import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConclusionRecord, HandoffConfig, SqliteDatabase } from "./types.js";
import { buildConfig, normalizeModel, nowIso, backupTimestamp, quoteSqlString, publicRecord } from "./util.js";

export const SCHEMA_VERSION = 15;

export function columnExists(db: SqliteDatabase, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}

export async function openDatabase(config: HandoffConfig): Promise<SqliteDatabase> {
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

export function applyMigrations(db: SqliteDatabase): void {
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

export function registerCloseHandlers(): void {
  if (_closeHandlersRegistered) return;
  _closeHandlersRegistered = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      try { _db?.close(); } catch { /* ignore */ }
      process.exit(0);
    });
  }
}

export async function initializeDatabase(): Promise<{ db: SqliteDatabase; config: HandoffConfig }> {
  const config = buildConfig();
  const db = await openDatabase(config);
  _db = db;
  _config = config;
  registerCloseHandlers();
  return { db, config };
}

export async function getDatabase(): Promise<{ db: SqliteDatabase; config: HandoffConfig }> {
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

export function resetDatabaseForTests(): void {
  try {
    _db?.close();
  } catch {
    // ignore close errors in test cleanup
  }
  _db = null;
  _config = null;
  _dbPromise = null;
}

export async function withDatabase<T>(fn: (db: SqliteDatabase, config: HandoffConfig) => T | Promise<T>): Promise<T> {
  const { db, config } = await getDatabase();
  return fn(db, config);
}

export function writeFallbackFile(config: HandoffConfig, record: ConclusionRecord): string {
  mkdirSync(config.filesDir, { recursive: true });
  const filePath = join(config.filesDir, `${record.id}.json`);
  writeFileSync(filePath, JSON.stringify(publicRecord(record), null, 2) + "\n", { mode: 0o600 });
  return filePath;
}

export function backupStorage(db: SqliteDatabase, config: HandoffConfig, label?: string) {
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
