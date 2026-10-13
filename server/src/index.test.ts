import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
// @ts-ignore repo-local runtime module
import { AgentEventsStore } from "../../agent-events/src/store.mjs";
// @ts-ignore repo-local runtime module
import { TraceStore } from "../../trace-store/src/trace-store.mjs";

function runConcurrentMutationWorkers(indexPath: string, homeDir: string, operation: string, payload: Record<string, unknown>) {
  const barrierDir = join(homeDir, `receipt-barrier-${operation}-${String(payload.request_id)}`);
  mkdirSync(barrierDir, { recursive: true });
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { existsSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    process.env.AGENT_HANDOFF_DISABLE_SERVER = "1";
    process.env.AGENT_HANDOFF_HOME = workerData.homeDir;
    (async () => {
      const { __test } = await import(workerData.indexPath);
      const { db, config } = await __test.getDatabase();
      parentPort.postMessage({ type: "ready" });
      await new Promise((resolve) => parentPort.once("message", resolve));
      try {
        const hooks = {
          afterReceipt: () => {
            writeFileSync(join(workerData.barrierDir, "receipt-" + workerData.workerId), "");
            parentPort.postMessage({ type: "receipt-read" });
            const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
            while (!existsSync(join(workerData.barrierDir, "release"))) Atomics.wait(waitBuffer, 0, 0, 10);
          },
        };
        const result = workerData.operation === "createReviewCase"
          ? __test.createReviewCase(db, workerData.payload, hooks)
          : workerData.operation === "transitionReviewCase"
            ? __test.transitionReviewCase(db, workerData.payload, hooks)
            : __test[workerData.operation](db, config, workerData.payload, hooks);
        parentPort.postMessage({ type: "result", result });
      } catch (error) {
        parentPort.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) });
      }
    })().catch((error) => parentPort.postMessage({ type: "error", error: String(error) }));
  `;
  const workers = [0, 1].map((workerId) => new Worker(workerSource, {
    eval: true,
    workerData: { indexPath, homeDir, operation, payload, barrierDir, workerId },
  }));
  return new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const results: Record<string, unknown>[] = [];
    let ready = 0;
    let receipts = 0;
    let releaseTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      for (const worker of workers) void worker.terminate();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const release = () => {
      if (existsSync(join(barrierDir, "release"))) return;
      if (releaseTimer) clearTimeout(releaseTimer);
      writeFileSync(join(barrierDir, "release"), "");
    };
    for (const worker of workers) {
      worker.on("message", (message: { type: string; result?: Record<string, unknown>; error?: string }) => {
        if (message.type === "ready") {
          ready += 1;
          if (ready === workers.length) {
            for (const readyWorker of workers) readyWorker.postMessage("go");
          }
        } else if (message.type === "receipt-read") {
          receipts += 1;
          if (receipts === workers.length) release();
          else if (!releaseTimer) releaseTimer = setTimeout(release, 100);
        } else if (message.type === "result") {
          results.push(message.result!);
          if (results.length === workers.length) {
            settled = true;
            for (const resultWorker of workers) void resultWorker.terminate();
            resolve(results);
          }
        } else {
          fail(new Error(message.error || "review case worker failed"));
        }
      });
      worker.on("error", fail);
      worker.on("exit", (code) => {
        if (code !== 0) fail(new Error(`review case worker exited with code ${code}`));
      });
    }
  });
}

test("schema v6 helpers cover ttl, logical topics, canonical writes, topic_raw, search, supersede reason, model/model_display fields, and singleton init", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "agent-handoff-test-"));
  process.env.AGENT_HANDOFF_DISABLE_SERVER = "1";
  process.env.AGENT_HANDOFF_HOME = tempHome;
  process.env.AGENT_HANDOFF_CANONICAL_WORKSPACES = JSON.stringify({
    "my-repo": join(tempHome, "my-repo"),
  });
  delete process.env.AGENT_HANDOFF_DB_PATH;
  delete process.env.AGENT_HANDOFF_FILES_DIR;
  delete process.env.AGENT_HANDOFF_BACKUPS_DIR;

  const { __test } = await import("./index.js");

  try {
    __test.resetDatabaseForTests();

    const [first, second] = await Promise.all([__test.getDatabase(), __test.getDatabase()]);
    assert.equal(first.db, second.db);

    assert.deepEqual(Object.keys(__test.sourceMetadataSchema), ["source_thread", "source_host"]);
    assert.equal(__test.sourceMetadataSchema.source_thread.description, "Originating conversation or thread identifier. Historical rows stay null; omit if unknown.");
    assert.equal(__test.sourceMetadataSchema.source_host.description, "Orthogonal host/frontend dimension: cli, desktop, vscode, intellij, or web. Lowercased automatically. Historical rows stay null — do not backfill. Omit if unknown rather than guessing.");
    for (const inputSchema of [
      __test.publishConclusionInputSchema,
      __test.publishReviewReadyImplementationInputSchema,
      __test.publishReviewComparisonInputSchema,
    ]) {
      assert.equal(inputSchema.source_thread, __test.sourceMetadataSchema.source_thread);
      assert.equal(inputSchema.source_host, __test.sourceMetadataSchema.source_host);
    }
    assert.match(String(__test.publishReviewComparisonInputSchema.comparison.description), /Status, Done, Blocked, and Risks\/Pitfalls/);
    assert.ok(__test.publishReviewComparisonInputSchema.supersedes_id);
    assert.ok(__test.publishReviewComparisonInputSchema.logical_topic_id);

    const schemaVersion = first.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value;
    assert.equal(schemaVersion, "15");
    const migration5 = first.db.prepare("SELECT name FROM schema_migrations WHERE version = 5").get();
    assert.equal(migration5?.name, "conclusions_model");
    const migration6 = first.db.prepare("SELECT name FROM schema_migrations WHERE version = 6").get();
    assert.equal(migration6?.name, "conclusions_model_display");
    const migration7 = first.db.prepare("SELECT name FROM schema_migrations WHERE version = 7").get();
    assert.equal(migration7?.name, "logical_topics_task_state_v7");
    const migration8 = first.db.prepare("SELECT name FROM schema_migrations WHERE version = 8").get();
    assert.equal(migration8?.name, "conclusions_model_normalize_from_display");
    const migration9 = first.db.prepare("SELECT name FROM schema_migrations WHERE version = 9").get();
    assert.equal(migration9?.name, "conclusions_source_host");
    const migration10 = first.db.prepare("SELECT name FROM schema_migrations WHERE version = 10").get();
    assert.equal(migration10?.name, "conclusions_changed_by");
    assert.equal(first.db.prepare("SELECT name FROM schema_migrations WHERE version = 11").get()?.name, "mutation_receipts");
    assert.equal(first.db.prepare("SELECT name FROM schema_migrations WHERE version = 12").get()?.name, "independent_review_protocol");
    assert.equal(first.db.prepare("SELECT name FROM schema_migrations WHERE version = 13").get()?.name, "review_case_task_material");
    assert.equal(first.db.prepare("SELECT name FROM schema_migrations WHERE version = 14").get()?.name, "structured_review_comparisons");
    assert.equal(first.db.prepare("SELECT name FROM schema_migrations WHERE version = 15").get()?.name, "review_case_lifecycle");
    const columns = first.db.prepare("PRAGMA table_info(conclusions)").all();
    assert.ok(columns.some((column) => column.name === "superseded_reason"));
    assert.ok(columns.some((column) => column.name === "topic_raw"));
    assert.ok(columns.some((column) => column.name === "logical_topic_id"));
    assert.ok(columns.some((column) => column.name === "model"));
    assert.ok(columns.some((column) => column.name === "model_display"));
    assert.ok(columns.some((column) => column.name === "source_host"));
    assert.ok(columns.some((column) => column.name === "changed_by"));

    assert.equal(__test.isoAfterDays("2026-07-06T03:21:36.174Z", 3), "2026-07-09T03:21:36.174Z");
    assert.throws(
      () => __test.publishConclusion(first.db, first.config, {
        project: "my-repo",
        topic: "ttl-conflict",
        conclusion: "conflict",
        expires_at: "2026-07-10T00:00:00.000Z",
        ttl_days: 1,
        sensitivity: "normal",
      }),
      /either expires_at or ttl_days/
    );

    first.db.exec("DELETE FROM conclusions");

    const ttlPublished = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "ttl-topic",
      conclusion: "database race fix candidate",
      ttl_days: 2,
      sensitivity: "normal",
    });
    const ttlRow = first.db.prepare("SELECT created_at, expires_at, topic_raw FROM conclusions WHERE id = ?").get(ttlPublished.id);
    assert.equal(ttlRow?.expires_at, __test.isoAfterDays(String(ttlRow?.created_at), 2));
    assert.equal(ttlRow?.topic_raw, null);
    const ttlLogical = first.db.prepare("SELECT logical_topic_id FROM conclusions WHERE id = ?").get(ttlPublished.id);
    assert.ok(ttlLogical?.logical_topic_id);

    const resolved = __test.resolveTopicRecord(first.db, {
      project: "my-repo",
      workspace: undefined,
      topic: "ttl-topic",
    });
    assert.equal(resolved.logical_topic.id, ttlLogical?.logical_topic_id);
    assert.equal(resolved.canonical_topic, "ttl-topic");

    // The standalone distribution ships an empty alias table, so the global
    // resolver is identity; alias-merging semantics are covered by the
    // topic-canonicalization unit tests with injected fixture tables.
    const aliasResolver = __test.resolveCanonicalTopic;
    const aliasTopic = "handoff-model-field-and-workflow-diagram";
    const canonical = aliasResolver("my-repo", null, aliasTopic);
    assert.equal(canonical, aliasTopic);
    const canonicalPublished = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: aliasTopic,
      conclusion: "canonical write path",
      sensitivity: "normal",
    });
    const canonicalRow = first.db.prepare("SELECT topic, topic_raw FROM conclusions WHERE id = ?").get(canonicalPublished.id);
    assert.equal(canonicalRow?.topic, aliasTopic);
    assert.equal(canonicalRow?.topic_raw, null);
    assert.equal(canonicalPublished.topic, aliasTopic);

    const oldRecord = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "tier3-supersede",
      conclusion: "old tier 3 record",
      sensitivity: "normal",
    });
    const replacementRecord = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "tier3-supersede",
      conclusion: "replacement for tier 3 database race",
      supersedes_id: oldRecord.id,
      sensitivity: "normal",
    });
    const superseded = __test.supersedeConclusion(first.db, first.config, {
      id: oldRecord.id,
      replacement_id: replacementRecord.id,
      reason: "migrated during tier 3",
    });
    assert.equal(superseded.updated, true);
    const supersededRow = first.db.prepare("SELECT status, superseded_reason FROM conclusions WHERE id = ?").get(oldRecord.id);
    assert.equal(supersededRow?.status, "superseded");
    assert.equal(supersededRow?.superseded_reason, "migrated during tier 3");

    const designRecord = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "workflow-diagram-design",
      conclusion: "initial design for the workflow diagram",
      sensitivity: "normal",
    });
    const designLogicalTopicId = first.db
      .prepare("SELECT logical_topic_id FROM conclusions WHERE id = ?")
      .get(designRecord.id)?.logical_topic_id;
    const followUpRecord = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "model-field-and-workflow-diagram",
      conclusion: "implementation follow-up, worded differently from the design topic",
      supersedes_id: designRecord.id,
      sensitivity: "normal",
    });
    const followUpRow = first.db.prepare("SELECT logical_topic_id FROM conclusions WHERE id = ?").get(followUpRecord.id);
    assert.equal(
      followUpRow?.logical_topic_id,
      designLogicalTopicId,
      "supersedes_id should carry the logical topic forward even when the topic string changes"
    );
    // Missing source_agent/source_host should produce both non-blocking warnings.
    assert.ok(followUpRecord.warning?.includes("source_agent is missing"));
    assert.ok(followUpRecord.warning?.includes("source_host is missing"));

    assert.throws(
      () => __test.publishConclusion(first.db, first.config, {
        project: "my-repo",
        topic: "orphan-supersede-topic",
        conclusion: "supersedes an id that doesn't exist",
        supersedes_id: "does-not-exist",
        sensitivity: "normal",
      }),
      /FOREIGN KEY constraint failed/
    );

    const crossProjectOriginal = __test.publishConclusion(first.db, first.config, {
      project: "other-project-topic-continuity-test",
      topic: "cross-project-original",
      conclusion: "conclusion published under a different project",
      sensitivity: "normal",
    });
    assert.throws(
      () => __test.publishConclusion(first.db, first.config, {
        project: "my-repo",
        topic: "cross-project-follow-up",
        conclusion: "should not be allowed to supersede a conclusion from another project",
        supersedes_id: crossProjectOriginal.id,
        sensitivity: "normal",
      }),
      /cannot be superseded from project/,
      "supersedes_id must be rejected when the prior conclusion belongs to a different project"
    );
    const crossProjectLogicalTopicId = first.db
      .prepare("SELECT logical_topic_id FROM conclusions WHERE id = ?")
      .get(crossProjectOriginal.id)?.logical_topic_id;
    assert.throws(
      () => __test.publishConclusion(first.db, first.config, {
        project: "my-repo",
        topic: "cross-project-follow-up-2",
        conclusion: "should not be allowed to reuse a logical_topic_id from another project",
        logical_topic_id: crossProjectLogicalTopicId as string,
        sensitivity: "normal",
      }),
      /cannot be reused from project/,
      "logical_topic_id must be rejected when it belongs to a different project"
    );

    const crossWorkspaceOriginal = __test.publishConclusion(first.db, first.config, {
      project: "workspace-scoped-test-project",
      workspace: "workspace-a",
      topic: "cross-workspace-original",
      conclusion: "conclusion published under workspace-a",
      sensitivity: "normal",
    });
    assert.throws(
      () => __test.publishConclusion(first.db, first.config, {
        project: "workspace-scoped-test-project",
        workspace: "workspace-b",
        topic: "cross-workspace-follow-up",
        conclusion: "should not be allowed to supersede a conclusion from a different workspace in the same project",
        supersedes_id: crossWorkspaceOriginal.id,
        sensitivity: "normal",
      }),
      /cannot be superseded from project/,
      "supersedes_id must be rejected when the prior conclusion belongs to a different workspace"
    );
    const sameScopeFollowUp = __test.publishConclusion(first.db, first.config, {
      project: "workspace-scoped-test-project",
      workspace: "workspace-a",
      topic: "cross-workspace-follow-up-same-scope",
      conclusion: "should succeed when project/workspace match the superseded conclusion",
      supersedes_id: crossWorkspaceOriginal.id,
      sensitivity: "normal",
    });
    const sameScopeLogicalTopicId = first.db
      .prepare("SELECT logical_topic_id FROM conclusions WHERE id = ?")
      .get(sameScopeFollowUp.id)?.logical_topic_id;
    const crossWorkspaceOriginalLogicalTopicId = first.db
      .prepare("SELECT logical_topic_id FROM conclusions WHERE id = ?")
      .get(crossWorkspaceOriginal.id)?.logical_topic_id;
    assert.equal(
      sameScopeLogicalTopicId,
      crossWorkspaceOriginalLogicalTopicId,
      "same project/workspace continuation must still inherit the logical topic"
    );

    // --- read-only candidate-continuation warning ---
    const firstStandaloneTask = __test.publishConclusion(first.db, first.config, {
      project: "continuation-warning-test-project",
      topic: "first-task",
      conclusion: "first task in this project, nothing to continue yet",
      sensitivity: "normal",
    });
    assert.ok(
      !firstStandaloneTask.warning?.includes("Recently active conclusions"),
      "no candidates should be surfaced when there is no prior activity in the project"
    );
    const secondUnlinkedTask = __test.publishConclusion(first.db, first.config, {
      project: "continuation-warning-test-project",
      topic: "second-task-different-wording",
      conclusion: "second task published without supersedes_id or logical_topic_id",
      sensitivity: "normal",
    });
    assert.ok(
      secondUnlinkedTask.warning?.includes("Recently active conclusions"),
      "minting a new logical topic while recent same-project activity exists should surface a candidate warning"
    );
    assert.ok(
      secondUnlinkedTask.warning?.includes(firstStandaloneTask.id),
      "the candidate warning should name the recent conclusion id"
    );
    const thirdLinkedTask = __test.publishConclusion(first.db, first.config, {
      project: "continuation-warning-test-project",
      topic: "third-task-continues-second",
      conclusion: "third task correctly links back via supersedes_id",
      supersedes_id: secondUnlinkedTask.id,
      sensitivity: "normal",
    });
    assert.ok(
      !thirdLinkedTask.warning?.includes("Recently active conclusions"),
      "no candidate warning should fire when supersedes_id is correctly provided"
    );

    // --- combined logical_topic_id + supersedes_id validation ---
    const combinedBaseTask = __test.publishConclusion(first.db, first.config, {
      project: "combined-params-test-project",
      topic: "combined-base-task",
      conclusion: "base task establishing a logical topic",
      sensitivity: "normal",
    });
    const combinedBaseLogicalTopicId = first.db
      .prepare("SELECT logical_topic_id FROM conclusions WHERE id = ?")
      .get(combinedBaseTask.id)?.logical_topic_id as string;

    const combinedValidFollowUp = __test.publishConclusion(first.db, first.config, {
      project: "combined-params-test-project",
      topic: "combined-follow-up",
      conclusion: "follow-up correctly naming both the prior conclusion and its logical topic",
      supersedes_id: combinedBaseTask.id,
      logical_topic_id: combinedBaseLogicalTopicId,
      sensitivity: "normal",
    });
    const combinedValidFollowUpRow = first.db
      .prepare("SELECT logical_topic_id FROM conclusions WHERE id = ?")
      .get(combinedValidFollowUp.id);
    assert.equal(
      combinedValidFollowUpRow?.logical_topic_id,
      combinedBaseLogicalTopicId,
      "combined valid params should inherit the shared logical topic"
    );
    const combinedBaseAfter = first.db.prepare("SELECT status FROM conclusions WHERE id = ?").get(combinedBaseTask.id);
    assert.equal(
      combinedBaseAfter?.status,
      "superseded",
      "supersedes_id should still mark the prior conclusion superseded when combined with a matching logical_topic_id"
    );

    const combinedCrossProjectOriginal = __test.publishConclusion(first.db, first.config, {
      project: "combined-params-other-project",
      topic: "combined-cross-project-original",
      conclusion: "conclusion in a different project",
      sensitivity: "normal",
    });
    assert.throws(
      () => __test.publishConclusion(first.db, first.config, {
        project: "combined-params-test-project",
        topic: "combined-cross-project-follow-up",
        conclusion: "should be rejected even though logical_topic_id is valid for this project",
        logical_topic_id: combinedBaseLogicalTopicId,
        supersedes_id: combinedCrossProjectOriginal.id,
        sensitivity: "normal",
      }),
      /cannot be superseded from project/,
      "supersedes_id must be independently validated even when logical_topic_id is also provided"
    );

    const combinedMismatchedTopic = __test.publishConclusion(first.db, first.config, {
      project: "combined-params-test-project",
      topic: "combined-unrelated-topic",
      conclusion: "an unrelated logical topic in the same project",
      sensitivity: "normal",
    });
    assert.throws(
      () => __test.publishConclusion(first.db, first.config, {
        project: "combined-params-test-project",
        topic: "combined-mismatch-follow-up",
        conclusion: "should be rejected because supersedes_id and logical_topic_id disagree on the thread",
        logical_topic_id: combinedBaseLogicalTopicId,
        supersedes_id: combinedMismatchedTopic.id,
        sensitivity: "normal",
      }),
      /names a different logical topic/,
      "supersedes_id must name the same logical topic as an explicitly-passed logical_topic_id"
    );
    const combinedMismatchedAfter = first.db.prepare("SELECT status FROM conclusions WHERE id = ?").get(combinedMismatchedTopic.id);
    assert.equal(
      combinedMismatchedAfter?.status,
      "active",
      "a rejected combined publish must not have marked the mismatched conclusion superseded"
    );

    // --- expired conclusions are excluded from the continuation-candidate warning ---
    __test.publishConclusion(first.db, first.config, {
      project: "expired-candidate-test-project",
      topic: "expired-task",
      conclusion: "an already-expired conclusion that should not be suggested as a continuation candidate",
      expires_at: "2020-01-01T00:00:00.000Z",
      sensitivity: "normal",
    });
    const expiredFollowUp = __test.publishConclusion(first.db, first.config, {
      project: "expired-candidate-test-project",
      topic: "unrelated-new-task",
      conclusion: "new unlinked task in the same project shortly after an expired one",
      sensitivity: "normal",
    });
    assert.ok(
      !expiredFollowUp.warning?.includes("Recently active conclusions"),
      "an expired conclusion must not be surfaced as a continuation candidate even though status is still active"
    );

    const sensitiveRecord = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "tier3-search-sensitive",
      conclusion: "database race notes kept for tier 3 follow-up",
      sensitivity: "sensitive",
    });
    const searchResults = __test.listConclusions(first.db, 20, false, {
      project: "my-repo",
      search: "database race",
    });
    const sensitiveItem = searchResults.items.find((item) => item.id === sensitiveRecord.id) as
      | { body_redacted?: boolean; conclusion?: string }
      | undefined;
    const normalItem = searchResults.items.find((item) => item.id === replacementRecord.id) as
      | { conclusion?: string; body_redacted?: boolean }
      | undefined;
    assert.ok(sensitiveItem);
    assert.equal(sensitiveItem?.body_redacted, true);
    assert.equal("conclusion" in (sensitiveItem || {}), false);
    assert.ok(normalItem?.conclusion?.includes("database race"));

    first.db.prepare(`
      INSERT INTO conclusions (
        id, project, workspace, topic, topic_raw, conclusion, next_action, refs_json, source_agent, source_thread,
        created_at, updated_at, expires_at, supersedes_id, superseded_reason, status, confidence, sensitivity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-raw-topic",
      "my-repo",
      null,
      "legacy-raw-topic",
      null,
      "legacy raw row",
      null,
      "[]",
      null,
      null,
      "2026-07-07T00:00:00.000Z",
      "2026-07-07T00:00:00.000Z",
      null,
      null,
      null,
      "active",
      null,
      "normal"
    );
    const legacyMatches = __test.listConclusions(first.db, 20, true, {
      project: "my-repo",
      topic: "legacy-raw-topic",
    });
    assert.equal(legacyMatches.items.length, 1);
    assert.equal(legacyMatches.items[0].id, "legacy-raw-topic");

    const explicitTopic = __test.resolveTopicRecord(first.db, {
      project: "my-repo",
      topic: "explicit-topic",
    });
    const explicitPublished = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "explicit-topic",
      logical_topic_id: explicitTopic.logical_topic.id,
      conclusion: "explicit logical topic id publish",
      sensitivity: "normal",
    });
    const explicitRow = first.db.prepare("SELECT logical_topic_id FROM conclusions WHERE id = ?").get(explicitPublished.id);
    assert.equal(explicitRow?.logical_topic_id, explicitTopic.logical_topic.id);

    const modelPublished = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "model-test",
      conclusion: "model field test",
      model: "  Claude Sonnet 4  ",
      sensitivity: "normal",
    });
    const modelRow = first.db.prepare("SELECT model, model_display FROM conclusions WHERE id = ?").get(modelPublished.id);
    assert.equal(modelRow?.model, "claude-sonnet-4");
    assert.equal(modelRow?.model_display, "Claude Sonnet 4");
    const modelPublic = __test.listConclusions(first.db, 20, true, {
      project: "my-repo",
      topic: "model-test",
    });
    assert.equal(modelPublic.items[0]?.model, "claude-sonnet-4");
    assert.equal((modelPublic.items[0] as { model_display?: string }).model_display, "Claude Sonnet 4");

    const noModelPublished = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "no-model-test",
      conclusion: "no model field",
      sensitivity: "normal",
    });
    const noModelRow = first.db.prepare("SELECT model FROM conclusions WHERE id = ?").get(noModelPublished.id);
    assert.equal(noModelRow?.model, null);

    // normalizeModel folding: '.', '_', and whitespace runs all → '-'
    assert.equal(__test.normalizeModel("Claude Opus 4.8"), "claude-opus-4-8");
    assert.equal(__test.normalizeModel("claude-opus-4.8"), "claude-opus-4-8");
    assert.equal(__test.normalizeModel("claude_opus_4_8"), "claude-opus-4-8");
    assert.equal(__test.normalizeModel("glm-5.2"), "glm-5-2");
    assert.equal(__test.normalizeModel("  MyModel GLM 5.2 "), "mymodel-glm-5-2");

    // normalizeModel provider-prefix stripping: take segment after LAST '/'
    assert.equal(__test.normalizeModel("gateway-openai/gpt-5.5"), "gpt-5-5");
    assert.equal(__test.normalizeModel("openai/gpt-4o"), "gpt-4o");
    assert.equal(__test.normalizeModel("provider/sub/gpt-5"), "gpt-5");
    // no slash → unchanged behavior
    assert.equal(__test.normalizeModel("claude-opus-4-8"), "claude-opus-4-8");

    // soft source_agent validation: known platform → no warning; unknown → warning
    const knownAgentPublished = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "known-agent-test",
      conclusion: "known agent",
      source_agent: "codebuddy",
      sensitivity: "normal",
    });
    // source_agent is known, but source_host is missing → warn about that
    assert.ok(knownAgentPublished.warning?.includes("source_host is missing"));
    assert.ok(!knownAgentPublished.warning?.includes("unknown source_agent"));

    for (const [sourceAgent, topic] of [["trae", "trae-agent-test"], ["trae-ide", "trae-ide-agent-test"], ["trae-cli", "trae-cli-agent-test"]] as const) {
      const traePublished = __test.publishConclusion(first.db, first.config, {
        project: "my-repo",
        topic,
        conclusion: `${sourceAgent} agent`,
        source_agent: sourceAgent,
        sensitivity: "normal",
      });
      assert.ok(!traePublished.warning?.includes("unknown source_agent"), `${sourceAgent} should be a known platform ID`);
    }

    const missingAgentPublished = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "missing-agent-test",
      conclusion: "missing agent",
      sensitivity: "normal",
    });
    assert.ok(missingAgentPublished.warning?.includes("source_agent is missing"));
    assert.ok(missingAgentPublished.warning?.includes("source_host is missing"));

    const unknownAgentPublished = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "unknown-agent-test",
      conclusion: "unknown agent",
      source_agent: "codex-gpt-5.4",
      sensitivity: "normal",
    });
    assert.ok(unknownAgentPublished.warning?.includes("unknown source_agent"));
    assert.ok(unknownAgentPublished.warning?.includes("codex-gpt-5.4"));

    // claude-desktop is NOT a known platform ID — it should trigger the warning.
    // Claude Desktop agents use source_agent="claude-code" with source_host="desktop".
    const claudeDesktopPublished = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "claude-desktop-agent-test",
      conclusion: "claude-desktop as source_agent",
      source_agent: "claude-desktop",
      sensitivity: "normal",
    });
    assert.ok(claudeDesktopPublished.warning?.includes("unknown source_agent"));
    assert.ok(claudeDesktopPublished.warning?.includes("claude-desktop"));

    // source_host is stored lowercased and returned in publicRecord
    const sourceHostPublished = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "source-host-test",
      conclusion: "source_host field test",
      source_agent: "claude-code",
      source_host: "Desktop",
      sensitivity: "normal",
    });
    assert.equal(sourceHostPublished.project, "my-repo");
    assert.equal(sourceHostPublished.topic, "source-host-test");
    assert.ok(sourceHostPublished.logical_topic_id);
    const sourceHostScope = first.db.prepare("SELECT workspace FROM conclusions WHERE id = ?").get(sourceHostPublished.id) as { workspace: string | null } | undefined;
    assert.equal(sourceHostPublished.workspace, sourceHostScope?.workspace ?? null);
    // Only asserting the source_agent/source_host warnings are absent here — this call
    // lands in a project with lots of other recent unlinked topics from earlier in this
    // same test run, so the orthogonal candidate-continuation warning may legitimately fire.
    assert.ok(!sourceHostPublished.warning?.includes("unknown source_agent"));
    assert.ok(!sourceHostPublished.warning?.includes("source_host is missing"));
    const sourceHostRow = first.db.prepare("SELECT source_host FROM conclusions WHERE id = ?").get(sourceHostPublished.id);
    assert.equal(sourceHostRow?.source_host, "desktop");
    const sourceHostPublic = __test.listConclusions(first.db, 20, true, {
      project: "my-repo",
      topic: "source-host-test",
    });
    assert.equal((sourceHostPublic.items[0] as { source_host?: string }).source_host, "desktop");

    // missing source_host produces a warning mentioning the omission
    const noHostPublished = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "missing-source-host-test",
      conclusion: "Status: warning\nDone: omitted host\nBlocked: none\nRisks/Pitfalls: none",
      source_agent: "codex",
      sensitivity: "normal",
    });
    assert.ok(noHostPublished.warning?.includes("source_host is missing"));
    // The warning must not coach a guess: omission is correct when no deterministic host signal exists.
    assert.ok(noHostPublished.warning?.includes("do NOT guess"));
    assert.ok(!noHostPublished.warning?.includes("'cli' for"));
    assert.ok(!noHostPublished.warning?.includes("reconnect the MCP session and republish"));
    assert.equal(noHostPublished.warning?.split("; ")[0], "source_host is missing — stored as null. If your platform has no deterministic host signal, omission is correct — do NOT guess a value.");

    // unknown source_agent + missing source_host → combined warning
    const combinedWarningPublished = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      topic: "combined-warning-test",
      conclusion: "both wrong",
      source_agent: "gpt-5-4",
      sensitivity: "normal",
    });
    assert.ok(combinedWarningPublished.warning?.includes("unknown source_agent"));
    assert.ok(combinedWarningPublished.warning?.includes("source_host is missing"));

    // handoff section reminder: missing sections warn but do not block persistence
    const incompleteHandoff = __test.publishConclusion(first.db, first.config, {
      project: "handoff-section-warning-test",
      topic: "incomplete",
      conclusion: "Status: investigating\nDone: reproduced the issue",
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
    });
    assert.ok(incompleteHandoff.warning?.includes("missing recommended handoff sections: Blocked, Risks"));
    assert.ok(first.db.prepare("SELECT id FROM conclusions WHERE id = ?").get(incompleteHandoff.id));

    const completeHandoff = __test.publishConclusion(first.db, first.config, {
      project: "handoff-section-warning-test",
      topic: "complete",
      conclusion: "当前状态：ready\n已完成：implementation\n卡点：无\n避坑/风险：保留兼容性",
      next_action: "Run the focused tests",
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
    });
    assert.ok(!completeHandoff.warning?.includes("missing recommended handoff sections"));

    const inlineCompleteHandoff = __test.publishConclusion(first.db, first.config, {
      project: "handoff-section-warning-test",
      topic: "inline-complete",
      conclusion: "Status: ready。Done: implementation。Blocked: none。Risks/Pitfalls: compatibility preserved",
      next_action: "Run the focused tests",
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
    });
    assert.ok(!inlineCompleteHandoff.warning?.includes("missing recommended handoff sections"));

    const markdownCompleteHandoff = __test.publishConclusion(first.db, first.config, {
      project: "handoff-section-warning-test",
      topic: "markdown-complete",
      conclusion: "## Status\nready\n## Done\nimplementation\n## Blocked\nnone\n## Risks/Pitfalls\ncompatibility preserved",
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
    });
    assert.ok(!markdownCompleteHandoff.warning?.includes("missing recommended handoff sections"));

    assert.throws(
      () => __test.publishConclusion(first.db, first.config, {
        project: "handoff-corruption-test",
        topic: "residue",
        conclusion: "Status: bad\n</parameter></invoke>",
        sensitivity: "normal",
      }),
      /tool-call serialization residue/
    );
    const discussedResidue = __test.publishConclusion(first.db, first.config, {
      project: "handoff-corruption-test",
      topic: "residue-discussion",
      conclusion: "Status: discussing parser output. The literal </parameter></invoke> sequence is documented here, not emitted as a trailing tool call.",
      sensitivity: "normal",
    });
    assert.ok(discussedResidue.id);
    const idempotentPublishRequest = {
      project: "handoff-idempotency-test",
      topic: "publish-receipt",
      conclusion: "Status: stored\nDone: once\nBlocked: none\nRisks/Pitfalls: none",
      source_agent: "codex",
      source_host: "cli",
      request_id: "publish-receipt-1",
      sensitivity: "normal" as const,
    };
    const firstIdempotentPublish = __test.publishConclusion(first.db, first.config, idempotentPublishRequest);
    const secondIdempotentPublish = __test.publishConclusion(first.db, first.config, idempotentPublishRequest);
    assert.deepEqual(secondIdempotentPublish, firstIdempotentPublish);
    assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM conclusions WHERE id = ?").get(firstIdempotentPublish.id)?.count, 1);
    assert.equal(first.db.prepare("SELECT request_id FROM mutation_receipts WHERE request_id = ?").get("publish-receipt-1")?.request_id, "publish-receipt-1");
    assert.throws(
      () => __test.publishConclusion(first.db, first.config, {
        ...idempotentPublishRequest,
        conclusion: "Status: changed\nDone: twice\nBlocked: none\nRisks/Pitfalls: none",
      }),
      /already used/
    );

    const baseline = __test.publishConclusion(first.db, first.config, {
      project: "review-protocol-test",
      topic: "independent-review",
      conclusion: "Status: baseline\nDone: baseline\nBlocked: none\nRisks/Pitfalls: none",
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
    });
    assert.throws(
      () => __test.createReviewCase(first.db, {
        project: "review-protocol-test",
        topic: "different-review-topic",
        baseline_conclusion_id: baseline.id,
        objective: "Verify the implementation independently",
        scope: "Current MCP and workflow files",
        acceptance_criteria: ["Refs are re-read", "No baseline leakage before assessment"],
        snapshot_ref: "worktree:main",
        refs: [{ type: "file", value: "mcp-servers/handoff/src/index.ts" }],
        constraints: ["No commit", "No push"],
        request_id: "review-create-mismatch",
      }),
      /belongs to topic "independent-review"/
    );
    const reviewCase = __test.createReviewCase(first.db, {
      project: "review-protocol-test",
      topic: "independent-review",
      baseline_conclusion_id: baseline.id,
      objective: "Verify the implementation independently",
      scope: "Current MCP and workflow files",
      acceptance_criteria: ["Refs are re-read", "No baseline leakage before assessment"],
      snapshot_ref: "worktree:main",
      refs: [{ type: "file", value: "mcp-servers/handoff/src/index.ts" }],
      constraints: ["No commit", "No push"],
      request_id: "review-create-1",
    });
    const openCaseBaseline = __test.publishConclusion(first.db, first.config, {
      project: "review-list-noncanonical-test",
      workspace: "/tmp/worktree-a",
      topic: "open-case",
      conclusion: "Status: baseline\nDone: seeded\nBlocked: none\nRisks/Pitfalls: none",
      sensitivity: "normal",
    });
    const openCase = __test.createReviewCase(first.db, {
      project: "review-list-noncanonical-test",
      workspace: "/tmp/worktree-a",
      topic: "open-case",
      baseline_conclusion_id: openCaseBaseline.id,
      objective: "List an open case without workspace filtering",
      scope: "Review case listing",
      acceptance_criteria: ["The case is discoverable"],
      snapshot_ref: "worktree:test",
      refs: [],
      constraints: [],
      request_id: "review-list-open-case-1",
    });
    assert.equal(__test.listReviewCases(first.db, {
      project: "review-list-noncanonical-test",
      topic: "open-case",
      status: "open",
      limit: 20,
    }).count, 1);
    assert.equal(__test.listReviewCases(first.db, {
      project: "review-list-noncanonical-test",
      workspace: "/tmp/other-worktree",
      topic: "open-case",
      status: "open",
      limit: 20,
    }).count, 0);
    const canonicalBaseline = __test.publishConclusion(first.db, first.config, {
      project: "my-repo",
      workspace: "/tmp/non-canonical-worktree",
      topic: "canonical-scope",
      conclusion: "Status: baseline\nDone: seeded\nBlocked: none\nRisks/Pitfalls: none",
      sensitivity: "normal",
    });
    __test.createReviewCase(first.db, {
      project: "my-repo",
      workspace: "/tmp/non-canonical-worktree",
      topic: "canonical-scope",
      baseline_conclusion_id: canonicalBaseline.id,
      objective: "Verify canonical workspace omission scope",
      scope: "Review case listing",
      acceptance_criteria: ["Omitted workspace uses canonical scope"],
      snapshot_ref: "worktree:test",
      refs: [],
      constraints: [],
      request_id: "review-list-canonical-scope-1",
    });
    assert.equal(__test.listReviewCases(first.db, {
      project: "my-repo",
      topic: "canonical-scope",
      status: "open",
      limit: 20,
    }).count, 0);
    assert.equal(__test.listReviewCases(first.db, {
      project: "my-repo",
      topic: "canonical-scope",
      status: "open",
      limit: 20,
    }).workspace_scope, "canonical");
    assert.equal(__test.listReviewCases(first.db, {
      project: "my-repo",
      workspace: "/tmp/non-canonical-worktree",
      topic: "canonical-scope",
      status: "open",
      limit: 20,
    }).count, 1);
    const closedOpenCase = __test.transitionReviewCase(first.db, {
      review_case_id: openCase.review_case_id,
      target_status: "closed",
      changed_by: "engineer",
      reason: "Blocking case resolved.",
      expected_status: "open",
      request_id: "review-list-open-case-close-1",
    });
    assert.equal(closedOpenCase.status, "closed");
    const reopenedCase = __test.transitionReviewCase(first.db, {
      review_case_id: openCase.review_case_id,
      target_status: "open",
      changed_by: "engineer",
      reason: "Reopen for follow-up evidence.",
      expected_status: "closed",
      request_id: "review-list-open-case-reopen-1",
    });
    assert.equal(reopenedCase.status, "open");
    assert.ok(!JSON.stringify(reviewCase).includes(baseline.id));
    const packet = __test.getReviewPacket(first.db, reviewCase.review_case_id);
    assert.equal(packet.found, true);
    assert.ok(!JSON.stringify(packet).includes(baseline.id));
    assert.ok(!JSON.stringify(packet).includes("Status: baseline"));
    const taskMaterial = (packet as { task_material: { objective: string; acceptance_criteria: string[]; snapshot_ref: string; constraints: string[] } }).task_material;
    assert.equal(taskMaterial.objective, "Verify the implementation independently");
    assert.deepEqual(taskMaterial.acceptance_criteria, ["Refs are re-read", "No baseline leakage before assessment"]);
    assert.equal(taskMaterial.snapshot_ref, "worktree:main");
    assert.deepEqual(taskMaterial.constraints, ["No commit", "No push"]);
    assert.throws(
      () => __test.submitIndependentAssessment(first.db, first.config, {
        review_case_id: reviewCase.review_case_id,
        reviewer_agent: "opencode",
        assessment: "Status: secret\nDone: Bearer abcdefghijklmnop\nBlocked: none\nRisks/Pitfalls: none",
        request_id: "review-assessment-secret",
      }),
      /Bearer token/
    );
    const assessment = __test.submitIndependentAssessment(first.db, first.config, {
      review_case_id: reviewCase.review_case_id,
      reviewer_agent: "opencode",
      assessment: "Status: independently checked\nDone: evidence reviewed\nBlocked: none\nRisks/Pitfalls: none",
      request_id: "review-assessment-1",
    });
    assert.equal(assessment.submitted, true);
    assert.equal(assessment.baseline.id, baseline.id);
    const assessmentRetry = __test.submitIndependentAssessment(first.db, first.config, {
      review_case_id: reviewCase.review_case_id,
      reviewer_agent: "opencode",
      assessment: "Status: independently checked\nDone: evidence reviewed\nBlocked: none\nRisks/Pitfalls: none",
      request_id: "review-assessment-1",
    });
    assert.deepEqual(assessmentRetry, assessment);
    const comparison = __test.publishReviewComparison(first.db, first.config, {
      review_case_id: reviewCase.review_case_id,
      comparison: "Status: compared\nDone: A/B comparison published\nBlocked: none\nRisks/Pitfalls: workflow-only independence",
      agreements: ["Refs were re-read"],
      author_only: ["Baseline framing"],
      reviewer_only: ["Independent packet evidence"],
      disagreements: [],
      evidence_gaps: ["No production deployment"],
      final_recommendation: "Proceed after the stated evidence gap is accepted.",
      source_agent: "opencode",
      source_thread: "thread-comparison-1",
      source_host: "Desktop",
      model: "gpt-5.6-luna",
      request_id: "review-comparison-1",
    });
    assert.equal(comparison.published, true);
    assert.equal(comparison.topic, "independent-review");
    assert.equal(comparison.handoff_id, comparison.comparison.id);
    assert.equal(comparison.review_case_id, reviewCase.review_case_id);
    assert.equal(comparison.next_mode, "none");
    assert.equal(first.db.prepare("SELECT status FROM review_cases WHERE id = ?").get(reviewCase.review_case_id)?.status, "compared");
    assert.throws(
      () => __test.publishReviewComparison(first.db, first.config, {
        review_case_id: reviewCase.review_case_id,
        comparison: "Status: repeat\nDone: already published\nBlocked: none\nRisks/Pitfalls: none",
        agreements: [],
        author_only: [],
        reviewer_only: [],
        disagreements: [],
        evidence_gaps: [],
        final_recommendation: "No repeat comparison",
        request_id: "review-comparison-repeat-1",
      }),
      /a comparison has already been published/
    );
    const comparedCases = __test.listReviewCases(first.db, {
      project: "review-protocol-test",
      topic: "independent-review",
      status: "compared",
      limit: 20,
    });
    assert.equal(comparedCases.count, 1);
    assert.equal(comparedCases.cases[0].review_case_id, reviewCase.review_case_id);
    assert.equal(comparedCases.cases[0].baseline_withheld, true);
    assert.ok(!JSON.stringify(comparedCases).includes(baseline.id));
    const closeReviewCase = __test.transitionReviewCase(first.db, {
      review_case_id: reviewCase.review_case_id,
      target_status: "closed",
      changed_by: "engineer",
      reason: "Independent comparison completed.",
      expected_status: "compared",
      request_id: "review-case-close-1",
    });
    assert.equal(closeReviewCase.status, "closed");
    const closedPacket = __test.getReviewPacket(first.db, reviewCase.review_case_id);
    assert.match(String(closedPacket.instructions), /no new assessment may be submitted/);
    assert.throws(
      () => __test.transitionReviewCase(first.db, {
        review_case_id: reviewCase.review_case_id,
        target_status: "open",
        changed_by: "engineer",
        reason: "Attempt to reopen completed comparison.",
        expected_status: "closed",
        request_id: "review-case-reopen-completed-1",
      }),
      /Completed review cases cannot be reopened/
    );
    assert.deepEqual(__test.transitionReviewCase(first.db, {
      review_case_id: reviewCase.review_case_id,
      target_status: "closed",
      changed_by: "engineer",
      reason: "Independent comparison completed.",
      expected_status: "compared",
      request_id: "review-case-close-1",
    }), closeReviewCase);
    assert.equal(__test.listReviewCases(first.db, {
      project: "review-protocol-test",
      topic: "independent-review",
      status: "closed",
      limit: 20,
    }).count, 1);
    assert.throws(
      () => __test.publishReviewComparison(first.db, first.config, {
        review_case_id: reviewCase.review_case_id,
        comparison: "Status: retry\nDone: no\nBlocked: none\nRisks/Pitfalls: closed",
        agreements: [],
        author_only: [],
        reviewer_only: [],
        disagreements: [],
        evidence_gaps: [],
        final_recommendation: "No retry",
        request_id: "review-comparison-after-close",
      }),
      /cannot publish a comparison/
    );
    const comparisonRow = first.db.prepare("SELECT review_case_id, assessment_id, conclusion_id, final_recommendation FROM review_comparisons WHERE id = ?")
      .get(comparison.comparison_record_id);
    assert.equal(comparisonRow?.review_case_id, reviewCase.review_case_id);
    assert.equal(comparisonRow?.assessment_id, assessment.assessment_id);
    assert.equal(comparisonRow?.conclusion_id, comparison.comparison.id);
    assert.equal(comparisonRow?.final_recommendation, "Proceed after the stated evidence gap is accepted.");
    const comparisonReplayConclusionRow = first.db.prepare("SELECT source_thread, source_host FROM conclusions WHERE id = ?")
      .get(comparison.comparison.id);
    assert.equal(comparisonReplayConclusionRow?.source_thread, "thread-comparison-1");
    assert.equal(comparisonReplayConclusionRow?.source_host, "desktop");
    const comparisonPublic = __test.listConclusions(first.db, 20, true, {
      project: "review-protocol-test",
      topic: "independent-review",
    });
    const comparisonPublicItem = comparisonPublic.items.find((item) => item.id === comparison.comparison.id) as { source_thread?: string; source_host?: string } | undefined;
    assert.equal(comparisonPublicItem?.source_thread, "thread-comparison-1");
    assert.equal(comparisonPublicItem?.source_host, "desktop");

    const comparisonOrigin = __test.publishConclusion(first.db, first.config, {
      project: "review-comparison-topic-test",
      topic: "round-origin",
      conclusion: "Status: origin\nDone: seeded\nBlocked: none\nRisks/Pitfalls: none",
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
    });
    const comparisonOriginRow = first.db.prepare("SELECT logical_topic_id FROM conclusions WHERE id = ?").get(comparisonOrigin.id);
    const comparisonOriginLogicalTopicId = typeof comparisonOriginRow?.logical_topic_id === "string"
      ? comparisonOriginRow.logical_topic_id
      : undefined;
    const comparisonBaseline = __test.publishConclusion(first.db, first.config, {
      project: "review-comparison-topic-test",
      topic: "round-current",
      conclusion: "Status: baseline\nDone: seeded\nBlocked: none\nRisks/Pitfalls: none",
      supersedes_id: comparisonOrigin.id,
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
    });
    const comparisonCase = __test.createReviewCase(first.db, {
      project: "review-comparison-topic-test",
      topic: "round-current",
      baseline_conclusion_id: comparisonBaseline.id,
      objective: "Keep review rounds on the original logical topic",
      scope: "Cross-agent handoff comparison publication",
      acceptance_criteria: ["The comparison uses the supplied logical topic"],
      snapshot_ref: "worktree:main",
      refs: [],
      constraints: [],
      request_id: "review-comparison-topic-case-1",
    });
    __test.submitIndependentAssessment(first.db, first.config, {
      review_case_id: comparisonCase.review_case_id,
      reviewer_agent: "opencode",
      assessment: "Status: assessed\nDone: evidence reviewed\nBlocked: none\nRisks/Pitfalls: none",
      request_id: "review-comparison-topic-assessment-1",
    });
    const chainedComparison = __test.publishReviewComparison(first.db, first.config, {
      review_case_id: comparisonCase.review_case_id,
      comparison: "Status: compared\nDone: linked to original round\nBlocked: none\nRisks/Pitfalls: none",
      agreements: [],
      author_only: [],
      reviewer_only: [],
      disagreements: [],
      evidence_gaps: [],
      final_recommendation: "Keep the linked review history.",
      logical_topic_id: comparisonOriginLogicalTopicId,
      request_id: "review-comparison-topic-publish-1",
    });
    const chainedComparisonRow = first.db.prepare("SELECT logical_topic_id, supersedes_id FROM conclusions WHERE id = ?")
      .get(chainedComparison.handoff_id);
    assert.equal(chainedComparisonRow?.logical_topic_id, comparisonOriginLogicalTopicId);
    assert.equal(chainedComparisonRow?.supersedes_id, null);

    const supersededComparisonAnchor = __test.publishConclusion(first.db, first.config, {
      project: "review-comparison-supersede-test",
      topic: "round-origin",
      conclusion: "Status: origin\nDone: seeded\nBlocked: none\nRisks/Pitfalls: none",
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
    });
    const supersededComparisonAnchorRow = first.db.prepare("SELECT logical_topic_id FROM conclusions WHERE id = ?")
      .get(supersededComparisonAnchor.id);
    const supersededComparisonLogicalTopicId = typeof supersededComparisonAnchorRow?.logical_topic_id === "string"
      ? supersededComparisonAnchorRow.logical_topic_id
      : undefined;
    const supersededComparisonBaseline = __test.publishConclusion(first.db, first.config, {
      project: "review-comparison-supersede-test",
      topic: "round-current",
      conclusion: "Status: baseline\nDone: seeded\nBlocked: none\nRisks/Pitfalls: none",
      logical_topic_id: supersededComparisonLogicalTopicId,
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
    });
    const supersededComparisonCase = __test.createReviewCase(first.db, {
      project: "review-comparison-supersede-test",
      topic: "round-current",
      baseline_conclusion_id: supersededComparisonBaseline.id,
      objective: "Continue the comparison through a prior conclusion",
      scope: "Cross-agent handoff comparison publication",
      acceptance_criteria: ["The comparison inherits the superseded conclusion's logical topic"],
      snapshot_ref: "worktree:main",
      refs: [],
      constraints: [],
      request_id: "review-comparison-supersede-case-1",
    });
    __test.submitIndependentAssessment(first.db, first.config, {
      review_case_id: supersededComparisonCase.review_case_id,
      reviewer_agent: "opencode",
      assessment: "Status: assessed\nDone: evidence reviewed\nBlocked: none\nRisks/Pitfalls: none",
      request_id: "review-comparison-supersede-assessment-1",
    });
    const supersedingComparison = __test.publishReviewComparison(first.db, first.config, {
      review_case_id: supersededComparisonCase.review_case_id,
      comparison: "Status: compared\nDone: linked to prior conclusion\nBlocked: none\nRisks/Pitfalls: none",
      agreements: [],
      author_only: [],
      reviewer_only: [],
      disagreements: [],
      evidence_gaps: [],
      final_recommendation: "Keep the linked review history.",
      supersedes_id: supersededComparisonAnchor.id,
      request_id: "review-comparison-supersede-publish-1",
    });
    const supersedingComparisonRow = first.db.prepare("SELECT logical_topic_id, supersedes_id FROM conclusions WHERE id = ?")
      .get(supersedingComparison.handoff_id);
    assert.equal(supersedingComparisonRow?.logical_topic_id, supersededComparisonLogicalTopicId);
    assert.equal(supersedingComparisonRow?.supersedes_id, supersededComparisonAnchor.id);
    assert.equal(first.db.prepare("SELECT status FROM conclusions WHERE id = ?").get(supersededComparisonAnchor.id)?.status, "superseded");

    const concurrentBaseline = __test.publishConclusion(first.db, first.config, {
      project: "review-concurrent-test",
      topic: "concurrent-review",
      conclusion: "Status: baseline\nDone: seeded\nBlocked: none\nRisks/Pitfalls: none",
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
    });
    const concurrentRequest = {
      project: "review-concurrent-test",
      topic: "concurrent-review",
      baseline_conclusion_id: concurrentBaseline.id,
      objective: "Exercise concurrent receipt idempotency",
      scope: "Review case creation",
      acceptance_criteria: ["Only one case is created"],
      snapshot_ref: "worktree:test",
      refs: [],
      constraints: [],
      request_id: "review-create-concurrent-1",
    };
    const concurrentResults = await runConcurrentMutationWorkers(
      new URL("./index.js", import.meta.url).href,
      tempHome,
      "createReviewCase",
      concurrentRequest,
    );
    const [concurrentFirst, concurrentSecond] = concurrentResults;
    assert.deepEqual(concurrentSecond, concurrentFirst);
    assert.equal(concurrentFirst.review_case_id, concurrentSecond.review_case_id);
    assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM review_cases WHERE project = ? AND topic = ?").get("review-concurrent-test", "concurrent-review")?.count, 1);
    assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE request_id = ?").get(concurrentRequest.request_id)?.count, 1);

    const transitionConcurrentBaseline = __test.publishConclusion(first.db, first.config, {
      project: "review-transition-concurrent-test",
      topic: "concurrent-transition",
      conclusion: "Status: baseline\nDone: seeded\nBlocked: none\nRisks/Pitfalls: none",
      sensitivity: "normal",
    });
    const transitionConcurrentCase = __test.createReviewCase(first.db, {
      project: "review-transition-concurrent-test",
      topic: "concurrent-transition",
      baseline_conclusion_id: transitionConcurrentBaseline.id,
      objective: "Exercise concurrent lifecycle receipt idempotency",
      scope: "Review case transition",
      acceptance_criteria: ["Only one transition is applied"],
      snapshot_ref: "worktree:test",
      refs: [],
      constraints: [],
      request_id: "review-transition-case-1",
    });
    const transitionConcurrentRequest = {
      review_case_id: transitionConcurrentCase.review_case_id,
      target_status: "cancelled" as const,
      changed_by: "engineer",
      reason: "Concurrent test cancellation.",
      expected_status: "open" as const,
      request_id: "review-transition-concurrent-1",
    };
    const transitionConcurrentResults = await runConcurrentMutationWorkers(
      new URL("./index.js", import.meta.url).href,
      tempHome,
      "transitionReviewCase",
      transitionConcurrentRequest,
    );
    assert.deepEqual(transitionConcurrentResults[1], transitionConcurrentResults[0]);
    assert.equal(first.db.prepare("SELECT lifecycle_status FROM review_cases WHERE id = ?").get(transitionConcurrentCase.review_case_id)?.lifecycle_status, "cancelled");
    assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE request_id = ?").get(transitionConcurrentRequest.request_id)?.count, 1);
    assert.throws(
      () => __test.submitIndependentAssessment(first.db, first.config, {
        review_case_id: transitionConcurrentCase.review_case_id,
        reviewer_agent: "opencode",
        assessment: "Status: blocked\nDone: none\nBlocked: cancelled\nRisks/Pitfalls: none",
        request_id: "review-assessment-cancelled-case",
      }),
      /only open cases accept an assessment/
    );

    const publishConcurrentRequest = {
      project: "publish-concurrent-test",
      topic: "concurrent-publish",
      conclusion: "Status: published\nDone: one conclusion\nBlocked: none\nRisks/Pitfalls: none",
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal" as const,
      request_id: "publish-concurrent-1",
    };
    const concurrentPublishResults = await runConcurrentMutationWorkers(
      new URL("./index.js", import.meta.url).href,
      tempHome,
      "publishConclusion",
      publishConcurrentRequest,
    );
    assert.deepEqual(concurrentPublishResults[1], concurrentPublishResults[0]);
    assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM conclusions WHERE project = ? AND topic = ?").get("publish-concurrent-test", "concurrent-publish")?.count, 1);
    assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE request_id = ?").get(publishConcurrentRequest.request_id)?.count, 1);

    const assessmentConcurrentBaseline = __test.publishConclusion(first.db, first.config, {
      project: "review-assessment-concurrent-test",
      topic: "concurrent-assessment",
      conclusion: "Status: baseline\nDone: seeded\nBlocked: none\nRisks/Pitfalls: none",
      sensitivity: "normal",
    });
    const assessmentConcurrentCase = __test.createReviewCase(first.db, {
      project: "review-assessment-concurrent-test",
      topic: "concurrent-assessment",
      baseline_conclusion_id: assessmentConcurrentBaseline.id,
      objective: "Exercise concurrent assessment receipt idempotency",
      scope: "Independent assessment",
      acceptance_criteria: ["Only one assessment is created"],
      snapshot_ref: "worktree:test",
      refs: [],
      constraints: [],
      request_id: "review-assessment-case-1",
    });
    const concurrentAssessmentRequest = {
      review_case_id: assessmentConcurrentCase.review_case_id,
      reviewer_agent: "opencode",
      assessment: "Status: assessed\nDone: independently checked\nBlocked: none\nRisks/Pitfalls: none",
      refs: [],
      request_id: "review-assessment-concurrent-1",
    };
    const concurrentAssessmentResults = await runConcurrentMutationWorkers(
      new URL("./index.js", import.meta.url).href,
      tempHome,
      "submitIndependentAssessment",
      concurrentAssessmentRequest,
    );
    assert.deepEqual(concurrentAssessmentResults[1], concurrentAssessmentResults[0]);
    assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM review_assessments WHERE review_case_id = ?").get(assessmentConcurrentCase.review_case_id)?.count, 1);
    assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE request_id = ?").get(concurrentAssessmentRequest.request_id)?.count, 1);

    const comparisonConcurrentBaseline = __test.publishConclusion(first.db, first.config, {
      project: "review-comparison-concurrent-test",
      topic: "concurrent-comparison",
      conclusion: "Status: baseline\nDone: seeded\nBlocked: none\nRisks/Pitfalls: none",
      sensitivity: "normal",
    });
    const comparisonConcurrentCase = __test.createReviewCase(first.db, {
      project: "review-comparison-concurrent-test",
      topic: "concurrent-comparison",
      baseline_conclusion_id: comparisonConcurrentBaseline.id,
      objective: "Exercise concurrent comparison receipt idempotency",
      scope: "Review comparison",
      acceptance_criteria: ["Only one comparison is created"],
      snapshot_ref: "worktree:test",
      refs: [],
      constraints: [],
      request_id: "review-comparison-case-1",
    });
    __test.submitIndependentAssessment(first.db, first.config, {
      review_case_id: comparisonConcurrentCase.review_case_id,
      reviewer_agent: "opencode",
      assessment: "Status: assessed\nDone: independently checked\nBlocked: none\nRisks/Pitfalls: none",
      request_id: "review-comparison-assessment-1",
    });
    const concurrentComparisonRequest = {
      review_case_id: comparisonConcurrentCase.review_case_id,
      comparison: "Status: compared\nDone: A/B comparison published\nBlocked: none\nRisks/Pitfalls: none",
      agreements: ["Refs were re-read"],
      author_only: [],
      reviewer_only: [],
      disagreements: [],
      evidence_gaps: [],
      final_recommendation: "Proceed.",
      source_agent: "opencode",
      model: "gpt-5.6-luna",
      request_id: "review-comparison-concurrent-1",
    };
    const concurrentComparisonResults = await runConcurrentMutationWorkers(
      new URL("./index.js", import.meta.url).href,
      tempHome,
      "publishReviewComparison",
      concurrentComparisonRequest,
    );
    assert.deepEqual(concurrentComparisonResults[1], concurrentComparisonResults[0]);
    assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM review_comparisons WHERE review_case_id = ?").get(comparisonConcurrentCase.review_case_id)?.count, 1);
    assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE request_id = ?").get(concurrentComparisonRequest.request_id)?.count, 1);

    const replayBaseline = __test.publishConclusion(first.db, first.config, {
      project: "review-replay-test",
      topic: "receipt-replay",
      conclusion: "Status: baseline\nDone: seeded\nBlocked: none\nRisks/Pitfalls: none",
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
    });
    const replayRequest = {
      project: "review-replay-test",
      topic: "receipt-replay",
      baseline_conclusion_id: replayBaseline.id,
      objective: "Replay after baseline cleanup",
      scope: "Review case creation",
      acceptance_criteria: ["Receipt replay wins over validation"],
      snapshot_ref: "worktree:test",
      refs: [],
      constraints: [],
      request_id: "review-create-replay-1",
    };
    const replayFirst = __test.createReviewCase(first.db, replayRequest);
    first.db.exec("PRAGMA foreign_keys = OFF");
    first.db.prepare("DELETE FROM conclusions WHERE id = ?").run(replayBaseline.id);
    first.db.exec("PRAGMA foreign_keys = ON");
    assert.deepEqual(__test.createReviewCase(first.db, replayRequest), replayFirst);

    const fallbackBaseline = __test.publishConclusion(first.db, first.config, {
      project: "review-fallback-test",
      topic: "fallback-error",
      conclusion: "Status: baseline\nDone: seeded\nBlocked: none\nRisks/Pitfalls: none",
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
    });
    const fallbackCase = __test.createReviewCase(first.db, {
      project: "review-fallback-test",
      topic: "fallback-error",
      baseline_conclusion_id: fallbackBaseline.id,
      objective: "Exercise post-commit fallback failure",
      scope: "Review comparison",
      acceptance_criteria: ["Database commit survives fallback failure"],
      snapshot_ref: "worktree:test",
      refs: [],
      constraints: [],
      request_id: "review-create-fallback-1",
    });
    __test.submitIndependentAssessment(first.db, first.config, {
      review_case_id: fallbackCase.review_case_id,
      reviewer_agent: "opencode",
      assessment: "Status: assessed\nDone: evidence checked\nBlocked: none\nRisks/Pitfalls: none",
      request_id: "review-assessment-fallback-1",
    });
    const fallbackBlocker = join(tempHome, "fallback-file-blocker");
    writeFileSync(fallbackBlocker, "not a directory");
    assert.throws(
      () => __test.publishReviewComparison(first.db, { ...first.config, filesDir: fallbackBlocker }, {
        review_case_id: fallbackCase.review_case_id,
        comparison: "Status: compared\nDone: committed before fallback\nBlocked: none\nRisks/Pitfalls: fallback write failed",
        agreements: [],
        author_only: [],
        reviewer_only: [],
        disagreements: [],
        evidence_gaps: [],
        final_recommendation: "Database state remains committed.",
        request_id: "review-comparison-fallback-1",
      }),
      /EEXIST|not a directory|exists/
    );
    assert.equal(first.db.prepare("SELECT status FROM review_cases WHERE id = ?").get(fallbackCase.review_case_id)?.status, "compared");
    assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM review_comparisons WHERE review_case_id = ?").get(fallbackCase.review_case_id)?.count, 1);

    const defaultsBaseline = __test.publishConclusion(first.db, first.config, {
      project: "review-defaults-test",
      topic: "internal-defaults",
      conclusion: "Status: baseline\nDone: seeded\nBlocked: none\nRisks/Pitfalls: none",
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
    });
    const defaultsCase = __test.createReviewCase(first.db, {
      project: "review-defaults-test",
      topic: "internal-defaults",
      baseline_conclusion_id: defaultsBaseline.id,
      objective: "Exercise internal task material defaults",
      scope: "Review case creation",
      acceptance_criteria: ["Missing arrays become empty"],
      snapshot_ref: "worktree:test",
      request_id: "review-create-defaults-1",
    });
    const defaultsPacket = __test.getReviewPacket(first.db, defaultsCase.review_case_id);
    assert.deepEqual((defaultsPacket as { task_material: { refs: unknown[]; constraints: unknown[] } }).task_material.refs, []);
    assert.deepEqual((defaultsPacket as { task_material: { refs: unknown[]; constraints: unknown[] } }).task_material.constraints, []);

    const partialBaseline = __test.publishConclusion(first.db, first.config, {
      project: "review-ready-partial-test",
      topic: "implementation",
      conclusion: "Status: baseline\nDone: seeded\nBlocked: none\nRisks/Pitfalls: none",
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
    });
    __test.createReviewCase(first.db, {
      project: "review-ready-partial-test",
      topic: "implementation",
      baseline_conclusion_id: partialBaseline.id,
      objective: "Existing case",
      scope: "Existing scope",
      acceptance_criteria: ["Existing criterion"],
      snapshot_ref: "worktree:existing",
      refs: [],
      constraints: [],
      request_id: "review-ready-partial-create-1",
    });
    const partialReady = __test.publishReviewReadyImplementation(first.db, first.config, {
      project: "review-ready-partial-test",
      topic: "implementation",
      conclusion: "Status: review-ready\nDone: implementation persisted\nBlocked: none\nRisks/Pitfalls: retry case only",
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
      implementation_request_id: "review-ready-partial-publish-1",
      create_request_id: "review-ready-partial-create-1",
      objective: "Different material causes the existing create request to reject",
      scope: "Current scope",
      acceptance_criteria: ["Partial success is reported"],
      snapshot_ref: "worktree:current",
      refs: [],
      constraints: [],
    });
    assert.equal(partialReady.partial_success, true);
    assert.equal(partialReady.topic, "implementation");
    assert.equal(partialReady.handoff_id, partialReady.implementation_handoff_id);
    assert.ok(partialReady.implementation_handoff_id);
    assert.equal(partialReady.review_case_id, null);
    assert.equal(partialReady.next_mode, "none");
    assert.equal(partialReady.review_case_request_id, "review-ready-partial-create-1");
    const ready = __test.publishReviewReadyImplementation(first.db, first.config, {
      project: "review-ready-test",
      topic: "implementation",
      conclusion: "Status: review-ready\nDone: implementation complete\nBlocked: none\nRisks/Pitfalls: review is workflow-level",
      source_agent: "codex",
      source_thread: "thread-review-ready-1",
      source_host: "cli",
      model: "gpt-5.6-luna",
      sensitivity: "normal",
      implementation_request_id: "review-ready-publish-1",
      create_request_id: "review-ready-create-1",
      objective: "Review the completed implementation independently",
      scope: "MCP handoff implementation",
      acceptance_criteria: ["Tests pass", "Refs are current"],
      snapshot_ref: "worktree:main",
      refs: [{ type: "file", value: "mcp-servers/handoff/src/index.ts" }],
      constraints: ["No commit", "No push"],
    });
    assert.equal(ready.partial_success, false);
    assert.equal(ready.topic, "implementation");
    assert.equal(ready.handoff_id, ready.implementation_handoff_id);
    assert.ok(ready.implementation_handoff_id);
    assert.ok(ready.review_case_id);
    assert.equal(ready.next_mode, "independent_review");
    const readyConclusionRow = first.db.prepare("SELECT source_thread, source_host FROM conclusions WHERE id = ?")
      .get(ready.implementation_handoff_id);
    assert.equal(readyConclusionRow?.source_thread, "thread-review-ready-1");
    assert.equal(readyConclusionRow?.source_host, "cli");
    const readyPublic = __test.listConclusions(first.db, 20, true, {
      project: "review-ready-test",
      topic: "implementation",
    });
    const readyPublicItem = readyPublic.items.find((item) => item.id === ready.implementation_handoff_id) as { source_thread?: string; source_host?: string } | undefined;
    assert.equal(readyPublicItem?.source_thread, "thread-review-ready-1");
    assert.equal(readyPublicItem?.source_host, "cli");
    assert.deepEqual(__test.publishReviewReadyImplementation(first.db, first.config, {
      project: "review-ready-test",
      topic: "implementation",
      conclusion: "Status: review-ready\nDone: implementation complete\nBlocked: none\nRisks/Pitfalls: review is workflow-level",
      source_agent: "codex",
      source_thread: "thread-review-ready-1",
      source_host: "cli",
      model: "gpt-5.6-luna",
      sensitivity: "normal",
      implementation_request_id: "review-ready-publish-1",
      create_request_id: "review-ready-create-1",
      objective: "Review the completed implementation independently",
      scope: "MCP handoff implementation",
      acceptance_criteria: ["Tests pass", "Refs are current"],
      snapshot_ref: "worktree:main",
      refs: [{ type: "file", value: "mcp-servers/handoff/src/index.ts" }],
      constraints: ["No commit", "No push"],
    }), ready);

    const concurrentReadyRequest = {
      project: "review-ready-concurrent-test",
      topic: "concurrent-review-ready",
      conclusion: "Status: review-ready\nDone: implementation complete\nBlocked: none\nRisks/Pitfalls: workflow-only independence",
      source_agent: "opencode",
      source_host: "desktop",
      model: "gpt-5.6-luna",
      sensitivity: "normal" as const,
      implementation_request_id: "review-ready-concurrent-publish-1",
      create_request_id: "review-ready-concurrent-create-1",
      objective: "Review the implementation independently",
      scope: "Review-ready handoff",
      acceptance_criteria: ["Only one implementation and case are created"],
      snapshot_ref: "worktree:test",
      refs: [],
      constraints: [],
    };
    const concurrentReadyResults = await runConcurrentMutationWorkers(
      new URL("./index.js", import.meta.url).href,
      tempHome,
      "publishReviewReadyImplementation",
      concurrentReadyRequest,
    );
    assert.deepEqual(concurrentReadyResults[1], concurrentReadyResults[0]);
    assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM conclusions WHERE project = ? AND topic = ?").get("review-ready-concurrent-test", "concurrent-review-ready")?.count, 1);
    assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM review_cases WHERE project = ? AND topic = ?").get("review-ready-concurrent-test", "concurrent-review-ready")?.count, 1);

    assert.deepEqual(__test.publishReviewComparison(first.db, first.config, {
      review_case_id: reviewCase.review_case_id,
      comparison: "Status: compared\nDone: A/B comparison published\nBlocked: none\nRisks/Pitfalls: workflow-only independence",
      agreements: ["Refs were re-read"],
      author_only: ["Baseline framing"],
      reviewer_only: ["Independent packet evidence"],
      disagreements: [],
      evidence_gaps: ["No production deployment"],
      final_recommendation: "Proceed after the stated evidence gap is accepted.",
      source_agent: "opencode",
      source_thread: "thread-comparison-1",
      source_host: "Desktop",
      model: "gpt-5.6-luna",
      request_id: "review-comparison-1",
    }), comparison);
    const comparisonConclusionRow = first.db.prepare("SELECT source_thread, source_host FROM conclusions WHERE id = ?")
      .get(comparison.comparison.id);
    assert.equal(comparisonConclusionRow?.source_thread, "thread-comparison-1");
    assert.equal(comparisonConclusionRow?.source_host, "desktop");

    // a section keyword appearing only as a substring of a larger ASCII word (e.g. "unblocked",
    // "undone") must not count as that section being present.
    const substringFalsePositiveHandoff = __test.publishConclusion(first.db, first.config, {
      project: "handoff-section-warning-test",
      topic: "substring-false-positive",
      conclusion: "Status: shipped. Done: implemented. The migration is unblocked: no manual steps needed.",
      source_agent: "codex",
      source_host: "cli",
      sensitivity: "normal",
    });
    assert.ok(substringFalsePositiveHandoff.warning?.includes("missing recommended handoff sections: Blocked, Risks"));

    // getTopicContext must include latestSourceHost on the topic object
    const sourceHostContext = __test.getTopicContext(first.db, sourceHostPublished.id);
    // The topic_id param to getTopicContext is the logical_topic_id, not the conclusion id.
    // Resolve the logical topic from the published record.
    const sourceHostLogicalRow = first.db.prepare("SELECT logical_topic_id FROM conclusions WHERE id = ?").get(sourceHostPublished.id) as { logical_topic_id: string } | undefined;
    assert.ok(sourceHostLogicalRow?.logical_topic_id);
    const topicCtx = __test.getTopicContext(first.db, sourceHostLogicalRow.logical_topic_id);
    assert.equal(topicCtx.found, true);
    assert.equal((topicCtx as { topic?: { latestSourceHost?: string } }).topic?.latestSourceHost, "desktop");

    const traceDbPath = join(tempHome, 'traces.db');
    const eventsDbPath = join(tempHome, 'events.db');
    process.env.AGENT_EVENTS_DB_PATH = eventsDbPath;
    process.env.WORKFLOW_TRACES_DB_PATH = traceDbPath;
    const eventsStore = new AgentEventsStore(eventsDbPath);
    const traceStore = new TraceStore(traceDbPath);
    try {
      eventsStore.publish({
        project: 'my-repo',
        workspace: null,
        topic: 'explicit-topic',
        logicalTopicId: explicitTopic.logical_topic.id,
        agent: 'codex',
        eventType: 'task_claimed',
      });
      const runId = traceStore.createRun({
        capabilityId: 'review',
        actor: 'codex',
        metadata: {
          handoff: {
            project: 'my-repo',
            topic: 'explicit-topic',
            logical_topic_id: explicitTopic.logical_topic.id,
          },
        },
      });
      traceStore.finishRun(runId);
      const context = __test.getTopicContext(first.db, explicitTopic.logical_topic.id) as { found: boolean; events: unknown[]; runs: unknown[]; mergedTimeline: unknown[] };
      assert.equal(context.found, true);
      assert.equal(context.events.length, 1);
      assert.equal(context.runs.length, 1);
      assert.ok(context.mergedTimeline.length >= 3);
    } finally {
      eventsStore.close();
      traceStore.close();
      delete process.env.AGENT_EVENTS_DB_PATH;
      delete process.env.WORKFLOW_TRACES_DB_PATH;
    }

    const sensitiveTopic = __test.resolveTopicRecord(first.db, {
      project: 'my-repo',
      topic: 'sensitive-topic',
    });
    __test.publishConclusion(first.db, first.config, {
      project: 'my-repo',
      topic: 'sensitive-topic',
      logical_topic_id: sensitiveTopic.logical_topic.id,
      conclusion: 'secret review details should not be returned by default',
      sensitivity: 'sensitive',
    });
    const sensitiveContext = __test.getTopicContext(first.db, sensitiveTopic.logical_topic.id) as {
      found: boolean;
      detail: {
        latest: { conclusion?: string; conclusionPreview?: string } | null;
        records: Array<{ conclusion?: string; conclusionPreview?: string }>;
      };
      mergedTimeline: Array<{ kind: string; body: string }>;
    };
    assert.equal(sensitiveContext.found, true);
    assert.equal(sensitiveContext.detail.latest?.conclusion, undefined);
    assert.ok(sensitiveContext.detail.latest?.conclusionPreview);
    assert.equal(sensitiveContext.detail.records[0]?.conclusion, undefined);
    assert.ok(sensitiveContext.detail.records[0]?.conclusionPreview);
    const sensitiveTimelineItem = sensitiveContext.mergedTimeline.find((item) => item.kind === 'handoff');
    assert.equal(sensitiveTimelineItem?.body, sensitiveContext.detail.records[0]?.conclusionPreview || '');

    const emptyTopic = __test.resolveTopicRecord(first.db, {
      project: 'my-repo',
      topic: 'empty-context-topic',
    });
    const emptyContext = __test.getTopicContext(first.db, emptyTopic.logical_topic.id) as {
      found: boolean;
      detail: { latest: null; records: unknown[]; rawTopics: string[] };
      events: unknown[];
      runs: unknown[];
      mergedTimeline: unknown[];
    };
    assert.equal(emptyContext.found, true);
    assert.equal(emptyContext.detail.latest, null);
    assert.deepEqual(emptyContext.detail.records, []);
    assert.deepEqual(emptyContext.detail.rawTopics, []);
    assert.deepEqual(emptyContext.events, []);
    assert.deepEqual(emptyContext.runs, []);
    assert.deepEqual(emptyContext.mergedTimeline, []);
  } finally {
    __test.resetDatabaseForTests();
    rmSync(tempHome, { recursive: true, force: true });
  }
});
