import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAgentState, deriveHealthState, deriveDisplayState, summarizeOverview } from '../src/state.mjs';

test('deriveHealthState marks expired first', () => {
  const state = deriveHealthState({ isExpired: true, latestStatus: 'active', hasNextAction: true, relatedRunStatus: null, latestUpdatedAt: new Date().toISOString() });
  assert.equal(state, 'expired');
});

test('deriveHealthState marks blocked when stale with next action', () => {
  const state = deriveHealthState({
    isExpired: false,
    latestStatus: 'active',
    hasNextAction: true,
    relatedRunStatus: null,
    latestUpdatedAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(state, 'blocked');
});

test('deriveHealthState marks blocked when blocked event exists', () => {
  const state = deriveHealthState({
    isExpired: false,
    latestStatus: 'active',
    hasNextAction: false,
    blockedCount24h: 1,
    lastEventType: 'task_blocked',
    relatedRunStatus: 'running',
    latestUpdatedAt: new Date().toISOString(),
  });
  assert.equal(state, 'blocked');
});

test('deriveDisplayState maps taskState + healthState correctly', () => {
  assert.equal(deriveDisplayState('cancelled', 'healthy', 'active'), 'cancelled');
  assert.equal(deriveDisplayState('done', 'expired', 'active'), 'done');
  assert.equal(deriveDisplayState('open', 'blocked', 'active'), 'blocked');
  assert.equal(deriveDisplayState('open', 'expired', 'active'), 'expired');
  assert.equal(deriveDisplayState('open', 'stale', 'active'), 'stale');
  assert.equal(deriveDisplayState('open', 'healthy', 'active'), 'active');
});

test('deriveDisplayState legacy null taskState with active handoff is not done-suspect', () => {
  // Legacy topic with null taskState but still has active conclusion → should show health-based state, not done-suspect.
  assert.equal(deriveDisplayState(null, 'healthy', 'active'), 'active');
  assert.equal(deriveDisplayState(null, 'stale', 'active'), 'stale');
  assert.equal(deriveDisplayState(null, 'blocked', 'active'), 'blocked');
  assert.equal(deriveDisplayState(null, 'expired', 'active'), 'expired');
});

test('deriveDisplayState legacy null taskState with non-active handoff is done-suspect', () => {
  assert.equal(deriveDisplayState(null, 'healthy', 'superseded'), 'done-suspect');
  assert.equal(deriveDisplayState(null, 'healthy', 'archived'), 'done-suspect');
});

test('deriveAgentState uses recent error first', () => {
  const state = deriveAgentState({ failedRuns24h: 1, lastSeenAt: new Date().toISOString() });
  assert.equal(state, 'error-recently');
});

test('summarizeOverview counts display states', () => {
  const summary = summarizeOverview(
    [
      { latestStatus: 'active', displayState: 'active' },
      { latestStatus: 'active', displayState: 'blocked' },
      { latestStatus: 'active', displayState: 'done' },
      { latestStatus: 'superseded', displayState: 'done-suspect' },
      { latestStatus: 'active', displayState: 'cancelled' },
    ],
    [
      { derivedState: 'active-recently' },
      { derivedState: 'error-recently' },
    ],
  );
  assert.equal(summary.activeTopics, 1);
  assert.equal(summary.blockedSuspectTopics, 1);
  assert.equal(summary.doneTopics, 2);
  assert.equal(summary.cancelledTopics, 1);
  assert.equal(summary.agentsActiveRecently, 1);
  assert.equal(summary.agentsWithRecentErrors, 1);
});

test('summarizeOverview counts task and health dimensions independently', () => {
  const summary = summarizeOverview(
    [
      { taskState: 'done', healthState: 'expired', displayState: 'done' },
      { taskState: 'cancelled', healthState: 'blocked', displayState: 'cancelled' },
      { taskState: null, healthState: 'stale', displayState: 'stale' },
    ],
    [],
  );
  assert.equal(summary.doneTaskTopics, 1);
  assert.equal(summary.cancelledTaskTopics, 1);
  assert.equal(summary.legacyTaskTopics, 1);
  assert.equal(summary.expiredHealthTopics, 1);
  assert.equal(summary.blockedHealthTopics, 1);
  assert.equal(summary.staleHealthTopics, 1);
});
