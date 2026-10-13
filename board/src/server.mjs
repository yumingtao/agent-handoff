import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HandoffStore } from './handoff-store.mjs';
import { TraceStoreView } from './trace-store-view.mjs';
import { AgentEventsStore } from '../../agent-events/src/store.mjs';
import { deriveAgentState, deriveHealthState, deriveDisplayState, summarizeOverview } from './state.mjs';
import { buildAgentCatalog } from './agent-catalog.mjs';
import { resolveCanonicalTopic, topicBelongsToCanonical, topicKey } from './topic-aliases.mjs';
import { buildTopicContextModel, mergeTopicTimeline } from '../../shared/topic-context/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = process.env.HANDOFF_BOARD_DIST_DIR || join(__dirname, '..', 'dist');

// Default port for normal use (API + static SPA, single process). The 5173
// Vite dev server in vite.config.mjs is a separate, dev-only HMR frontend
// that proxies here — it is not an alternative way to browse the board.
const host = process.env.HANDOFF_BOARD_HOST || '127.0.0.1';
const port = Number(process.env.HANDOFF_BOARD_PORT || 4319);

function resolveTimeZone() {
  const explicit = usableEnvValue(process.env.AGENT_HANDOFF_TZ) || usableEnvValue(process.env.TZ);
  if (explicit) return explicit;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

function usableEnvValue(value) {
  return value && value.trim() ? value.trim() : undefined;
}

function formatLocal(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    const timeZone = resolveTimeZone();
    const formatted = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      timeZoneName: 'shortOffset',
    }).format(date);
    return timeZone ? `${formatted} [${timeZone}]` : formatted;
  } catch { return iso; }
}
const sseClients = new Set();

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`);
  const handoffStore = new HandoffStore();
  const traceStore = new TraceStoreView();
  const eventsStore = new AgentEventsStore();

  try {
    if (request.method === 'GET' && url.pathname === '/api/overview') {
      return sendJson(response, buildModel(handoffStore, traceStore, eventsStore, readFilters(url.searchParams)).overview);
    }

    if (request.method === 'GET' && url.pathname === '/api/topics') {
      const model = buildModel(handoffStore, traceStore, eventsStore, readFilters(url.searchParams));
      return sendJson(response, { topics: model.topics, pagination: model.topicPagination, filterOptions: model.filterOptions });
    }

    if (request.method === 'GET' && url.pathname === '/api/agents') {
      return sendJson(response, buildModel(handoffStore, traceStore, eventsStore, readFilters(url.searchParams)).agents);
    }

    if (request.method === 'GET' && url.pathname === '/api/filter-options') {
      const model = buildModel(handoffStore, traceStore, eventsStore, readFilters(url.searchParams));
      return sendJson(response, model.filterOptions);
    }

    if (request.method === 'GET' && url.pathname === '/api/ops/health') {
      return sendJson(response, { ...handoffStore.healthCheck(), agentEventsDbPath: eventsStore.path });
    }

    if (request.method === 'GET' && url.pathname === '/api/agent-catalog') {
      return sendJson(response, buildAgentCatalog());
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/topic/')) {
      const params = decodeTopicPath(url.pathname, '/api/topic/');
      const model = buildTopicModel(handoffStore, traceStore, eventsStore, params);
      if (!model) return sendNotFound(response);
      return sendJson(response, model);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/topic-id/')) {
      const logicalTopicId = decodeURIComponent(url.pathname.slice('/api/topic-id/'.length));
      const params = { logicalTopicId, timeline: url.searchParams.get('timeline') || 'all' };
      const model = buildTopicModel(handoffStore, traceStore, eventsStore, params);
      if (!model) return sendNotFound(response);
      return sendJson(response, model);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/agent/')) {
      const agent = decodeURIComponent(url.pathname.slice('/api/agent/'.length));
      const model = buildAgentDetailModel(handoffStore, traceStore, eventsStore, agent);
      if (!model) return sendNotFound(response);
      return sendJson(response, model);
    }

    if (request.method === 'GET' && url.pathname === '/api/events') {
      return sendJson(response, eventsStore.list({
        project: url.searchParams.get('project') || '',
        workspace: url.searchParams.get('workspace') || '',
        topic: url.searchParams.get('topic') || '',
        logicalTopicId: url.searchParams.get('logicalTopicId') || '',
        agent: url.searchParams.get('agent') || '',
        eventType: url.searchParams.get('eventType') || '',
        limit: url.searchParams.get('limit') || '100',
      }));
    }

    if (request.method === 'GET' && url.pathname === '/events') {
      return streamEvents(request, response);
    }

    if (request.method === 'POST' && url.pathname === '/ops/backup') {
      const body = await readFormBody(request);
      const result = handoffStore.backup(body.label || '');
      broadcastSse({ type: 'backup' });
      return sendJson(response, { ok: true, op: 'backup', result });
    }

    if (request.method === 'POST' && url.pathname === '/ops/cleanup-preview') {
      const body = await readFormBody(request);
      const result = handoffStore.cleanupPreview({
        before: body.before ? new Date(body.before).toISOString() : null,
        statuses: String(body.status || 'superseded,archived').split(','),
      });
      return sendJson(response, { ok: true, op: 'cleanup-preview', result });
    }

    if (request.method === 'POST' && url.pathname === '/ops/publish-event') {
      const body = await readFormBody(request);
      const payload = body.payload ? JSON.parse(body.payload) : {};
      const logicalTopic = body.logicalTopicId
        ? handoffStore.getLogicalTopicById(body.logicalTopicId)
        : handoffStore.resolveLogicalTopic({
          project: body.project,
          workspace: body.workspace || null,
          topic: body.topic,
          create: true,
        });
      const result = eventsStore.publish({
        project: body.project,
        workspace: body.workspace || null,
        topic: body.topic,
        logicalTopicId: logicalTopic?.id || null,
        agent: body.agent,
        eventType: body.eventType,
        payload,
      });
      broadcastSse({ type: 'event', payload: result });
      return sendJson(response, { ok: true, op: 'publish-event', result });
    }

    if (request.method === 'POST' && url.pathname === '/api/topic-transition') {
      const body = await readFormBody(request);
      try {
        const result = handoffStore.transitionTopicState({
          logical_topic_id: body.logicalTopicId,
          target_state: body.targetState,
          changed_by: body.changedBy || 'board-operator',
          reason: body.reason || '',
          expected_state: body.expectedState || undefined,
        });
        broadcastSse({ type: 'topic-transition', payload: result });
        return sendJson(response, { ok: true, op: 'topic-transition', result });
      } catch (error) {
        return sendJson(response, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/conclusion-archive') {
      const body = await readFormBody(request);
      try {
        const result = handoffStore.archiveConclusion({
          id: body.id,
          changedBy: body.changedBy,
          reason: body.reason,
        });
        broadcastSse({ type: 'conclusion-archive', payload: result });
        return sendJson(response, { ok: true, op: 'conclusion-archive', result });
      } catch (error) {
        return sendJson(response, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // React SPA: serve static assets or fall back to index.html
    if (request.method === 'GET'
        && !url.pathname.startsWith('/api/') && url.pathname !== '/events'
        && !url.pathname.startsWith('/ops/')) {
      const assetPath = join(DIST_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
      if (existsSync(assetPath) && extname(assetPath) !== '.html') {
        const ext = extname(assetPath).slice(1);
        const types = { js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', json: 'application/json', woff2: 'font/woff2', woff: 'font/woff' };
        response.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
        return response.end(readFileSync(assetPath));
      }
      const indexPath = join(DIST_DIR, 'index.html');
      if (existsSync(indexPath)) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return response.end(readFileSync(indexPath));
      }
    }

    return sendNotFound(response);
  } catch (error) {
    return sendError(response, error);
  } finally {
    eventsStore.close();
    traceStore.close();
    handoffStore.close();
  }
});

server.listen(port, host, () => {
  process.stdout.write(`loop-engineering-board listening on http://${host}:${port}\n`);
});

function buildModel(handoffStore, traceStore, eventsStore, filters) {
  const traceByTopic = traceStore.summaryByLogicalTopic();
  const traceByAgent = traceStore.summaryByAgent();
  const eventsByTopic = eventsStore.summaryByLogicalTopic();
  const eventsByAgent = eventsStore.summaryByAgent();
  const allTopics = handoffStore.listTopicViews(filters).map((topic) => decorateTopic(topic, traceByTopic.get(topic.logicalTopicId || topic.key), eventsByTopic.get(topic.logicalTopicId || topic.key)));
  const filteredTopics = allTopics
    .filter((topic) => !filters.state || topic.displayState === filters.state)
    .filter((topic) => !filters.taskState || (filters.taskState === 'legacy' ? topic.taskState == null : topic.taskState === filters.taskState))
    .filter((topic) => !filters.healthState || topic.healthState === filters.healthState);
  const sortedTopics = sortTopics(filteredTopics, filters.sort);
  const pageSize = clampPageSize(filters.pageSize);
  const totalTopics = sortedTopics.length;
  const totalPages = Math.max(1, Math.ceil(totalTopics / pageSize));
  const currentPage = clampPage(filters.page, totalPages);
  const pagedTopics = sortedTopics.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const agentTopicIndex = buildAgentTopicIndex(sortedTopics);
  const agents = handoffStore.listAgentViews().map((agent) => decorateAgent(agent, traceByAgent.get(agent.agent), eventsByAgent.get(agent.agent), agentTopicIndex.get(agent.agent) || []));
  return {
    filters,
    health: { ...handoffStore.healthCheck(), agentEventsDbPath: eventsStore.path },
    overview: summarizeOverview(sortedTopics, agents),
    topics: pagedTopics,
    topicPagination: { totalTopics, totalPages, currentPage, pageSize },
    agents,
    filterOptions: buildFilterOptions(allTopics, agents),
  };
}

function buildTopicModel(handoffStore, traceStore, eventsStore, params) {
  const detail = params.logicalTopicId
    ? handoffStore.getTopicDetailByLogicalTopicId(params.logicalTopicId)
    : handoffStore.getTopicDetail(params);
  if (!detail) return null;
  const traceByTopic = traceStore.summaryByLogicalTopic();
  const eventsByTopic = eventsStore.summaryByLogicalTopic();
  const topicLookupKey = detail.logicalTopicId || topicKey(detail.project, detail.workspace, detail.topic);
  const trace = detail.logicalTopicId ? (traceByTopic.get(detail.logicalTopicId) || null) : null;
  const events = detail.logicalTopicId
    ? eventsStore.listByLogicalTopic(detail.logicalTopicId, 100)
    : listEventsForCanonicalTopic(eventsStore, detail.project, detail.workspace, detail.topic, 100);
  const runs = detail.logicalTopicId
    ? traceStore.listRunsByLogicalTopic(detail.logicalTopicId, 50)
    : traceStore.listRunsByTopic({
      project: detail.project,
      workspace: detail.workspace,
      topic: detail.topic,
      limit: 50,
      topicMatcher: (rowTopic) => topicBelongsToCanonical(detail.project, detail.workspace, rowTopic, detail.topic, resolveCanonicalTopic),
    });
  const participantAgents = Array.from(new Set(detail.records.map((record) => record.sourceAgent).filter(Boolean))).sort();
  const latest = detail.latest;
  const topic = decorateTopic({
    key: topicLookupKey,
    logicalTopicId: detail.logicalTopicId || null,
    project: detail.project,
    workspace: detail.workspace,
    workspaceKey: detail.workspace || '_',
    topic: detail.topic,
    taskState: detail.taskState ?? null,
    completedAt: detail.completedAt || null,
    completedBy: detail.completedBy || null,
    cancelledAt: detail.cancelledAt || null,
    cancelledBy: detail.cancelledBy || null,
    latestStatus: latest?.status || 'active',
    latestSourceAgent: latest?.sourceAgent || '',
    latestSourceHost: latest?.sourceHost || null,
    latestUpdatedAt: latest?.updatedAt || null,
    latestUpdatedAtDisplay: latest?.updatedAtDisplay || (latest?.updatedAt ? formatLocal(latest.updatedAt) : null),
    latestConclusionId: latest?.id || '',
    latestConclusionPreview: null,
    expiresAt: latest?.expiresAt || null,
    isExpired: Boolean(latest?.expiresAt) && Date.parse(latest.expiresAt) <= Date.now(),
    hasNextAction: Boolean(latest?.nextAction),
    refsCount: latest?.refs?.length || 0,
    supersedeDepth: detail.records.filter((record) => record.supersedesId).length,
    participantAgents,
    participantCount: participantAgents.length,
    recordCount: detail.records.length,
    rawTopics: detail.rawTopics,
    aliasCount: detail.aliasCount,
  }, trace, eventsByTopic.get(topicLookupKey));
  const timelineFilter = params.timeline || 'all';
  const stateChanges = detail.logicalTopicId
    ? handoffStore.listTopicStateChanges(detail.logicalTopicId)
    : [];
  return { ...buildTopicContextModel({ detail, trace, topic, events, runs, timelineFilter, formatLocal }), stateChanges };
}

function buildAgentDetailModel(handoffStore, traceStore, eventsStore, agentName) {
  const model = buildModel(handoffStore, traceStore, eventsStore, { view: 'agents', sort: 'updated', page: 1, pageSize: 200, q: '', project: '', workspace: '', topic: '', sourceAgent: '', state: '' });
  const agent = model.agents.find((item) => item.agent === agentName);
  if (!agent) return null;
  const rawTopics = handoffStore.listTopicViews({ sourceAgent: agentName });
  const traceByTopic = traceStore.summaryByLogicalTopic();
  const eventsByTopic = eventsStore.summaryByLogicalTopic();
  const relatedTopics = rawTopics.map((topic) => decorateTopic(topic, traceByTopic.get(topic.logicalTopicId || topic.key), eventsByTopic.get(topic.logicalTopicId || topic.key)));
  const recentHandoffs = rawTopics
    .flatMap((t) => t.records)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 10);
  const events = eventsStore.list({ agent: agentName, limit: 100 }).map((event) => ({ ...event, createdAtDisplay: formatLocal(event.createdAt) }));
  return {
    agent,
    relatedTopics,
    recentHandoffs,
    events,
  };
}

function decorateTopic(topic, trace, events) {
  const merged = {
    ...topic,
    workspaceKey: topic.workspace || '_',
    recordCount: topic.records?.length || topic.recordCount || 0,
    latestUpdatedAtDisplay: topic.latestUpdatedAtDisplay || formatLocal(topic.latestUpdatedAt) || null,
    relatedRunIds: trace?.runIds || [],
    relatedRunStatus: trace?.runningRuns ? 'running' : trace?.lastRunStatus || null,
    lastRunAt: trace?.lastRunAt || null,
    lastEventAt: events?.lastEventAt || null,
    lastEventType: events?.lastEventType || null,
    blockedCount24h: events?.blockedCount24h || 0,
    heartbeatCount24h: events?.heartbeats24h || 0,
    claimCount24h: events?.claims24h || 0,
  };
  const taskState = topic.taskState ?? null;
  const healthState = deriveHealthState(merged, taskState);
  merged.taskState = taskState;
  merged.healthState = healthState;
  merged.displayState = deriveDisplayState(taskState, healthState, merged.latestStatus);
  // Backwards-compat alias for consumers that still read derivedTaskState.
  merged.derivedTaskState = merged.displayState;
  return merged;
}

function decorateAgent(agent, trace, events, relatedTopics) {
  const lastSeenAtRaw = mostRecent(mostRecent(agent.lastSeenAt, trace?.lastSeenAt), events?.lastEventAt);
  const merged = {
    ...agent,
    runCount24h: trace?.runCount24h || 0,
    failedRuns24h: trace?.failedRuns24h || 0,
    heartbeatCount24h: events?.heartbeatCount24h || 0,
    blockedCount24h: events?.blockedCount24h || 0,
    claimedTopics24h: events?.claimedTopics24h || 0,
    relatedTopics,
    lastSeenAtRaw,
    lastSeenAt: formatLocal(lastSeenAtRaw),
  };
  merged.derivedState = deriveAgentState(merged);
  return merged;
}

function readFilters(searchParams) {
  return {
    view: searchParams.get('view') || 'topics',
    sort: searchParams.get('sort') || 'updated',
    page: Number(searchParams.get('page') || '1'),
    pageSize: Number(searchParams.get('pageSize') || '10'),
    q: searchParams.get('q') || '',
    project: searchParams.get('project') || '',
    workspace: searchParams.get('workspace') || '',
    topic: searchParams.get('topic') || '',
    sourceAgent: searchParams.get('sourceAgent') || '',
    state: searchParams.get('state') || '',
    taskState: searchParams.get('taskState') || '',
    healthState: searchParams.get('healthState') || '',
  };
}

function streamEvents(request, response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  response.write('event: ready\ndata: {}\n\n');
  sseClients.add(response);
  const keepAlive = setInterval(() => {
    response.write('event: ping\ndata: {}\n\n');
  }, 15000);
  request.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(response);
    response.end();
  });
}

function broadcastSse(message) {
  const payload = `event: update\ndata: ${JSON.stringify(message)}\n\n`;
  for (const client of sseClients) client.write(payload);
}

function buildFilterOptions(topics, agents) {
  return {
    projects: uniqueSorted(topics.map((topic) => topic.project)),
    workspaces: uniqueSorted(topics.map((topic) => topic.workspace).filter(Boolean)),
    topics: uniqueSorted(topics.map((topic) => topic.topic)),
    sourceAgents: uniqueSorted(agents.map((agent) => agent.agent)),
    taskStates: ['open', 'done', 'cancelled', 'legacy'],
    healthStates: ['healthy', 'stale', 'blocked', 'expired'],
    sorts: ['updated', 'healthState', 'taskState', 'state', 'agent', 'topic'],
    pageSizes: [10, 20, 50],
  };
}

function listEventsForCanonicalTopic(eventsStore, project, workspace, canonicalTopic, limit = 100) {
  return eventsStore.list({ project, workspace: workspace || '', limit: 1000 })
    .filter((event) => (event.workspace || null) === workspace)
    .filter((event) => topicBelongsToCanonical(project, workspace, event.topic, canonicalTopic, resolveCanonicalTopic))
    .slice(0, limit);
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function sortTopics(topics, sortKey) {
  const sorted = [...topics];
  if (sortKey === 'taskState') {
    const rank = { legacy: 0, open: 1, done: 2, cancelled: 3 };
    return sorted.sort((left, right) => {
      const rankDiff = (rank[left.taskState || 'legacy'] ?? 99) - (rank[right.taskState || 'legacy'] ?? 99);
      if (rankDiff !== 0) return rankDiff;
      return compareUpdated(left, right);
    });
  }
  if (sortKey === 'healthState') {
    const rank = { healthy: 0, stale: 1, blocked: 2, expired: 3 };
    return sorted.sort((left, right) => {
      const rankDiff = (rank[left.healthState] ?? 99) - (rank[right.healthState] ?? 99);
      if (rankDiff !== 0) return rankDiff;
      return compareUpdated(left, right);
    });
  }
  if (sortKey === 'state') {
    const rank = { active: 0, blocked: 1, stale: 2, expired: 3, done: 4, cancelled: 5, 'done-suspect': 6 };
    return sorted.sort((left, right) => {
      const rankDiff = (rank[left.displayState] ?? 99) - (rank[right.displayState] ?? 99);
      if (rankDiff !== 0) return rankDiff;
      return compareUpdated(left, right);
    });
  }
  if (sortKey === 'agent') {
    return sorted.sort((left, right) => {
      const agentDiff = String(left.latestSourceAgent || '').localeCompare(String(right.latestSourceAgent || ''));
      if (agentDiff !== 0) return agentDiff;
      return compareUpdated(left, right);
    });
  }
  if (sortKey === 'topic') {
    return sorted.sort((left, right) => left.topic.localeCompare(right.topic));
  }
  return sorted.sort(compareUpdated);
}

function compareUpdated(left, right) {
  return String(right.latestUpdatedAt || '').localeCompare(String(left.latestUpdatedAt || ''));
}

function buildAgentTopicIndex(topics) {
  const index = new Map();
  for (const topic of topics) {
    const agent = topic.latestSourceAgent || 'unknown';
    const current = index.get(agent) || [];
    current.push({ topic: topic.topic, state: topic.displayState, project: topic.project });
    index.set(agent, current.slice(0, 3));
  }
  return index;
}

function clampPageSize(value) {
  return [10, 20, 50].includes(value) ? value : 10;
}

function clampPage(value, totalPages) {
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, totalPages);
}

function decodeTopicPath(pathname, prefix) {
  const [project, workspaceKey, ...rest] = pathname.slice(prefix.length).split('/').map(decodeURIComponent);
  return {
    project,
    workspace: workspaceKey === '_' ? null : workspaceKey,
    topic: rest.join('/'),
  };
}

function mostRecent(left, right) {
  if (!left) return right || null;
  if (!right) return left || null;
  return left > right ? left : right;
}

function sendJson(response, body) {
  const json = JSON.stringify(body);
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(json);
}

function sendNotFound(response) {
  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ ok: false, error: 'Not found' }));
}

function sendError(response, error) {
  response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
}

async function readFormBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  return Object.fromEntries(new URLSearchParams(body));
}
