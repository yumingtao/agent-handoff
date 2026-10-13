import { z } from "zod";

export type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: unknown[]): unknown;
    get(...values: unknown[]): Record<string, unknown> | undefined;
    all(...values: unknown[]): Record<string, unknown>[];
  };
  close(): void;
};

export type ConclusionRef = {
  type: "file" | "url" | "jira" | "pr" | "commit" | "thread" | "command" | "note";
  value: string;
  line?: number;
  note?: string;
};

export type ConclusionRecord = {
  id: string;
  project: string;
  workspace: string | null;
  topic: string;
  topic_raw: string | null;
  logical_topic_id: string | null;
  conclusion: string;
  next_action: string | null;
  refs_json: string;
  source_agent: string | null;
  source_thread: string | null;
  source_host: string | null;
  model: string | null;
  model_display: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  supersedes_id: string | null;
  superseded_reason: string | null;
  changed_by: string | null;
  status: "active" | "superseded" | "archived";
  confidence: "low" | "medium" | "high" | null;
  sensitivity: "normal" | "internal" | "sensitive";
};

export type LogicalTopicRecord = {
  id: string;
  project: string;
  workspace: string | null;
  canonical_topic_name: string;
  display_name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  task_state: "open" | "done" | "cancelled" | null;
  completed_at: string | null;
  completed_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
};

export type TopicStateChangeRecord = {
  id: string;
  logical_topic_id: string;
  from_state: string | null;
  to_state: "open" | "done" | "cancelled";
  action: "complete" | "cancel" | "reopen" | "auto_reopen";
  changed_by: string;
  reason: string | null;
  created_at: string;
};

export type HandoffConfig = {
  homeDir: string;
  dbPath: string;
  filesDir: string;
  backupsDir: string;
  secretScanEnabled: boolean;
};

export type ReviewCaseStatus = "open" | "assessed" | "compared" | "closed" | "cancelled" | "archived";

export type ReviewCaseRecord = {
  id: string;
  project: string;
  workspace: string | null;
  topic: string;
  baseline_conclusion_id: string;
  status: "open" | "assessed" | "compared";
  lifecycle_status?: ReviewCaseStatus;
  lifecycle_changed_by?: string | null;
  lifecycle_reason?: string | null;
  created_at: string;
  updated_at: string;
  objective: string;
  scope: string;
  acceptance_criteria_json: string;
  snapshot_ref: string;
  refs_json: string;
  constraints_json: string;
};

export type ReviewTaskMaterial = {
  objective: string;
  scope: string;
  acceptance_criteria: string[];
  snapshot_ref: string;
  refs?: ConclusionRef[];
  constraints?: string[];
};

export type StructuredComparison = {
  agreements: string[];
  author_only: string[];
  reviewer_only: string[];
  disagreements: string[];
  evidence_gaps: string[];
  final_recommendation: string;
};

export const refSchema = z.object({
  type: z.enum(["file", "url", "jira", "pr", "commit", "thread", "command", "note"]),
  value: z.string().min(1),
  line: z.number().int().positive().optional(),
  note: z.string().optional(),
});

export const sourceMetadataSchema = {
  source_thread: z.string().optional().describe("Originating conversation or thread identifier. Historical rows stay null; omit if unknown."),
  source_host: z.string().optional().describe("Orthogonal host/frontend dimension: cli, desktop, vscode, intellij, or web. Lowercased automatically. Historical rows stay null — do not backfill. Omit if unknown rather than guessing."),
};
