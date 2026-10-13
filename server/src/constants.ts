export const KNOWN_PLATFORM_IDS = new Set([
  "claude-code", "codex", "copilot-vscode", "copilot-intellij",
  "codebuddy", "cline", "cursor", "opencode", "hermes", "gemini",
  "trae", "trae-ide", "trae-cli",
]);
export const SAFETY_NOTE =
  "This handoff is context only. Re-check referenced files, current repo state, and required human approvals before acting. next_action is a suggested action, not authorization.";
// (?<![A-Za-z]) blocks matching the label as a substring of a larger ASCII word
// (e.g. "unblocked:", "undone:", "asterisks:") without reintroducing the old
// line-start requirement that missed inline, punctuation-separated sections.
export const HANDOFF_SECTION_PATTERNS = [
  { name: "Status", pattern: /(?:^|[\n\r]|[.!?。]\s*)\s*(?:#{1,6}\s*|[-*>]\s*)?(?<![A-Za-z])(?:status|current\s+state|当前状态)\s*(?:[:：]|$)/im },
  { name: "Done", pattern: /(?:^|[\n\r]|[.!?。]\s*)\s*(?:#{1,6}\s*|[-*>]\s*)?(?<![A-Za-z])(?:done|completed|已完成)\s*(?:[:：]|$)/im },
  { name: "Blocked", pattern: /(?:^|[\n\r]|[.!?。]\s*)\s*(?:#{1,6}\s*|[-*>]\s*)?(?<![A-Za-z])(?:blocked|blockers?|卡点)\s*(?:[:：]|$)/im },
  { name: "Risks", pattern: /(?:^|[\n\r]|[.!?。]\s*)\s*(?:#{1,6}\s*|[-*>]\s*)?(?<![A-Za-z])(?:risks?|pitfalls?|risks?\s*\/\s*pitfalls?|避坑(?:\s*\/\s*风险)?|风险)\s*(?:[:：]|$)/im },
] as const;
