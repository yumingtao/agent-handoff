import { EVENT_TYPE_LABELS, labelEventType } from './event-labels.mjs';
import { buildWorkflowGraph } from './workflow-graph.mjs';
export { EVENT_TYPE_LABELS, labelEventType };
export { buildWorkflowGraph };

export function mergeTopicTimeline(records, events, runs, formatLocal, timelineFilter = 'all') {
  const handoffItems = records.map((record) => ({
    kind: 'handoff',
    at: record.updatedAt,
    atDisplay: formatLocal(record.updatedAt),
    title: `${record.status} handoff`,
    actor: record.sourceAgent || 'unknown',
    body: record.conclusion || record.conclusionPreview || '',
    refs: record.refs || [],
    meta: record,
  }));
  const eventItems = events.map((event) => ({
    kind: 'event',
    at: event.createdAt,
    atDisplay: formatLocal(event.createdAt),
    title: labelEventType(event.eventType),
    actor: event.agent,
    body: JSON.stringify(event.payload || {}, null, 2),
    refs: [],
    meta: event,
  }));
  const runItems = runs.map((run) => ({
    kind: 'trace',
    at: run.started_at,
    atDisplay: formatLocal(run.started_at),
    title: `trace ${run.status}`,
    actor: run.actor || 'unknown',
    body: JSON.stringify({ runId: run.run_id, capability: run.capability_id, status: run.status, endedAt: run.ended_at || null }, null, 2),
    refs: [],
    meta: run,
  }));
  const all = [...handoffItems, ...eventItems, ...runItems];
  const filtered = timelineFilter === 'all' ? all : all.filter((item) => item.kind === timelineFilter);
  return filtered.sort((left, right) => String(right.at).localeCompare(String(left.at)));
}

export function buildTopicContextModel({ detail, trace, topic, events, runs, timelineFilter = 'all', formatLocal }) {
  const displayEvents = events.map((event) => ({ ...event, createdAtDisplay: formatLocal(event.createdAt) }));
  return {
    detail,
    trace,
    topic,
    events: displayEvents,
    runs,
    timelineFilter,
    mergedTimeline: mergeTopicTimeline(detail.records, events, runs, formatLocal, timelineFilter),
    workflowGraph: buildWorkflowGraph(detail.records, events, runs),
  };
}
