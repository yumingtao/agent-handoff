import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

test("topic task state model: state machine, idempotency, concurrency, auto-reopen, and legacy compat", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "agent-handoff-taskstate-"));
  process.env.AGENT_HANDOFF_DISABLE_SERVER = "1";
  process.env.AGENT_HANDOFF_HOME = tempHome;
  process.env.AGENT_HANDOFF_CANONICAL_WORKSPACES = JSON.stringify({
    "my-backend": join(tempHome, "my-backend"),
  });
  delete process.env.AGENT_HANDOFF_DB_PATH;
  delete process.env.AGENT_HANDOFF_FILES_DIR;
  delete process.env.AGENT_HANDOFF_BACKUPS_DIR;

  const { __test } = await import("./index.js");

  try {
    __test.resetDatabaseForTests();
    const { db, config } = await __test.getDatabase();

    // --- schema v7 columns exist ---
    const logicalColumns = db.prepare("PRAGMA table_info(logical_topics)").all() as Array<{ name: string }>;
    for (const col of ["task_state", "completed_at", "completed_by", "cancelled_at", "cancelled_by"]) {
      assert.ok(logicalColumns.some((c) => c.name === col), `logical_topics should have column ${col}`);
    }
    const changeTableCols = db.prepare("PRAGMA table_info(topic_state_changes)").all() as Array<{ name: string }>;
    for (const col of ["id", "logical_topic_id", "from_state", "to_state", "action", "changed_by", "reason", "created_at"]) {
      assert.ok(changeTableCols.some((c) => c.name === col), `topic_state_changes should have column ${col}`);
    }

    // --- new topics are initialized as open ---
    const resolved = __test.resolveTopicRecord(db, { project: "my-repo", topic: "task-state-fixture" });
    const ltId = resolved.logical_topic.id;
    const fresh = __test.getLogicalTopicById(db, ltId) as { task_state: string };
    assert.equal(fresh.task_state, "open");

    // Workspace aliases must resolve to the same logical topic instead of creating duplicates.
    const backendWorkspace = join(tempHome, "my-backend");
    const legacyBackendTopicId = "legacy-backend-workspace-topic";
    db.prepare(`
      INSERT INTO logical_topics (id, project, workspace, canonical_topic_name, display_name, description, created_at, updated_at, task_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      legacyBackendTopicId,
      "my-backend",
      "my-backend",
      "workspace-alias-fixture",
      "workspace-alias-fixture",
      null,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "open",
    );
    const backendCanonical = __test.resolveTopicRecord(db, {
      project: "my-backend",
      workspace: backendWorkspace,
      topic: "workspace-alias-fixture",
    });
    const backendDefault = __test.resolveTopicRecord(db, {
      project: "my-backend",
      topic: "workspace-alias-fixture",
    });
    assert.equal(backendCanonical.logical_topic.id, legacyBackendTopicId);
    assert.equal(backendDefault.logical_topic.id, legacyBackendTopicId);

    // --- complete: open → done ---
    const completed = __test.transitionTopicState(db, {
      logical_topic_id: ltId,
      target_state: "done",
      changed_by: "codex",
      reason: "work delivered",
    });
    assert.equal(completed.updated, true);
    assert.equal(completed.task_state, "done");
    assert.equal(completed.action, "complete");
    const doneRow = __test.getLogicalTopicById(db, ltId) as { task_state: string; completed_by: string; completed_at: string; cancelled_at: string | null };
    assert.equal(doneRow.task_state, "done");
    assert.equal(doneRow.completed_by, "codex");
    assert.ok(doneRow.completed_at);
    assert.equal(doneRow.cancelled_at, null);

    // --- idempotent: done → done is a no-op ---
    const idempotent = __test.transitionTopicState(db, {
      logical_topic_id: ltId,
      target_state: "done",
      changed_by: "codex",
      reason: "retry",
    });
    assert.equal(idempotent.updated, false);
    assert.equal(idempotent.idempotent, true);
    // no duplicate history row
    const history = __test.listTopicStateChanges(db, ltId) as Array<{ action: string }>;
    assert.equal(history.filter((h) => h.action === "complete").length, 1);

    // --- illegal transition: done → cancelled is rejected ---
    assert.throws(
      () => __test.transitionTopicState(db, {
        logical_topic_id: ltId,
        target_state: "cancelled",
        changed_by: "codex",
        reason: "try cancel after done",
      }),
      /Illegal transition/,
    );

    // --- reopen: done → open ---
    const reopened = __test.transitionTopicState(db, {
      logical_topic_id: ltId,
      target_state: "open",
      changed_by: "codebuddy",
      reason: "follow-up work needed",
    });
    assert.equal(reopened.updated, true);
    assert.equal(reopened.action, "reopen");
    const openRow = __test.getLogicalTopicById(db, ltId) as { task_state: string; completed_at: string | null; completed_by: string | null };
    assert.equal(openRow.task_state, "open");
    assert.equal(openRow.completed_at, null);
    assert.equal(openRow.completed_by, null);

    // --- cancel: open → cancelled ---
    const cancelled = __test.transitionTopicState(db, {
      logical_topic_id: ltId,
      target_state: "cancelled",
      changed_by: "human",
      reason: "requirements dropped",
    });
    assert.equal(cancelled.task_state, "cancelled");
    assert.equal(cancelled.action, "cancel");
    const cancelledRow = __test.getLogicalTopicById(db, ltId) as { cancelled_by: string; cancelled_at: string };
    assert.equal(cancelledRow.cancelled_by, "human");
    assert.ok(cancelledRow.cancelled_at);

    // --- illegal: cancelled → done ---
    assert.throws(
      () => __test.transitionTopicState(db, {
        logical_topic_id: ltId,
        target_state: "done",
        changed_by: "codex",
        reason: "try",
      }),
      /Illegal transition/,
    );

    // --- optimistic concurrency conflict ---
    assert.throws(
      () => __test.transitionTopicState(db, {
        logical_topic_id: ltId,
        target_state: "open",
        changed_by: "codex",
        reason: "reopen",
        expected_state: "done",
      }),
      /Optimistic concurrency conflict/,
    );
    // correct expected_state succeeds
    const reopenFromCancelled = __test.transitionTopicState(db, {
      logical_topic_id: ltId,
      target_state: "open",
      changed_by: "codex",
      reason: "reopened correctly",
      expected_state: "cancelled",
    });
    assert.equal(reopenFromCancelled.task_state, "open");

    // --- reason required for terminal transitions ---
    assert.throws(
      () => __test.transitionTopicState(db, {
        logical_topic_id: ltId,
        target_state: "done",
        changed_by: "codex",
      }),
      /reason is required/,
    );

    // --- changed_by required ---
    assert.throws(
      () => __test.transitionTopicState(db, {
        logical_topic_id: ltId,
        target_state: "done",
        changed_by: "",
        reason: "x",
      }),
      /changed_by is required/,
    );

    // --- auto-reopen on publish to a done topic ---
    const doneAgain = __test.transitionTopicState(db, {
      logical_topic_id: ltId,
      target_state: "done",
      changed_by: "codex",
      reason: "mark done again for auto-reopen test",
    });
    assert.equal(doneAgain.task_state, "done");
    const published = __test.publishConclusion(db, config, {
      project: "my-repo",
      topic: "task-state-fixture",
      conclusion: "new handoff should auto-reopen",
      source_agent: "codex",
      sensitivity: "normal",
    });
    assert.ok(published.id);
    const afterPublish = __test.getLogicalTopicById(db, ltId) as { task_state: string };
    assert.equal(afterPublish.task_state, "open", "publishing to a done topic should auto-reopen");
    const historyAfterPublish = __test.listTopicStateChanges(db, ltId) as Array<{ action: string }>;
    assert.ok(historyAfterPublish.some((h) => h.action === "auto_reopen"), "auto_reopen should be recorded in history");

    // --- legacy topic with null task_state: lazy init on publish ---
    // Insert a legacy logical topic directly with null task_state (simulates pre-v7 data).
    const legacyId = "legacy-null-state-topic-id";
    db.prepare(`
      INSERT INTO logical_topics (id, project, workspace, canonical_topic_name, display_name, description, created_at, updated_at, task_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(legacyId, "my-repo", null, "legacy-null-topic", "legacy-null-topic", null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    __test.publishConclusion(db, config, {
      project: "my-repo",
      topic: "legacy-null-topic",
      logical_topic_id: legacyId,
      conclusion: "publish to legacy null-state topic",
      source_agent: "codex",
      sensitivity: "normal",
    });
    const legacyAfter = __test.getLogicalTopicById(db, legacyId) as { task_state: string };
    assert.equal(legacyAfter.task_state, "open", "legacy null-state topic should be lazily initialized to open");

    // --- topic context exposes task state + history ---
    const ctx = __test.getTopicContext(db, ltId) as {
      found: boolean;
      detail: { task_state: string; stateChanges: Array<{ action: string }> };
    };
    assert.equal(ctx.found, true);
    assert.equal(ctx.detail.task_state, "open");
    assert.ok(ctx.detail.stateChanges.length >= 4, "should have transition history");

    // --- real concurrent connection serialization ---
    // Two separate DatabaseSync connections to the same DB file. The second
    // connection uses busy_timeout=0 so it fails fast instead of blocking.
    const conn2 = new DatabaseSync(config.dbPath);
    conn2.exec("PRAGMA busy_timeout = 0;");
    try {
      // conn1 (db) holds the BEGIN IMMEDIATE write lock
      db.exec("BEGIN IMMEDIATE");
      // conn2 cannot acquire a write lock — proves BEGIN IMMEDIATE serializes
      assert.throws(
        () => conn2.exec("BEGIN IMMEDIATE"),
        /SQLITE_BUSY|database is locked/i,
      );
      db.exec("ROLLBACK");

      // After conn1 releases, conn2 can transition and sees committed state.
      // The topic is currently 'open' (reopened by auto-reopen test above).
      // Use conn2 to complete it, then verify conn1 sees the update.
      const conn2Result = __test.transitionTopicState(conn2, {
        logical_topic_id: ltId,
        target_state: "done",
        changed_by: "conn2-operator",
        reason: "completed via second connection",
      });
      assert.equal(conn2Result.updated, true);
      assert.equal(conn2Result.task_state, "done");

      // conn1 reads the same row — sees conn2's committed write
      const seenByConn1 = __test.getLogicalTopicById(db, ltId) as { task_state: string; completed_by: string };
      assert.equal(seenByConn1.task_state, "done");
      assert.equal(seenByConn1.completed_by, "conn2-operator");

      // conn1 idempotent retry on the now-done topic
      const idempotentConn1 = __test.transitionTopicState(db, {
        logical_topic_id: ltId,
        target_state: "done",
        changed_by: "conn1-operator",
        reason: "retry from conn1",
      });
      assert.equal(idempotentConn1.updated, false);
      assert.equal(idempotentConn1.idempotent, true);
    } finally {
      conn2.close();
    }
  } finally {
    __test.resetDatabaseForTests();
    rmSync(tempHome, { recursive: true, force: true });
  }
});
