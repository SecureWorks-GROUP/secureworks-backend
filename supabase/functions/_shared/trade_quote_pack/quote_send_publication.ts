/**
 * Direct /send claim vs publication.
 *
 * An in-flight claim locks the row (`send_claimed_at`) so two callers cannot
 * both dispatch Resend. That stamp is not a client send. Quote-pack and
 * extract eligibility read publication only: `sent_to_client=true` plus
 * `sent_at` after Resend succeeds, or a historical omitted-flag row, or
 * `accepted_at`. Same bar as send-runs.
 */

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

export async function claimQuoteDocumentSend(
  sb: QuoteSendPublicationClient,
  documentId: string,
  now = new Date(),
): Promise<{ id: string } | null> {
  const { data, error } = await sb
    .from('job_documents')
    .update(quoteSendClaimPayload(now))
    .eq('id', documentId)
    .is('send_claimed_at', null)
    .not('sent_to_client', 'is', true)
    .select('id')
    .maybeSingle()
  if (error) {
    console.error('[send-quote] claim failed:', error.message || String(error))
    return null
  }
  return data && typeof data.id === 'string' ? { id: data.id } : null
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
