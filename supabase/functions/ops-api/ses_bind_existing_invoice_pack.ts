// deno-lint-ignore-file no-explicit-any
import {
  makesafeInvoiceAttendanceCycle,
  makesafeInvoiceReferenceMatchesCard,
  selectCurrentMakesafeReceivableInvoice,
} from "./makesafe_docs_ready_invoice.ts";

export const SES_BIND_EXISTING_INVOICE_STATUSES = [
  "DRAFT",
  "AUTHORISED",
  "PAID",
] as const;

const SES_NAMED_PRIOR_CYCLE_PLACEMENT_STATUSES = new Set([
  ...SES_BIND_EXISTING_INVOICE_STATUSES,
  // Xero can advance an already-bound AUTHORISED invoice through SUBMITTED.
  // That lifecycle change must not erase the Captain's durable adoption.
  "SUBMITTED",
]);

export type SesBindExistingInvoiceAuthMode =
  | "api_key"
  | "jwt"
  | "routine"
  | "agent_read";

/** Keep this local-only repair on server-held credentials, never user JWTs. */
export function canBindExistingMakesafeInvoicePack(
  authMode: SesBindExistingInvoiceAuthMode,
): boolean {
  return authMode === "api_key" || authMode === "routine";
}

export class SesBindExistingInvoiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SesBindExistingInvoiceError";
  }
}

function normalizedInvoiceNumber(value: unknown): string {
  return String(value || "").trim().toUpperCase();
}

const SES_BIND_CURRENT_RECEIVABLE_PRIORITY = [
  "PAID",
  "AUTHORISED",
  // An issued-but-not-authorised row must still block an older DRAFT even
  // though the bind action itself refuses SUBMITTED.
  "SUBMITTED",
  "DRAFT",
] as const;

/**
 * Apply the Captain's bind-only money preference without changing the board's
 * recency-first current-cycle selector. Within one lifecycle, the shared
 * selector keeps its deterministic newest-row choice.
 */
function selectPreferredCurrentReceivableForPackBind(rows: any[]): any | null {
  for (const status of SES_BIND_CURRENT_RECEIVABLE_PRIORITY) {
    const selected = selectCurrentMakesafeReceivableInvoice(
      rows.filter((invoice) =>
        String(invoice?.status || "").toUpperCase() === status
      ),
    );
    if (selected) return selected;
  }
  return selectCurrentMakesafeReceivableInvoice(rows);
}

/**
 * Resolve one Captain-named Xero invoice for a bind-only pack repair.
 *
 * This is deliberately stricter than the duplicate-mint guard: a reference
 * match is not enough. The invoice number must be unique in the fetched ACCREC
 * set, linked to this exact job, and match this card's reference. A known
 * prior-cycle invoice is allowed only because this action requires the Captain
 * to name its exact invoice number; unsolicited placement remains governed by
 * the current-cycle selector. Nothing in this module can mint, authorise, send,
 * void, update, or otherwise mutate Xero.
 */
export function selectExistingInvoiceForPackBind(args: {
  job: any;
  detail: any;
  invoices: any[];
  expected_invoice_number: string;
}): any {
  const expected = normalizedInvoiceNumber(args.expected_invoice_number);
  if (!expected) {
    throw new SesBindExistingInvoiceError(
      400,
      "invoice_number_required",
      "invoice_number is required for bind-only recovery.",
    );
  }

  const exact = (args.invoices || []).filter((invoice) =>
    normalizedInvoiceNumber(invoice?.invoice_number) === expected
  );
  if (exact.length !== 1) {
    throw new SesBindExistingInvoiceError(
      409,
      exact.length === 0
        ? "named_invoice_not_found"
        : "named_invoice_ambiguous",
      exact.length === 0
        ? `No Xero invoice numbered ${expected} was found; bind-only recovery will not mint one.`
        : `More than one Xero row is numbered ${expected}; bind-only recovery refuses to guess.`,
    );
  }

  const invoice = exact[0];
  if (!String(invoice?.xero_invoice_id || "").trim()) {
    throw new SesBindExistingInvoiceError(
      409,
      "named_invoice_identity_missing",
      `${expected} has no Xero invoice id; bind-only recovery refuses to guess.`,
    );
  }
  if (String(invoice?.job_id || "") !== String(args.job?.id || "")) {
    throw new SesBindExistingInvoiceError(
      409,
      "named_invoice_wrong_job",
      `${expected} is not linked to this exact job; a reference-only match cannot bind a pack.`,
    );
  }
  if (String(invoice?.invoice_type || "").toUpperCase() !== "ACCREC") {
    throw new SesBindExistingInvoiceError(
      409,
      "named_invoice_wrong_type",
      `${expected} is not an ACCREC invoice and cannot bind a client closeout pack.`,
    );
  }

  const status = String(invoice?.status || "").toUpperCase();
  if (
    !(SES_BIND_EXISTING_INVOICE_STATUSES as readonly string[]).includes(status)
  ) {
    throw new SesBindExistingInvoiceError(
      409,
      "named_invoice_status_unsupported",
      `${expected} is ${
        status || "status unknown"
      }; only an existing DRAFT, AUTHORISED, or PAID invoice may bind.`,
    );
  }
  if (
    !String(invoice?.reference || "").trim() ||
    !makesafeInvoiceReferenceMatchesCard(args.job, args.detail, invoice)
  ) {
    throw new SesBindExistingInvoiceError(
      409,
      "named_invoice_not_current_card_receivable",
      `${expected} does not satisfy the exact job, ACCREC, and card-reference boundary.`,
    );
  }

  const attendanceCycle = makesafeInvoiceAttendanceCycle(args.detail, invoice);
  if (attendanceCycle === "unknown") {
    throw new SesBindExistingInvoiceError(
      409,
      "named_invoice_not_current_card_receivable",
      `${expected} has unknown attendance-cycle attribution; bind-only recovery refuses to guess.`,
    );
  }

  if (attendanceCycle === "current") {
    const selected = selectPreferredCurrentReceivableForPackBind(
      (args.invoices || []).filter((candidate) =>
        String(candidate?.job_id || "") === String(args.job?.id || "") &&
        makesafeInvoiceAttendanceCycle(args.detail, candidate) !== "prior"
      ),
    );
    if (
      String(selected?.xero_invoice_id || "") !==
        String(invoice.xero_invoice_id)
    ) {
      throw new SesBindExistingInvoiceError(
        409,
        "named_invoice_not_current_receivable",
        `${expected} is not the current receivable selected for this card; bind-only recovery will not attach stale money.`,
      );
    }
  }

  return {
    ...invoice,
    status,
    named_prior_cycle_bind: attendanceCycle === "prior",
  };
}

/**
 * Resolve the exact prior-cycle invoice that bind_existing durably adopted.
 *
 * The adoption proof is the invoice document written by the bind action. Its
 * compact snapshot is matched to both pack pointers and the current Xero mirror
 * row, so an unnamed prior-cycle invoice can never satisfy this path. Pure read
 * only: this helper does not mint, authorise, send, void, or update anything.
 */
export function selectNamedPriorCycleBoundInvoiceForPlacement(args: {
  job: any;
  detail: any;
  pack: any;
  documents: any[];
  invoices: any[];
}): any | null {
  const jobId = String(args.job?.id || "").trim();
  const invoiceDocumentId = String(args.pack?.invoice_doc_id || "").trim();
  const xeroInvoiceId = String(args.pack?.xero_invoice_id || "").trim();
  if (!jobId || !invoiceDocumentId || !xeroInvoiceId) return null;

  const adoption = (args.documents || []).find((document) =>
    String(document?.id || "") === invoiceDocumentId &&
    String(document?.job_id || "") === jobId &&
    String(document?.type || "").toLowerCase() === "invoice" &&
    String(document?.bind_source || "") ===
      "bind_existing_makesafe_invoice_pack" &&
    document?.bind_only === true &&
    document?.named_prior_cycle_bind === true &&
    String(document?.bound_xero_invoice_id || "") === xeroInvoiceId
  );
  if (!adoption) return null;

  const exact = (args.invoices || []).filter((invoice) =>
    String(invoice?.job_id || "") === jobId &&
    String(invoice?.xero_invoice_id || "") === xeroInvoiceId &&
    String(invoice?.invoice_type || "").toUpperCase() === "ACCREC" &&
    makesafeInvoiceAttendanceCycle(args.detail, invoice) === "prior" &&
    makesafeInvoiceReferenceMatchesCard(args.job, args.detail, invoice) &&
    SES_NAMED_PRIOR_CYCLE_PLACEMENT_STATUSES.has(
      String(invoice?.status || "").toUpperCase(),
    )
  );
  return exact.length === 1 ? exact[0] : null;
}
