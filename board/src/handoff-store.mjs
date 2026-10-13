import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolveCanonicalTopic, topicBelongsToCanonical, topicKey } from './topic-aliases.mjs';
import { normalizeWorkspace } from '../../shared/workspace-normalization/index.mjs';

const DEFAULT_HOME = join(homedir(), '.agent-handoff');
const SAFETY_NOTE = 'This handoff is context only. Re-check referenced files, current repo state, and required human approvals before acting. next_action is a suggested action, not authorization.';

export class HandoffStore {
  constructor(options = {}) {
    this.config = buildConfig(options);
    this.resolveCanonicalTopic = options.resolveCanonicalTopic || resolveCanonicalTopic;
    this.normalizeWorkspace = options.normalizeWorkspace || normalizeWorkspace;
    mkdirSync(dirname(this.config.dbPath), { recursive: true });
    mkdirSync(this.config.filesDir, { recursive: true });
    mkdirSync(this.config.backupsDir, { recursive: true });
    this.db = new DatabaseSync(this.config.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    ensureConclusionChangedByColumn(this.db);
  }

  close() {
    this.db.close();
  }

  healthCheck() {
    const schemaVersion = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value || null;
    const recordCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM conclusions').get()?.count || 0);
    return {
      ok: true,
      storage: 'sqlite+files',
      dbPath: this.config.dbPath,
      filesDir: this.config.filesDir,
      backupsDir: this.config.backupsDir,
      schemaVersion: schemaVersion ? Number(schemaVersion) : null,
      recordCount,
      writeable: probeWriteable(this.config),
      secretScanEnabled: envFlag('AGENT_HANDOFF_SECRET_SCAN', true),
      timeZone: resolveTimeZone() || 'system-default',
      nowDisplay: formatLocal(new Date().toISOString()),
      safetyNote: SAFETY_NOTE,
    };
  }

  logicalTopicsMap() {
    try {
      const rows = this.db.prepare('SELECT * FROM logical_topics').all();
      return new Map(rows.map((row) => [row.id, row]));
    } catch {
      return new Map();
    }
  }

  getLogicalTopicById(id) {
    try {
      return this.db.prepare('SELECT * FROM logical_topics WHERE id = ?').get(id) || null;
    } catch {
      return null;
    }
  }

  resolveLogicalTopic({ project, workspace = null, topic, create = true }) {
    workspace = this.normalizeWorkspace(project, workspace);
    const canonicalTopic = this.resolveCanonicalTopic(project, workspace, topic);
    let existing = null;
    try {
      existing = this.db.prepare(`
        SELECT * FROM logical_topics
        WHERE project = ? AND coalesce(workspace, '') = coalesce(?, '') AND canonical_topic_name = ?
        LIMIT 1
      `).get(project, workspace, canonicalTopic) || null;
    } catch {
      return null;
    }
    if (existing || !create) return existing;
    const timestamp = new Date().toISOString();
    const record = {
      id: randomUUID(),
      project,
      workspace,
      canonical_topic_name: canonicalTopic,
      display_name: canonicalTopic,
      description: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.db.prepare(`
      INSERT INTO logical_topics (id, project, workspace, canonical_topic_name, display_name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.project,
      record.workspace,
      record.canonical_topic_name,
      record.display_name,
      record.description,
      record.created_at,
      record.updated_at,
    );
    return record;
  }

  listTopicViews(filters = {}) {
    const where = [];
    const values = [];
    const requestedTopic = filters.topic || '';
    if (filters.project) {
      where.push('project = ?');
      values.push(filters.project);
    }
    if (filters.workspace) {
      where.push('workspace = ?');
      values.push(filters.workspace);
    }
    if (filters.sourceAgent) {
      where.push('source_agent = ?');
      values.push(filters.sourceAgent);
    }
    if (filters.status) {
      where.push('status = ?');
      values.push(filters.status);
    }
    if (filters.q) {
      where.push('(topic LIKE ? OR project LIKE ? OR workspace LIKE ? OR conclusion LIKE ?)');
      const pattern = `%${filters.q}%`;
      values.push(pattern, pattern, pattern, pattern);
    }
    const rows = this.db.prepare(`
      SELECT * FROM conclusions
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, created_at DESC
    `).all(...values).map(normalizeRow);

    const logicalTopics = this.logicalTopicsMap();
    const grouped = new Map();
    for (const row of rows) {
      const logicalTopic = row.logical_topic_id ? logicalTopics.get(row.logical_topic_id) || null : null;
      const canonicalTopic = this.resolveCanonicalTopic(row.project, row.workspace, row.topic);
      const fallbackKey = topicKey(row.project, row.workspace, canonicalTopic);
      const key = row.logical_topic_id || fallbackKey;
      const rowRefsCount = parseRefs(row.refs_json).length;
      let group = grouped.get(key);
      if (!group) {
        group = {
          key,
          logicalTopicId: row.logical_topic_id || null,
          project: row.project,
          workspace: row.workspace,
          topic: logicalTopic?.display_name || logicalTopic?.canonical_topic_name || canonicalTopic,
          taskState: logicalTopic?.task_state ?? null,
          completedAt: logicalTopic?.completed_at || null,
          completedBy: logicalTopic?.completed_by || null,
          cancelledAt: logicalTopic?.cancelled_at || null,
          cancelledBy: logicalTopic?.cancelled_by || null,
          latestConclusionId: row.id,
          latestConclusionPreview: row.sensitivity === 'sensitive' ? null : preview(row.conclusion),
          latestStatus: row.status,
          latestSourceAgent: row.source_agent,
          latestSourceHost: row.source_host || null,
          latestUpdatedAt: row.updated_at,
          latestCreatedAt: row.created_at,
          expiresAt: row.expires_at,
          isExpired: isExpired(row.expires_at),
          hasSensitive: row.sensitivity === 'sensitive',
          hasNextAction: Boolean(row.next_action),
          refsCount: rowRefsCount,
          supersedeDepth: 0,
          activeCount: 0,
          participantAgents: row.source_agent ? [row.source_agent] : [],
          participantCount: row.source_agent ? 1 : 0,
          rawTopics: [],
          aliasCount: 0,
          records: [],
        };
        grouped.set(key, group);
      }
      const rawTopic = row.topic_raw || row.topic;
      if (!group.rawTopics.includes(rawTopic)) {
        group.rawTopics.push(rawTopic);
        group.rawTopics.sort();
        group.aliasCount = group.rawTopics.length;
      }
      group.records.push(toPublicRecord(row, row.sensitivity !== 'sensitive'));
      group.supersedeDepth += row.supersedes_id ? 1 : 0;
      if (row.status === 'active') group.activeCount += 1;
      if (row.sensitivity === 'sensitive') group.hasSensitive = true;
      if (row.source_agent && !group.participantAgents.includes(row.source_agent)) {
        group.participantAgents.push(row.source_agent);
        group.participantAgents.sort();
        group.participantCount = group.participantAgents.length;
      }
      if (shouldReplaceTopicHead(group, row)) {
        group.latestConclusionId = row.id;
        group.latestConclusionPreview = row.sensitivity === 'sensitive' ? null : preview(row.conclusion);
        group.latestStatus = row.status;
        group.latestSourceAgent = row.source_agent;
        group.latestSourceHost = row.source_host || null;
        group.latestUpdatedAt = row.updated_at;
        group.latestCreatedAt = row.created_at;
        group.expiresAt = row.expires_at;
        group.isExpired = isExpired(row.expires_at);
        group.hasNextAction = Boolean(row.next_action);
        group.refsCount = rowRefsCount;
      }
    }
    for (const logicalTopic of logicalTopics.values()) {
      if (grouped.has(logicalTopic.id)) continue;
      if (!matchesLogicalTopicFilters(logicalTopic, requestedTopic, filters, this.resolveCanonicalTopic)) continue;
      grouped.set(logicalTopic.id, {
        key: logicalTopic.id,
        logicalTopicId: logicalTopic.id,
        project: logicalTopic.project,
        workspace: logicalTopic.workspace,
        topic: logicalTopic.display_name || logicalTopic.canonical_topic_name,
        taskState: logicalTopic.task_state ?? null,
        completedAt: logicalTopic.completed_at || null,
        completedBy: logicalTopic.completed_by || null,
        cancelledAt: logicalTopic.cancelled_at || null,
        cancelledBy: logicalTopic.cancelled_by || null,
        latestConclusionId: '',
        latestConclusionPreview: null,
        latestStatus: 'active',
        latestSourceAgent: '',
        latestSourceHost: null,
        latestUpdatedAt: logicalTopic.updated_at,
        latestCreatedAt: logicalTopic.created_at,
        expiresAt: null,
        isExpired: false,
        hasSensitive: false,
        hasNextAction: false,
        refsCount: 0,
        supersedeDepth: 0,
        activeCount: 0,
        participantAgents: [],
        participantCount: 0,
        rawTopics: [logicalTopic.canonical_topic_name],
        aliasCount: 1,
        records: [],
      });
    }
    let topics = Array.from(grouped.values());
    if (requestedTopic) {
      topics = topics.filter((group) => topicBelongsToCanonical(
        group.project,
        group.workspace,
        group.topic,
        requestedTopic,
        this.resolveCanonicalTopic,
      ));
    }
    return topics.sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt));
  }

  getTopicDetail({ project, workspace = null, topic }) {
    workspace = this.normalizeWorkspace(project, workspace);
    const logicalTopic = this.resolveLogicalTopic({ project, workspace, topic, create: false });
    if (logicalTopic?.id) {
      return this.getTopicDetailByLogicalTopicId(logicalTopic.id);
    }
    const rows = this.db.prepare(`
      SELECT * FROM conclusions
      WHERE project = ? AND coalesce(workspace, '') = coalesce(?, '')
      ORDER BY created_at DESC
    `).all(project, workspace).map(normalizeRow)
      .filter((row) => topicBelongsToCanonical(project, workspace, row.topic, topic, this.resolveCanonicalTopic));
    if (!rows.length) return null;
    const canonicalTopic = this.resolveCanonicalTopic(project, workspace, topic);
    const latestActive = rows.find((row) => row.status === 'active') || null;
    const rawTopics = Array.from(new Set(rows.map((row) => row.topic))).sort();
    return {
      project,
      workspace,
      topic: canonicalTopic,
      logicalTopicId: null,
      rawTopics,
      aliasCount: rawTopics.length,
      latest: latestActive ? toPublicRecord(latestActive, latestActive.sensitivity !== 'sensitive') : null,
      records: rows.map((row) => toPublicRecord(row, row.sensitivity !== 'sensitive')),
      safetyNote: SAFETY_NOTE,
    };
  }

  listAgentViews() {
    const rows = this.db.prepare(`
      SELECT c.source_agent, c.source_host, c.project, c.workspace, c.topic, c.updated_at, c.logical_topic_id, lt.task_state
      FROM conclusions c
      LEFT JOIN logical_topics lt ON lt.id = c.logical_topic_id
      WHERE c.source_agent IS NOT NULL AND c.source_agent != ''
      ORDER BY c.updated_at DESC
    `).all().map(normalizeRow);
    const grouped = new Map();
    for (const row of rows) {
      let agent = grouped.get(row.source_agent);
      if (!agent) {
        agent = {
          agent: row.source_agent,
          sourceHost: row.source_host || null,
          lastSeenAt: row.updated_at,
          publishCount: 0,
          canonicalTopics: new Set(),
          terminalTopics: new Set(),
        };
        grouped.set(row.source_agent, agent);
      }
      agent.publishCount += 1;
      if (row.updated_at > agent.lastSeenAt) {
        agent.lastSeenAt = row.updated_at;
      }
      if (row.source_host && !agent.sourceHost) {
        agent.sourceHost = row.source_host;
      }
      const topicKeyVal = row.logical_topic_id || topicKey(
        row.project,
        row.workspace,
        this.resolveCanonicalTopic(row.project, row.workspace, row.topic),
      );
      agent.canonicalTopics.add(topicKeyVal);
      if (row.task_state === 'done' || row.task_state === 'cancelled') {
        agent.terminalTopics.add(topicKeyVal);
      }
    }
    return Array.from(grouped.values())
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .map((agent) => ({
        agent: agent.agent,
        sourceHost: agent.sourceHost,
        lastSeenAt: agent.lastSeenAt,
        handoffPublishes24h: recentPublishCount(this.db, agent.agent, 24),
        activeTopicsCount: agent.canonicalTopics.size - agent.terminalTopics.size,
        publishCount: agent.publishCount,
      }));
  }

  backup(label = '') {
    const safeLabel = label ? `-${label.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48)}` : '';
    const backupDir = join(this.config.backupsDir, `${backupTimestamp()}${safeLabel}`);
    mkdirSync(backupDir, { recursive: true });
    const dbBackupPath = join(backupDir, 'handoff.db');
    this.db.exec('PRAGMA wal_checkpoint(FULL);');
    this.db.exec(`VACUUM main INTO ${quoteSqlString(dbBackupPath)};`);
    const filesBackupDir = join(backupDir, 'files');
    if (existsSync(this.config.filesDir)) {
      cpSync(this.config.filesDir, filesBackupDir, { recursive: true });
    } else {
      mkdirSync(filesBackupDir, { recursive: true });
    }
    return { backupDir, dbBackupPath, filesBackupDir };
  }

  cleanupPreview({ before = null, expiredOnly = false, statuses = ['superseded', 'archived'], limit = 20 }) {
    const where = ['status IN (' + statuses.map(() => '?').join(', ') + ')'];
    const values = [...statuses];
    if (before) {
      where.push('updated_at < ?');
      values.push(before);
    }
    if (expiredOnly) {
      where.push('expires_at IS NOT NULL AND unixepoch(expires_at) <= unixepoch(?)');
      values.push(new Date().toISOString());
    }
    const rows = this.db.prepare(`
      SELECT * FROM conclusions
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(...values, limit).map(normalizeRow);
    return {
      matchedCount: rows.length,
      candidates: rows.map((row) => toPublicRecord(row, false)),
      safetyNote: SAFETY_NOTE,
    };
  }

  archiveConclusion({ id, changedBy, reason }) {
    if (!changedBy || !changedBy.trim()) {
      throw new Error('changed_by is required and must identify the actor.');
    }
    if (!reason || !reason.trim()) {
      throw new Error('A reason is required for archiving a conclusion.');
    }

    this.db.exec('BEGIN IMMEDIATE');
    let updated;
    try {
      const row = this.db.prepare('SELECT * FROM conclusions WHERE id = ?').get(id);
      if (!row) {
        this.db.exec('COMMIT');
        return { updated: false, id, reason: `Conclusion not found: ${id}` };
      }
      if (row.status !== 'active') {
        this.db.exec('COMMIT');
        return { updated: false, id, idempotent: true, record: toPublicRecord(normalizeRow(row), row.sensitivity !== 'sensitive') };
      }

      const updatedAt = new Date().toISOString();
      this.db.prepare(`
        UPDATE conclusions
        SET status = 'archived', updated_at = ?, changed_by = ?, superseded_reason = ?
        WHERE id = ? AND status = 'active'
      `).run(updatedAt, changedBy.trim(), reason.trim(), id);
      updated = normalizeRow(this.db.prepare('SELECT * FROM conclusions WHERE id = ?').get(id));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    writeFallbackFile(this.config, updated);
    return { updated: true, id, idempotent: false, record: toPublicRecord(updated, updated.sensitivity !== 'sensitive') };
  }

  getTopicDetailByLogicalTopicId(logicalTopicId) {
    const logicalTopic = this.getLogicalTopicById(logicalTopicId);
    if (!logicalTopic) return null;
    const rows = this.db.prepare(`
      SELECT * FROM conclusions
      WHERE logical_topic_id = ?
      ORDER BY created_at DESC
    `).all(logicalTopicId).map(normalizeRow);
    const latestActive = rows.find((row) => row.status === 'active') || null;
    const rawTopics = Array.from(new Set(rows.map((row) => row.topic_raw || row.topic))).sort();
    return {
      project: logicalTopic.project,
      workspace: logicalTopic.workspace,
      topic: logicalTopic.display_name || logicalTopic.canonical_topic_name,
      logicalTopicId,
      taskState: logicalTopic.task_state ?? null,
      completedAt: logicalTopic.completed_at || null,
      completedBy: logicalTopic.completed_by || null,
      cancelledAt: logicalTopic.cancelled_at || null,
      cancelledBy: logicalTopic.cancelled_by || null,
      rawTopics: rawTopics.length ? rawTopics : [logicalTopic.canonical_topic_name],
      aliasCount: rawTopics.length,
      latest: latestActive ? toPublicRecord(latestActive, latestActive.sensitivity !== 'sensitive') : null,
      records: rows.map((row) => toPublicRecord(row, row.sensitivity !== 'sensitive')),
      safetyNote: SAFETY_NOTE,
    };
  }

  transitionTopicState({ logical_topic_id, target_state, changed_by, reason, expected_state }) {
    if (!changed_by || !changed_by.trim()) {
      throw new Error('changed_by is required and must identify the actor.');
    }
    if (target_state === 'done' || target_state === 'cancelled') {
      if (!reason || !reason.trim()) {
        throw new Error(`A reason is required for transitioning to '${target_state}'.`);
      }
    }

    const ALLOWED = { open: ['done', 'cancelled'], done: ['open'], cancelled: ['open'] };
    const timestamp = new Date().toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const topic = this.getLogicalTopicById(logical_topic_id);
      if (!topic) throw new Error(`logical_topic_id not found: ${logical_topic_id}`);

      const currentState = topic.task_state;
      const effectiveCurrent = currentState || 'open';

      if (expected_state !== undefined && expected_state !== effectiveCurrent) {
        throw new Error(`Optimistic concurrency conflict: expected_state='${expected_state}' but actual state is '${effectiveCurrent}'.`);
      }

      if (effectiveCurrent === target_state) {
        this.db.exec('COMMIT');
        return { updated: false, idempotent: true, logical_topic_id, task_state: effectiveCurrent };
      }

      const allowed = ALLOWED[effectiveCurrent] || [];
      if (!allowed.includes(target_state)) {
        throw new Error(`Illegal transition: '${effectiveCurrent}' -> '${target_state}'. Allowed: [${allowed.join(', ')}].`);
      }

      // Apply the transition
      if (target_state === 'done') {
        this.db.prepare(`
          UPDATE logical_topics
          SET task_state = ?, completed_at = ?, completed_by = ?, cancelled_at = NULL, cancelled_by = NULL, updated_at = ?
          WHERE id = ?
        `).run(target_state, timestamp, changed_by, timestamp, logical_topic_id);
      } else if (target_state === 'cancelled') {
        this.db.prepare(`
          UPDATE logical_topics
          SET task_state = ?, cancelled_at = ?, cancelled_by = ?, completed_at = NULL, completed_by = NULL, updated_at = ?
          WHERE id = ?
        `).run(target_state, timestamp, changed_by, timestamp, logical_topic_id);
      } else {
        this.db.prepare(`
          UPDATE logical_topics
          SET task_state = ?, completed_at = NULL, completed_by = NULL, cancelled_at = NULL, cancelled_by = NULL, updated_at = ?
          WHERE id = ?
        `).run(target_state, timestamp, logical_topic_id);
      }

      // Audit record
      const action = target_state === 'done' ? 'complete' : target_state === 'cancelled' ? 'cancel' : 'reopen';
      this.db.prepare(`
        INSERT INTO topic_state_changes (id, logical_topic_id, from_state, to_state, action, changed_by, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), logical_topic_id, currentState, target_state, action, changed_by, reason || null, timestamp);

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const updated = this.getLogicalTopicById(logical_topic_id);
    return { updated: true, idempotent: false, logical_topic_id, task_state: updated.task_state };
  }

  listTopicStateChanges(logicalTopicId) {
    try {
      return this.db.prepare(`
        SELECT * FROM topic_state_changes
        WHERE logical_topic_id = ?
        ORDER BY created_at DESC
      `).all(logicalTopicId).map(normalizeRow);
    } catch {
      return [];
    }
  }
}

function buildConfig(options) {
  const homeDir = resolve(options.homeDir || usableEnvValue(process.env.AGENT_HANDOFF_HOME) || DEFAULT_HOME);
  return {
    homeDir,
    dbPath: resolve(options.dbPath || usableEnvValue(process.env.AGENT_HANDOFF_DB_PATH) || join(homeDir, 'handoff.db')),
    filesDir: resolve(options.filesDir || usableEnvValue(process.env.AGENT_HANDOFF_FILES_DIR) || join(homeDir, 'files')),
    backupsDir: resolve(options.backupsDir || usableEnvValue(process.env.AGENT_HANDOFF_BACKUPS_DIR) || join(homeDir, 'backups')),
  };
}

function recentPublishCount(db, sourceAgent, hours) {
  const threshold = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return Number(db.prepare('SELECT COUNT(*) AS count FROM conclusions WHERE source_agent = ? AND updated_at >= ?').get(sourceAgent, threshold)?.count || 0);
}

function shouldReplaceTopicHead(group, row) {
  const candidateRank = topicHeadRank(row.status);
  const currentRank = topicHeadRank(group.latestStatus);
  if (candidateRank !== currentRank) {
    return candidateRank < currentRank;
  }
  if (row.updated_at !== group.latestUpdatedAt) {
    return row.updated_at > group.latestUpdatedAt;
  }
  return row.created_at > group.latestCreatedAt;
}

function matchesLogicalTopicFilters(logicalTopic, requestedTopic, filters, resolver) {
  if (filters.project && logicalTopic.project !== filters.project) return false;
  if (filters.workspace && logicalTopic.workspace !== filters.workspace) return false;
  if (filters.sourceAgent || filters.status) return false;
  if (requestedTopic && !topicBelongsToCanonical(
    logicalTopic.project,
    logicalTopic.workspace,
    logicalTopic.canonical_topic_name,
    requestedTopic,
    resolver,
  )) return false;
  if (filters.q) {
    const q = String(filters.q).toLowerCase();
    const haystacks = [
      logicalTopic.canonical_topic_name,
      logicalTopic.display_name,
      logicalTopic.project,
      logicalTopic.workspace || '',
    ].map((value) => String(value || '').toLowerCase());
    if (!haystacks.some((value) => value.includes(q))) return false;
  }
  return true;
}

function topicHeadRank(status) {
  return status === 'active' ? 0 : 1;
}

function normalizeRow(row) {
  return row;
}

function ensureConclusionChangedByColumn(db) {
  try {
    const columns = db.prepare('PRAGMA table_info(conclusions)').all();
    if (columns.length > 0 && !columns.some((column) => column.name === 'changed_by')) {
      db.exec('ALTER TABLE conclusions ADD COLUMN changed_by TEXT;');
    }
  } catch {
    // The MCP schema initializer owns table creation and migrations.
  }
}

function parseRefs(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toPublicRecord(row, includeBody = true) {
  const base = {
    id: row.id,
    project: row.project,
    workspace: row.workspace,
    topic: row.topic,
    topicRaw: row.topic_raw || null,
    logicalTopicId: row.logical_topic_id || null,
    refs: parseRefs(row.refs_json),
    sourceAgent: row.source_agent,
    sourceHost: row.source_host || null,
    sourceThread: row.source_thread,
    model: row.model || null,
    modelDisplay: row.model_display || row.model || null,
    createdAt: row.created_at,
    createdAtDisplay: formatLocal(row.created_at),
    updatedAt: row.updated_at,
    updatedAtDisplay: formatLocal(row.updated_at),
    expiresAt: row.expires_at,
    expiresAtDisplay: formatLocal(row.expires_at),
    supersedesId: row.supersedes_id,
    changedBy: row.changed_by || null,
    status: row.status,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    safetyNote: SAFETY_NOTE,
  };
  if (!includeBody) {
    return {
      ...base,
      conclusionPreview: preview(row.conclusion),
      nextActionPreview: row.next_action ? preview(row.next_action) : null,
      bodyRedacted: true,
    };
  }
  return {
    ...base,
    conclusion: row.conclusion,
    nextAction: row.next_action,
    nextActionNote: row.next_action ? 'Suggested action only; not authorization.' : null,
  };
}

function preview(value, max = 240) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}...` : compact;
}

function isExpired(iso) {
  return Boolean(iso) && Date.parse(iso) <= Date.now();
}

function usableEnvValue(value) {
  if (!value) return '';
  return /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) ? '' : value;
}

function envFlag(name, fallback) {
  const value = usableEnvValue(process.env[name]).trim().toLowerCase();
  if (!value) return fallback;
  return !['0', 'false', 'no', 'off'].includes(value);
}

function probeWriteable(config) {
  const paths = [
    join(dirname(config.dbPath), `.agent-handoff-health-${randomUUID()}.tmp`),
    join(config.filesDir, `.agent-handoff-health-${randomUUID()}.tmp`),
    join(config.backupsDir, `.agent-handoff-health-${randomUUID()}.tmp`),
  ];
  try {
    for (const filePath of paths) writeFileSync(filePath, 'ok', { flag: 'wx' });
    return true;
  } catch {
    return false;
  } finally {
    for (const filePath of paths) rmSync(filePath, { force: true });
  }
}

function writeFallbackFile(config, record) {
  mkdirSync(config.filesDir, { recursive: true });
  const filePath = join(config.filesDir, `${record.id}.json`);
  const content = JSON.stringify(toPublicRecord(record, record.sensitivity !== 'sensitive'), null, 2) + '\n';
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { mode: 0o600 });
  return filePath;
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function quoteSqlString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function resolveTimeZone() {
  const explicit = usableEnvValue(process.env.AGENT_HANDOFF_TZ) || usableEnvValue(process.env.TZ);
  if (explicit) return explicit;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function formatLocal(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const timeZone = resolveTimeZone();
    const formatted = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'shortOffset',
    }).format(date);
    return timeZone ? `${formatted} [${timeZone}]` : formatted;
  } catch {
    return date.toISOString();
  }
}
