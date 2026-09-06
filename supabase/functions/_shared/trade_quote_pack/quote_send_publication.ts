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
  from: (table: string) => {
    update: (payload: Record<string, unknown>) => {
      eq: (column: string, value: unknown) => any
    }
  }
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
