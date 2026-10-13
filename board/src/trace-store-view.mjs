import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '../..');

export function resolveTraceDbPath() {
  const configuredPath = process.env.WORKFLOW_TRACES_DB_PATH;
  if (configuredPath) return resolve(configuredPath);
  return resolve(REPO_ROOT, '.agent-handoff', 'traces.db');
}

export class TraceStoreView {
  constructor(path = resolveTraceDbPath()) {
    this.path = path;
    this.db = existsSync(path) ? new DatabaseSync(path, { open: true }) : null;
  }

  close() {
    this.db?.close();
  }

  summaryByTopic() {
    if (!this.db) return new Map();
    const runs = this.db.prepare(`
      SELECT run_id, status, actor, started_at, ended_at, metadata_json
      FROM workflow_runs
      ORDER BY started_at DESC
      LIMIT 500
    `).all();
    const grouped = new Map();
    for (const run of runs) {
      const metadata = safeParse(run.metadata_json, {});
      const topic = normalizeTopicFromMetadata(metadata);
      if (!topic) continue;
      const key = `${topic.project}::${topic.workspace || ''}::${topic.topic}`;
      let current = grouped.get(key);
      if (!current) {
        current = {
          runIds: [],
          lastRunAt: run.started_at,
          lastRunStatus: run.status,
          lastActor: run.actor,
          failedRuns24h: 0,
          runningRuns: 0,
        };
        grouped.set(key, current);
      }
      current.runIds.push(run.run_id);
      if (run.started_at > current.lastRunAt) {
        current.lastRunAt = run.started_at;
        current.lastRunStatus = run.status;
        current.lastActor = run.actor;
      }
      if (isRecent(run.started_at, 24) && ['error', 'failed', 'rejected', 'rework'].includes(run.status)) current.failedRuns24h += 1;
      if (run.status === 'running' || run.status === 'awaiting-human-verdict') current.runningRuns += 1;
    }
    return grouped;
  }

  summaryByLogicalTopic() {
    if (!this.db) return new Map();
    const rows = this.db.prepare(`
      SELECT wr.run_id, wr.status, wr.actor, wr.started_at, wr.ended_at, wrt.logical_topic_id
      FROM workflow_run_topics wrt
      JOIN workflow_runs wr ON wr.run_id = wrt.run_id
      WHERE wrt.logical_topic_id IS NOT NULL
      ORDER BY wr.started_at DESC
      LIMIT 500
    `).all();
    const grouped = new Map();
    for (const run of rows) {
      let current = grouped.get(run.logical_topic_id);
      if (!current) {
        current = {
          runIds: [],
          lastRunAt: run.started_at,
          lastRunStatus: run.status,
          lastActor: run.actor,
          failedRuns24h: 0,
          runningRuns: 0,
        };
        grouped.set(run.logical_topic_id, current);
      }
      current.runIds.push(run.run_id);
      if (run.started_at > current.lastRunAt) {
        current.lastRunAt = run.started_at;
        current.lastRunStatus = run.status;
        current.lastActor = run.actor;
      }
      if (isRecent(run.started_at, 24) && ['error', 'failed', 'rejected', 'rework'].includes(run.status)) current.failedRuns24h += 1;
      if (run.status === 'running' || run.status === 'awaiting-human-verdict') current.runningRuns += 1;
    }
    return grouped;
  }

  summaryByAgent() {
    if (!this.db) return new Map();
    const rows = this.db.prepare(`
      SELECT actor, MAX(started_at) AS last_seen_at,
             SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) AS run_count_24h,
             SUM(CASE WHEN started_at >= ? AND status IN ('error', 'failed', 'rejected', 'rework') THEN 1 ELSE 0 END) AS failed_runs_24h
      FROM workflow_runs
      WHERE actor IS NOT NULL AND actor != ''
      GROUP BY actor
      ORDER BY last_seen_at DESC
    `).all(hoursAgo(24), hoursAgo(24));
    return new Map(rows.map((row) => [row.actor, {
      lastSeenAt: row.last_seen_at,
      runCount24h: Number(row.run_count_24h || 0),
      failedRuns24h: Number(row.failed_runs_24h || 0),
    }]));
  }

  listRunsByTopic({ project, workspace = null, topic, limit = 50, topicMatcher = null }) {
    if (!this.db) return [];
    return this.db.prepare(`
      SELECT run_id, capability_id, status, actor, started_at, ended_at, metadata_json
      FROM workflow_runs
      ORDER BY started_at DESC
      LIMIT 1000
    `).all().map((row) => ({ ...row, metadata: safeParse(row.metadata_json, {}) }))
      .filter((row) => {
        const handoff = row.metadata?.handoff || row.metadata;
        const matchesTopic = typeof topicMatcher === 'function'
          ? topicMatcher(handoff?.topic)
          : handoff?.topic === topic;
        return handoff?.project === project
          && (handoff?.workspace || null) === workspace
          && matchesTopic;
      })
      .slice(0, limit);
  }

  listRunsByLogicalTopic(logicalTopicId, limit = 50) {
    if (!this.db) return [];
    return this.db.prepare(`
      SELECT wr.run_id, wr.capability_id, wr.status, wr.actor, wr.started_at, wr.ended_at, wr.metadata_json
      FROM workflow_run_topics wrt
      JOIN workflow_runs wr ON wr.run_id = wrt.run_id
      WHERE wrt.logical_topic_id = ?
      ORDER BY wr.started_at DESC
      LIMIT ?
    `).all(logicalTopicId, limit).map((row) => ({ ...row, metadata: safeParse(row.metadata_json, {}) }));
  }
}

function normalizeTopicFromMetadata(metadata) {
  if (metadata?.topic && metadata?.project) {
    return {
      project: metadata.project,
      workspace: metadata.workspace || null,
      topic: metadata.topic,
    };
  }
  if (metadata?.handoff?.topic && metadata?.handoff?.project) {
    return {
      project: metadata.handoff.project,
      workspace: metadata.handoff.workspace || null,
      topic: metadata.handoff.topic,
    };
  }
  return null;
}

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function isRecent(iso, hours) {
  return Date.parse(iso) >= Date.now() - hours * 60 * 60 * 1000;
}
