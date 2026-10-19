// The resend hold for invoice emails.
//
// Every invoice email, whichever door sends it (Outlook with a PDF, Xero's own
// email, or the branded email of approve_and_send_invoice), first claims the
// item key `invoice:<xero_invoice_id>` in outbound_send_claims
// (_shared/outbound_send_claim.ts) under a fresh attempt id, and settles that
// attempt after the reply. The claim is written before anything is sent and is
// one row per item, so:
//   - two presses that land together cannot both send (one claim wins);
//   - an Outlook send and a Xero-direct send of the same invoice share the key;
//   - an unknown outcome holds the invoice until someone checks Sent Items (or
//     the invoice History in Xero) and presses again marked as checked, whether
//     or not the invoice is linked to a job and whether or not the business
//     event lane is on;
//   - a later successful send can never clear an earlier unknown, because the
//     later send is never admitted while the earlier attempt is unresolved.
// A claim that cannot be written refuses the send. The business_events and
// job_events rows the callers also write are audit trails, not the hold.

import {
  claimSend,
  invoiceSendKey,
  newSendAttemptId,
  reconcileThenClaim,
  sendClaimRefusalBody,
  sendClaimRefusalStatus,
  settleSend,
  type SendClaimRefusal,
  type SettleState,
} from '../_shared/outbound_send_claim.ts'

export const INVOICE_EMAIL_EMAILED_EVENT = 'invoice.emailed'
export const INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT = 'invoice.email_outcome_unknown'
export const INVOICE_EMAIL_OUTCOME_RECONCILED_EVENT = 'invoice.email_outcome_reconciled'

export type InvoiceEmailVia = 'outlook' | 'xero' | 'branded'

export type InvoiceEmailClaim =
  | { ok: true; attemptId: string; itemKey: string; reconciled: boolean }
  | { ok: false; status: number; body: Record<string, unknown> }

/** The refusal body for an invoice email the hold refuses. Fixed text only. */
export function invoiceEmailClaimRefusal(xeroInvoiceId: string, result: SendClaimRefusal): { status: number; body: Record<string, unknown> } {
  const body = sendClaimRefusalBody(result)
  const code = result.code === 'send_claim_held'
    ? (body.state === 'sending' ? 'invoice_email_send_in_progress' : 'invoice_email_outcome_unreconciled')
    : result.code === 'send_claim_unavailable' || result.code === 'send_claim_unreadable'
    ? 'invoice_email_hold_unavailable'
    : result.code
  return {
    status: sendClaimRefusalStatus(result),
    body: { ...body, code, claim_code: result.code, xero_invoice_id: xeroInvoiceId },
  }
}

/**
 * Claim the invoice before any email goes out. With sentItemsChecked the
 * caller says the earlier send is not in Sent Items (or Xero History): that is
 * recorded against the named attempt with who checked and when, compare-and-
 * set, and only then is the new send claimed. A checked press with no named
 * checker, or against a send still in progress, is refused.
 */
export async function claimInvoiceEmailSend(
  client: any,
  input: {
    xeroInvoiceId: string
    via: InvoiceEmailVia
    actor: string | null
    sentItemsChecked: boolean
    checkedAt?: string | null
    expectedAttemptId?: string | null
    detail?: Record<string, unknown>
  },
): Promise<InvoiceEmailClaim> {
  const itemKey = invoiceSendKey(input.xeroInvoiceId)
  const attemptId = newSendAttemptId(`invoice_email_${input.via}`)
  const detail = { via: input.via, xero_invoice_id: input.xeroInvoiceId, ...(input.detail ?? {}) }
  const result = input.sentItemsChecked
    ? await reconcileThenClaim(client, {
      keys: [itemKey],
      attemptId,
      actor: input.actor,
      checkedAt: input.checkedAt ?? null,
      evidence: input.via === 'xero' ? 'xero_history_checked' : 'sent_items_checked',
      expectedAttemptId: input.expectedAttemptId ?? null,
      detail,
    })
    : await claimSend(client, { keys: [itemKey], attemptId, actor: input.actor, detail })
  if (!result.ok) {
    console.error(JSON.stringify({ event: 'invoice_email_hold_refused', entity_id: input.xeroInvoiceId, code: result.code }))
    return { ok: false, ...invoiceEmailClaimRefusal(input.xeroInvoiceId, result) }
  }
  return { ok: true, attemptId, itemKey, reconciled: input.sentItemsChecked }
}

/** Settle the attempt. A failed settle leaves the hold in place (it reads stale later). */
export async function settleInvoiceEmailSend(
  client: any,
  attemptId: string,
  state: SettleState,
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  const settled = await settleSend(client, attemptId, state, detail)
  // send-outlook-email settles a caller's claim itself when it can; the first
  // settle wins (compare-and-set), so a later one finding it settled is fine.
  if (!settled.ok && settled.code === 'send_claim_not_sending') return true
  if (!settled.ok) {
    console.error(JSON.stringify({ event: 'invoice_email_settle_failed', attempt_id: attemptId, state, code: settled.code }))
  }
  return settled.ok
}

/** Writes a gate event to job_events when the invoice is linked to a job. Never throws. */
export async function writeInvoiceEmailGateJobEvent(
  client: any,
  jobId: string | null,
  eventType: string,
  detail: Record<string, unknown>,
): Promise<boolean> {
  if (!jobId) return false
  try {
    const { error } = await client.from('job_events').insert({ job_id: jobId, event_type: eventType, detail_json: detail })
    if (error) {
      console.error(JSON.stringify({ event: 'invoice_email_gate_job_event_failed', event_type: eventType, error: error.message }))
      return false
    }
    return true
  } catch (e) {
    console.error(JSON.stringify({ event: 'invoice_email_gate_job_event_failed', event_type: eventType, error: (e as Error)?.message }))
    return false
  }
}
