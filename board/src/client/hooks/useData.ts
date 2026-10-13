import { useQuery } from '@tanstack/react-query';
import { fetchJSON } from '../net/client';
import type { Overview, TopicsResponse, AgentView, FilterOptions, AgentCatalog } from '../types';

export function useOverview() {
  return useQuery({ queryKey: ['overview'], queryFn: () => fetchJSON<Overview>('/overview') });
}

export function useTopics(filters: Record<string, string>) {
  const params = new URLSearchParams(filters);
  return useQuery({
    queryKey: ['topics', filters],
    queryFn: () => fetchJSON<TopicsResponse>(`/topics?${params}`),
  });
}

export function useAgents() {
  return useQuery({ queryKey: ['agents'], queryFn: () => fetchJSON<AgentView[]>('/agents') });
}

export function useFilterOptions() {
  return useQuery({
    queryKey: ['filterOptions'],
    queryFn: () => fetchJSON<FilterOptions>('/filter-options'),
    staleTime: 60_000,
  });
}

export function useAgentCatalog() {
  return useQuery({
    queryKey: ['agentCatalog'],
    queryFn: () => fetchJSON<AgentCatalog>('/agent-catalog'),
    staleTime: 300_000,
  });
}
