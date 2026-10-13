import { randomUUID } from "node:crypto";
import { join } from "node:path";
// @ts-ignore repo-local shared runtime module
import { resolveCanonicalTopicWithRaw, topicBelongsToCanonical } from "../../shared/topic-canonicalization/index.mjs";
// @ts-ignore repo-local shared runtime module
import { normalizeWorkspace } from "../../shared/workspace-normalization/index.mjs";
// @ts-ignore repo-local shared runtime module
import { buildTopicContextModel } from "../../shared/topic-context/index.mjs";
// @ts-ignore repo-local runtime module
import { AgentEventsStore } from "../../agent-events/src/store.mjs";
// @ts-ignore repo-local runtime module
import { TraceStoreView } from "../../board/src/trace-store-view.mjs";
import type { ConclusionRecord, ConclusionRef, HandoffConfig, SqliteDatabase } from "./types.js";
import { KNOWN_PLATFORM_IDS, SAFETY_NOTE, HANDOFF_SECTION_PATTERNS } from "./constants.js";
import { escapeSqlLike, formatLocal, isoAfterDays, normalizeModel, normalizeRow, nowIso, preview, publicRecord, readMutationReceipt, requestHash, writeMutationReceipt } from "./util.js";
import { assertNoSecrets, assertCleanConclusion } from "./secret-scan.js";
import { writeFallbackFile } from "./db.js";
import { applyTopicStateTransition, findLogicalTopicByIdentity, getLogicalTopicById, getOrCreateLogicalTopic, listTopicStateChanges, publicLogicalTopic, resolveCanonicalTopic } from "./topics.js";

export function insertConclusion(db: SqliteDatabase, record: ConclusionRecord): void {
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

export function toBoardRecord(row: ReturnType<typeof publicRecord>) {
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

export function getTopicContext(db: SqliteDatabase, logicalTopicId: string) {
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
export function resolvePriorConclusionInScope(
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

export function publishConclusion(
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

export function listConclusions(
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

export function supersedeConclusion(
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
