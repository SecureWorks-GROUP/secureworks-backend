// Pure fencing stage engine v1. Facts in, canonical stage out.
//
// Never reads a claimed board status. A job with empty evidence is `unknown`
// or an earlier proved stage, never an echo of the operator claim. A later
// fact without its prerequisites is `decision_required`, never a skip into a
// plausible column. A draft PO is not awaiting-supplier.

import type {
  FencingAssignmentFact,
  FencingExecutionEvidence,
  FencingInvoiceFact,
  FencingPoCommFact,
  FencingPoFact,
  FencingServiceReportFact,
  FencingStageEvidenceRef,
} from "./fencing_stage_evidence.ts";
import {
  isDepositInvoiceFact,
  isFinalInvoiceFact,
} from "./fencing_stage_evidence.ts";
import {
  FENCING_RECTIFICATION_ASSIGNMENT_TYPE,
  FENCING_STAGE_ARCHIVE_AFTER_MS,
  FENCING_STAGE_ENGINE_VERSION,
  FENCING_STAGE_EVIDENCE_REFS_CAP,
  FENCING_STAGE_LADDER,
  FENCING_STAGE_RECIPE_VERSION,
  type FencingCanonicalStage,
  type FencingFactId,
  isFencingAssignmentNonFieldWork,
  isFencingInvoiceIssuedStatus,
  isFencingInvoicePaidStatus,
  isFencingPoConfirmedStatus,
  isFencingPoDraftStatus,
  isFencingPoSentStatus,
  isFencingServiceReportSubmitted,
  normalizeStatusToken,
} from "./fencing_stage_recipe_v1.ts";

export interface FencingRectificationPending {
  assignment_id: string | null;
  status: string | null;
}

export interface FencingStageDerivation {
  canonical_stage: FencingCanonicalStage;
  stage_recipe_version: string;
  engine_version: string;
  reasons: string[];
  missing: string[];
  conflicts: string[];
  evidence_refs: FencingStageEvidenceRef[];
  facts: Record<FencingFactId, boolean>;
  /** Re-entry overlay. Not a ladder position. */
  rectification_pending: FencingRectificationPending | null;
}

export interface FencingStageDeriveOptions {
  now?: Date;
}

interface EvaluatedFacts {
  deposit_issued: boolean;
  deposit_paid: boolean;
  material_order_sent: boolean;
  order_confirmed: boolean;
  assignment_dated: boolean;
  install_started: boolean;
  work_complete: boolean;
  final_issued: boolean;
  final_paid: boolean;
  draft_po_veto: boolean;
  archive_clock_elapsed: boolean;
  rectification_pending: FencingRectificationPending | null;
}

function hasStamp(value: string | null | undefined): boolean {
  return !!value && String(value).trim().length > 0;
}

function invoiceIsPaid(invoice: FencingInvoiceFact): boolean {
  if (isFencingInvoicePaidStatus(invoice.status)) return true;
  return hasStamp(invoice.fully_paid_on) && isFencingInvoiceIssuedStatus(
    invoice.status,
  );
}

function liveAssignments(
  evidence: FencingExecutionEvidence,
): FencingAssignmentFact[] {
  return evidence.assignments.filter((row) =>
    !isFencingAssignmentNonFieldWork(row)
  );
}

function isRectificationAssignment(row: FencingAssignmentFact): boolean {
  return normalizeStatusToken(row.assignment_type) ===
    FENCING_RECTIFICATION_ASSIGNMENT_TYPE;
}

/** Forward-ladder field work. Re-entry visits are overlay, not rungs. */
function forwardAssignments(
  evidence: FencingExecutionEvidence,
): FencingAssignmentFact[] {
  return liveAssignments(evidence).filter((row) =>
    !isRectificationAssignment(row)
  );
}

function depositInvoices(
  evidence: FencingExecutionEvidence,
): FencingInvoiceFact[] {
  return evidence.invoices.filter((invoice) =>
    isDepositInvoiceFact(invoice, evidence.deposit_invoice_id)
  );
}

function finalInvoices(
  evidence: FencingExecutionEvidence,
): FencingInvoiceFact[] {
  return evidence.invoices.filter((invoice) =>
    isFinalInvoiceFact(invoice, evidence.deposit_invoice_id)
  );
}

function outboundComms(
  evidence: FencingExecutionEvidence,
): FencingPoCommFact[] {
  const materialPoIds = new Set(
    evidence.purchase_orders.map((po) => po.id).filter((id) => id != null),
  );
  return evidence.po_communications.filter((row) =>
    normalizeStatusToken(row.direction) === "outbound" &&
    hasStamp(row.sent_at) &&
    hasStamp(row.message_id) &&
    row.po_id != null &&
    materialPoIds.has(row.po_id)
  );
}

function poHasConfirmation(po: FencingPoFact): boolean {
  return isFencingPoConfirmedStatus(po.status) ||
    hasStamp(po.delivery_confirmed_at);
}

function submittedReports(
  evidence: FencingExecutionEvidence,
): FencingServiceReportFact[] {
  return evidence.service_reports.filter((row) =>
    isFencingServiceReportSubmitted(row.status) && hasStamp(row.submitted_at)
  );
}

function parseInstant(value: string | null | undefined): number | null {
  if (!hasStamp(value)) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function latestCompletionMs(
  evidence: FencingExecutionEvidence,
): number | null {
  const stamps: number[] = [];
  for (const assignment of forwardAssignments(evidence)) {
    const completed = parseInstant(assignment.completed_at);
    if (completed != null) stamps.push(completed);
  }
  for (const report of submittedReports(evidence)) {
    const submitted = parseInstant(report.submitted_at);
    if (submitted != null) stamps.push(submitted);
  }
  if (stamps.length === 0) return null;
  return Math.max(...stamps);
}

function evaluateFacts(
  evidence: FencingExecutionEvidence,
  now: Date,
): EvaluatedFacts {
  const deposits = depositInvoices(evidence);
  const finals = finalInvoices(evidence);
  const pos = evidence.purchase_orders;
  const assignments = forwardAssignments(evidence);
  const rectificationAssignments = liveAssignments(evidence).filter(
    isRectificationAssignment,
  );

  const depositIssued = deposits.some((invoice) =>
    isFencingInvoiceIssuedStatus(invoice.status)
  );
  const depositPaid = deposits.some((invoice) => invoiceIsPaid(invoice));

  const livePos = pos.filter((po) =>
    normalizeStatusToken(po.status) !== "deleted"
  );
  const draftOnly = livePos.length > 0 &&
    livePos.every((po) => isFencingPoDraftStatus(po.status));
  const poSent = livePos.some((po) => isFencingPoSentStatus(po.status));
  const outbound = outboundComms(evidence).length > 0;
  const materialOrderSent = poSent ||
    (outbound && livePos.length > 0 && !draftOnly);

  const orderConfirmed = livePos.some((po) => poHasConfirmation(po));

  const datedAssignments = assignments.filter((row) =>
    hasStamp(row.scheduled_date)
  );
  const assignmentDated = datedAssignments.length > 0;

  const installStarted = assignments.some((row) => hasStamp(row.started_at));
  const workComplete = assignments.some((row) => hasStamp(row.completed_at)) ||
    submittedReports(evidence).length > 0;

  const finalIssued = finals.some((invoice) =>
    isFencingInvoiceIssuedStatus(invoice.status)
  );
  const finalPaid = finals.some((invoice) => invoiceIsPaid(invoice));

  const pendingRectification =
    rectificationAssignments.find((row) =>
      normalizeStatusToken(row.status) !== "complete" &&
      !hasStamp(row.completed_at)
    ) ?? null;

  const completedAt = latestCompletionMs(evidence);
  const archiveClockElapsed = completedAt != null &&
    (now.getTime() - completedAt) >= FENCING_STAGE_ARCHIVE_AFTER_MS;

  return {
    deposit_issued: depositIssued,
    deposit_paid: depositPaid,
    material_order_sent: materialOrderSent,
    order_confirmed: orderConfirmed,
    assignment_dated: assignmentDated,
    install_started: installStarted,
    work_complete: workComplete,
    final_issued: finalIssued,
    final_paid: finalPaid,
    draft_po_veto: draftOnly,
    archive_clock_elapsed: archiveClockElapsed,
    rectification_pending: pendingRectification
      ? {
        assignment_id: pendingRectification.id,
        status: pendingRectification.status,
      }
      : null,
  };
}

function boundRefs(refs: FencingStageEvidenceRef[]): FencingStageEvidenceRef[] {
  const seen = new Set<string>();
  const unique: FencingStageEvidenceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id || ""}:${ref.status || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
    if (unique.length >= FENCING_STAGE_EVIDENCE_REFS_CAP) break;
  }
  return unique;
}

function collectRefs(
  evidence: FencingExecutionEvidence,
): FencingStageEvidenceRef[] {
  const refs: FencingStageEvidenceRef[] = [];
  for (const invoice of depositInvoices(evidence)) {
    refs.push({
      kind: "deposit_invoice",
      id: invoice.id,
      status: invoice.status,
    });
  }
  for (const invoice of finalInvoices(evidence)) {
    refs.push({
      kind: "final_invoice",
      id: invoice.id,
      status: invoice.status,
    });
  }
  for (const po of evidence.purchase_orders) {
    refs.push({
      kind: "purchase_order",
      id: po.id,
      status: po.status,
    });
  }
  for (const comm of evidence.po_communications) {
    refs.push({
      kind: "po_communication",
      id: comm.id,
      status: comm.direction,
    });
  }
  for (const assignment of evidence.assignments) {
    refs.push({
      kind: "assignment",
      id: assignment.id,
      status: assignment.status,
    });
  }
  for (const report of evidence.service_reports) {
    refs.push({
      kind: "service_report",
      id: report.id,
      status: report.status,
    });
  }
  return boundRefs(refs);
}

function factRecord(evaluated: EvaluatedFacts): Record<FencingFactId, boolean> {
  return {
    deposit_issued: evaluated.deposit_issued,
    deposit_paid: evaluated.deposit_paid,
    material_order_sent: evaluated.material_order_sent,
    order_confirmed: evaluated.order_confirmed,
    assignment_dated: evaluated.assignment_dated,
    install_started: evaluated.install_started,
    work_complete: evaluated.work_complete,
    final_issued: evaluated.final_issued,
    final_paid: evaluated.final_paid,
  };
}

function result(args: {
  stage: FencingCanonicalStage;
  reasons: string[];
  missing: string[];
  conflicts: string[];
  evidence: FencingExecutionEvidence;
  facts: Record<FencingFactId, boolean>;
  rectification_pending: FencingRectificationPending | null;
}): FencingStageDerivation {
  return {
    canonical_stage: args.stage,
    stage_recipe_version: FENCING_STAGE_RECIPE_VERSION,
    engine_version: FENCING_STAGE_ENGINE_VERSION,
    reasons: [...args.reasons],
    missing: [...args.missing],
    conflicts: [...args.conflicts],
    evidence_refs: collectRefs(args.evidence),
    facts: args.facts,
    rectification_pending: args.rectification_pending,
  };
}

function firstUnprovedIndex(facts: Record<FencingFactId, boolean>): number {
  return FENCING_STAGE_LADDER.findIndex((step) => !facts[step.fact]);
}

function laterFactWithoutPrefix(
  facts: Record<FencingFactId, boolean>,
  firstGap: number,
): FencingFactId | null {
  if (firstGap < 0) return null;
  for (let i = firstGap + 1; i < FENCING_STAGE_LADDER.length; i++) {
    const step = FENCING_STAGE_LADDER[i];
    if (facts[step.fact]) return step.fact;
  }
  return null;
}

function waitingStage(
  facts: Record<FencingFactId, boolean>,
  evaluated: EvaluatedFacts,
): { stage: FencingCanonicalStage; reasons: string[]; missing: string[] } {
  const firstGap = firstUnprovedIndex(facts);
  if (firstGap === 0 || firstGap < 0 && !facts.deposit_issued) {
    return {
      stage: "unknown",
      reasons: ["no_issued_deposit_or_later_fact"],
      missing: [FENCING_STAGE_LADDER[0].missing_code],
    };
  }
  if (firstGap < 0) {
    if (
      evaluated.archive_clock_elapsed && !evaluated.rectification_pending
    ) {
      return {
        stage: "archived",
        reasons: ["final_paid_and_completion_older_than_seven_days"],
        missing: [],
      };
    }
    const reasons = evaluated.rectification_pending
      ? ["final_invoice_paid", "rectification_pending_blocks_archive"]
      : ["final_invoice_paid"];
    return {
      stage: "get_review",
      reasons,
      missing: ["review_request_send_proof"],
    };
  }
  const reached = FENCING_STAGE_LADDER[firstGap - 1];
  const stage = reached.reached_stage;
  const reasons = [`proved_${reached.fact}`];
  const missing = [FENCING_STAGE_LADDER[firstGap].missing_code];

  if (evaluated.draft_po_veto && stage === "awaiting_supplier") {
    return {
      stage: "order_materials",
      reasons: ["draft_po_is_not_a_send"],
      missing: ["material_order_sent"],
    };
  }

  return { stage, reasons, missing };
}

/**
 * Derive the fencing execution stage from evidence. Pure. Deterministic
 * for the same evidence + `now`.
 */
export function deriveFencingStageV1(
  evidence: FencingExecutionEvidence,
  options: FencingStageDeriveOptions = {},
): FencingStageDerivation {
  const now = options.now ?? new Date();
  const evaluated = evaluateFacts(evidence, now);
  const facts = factRecord(evaluated);

  if (evidence.unreadable.length > 0) {
    return result({
      stage: "decision_required",
      reasons: ["stage_truth_evidence_unreadable"],
      missing: [],
      conflicts: evidence.unreadable.map((name) => `unreadable:${name}`),
      evidence,
      facts,
      rectification_pending: evaluated.rectification_pending,
    });
  }

  const firstGap = firstUnprovedIndex(facts);
  const skipped = laterFactWithoutPrefix(facts, firstGap);
  if (skipped) {
    const missing = firstGap >= 0
      ? [FENCING_STAGE_LADDER[firstGap].missing_code]
      : [];
    return result({
      stage: "decision_required",
      reasons: [`later_fact_without_prefix:${skipped}`],
      missing,
      conflicts: [
        `${skipped}_without_${
          firstGap >= 0 ? FENCING_STAGE_LADDER[firstGap].fact : "prefix"
        }`,
      ],
      evidence,
      facts,
      rectification_pending: evaluated.rectification_pending,
    });
  }

  const waiting = waitingStage(facts, evaluated);
  return result({
    stage: waiting.stage,
    reasons: waiting.reasons,
    missing: waiting.missing,
    conflicts: [],
    evidence,
    facts,
    rectification_pending: evaluated.rectification_pending,
  });
}

export function fencingStageTruthFields(
  declaredStage: string | null | undefined,
  derivation: FencingStageDerivation,
): {
  declared_stage: string | null;
  canonical_stage: FencingCanonicalStage;
  stage_recipe_version: string;
  reasons: string[];
  missing: string[];
  conflicts: string[];
  evidence_refs: FencingStageEvidenceRef[];
  rectification_pending: FencingRectificationPending | null;
} {
  return {
    declared_stage: declaredStage == null || declaredStage === ""
      ? null
      : String(declaredStage),
    canonical_stage: derivation.canonical_stage,
    stage_recipe_version: derivation.stage_recipe_version,
    reasons: derivation.reasons,
    missing: derivation.missing,
    conflicts: derivation.conflicts,
    evidence_refs: derivation.evidence_refs,
    rectification_pending: derivation.rectification_pending,
  };
}
