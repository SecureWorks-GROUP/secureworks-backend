// deno-lint-ignore-file no-explicit-any
/** Metadata only: bind an actual acceptance create result to its exact frozen deposit. */
import { completeInvoicePage } from "./invoice_milestone_drafts.ts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown): string | null => typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null;
type Row = Record<string, any>;
export interface AcceptanceDepositReceiptInput {
  orgId: string;
  jobId: string;
  documentId: unknown;
  partyId?: unknown;
  runLabel?: unknown;
  /** Only the private createDepositInvoice return, never a request-body or jobs-row identity. */
  creationResult: unknown;
  /** Private in-process evidence, unavailable from any request body. */
  dispatchToken?: unknown;
}
export interface AcceptanceDepositReceiptDeps {
  readInvoice(id: string): Promise<unknown>;
}
type Dispatch = {
  orgId: string;
  jobId: string;
  documentId: string;
  revisionId: string;
  reference: string;
  replayInvoiceId: string | null;
};
const dispatches = new WeakMap<object, Dispatch>();
export type AcceptanceDepositDispatchResult = {
  state: "prepared";
  token: object;
} | { state: "held"; reason: string };
export type AcceptanceDepositReceiptResult =
  | { state: "held"; reason: string }
  | {
    state: "captured";
    quote_revision_id: string;
    accepted_document_id: string;
    provider_invoice_id: string;
    stage_id: string;
    reused: boolean;
  };
const held = (reason: string): AcceptanceDepositReceiptResult => ({
  state: "held",
  reason,
});
function acceptedAfterRelease(doc: Row, revision: Row): boolean {
  const accepted = Date.parse(doc.accepted_at), released = Date.parse(revision.sent_at), sent = Date.parse(doc.sent_at);
  return Number.isFinite(accepted) && Number.isFinite(released) && Number.isFinite(sent) && accepted >= released &&
    accepted >= sent;
}
function cents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const n = Math.round(value * 100);
  return Number.isSafeInteger(n) && Math.abs(value * 100 - n) < 0.00001 ? n : null;
}
function sameReceipt(a: Row | null, b: Row): boolean {
  return !!a &&
    [
      "org_id",
      "job_id",
      "quote_revision_id",
      "accepted_document_id",
      "provider_invoice_id",
      "xero_contact_id",
      "stage_id",
      "reference",
    ]
      .every((k) => a[k] === b[k]) &&
    Number(a.amount_cents) === b.amount_cents;
}
function captured(row: Row, reused: boolean): AcceptanceDepositReceiptResult {
  return {
    state: "captured",
    quote_revision_id: row.quote_revision_id,
    accepted_document_id: row.accepted_document_id,
    provider_invoice_id: row.provider_invoice_id,
    stage_id: row.stage_id,
    reused,
  };
}
/** Fresh dispatch evidence, not proof of global provider-origin or absence. */
export async function prepareAcceptanceDepositDispatch(
  client: any,
  input:
    & Omit<AcceptanceDepositReceiptInput, "creationResult" | "dispatchToken">
    & { reference: string },
  findInvoices: (reference: string) => Promise<unknown>,
): Promise<AcceptanceDepositDispatchResult> {
  try {
    const orgId = uuid(input.orgId),
      jobId = uuid(input.jobId),
      documentId = uuid(input.documentId);
    if (
      !orgId || !jobId || !documentId || input.partyId || input.runLabel ||
      typeof input.reference !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/.test(input.reference)
    ) {
      return {
        state: "held",
        reason: "exact_acceptance_dispatch_identity_required",
      };
    }
    const doc = await client.from("job_documents").select(
      "id,job_id,type,quote_revision_id,job_contact_id,run_label,accepted_at,sent_at,superseded_at",
    )
      .eq("id", documentId).eq("job_id", jobId).maybeSingle();
    const revisionId = uuid(doc.data?.quote_revision_id);
    if (
      doc.error || !revisionId || uuid(doc.data?.id) !== documentId ||
      doc.data?.type !== "quote" || !doc.data?.accepted_at ||
      !doc.data?.sent_at || doc.data?.superseded_at ||
      doc.data?.job_contact_id || doc.data?.run_label
    ) {
      return { state: "held", reason: "exact_accepted_document_required" };
    }
    const revision = await client.from("quote_revisions").select(
      "id,job_id,job_document_id,sent_at",
    )
      .eq("id", revisionId).eq("job_id", jobId).maybeSingle();
    if (
      revision.error || !revision.data ||
      uuid(revision.data.job_document_id) !== documentId ||
      !acceptedAfterRelease(doc.data, revision.data)
    ) {
      return {
        state: "held",
        reason: "exact_released_revision_acceptance_required",
      };
    }
    const binding = await client.from("quote_invoice_billing_bindings").select(
      "*",
    )
      .eq("quote_revision_id", revisionId).eq("org_id", orgId).eq(
        "job_id",
        jobId,
      ).maybeSingle();
    if (
      binding.error || binding.data?.state !== "eligible" ||
      !uuid(binding.data?.xero_contact_id)
    ) {
      return { state: "held", reason: "frozen_single_payer_required" };
    }
    const page = await findInvoices(input.reference) as Row;
    if (!completeInvoicePage(page)) {
      return {
        state: "held",
        reason: "deposit_predispatch_inventory_unconfirmed",
      };
    }
    let replayInvoiceId: string | null = null;
    if (page.Invoices.length !== 0) {
      if (page.Invoices.length !== 1 || !uuid(page.Invoices[0]?.InvoiceID)) {
        return { state: "held", reason: "existing_deposit_requires_review" };
      }
      replayInvoiceId = uuid(page.Invoices[0].InvoiceID)!;
      const existing = await client.from("quote_invoice_deposit_receipts")
        .select("*")
        .eq("org_id", orgId).eq("provider_invoice_id", replayInvoiceId)
        .maybeSingle();
      if (
        existing.error || !existing.data || existing.data.job_id !== jobId ||
        existing.data.accepted_document_id !== documentId ||
        existing.data.quote_revision_id !== revisionId ||
        existing.data.reference !== input.reference
      ) {
        return {
          state: "held",
          reason: "unbound_existing_deposit_requires_review",
        };
      }
    }
    const token = Object.freeze({});
    dispatches.set(token, {
      orgId,
      jobId,
      documentId,
      revisionId,
      reference: input.reference,
      replayInvoiceId,
    });
    return { state: "prepared", token };
  } catch {
    return {
      state: "held",
      reason: "deposit_predispatch_inventory_unconfirmed",
    };
  }
}
/**
 * No invoice calculation, creation, status change or send is reachable here.
 * Failure leaves later automatic billing held; it never retries the acceptance effect.
 */
export async function captureAcceptanceDepositReceipt(
  client: any,
  input: AcceptanceDepositReceiptInput,
  deps: AcceptanceDepositReceiptDeps,
): Promise<AcceptanceDepositReceiptResult> {
  try {
    const orgId = uuid(input.orgId),
      jobId = uuid(input.jobId),
      documentId = uuid(input.documentId);
    const made = input.creationResult as Row | null;
    const invoiceId = uuid(made?.xero_invoice_id);
    const dispatch = input.dispatchToken && typeof input.dispatchToken === "object"
      ? dispatches.get(input.dispatchToken)
      : null;
    if (
      !orgId || !jobId || !documentId || input.partyId || input.runLabel ||
      !made || made.success !== true ||
      uuid(made.job_id) !== jobId || !invoiceId ||
      typeof made.reference !== "string" || !made.reference.trim() ||
      !dispatch || dispatch.orgId !== orgId || dispatch.jobId !== jobId ||
      dispatch.documentId !== documentId ||
      dispatch.reference !== made.reference ||
      (dispatch.replayInvoiceId !== null &&
        dispatch.replayInvoiceId !== invoiceId)
    ) {
      return held("exact_acceptance_create_identity_required");
    }

    const docResult = await client.from("job_documents")
      .select(
        "id,job_id,type,quote_revision_id,job_contact_id,run_label,accepted_at,sent_at,superseded_at",
      )
      .eq("id", documentId).eq("job_id", jobId).maybeSingle();
    if (docResult.error) return held("accepted_document_unreadable");
    const doc = docResult.data;
    const revisionId = uuid(doc?.quote_revision_id);
    if (
      !doc || uuid(doc.id) !== documentId || uuid(doc.job_id) !== jobId ||
      doc.type !== "quote" || !revisionId ||
      revisionId !== dispatch.revisionId ||
      !doc.accepted_at || !doc.sent_at || doc.superseded_at ||
      doc.job_contact_id || doc.run_label
    ) {
      return held("exact_accepted_document_required");
    }
    const revisionResult = await client.from("quote_revisions")
      .select("id,job_id,job_document_id,sent_at,pricing_snapshot_json")
      .eq("id", revisionId).eq("job_id", jobId).maybeSingle();
    if (revisionResult.error) return held("accepted_revision_unreadable");
    const revision = revisionResult.data;
    if (
      !revision || uuid(revision.id) !== revisionId ||
      uuid(revision.job_id) !== jobId ||
      uuid(revision.job_document_id) !== documentId || !revision.sent_at ||
      !acceptedAfterRelease(doc, revision)
    ) {
      return held("exact_released_revision_required");
    }
    const bindingResult = await client.from("quote_invoice_billing_bindings")
      .select("*")
      .eq("quote_revision_id", revisionId).eq("org_id", orgId).eq(
        "job_id",
        jobId,
      ).maybeSingle();
    if (bindingResult.error) return held("frozen_payer_unreadable");
    const binding = bindingResult.data,
      payerId = uuid(binding?.xero_contact_id);
    if (
      !binding || binding.state !== "eligible" || !payerId ||
      uuid(binding.org_id) !== orgId ||
      uuid(binding.job_id) !== jobId ||
      uuid(binding.quote_revision_id) !== revisionId
    ) {
      return held("frozen_single_payer_required");
    }
    const raw = revision.pricing_snapshot_json?.raw;
    const payments = raw?.payment_schedule?.payments;
    const first = Array.isArray(payments) ? payments[0] : null;
    const amount = cents(first?.amount_inc_gst);
    if (
      raw?.pricing_complete !== true || raw?.payment_schedule?.version !== 1 ||
      !Array.isArray(payments) ||
      payments.length < 2 || !first || typeof first.id !== "string" ||
      !first.id.trim() || first.id.length > 100 ||
      typeof first.label !== "string" || !first.label.trim() ||
      typeof first.printed_terms !== "string" ||
      amount === null || payments.some((p: any) => !p || typeof p.id !== "string" || !p.id.trim()) ||
      new Set(payments.map((p: any) => p.id)).size !== payments.length
    ) {
      return held("frozen_first_printed_payment_required");
    }

    const invoice = await deps.readInvoice(invoiceId) as Row | null;
    if (
      !invoice || uuid(invoice.InvoiceID) !== invoiceId ||
      invoice.Type !== "ACCREC" ||
      !["AUTHORISED", "PAID"].includes(invoice.Status) ||
      invoice.CurrencyCode !== "AUD" ||
      uuid(invoice.Contact?.ContactID) !== payerId ||
      cents(invoice.Total) !== amount ||
      invoice.Reference !== made.reference
    ) {
      return held("provider_deposit_identity_or_amount_unconfirmed");
    }
    const receipt = {
      org_id: orgId,
      job_id: jobId,
      quote_revision_id: revisionId,
      accepted_document_id: documentId,
      provider_invoice_id: invoiceId,
      xero_contact_id: payerId,
      stage_id: first.id,
      amount_cents: amount,
      reference: invoice.Reference,
    };
    const read = async () =>
      await client.from("quote_invoice_deposit_receipts").select("*")
        .eq("org_id", orgId).eq("provider_invoice_id", invoiceId).maybeSingle();
    const before = await read();
    if (before.error) return held("deposit_receipt_unreadable");
    if (before.data) {
      return sameReceipt(before.data, receipt) ? captured(receipt, true) : held("deposit_receipt_identity_conflict");
    }
    const inserted = await client.from("quote_invoice_deposit_receipts").insert(
      receipt,
    );
    if (inserted.error && inserted.error.code !== "23505") {
      return held("deposit_receipt_persistence_unconfirmed");
    }
    const after = await read();
    if (after.error || !sameReceipt(after.data, receipt)) {
      return held("deposit_receipt_persistence_unconfirmed");
    }
    return captured(receipt, !!inserted.error);
  } catch {
    return held("deposit_receipt_unconfirmed_no_retry");
  }
}
