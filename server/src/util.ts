import { createHash, randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ConclusionRef, ConclusionRecord, HandoffConfig, SqliteDatabase } from "./types.js";
import { SAFETY_NOTE } from "./constants.js";

export const DEFAULT_HOME = join(homedir(), ".agent-handoff");

export function usableEnvValue(value: string | undefined): string {
  if (!value) return "";
  return /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) ? "" : value;
}

export function envFlag(name: string, fallback: boolean): boolean {
  const value = usableEnvValue(process.env[name]).trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value);
}

export function buildConfig(): HandoffConfig {
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

export function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function normalizeModel(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  // Strip provider prefix: take the segment after the LAST '/' before folding.
  // e.g. "openai/gpt-5.5" → "gpt-5.5" → "gpt-5-5"
  const afterSlash = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  const normalized = afterSlash.replace(/[\s._]+/g, "-");
  return normalized || null;
}

export function probeWriteable(config: HandoffConfig): boolean {
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

export function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoAfterDays(baseIso: string, days: number): string {
  const date = new Date(baseIso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

// Timestamps are stored and compared in UTC (toISOString / SQLite unixepoch) so
// ordering and expiry math stay correct across machines and DST. For human
// display we additionally render the local zone. Resolution order:
// AGENT_HANDOFF_TZ, then TZ, then the OS default (the server runs on the user's
// machine, so this is the user's zone). The UTC `*_at` fields stay canonical.
export function resolveTimeZone(): string | undefined {
  const explicit = usableEnvValue(process.env.AGENT_HANDOFF_TZ) || usableEnvValue(process.env.TZ);
  if (explicit) return explicit;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export const TIME_ZONE = resolveTimeZone();

export function formatLocal(iso: string | null): string | null {
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

export function relativeTime(iso: string | null, nowMs: number = Date.now()): string | null {
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

export function parseRefs(value: string): ConclusionRef[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizeRow(row: Record<string, unknown>): ConclusionRecord {
  return row as unknown as ConclusionRecord;
}

export function publicRecord(row: ConclusionRecord, includeBody = true) {
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

export function preview(value: string, max = 240): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}...` : compact;
}

export function backupTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function readMutationReceipt(db: SqliteDatabase, requestId: string, operation: string, hash: string): any {
  const row = db.prepare("SELECT operation, request_hash, response_json FROM mutation_receipts WHERE request_id = ?").get(requestId) as
    | { operation: string; request_hash: string; response_json: string }
    | undefined;
  if (!row) return null;
  if (row.operation !== operation || row.request_hash !== hash) {
    throw new Error(`request_id ${requestId} was already used for a different ${operation} request.`);
  }
  return JSON.parse(row.response_json);
}

export function writeMutationReceipt(db: SqliteDatabase, requestId: string, operation: string, hash: string, response: unknown): void {
  db.prepare(`
    INSERT INTO mutation_receipts (request_id, operation, request_hash, response_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(requestId, operation, hash, JSON.stringify(response), nowIso());
}
