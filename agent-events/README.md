# Agent Events

Local SQLite event stream for lightweight agent process-state hints.

It is intentionally separate from `agent-handoff` conclusions and from `trace-store` runs.

## Event types

- `task_claimed`
- `task_progress`
- `task_blocked`
- `task_released`
- `agent_heartbeat`

## Run

```bash
cd agent-events
node src/cli.mjs publish \
  --project my-repo \
  --workspace /absolute/workspace \
  --topic ISSUE-25481 \
  --agent codex \
  --event-type task_progress \
  --payload '{"note":"Investigating coverage gap"}'
```

List recent events:

```bash
node src/cli.mjs list --project my-repo --limit 20
```

Default DB path: `~/.agent-handoff/agent-events.db`
