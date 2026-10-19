// W4 PROPOSAL (Operations, 19 Oct 2026): when may a trade claim on an
// insurance-builder job (make-safe, repair, restoration)? Not wired into any
// money path. The release rule below is a labelled proposal for the owner to
// confirm; it is NOT an owner ruling.
//
// Why it exists: the client sign-off rule (DSP-11) covers homeowner jobs. An
// insurance-builder job has no homeowner sign-off; the builder pays us on our
// completion report. Today the code has no insurance branch at all:
//   - workOrderIsInvoiceReady (trade_invoice_weekly.ts) needs work order status
//     `complete`, or `sent`/`accepted` with a FINISHED jobs.status. Make-safe
//     and repair jobs are minted at `accepted` and stay there (progress lives in
//     makesafe_job_details.substatus or metadata.repair_stage), so a crew work
//     order on them is never ready through the job-status arm.
//   - the hourly lane checks only the assignment status, with no completion
//     evidence of any kind.
// This module answers one question from records the job already has, so a
// caller can later gate both lanes on the same fact.

import {
  insuranceRepairStage,
  isInsuranceRepairFamily,
} from "./insurance_repairs_board.ts";

export type InsuranceClaimFamily = "makesafe" | "repair" | "restoration";

export type InsuranceClaimReason =
  | "not_insurance" // homeowner job: DSP-11 client sign-off applies instead
  | "cancelled"
  | "trade_report_submitted"
  | "report_stage_reached"
  | "repair_complete"
  | "no_completion_evidence"
  | "restoration_no_rule";

export interface InsuranceClaimGateInput {
  job: {
    type?: string | null;
    status?: string | null;
    metadata?: Record<string, unknown> | null;
  };
  makesafe_details?: {
    substatus?: string | null;
    report_type?: string | null;
  } | null;
  // job_service_reports rows for the job (any cycle).
  service_reports?:
    | Array<{
      status?: string | null;
      submitted_at?: string | null;
    }>
    | null;
}

export interface InsuranceClaimGateResult {
  applies: boolean;
  family: InsuranceClaimFamily | null;
  released: boolean;
  reason: InsuranceClaimReason;
}

// Substatuses that come after the trade's report is in (migration
// 20260802010000 substatus check). `complete` is the card's closed state.
export const MAKESAFE_POST_REPORT_SUBSTATUSES = [
  "admin_to_send_report",
  "ready_to_invoice",
  "complete",
] as const;

const POST_REPORT = new Set<string>(MAKESAFE_POST_REPORT_SUBSTATUSES);
const CANCELLED_JOB_STATUSES = new Set(["cancelled", "canceled", "lost"]);

function token(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function insuranceClaimFamily(
  input: InsuranceClaimGateInput,
): InsuranceClaimFamily | null {
  const type = token(input.job?.type);
  const row = {
    ...input.job,
    makesafe_details: input.makesafe_details ?? null,
  };
  // Repair wins over the stored type, by the Repairs board's rule
  // (isInsuranceRepairFamily): a make-safe card tagged repair keeps
  // type=makesafe and its SWMS- number. Dispatch is narrower: its work type
  // ignores makesafe_details.report_type = 'repair', so such a card is a repair
  // here and on the Repairs board but refused by Dispatch Materials.
  if (isInsuranceRepairFamily(row)) return "repair";
  if (type === "makesafe") return "makesafe";
  if (type === "insurance") return "restoration";
  return null;
}

function hasSubmittedReport(input: InsuranceClaimGateInput): boolean {
  return (input.service_reports ?? []).some((report) => {
    const status = token(report?.status);
    return (status === "submitted" || status === "approved") &&
      token(report?.submitted_at) !== "";
  });
}

export function insuranceTradeClaimGate(
  input: InsuranceClaimGateInput,
): InsuranceClaimGateResult {
  const family = insuranceClaimFamily(input);
  if (!family) {
    return {
      applies: false,
      family: null,
      released: false,
      reason: "not_insurance",
    };
  }
  const result = (released: boolean, reason: InsuranceClaimReason) => ({
    applies: true,
    family,
    released,
    reason,
  });
  if (CANCELLED_JOB_STATUSES.has(token(input.job?.status))) {
    return result(false, "cancelled");
  }
  if (family === "restoration") return result(false, "restoration_no_rule");

  // The trade's own completion report is the evidence the builder pays on.
  if (hasSubmittedReport(input)) return result(true, "trade_report_submitted");

  if (family === "makesafe") {
    return POST_REPORT.has(token(input.makesafe_details?.substatus))
      ? result(true, "report_stage_reached")
      : result(false, "no_completion_evidence");
  }

  // Repair: the Repairs board's own stage, the function the board uses.
  const stage = insuranceRepairStage({
    ...input.job,
    repair_stage: input.job?.metadata?.repair_stage,
  });
  return stage === "complete"
    ? result(true, "repair_complete")
    : result(false, "no_completion_evidence");
}

// ---------------------------------------------------------------------------
// W4-1 slot-in (DSP-T3 preparation). Each owner option as one rule, so the
// ruling picks a name instead of a new build. Not wired: a caller would read
// the rule from a flag seeded off (rule `C_unchanged`), and wiring it into
// either trade-pay lane is a money change that needs second-model review.
//   A_completion_report: insuranceTradeClaimGate above.
//   B_builder_invoice: released once the job's own sales invoice to the
//     builder is raised (AUTHORISED, SUBMITTED or PAID; a DRAFT is unpayable
//     and never counts, the same raised set as _makesafeInvoiceIsRaised).
//   C_unchanged: today's behaviour, nothing held.
// Homeowner jobs are never held here under any rule (DSP-11 covers them).

export type InsuranceClaimRule =
  | "A_completion_report"
  | "B_builder_invoice"
  | "C_unchanged";

export const INSURANCE_CLAIM_RULES: readonly InsuranceClaimRule[] = [
  "A_completion_report",
  "B_builder_invoice",
  "C_unchanged",
];

export interface InsuranceClaimDecisionInput extends InsuranceClaimGateInput {
  // xero_invoices rows linked to the job (exact job_id).
  sales_invoices?:
    | Array<{
      type?: string | null;
      status?: string | null;
    }>
    | null;
}

export interface InsuranceClaimDecision {
  rule: InsuranceClaimRule;
  applies: boolean;
  family: InsuranceClaimFamily | null;
  hold: boolean;
  reason:
    | InsuranceClaimReason
    | "builder_invoice_raised"
    | "builder_invoice_not_raised"
    | "rule_not_in_force"
    | "unknown_rule";
}

const RAISED_INVOICE_STATUSES = new Set(["AUTHORISED", "SUBMITTED", "PAID"]);

export function insuranceClaimDecision(
  rule: unknown,
  input: InsuranceClaimDecisionInput,
): InsuranceClaimDecision {
  const family = insuranceClaimFamily(input);
  const applies = family !== null;
  const named = INSURANCE_CLAIM_RULES.find((r) => r === rule);
  // An unreadable rule holds nothing new: today's behaviour, said by name.
  if (!named) {
    return {
      rule: "C_unchanged",
      applies,
      family,
      hold: false,
      reason: "unknown_rule",
    };
  }
  if (!applies) {
    return {
      rule: named,
      applies,
      family,
      hold: false,
      reason: "not_insurance",
    };
  }
  if (named === "C_unchanged") {
    return {
      rule: named,
      applies,
      family,
      hold: false,
      reason: "rule_not_in_force",
    };
  }
  if (named === "A_completion_report") {
    const gate = insuranceTradeClaimGate(input);
    return {
      rule: named,
      applies,
      family,
      hold: !gate.released,
      reason: gate.reason,
    };
  }
  if (CANCELLED_JOB_STATUSES.has(token(input.job?.status))) {
    return { rule: named, applies, family, hold: true, reason: "cancelled" };
  }
  const raised = (input.sales_invoices ?? []).some((invoice) =>
    String(invoice?.type ?? "").toUpperCase() === "ACCREC" &&
    RAISED_INVOICE_STATUSES.has(String(invoice?.status ?? "").toUpperCase())
  );
  return {
    rule: named,
    applies,
    family,
    hold: !raised,
    reason: raised ? "builder_invoice_raised" : "builder_invoice_not_raised",
  };
}
