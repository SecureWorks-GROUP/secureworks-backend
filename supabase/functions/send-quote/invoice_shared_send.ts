/**
 * The shared invoice hold for the branded invoice email (/send-invoice).
 *
 * Every door that emails an invoice (ops-api's Outlook and Xero sends,
 * approve_and_send_invoice, and this one) holds the same item key
 * `invoice:<xero_invoice_id>` in outbound_send_claims. This door takes it
 * before its own invoice_email_send_claims row and Resend idempotency key,
 * which stay as they are:
 *   - called by approve_and_send_invoice, which already holds the claim, it
 *     joins that attempt (send_claim) once, as its dispatcher;
 *   - called on its own, it claims the invoice itself, through the same gate
 *     ops-api uses, so an unconfirmed send from any door (or an unknown-send
 *     event from before the claim store) holds it.
 * It settles from Resend's answer: sent only with a Resend message id; a
 * definite 4xx rejection is failed (nothing sent); a thrown call, a 2xx
 * without an id, or any other answer is unknown and holds the invoice.
 */

import {
  confirmSendDispatch,
  extendSendClaim,
  invoiceSendKey,
  sendClaimRefusalBody,
  sendClaimRefusalStatus,
  settleSend,
  type ClaimClient,
  type SettleState,
} from '../_shared/outbound_send_claim.ts'
import {
  claimInvoiceEmailSend as claimSharedInvoiceEmail,
  invoiceEmailClaimRefusal,
} from '../ops-api/invoice_email_resend_gate.ts'
import { resendResponseIsDefinitivePreSendRejection } from '../_shared/trade_quote_pack/quote_send_publication.ts'

export type SharedInvoiceSend = { attemptId: string; dispatchToken: string; joined: boolean }

export type SharedInvoiceSendRefusal = { ok: false; status: number; body: Record<string, unknown> }

/** The door's own key inside a joined attempt (the caller already holds invoice:<id>). */
export function sendQuoteInvoiceDoorKey(xeroInvoiceId: string): string {
  return `send_quote_invoice:${invoiceSendKey(xeroInvoiceId).slice('invoice:'.length)}`
}

function callerClaimOf(value: unknown): { item_key: string; attempt_id: string } | null {
  const v = value as Record<string, unknown> | null
  if (!v || typeof v !== 'object') return null
  const itemKey = typeof v.item_key === 'string' ? v.item_key.trim() : ''
  const attemptId = typeof v.attempt_id === 'string' ? v.attempt_id.trim() : ''
  return itemKey && attemptId ? { item_key: itemKey, attempt_id: attemptId } : null
}

/** Take (or join) the shared invoice hold before anything else is written or sent. */
export async function takeSharedInvoiceSend(
  client: ClaimClient & { from: (table: string) => any },
  input: { xeroInvoiceId: string; jobId: string | null; sendClaim?: unknown; actor?: string | null },
): Promise<({ ok: true } & SharedInvoiceSend) | SharedInvoiceSendRefusal> {
  const itemKey = invoiceSendKey(input.xeroInvoiceId)
  if (input.sendClaim !== undefined && input.sendClaim !== null) {
    const caller = callerClaimOf(input.sendClaim)
    if (!caller || caller.item_key !== itemKey) {
      return { ok: false, ...invoiceEmailClaimRefusal(input.xeroInvoiceId, { ok: false, code: 'send_claim_item_mismatch', held: [] }) }
    }
    const joined = await extendSendClaim(client, {
      attemptId: caller.attempt_id,
      keys: [sendQuoteInvoiceDoorKey(input.xeroInvoiceId)],
      callerItemKey: itemKey,
      actor: input.actor ?? null,
      detail: { door: 'send-quote/send-invoice', caller_item_key: itemKey },
    })
    if (!joined.ok) return { ok: false, ...invoiceEmailClaimRefusal(input.xeroInvoiceId, joined) }
    return { ok: true, attemptId: caller.attempt_id, dispatchToken: joined.dispatch_token, joined: true }
  }
  const claimed = await claimSharedInvoiceEmail(client, {
    xeroInvoiceId: input.xeroInvoiceId,
    via: 'branded',
    actor: input.actor ?? null,
    sentItemsChecked: false,
    detail: { door: 'send-quote/send-invoice', job_id: input.jobId },
    jobId: input.jobId,
  })
  if (!claimed.ok) return { ok: false, status: claimed.status, body: claimed.body }
  return { ok: true, attemptId: claimed.attemptId, dispatchToken: claimed.dispatchToken, joined: false }
}

/** Release the hold when this door stops before calling Resend: nothing was sent. */
export async function releaseSharedInvoiceSendNotSent(client: ClaimClient, shared: SharedInvoiceSend, reason: string): Promise<void> {
  await settleShared(client, shared, 'failed', { reason })
}

async function settleShared(client: ClaimClient, shared: SharedInvoiceSend, state: SettleState, detail: Record<string, unknown>) {
  const settled = await settleSend(client, shared.attemptId, state, { door: 'send-quote/send-invoice', ...detail })
  if (!settled.ok && settled.code !== 'send_claim_not_sending') {
    // The hold stays at sending; it reads as unknown once its lease passes.
    console.error(JSON.stringify({ event: 'send_invoice_shared_settle_failed', attempt_id: shared.attemptId, state, code: settled.code }))
  }
}

export type ResendInvoiceOutcome =
  | { kind: 'fenced'; status: number; body: Record<string, unknown> }
  | { kind: 'sent'; messageId: string; status: number }
  | { kind: 'failed'; status: number; errData: Record<string, unknown> }
  | { kind: 'unknown'; status: number | null; errData: Record<string, unknown> }

/**
 * The Resend call under the shared hold: the pre-send fence first, then the
 * call, then the settle from what Resend proved.
 */
export async function dispatchInvoiceResend(
  client: ClaimClient,
  shared: SharedInvoiceSend,
  send: () => Promise<Response>,
): Promise<ResendInvoiceOutcome> {
  const fence = await confirmSendDispatch(client, { attemptId: shared.attemptId, dispatchToken: shared.dispatchToken })
  if (!fence.ok) {
    await settleShared(client, shared, 'failed', { reason: 'dispatch_fenced' })
    return { kind: 'fenced', status: sendClaimRefusalStatus(fence), body: { ...sendClaimRefusalBody(fence), code: 'invoice_email_dispatch_fenced' } }
  }
  let res: Response
  try {
    res = await send()
  } catch {
    await settleShared(client, shared, 'outcome_unknown', { reason: 'resend_call_threw' })
    return { kind: 'unknown', status: null, errData: {} }
  }
  let data: unknown = null
  try { data = JSON.parse(await res.text()) } catch { data = null }
  const record = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}
  if (res.ok) {
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (id) {
      await settleShared(client, shared, 'sent', { status: res.status })
      return { kind: 'sent', messageId: id, status: res.status }
    }
    // A 2xx with no message id proves nothing about delivery.
    await settleShared(client, shared, 'outcome_unknown', { reason: 'resend_no_message_id', status: res.status })
    return { kind: 'unknown', status: res.status, errData: record }
  }
  if (resendResponseIsDefinitivePreSendRejection(res.status)) {
    await settleShared(client, shared, 'failed', { reason: 'resend_rejected', status: res.status })
    return { kind: 'failed', status: res.status, errData: record }
  }
  await settleShared(client, shared, 'outcome_unknown', { reason: 'resend_ambiguous', status: res.status })
  return { kind: 'unknown', status: res.status, errData: record }
}

/** Fixed wording for an unknown branded invoice email; no provider text. */
export const SEND_INVOICE_OUTCOME_UNKNOWN_BODY = {
  success: false,
  error: 'Invoice email outcome unknown: it may already have reached the client. Check the sent emails before sending again.',
  code: 'invoice_email_outcome_unknown',
  state: 'outcome_unknown',
  retry_safe: false,
}
