# Cross-Vendor Agent Review Handoff Convention

> English | [简体中文](cross-agent-review-handoff.zh-CN.md)

This convention describes how to use the local `agent-handoff` MCP so that **agents from different vendors** (Claude, Codex, Cursor, GitHub Copilot, Gemini CLI, Cline, CodeBuddy, OpenCode, Hermes, Trae) can review each other's output without manually copy-pasting prompts.

It turns the cross-vendor review workflow into a reusable handoff convention; the companion skill lives at `skills/cross-agent-review-handoff/SKILL.md`.

## Why It Exists

Handoff is an **explicit opt-in** capability, not a default closing action for every conversation. Ordinary clarification, implementation, validation, review, routing, blocker, or status reporting does not read or write handoffs and does not create topics. The handoff flow starts only when the engineer explicitly asks to "hand off", "publish a handoff", "run a cross-model review", "pick up the previous conclusion", or explicitly provides a topic / logical topic ID.

The common practice: after Agent A (say Claude Desktop) finishes, a human switches to another vendor's Agent B, opens a new session, pastes a prompt, and asks B to re-review with a different model. The pain point is the copy-paste.

Key constraint: **there is no shared orchestrator across vendors** (an OpenAI agent cannot spawn an Anthropic process, and vice versa), so a zero-touch "parent process feeds child process" trigger is impossible. The `agent-handoff` local blackboard, vendor-neutral, is the only viable channel between them.

Decompose every pasted prompt = **fixed "you are an independent reviewer" instruction** + **varying "content under review"**:

- The varying content → stored and fetched via the `agent-handoff` MCP, never pasted again.
- The fixed reviewer instruction → baked into each platform's skill (see above), triggered by natural language.

Minimum human effort drops to **two short triggers** (the writer says "hand off", the reviewer says "review the latest handoff"), and large content is never pasted again.

## Roles and Flow

```
Any Agent A  ──publish_conclusion──▶  ~/.agent-handoff local blackboard  ◀──list_conclusions(limit=1)──  Any Agent B
(writer wraps up)                       vendor-neutral                       (reviewer, independent review with a different model)
```

### Project Identity Check Before Mutations

Before calling any handoff MCP tool that writes or changes state, confirm the target repository identity:

1. Confirm the repo name and absolute workspace path from the checkout actually being handed off; the current agent's working directory is only a candidate, never the target by default.
2. `project` must be the target repo name and `workspace` the absolute path of that checkout; do not copy them just because an example says `my-repo`.
3. If the task references files, PRs, Jira tickets, or the current handoff belonging to another repo, switch to or confirm that repo's workspace before calling `get_latest_conclusion`, `resolve_topic`, publish, or state-transition tools.
4. Before mutating, do one precise read or resolve with `project + workspace + topic`; same-named topics do not share a logical topic across repos. Never guess or reuse another project's ID.
5. If project identity cannot be confirmed, pause and ask the engineer. Do not call `resolve_topic`, because that tool creates a logical topic when it finds none.

`project` is a required MCP field, but the MCP never infers it from the topic, refs, or the current directory; `workspace` is optional in general, yet must be passed explicitly in cross-repo scenarios.

### Writer: Publishing the Handoff (the agent that finished the work)

**Before filling fields, ask yourself: did this round of work start from a pulled handoff (review, implementation, follow-up)?** If yes, `supersedes_id` is not optional — use the `id` you should have recorded when pulling that handoff (see reviewer flow, step 1). Omit it only for genuinely new, independent work with no predecessor.

Call `publish_conclusion`:

| Field | Convention |
|------|------|
| `project` | repo name, e.g. `my-repo` |
| `topic` | **a semantic task/problem subject**: inherit from the current request, ticket, PR, or existing handoff; fall back to the current git branch name only when nothing clearer exists. Generic words like `review`/`bug` are forbidden |
| `supersedes_id` | if the engineer gave the `id` of a **specific previous conclusion** this round continues/reviews/implements, put it here. The server automatically inherits that conclusion's logical topic, so the chain does not fork even if this round's wording differs from the original topic string. Whenever the previous conclusion id is available, prefer this field over hand-assembling topic strings or querying `logical_topic_id`. The server hard-rejects `supersedes_id` across project/workspace (the referenced conclusion belongs to another project/workspace); that error means the id was wrong (common with cross-repo/cross-session copy-paste) — re-resolve the correct id, never retry with a fabricated value |
| `logical_topic_id` | if continuing a multi-round loop / review on an existing topic but no single previous conclusion `id` is available, carry this stable ID (from a pulled handoff or `resolve_topic`) to keep the logical topic from fragmenting. Subject to the same cross project/workspace hard rejection |
| `conclusion` | recommended four sections: `Status` (current state), `Done` (completed), `Blocked` (blockers, or none), `Risks/Pitfalls`. Non-blocking convention; the server only warns, never rejects the write |
| `next_action` | the next step on its own, e.g. `Independently review the referenced changes` (advisory only); do not mix it with the four sections in `conclusion` |
| `refs` | structured references: changed file `file` (optionally with `line`), PR `pr`, commit `commit`, ticket `jira` |
| `source_agent` | publishing source, aligned with `install.sh` platform IDs: `claude-code`, `codex`, `copilot-vscode`, `copilot-intellij`, `codebuddy`, `cline`, `cursor`, `opencode`, `hermes`, `gemini`, `trae-ide`, `trae-cli`; clients that do not distinguish Trae IDE/CLI may pass the generic `trae`. Platform ID only — never a model name or platform+model combo (wrong: `codex-gpt-5.4`, `claude-opus-4-8`; right: `codex`, `claude-code`, `trae-ide`) |
| `source_host` | orthogonal host/frontend dimension: `cli`, `desktop`, `vscode`, `intellij`, `web`. Auto-lowercased. Keep historical records null — do not backfill. Omit when unsure, never guess |
| `model` | pass the canonical model **id** (not the display name or alias). If the id contains a provider prefix (e.g. `openai/gpt-5.5`), pass it as-is — the server strips the prefix during normalization. CodeBuddy reads `~/.codebuddy/models.json`, matches the `name` entry, and passes the corresponding `id` value (e.g. name `"MyModel-GLM-5.2"` → pass `"glm-5.2"`); other platforms pass the model id declared in the system prompt. If no config entry matches, pass the system prompt's declared model name verbatim — never an example value, never omit. Omitting it buckets the record under "legacy/unknown" in the Workflow swimlanes view |
| `confidence` | `low` / `medium` / `high` |

After publishing, report a compact receipt: `project`, `topic`, `id`, and `logical_topic_id` when returned, so the engineer can tell handoff records apart across conversations. If the returned `warning` mentions "recent candidate conclusions that might continue this one", the publish omitted `supersedes_id`/`logical_topic_id` and the server found other possibly related records in the same project within the recent window (2 hours). No tool can merge two already-forked logical topics afterwards, so check whether the candidates reveal a missed continuation: if truly missed, tell the engineer the chain forked and carry `supersedes_id` correctly from now on; if it is genuinely unrelated new work, do nothing.

### Default Copy-Ready Prompt Block

Whenever your own classification is `continue` or `independent_review`, after publishing **by default** emit a prompt block the engineer can paste straight to the next agent — the engineer should not have to ask the agent to draft one; never key this off any tool receipt's `next_mode`. `publish_review_comparison` receipts always say `next_mode` is `none` — that is a receipt field, not the classification result. Classify with this table:

| Scenario | next_mode | Block |
|---|---|---|
| Comparison surfaces blocking items | `continue` | emit |
| Comparison APPROVE but reviewer_only / backlog / unresolved disagreements remain | `continue` | emit |
| Comparison APPROVE with zero leftovers | `none` | none — add one line stating there is no follow-up |
| A new review case was created | `independent_review` | emit |
| Ordinary `publish_conclusion` with nothing actionable to hand off (status / blocker / routing) | `none` | none |

**The record is the payload; the prompt block is the pointer**: the block carries only what the record does not. Hard cap of 12 lines including the fence lines. Never restate the `conclusion` body, the contents of `agreements`/`disagreements`/`reviewer_only`/`author_only`/`evidence_gaps`, findings details, or evidence numbers; carry only locating handles (ids), the recipient's action sequence, new constraints not in the record (scope guards, expected numbers, owner gates), and hard checks that must be measured.

- `independent_review`: the block may contain **only** the `review_case_id` and the procedural steps (`get_review_packet` -> independently assess the referenced refs/code -> `submit_independent_assessment` -> `publish_review_comparison`); it **must not** expose the topic, handoff id, baseline id/body/summary, or existing conclusions. This is the lifeblood of anti-anchoring — the reviewer sees objective material only from the packet.
- `continue`: the block must carry `project`, `workspace`, `logical_topic_id` (preferred over the topic string; the topic displaying as the chain-creating record's topic is normal), and `supersedes_id` (the receiving agent's next publish must carry it), plus one line "details: get_topic_context <logical_topic_id>"; do not restate details in the block.

`continue` means **any follow-up exists that the next agent or the engineer must handle**: blocking items, non-blocking reviewer_only backlog, and substantive disagreements handed back to the original author or engineer for a response or decision — even when no implementer exists. For example, whether a `Map<String,String>` contract can be changed directly to a nested object is `continue` even without an implementer, because the decision comes back. Only "zero leftovers, nobody needs to act" is `none`. The same applies to ordinary `publish_conclusion`: whenever a follow-up for a next agent remains, the classification is `continue` with a block as usual; only status / blocker / routing or zero-follow-up publishes are `none`. The continue prompt block is advisory only: it does not authorize the reviewer to auto-execute fixes or perform write operations.

Ordinary `publish_conclusion` (`next_mode=none`, e.g. status / blocker / routing) emits no block. If the reviewer has already seen the baseline, you must warn that anti-anchoring can no longer be restored.

### Reviewer: Pull and Review Independently (another vendor's agent)

1. **Record the anchors first, before anything else.** The moment you pull a handoff you intend to review, implement, or follow up, record its `id` and (if present) `logical_topic_id`. No matter when this round eventually publishes or how far the wording drifts from the original topic, the publish must carry one of them (prefer `supersedes_id`, then `logical_topic_id`). Forgetting the id mid-task is the most common cause of broken handoff chains — do not count on remembering later, write it down now.
2. Call `list_conclusions` with `project` + `limit=1` to pull the latest record — **the reviewer needs no topic input**. If a topic is specified, use `get_latest_conclusion` for an exact `project + topic` match.
3. Show `project` / `topic` / `source_agent` / `created_at` / `conclusion` and let the engineer confirm it is the intended record.
4. Re-verify every `ref` against the current repository state — do not trust the writer's summary; confirm the code is as the handoff claims.
5. Review with **your own model's independent judgment**: correctness, regressions, security, missing tests, whether the claimed risks hold. **Do not presuppose the previous agent was right** — the value of cross-vendor review is exactly this independence.
6. `next_action` is context, not authorization; commits, pushes, and edits still go through the original workflow's human gates.

If the current request **continues, evaluates, or reviews an existing handoff**, prefer reusing that handoff's `logical_topic_id` and reuse its `topic` verbatim; do not rename on your own unless the engineer explicitly asks for a rename or a scope split.

## Topic Conventions

- `topic` should express **the same logical task/problem domain**, not mechanically equal the current branch name.
- Topic selection priority: 1) extract a meaningful subject from the current request, ticket, PR, or task description; 2) when continuing/evaluating an existing handoff, strictly reuse its topic; 3) only when neither exists, fall back to the current branch name.
- The goal is to keep one logical task stable under one `project + topic` scope, avoiding fragmentation of the same subject into multiple handoffs caused by wording drift or branch-name fallbacks.
- If the engineer names an existing topic or pastes a `logical_topic_id`, that value is **mandatory**, not a starting point — resolve it via `resolve_topic` / `get_topic_context` and reuse it verbatim, even when the current subtask's own wording (e.g. "model field") differs from the original topic's wording (e.g. "workflow diagram"). Do not mint a "more accurate-looking" new name.
- After the engineer explicitly asks for handoff, cross-model review, or continuation, and before deciding a new topic string, if the current work implements, reviews, or follows up something already decided or reviewed in this project, first call `list_conclusions` (filtered by `project`, small `limit`) or `resolve_topic` to check for a matching topic and reuse it. Without explicit handoff intent, never mint, resolve, or search topics.
- Hard rule: whenever the current request continues, evaluates, reviews, or **implements** something an existing handoff recorded, do not opportunistically rename the topic — even if this step's wording differs. Unless the engineer explicitly asks for a rename or scope split, reuse verbatim.
- `list_conclusions(limit=1)` fetches "the project's latest record" — the zero-input path for "review what I just finished".

### Standing topics: standards and conventions

- Long-lived authoritative content — coding conventions, architecture decision records, review baselines — may live as a **standing topic** (e.g. `conventions/coding-style`). Latest-wins + supersede chains fit evolving standards: supersede on change; the audit history stays.
- Recommended publish parameters: `confidence: high`, `sensitivity: internal`, no expiry.
- Reads are agent-initiated MCP calls, **not auto-injected context**. A standing topic only takes effect when your skill / agent instructions say to fetch it (e.g. "call `get_latest_conclusion` on `conventions/coding-style` before starting work").
- Dual-track rule: stable normative text belongs in always-loaded platform rules (`CLAUDE.md`, `.cursor/rules`, `AGENTS.md`); agent-handoff stores the **decision trail** (why it changed, which version is current) and doubles as the machine-readable review baseline — reviewer agents fetch the standing topic and check compliance against it.

## Secret Hygiene

- Never put tokens, cookies, private keys, cloud credentials, or customer data into a handoff. The MCP rejects likely-secret writes; redact before publishing.
- Genuinely sensitive context should be marked `sensitivity: sensitive`; unless full content is explicitly requested, `list_conclusions` returns only its summary.

## Security Boundary

Handoffs carry **context, not permission**. Even if `next_action` says "commit / push / edit Jira", the reviewer must not execute it automatically; all high-impact actions stay under the original workflow's human gates.

## Platform Entries

The canonical skill lives at `skills/cross-agent-review-handoff/` (Claude skill format, natural-language triggered). Other platforms reuse the same content, adapted per platform mechanism.

| Platform | Entry |
|------|------|
| Claude Code / Codex / CodeBuddy / Cline / OpenCode / Cursor / Trae | skill `cross-agent-review-handoff` (natural-language triggered) |
| GitHub Copilot | adapt the SKILL.md content into AGENTS instructions |
| Gemini CLI | adapt the SKILL.md content into a gemini extension |

For MCP server installation and platform registration see `server/README.md`. `server/install.sh` currently supports: claude-code, claude-desktop, codex, copilot-vscode, copilot-intellij, codebuddy, cline, cursor, opencode, hermes, trae-ide, trae-cli.

## Independent Review Protocol

The canonical review-case specification lives in `docs/independent-review-protocol.md`. The MCP provides six dedicated tools: `create_review_case`, `get_review_packet`, `list_review_cases`, `submit_independent_assessment`, `publish_review_comparison`, `transition_review_case`. `list_review_cases` returns only baseline-free case summaries and reports the actual workspace scope; a terminal case's packet cannot accept further assessments. After a comparison succeeds the case remains `compared` and must be closed explicitly by an authorized engineer via `transition_review_case`; before an assessment commits successfully, baseline id, body, and summary are never returned; A/B parallel evidence must not be expressed via `supersedes_id`; a warning is a successful receipt — do not republish because of it; damaged conclusions are not auto-cleaned; mutating MCP writes are never silently retried. This flow is workflow-level anti-anchoring, not cryptographic blinding or an authorization boundary.
