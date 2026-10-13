import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEventsStore } from '../../agent-events/src/store.mjs';
import { canonicalizeSummaryMap, createTopicResolver, topicBelongsToCanonical, topicKey } from '../src/topic-aliases.mjs';

test('createTopicResolver returns identity when alias table is empty', () => {
  const resolver = createTopicResolver([]);
  assert.equal(resolver('proj', null, 'raw-topic'), 'raw-topic');
});

test('createTopicResolver maps declared aliases and rejects conflicts', () => {
  const resolver = createTopicResolver([{ project: 'proj', canonical: 'canonical-topic', aliases: ['raw-a', 'raw-b'] }]);
  assert.equal(resolver('proj', null, 'raw-a'), 'canonical-topic');
  assert.equal(resolver('proj', null, 'raw-b'), 'canonical-topic');
  assert.equal(resolver('proj', null, 'canonical-topic'), 'canonical-topic');

  const conflictResolver = createTopicResolver([
    { project: 'proj', canonical: 'one', aliases: ['raw-topic'] },
    { project: 'proj', canonical: 'two', aliases: ['raw-topic'] },
  ]);
  assert.throws(() => conflictResolver('proj', null, 'raw-topic'), /Conflicting topic alias mapping/);
});

test('canonicalizeSummaryMap merges raw topic summaries under one canonical key', () => {
  const resolver = createTopicResolver([{ project: 'proj', canonical: 'canonical-topic', aliases: ['raw-a', 'raw-b'] }]);
  const summary = new Map([
    [topicKey('proj', null, 'raw-a'), { lastEventAt: '2026-07-06T01:00:00.000Z', lastEventType: 'task_claimed', blockedCount24h: 1, heartbeats24h: 0, claims24h: 1, events: [{ id: 'a' }] }],
    [topicKey('proj', null, 'raw-b'), { lastEventAt: '2026-07-06T03:00:00.000Z', lastEventType: 'task_blocked', blockedCount24h: 2, heartbeats24h: 1, claims24h: 0, events: [{ id: 'b' }] }],
  ]);

  const merged = canonicalizeSummaryMap(summary, (current, incoming) => {
    if (!current) return { ...incoming, events: [...incoming.events] };
    return {
      lastEventAt: current.lastEventAt > incoming.lastEventAt ? current.lastEventAt : incoming.lastEventAt,
      lastEventType: current.lastEventAt > incoming.lastEventAt ? current.lastEventType : incoming.lastEventType,
      blockedCount24h: current.blockedCount24h + incoming.blockedCount24h,
      heartbeats24h: current.heartbeats24h + incoming.heartbeats24h,
      claims24h: current.claims24h + incoming.claims24h,
      events: [...current.events, ...incoming.events],
    };
  }, resolver);

  assert.equal(merged.size, 1);
  const entry = merged.get(topicKey('proj', null, 'canonical-topic'));
  assert.ok(entry);
  assert.equal(entry.lastEventAt, '2026-07-06T03:00:00.000Z');
  assert.equal(entry.blockedCount24h, 3);
  assert.equal(entry.heartbeats24h, 1);
  assert.equal(entry.claims24h, 1);
  assert.deepEqual(entry.events.map((event) => event.id).sort(), ['a', 'b']);
});

test('Rule F keeps raw event queries exact while canonical reads still match aliases', () => {
  const resolver = createTopicResolver([{ project: 'proj', canonical: 'canonical-topic', aliases: ['raw-a'] }]);
  const dir = mkdtempSync(join(tmpdir(), 'handoff-topic-alias-events-'));
  const dbPath = join(dir, 'events.db');
  const store = new AgentEventsStore(dbPath);
  try {
    store.publish({ project: 'proj', workspace: null, topic: 'raw-a', agent: 'alpha', eventType: 'task_claimed' });
    store.publish({ project: 'proj', workspace: null, topic: 'canonical-topic', agent: 'beta', eventType: 'task_blocked' });
    store.publish({ project: 'proj', workspace: '/other', topic: 'raw-a', agent: 'gamma', eventType: 'task_released' });

    const exactRaw = store.list({ project: 'proj', topic: 'raw-a', limit: 100 });
    assert.equal(exactRaw.length, 2);
    assert.deepEqual(exactRaw.map((event) => event.workspace).sort(), ['/other', null]);

    const canonicalRead = store.list({ project: 'proj', limit: 100 })
      .filter((event) => (event.workspace || null) === null)
      .filter((event) => topicBelongsToCanonical('proj', null, event.topic, 'canonical-topic', resolver));
    assert.equal(canonicalRead.length, 2);
    assert.deepEqual(canonicalRead.map((event) => event.topic).sort(), ['canonical-topic', 'raw-a']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
