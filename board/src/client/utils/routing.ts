/**
 * Topic key = "project::workspace::topic" (workspace is empty string when null).
 * Used as a single URL segment to avoid React Router issues with '/' in workspace paths.
 */

export function buildTopicKey(project: string, workspace: string | null, topic: string): string {
  return `${project}::${workspace || ''}::${topic}`;
}

export function parseTopicKey(key: string): { project: string; workspace: string | null; topic: string } {
  const firstSep = key.indexOf('::');
  if (firstSep === -1) return { project: key, workspace: null, topic: '' };
  const project = key.slice(0, firstSep);
  const rest = key.slice(firstSep + 2);
  const secondSep = rest.indexOf('::');
  if (secondSep === -1) return { project, workspace: null, topic: rest };
  const ws = rest.slice(0, secondSep);
  return { project, workspace: ws || null, topic: rest.slice(secondSep + 2) };
}

export function topicDetailPath(project: string, workspaceKey: string, topic: string): string {
  const key = buildTopicKey(project, workspaceKey === '_' ? null : workspaceKey, topic);
  return `/topic-key/${encodeURIComponent(key)}`;
}

export function logicalTopicDetailPath(logicalTopicId: string): string {
  return `/topic/${encodeURIComponent(logicalTopicId)}`;
}

export function agentDetailPath(agentName: string): string {
  return `/agent/${encodeURIComponent(agentName)}`;
}
