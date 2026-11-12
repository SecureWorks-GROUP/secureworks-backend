// What the customer and the office are told when the deposit invoice is not made
// on an online quote accept (13 Nov 2026, director's ruling).
//
// The accept handler asks ops-api send_acceptance_invoice for the deposit invoice.
// Until this change a refusal (for example createInvoice's "Invoice preflight
// failed: suburb" on a job whose site has no suburb) was only logged: the accept
// still answered 200 and the page said "Your deposit invoice has been emailed to
// you", although no invoice existed and nobody in the office was told.
//
// Rules:
// - Only a reply with success true is an invoice. Anything else (an error reply,
//   a held deposit, a thrown call, an unreadable reply) is a failure with a reason.
// - On a failure the page says exactly ACCEPT_INVOICE_PENDING_WORDS and never
//   that an invoice was emailed. The successful path is unchanged.
// - On a failure the office gets one ai_alerts row naming the job and the reason
//   (the alert list staff and the agents read; dismissed with dismiss_alert).
//   Nothing is retried here, so one accept never raises two invoices, and
//   bypass_preflight is never used.

export const ACCEPT_INVOICE_PENDING_WORDS = 'We will email your deposit invoice shortly.'

export const ACCEPTANCE_INVOICE_ALERT_TYPE = 'acceptance_invoice_failed'

export type AcceptanceInvoiceOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; reason: string }

/** Reads ops-api's send_acceptance_invoice reply: only success true is an invoice. */
export function acceptanceInvoiceOutcome(reply: unknown, httpStatus?: number): AcceptanceInvoiceOutcome {
  const r = (reply && typeof reply === 'object') ? reply as Record<string, unknown> : null
  if (r && r.success === true) return { ok: true, result: r }
  const error = r && typeof r.error === 'string' && r.error.trim() ? r.error.trim() : ''
  const status = httpStatus != null ? `HTTP ${httpStatus}` : ''
  return { ok: false, reason: error || status || 'no invoice in the reply' }
}

/** The ai_alerts row for a deposit invoice not made on an online accept. */
export function acceptanceInvoiceAlertRow(input: {
  jobId: string
  jobNumber: string | null | undefined
  reason: string
  jobDocumentId?: string | null
  jobContactId?: string | null
}): Record<string, unknown> {
  const job = input.jobNumber || 'A job'
  return {
    job_id: input.jobId,
    alert_type: ACCEPTANCE_INVOICE_ALERT_TYPE,
    severity: 'red',
    message: `${job}: the customer accepted the quote online but the deposit invoice was not created (${input.reason}). The customer was told: "${ACCEPT_INVOICE_PENDING_WORDS}"`,
    recommended_action: 'Fix the reason, then raise and email the deposit invoice from the accepted quote.',
    detail_json: {
      job_id: input.jobId,
      job_number: input.jobNumber || null,
      reason: input.reason,
      job_document_id: input.jobDocumentId || null,
      job_contact_id: input.jobContactId || null,
      source: 'send-quote/accept',
    },
  }
}

/** Writes the office alert. Never throws: the customer's acceptance stands either way. */
export async function alertAcceptanceInvoiceFailed(
  sb: { from: (table: string) => any },
  input: Parameters<typeof acceptanceInvoiceAlertRow>[0],
): Promise<boolean> {
  try {
    const { error } = await sb.from('ai_alerts').insert(acceptanceInvoiceAlertRow(input))
    if (error) {
      console.error('[send-quote] acceptance invoice alert not written:', error.message || String(error))
      return false
    }
    return true
  } catch (e) {
    console.error('[send-quote] acceptance invoice alert not written:', (e as Error).message)
    return false
  }
}

/** The line under the deposit amount on the accept page. */
export function depositPaymentLine(opts: { paymentUrl: string; invoiceFailed?: boolean }): string {
  if (opts.invoiceFailed) {
    return `<p style="color:#4C6A7C;font-size:14px;">${ACCEPT_INVOICE_PENDING_WORDS}</p>`
  }
  return opts.paymentUrl
    ? `<a href="${opts.paymentUrl}" class="btn btn-pay" target="_blank">Pay Now - Card or Bank Transfer</a>`
    : '<p style="color:#4C6A7C;font-size:14px;">Your deposit invoice has been emailed to you. You can pay by card or bank transfer.</p>'
}

/** The accept page card when no deposit amount is shown. */
export function noDepositAmountLine(opts: { invoiceFailed?: boolean }): string {
  return opts.invoiceFailed
    ? `<p style="color:#4C6A7C;font-size:14px;">${ACCEPT_INVOICE_PENDING_WORDS}</p>`
    : '<p style="color:#4C6A7C;font-size:14px;">Your deposit invoice will be sent to you shortly. You can pay by card or bank transfer.</p>'
}
