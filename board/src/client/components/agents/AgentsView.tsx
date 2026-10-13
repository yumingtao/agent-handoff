import { useAgents } from '../../hooks/useData';
import { StateBadge } from '../shared/Badge';
import { Link } from 'react-router-dom';
import { agentDetailPath } from '../../utils/routing';

export default function AgentsView() {
  const { data: agents, isLoading } = useAgents();

  if (isLoading) return <div className="muted">Loading agents...</div>;

  return (
    <>
      <section className="hero">
        <div>
          <h1>Agents</h1>
          <div className="hero-copy">
            Supporting view for ownership and liveness. This is intentionally secondary to the topic
            workflow.
          </div>
        </div>
        <div className="status-pill">{agents?.length ?? 0} agents</div>
      </section>

      <section className="section">
        <div className="agent-grid">
          {agents?.map((a) => (
            <div key={a.agent} className="agent-card">
              <div className="agent-row">
                <div>
                  <StateBadge value={a.derivedState} />{' '}
                  <strong>
                    <Link to={agentDetailPath(a.agent)}>{a.agent}</Link>
                  </strong>
                </div>
                <div className="muted small">{a.lastSeenAt || 'unknown'}</div>
              </div>
              <div className="agent-stats">
                <div className="agent-stat">
                  <span>Handoffs</span>
                  <strong>{a.publishCount}</strong>
                </div>
                <div className="agent-stat">
                  <span>Runs 24h</span>
                  <strong>{a.runCount24h}</strong>
                </div>
                <div className="agent-stat">
                  <span>Blocked 24h</span>
                  <strong>{a.blockedCount24h || 0}</strong>
                </div>
              </div>
              {a.relatedTopics?.length > 0 && (
                <div className="agent-related">
                  <div className="muted small">Recent topics</div>
                  {a.relatedTopics.map((t, i) => (
                    <div key={i} className="agent-related-item">
                      <StateBadge value={t.state} /> <span>{t.topic}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
