// Debt Workshop: Debt and Other receivables (Shaun approved 4 Nov 2026; the build spec is
// C:\Coding Projects\.lavish\receivables-build-spec.md, summarised in
// docs/debt-workshop/README.md, "Debt and Other receivables").
//
// Receivables are every unpaid invoice. Each one is split into exactly one class:
//
//   debt          A final invoice made after the job is Complete or Invoiced (the ops
//                 dashboard job status, any pipeline), or a company invoice (make-safe,
//                 repair, roof report, insurance, or a company with no job card).
//   other         Everything else unpaid: deposits, go-ahead deposits, materials, progress
//                 payments, planning fees and extra labour.
//   write_off     Contacts on the tab's not-chased list (Emergency Trade Services,
//                 Builderwest): "for us to check whether to write off".
//   needs_a_look  The rules could not place it, including a final invoice on a job that is
//                 not marked Complete or Invoiced yet. Still chased as today.
//   test          SAMPLE- references: left out of Receivables and named in the check.
//
// Every invoice also gets a "pay by" date and "days overdue" (days after pay by, never
// below zero):
//   - a Debt final: the invoice date (the tab's day 0, so the day the job left
//     rectification when that is later, as today);
//   - a company invoice: the invoice date plus that company's terms (debt_ws_rules.ts
//     companyTermsFor, the tab's due date);
//   - Other receivables: Xero's own due date (the invoice date when Xero has none).
//
// The chase steps, holds, statements and Jan's list do not read this: they keep the tab's
// own day and category exactly as before. This is the money view only.
//
// Pure functions only: no database, no clock. GoHighLevel pipeline stages are never read.

import { daysBetween, type DebtKind } from "./debt_ws_rules.ts";

export type ReceivableClass =
  | "debt"
  | "other"
  | "write_off"
  | "needs_a_look"
  | "test";

/**
 * The job statuses that mean the job is Complete or Invoiced (or past it). A final on a job
 * in rectification also counts: the job was finished and invoiced, and the tab holds it
 * while the fix is done. Any other status (scheduled, in progress, a job with no status)
 * puts a final under Needs a look.
 */
export const DEBT_FINAL_JOB_STATUSES: ReadonlySet<string> = new Set([
  "rectification",
  "complete",
  "final_payment",
  "get_review",
  "invoiced",
  "paid",
  "archived",
]);

export const NOT_COMPLETE_REASON =
  "final invoice but the job is not marked Complete or Invoiced";

/** The words for a not-final stage on the Type column. */
const STAGE_TYPES: Record<string, string> = {
  deposit: "Deposit",
  materials: "Materials",
  progress: "Progress payment",
  "planning fee": "Planning fee",
  "extra labour": "Extra labour",
};

export function stageType(stage: string | null | undefined): string {
  const s = String(stage ?? "").trim().toLowerCase();
  return STAGE_TYPES[s] ?? (s ? s.charAt(0).toUpperCase() + s.slice(1) : "Other");
}

export interface ReceivableView {
  receivable_class: ReceivableClass;
  /** Company, Final, Deposit, Go-ahead deposit, Materials, Progress payment, and so on. */
  type_label: string;
  /** The date it should be paid by (YYYY-MM-DD), or null with no date at all. */
  pay_by: string | null;
  /** Days after pay by; 0 when not yet due. */
  days_overdue: number;
  /** Why it sits under Needs a look, when it does. */
  look_reason: string | null;
}

export function daysOverdue(payBy: string | null, today: string): number {
  return payBy ? Math.max(0, daysBetween(payBy, today)) : 0;
}

const xeroDate = (d: string | null | undefined) =>
  d ? String(d).slice(0, 10) : null;

/** An invoice the tab placed as debt (a BookEntry): its class, type and pay by. */
export function receivableOfEntry(input: {
  kind: DebtKind;
  stage: string | null;
  notChased: boolean;
  jobStatus: string | null;
  /** The tab's day 0 (the due date, or the day the job left rectification). */
  dayZero: string;
  /** The tab's due date (for a company: invoice date plus that company's terms). */
  dueDate: string;
  invoiceDate: string | null;
  xeroDue: string | null | undefined;
  today: string;
}): ReceivableView {
  const view = (
    cls: ReceivableClass,
    type: string,
    payBy: string | null,
    reason: string | null = null,
  ): ReceivableView => ({
    receivable_class: cls,
    type_label: type,
    pay_by: payBy,
    days_overdue: daysOverdue(payBy, input.today),
    look_reason: reason,
  });
  const typeOf = input.kind === "account"
    ? "Company"
    : input.kind === "final"
    ? "Final"
    : stageType(input.stage);
  if (input.notChased) return view("write_off", typeOf, input.dueDate);
  if (input.kind === "account") return view("debt", "Company", input.dueDate);
  if (input.kind === "progress") {
    return view(
      "other",
      typeOf,
      xeroDate(input.xeroDue) ?? input.invoiceDate ?? input.dueDate,
    );
  }
  const status = String(input.jobStatus ?? "").trim().toLowerCase();
  if (DEBT_FINAL_JOB_STATUSES.has(status)) {
    return view("debt", "Final", input.dayZero);
  }
  return view("needs_a_look", "Final", input.dayZero, NOT_COMPLETE_REASON);
}

/** A go-ahead deposit (the first stage payment on a job): Other, pay by Xero's due date. */
export function receivableOfGoAhead(input: {
  stage: string | null;
  invoiceDate: string | null;
  xeroDue: string | null | undefined;
  today: string;
}): ReceivableView {
  const payBy = xeroDate(input.xeroDue) ?? input.invoiceDate;
  const type = String(input.stage ?? "").toLowerCase() === "deposit" || !input.stage
    ? "Go-ahead deposit"
    : `${stageType(input.stage)} (go-ahead)`;
  return {
    receivable_class: "other",
    type_label: type,
    pay_by: payBy,
    days_overdue: daysOverdue(payBy, input.today),
    look_reason: null,
  };
}

/** Needs a look, a test invoice or an invoice no rule placed: pay by Xero's due date. */
export function receivableOfUnplaced(input: {
  cls: "needs_a_look" | "test";
  reason: string | null;
  invoiceDate: string | null;
  xeroDue: string | null | undefined;
  today: string;
}): ReceivableView {
  const payBy = xeroDate(input.xeroDue) ?? input.invoiceDate;
  return {
    receivable_class: input.cls,
    type_label: input.cls === "test" ? "Test invoice" : "Needs a look",
    pay_by: payBy,
    days_overdue: daysOverdue(payBy, input.today),
    look_reason: input.reason,
  };
}

/** The Debt overdue bands (spec point 6): not due, 1 to 7, 8 to 20, 21 or more (bad debt). */
export type OverdueBand = "not_due" | "d1_7" | "d8_20" | "d21";

export const OVERDUE_BANDS: Array<{ key: OverdueBand; name: string }> = [
  { key: "not_due", name: "Not due" },
  { key: "d1_7", name: "1 to 7 days" },
  { key: "d8_20", name: "8 to 20 days" },
  { key: "d21", name: "21 days or more (bad debt)" },
];

export function overdueBand(daysOver: number): OverdueBand {
  if (daysOver <= 0) return "not_due";
  if (daysOver <= 7) return "d1_7";
  if (daysOver <= 20) return "d8_20";
  return "d21";
}
