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
 * Evaluate the already-selected current receivable candidate for one card.
 * Exact job linkage remains mandatory: a reference match never substitutes for
 * `job_id`, so sibling and unrelated invoices fail closed.
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
  if (!invoiceBelongsToCurrentAttendance(detail, invoice)) {
    return { qualifies: false, reason: "prior_cycle_commercial" };
  }
  if (!String(invoice?.reference || "").trim()) {
    return { qualifies: false, reason: "missing_reference" };
  }
  if (!makesafeInvoiceReferenceMatchesCard(job, detail, invoice)) {
    return { qualifies: false, reason: "wrong_reference" };
  }
  return { qualifies: true, reason: "qualifying_draft" };
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

function invoiceBelongsToCurrentAttendance(detail: any, invoice: any): boolean {
  if ((Number(detail?.reattend_count ?? 0) || 0) <= 0) return true;

  // Reattendance is the only explicit commercial-evidence boundary available
  // on the card. A draft created before that boundary belongs to an earlier
  // visit; a draft created at or after it is current. Missing/invalid stamps
  // fail closed rather than making old commercial evidence current.
  const boundary = invoiceSortTimestamp(detail?.last_reattend_at);
  const createdAt = invoiceSortTimestamp(invoice?.created_at);
  return Number.isFinite(boundary) && Number.isFinite(createdAt) &&
    boundary !== Number.NEGATIVE_INFINITY &&
    createdAt !== Number.NEGATIVE_INFINITY && createdAt >= boundary;
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
