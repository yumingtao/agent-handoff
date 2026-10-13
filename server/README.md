# Agent Handoff MCP Server

Local MCP server for cross-agent handoff conclusions. It lets one agent publish a structured conclusion and another agent retrieve the latest active context by exact `project + topic` scope.

Handoff records are context only. `next_action` is always a suggested action, not permission to commit, push, edit Jira, call remote APIs, or bypass the normal workflow gates.

## Storage

Default storage:

```text
~/.agent-handoff/
  handoff.db
  files/
  backups/
```

SQLite is the main store and uses Node's built-in `node:sqlite` binding. This requires Node `>= 22.5`; the API is still marked experimental in Node 22. Each published conclusion is also written as one JSON file under `files/` so non-MCP tools can read the handoff protocol directly.

Optional environment variables:

```bash
export AGENT_HANDOFF_HOME="$HOME/.agent-handoff"
export AGENT_HANDOFF_DB_PATH="$HOME/.agent-handoff/handoff.db"
export AGENT_HANDOFF_FILES_DIR="$HOME/.agent-handoff/files"
export AGENT_HANDOFF_BACKUPS_DIR="$HOME/.agent-handoff/backups"
export AGENT_HANDOFF_SECRET_SCAN="1"
# Time zone for the human-readable *_at_display fields. Falls back to TZ, then
# the OS default. Stored timestamps stay canonical UTC regardless.
export AGENT_HANDOFF_TZ="Asia/Shanghai"
```

Timestamps (`created_at`, `updated_at`, `expires_at`) are stored and compared in
UTC. Read responses additionally include `created_at_display` /
`updated_at_display` / `expires_at_display` (rendered in the resolved zone, e.g.
`2026-06-30 15:09:43 GMT+8 [Asia/Shanghai]`) and `created_at_relative` (e.g.
`3 hours ago`) for human confirmation.

## Tools

- `publish_conclusion` — publish a new active conclusion.
- `publish_review_ready_implementation` — publish a final implementation handoff and then create its hidden-baseline independent review case; returns both ids. Use only for explicitly review-ready implementations.
- `create_review_case` — create a workflow-level independent review case with objective, scope, acceptance criteria, snapshot/worktree reference, refs, and constraints while withholding baseline details.
- `get_review_packet` — return the original task material and case scope without baseline id, body, or summary.
- `submit_independent_assessment` — durably submit the independent assessment and then reveal the baseline atomically; requires an idempotency `request_id`.
- `publish_review_comparison` — publish the final comparison as an ordinary conclusion after assessment; accepts optional `logical_topic_id` or `supersedes_id` to continue an existing logical thread when the review round uses a different topic; the review case remains `compared` until explicitly transitioned; requires an idempotency `request_id`.
- `list_review_cases` — list review cases by project/workspace/topic/status without revealing baseline data.
- `transition_review_case` — close, cancel, archive, or explicitly reopen an eligible review case with a reason and idempotency key.

Structured comparisons contain `agreements`, `author_only`, `reviewer_only`, `disagreements`, `evidence_gaps`, and `final_recommendation`, and are linked to the review case, assessment, and ordinary conclusion.
- `get_latest_conclusion` — get the latest active, unexpired conclusion for exact `project + topic`, optionally filtered by `workspace`.
- `list_conclusions` — list records with `project`, `workspace`, `topic`, `since`, `status`, and `limit` filters. Sensitive records are summarized by default.
- `supersede_conclusion` — mark an existing conclusion as superseded by another conclusion, or archive it when there is no replacement.
- `backup_storage` — create a local backup of the SQLite database and fallback JSON files under `backups/`.
- `cleanup_conclusions` — preview or delete old records. Defaults to dry-run; real deletion requires `confirmDelete=true`.
- `health_check` — report storage paths, schema version, writeability, record count, Node version, and secret-scan status.

`get_latest_conclusion` is still exact-match first. If no active unexpired record exists for the requested topic, it returns recent same-project candidates so the caller can choose instead of guessing.

## Safety

Secret scan is enabled by default. The server refuses writes that look like bearer tokens, cookies, private keys, cloud keys, GitHub tokens, or common key/value secrets. Redact secrets before publishing a handoff.

Conclusion text containing tool-call serialization residue such as `</parameter>` or `</invoke>` is rejected and never auto-cleaned. A warning is a successful write response; callers must not republish because a warning was returned or silently retry a mutating write. See `docs/independent-review-protocol.md` for the review sequencing and A/B evidence rules.

Records with `sensitivity=sensitive` are not returned with full body text from `list_conclusions` unless `includeSensitiveDetails=true` is explicitly requested.

## Build

```bash
cd server
npm install
npm run build
```

## Install

```bash
cd server
./install.sh
```

Supported platform names are `claude-code`, `claude-desktop`, `codex`, `copilot-vscode`, `copilot-intellij`, `codebuddy`, `cline`, `cursor`, `opencode`, `hermes`, `trae-ide`, `trae-cli`, `all`, and `none`. Handoff records also accept the generic Trae `source_agent` value `trae` for clients that do not distinguish IDE from CLI.

Install examples:

```bash
./install.sh --platforms claude-code,codex,cursor
./install.sh --all
./install.sh --platforms none --no-build
```

Restart or reload the selected AI clients after installation.
