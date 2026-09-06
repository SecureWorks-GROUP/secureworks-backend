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
 * calls cannot mint a second published pack.
 */

import {
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

export function quoteSendDocumentResendIdempotencyKey(documentId: string): string {
  return `quote-send-doc:${documentId}`
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

export function quoteSendClaimRevertPayload(): {
  send_claimed_at: null
  send_claim_token: null
  send_resend_idempotency_key: null
} {
  return {
    send_claimed_at: null,
    send_claim_token: null,
    send_resend_idempotency_key: null,
  }
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
    .update(payload)
    .eq('id', documentId)
    .is('send_claimed_at', null)
    .is('sent_at', null)
    .is('accepted_at', null)
    .not('sent_to_client', 'is', true)
    .select('id')
    .maybeSingle()
  if (error) {
    console.error('[send-quote] claim failed:', claimErrorMessage(error))
    return { status: 'error', error: claimErrorMessage(error) }
  }
  return data && typeof data.id === 'string'
    ? {
      status: 'claimed',
      id: data.id,
      token: payload.send_claim_token,
      claimed_at: payload.send_claimed_at,
      resend_idempotency_key: payload.send_resend_idempotency_key,
    }
    : { status: 'unavailable' }
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
): Promise<{ updated: boolean; error: { message?: string } | null }> {
  const owned = quoteSendClaimToken(token)
  if (!owned) return { updated: false, error: { message: 'send claim token required' } }
  const { data, error } = await sb
    .from('job_documents')
    .update(quoteSendClaimRevertPayload())
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
): Promise<{ error: { message?: string } | null }> {
  const owned = uniqueDocumentClaims(claims)
  if (!owned.length) return { error: null }
  for (const claim of owned) {
    const { error } = await revertQuoteDocumentSendClaim(sb, claim.id, claim.token)
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
  await revertQuoteDocumentSendClaim(sb, documentId, token)
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
    await revertQuoteDocumentSendClaims(sb, owned)
    return { published: false, error: message }
  }
  return { published: true }
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

/** Document ids belonging to recipients whose Resend call succeeded. */
export function documentIdsPublishedForSuccessfulSends(
  recipients: Array<{ email?: string | null; docs?: Array<{ id?: string | null }> | null }>,
  successfulEmails: Iterable<string>,
): string[] {
  const ok = new Set(
    [...successfulEmails]
      .map((email) => String(email || '').trim().toLowerCase())
      .filter(Boolean),
  )
  const ids: string[] = []
  const seen = new Set<string>()
  for (const recipient of recipients) {
    const email = String(recipient.email || '').trim().toLowerCase()
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
