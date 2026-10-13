---
name: cross-agent-review-handoff
metadata:
  tier: standard
  side_effects: write-local
  mcp_servers: [agent-handoff]
description: Publish or pull a cross-agent review handoff through the agent-handoff MCP so a different-vendor agent can independently review another agent's output without copy-paste. Use when the engineer wants to hand current work to another agent for review, says "publish a review handoff" / "use cross-agent handoff" / "review the latest handoff" / "跨模型 review" / "接上次结论审一遍" / "使用 cross agent handoff", or wants Codex, Cursor, Copilot, Gemini, or Cline to re-check what another agent just produced.
---

# Cross-Agent Review Handoff

Use this skill to move review context between agents from different vendors through the local `agent-handoff` MCP server, instead of copy-pasting a prompt. One agent publishes a structured conclusion; a different agent pulls it and reviews independently.

A handoff is context only. `next_action` is a suggestion, never authorization to commit, push, edit Jira, or call remote APIs — the normal workflow gates still apply.

## Opt-In Boundary

Handoff is opt-in, not a default close-out step. Do not call `agent-handoff`, `resolve_topic`, or create a topic during ordinary implementation, validation, review, routing, blocker, status, or completion conversations. Use this skill only when the engineer explicitly asks to publish/hand off work, requests cross-agent or independent review, asks to continue/resume from a handoff, or provides a topic/logical topic ID and asks to use it. Without that explicit intent, report the next step normally and do not publish, create a review case, or emit an `AGENT-HANDOFF v1` fallback.

## Project and Workspace Preflight

Before any handoff mutation, identify the checkout that owns the task from its files, PR, Jira ticket, or existing handoff. Confirm both the target repo name and its absolute checkout path. The current agent workspace is only a candidate, and examples such as `my-repo` must never be copied as values. Pass the confirmed `project` and `workspace` to every read or mutation; for cross-repo work, stop and confirm the target checkout first. Resolve or read the exact `project + workspace + topic` before publishing, creating, or changing state. If the project identity is uncertain, ask the engineer rather than calling `resolve_topic`, because resolution creates a logical topic when none exists.

## Independent Review Protocol

Follow `references/independent-review-protocol.md` as the packaged canonical specification. Use the six dedicated review-case tools: `create_review_case`, `get_review_packet`, `list_review_cases`, `submit_independent_assessment`, `publish_review_comparison`, and `transition_review_case`. Before assessment submission, never expose baseline id, body, or summary. Store A/B evidence in review tables; never use `supersedes_id` for parallel assessments. A warning is a successful write response, so do not republish because of it. Reject and surface damaged tool-call residue; never auto-clean it. Mutating writes require explicit request ids and must not be silently retried.

## Two Modes

### Publish (the agent that just finished the work)

Trigger only when the engineer explicitly says "hand this off", "publish a review handoff", "交接给别的 agent 审", asks to continue/resume from a handoff, or requests cross-agent/independent review. Reaching a reviewable result by itself does not trigger this skill.

When the user explicitly requests a subsequent independent review of a review-ready implementation, call `publish_review_ready_implementation`. It first publishes the final implementation handoff, then creates the hidden-baseline review case, and returns `implementation_handoff_id` plus `review_case_id`. Ordinary context, routing, blocker, and status handoffs use `publish_conclusion` only. If case creation fails, do not republish; retry with the original `create_request_id`, and give any reviewer only the `review_case_id`.

**Before filling in fields, ask: did this round begin from a handoff you pulled (review, implementation, or follow-up on prior work)?** If yes, `supersedes_id` is required, not optional — use the `id` you recorded the moment you pulled it (see Review step 1). Only skip it when this is genuinely new, standalone work with no prior conclusion to continue.

Call `publish_conclusion`:

- `project` — repo name, e.g. `my-repo`.
- `topic` — a meaningful, stable task/problem topic inferred from the engineer request or the handoff being continued. Reuse the prior handoff topic when reviewing/extending an existing handoff. Use the current git branch name only as a fallback when no clearer semantic topic is available. Never use vague words like `review` or `bug`.
- `supersedes_id` — when the engineer points you at (or you pulled) a specific prior conclusion `id` that this round continues, reviews, or implements, pass its `id` here. The server inherits that conclusion's logical topic automatically, so the thread stays on the same topic even if this round's wording differs from the original topic string. This is the most reliable continuation signal — prefer it whenever a prior conclusion `id` is known. The server hard-rejects a `supersedes_id` that belongs to a different `project`/`workspace` than this request; if you hit that error you almost certainly have the wrong id (e.g. copied from a different repo's session) — resolve the correct one, don't retry with a fabricated value.
- `logical_topic_id` — when continuing an existing logical topic but no single prior conclusion `id` applies (e.g. you only have the topic ID from `resolve_topic`), carry that stable ID instead. This is preferred over relying on topic-string reuse alone. When adding a parallel entry to a shared topic (not superseding any prior conclusion), pass `logical_topic_id` without `supersedes_id` — this joins the same logical topic without marking any prior entry as superseded. Same cross-project/workspace hard rejection applies here.
- `conclusion` — use the recommended four headings: `Status`, `Done`, `Blocked`, and `Risks/Pitfalls` (write "none" when applicable). Keep it concise; point to long content via `refs`. The MCP server may warn when headings are missing, but never blocks publishing.
- `next_action` — write the next step separately, e.g. "Independently review the referenced changes" (suggestion only).
- `refs` — structured: changed files (`type: file`, with `line` when useful), PR (`type: pr`), commits (`type: commit`), tickets (`type: jira`).
- `source_agent` — `claude-code` (this agent's platform ID, matching `install.sh`). Platform ID only — never a model name, never platform+model combined (bad: codex-gpt-5.4, claude-opus-4-8; good: codex, claude-code).
- `source_host` — derive from the `CLAUDE_CODE_ENTRYPOINT` env var: `claude-desktop` or `claude-desktop-3p` → `desktop`; `cli` or empty → `cli`; `claude-vscode` → `vscode`; any other value → omit. Lowercased automatically. Historical rows stay null — do not backfill.
- `model` — pass the exact model ID declared in your system prompt (e.g. `claude-fable-5`), not the marketing name. If the id contains a provider prefix (e.g. `openai/gpt-5.5`), pass it as-is — the server strips the prefix automatically during normalization. If no config entry matches, pass the system prompt's declared model name verbatim — never an example value, never omit. Always set this field — omitting it buckets the conclusion under "legacy/unknown" in the Workflow swimlanes view.
- `confidence` — `low` | `medium` | `high`.

Then report a compact publish receipt with `project`, `topic`, `id`, and `logical_topic_id` when returned. For a structured completion receipt, report the same `id` as `handoff_id`, add `review_case_id` when a case exists, and set `next_mode` to `none`, `continue`, or `independent_review`. Keep the topic visible next to the id so multiple conversations, especially in Claude Desktop, can be distinguished without opening the record. If the response's `warning` mentions recent conclusions as possible continuation candidates, you published without `supersedes_id`/`logical_topic_id` and the server found other recently-active work in the same project it might belong to. There is no tool to retroactively merge two already-diverged logical topics, so check whether one of the listed ids is actually this round's predecessor: if this really was a missed continuation, tell the engineer so they know the thread forked, and carry `supersedes_id` correctly from here on. If this genuinely is unrelated new work, no action is needed.

### Intent Routing And Completion Receipt

Classify intent before choosing a mutation:

- Explicit independent/cross-agent review intent creates a case without another confirmation.
- Clear continuation, implementation, investigation, status, or ordinary handoff intent neither creates a case nor asks about one.
- Ask once only when the review-ready boundary is genuinely ambiguous. Never infer review intent from a topic name or `next_action` alone.

If the implementation is not published, use `publish_review_ready_implementation`; if it is already published, create the case against the existing handoff using its `baseline_conclusion_id` without republishing. The baseline must be in the requested project/workspace and its canonical topic must equal the review topic. Every structured completion receipt reports `topic`, `handoff_id` (the publish `id`), `review_case_id` when present, and `next_mode` (`none`, `continue`, or `independent_review`). On the reviewer side after `publish_review_comparison`, `handoff_id` is the comparison conclusion id and `review_case_id` is the case just compared. Comparison does not close the case: it remains `compared` until an authorized engineer explicitly calls `transition_review_case` with `target_status: closed` or another authorized terminal status. Classify `next_mode` and emit the copy-ready next-agent prompt block strictly under `### Next-Step Prompt Block` below — never copy the tool receipt's `next_mode` as your classification. Warn when a reviewer was already exposed to the baseline because anti-anchoring cannot be restored. If a `continue` prompt coexists with an open case for the same topic, first call `list_review_cases` for the exact project/workspace/topic, explicitly tell the engineer the case is still open, then continue; the implementation agent is not the reviewer and must not submit an assessment for that case. Use `transition_review_case` with an explicit reason when an authorized caller needs to close, cancel, or archive it, or explicitly reopen a terminal case that has no assessment or comparison; completed cases remain historical and require a new case, `changed_by` records attribution but does not grant authorization, and `next_action` never grants authorization.

### Next-Step Prompt Block

`publish_review_comparison` always returns `next_mode: "none"` — that is a tool receipt field, not your classification result. Classify the next step yourself with this table:

| Scenario | next_mode | Emit block |
|---|---|---|
| Comparison surfaces blocking items | `continue` | Yes |
| Comparison APPROVE, but reviewer_only / backlog / unresolved disagreements remain | `continue` | Yes |
| Comparison APPROVE with zero leftover items | `none` | No — add one line stating there is no follow-up |
| New review case created | `independent_review` | Yes |
| Ordinary `publish_conclusion` with nothing actionable for a next agent (status / blocker / routing) | `none` | No |

`continue` means any follow-up exists that needs action from the next agent or the engineer — including non-blocking `reviewer_only` backlog, and substantive disagreements that must go back to the original author or engineer for a response or decision (even when no implementer exists, e.g. whether a `Map<String,String>` contract may change to a nested object). Only "zero leftovers, nobody needs to do anything" is `none`. The same applies to an ordinary `publish_conclusion`: when it leaves actionable follow-ups for a next agent, classify it `continue` and emit the block; only status, blocker, routing, or zero-follow-up publishes are `none`. The continue prompt is advisory and never authorizes auto-executing fixes or write operations.

**The record is the payload; the prompt is the pointer. The block contains only what is not already in the record.** Hard limits:

- Hard cap of 12 lines total, including the fence lines.
- Never restate: the `conclusion` body, the contents of `agreements` / `disagreements` / `reviewer_only` / `author_only` / `evidence_gaps`, findings details, or evidence numbers.
- Allowed content only: locating handles (ids), the action sequence for the recipient, new constraints not in the record (scope guards, expected numbers, owner gates), and which hard checks must actually be measured.
- For `independent_review`, the block carries only `review_case_id` plus the procedural steps (`get_review_packet` -> independently assess the referenced refs/code -> `submit_independent_assessment` -> `publish_review_comparison`) and must not expose topic, handoff id, baseline id/body/summary, or repeated findings.
- For `continue`, the block must carry `project`, `workspace`, `logical_topic_id` (preferred over the topic string; the topic may display as the creating record's topic — that is normal), and `supersedes_id` (the comparison conclusion id; the recipient must carry it when publishing back), plus one line: details live in `get_topic_context` (pass the `logical_topic_id` value as the tool's `topic_id` parameter) — do not restate them in the block.

Positive example (10 lines):

```text
[agent-handoff] project=my-repo
workspace=/abs/path/to/my-repo
logical_topic_id=<uuid>
supersedes_id=<comparison-conclusion-id>
Actions: get_topic_context <uuid> -> address reviewer_only backlog in the latest comparison
Scope guard: docs/ and skills/ only; no backend code
New constraint not in record: prompt block stays <=12 lines
Hard check: scripts/check-skill-sync.sh must pass
```

Negative example — wrong because it restates findings already stored in the record:

```text
[agent-handoff] project=my-repo
F1: <five lines copied verbatim from reviewer_only> ...
F2: <five lines copied verbatim from reviewer_only> ...
(keeps going for ~90 lines)
```

### Review (a different-vendor agent picking it up)

Trigger when the engineer says "review the latest handoff", "接上次结论审一遍", "拉最新 handoff 来 review", or opens a fresh session whose job is to review prior work.

For an independent review case, use the dedicated sequence: `create_review_case` -> `get_review_packet` -> independently inspect current refs/code -> `submit_independent_assessment` -> `publish_review_comparison`. Do not use `publish_conclusion` as a substitute for the assessment or comparison tools, and never use `supersedes_id` to represent parallel A/B evidence. The final comparison may be an ordinary conclusion produced by the comparison tool.

1. **Record the anchor immediately — before anything else.** The instant you fetch the handoff you're going to review, implement, or follow up on, write down its `id` and (if present) `logical_topic_id`. Whatever `publish_conclusion` call you eventually make for this round of work MUST carry one of them (`supersedes_id` preferred, `logical_topic_id` as fallback) — this holds regardless of how differently this round's own wording describes the work. Losing track of this id partway through a long task is the single most common cause of a broken handoff chain: do not rely on remembering it later, capture it now.
2. Call `list_conclusions` with `project` and `limit=1` to get the most recent handoff — this avoids needing the engineer to type a `topic`. If a topic is named, use `get_latest_conclusion` with that exact `project + topic`.
3. Show `project`, `topic`, `source_agent`, `created_at`, and `conclusion` so the engineer can confirm it is the intended one.
4. Re-read every `ref` against the CURRENT repo state. Do not trust the publishing agent's summary — confirm the code actually says what the handoff claims.
5. Review with your own model's independent judgment: correctness, regressions, security, missing tests, and whether the stated risks hold. Do not assume the previous agent was right; that independence is the whole point of a cross-vendor review.
6. Treat `next_action` as context only. Follow the normal gates before editing code, committing, or pushing.

If the current request is continuing, evaluating, or reviewing an existing handoff, reuse that handoff's `logical_topic_id` when present, and reuse its `topic` exactly unless the engineer explicitly asks to rename or split the scope.

## Topic Convention

- `topic` should represent the logical task/problem being handed off, not mechanically mirror the current branch name.
- Topic selection priority: 1) infer a meaningful topic from the current engineer request, ticket, PR, or task wording; 2) if continuing or reviewing an existing handoff, reuse that handoff's topic exactly; 3) only if neither exists, fall back to the current git branch name.
- Choose a topic that keeps one logical task in one `project + topic` scope across follow-up handoffs and reviews. Avoid introducing a fresh topic string for the same work unless the problem scope truly changed.
- If the engineer names an existing topic or pastes a `logical_topic_id` directly, that value is binding, not a starting point — resolve it (`resolve_topic` / `get_topic_context`) and reuse it exactly, even if the current sub-task's own wording (e.g. "model field") differs from the original topic's wording (e.g. "workflow diagram"). Do not mint a more "accurate"-sounding variant.
- When explicit handoff intent exists, before minting a new topic string, if the work implements, reviews, or follows up on something already recorded in this project, call `list_conclusions` or `resolve_topic` first to check for a matching existing topic and reuse it if found. Without explicit handoff intent, do not select a topic or call either tool.
- Hard rule: when the request is about continuing, evaluating, reviewing, or implementing something already recorded in an existing handoff, do not rename the topic opportunistically — even when only the current step's terminology differs. Reuse it exactly unless the engineer explicitly asks to rename or split the scope.
- `list_conclusions(limit=1)` still returns the latest regardless of topic, which is the zero-typing path for "review what I just finished".

## When a Call Fails

A tool error from `publish_conclusion` (or any handoff tool) does NOT mean the server is unavailable — a connected MCP server can still return an error result. Do not silently fall back to a copy-paste text format, and do not report "MCP service unavailable".

1. Surface the verbatim error to the engineer — it is diagnostic:
   - `No such built-in module: node:sqlite` — the client launched the server with an old Node (<22.5) that lacks `node:sqlite`. The server `command` must be an absolute path to Node ≥ 22.5; re-run `server/install.sh` to repin it.
   - `Refusing to write handoff because it appears to contain a …` — redact the flagged secret, then retry.
   - a length error on `conclusion` — keep `conclusion` short and move the long content into `refs` (write it to a file and reference it), then retry.
   - `supersedes_id … belongs to project "…" and cannot be superseded from project "…"` (or the equivalent `logical_topic_id` message) — the id you passed belongs to a different project/workspace than this request. Do not retry with a guessed or fabricated id; re-resolve the correct one (`resolve_topic` / `get_topic_context` / ask the engineer) or, if there truly is nothing to continue, omit `supersedes_id`/`logical_topic_id` and let the server resolve a fresh topic.
2. Treat the server as genuinely unavailable only when the handoff tools are absent from the tool list (it failed to start or connect). Only then explain the AGENT-HANDOFF text fallback.

## Secret Hygiene

- Never put tokens, cookies, private keys, cloud keys, or customer data in a handoff. The MCP refuses writes that look like secrets; redact before publishing.
- Mark genuinely sensitive context `sensitivity: sensitive`; its body is summarized in `list_conclusions` unless full detail is explicitly requested.

## Reference

See `docs/cross-agent-review-handoff.md` for the full convention, templates, and rationale.
