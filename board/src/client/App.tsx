import { createContext, useContext } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Shell, { useRefresh } from './components/layout/Shell';
import TopicsView from './components/topics/TopicsView';
import AgentsView from './components/agents/AgentsView';
import OpsView from './components/ops/OpsView';
import TopicDetailPage from './components/topic-detail/TopicDetailPage';
import AgentDetailPage from './components/agent-detail/AgentDetailPage';
import WorkflowPage from './components/workflow/WorkflowPage';
import OverviewCards from './components/overview/OverviewCards';
import FilterPanel from './components/shared/FilterPanel';
import RefreshControl from './components/shared/RefreshControl';
import { ToastContainer, useToasts } from './components/shared/Toast';
import type { ToastTone } from './components/shared/Toast';
import { useSSE } from './hooks/useSSE';

const ToastContext = createContext<(tone: ToastTone, message: string, ttl?: number) => string>(() => '');

export function useToast() {
  return useContext(ToastContext);
}

function DashboardPage() {
  const refresh = useRefresh();
  return (
    <>
      <section className="hero">
        <div>
          <h1>Loop Engineering Board</h1>
          <div className="hero-copy">
            A local control-room style view for loop engineering: handoff conclusions, derived task
            state, trace overlays, and agent process signals.
          </div>
        </div>
        <RefreshControl
          interval={refresh.interval}
          onIntervalChange={refresh.setInterval}
          onRefreshNow={refresh.refreshNow}
          lastRefreshedAt={refresh.lastRefreshedAt}
        />
      </section>
      <OverviewCards />
      <FilterPanel />
      <TopicsView />
    </>
  );
}

export default function App() {
  useSSE();
  const { toasts, push, dismiss } = useToasts();

  return (
    <ToastContext.Provider value={push}>
      <Shell>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/topics" element={<Navigate to="/" replace />} />
          <Route path="/agents" element={<AgentsView />} />
          <Route path="/ops" element={<OpsView />} />
          <Route path="/topic/:logicalTopicId" element={<TopicDetailPage />} />
          <Route path="/topic-key/:key" element={<TopicDetailPage />} />
          <Route path="/agent/:agentName" element={<AgentDetailPage />} />
          <Route path="/workflow" element={<WorkflowPage />} />
        </Routes>
      </Shell>
      <ToastContainer toasts={toasts} dismiss={dismiss} />
    </ToastContext.Provider>
  );
}
