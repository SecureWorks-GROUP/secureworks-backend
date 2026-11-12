// What the customer and the office are told when the deposit invoice is not made
// on an online quote accept (13 Nov 2026, director's ruling, all trades).
//
// The accept handler asks ops-api send_acceptance_invoice for each deposit invoice
// (the per-party accept and the shared fence run accept). Until this change a
// refusal (for example createInvoice's "Invoice preflight failed: suburb" on a job
// whose site has no suburb) was only logged, or on a fence run not read at all: the
// accept still answered 200 and the page said the invoice was emailed (or told the
// customer to check their email), although no invoice had gone out and nobody in
// the office was told.
//
// Rules:
// - Only a reply with success true is an invoice that went out. Anything else (an
//   error reply, a held deposit, a thrown call, an unreadable reply) is a failure.
// - A failure says whether an invoice exists:
//     'no'      nothing was created (a deposit held before the call, or the
//               invoice preflight refusal, which runs before anything is written);
//     'yes'     ops-api created it and then stopped (not authorised, no pay link):
//               its reply carries the invoice number and Xero id;
//     'unknown' no identity came back but no known refusal either (a thrown call,
//               an unreadable reply, another error): the office checks Xero first.
//   Where the reply names an invoice the alert says it exists, what is wrong with
//   it, and to repair that invoice, never to raise another. Only where no identity
//   came back does it say no invoice was made.
// - On a failure the page says exactly ACCEPT_INVOICE_PENDING_WORDS and never that
//   an invoice was emailed or that the customer should check their email.
//   The successful path is unchanged.
// - Each failure writes one ai_alerts row naming the job (the alert list staff and
//   the agents read; closed with dismiss_alert). Nothing is retried here, and
//   bypass_preflight is never used or suggested.

export const ACCEPT_INVOICE_PENDING_WORDS = 'We will email your deposit invoice shortly.'

export const ACCEPTANCE_INVOICE_ALERT_TYPE = 'acceptance_invoice_failed'

export type InvoiceCreated = 'no' | 'yes' | 'unknown'

export type AcceptanceInvoiceFailure = {
  ok: false
  reason: string
  created: InvoiceCreated
  invoiceNumber: string | null
  xeroInvoiceId: string | null
  xeroStatus: string | null
}

export type AcceptanceInvoiceOutcome =
  | { ok: true; result: Record<string, unknown> }
  | AcceptanceInvoiceFailure

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

const PREFLIGHT_REFUSAL = /^Invoice preflight failed: ([^.]*)/

/** A failure with nothing created: the deposit was held before ops-api was asked. */
export function heldDepositFailure(reason: string): AcceptanceInvoiceFailure {
  return { ok: false, reason: `deposit held: ${reason}`, created: 'no', invoiceNumber: null, xeroInvoiceId: null, xeroStatus: null }
}

/** A failure whose outcome cannot be known: the call threw or its reply could not be read. */
export function uncertainFailure(reason: string): AcceptanceInvoiceFailure {
  return { ok: false, reason: reason || 'the invoice request failed', created: 'unknown', invoiceNumber: null, xeroInvoiceId: null, xeroStatus: null }
}

/** Reads ops-api's send_acceptance_invoice reply: only success true is an invoice that went out. */
export function acceptanceInvoiceOutcome(reply: unknown, httpStatus?: number): AcceptanceInvoiceOutcome {
  const r = (reply && typeof reply === 'object') ? reply as Record<string, unknown> : null
  if (r && r.success === true) return { ok: true, result: r }
  if (!r) return uncertainFailure(httpStatus != null ? `HTTP ${httpStatus}, unreadable reply` : 'unreadable reply')
  const invoiceNumber = text(r.invoice_number)
  const xeroInvoiceId = text(r.xero_invoice_id)
  const xeroStatus = text(r.xero_status)
  const error = text(r.error)
  const code = text(r.reason)
  const preflight = error ? PREFLIGHT_REFUSAL.exec(error) : null
  // The preflight sentence's second half suggests bypass_preflight; it is never repeated.
  const reason = preflight
    ? `Invoice preflight failed: ${preflight[1].trim()}`
    : (code || error || (httpStatus != null ? `HTTP ${httpStatus}` : 'no invoice in the reply'))
      // Staff-facing text carries no em dash.
      .replace(/\s*\u2014\s*/g, ', ')
  const created: InvoiceCreated = (invoiceNumber || xeroInvoiceId) ? 'yes' : preflight ? 'no' : 'unknown'
  return { ok: false, reason, created, invoiceNumber, xeroInvoiceId, xeroStatus }
}

// ops-api send_acceptance_invoice's reasons for an invoice it created but did not send.
const INVOICE_PROBLEM: Record<string, string> = {
  invoice_not_authorised: 'it is not authorised',
  online_invoice_url_unavailable: 'it has no payment link',
}

export type AcceptanceInvoiceAlertInput = {
  jobId: string
  jobNumber: string | null | undefined
  failure: AcceptanceInvoiceFailure
  jobDocumentId?: string | null
  jobContactId?: string | null
  runLabel?: string | null
}

/** The ai_alerts row for a deposit invoice that did not go out on an online accept. */
export function acceptanceInvoiceAlertRow(input: AcceptanceInvoiceAlertInput): Record<string, unknown> {
  const job = input.jobNumber || 'A job'
  const f = input.failure
  const told = `The customer was told: "${ACCEPT_INVOICE_PENDING_WORDS}"`
  const invoice = f.invoiceNumber || (f.xeroInvoiceId ? `Xero invoice ${f.xeroInvoiceId}` : 'the deposit invoice')
  let message: string
  let action: string
  if (f.created === 'yes') {
    // The reply named an invoice: it exists. Say what is wrong with it and repair THAT one.
    const problem = INVOICE_PROBLEM[f.reason] || f.reason
    message = `${job}: the customer accepted the quote online. Deposit invoice ${invoice} exists in Xero but ${problem}, so it was not sent to the customer${f.xeroStatus ? ` (Xero status ${f.xeroStatus})` : ''}. ${told}`
    action = `Open invoice ${invoice} in Xero and repair it (authorised, with a payment link), then send it to the customer. Do not raise another invoice.`
  } else if (f.created === 'no') {
    message = `${job}: the customer accepted the quote online but no deposit invoice was made (${f.reason}). ${told}`
    action = 'Fix the reason, then raise and email the deposit invoice from the accepted quote.'
  } else {
    // No invoice identity came back, but the call did not end in a known refusal.
    message = `${job}: the customer accepted the quote online but no deposit invoice came back (${f.reason}). ${told}`
    action = 'Check Xero for a deposit invoice on this job before raising one. If one exists, repair and send it.'
  }
  return {
    job_id: input.jobId,
    alert_type: ACCEPTANCE_INVOICE_ALERT_TYPE,
    severity: 'red',
    message,
    recommended_action: action,
    detail_json: {
      job_id: input.jobId,
      job_number: input.jobNumber || null,
      reason: f.reason,
      invoice_created: f.created,
      invoice_number: f.invoiceNumber,
      xero_invoice_id: f.xeroInvoiceId,
      xero_status: f.xeroStatus,
      job_document_id: input.jobDocumentId || null,
      job_contact_id: input.jobContactId || null,
      run_label: input.runLabel || null,
      source: 'send-quote/accept',
    },
  }
}

/** Writes the office alert. Never throws: the customer's acceptance stands either way. */
export async function alertAcceptanceInvoiceFailed(
  sb: { from: (table: string) => any },
  input: AcceptanceInvoiceAlertInput,
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

/**
 * Asks ops-api for one deposit invoice and reads the answer. Never throws:
 * a thrown call or an unreadable reply is an 'unknown' failure.
 */
export async function requestAcceptanceInvoice(
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
): Promise<AcceptanceInvoiceOutcome> {
  let res: Response
  try {
    res = await fetchFn(url, init)
  } catch (e) {
    return uncertainFailure((e as Error).message)
  }
  let reply: unknown = null
  try {
    reply = await res.json()
  } catch {
    reply = null
  }
  return acceptanceInvoiceOutcome(reply, res.status)
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

/** The fence run accepted page's deposit lines: the invoice note and the first next step. */
export function runDepositLines(opts: { invoiceFailed?: boolean }): { note: string; firstStep: string } {
  return opts.invoiceFailed
    ? { note: ACCEPT_INVOICE_PENDING_WORDS, firstStep: 'Pay your deposit once your invoice arrives' }
    : {
      note: "Deposit invoices are being created now. You'll receive yours by email shortly with a payment link.",
      firstStep: 'Pay your deposit via the invoice link (check your email)',
    }
}
