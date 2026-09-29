// deno-lint-ignore-file no-explicit-any
// Approved email: send the one email an owner approval names, exactly.
//
// Reached only with a body of {approval_id}. Nothing in the request shapes the
// message: mailbox, new-or-reply, the message replied to, To, CC, BCC,
// subject, HTML body and attachment files all come from the approval, and the
// attachments are re-read and re-hashed (prepareApprovedSend) before anything
// is claimed. The body is sent exactly as approved: no signature is appended.
//
// The message is built as a Graph draft (a new draft, or the provider's own
// reply draft so the reply stays in the thread), its recipients and subject
// are set to the approved values, the draft Graph returns is checked against
// the approval, and only then are the files added and the draft sent. A draft
// never delivers mail, so any failure before the final send leaves nothing
// sent (status failed); an uncertain final send is outcome_unknown and is
// never retried.
//
// Approval checks, the claim and the audit are owned by
// ../_shared/approved_send.ts.

import {
  ApprovedSendRefusal,
  claimApprovedSend,
  type EmailPayload,
  finishApprovedSend,
  prepareApprovedSend,
  type SendDeps,
} from '../_shared/approved_send.ts'

export type GraphCall = (
  path: string,
  init?: RequestInit,
  options?: { mutating?: boolean },
) => Promise<Response>

export interface ApprovedEmailDeps extends SendDeps {
  graph: GraphCall
  verifyMailbox: (mailbox: string) => Promise<void>
}

export interface Caller {
  actor: string | null
  credentialClass: string | null
}

function seg(value: string): string {
  return encodeURIComponent(value)
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function recipients(list: string[]) {
  return list.map((address) => ({ emailAddress: { address } }))
}

function addresses(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) =>
    String((entry as any)?.emailAddress?.address || '').trim().toLowerCase()
  ).filter(Boolean).sort()
}

function sameList(actual: string[], expected: string[]): boolean {
  const want = [...expected].sort()
  return actual.length === want.length &&
    actual.every((address, index) => address === want[index])
}

/** True when a thrown provider error may mean Graph acted. */
function outcomeUnknown(error: unknown): boolean {
  if (error instanceof ApprovedSendRefusal) return false
  const flag = (error as { outcomeUnknown?: unknown })?.outcomeUnknown
  return typeof flag === 'boolean' ? flag : true
}

class DraftMismatch extends Error {}

export async function sendApprovedEmail(
  deps: ApprovedEmailDeps,
  approvalId: string,
  caller: Caller,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const prepared = await prepareApprovedSend(deps, approvalId, 'email')
  const payload = prepared.payload as EmailPayload
  // A read that proves the mailbox exists and primes the Graph token before
  // the approval is consumed.
  await deps.verifyMailbox(payload.mailbox)
  const claimed = await claimApprovedSend(deps, prepared, caller)

  const base = `/users/${seg(payload.mailbox)}/messages`
  let draftId: string | null = null
  let internetMessageId: string | null = null
  let stage = 'draft'
  try {
    let draft: Record<string, unknown>
    if (payload.mode === 'reply') {
      const created = await deps.graph(
        `${base}/${seg(payload.reply_to_message_id || '')}/createReply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: { body: { contentType: 'HTML', content: payload.html_body } },
          }),
        },
        { mutating: true },
      )
      draftId = String((await created.json() as any)?.id || '') || null
      if (!draftId) throw new DraftMismatch('Graph reply draft had no id')
      const patched = await deps.graph(`${base}/${seg(draftId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: payload.subject,
          toRecipients: recipients(payload.to),
          ccRecipients: recipients(payload.cc),
          bccRecipients: recipients(payload.bcc),
        }),
      }, { mutating: true })
      draft = await patched.json() as Record<string, unknown>
    } else {
      const created = await deps.graph(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: payload.subject,
          body: { contentType: 'HTML', content: payload.html_body },
          toRecipients: recipients(payload.to),
          ccRecipients: recipients(payload.cc),
          bccRecipients: recipients(payload.bcc),
        }),
      }, { mutating: true })
      draft = await created.json() as Record<string, unknown>
      draftId = String(draft?.id || '') || null
      if (!draftId) throw new DraftMismatch('Graph draft had no id')
    }
    internetMessageId = String(draft?.internetMessageId || '') || null
    if (
      !sameList(addresses(draft.toRecipients), payload.to) ||
      !sameList(addresses(draft.ccRecipients), payload.cc) ||
      !sameList(addresses(draft.bccRecipients), payload.bcc) ||
      String(draft.subject ?? '') !== payload.subject
    ) {
      throw new DraftMismatch(
        'The provider draft does not carry exactly the approved recipients and subject',
      )
    }
    stage = 'attachments'
    for (const attachment of prepared.attachments) {
      await deps.graph(`${base}/${seg(draftId)}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: attachment.approved.name,
          contentType: attachment.approved.content_type,
          contentBytes: base64(attachment.bytes),
        }),
      }, { mutating: true })
    }
    stage = 'send'
    await deps.graph(`${base}/${seg(draftId)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { mutating: true })
  } catch (error) {
    // Before the final send nothing can have been delivered.
    const unknown = stage === 'send' && outcomeUnknown(error)
    const status = unknown ? 'outcome_unknown' : 'failed'
    const code = error instanceof DraftMismatch
      ? 'provider_draft_mismatch'
      : unknown
      ? 'provider_outcome_unknown'
      : `provider_failed_at_${stage}`
    if (!unknown && draftId) {
      // Leave no approved-content draft lying in the mailbox. Best effort.
      try {
        await deps.graph(`${base}/${seg(draftId)}`, { method: 'DELETE' }, {
          mutating: true,
        })
      } catch { /* the outcome below still records the failure */ }
    }
    const recorded = await finishApprovedSend(deps, claimed, {
      status,
      code,
      provider_message_id: internetMessageId,
      detail: {
        mailbox: payload.mailbox,
        mode: payload.mode,
        graph_draft_id: draftId,
        stage,
        error: (error as Error).message,
      },
    }, caller)
    return {
      status: 502,
      body: {
        state: status,
        code,
        approval_id: approvalId,
        error: (error as Error).message,
        retry_safe: false,
        recovery_action: unknown
          ? 'Check the mailbox Sent Items for this message before anything else; this approval is used and is never resent.'
          : 'Nothing was sent. This approval is used; record a new approval to try again.',
        ...recorded,
      },
    }
  }
  const recorded = await finishApprovedSend(deps, claimed, {
    status: 'sent',
    code: null,
    provider_message_id: internetMessageId || draftId,
    detail: {
      mailbox: payload.mailbox,
      mode: payload.mode,
      reply_to_message_id: payload.reply_to_message_id,
      graph_draft_id: draftId,
      internet_message_id: internetMessageId,
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      subject: payload.subject,
      attachments: payload.attachments.map((entry) => ({
        name: entry.name,
        sha256: entry.sha256,
        size_bytes: entry.size_bytes,
      })),
    },
  }, caller)
  return {
    status: 202,
    body: {
      success: true,
      state: 'sent',
      accepted: true,
      delivered: null,
      delivery_status: 'unverified',
      approval_id: approvalId,
      channel: 'email',
      mailbox: payload.mailbox,
      mode: payload.mode,
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      subject: payload.subject,
      attachments: payload.attachments.length,
      provider_message_id: internetMessageId || draftId,
      graph_draft_id: draftId,
      payload_hash: claimed.row.payload_hash,
      retry_safe: false,
      ...recorded,
    },
  }
}
