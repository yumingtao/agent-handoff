export function StateBadge({ value }: { value: string }) {
  const tone =
    value === 'active' || value === 'active-recently'
      ? 'good'
      : value === 'stale' || value === 'idle'
        ? 'warn'
        : value === 'blocked' || value === 'blocked-suspect' || value === 'expired' || value === 'error-recently'
          ? 'bad'
          : 'neutral';
  return <span className={`badge badge-${tone}`}>{value}</span>;
}

export function TaskStateBadge({ value }: { value: string | null }) {
  const label = value || 'legacy';
  const tone = label === 'open' ? 'good' : 'neutral';
  return <span className={`badge badge-${tone}`} aria-label={`Task state: ${label}`}>{label}</span>;
}

export function HealthStateBadge({ value }: { value: string }) {
  const tone = value === 'healthy' ? 'good' : value === 'stale' ? 'warn' : 'bad';
  return <span className={`badge badge-${tone}`} aria-label={`Health: ${value}`}>{value}</span>;
}

export function StatusBadge({ value }: { value: string }) {
  const tone = value === 'active' ? 'good' : value === 'superseded' ? 'warn' : 'neutral';
  return <span className={`badge badge-${tone}`}>{value}</span>;
}
