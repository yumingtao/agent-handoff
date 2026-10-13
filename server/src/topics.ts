import { randomUUID } from "node:crypto";
// @ts-ignore repo-local shared runtime module
import { TOPIC_ALIASES } from "../../shared/topic-canonicalization/aliases.mjs";
// @ts-ignore repo-local shared runtime module
import { createTopicResolver, resolveCanonicalTopicWithRaw } from "../../shared/topic-canonicalization/index.mjs";
// @ts-ignore repo-local shared runtime module
import { normalizeWorkspace, workspaceIdentityCandidates } from "../../shared/workspace-normalization/index.mjs";
import type { ConclusionRecord, LogicalTopicRecord, SqliteDatabase, TopicStateChangeRecord } from "./types.js";
import { formatLocal, nowIso } from "./util.js";
import { SAFETY_NOTE } from "./constants.js";

export const resolveCanonicalTopic = createTopicResolver(TOPIC_ALIASES);

export function normalizeLogicalTopic(row: Record<string, unknown>): LogicalTopicRecord {
  return row as unknown as LogicalTopicRecord;
}

export function publicLogicalTopic(row: LogicalTopicRecord) {
  return {
    id: row.id,
    project: row.project,
    workspace: row.workspace,
    canonical_topic_name: row.canonical_topic_name,
    display_name: row.display_name,
    description: row.description,
    created_at: row.created_at,
    created_at_display: formatLocal(row.created_at),
    updated_at: row.updated_at,
    updated_at_display: formatLocal(row.updated_at),
    task_state: row.task_state || null,
    completed_at: row.completed_at || null,
    completed_at_display: row.completed_at ? formatLocal(row.completed_at) : null,
    completed_by: row.completed_by || null,
    cancelled_at: row.cancelled_at || null,
    cancelled_at_display: row.cancelled_at ? formatLocal(row.cancelled_at) : null,
    cancelled_by: row.cancelled_by || null,
  };
}

export function getLogicalTopicById(db: SqliteDatabase, logicalTopicId: string): LogicalTopicRecord | null {
  const row = db.prepare("SELECT * FROM logical_topics WHERE id = ?").get(logicalTopicId);
  return row ? normalizeLogicalTopic(row) : null;
}

export function findLogicalTopicByIdentity(db: SqliteDatabase, project: string, workspace: string | null, canonicalTopic: string): LogicalTopicRecord | null {
  const workspaceCandidates = workspaceIdentityCandidates(project, workspace);
  const placeholders = workspaceCandidates.map(() => "?").join(", ");
  const row = db.prepare(`
    SELECT * FROM logical_topics
    WHERE project = ? AND coalesce(workspace, '') IN (${placeholders}) AND canonical_topic_name = ?
    LIMIT 1
  `).get(project, ...workspaceCandidates.map((candidate: string | null) => candidate || ""), canonicalTopic);
  return row ? normalizeLogicalTopic(row) : null;
}

export function createLogicalTopic(db: SqliteDatabase, project: string, workspace: string | null, canonicalTopic: string, timestamp: string): LogicalTopicRecord {
  const record: LogicalTopicRecord = {
    id: randomUUID(),
    project,
    workspace,
    canonical_topic_name: canonicalTopic,
    display_name: canonicalTopic,
    description: null,
    created_at: timestamp,
    updated_at: timestamp,
    task_state: "open",
    completed_at: null,
    completed_by: null,
    cancelled_at: null,
    cancelled_by: null,
  };
  db.prepare(`
    INSERT INTO logical_topics (id, project, workspace, canonical_topic_name, display_name, description, created_at, updated_at, task_state, completed_at, completed_by, cancelled_at, cancelled_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.project,
    record.workspace,
    record.canonical_topic_name,
    record.display_name,
    record.description,
    record.created_at,
    record.updated_at,
    record.task_state,
    record.completed_at,
    record.completed_by,
    record.cancelled_at,
    record.cancelled_by,
  );
  return record;
}

export function getOrCreateLogicalTopic(db: SqliteDatabase, project: string, workspace: string | null, canonicalTopic: string, timestamp = nowIso()): LogicalTopicRecord {
  const existing = findLogicalTopicByIdentity(db, project, workspace, canonicalTopic);
  if (existing) return existing;
  try {
    return createLogicalTopic(db, project, workspace, canonicalTopic, timestamp);
  } catch {
    const raced = findLogicalTopicByIdentity(db, project, workspace, canonicalTopic);
    if (raced) return raced;
    throw new Error(`Failed to get or create logical topic for ${project}/${workspace || ''}/${canonicalTopic}`);
  }
}

// --- topic task state machine (design: docs/topic-task-state-model-design.md §3) ---

export const ALLOWED_TRANSITIONS: Record<string, Array<"open" | "done" | "cancelled">> = {
  open: ["done", "cancelled"],
  done: ["open"],
  cancelled: ["open"],
};

export function transitionAction(from: string | null, to: "open" | "done" | "cancelled"): "complete" | "cancel" | "reopen" | null {
  if (from === to) return null;
  if (to === "done") return "complete";
  if (to === "cancelled") return "cancel";
  if (to === "open") return "reopen";
  return null;
}

export function insertTopicStateChange(
  db: SqliteDatabase,
  logicalTopicId: string,
  fromState: string | null,
  toState: "open" | "done" | "cancelled",
  action: "complete" | "cancel" | "reopen" | "auto_reopen",
  changedBy: string,
  reason: string | null,
  timestamp: string,
): TopicStateChangeRecord {
  const record: TopicStateChangeRecord = {
    id: randomUUID(),
    logical_topic_id: logicalTopicId,
    from_state: fromState,
    to_state: toState,
    action,
    changed_by: changedBy,
    reason,
    created_at: timestamp,
  };
  db.prepare(`
    INSERT INTO topic_state_changes (id, logical_topic_id, from_state, to_state, action, changed_by, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.logical_topic_id,
    record.from_state,
    record.to_state,
    record.action,
    record.changed_by,
    record.reason,
    record.created_at,
  );
  return record;
}

export function listTopicStateChanges(db: SqliteDatabase, logicalTopicId: string, limit = 50): TopicStateChangeRecord[] {
  return db.prepare(`
    SELECT * FROM topic_state_changes
    WHERE logical_topic_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(logicalTopicId, limit) as TopicStateChangeRecord[];
}

export function applyTopicStateTransition(
  db: SqliteDatabase,
  logicalTopicId: string,
  fromState: string | null,
  toState: "open" | "done" | "cancelled",
  action: "complete" | "cancel" | "reopen" | "auto_reopen",
  changedBy: string,
  reason: string | null,
  timestamp: string,
): void {
  if (toState === "done") {
    db.prepare(`
      UPDATE logical_topics
      SET task_state = ?, completed_at = ?, completed_by = ?, cancelled_at = NULL, cancelled_by = NULL, updated_at = ?
      WHERE id = ?
    `).run(toState, timestamp, changedBy, timestamp, logicalTopicId);
  } else if (toState === "cancelled") {
    db.prepare(`
      UPDATE logical_topics
      SET task_state = ?, cancelled_at = ?, cancelled_by = ?, completed_at = NULL, completed_by = NULL, updated_at = ?
      WHERE id = ?
    `).run(toState, timestamp, changedBy, timestamp, logicalTopicId);
  } else {
    // reopen → open: clear terminal-state fields
    db.prepare(`
      UPDATE logical_topics
      SET task_state = ?, completed_at = NULL, completed_by = NULL, cancelled_at = NULL, cancelled_by = NULL, updated_at = ?
      WHERE id = ?
    `).run(toState, timestamp, logicalTopicId);
  }
  insertTopicStateChange(db, logicalTopicId, fromState, toState, action, changedBy, reason, timestamp);
}

export function transitionTopicState(
  db: SqliteDatabase,
  params: {
    logical_topic_id: string;
    target_state: "open" | "done" | "cancelled";
    changed_by: string;
    reason?: string;
    expected_state?: "open" | "done" | "cancelled";
  },
) {
  const { logical_topic_id, target_state, changed_by, reason, expected_state } = params;

  // Pre-transaction param validation (does not touch DB state).
  if (!changed_by || !changed_by.trim()) {
    throw new Error("changed_by is required and must identify the actor; it must not be inferred from free-form text.");
  }
  if (target_state === "done" || target_state === "cancelled") {
    if (!reason || !reason.trim()) {
      throw new Error(`A reason is required for transitioning to '${target_state}'.`);
    }
  }

  const timestamp = nowIso();
  let updated: LogicalTopicRecord | null = null;
  let appliedAction: "complete" | "cancel" | "reopen" | null = null;

  // All state reads and validation happen inside BEGIN IMMEDIATE to prevent TOCTOU races.
  db.exec("BEGIN IMMEDIATE");
  try {
    const topic = getLogicalTopicById(db, logical_topic_id);
    if (!topic) {
      throw new Error(`logical_topic_id not found: ${logical_topic_id}`);
    }

    const currentState = topic.task_state;
    // Legacy topic with null task_state: treat as 'open' for transition purposes.
    const effectiveCurrent = currentState || "open";

    // Optimistic concurrency check (inside lock so the state can't change between read and write).
    if (expected_state !== undefined && expected_state !== effectiveCurrent) {
      throw new Error(
        `Optimistic concurrency conflict: expected_state='${expected_state}' but actual state is '${effectiveCurrent}'.`,
      );
    }

    // Idempotent: same state, no-op (commit empty transaction).
    if (effectiveCurrent === target_state) {
      db.exec("COMMIT");
      return {
        updated: false,
        idempotent: true,
        logical_topic_id,
        task_state: effectiveCurrent,
        safety_note: SAFETY_NOTE,
      };
    }

    // Validate allowed transition
    const allowed = ALLOWED_TRANSITIONS[effectiveCurrent] || [];
    if (!allowed.includes(target_state)) {
      throw new Error(
        `Illegal transition: '${effectiveCurrent}' → '${target_state}'. Allowed targets from '${effectiveCurrent}': [${allowed.join(", ")}].`,
      );
    }

    const action = transitionAction(effectiveCurrent, target_state);
    if (!action) {
      throw new Error(`No action mapped for transition '${effectiveCurrent}' → '${target_state}'.`);
    }

    applyTopicStateTransition(db, logical_topic_id, currentState, target_state, action, changed_by, reason || null, timestamp);
    db.exec("COMMIT");
    updated = getLogicalTopicById(db, logical_topic_id)!;
    appliedAction = action;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    updated: true,
    idempotent: false,
    logical_topic_id,
    task_state: updated!.task_state,
    completed_at: updated!.completed_at,
    completed_by: updated!.completed_by,
    cancelled_at: updated!.cancelled_at,
    cancelled_by: updated!.cancelled_by,
    action: appliedAction,
    safety_note: SAFETY_NOTE,
  };
}

export function resolveTopicRecord(db: SqliteDatabase, params: { project: string; workspace?: string; topic: string }) {
  const workspace = normalizeWorkspace(params.project, params.workspace || null);
  const { canonicalTopic, topicRaw } = resolveCanonicalTopicWithRaw(
    params.project,
    workspace,
    params.topic,
    resolveCanonicalTopic,
  );
  const logicalTopic = getOrCreateLogicalTopic(db, params.project, workspace, canonicalTopic);
  return {
    logical_topic: publicLogicalTopic(logicalTopic),
    canonical_topic: canonicalTopic,
    topic_raw: topicRaw,
    safety_note: SAFETY_NOTE,
  };
}
