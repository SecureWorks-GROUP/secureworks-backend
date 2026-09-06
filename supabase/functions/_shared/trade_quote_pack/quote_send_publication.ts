/**
 * Direct /send and send-runs claim vs publication.
 *
 * An in-flight claim locks the row (`send_claimed_at`) so two callers cannot
 * both dispatch Resend. That stamp is not a client send. Quote-pack and
 * extract eligibility read publication only: `sent_to_client=true` plus
 * `sent_at` after Resend succeeds, or a historical omitted-flag row, or
 * `accepted_at`. Same bar as send-runs.
 *
 * Claims expire. A worker that dies after claim and before Resend-failure
 * revert or publication must not strand `/send` on `already_sent` forever.
 * send-runs takes a job-level claim (`jobs.send_runs_claimed_at`) with the
 * same TTL so concurrent/retry calls cannot mint a second published pack.
 */

export const QUOTE_SEND_CLAIM_TTL_MS = 15 * 60 * 1000

export type QuoteSendPublicationClient = {
  from: (table: string) => any
  rpc?: (fn: string) => Promise<{ data: unknown; error: { message?: string } | null }>
}

export function quoteSendClaimPayload(now = new Date()): { send_claimed_at: string } {
  return { send_claimed_at: now.toISOString() }
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

export function quoteSendClaimRevertPayload(): { send_claimed_at: null } {
  return { send_claimed_at: null }
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
}): boolean {
  return row.sent_to_client === true &&
    typeof row.sent_at === 'string' &&
    row.sent_at.trim().length > 0
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

async function claimQuoteDocumentSendExclusive(
  sb: QuoteSendPublicationClient,
  documentId: string,
  now: Date,
): Promise<{ id: string } | null> {
  const { data, error } = await sb
    .from('job_documents')
    .update(quoteSendClaimPayload(now))
    .eq('id', documentId)
    .is('send_claimed_at', null)
    .is('sent_at', null)
    .not('sent_to_client', 'is', true)
    .select('id')
    .maybeSingle()
  if (error) {
    console.error('[send-quote] claim failed:', error.message || String(error))
    return null
  }
  return data && typeof data.id === 'string' ? { id: data.id } : null
}

async function reclaimStaleQuoteDocumentSend(
  sb: QuoteSendPublicationClient,
  documentId: string,
  now: Date,
): Promise<{ id: string } | null> {
  const { data, error } = await sb
    .from('job_documents')
    .update(quoteSendClaimPayload(now))
    .eq('id', documentId)
    .is('sent_at', null)
    .not('sent_to_client', 'is', true)
    .lt('send_claimed_at', quoteSendClaimStaleBefore(now))
    .select('id')
    .maybeSingle()
  if (error) {
    console.error('[send-quote] stale claim reclaim failed:', error.message || String(error))
    return null
  }
  return data && typeof data.id === 'string' ? { id: data.id } : null
}

export async function claimQuoteDocumentSend(
  sb: QuoteSendPublicationClient,
  documentId: string,
  now = new Date(),
): Promise<{ id: string } | null> {
  const exclusive = await claimQuoteDocumentSendExclusive(sb, documentId, now)
  if (exclusive) return exclusive
  return await reclaimStaleQuoteDocumentSend(sb, documentId, now)
}

export async function publishQuoteDocumentSend(
  sb: QuoteSendPublicationClient,
  documentId: string,
  now = new Date(),
): Promise<{ error: { message?: string } | null }> {
  const { error } = await sb
    .from('job_documents')
    .update(quoteSendPublicationPayload(now))
    .eq('id', documentId)
  return { error: error || null }
}

export async function revertQuoteDocumentSendClaim(
  sb: QuoteSendPublicationClient,
  documentId: string,
): Promise<{ error: { message?: string } | null }> {
  const { error } = await sb
    .from('job_documents')
    .update(quoteSendClaimRevertPayload())
    .eq('id', documentId)
    .not('sent_to_client', 'is', true)
  return { error: error || null }
}

export async function revertQuoteDocumentSendClaims(
  sb: QuoteSendPublicationClient,
  documentIds: Iterable<string | null | undefined>,
): Promise<{ error: { message?: string } | null }> {
  const ids = uniqueDocumentIds(documentIds)
  if (!ids.length) return { error: null }
  const { error } = await sb
    .from('job_documents')
    .update(quoteSendClaimRevertPayload())
    .in('id', ids)
    .not('sent_to_client', 'is', true)
  return { error: error || null }
}

/**
 * Stamp publication after Resend. On stamp failure revert the in-flight
 * claim so a retry can re-claim. Do not treat a logged error as success.
 */
export async function publishQuoteDocumentSendOrRevert(
  sb: QuoteSendPublicationClient,
  documentId: string,
  now = new Date(),
): Promise<{ published: true } | { published: false; error: string }> {
  const { error } = await publishQuoteDocumentSend(sb, documentId, now)
  if (!error) return { published: true }
  const message = error.message || String(error)
  console.error('[send-quote] publication stamp failed:', message)
  await revertQuoteDocumentSendClaim(sb, documentId)
  return { published: false, error: message }
}

export async function publishQuoteDocumentsSendOrRevert(
  sb: QuoteSendPublicationClient,
  documentIds: Iterable<string | null | undefined>,
  now = new Date(),
): Promise<{ published: true } | { published: false; error: string }> {
  const ids = uniqueDocumentIds(documentIds)
  if (!ids.length) return { published: true }
  const { error } = await sb
    .from('job_documents')
    .update(quoteSendPublicationPayload(now))
    .in('id', ids)
  if (!error) return { published: true }
  const message = error.message || String(error)
  console.error('[send-quote] publication stamp failed:', message)
  await revertQuoteDocumentSendClaims(sb, ids)
  return { published: false, error: message }
}

async function claimJobSendRunsExclusive(
  sb: QuoteSendPublicationClient,
  jobId: string,
  now: Date,
): Promise<{ id: string; claimed_at: string } | null> {
  const payload = jobSendRunsClaimPayload(now)
  const { data, error } = await sb
    .from('jobs')
    .update(payload)
    .eq('id', jobId)
    .is('send_runs_claimed_at', null)
    .select('id')
    .maybeSingle()
  if (error) {
    console.error('[send-quote] send-runs job claim failed:', error.message || String(error))
    return null
  }
  return data && typeof data.id === 'string'
    ? { id: data.id, claimed_at: payload.send_runs_claimed_at }
    : null
}

async function reclaimStaleJobSendRuns(
  sb: QuoteSendPublicationClient,
  jobId: string,
  now: Date,
): Promise<{ id: string; claimed_at: string } | null> {
  const payload = jobSendRunsClaimPayload(now)
  const { data, error } = await sb
    .from('jobs')
    .update(payload)
    .eq('id', jobId)
    .lt('send_runs_claimed_at', quoteSendClaimStaleBefore(now))
    .select('id')
    .maybeSingle()
  if (error) {
    console.error('[send-quote] send-runs stale job claim reclaim failed:', error.message || String(error))
    return null
  }
  return data && typeof data.id === 'string'
    ? { id: data.id, claimed_at: payload.send_runs_claimed_at }
    : null
}

export async function claimJobSendRuns(
  sb: QuoteSendPublicationClient,
  jobId: string,
  now = new Date(),
): Promise<{ id: string; claimed_at: string } | null> {
  const exclusive = await claimJobSendRunsExclusive(sb, jobId, now)
  if (exclusive) return exclusive
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

export function existingQuoteDocumentForRun(
  documents: SendRunExistingDocument[],
  key: SendRunPartyKey,
): { document: SendRunExistingDocument; published: boolean } | null {
  const runLabel = String(key.runLabel || '')
  const matches = (documents || []).filter((d) => {
    if (typeof d?.id !== 'string' || !d.id) return false
    if (String(d.type || '').toLowerCase() !== 'quote') return false
    if (d.archived) return false
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
