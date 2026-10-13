# Loop Engineering Board

## Purpose

`board` is the local operational board for loop engineering work.

It is intentionally **not** a multi-vendor orchestrator. It provides one local view that combines:

- `agent-handoff` conclusions from `~/.agent-handoff/handoff.db`
- local trace activity from `.agent-handoff/traces.db`
- lightweight process-state events from `~/.agent-handoff/agent-events.db`

This preserves the original boundary:

- handoff stores **context and conclusions**
- trace-store stores **runs and spans**
- agent-events stores **process state hints** like claim/block/heartbeat

## What is implemented

### Phase 1

- local HTML board with topic list and topic detail pages
- filters for `project`, `workspace`, `topic`, `sourceAgent`, and derived state
- grouped topic model keyed by `project + workspace + topic`
- ops actions for `health`, `backup`, and `cleanup preview`

### Phase 2

- trace overlay from `.agent-handoff/traces.db`
- orchestration review runs can now attach optional handoff metadata:
  - `project`
  - `workspace`
  - `topic`
- board resolves those trace runs back into topic views

### Phase 3

- separate `agent-events` SQLite store
- supported events:
  - `task_claimed`
  - `task_progress`
  - `task_blocked`
  - `task_released`
  - `agent_heartbeat`
- board uses these events to strengthen topic and agent derived states

## Why `agent-events` is separate

Do not overload `conclusions.status` for process state.

`conclusions.status` remains record lifecycle only:

- `active`
- `superseded`
- `archived`

Process state evolves faster and is lower confidence. Keeping it in a separate event stream avoids mixing:

- final conclusions
- transient progress updates
- runtime liveness hints

## How to use

### Start the board

```bash
cd board
npm run build   # build React SPA to dist/ (only needed once or after frontend changes)
npm start       # single server: API + SSE + static SPA on port 4319
```

Open **`http://127.0.0.1:4319`**.

Port 4319 is a full-featured standalone server — it serves the built React app and all API routes together. Do **not** use port 5173 (that is the optional Vite dev server for frontend HMR only, and requires a separate `npm run dev` process).

### Publish an agent event

```bash
cd agent-events
node src/cli.mjs publish \
  --project my-backend \
  --workspace /absolute/workspace \
  --topic ISSUE-25481 \
  --agent codex \
  --event-type task_progress \
  --payload '{"note":"Investigating coverage gap"}'
```

### Attach handoff scope to orchestration review traces

```bash
node orchestration/src/cli.mjs review \
  --repo /absolute/path/to/repo \
  --adapter fixture \
  --fixture /absolute/path/to/fixture.json \
  --project my-backend \
  --workspace /absolute/path/to/repo \
  --topic ISSUE-25481
```

## Current limits

- agent state is still derived, not authoritative runtime truth
- most existing traces do not yet contain handoff metadata; only new runs can be correlated automatically
- board remains local-only and should not be exposed publicly

## Frozen Boundary

The Board is frozen as a read/maintenance surface. Do not add Board UI, charts, statistics, task-state models, or APIs for independent review. The review protocol is implemented by six dedicated MCP tools and additive handoff tables; the Board only sees the final ordinary conclusion. Review-case discovery and lifecycle transitions remain MCP concerns, not Board features.

Allowed maintenance is limited to data-corruption recovery, security fixes, and blocking regressions. Do not bulk-close topics from conclusion text. Completed or explicitly parked topics must be closed by an explicit state transition before declaring the Board frozen.
