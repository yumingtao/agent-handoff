import { z } from "zod";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// @ts-ignore repo-local shared runtime module
import { topicBelongsToCanonical } from "../../shared/topic-canonicalization/index.mjs";
import { refSchema, sourceMetadataSchema } from "./types.js";
import { escapeSqlLike, formatLocal, isoAfterDays, normalizeModel, normalizeRow, nowIso, probeWriteable, publicRecord, textResult, TIME_ZONE } from "./util.js";
import { HANDOFF_SECTION_PATTERNS, KNOWN_PLATFORM_IDS, SAFETY_NOTE } from "./constants.js";
import { assertCleanConclusion } from "./secret-scan.js";
import { applyMigrations, backupStorage, getDatabase, resetDatabaseForTests, SCHEMA_VERSION, withDatabase } from "./db.js";
import { getLogicalTopicById, getOrCreateLogicalTopic, listTopicStateChanges, resolveCanonicalTopic, resolveTopicRecord, transitionTopicState } from "./topics.js";
import { getTopicContext, listConclusions, publishConclusion, supersedeConclusion, toBoardRecord } from "./conclusions.js";
import { createReviewCase, getReviewPacket, listReviewCases, publishReviewComparison, publishReviewReadyImplementation, submitIndependentAssessment, transitionReviewCase } from "./review.js";

const server = new McpServer({
  name: "agent-handoff",
  version: "0.1.0",
});

const publishConclusionInputSchema = {
  project: z.string().min(1).describe("Project or repo name, for example my-repo."),
  workspace: z.string().optional().describe("Optional checkout path, workspace short name, or workspace hash."),
  topic: z.string().min(1).describe("Precise topic key, for example cross-agent-handoff."),
  conclusion: z.string().min(1).max(12000).describe("Concise conclusion. Prefer refs for long documents. Recommended headings: Status, Done, Blocked, Risks/Pitfalls. These headings are a non-blocking handoff convention; next_action carries the next step."),
  next_action: z.string().max(4000).optional().describe("Suggested next action only; not authorization."),
  refs: z.array(refSchema).default([]).describe("Structured references such as files, Jira tickets, PRs, threads, or URLs."),
  source_agent: z.string().optional(),
  ...sourceMetadataSchema,
  model: z.string().optional().describe("Strongly recommended: the calling agent's canonical model id — read from your platform's config or system prompt, do not guess or copy examples. The original value is preserved as model_display; a normalized key (lowercased, hyphens, provider prefix stripped) is derived for grouping. Omitting this buckets the conclusion under 'legacy/unknown' in the Workflow swimlanes view instead of its correct model lane."),
  supersedes_id: z.string().optional().describe("Id of the prior conclusion this continues. When set and logical_topic_id is omitted, the server inherits that conclusion's logical topic instead of resolving one from topic, so a differently-worded topic string on this round still lands on the same logical topic."),
  logical_topic_id: z.string().optional().describe("Optional stable logical topic id. Takes precedence over supersedes_id. When both are omitted, the server resolves or creates one from project/workspace/topic."),
  expires_at: z.string().datetime({ offset: true }).optional(),
  ttl_days: z.number().int().positive().optional().describe("Optional retention in days when expires_at is not provided."),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  sensitivity: z.enum(["normal", "internal", "sensitive"]).default("normal"),
  request_id: z.string().min(1).optional().describe("Optional idempotency key. Reusing it returns the original result after the mutation's write transaction serializes the replay; under contention it may wait for or hit the configured SQLite busy timeout. Do not retry a warning as a new write."),
};

const publishReviewReadyImplementationInputSchema = {
  project: z.string().min(1),
  workspace: z.string().optional(),
  topic: z.string().min(1),
  conclusion: z.string().min(1).max(12000),
  next_action: z.string().max(4000).optional(),
  refs: z.array(refSchema).default([]),
  source_agent: z.string().optional(),
  ...sourceMetadataSchema,
  model: z.string().optional(),
  supersedes_id: z.string().optional(),
  logical_topic_id: z.string().optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
  ttl_days: z.number().int().positive().optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  sensitivity: z.enum(["normal", "internal", "sensitive"]).default("normal"),
  implementation_request_id: z.string().min(1).describe("Required idempotency key for the implementation handoff publish."),
  create_request_id: z.string().min(1).describe("Required idempotency key for the review case creation; reuse this key when retrying case creation."),
  objective: z.string().min(1),
  scope: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  snapshot_ref: z.string().min(1),
  constraints: z.array(z.string().min(1)).default([]),
};

const publishReviewComparisonInputSchema = {
  review_case_id: z.string().min(1),
  comparison: z.string().min(1).max(12000).describe("Final human-readable comparison conclusion to publish after the independent assessment. Include Status, Done, Blocked, and Risks/Pitfalls sections. This is the published handoff body; use the structured fields below for machine-readable comparison details."),
  agreements: z.array(z.string()),
  author_only: z.array(z.string()),
  reviewer_only: z.array(z.string()),
  disagreements: z.array(z.string()),
  evidence_gaps: z.array(z.string()),
  final_recommendation: z.string().min(1),
  source_agent: z.string().optional(),
  ...sourceMetadataSchema,
  model: z.string().optional(),
  refs: z.array(refSchema).default([]),
  supersedes_id: z.string().optional().describe("Id of the prior conclusion this comparison continues. When set and logical_topic_id is omitted, the comparison inherits that conclusion's logical topic. This also marks the prior conclusion as superseded."),
  logical_topic_id: z.string().optional().describe("Optional stable logical topic id for the comparison. Takes precedence over supersedes_id and keeps differently-worded review rounds in the same thread."),
  request_id: z.string().min(1).describe("Required idempotency key for this mutation."),
};

// These queries only read the local agent-handoff store. Declaring their
// behavior lets MCP clients avoid treating them like unclassified mutations.
const LOCAL_READ_ONLY_TOOL = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

server.tool(
  "publish_conclusion",
  "Publish a cross-agent handoff conclusion. This stores context only; next_action is a suggested action and never grants authorization.",
  publishConclusionInputSchema,
  async (request) => {
    return textResult(await withDatabase((db, config) => publishConclusion(db, config, request)));
  }
);

server.tool(
  "publish_review_ready_implementation",
  "Publish the final implementation handoff, then create an independent review case using that handoff as the hidden baseline. Ordinary context/status/routing handoffs do not use this tool.",
  publishReviewReadyImplementationInputSchema,
  async (request) => textResult(await withDatabase((db, config) => publishReviewReadyImplementation(db, config, request)))
);

server.tool(
  "create_review_case",
  "Create an independent review case. The baseline is withheld from the reviewer until an assessment is durably submitted.",
  {
    project: z.string().min(1),
    workspace: z.string().optional(),
    topic: z.string().min(1),
    baseline_conclusion_id: z.string().min(1),
    objective: z.string().min(1),
    scope: z.string().min(1),
    acceptance_criteria: z.array(z.string().min(1)).min(1),
    snapshot_ref: z.string().min(1),
    refs: z.array(refSchema).default([]),
    constraints: z.array(z.string().min(1)).default([]),
    request_id: z.string().min(1).describe("Required idempotency key for this mutation."),
  },
  async (request) => textResult(await withDatabase((db) => createReviewCase(db, request)))
);

server.tool(
  "get_review_packet",
  "Get the independent review packet without revealing baseline id, body, or summary.",
  { review_case_id: z.string().min(1) },
  LOCAL_READ_ONLY_TOOL,
  async ({ review_case_id }) => textResult(await withDatabase((db) => getReviewPacket(db, review_case_id)))
);

server.tool(
  "list_review_cases",
  "List review cases by project/workspace/topic/status without revealing baseline ids or contents.",
  {
    project: z.string().min(1),
    workspace: z.string().optional(),
    topic: z.string().optional(),
    status: z.enum(["open", "assessed", "compared", "closed", "cancelled", "archived"]).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  },
  LOCAL_READ_ONLY_TOOL,
  async (request) => textResult(await withDatabase((db) => listReviewCases(db, request)))
);

server.tool(
  "submit_independent_assessment",
  "Submit the independent assessment. The baseline is revealed atomically only after this write succeeds.",
  {
    review_case_id: z.string().min(1),
    reviewer_agent: z.string().min(1),
    assessment: z.string().min(1).max(12000),
    refs: z.array(refSchema).default([]),
    request_id: z.string().min(1).describe("Required idempotency key for this mutation."),
  },
  async (request) => textResult(await withDatabase((db, config) => submitIndependentAssessment(db, config, request)))
);

server.tool(
  "publish_review_comparison",
  "Atomically publish the final comparison as an ordinary handoff conclusion after assessment.",
  publishReviewComparisonInputSchema,
  async (request) => textResult(await withDatabase((db, config) => publishReviewComparison(db, config, request)))
);

server.tool(
  "transition_review_case",
  "Close, cancel, or archive a review case. This changes review-case lifecycle state and requires explicit human-facing reason and idempotency key.",
  {
    review_case_id: z.string().min(1),
    target_status: z.enum(["open", "closed", "cancelled", "archived"]),
    changed_by: z.string().min(1),
    reason: z.string().min(1),
    expected_status: z.enum(["open", "assessed", "compared", "closed", "cancelled", "archived"]).optional(),
    request_id: z.string().min(1).describe("Required idempotency key for this mutation."),
  },
  async (request) => textResult(await withDatabase((db) => transitionReviewCase(db, request)))
);

server.tool(
  "resolve_topic",
  "Resolve or create the stable logical topic id for a project/workspace/topic input.",
  {
    project: z.string().min(1),
    workspace: z.string().optional(),
    topic: z.string().min(1),
  },
  async (request) => {
    return textResult(await withDatabase((db) => resolveTopicRecord(db, request)));
  }
);

server.tool(
  "get_latest_conclusion",
  "Get the latest active, unexpired conclusion for an exact project + topic scope, with optional workspace filtering.",
  {
    project: z.string().min(1),
    topic: z.string().min(1),
    workspace: z.string().optional(),
  },
  LOCAL_READ_ONLY_TOOL,
  async ({ project, topic, workspace }) => {
    return textResult(await withDatabase((db) => {
      const now = nowIso();
      const workspaceClause = workspace ? "AND workspace = ?" : "";
      const activeValues = workspace ? [project, workspace, now] : [project, now];
      const activeRows = db.prepare(`
        SELECT * FROM conclusions
        WHERE project = ? ${workspaceClause}
          AND status = 'active'
          AND (expires_at IS NULL OR unixepoch(expires_at) > unixepoch(?))
        ORDER BY created_at DESC
        LIMIT 100
      `).all(...activeValues).map(normalizeRow)
        .filter((row) => topicBelongsToCanonical(project, workspace || null, row.topic, topic, resolveCanonicalTopic));
      const row = activeRows[0];

      if (row) {
        return {
          found: true,
          ...publicRecord(row, row.sensitivity !== "sensitive"),
        };
      }

      const expiredValues = workspace ? [project, workspace] : [project];
      const expiredRows = db.prepare(`
        SELECT * FROM conclusions
        WHERE project = ? ${workspaceClause}
          AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 100
      `).all(...expiredValues).map(normalizeRow)
        .filter((row) => topicBelongsToCanonical(project, workspace || null, row.topic, topic, resolveCanonicalTopic));
      const expiredRow = expiredRows[0];

      if (expiredRow) {
        return {
          found: false,
          expired: true,
          latest_expired: publicRecord(normalizeRow(expiredRow), false),
          candidates: db.prepare(`
            SELECT * FROM conclusions
            WHERE project = ? ${workspaceClause}
              AND status = 'active'
            ORDER BY created_at DESC
            LIMIT 10
          `).all(...(workspace ? [project, workspace] : [project])).map((candidate) => publicRecord(normalizeRow(candidate), false)),
          safety_note: SAFETY_NOTE,
        };
      }

      return {
        found: false,
        expired: false,
        project,
        topic,
        workspace: workspace || null,
        candidates: db.prepare(`
          SELECT * FROM conclusions
          WHERE project = ? ${workspaceClause}
            AND status = 'active'
          ORDER BY
            CASE
              WHEN topic = ? THEN 0
              WHEN topic LIKE ? ESCAPE '\\' THEN 1
              WHEN ? LIKE replace(replace(replace(topic, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' ESCAPE '\\' THEN 2
              ELSE 3
            END,
            created_at DESC
          LIMIT 10
        `).all(...(workspace ? [project, workspace, topic, `${escapeSqlLike(topic)}%`, topic] : [project, topic, `${escapeSqlLike(topic)}%`, topic]))
          .map((candidate) => publicRecord(normalizeRow(candidate), false)),
        safety_note: SAFETY_NOTE,
      };
    }));
  }
);

server.tool(
  "list_conclusions",
  "List handoff conclusions with project/topic/workspace/since/status/limit filters. Sensitive records are summarized by default.",
  {
    id: z.string().optional().describe("Optional exact conclusion id to retrieve a specific record."),
    project: z.string().optional(),
    workspace: z.string().optional(),
    topic: z.string().optional(),
    search: z.string().optional().describe("Optional substring search across topic and conclusion."),
    since: z.string().datetime({ offset: true }).optional(),
    status: z.enum(["active", "superseded", "archived"]).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    includeSensitiveDetails: z.boolean().default(false),
  },
  LOCAL_READ_ONLY_TOOL,
  async ({ limit, includeSensitiveDetails, ...filters }) => {
    return textResult(await withDatabase((db) => listConclusions(db, limit, includeSensitiveDetails, filters)));
  }
);

server.tool(
  "supersede_conclusion",
  "Mark an existing handoff conclusion as superseded by another conclusion, or archive it when no replacement is provided.",
  {
    id: z.string().min(1).describe("Existing conclusion id to supersede or archive."),
    replacement_id: z.string().min(1).optional().describe("Optional replacement conclusion id. When omitted, the old conclusion is archived."),
    reason: z.string().max(1000).optional().describe("Optional human-readable reason stored with the superseded or archived record."),
  },
  async ({ id, replacement_id, reason }) => {
    return textResult(await withDatabase((db, config) => supersedeConclusion(db, config, { id, replacement_id, reason })));
  }
);

server.tool(
  "backup_storage",
  "Create a local backup of the handoff SQLite database and fallback JSON files.",
  {
    label: z.string().max(64).optional().describe("Optional backup label. Unsafe filename characters are replaced."),
  },
  async ({ label }) => {
    return textResult(await withDatabase((db, config) => {
      const backup = backupStorage(db, config, label);
      const recordCount = db.prepare("SELECT COUNT(*) AS count FROM conclusions").get()?.count ?? 0;
      return {
        ok: true,
        storage: "sqlite+files",
        record_count: Number(recordCount),
        ...backup,
        safety_note: SAFETY_NOTE,
      };
    }));
  }
);

server.tool(
  "cleanup_conclusions",
  "Preview or delete old handoff conclusions. Defaults to dry-run and never deletes active records unless explicitly requested.",
  {
    statuses: z.array(z.enum(["active", "superseded", "archived"])).default(["superseded", "archived"]),
    before: z.string().datetime({ offset: true }).optional().describe("Only include records with updated_at before this timestamp."),
    expiredOnly: z.boolean().default(false).describe("Only include records whose expires_at is in the past."),
    limit: z.number().int().min(1).max(1000).default(100),
    deleteFiles: z.boolean().default(false).describe("Also remove fallback JSON files for deleted rows when dryRun=false."),
    dryRun: z.boolean().default(true).describe("Preview matching records without deleting them."),
    confirmDelete: z.boolean().optional().describe("Must be true when dryRun=false."),
  },
  async ({ statuses, before, expiredOnly, limit, deleteFiles, dryRun, confirmDelete }) => {
    return textResult(await withDatabase((db, config) => {
      if (!dryRun && confirmDelete !== true) {
        throw new Error("cleanup_conclusions requires confirmDelete=true when dryRun=false.");
      }

      const where: string[] = [];
      const values: unknown[] = [];
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      values.push(...statuses);

      if (before) {
        where.push("unixepoch(updated_at) < unixepoch(?)");
        values.push(before);
      }

      if (expiredOnly) {
        where.push("expires_at IS NOT NULL AND unixepoch(expires_at) <= unixepoch(?)");
        values.push(nowIso());
      }

      const rows = db.prepare(`
        SELECT * FROM conclusions
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at ASC
        LIMIT ?
      `).all(...values, limit).map(normalizeRow);

      if (dryRun) {
        return {
          dryRun,
          matched_count: rows.length,
          candidates: rows.map((row) => publicRecord(row, false)),
          safety_note: SAFETY_NOTE,
        };
      }

      db.exec("BEGIN IMMEDIATE");
      let detachedReferenceCount = 0;
      try {
        for (const row of rows) {
          const detached = db.prepare("UPDATE conclusions SET supersedes_id = NULL, updated_at = ? WHERE supersedes_id = ?").run(nowIso(), row.id) as { changes?: number };
          detachedReferenceCount += Number(detached.changes || 0);
          db.prepare("DELETE FROM conclusions WHERE id = ?").run(row.id);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      const removedFiles: string[] = [];
      if (deleteFiles) {
        for (const row of rows) {
          const filePath = join(config.filesDir, `${row.id}.json`);
          if (existsSync(filePath)) {
            rmSync(filePath);
            removedFiles.push(filePath);
          }
        }
      }

      return {
        dryRun,
        deleted_count: rows.length,
        deleted_ids: rows.map((row) => row.id),
        detached_reference_count: detachedReferenceCount,
        removed_files: removedFiles,
        safety_note: SAFETY_NOTE,
      };
    }));
  }
);

server.tool(
  "health_check",
  "Check handoff MCP storage health, schema version, writeability, and record count.",
  {},
  async () => {
    return textResult(await withDatabase((db, config) => {
      const recordCount = db.prepare("SELECT COUNT(*) AS count FROM conclusions").get()?.count ?? 0;
      const schemaVersion = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value ?? String(SCHEMA_VERSION);
      const writeable = probeWriteable(config);
      return {
        ok: true,
        storage: "sqlite+files",
        db_path: config.dbPath,
        files_dir: config.filesDir,
        backups_dir: config.backupsDir,
        schema_version: Number(schemaVersion),
        applied_migrations: db.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all(),
        writeable,
        record_count: Number(recordCount),
        node_version: process.version,
        node_sqlite: "required; Node >= 22.5, currently experimental",
        secret_scan_enabled: config.secretScanEnabled,
        time_zone: TIME_ZONE ?? "system-default",
        now_display: formatLocal(nowIso()),
        safety_note: SAFETY_NOTE,
      };
    }));
  }
);

server.tool(
  "get_topic_context",
  "Return the full assembled topic context for a logical topic id, including handoffs, events, runs, and merged timeline.",
  {
    topic_id: z.string().min(1),
  },
  LOCAL_READ_ONLY_TOOL,
  async ({ topic_id }) => {
    return textResult(await withDatabase((db) => getTopicContext(db, topic_id)));
  }
);

server.tool(
  "transition_topic_state",
  "Transition the explicit task state of a logical topic (open/done/cancelled). This changes task state and is not merely context — confirm authorization before calling. Allowed: open→done, open→cancelled, done→open, cancelled→open. Same-state transitions are idempotent. Publishing a new handoff to a done/cancelled topic auto-reopens it.",
  {
    logical_topic_id: z.string().min(1),
    target_state: z.enum(["open", "done", "cancelled"]),
    changed_by: z.string().min(1),
    reason: z.string().optional(),
    expected_state: z.enum(["open", "done", "cancelled"]).optional(),
  },
  async (request) => {
    return textResult(await withDatabase((db) => transitionTopicState(db, request)));
  }
);

const transport = new StdioServerTransport();

export const __test = {
  sourceMetadataSchema,
  publishConclusionInputSchema,
  publishReviewReadyImplementationInputSchema,
  publishReviewComparisonInputSchema,
  applyMigrations,
  getDatabase,
  isoAfterDays,
  listConclusions,
  publishConclusion,
  publicRecord,
  getTopicContext,
  resolveTopicRecord,
  resolveCanonicalTopic,
  resetDatabaseForTests,
  supersedeConclusion,
  transitionTopicState,
  listTopicStateChanges,
  getLogicalTopicById,
  getOrCreateLogicalTopic,
  createReviewCase,
  getReviewPacket,
  submitIndependentAssessment,
  publishReviewComparison,
  listReviewCases,
  transitionReviewCase,
  publishReviewReadyImplementation,
  assertCleanConclusion,
  normalizeModel,
  HANDOFF_SECTION_PATTERNS,
  KNOWN_PLATFORM_IDS,
};

if (process.env.AGENT_HANDOFF_DISABLE_SERVER !== "1") {
  await server.connect(transport);
}
