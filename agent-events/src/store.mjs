import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DB_PATH = resolve(homedir(), '.agent-handoff', 'agent-events.db');
const SCHEMA_VERSION = 2;

const EVENT_TYPES = new Set([
  'task_claimed',
  'task_progress',
  'task_blocked',
  'task_released',
  'agent_heartbeat',
]);

export class AgentEventsStore {
  constructor(path = resolve(process.env.AGENT_EVENTS_DB_PATH || DEFAULT_DB_PATH)) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
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

  close() {
    this.db.close();
  }

  publish({ project, workspace = null, topic, logicalTopicId = null, agent, eventType, payload = {}, createdAt = new Date().toISOString() }) {
    if (!project || !topic || !agent) throw new Error('project, topic, and agent are required');
    if (!EVENT_TYPES.has(eventType)) throw new Error(`unsupported event_type: ${eventType}`);
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO agent_events (id, project, workspace, topic, logical_topic_id, agent, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, project, workspace, topic, logicalTopicId, agent, eventType, JSON.stringify(payload), createdAt);
    return this.getById(id);
  }

  getById(id) {
    const row = this.db.prepare('SELECT * FROM agent_events WHERE id = ?').get(id);
    return row ? parseRow(row) : null;
  }

  list(filters = {}) {
    const where = [];
    const values = [];
    for (const [column, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === '') continue;
      if (column === 'since') {
        where.push('created_at >= ?');
        values.push(value);
      } else if (column === 'limit') {
        continue;
      } else {
        where.push(`${toSnake(column)} = ?`);
        values.push(value);
      }
    }
    const limit = Number(filters.limit || 100);
    return this.db.prepare(`
      SELECT * FROM agent_events
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...values, limit).map(parseRow);
  }

  summaryByTopic() {
    const rows = this.list({ limit: 1000 });
    const grouped = new Map();
    for (const row of rows) {
      const key = topicKey(row.project, row.workspace, row.topic);
      let current = grouped.get(key);
      if (!current) {
        current = {
          lastEventAt: row.createdAt,
          lastEventType: row.eventType,
          lastAgent: row.agent,
          blockedCount24h: 0,
          heartbeats24h: 0,
          claims24h: 0,
          events: [],
        };
        grouped.set(key, current);
      }
      current.events.push(row);
      if (row.createdAt > current.lastEventAt) {
        current.lastEventAt = row.createdAt;
        current.lastEventType = row.eventType;
        current.lastAgent = row.agent;
      }
      if (isRecent(row.createdAt, 24) && row.eventType === 'task_blocked') current.blockedCount24h += 1;
      if (isRecent(row.createdAt, 24) && row.eventType === 'agent_heartbeat') current.heartbeats24h += 1;
      if (isRecent(row.createdAt, 24) && row.eventType === 'task_claimed') current.claims24h += 1;
    }
    return grouped;
  }

  summaryByLogicalTopic() {
    const rows = this.list({ limit: 1000 });
    const grouped = new Map();
    for (const row of rows) {
      const key = row.logicalTopicId || topicKey(row.project, row.workspace, row.topic);
      let current = grouped.get(key);
      if (!current) {
        current = {
          logicalTopicId: row.logicalTopicId,
          lastEventAt: row.createdAt,
          lastEventType: row.eventType,
          lastAgent: row.agent,
          blockedCount24h: 0,
          heartbeats24h: 0,
          claims24h: 0,
          events: [],
        };
        grouped.set(key, current);
      }
      current.events.push(row);
      if (row.createdAt > current.lastEventAt) {
        current.lastEventAt = row.createdAt;
        current.lastEventType = row.eventType;
        current.lastAgent = row.agent;
      }
      if (isRecent(row.createdAt, 24) && row.eventType === 'task_blocked') current.blockedCount24h += 1;
      if (isRecent(row.createdAt, 24) && row.eventType === 'agent_heartbeat') current.heartbeats24h += 1;
      if (isRecent(row.createdAt, 24) && row.eventType === 'task_claimed') current.claims24h += 1;
    }
    return grouped;
  }

  listByLogicalTopic(logicalTopicId, limit = 100) {
    return this.list({ logicalTopicId, limit });
  }

  summaryByAgent() {
    const rows = this.list({ limit: 1000 });
    const grouped = new Map();
    for (const row of rows) {
      let current = grouped.get(row.agent);
      if (!current) {
        current = {
          lastEventAt: row.createdAt,
          heartbeatCount24h: 0,
          blockedCount24h: 0,
          claimedTopics24h: 0,
        };
        grouped.set(row.agent, current);
      }
      if (row.createdAt > current.lastEventAt) current.lastEventAt = row.createdAt;
      if (isRecent(row.createdAt, 24) && row.eventType === 'agent_heartbeat') current.heartbeatCount24h += 1;
      if (isRecent(row.createdAt, 24) && row.eventType === 'task_blocked') current.blockedCount24h += 1;
      if (isRecent(row.createdAt, 24) && row.eventType === 'task_claimed') current.claimedTopics24h += 1;
    }
    return grouped;
  }
}

function parseRow(row) {
  return {
    id: row.id,
    project: row.project,
    workspace: row.workspace,
    topic: row.topic,
    logicalTopicId: row.logical_topic_id || null,
    agent: row.agent,
    eventType: row.event_type,
    payload: safeParse(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

function applyMigrations(db) {
  const applied = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version;
  const currentVersion = Number(applied || 0);
  db.exec('BEGIN');
  try {
    if (currentVersion < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_events (
          id TEXT PRIMARY KEY,
          project TEXT NOT NULL,
          workspace TEXT,
          topic TEXT NOT NULL,
          agent TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_events_topic ON agent_events(project, topic, workspace, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent, created_at DESC);
      `);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        1,
        'initial_agent_events_schema',
        new Date().toISOString(),
      );
    }
    if (currentVersion < 2) {
      if (!columnExists(db, 'agent_events', 'logical_topic_id')) {
        db.exec('ALTER TABLE agent_events ADD COLUMN logical_topic_id TEXT;');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_agent_events_logical_topic ON agent_events(logical_topic_id, created_at DESC);');
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        2,
        'agent_events_logical_topic',
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

function columnExists(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toSnake(value) {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function topicKey(project, workspace, topic) {
  return `${project}::${workspace || ''}::${topic}`;
}

function isRecent(iso, hours) {
  return Date.parse(iso) >= Date.now() - hours * 60 * 60 * 1000;
}
