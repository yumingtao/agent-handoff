export function renderDashboard(metrics, runs) {
  const cards = [
    ['Runs', metrics.runs.total],
    ['Agent calls', metrics.agents.total],
    ['Prompt tokens', metrics.agents.promptTokens],
    ['Completion tokens', metrics.agents.completionTokens],
    ['Policy denied', metrics.policy.deny || 0],
    ['Approved verdicts', metrics.humanGates.approved || 0]
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Handoff governed agent traces</title><style>
body{font:14px system-ui;margin:32px;background:#f5f7fa;color:#18202a}h1{margin-bottom:8px}.muted{color:#667085}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:24px 0}.card,table{background:white;border:1px solid #d9e0e8;border-radius:10px}.card{padding:16px}.value{font-size:26px;font-weight:700}table{border-collapse:collapse;width:100%;overflow:hidden}th,td{text-align:left;padding:10px;border-bottom:1px solid #e8edf2}th{background:#eef2f6}code{font-size:12px}</style></head>
<body><h1>Governed multi-agent traces</h1><div class="muted">Local redacted operational view</div>
<div class="cards">${cards.map(([label, value]) => `<div class="card"><div class="muted">${escape(label)}</div><div class="value">${escape(value)}</div></div>`).join('')}</div>
<h2>Recent runs</h2><table><thead><tr><th>Started</th><th>Run</th><th>Capability</th><th>Status</th><th>Actor</th></tr></thead><tbody>
${runs.map((run) => `<tr><td>${escape(run.started_at)}</td><td><code>${escape(run.run_id)}</code></td><td>${escape(run.capability_id)}</td><td>${escape(run.status)}</td><td>${escape(run.actor)}</td></tr>`).join('')}
</tbody></table></body></html>\n`;
}

function escape(value) { return String(value ?? '').replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
