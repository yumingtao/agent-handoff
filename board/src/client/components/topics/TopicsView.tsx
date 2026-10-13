import { useSearchParams, Link } from 'react-router-dom';
import { useTopics, useOverview } from '../../hooks/useData';
import { HealthStateBadge, TaskStateBadge } from '../shared/Badge';
import { Pagination } from '../shared/Pagination';
import { CopyButton } from '../shared/CopyButton';
import { logicalTopicDetailPath, topicDetailPath } from '../../utils/routing';

function compactPath(value: string | null) {
  if (!value) return '';
  if (value.length <= 42) return value;
  return `${value.slice(0, 18)}...${value.slice(-18)}`;
}

function agentInitial(agent: string) {
  return agent.trim().slice(0, 1).toUpperCase() || '?';
}

export default function TopicsView() {
  const [searchParams] = useSearchParams();
  const sort = searchParams.get('sort') || 'updated';

  const filters = Object.fromEntries(searchParams.entries());
  const { data, isLoading } = useTopics(filters);

  // Build topic detail URL with current filter params preserved
  const filterSearchParams = new URLSearchParams(searchParams);
  const filterQuery = filterSearchParams.toString() ? `?${filterSearchParams.toString()}` : '';
  const { data: overview } = useOverview();

  if (isLoading) return <div className="muted">Loading topics...</div>;

  const topics = data?.topics ?? [];
  const pagination = data?.pagination ?? { totalTopics: 0, totalPages: 1, currentPage: 1, pageSize: 10 };

  const taskSummary = [
    { label: 'Open', count: overview?.openTaskTopics ?? 0, tone: 'good' },
    { label: 'Done', count: overview?.doneTaskTopics ?? 0, tone: 'neutral' },
    { label: 'Cancelled', count: overview?.cancelledTaskTopics ?? 0, tone: 'neutral' },
    { label: 'Legacy', count: overview?.legacyTaskTopics ?? 0, tone: 'neutral' },
  ];
  const healthSummary = [
    { label: 'Healthy', count: overview?.healthyTopics ?? 0, tone: 'good' },
    { label: 'Stale', count: overview?.staleHealthTopics ?? 0, tone: 'warn' },
    { label: 'Blocked', count: overview?.blockedHealthTopics ?? 0, tone: 'bad' },
    { label: 'Expired', count: overview?.expiredHealthTopics ?? 0, tone: 'bad' },
  ];

  function buildSortURL(key: string) {
    const next = new URLSearchParams(searchParams);
    next.set('sort', key);
    next.set('page', '1');
    return `/?${next.toString()}`;
  }

  function buildPageURL(p: number) {
    const next = new URLSearchParams(searchParams);
    next.set('page', String(p));
    return `/?${next.toString()}`;
  }

  return (
    <section className="section">
      <div className="section-header">
        <div>
          <h2>Topics</h2>
          <div className="section-copy">
            The main triage surface. Use it to understand which topic is active, stale, blocked, or
            already superseded.
          </div>
        </div>
        <div className="section-meta">{pagination.totalTopics} topics</div>
      </div>

      <div className="topics-state-summary">
        <div className="topics-summary-group" role="group" aria-label="Task state summary">
          <span className="topics-summary-title">Task state</span>
          {taskSummary.map((s) => (
            <span key={s.label} className={`filter-chip filter-chip-${s.tone}`}>
              <span className="filter-chip-label">{s.label}</span>
              <span className="filter-chip-count">{s.count}</span>
            </span>
          ))}
        </div>
        <div className="topics-summary-group" role="group" aria-label="Health summary">
          <span className="topics-summary-title">Health</span>
          {healthSummary.map((s) => (
            <span key={s.label} className={`filter-chip filter-chip-${s.tone}`}>
              <span className="filter-chip-label">{s.label}</span>
              <span className="filter-chip-count">{s.count}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col" aria-sort={sort === 'topic' ? 'ascending' : 'none'}>
                <Link className="sort-link" to={buildSortURL('topic')} aria-label="Sort by topic">
                  Topic{sort === 'topic' ? ' ↑' : ''}
                </Link>
              </th>
              <th scope="col" className="topics-optional-column">Latest ID</th>
              <th scope="col" aria-sort={sort === 'taskState' ? 'ascending' : 'none'}>
                <Link className="sort-link" to={buildSortURL('taskState')} aria-label="Sort by task state">
                  Task state{sort === 'taskState' ? ' ↑' : ''}
                </Link>
              </th>
              <th scope="col" aria-sort={sort === 'healthState' ? 'ascending' : 'none'}>
                <Link className="sort-link" to={buildSortURL('healthState')} aria-label="Sort by health">
                  Health{sort === 'healthState' ? ' ↑' : ''}
                </Link>
              </th>
              <th scope="col" className="topics-optional-column" aria-sort={sort === 'agent' ? 'ascending' : 'none'}>
                <Link className="sort-link" to={buildSortURL('agent')}>
                  Owner{sort === 'agent' ? ' ↑' : ''}
                </Link>
              </th>
              <th scope="col" className="topics-optional-column" aria-sort={sort === 'updated' ? 'ascending' : 'none'}>
                <Link className="sort-link" to={buildSortURL('updated')}>
                  Updated{sort === 'updated' ? ' ↑' : ''}
                </Link>
              </th>
              <th scope="col" className="topics-optional-column topics-signal-column">Signal</th>
            </tr>
          </thead>
          <tbody>
            {topics.map((t) => (
              <tr key={t.key}>
                <td>
                  <div className="topic-name">
                    <Link to={`${t.logicalTopicId ? logicalTopicDetailPath(t.logicalTopicId) : topicDetailPath(t.project, t.workspaceKey, t.topic)}${filterQuery}`}>
                      {t.topic}
                    </Link>
                    <CopyButton value={t.topic} label="copy topic" />
                    {t.aliasCount > 1 && (
                      <span
                        className="topic-alias-badge"
                        title={t.rawTopics.join(', ')}
                      >
                        aliases {t.aliasCount}
                      </span>
                    )}
                  </div>
                  {t.latestConclusionPreview && (
                    <div className="topic-preview" title={t.latestConclusionPreview}>
                      {t.latestConclusionPreview}
                    </div>
                  )}
                  <div className="topic-meta">{t.project}</div>
                  {t.workspace && (
                    <div className="topic-path" title={t.workspace}>
                      {compactPath(t.workspace)}
                    </div>
                  )}
                </td>
                <td className="topics-optional-column">
                  <div className="id-cell">
                    <CopyButton value={t.latestConclusionId || ''} />
                      <Link
                        className="id-link"
                        to={`${t.logicalTopicId ? logicalTopicDetailPath(t.logicalTopicId) : topicDetailPath(t.project, t.workspaceKey, t.topic)}${filterQuery}`}
                        title="Open topic detail"
                      >
                      ↗
                    </Link>
                  </div>
                </td>
                <td>
                  <TaskStateBadge value={t.taskState} />
                </td>
                <td>
                  <HealthStateBadge value={t.healthState} />
                </td>
                <td className="topics-optional-column">
                  <span className="agent-name">{t.latestSourceAgent || 'unknown'}</span>
                  {t.latestSourceHost && <span className="muted small"> / {t.latestSourceHost}</span>}
                </td>
                <td className="topics-optional-column">
                  <div className="time-value">{t.latestUpdatedAtDisplay || t.latestUpdatedAt}</div>
                  <div className="muted small">{t.relatedRunStatus || 'no trace'}</div>
                </td>
                <td className="topics-optional-column topics-signal-column">
                  <div className="signal-stack">
                    <span className="signal-item">
                      <span className="signal-label">records</span>
                      <span className="signal-value">{t.recordCount}</span>
                    </span>
                    <span className="signal-item" title={t.participantAgents.join(', ') || 'No agents'}>
                      <span className="signal-label">agents</span>
                      <span className="participant-chip-stack" aria-label={`${t.participantCount} participant agents`}>
                        {t.participantAgents.slice(0, 4).map((agent) => (
                          <span key={agent} className="participant-chip" title={agent}>
                            <span className="participant-chip-initial" aria-hidden="true">{agentInitial(agent)}</span>
                            <span className="participant-chip-name">{agent}</span>
                          </span>
                        ))}
                        {t.participantCount > 4 && (
                          <span className="participant-chip participant-chip-overflow">+{t.participantCount - 4}</span>
                        )}
                        <span className="participant-count">{t.participantCount}</span>
                      </span>
                    </span>
                    <span className="signal-item">
                      <span className="signal-label">refs</span>
                      <span className="signal-value">{t.refsCount}</span>
                    </span>
                    <span className="signal-item">
                      <span className="signal-label">supersedes</span>
                      <span className="signal-value">{t.supersedeDepth}</span>
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        page={pagination.currentPage}
        totalPages={pagination.totalPages}
        totalTopics={pagination.totalTopics}
        buildURL={buildPageURL}
      />
    </section>
  );
}
