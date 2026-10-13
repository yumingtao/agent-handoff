import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
// @ts-ignore repo-local shared runtime module
import { TOPIC_ALIASES } from "../../shared/topic-canonicalization/aliases.mjs";
// @ts-ignore repo-local shared runtime module
import { createTopicResolver, resolveCanonicalTopicWithRaw, topicBelongsToCanonical } from "../../shared/topic-canonicalization/index.mjs";
// @ts-ignore repo-local shared runtime module
import { isCanonicalWorkspaceProject, normalizeWorkspace, workspaceIdentityCandidates } from "../../shared/workspace-normalization/index.mjs";
// @ts-ignore repo-local shared runtime module
import { buildTopicContextModel } from "../../shared/topic-context/index.mjs";
// @ts-ignore repo-local runtime module
import { AgentEventsStore } from "../../agent-events/src/store.mjs";
// @ts-ignore repo-local runtime module
import { TraceStoreView } from "../../board/src/trace-store-view.mjs";

const SCHEMA_VERSION = 15;
const DEFAULT_HOME = join(homedir(), ".agent-handoff");
const KNOWN_PLATFORM_IDS = new Set([
  "claude-code", "codex", "copilot-vscode", "copilot-intellij",
  "codebuddy", "cline", "cursor", "opencode", "hermes", "gemini",
  "trae", "trae-ide", "trae-cli",
]);
const SAFETY_NOTE =
  "This handoff is context only. Re-check referenced files, current repo state, and required human approvals before acting. next_action is a suggested action, not authorization.";
// (?<![A-Za-z]) blocks matching the label as a substring of a larger ASCII word
// (e.g. "unblocked:", "undone:", "asterisks:") without reintroducing the old
// line-start requirement that missed inline, punctuation-separated sections.
const HANDOFF_SECTION_PATTERNS = [
  { name: "Status", pattern: /(?:^|[\n\r]|[.!?。]\s*)\s*(?:#{1,6}\s*|[-*>]\s*)?(?<![A-Za-z])(?:status|current\s+state|当前状态)\s*(?:[:：]|$)/im },
  { name: "Done", pattern: /(?:^|[\n\r]|[.!?。]\s*)\s*(?:#{1,6}\s*|[-*>]\s*)?(?<![A-Za-z])(?:done|completed|已完成)\s*(?:[:：]|$)/im },
  { name: "Blocked", pattern: /(?:^|[\n\r]|[.!?。]\s*)\s*(?:#{1,6}\s*|[-*>]\s*)?(?<![A-Za-z])(?:blocked|blockers?|卡点)\s*(?:[:：]|$)/im },
  { name: "Risks", pattern: /(?:^|[\n\r]|[.!?。]\s*)\s*(?:#{1,6}\s*|[-*>]\s*)?(?<![A-Za-z])(?:risks?|pitfalls?|risks?\s*\/\s*pitfalls?|避坑(?:\s*\/\s*风险)?|风险)\s*(?:[:：]|$)/im },
] as const;
const resolveCanonicalTopic = createTopicResolver(TOPIC_ALIASES);

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: unknown[]): unknown;
    get(...values: unknown[]): Record<string, unknown> | undefined;
    all(...values: unknown[]): Record<string, unknown>[];
  };
  close(): void;
};

type ConclusionRef = {
  type: "file" | "url" | "jira" | "pr" | "commit" | "thread" | "command" | "note";
  value: string;
  line?: number;
  note?: string;
};

type ConclusionRecord = {
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

type LogicalTopicRecord = {
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

type TopicStateChangeRecord = {
  id: string;
  logical_topic_id: string;
  from_state: string | null;
  to_state: "open" | "done" | "cancelled";
  action: "complete" | "cancel" | "reopen" | "auto_reopen";
  changed_by: string;
  reason: string | null;
  created_at: string;
};

type HandoffConfig = {
  homeDir: string;
  dbPath: string;
  filesDir: string;
  backupsDir: string;
  secretScanEnabled: boolean;
};

type ReviewCaseStatus = "open" | "assessed" | "compared" | "closed" | "cancelled" | "archived";

type ReviewCaseRecord = {
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

type ReviewTaskMaterial = {
  objective: string;
  scope: string;
  acceptance_criteria: string[];
  snapshot_ref: string;
  refs?: ConclusionRef[];
  constraints?: string[];
};

type StructuredComparison = {
  agreements: string[];
  author_only: string[];
  reviewer_only: string[];
  disagreements: string[];
  evidence_gaps: string[];
  final_recommendation: string;
};

const refSchema = z.object({
  type: z.enum(["file", "url", "jira", "pr", "commit", "thread", "command", "note"]),
  value: z.string().min(1),
  line: z.number().int().positive().optional(),
  note: z.string().optional(),
});

const sourceMetadataSchema = {
  source_thread: z.string().optional().describe("Originating conversation or thread identifier. Historical rows stay null; omit if unknown."),
  source_host: z.string().optional().describe("Orthogonal host/frontend dimension: cli, desktop, vscode, intellij, or web. Lowercased automatically. Historical rows stay null — do not backfill. Omit if unknown rather than guessing."),
};

function usableEnvValue(value: string | undefined): string {
  if (!value) return "";
  return /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) ? "" : value;
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = usableEnvValue(process.env[name]).trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value);
}

function buildConfig(): HandoffConfig {
  const homeDir = resolve(usableEnvValue(process.env.AGENT_HANDOFF_HOME) || DEFAULT_HOME);
  const dbPath = resolve(usableEnvValue(process.env.AGENT_HANDOFF_DB_PATH) || join(homeDir, "handoff.db"));
  return {
    homeDir,
    dbPath,
    filesDir: resolve(usableEnvValue(process.env.AGENT_HANDOFF_FILES_DIR) || join(homeDir, "files")),
    backupsDir: resolve(usableEnvValue(process.env.AGENT_HANDOFF_BACKUPS_DIR) || join(homeDir, "backups")),
    secretScanEnabled: envFlag("AGENT_HANDOFF_SECRET_SCAN", true),
  };
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function normalizeModel(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  // Strip provider prefix: take the segment after the LAST '/' before folding.
  // e.g. "openai/gpt-5.5" → "gpt-5.5" → "gpt-5-5"
  const afterSlash = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  const normalized = afterSlash.replace(/[\s._]+/g, "-");
  return normalized || null;
}

function probeWriteable(config: HandoffConfig): boolean {
  const paths = [
    join(dirname(config.dbPath), `.agent-handoff-health-${randomUUID()}.tmp`),
    join(config.filesDir, `.agent-handoff-health-${randomUUID()}.tmp`),
    join(config.backupsDir, `.agent-handoff-health-${randomUUID()}.tmp`),
  ];

  try {
    for (const filePath of paths) {
      writeFileSync(filePath, "ok", { flag: "wx" });
    }
    return true;
  } catch {
    return false;
  } finally {
    for (const filePath of paths) {
      rmSync(filePath, { force: true });
    }
  }
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoAfterDays(baseIso: string, days: number): string {
  const date = new Date(baseIso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

// Timestamps are stored and compared in UTC (toISOString / SQLite unixepoch) so
// ordering and expiry math stay correct across machines and DST. For human
// display we additionally render the local zone. Resolution order:
// AGENT_HANDOFF_TZ, then TZ, then the OS default (the server runs on the user's
// machine, so this is the user's zone). The UTC `*_at` fields stay canonical.
function resolveTimeZone(): string | undefined {
  const explicit = usableEnvValue(process.env.AGENT_HANDOFF_TZ) || usableEnvValue(process.env.TZ);
  if (explicit) return explicit;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

const TIME_ZONE = resolveTimeZone();

function formatLocal(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const formatted = new Intl.DateTimeFormat("sv-SE", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "shortOffset",
    }).format(date);
    return TIME_ZONE ? `${formatted} [${TIME_ZONE}]` : formatted;
  } catch {
    return date.toISOString();
  }
}

function relativeTime(iso: string | null, nowMs: number = Date.now()): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const diffMs = t - nowMs;
  const past = diffMs <= 0;
  const sec = Math.round(Math.abs(diffMs) / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  let value = sec;
  let unit = "second";
  if (sec >= 60 && min < 60) {
    value = min;
    unit = "minute";
  } else if (min >= 60 && hr < 24) {
    value = hr;
    unit = "hour";
  } else if (hr >= 24) {
    value = day;
    unit = "day";
  }
  const label = `${value} ${unit}${value === 1 ? "" : "s"}`;
  return past ? `${label} ago` : `in ${label}`;
}

function parseRefs(value: string): ConclusionRef[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeRow(row: Record<string, unknown>): ConclusionRecord {
  return row as unknown as ConclusionRecord;
}

function columnExists(db: SqliteDatabase, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}

function publicRecord(row: ConclusionRecord, includeBody = true) {
  const refs = parseRefs(row.refs_json);
  const base = {
    id: row.id,
    project: row.project,
    workspace: row.workspace,
    topic: row.topic,
    topic_raw: row.topic_raw,
    logical_topic_id: row.logical_topic_id,
    refs,
    source_agent: row.source_agent,
    source_thread: row.source_thread,
    source_host: row.source_host,
    model: row.model,
    model_display: row.model_display || row.model,
    created_at: row.created_at,
    created_at_display: formatLocal(row.created_at),
    created_at_relative: relativeTime(row.created_at),
    updated_at: row.updated_at,
    updated_at_display: formatLocal(row.updated_at),
    expires_at: row.expires_at,
    expires_at_display: formatLocal(row.expires_at),
    supersedes_id: row.supersedes_id,
    superseded_reason: row.superseded_reason,
    changed_by: row.changed_by,
    status: row.status,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    safety_note: SAFETY_NOTE,
  };

  if (!includeBody) {
    return {
      ...base,
      conclusion_preview: preview(row.conclusion),
      next_action_preview: row.next_action ? preview(row.next_action) : null,
      body_redacted: true,
    };
  }

  return {
    ...base,
    conclusion: row.conclusion,
    next_action: row.next_action,
    next_action_note: row.next_action ? "Suggested action only; not authorization." : null,
  };
}

function preview(value: string, max = 240): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}...` : compact;
}

function backupTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function assertNoSecrets(input: unknown): void {
  const text = JSON.stringify(input);
  const checks: Array<[RegExp, string]> = [
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i, "Bearer token"],
    [/\b(cookie|set-cookie)\s*[:=]\s*[^;\n]{12,}/i, "cookie"],
    [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i, "private key"],
    [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
    [/\bASIA[0-9A-Z]{16}\b/, "AWS session key"],
    [/\bgh[pousr]_[A-Za-z0-9_]{30,}\b/, "GitHub token"],
    [/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd)\b\s*[:=]\s*["']?[^"',\s]{12,}/i, "secret-like key/value"],
  ];

  for (const [pattern, label] of checks) {
    if (pattern.test(text)) {
      throw new Error(`Refusing to write handoff because it appears to contain a ${label}. Remove or redact the secret and try again.`);
    }
  }
}

function assertCleanConclusion(value: string): void {
  const trailingToolCallResidue = /(?:<\/parameter>\s*<\/invoke>|<\/invoke>\s*<\/parameter>)\s*$/i;
  if (trailingToolCallResidue.test(value)) {
    throw new Error("Refusing to write conclusion containing tool-call serialization residue such as </parameter> or </invoke>. Remove the residue and submit once; do not retry blindly.");
  }
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readMutationReceipt(db: SqliteDatabase, requestId: string, operation: string, hash: string): any {
  const row = db.prepare("SELECT operation, request_hash, response_json FROM mutation_receipts WHERE request_id = ?").get(requestId) as
    | { operation: string; request_hash: string; response_json: string }
    | undefined;
  if (!row) return null;
  if (row.operation !== operation || row.request_hash !== hash) {
    throw new Error(`request_id ${requestId} was already used for a different ${operation} request.`);
  }
  return JSON.parse(row.response_json);
}

function writeMutationReceipt(db: SqliteDatabase, requestId: string, operation: string, hash: string, response: unknown): void {
  db.prepare(`
    INSERT INTO mutation_receipts (request_id, operation, request_hash, response_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(requestId, operation, hash, JSON.stringify(response), nowIso());
}

async function openDatabase(config: HandoffConfig): Promise<SqliteDatabase> {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  mkdirSync(config.filesDir, { recursive: true });
  mkdirSync(config.backupsDir, { recursive: true });
  const sqlite = await import("node:sqlite") as unknown as { DatabaseSync: new (path: string) => SqliteDatabase };
  const db = new sqlite.DatabaseSync(config.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conclusions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      workspace TEXT,
      topic TEXT NOT NULL,
      topic_raw TEXT,
      logical_topic_id TEXT,
      conclusion TEXT NOT NULL,
      next_action TEXT,
      refs_json TEXT NOT NULL,
      source_agent TEXT,
      source_thread TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      supersedes_id TEXT,
      superseded_reason TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'archived')),
      confidence TEXT CHECK (confidence IN ('low', 'medium', 'high')),
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'internal', 'sensitive')),
      FOREIGN KEY (supersedes_id) REFERENCES conclusions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_conclusions_lookup
      ON conclusions(project, topic, workspace, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conclusions_status_created
      ON conclusions(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS logical_topics (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      workspace TEXT,
      canonical_topic_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  applyMigrations(db);
  return db;
}

function applyMigrations(db: SqliteDatabase): void {
  const applied = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version;
  const currentVersion = Number(applied || 0);

  db.exec("BEGIN");
  try {
    if (currentVersion < 1) {
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        1,
        "initial_conclusions_schema",
        nowIso()
      );
    }

    if (currentVersion < 2) {
      if (!columnExists(db, "conclusions", "superseded_reason")) {
        db.exec("ALTER TABLE conclusions ADD COLUMN superseded_reason TEXT;");
      }
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        2,
        "conclusions_superseded_reason",
        nowIso()
      );
    }

    if (currentVersion < 3) {
      if (!columnExists(db, "conclusions", "topic_raw")) {
        db.exec("ALTER TABLE conclusions ADD COLUMN topic_raw TEXT;");
      }
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        3,
        "conclusions_topic_raw",
        nowIso()
      );
    }

    if (currentVersion < 4) {
      if (!columnExists(db, "conclusions", "logical_topic_id")) {
        db.exec("ALTER TABLE conclusions ADD COLUMN logical_topic_id TEXT;");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS logical_topics (
          id TEXT PRIMARY KEY,
          project TEXT NOT NULL,
          workspace TEXT,
          canonical_topic_name TEXT NOT NULL,
          display_name TEXT NOT NULL,
          description TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_logical_topics_identity
          ON logical_topics(project, coalesce(workspace,''), canonical_topic_name);
        CREATE INDEX IF NOT EXISTS idx_conclusions_logical_topic ON conclusions(logical_topic_id, created_at DESC);
      `);
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        4,
        "logical_topics_v4",
        nowIso()
      );
    }

    if (currentVersion < 5) {
      if (!columnExists(db, "conclusions", "model")) {
        db.exec("ALTER TABLE conclusions ADD COLUMN model TEXT;");
      }
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        5,
        "conclusions_model",
        nowIso()
      );
    }

    if (currentVersion < 6) {
      if (!columnExists(db, "conclusions", "model_display")) {
        db.exec("ALTER TABLE conclusions ADD COLUMN model_display TEXT;");
      }
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        6,
        "conclusions_model_display",
        nowIso()
      );
    }

    if (currentVersion < 7) {
      if (!columnExists(db, "logical_topics", "task_state")) {
        db.exec("ALTER TABLE logical_topics ADD COLUMN task_state TEXT;");
      }
      if (!columnExists(db, "logical_topics", "completed_at")) {
        db.exec("ALTER TABLE logical_topics ADD COLUMN completed_at TEXT;");
      }
      if (!columnExists(db, "logical_topics", "completed_by")) {
        db.exec("ALTER TABLE logical_topics ADD COLUMN completed_by TEXT;");
      }
      if (!columnExists(db, "logical_topics", "cancelled_at")) {
        db.exec("ALTER TABLE logical_topics ADD COLUMN cancelled_at TEXT;");
      }
      if (!columnExists(db, "logical_topics", "cancelled_by")) {
        db.exec("ALTER TABLE logical_topics ADD COLUMN cancelled_by TEXT;");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS topic_state_changes (
          id TEXT PRIMARY KEY,
          logical_topic_id TEXT NOT NULL,
          from_state TEXT,
          to_state TEXT NOT NULL,
          action TEXT NOT NULL,
          changed_by TEXT NOT NULL,
          reason TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (logical_topic_id) REFERENCES logical_topics(id)
        );
        CREATE INDEX IF NOT EXISTS idx_topic_state_changes_topic_time
          ON topic_state_changes(logical_topic_id, created_at DESC);
      `);
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        7,
        "logical_topics_task_state_v7",
        nowIso()
      );
    }

    if (currentVersion < 8) {
      // Re-derive conclusions.model using the hardened normalizeModel that
      // folds '.', '_' and whitespace into '-'. Derive from model_display
      // (the source of truth) when available, else from the existing model
      // column. Never modify model_display.
      const rows = db.prepare(
        "SELECT id, model_display, model FROM conclusions WHERE model_display IS NOT NULL OR model IS NOT NULL"
      ).all() as { id: string; model_display: string | null; model: string | null }[];
      for (const row of rows) {
        const source = row.model_display ?? row.model;
        const rederived = normalizeModel(source);
        if (rederived) {
          db.prepare("UPDATE conclusions SET model = ? WHERE id = ?").run(rederived, row.id);
        }
      }
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        8,
        "conclusions_model_normalize_from_display",
        nowIso()
      );
    }

    if (currentVersion < 9) {
      if (!columnExists(db, "conclusions", "source_host")) {
        db.exec("ALTER TABLE conclusions ADD COLUMN source_host TEXT NULL;");
      }
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        9,
        "conclusions_source_host",
        nowIso()
      );
    }

    if (currentVersion < 10) {
      if (!columnExists(db, "conclusions", "changed_by")) {
        db.exec("ALTER TABLE conclusions ADD COLUMN changed_by TEXT;");
      }
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        10,
        "conclusions_changed_by",
        nowIso()
      );
    }

    if (currentVersion < 11) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mutation_receipts (
          request_id TEXT PRIMARY KEY,
          operation TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        11,
        "mutation_receipts",
        nowIso()
      );
    }

    if (currentVersion < 12) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS review_cases (
          id TEXT PRIMARY KEY,
          project TEXT NOT NULL,
          workspace TEXT,
          topic TEXT NOT NULL,
          baseline_conclusion_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'assessed', 'compared')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (baseline_conclusion_id) REFERENCES conclusions(id)
        );
        CREATE TABLE IF NOT EXISTS review_assessments (
          id TEXT PRIMARY KEY,
          review_case_id TEXT NOT NULL,
          reviewer_agent TEXT NOT NULL,
          assessment TEXT NOT NULL,
          refs_json TEXT NOT NULL,
          request_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          FOREIGN KEY (review_case_id) REFERENCES review_cases(id)
        );
        CREATE INDEX IF NOT EXISTS idx_review_assessments_case ON review_assessments(review_case_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_review_cases_scope ON review_cases(project, workspace, topic, created_at DESC);
      `);
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        12,
        "independent_review_protocol",
        nowIso()
      );
    }

    if (currentVersion < 13) {
      for (const [column, definition] of [
        ["objective", "TEXT NOT NULL DEFAULT ''"],
        ["scope", "TEXT NOT NULL DEFAULT ''"],
        ["acceptance_criteria_json", "TEXT NOT NULL DEFAULT '[]'"],
        ["snapshot_ref", "TEXT NOT NULL DEFAULT ''"],
        ["refs_json", "TEXT NOT NULL DEFAULT '[]'"],
        ["constraints_json", "TEXT NOT NULL DEFAULT '[]'"],
      ] as const) {
        if (!columnExists(db, "review_cases", column)) {
          db.exec(`ALTER TABLE review_cases ADD COLUMN ${column} ${definition}`);
        }
      }
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        13,
        "review_case_task_material",
        nowIso()
      );
    }

    if (currentVersion < 14) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS review_comparisons (
          id TEXT PRIMARY KEY,
          review_case_id TEXT NOT NULL,
          assessment_id TEXT NOT NULL,
          conclusion_id TEXT NOT NULL,
          agreements_json TEXT NOT NULL,
          author_only_json TEXT NOT NULL,
          reviewer_only_json TEXT NOT NULL,
          disagreements_json TEXT NOT NULL,
          evidence_gaps_json TEXT NOT NULL,
          final_recommendation TEXT NOT NULL,
          request_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          FOREIGN KEY (review_case_id) REFERENCES review_cases(id),
          FOREIGN KEY (assessment_id) REFERENCES review_assessments(id),
          FOREIGN KEY (conclusion_id) REFERENCES conclusions(id)
        );
        CREATE INDEX IF NOT EXISTS idx_review_comparisons_case ON review_comparisons(review_case_id, created_at);
      `);
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        14,
        "structured_review_comparisons",
        nowIso()
      );
    }

    if (currentVersion < 15) {
      for (const [column, definition] of [
        ["lifecycle_status", "TEXT NOT NULL DEFAULT 'open' CHECK (lifecycle_status IN ('open', 'assessed', 'compared', 'closed', 'cancelled', 'archived'))"],
        ["lifecycle_changed_by", "TEXT"],
        ["lifecycle_reason", "TEXT"],
      ] as const) {
        if (!columnExists(db, "review_cases", column)) {
          db.exec(`ALTER TABLE review_cases ADD COLUMN ${column} ${definition}`);
        }
      }
      db.prepare("UPDATE review_cases SET lifecycle_status = status WHERE lifecycle_status = 'open' AND status <> 'open'").run();
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        15,
        "review_case_lifecycle",
        nowIso()
      );
    }

    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Module-level singleton: open once, reuse across all tool calls, close on exit.
let _db: SqliteDatabase | null = null;
let _config: HandoffConfig | null = null;
let _dbPromise: Promise<{ db: SqliteDatabase; config: HandoffConfig }> | null = null;
let _closeHandlersRegistered = false;

function registerCloseHandlers(): void {
  if (_closeHandlersRegistered) return;
  _closeHandlersRegistered = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      try { _db?.close(); } catch { /* ignore */ }
      process.exit(0);
    });
  }
}

async function initializeDatabase(): Promise<{ db: SqliteDatabase; config: HandoffConfig }> {
  const config = buildConfig();
  const db = await openDatabase(config);
  _db = db;
  _config = config;
  registerCloseHandlers();
  return { db, config };
}

async function getDatabase(): Promise<{ db: SqliteDatabase; config: HandoffConfig }> {
  if (!_dbPromise) {
    _dbPromise = initializeDatabase().catch((error) => {
      _dbPromise = null;
      _db = null;
      _config = null;
      throw error;
    });
  }
  return _dbPromise;
}

function resetDatabaseForTests(): void {
  try {
    _db?.close();
  } catch {
    // ignore close errors in test cleanup
  }
  _db = null;
  _config = null;
  _dbPromise = null;
}

async function withDatabase<T>(fn: (db: SqliteDatabase, config: HandoffConfig) => T | Promise<T>): Promise<T> {
  const { db, config } = await getDatabase();
  return fn(db, config);
}

function writeFallbackFile(config: HandoffConfig, record: ConclusionRecord): string {
  mkdirSync(config.filesDir, { recursive: true });
  const filePath = join(config.filesDir, `${record.id}.json`);
  writeFileSync(filePath, JSON.stringify(publicRecord(record), null, 2) + "\n", { mode: 0o600 });
  return filePath;
}

function backupStorage(db: SqliteDatabase, config: HandoffConfig, label?: string) {
  const safeLabel = label ? `-${label.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48)}` : "";
  const backupDir = join(config.backupsDir, `${backupTimestamp()}${safeLabel}`);
  mkdirSync(backupDir, { recursive: true });

  const dbBackupPath = join(backupDir, "handoff.db");
  db.exec("PRAGMA wal_checkpoint(FULL);");
  db.exec(`VACUUM main INTO ${quoteSqlString(dbBackupPath)};`);

  const filesBackupDir = join(backupDir, "files");
  if (existsSync(config.filesDir)) {
    cpSync(config.filesDir, filesBackupDir, { recursive: true });
  } else {
    mkdirSync(filesBackupDir, { recursive: true });
  }

  return {
    backup_dir: backupDir,
    db_backup_path: dbBackupPath,
    files_backup_dir: filesBackupDir,
  };
}

function insertConclusion(db: SqliteDatabase, record: ConclusionRecord): void {
  db.prepare(`
    INSERT INTO conclusions (
      id, project, workspace, topic, topic_raw, logical_topic_id, conclusion, next_action, refs_json, source_agent, source_thread, source_host, model, model_display,
      created_at, updated_at, expires_at, supersedes_id, superseded_reason, status, confidence, sensitivity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.project,
    record.workspace,
    record.topic,
    record.topic_raw,
    record.logical_topic_id,
    record.conclusion,
    record.next_action,
    record.refs_json,
    record.source_agent,
    record.source_thread,
    record.source_host,
    record.model,
    record.model_display,
    record.created_at,
    record.updated_at,
    record.expires_at,
    record.supersedes_id,
    record.superseded_reason,
    record.status,
    record.confidence,
    record.sensitivity
  );
}

function normalizeLogicalTopic(row: Record<string, unknown>): LogicalTopicRecord {
  return row as unknown as LogicalTopicRecord;
}

function publicLogicalTopic(row: LogicalTopicRecord) {
  return {
    id: row.id,
    project: row.project,
    workspace: row.workspace,
    canonical_topic_name: row.canonical_topic_name,
    display_name: row.display_name,
    description: row.description,
    created_at: row.created_at,
    created_at_display: formatLocal(row.created_at),
    updated_at: row.updated_at,
    updated_at_display: formatLocal(row.updated_at),
    task_state: row.task_state || null,
    completed_at: row.completed_at || null,
    completed_at_display: row.completed_at ? formatLocal(row.completed_at) : null,
    completed_by: row.completed_by || null,
    cancelled_at: row.cancelled_at || null,
    cancelled_at_display: row.cancelled_at ? formatLocal(row.cancelled_at) : null,
    cancelled_by: row.cancelled_by || null,
  };
}

function getLogicalTopicById(db: SqliteDatabase, logicalTopicId: string): LogicalTopicRecord | null {
  const row = db.prepare("SELECT * FROM logical_topics WHERE id = ?").get(logicalTopicId);
  return row ? normalizeLogicalTopic(row) : null;
}

function findLogicalTopicByIdentity(db: SqliteDatabase, project: string, workspace: string | null, canonicalTopic: string): LogicalTopicRecord | null {
  const workspaceCandidates = workspaceIdentityCandidates(project, workspace);
  const placeholders = workspaceCandidates.map(() => "?").join(", ");
  const row = db.prepare(`
    SELECT * FROM logical_topics
    WHERE project = ? AND coalesce(workspace, '') IN (${placeholders}) AND canonical_topic_name = ?
    LIMIT 1
  `).get(project, ...workspaceCandidates.map((candidate: string | null) => candidate || ""), canonicalTopic);
  return row ? normalizeLogicalTopic(row) : null;
}

function createLogicalTopic(db: SqliteDatabase, project: string, workspace: string | null, canonicalTopic: string, timestamp: string): LogicalTopicRecord {
  const record: LogicalTopicRecord = {
    id: randomUUID(),
    project,
    workspace,
    canonical_topic_name: canonicalTopic,
    display_name: canonicalTopic,
    description: null,
    created_at: timestamp,
    updated_at: timestamp,
    task_state: "open",
    completed_at: null,
    completed_by: null,
    cancelled_at: null,
    cancelled_by: null,
  };
  db.prepare(`
    INSERT INTO logical_topics (id, project, workspace, canonical_topic_name, display_name, description, created_at, updated_at, task_state, completed_at, completed_by, cancelled_at, cancelled_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.project,
    record.workspace,
    record.canonical_topic_name,
    record.display_name,
    record.description,
    record.created_at,
    record.updated_at,
    record.task_state,
    record.completed_at,
    record.completed_by,
    record.cancelled_at,
    record.cancelled_by,
  );
  return record;
}

function getOrCreateLogicalTopic(db: SqliteDatabase, project: string, workspace: string | null, canonicalTopic: string, timestamp = nowIso()): LogicalTopicRecord {
  const existing = findLogicalTopicByIdentity(db, project, workspace, canonicalTopic);
  if (existing) return existing;
  try {
    return createLogicalTopic(db, project, workspace, canonicalTopic, timestamp);
  } catch {
    const raced = findLogicalTopicByIdentity(db, project, workspace, canonicalTopic);
    if (raced) return raced;
    throw new Error(`Failed to get or create logical topic for ${project}/${workspace || ''}/${canonicalTopic}`);
  }
}

// --- topic task state machine (design: docs/topic-task-state-model-design.md §3) ---

const ALLOWED_TRANSITIONS: Record<string, Array<"open" | "done" | "cancelled">> = {
  open: ["done", "cancelled"],
  done: ["open"],
  cancelled: ["open"],
};

function transitionAction(from: string | null, to: "open" | "done" | "cancelled"): "complete" | "cancel" | "reopen" | null {
  if (from === to) return null;
  if (to === "done") return "complete";
  if (to === "cancelled") return "cancel";
  if (to === "open") return "reopen";
  return null;
}

function insertTopicStateChange(
  db: SqliteDatabase,
  logicalTopicId: string,
  fromState: string | null,
  toState: "open" | "done" | "cancelled",
  action: "complete" | "cancel" | "reopen" | "auto_reopen",
  changedBy: string,
  reason: string | null,
  timestamp: string,
): TopicStateChangeRecord {
  const record: TopicStateChangeRecord = {
    id: randomUUID(),
    logical_topic_id: logicalTopicId,
    from_state: fromState,
    to_state: toState,
    action,
    changed_by: changedBy,
    reason,
    created_at: timestamp,
  };
  db.prepare(`
    INSERT INTO topic_state_changes (id, logical_topic_id, from_state, to_state, action, changed_by, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.logical_topic_id,
    record.from_state,
    record.to_state,
    record.action,
    record.changed_by,
    record.reason,
    record.created_at,
  );
  return record;
}

function listTopicStateChanges(db: SqliteDatabase, logicalTopicId: string, limit = 50): TopicStateChangeRecord[] {
  return db.prepare(`
    SELECT * FROM topic_state_changes
    WHERE logical_topic_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(logicalTopicId, limit) as TopicStateChangeRecord[];
}

function applyTopicStateTransition(
  db: SqliteDatabase,
  logicalTopicId: string,
  fromState: string | null,
  toState: "open" | "done" | "cancelled",
  action: "complete" | "cancel" | "reopen" | "auto_reopen",
  changedBy: string,
  reason: string | null,
  timestamp: string,
): void {
  if (toState === "done") {
    db.prepare(`
      UPDATE logical_topics
      SET task_state = ?, completed_at = ?, completed_by = ?, cancelled_at = NULL, cancelled_by = NULL, updated_at = ?
      WHERE id = ?
    `).run(toState, timestamp, changedBy, timestamp, logicalTopicId);
  } else if (toState === "cancelled") {
    db.prepare(`
      UPDATE logical_topics
      SET task_state = ?, cancelled_at = ?, cancelled_by = ?, completed_at = NULL, completed_by = NULL, updated_at = ?
      WHERE id = ?
    `).run(toState, timestamp, changedBy, timestamp, logicalTopicId);
  } else {
    // reopen → open: clear terminal-state fields
    db.prepare(`
      UPDATE logical_topics
      SET task_state = ?, completed_at = NULL, completed_by = NULL, cancelled_at = NULL, cancelled_by = NULL, updated_at = ?
      WHERE id = ?
    `).run(toState, timestamp, logicalTopicId);
  }
  insertTopicStateChange(db, logicalTopicId, fromState, toState, action, changedBy, reason, timestamp);
}

function transitionTopicState(
  db: SqliteDatabase,
  params: {
    logical_topic_id: string;
    target_state: "open" | "done" | "cancelled";
    changed_by: string;
    reason?: string;
    expected_state?: "open" | "done" | "cancelled";
  },
) {
  const { logical_topic_id, target_state, changed_by, reason, expected_state } = params;

  // Pre-transaction param validation (does not touch DB state).
  if (!changed_by || !changed_by.trim()) {
    throw new Error("changed_by is required and must identify the actor; it must not be inferred from free-form text.");
  }
  if (target_state === "done" || target_state === "cancelled") {
    if (!reason || !reason.trim()) {
      throw new Error(`A reason is required for transitioning to '${target_state}'.`);
    }
  }

  const timestamp = nowIso();
  let updated: LogicalTopicRecord | null = null;
  let appliedAction: "complete" | "cancel" | "reopen" | null = null;

  // All state reads and validation happen inside BEGIN IMMEDIATE to prevent TOCTOU races.
  db.exec("BEGIN IMMEDIATE");
  try {
    const topic = getLogicalTopicById(db, logical_topic_id);
    if (!topic) {
      throw new Error(`logical_topic_id not found: ${logical_topic_id}`);
    }

    const currentState = topic.task_state;
    // Legacy topic with null task_state: treat as 'open' for transition purposes.
    const effectiveCurrent = currentState || "open";

    // Optimistic concurrency check (inside lock so the state can't change between read and write).
    if (expected_state !== undefined && expected_state !== effectiveCurrent) {
      throw new Error(
        `Optimistic concurrency conflict: expected_state='${expected_state}' but actual state is '${effectiveCurrent}'.`,
      );
    }

    // Idempotent: same state, no-op (commit empty transaction).
    if (effectiveCurrent === target_state) {
      db.exec("COMMIT");
      return {
        updated: false,
        idempotent: true,
        logical_topic_id,
        task_state: effectiveCurrent,
        safety_note: SAFETY_NOTE,
      };
    }

    // Validate allowed transition
    const allowed = ALLOWED_TRANSITIONS[effectiveCurrent] || [];
    if (!allowed.includes(target_state)) {
      throw new Error(
        `Illegal transition: '${effectiveCurrent}' → '${target_state}'. Allowed targets from '${effectiveCurrent}': [${allowed.join(", ")}].`,
      );
    }

    const action = transitionAction(effectiveCurrent, target_state);
    if (!action) {
      throw new Error(`No action mapped for transition '${effectiveCurrent}' → '${target_state}'.`);
    }

    applyTopicStateTransition(db, logical_topic_id, currentState, target_state, action, changed_by, reason || null, timestamp);
    db.exec("COMMIT");
    updated = getLogicalTopicById(db, logical_topic_id)!;
    appliedAction = action;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    updated: true,
    idempotent: false,
    logical_topic_id,
    task_state: updated!.task_state,
    completed_at: updated!.completed_at,
    completed_by: updated!.completed_by,
    cancelled_at: updated!.cancelled_at,
    cancelled_by: updated!.cancelled_by,
    action: appliedAction,
    safety_note: SAFETY_NOTE,
  };
}

function resolveTopicRecord(db: SqliteDatabase, params: { project: string; workspace?: string; topic: string }) {
  const workspace = normalizeWorkspace(params.project, params.workspace || null);
  const { canonicalTopic, topicRaw } = resolveCanonicalTopicWithRaw(
    params.project,
    workspace,
    params.topic,
    resolveCanonicalTopic,
  );
  const logicalTopic = getOrCreateLogicalTopic(db, params.project, workspace, canonicalTopic);
  return {
    logical_topic: publicLogicalTopic(logicalTopic),
    canonical_topic: canonicalTopic,
    topic_raw: topicRaw,
    safety_note: SAFETY_NOTE,
  };
}

function toBoardRecord(row: ReturnType<typeof publicRecord>) {
  return {
    id: row.id,
    logicalTopicId: (row as { logical_topic_id?: string | null }).logical_topic_id || null,
    project: row.project,
    workspace: row.workspace,
    topic: row.topic,
    status: row.status,
    sourceAgent: row.source_agent,
    sourceThread: row.source_thread,
    sourceHost: (row as { source_host?: string | null }).source_host ?? null,
    model: (row as { model?: string | null }).model ?? null,
    modelDisplay: (row as { model_display?: string | null }).model_display ?? null,
    createdAt: row.created_at,
    createdAtDisplay: row.created_at_display,
    updatedAt: row.updated_at,
    updatedAtDisplay: row.updated_at_display,
    expiresAt: row.expires_at,
    refs: row.refs,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    conclusion: 'conclusion' in row ? row.conclusion : undefined,
    conclusionPreview: 'conclusion_preview' in row ? row.conclusion_preview : undefined,
    nextAction: 'next_action' in row ? row.next_action : null,
    supersedesId: row.supersedes_id,
  };
}

function getTopicContext(db: SqliteDatabase, logicalTopicId: string) {
  const logicalTopic = getLogicalTopicById(db, logicalTopicId);
  if (!logicalTopic) {
    return {
      found: false,
      logical_topic_id: logicalTopicId,
      safety_note: SAFETY_NOTE,
    };
  }
  const conclusionRows = db.prepare(`
    SELECT * FROM conclusions
    WHERE logical_topic_id = ?
    ORDER BY created_at DESC
  `).all(logicalTopicId).map(normalizeRow);
  const detail = {
    project: logicalTopic.project,
    workspace: logicalTopic.workspace,
    topic: logicalTopic.display_name,
    logicalTopicId,
    task_state: logicalTopic.task_state,
    completed_at: logicalTopic.completed_at,
    completed_by: logicalTopic.completed_by,
    cancelled_at: logicalTopic.cancelled_at,
    cancelled_by: logicalTopic.cancelled_by,
    stateChanges: listTopicStateChanges(db, logicalTopicId, 50),
    rawTopics: Array.from(new Set(conclusionRows.map((row) => row.topic_raw || row.topic))).sort(),
    aliasCount: Array.from(new Set(conclusionRows.map((row) => row.topic_raw || row.topic))).length,
    latest: conclusionRows[0]
      ? toBoardRecord(publicRecord(conclusionRows[0], conclusionRows[0].sensitivity !== 'sensitive'))
      : null,
    records: conclusionRows.map((row) => toBoardRecord(publicRecord(row, row.sensitivity !== 'sensitive'))),
    safetyNote: SAFETY_NOTE,
  };
  const eventsStore = new AgentEventsStore();
  const traceStore = new TraceStoreView();
  try {
    const events = eventsStore.listByLogicalTopic(logicalTopicId, 100);
    const runs = traceStore.listRunsByLogicalTopic(logicalTopicId, 50);
    const traceSummary = traceStore.summaryByLogicalTopic().get(logicalTopicId) || null;
    const eventSummary = eventsStore.summaryByLogicalTopic().get(logicalTopicId) || null;
    const latestExpiresAt = detail.latest?.expiresAt || null;
    const topic = {
      key: logicalTopicId,
      logicalTopicId,
      project: logicalTopic.project,
      workspace: logicalTopic.workspace,
      workspaceKey: logicalTopic.workspace || '_',
      topic: logicalTopic.display_name,
      latestStatus: detail.latest?.status || 'active',
      latestSourceAgent: detail.latest?.sourceAgent || 'unknown',
      latestSourceHost: detail.latest?.sourceHost || null,
      latestUpdatedAt: detail.latest?.updatedAt || logicalTopic.updated_at,
      latestUpdatedAtDisplay: detail.latest?.updatedAtDisplay || formatLocal(logicalTopic.updated_at),
      latestConclusionId: detail.latest?.id || '',
      latestConclusionPreview: null,
      expiresAt: latestExpiresAt,
      isExpired: latestExpiresAt ? Date.parse(latestExpiresAt) <= Date.now() : false,
      hasNextAction: Boolean(detail.latest?.nextAction),
      refsCount: detail.latest?.refs?.length || 0,
      supersedeDepth: detail.records.filter((record) => record.supersedesId).length,
      participantAgents: Array.from(new Set(detail.records.map((record) => record.sourceAgent).filter(Boolean))).sort(),
      participantCount: Array.from(new Set(detail.records.map((record) => record.sourceAgent).filter(Boolean))).length,
      recordCount: detail.records.length,
      rawTopics: detail.rawTopics,
      aliasCount: detail.aliasCount,
      relatedRunIds: traceSummary?.runIds || [],
      relatedRunStatus: traceSummary?.runningRuns ? 'running' : traceSummary?.lastRunStatus || null,
      lastRunAt: traceSummary?.lastRunAt || null,
      lastEventAt: eventSummary?.lastEventAt || null,
      lastEventType: eventSummary?.lastEventType || null,
      blockedCount24h: eventSummary?.blockedCount24h || 0,
      heartbeatCount24h: eventSummary?.heartbeats24h || 0,
      claimCount24h: eventSummary?.claims24h || 0,
    };
    return {
      found: true,
      logical_topic: publicLogicalTopic(logicalTopic),
      ...buildTopicContextModel({ detail, trace: traceSummary, topic, events, runs, timelineFilter: 'all', formatLocal }),
      safety_note: SAFETY_NOTE,
    };
  } finally {
    eventsStore.close();
    traceStore.close();
  }
}

// Validates that the conclusion named by supersedes_id belongs to the same project/workspace
// scope as the current publish request, returning its row (with logical_topic_id) so the
// caller can inherit or cross-check it. Returns undefined (no throw) when the id doesn't
// exist — the FK constraint on conclusions.supersedes_id catches that case at insert time.
function resolvePriorConclusionInScope(
  db: SqliteDatabase,
  supersedesId: string,
  record: { project: string; workspace: string | null }
): { project: string; workspace: string | null; logical_topic_id: string | null } | undefined {
  const priorRow = db.prepare("SELECT project, workspace, logical_topic_id FROM conclusions WHERE id = ?").get(supersedesId) as
    | { project: string; workspace: string | null; logical_topic_id: string | null }
    | undefined;
  if (!priorRow) return undefined;
  const normalizedPriorWorkspace = normalizeWorkspace(priorRow.project, priorRow.workspace);
  if (priorRow.project !== record.project || normalizedPriorWorkspace !== record.workspace) {
    throw new Error(
      `supersedes_id ${supersedesId} belongs to project "${priorRow.project}"` +
      (priorRow.workspace ? ` / workspace "${priorRow.workspace}"` : "") +
      ` and cannot be superseded from project "${record.project}"` +
      (record.workspace ? ` / workspace "${record.workspace}"` : "") +
      `. A conclusion can only supersede a prior conclusion in the same project/workspace scope.`
    );
  }
  return priorRow;
}

function publishConclusion(
  db: SqliteDatabase,
  config: HandoffConfig,
  request: {
    project: string;
    workspace?: string;
    topic: string;
    logical_topic_id?: string;
    conclusion: string;
    next_action?: string;
    refs?: ConclusionRef[];
    source_agent?: string;
    source_thread?: string;
    source_host?: string;
    model?: string;
    supersedes_id?: string;
    expires_at?: string;
    ttl_days?: number;
    confidence?: "low" | "medium" | "high";
    sensitivity: "normal" | "internal" | "sensitive";
    request_id?: string;
    manage_transaction?: boolean;
    write_fallback_file?: boolean;
  },
  hooks?: { afterReceipt?: () => void },
) {
  if (config.secretScanEnabled) assertNoSecrets(request);
  assertCleanConclusion(request.conclusion);
  if (request.expires_at && request.ttl_days) {
    throw new Error("publish_conclusion accepts either expires_at or ttl_days, not both.");
  }

  const mutationHash = request.request_id ? requestHash({ ...request, request_id: undefined }) : null;

  const timestamp = nowIso();
  const workspace = normalizeWorkspace(request.project, request.workspace || null);
  const { canonicalTopic, topicRaw } = resolveCanonicalTopicWithRaw(
    request.project,
    workspace,
    request.topic,
    resolveCanonicalTopic,
  );
  const record: ConclusionRecord = {
    id: randomUUID(),
    project: request.project,
    workspace,
    topic: canonicalTopic,
    topic_raw: topicRaw,
    logical_topic_id: null,
    conclusion: request.conclusion,
    next_action: request.next_action || null,
    refs_json: JSON.stringify(request.refs ?? []),
    source_agent: request.source_agent || null,
    source_thread: request.source_thread || null,
    source_host: request.source_host ? request.source_host.trim().toLowerCase() || null : null,
    model: normalizeModel(request.model),
    model_display: request.model?.trim() || null,
    created_at: timestamp,
    updated_at: timestamp,
    expires_at: request.expires_at || (request.ttl_days ? isoAfterDays(timestamp, request.ttl_days) : null),
    supersedes_id: request.supersedes_id || null,
    superseded_reason: null,
    changed_by: null,
    status: "active",
    confidence: request.confidence || null,
    sensitivity: request.sensitivity,
  };
  const fallback_file = join(config.filesDir, `${record.id}.json`);

  let continuationCandidates: Array<{ id: string; topic: string; created_at: string }> = [];

  const manageTransaction = request.manage_transaction !== false;
  let transactionCommitted = false;
  if (manageTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    if (request.request_id && mutationHash) {
      const previous = readMutationReceipt(db, request.request_id, "publish_conclusion", mutationHash);
      if (previous) {
        if (manageTransaction) db.exec("COMMIT");
        return previous;
      }
      hooks?.afterReceipt?.();
    }
    if (request.logical_topic_id) {
      const logicalTopic = getLogicalTopicById(db, request.logical_topic_id);
      if (!logicalTopic) throw new Error(`logical_topic_id not found: ${request.logical_topic_id}`);
      const normalizedTopicWorkspace = normalizeWorkspace(logicalTopic.project, logicalTopic.workspace);
      if (logicalTopic.project !== record.project || normalizedTopicWorkspace !== record.workspace) {
        throw new Error(
          `logical_topic_id ${request.logical_topic_id} belongs to project "${logicalTopic.project}"` +
          (logicalTopic.workspace ? ` / workspace "${logicalTopic.workspace}"` : "") +
          ` and cannot be reused from project "${record.project}"` +
          (record.workspace ? ` / workspace "${record.workspace}"` : "") +
          `. Pass the matching project/workspace, or omit logical_topic_id to resolve one from topic instead.`
        );
      }
      if (record.supersedes_id) {
        // Both logical_topic_id and supersedes_id were given: the unconditional supersede
        // write further down (after insertConclusion) always fires off record.supersedes_id
        // regardless of which branch resolves logical_topic_id, so supersedes_id must be
        // validated here too — otherwise a mismatched or cross-project id would still get
        // silently marked superseded even though this branch never looked at it.
        const priorRow = resolvePriorConclusionInScope(db, record.supersedes_id, record);
        if (priorRow && priorRow.logical_topic_id !== logicalTopic.id) {
          throw new Error(
            `supersedes_id ${record.supersedes_id} belongs to logical topic ${priorRow.logical_topic_id}, ` +
            `but logical_topic_id ${request.logical_topic_id} names a different logical topic. ` +
            `They must refer to the same thread — pass only one of supersedes_id/logical_topic_id, or correct the mismatch.`
          );
        }
      }
      record.logical_topic_id = logicalTopic.id;
    } else if (record.supersedes_id) {
      // supersedes_id names the exact prior conclusion this continues, which is a stronger
      // signal than the topic string: inherit its logical topic so a differently-worded
      // topic on this round can't fork the thread into a second logical topic. The FK on
      // supersedes_id guarantees the prior row exists by the time insertConclusion runs.
      const priorRow = resolvePriorConclusionInScope(db, record.supersedes_id, record);
      record.logical_topic_id = priorRow?.logical_topic_id
        || getOrCreateLogicalTopic(db, record.project, record.workspace, record.topic, timestamp).id;
    } else {
      const resolvedLogicalTopic = getOrCreateLogicalTopic(db, record.project, record.workspace, record.topic, timestamp);
      record.logical_topic_id = resolvedLogicalTopic.id;
      // Neither supersedes_id nor logical_topic_id was given, and this call minted a brand
      // new logical topic (created_at === this publish's timestamp). That's the exact shape
      // of a missed continuation: check for other recently-active conclusions in the same
      // project/workspace scope so the caller can decide whether to republish with
      // supersedes_id instead. Read-only surfacing only — never auto-merge on similarity.
      if (resolvedLogicalTopic.created_at === timestamp) {
        // Short window (2h), not 24h: a busy shared project accumulates many genuinely
        // unrelated topics per day, and a wide window would make this fire on nearly
        // every publish. 2h targets "still the same working session, likely forgot to
        // carry the anchor forward" while staying quiet for unrelated same-day work.
        const recentCutoff = new Date(new Date(timestamp).getTime() - 2 * 60 * 60 * 1000).toISOString();
        continuationCandidates = db.prepare(`
          SELECT id, topic, created_at FROM conclusions
          WHERE project = ? AND coalesce(workspace, '') = coalesce(?, '') AND status = 'active'
            AND logical_topic_id != ? AND created_at >= ?
            AND (expires_at IS NULL OR unixepoch(expires_at) > unixepoch(?))
          ORDER BY created_at DESC
          LIMIT 2
        `).all(record.project, record.workspace, resolvedLogicalTopic.id, recentCutoff, timestamp) as Array<{ id: string; topic: string; created_at: string }>;
      }
    }

    // Design §7: publishing a new handoff to a done/cancelled topic auto-reopens it.
    // Legacy topics with null task_state are lazily initialized to 'open'.
    const currentTopic = getLogicalTopicById(db, record.logical_topic_id!);
    if (currentTopic) {
      if (currentTopic.task_state === "done" || currentTopic.task_state === "cancelled") {
        applyTopicStateTransition(
          db,
          currentTopic.id,
          currentTopic.task_state,
          "open",
          "auto_reopen",
          record.source_agent || "system",
          `Auto-reopened by new handoff ${record.id}`,
          timestamp,
        );
      } else if (currentTopic.task_state === null) {
        db.prepare("UPDATE logical_topics SET task_state = 'open', updated_at = ? WHERE id = ?").run(timestamp, currentTopic.id);
      }
    }

    insertConclusion(db, record);
    if (record.supersedes_id) {
      db.prepare("UPDATE conclusions SET status = 'superseded', updated_at = ? WHERE id = ?").run(timestamp, record.supersedes_id);
    }
  const publishedTopic = getLogicalTopicById(db, record.logical_topic_id!);

  let warning: string | null = null;
  if (!record.source_agent) {
    warning =
      "source_agent is missing — stored as null. Pass the install.sh platform ID (e.g. claude-code, codex, codebuddy, trae, trae-ide, trae-cli); model names do not belong here.";
  } else if (!KNOWN_PLATFORM_IDS.has(record.source_agent)) {
    warning = `unknown source_agent '${record.source_agent}' — expected an install.sh platform ID (e.g. claude-code, codex, codebuddy, trae, trae-ide, trae-cli); model names do not belong here`;
  }
  if (!record.source_host) {
    const hostNote =
      "source_host is missing — stored as null. If your platform has no deterministic host signal, omission is correct — do NOT guess a value.";
    warning = warning ? `${warning}; ${hostNote}` : hostNote;
  }
  if (continuationCandidates.length > 0) {
    const candidateList = continuationCandidates
      .map((c) => `${c.id} (topic "${c.topic}", ${c.created_at})`)
      .join("; ");
    const continuationNote =
      `no supersedes_id/logical_topic_id was given, so a new logical topic was created for "${record.topic}". ` +
      `Recently active conclusions in this project/workspace may be the same task: ${candidateList}. ` +
      `If this round continues one of them, republish with supersedes_id set to the right id — this is informational only, nothing was auto-merged.`;
    warning = warning ? `${warning}; ${continuationNote}` : continuationNote;
  }
  const missingSections = HANDOFF_SECTION_PATTERNS
    .filter(({ pattern }) => !pattern.test(record.conclusion))
    .map(({ name }) => name);
  if (missingSections.length > 0) {
    const sectionNote =
      `conclusion is missing recommended handoff sections: ${missingSections.join(", ")}. ` +
      "Use Status, Done, Blocked, and Risks/Pitfalls headings; this is a non-blocking reminder.";
    warning = warning ? `${warning}; ${sectionNote}` : sectionNote;
  }

  const response = {
    id: record.id,
    project: record.project,
    workspace: record.workspace,
    topic: publishedTopic?.display_name || record.topic,
    logical_topic_id: record.logical_topic_id,
    status: record.status,
    created_at: record.created_at,
    fallback_file,
    warning,
    safety_note: SAFETY_NOTE,
  };
  if (request.request_id && mutationHash) {
    db.prepare("INSERT OR IGNORE INTO mutation_receipts (request_id, operation, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(request.request_id, "publish_conclusion", mutationHash, JSON.stringify(response), nowIso());
  }
  if (manageTransaction) {
    db.exec("COMMIT");
    transactionCommitted = true;
  }
  if (request.write_fallback_file !== false) writeFallbackFile(config, record);
  return response;
  } catch (error) {
    if (manageTransaction && !transactionCommitted) db.exec("ROLLBACK");
    throw error;
  }
}

function listConclusions(
  db: SqliteDatabase,
  limit: number,
  includeSensitiveDetails: boolean,
  filters: {
    id?: string;
    project?: string;
    workspace?: string;
    topic?: string;
    search?: string;
    since?: string;
    status?: "active" | "superseded" | "archived";
  }
) {
  const where: string[] = [];
  const values: unknown[] = [];
  const requestedTopic = filters.topic || "";

  for (const [column, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    if (column === "since") {
      where.push("created_at >= ?");
    } else if (column === "search") {
      const pattern = `%${escapeSqlLike(String(value))}%`;
      where.push("(topic LIKE ? ESCAPE '\\' OR coalesce(topic_raw, '') LIKE ? ESCAPE '\\' OR conclusion LIKE ? ESCAPE '\\')");
      values.push(pattern, pattern, pattern);
      continue;
    } else if (column === "topic") {
      continue;
    } else {
      where.push(`${column} = ?`);
    }
    values.push(value);
  }

  const sql = `
    SELECT * FROM conclusions
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT ?
  `;
  let rows = db.prepare(sql).all(...values, limit).map(normalizeRow);
  if (requestedTopic) {
    rows = rows.filter((row) => topicBelongsToCanonical(
      row.project,
      row.workspace,
      row.topic,
      requestedTopic,
      resolveCanonicalTopic,
    ));
  }

  return {
    count: rows.length,
    limit,
    items: rows.map((row) => publicRecord(row, row.sensitivity !== "sensitive" || includeSensitiveDetails)),
    safety_note: SAFETY_NOTE,
  };
}

function supersedeConclusion(
  db: SqliteDatabase,
  config: HandoffConfig,
  params: { id: string; replacement_id?: string; reason?: string }
) {
  const { id, replacement_id, reason } = params;
  if (replacement_id && replacement_id === id) {
    throw new Error("replacement_id must be different from id.");
  }

  const currentRow = db.prepare("SELECT * FROM conclusions WHERE id = ?").get(id);
  if (!currentRow) {
    return {
      updated: false,
      reason: `Conclusion not found: ${id}`,
      safety_note: SAFETY_NOTE,
    };
  }

  let replacementRow: Record<string, unknown> | undefined;
  if (replacement_id) {
    replacementRow = db.prepare("SELECT * FROM conclusions WHERE id = ?").get(replacement_id);
    if (!replacementRow) {
      return {
        updated: false,
        reason: `Replacement conclusion not found: ${replacement_id}`,
        safety_note: SAFETY_NOTE,
      };
    }
  }

  const timestamp = nowIso();
  const nextStatus = replacement_id ? "superseded" : "archived";
  db.prepare("UPDATE conclusions SET status = ?, updated_at = ?, superseded_reason = ? WHERE id = ?").run(nextStatus, timestamp, reason || null, id);

  const updatedRow = normalizeRow(db.prepare("SELECT * FROM conclusions WHERE id = ?").get(id) ?? currentRow);
  writeFallbackFile(config, updatedRow);

  return {
    updated: true,
    id,
    status: nextStatus,
    replacement_id: replacement_id || null,
    reason: reason || null,
    updated_record: publicRecord(updatedRow, updatedRow.sensitivity !== "sensitive"),
    replacement_record: replacementRow ? publicRecord(normalizeRow(replacementRow), normalizeRow(replacementRow).sensitivity !== "sensitive") : null,
    safety_note: SAFETY_NOTE,
  };
}

function createReviewCase(
  db: SqliteDatabase,
  request: { project: string; workspace?: string; topic: string; baseline_conclusion_id: string; request_id: string } & ReviewTaskMaterial,
  hooks?: { afterReceipt?: () => void },
) {
  const hash = requestHash({ ...request, request_id: undefined });
  db.exec("BEGIN IMMEDIATE");
  try {
    const previous = readMutationReceipt(db, request.request_id, "create_review_case", hash);
    if (previous) {
      db.exec("COMMIT");
      return previous;
    }
    hooks?.afterReceipt?.();
    const workspace = normalizeWorkspace(request.project, request.workspace || null);
    const baseline = db.prepare("SELECT * FROM conclusions WHERE id = ? AND project = ? AND coalesce(workspace, '') = coalesce(?, '')")
      .get(request.baseline_conclusion_id, request.project, workspace) as Record<string, unknown> | undefined;
    if (!baseline) throw new Error("baseline_conclusion_id was not found in the requested project/workspace scope.");
    const { canonicalTopic } = resolveCanonicalTopicWithRaw(request.project, workspace, request.topic, resolveCanonicalTopic);
    if (baseline.topic !== canonicalTopic) {
      throw new Error(`baseline_conclusion_id belongs to topic "${baseline.topic}", not review topic "${canonicalTopic}".`);
    }
    const timestamp = nowIso();
    const reviewCase: ReviewCaseRecord = {
      id: randomUUID(),
      project: request.project,
      workspace,
      topic: canonicalTopic,
      baseline_conclusion_id: request.baseline_conclusion_id,
      status: "open",
      created_at: timestamp,
      updated_at: timestamp,
      objective: request.objective,
      scope: request.scope,
      acceptance_criteria_json: JSON.stringify(request.acceptance_criteria),
      snapshot_ref: request.snapshot_ref,
      refs_json: JSON.stringify(request.refs ?? []),
      constraints_json: JSON.stringify(request.constraints ?? []),
    };
    db.prepare(`INSERT INTO review_cases (id, project, workspace, topic, baseline_conclusion_id, status, created_at, updated_at, objective, scope, acceptance_criteria_json, snapshot_ref, refs_json, constraints_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(reviewCase.id, reviewCase.project, reviewCase.workspace, reviewCase.topic, reviewCase.baseline_conclusion_id, reviewCase.status, timestamp, timestamp, reviewCase.objective, reviewCase.scope, reviewCase.acceptance_criteria_json, reviewCase.snapshot_ref, reviewCase.refs_json, reviewCase.constraints_json);
    const response = {
      created: true,
      review_case_id: reviewCase.id,
      project: reviewCase.project,
      workspace: reviewCase.workspace,
      topic: reviewCase.topic,
      status: reviewCase.status,
      safety_note: SAFETY_NOTE,
    };
    writeMutationReceipt(db, request.request_id, "create_review_case", hash, response);
    db.exec("COMMIT");
    return response;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getReviewPacket(db: SqliteDatabase, reviewCaseId: string) {
  const reviewCase = db.prepare("SELECT id, project, workspace, topic, status, lifecycle_status, created_at, updated_at, objective, scope, acceptance_criteria_json, snapshot_ref, refs_json, constraints_json FROM review_cases WHERE id = ?")
    .get(reviewCaseId) as Record<string, unknown> | undefined;
  if (!reviewCase) return { found: false, review_case_id: reviewCaseId, safety_note: SAFETY_NOTE };
  const status = reviewCase.lifecycle_status || reviewCase.status;
  return {
    found: true,
    review_case_id: reviewCase.id,
    project: reviewCase.project,
    workspace: reviewCase.workspace,
    topic: reviewCase.topic,
    status,
    created_at: reviewCase.created_at,
    updated_at: reviewCase.updated_at,
    task_material: {
      objective: reviewCase.objective,
      scope: reviewCase.scope,
      acceptance_criteria: JSON.parse(String(reviewCase.acceptance_criteria_json || "[]")),
      snapshot_ref: reviewCase.snapshot_ref,
      refs: JSON.parse(String(reviewCase.refs_json || "[]")),
      constraints: JSON.parse(String(reviewCase.constraints_json || "[]")),
    },
    instructions: status === "open"
      ? "Assess the referenced work independently. The baseline is intentionally withheld until this assessment is durably submitted."
      : `This review case is ${status}; the baseline remains withheld and no new assessment may be submitted. An authorized engineer must transition the case or create a new review case as appropriate.`,
    safety_note: SAFETY_NOTE,
  };
}

function effectiveReviewCaseStatus(reviewCase: ReviewCaseRecord): ReviewCaseStatus {
  return reviewCase.lifecycle_status || reviewCase.status;
}

function listReviewCases(
  db: SqliteDatabase,
  request: { project: string; workspace?: string; topic?: string; status?: ReviewCaseStatus; limit: number },
) {
  const workspace = normalizeWorkspace(request.project, request.workspace || null);
  const workspaceScope = request.workspace !== undefined
    ? "explicit"
    : isCanonicalWorkspaceProject(request.project)
      ? "canonical"
      : "all";
  const where = ["project = ?"];
  const values: unknown[] = [request.project];
  if (request.workspace !== undefined || isCanonicalWorkspaceProject(request.project)) {
    where.push("coalesce(workspace, '') = coalesce(?, '')");
    values.push(workspace);
  }
  let canonicalTopic: string | undefined;
  if (request.topic) {
    canonicalTopic = resolveCanonicalTopicWithRaw(request.project, workspace, request.topic, resolveCanonicalTopic).canonicalTopic;
    where.push("topic = ?");
    values.push(canonicalTopic);
  }
  if (request.status) {
    where.push("lifecycle_status = ?");
    values.push(request.status);
  }

  const rows = db.prepare(`
    SELECT id, project, workspace, topic, lifecycle_status, created_at, updated_at
    FROM review_cases
    WHERE ${where.join(" AND ")}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `).all(...values, request.limit) as Array<Record<string, unknown>>;

  return {
    found: rows.length > 0,
    count: rows.length,
    project: request.project,
    workspace,
    workspace_scope: workspaceScope,
    topic: canonicalTopic || null,
    cases: rows.map((row) => ({
      review_case_id: row.id,
      project: row.project,
      workspace: row.workspace,
      topic: row.topic,
      status: row.lifecycle_status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      baseline_withheld: true,
      safety_note: SAFETY_NOTE,
    })),
    safety_note: SAFETY_NOTE,
  };
}

function transitionReviewCase(
  db: SqliteDatabase,
  request: {
    review_case_id: string;
    target_status: "open" | "closed" | "cancelled" | "archived";
    changed_by: string;
    reason: string;
    expected_status?: ReviewCaseStatus;
    request_id: string;
  },
  hooks?: { afterReceipt?: () => void },
) {
  const hash = requestHash({ ...request, request_id: undefined });
  const timestamp = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const previous = readMutationReceipt(db, request.request_id, "transition_review_case", hash);
    if (previous) {
      db.exec("COMMIT");
      return previous;
    }
    hooks?.afterReceipt?.();
    const reviewCase = db.prepare("SELECT * FROM review_cases WHERE id = ?").get(request.review_case_id) as ReviewCaseRecord | undefined;
    if (!reviewCase) throw new Error(`review_case_id not found: ${request.review_case_id}`);
    const currentStatus = effectiveReviewCaseStatus(reviewCase);
    if (request.expected_status && request.expected_status !== currentStatus) {
      throw new Error(`Expected review case status ${request.expected_status}, but current status is ${currentStatus}.`);
    }
    if (!request.reason.trim()) throw new Error("reason is required when transitioning a review case.");
    if (request.target_status === "open" && (reviewCase.status !== "open" || reviewCase.lifecycle_status !== "open")) {
      const hasAssessment = Boolean(db.prepare("SELECT id FROM review_assessments WHERE review_case_id = ?").get(request.review_case_id));
      const hasComparison = Boolean(db.prepare("SELECT id FROM review_comparisons WHERE review_case_id = ?").get(request.review_case_id));
      if (hasAssessment || hasComparison) {
        throw new Error("Completed review cases cannot be reopened; create a new review case for another assessment.");
      }
    }
    const allowed = request.target_status === "cancelled"
      ? ["open", "assessed", "compared"]
      : request.target_status === "closed"
        ? ["open", "assessed", "compared"]
        : request.target_status === "archived"
          ? ["open", "assessed", "compared", "closed", "cancelled"]
          : ["closed", "cancelled", "archived"];
    if (!allowed.includes(currentStatus)) {
      throw new Error(`Cannot transition review case from ${currentStatus} to ${request.target_status}.`);
    }
    db.prepare("UPDATE review_cases SET lifecycle_status = ?, lifecycle_changed_by = ?, lifecycle_reason = ?, updated_at = ? WHERE id = ?")
      .run(request.target_status, request.changed_by, request.reason, timestamp, request.review_case_id);
    const response = {
      updated: true,
      idempotent: false,
      review_case_id: request.review_case_id,
      previous_status: currentStatus,
      status: request.target_status,
      changed_by: request.changed_by,
      reason: request.reason,
      safety_note: SAFETY_NOTE,
    };
    writeMutationReceipt(db, request.request_id, "transition_review_case", hash, response);
    db.exec("COMMIT");
    return response;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function submitIndependentAssessment(
  db: SqliteDatabase,
  config: HandoffConfig,
  request: { review_case_id: string; reviewer_agent: string; assessment: string; refs?: ConclusionRef[]; request_id: string },
  hooks?: { afterReceipt?: () => void },
) {
  const hash = requestHash({ ...request, request_id: undefined });
  if (config.secretScanEnabled) assertNoSecrets(request);
  assertCleanConclusion(request.assessment);
  const timestamp = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const previous = readMutationReceipt(db, request.request_id, "submit_independent_assessment", hash);
    if (previous) {
      db.exec("COMMIT");
      return previous;
    }
    hooks?.afterReceipt?.();
    const reviewCase = db.prepare("SELECT * FROM review_cases WHERE id = ?").get(request.review_case_id) as ReviewCaseRecord | undefined;
    if (!reviewCase) throw new Error(`review_case_id not found: ${request.review_case_id}`);
    if (effectiveReviewCaseStatus(reviewCase) !== "open") {
      throw new Error(`Review case is ${effectiveReviewCaseStatus(reviewCase)}; only open cases accept an assessment.`);
    }
    const existing = db.prepare("SELECT id FROM review_assessments WHERE review_case_id = ?").get(request.review_case_id);
    if (existing) throw new Error("This review case already has an assessment; use the original request_id to retry idempotently.");
    const assessmentId = randomUUID();
    db.prepare(`INSERT INTO review_assessments (id, review_case_id, reviewer_agent, assessment, refs_json, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(assessmentId, request.review_case_id, request.reviewer_agent, request.assessment, JSON.stringify(request.refs || []), request.request_id, timestamp);
    db.prepare("UPDATE review_cases SET status = 'assessed', lifecycle_status = 'assessed', updated_at = ? WHERE id = ?").run(timestamp, request.review_case_id);
    const baseline = db.prepare("SELECT * FROM conclusions WHERE id = ?").get(reviewCase.baseline_conclusion_id) as Record<string, unknown>;
    const response = {
      submitted: true,
      idempotent: false,
      review_case_id: request.review_case_id,
      assessment_id: assessmentId,
      baseline: publicRecord(normalizeRow(baseline), normalizeRow(baseline).sensitivity !== "sensitive"),
      safety_note: SAFETY_NOTE,
    };
    writeMutationReceipt(db, request.request_id, "submit_independent_assessment", hash, response);
    db.exec("COMMIT");
    return response;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function publishReviewComparison(
  db: SqliteDatabase,
  config: HandoffConfig,
  request: StructuredComparison & {
    review_case_id: string;
    comparison: string;
    source_agent?: string;
    source_thread?: string;
    source_host?: string;
    model?: string;
    refs?: ConclusionRef[];
    supersedes_id?: string;
    logical_topic_id?: string;
    request_id: string;
  },
  hooks?: { afterReceipt?: () => void },
) {
  const hash = requestHash({ ...request, request_id: undefined });
  assertCleanConclusion(request.comparison);
  const timestamp = nowIso();
  let response: {
    published: boolean;
    idempotent: boolean;
    topic: string;
    handoff_id: string;
    review_case_id: string;
    next_mode: "none" | "continue" | "independent_review";
    comparison: Record<string, unknown>;
    structured_comparison: StructuredComparison;
    comparison_record_id: string | null;
    safety_note: string;
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    const previous = readMutationReceipt(db, request.request_id, "publish_review_comparison", hash);
    if (previous) {
      db.exec("COMMIT");
      return previous;
    }
    hooks?.afterReceipt?.();
    const reviewCase = db.prepare("SELECT * FROM review_cases WHERE id = ?").get(request.review_case_id) as ReviewCaseRecord | undefined;
    if (!reviewCase) throw new Error(`review_case_id not found: ${request.review_case_id}`);
    const reviewCaseStatus = effectiveReviewCaseStatus(reviewCase);
    if (reviewCaseStatus === "compared") {
      throw new Error("Review case is compared; a comparison has already been published.");
    }
    if (reviewCaseStatus === "closed" || reviewCaseStatus === "cancelled" || reviewCaseStatus === "archived") {
      throw new Error(`Review case is ${reviewCaseStatus}; it cannot publish a comparison.`);
    }
    if (reviewCaseStatus !== "assessed") throw new Error("A durable independent assessment is required before publishing comparison.");
    const assessment = db.prepare("SELECT * FROM review_assessments WHERE review_case_id = ?").get(request.review_case_id) as Record<string, unknown> | undefined;
    if (!assessment) throw new Error("A durable independent assessment is required before publishing comparison.");
    const comparison = publishConclusion(db, config, {
      project: reviewCase.project,
      workspace: reviewCase.workspace || undefined,
      topic: reviewCase.topic,
      conclusion: request.comparison,
      refs: request.refs || [],
      source_agent: request.source_agent,
      source_thread: request.source_thread,
      source_host: request.source_host,
      model: request.model,
      supersedes_id: request.supersedes_id,
      logical_topic_id: request.logical_topic_id,
      sensitivity: "normal",
      manage_transaction: false,
      write_fallback_file: false,
    });
    db.prepare("UPDATE review_cases SET status = 'compared', lifecycle_status = 'compared', updated_at = ? WHERE id = ?").run(timestamp, request.review_case_id);
    response = {
      published: true,
      idempotent: false,
      topic: reviewCase.topic,
      handoff_id: comparison.id,
      review_case_id: request.review_case_id,
      next_mode: "none" as const,
      comparison,
      structured_comparison: {
        agreements: request.agreements,
        author_only: request.author_only,
        reviewer_only: request.reviewer_only,
        disagreements: request.disagreements,
        evidence_gaps: request.evidence_gaps,
        final_recommendation: request.final_recommendation,
      },
      comparison_record_id: null as string | null,
      safety_note: SAFETY_NOTE,
    };
    const comparisonId = randomUUID();
    db.prepare(`
      INSERT INTO review_comparisons
        (id, review_case_id, assessment_id, conclusion_id, agreements_json, author_only_json, reviewer_only_json, disagreements_json, evidence_gaps_json, final_recommendation, request_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      comparisonId,
      request.review_case_id,
      assessment.id,
      comparison.id,
      JSON.stringify(request.agreements),
      JSON.stringify(request.author_only),
      JSON.stringify(request.reviewer_only),
      JSON.stringify(request.disagreements),
      JSON.stringify(request.evidence_gaps),
      request.final_recommendation,
      request.request_id,
      timestamp,
    );
    response.comparison_record_id = comparisonId;
    writeMutationReceipt(db, request.request_id, "publish_review_comparison", hash, response);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const comparisonRow = db.prepare("SELECT * FROM conclusions WHERE id = ?").get(response.comparison.id);
  if (comparisonRow) writeFallbackFile(config, normalizeRow(comparisonRow));
  return response;
}

type ReviewReadyImplementationRequest = {
  project: string;
  workspace?: string;
  topic: string;
  conclusion: string;
  next_action?: string;
  refs?: ConclusionRef[];
  source_agent?: string;
  source_thread?: string;
  source_host?: string;
  model?: string;
  supersedes_id?: string;
  logical_topic_id?: string;
  expires_at?: string;
  ttl_days?: number;
  confidence?: "low" | "medium" | "high";
  sensitivity: "normal" | "internal" | "sensitive";
  implementation_request_id: string;
  create_request_id: string;
  objective: string;
  scope: string;
  acceptance_criteria: string[];
  snapshot_ref: string;
  constraints: string[];
};

function publishReviewReadyImplementation(
  db: SqliteDatabase,
  config: HandoffConfig,
  request: ReviewReadyImplementationRequest,
  hooks?: { afterReceipt?: () => void },
) {
  const implementation = publishConclusion(db, config, {
    ...request,
    request_id: request.implementation_request_id,
  }, hooks);

  try {
    const reviewCase = createReviewCase(db, {
      project: request.project,
      workspace: request.workspace,
      topic: request.topic,
      baseline_conclusion_id: implementation.id,
      request_id: request.create_request_id,
      objective: request.objective,
      scope: request.scope,
      acceptance_criteria: request.acceptance_criteria,
      snapshot_ref: request.snapshot_ref,
      refs: request.refs || [],
      constraints: request.constraints,
    }, hooks);
    return {
      topic: request.topic,
      handoff_id: implementation.id,
      implementation_handoff_id: implementation.id,
      review_case_id: reviewCase.review_case_id,
      next_mode: "independent_review" as const,
      partial_success: false,
      safety_note: SAFETY_NOTE,
    };
  } catch (error) {
    return {
      topic: request.topic,
      handoff_id: implementation.id,
      implementation_handoff_id: implementation.id,
      review_case_id: null,
      next_mode: "none" as const,
      partial_success: true,
      review_case_request_id: request.create_request_id,
      review_case_error: error instanceof Error ? error.message : String(error),
      safety_note: SAFETY_NOTE,
    };
  }
}

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
