import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { safeJson } from './redaction.mjs';

const SCHEMA_VERSION = 2;

export class TraceStore {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    applyMigrations(this.db);
  }

  now() { return new Date().toISOString(); }

  createRun({ runId = randomUUID(), capabilityId, actor = '', inputHash = '', metadata = {} }) {
    this.db.prepare(`INSERT INTO workflow_runs VALUES (?, ?, 'running', ?, ?, ?, NULL, ?)`).run(
      runId, capabilityId, actor, inputHash, this.now(), safeJson(metadata)
    );
    upsertWorkflowRunTopic(this.db, runId, metadata, this.now());
    return runId;
  }

  finishRun(runId, status = 'completed', metadata = {}) {
    const current = this.db.prepare(`SELECT metadata_json FROM workflow_runs WHERE run_id = ?`).get(runId);
    const merged = { ...(current ? JSON.parse(current.metadata_json) : {}), ...metadata };
    this.db.prepare(`UPDATE workflow_runs SET status = ?, ended_at = ?, metadata_json = ? WHERE run_id = ?`).run(
      status, this.now(), safeJson(merged), runId
    );
    upsertWorkflowRunTopic(this.db, runId, merged, this.now());
  }

  startSpan({ runId, parentSpanId = null, kind, name, actor = '', attributes = {} }) {
    const spanId = randomUUID();
    this.db.prepare(`INSERT INTO spans VALUES (?, ?, ?, ?, ?, ?, 'running', ?, NULL, ?)`).run(
      spanId, runId, parentSpanId, kind, name, actor, this.now(), safeJson(attributes)
    );
    return spanId;
  }

  endSpan(spanId, status = 'ok', attributes = {}) {
    this.db.prepare(`UPDATE spans SET status = ?, ended_at = ?, attributes_json = ? WHERE span_id = ?`).run(
      status, this.now(), safeJson(attributes), spanId
    );
  }

  recordToolCall({ runId, spanId = null, tool, target = '', effect = '', decision = '', outcome = '', details = {} }) {
    this.db.prepare(`INSERT INTO tool_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      randomUUID(), runId, spanId, tool, target, effect, decision, outcome, this.now(), safeJson(details)
    );
  }

  recordPolicyDecision({ runId = null, actor = '', tool = '', target = '', effect = '', decision, reason = '' }) {
    this.db.prepare(`INSERT INTO policy_decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      randomUUID(), runId, actor, tool, target, effect, decision, reason, this.now()
    );
  }

  recordHumanGate({ runId, gate, verdict, decidedBy, details = {} }) {
    this.db.prepare(`INSERT INTO human_gates VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      randomUUID(), runId, gate, verdict, decidedBy, this.now(), safeJson(details)
    );
  }

  getRun(runId) {
    const run = this.db.prepare(`SELECT * FROM workflow_runs WHERE run_id = ?`).get(runId);
    if (!run) return null;
    return {
      ...run,
      metadata: JSON.parse(run.metadata_json),
      spans: this.db.prepare(`SELECT * FROM spans WHERE run_id = ? ORDER BY started_at`).all(runId).map(parseAttributes),
      toolCalls: this.db.prepare(`SELECT * FROM tool_calls WHERE run_id = ? ORDER BY occurred_at`).all(runId).map(parseDetails),
      policyDecisions: this.db.prepare(`SELECT * FROM policy_decisions WHERE run_id = ? ORDER BY occurred_at`).all(runId),
      humanGates: this.db.prepare(`SELECT * FROM human_gates WHERE run_id = ? ORDER BY occurred_at`).all(runId).map(parseDetails)
    };
  }

  listRuns(limit = 100) {
    return this.db.prepare(`SELECT run_id, capability_id, status, actor, input_hash, started_at, ended_at, metadata_json FROM workflow_runs ORDER BY started_at DESC LIMIT ?`).all(limit)
      .map(({ metadata_json, ...row }) => ({ ...row, metadata: JSON.parse(metadata_json) }));
  }

  listRunTopicsByLogicalTopic(logicalTopicId, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM workflow_run_topics
      WHERE logical_topic_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(logicalTopicId, limit);
  }

  listRunTopics(limit = 1000) {
    return this.db.prepare(`
      SELECT * FROM workflow_run_topics
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
  }

  metrics() {
    const runs = this.listRuns(10_000);
    const policy = this.db.prepare(`SELECT decision, COUNT(*) AS count FROM policy_decisions GROUP BY decision`).all();
    const gates = this.db.prepare(`SELECT verdict, COUNT(*) AS count FROM human_gates GROUP BY verdict`).all();
    const agentSpans = this.db.prepare(`SELECT status, attributes_json FROM spans WHERE kind = 'agent'`).all();
    const totals = agentSpans.reduce((acc, row) => {
      const attributes = JSON.parse(row.attributes_json);
      acc.promptTokens += Number(attributes.usage?.prompt_tokens || attributes.usage?.input_tokens || 0);
      acc.completionTokens += Number(attributes.usage?.completion_tokens || attributes.usage?.output_tokens || 0);
      acc.latencyMs += Number(attributes.latencyMs || 0);
      return acc;
    }, { promptTokens: 0, completionTokens: 0, latencyMs: 0 });
    return {
      runs: { total: runs.length, byStatus: countBy(runs, 'status') },
      agents: { total: agentSpans.length, byStatus: countBy(agentSpans, 'status'), ...totals },
      policy: Object.fromEntries(policy.map((row) => [row.decision, row.count])),
      humanGates: Object.fromEntries(gates.map((row) => [row.verdict, row.count]))
    };
  }

  pruneBefore(isoTimestamp) {
    const runIds = this.db.prepare(`SELECT run_id FROM workflow_runs WHERE started_at < ?`).all(isoTimestamp).map((row) => row.run_id);
    this.db.exec('BEGIN');
    try {
      for (const runId of runIds) {
        this.db.prepare(`DELETE FROM workflow_run_topics WHERE run_id = ?`).run(runId);
        this.db.prepare(`DELETE FROM tool_calls WHERE run_id = ?`).run(runId);
        this.db.prepare(`DELETE FROM policy_decisions WHERE run_id = ?`).run(runId);
        this.db.prepare(`DELETE FROM human_gates WHERE run_id = ?`).run(runId);
        this.db.prepare(`DELETE FROM spans WHERE run_id = ?`).run(runId);
        this.db.prepare(`DELETE FROM workflow_runs WHERE run_id = ?`).run(runId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return runIds.length;
  }

  close() { this.db.close(); }
}

function applyMigrations(db) {
  const applied = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version;
  const currentVersion = Number(applied || 0);
  db.exec('BEGIN');
  try {
    if (currentVersion < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_runs (
          run_id TEXT PRIMARY KEY, capability_id TEXT NOT NULL, status TEXT NOT NULL,
          actor TEXT, input_hash TEXT, started_at TEXT NOT NULL, ended_at TEXT, metadata_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS spans (
          span_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_span_id TEXT,
          kind TEXT NOT NULL, name TEXT NOT NULL, actor TEXT, status TEXT NOT NULL,
          started_at TEXT NOT NULL, ended_at TEXT, attributes_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tool_calls (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL, span_id TEXT, tool TEXT NOT NULL,
          target TEXT, effect TEXT, decision TEXT, outcome TEXT, occurred_at TEXT NOT NULL, details_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS policy_decisions (
          id TEXT PRIMARY KEY, run_id TEXT, actor TEXT, tool TEXT, target TEXT,
          effect TEXT, decision TEXT NOT NULL, reason TEXT, occurred_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS human_gates (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL, gate TEXT NOT NULL, verdict TEXT NOT NULL,
          decided_by TEXT NOT NULL, occurred_at TEXT NOT NULL, details_json TEXT NOT NULL
        );
      `);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        1,
        'initial_trace_store_schema',
        new Date().toISOString(),
      );
    }
    if (currentVersion < 2) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_run_topics (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          logical_topic_id TEXT,
          project TEXT NOT NULL,
          workspace TEXT,
          topic_raw TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_run_topics_logical_topic ON workflow_run_topics(logical_topic_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_workflow_run_topics_run_id ON workflow_run_topics(run_id);
      `);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        2,
        'workflow_run_topics',
        new Date().toISOString(),
      );
    }
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function upsertWorkflowRunTopic(db, runId, metadata, createdAt) {
  const topicInfo = extractTopicMetadata(metadata);
  if (!topicInfo) return;
  const existing = db.prepare('SELECT id FROM workflow_run_topics WHERE run_id = ?').get(runId);
  if (existing?.id) {
    db.prepare(`
      UPDATE workflow_run_topics
      SET logical_topic_id = ?, project = ?, workspace = ?, topic_raw = ?, created_at = ?
      WHERE run_id = ?
    `).run(topicInfo.logicalTopicId, topicInfo.project, topicInfo.workspace, topicInfo.topicRaw, createdAt, runId);
    return;
  }
  db.prepare(`
    INSERT INTO workflow_run_topics (id, run_id, logical_topic_id, project, workspace, topic_raw, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), runId, topicInfo.logicalTopicId, topicInfo.project, topicInfo.workspace, topicInfo.topicRaw, createdAt);
}

function extractTopicMetadata(metadata) {
  if (metadata?.handoff?.project && metadata?.handoff?.topic) {
    return {
      logicalTopicId: metadata.handoff.logical_topic_id || null,
      project: metadata.handoff.project,
      workspace: metadata.handoff.workspace || null,
      topicRaw: metadata.handoff.topic_raw || metadata.handoff.topic,
    };
  }
  if (metadata?.project && metadata?.topic) {
    return {
      logicalTopicId: metadata.logical_topic_id || null,
      project: metadata.project,
      workspace: metadata.workspace || null,
      topicRaw: metadata.topic_raw || metadata.topic,
    };
  }
  return null;
}

function parseAttributes(row) {
  const { attributes_json, ...rest } = row;
  return { ...rest, attributes: JSON.parse(attributes_json) };
}

function parseDetails(row) {
  const { details_json, ...rest } = row;
  return { ...rest, details: JSON.parse(details_json) };
}

function countBy(values, key) {
  const counts = {};
  for (const value of values) counts[value[key]] = (counts[value[key]] || 0) + 1;
  return counts;
}
