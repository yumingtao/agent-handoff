import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HandoffStore } from '../src/handoff-store.mjs';

function makeTempStore(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-store-test-'));
  const store = new HandoffStore({ homeDir: dir, ...options });
  // HandoffStore only sets PRAGMAs; create the schema that the MCP server normally builds.
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conclusions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      workspace TEXT,
      topic TEXT NOT NULL,
      topic_raw TEXT,
      logical_topic_id TEXT,
      conclusion TEXT NOT NULL,
      next_action TEXT,
      refs_json TEXT NOT NULL,
      source_agent TEXT,
      source_host TEXT,
      source_thread TEXT,
      model TEXT,
      model_display TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      supersedes_id TEXT,
      superseded_reason TEXT,
      changed_by TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'archived')),
      confidence TEXT CHECK (confidence IN ('low', 'medium', 'high')),
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'internal', 'sensitive')),
      FOREIGN KEY (supersedes_id) REFERENCES conclusions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_conclusions_lookup
      ON conclusions(project, topic, workspace, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conclusions_status_created
      ON conclusions(status, created_at DESC);
    CREATE TABLE IF NOT EXISTS logical_topics (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      workspace TEXT,
      canonical_topic_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      task_state TEXT,
      completed_at TEXT,
      completed_by TEXT,
      cancelled_at TEXT,
      cancelled_by TEXT
    );
    CREATE TABLE IF NOT EXISTS topic_state_changes (
      id TEXT PRIMARY KEY,
      logical_topic_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      action TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (logical_topic_id) REFERENCES logical_topics(id)
    );
    CREATE INDEX IF NOT EXISTS idx_topic_state_changes_lookup
      ON topic_state_changes(logical_topic_id, created_at DESC);
    INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '9');
  `);
  return { store, dir };
}

function seedRow(db, overrides = {}) {
  const defaults = {
    id: 'test-id-' + Math.random().toString(36).slice(2),
    project: 'proj',
    workspace: null,
    topic: 'test-topic',
    conclusion: 'conclusion text',
    next_action: null,
    refs_json: '[]',
    source_agent: 'test-agent',
    source_thread: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at: null,
    supersedes_id: null,
    status: 'active',
    confidence: 'high',
    sensitivity: 'normal',
  };
  const row = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO conclusions
      (id, project, workspace, topic, topic_raw, logical_topic_id, conclusion, next_action, refs_json, source_agent, source_thread,
       created_at, updated_at, expires_at, supersedes_id, changed_by, status, confidence, sensitivity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.project, row.workspace, row.topic, row.topic_raw || null, row.logical_topic_id || null, row.conclusion, row.next_action,
    row.refs_json, row.source_agent, row.source_thread,
    row.created_at, row.updated_at, row.expires_at, row.supersedes_id, row.changed_by || null,
    row.status, row.confidence, row.sensitivity,
  );
  return row;
}

// Regression: when a new record supersedes an old one and both share the same
// updated_at timestamp (as produced by MCP publish_conclusion), listTopicViews
// must surface the new active record as the topic head — not the old superseded one.
test('listTopicViews selects active head when updated_at is equal (supersede tiebreak)', () => {
  const { store, dir } = makeTempStore();
  try {
    const sameTs = '2026-07-06T03:21:36.174Z';

    const oldRow = seedRow(store.db, {
      id: 'old-id',
      created_at: '2026-07-06T02:34:57.989Z',
      updated_at: sameTs,
      status: 'superseded',
    });
    const newRow = seedRow(store.db, {
      id: 'new-id',
      created_at: sameTs,       // created_at is later than oldRow
      updated_at: sameTs,       // same updated_at — this is the tricky case
      status: 'active',
      supersedes_id: oldRow.id,
    });

    const views = store.listTopicViews({ project: 'proj', topic: 'test-topic' });
    assert.equal(views.length, 1, 'should produce exactly one topic group');
    const group = views[0];
    const detail = store.getTopicDetail({ project: 'proj', topic: 'test-topic' });
    assert.equal(group.latestConclusionId, newRow.id,
      `latestConclusionId should be the new active record (${newRow.id}), got ${group.latestConclusionId}`);
    assert.equal(group.latestStatus, 'active',
      `latestStatus should be 'active', got ${group.latestStatus}`);
    assert.equal(detail?.latest.id, newRow.id, 'detail view should agree on the active head');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveConclusion archives active records with audit fields and writes fallback data', () => {
  const { store, dir } = makeTempStore();
  try {
    const row = seedRow(store.db, { id: 'archive-me' });
    const result = store.archiveConclusion({ id: row.id, changedBy: 'operator', reason: 'no longer valid' });
    assert.equal(result.updated, true);
    assert.equal(result.idempotent, false);
    const archived = store.db.prepare('SELECT status, changed_by, superseded_reason FROM conclusions WHERE id = ?').get(row.id);
    assert.equal(archived?.status, 'archived');
    assert.equal(archived?.changed_by, 'operator');
    assert.equal(archived?.superseded_reason, 'no longer valid');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveConclusion validates audit inputs and is idempotent for non-active records', () => {
  const { store, dir } = makeTempStore();
  try {
    const row = seedRow(store.db, { id: 'archive-once' });
    assert.throws(() => store.archiveConclusion({ id: row.id, changedBy: '', reason: 'reason' }), /changed_by is required/);
    assert.throws(() => store.archiveConclusion({ id: row.id, changedBy: 'operator', reason: '' }), /reason is required/);
    store.archiveConclusion({ id: row.id, changedBy: 'operator', reason: 'no longer valid' });
    const repeated = store.archiveConclusion({ id: row.id, changedBy: 'operator', reason: 'retry' });
    assert.equal(repeated.updated, false);
    assert.equal(repeated.idempotent, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveConclusion reports missing records without mutating storage', () => {
  const { store, dir } = makeTempStore();
  try {
    const result = store.archiveConclusion({ id: 'missing', changedBy: 'operator', reason: 'cleanup' });
    assert.equal(result.updated, false);
    assert.match(result.reason, /Conclusion not found/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listTopicViews keeps active head even when a non-active record updated later', () => {
  const { store, dir } = makeTempStore();
  try {
    const activeRow = seedRow(store.db, {
      id: 'active-id',
      created_at: '2026-07-06T01:00:00.000Z',
      updated_at: '2026-07-06T01:00:00.000Z',
      status: 'active',
    });
    seedRow(store.db, {
      id: 'archived-id',
      created_at: '2026-07-06T02:00:00.000Z',
      updated_at: '2026-07-06T03:00:00.000Z',
      status: 'archived',
    });

    const views = store.listTopicViews({ project: 'proj', topic: 'test-topic' });
    const detail = store.getTopicDetail({ project: 'proj', topic: 'test-topic' });
    assert.equal(views.length, 1);
    assert.equal(views[0].latestConclusionId, activeRow.id);
    assert.equal(views[0].latestStatus, 'active');
    assert.equal(detail?.latest.id, activeRow.id, 'detail view should still prefer the active record');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listTopicViews resyncs refsCount when the active head changes', () => {
  const { store, dir } = makeTempStore();
  try {
    seedRow(store.db, {
      id: 'superseded-head',
      created_at: '2026-07-06T02:00:00.000Z',
      updated_at: '2026-07-06T05:00:00.000Z',
      status: 'superseded',
      refs_json: JSON.stringify([{ type: 'file', value: 'one' }, { type: 'file', value: 'two' }]),
    });
    const activeRow = seedRow(store.db, {
      id: 'active-head',
      created_at: '2026-07-06T01:00:00.000Z',
      updated_at: '2026-07-06T04:00:00.000Z',
      status: 'active',
      refs_json: JSON.stringify([{ type: 'file', value: 'only' }]),
    });

    const views = store.listTopicViews({ project: 'proj', topic: 'test-topic' });
    assert.equal(views.length, 1);
    assert.equal(views[0].latestConclusionId, activeRow.id);
    assert.equal(views[0].refsCount, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listTopicViews aggregates distinct participant agents', () => {
  const { store, dir } = makeTempStore();
  try {
    seedRow(store.db, {
      id: 'row-a',
      source_agent: 'beta',
      created_at: '2026-07-06T01:00:00.000Z',
      updated_at: '2026-07-06T01:00:00.000Z',
    });
    seedRow(store.db, {
      id: 'row-b',
      source_agent: 'alpha',
      created_at: '2026-07-06T02:00:00.000Z',
      updated_at: '2026-07-06T02:00:00.000Z',
      status: 'superseded',
    });
    seedRow(store.db, {
      id: 'row-c',
      source_agent: 'beta',
      created_at: '2026-07-06T03:00:00.000Z',
      updated_at: '2026-07-06T03:00:00.000Z',
    });

    const views = store.listTopicViews({ project: 'proj', topic: 'test-topic' });
    assert.equal(views.length, 1);
    assert.equal(views[0].participantCount, 2);
    assert.deepEqual(views[0].participantAgents, ['alpha', 'beta']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listTopicViews exposes latestConclusionPreview from the chosen active head', () => {
  const { store, dir } = makeTempStore();
  try {
    seedRow(store.db, {
      id: 'superseded-preview',
      created_at: '2026-07-06T02:00:00.000Z',
      updated_at: '2026-07-06T04:00:00.000Z',
      status: 'superseded',
      conclusion: 'superseded conclusion that should not be used',
    });
    const activeRow = seedRow(store.db, {
      id: 'active-preview',
      created_at: '2026-07-06T01:00:00.000Z',
      updated_at: '2026-07-06T03:00:00.000Z',
      status: 'active',
      conclusion: 'active head preview should be shown in the topics row',
    });

    const views = store.listTopicViews({ project: 'proj', topic: 'test-topic' });
    assert.equal(views.length, 1);
    assert.equal(views[0].latestConclusionId, activeRow.id);
    assert.equal(views[0].latestConclusionPreview, 'active head preview should be shown in the topics row');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listTopicViews redacts latestConclusionPreview when the chosen head is sensitive', () => {
  const { store, dir } = makeTempStore();
  try {
    seedRow(store.db, {
      id: 'sensitive-head',
      created_at: '2026-07-06T02:00:00.000Z',
      updated_at: '2026-07-06T02:00:00.000Z',
      status: 'active',
      sensitivity: 'sensitive',
      conclusion: 'sensitive conclusion text must not leak into topic preview',
    });
    seedRow(store.db, {
      id: 'older-normal',
      created_at: '2026-07-06T01:00:00.000Z',
      updated_at: '2026-07-06T01:00:00.000Z',
      status: 'archived',
      sensitivity: 'normal',
      conclusion: 'older normal text',
    });

    const views = store.listTopicViews({ project: 'proj', topic: 'test-topic' });
    assert.equal(views.length, 1);
    assert.equal(views[0].latestConclusionId, 'sensitive-head');
    assert.equal(views[0].latestConclusionPreview, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Multiple topics: each project+workspace+topic combination is grouped separately.
test('listTopicViews groups by project+workspace+topic', () => {
  const { store, dir } = makeTempStore();
  try {
    seedRow(store.db, { id: 'a1', topic: 'topic-a', created_at: '2026-07-06T01:00:00.000Z', updated_at: '2026-07-06T01:00:00.000Z' });
    seedRow(store.db, { id: 'b1', topic: 'topic-b', created_at: '2026-07-06T01:00:00.000Z', updated_at: '2026-07-06T01:00:00.000Z' });

    const views = store.listTopicViews({ project: 'proj' });
    assert.equal(views.length, 2);
    const topics = views.map((v) => v.topic).sort();
    assert.deepEqual(topics, ['topic-a', 'topic-b']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listTopicViews merges aliased raw topics into one canonical group', () => {
  const resolveTopic = (_project, _workspace, topic) => ({ 'raw-a': 'canonical-topic', 'raw-b': 'canonical-topic' }[topic] || topic);
  const { store, dir } = makeTempStore({ resolveCanonicalTopic: resolveTopic });
  try {
    seedRow(store.db, { id: 'a1', topic: 'raw-a', source_agent: 'alpha', created_at: '2026-07-06T01:00:00.000Z', updated_at: '2026-07-06T01:00:00.000Z' });
    seedRow(store.db, { id: 'b1', topic: 'raw-b', source_agent: 'beta', created_at: '2026-07-06T02:00:00.000Z', updated_at: '2026-07-06T02:00:00.000Z' });

    const views = store.listTopicViews({ project: 'proj' });
    assert.equal(views.length, 1);
    assert.equal(views[0].topic, 'canonical-topic');
    assert.deepEqual(views[0].rawTopics, ['raw-a', 'raw-b']);
    assert.equal(views[0].aliasCount, 2);
    assert.equal(views[0].participantCount, 2);
    assert.equal(views[0].records.length, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getTopicDetail aggregates aliased raw topics and returns canonical topic', () => {
  const resolveTopic = (_project, _workspace, topic) => ({ 'raw-a': 'canonical-topic', 'raw-b': 'canonical-topic' }[topic] || topic);
  const { store, dir } = makeTempStore({ resolveCanonicalTopic: resolveTopic });
  try {
    seedRow(store.db, { id: 'superseded', topic: 'raw-a', status: 'superseded', created_at: '2026-07-06T01:00:00.000Z', updated_at: '2026-07-06T01:00:00.000Z' });
    seedRow(store.db, { id: 'active', topic: 'raw-b', status: 'active', created_at: '2026-07-06T02:00:00.000Z', updated_at: '2026-07-06T02:00:00.000Z' });

    const detail = store.getTopicDetail({ project: 'proj', topic: 'canonical-topic' });
    assert.ok(detail);
    assert.equal(detail?.topic, 'canonical-topic');
    assert.deepEqual(detail?.rawTopics, ['raw-a', 'raw-b']);
    assert.equal(detail?.latest.id, 'active');
    assert.equal(detail?.records.length, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getTopicDetailByLogicalTopicId returns empty detail for a logical topic without conclusions', () => {
  const { store, dir } = makeTempStore();
  try {
    store.db.prepare(`
      INSERT INTO logical_topics
        (id, project, workspace, canonical_topic_name, display_name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'logical-empty',
      'proj',
      null,
      'empty-topic',
      'empty-topic',
      null,
      '2026-07-09T08:00:00.000Z',
      '2026-07-09T08:00:00.000Z',
    );

    const detail = store.getTopicDetailByLogicalTopicId('logical-empty');
    assert.ok(detail);
    assert.equal(detail?.logicalTopicId, 'logical-empty');
    assert.equal(detail?.topic, 'empty-topic');
    assert.equal(detail?.latest, null);
    assert.deepEqual(detail?.rawTopics, ['empty-topic']);
    assert.equal(detail?.records.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('topic detail does not present an archived record as the latest active conclusion', () => {
  const { store, dir } = makeTempStore();
  try {
    store.db.prepare(`
      INSERT INTO logical_topics
        (id, project, workspace, canonical_topic_name, display_name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'logical-archived',
      'proj',
      null,
      'archived-topic',
      'archived-topic',
      null,
      '2026-07-09T08:00:00.000Z',
      '2026-07-09T08:00:00.000Z',
    );
    seedRow(store.db, {
      id: 'archived-only',
      logical_topic_id: 'logical-archived',
      status: 'archived',
      created_at: '2026-07-09T09:00:00.000Z',
      updated_at: '2026-07-09T09:00:00.000Z',
    });

    const detail = store.getTopicDetailByLogicalTopicId('logical-archived');
    assert.ok(detail);
    assert.equal(detail?.latest, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listTopicViews topic filter matches both canonical and raw alias values', () => {
  const resolveTopic = (_project, _workspace, topic) => ({ 'raw-a': 'canonical-topic', 'raw-b': 'canonical-topic' }[topic] || topic);
  const { store, dir } = makeTempStore({ resolveCanonicalTopic: resolveTopic });
  try {
    seedRow(store.db, { id: 'a1', topic: 'raw-a', created_at: '2026-07-06T01:00:00.000Z', updated_at: '2026-07-06T01:00:00.000Z' });
    seedRow(store.db, { id: 'b1', topic: 'raw-b', created_at: '2026-07-06T02:00:00.000Z', updated_at: '2026-07-06T02:00:00.000Z' });

    const canonical = store.listTopicViews({ project: 'proj', topic: 'canonical-topic' });
    const raw = store.listTopicViews({ project: 'proj', topic: 'raw-a' });
    assert.equal(canonical.length, 1);
    assert.equal(raw.length, 1);
    assert.equal(canonical[0].key, raw[0].key);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listAgentViews collapses aliased topics into one canonical active topic', () => {
  const resolveTopic = (_project, _workspace, topic) => ({ 'raw-a': 'canonical-topic', 'raw-b': 'canonical-topic' }[topic] || topic);
  const { store, dir } = makeTempStore({ resolveCanonicalTopic: resolveTopic });
  try {
    seedRow(store.db, { id: 'a1', topic: 'raw-a', source_agent: 'alpha', created_at: '2026-07-06T01:00:00.000Z', updated_at: '2026-07-06T01:00:00.000Z' });
    seedRow(store.db, { id: 'b1', topic: 'raw-b', source_agent: 'alpha', created_at: '2026-07-06T02:00:00.000Z', updated_at: '2026-07-06T02:00:00.000Z' });

    const agents = store.listAgentViews();
    assert.equal(agents.length, 1);
    assert.equal(agents[0].activeTopicsCount, 1);
    assert.equal(agents[0].publishCount, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
