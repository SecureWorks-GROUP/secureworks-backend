// deno-lint-ignore-file no-explicit-any
// One fail-closed invoice prerequisite shared by every deterministic Docs Ready
// positive. This module derives only; it never creates, authorises, sends, pays,
// retires, links, or otherwise mutates an invoice.

export type MakesafeDraftInvoiceReason =
  | "qualifying_draft"
  | "prior_cycle_commercial"
  | "missing_invoice"
  | "wrong_job"
  | "wrong_type"
  | "wrong_status"
  | "missing_reference"
  | "wrong_reference";

export interface MakesafeDraftInvoiceQualification {
  qualifies: boolean;
  reason: MakesafeDraftInvoiceReason;
}

function normalizedReference(value: unknown): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function referencePrefixEndsAtIdentityBoundary(
  invoiceReference: string,
  expectedReference: string,
): boolean {
  if (!invoiceReference || !expectedReference) return false;
  if (invoiceReference === expectedReference) return true;
  if (!invoiceReference.startsWith(expectedReference)) return false;

  // A suffix is legitimate only at an alpha/numeric transition. This admits
  // `MLB-26111PO-53991` for card reference `MLB-26111`, but rejects the sibling
  // numeric reference `MLB-261110` for `MLB-26111`.
  const before = expectedReference.at(-1) || "";
  const after = invoiceReference.charAt(expectedReference.length);
  return /[A-Z]/.test(before) !== /[A-Z]/.test(after) &&
    /[A-Z0-9]/.test(before) && /[A-Z0-9]/.test(after);
}

export function makesafeInvoiceReferenceMatchesCard(
  job: any,
  detail: any,
  invoice: any,
): boolean {
  const invoiceReference = normalizedReference(invoice?.reference);
  if (!invoiceReference) return false;

  const expected = [
    detail?.external_ref,
    job?.metadata?.external_ref,
    job?.metadata?.builder_po_number,
    job?.job_number,
  ].map(normalizedReference).filter((value) => value.length >= 4);

  return [...new Set(expected)].some((reference) =>
    referencePrefixEndsAtIdentityBoundary(invoiceReference, reference)
  );
}

/**
 * Every gate this module applies EXCEPT the lifecycle-status test: exact job
 * linkage, ACCREC type, current-attendance-cycle attribution and card-owned
 * reference. It is deliberately status-agnostic — "does this invoice belong to
 * THIS card's CURRENT attendance" is a different question from "what stage of
 * its life is it at", and the two were previously fused so that only a DRAFT
 * could ever be answered.
 *
 * Returns `"ok"` or the reason it failed, using the same reason vocabulary the
 * DRAFT qualifier publishes, so a caller never has to invent one.
 */
function evaluateMakesafeInvoiceCardIdentity(
  job: any,
  detail: any,
  invoice: any,
): "ok" | MakesafeDraftInvoiceReason {
  if (!invoice) return "missing_invoice";
  if (!job?.id || String(invoice?.job_id || "") !== String(job.id)) {
    return "wrong_job";
  }
  if (String(invoice?.invoice_type || "").toUpperCase() !== "ACCREC") {
    return "wrong_type";
  }
  if (!invoiceBelongsToCurrentAttendance(detail, invoice)) {
    return "prior_cycle_commercial";
  }
  if (!String(invoice?.reference || "").trim()) return "missing_reference";
  if (!makesafeInvoiceReferenceMatchesCard(job, detail, invoice)) {
    return "wrong_reference";
  }
  return "ok";
}

/**
 * Evaluate the already-selected current receivable candidate for one card.
 * Exact job linkage remains mandatory: a reference match never substitutes for
 * `job_id`, so sibling and unrelated invoices fail closed.
 *
 * The first three gates are restated here rather than delegated so the REASON
 * ordering stays byte-identical to the published contract: an invoice that is
 * both non-DRAFT and prior-cycle must keep reporting `wrong_status`, which is
 * what `invoice_draft_qualification_reason` consumers diagnose from.
 */
export function qualifyMakesafeCurrentDraftInvoice(
  job: any,
  detail: any,
  invoice: any,
): MakesafeDraftInvoiceQualification {
  if (!invoice) return { qualifies: false, reason: "missing_invoice" };
  if (!job?.id || String(invoice?.job_id || "") !== String(job.id)) {
    return { qualifies: false, reason: "wrong_job" };
  }
  if (String(invoice?.invoice_type || "").toUpperCase() !== "ACCREC") {
    return { qualifies: false, reason: "wrong_type" };
  }
  if (String(invoice?.status || "").toUpperCase() !== "DRAFT") {
    return { qualifies: false, reason: "wrong_status" };
  }
  const identity = evaluateMakesafeInvoiceCardIdentity(job, detail, invoice);
  if (identity !== "ok") return { qualifies: false, reason: identity };
  return { qualifies: true, reason: "qualifying_draft" };
}

/**
 * Is this invoice this card's own, and does it belong to the card's CURRENT
 * attendance cycle? Status-agnostic by design — the caller pairs it with
 * whatever lifecycle predicate its question needs (`_makesafeInvoiceIsRaised`
 * for a closeout driver, the DRAFT qualifier above for pre-Xero review).
 *
 * This exists because the re-attend suppression in `enrichMakesafeBoardJob` used
 * the DRAFT qualifier as a proxy for cycle attribution. That admitted a
 * current-cycle DRAFT and blanked a current-cycle AUTHORISED invoice — the
 * strictly STRONGER money fact — so a re-attend card that had been sent and
 * billed lost the ladder's raised-invoice term entirely and fell to
 * `trade_report_in`. The cycle boundary applied here is the identical one
 * (`invoiceBelongsToCurrentAttendance`: created at/after `last_reattend_at`,
 * missing or unparseable stamp fails closed), so prior-cycle commercial evidence
 * is refused exactly as before.
 */
export function makesafeInvoiceIsCurrentAttendanceReceivable(
  job: any,
  detail: any,
  invoice: any,
): boolean {
  return evaluateMakesafeInvoiceCardIdentity(job, detail, invoice) === "ok";
}

export function makesafeHasQualifyingCurrentDraftInvoice(
  job: any,
  detail: any,
  invoice: any,
): boolean {
  return qualifyMakesafeCurrentDraftInvoice(job, detail, invoice).qualifies;
}

function invoiceSortTimestamp(value: unknown): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export type MakesafeInvoiceAttendanceCycle = "current" | "prior" | "unknown";

/**
 * Which attendance cycle does this invoice's money belong to?
 *
 * The ONE cycle boundary on the card. Callers pair it with their own
 * fail-closed direction, which differs by question: a placement/closeout driver
 * treats `unknown` as NOT current (prior-cycle money must never place or close
 * a card), while a double-bill refusal treats `unknown` as possibly current
 * (unresolvable attribution must still refuse). Both readings come from this
 * one derivation — do not add a second engine for either.
 */
export function makesafeInvoiceAttendanceCycle(
  detail: any,
  invoice: any,
): MakesafeInvoiceAttendanceCycle {
  if ((Number(detail?.reattend_count ?? 0) || 0) <= 0) return "current";

  // Reattendance is the only explicit commercial-evidence boundary available
  // on the card. A draft created before that boundary belongs to an earlier
  // visit; a draft created at or after it is current. Missing/invalid stamps
  // are unresolvable rather than current.
  const boundary = invoiceSortTimestamp(detail?.last_reattend_at);
  const createdAt = invoiceSortTimestamp(invoice?.created_at);
  if (
    boundary === Number.NEGATIVE_INFINITY ||
    createdAt === Number.NEGATIVE_INFINITY
  ) {
    return "unknown";
  }
  return createdAt >= boundary ? "current" : "prior";
}

function invoiceBelongsToCurrentAttendance(detail: any, invoice: any): boolean {
  return makesafeInvoiceAttendanceCycle(detail, invoice) === "current";
}

/**
 * Choose the current candidate before applying lifecycle qualification. VOIDED
 * and DELETED rows stay visible to this selector so they cannot expose an older
 * DRAFT merely by being filtered out first.
 */
export function selectCurrentMakesafeReceivableInvoice(
  rows: any[] | null | undefined,
): any | null {
  const candidates = (rows || []).filter((row) =>
    String(row?.invoice_type || "").toUpperCase() === "ACCREC"
  );
  candidates.sort((a, b) => {
    const byInvoiceDate = invoiceSortTimestamp(b?.invoice_date) -
      invoiceSortTimestamp(a?.invoice_date);
    if (byInvoiceDate !== 0) return byInvoiceDate;
    const byCreatedAt = invoiceSortTimestamp(b?.created_at) -
      invoiceSortTimestamp(a?.created_at);
    if (byCreatedAt !== 0) return byCreatedAt;
    const aKey = String(a?.id || a?.xero_invoice_id || a?.invoice_number || "");
    const bKey = String(b?.id || b?.xero_invoice_id || b?.invoice_number || "");
    return bKey.localeCompare(aKey);
  });
  return candidates[0] || null;
}

export function currentMakesafeReceivableInvoicesByJobId(
  rows: any[] | null | undefined,
): Record<string, any> {
  const grouped: Record<string, any[]> = {};
  for (const row of rows || []) {
    const jobId = String(row?.job_id || "");
    if (!jobId) continue;
    (grouped[jobId] ||= []).push(row);
  }
  return Object.fromEntries(
    Object.entries(grouped).flatMap(([jobId, invoices]) => {
      const current = selectCurrentMakesafeReceivableInvoice(invoices);
      return current ? [[jobId, current]] : [];
    }),
  );
}
