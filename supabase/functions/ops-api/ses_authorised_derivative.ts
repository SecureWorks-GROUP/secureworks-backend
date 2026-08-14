import { extractPdfText } from "./makesafe_pdf_text.ts";

export const SES_AUTHORISED_DERIVATIVE_CONTRACT =
  "ses-authorised-derivative/v1" as const;

export const SES_AUTHORISED_DERIVATIVE_MISMATCH =
  "authorised_derivative_mismatch" as const;

export interface SesDerivativeInvoiceIdentity {
  xero_invoice_id: string;
  invoice_number: string;
  status: string;
  reference: string;
  total: number;
}

export interface SesAuthorisedDerivativeProof {
  contract: typeof SES_AUTHORISED_DERIVATIVE_CONTRACT;
  xero_invoice_id: string;
  reference: string;
  total: number;
  draft_invoice_number: string;
  authorised_invoice_number: string;
  draft_pdf_content_hash: string;
  authorised_pdf_content_hash: string;
  canonical_text_hash: string;
  page_count: number;
}

export type SesAuthorisedDerivativeMismatchReason =
  | "invoice_identity_missing"
  | "invoice_identity_changed"
  | "invoice_status_transition_invalid"
  | "invoice_reference_changed"
  | "invoice_total_changed"
  | "pdf_unreadable"
  | "pdf_text_truncated"
  | "pdf_page_count_changed"
  | "pdf_content_changed";

export class SesAuthorisedDerivativeError extends Error {
  readonly code = SES_AUTHORISED_DERIVATIVE_MISMATCH;

  constructor(
    readonly reason: SesAuthorisedDerivativeMismatchReason,
    message: string,
  ) {
    super(message);
    this.name = "SesAuthorisedDerivativeError";
  }
}

function mismatch(
  reason: SesAuthorisedDerivativeMismatchReason,
  message: string,
): never {
  throw new SesAuthorisedDerivativeError(reason, message);
}

function requiredText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function moneyInCents(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return `sha256:${
    Array.from(new Uint8Array(digest)).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
}

function replaceLiteral(
  value: string,
  literal: string,
  replacement: string,
): string {
  return value.split(literal).join(replacement);
}

function replaceStandaloneStatus(value: string, status: string): string {
  const escaped = status.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(
    new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "g"),
    (_match, prefix: string) => `${prefix}<INVOICE_STATUS>`,
  );
}

/**
 * Canonicalise only the two changes Xero may make while authorising the exact
 * approved DRAFT: the exact invoice-number value and the standalone status
 * token. Whitespace, line order, amounts, descriptions, recipients and every
 * other extracted character remain comparison-significant.
 */
function canonicalPdfText(
  text: string,
  invoiceNumber: string,
  status: "DRAFT" | "AUTHORISED",
): string {
  return replaceStandaloneStatus(
    replaceLiteral(text, invoiceNumber, "<INVOICE_NUMBER>"),
    status,
  );
}

/**
 * Proves that an AUTHORISED Xero invoice/PDF is the deterministic derivative
 * pre-ratified by approval of the corresponding DRAFT. This helper is
 * deliberately fail closed: it returns only after both structured identity and
 * readable, complete PDF text agree under the two explicitly allowed changes.
 */
export async function verifySesAuthorisedDerivative(args: {
  draft_invoice: SesDerivativeInvoiceIdentity;
  authorised_invoice: SesDerivativeInvoiceIdentity;
  draft_pdf: Uint8Array;
  authorised_pdf: Uint8Array;
}): Promise<SesAuthorisedDerivativeProof> {
  const draftId = requiredText(args.draft_invoice?.xero_invoice_id);
  const authorisedId = requiredText(
    args.authorised_invoice?.xero_invoice_id,
  );
  const draftNumber = requiredText(args.draft_invoice?.invoice_number);
  const authorisedNumber = requiredText(
    args.authorised_invoice?.invoice_number,
  );
  const draftReference = requiredText(args.draft_invoice?.reference);
  const authorisedReference = requiredText(args.authorised_invoice?.reference);
  if (
    !draftId || !authorisedId || !draftNumber || !authorisedNumber ||
    !draftReference || !authorisedReference
  ) {
    mismatch(
      "invoice_identity_missing",
      "The DRAFT and AUTHORISED invoices require exact ids, numbers and references.",
    );
  }
  if (draftId !== authorisedId) {
    mismatch(
      "invoice_identity_changed",
      "The AUTHORISED invoice id differs from the approved DRAFT invoice id.",
    );
  }
  if (
    requiredText(args.draft_invoice.status).toUpperCase() !== "DRAFT" ||
    requiredText(args.authorised_invoice.status).toUpperCase() !== "AUTHORISED"
  ) {
    mismatch(
      "invoice_status_transition_invalid",
      "The deterministic derivative requires the exact DRAFT to AUTHORISED transition.",
    );
  }
  if (draftReference !== authorisedReference) {
    mismatch(
      "invoice_reference_changed",
      "The AUTHORISED invoice reference differs from the approved DRAFT reference.",
    );
  }
  const draftCents = moneyInCents(args.draft_invoice.total);
  const authorisedCents = moneyInCents(args.authorised_invoice.total);
  if (draftCents === null || authorisedCents === null) {
    mismatch(
      "invoice_identity_missing",
      "The DRAFT and AUTHORISED invoices require finite totals.",
    );
  }
  if (draftCents !== authorisedCents) {
    mismatch(
      "invoice_total_changed",
      "The AUTHORISED invoice total differs from the approved DRAFT total.",
    );
  }

  const [draftExtracted, authorisedExtracted] = await Promise.all([
    extractPdfText(args.draft_pdf),
    extractPdfText(args.authorised_pdf),
  ]);
  const draftPageCount = draftExtracted.pageCount;
  const authorisedPageCount = authorisedExtracted.pageCount;
  if (
    draftExtracted.mode !== "text" || authorisedExtracted.mode !== "text" ||
    !draftExtracted.text || !authorisedExtracted.text ||
    typeof draftPageCount !== "number" || !Number.isInteger(draftPageCount) ||
    typeof authorisedPageCount !== "number" ||
    !Number.isInteger(authorisedPageCount)
  ) {
    mismatch(
      "pdf_unreadable",
      "Both Xero PDFs must have a readable text layer and a verified page count.",
    );
  }
  if (draftExtracted.truncated || authorisedExtracted.truncated) {
    mismatch(
      "pdf_text_truncated",
      "The Xero PDF text exceeded the complete-comparison limit.",
    );
  }
  if (draftPageCount !== authorisedPageCount) {
    mismatch(
      "pdf_page_count_changed",
      "The AUTHORISED invoice PDF page count differs from the approved DRAFT PDF.",
    );
  }

  const draftCanonical = canonicalPdfText(
    draftExtracted.text,
    draftNumber,
    "DRAFT",
  );
  const authorisedCanonical = canonicalPdfText(
    authorisedExtracted.text,
    authorisedNumber,
    "AUTHORISED",
  );
  if (draftCanonical !== authorisedCanonical) {
    mismatch(
      "pdf_content_changed",
      "The AUTHORISED invoice PDF changed outside the allowed status and invoice-number fields.",
    );
  }

  const [draftHash, authorisedHash, canonicalHash] = await Promise.all([
    sha256(args.draft_pdf),
    sha256(args.authorised_pdf),
    sha256(draftCanonical),
  ]);
  return {
    contract: SES_AUTHORISED_DERIVATIVE_CONTRACT,
    xero_invoice_id: draftId,
    reference: draftReference,
    total: draftCents / 100,
    draft_invoice_number: draftNumber,
    authorised_invoice_number: authorisedNumber,
    draft_pdf_content_hash: draftHash,
    authorised_pdf_content_hash: authorisedHash,
    canonical_text_hash: canonicalHash,
    page_count: draftPageCount,
  };
}
