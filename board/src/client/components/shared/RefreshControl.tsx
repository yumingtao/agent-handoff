import { REFRESH_INTERVALS } from '../../hooks/useAutoRefresh';

interface Props {
  /** Seconds; 0 means off. */
  interval: number;
  onIntervalChange: (seconds: number) => void;
  onRefreshNow: () => void;
  lastRefreshedAt: Date | null;
}

export default function RefreshControl({ interval, onIntervalChange, onRefreshNow, lastRefreshedAt }: Props) {
  const lastLabel = lastRefreshedAt
    ? lastRefreshedAt.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : null;

  return (
    <div className="refresh-control">
      <button
        type="button"
        className="refresh-now-btn"
        onClick={onRefreshNow}
        title="Refresh now"
      >
        <span className="refresh-icon">↻</span>
      </button>
      <div className="refresh-select-wrap">
        <select
          className="refresh-select"
          value={interval}
          onChange={(e) => onIntervalChange(Number(e.target.value))}
          title="Auto-refresh interval"
        >
          {REFRESH_INTERVALS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label === 'Off' ? 'Auto: Off' : `Auto: ${opt.label}`}
            </option>
          ))}
        </select>
      </div>
      {interval > 0 && lastLabel && (
        <span className="refresh-last">↻ {lastLabel}</span>
      )}
    </div>
  );
}
