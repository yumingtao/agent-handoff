import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { AgentEventsStore } from '../src/store.mjs';

test('publish and list agent events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-events-'));
  const dbPath = join(dir, 'events.db');
  const store = new AgentEventsStore(dbPath);
  try {
    const row = store.publish({
      project: 'my-repo',
      workspace: '/tmp/ws',
      topic: 'handoff-board',
      logicalTopicId: 'topic-1',
      agent: 'codex',
      eventType: 'task_progress',
      payload: { note: 'smoke' },
    });
    assert.equal(row.agent, 'codex');
    assert.equal(row.logicalTopicId, 'topic-1');
    const listed = store.list({ project: 'my-repo', topic: 'handoff-board', limit: 10 });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].payload.note, 'smoke');
    assert.equal(listed[0].logicalTopicId, 'topic-1');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrates a legacy agent-events database in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-events-legacy-'));
  const dbPath = join(dir, 'events.db');
  const bootstrap = new AgentEventsStore(dbPath);
  bootstrap.close();
  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec('DROP TABLE schema_meta; DROP TABLE schema_migrations;');
    legacy.exec('ALTER TABLE agent_events RENAME TO agent_events_old;');
    legacy.exec(`
      CREATE TABLE agent_events (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        workspace TEXT,
        topic TEXT NOT NULL,
        agent TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO agent_events SELECT id, project, workspace, topic, agent, event_type, payload_json, created_at FROM agent_events_old;
      DROP TABLE agent_events_old;
    `);
  } finally {
    legacy.close();
  }

  const migrated = new AgentEventsStore(dbPath);
  try {
    const version = migrated.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value;
    assert.equal(version, '2');
    const columns = migrated.db.prepare('PRAGMA table_info(agent_events)').all();
    assert.ok(columns.some((column) => column.name === 'logical_topic_id'));
  } finally {
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
