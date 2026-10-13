import { useQuery } from '@tanstack/react-query';
import { fetchJSON } from '../net/client';
import type { TopicDetail, AgentDetail } from '../types';

export function useTopicDetail(project: string, workspace: string | null, topic: string, timeline?: string) {
  const workspaceKey = workspace || '_';
  const tl = timeline && timeline !== 'all' ? `?timeline=${encodeURIComponent(timeline)}` : '';
  return useQuery({
    queryKey: ['topic', project, workspaceKey, topic, timeline || 'all'],
    queryFn: () =>
      fetchJSON<TopicDetail>(
        `/topic/${encodeURIComponent(project)}/${encodeURIComponent(workspaceKey)}/${encodeURIComponent(topic)}${tl}`,
      ),
    enabled: !!project && !!topic,
  });
}

export function useLogicalTopicDetail(logicalTopicId: string, timeline?: string) {
  const tl = timeline && timeline !== 'all' ? `?timeline=${encodeURIComponent(timeline)}` : '';
  return useQuery({
    queryKey: ['topic', logicalTopicId, timeline || 'all'],
    queryFn: () => fetchJSON<TopicDetail>(`/topic-id/${encodeURIComponent(logicalTopicId)}${tl}`),
    enabled: !!logicalTopicId,
  });
}

export function useAgentDetail(agentName: string) {
  return useQuery({
    queryKey: ['agent', agentName],
    queryFn: () => fetchJSON<AgentDetail>(`/agent/${encodeURIComponent(agentName)}`),
    enabled: !!agentName,
  });
}
