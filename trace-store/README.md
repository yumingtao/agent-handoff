# Workflow trace store

Local SQLite storage for workflow runs, agent and synthesizer spans, tool calls, policy decisions, and human gates. Sensitive key names and bearer credentials are redacted before persistence. Raw tokens must never be passed as trace attributes.

The initial implementation uses Node.js `node:sqlite`, requires Node 22, and is intended for local pilot use. Its schema keeps the export boundary small for a later OpenTelemetry or enterprise tracing adapter.

Operational commands:

```bash
node trace-store/src/cli.mjs metrics --db .agent-handoff/traces.db
node trace-store/src/cli.mjs show --db .agent-handoff/traces.db --run-id RUN_ID
node trace-store/src/cli.mjs dashboard --db .agent-handoff/traces.db --out .agent-handoff/trace-dashboard.html
node trace-store/src/cli.mjs prune --db .agent-handoff/traces.db --days 30
```
