import { createContext, useContext, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAgents, useOverview } from '../../hooks/useData';
import { useTheme } from '../../hooks/useTheme';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useSSE } from '../../hooks/useSSE';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';
import StatusBar from './StatusBar';

const RefreshContext = createContext<ReturnType<typeof useAutoRefresh> | null>(null);

export function useRefresh() {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error('useRefresh must be used within Shell');
  return ctx;
}

export default function Shell({ children }: { children: ReactNode }) {
  const { data: overview } = useOverview();
  const { data: agents } = useAgents();
  const location = useLocation();
  const { theme, toggle } = useTheme();
  const sseStatus = useSSE();
  const refresh = useAutoRefresh();

  useKeyboardShortcuts(toggle);

  const isTopicsActive = location.pathname === '/' || location.pathname.startsWith('/topic/');
  const isAgentsActive = location.pathname === '/agents' || location.pathname.startsWith('/agent/');
  const isOpsActive = location.pathname === '/ops';
  const isWorkflowActive = location.pathname === '/workflow';

  const sseLabel = sseStatus === 'connected' ? 'Live' : sseStatus === 'connecting' ? 'Connecting…' : 'Offline';
  const sseClass = sseStatus === 'connected' ? 'live' : sseStatus === 'connecting' ? 'pending' : 'off';
  const agentCount = agents?.length ?? overview?.totalAgents ?? 0;

  return (
    <RefreshContext.Provider value={refresh}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-title">Loop Engineering Board</div>
            <div className="brand-subtitle">
              Cross-agent visibility for loop engineering, handoff context, traces, and process-state
              events.
            </div>
          </div>
          <nav className="nav">
            <NavLink
              className={() => `nav-link${isTopicsActive ? ' nav-link-active' : ''}`}
              to="/"
              end
            >
              Topics
              {overview != null && (
                <span className="nav-count">
                  {overview.activeTopics +
                    overview.blockedSuspectTopics +
                    overview.staleTopics +
                    overview.expiredTopics}
                </span>
              )}
            </NavLink>
            <NavLink
              className={() => `nav-link${isAgentsActive ? ' nav-link-active' : ''}`}
              to="/agents"
            >
              Agents
              <span className="nav-count">{agentCount}</span>
            </NavLink>
            <NavLink
              className={() => `nav-link${isOpsActive ? ' nav-link-active' : ''}`}
              to="/ops"
            >
              Ops
            </NavLink>
            <NavLink
              className={() => `nav-link${isWorkflowActive ? ' nav-link-active' : ''}`}
              to="/workflow"
            >
              Workflow
            </NavLink>
          </nav>
          <div className="nav-note">
            <strong>How to read it</strong>
            <div className="helper">
              Start with Topics. Only switch to Agents or Ops when you need ownership hints or
              maintenance tools.
            </div>
            <div className="shortcut-list" aria-label="Keyboard shortcuts">
              <div><kbd>g t</kbd><span>Topics</span></div>
              <div><kbd>g a</kbd><span>Agents</span></div>
              <div><kbd>g o</kbd><span>Ops</span></div>
              <div><kbd>g d</kbd><span>Theme</span></div>
              <div><kbd>Esc</kbd><span>Back</span></div>
            </div>
          </div>
          {overview != null && (
            <div className="sidebar-overview" aria-label="Board overview">
              <div className="sidebar-overview-title">Board pulse</div>
              <div className="sidebar-overview-row">
                <span>Blocked / stale</span>
                <strong>{overview.blockedSuspectTopics + overview.staleTopics}</strong>
              </div>
              <div className="sidebar-overview-row">
                <span>Active agents</span>
                <strong>{overview.agentsActiveToday} / {overview.totalAgents}</strong>
              </div>
              <div className={`sidebar-overview-row${overview.agentsWithRecentErrors > 0 ? ' sidebar-overview-alert' : ''}`}>
                <span>Recent errors</span>
                <strong>{overview.agentsWithRecentErrors}</strong>
              </div>
            </div>
          )}
          <div className="sidebar-footer">
            <div className={`sse-indicator sse-${sseClass}`}>
              <span className="sse-dot" />
              <span className="sse-label">{sseLabel}</span>
            </div>
            <button type="button" className="theme-toggle" onClick={toggle} title="Toggle theme">
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          </div>
        </aside>
        <div className="page-wrapper">
          <main className="page">{children}</main>
          <StatusBar interval={refresh.interval} lastRefreshedAt={refresh.lastRefreshedAt} />
        </div>
      </div>
    </RefreshContext.Provider>
  );
}
