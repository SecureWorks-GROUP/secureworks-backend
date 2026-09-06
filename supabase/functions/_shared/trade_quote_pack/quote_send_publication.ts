/**
 * Direct /send and send-runs claim vs publication.
 *
 * An in-flight claim locks the row (`send_claimed_at` + opaque
 * `send_claim_token`) so two callers cannot both dispatch Resend.
 * That stamp is not a client send. Quote-pack and extract eligibility
 * read publication only: `sent_to_client=true` plus `sent_at` after
 * Resend succeeds, or a historical omitted-flag row, or `accepted_at`.
 * Same bar as send-runs.
 *
 * Claims expire. A worker that dies after claim and before Resend-failure
 * revert or publication must not strand `/send` on `already_sent` forever.
 * Reclaim writes a new ownership token. Publish, revert, and heartbeat
 * match that token so the original worker cannot stamp, clear, or keep a
 * lease it no longer owns. The first-claim Resend idempotency key stays
 * on the row across reclaim so a delayed original and a reclaimer cannot
 * both dispatch. send-runs takes a job-level claim
 * (`jobs.send_runs_claimed_at`) with the same TTL so concurrent/retry
 * calls cannot mint a second published pack. A grouped send-runs email
 * heartbeats every owned document claim in that recipient set before
 * Resend and again through pack persist / publication — refreshing
 * only the first, or only pre-Resend, leaves secondary claims stale so
 * direct `/send` can reclaim them with a distinct Idempotency-Key.
 * Exclusive key-stamp updates must return the owned row; a zero-row
 * stamp is not a claim and must not dispatch. send-runs recipient keys
 * are trim + lowercase so case-variant addresses are one group. The
 * grouped Resend Idempotency-Key lives on
 * `quote_group_email_send_records` for the original document set, not
 * `claims[0]`. A leftover retry after partial publication reuses that
 * stored key; a new document set mints another record. A definitive
 * pre-send 4xx retires that group key so a corrected retry mints a
 * new one. Ambiguous or accepted provider outcomes keep the key.
 * Per-doc claims stay the lease.
 */

import {
  persistTradePackOnDocuments,
  persistTradePackWriteConfirmed,
  quoteDocumentHasClientSend,
  quoteDocumentIsSuperseded,
} from './pack_trade_quote.ts'

export const QUOTE_SEND_CLAIM_TTL_MS = 15 * 60 * 1000

export type QuoteSendPublicationClient = {
  from: (table: string) => any
  rpc?: (fn: string) => Promise<{ data: unknown; error: { message?: string } | null }>
}

export type QuoteSendDocumentClaim = {
  id: string
  token: string
  claimed_at: string
  resend_idempotency_key: string
}

export type QuoteSendClaimResult =
  | {
    status: 'claimed'
    id: string
    token: string
    claimed_at: string
    resend_idempotency_key: string
  }
  | { status: 'unavailable' }
  | { status: 'error'; error: string }

export type JobSendRunsClaimResult =
  | { status: 'claimed'; id: string; claimed_at: string }
  | { status: 'unavailable' }
  | { status: 'error'; error: string }

export function mintQuoteSendClaimToken(): string {
  return crypto.randomUUID()
}

export function quoteSendClaimToken(token: string | null | undefined): string | null {
  const value = typeof token === 'string' ? token.trim() : ''
  return value || null
}

export function quoteSendResendIdempotencyKey(token: string): string {
  return `quote-send:${token}`
}

export const QUOTE_GROUP_EMAIL_SEND_TABLE = 'quote_group_email_send_records'

export function quoteGroupEmailResendIdempotencyKey(token: string): string {
  return `quote-group-send:${token}`
}

export function quoteSendDocumentResendIdempotencyKey(documentId: string): string {
  return `quote-send-doc:${documentId}`
}

/** Returning row from a token-fenced key stamp. Zero rows are not claimed. */
export function sendClaimKeyStampConfirmed(
  returnedId: unknown,
  expectedId: string,
  returnedKey: unknown,
  fallbackKey: string,
): string | null {
  const id = typeof returnedId === 'string' ? returnedId.trim() : ''
  if (!id || id !== expectedId) return null
  const stored = typeof returnedKey === 'string' ? returnedKey : null
  return quoteSendClaimToken(stored) || quoteSendClaimToken(fallbackKey)
}

export function quoteSendClaimPayload(
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
    send_resend_idempotency_key: quoteSendResendIdempotencyKey(token),
  }
}

export function quoteSendClaimReclaimOwnershipPayload(
  now = new Date(),
  token = mintQuoteSendClaimToken(),
): { send_claimed_at: string; send_claim_token: string } {
  return { send_claimed_at: now.toISOString(), send_claim_token: token }
}

export function quoteSendPublicationPayload(now = new Date()): {
  sent_to_client: true
  sent_at: string
} {
  return {
    sent_to_client: true,
    sent_at: now.toISOString(),
  }
}

export type SendClaimReleaseMode = 'pre_send' | 'keep_provider_key'

/**
 * Pre-send rejection may clear the Resend key. After the provider has
 * accepted — or any ambiguous post-dispatch failure — omit the key so
 * reclaim/resume keeps the first-send Idempotency-Key.
 */
export function quoteSendClaimRevertPayload(
  mode: SendClaimReleaseMode = 'pre_send',
): {
  send_claimed_at: null
  send_claim_token: null
  send_resend_idempotency_key?: null
} {
  if (mode === 'keep_provider_key') {
    return {
      send_claimed_at: null,
      send_claim_token: null,
    }
  }
  return {
    send_claimed_at: null,
    send_claim_token: null,
    send_resend_idempotency_key: null,
  }
}

/** 4xx except 408/409/429: Resend definitely rejected before accept. */
export function resendResponseIsDefinitivePreSendRejection(status: number): boolean {
  if (!Number.isFinite(status)) return false
  if (status === 408 || status === 409 || status === 429) return false
  return status >= 400 && status < 500
}

export function jobSendRunsClaimPayload(now = new Date()): { send_runs_claimed_at: string } {
  return { send_runs_claimed_at: now.toISOString() }
}

export function jobSendRunsClaimRevertPayload(): { send_runs_claimed_at: null } {
  return { send_runs_claimed_at: null }
}

export function quoteSendClaimStaleBefore(now = new Date()): string {
  return new Date(now.getTime() - QUOTE_SEND_CLAIM_TTL_MS).toISOString()
}

export function quoteSendClaimIsStale(
  claimedAt: string | null | undefined,
  now = new Date(),
): boolean {
  if (claimedAt == null || !String(claimedAt).trim()) return false
  const t = Date.parse(String(claimedAt))
  if (!Number.isFinite(t)) return true
  return now.getTime() - t >= QUOTE_SEND_CLAIM_TTL_MS
}

export function quoteSendIsPublished(row: {
  sent_to_client?: boolean | null
  sent_at?: string | null
  accepted_at?: string | null
  send_claimed_at?: string | null
}): boolean {
  return quoteDocumentHasClientSend(row)
}

function uniqueDocumentIds(documentIds: Iterable<string | null | undefined>): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const raw of documentIds) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function uniqueDocumentClaims(
  claims: Iterable<{
    id?: string | null
    token?: string | null
    claimed_at?: string | null
    resend_idempotency_key?: string | null
  } | null | undefined>,
): QuoteSendDocumentClaim[] {
  const out: QuoteSendDocumentClaim[] = []
  const seen = new Set<string>()
  for (const raw of claims) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
    const token = quoteSendClaimToken(raw?.token)
    if (!id || !token || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      token,
      claimed_at: typeof raw === 'object' && raw && 'claimed_at' in raw && typeof raw.claimed_at === 'string'
        ? raw.claimed_at
        : '',
      resend_idempotency_key: quoteSendClaimToken(raw?.resend_idempotency_key)
        || quoteSendDocumentResendIdempotencyKey(id),
    })
  }
  return out
}

function claimErrorMessage(error: { message?: string } | null | undefined): string {
  return error?.message || String(error)
}

async function claimQuoteDocumentSendExclusive(
  sb: QuoteSendPublicationClient,
  documentId: string,
  now: Date,
): Promise<QuoteSendClaimResult> {
  const payload = quoteSendClaimPayload(now)
  const { data, error } = await sb
    .from('job_documents')
    .update({
      send_claimed_at: payload.send_claimed_at,
      send_claim_token: payload.send_claim_token,
    })
    .eq('id', documentId)
    .is('send_claimed_at', null)
    .is('sent_at', null)
    .is('accepted_at', null)
    .not('sent_to_client', 'is', true)
    .select('id, send_resend_idempotency_key')
    .maybeSingle()
  if (error) {
    console.error('[send-quote] claim failed:', claimErrorMessage(error))
    return { status: 'error', error: claimErrorMessage(error) }
  }
  if (!data || typeof data.id !== 'string') return { status: 'unavailable' }
  const keptKey = quoteSendClaimToken(data.send_resend_idempotency_key)
  if (keptKey) {
    return {
      status: 'claimed',
      id: data.id,
      token: payload.send_claim_token,
      claimed_at: payload.send_claimed_at,
      resend_idempotency_key: keptKey,
    }
  }
  const { data: stamped, error: keyError } = await sb
    .from('job_documents')
    .update({ send_resend_idempotency_key: payload.send_resend_idempotency_key })
    .eq('id', documentId)
    .eq('send_claim_token', payload.send_claim_token)
    .is('send_resend_idempotency_key', null)
    .select('id, send_resend_idempotency_key')
    .maybeSingle()
  if (keyError) {
    console.error('[send-quote] claim key stamp failed:', claimErrorMessage(keyError))
    return { status: 'error', error: claimErrorMessage(keyError) }
  }
  const stampedKey = sendClaimKeyStampConfirmed(
    stamped?.id,
    documentId,
    stamped?.send_resend_idempotency_key,
    payload.send_resend_idempotency_key,
  )
  if (!stampedKey) {
    console.error('[send-quote] claim key stamp lost ownership')
    return { status: 'unavailable' }
  }
  return {
    status: 'claimed',
    id: data.id,
    token: payload.send_claim_token,
    claimed_at: payload.send_claimed_at,
    resend_idempotency_key: stampedKey,
  }
}

async function reclaimStaleQuoteDocumentSend(
  sb: QuoteSendPublicationClient,
  documentId: string,
  now: Date,
): Promise<QuoteSendClaimResult> {
  const { data: existing, error: readError } = await sb
    .from('job_documents')
    .select('id, send_claimed_at, send_resend_idempotency_key, sent_at, sent_to_client, accepted_at')
    .eq('id', documentId)
    .maybeSingle()
  if (readError) {
    console.error('[send-quote] stale claim read failed:', claimErrorMessage(readError))
    return { status: 'error', error: claimErrorMessage(readError) }
  }
  if (!existing || typeof existing.id !== 'string') return { status: 'unavailable' }
  if (quoteSendIsPublished(existing)) return { status: 'unavailable' }
  if (!quoteSendClaimIsStale(existing.send_claimed_at, now)) return { status: 'unavailable' }

  const ownership = quoteSendClaimReclaimOwnershipPayload(now)
  const keptKey = quoteSendClaimToken(existing.send_resend_idempotency_key)
    || quoteSendDocumentResendIdempotencyKey(documentId)
  const { data, error } = await sb
    .from('job_documents')
    .update({
      ...ownership,
      send_resend_idempotency_key: keptKey,
    })
    .eq('id', documentId)
    .is('sent_at', null)
    .is('accepted_at', null)
    .not('sent_to_client', 'is', true)
    .lt('send_claimed_at', quoteSendClaimStaleBefore(now))
    .select('id, send_resend_idempotency_key')
    .maybeSingle()
  if (error) {
    console.error('[send-quote] stale claim reclaim failed:', claimErrorMessage(error))
    return { status: 'error', error: claimErrorMessage(error) }
  }
  return data && typeof data.id === 'string'
    ? {
      status: 'claimed',
      id: data.id,
      token: ownership.send_claim_token,
      claimed_at: ownership.send_claimed_at,
      resend_idempotency_key: quoteSendClaimToken(data.send_resend_idempotency_key) || keptKey,
    }
    : { status: 'unavailable' }
}

export async function claimQuoteDocumentSend(
  sb: QuoteSendPublicationClient,
  documentId: string,
  now = new Date(),
): Promise<QuoteSendClaimResult> {
  const exclusive = await claimQuoteDocumentSendExclusive(sb, documentId, now)
  if (exclusive.status === 'claimed' || exclusive.status === 'error') return exclusive
  return await reclaimStaleQuoteDocumentSend(sb, documentId, now)
}

export async function touchQuoteDocumentSendClaim(
  sb: QuoteSendPublicationClient,
  documentId: string,
  token: string,
  now = new Date(),
): Promise<{ updated: boolean; error: { message?: string } | null }> {
  const owned = quoteSendClaimToken(token)
  if (!owned) return { updated: false, error: { message: 'send claim token required' } }
  const { data, error } = await sb
    .from('job_documents')
    .update({ send_claimed_at: now.toISOString() })
    .eq('id', documentId)
    .eq('send_claim_token', owned)
    .is('sent_at', null)
    .is('accepted_at', null)
    .not('sent_to_client', 'is', true)
    .select('id')
    .maybeSingle()
  if (error) return { updated: false, error }
  return { updated: !!(data && typeof data.id === 'string'), error: null }
}

export type SendClaimLeaseOutcome = 'owned' | 'lost' | 'error'

/** DB faults are errors. Zero-row token misses are ownership loss. */
export function classifySendClaimLease(lease: {
  updated: boolean
  error?: { message?: string } | null
}): SendClaimLeaseOutcome {
  if (lease.error) return 'error'
  return lease.updated ? 'owned' : 'lost'
}

/**
 * Refresh every owned claim. Continue after a lost token so siblings in
 * a grouped email do not expire. A DB fault on any row wins the outcome.
 */
export async function touchQuoteDocumentSendClaims(
  sb: QuoteSendPublicationClient,
  claims: Iterable<{ id?: string | null; token?: string | null } | null | undefined>,
  now = new Date(),
): Promise<{ outcome: SendClaimLeaseOutcome; error: { message?: string } | null }> {
  const owned = uniqueDocumentClaims(claims)
  let lost = false
  let error: { message?: string } | null = null
  for (const claim of owned) {
    const lease = await touchQuoteDocumentSendClaim(sb, claim.id, claim.token, now)
    const outcome = classifySendClaimLease(lease)
    if (outcome === 'error') {
      error = lease.error || { message: 'send claim heartbeat failed' }
      continue
    }
    if (outcome === 'lost') lost = true
  }
  if (error) return { outcome: 'error', error }
  return { outcome: lost ? 'lost' : 'owned', error: null }
}

/**
 * Heartbeat every claim that belongs to a grouped recipient. A document
 * in the group with no owned claim is ownership loss — do not dispatch.
 */
export async function touchGroupedQuoteDocumentSendClaims(
  sb: QuoteSendPublicationClient,
  claims: Iterable<{ id?: string | null; token?: string | null } | null | undefined>,
  documentIds: Iterable<string | null | undefined>,
  now = new Date(),
): Promise<{
  outcome: SendClaimLeaseOutcome
  claims: QuoteSendDocumentClaim[]
  error: { message?: string } | null
}> {
  const wanted = uniqueDocumentIds(documentIds)
  const grouped = uniqueDocumentClaims(claims).filter((claim) => wanted.includes(claim.id))
  const heartbeats = await touchQuoteDocumentSendClaims(sb, grouped, now)
  if (heartbeats.outcome === 'error') {
    return { outcome: 'error', claims: grouped, error: heartbeats.error }
  }
  if (!wanted.length) return { outcome: 'owned', claims: grouped, error: null }
  if (grouped.length !== wanted.length || heartbeats.outcome === 'lost') {
    return { outcome: 'lost', claims: grouped, error: null }
  }
  return { outcome: 'owned', claims: grouped, error: null }
}

export function resendIdempotencyHeaders(key: string): { 'Idempotency-Key': string } {
  return { 'Idempotency-Key': key }
}

export async function publishQuoteDocumentSend(
  sb: QuoteSendPublicationClient,
  documentId: string,
  token: string,
  now = new Date(),
): Promise<{ updated: boolean; error: { message?: string } | null }> {
  const owned = quoteSendClaimToken(token)
  if (!owned) return { updated: false, error: { message: 'send claim token required' } }
  const { data, error } = await sb
    .from('job_documents')
    .update({
      ...quoteSendPublicationPayload(now),
      ...quoteSendClaimRevertPayload(),
    })
    .eq('id', documentId)
    .eq('send_claim_token', owned)
    .select('id')
    .maybeSingle()
  if (error) return { updated: false, error }
  return { updated: !!(data && typeof data.id === 'string'), error: null }
}

export async function revertQuoteDocumentSendClaim(
  sb: QuoteSendPublicationClient,
  documentId: string,
  token: string,
  mode: SendClaimReleaseMode = 'pre_send',
): Promise<{ updated: boolean; error: { message?: string } | null }> {
  const owned = quoteSendClaimToken(token)
  if (!owned) return { updated: false, error: { message: 'send claim token required' } }
  const { data, error } = await sb
    .from('job_documents')
    .update(quoteSendClaimRevertPayload(mode))
    .eq('id', documentId)
    .eq('send_claim_token', owned)
    .not('sent_to_client', 'is', true)
    .select('id')
    .maybeSingle()
  if (error) return { updated: false, error }
  return { updated: !!(data && typeof data.id === 'string'), error: null }
}

export async function revertQuoteDocumentSendClaims(
  sb: QuoteSendPublicationClient,
  claims: Iterable<{ id?: string | null; token?: string | null } | null | undefined>,
  mode: SendClaimReleaseMode = 'pre_send',
): Promise<{ error: { message?: string } | null }> {
  const owned = uniqueDocumentClaims(claims)
  if (!owned.length) return { error: null }
  for (const claim of owned) {
    const { error } = await revertQuoteDocumentSendClaim(sb, claim.id, claim.token, mode)
    if (error) return { error }
  }
  return { error: null }
}

/**
 * Stamp publication after Resend. On stamp failure revert the in-flight
 * claim so a retry can re-claim. Do not treat a logged error as success.
 * Publish and revert match the caller token so a stale reclaim cannot be
 * overwritten by the original worker.
 */
export async function publishQuoteDocumentSendOrRevert(
  sb: QuoteSendPublicationClient,
  documentId: string,
  token: string,
  now = new Date(),
): Promise<{ published: true } | { published: false; error: string }> {
  const { updated, error } = await publishQuoteDocumentSend(sb, documentId, token, now)
  if (updated) return { published: true }
  const message = error?.message || 'publication stamp not confirmed'
  console.error('[send-quote] publication stamp failed:', message)
  await revertQuoteDocumentSendClaim(sb, documentId, token, 'keep_provider_key')
  return { published: false, error: message }
}

export async function publishQuoteDocumentsSendOrRevert(
  sb: QuoteSendPublicationClient,
  claims: Iterable<{ id?: string | null; token?: string | null } | null | undefined>,
  now = new Date(),
): Promise<{ published: true } | { published: false; error: string }> {
  const owned = uniqueDocumentClaims(claims)
  if (!owned.length) return { published: true }
  for (const claim of owned) {
    const { updated, error } = await publishQuoteDocumentSend(sb, claim.id, claim.token, now)
    if (updated) continue
    const message = error?.message || 'publication stamp not confirmed'
    console.error('[send-quote] publication stamp failed:', message)
    await revertQuoteDocumentSendClaims(sb, owned, 'keep_provider_key')
    return { published: false, error: message }
  }
  return { published: true }
}

export type PersistHeldSendClaimsResult =
  | { status: 'persisted' }
  | { status: 'lease_error'; error: string }
  | { status: 'lease_lost' }
  | { status: 'persist_failed' }

/**
 * Persist each frozen pack only while every claim in the set still
 * refreshes. Heartbeat the whole group before each write so a slow
 * persist cannot let `/send` reclaim a sibling.
 */
export async function persistTradePacksWhileHoldingSendClaims(
  sb: QuoteSendPublicationClient,
  args: Parameters<typeof persistTradePackOnDocuments>[1],
  now = new Date(),
): Promise<PersistHeldSendClaimsResult> {
  const documents = (args.documents || []).filter((doc) => typeof doc?.id === 'string' && doc.id)
  const claims = uniqueDocumentClaims(
    documents.map((doc) => ({ id: doc.id, token: doc.claim_token })),
  )
  for (const doc of documents) {
    const beat = await touchQuoteDocumentSendClaims(sb, claims, now)
    if (beat.outcome === 'error') {
      return { status: 'lease_error', error: beat.error?.message || 'send claim heartbeat failed' }
    }
    if (beat.outcome === 'lost') return { status: 'lease_lost' }
    const persisted = await persistTradePackOnDocuments(sb, { ...args, documents: [doc] })
    if (!persistTradePackWriteConfirmed(persisted, 1)) return { status: 'persist_failed' }
  }
  return { status: 'persisted' }
}

export async function publishQuoteDocumentsSendOrRevertWhileHolding(
  sb: QuoteSendPublicationClient,
  claims: Iterable<{ id?: string | null; token?: string | null } | null | undefined>,
  now = new Date(),
): Promise<{ published: true } | { published: false; error: string; lease?: SendClaimLeaseOutcome }> {
  const owned = uniqueDocumentClaims(claims)
  if (!owned.length) return { published: true }
  const beat = await touchQuoteDocumentSendClaims(sb, owned, now)
  if (beat.outcome === 'error') {
    await revertQuoteDocumentSendClaims(sb, owned, 'keep_provider_key')
    return {
      published: false,
      error: beat.error?.message || 'send claim heartbeat failed',
      lease: 'error',
    }
  }
  if (beat.outcome === 'lost') {
    await revertQuoteDocumentSendClaims(sb, owned, 'keep_provider_key')
    return { published: false, error: 'quote send claim lost before publication', lease: 'lost' }
  }
  return await publishQuoteDocumentsSendOrRevert(sb, owned, now)
}

async function claimJobSendRunsExclusive(
  sb: QuoteSendPublicationClient,
  jobId: string,
  now: Date,
): Promise<JobSendRunsClaimResult> {
  const payload = jobSendRunsClaimPayload(now)
  const { data, error } = await sb
    .from('jobs')
    .update(payload)
    .eq('id', jobId)
    .is('send_runs_claimed_at', null)
    .select('id')
    .maybeSingle()
  if (error) {
    console.error('[send-quote] send-runs job claim failed:', claimErrorMessage(error))
    return { status: 'error', error: claimErrorMessage(error) }
  }
  return data && typeof data.id === 'string'
    ? { status: 'claimed', id: data.id, claimed_at: payload.send_runs_claimed_at }
    : { status: 'unavailable' }
}

async function reclaimStaleJobSendRuns(
  sb: QuoteSendPublicationClient,
  jobId: string,
  now: Date,
): Promise<JobSendRunsClaimResult> {
  const payload = jobSendRunsClaimPayload(now)
  const { data, error } = await sb
    .from('jobs')
    .update(payload)
    .eq('id', jobId)
    .lt('send_runs_claimed_at', quoteSendClaimStaleBefore(now))
    .select('id')
    .maybeSingle()
  if (error) {
    console.error('[send-quote] send-runs stale job claim reclaim failed:', claimErrorMessage(error))
    return { status: 'error', error: claimErrorMessage(error) }
  }
  return data && typeof data.id === 'string'
    ? { status: 'claimed', id: data.id, claimed_at: payload.send_runs_claimed_at }
    : { status: 'unavailable' }
}

export async function claimJobSendRuns(
  sb: QuoteSendPublicationClient,
  jobId: string,
  now = new Date(),
): Promise<JobSendRunsClaimResult> {
  const exclusive = await claimJobSendRunsExclusive(sb, jobId, now)
  if (exclusive.status === 'claimed' || exclusive.status === 'error') return exclusive
  return await reclaimStaleJobSendRuns(sb, jobId, now)
}

export async function clearJobSendRunsClaim(
  sb: QuoteSendPublicationClient,
  jobId: string,
  claimedAt: string,
): Promise<{ error: { message?: string } | null }> {
  const { error } = await sb
    .from('jobs')
    .update(jobSendRunsClaimRevertPayload())
    .eq('id', jobId)
    .eq('send_runs_claimed_at', claimedAt)
  return { error: error || null }
}

export async function touchJobSendRunsClaim(
  sb: QuoteSendPublicationClient,
  jobId: string,
  claimedAt: string,
  now = new Date(),
): Promise<{ updated: boolean; claimed_at?: string; error: { message?: string } | null }> {
  const stamp = String(claimedAt || '').trim()
  if (!stamp) return { updated: false, error: { message: 'send-runs claim stamp required' } }
  const next = jobSendRunsClaimPayload(now)
  const { data, error } = await sb
    .from('jobs')
    .update(next)
    .eq('id', jobId)
    .eq('send_runs_claimed_at', stamp)
    .select('id')
    .maybeSingle()
  if (error) return { updated: false, error }
  return data && typeof data.id === 'string'
    ? { updated: true, claimed_at: next.send_runs_claimed_at, error: null }
    : { updated: false, error: null }
}

export type SendRunExistingDocument = {
  id: string
  type?: string | null
  archived?: boolean | null
  run_label?: string | null
  job_contact_id?: string | null
  sent_to_client?: boolean | null
  sent_at?: string | null
  send_claimed_at?: string | null
  share_token?: string | null
  quote_number?: string | null
  superseded_at?: string | null
  accepted_at?: string | null
}

export type SendRunPartyKey = {
  runLabel: string
  jobContactId: string | null
}

export type SendRunDocumentResolution =
  | { action: 'use_published'; document: SendRunExistingDocument }
  | { action: 'reuse_unpublished'; document: SendRunExistingDocument }
  | { action: 'create' }

function sameSendRunContact(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return (left ?? null) === (right ?? null)
}

export function sendRunDocumentIsSuperseded(
  doc: { superseded_at?: string | null } | null | undefined,
): boolean {
  const stamp = doc?.superseded_at
  return typeof stamp === 'string' && stamp.trim().length > 0
}

export function existingQuoteDocumentForRun(
  documents: SendRunExistingDocument[],
  key: SendRunPartyKey,
): { document: SendRunExistingDocument; published: boolean } | null {
  const runLabel = String(key.runLabel || '')
  const matches = (documents || []).filter((d) => {
    if (typeof d?.id !== 'string' || !d.id) return false
    if (String(d.type || '').toLowerCase() !== 'quote') return false
    if (d.archived) return false
    if (sendRunDocumentIsSuperseded(d)) return false
    if (String(d.run_label || '') !== runLabel) return false
    return sameSendRunContact(d.job_contact_id, key.jobContactId)
  })
  if (!matches.length) return null
  const published = matches.find((d) => quoteSendIsPublished(d))
  if (published) return { document: published, published: true }
  return { document: matches[0], published: false }
}

export function resolveSendRunDocument(
  documents: SendRunExistingDocument[],
  key: SendRunPartyKey,
): SendRunDocumentResolution {
  const found = existingQuoteDocumentForRun(documents, key)
  if (!found) return { action: 'create' }
  if (found.published) return { action: 'use_published', document: found.document }
  return { action: 'reuse_unpublished', document: found.document }
}

export type PriorQuoteSupersedeCandidate = {
  id?: string | null
  sent_at?: string | null
  sent_to_client?: boolean | null
  accepted_at?: string | null
  send_claimed_at?: string | null
  superseded_at?: string | null
}

/** Same durable-publication predicate as extract eligibility. Historical
 *  omitted-flag + sent_at and accepted_at rows must be superseded; explicit
 *  sent_to_client=false and in-flight claims stay current unpublished work. */
export function priorPublishedQuoteIdsToSupersede(
  candidates: PriorQuoteSupersedeCandidate[],
): string[] {
  return uniqueDocumentIds(
    (candidates || [])
      .filter((row) => {
        const publication = {
          sent_at: row.sent_at,
          sent_to_client: row.sent_to_client,
          accepted_at: row.accepted_at,
          send_claimed_at: row.send_claimed_at,
          superseded_at: row.superseded_at,
        }
        return quoteDocumentHasClientSend(publication) && !quoteDocumentIsSuperseded(publication)
      })
      .map((row) => row.id),
  )
}

export async function supersedePriorPublishedQuoteDocuments(
  sb: QuoteSendPublicationClient,
  input: {
    jobId: string
    currentDocumentId: string
    currentVersion: number
    jobContactId: string | null
    runLabel: string | null
    supersededByRevisionId?: string | null
    now?: Date
  },
): Promise<{ ok: true; supersededIds: string[] } | { ok: false; error: string }> {
  let sel = sb
    .from('job_documents')
    .select('id, version, sent_at, sent_to_client, accepted_at, send_claimed_at, superseded_at')
    .eq('job_id', input.jobId)
    .eq('type', 'quote')
    .is('superseded_at', null)
    .lt('version', input.currentVersion)
    .neq('id', input.currentDocumentId)
  sel = input.jobContactId == null
    ? sel.is('job_contact_id', null)
    : sel.eq('job_contact_id', input.jobContactId)
  sel = input.runLabel == null
    ? sel.is('run_label', null)
    : sel.eq('run_label', input.runLabel)
  const { data, error } = await sel
  if (error) {
    console.error('[send-quote] G-B2 supersede-prior read failed:', claimErrorMessage(error))
    return { ok: false, error: claimErrorMessage(error) }
  }
  const ids = priorPublishedQuoteIdsToSupersede(Array.isArray(data) ? data : [])
  if (!ids.length) return { ok: true, supersededIds: [] }
  const now = input.now || new Date()
  const { data: updated, error: updateError } = await sb
    .from('job_documents')
    .update({
      superseded_at: now.toISOString(),
      superseded_by_revision_id: input.supersededByRevisionId ?? null,
    })
    .in('id', ids)
    .is('superseded_at', null)
    .select('id')
  if (updateError) {
    console.error('[send-quote] G-B2 supersede-prior write failed:', claimErrorMessage(updateError))
    return { ok: false, error: claimErrorMessage(updateError) }
  }
  const supersededIds = uniqueDocumentIds(
    (Array.isArray(updated) ? updated : []).map((row: { id?: string | null }) => row?.id),
  )
  return { ok: true, supersededIds }
}

export function sendRunsPublicationFailureBlocksSuccess(input: {
  resendSucceeded: boolean
  publicationSucceeded: boolean
}): { failHandler: boolean; flipQuoted: boolean } {
  if (input.resendSucceeded && !input.publicationSucceeded) {
    return { failHandler: true, flipQuoted: false }
  }
  return {
    failHandler: false,
    flipQuoted: input.resendSucceeded && input.publicationSucceeded,
  }
}

export type SendRunsSendOutcome =
  | { success: true; alreadyComplete: boolean }
  | { success: false; httpStatus: number; code: string; error: string }

/**
 * send-runs may report success only when at least one email was published,
 * or when every eligible pack is already published (idempotent retry).
 * Neighbour-only email success stays success; the job stays unquoted.
 * Zero emails after assembled recipients, or nothing assembled, is failure.
 */
export function sendRunsSendOutcome(input: {
  emailsSent: number
  recipientsAssembled: number
  publishedExistingCount: number
  claimedCount: number
}): SendRunsSendOutcome {
  if (input.emailsSent > 0) return { success: true, alreadyComplete: false }
  if (
    input.recipientsAssembled === 0 &&
    input.claimedCount === 0 &&
    input.publishedExistingCount > 0
  ) {
    return { success: true, alreadyComplete: true }
  }
  if (input.recipientsAssembled > 0) {
    return {
      success: false,
      httpStatus: 502,
      code: 'quote_email_delivery_failed',
      error: 'Quote email delivery failed',
    }
  }
  return {
    success: false,
    httpStatus: 400,
    code: 'no_quote_recipients',
    error: 'No quote recipients to send',
  }
}

/**
 * draft→quoted is durable primary-client publication, not "emailed this
 * request". A retry that resolves the primary as use_published must still
 * flip a leftover draft. Neighbour-only publication never satisfies.
 */
export function sendRunsPrimaryClientPublicationSatisfied(input: {
  primarySentThisRequest: boolean
  publishedExistingDocs: Array<{
    job_contact_id?: string | null
    superseded_at?: string | null
    sent_to_client?: boolean | null
    sent_at?: string | null
    accepted_at?: string | null
    send_claimed_at?: string | null
  }>
  primaryJobContactId: string | null
}): boolean {
  if (input.primarySentThisRequest) return true
  return (input.publishedExistingDocs || []).some((doc) => {
    if (sendRunDocumentIsSuperseded(doc)) return false
    if (!sameSendRunContact(doc.job_contact_id, input.primaryJobContactId)) return false
    return quoteSendIsPublished(doc)
  })
}

/** send-runs recipient group key. Trim + lowercase so case variants
 *  are one inbox, one email, one publication set. */
export function quoteSendRecipientKey(email: unknown): string {
  return String(email || '').trim().toLowerCase()
}

export function quoteGroupEmailDocumentIds(
  documentIds: Iterable<string | null | undefined>,
): string[] {
  return uniqueDocumentIds(documentIds).slice().sort()
}

export function quoteGroupEmailDocumentSetKey(
  documentIds: Iterable<string | null | undefined>,
): string {
  return quoteGroupEmailDocumentIds(documentIds).join(',')
}

export function quoteGroupEmailCoversDocumentSet(
  storedIds: Iterable<string | null | undefined>,
  currentIds: Iterable<string | null | undefined>,
): boolean {
  const stored = new Set(quoteGroupEmailDocumentIds(storedIds))
  const current = quoteGroupEmailDocumentIds(currentIds)
  if (!current.length || !stored.size) return false
  return current.every((id) => stored.has(id))
}

export type QuoteGroupEmailSendRecord = {
  id?: string | null
  document_ids?: Iterable<string | null | undefined> | null
  document_set_key?: string | null
  send_resend_idempotency_key?: string | null
}

/** Exact original set first, then the smallest covering superset. */
export function pickQuoteGroupEmailCoveringRecord<T extends QuoteGroupEmailSendRecord>(
  records: Iterable<T | null | undefined>,
  currentIds: Iterable<string | null | undefined>,
): T | null {
  const current = quoteGroupEmailDocumentIds(currentIds)
  if (!current.length) return null
  const covering: Array<{ record: T; size: number; setKey: string; exact: boolean }> = []
  for (const raw of records) {
    if (!raw) continue
    const stored = quoteGroupEmailDocumentIds(raw.document_ids || [])
    if (!quoteGroupEmailCoversDocumentSet(stored, current)) continue
    const setKey = quoteSendClaimToken(raw.document_set_key) || quoteGroupEmailDocumentSetKey(stored)
    covering.push({
      record: raw,
      size: stored.length,
      setKey,
      exact: stored.length === current.length,
    })
  }
  if (!covering.length) return null
  covering.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1
    if (a.size !== b.size) return a.size - b.size
    return a.setKey.localeCompare(b.setKey)
  })
  return covering[0].record
}

function isPgUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  if (error.code === '23505') return true
  return /duplicate key|unique constraint/i.test(String(error.message || ''))
}

export type QuoteGroupEmailSendKeyResult =
  | { status: 'ready'; resend_idempotency_key: string; reused: boolean }
  | { status: 'unavailable' }
  | { status: 'error'; error: string }

function quoteGroupEmailReadyKey(
  record: QuoteGroupEmailSendRecord | null | undefined,
): string | null {
  return quoteSendClaimToken(record?.send_resend_idempotency_key)
}

async function loadQuoteGroupEmailSendRecords(
  sb: QuoteSendPublicationClient,
  jobId: string,
  recipientEmail: string,
): Promise<{ records: QuoteGroupEmailSendRecord[]; error: string | null }> {
  const { data, error } = await sb
    .from(QUOTE_GROUP_EMAIL_SEND_TABLE)
    .select('id, document_ids, document_set_key, send_resend_idempotency_key')
    .eq('job_id', jobId)
    .eq('recipient_email', recipientEmail)
  if (error) return { records: [], error: claimErrorMessage(error) }
  const records = Array.isArray(data) ? data.filter((row): row is QuoteGroupEmailSendRecord => !!row) : []
  return { records, error: null }
}

/**
 * Durable send-runs group provider key. Lookup a covering original set
 * (current docs ⊆ stored docs) and reuse its Idempotency-Key. Otherwise
 * insert this attempt's document set. Unique races re-read. Partial
 * publication does not mint a second key for leftovers.
 */
export async function ensureQuoteGroupEmailSendKey(
  sb: QuoteSendPublicationClient,
  input: {
    jobId?: string | null
    recipientEmail?: string | null
    documentIds: Iterable<string | null | undefined>
  },
): Promise<QuoteGroupEmailSendKeyResult> {
  const jobId = typeof input.jobId === 'string' ? input.jobId.trim() : ''
  const recipientEmail = quoteSendRecipientKey(input.recipientEmail)
  const documentIds = quoteGroupEmailDocumentIds(input.documentIds)
  if (!jobId || !recipientEmail || !documentIds.length) return { status: 'unavailable' }

  const loaded = await loadQuoteGroupEmailSendRecords(sb, jobId, recipientEmail)
  if (loaded.error) {
    console.error('[send-quote] group send record read failed:', loaded.error)
    return { status: 'error', error: loaded.error }
  }
  const covering = pickQuoteGroupEmailCoveringRecord(loaded.records, documentIds)
  const reusedKey = quoteGroupEmailReadyKey(covering)
  if (reusedKey) {
    return { status: 'ready', resend_idempotency_key: reusedKey, reused: true }
  }

  const payload = {
    job_id: jobId,
    recipient_email: recipientEmail,
    document_ids: documentIds,
    document_set_key: quoteGroupEmailDocumentSetKey(documentIds),
    send_resend_idempotency_key: quoteGroupEmailResendIdempotencyKey(mintQuoteSendClaimToken()),
  }
  const { data, error } = await sb
    .from(QUOTE_GROUP_EMAIL_SEND_TABLE)
    .insert(payload)
    .select('id, document_ids, document_set_key, send_resend_idempotency_key')
    .maybeSingle()
  if (error) {
    if (isPgUniqueViolation(error)) {
      const again = await loadQuoteGroupEmailSendRecords(sb, jobId, recipientEmail)
      if (again.error) {
        console.error('[send-quote] group send record reread failed:', again.error)
        return { status: 'error', error: again.error }
      }
      const raced = pickQuoteGroupEmailCoveringRecord(again.records, documentIds)
      const racedKey = quoteGroupEmailReadyKey(raced)
      if (racedKey) {
        return { status: 'ready', resend_idempotency_key: racedKey, reused: true }
      }
    }
    console.error('[send-quote] group send record insert failed:', claimErrorMessage(error))
    return { status: 'error', error: claimErrorMessage(error) }
  }
  const confirmedId = typeof data?.id === 'string' ? data.id.trim() : ''
  const confirmed = quoteGroupEmailReadyKey(data)
    || (confirmedId ? quoteSendClaimToken(payload.send_resend_idempotency_key) : null)
  if (!confirmedId || !confirmed) {
    console.error('[send-quote] group send record insert lost the returning row')
    return { status: 'error', error: 'quote group send record insert was not confirmed' }
  }
  return { status: 'ready', resend_idempotency_key: confirmed, reused: false }
}

export type QuoteGroupEmailSendRetireResult =
  | { status: 'retired' }
  | { status: 'unavailable' }
  | { status: 'error'; error: string }

/**
 * Drop the durable group provider key after Resend definitely rejected
 * the payload (4xx except 408/409/429). CHECK forbids an empty key, so
 * this deletes the matching row. Next `ensure` mints a new key. Keep
 * the row for accepted or ambiguous provider outcomes.
 */
export async function retireQuoteGroupEmailSendKey(
  sb: QuoteSendPublicationClient,
  input: {
    jobId?: string | null
    recipientEmail?: string | null
    resendIdempotencyKey?: string | null
  },
): Promise<QuoteGroupEmailSendRetireResult> {
  const jobId = typeof input.jobId === 'string' ? input.jobId.trim() : ''
  const recipientEmail = quoteSendRecipientKey(input.recipientEmail)
  const key = quoteSendClaimToken(input.resendIdempotencyKey)
  if (!jobId || !recipientEmail || !key) return { status: 'unavailable' }

  const { error } = await sb
    .from(QUOTE_GROUP_EMAIL_SEND_TABLE)
    .delete()
    .eq('job_id', jobId)
    .eq('recipient_email', recipientEmail)
    .eq('send_resend_idempotency_key', key)
  if (error) {
    console.error('[send-quote] group send record retire failed:', claimErrorMessage(error))
    return { status: 'error', error: claimErrorMessage(error) }
  }
  return { status: 'retired' }
}

/** Document ids belonging to recipients whose Resend call succeeded.
 *  Match the stored group email exactly (after trim) so a success for
 *  `Pat@` cannot stamp a distinct `pat@` group. Construction must
 *  store `quoteSendRecipientKey` so live groups stay one inbox. */
export function documentIdsPublishedForSuccessfulSends(
  recipients: Array<{ email?: string | null; docs?: Array<{ id?: string | null }> | null }>,
  successfulEmails: Iterable<string>,
): string[] {
  const ok = new Set(
    [...successfulEmails]
      .map((email) => String(email || '').trim())
      .filter(Boolean),
  )
  const ids: string[] = []
  const seen = new Set<string>()
  for (const recipient of recipients) {
    const email = String(recipient.email || '').trim()
    if (!email || !ok.has(email)) continue
    for (const doc of recipient.docs || []) {
      const id = typeof doc?.id === 'string' ? doc.id.trim() : ''
      if (!id || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

export function claimsForDocumentIds(
  claims: Iterable<{ id?: string | null; token?: string | null } | null | undefined>,
  documentIds: Iterable<string>,
): QuoteSendDocumentClaim[] {
  const wanted = new Set(uniqueDocumentIds(documentIds))
  return uniqueDocumentClaims(claims).filter((claim) => wanted.has(claim.id))
}

/** Claims whose document was not in the successful-recipient publish set. */
export function claimsNotInDocumentIds(
  claims: Iterable<{ id?: string | null; token?: string | null } | null | undefined>,
  documentIds: Iterable<string>,
): QuoteSendDocumentClaim[] {
  const published = new Set(uniqueDocumentIds(documentIds))
  return uniqueDocumentClaims(claims).filter((claim) => !published.has(claim.id))
}

export function sendRunQuoteNumberFallback(input: {
  jobNumber?: string | null
  runLabel?: string | null
  party?: 'client' | 'neighbour'
}): string {
  const job = String(input.jobNumber || '').trim() || 'Q'
  const run = String(input.runLabel || '').trim() || 'RUN'
  const suffix = input.party === 'neighbour' ? '-N' : ''
  return `${job}-${run}${suffix}`
}

export async function mintSendRunQuoteNumber(
  sb: QuoteSendPublicationClient,
  fallback: string,
): Promise<string> {
  if (typeof sb.rpc !== 'function') return fallback
  const { data, error } = await sb.rpc('next_quote_number')
  if (error) {
    console.error('[send-quote] next_quote_number failed:', error.message || String(error))
  }
  if (typeof data === 'string' && data.trim()) return data.trim()
  return fallback
}
