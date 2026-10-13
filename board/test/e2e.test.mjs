import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(__dirname, '..', 'src', 'server.mjs');
const TEST_PORT = 14399;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let serverProcess;

async function waitForServer(maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${BASE}/api/ops/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready');
}

async function fetchJSON(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  return { status: res.status, body: await res.json() };
}

async function postForm(path, fields) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, body: await res.json() };
}

test.before(async () => {
  serverProcess = spawn('node', [SERVER_SCRIPT], {
    env: { ...process.env, HANDOFF_BOARD_PORT: String(TEST_PORT), HANDOFF_BOARD_HOST: '127.0.0.1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await waitForServer();
});

test.after(async () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
  }
});

test('GET /api/overview returns overview metrics', async () => {
  const { status, body } = await fetchJSON('/api/overview');
  assert.equal(status, 200);
  assert.ok(typeof body.activeTopics === 'number');
  assert.ok(typeof body.staleTopics === 'number');
});

test('GET /api/topics returns topics with pagination', async () => {
  const { status, body } = await fetchJSON('/api/topics');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.topics));
  assert.ok(body.pagination);
  assert.ok(typeof body.pagination.totalPages === 'number');
});

test('GET /api/topics exposes independent state filters and sort keys', async () => {
  const initial = await fetchJSON('/api/topics?pageSize=50');
  assert.equal(initial.status, 200);
  assert.ok(initial.body.topics.length > 0, 'fixture data must contain a topic for filter verification');
  const source = initial.body.topics[0];
  const taskState = source.taskState || 'legacy';
  const { status, body } = await fetchJSON(`/api/topics?taskState=${encodeURIComponent(taskState)}&healthState=${encodeURIComponent(source.healthState)}&sort=healthState&pageSize=50`);
  assert.equal(status, 200);
  assert.ok(body.topics.length > 0);
  assert.ok(body.filterOptions.taskStates.includes('open'));
  assert.ok(body.filterOptions.healthStates.includes('expired'));
  for (const topic of body.topics) {
    assert.equal(topic.taskState, source.taskState);
    assert.equal(topic.healthState, source.healthState);
  }
});

test('GET /api/agents returns agents array', async () => {
  const { status, body } = await fetchJSON('/api/agents');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
});

test('GET /api/ops/health returns health data', async () => {
  const { status, body } = await fetchJSON('/api/ops/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.storage);
});

test('POST /api/conclusion-archive validates required audit fields', async () => {
  const { status, body } = await postForm('/api/conclusion-archive', { id: 'missing-id' });
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.match(body.error, /changed_by is required/);
});

test('POST /api/conclusion-archive returns a safe not-found result', async () => {
  const { status, body } = await postForm('/api/conclusion-archive', {
    id: 'missing-id',
    changedBy: 'e2e-test',
    reason: 'test archive',
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.op, 'conclusion-archive');
  assert.equal(body.result.updated, false);
});

test('GET /api/filter-options returns filter option arrays', async () => {
  const { status, body } = await fetchJSON('/api/filter-options');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.projects));
  assert.ok(Array.isArray(body.sorts));
});

test('GET / returns HTML (SPA fallback)', async () => {
  const res = await fetch(BASE + '/');
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(text.includes('<div id="root">'));
});

test('GET /agents/some-agent returns 404 for unknown agent', async () => {
  const { status, body } = await fetchJSON('/api/agent/nonexistent-agent-xyz');
  assert.equal(status, 404);
  assert.equal(body.ok, false);
});
