# Independent Review Protocol

This is the canonical protocol for workflow-level independent review. It is an anti-anchoring workflow, not a cryptographic blind-review or authorization boundary.

## Tools

- `create_review_case`: stores the project/workspace/topic, baseline reference, and original task material: `objective`, `scope`, `acceptance_criteria`, `snapshot_ref`, `refs`, and `constraints`. Its response never returns the baseline id, body, or summary.
- `get_review_packet`: returns the original task material and case scope. It must not reveal baseline data.
- `submit_independent_assessment`: durably stores the assessment, then atomically reveals the baseline in the successful response. `request_id` is required and idempotent.
- `publish_review_comparison`: after assessment, atomically publishes the final comparison as an ordinary handoff conclusion. Use its optional `logical_topic_id` or `supersedes_id` when the review round continues an existing logical thread under a differently-worded topic; `logical_topic_id` takes precedence. `request_id` is required and idempotent.
- `list_review_cases`: lists cases by project/workspace/topic/status without revealing baseline ids or contents, so a receiving agent can detect an open case before continuing a topic.
- `transition_review_case`: closes, cancels, or archives a case with an explicit reason and idempotent `request_id`.

Comparison records must contain `agreements`, `author_only`, `reviewer_only`, `disagreements`, `evidence_gaps`, and `final_recommendation`, and link the review case, assessment, and final ordinary conclusion. The author-written `comparison` body is also published as an ordinary conclusion and must use the `Status`, `Done`, `Blocked`, and `Risks/Pitfalls` headings.

`create_review_case` requires `baseline_conclusion_id` to resolve to a conclusion in the requested project/workspace scope. The baseline's canonical topic must equal the review case topic after topic resolution; do not create a case against a conclusion from another scope or topic.

## Invariants

- A/B evidence is stored in review tables. Do not use `supersedes_id` to represent parallel assessments.
- A retry with the same `request_id` and payload returns the original result. Reusing the id with a different payload is an error.
- Receipt replay is serialized by the mutation's write transaction; under contention, a retry waits for the writer and may surface the configured SQLite busy timeout instead of bypassing the lock.
- A warning is a successful write response. Do not republish because a warning was returned.
- A trailing paired tool-call serialization fragment is rejected; normal discussion mentioning literal tags is allowed. The server never cleans damaged conclusion text automatically.
- Mutating MCP calls are not silently retried. Surface the error and require an explicit decision before another write.
- Baseline withholding is workflow-level sequencing, not a security guarantee.

## Sequence

1. A coordinator selects a baseline and creates a case.
2. The independent reviewer reads the packet and checks current refs/code without baseline context.
3. The reviewer submits one assessment; only the successful commit response reveals baseline data.
4. A comparison is published once and becomes the ordinary conclusion consumed by existing handoff readers.

## Review-Ready Handoff

When the user explicitly requests a subsequent independent review of a review-ready implementation, use `publish_review_ready_implementation`. It first publishes the final implementation handoff, then creates the review case with that handoff as the hidden baseline and returns both `implementation_handoff_id` and `review_case_id`.

Ordinary context, routing, blocker, and status handoffs use `publish_conclusion` only and do not create review cases. If case creation fails after the implementation handoff succeeds, do not republish the implementation; retry case creation with the original `create_request_id` and report partial success with the existing handoff id. Give the reviewer only `review_case_id`, never the implementation handoff id or baseline contents.

## Intent Routing And Completion Receipt

The handoff skill must classify the engineer's intent before selecting a mutation:

- Handoff is opt-in. Ordinary implementation, validation, review, routing, blocker, status, and completion conversations do not read or write handoff topics unless the engineer explicitly asks for handoff/review/continuation or provides a topic/logical topic ID to use.
- Explicit independent/cross-agent review intent, such as "完成后交给另一个 Agent 独立 review", creates a review case without asking for confirmation.
- Clear continuation, implementation, investigation, status, or ordinary handoff intent neither creates a review case nor asks about one.
- A genuinely ambiguous review-ready boundary asks once. Do not infer review intent from a topic name or from `next_action` alone.

Use `publish_review_ready_implementation` when the review-ready implementation has not been published. When it has already been published, call `create_review_case` against the existing handoff instead of publishing a duplicate baseline.

For a review-ready completion on either side, the structured receipt uses these fields:

- `topic`
- `handoff_id`
- `review_case_id` (when a case was created)
- `next_mode`: `none`, `continue`, or `independent_review`

For an ordinary publish, retain the compact receipt fields `project`, `topic`, `id`, and `logical_topic_id` when returned. In a structured completion receipt, `handoff_id` is the same value as that publish `id`; `review_case_id` is included only when a case exists.

The reviewer-side values after `publish_review_comparison` are explicit: `handoff_id` is the comparison conclusion id returned by that mutation, `review_case_id` is the case just compared, and the receipt's `next_mode` is always `none` because the mutation only publishes the comparison and does not classify the next step. The reviewer must not copy that receipt `next_mode` as its own handoff decision; it independently determines the handoff `next_mode` from the comparison outcome. Comparison does not close the review-case lifecycle: the case remains `compared` until an authorized engineer explicitly calls `transition_review_case` with `target_status: closed` (or another authorized terminal status). Set the handoff `next_mode` to `continue` whenever any follow-up exists that needs action from the next agent or the engineer: blocking items to fix, non-blocking `reviewer_only` backlog, or, for a design/discussion case, a substantive disagreement handed back to the original author or engineer for a response or decision. For example, a disagreement over changing a `Map<String,String>` contract to a nested object needs that follow-up even when no implementer exists. Only a comparison with zero leftover items — nobody needs to do anything — is `none`. Use `independent_review` only when a new case was created for a new handoff; otherwise use `none`.

Emit a copy-ready next-agent prompt block whenever your own classification is `continue` or `independent_review`, so the engineer can paste it straight to the receiving agent without drafting it — never key this off a tool receipt field. `publish_review_comparison` always returns `next_mode: "none"` — that is a tool receipt field, not the classification result. Classify with this table:

| Scenario | next_mode | Emit block |
|---|---|---|
| Comparison surfaces blocking items | `continue` | Yes |
| Comparison APPROVE, but reviewer_only / backlog / unresolved disagreements remain | `continue` | Yes |
| Comparison APPROVE with zero leftover items | `none` | No — add one line stating there is no follow-up |
| New review case created | `independent_review` | Yes |
| Ordinary `publish_conclusion` with nothing actionable for a next agent (status / blocker / routing) | `none` | No |

The record is the payload; the prompt is the pointer — the block contains only what is not already in the record. Hard cap of 12 lines including the fence lines. Never restate the `conclusion` body, the contents of `agreements` / `disagreements` / `reviewer_only` / `author_only` / `evidence_gaps`, findings details, or evidence numbers; carry only locating handles (ids), the recipient's action sequence, new constraints not in the record (scope guards, expected numbers, owner gates), and which hard checks must be measured. For `continue`, the block must carry `project`, `workspace`, `logical_topic_id` (preferred over the topic string; the topic may display as the creating record's topic — that is normal), and `supersedes_id` (the comparison conclusion `id` returned by `publish_review_comparison`; the receiving agent must carry it when publishing back), plus one line: details live in `get_topic_context` (pass the `logical_topic_id` value as the tool's `topic_id` parameter). For `independent_review`, the block carries only the `review_case_id` plus the procedural steps (`get_review_packet` -> independently assess the referenced refs/code -> `submit_independent_assessment` -> `publish_review_comparison`); it must not expose the topic, handoff id, baseline id, body, or summary. Ordinary `publish_conclusion` with `next_mode=none` emits no block. A reviewer that has already received baseline data must be warned that formal anti-anchoring cannot be restored. The `continue` prompt is advisory only: it tells the receiving implementation agent to fetch the latest conclusion and address the listed follow-ups. Emitting it does not authorize the reviewer to auto-execute the fixes, perform write operations, or bypass the implementer.

When a `continue` prompt and an open review case coexist for the same topic, the receiving agent must call `list_review_cases` for the exact project/workspace/topic, explicitly tell the engineer that the case is still open, and then proceed with the continuation intent. The implementation agent is not the reviewer and must not submit an assessment for that case; only the designated independent reviewer may do so. A case can be removed from this ambiguity by an authorized caller using `transition_review_case` with an explicit reason; do not treat a conclusion supersede or logical-topic transition as closing the case.

Review-case source and authorization matrix:

- A receiving/implementation agent may call `list_review_cases` because it is read-only; when `workspace` is omitted, canonical projects use their canonical workspace and non-canonical projects search across workspaces.
- Only an engineer/coordinator authorized for the case may call `transition_review_case`; `changed_by` records attribution but does not authenticate or grant authorization. The allowed lifecycle paths are active (`open`, `assessed`, or `compared`) to `closed`, `cancelled`, or `archived`, and `closed`/`cancelled` may transition to `archived`. An explicitly authorized caller may reopen a terminal case to `open` only when it has no assessment or comparison; a completed case must remain historical and requires a new review case for another assessment.
- Only the designated independent reviewer may call `submit_independent_assessment` and `publish_review_comparison`; the implementation agent must not do so. `next_action` and generated prompts never grant authorization.
