// Declarative fencing execution recipe v1.
//
// Polarity: evidence in, stage out. The stored board status is a CLAIM and
// is not an input to this table. The Cap 1 gate evaluator is the opposite
// polarity (claimed status in, gates out) and is not this recipe. Do not
// generalise the make-safe placement engine into fencing — copy the result
// shape only.
//
// Signals are the ones fence-arch-a proved already exist: deposit invoice
// identity + Xero status, material PO identity + send/confirm/delivery,
// assignment dates/status/clocks, submitted service report, issued/paid
// non-deposit ACCREC, rectification assignment type. Quote documents are
// not read in v1, so quoted/accepted cannot be proved and stay `unknown`.

export const FENCING_STAGE_RECIPE_VERSION = "fencing-stage-recipe/v1";

export const FENCING_STAGE_ENGINE_VERSION =
  "fencing-stage-engine.v1-shadow-read";

/** Opt-in pipeline flag. Absent → today's byte-identical response. */
export const FENCING_STAGE_TRUTH_PARAM = "stage_truth";
export const FENCING_STAGE_TRUTH_ON = "1";

export const FENCING_STAGE_EVIDENCE_REFS_CAP = 8;

export const FENCING_STAGE_ARCHIVE_AFTER_MS = 7 * 86_400_000;

export type FencingCanonicalStage =
  | "quoted"
  | "accepted"
  | "awaiting_deposit"
  | "order_materials"
  | "awaiting_supplier"
  | "order_confirmed"
  | "schedule_install"
  | "scheduled"
  | "in_progress"
  | "rectification"
  | "complete"
  | "final_payment"
  | "get_review"
  | "invoiced"
  | "archived"
  | "unknown"
  | "decision_required";

export const FENCING_CANONICAL_STAGES: readonly FencingCanonicalStage[] = [
  "quoted",
  "accepted",
  "awaiting_deposit",
  "order_materials",
  "awaiting_supplier",
  "order_confirmed",
  "schedule_install",
  "scheduled",
  "in_progress",
  "rectification",
  "complete",
  "final_payment",
  "get_review",
  "invoiced",
  "archived",
  "unknown",
  "decision_required",
];

/**
 * Execution stages that may not be emitted without a paid deposit fact.
 * `unknown` / `decision_required` / `awaiting_deposit` are not in this set.
 */
export const FENCING_MATERIALS_OR_LATER: ReadonlySet<FencingCanonicalStage> =
  new Set([
    "order_materials",
    "awaiting_supplier",
    "order_confirmed",
    "schedule_install",
    "scheduled",
    "in_progress",
    "rectification",
    "complete",
    "final_payment",
    "get_review",
    "invoiced",
    "archived",
  ]);

/** Live purchase_orders.status values that are not a send. */
export const FENCING_PO_DRAFT_STATUSES = [
  "quote_requested",
  "draft",
  "approved",
] as const;

/** PO statuses that prove the order left the office. */
export const FENCING_PO_SENT_STATUSES = [
  "submitted",
  "authorised",
  "sent",
] as const;

/** PO statuses that prove supplier acknowledgement or receipt. */
export const FENCING_PO_CONFIRMED_STATUSES = [
  "confirmed",
  "delivered",
  "billed",
] as const;

export const FENCING_PO_DELETED_STATUS = "deleted";
export const FENCING_PO_CANCELLED_STATUS = "cancelled";

/** Xero ACCREC statuses that can take payment. DRAFT is not among them. */
export const FENCING_INVOICE_ISSUED_STATUSES = [
  "AUTHORISED",
  "SUBMITTED",
  "PAID",
] as const;

export const FENCING_INVOICE_PAID_STATUS = "PAID";

export const FENCING_ASSIGNMENT_LIVE_STATUSES = [
  "scheduled",
  "confirmed",
  "in_progress",
  "complete",
] as const;

export const FENCING_ASSIGNMENT_CONFIRMED_STATUSES = [
  "confirmed",
  "in_progress",
  "complete",
] as const;

export const FENCING_SERVICE_REPORT_SUBMITTED_STATUSES = [
  "submitted",
  "approved",
] as const;

export const FENCING_RECTIFICATION_ASSIGNMENT_TYPE = "rectification";

export type FencingFactId =
  | "deposit_issued"
  | "deposit_paid"
  | "material_order_sent"
  | "order_confirmed"
  | "assignment_dated"
  | "install_started"
  | "work_complete"
  | "final_issued"
  | "final_paid";

/**
 * Ordered evidence ladder. Each row names the fact that must hold before
 * the next stage is honest, and the canonical stage while waiting on the
 * NEXT fact. A later fact without every earlier fact is `decision_required`,
 * never a skip into a plausible column.
 *
 * quoted / accepted are listed for the 12-stage spec but have no v1 producer
 * (quote documents are outside the allowed signal set). Empty evidence
 * therefore stays `unknown`, not an echo of the claim.
 */
export interface FencingLadderStep {
  fact: FencingFactId;
  /** Stage emitted when this fact holds and the next one does not. */
  reached_stage: FencingCanonicalStage;
  missing_code: string;
}

export const FENCING_STAGE_LADDER: readonly FencingLadderStep[] = [
  {
    fact: "deposit_issued",
    reached_stage: "awaiting_deposit",
    missing_code: "deposit_invoice_issued",
  },
  {
    fact: "deposit_paid",
    reached_stage: "order_materials",
    missing_code: "deposit_paid",
  },
  {
    fact: "material_order_sent",
    reached_stage: "awaiting_supplier",
    missing_code: "material_order_sent",
  },
  {
    fact: "order_confirmed",
    reached_stage: "schedule_install",
    missing_code: "supplier_confirmation",
  },
  {
    fact: "assignment_dated",
    reached_stage: "scheduled",
    missing_code: "assignment_scheduled_date",
  },
  {
    fact: "install_started",
    reached_stage: "in_progress",
    missing_code: "assignment_started_at",
  },
  {
    fact: "work_complete",
    reached_stage: "complete",
    missing_code: "work_complete_clock_or_report",
  },
  {
    fact: "final_issued",
    reached_stage: "final_payment",
    missing_code: "final_invoice_issued",
  },
  {
    fact: "final_paid",
    reached_stage: "get_review",
    missing_code: "final_invoice_paid",
  },
];

export const FENCING_STAGE_PIPELINE_FIELDS = [
  "declared_stage",
  "canonical_stage",
  "stage_recipe_version",
  "reasons",
  "missing",
  "conflicts",
  "evidence_refs",
] as const;

export function isFencingStageTruthRequested(
  params: { get(name: string): string | null },
): boolean {
  return params.get(FENCING_STAGE_TRUTH_PARAM) === FENCING_STAGE_TRUTH_ON;
}

export function isFencingMaterialsOrLater(
  stage: FencingCanonicalStage,
): boolean {
  return FENCING_MATERIALS_OR_LATER.has(stage);
}

export function normalizeStatusToken(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function normalizeInvoiceStatus(value: unknown): string {
  return String(value || "").trim().toUpperCase();
}

export function isFencingPoDraftStatus(status: unknown): boolean {
  return (FENCING_PO_DRAFT_STATUSES as readonly string[]).includes(
    normalizeStatusToken(status),
  );
}

export function isFencingPoSentStatus(status: unknown): boolean {
  const token = normalizeStatusToken(status);
  return (FENCING_PO_SENT_STATUSES as readonly string[]).includes(token) ||
    (FENCING_PO_CONFIRMED_STATUSES as readonly string[]).includes(token);
}

export function isFencingPoConfirmedStatus(status: unknown): boolean {
  return (FENCING_PO_CONFIRMED_STATUSES as readonly string[]).includes(
    normalizeStatusToken(status),
  );
}

export function isFencingInvoiceIssuedStatus(status: unknown): boolean {
  return (FENCING_INVOICE_ISSUED_STATUSES as readonly string[]).includes(
    normalizeInvoiceStatus(status),
  );
}

export function isFencingInvoicePaidStatus(status: unknown): boolean {
  return normalizeInvoiceStatus(status) === FENCING_INVOICE_PAID_STATUS;
}

export function isFencingAssignmentLiveStatus(status: unknown): boolean {
  const token = normalizeStatusToken(status);
  if (!token) return true;
  return (FENCING_ASSIGNMENT_LIVE_STATUSES as readonly string[]).includes(
    token,
  );
}

export function isFencingServiceReportSubmitted(status: unknown): boolean {
  return (FENCING_SERVICE_REPORT_SUBMITTED_STATUSES as readonly string[])
    .includes(normalizeStatusToken(status));
}

export function referenceLooksLikeDeposit(reference: unknown): boolean {
  return String(reference || "").toUpperCase().includes("DEP");
}
