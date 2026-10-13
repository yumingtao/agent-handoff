export function deriveHealthState(topicView, taskState = null, nowMs = Date.now()) {
  if (topicView.isExpired) return 'expired';

  // Done/cancelled topics are already resolved — they should never appear as "blocked"
  // in health state, even if they have blocked events or are stale by age.
  if (taskState !== 'done' && taskState !== 'cancelled') {
    // Only mark blocked when the MOST RECENT event is a task_blocked,
    // not just when any blocked event exists in the last 24h.
    if (topicView.blockedCount24h > 0 && topicView.lastEventType === 'task_blocked') return 'blocked';

    const updatedMs = Date.parse(topicView.latestUpdatedAt || '') || 0;
    const blockedMs = 12 * 60 * 60 * 1000;
    const ageMs = updatedMs ? nowMs - updatedMs : Number.POSITIVE_INFINITY;

    if (ageMs >= blockedMs && topicView.relatedRunStatus !== 'running' && topicView.hasNextAction) {
      return 'blocked';
    }
  }

  const updatedMs = Date.parse(topicView.latestUpdatedAt || '') || 0;
  const staleMs = 6 * 60 * 60 * 1000;
  const ageMs = updatedMs ? nowMs - updatedMs : Number.POSITIVE_INFINITY;

  if (ageMs >= staleMs) return 'stale';
  return 'healthy';
}

export function deriveDisplayState(taskState, healthState, latestStatus) {
  if (taskState === 'cancelled') return 'cancelled';
  if (taskState === 'done') return 'done';
  if (taskState === 'open') {
    if (healthState === 'blocked') return 'blocked';
    if (healthState === 'expired') return 'expired';
    if (healthState === 'stale') return 'stale';
    return 'active';
  }
  // Legacy topic with null task_state: only infer done-suspect when the old logic
  // would have (non-active conclusion lifecycle). Topics that still have an active
  // handoff should display normally based on health signals.
  if (latestStatus && latestStatus !== 'active') return 'done-suspect';
  if (healthState === 'blocked') return 'blocked';
  if (healthState === 'expired') return 'expired';
  if (healthState === 'stale') return 'stale';
  return 'active';
}

export function deriveAgentState(agentView, nowMs = Date.now()) {
  if (agentView.failedRuns24h > 0) return 'error-recently';
  const lastSeenMs = Date.parse(agentView.lastSeenAtRaw || agentView.lastSeenAt || '') || 0;
  if (!lastSeenMs) return 'stale';
  const ageMs = nowMs - lastSeenMs;
  if (ageMs <= 30 * 60 * 1000) return 'active-recently';
  if (ageMs <= 24 * 60 * 60 * 1000) return 'idle';
  return 'stale';
}

export function summarizeOverview(topics, agents) {
  const counts = countBy(topics, 'displayState');
  const taskCounts = countBy(topics, (topic) => topic.taskState || 'legacy');
  const healthCounts = countBy(topics, 'healthState');
  const agentCounts = countBy(agents, 'derivedState');
  return {
    activeTopics: counts['active'] || 0,
    blockedSuspectTopics: counts['blocked'] || 0,
    doneTopics: (counts['done'] || 0) + (counts['done-suspect'] || 0),
    cancelledTopics: counts['cancelled'] || 0,
    staleTopics: counts['stale'] || 0,
    expiredTopics: counts['expired'] || 0,
    openTaskTopics: taskCounts['open'] || 0,
    doneTaskTopics: taskCounts['done'] || 0,
    cancelledTaskTopics: taskCounts['cancelled'] || 0,
    legacyTaskTopics: taskCounts['legacy'] || 0,
    healthyTopics: healthCounts['healthy'] || 0,
    blockedHealthTopics: healthCounts['blocked'] || 0,
    staleHealthTopics: healthCounts['stale'] || 0,
    expiredHealthTopics: healthCounts['expired'] || 0,
    totalAgents: agents.length,
    agentsActiveRecently: agentCounts['active-recently'] || 0,
    agentsActiveToday: (agentCounts['active-recently'] || 0) + (agentCounts['idle'] || 0),
    agentsWithRecentErrors: agentCounts['error-recently'] || 0,
  };
}

function countBy(values, key) {
  const counts = {};
  for (const value of values) {
    const bucket = typeof key === 'function' ? key(value) : value[key] || 'unknown';
    counts[bucket] = (counts[bucket] || 0) + 1;
  }
  return counts;
}
