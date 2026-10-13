import { randomUUID } from "node:crypto";
// @ts-ignore repo-local shared runtime module
import { resolveCanonicalTopicWithRaw } from "../../shared/topic-canonicalization/index.mjs";
// @ts-ignore repo-local shared runtime module
import { isCanonicalWorkspaceProject, normalizeWorkspace } from "../../shared/workspace-normalization/index.mjs";
import type { ConclusionRecord, ConclusionRef, HandoffConfig, ReviewCaseRecord, ReviewCaseStatus, ReviewTaskMaterial, SqliteDatabase, StructuredComparison } from "./types.js";
import { SAFETY_NOTE } from "./constants.js";
import { escapeSqlLike, formatLocal, nowIso, normalizeRow, preview, publicRecord, readMutationReceipt, requestHash, writeMutationReceipt } from "./util.js";
import { assertNoSecrets, assertCleanConclusion } from "./secret-scan.js";
import { writeFallbackFile } from "./db.js";
import { resolveCanonicalTopic } from "./topics.js";
import { publishConclusion } from "./conclusions.js";

export function createReviewCase(
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

export function getReviewPacket(db: SqliteDatabase, reviewCaseId: string) {
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

export function effectiveReviewCaseStatus(reviewCase: ReviewCaseRecord): ReviewCaseStatus {
  return reviewCase.lifecycle_status || reviewCase.status;
}

export function listReviewCases(
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

export function transitionReviewCase(
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

export function submitIndependentAssessment(
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

export function publishReviewComparison(
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

export type ReviewReadyImplementationRequest = {
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

export function publishReviewReadyImplementation(
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
