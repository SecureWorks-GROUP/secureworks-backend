// ════════════════════════════════════════════════════════════
// SecureWorks — Send Outlook Email via Microsoft Graph API
//
// Sends email from any configured M365 mailbox with:
//   - HTML body
//   - CC recipients
//   - File attachments (from URL — downloaded and base64'd)
//
// Auth: Same dual-auth as other functions (x-api-key or Bearer)
// Graph: OAuth2 client_credentials flow (app-only, no user login)
//
// Required secrets:
//   MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
//
// Deploy:
//   supabase functions deploy send-outlook-email --no-verify-jwt
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  getSignature,
  outlookMessageHtmlBody,
  OUTLOOK_DEFAULT_MAILBOX,
} from "../_shared/outlook_signature.ts"
export { getSignature } from "../_shared/outlook_signature.ts"
import {
  inspectSealedSesJob,
  invoiceLinkRequiredRefusal,
  sealedSesFenceCheckFailedRefusal,
  sealedSesMoneyRefusal,
} from '../_shared/sealed_ses_money_fence.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  Deno.env.get('SUPABASE_SERVICE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-api-key, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const GRAPH_TIMEOUT_MS = 25_000
// Generic sendMail uses inline file attachments. Keep this at Graph's direct
// attachment boundary and leave larger files to the sealed SES upload path.
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024
const MAX_MESSAGE_BYTES = 35 * 1024 * 1024
const MAX_ATTACHMENT_REDIRECTS = 3
const KNOWN_GROUP_ADDRESSES = new Set([
  'ses@secureworkswa.com.au',
  'fencing@secureworkswa.com.au',
  'patios@secureworkswa.com.au',
])

const LEGACY_REPLY_FIELDS = [
  'in_reply_to',
  'references',
  'conversation_id',
  'replyTo',
  'reply_to',
  'conversationId',
]

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

class OutlookFenceError extends Error {
  constructor(
    readonly status: number,
    readonly refusal: {
      state: 'refused'
      fact: string
      code?: string
      recovery_action?: string
      evidence?: Record<string, unknown>
    },
  ) {
    super(String(refusal.fact || refusal.code || 'Outlook SES fence refused'))
  }
}

export class OutlookInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'OutlookInputError'
  }
}

export class GraphProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly outcomeUnknown = false,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'GraphProviderError'
  }
}

type FetchLike = typeof fetch

export type OutlookRoute =
  | { kind: 'mailbox'; mailbox: string }
  | { kind: 'group'; group: string; reason: string }

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OutlookInputError(
      'invalid_source',
      `${field} must be a non-empty string`,
    )
  }
  return value.trim()
}

function isEmail(value: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)
}

export function splitRecipientInput(
  value: unknown,
  field: string,
  required = false,
): string[] {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new OutlookInputError(
        'invalid_recipient',
        `${field} must contain at least one recipient`,
      )
    }
    return []
  }
  const values = Array.isArray(value) ? value : [value]
  const output: string[] = []
  for (const entry of values) {
    if (typeof entry !== 'string') {
      throw new OutlookInputError(
        'invalid_recipient',
        `${field} entries must be strings`,
      )
    }
    for (const candidate of entry.split(',')) {
      const email = candidate.trim()
      if (!email || !isEmail(email)) {
        throw new OutlookInputError(
          'invalid_recipient',
          `${field} contains an invalid address`,
        )
      }
      output.push(email)
    }
  }
  if (required && output.length === 0) {
    throw new OutlookInputError(
      'invalid_recipient',
      `${field} must contain at least one recipient`,
    )
  }
  return output
}

function hasOwn(body: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field)
}

export function classifyOutlookRoute(
  body: Record<string, unknown>,
): OutlookRoute {
  if (
    body.from !== undefined && body.mailbox !== undefined &&
    String(body.from).trim().toLowerCase() !==
      String(body.mailbox).trim().toLowerCase()
  ) {
    throw new OutlookInputError(
      'invalid_source',
      'from and mailbox must identify the same exact mailbox',
    )
  }
  if (body.action === 'forward') {
    const unsupportedSourceFields = [
      'from',
      'group_email',
      'group_id',
      'from_group',
      'target_type',
      'source_type',
    ].filter((field) => hasOwn(body, field))
    if (unsupportedSourceFields.length) {
      throw new OutlookInputError(
        'invalid_source',
        `Forward source contains unsupported fields: ${unsupportedSourceFields.join(', ')}`,
      )
    }
    if (hasOwn(body, 'group')) {
      const group = nonEmptyString(body.group, 'group')
      return { kind: 'group', group, reason: 'forward_group_source' }
    }
    return {
      kind: 'mailbox',
      mailbox: nonEmptyString(body.mailbox, 'mailbox'),
    }
  }
  const targetType = body.target_type ?? body.source_type
  if (
    targetType !== undefined && targetType !== 'mailbox' &&
    targetType !== 'user' && targetType !== 'group'
  ) {
    throw new OutlookInputError(
      'invalid_source',
      'target_type must be mailbox, user, or group',
    )
  }
  if (
    targetType === 'group' || hasOwn(body, 'group') ||
    hasOwn(body, 'group_id') ||
    hasOwn(body, 'from_group') || hasOwn(body, 'group_email')
  ) {
    const group = nonEmptyString(
      body.group ?? body.group_email ?? body.from_group ?? body.from,
      'group',
    )
    return {
      kind: 'group',
      group,
      reason: 'group_sender_requires_group_action',
    }
  }
  const mailbox = nonEmptyString(
    body.from ?? body.mailbox ?? OUTLOOK_DEFAULT_MAILBOX,
    'from',
  )
  if (KNOWN_GROUP_ADDRESSES.has(mailbox.toLowerCase())) {
    return {
      kind: 'group',
      group: mailbox,
      reason: 'known_group_sender_requires_group_action',
    }
  }
  return { kind: 'mailbox', mailbox }
}

export function assertNoLegacyReplyFields(body: Record<string, unknown>): void {
  const present = LEGACY_REPLY_FIELDS.filter((field) => hasOwn(body, field))
  if (present.length > 0) {
    throw new OutlookInputError(
      'legacy_reply_fields_unsupported',
      `Use action=reply with mailbox and message_id; ignored legacy reply fields are rejected (${
        present.join(', ')
      })`,
    )
  }
}

async function assertOutlookJobAllowed(
  client: any,
  jobId: string,
  action: string,
) {
  try {
    const inspection = await inspectSealedSesJob(client, jobId)
    if (inspection.sealed) {
      throw new OutlookFenceError(
        409,
        sealedSesMoneyRefusal(action, {
          job_id: jobId,
          matched_by: inspection.matched_by,
        }),
      )
    }
  } catch (error) {
    if (error instanceof OutlookFenceError) throw error
    throw new OutlookFenceError(
      503,
      sealedSesFenceCheckFailedRefusal(
        action,
        (error as Error).message,
        { job_id: jobId },
      ),
    )
  }
}

async function resolveOutlookInvoiceJob(
  client: any,
  xeroInvoiceId: string,
): Promise<string | null> {
  const mirror = await client.from('xero_invoices')
    .select(
      'job_id,invoice_type,invoice_obligation_revision_id,ses_external_token',
    )
    .eq('xero_invoice_id', xeroInvoiceId)
    .maybeSingle()
  if (mirror.error) {
    throw new OutlookFenceError(
      503,
      sealedSesFenceCheckFailedRefusal(
        'send_outlook_email',
        `The invoice mirror lookup failed (${mirror.error.message}).`,
        { xero_invoice_id: xeroInvoiceId },
      ),
    )
  }
  if (!mirror.data) {
    throw new OutlookFenceError(
      503,
      sealedSesFenceCheckFailedRefusal(
        'send_outlook_email',
        'The invoice is missing from the local Xero mirror.',
        { xero_invoice_id: xeroInvoiceId },
      ),
    )
  }
  const invoiceType = String(mirror.data.invoice_type || '').toUpperCase()
  if (
    invoiceType !== 'ACCPAY' &&
    (mirror.data.invoice_obligation_revision_id ||
      mirror.data.ses_external_token)
  ) {
    throw new OutlookFenceError(
      409,
      sealedSesMoneyRefusal('send_outlook_email', {
        xero_invoice_id: xeroInvoiceId,
        job_id: mirror.data.job_id || null,
      }),
    )
  }
  if (invoiceType !== 'ACCPAY' && !mirror.data.job_id) {
    throw new OutlookFenceError(
      409,
      invoiceLinkRequiredRefusal('send_outlook_email', {
        xero_invoice_id: xeroInvoiceId,
        invoice_type: invoiceType || null,
      }),
    )
  }
  if (mirror.data.job_id) {
    await assertOutlookJobAllowed(
      client,
      mirror.data.job_id,
      'send_outlook_email',
    )
  }
  return mirror.data.job_id || null
}

/**
 * Sender-only reply fence.
 *
 * A mailbox message with no stored job can still be answered, but only by
 * replying to that message's own stored inbound sender, from the mailbox that
 * received it, with nothing else attached to the send. Every widening — a CC,
 * a reply-all, a second recipient, a recipient override or an attachment — is
 * refused here, before any Graph call. Graph's own reply draft is checked
 * against the same expected_to list in handleReply, so the message can only
 * leave if the stored record and the provider agree on the recipient.
 */
export function assertSenderOnlyReplyAllowed(
  body: Record<string, unknown>,
  source: { message_id: string; mailbox: string; sender: string },
) {
  const refuse = (fact: string, recovery_action: string): never => {
    throw new OutlookFenceError(409, {
      state: 'refused',
      code: 'reply_sender_only_required',
      fact,
      recovery_action,
      evidence: {
        message_id: source.message_id,
        mailbox: source.mailbox,
        stored_sender: source.sender || null,
      },
    })
  }

  const sender = source.sender.toLowerCase()
  if (!sender || !isEmail(sender)) {
    refuse(
      'The source message has no usable stored sender, so a reply with no job has no verified recipient.',
      'Link the message to a job and reply on the job-anchored path.',
    )
  }
  if (KNOWN_GROUP_ADDRESSES.has(sender)) {
    refuse(
      'The stored sender is a Microsoft 365 Group address, not an external correspondent.',
      'Answer group traffic through the supported Group action.',
    )
  }
  if (body.reply_all === true) {
    refuse(
      'A reply with no stored job cannot be a reply-all.',
      'Reply to the original sender only, or supply the job_id that owns this message.',
    )
  }
  for (const field of ['to', 'to_email', 'cc', 'bcc']) {
    if (hasOwn(body, field)) {
      refuse(
        `A native reply never accepts ${field}.`,
        'Remove the recipient override; provider reply routing is preserved.',
      )
    }
  }
  const expectedTo = splitRecipientInput(body.expected_to, 'expected_to', true)
  if (
    expectedTo.length !== 1 || expectedTo[0].trim().toLowerCase() !== sender
  ) {
    refuse(
      'A reply with no stored job may go only to the stored sender of that exact message.',
      'Set expected_to to exactly the stored sender of this message, or supply the job_id.',
    )
  }
  const expectedCc = splitRecipientInput(body.expected_cc, 'expected_cc')
  if (expectedCc.length > 0) {
    refuse(
      'A reply with no stored job cannot carry CC recipients.',
      'Remove every CC recipient, or supply the job_id that owns this message.',
    )
  }
  if (Array.isArray(body.attachments) ? body.attachments.length > 0 : Boolean(body.attachments)) {
    refuse(
      'A reply with no stored job cannot carry attachments; attachment provenance is expressed through the job.',
      'Send the attachment from the job-anchored path once the message is linked to a job.',
    )
  }
}

export async function assertOutlookSesDeliveryAllowed(
  client: any,
  body: Record<string, any>,
) {
  const recipients = Array.isArray(body.to) ? body.to : [body.to]
  const syntheticInboundFixture = body.sent_by === 'ses_synthetic_livefire_lab' &&
    String(body.from || '').toLowerCase() === 'marnin@secureworkswa.com.au' &&
    recipients.length === 1 &&
    String(recipients[0] || '').toLowerCase() === 'ses@secureworkswa.com.au' &&
    !body.action &&
    !body.job_id &&
    !body.xero_invoice_id
  if (syntheticInboundFixture) return

  const bodyJobId = String(body.job_id || '').trim()
  const bodyInvoiceId = String(body.xero_invoice_id || '').trim()

  if (body.action === 'reply') {
    const requestedMailbox = String(body.mailbox || '').trim()
    const mailboxMessageId = String(body.message_id || '').trim()
    // A job_id that is present but blank must refuse outright. Treating it as
    // absent would let a malformed anchor select the sender-only path, which
    // is the one path that does not run the stored-job fence.
    if (hasOwn(body, 'job_id') && body.job_id !== null && !bodyJobId) {
      throw new OutlookFenceError(409, {
        state: 'refused',
        code: 'pdf_provenance_required',
        fact: 'job_id was supplied but is blank, so no job anchor could be resolved.',
        recovery_action:
          'Send the exact job_id stored against this source message, or omit job_id entirely for a sender-only reply.',
        evidence: { message_id: mailboxMessageId || null },
      })
    }
    if (!requestedMailbox || !mailboxMessageId || body.post_id) {
      throw new OutlookFenceError(409, {
        state: 'refused',
        code: 'pdf_provenance_required',
        fact:
          'A native mailbox reply requires an exact mailbox and an authoritative source message before replying.',
        recovery_action:
          'Resolve the source message in the stored inbox record, then retry with those exact identities.',
      })
    }
    const source = await client.from('inbox_events')
      .select('job_id,mailbox,from_email')
      .eq('graph_message_id', mailboxMessageId)
      .maybeSingle()
    if (source.error) {
      throw new OutlookFenceError(
        503,
        sealedSesFenceCheckFailedRefusal(
          'reply_outlook_email',
          `The source-message job lookup failed (${source.error.message}).`,
          { message_id: mailboxMessageId },
        ),
      )
    }
    const sourceJobId = String(source.data?.job_id || '').trim()
    const sourceMailbox = String(source.data?.mailbox || '').trim()
    const sourceSender = String(source.data?.from_email || '').trim()
    // The mailbox that received the message is the only mailbox allowed to
    // answer it, on both the job-anchored and the sender-only path. An
    // unknown source message can never be replied to at all.
    if (
      !source.data || !sourceMailbox ||
      sourceMailbox.toLowerCase() !== requestedMailbox.toLowerCase()
    ) {
      throw new OutlookFenceError(409, {
        state: 'refused',
        code: 'pdf_provenance_required',
        fact:
          'The reply source message is not authoritatively stored against the requested mailbox.',
        recovery_action:
          'Reply only from the mailbox that received the message, using the stored source identity.',
        evidence: {
          message_id: mailboxMessageId,
          requested_mailbox: requestedMailbox,
          stored_mailbox: sourceMailbox || null,
        },
      })
    }
    if (bodyJobId) {
      if (!sourceJobId || sourceJobId !== bodyJobId) {
        throw new OutlookFenceError(409, {
          state: 'refused',
          code: 'pdf_provenance_required',
          fact:
            'The reply source message is not authoritatively linked to the supplied job_id.',
          recovery_action:
            'Use the source message and job identities stored together; never use a decoy job.',
          evidence: {
            message_id: mailboxMessageId,
            requested_mailbox: requestedMailbox,
            stored_mailbox: sourceMailbox,
            stored_job_id: sourceJobId || null,
            received_job_id: bodyJobId,
          },
        })
      }
      await assertOutlookJobAllowed(client, sourceJobId, 'reply_outlook_email')
      return
    }
    // No job supplied. This is only allowed for a message that genuinely has
    // no stored job, and only as a reply to that message's own stored sender.
    if (sourceJobId) {
      throw new OutlookFenceError(409, {
        state: 'refused',
        code: 'pdf_provenance_required',
        fact:
          'The reply source message has a stored job, so the reply must name that job_id.',
        recovery_action:
          'Retry with the job_id stored against this source message.',
        evidence: {
          message_id: mailboxMessageId,
          requested_mailbox: requestedMailbox,
          stored_job_id: sourceJobId,
          received_job_id: null,
        },
      })
    }
    assertSenderOnlyReplyAllowed(body, {
      message_id: mailboxMessageId,
      mailbox: requestedMailbox,
      sender: sourceSender,
    })
    return
  }

  if (body.action === 'forward') {
    const mailboxMessageId = String(body.message_id || '').trim()
    const groupPostId = String(body.post_id || '').trim()
    const requestedMailbox = String(body.mailbox || '').trim()
    const requestedGroup = String(body.group || '').trim()
    if (!bodyJobId || (!mailboxMessageId && !groupPostId)) {
      throw new OutlookFenceError(409, {
        state: 'refused',
        code: 'pdf_provenance_required',
        fact:
          'Graph forwarding preserves opaque attachments, so an authoritative source message and job_id are required before forwarding.',
        recovery_action:
          'Resolve the source message to its stored job, then retry with those exact identities.',
      })
    }
    const source = mailboxMessageId
      ? await client.from('inbox_events')
        .select('job_id,mailbox')
        .eq('graph_message_id', mailboxMessageId)
        .maybeSingle()
      : await client.from('makesafe_intake_drafts')
        .select('approved_job_id,mailbox')
        .eq('graph_message_id', groupPostId)
        .maybeSingle()
    if (source.error) {
      throw new OutlookFenceError(
        503,
        sealedSesFenceCheckFailedRefusal(
          'forward_outlook_email',
          `The source-message job lookup failed (${source.error.message}).`,
          {
            message_id: mailboxMessageId || null,
            post_id: groupPostId || null,
          },
        ),
      )
    }
    const sourceJobId = String(
      source.data?.job_id || source.data?.approved_job_id || '',
    ).trim()
    const sourceMailbox = String(source.data?.mailbox || '').trim()
    const requestedSource = mailboxMessageId ? requestedMailbox : requestedGroup
    if (
      !sourceJobId || sourceJobId !== bodyJobId ||
      !sourceMailbox || !requestedSource ||
      sourceMailbox.toLowerCase() !== requestedSource.toLowerCase()
    ) {
      throw new OutlookFenceError(409, {
        state: 'refused',
        code: 'pdf_provenance_required',
        fact: 'The forwarded source message is not authoritatively linked to the supplied job_id.',
        recovery_action:
          'Use the source message and job identities stored together; never use a decoy job.',
        evidence: {
          message_id: mailboxMessageId || null,
          post_id: groupPostId || null,
          requested_mailbox_or_group: requestedSource || null,
          stored_mailbox: sourceMailbox || null,
          stored_job_id: sourceJobId || null,
          received_job_id: bodyJobId,
        },
      })
    }
    await assertOutlookJobAllowed(client, sourceJobId, 'forward_outlook_email')
    return
  }

  let invoiceJobId: string | null = null
  if (bodyInvoiceId) {
    invoiceJobId = await resolveOutlookInvoiceJob(client, bodyInvoiceId)
  }
  if (bodyJobId) {
    if (invoiceJobId && invoiceJobId !== bodyJobId) {
      throw new OutlookFenceError(
        409,
        invoiceLinkRequiredRefusal(
          'send_outlook_email',
          {
            xero_invoice_id: bodyInvoiceId,
            expected_job_id: invoiceJobId,
            received_job_id: bodyJobId,
          },
        ),
      )
    }
    await assertOutlookJobAllowed(client, bodyJobId, 'send_outlook_email')
  }

  for (
    const attachment of Array.isArray(body.attachments) ? body.attachments : []
  ) {
    const contentBytes = String(attachment?.contentBytes || '').trim()
    const isPdf = String(attachment?.contentType || '').toLowerCase() ===
        'application/pdf' ||
      /\.pdf(?:$|[?#])/i.test(
        String(attachment?.name || attachment?.url || ''),
      ) ||
      contentBytes.startsWith('JVBERi0')
    if (!isPdf) continue

    const attachmentInvoiceId = String(
      attachment?.xero_invoice_id || bodyInvoiceId || '',
    ).trim()
    if (attachmentInvoiceId) {
      const attachmentJobId = attachmentInvoiceId === bodyInvoiceId
        ? invoiceJobId
        : await resolveOutlookInvoiceJob(client, attachmentInvoiceId)
      if (bodyJobId && attachmentJobId && bodyJobId !== attachmentJobId) {
        throw new OutlookFenceError(
          409,
          invoiceLinkRequiredRefusal(
            'send_outlook_email',
            {
              xero_invoice_id: attachmentInvoiceId,
              expected_job_id: attachmentJobId,
              received_job_id: bodyJobId,
            },
          ),
        )
      }
      continue
    }

    const jobDocumentId = String(
      attachment?.job_document_id || body.job_document_id || '',
    ).trim()
    if (jobDocumentId) {
      const document = await client.from('job_documents')
        .select('id,job_id')
        .eq('id', jobDocumentId)
        .maybeSingle()
      if (document.error || !document.data?.job_id) {
        throw new OutlookFenceError(
          document.error ? 503 : 409,
          sealedSesFenceCheckFailedRefusal(
            'send_outlook_email',
            document.error
              ? `The job document lookup failed (${document.error.message}).`
              : 'The job document is missing or has no job link.',
            { job_document_id: jobDocumentId },
          ),
        )
      }
      if (bodyJobId && bodyJobId !== document.data.job_id) {
        throw new OutlookFenceError(409, {
          state: 'refused',
          code: 'pdf_provenance_required',
          fact: 'The PDF job_document_id does not belong to the supplied job_id.',
          recovery_action: 'Use the document and job identities stored together.',
        })
      }
      await assertOutlookJobAllowed(
        client,
        document.data.job_id,
        'send_outlook_email',
      )
      continue
    }

    throw new OutlookFenceError(409, {
      state: 'refused',
      code: 'pdf_provenance_required',
      fact:
        'A PDF attachment requires an authoritative xero_invoice_id or job_document_id before Graph delivery.',
      recovery_action:
        'Attach the invoice or job-document identity that owns this PDF, then retry.',
    })
  }
}

// ── Graph OAuth2 Token ──

let _cachedToken: { token: string; expires: number } | null = null

function tokenExpiryClaim(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = encoded + '='.repeat((4 - encoded.length % 4) % 4)
    const claims = JSON.parse(atob(padded)) as { exp?: unknown }
    if (claims.exp === undefined) return null
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
      throw new Error('token exp claim is invalid')
    }
    return claims.exp * 1000
  } catch (error) {
    if (
      error instanceof Error && error.message === 'token exp claim is invalid'
    ) throw error
    return null
  }
}

function validateToken(
  data: Record<string, unknown>,
): { token: string; expires: number } {
  const token = typeof data.access_token === 'string' ? data.access_token.trim() : ''
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : Number(data.expires_in)
  if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(
      'Graph token response has no valid access_token/expires_in',
    )
  }
  const now = Date.now()
  const advertisedExpiry = now + expiresIn * 1000
  const claimedExpiry = tokenExpiryClaim(token)
  const expires = claimedExpiry === null
    ? advertisedExpiry
    : Math.min(advertisedExpiry, claimedExpiry)
  if (!Number.isFinite(expires) || expires <= now) {
    throw new Error('Graph token is already expired')
  }
  return { token, expires }
}

export function resetGraphTokenCache(): void {
  _cachedToken = null
}

export async function getGraphToken(options: {
  forceRefresh?: boolean
  fetchImpl?: FetchLike
} = {}): Promise<string> {
  const fetchImpl = options.fetchImpl || fetch
  if (
    !options.forceRefresh && _cachedToken &&
    _cachedToken.expires > Date.now() + 300000
  ) {
    return _cachedToken.token
  }

  const tenantId = Deno.env.get('MICROSOFT_TENANT_ID')
  const clientId = Deno.env.get('MICROSOFT_CLIENT_ID')
  const clientSecret = Deno.env.get('MICROSOFT_CLIENT_SECRET')

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET must be set',
    )
  }

  const resp = await fetchWithTimeout(
    fetchImpl,
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }),
    },
    GRAPH_TIMEOUT_MS,
  )

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Graph token request failed: ${resp.status} ${err}`)
  }

  _cachedToken = validateToken(await resp.json() as Record<string, unknown>)
  return _cachedToken.token
}

type GraphRequestOptions = {
  fetchImpl?: FetchLike
  timeoutMs?: number
  mutating?: boolean
}

function isMutationMethod(method: string | undefined): boolean {
  return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(
    (method || 'GET').toUpperCase(),
  )
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function graphRequest(
  path: string,
  init: RequestInit = {},
  options: GraphRequestOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = options.timeoutMs || GRAPH_TIMEOUT_MS
  const mutating = options.mutating ?? isMutationMethod(init.method)
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`
  const body = init.body
  let token = await getGraphToken({ fetchImpl })
  const request = () =>
    fetchWithTimeout(fetchImpl, url, {
      ...init,
      body,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    }, timeoutMs)

  let response: Response
  try {
    response = await request()
  } catch (error) {
    throw new GraphProviderError(
      0,
      `Graph request failed: ${(error as Error).message}`,
      mutating,
    )
  }

  if (response.status === 401) {
    let refreshedToken: string
    try {
      refreshedToken = await getGraphToken({ forceRefresh: true, fetchImpl })
    } catch (error) {
      throw new GraphProviderError(
        401,
        `Graph request was rejected and token refresh failed: ${(error as Error).message}`,
        false,
        { token_refreshed: false, retry_safe: false },
      )
    }
    if (mutating) {
      // A 401 may arrive after Graph accepted a mutation. Refresh the cache for
      // a later read/reconciliation, but never replay the business write.
      throw new GraphProviderError(
        401,
        'Graph rejected a mutating request after token refresh; the request was not replayed',
        false,
        { token_refreshed: true, retry_safe: false },
      )
    }
    token = refreshedToken
    try {
      response = await request()
    } catch (error) {
      throw new GraphProviderError(
        0,
        `Graph refresh request failed: ${(error as Error).message}`,
        mutating,
      )
    }
  }

  if (!response.ok) {
    const detail = (await response.clone().text()).slice(0, 2000)
    const unknown = mutating &&
      (response.status >= 500 || response.status === 408 ||
        response.status === 429)
    throw new GraphProviderError(
      response.status,
      `Graph request failed: ${response.status}${detail ? ` ${detail}` : ''}`,
      unknown,
      unknown ? { retry_safe: false } : {},
    )
  }
  return response
}

// ── Download + Base64 encode attachment from URL ──

type GraphFileAttachment = {
  '@odata.type': string
  name: string
  contentType: string
  contentBytes: string
}

function allowedAttachmentHost(
  hostname: string,
  extraHosts: string[] = [],
): boolean {
  const host = hostname.toLowerCase()
  let supabaseHost = ''
  try {
    supabaseHost = new URL(SUPABASE_URL || '').hostname.toLowerCase()
  } catch (_) {
    // Test and local environments may not define SUPABASE_URL.
  }
  if (supabaseHost && host === supabaseHost) return true
  return extraHosts.map((item) => item.toLowerCase()).includes(host)
}

async function readAttachmentBytes(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length') || '')
  if (
    Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES
  ) {
    throw new OutlookInputError(
      'attachment_too_large',
      `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
    )
  }
  if (!response.body) {
    throw new OutlookInputError(
      'attachment_invalid_response',
      'Attachment response did not expose a bounded body stream',
    )
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value)
      total += chunk.length
      if (total > MAX_ATTACHMENT_BYTES) {
        await reader.cancel()
        throw new OutlookInputError(
          'attachment_too_large',
          `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
        )
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let start = 0; start < bytes.length; start += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(start, Math.min(start + chunkSize, bytes.length)),
    )
  }
  return btoa(binary)
}

export async function fetchAttachment(url: string, name: string, options: {
  fetchImpl?: FetchLike
  timeoutMs?: number
  allowedHosts?: string[]
} = {}): Promise<GraphFileAttachment> {
  if (typeof url !== 'string' || !url.trim()) {
    throw new OutlookInputError(
      'invalid_attachment',
      'Attachment URL is required',
    )
  }
  if (typeof name !== 'string' || !name.trim()) {
    throw new OutlookInputError(
      'invalid_attachment',
      'Attachment name is required',
    )
  }
  const fetchImpl = options.fetchImpl || fetch
  const allowedHosts = [
    ...(options.allowedHosts || []),
    ...(Deno.env.get('OUTLOOK_ATTACHMENT_HOSTS') || '').split(',').map((item) => item.trim())
      .filter(Boolean),
  ]
  let current = url.trim()
  for (let redirect = 0; redirect <= MAX_ATTACHMENT_REDIRECTS; redirect++) {
    const parsed = new URL(current)
    if (
      parsed.protocol !== 'https:' ||
      !allowedAttachmentHost(parsed.hostname, allowedHosts)
    ) {
      throw new OutlookInputError(
        'attachment_source_not_allowed',
        'Attachment URL must use approved HTTPS storage',
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs || GRAPH_TIMEOUT_MS,
    )
    let resp: Response
    try {
      resp = await fetchImpl(current, {
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (error) {
      throw new OutlookInputError(
        'attachment_download_failed',
        `Failed to download attachment: ${(error as Error).message}`,
      )
    } finally {
      clearTimeout(timer)
    }
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location')
      if (!location || redirect === MAX_ATTACHMENT_REDIRECTS) {
        throw new OutlookInputError(
          'attachment_redirect_limit',
          'Attachment redirect limit exceeded',
        )
      }
      current = new URL(location, current).toString()
      continue
    }
    if (!resp.ok) {
      throw new OutlookInputError(
        'attachment_download_failed',
        `Failed to download attachment (${resp.status})`,
      )
    }
    const bytes = await readAttachmentBytes(resp)
    const ext = name.split('.').pop()?.toLowerCase() || ''
    const contentTypes: Record<string, string> = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      csv: 'text/csv',
    }
    return {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: name.trim(),
      contentType: contentTypes[ext] || 'application/octet-stream',
      contentBytes: encodeBase64(bytes),
    }
  }
  throw new OutlookInputError(
    'attachment_redirect_limit',
    'Attachment redirect limit exceeded',
  )
}

export function validateInlineAttachment(
  att: Record<string, unknown>,
): GraphFileAttachment {
  if (typeof att.name !== 'string' || !att.name.trim()) {
    throw new OutlookInputError(
      'invalid_attachment',
      'Attachment name is required',
    )
  }
  if (typeof att.contentBytes !== 'string' || !att.contentBytes.trim()) {
    throw new OutlookInputError(
      'invalid_attachment',
      `Attachment ${att.name} has no contentBytes`,
    )
  }
  const contentBytes = att.contentBytes.trim()
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBytes) ||
    contentBytes.length % 4 !== 0
  ) {
    throw new OutlookInputError(
      'invalid_attachment',
      `Attachment ${att.name} has invalid base64 content`,
    )
  }
  let decoded: string
  try {
    decoded = atob(contentBytes)
  } catch (_) {
    throw new OutlookInputError(
      'invalid_attachment',
      `Attachment ${att.name} has invalid base64 content`,
    )
  }
  if (decoded.length > MAX_ATTACHMENT_BYTES) {
    throw new OutlookInputError(
      'attachment_too_large',
      `Attachment ${att.name} exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
    )
  }
  const contentType = typeof att.contentType === 'string' && att.contentType.trim()
    ? att.contentType.trim()
    : 'application/octet-stream'
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: att.name.trim(),
    contentType,
    contentBytes,
  }
}

export async function prepareAttachments(attachments: unknown, options: {
  fetchImpl?: FetchLike
  timeoutMs?: number
  allowedHosts?: string[]
} = {}): Promise<GraphFileAttachment[]> {
  if (attachments === undefined || attachments === null) return []
  if (!Array.isArray(attachments)) {
    throw new OutlookInputError(
      'invalid_attachment',
      'attachments must be an array',
    )
  }
  const result: GraphFileAttachment[] = []
  let encodedTotal = 0
  for (const raw of attachments) {
    if (!raw || typeof raw !== 'object') {
      throw new OutlookInputError(
        'invalid_attachment',
        'Every attachment must be an object',
      )
    }
    const att = raw as Record<string, unknown>
    let prepared: GraphFileAttachment
    if (att.url !== undefined) {
      if (
        typeof att.url !== 'string' || typeof att.name !== 'string' ||
        !att.name.trim()
      ) {
        throw new OutlookInputError(
          'invalid_attachment',
          'URL attachments require url and name',
        )
      }
      prepared = await fetchAttachment(att.url, att.name, options)
    } else {
      prepared = validateInlineAttachment(att)
    }
    encodedTotal += prepared.contentBytes.length
    if (encodedTotal > MAX_MESSAGE_BYTES) {
      throw new OutlookInputError(
        'message_too_large',
        'Encoded attachments exceed message limit',
      )
    }
    result.push(prepared)
  }
  return result
}

// ── Dynamic Signature Selection ──


// ── Group resolution (M365 Group email -> group ID) ──

const _groupIdCache = new Map<string, string>()

// A caller-supplied address is not enough to select the Graph /users route:
// several directory objects have mail addresses. This read proves that the
// exact target exposes an Exchange mailbox before any provider mutation.
export async function verifyMailboxRoute(mailbox: string): Promise<void> {
  if (!isEmail(mailbox)) {
    throw new OutlookInputError(
      'invalid_source',
      'mailbox must be a valid mailbox address',
    )
  }
  await graphRequest(
    `/users/${safeSegment(mailbox, 'mailbox')}/mailFolders/inbox?$select=id`,
    {},
    { mutating: false },
  )
}

async function resolveGroupId(groupEmail: string): Promise<string> {
  if (!isEmail(groupEmail)) {
    throw new OutlookInputError(
      'invalid_source',
      'group must be a valid group email',
    )
  }
  const cacheKey = groupEmail.toLowerCase()
  const cached = _groupIdCache.get(cacheKey)
  if (cached) return cached

  const resp = await graphRequest(
    `/groups?$filter=${encodeURIComponent(`mail eq '${groupEmail}'`)}&$select=id,mail&$top=2`,
  )
  const data = await resp.json()
  const groups = data.value || []
  if (groups.length === 0) {
    throw new Error(`No M365 Group found for email: ${groupEmail}`)
  }
  if (groups.length > 1) {
    throw new OutlookInputError(
      'ambiguous_source',
      `More than one M365 Group found for email: ${groupEmail}`,
    )
  }

  const groupId = nonEmptyString(groups[0].id, 'group id')
  _groupIdCache.set(cacheKey, groupId)
  return groupId
}

// ── Forward Handler ──
//
// Two source shapes, matching the two mailbox types this system reads from:
//
//  1. Regular user mailbox message (mailbox + message_id):
//     createForward -> optional PATCH ccRecipients -> send. Full fidelity —
//     Graph auto-carries the original body + attachments into the draft, and
//     this path supports cc (a plain `forward` action does not).
//
//  2. M365 Group conversation post (group + thread_id + post_id):
//     Groups don't expose createForward on posts, so this uses the direct
//     `forward` action instead. Graph still auto-carries body + attachments,
//     but there is no cc step for this path — fold any cc addresses into
//     `to` when forwarding from a group.
//
const AUDIT_WARNINGS = [
  'provider_accepted_delivery_unproven',
  'audit_persistence_best_effort',
  'dedupe_or_exact_once_not_available',
]
const DRAFT_WARNINGS = [
  'draft_not_sent',
  'audit_persistence_best_effort',
  'draft_deduplication_unavailable',
]

function safeSegment(value: unknown, field: string): string {
  return encodeURIComponent(nonEmptyString(value, field))
}

function acceptedResponse(
  data: Record<string, unknown>,
  outcome = 'accepted_not_delivered',
  warnings = AUDIT_WARNINGS,
): Response {
  return json({
    ...data,
    accepted: true,
    delivered: null,
    delivery_status: 'unverified',
    outcome,
    retry_safe: false,
    audit_warnings: warnings,
  }, 202)
}

async function sendDraftById(mailbox: string, draftId: string): Promise<void> {
  await graphRequest(
    `/users/${safeSegment(mailbox, 'mailbox')}/messages/${safeSegment(draftId, 'draft_id')}/send`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    { mutating: true },
  )
}

async function addDraftAttachments(
  mailbox: string,
  draftId: string,
  attachments: GraphFileAttachment[],
): Promise<void> {
  // Graph's message attachment endpoint accepts each direct file attachment
  // below 3 MiB. Validate all bytes before createReply/createReplyAll, then
  // add them one by one to the already-created native draft.
  for (const attachment of attachments) {
    await graphRequest(
      `/users/${safeSegment(mailbox, 'mailbox')}/messages/${safeSegment(draftId, 'draft_id')}/attachments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attachment),
      },
      { mutating: true },
    )
  }
}

function messageContent(
  body: Record<string, unknown>,
  mailbox: string,
): Record<string, unknown> {
  const htmlBody = nonEmptyString(body.htmlBody, 'htmlBody')
  const subject = nonEmptyString(body.subject, 'subject')
  const to = splitRecipientInput(body.to, 'to', true)
  const cc = splitRecipientInput(body.cc, 'cc')
  const bcc = splitRecipientInput(body.bcc, 'bcc')
  const message: Record<string, unknown> = {
    subject,
    body: {
      contentType: 'HTML',
      content: outlookMessageHtmlBody(htmlBody, mailbox),
    },
    toRecipients: to.map((email) => ({ emailAddress: { address: email } })),
  }
  if (cc.length) {
    message.ccRecipients = cc.map((email) => ({
      emailAddress: { address: email },
    }))
  }
  if (bcc.length) {
    message.bccRecipients = bcc.map((email) => ({
      emailAddress: { address: email },
    }))
  }
  return message
}

async function handleForward(body: Record<string, unknown>): Promise<Response> {
  const to = splitRecipientInput(body.to_email, 'to_email', true)
  const cc = splitRecipientInput(body.cc, 'cc')
  const toRecipients = to.map((email) => ({
    emailAddress: { address: email },
  }))
  const hasGroupFields = ['group', 'thread_id', 'post_id'].some((field) => hasOwn(body, field))
  const hasMailboxFields = ['mailbox', 'message_id'].some((field) => hasOwn(body, field))
  if (hasGroupFields && hasMailboxFields) {
    throw new OutlookInputError(
      'invalid_source',
      'Forward source must be either a mailbox message or a group post',
    )
  }
  const comment = typeof body.comment === 'string' ? body.comment : ''
  const jobId = typeof body.job_id === 'string' ? body.job_id : null
  let sourceType: 'mailbox' | 'group'
  let subject = '(forwarded email)'
  let fromAddress: string
  let messageId: string | null = null
  let postId: string | null = null

  if (hasGroupFields) {
    const group = nonEmptyString(body.group, 'group')
    const threadId = nonEmptyString(body.thread_id, 'thread_id')
    postId = nonEmptyString(body.post_id, 'post_id')
    sourceType = 'group'
    fromAddress = group
    const allRecipients = [
      ...toRecipients,
      ...cc.map((email) => ({ emailAddress: { address: email } })),
    ]
    const groupId = await resolveGroupId(group)
    await graphRequest(
      `/groups/${safeSegment(groupId, 'group id')}/threads/${
        safeSegment(threadId, 'thread_id')
      }/posts/${safeSegment(postId, 'post_id')}/forward`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment, toRecipients: allRecipients }),
      },
      { mutating: true },
    )
  } else {
    messageId = nonEmptyString(body.message_id, 'message_id')
    const mailbox = nonEmptyString(body.mailbox, 'mailbox')
    sourceType = 'mailbox'
    fromAddress = mailbox
    const createResp = await graphRequest(
      `/users/${safeSegment(mailbox, 'mailbox')}/messages/${
        safeSegment(messageId, 'message_id')
      }/createForward`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toRecipients, comment }),
      },
      { mutating: true },
    )
    let draft: Record<string, unknown>
    try {
      draft = await createResp.json() as Record<string, unknown>
    } catch (error) {
      throw new GraphProviderError(
        0,
        `Forward draft response could not be decoded: ${(error as Error).message}`,
        true,
      )
    }
    let draftId: string
    try {
      draftId = nonEmptyString(draft.id, 'draft_id')
    } catch (error) {
      throw new GraphProviderError(
        0,
        `Forward draft response had no draft_id: ${(error as Error).message}`,
        true,
      )
    }
    try {
      subject = typeof draft.subject === 'string' && draft.subject ? draft.subject : subject
      if (cc.length) {
        await graphRequest(
          `/users/${safeSegment(mailbox, 'mailbox')}/messages/${safeSegment(draftId, 'draft_id')}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ccRecipients: cc.map((email) => ({
                emailAddress: { address: email },
              })),
            }),
          },
          { mutating: true },
        )
      }
      await sendDraftById(mailbox, draftId)
    } catch (error) {
      if (error instanceof GraphProviderError) {
        throw new GraphProviderError(error.status, error.message, true, {
          draft_id: draftId,
        })
      }
      throw new GraphProviderError(
        0,
        `Forward draft ${draftId} was created but not sent: ${(error as Error).message}`,
        true,
        { draft_id: draftId },
      )
    }
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const toStr = [...to, ...cc].join(', ')
  if (jobId) {
    Promise.resolve(
      sb.from('po_communications').insert({
        job_id: jobId,
        direction: 'outbound',
        from_email: fromAddress,
        to_email: toStr,
        cc_emails: cc.length ? cc : null,
        subject,
        body_html: comment,
        communication_type: 'internal_forward',
        sent_at: new Date().toISOString(),
        created_by: body.sent_by || null,
      }),
    ).catch((e: any) => console.log('[send-outlook-email] po_comms log failed:', e?.message))
  }
  Promise.resolve(
    sb.from('email_events').insert({
      email_type: 'forward',
      entity_type: jobId ? 'job' : 'message',
      entity_id: jobId || messageId || postId,
      job_id: jobId,
      recipient: to[0],
      sender: fromAddress,
      subject,
      status: 'accepted',
      sent_at: new Date().toISOString(),
    }),
  ).catch(() => {})
  const warnings = sourceType === 'group'
    ? [...AUDIT_WARNINGS, 'group_requested_source_actual_sender_unverified']
    : AUDIT_WARNINGS
  return acceptedResponse(
    {
      success: true,
      action: 'forward',
      sourceType,
      from: fromAddress,
      ...(sourceType === 'group' ? { requested_source: fromAddress, actual_sender: null } : {}),
      to,
      cc,
      subject,
    },
    'accepted_not_delivered',
    warnings,
  )
}

export async function handleReply(
  body: Record<string, unknown>,
): Promise<Response> {
  assertNoLegacyReplyFields(body)
  if (body.content_reviewed !== true) {
    throw new OutlookInputError(
      'review_required',
      'Reply requires content_reviewed:true',
    )
  }
  if (hasOwn(body, 'to') || hasOwn(body, 'cc') || hasOwn(body, 'bcc')) {
    throw new OutlookInputError(
      'reply_recipient_override',
      'Native replies preserve provider recipients; recipient overrides are not accepted',
    )
  }
  if (body.reply_all !== undefined && typeof body.reply_all !== 'boolean') {
    throw new OutlookInputError('invalid_source', 'reply_all must be boolean')
  }
  const mailbox = nonEmptyString(body.mailbox, 'mailbox')
  const messageId = nonEmptyString(body.message_id, 'message_id')
  const htmlBody = nonEmptyString(body.htmlBody, 'htmlBody')
  if (!Array.isArray(body.expected_to) || !Array.isArray(body.expected_cc)) {
    throw new OutlookInputError(
      'reply_recipients_required',
      'Native replies require explicit expected_to and expected_cc recipient lists',
    )
  }
  const expectedTo = splitRecipientInput(body.expected_to, 'expected_to', true)
  const expectedCc = splitRecipientInput(body.expected_cc, 'expected_cc')
  const attachments = await prepareAttachments(body.attachments)
  const endpoint = body.reply_all ? 'createReplyAll' : 'createReply'
  const createResp = await graphRequest(
    `/users/${safeSegment(mailbox, 'mailbox')}/messages/${
      safeSegment(messageId, 'message_id')
    }/${endpoint}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Do not provide to/cc/bcc/replyTo: Graph carries the original provider
      // recipients and reply metadata into this native draft.
      body: JSON.stringify({
        message: {
          body: {
            contentType: 'HTML',
            content: htmlBody +
              (/<!--\s*suppress-auto-appended-default-signature\s*-->/i.test(
                  htmlBody,
                )
                ? ''
                : getSignature(mailbox)),
          },
        },
      }),
    },
    { mutating: true },
  )
  let draft: Record<string, unknown>
  try {
    draft = await createResp.json() as Record<string, unknown>
  } catch (error) {
    throw new GraphProviderError(
      0,
      `Reply draft response could not be decoded: ${(error as Error).message}`,
      true,
    )
  }
  let draftId: string
  try {
    draftId = nonEmptyString(draft.id, 'draft_id')
  } catch (error) {
    throw new GraphProviderError(
      0,
      `Reply draft response had no draft_id: ${(error as Error).message}`,
      true,
    )
  }
  try {
    const addresses = (value: unknown): string[] => {
      if (!Array.isArray(value)) return []
      return value.map((entry) =>
        String(
          (entry as Record<string, unknown>)?.emailAddress &&
              ((entry as Record<string, any>).emailAddress as Record<
                string,
                unknown
              >).address || '',
        ).trim().toLowerCase()
      ).filter(Boolean)
    }
    const actualTo = addresses(draft.toRecipients)
    const actualCc = addresses(draft.ccRecipients)
    const sameRecipients = (left: string[], right: string[]) => {
      const a = [...left].sort()
      const b = [...right].sort()
      return a.length === b.length &&
        a.every((address, index) => address === b[index])
    }
    if (
      !sameRecipients(
        actualTo,
        expectedTo.map((address) => address.toLowerCase()),
      ) ||
      !sameRecipients(
        actualCc,
        expectedCc.map((address) => address.toLowerCase()),
      )
    ) {
      throw new OutlookInputError(
        'reply_recipient_mismatch',
        'Graph reply draft recipients did not match the reviewed expected recipients',
      )
    }
    if (attachments.length) {
      await addDraftAttachments(mailbox, draftId, attachments)
    }
    await sendDraftById(mailbox, draftId)
  } catch (error) {
    if (error instanceof GraphProviderError) {
      throw new GraphProviderError(error.status, error.message, true, {
        draft_id: draftId,
      })
    }
    throw new GraphProviderError(
      0,
      `Reply draft ${draftId} was created but not sent: ${(error as Error).message}`,
      true,
      { draft_id: draftId },
    )
  }
  return acceptedResponse({
    success: true,
    action: 'reply',
    mailbox,
    message_id: messageId,
    draft_id: draftId,
    reply_all: Boolean(body.reply_all),
    attachments: attachments.length,
  })
}

export async function handleDraft(
  body: Record<string, unknown>,
): Promise<Response> {
  if (body.content_reviewed !== true) {
    throw new OutlookInputError(
      'review_required',
      'Draft creation requires content_reviewed:true',
    )
  }
  const route = classifyOutlookRoute(body)
  if (route.kind !== 'mailbox') {
    throw new OutlookInputError(
      'group_route_required',
      'Drafts require an exact mailbox; group sources are not supported',
    )
  }
  const message = messageContent(body, route.mailbox)
  const attachments = await prepareAttachments(body.attachments)
  if (attachments.length) message.attachments = attachments
  const response = await graphRequest(
    `/users/${safeSegment(route.mailbox, 'mailbox')}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    },
    { mutating: true },
  )
  let draft: Record<string, unknown>
  try {
    draft = await response.json() as Record<string, unknown>
  } catch (error) {
    throw new GraphProviderError(
      0,
      `Graph draft response could not be decoded: ${(error as Error).message}`,
      true,
    )
  }
  let draftId: string
  try {
    draftId = nonEmptyString(draft.id, 'draft_id')
  } catch (error) {
    throw new GraphProviderError(
      0,
      `Graph draft response had no draft_id: ${(error as Error).message}`,
      true,
    )
  }
  const changeKey = typeof draft.changeKey === 'string' ? draft.changeKey : null
  return acceptedResponse(
    {
      success: true,
      action: 'draft',
      mailbox: route.mailbox,
      draft_id: draftId,
      changeKey,
      change_key: changeKey,
      attachments: attachments.length,
      sent: false,
      isDraft: true,
    },
    'draft_created_not_sent',
    DRAFT_WARNINGS,
  )
}

// ── Main Handler ──

export async function handleOutlookRequest(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

    // Auth — same pattern as ghl-proxy
    const validKey = Deno.env.get('SW_API_KEY')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const xApiKey = req.headers.get('x-api-key')
    const authHeader = req.headers.get('authorization')
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    const suppliedCredential = xApiKey || bearerToken
    const opsAgentKey = Deno.env.get('OPS_AGENT_SERVER_KEY')

    if (xApiKey && bearerToken && xApiKey !== bearerToken) {
      return json({ error: 'Conflicting credentials' }, 401)
    }
    const opsAuthorized = Boolean(
      suppliedCredential && (
        (serviceKey && serviceKey !== validKey && suppliedCredential === serviceKey) ||
        (opsAgentKey && opsAgentKey !== validKey &&
          suppliedCredential === opsAgentKey)
      ),
    )
    const isAuthed = opsAuthorized || Boolean(validKey && suppliedCredential === validKey)
    if (!isAuthed) return json({ error: 'Unauthorized' }, 401)

    if (req.method === 'GET') {
      const action = new URL(req.url).searchParams.get('action')
      if (action === 'outlook_capabilities') {
        if (!opsAuthorized) {
          return json({ error: 'Operations credential required' }, 401)
        }
        // The MCP client pins this string exactly, so changing it makes every
        // Outlook action refuse until both sides deploy together. The
        // sender-only reply path was added without a bump for that reason:
        // deploy this function first, then the MCP server.
        return json({
          contract_version: '2026-09-09.1',
          actions: ['send', 'forward', 'reply', 'draft'],
          new_group_send: false,
        })
      }
      return json({ error: 'Unsupported capability query' }, 400)
    }
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

    try {
      const body = await req.json() as Record<string, unknown>
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new OutlookInputError(
          'invalid_request',
          'Request body must be an object',
        )
      }
      if (
        (body.action === 'reply' || body.action === 'draft') && !opsAuthorized
      ) {
        return json(
          { error: 'Operations credential required for this action' },
          401,
        )
      }
      // Classify before any provider call so a group sender can never fall
      // through to /users/{id}/sendMail.
      const route = classifyOutlookRoute(body)
      if (body.action === 'send_draft') {
        throw new OutlookInputError(
          'draft_send_requires_review',
          'Draft sending requires a reviewed action-specific workflow',
        )
      }
      if (
        body.action !== 'forward' && body.action !== 'reply' &&
        body.action !== 'draft' && body.action !== undefined
      ) {
        throw new OutlookInputError(
          'invalid_action',
          'Unsupported Outlook action',
        )
      }
      if (body.action !== 'reply') assertNoLegacyReplyFields(body)
      if (body.action !== 'forward' && route.kind === 'group') {
        throw new OutlookInputError(
          'group_route_required',
          'Group senders require the explicit group forward action',
        )
      }
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      await assertOutlookSesDeliveryAllowed(sb, body)
      if (route.kind === 'mailbox') await verifyMailboxRoute(route.mailbox)

      // ── Forward action — genuine Graph forward, preserves original body + attachments ──
      if (body.action === 'forward') {
        return await handleForward(body)
      }
      if (body.action === 'reply') return await handleReply(body)
      if (body.action === 'draft') return await handleDraft(body)

      const from = route.kind === 'mailbox' ? route.mailbox : OUTLOOK_DEFAULT_MAILBOX
      const to = splitRecipientInput(body.to, 'to', true)
      const cc = splitRecipientInput(body.cc, 'cc')
      const bcc = splitRecipientInput(body.bcc, 'bcc')
      const subject = nonEmptyString(body.subject, 'subject')
      const htmlBody = nonEmptyString(body.htmlBody, 'htmlBody')
      const message = messageContent({
        ...body,
        to,
        cc,
        bcc,
        subject,
        htmlBody,
      }, from)
      const graphAttachments = await prepareAttachments(body.attachments)
      if (graphAttachments.length) message.attachments = graphAttachments
      await graphRequest(`/users/${safeSegment(from, 'from')}/sendMail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, saveToSentItems: true }),
      }, { mutating: true })

      const toStr = to.join(', ')
      if (body.job_id) {
        Promise.resolve(
          sb.from('po_communications').insert({
            job_id: body.job_id,
            direction: 'outbound',
            from_email: from,
            to_email: toStr,
            cc_emails: cc.length ? cc : null,
            subject,
            body_html: htmlBody,
            communication_type: 'client',
            sent_at: new Date().toISOString(),
            created_by: body.sent_by || null,
          }),
        ).catch((e: any) => console.log('[send-outlook-email] po_comms log failed:', e?.message))
      }
      Promise.resolve(
        sb.from('email_events').insert({
          email_type: 'client_email',
          entity_type: body.job_id ? 'job' : 'contact',
          entity_id: body.job_id || body.ghl_contact_id || toStr,
          job_id: body.job_id || null,
          recipient: to[0],
          sender: from,
          subject,
          status: 'accepted',
          sent_at: new Date().toISOString(),
        }),
      ).catch(() => {})
      if (body.ghl_contact_id) {
        fetch(`${SUPABASE_URL}/functions/v1/ghl-proxy?action=add_note`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          },
          body: JSON.stringify({
            contactId: body.ghl_contact_id,
            body: `Email accepted: "${subject}" to ${toStr}`,
          }),
        }).catch(() => {})
      }
      return acceptedResponse({
        success: true,
        from,
        to,
        cc,
        bcc,
        subject,
        attachments: graphAttachments.length,
      })
    } catch (err) {
      if (err instanceof OutlookFenceError) {
        return json(err.refusal, err.status)
      }
      if (err instanceof OutlookInputError) {
        return json(
          { error: err.message, code: err.code, retry_safe: true },
          400,
        )
      }
      if (err instanceof GraphProviderError) {
        if (err.outcomeUnknown) {
          return json({
            state: 'outcome_unknown',
            code: 'provider_outcome_unknown',
            error: err.message,
            retry_safe: false,
            ...err.context,
          }, 502)
        }
        return json({
          ...err.context,
          error: 'Graph API error',
          status: err.status || 502,
          detail: err.message,
          retry_safe: typeof err.context.retry_safe === 'boolean'
            ? err.context.retry_safe
            : true,
        }, 502)
      }
      console.error('[send-outlook-email] Error:', (err as Error).message)
      return json({ error: (err as Error).message, retry_safe: true }, 500)
    }
}

if (import.meta.main) serve(handleOutlookRequest)
