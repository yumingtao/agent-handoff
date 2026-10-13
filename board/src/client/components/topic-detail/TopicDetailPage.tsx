import { useEffect, useRef, useCallback, useState } from 'react';
import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useTopicDetail, useLogicalTopicDetail } from '../../hooks/useDetail';
import { StateBadge, StatusBadge } from '../shared/Badge';
import { CopyButton } from '../shared/CopyButton';
import { WorkflowFlowDiagram } from './WorkflowFlowDiagram';
import { postForm } from '../../net/client';
import { useToast } from '../../App';
import { parseTopicKey } from '../../utils/routing';
import { labelEventType as labelEventTitle } from '@shared/topic-context/event-labels.mjs';
import type { HandoffRecord, TopicDetail } from '../../types';

const TIMELINE_FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'handoff', label: 'Handoffs' },
  { key: 'event', label: 'Events' },
  { key: 'trace', label: 'Traces' },
];

export default function TopicDetailPage() {
  const { key, logicalTopicId } = useParams();
  const navigate = useNavigate();
  const { project, workspace, topic } = parseTopicKey(decodeURIComponent(key || ''));
  const [searchParams, setSearchParams] = useSearchParams();
  const timelineFilter = searchParams.get('timeline') || 'all';

  // Build back URL preserving filter params (excluding topic-detail-specific ones)
  const backParams = new URLSearchParams(searchParams);
  backParams.delete('timeline');
  const backUrl = `/${backParams.toString() ? `?${backParams.toString()}` : ''}`;
  const legacyDetail = useTopicDetail(project, workspace, topic, timelineFilter);
  const logicalDetail = useLogicalTopicDetail(logicalTopicId || '', timelineFilter);
  const model = logicalTopicId ? logicalDetail.data : legacyDetail.data;
  const isLoading = logicalTopicId ? logicalDetail.isLoading : legacyDetail.isLoading;
  const queryClient = useQueryClient();
  const toast = useToast();
  const timelineRef = useRef<HTMLDivElement>(null);

  const scrollToTimelineItem = useCallback((timelineKey: string) => {
    const container = timelineRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-timeline-key="${CSS.escape(timelineKey)}"]`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('timeline-item-flash');
      setTimeout(() => el.classList.remove('timeline-item-flash'), 1500);
    }
  }, []);

  useEffect(() => {
    if (!logicalTopicId && model?.detail?.logicalTopicId) {
      navigate(`/topic/${encodeURIComponent(model.detail.logicalTopicId)}`, { replace: true });
    }
  }, [logicalTopicId, model?.detail?.logicalTopicId, navigate]);

  const quickEventMut = useMutation({
    mutationFn: (data: Record<string, string>) =>
      postForm<{ ok: boolean }>('/ops/publish-event', data),
    onSuccess: () => {
      toast('success', 'Event published');
      queryClient.invalidateQueries({ queryKey: ['topic'] });
    },
    onError: (err) => {
      toast('error', `Publish failed: ${err.message}`);
    },
  });

  const [transitionDialog, setTransitionDialog] = useState<{ targetState: string } | null>(null);
  const [transitionReason, setTransitionReason] = useState('');
  const [transitionOperator, setTransitionOperator] = useState('');
  const [archiveDialog, setArchiveDialog] = useState<{ recordId: string } | null>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const [archiveOperator, setArchiveOperator] = useState('');

  const transitionMut = useMutation({
    mutationFn: (data: Record<string, string>) =>
      postForm<{ ok: boolean; error?: string }>('/api/topic-transition', data),
    onSuccess: (data) => {
      if (data.ok === false) {
        toast('error', `Transition failed: ${data.error || 'unknown error'}`);
        return;
      }
      toast('success', 'Task state updated');
      setTransitionDialog(null);
      setTransitionReason('');
      queryClient.invalidateQueries({ queryKey: ['topic'] });
    },
    onError: (err) => {
      toast('error', `Transition failed: ${err.message}`);
    },
  });

  function submitTransition(targetState: string) {
    transitionMut.mutate({
      logicalTopicId: model?.detail?.logicalTopicId || '',
      targetState,
      changedBy: transitionOperator || 'board-operator',
      reason: transitionReason,
      ...(topicView?.taskState ? { expectedState: topicView.taskState } : {}),
    });
  }

  const archiveMut = useMutation({
    mutationFn: (data: Record<string, string>) =>
      postForm<{ ok: boolean; error?: string }>('/api/conclusion-archive', data),
    onSuccess: (data) => {
      if (data.ok === false) {
        toast('error', `Archive failed: ${data.error || 'unknown error'}`);
        return;
      }
      toast('success', 'Conclusion archived');
      setArchiveDialog(null);
      setArchiveReason('');
      queryClient.invalidateQueries({ queryKey: ['topic'] });
    },
    onError: (err) => {
      toast('error', `Archive failed: ${err.message}`);
    },
  });

  function submitArchive(recordId: string) {
    archiveMut.mutate({
      id: recordId,
      changedBy: archiveOperator,
      reason: archiveReason,
    });
  }

  function publishQuickEvent(eventType: string, agent: string) {
    quickEventMut.mutate({
      project: detailProject(model),
      workspace: detailWorkspace(model) || '',
      topic: detailTopic(model),
      logicalTopicId: model?.detail?.logicalTopicId || '',
      agent: agent || 'manual',
      eventType,
      payload: '{}',
    });
  }

  function setTimelineFilter(filter: string) {
    const next = new URLSearchParams(searchParams);
    if (filter === 'all') {
      next.delete('timeline');
    } else {
      next.set('timeline', filter);
    }
    setSearchParams(next, { replace: true });
  }

  if (isLoading) return <div className="muted">Loading topic...</div>;
  if (!model) return <div className="muted">Topic not found</div>;

  const { detail, trace, topic: topicView, events, mergedTimeline, workflowGraph } = model;
  const latest = detail.latest;
  const activityByAgent = new Map<string, { handoffs: number; events: number; traces: number }>();
  const ensureActivity = (agent: string) => {
    const current = activityByAgent.get(agent) || { handoffs: 0, events: 0, traces: 0 };
    activityByAgent.set(agent, current);
    return current;
  };
  detail.records.forEach((record: HandoffRecord) => {
    ensureActivity(record.sourceAgent || 'unknown').handoffs += 1;
  });
  events.forEach((event) => {
    ensureActivity(event.agent || 'unknown').events += 1;
  });
  runsForActivity(model).forEach((run) => {
    ensureActivity(run.actor || 'unknown').traces += 1;
  });
  const activityRows = Array.from(activityByAgent, ([agent, counts]) => ({
    agent,
    ...counts,
    total: counts.handoffs + counts.events + counts.traces,
  })).sort((left, right) => right.total - left.total || left.agent.localeCompare(right.agent));

  return (
    <div className="page">
      <div className="hero">
        <div>
          <div>
            <Link to={backUrl}>&larr; Back to board</Link>
          </div>
          <div className="topic-name">
            <h1>{detail.topic}</h1>
            <CopyButton value={detail.topic} label="copy topic" />
          </div>
          <div className="hero-copy">
            {detail.project}
            {detail.workspace ? ` · ${detail.workspace}` : ''}
          </div>
          {detail.aliasCount > 1 && (
            <div className="topic-alias-note" title={detail.rawTopics.join(', ')}>
              aliases: {detail.rawTopics.join(', ')}
            </div>
          )}
        </div>
        <div className="hero-badge">Topic detail</div>
      </div>

      <div className="section">
        <div className="panel">
          <div className="section-header">
            <div>
              <h2>Agent activity</h2>
              <div className="section-copy">
                Activity grouped by actor. Handoffs are complete history; events are capped at 100 and traces at 50.
              </div>
            </div>
          </div>
          {activityRows.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Handoffs</th>
                    <th>Events</th>
                    <th>Traces</th>
                    <th>Total loaded</th>
                  </tr>
                </thead>
                <tbody>
                  {activityRows.map((row) => (
                    <tr key={row.agent}>
                      <td><strong>{row.agent}</strong></td>
                      <td>{row.handoffs}</td>
                      <td>{row.events}</td>
                      <td>{row.traces}</td>
                      <td><strong>{row.total}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="muted">No agent activity recorded for this topic.</div>
          )}
        </div>
        <div className="panel">
          <h2>Latest active</h2>
          {latest ? (
            <>
              <div className="latest-meta">
                <StateBadge value={topicView.derivedTaskState} />
                {latest.model && (
                  <span className="model-chip" title="model">{latest.modelDisplay || latest.model}</span>
                )}
                <HandoffIdChip id={latest.id} />
                <span className="muted">by</span>{' '}
                <strong>{latest.sourceAgent || 'unknown'}</strong>
                {latest.sourceHost && <span className="muted small"> / {latest.sourceHost}</span>} <span className="muted">·</span>{' '}
                <span className="muted">{latest.updatedAtDisplay || latest.updatedAt}</span>
              </div>
              <div className="json-box">
                <pre>{latest.conclusion || latest.conclusionPreview || ''}</pre>
              </div>
              {latest.nextAction && (
                <div className="next-action">
                  <div className="next-action-label">Next action</div>
                  <pre style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '13px', lineHeight: '1.6' }}>
                    {latest.nextAction}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <div className="muted">No handoff conclusions yet for this logical topic.</div>
          )}
        </div>

        {detail.records.some((record: HandoffRecord) => record.status === 'active') && (
          <div className="panel">
            <h2>Conclusion actions</h2>
            <div className="muted small" style={{ marginBottom: '10px' }}>
              Archive an active conclusion when it is no longer valid and has no replacement.
            </div>
            {detail.records.filter((record: HandoffRecord) => record.status === 'active').map((record: HandoffRecord) => (
              <div key={record.id} className="event-item">
                <div className="event-item-head">
                  <HandoffIdChip id={record.id} />
                  <span className="muted small">{record.updatedAtDisplay || record.updatedAt}</span>
                  <button
                    type="button"
                    className="secondary"
                    disabled={archiveMut.isPending}
                    onClick={() => { setArchiveDialog({ recordId: record.id }); setArchiveReason(''); }}
                  >
                    Archive
                  </button>
                </div>
                <div className="muted small">by {record.sourceAgent || 'unknown'}</div>
              </div>
            ))}
            {archiveDialog && (
              <div className="transition-dialog" style={{ marginTop: '12px', padding: '12px', border: '1px solid var(--border)', borderRadius: '6px' }}>
                <div style={{ marginBottom: '8px' }}><strong>Archive conclusion</strong></div>
                <input
                  type="text"
                  placeholder="Your name (for audit)"
                  value={archiveOperator}
                  onChange={(e) => setArchiveOperator(e.target.value)}
                  style={{ width: '100%', marginBottom: '8px', padding: '6px 8px' }}
                />
                <textarea
                  placeholder="Reason (required)"
                  value={archiveReason}
                  onChange={(e) => setArchiveReason(e.target.value)}
                  rows={2}
                  style={{ width: '100%', marginBottom: '8px', padding: '6px 8px', resize: 'vertical' }}
                />
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="primary"
                    disabled={archiveMut.isPending || !archiveOperator.trim() || !archiveReason.trim()}
                    onClick={() => submitArchive(archiveDialog.recordId)}
                  >
                    {archiveMut.isPending ? 'Working...' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setArchiveDialog(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="panel">
          <h2>Quick actions</h2>
          <div className="quick-actions">
            <button
              type="button"
              className="secondary"
              title="Signal that the latest agent is still active"
              disabled={quickEventMut.isPending}
              onClick={() => publishQuickEvent('agent_heartbeat', latest?.sourceAgent || '')}
            >
              Heartbeat
            </button>
            <button
              type="button"
              className="secondary"
              title="Mark this topic as blocked by an obstacle"
              disabled={quickEventMut.isPending}
              onClick={() => publishQuickEvent('task_blocked', latest?.sourceAgent || '')}
            >
              Mark blocked
            </button>
            <button
              type="button"
              className="secondary"
              title="Claim ownership of this topic"
              disabled={quickEventMut.isPending}
              onClick={() => publishQuickEvent('task_claimed', latest?.sourceAgent || '')}
            >
              Claim
            </button>
            <button
              type="button"
              className="secondary"
              title="Release ownership of this topic"
              disabled={quickEventMut.isPending}
              onClick={() => publishQuickEvent('task_released', latest?.sourceAgent || '')}
            >
              Release
            </button>
          </div>
        </div>

        {topicView?.logicalTopicId && (
          <div className="panel">
            <h2>Task state</h2>
            <div className="task-state-info">
              <StateBadge value={topicView.displayState || topicView.derivedTaskState} />
              <span className="muted">
                taskState: <strong>{topicView.taskState || 'null (legacy)'}</strong>
                {topicView.completedBy && ` · completed by ${topicView.completedBy}`}
                {topicView.cancelledBy && ` · cancelled by ${topicView.cancelledBy}`}
              </span>
            </div>
            <div className="quick-actions" style={{ marginTop: '12px' }}>
              {(topicView.taskState || 'open') === 'open' && (
                <>
                  <button
                    type="button"
                    className="secondary"
                    disabled={transitionMut.isPending}
                    onClick={() => { setTransitionDialog({ targetState: 'done' }); setTransitionReason(''); }}
                  >
                    Mark done
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={transitionMut.isPending}
                    onClick={() => { setTransitionDialog({ targetState: 'cancelled' }); setTransitionReason(''); }}
                  >
                    Cancel
                  </button>
                </>
              )}
              {(topicView.taskState === 'done' || topicView.taskState === 'cancelled') && (
                <button
                  type="button"
                  className="secondary"
                  disabled={transitionMut.isPending}
                  onClick={() => { setTransitionDialog({ targetState: 'open' }); setTransitionReason(''); }}
                >
                  Reopen
                </button>
              )}
            </div>

            {transitionDialog && (
              <div className="transition-dialog" style={{ marginTop: '12px', padding: '12px', border: '1px solid var(--border)', borderRadius: '6px' }}>
                <div style={{ marginBottom: '8px' }}>
                  <strong>
                    {transitionDialog.targetState === 'done' && 'Complete task'}
                    {transitionDialog.targetState === 'cancelled' && 'Cancel task'}
                    {transitionDialog.targetState === 'open' && 'Reopen task'}
                  </strong>
                </div>
                <input
                  type="text"
                  placeholder="Your name (for audit)"
                  value={transitionOperator}
                  onChange={(e) => setTransitionOperator(e.target.value)}
                  style={{ width: '100%', marginBottom: '8px', padding: '6px 8px' }}
                />
                {(transitionDialog.targetState === 'done' || transitionDialog.targetState === 'cancelled') && (
                  <textarea
                    placeholder="Reason (required)"
                    value={transitionReason}
                    onChange={(e) => setTransitionReason(e.target.value)}
                    rows={2}
                    style={{ width: '100%', marginBottom: '8px', padding: '6px 8px', resize: 'vertical' }}
                  />
                )}
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="primary"
                    disabled={transitionMut.isPending || ((transitionDialog.targetState === 'done' || transitionDialog.targetState === 'cancelled') && !transitionReason.trim())}
                    onClick={() => submitTransition(transitionDialog.targetState)}
                  >
                    {transitionMut.isPending ? 'Working...' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setTransitionDialog(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {model.stateChanges && model.stateChanges.length > 0 && (
              <details style={{ marginTop: '12px' }}>
                <summary className="muted small">State change history ({model.stateChanges.length})</summary>
                <div className="state-change-list" style={{ marginTop: '8px' }}>
                  {model.stateChanges.map((change) => (
                    <div key={change.id} className="event-item" style={{ fontSize: '13px' }}>
                      <div className="event-item-head">
                        <span className="badge badge-neutral">{change.action}</span>
                        <span className="muted">{change.fromState || 'null'} &rarr; {change.toState}</span>
                      </div>
                      <div className="muted small">
                        by {change.changedBy}
                        {change.reason ? ` · ${change.reason}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        <div className="detail-grid">
          <div className="panel">
            <h2>Trace overlay</h2>
            {(trace && (trace.runIds?.length > 0 || trace.lastRunStatus)) || model.runs?.length > 0 ? (
              <>
                <div className="trace-summary">
                  <div className="trace-summary-item">
                    <span className="trace-summary-label">Last run</span>
                    <span className="trace-summary-value">
                      <StatusBadge value={trace?.lastRunStatus || model.runs?.[0]?.status || 'unknown'} />
                    </span>
                  </div>
                  {(trace?.lastRunAt || model.runs?.[0]?.started_at) && (
                    <div className="trace-summary-item">
                      <span className="trace-summary-label">Last run time</span>
                      <span className="trace-summary-value muted">{trace?.lastRunAt || model.runs[0].started_at}</span>
                    </div>
                  )}
                  <div className="trace-summary-item">
                    <span className="trace-summary-label">Running</span>
                    <span className="trace-summary-value">{trace?.runningRuns || 0}</span>
                  </div>
                  <div className="trace-summary-item">
                    <span className="trace-summary-label">Failed (24h)</span>
                    <span className="trace-summary-value">{trace?.failedRuns24h || 0}</span>
                  </div>
                  {model.runs?.[0]?.run_id && (
                    <div className="trace-summary-item">
                      <span className="trace-summary-label">Recent run</span>
                      <span className="trace-summary-value mono">{model.runs[0].run_id.slice(0, 8)}</span>
                    </div>
                  )}
                  {model.runs?.[0]?.capability_id && (
                    <div className="trace-summary-item">
                      <span className="trace-summary-label">Capability</span>
                      <span className="trace-summary-value">{model.runs[0].capability_id}</span>
                    </div>
                  )}
                </div>
                <details>
                  <summary className="muted small">Raw trace data</summary>
                  <div className="json-box" style={{ marginTop: '8px' }}>
                    <pre>{JSON.stringify(trace || model.runs, null, 2)}</pre>
                  </div>
                </details>
              </>
            ) : (
              <div className="empty-state">
                <p className="muted">No workflow trace runs are linked to this topic yet.</p>
                <p className="muted">Trace data appears here automatically when workflow runs publish matching logical topic metadata — showing run status, timing, and failure counts.</p>
              </div>
            )}
          </div>
          <div className="panel">
            <h2>Agent events</h2>
            {events && events.length > 0 ? (
              <>
                <div className="event-list">
                  {events.slice(0, 10).map((event, i) => (
                    <div key={i} className="event-item">
                      <div className="event-item-head">
                        <StateBadge value="active" />
                        <span style={{ fontWeight: 600 }}>{labelEventTitle(event.eventType)}</span>
                        <span className="muted small">{event.createdAtDisplay || event.createdAt}</span>
                      </div>
                      <div className="muted small">by {event.agent || 'unknown'}</div>
                    </div>
                  ))}
                </div>
                <details>
                  <summary className="muted small">Raw event data</summary>
                  <div className="json-box" style={{ marginTop: '8px' }}>
                    <pre>{JSON.stringify(events, null, 2)}</pre>
                  </div>
                </details>
              </>
            ) : (
              <div className="empty-state">
                <p className="muted">No agent events have been recorded for this topic yet.</p>
                <p className="muted">Use Quick actions to publish signals:</p>
                <ul className="empty-state-list muted">
                  <li><strong>Heartbeat</strong> — signal that an agent is still actively working</li>
                  <li><strong>Mark blocked</strong> — flag an obstacle preventing progress</li>
                  <li><strong>Claim</strong> — take ownership of this topic</li>
                  <li><strong>Release</strong> — give up ownership of this topic</li>
                </ul>
              </div>
            )}
          </div>
        </div>

        {workflowGraph && workflowGraph.nodeCount > 0 && (
          <div className="panel">
            <div className="section-header">
              <div>
                <h2>Workflow diagram</h2>
                <div className="section-copy">
                  Agent swimlanes with model sub-lanes. Click a node to jump to its timeline entry.
                </div>
              </div>
            </div>
            <WorkflowFlowDiagram graph={workflowGraph} onNodeClick={scrollToTimelineItem} />
          </div>
        )}

        <div className="panel">
          <div className="section-header">
            <div>
              <h2>Merged timeline</h2>
              <div className="section-copy">
                Unified handoff, trace, and event history ordered by time.
              </div>
            </div>
          </div>
          <div className="timeline-filters">
            {TIMELINE_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`timeline-chip ${timelineFilter === f.key ? 'timeline-chip-active' : ''}`}
                onClick={() => setTimelineFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="timeline" ref={timelineRef}>
            {mergedTimeline.length === 0 && (
              <div className="muted" style={{ padding: '20px 0', textAlign: 'center' }}>
                No timeline items for this filter.
              </div>
            )}
            {mergedTimeline.map((item, i) => {
              const stableKey = item.kind === 'handoff'
                ? `handoff-${item.meta?.id || i}`
                : item.kind === 'event'
                  ? `event-${item.meta?.id || item.meta?.ts || item.meta?.createdAt || i}`
                  : `trace-${item.meta?.run_id || i}`;
              return (
              <div key={stableKey} className="timeline-item" data-kind={item.kind} data-timeline-key={stableKey}>
                <div className="timeline-head">
                  <div className="timeline-meta">
                    {item.kind === 'handoff' ? (
                      <StatusBadge value={item.meta.status} />
                    ) : item.kind === 'event' ? (
                      <StateBadge value="active" />
                    ) : (
                      <span className="badge badge-neutral">trace</span>
                    )}{' '}
                    <span style={{ fontWeight: 600 }}>{item.title}</span>{' '}
                    {item.kind === 'handoff' && item.meta?.id && (
                      <>
                        {item.meta?.model && (
                          <span className="model-chip" title="model">{item.meta.modelDisplay || item.meta.model}</span>
                        )}
                        <HandoffIdChip id={item.meta.id} compact />
                      </>
                    )}{' '}
                    <span className="muted">{item.actor}</span>
                  </div>
                  <div className="muted small">{item.atDisplay || item.at}</div>
                </div>
                <div className="timeline-section">
                  <div className="json-box">
                    <pre>{item.body || ''}</pre>
                  </div>
                </div>
                {item.refs?.length > 0 && (
                  <div className="timeline-section">
                    <div
                      className="muted small"
                      style={{
                        marginBottom: '6px',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '.05em',
                      }}
                    >
                      Refs
                    </div>
                    <div className="ref-list">
                      {item.refs.map((ref, j) => (
                        <div key={j}>
                          {ref.type} · {ref.value}
                          {ref.line ? `:${ref.line}` : ''}
                          {ref.note ? ` · ${ref.note}` : ''}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function runsForActivity(model: TopicDetail) {
  return model.runs || [];
}

function HandoffIdChip({ id, compact = false }: { id: string; compact?: boolean }) {
  return (
    <span className={`handoff-id-chip${compact ? ' handoff-id-chip-compact' : ''}`}>
      <span className="handoff-id-label">ID</span>
      <span className="handoff-id-value">{id}</span>
      <CopyButton value={id} label="copy" />
    </span>
  );
}

function detailProject(model: TopicDetail | undefined) {
  return model?.detail?.project || '';
}

function detailWorkspace(model: TopicDetail | undefined) {
  return model?.detail?.workspace || null;
}

function detailTopic(model: TopicDetail | undefined) {
  return model?.detail?.topic || '';
}
