// Invoice status evidence rows for business_events (context cadence slice K3).
//
// `invoice.authorised` and `invoice.emailed` are status-only records: they
// explain what happened to an invoice, they are never money truth (Xero is).
// Two things make them readable by the context pipeline without letting them
// mis-link:
//
// 1. A kept job id. The attribution ladder (`resolve_context_attribution`)
//    strips `job_id` from any row whose `match_method` is not
//    `direct_job_id` / `direct_reference` / `manual` (rule A). The authorised
//    writers used to insert without one, so every row lost its job.
// 2. Words with NO digits. Ladder step 1 matches job, invoice and PO numbers
//    anywhere in the row's words, so the invoice number stays in `payload`
//    (which `context_event_text` does not read for these keys) and the
//    `body_preview` is a fixed digit-free sentence. No address either.
//
// The authorised insert stays a raw, unconditional `business_events` insert:
// ops-api's own contract is that invoice events are always written, so it
// must never move behind the capture lane (`insertCapturedEvidence`).

export const INVOICE_AUTHORISED_BODY_PREVIEW = "Invoice authorised in Xero.";
export const INVOICE_EMAILED_BODY_PREVIEW = "Invoice emailed to the client.";

export type InvoiceAuthorisedSource =
  | "ops-api/approve_invoice"
  | "ops-api/approve_and_send_invoice"
  | "ops-api/makesafe_send_pack";

export function buildInvoiceAuthorisedEvidence(input: {
  source: InvoiceAuthorisedSource;
  xeroInvoiceId: string;
  jobId: string | null | undefined;
  payload: Record<string, unknown>;
  operator: string | null | undefined;
}): Record<string, unknown> {
  const jobId = input.jobId || null;
  return {
    event_type: "invoice.authorised",
    source: input.source,
    entity_type: "invoice",
    entity_id: input.xeroInvoiceId,
    job_id: jobId,
    correlation_id: jobId,
    // Only a job id we actually hold is direct custody; an unlinked invoice
    // leaves this null and the ladder treats the row as unplaced evidence.
    match_method: jobId ? "direct_job_id" : null,
    channel: "invoice",
    direction: "internal",
    body_preview: INVOICE_AUTHORISED_BODY_PREVIEW,
    payload: input.payload,
    metadata: { operator: input.operator || null },
  };
}

/**
 * Writes one `invoice.authorised` row. Unconditional on purpose: it goes
 * straight to `business_events` and never consults the capture lane. Never
 * throws, so an evidence outage cannot break the customer-side AUTHORISE; a
 * returned PostgREST error (which does not throw) is logged, not dropped.
 * Returns whether the row was written.
 */
export async function writeInvoiceAuthorisedEvidence(
  // deno-lint-ignore no-explicit-any
  client: any,
  input: Parameters<typeof buildInvoiceAuthorisedEvidence>[0],
): Promise<boolean> {
  try {
    const { error } = await client.from("business_events").insert(
      buildInvoiceAuthorisedEvidence(input),
    );
    if (error) {
      console.log(
        `[${input.source}] business_events invoice.authorised insert failed:`,
        error.message,
      );
      return false;
    }
    return true;
  } catch (e) {
    console.log(
      `[${input.source}] business_events invoice.authorised insert failed:`,
      (e as Error).message,
    );
    return false;
  }
}
