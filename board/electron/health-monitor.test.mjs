import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBoardState } from './health-monitor.mjs';

test('health monitor distinguishes running, starting, error and stopped', () => {
  assert.equal(deriveBoardState({ health: { ok: true }, service: { installed: true, running: true } }).state, 'running');
  assert.equal(deriveBoardState({ health: null, service: { installed: true, running: true } }).state, 'starting');
  assert.equal(deriveBoardState({ health: null, service: { installed: true, running: false } }).state, 'error');
  assert.equal(deriveBoardState({ health: null, service: { installed: false, running: false } }).state, 'stopped');
});
