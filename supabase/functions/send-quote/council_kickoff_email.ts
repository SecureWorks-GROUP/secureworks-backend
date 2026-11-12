// The "Next Steps & House Plans" email a patio customer gets when they accept
// their quote online (council kickoff: it asks for the house plans, with an
// upload link).
//
// Until 12 Nov 2026 the accept handler sent it to an address it never read (its
// document and job reads select no email), so every send went to an empty
// address, Resend refused it, and the handler still recorded it as 'sent'
// because it never looked at Resend's answer.
//
// Rules:
// - The recipient is the address the quote send itself used for the accepted
//   document: the newest released quote_revisions row for that document
//   (recipient_email, written by send-quote at the send). No cc, no other
//   recipient, no guess from the job or contact rows.
// - No address: nothing is sent and nothing is recorded as sent.
// - 'sent' is recorded (po_communications and the GHL note) only when Resend
//   accepts the email (ok response with an id). Anything else is recorded as
//   'failed' on po_communications and no GHL note is written.

export const COUNCIL_KICKOFF_SUBJECT = 'Your Patio Project - Next Steps & What We Need From You'
export const COUNCIL_KICKOFF_GHL_SUBJECT = 'Council Kickoff - Next Steps & House Plans'
export const COUNCIL_KICKOFF_FROM = 'approvals@secureworksgroup.app'

export type QuoteRecipient =
  | { ok: true; email: string }
  | { ok: false; reason: 'no_accepted_document' | 'recipient_read_failed' | 'no_released_quote' | 'no_recipient_email' }

type Sb = { from: (table: string) => any }

/** The address the quote send used for this document (newest released revision). */
export async function readQuoteRecipientEmail(sb: Sb, documentId: string | null | undefined): Promise<QuoteRecipient> {
  if (!documentId) return { ok: false, reason: 'no_accepted_document' }
  let res: { data: any[] | null; error: unknown }
  try {
    res = await sb.from('quote_revisions')
      .select('recipient_email, sent_at')
      .eq('job_document_id', documentId)
      .not('sent_at', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(1)
  } catch {
    return { ok: false, reason: 'recipient_read_failed' }
  }
  if (res?.error) return { ok: false, reason: 'recipient_read_failed' }
  const row = res?.data?.[0]
  if (!row) return { ok: false, reason: 'no_released_quote' }
  const email = typeof row.recipient_email === 'string' ? row.recipient_email.trim() : ''
  if (!email || !email.includes('@')) return { ok: false, reason: 'no_recipient_email' }
  return { ok: true, email }
}

export type CouncilKickoffOutcome =
  | { outcome: 'sent'; recipient: string; messageId: string }
  | { outcome: 'no_recipient'; reason: string }
  | { outcome: 'failed'; recipient: string; reason: string }

export type CouncilKickoffDeps = {
  sb: Sb
  fetch: typeof fetch
  resendApiKey: string
  /** Logs the sent email as a note on the customer's GHL contact. Called only on a real send. */
  logGhl: (subject: string, recipient: string) => void
  now?: () => Date
}

export type CouncilKickoffInput = {
  jobId: string
  jobNumber: string | null | undefined
  documentId: string | null | undefined
  councilSubmissionId: string | null
  replyTo: string
  html: string
}

export async function sendCouncilKickoffEmail(
  deps: CouncilKickoffDeps,
  input: CouncilKickoffInput,
): Promise<CouncilKickoffOutcome> {
  const recipient = await readQuoteRecipientEmail(deps.sb, input.documentId)
  if (!recipient.ok) {
    console.warn('[send-quote] council kickoff email not sent: no recipient', JSON.stringify({
      job_id: input.jobId, document_id: input.documentId ?? null, reason: recipient.reason,
    }))
    return { outcome: 'no_recipient', reason: recipient.reason }
  }
  const to = recipient.email

  let messageId: string | null = null
  let reason = ''
  try {
    const res = await deps.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${deps.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `SecureWorks Group <${COUNCIL_KICKOFF_FROM}>`,
        reply_to: input.replyTo,
        to: [to],
        subject: COUNCIL_KICKOFF_SUBJECT,
        html: input.html,
      }),
    })
    const body = await res.json().catch(() => null)
    const id = body && typeof body === 'object' && typeof (body as any).id === 'string' ? (body as any).id : ''
    if (res.ok && id) messageId = id
    else reason = res.ok ? 'resend_no_id' : `resend_http_${res.status}`
  } catch (e) {
    reason = `resend_network: ${(e as Error).message}`
  }

  const sent = messageId !== null
  if (sent) {
    console.log(`[send-quote] Council kickoff email sent for ${input.jobNumber}`)
    deps.logGhl(COUNCIL_KICKOFF_GHL_SUBJECT, to)
  } else {
    console.error('[send-quote] council kickoff email failed', JSON.stringify({ job_id: input.jobId, reason }))
  }

  // Record in po_communications for the council thread (as before, only when a
  // council submission exists to thread it on).
  if (input.councilSubmissionId) {
    try {
      const { error } = await deps.sb.from('po_communications').insert({
        job_id: input.jobId,
        direction: 'outbound',
        from_email: COUNCIL_KICKOFF_FROM,
        to_email: to,
        subject: COUNCIL_KICKOFF_SUBJECT,
        body_text: sent
          ? 'House plans request sent to client on acceptance'
          : `House plans request to client on acceptance failed (${reason})`,
        communication_type: 'council',
        council_submission_id: input.councilSubmissionId,
        council_step_index: 0,
        sent_at: (deps.now?.() ?? new Date()).toISOString(),
        delivery_status: sent ? 'sent' : 'failed',
        ...(sent ? { message_id: messageId } : {}),
      })
      if (error) console.error('[send-quote] council kickoff record failed:', (error as any)?.message || String(error))
    } catch (e) {
      console.error('[send-quote] council kickoff record failed:', (e as Error).message)
    }
  }

  return sent
    ? { outcome: 'sent', recipient: to, messageId: messageId! }
    : { outcome: 'failed', recipient: to, reason }
}
