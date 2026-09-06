/**
 * Invoice-scoped send claim (TRD6-REV13-004).
 *
 * Same family as quote document claims: exclusive lease, stale reclaim
 * that rotates the ownership token, heartbeat so a live worker is not
 * reclaimed, and a first-claim Resend idempotency key that survives
 * reclaim. Publication is `sent_at` after Resend succeeds. The table is
 * operational mail state, not the Xero money mirror.
 */

import {
  mintQuoteSendClaimToken,
  quoteSendClaimIsStale,
  quoteSendClaimRevertPayload,
  quoteSendClaimStaleBefore,
  quoteSendClaimToken,
  QUOTE_SEND_CLAIM_TTL_MS,
  sendClaimKeyStampConfirmed,
  type SendClaimReleaseMode,
} from '../_shared/trade_quote_pack/quote_send_publication.ts'

export const INVOICE_EMAIL_SEND_CLAIM_TTL_MS = QUOTE_SEND_CLAIM_TTL_MS
export const INVOICE_EMAIL_SEND_CLAIMS_TABLE = 'invoice_email_send_claims'

export type InvoiceEmailSendClient = {
  from: (table: string) => any
}

export type InvoiceEmailSendClaim = {
  xero_invoice_id: string
  job_id: string
  token: string
  claimed_at: string
  resend_idempotency_key: string
}

export type InvoiceEmailSendClaimResult =
  | { status: 'claimed'; claim: InvoiceEmailSendClaim }
  | { status: 'already_sent' }
  | { status: 'unavailable' }
  | { status: 'error'; error: string }

function claimErrorMessage(error: { message?: string } | null | undefined): string {
  return error?.message || String(error)
}

function isUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  const code = String(error?.code || '')
  const message = String(error?.message || '')
  return code === '23505' || /duplicate key|unique constraint/i.test(message)
}

export function invoiceEmailResendIdempotencyKey(token: string): string {
  return `invoice-send:${token}`
}

export function invoiceEmailDocumentIdempotencyKey(xeroInvoiceId: string): string {
  return `invoice-send-id:${xeroInvoiceId}`
}

export function invoiceEmailSendClaimPayload(
  now = new Date(),
  token = mintQuoteSendClaimToken(),
): {
  send_claimed_at: string
  send_claim_token: string
  send_resend_idempotency_key: string
} {
  return {
    send_claimed_at: now.toISOString(),
    send_claim_token: token,
    send_resend_idempotency_key: invoiceEmailResendIdempotencyKey(token),
  }
}

function claimedResult(
  xeroInvoiceId: string,
  jobId: string,
  token: string,
  claimedAt: string,
  key: string,
): InvoiceEmailSendClaimResult {
  return {
    status: 'claimed',
    claim: {
      xero_invoice_id: xeroInvoiceId,
      job_id: jobId,
      token,
      claimed_at: claimedAt,
      resend_idempotency_key: key,
    },
  }
}

async function readInvoiceEmailSendRow(
  sb: InvoiceEmailSendClient,
  xeroInvoiceId: string,
): Promise<
  | {
    status: 'row'
    row: {
      xero_invoice_id?: string
      job_id?: string | null
      send_claimed_at?: string | null
      send_claim_token?: string | null
      send_resend_idempotency_key?: string | null
      sent_at?: string | null
    }
  }
  | { status: 'missing' }
  | { status: 'error'; error: string }
> {
  const { data, error } = await sb
    .from(INVOICE_EMAIL_SEND_CLAIMS_TABLE)
    .select(
      'xero_invoice_id, job_id, send_claimed_at, send_claim_token, send_resend_idempotency_key, sent_at',
    )
    .eq('xero_invoice_id', xeroInvoiceId)
    .maybeSingle()
  if (error) return { status: 'error', error: claimErrorMessage(error) }
  if (!data) return { status: 'missing' }
  return { status: 'row', row: data }
}

function rowIsPublished(row: { sent_at?: string | null } | null | undefined): boolean {
  return typeof row?.sent_at === 'string' && row.sent_at.trim().length > 0
}

async function claimInvoiceEmailSendExclusive(
  sb: InvoiceEmailSendClient,
  xeroInvoiceId: string,
  jobId: string,
  now: Date,
): Promise<InvoiceEmailSendClaimResult> {
  const payload = invoiceEmailSendClaimPayload(now)
  const { data, error } = await sb
    .from(INVOICE_EMAIL_SEND_CLAIMS_TABLE)
    .update({
      job_id: jobId,
      send_claimed_at: payload.send_claimed_at,
      send_claim_token: payload.send_claim_token,
    })
    .eq('xero_invoice_id', xeroInvoiceId)
    .is('send_claimed_at', null)
    .is('sent_at', null)
    .select('xero_invoice_id, send_resend_idempotency_key')
    .maybeSingle()
  if (error) {
    console.error('[send-invoice] claim update failed:', claimErrorMessage(error))
    return { status: 'error', error: claimErrorMessage(error) }
  }
  if (data && typeof data.xero_invoice_id === 'string') {
    const keptKey = quoteSendClaimToken(data.send_resend_idempotency_key)
    if (keptKey) {
      return claimedResult(
        xeroInvoiceId,
        jobId,
        payload.send_claim_token,
        payload.send_claimed_at,
        keptKey,
      )
    }
    const { data: stamped, error: keyError } = await sb
      .from(INVOICE_EMAIL_SEND_CLAIMS_TABLE)
      .update({ send_resend_idempotency_key: payload.send_resend_idempotency_key })
      .eq('xero_invoice_id', xeroInvoiceId)
      .eq('send_claim_token', payload.send_claim_token)
      .is('send_resend_idempotency_key', null)
      .select('xero_invoice_id, send_resend_idempotency_key')
      .maybeSingle()
    if (keyError) {
      console.error('[send-invoice] claim key stamp failed:', claimErrorMessage(keyError))
      return { status: 'error', error: claimErrorMessage(keyError) }
    }
    const stampedKey = sendClaimKeyStampConfirmed(
      stamped?.xero_invoice_id,
      xeroInvoiceId,
      stamped?.send_resend_idempotency_key,
      payload.send_resend_idempotency_key,
    )
    if (!stampedKey) {
      console.error('[send-invoice] claim key stamp lost ownership')
      return { status: 'unavailable' }
    }
    return claimedResult(
      xeroInvoiceId,
      jobId,
      payload.send_claim_token,
      payload.send_claimed_at,
      stampedKey,
    )
  }

  const insert = await sb
    .from(INVOICE_EMAIL_SEND_CLAIMS_TABLE)
    .insert({
      xero_invoice_id: xeroInvoiceId,
      job_id: jobId,
      ...payload,
    })
    .select('xero_invoice_id')
    .maybeSingle()
  if (insert.error) {
    if (isUniqueViolation(insert.error)) return { status: 'unavailable' }
    console.error('[send-invoice] claim insert failed:', claimErrorMessage(insert.error))
    return { status: 'error', error: claimErrorMessage(insert.error) }
  }
  if (insert.data && typeof insert.data.xero_invoice_id === 'string') {
    return claimedResult(
      xeroInvoiceId,
      jobId,
      payload.send_claim_token,
      payload.send_claimed_at,
      payload.send_resend_idempotency_key,
    )
  }
  return { status: 'unavailable' }
}

async function reclaimStaleInvoiceEmailSend(
  sb: InvoiceEmailSendClient,
  xeroInvoiceId: string,
  jobId: string,
  now: Date,
): Promise<InvoiceEmailSendClaimResult> {
  const existing = await readInvoiceEmailSendRow(sb, xeroInvoiceId)
  if (existing.status === 'error') return existing
  if (existing.status === 'missing') return { status: 'unavailable' }
  if (rowIsPublished(existing.row)) return { status: 'already_sent' }
  if (!quoteSendClaimIsStale(existing.row.send_claimed_at, now)) return { status: 'unavailable' }

  const token = mintQuoteSendClaimToken()
  const claimedAt = now.toISOString()
  const keptKey = quoteSendClaimToken(existing.row.send_resend_idempotency_key)
    || invoiceEmailDocumentIdempotencyKey(xeroInvoiceId)
  const { data, error } = await sb
    .from(INVOICE_EMAIL_SEND_CLAIMS_TABLE)
    .update({
      job_id: jobId,
      send_claimed_at: claimedAt,
      send_claim_token: token,
      send_resend_idempotency_key: keptKey,
    })
    .eq('xero_invoice_id', xeroInvoiceId)
    .is('sent_at', null)
    .lt('send_claimed_at', quoteSendClaimStaleBefore(now))
    .select('xero_invoice_id, send_resend_idempotency_key')
    .maybeSingle()
  if (error) {
    console.error('[send-invoice] stale claim reclaim failed:', claimErrorMessage(error))
    return { status: 'error', error: claimErrorMessage(error) }
  }
  if (data && typeof data.xero_invoice_id === 'string') {
    return claimedResult(
      xeroInvoiceId,
      jobId,
      token,
      claimedAt,
      quoteSendClaimToken(data.send_resend_idempotency_key) || keptKey,
    )
  }
  return { status: 'unavailable' }
}

export async function claimInvoiceEmailSend(
  sb: InvoiceEmailSendClient,
  xeroInvoiceId: string,
  jobId: string,
  now = new Date(),
): Promise<InvoiceEmailSendClaimResult> {
  const exclusive = await claimInvoiceEmailSendExclusive(sb, xeroInvoiceId, jobId, now)
  if (exclusive.status === 'claimed' || exclusive.status === 'error') return exclusive
  const published = await readInvoiceEmailSendRow(sb, xeroInvoiceId)
  if (published.status === 'error') return published
  if (published.status === 'row' && rowIsPublished(published.row)) {
    return { status: 'already_sent' }
  }
  return await reclaimStaleInvoiceEmailSend(sb, xeroInvoiceId, jobId, now)
}

export async function touchInvoiceEmailSendClaim(
  sb: InvoiceEmailSendClient,
  xeroInvoiceId: string,
  token: string,
  now = new Date(),
): Promise<{ updated: boolean; error: { message?: string } | null }> {
  const owned = quoteSendClaimToken(token)
  if (!owned) return { updated: false, error: { message: 'send claim token required' } }
  const { data, error } = await sb
    .from(INVOICE_EMAIL_SEND_CLAIMS_TABLE)
    .update({ send_claimed_at: now.toISOString() })
    .eq('xero_invoice_id', xeroInvoiceId)
    .eq('send_claim_token', owned)
    .is('sent_at', null)
    .select('xero_invoice_id')
    .maybeSingle()
  if (error) return { updated: false, error }
  return { updated: !!(data && typeof data.xero_invoice_id === 'string'), error: null }
}

export async function publishInvoiceEmailSend(
  sb: InvoiceEmailSendClient,
  xeroInvoiceId: string,
  token: string,
  now = new Date(),
): Promise<{ updated: boolean; error: { message?: string } | null }> {
  const owned = quoteSendClaimToken(token)
  if (!owned) return { updated: false, error: { message: 'send claim token required' } }
  const { data, error } = await sb
    .from(INVOICE_EMAIL_SEND_CLAIMS_TABLE)
    .update({
      sent_at: now.toISOString(),
      send_claimed_at: null,
      send_claim_token: null,
    })
    .eq('xero_invoice_id', xeroInvoiceId)
    .eq('send_claim_token', owned)
    .select('xero_invoice_id')
    .maybeSingle()
  if (error) return { updated: false, error }
  return { updated: !!(data && typeof data.xero_invoice_id === 'string'), error: null }
}

export async function revertInvoiceEmailSendClaim(
  sb: InvoiceEmailSendClient,
  xeroInvoiceId: string,
  token: string,
  mode: SendClaimReleaseMode = 'pre_send',
): Promise<{ updated: boolean; error: { message?: string } | null }> {
  const owned = quoteSendClaimToken(token)
  if (!owned) return { updated: false, error: { message: 'send claim token required' } }
  const { data, error } = await sb
    .from(INVOICE_EMAIL_SEND_CLAIMS_TABLE)
    .update(quoteSendClaimRevertPayload(mode))
    .eq('xero_invoice_id', xeroInvoiceId)
    .eq('send_claim_token', owned)
    .is('sent_at', null)
    .select('xero_invoice_id')
    .maybeSingle()
  if (error) return { updated: false, error }
  return { updated: !!(data && typeof data.xero_invoice_id === 'string'), error: null }
}

export async function publishInvoiceEmailSendOrRevert(
  sb: InvoiceEmailSendClient,
  xeroInvoiceId: string,
  token: string,
  now = new Date(),
): Promise<{ published: true } | { published: false; error: string }> {
  const { updated, error } = await publishInvoiceEmailSend(sb, xeroInvoiceId, token, now)
  if (updated) return { published: true }
  const message = error?.message || 'invoice send publication stamp not confirmed'
  console.error('[send-invoice] publication stamp failed:', message)
  await revertInvoiceEmailSendClaim(sb, xeroInvoiceId, token, 'keep_provider_key')
  return { published: false, error: message }
}
