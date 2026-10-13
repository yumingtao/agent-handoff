import { useOverview } from '../../hooks/useData';

export default function OverviewCards() {
  const { data: overview } = useOverview();

  if (!overview) return null;

  const cards = [
    { label: 'Active topics', value: overview.activeTopics, tone: 'good' as const },
    { label: 'Blocked', value: overview.blockedSuspectTopics, tone: 'bad' as const },
    { label: 'Done', value: overview.doneTopics, tone: 'neutral' as const },
    { label: 'Cancelled', value: overview.cancelledTopics, tone: 'neutral' as const },
    { label: 'Stale topics', value: overview.staleTopics, tone: 'warn' as const },
    { label: 'Expired', value: overview.expiredTopics, tone: 'neutral' as const },
    { label: 'Agents active', value: overview.agentsActiveRecently, tone: 'good' as const },
    { label: 'Recent errors', value: overview.agentsWithRecentErrors, tone: 'bad' as const },
  ];

  return (
    <div className="cards">
      {cards.map((c) => (
        <div key={c.label} className={`card card-${c.tone}`}>
          <div className="card-label">{c.label}</div>
          <div className="card-value">{c.value}</div>
        </div>
      ))}
    </div>
  );
}
