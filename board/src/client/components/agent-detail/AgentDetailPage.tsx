import { useParams, Link } from 'react-router-dom';
import { useAgentDetail } from '../../hooks/useDetail';
import { StateBadge, StatusBadge } from '../shared/Badge';
import { CopyButton } from '../shared/CopyButton';
import { logicalTopicDetailPath, topicDetailPath } from '../../utils/routing';

export default function AgentDetailPage() {
  const { agentName } = useParams();
  const { data: model, isLoading } = useAgentDetail(agentName || '');

  if (isLoading) return <div className="muted">Loading agent...</div>;
  if (!model) return <div className="muted">Agent not found</div>;

  const { agent, relatedTopics, recentHandoffs, events } = model;

  return (
    <div className="page">
      <div className="hero">
        <div>
          <div>
            <Link to="/agents">&larr; Back to agents</Link>
          </div>
          <h1>{agent.agent}</h1>
          <div className="hero-copy">
            Agent detail view with recent related topics and process-state events.
          </div>
        </div>
        <div>
          <StateBadge value={agent.derivedState} />
        </div>
      </div>

      <div className="panel">
        <div className="summary-row">
          <span>
            <strong>Last seen</strong> {agent.lastSeenAt || 'unknown'}
          </span>
          <span>
            <strong>Handoffs</strong> {agent.publishCount}
          </span>
          <span>
            <strong>Runs 24h</strong> {agent.runCount24h}
          </span>
          <span>
            <strong>Blocked 24h</strong> {agent.blockedCount24h || 0}
          </span>
        </div>
      </div>

      {recentHandoffs.length > 0 && (
        <div className="section">
          <div className="section-header">
            <div>
              <h2>Recent handoff conclusions</h2>
              <div className="section-copy">
                Latest conclusions published by this agent, most recent first.
              </div>
            </div>
          </div>
          <div className="timeline">
            {recentHandoffs.map((h) => (
              <div key={h.id} className="timeline-item" data-kind="handoff">
                <div className="timeline-head">
                  <div className="timeline-meta">
                    <StatusBadge value={h.status} />{' '}
                    <Link to={h.logicalTopicId ? logicalTopicDetailPath(h.logicalTopicId) : topicDetailPath(h.project, h.workspace || '_', h.topic)} style={{ fontWeight: 600 }}>
                      {h.topic}
                    </Link>
                    <CopyButton value={h.topic} label="copy topic" />
                    <span className="muted">{h.project}</span>
                  </div>
                  <div className="muted small">{h.updatedAtDisplay || h.updatedAt}</div>
                </div>
                <div className="timeline-section">
                  <div className="json-box">
                    <pre>{h.conclusion || h.conclusionPreview || ''}</pre>
                  </div>
                </div>
                {h.nextAction && (
                  <div className="timeline-section">
                    <div className="next-action">
                      <div className="next-action-label">Next action</div>
                      <pre style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '13px', lineHeight: '1.6' }}>
                        {h.nextAction}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid">
        <div className="panel">
          <h2>Related topics</h2>
          <div className="topic-list">
            {relatedTopics.map((t) => (
              <div key={t.key} className="topic-item">
                <StateBadge value={t.derivedTaskState} />{' '}
                <Link to={t.logicalTopicId ? logicalTopicDetailPath(t.logicalTopicId) : topicDetailPath(t.project, t.workspaceKey, t.topic)}>
                  {t.topic}
                </Link>
                <CopyButton value={t.topic} label="copy topic" />
                <div className="muted" style={{ marginTop: '4px', fontSize: '12px' }}>
                  {t.project}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h2>Recent events</h2>
          <div className="json-box">
            <pre>{JSON.stringify(events || [], null, 2)}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
