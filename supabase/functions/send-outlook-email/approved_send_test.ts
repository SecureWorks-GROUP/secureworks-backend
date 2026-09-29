// Approved email through a fake Graph. No real provider is ever called.
// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { ApprovedSendRefusal, recordApproval } from '../_shared/approved_send.ts'
import {
  emailApprovalBody,
  makeDeps,
  RECORDER,
} from '../_shared/approved_send_test_fakes.ts'
import { type GraphCall, sendApprovedEmail } from './approved_send_email.ts'
import {
  GraphProviderError,
  handleApprovedEmailRequest,
  handleOutlookRequest,
} from './index.ts'

const DOC_ID = '11111111-1111-4111-8111-111111111111'
const CALLER = { actor: 'seat:rayleigh', credentialClass: 'ops_agent_server_key' }

type GraphCallRecord = { path: string; method: string; body: any }

function fakeGraph(options: {
  dropCcOnPatch?: boolean
  failAt?: { match: (path: string, method: string) => boolean; error: Error }
} = {}): { graph: GraphCall; calls: GraphCallRecord[] } {
  const calls: GraphCallRecord[] = []
  let draft: Record<string, unknown> = {}
  const graph: GraphCall = (path, init = {}) => {
    const method = String(init.method || 'GET')
    const body = init.body ? JSON.parse(String(init.body)) : null
    calls.push({ path, method, body })
    if (options.failAt?.match(path, method)) return Promise.reject(options.failAt.error)
    const ok = (value: unknown) =>
      Promise.resolve(new Response(JSON.stringify(value), { status: 200 }))
    if (path.endsWith('/createReply') && method === 'POST') {
      draft = {
        id: 'draft-reply-1',
        internetMessageId: '<reply-1@secureworks>',
        subject: 'RE: Fence at 12 Example St',
        // Graph's own reply draft addresses only the original sender.
        toRecipients: [{ emailAddress: { address: 'ambrose@example.com' } }],
        ccRecipients: [],
        bccRecipients: [],
      }
      return ok(draft)
    }
    if (method === 'PATCH') {
      draft = {
        ...draft,
        subject: body.subject,
        toRecipients: body.toRecipients,
        ccRecipients: options.dropCcOnPatch ? [] : body.ccRecipients,
        bccRecipients: body.bccRecipients,
      }
      return ok(draft)
    }
    if (path.endsWith('/messages') && method === 'POST') {
      draft = { id: 'draft-new-1', internetMessageId: '<new-1@secureworks>', ...body }
      return ok(draft)
    }
    if (path.endsWith('/attachments') || path.endsWith('/send') || method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 202 }))
    }
    return Promise.reject(new Error(`unexpected Graph call ${method} ${path}`))
  }
  return { graph, calls }
}

async function recordEmail(
  deps: ReturnType<typeof makeDeps>,
  body = emailApprovalBody(),
): Promise<string> {
  const preview = await recordApproval(deps, RECORDER, body)
  const live = await recordApproval(deps, RECORDER, {
    ...body,
    dry_run: false,
    expected_payload_hash: preview.payload_hash,
  })
  return live.approval_id!
}

function emailDeps(graph: GraphCall, verifyMailbox = () => Promise.resolve()) {
  const deps = makeDeps()
  deps.files.put({ source: 'job_document', id: DOC_ID }, '%PDF-1.7 revised quote', 'Quote-v2.pdf')
  return { ...deps, graph, verifyMailbox }
}

Deno.test('an approved reply with no job carries CC and an attachment in the thread', async () => {
  const provider = fakeGraph()
  const deps = emailDeps(provider.graph)
  const id = await recordEmail(deps)
  const result = await sendApprovedEmail(deps, id, CALLER)
  assertEquals(result.status, 202)
  assertEquals(result.body.state, 'sent')
  assertEquals(result.body.cc, ['shaun@secureworkswa.com.au'])

  const steps = provider.calls.map((call) => `${call.method} ${call.path}`)
  assertEquals(steps, [
    'POST /users/marnin%40secureworkswa.com.au/messages/AAMkAGI-source-message/createReply',
    'PATCH /users/marnin%40secureworkswa.com.au/messages/draft-reply-1',
    'POST /users/marnin%40secureworkswa.com.au/messages/draft-reply-1/attachments',
    'POST /users/marnin%40secureworkswa.com.au/messages/draft-reply-1/send',
  ])
  assertEquals(provider.calls[0].body.message.body.content, '<p>Hi Ambrose, the revised quote is attached.</p>')
  assertEquals(provider.calls[1].body.ccRecipients, [{ emailAddress: { address: 'shaun@secureworkswa.com.au' } }])
  assertEquals(provider.calls[1].body.subject, 'RE: Fence at 12 Example St')
  const attachment = provider.calls[2].body
  assertEquals(attachment.name, 'Quote-v2.pdf')
  assertEquals(atob(attachment.contentBytes), '%PDF-1.7 revised quote')

  const row = deps.store.rows.get(id)!
  assertEquals(row.status, 'sent')
  assertEquals(row.provider_message_id, '<reply-1@secureworks>')
  assertEquals(deps.store.events(id), ['recorded', 'claimed', 'sent'])
})

Deno.test('an approved new email goes to any recipient with CC and BCC exactly', async () => {
  const provider = fakeGraph()
  const deps = emailDeps(provider.graph)
  const body = emailApprovalBody({
    email: {
      mailbox: 'admin@secureworkswa.com.au',
      mode: 'new',
      to: ['someone.new@example.org'],
      cc: ['shaun@secureworkswa.com.au'],
      bcc: ['records@secureworkswa.com.au'],
      subject: 'Your fence quote',
      html_body: '<p>Exact approved words.</p>',
      attachments: [],
    },
  })
  const id = await recordEmail(deps, body)
  const result = await sendApprovedEmail(deps, id, CALLER)
  assertEquals(result.body.state, 'sent')
  const create = provider.calls[0]
  assertEquals(create.path, '/users/admin%40secureworkswa.com.au/messages')
  assertEquals(create.body.toRecipients, [{ emailAddress: { address: 'someone.new@example.org' } }])
  assertEquals(create.body.bccRecipients, [{ emailAddress: { address: 'records@secureworkswa.com.au' } }])
  // Sent exactly as approved: no signature appended.
  assertEquals(create.body.body.content, '<p>Exact approved words.</p>')
  assertEquals(provider.calls.at(-1)!.path, '/users/admin%40secureworkswa.com.au/messages/draft-new-1/send')
})

Deno.test('a provider draft that does not match the approval is deleted and never sent', async () => {
  const provider = fakeGraph({ dropCcOnPatch: true })
  const deps = emailDeps(provider.graph)
  const id = await recordEmail(deps)
  const result = await sendApprovedEmail(deps, id, CALLER)
  assertEquals(result.body.state, 'failed')
  assertEquals(result.body.code, 'provider_draft_mismatch')
  assert(!provider.calls.some((call) => call.path.endsWith('/send')))
  assert(provider.calls.some((call) => call.method === 'DELETE'))
  assertEquals(deps.store.rows.get(id)!.status, 'failed')
})

Deno.test('an uncertain final send is outcome_unknown and never resent', async () => {
  const provider = fakeGraph({
    failAt: {
      match: (path) => path.endsWith('/send'),
      error: new GraphProviderError(504, 'gateway timeout', true),
    },
  })
  const deps = emailDeps(provider.graph)
  const id = await recordEmail(deps)
  const result = await sendApprovedEmail(deps, id, CALLER)
  assertEquals(result.body.state, 'outcome_unknown')
  assert(!provider.calls.some((call) => call.method === 'DELETE'))
  assertEquals(deps.store.rows.get(id)!.status, 'outcome_unknown')
  const replay = fakeGraph()
  await assertRejects(
    () => sendApprovedEmail({ ...deps, graph: replay.graph }, id, CALLER),
    ApprovedSendRefusal,
  )
  assertEquals(replay.calls.length, 0)
})

Deno.test('a definite provider refusal before sending records failed', async () => {
  const provider = fakeGraph({
    failAt: {
      match: (path) => path.endsWith('/createReply'),
      error: new GraphProviderError(404, 'message not found', false),
    },
  })
  const deps = emailDeps(provider.graph)
  const id = await recordEmail(deps)
  const result = await sendApprovedEmail(deps, id, CALLER)
  assertEquals(result.body.state, 'failed')
  assertEquals(result.body.code, 'provider_failed_at_draft')
})

Deno.test('the door refuses extra fields and an unverifiable mailbox, leaving the approval unused', async () => {
  const provider = fakeGraph()
  const deps = emailDeps(provider.graph, () =>
    Promise.reject(new GraphProviderError(404, 'mailbox not found', false)))
  const id = await recordEmail(deps)

  const widened = await handleApprovedEmailRequest({ approval_id: id, to: ['x@y.com'] }, CALLER, deps)
  assertEquals(widened.status, 400)
  assertEquals((await widened.json()).code, 'approval_send_fields_rejected')

  const unverified = await handleApprovedEmailRequest({ approval_id: id }, CALLER, deps)
  assertEquals(unverified.status, 502)
  assertEquals((await unverified.json()).code, 'mailbox_unverified')

  assertEquals(provider.calls.length, 0)
  assertEquals(deps.store.rows.get(id)!.status, 'approved')
  const refused = deps.store.auditRows.filter((entry) => entry.event === 'send_refused')
  assertEquals(refused.map((entry) => entry.code), ['approval_send_fields_rejected', 'mailbox_unverified'])
})

Deno.test('an SMS approval cannot be sent through the email door', async () => {
  const provider = fakeGraph()
  const deps = emailDeps(provider.graph)
  const preview = await recordApproval(deps, RECORDER, {
    channel: 'sms',
    approved_by: 'marnin',
    approved_at: '2026-09-29T01:55:00Z',
    approval_words: 'send it',
    approval_source: 'test',
    sms: { to_mobile: '0412345678', message: 'hi' },
  })
  const live = await recordApproval(deps, RECORDER, {
    channel: 'sms',
    approved_by: 'marnin',
    approved_at: '2026-09-29T01:55:00Z',
    approval_words: 'send it',
    approval_source: 'test',
    sms: { to_mobile: '0412345678', message: 'hi' },
    dry_run: false,
    expected_payload_hash: preview.payload_hash,
  })
  const response = await handleApprovedEmailRequest({ approval_id: live.approval_id }, CALLER, deps)
  assertEquals(response.status, 409)
  assertEquals((await response.json()).code, 'approval_wrong_channel')
  assertEquals(provider.calls.length, 0)
})

Deno.test('the approved branch needs the operations credential; the shared key is refused before any call', async () => {
  const fixture = { SW_API_KEY: 'public-fixture', OPS_AGENT_SERVER_KEY: 'ops-fixture', SUPABASE_SERVICE_ROLE_KEY: 'service-fixture' }
  const previous = Object.fromEntries(Object.keys(fixture).map((key) => [key, Deno.env.get(key)]))
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (() => { calls++; throw new Error('Provider must not be called') }) as typeof fetch
  try {
    for (const [key, value] of Object.entries(fixture)) Deno.env.set(key, value)
    const response = await handleOutlookRequest(new Request('https://example.invalid/send-outlook-email', {
      method: 'POST',
      headers: { 'x-api-key': 'public-fixture' },
      body: JSON.stringify({ approval_id: '12345678-1234-4234-8234-123456789012' }),
    }))
    assertEquals(response.status, 401)
    assertEquals(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(previous)) value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value)
  }
})
