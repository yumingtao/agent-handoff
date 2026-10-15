interface StatusBarProps {
  interval: number;
  lastRefreshedAt: Date | null;
}

export default function StatusBar({ interval, lastRefreshedAt }: StatusBarProps) {
  const updatedLabel = lastRefreshedAt
    ? lastRefreshedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'Never';
  const refreshLabel = interval === 0 ? 'Off' : `${interval}s`;

  return (
    <footer className="status-bar" role="status" aria-label="Board status">
      <div className="status-bar-left">
        <span className="status-item">
          <span className="status-label">Updated</span>
          <span className="status-value">{updatedLabel}</span>
        </span>
        <span className="status-sep" aria-hidden="true">·</span>
        <span className="status-item">
          <span className="status-label">Refresh</span>
          <span className="status-value">{refreshLabel}</span>
        </span>
      </div>
      <div className="status-bar-right">
        <span className="status-item">
          <span className="status-label">Loop Engineering Board</span>
          <span className="status-value status-version">v0.2.0</span>
        </span>
        <span className="status-sep" aria-hidden="true">·</span>
        <span className="status-item">
          <span className="status-label">Port</span>
          <span className="status-value status-version">4319</span>
        </span>
      </div>
    </footer>
  );
}
