// deno-lint-ignore-file no-explicit-any
import {
  makesafeInvoiceIsCurrentAttendanceReceivable,
  selectCurrentMakesafeReceivableInvoice,
} from "./makesafe_docs_ready_invoice.ts";

export const SES_BIND_EXISTING_INVOICE_STATUSES = [
  "DRAFT",
  "AUTHORISED",
  "PAID",
] as const;

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

/**
 * Resolve one Captain-named Xero invoice for a bind-only pack repair.
 *
 * This is deliberately stricter than the duplicate-mint guard: a reference
 * match is not enough. The invoice number must be unique in the fetched ACCREC
 * set, linked to this exact job, current for this attendance, and the selected
 * current receivable on the card. Nothing in this module can mint, authorise,
 * send, void, update, or otherwise mutate Xero.
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
    !makesafeInvoiceIsCurrentAttendanceReceivable(
      args.job,
      args.detail,
      invoice,
    )
  ) {
    throw new SesBindExistingInvoiceError(
      409,
      "named_invoice_not_current_card_receivable",
      `${expected} does not satisfy the exact job, ACCREC, current-attendance, and card-reference boundary.`,
    );
  }

  const selected = selectCurrentMakesafeReceivableInvoice(
    (args.invoices || []).filter((candidate) =>
      String(candidate?.job_id || "") === String(args.job?.id || "")
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

  return { ...invoice, status };
}
