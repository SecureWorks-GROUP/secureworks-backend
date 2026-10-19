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
// A claim that cannot be written refuses the send.
//
// The unknown-send events written before the claim store existed still hold:
// an `invoice.email_outcome_unknown` in business_events or job_events with no
// later `invoice.email_outcome_reconciled` refuses every door until someone
// checks and presses again marked as checked (readLegacyInvoiceEmailHold). A
// later `invoice.emailed` never clears it. A store that cannot be read refuses.
// A checked press that releases such a hold writes the reconciled event after
// its own claim succeeds and before anything is sent, so two checked presses
// together release it once: the second either meets the first one's claim or,
// once that settles, finds the hold already released and is refused.

import {
  claimSend,
  reconcileActor,
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
  | { ok: true; attemptId: string; itemKey: string; dispatchToken: string; reconciled: boolean; legacyReleased: boolean }
  | { ok: false; status: number; body: Record<string, unknown> }

const LEGACY_HOLD_EVENT_TYPES = [INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT, INVOICE_EMAIL_OUTCOME_RECONCILED_EVENT]

export type LegacyInvoiceEmailHold =
  | { state: 'clear' }
  | { state: 'held'; unknown_since: string }
  | { state: 'unreadable' }

function newestAt(rows: Array<{ event_type: string; at: unknown }>, type: string): number {
  let best = Number.NEGATIVE_INFINITY
  for (const row of rows) {
    if (row.event_type !== type || typeof row.at !== 'string') continue
    const at = Date.parse(row.at)
    if (!Number.isNaN(at) && at > best) best = at
  }
  return best
}

/**
 * The unknown-send hold recorded before the claim store: the newest
 * `invoice.email_outcome_unknown` in either store, unless a reconciled event
 * is at or after it. `invoice.emailed` is not read. Any read error is
 * unreadable, never clear.
 */
export async function readLegacyInvoiceEmailHold(client: any, xeroInvoiceId: string): Promise<LegacyInvoiceEmailHold> {
  try {
    const [be, je] = await Promise.all([
      client.from('business_events')
        .select('event_type, occurred_at')
        .eq('entity_type', 'xero_invoice')
        .eq('entity_id', xeroInvoiceId)
        .in('event_type', LEGACY_HOLD_EVENT_TYPES)
        .order('occurred_at', { ascending: false }),
      client.from('job_events')
        .select('event_type, created_at')
        .eq('detail_json->>xero_invoice_id', xeroInvoiceId)
        .in('event_type', LEGACY_HOLD_EVENT_TYPES)
        .order('created_at', { ascending: false }),
    ])
    if (!be || be.error || !Array.isArray(be.data) || !je || je.error || !Array.isArray(je.data)) return { state: 'unreadable' }
    const rows = [
      ...be.data.map((r: any) => ({ event_type: String(r?.event_type ?? ''), at: r?.occurred_at })),
      ...je.data.map((r: any) => ({ event_type: String(r?.event_type ?? ''), at: r?.created_at })),
    ]
    const unknown = newestAt(rows, INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT)
    if (unknown === Number.NEGATIVE_INFINITY) return { state: 'clear' }
    if (newestAt(rows, INVOICE_EMAIL_OUTCOME_RECONCILED_EVENT) >= unknown) return { state: 'clear' }
    return { state: 'held', unknown_since: new Date(unknown).toISOString() }
  } catch {
    return { state: 'unreadable' }
  }
}

function legacyRefusal(
  xeroInvoiceId: string,
  code: 'invoice_email_outcome_unreconciled' | 'invoice_email_hold_unavailable' | 'send_reconcile_actor_required' | 'send_reconcile_state_changed',
  unknownSince: string | null,
): { status: number; body: Record<string, unknown> } {
  const unavailable = code === 'invoice_email_hold_unavailable'
  const body = sendClaimRefusalBody({
    ok: false,
    code: unavailable ? 'send_claim_unreadable' : code === 'invoice_email_outcome_unreconciled' ? 'send_claim_held' : code,
    held: [],
  })
  return {
    status: unavailable ? 503 : 409,
    body: {
      ...body, code, claim_code: unavailable ? 'legacy_hold_unreadable' : 'legacy_hold',
      xero_invoice_id: xeroInvoiceId, unknown_since: unknownSince,
    },
  }
}

/**
 * The reconciled event that releases a legacy hold, written straight to the
 * stores the hold is read from (job_events when linked, and business_events),
 * not through the capture lane. True when at least one was written.
 */
async function writeLegacyReconciled(
  client: any,
  input: { xeroInvoiceId: string; jobId: string | null; actor: string; attemptId: string; via: InvoiceEmailVia; unknownSince: string },
): Promise<boolean> {
  const at = new Date().toISOString()
  const detail = {
    xero_invoice_id: input.xeroInvoiceId, via: input.via, checked_by: input.actor,
    attempt_id: input.attemptId, released_unknown_since: input.unknownSince, legacy_hold: true,
  }
  let wrote = false
  if (input.jobId) {
    try {
      const { error } = await client.from('job_events').insert({
        job_id: input.jobId, event_type: INVOICE_EMAIL_OUTCOME_RECONCILED_EVENT, detail_json: detail, created_at: at,
      })
      if (!error) wrote = true
    } catch { /* falls through to business_events */ }
  }
  try {
    const { error } = await client.from('business_events').insert({
      event_type: INVOICE_EMAIL_OUTCOME_RECONCILED_EVENT,
      source: 'ops-api/invoice_email_gate',
      entity_type: 'xero_invoice',
      entity_id: input.xeroInvoiceId,
      job_id: input.jobId,
      occurred_at: at,
      payload: detail,
      provider_message_id: `ops-api:${INVOICE_EMAIL_OUTCOME_RECONCILED_EVENT}:${input.xeroInvoiceId}:${input.attemptId}`,
    })
    if (!error) wrote = true
  } catch { /* wrote stays as it is */ }
  if (!wrote) console.error(JSON.stringify({ event: 'invoice_email_legacy_reconcile_write_failed', entity_id: input.xeroInvoiceId }))
  return wrote
}

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
 * checker, or against a send still in progress, is refused. An unknown-send
 * event from before the claim store holds the same way (see the header).
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
    jobId?: string | null
  },
): Promise<InvoiceEmailClaim> {
  const itemKey = invoiceSendKey(input.xeroInvoiceId)
  const attemptId = newSendAttemptId(`invoice_email_${input.via}`)
  const detail = { via: input.via, xero_invoice_id: input.xeroInvoiceId, ...(input.detail ?? {}) }
  const jobId = input.jobId ?? (typeof input.detail?.job_id === 'string' ? input.detail.job_id as string : null)

  const legacy = await readLegacyInvoiceEmailHold(client, input.xeroInvoiceId)
  if (legacy.state === 'unreadable') return { ok: false, ...legacyRefusal(input.xeroInvoiceId, 'invoice_email_hold_unavailable', null) }
  const legacyHeld = legacy.state === 'held'
  if (legacyHeld && !input.sentItemsChecked) {
    console.error(JSON.stringify({ event: 'invoice_email_hold_refused', entity_id: input.xeroInvoiceId, code: 'legacy_hold' }))
    return { ok: false, ...legacyRefusal(input.xeroInvoiceId, 'invoice_email_outcome_unreconciled', legacy.unknown_since) }
  }
  if (legacyHeld && !reconcileActor(input.actor)) {
    return { ok: false, ...legacyRefusal(input.xeroInvoiceId, 'send_reconcile_actor_required', legacy.unknown_since) }
  }

  const result = input.sentItemsChecked
    ? await reconcileThenClaim(client, {
      keys: [itemKey],
      attemptId,
      actor: input.actor,
      checkedAt: input.checkedAt ?? null,
      evidence: input.via === 'xero' ? 'xero_history_checked' : 'sent_items_checked',
      expectedAttemptId: input.expectedAttemptId ?? null,
      detail: legacyHeld ? { ...detail, legacy_unknown_since: legacy.unknown_since } : detail,
    })
    : await claimSend(client, { keys: [itemKey], attemptId, actor: input.actor, detail })
  if (!result.ok) {
    console.error(JSON.stringify({ event: 'invoice_email_hold_refused', entity_id: input.xeroInvoiceId, code: result.code }))
    return { ok: false, ...invoiceEmailClaimRefusal(input.xeroInvoiceId, result) }
  }

  if (legacyHeld) {
    // Holding the claim, nobody else can be past this point for the invoice.
    // A press that saw the hold before another press released it finds it
    // released now: its check was of a state that has since sent, so it stops.
    const again = await readLegacyInvoiceEmailHold(client, input.xeroInvoiceId)
    const stop = again.state === 'unreadable'
      ? legacyRefusal(input.xeroInvoiceId, 'invoice_email_hold_unavailable', null)
      : again.state === 'clear'
      ? legacyRefusal(input.xeroInvoiceId, 'send_reconcile_state_changed', legacy.unknown_since)
      : null
    const wrote = stop ? false : await writeLegacyReconciled(client, {
      xeroInvoiceId: input.xeroInvoiceId, jobId, actor: reconcileActor(input.actor) as string,
      attemptId, via: input.via, unknownSince: legacy.unknown_since,
    })
    if (stop || !wrote) {
      await settleInvoiceEmailSend(client, attemptId, 'failed', { reason: stop ? 'legacy_hold_changed' : 'legacy_reconcile_write_failed' })
      return { ok: false, ...(stop ?? legacyRefusal(input.xeroInvoiceId, 'invoice_email_hold_unavailable', null)) }
    }
  }
  return {
    ok: true, attemptId, itemKey, dispatchToken: result.dispatch_token,
    reconciled: input.sentItemsChecked, legacyReleased: legacyHeld,
  }
}

/**
 * Settle the attempt. A failed settle leaves the hold in place (it reads stale
 * later). settler 'caller': the attempt was handed to a door (send-outlook-
 * email, send-quote) that may still be dispatching; the claim layer then
 * defers this settle while that dispatch is open, and the door's own settle
 * decides.
 */
export async function settleInvoiceEmailSend(
  client: any,
  attemptId: string,
  state: SettleState,
  detail: Record<string, unknown> = {},
  opts: { settler?: 'dispatcher' | 'caller' } = {},
): Promise<boolean> {
  const settled = await settleSend(client, attemptId, state, detail, { settler: opts.settler ?? 'dispatcher' })
  // A door settles a caller's claim itself when it can; the first settle wins
  // (compare-and-set), so a later one finding it settled is fine.
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
