import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolveTraceDbPath } from '../src/trace-store-view.mjs';

test('resolveTraceDbPath defaults to repo-relative .agent-handoff/traces.db', () => {
  const original = process.env.WORKFLOW_TRACES_DB_PATH;
  try {
    delete process.env.WORKFLOW_TRACES_DB_PATH;
    const repoRoot = resolve(process.cwd(), '..');
    assert.equal(
      resolveTraceDbPath(),
      resolve(repoRoot, '.agent-handoff', 'traces.db'),
    );
  } finally {
    if (original === undefined) {
      delete process.env.WORKFLOW_TRACES_DB_PATH;
    } else {
      process.env.WORKFLOW_TRACES_DB_PATH = original;
    }
  }
});

test('resolveTraceDbPath honors WORKFLOW_TRACES_DB_PATH override', () => {
  const original = process.env.WORKFLOW_TRACES_DB_PATH;
  try {
    process.env.WORKFLOW_TRACES_DB_PATH = '/tmp/custom-traces.db';
    assert.equal(resolveTraceDbPath(), '/tmp/custom-traces.db');
  } finally {
    if (original === undefined) {
      delete process.env.WORKFLOW_TRACES_DB_PATH;
    } else {
      process.env.WORKFLOW_TRACES_DB_PATH = original;
    }
  }
});
