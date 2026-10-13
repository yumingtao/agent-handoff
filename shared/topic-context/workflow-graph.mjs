/**
 * Build a swimlane workflow graph from the loaded-window of handoffs,
 * events, and traces for a logical topic.
 *
 * Lane policy (engineer's final decision, per handoff d2f7109d):
 *   - Agent is the primary lane grouping.
 *   - Model is a secondary sub-lane under that agent.
 *   - Records without a model fall into a `legacy/unknown` sub-lane.
 *
 * Data is a loaded window (events capped at 100, runs at 50) — NOT full
 * history. Callers must surface this to users.
 */

const LEGACY_LANE = 'legacy/unknown';

/**
 * @param {Array} records  — handoff records (from detail.records)
 * @param {Array} events   — agent events (from eventsStore, capped at 100)
 * @param {Array} runs     — trace runs (from traceStore, capped at 50)
 * @returns {{ lanes, minTime, maxTime, nodeCount, windowNote }}
 */
export function buildWorkflowGraph(records = [], events = [], runs = []) {
  /** @type {Array<{id:string,kind:string,at:string,title:string,agent:string,model:string|null,timelineKey:string}>} */
  const nodes = [];

  for (const record of records) {
    const id = record.id;
    if (!id || !record.updatedAt) continue;
    const model = record.model || null;
    nodes.push({
      id,
      kind: 'handoff',
      at: record.updatedAt,
      title: `${record.status || 'active'} handoff`,
      agent: record.sourceAgent || 'unknown',
      model,
      modelDisplay: record.modelDisplay || model,
      timelineKey: `handoff-${id}`,
    });
  }

  for (const event of events) {
    const eid = event.id || event.ts || event.createdAt;
    if (!eid || !event.createdAt) continue;
    nodes.push({
      id: String(eid),
      kind: 'event',
      at: event.createdAt,
      title: event.eventType || 'event',
      agent: event.agent || 'unknown',
      model: null,
      timelineKey: `event-${eid}`,
    });
  }

  for (const run of runs) {
    const rid = run.run_id;
    if (!rid || !run.started_at) continue;
    nodes.push({
      id: rid,
      kind: 'trace',
      at: run.started_at,
      title: `trace ${run.status || 'unknown'}`,
      agent: run.actor || 'unknown',
      model: null,
      timelineKey: `trace-${rid}`,
    });
  }

  // Sort nodes by time ascending (oldest left, newest right)
  nodes.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  // Group into agent lanes → model sub-lanes
  const agentOrder = [];
  /** @type {Map<string, Map<string, typeof nodes>>} */
  const agentMap = new Map();

  for (const node of nodes) {
    if (!agentMap.has(node.agent)) {
      agentMap.set(node.agent, new Map());
      agentOrder.push(node.agent);
    }
    const subLanes = agentMap.get(node.agent);
    const modelKey = node.model || LEGACY_LANE;
    if (!subLanes.has(modelKey)) subLanes.set(modelKey, []);
    subLanes.get(modelKey).push(node);
  }

  const lanes = agentOrder.map((agent) => {
    const subLanesMap = agentMap.get(agent);
    // Order sub-lanes: real models first (alphabetical), legacy last
    const modelKeys = [...subLanesMap.keys()].sort((a, b) => {
      if (a === LEGACY_LANE) return 1;
      if (b === LEGACY_LANE) return -1;
      return a.localeCompare(b);
    });
    return {
      agent,
      subLanes: modelKeys.map((modelKey) => ({
        model: modelKey,
        modelDisplay: modelKey === LEGACY_LANE ? LEGACY_LANE
          : (subLanesMap.get(modelKey)[0]?.modelDisplay || modelKey),
        isLegacy: modelKey === LEGACY_LANE,
        nodes: subLanesMap.get(modelKey),
      })),
    };
  });

  const times = nodes.map((n) => n.at).filter(Boolean);
  const minTime = times.length ? times[0] : null;
  const maxTime = times.length ? times[times.length - 1] : null;

  return {
    lanes,
    minTime,
    maxTime,
    nodeCount: nodes.length,
    windowNote: 'Loaded window — events capped at 100, runs at 50.',
  };
}
