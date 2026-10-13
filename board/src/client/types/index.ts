export interface Overview {
  activeTopics: number;
  blockedSuspectTopics: number;
  doneTopics: number;
  cancelledTopics: number;
  staleTopics: number;
  expiredTopics: number;
  openTaskTopics: number;
  doneTaskTopics: number;
  cancelledTaskTopics: number;
  legacyTaskTopics: number;
  healthyTopics: number;
  blockedHealthTopics: number;
  staleHealthTopics: number;
  expiredHealthTopics: number;
  totalAgents: number;
  agentsActiveRecently: number;
  agentsActiveToday: number;
  agentsWithRecentErrors: number;
}

export interface Pagination {
  totalTopics: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
}

export interface FilterOptions {
  projects: string[];
  workspaces: string[];
  topics: string[];
  sourceAgents: string[];
  sorts: string[];
  pageSizes: number[];
  taskStates: string[];
  healthStates: string[];
}

export interface TopicsResponse {
  topics: TopicView[];
  pagination: Pagination;
  filterOptions: FilterOptions;
}

export interface TopicView {
  key: string;
  logicalTopicId: string | null;
  project: string;
  workspace: string | null;
  workspaceKey: string;
  topic: string;
  rawTopics: string[];
  aliasCount: number;
  latestStatus: string;
  latestSourceAgent: string;
  latestSourceHost: string | null;
  latestUpdatedAt: string;
  latestUpdatedAtDisplay: string | null;
  latestConclusionId: string;
  latestConclusionPreview: string | null;
  expiresAt: string | null;
  isExpired: boolean;
  hasNextAction: boolean;
  refsCount: number;
  supersedeDepth: number;
  participantAgents: string[];
  participantCount: number;
  recordCount: number;
  taskState: string | null;
  healthState: string;
  displayState: string;
  completedAt: string | null;
  completedBy: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  derivedTaskState: string;
  relatedRunIds: string[];
  relatedRunStatus: string | null;
  lastRunAt: string | null;
  lastEventAt: string | null;
  lastEventType: string | null;
  blockedCount24h: number;
  heartbeatCount24h: number;
  claimCount24h: number;
}

export interface AgentView {
  agent: string;
  activeTopicsCount: number;
  publishCount: number;
  lastSeenAt: string | null;
  lastSeenAtRaw?: string | null;
  runCount24h: number;
  failedRuns24h: number;
  heartbeatCount24h: number;
  blockedCount24h: number;
  claimedTopics24h: number;
  derivedState: string;
  relatedTopics: { topic: string; state: string; project: string }[];
}

export interface TopicDetail {
  detail: {
    project: string;
    workspace: string | null;
    topic: string;
    logicalTopicId: string | null;
    rawTopics: string[];
    aliasCount: number;
    latest: {
      id: string;
      status: string;
      sourceAgent: string;
      sourceHost: string | null;
      model: string | null;
      modelDisplay: string | null;
      updatedAt: string;
      updatedAtDisplay: string | null;
      conclusion?: string;
      conclusionPreview?: string;
      nextAction: string | null;
      refs: { type: string; value: string; line?: number; note?: string }[];
    } | null;
    records: HandoffRecord[];
    safetyNote: string | null;
  };
  trace: any;
  topic: TopicView;
  events: any[];
  runs: any[];
  mergedTimeline: TimelineItem[];
  workflowGraph: WorkflowGraph;
  timelineFilter: string;
  stateChanges: TopicStateChange[];
}

export interface TopicStateChange {
  id: string;
  logicalTopicId: string;
  fromState: string | null;
  toState: string;
  action: string;
  changedBy: string;
  reason: string | null;
  createdAt: string;
  createdAtDisplay: string | null;
}

export interface HandoffRecord {
  id: string;
  logicalTopicId?: string | null;
  project: string;
  workspace: string | null;
  topic: string;
  status: string;
  sourceAgent: string;
  model: string | null;
  modelDisplay: string | null;
  createdAt: string;
  createdAtDisplay: string | null;
  updatedAt: string;
  updatedAtDisplay: string | null;
  conclusion?: string;
  conclusionPreview?: string;
  nextAction?: string | null;
  supersedesId: string | null;
}

export interface AgentDetail {
  agent: AgentView;
  relatedTopics: TopicView[];
  recentHandoffs: HandoffRecord[];
  events: any[];
}

export interface TimelineItem {
  kind: 'handoff' | 'event' | 'trace';
  at: string;
  atDisplay: string;
  title: string;
  actor: string;
  body: string;
  refs: { type: string; value: string; line?: number; note?: string }[];
  meta: any;
}

export interface HealthData {
  ok: boolean;
  storage: string;
  dbPath: string;
  filesDir: string;
  backupsDir: string;
  schemaVersion: string;
  recordCount: number;
  writeable: boolean;
  agentEventsDbPath: string;
  [key: string]: unknown;
}

export interface CatalogSkill {
  id: string;
  name: string;
  skillName: string;
  description: string;
  fullDescription: string;
  scope: string;
  sideEffects: string;
  tier: string;
  path: string;
}

export interface CatalogPlatform {
  id: string;
  label: string;
  color: string;
  icon: string;
  cliCallable: boolean;
  agentType: 'cli' | 'desktop' | 'ide';
  skillCount: number;
  skills: CatalogSkill[];
}

export interface AgentCatalog {
  platforms: CatalogPlatform[];
}

export interface WorkflowGraphNode {
  id: string;
  kind: 'handoff' | 'event' | 'trace';
  at: string;
  title: string;
  agent: string;
  model: string | null;
  timelineKey: string;
}

export interface WorkflowSubLane {
  model: string;
  modelDisplay: string;
  isLegacy: boolean;
  nodes: WorkflowGraphNode[];
}

export interface WorkflowLane {
  agent: string;
  subLanes: WorkflowSubLane[];
}

export interface WorkflowGraph {
  lanes: WorkflowLane[];
  minTime: string | null;
  maxTime: string | null;
  nodeCount: number;
  windowNote: string;
}
