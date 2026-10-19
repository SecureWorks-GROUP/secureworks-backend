// deno test --no-check --allow-env --allow-read supabase/functions/send-outlook-email/plain_door_send_claim_test.ts
//
// The plain send door holds each email's content key before it sends, so a
// repeat of an unconfirmed send (from any caller, through any door) is refused,
// and a 2xx that is not a clean Graph acceptance, or a refusal that says its
// own outcome is uncertain, is never "sent" and never retry-safe.
import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'

// Placeholders only. None of these is, or is shaped from, a real key.
Deno.env.set('SUPABASE_URL', 'https://project-fixture.supabase.co')
Deno.env.set('SW_API_KEY', 'public-fixture')
Deno.env.set('OPS_AGENT_SERVER_KEY', 'ops-fixture')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-fixture')
Deno.env.set('MICROSOFT_TENANT_ID', 'tenant-claim-fixture')
Deno.env.set('MICROSOFT_CLIENT_ID', 'client-claim-fixture')
Deno.env.set('MICROSOFT_CLIENT_SECRET', 'secret-claim-fixture')

const {
  GraphProviderError,
  handleOutlookRequest,
  handleReply,
  makeOutlookSendHold,
  resetGraphTokenCache,
  setOutlookSendClaimClient,
} = await import('./index.ts')
const { makeFakeClaimStore } = await import('../_shared/outbound_send_claim_fake.ts')
type Store = ReturnType<typeof makeFakeClaimStore>

// Self-addressed synthetic shape: skips the stored-job fence.
const SEND_BODY = {
  from: 'marnin@secureworkswa.com.au',
  to: 'ses@secureworkswa.com.au',
  subject: 'Fixture send',
  htmlBody: '<p>Fixture</p>',
  sent_by: 'ses_synthetic_livefire_lab',
}

function erroredBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.error(new Error('body read failed')) } })
}

function provider(onSendMail: () => Response | Promise<Response>) {
  const calls: string[] = []
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method || 'GET'} ${url}`)
    if (url.includes('/oauth2/v2.0/token')) {
      return Promise.resolve(Response.json({ access_token: 'opaque-token', expires_in: 3600 }))
    }
    if (url.includes('/mailFolders/inbox')) return Promise.resolve(Response.json({ id: 'inbox-1' }))
    if (url.endsWith('/sendMail')) return Promise.resolve(onSendMail())
    return Promise.resolve(Response.json([]))
  }) as typeof fetch
  return { calls, fetchImpl, sendMails: () => calls.filter((c) => c.endsWith('/sendMail')).length }
}

async function withProvider<T>(store: Store, p: ReturnType<typeof provider>, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = p.fetchImpl
  setOutlookSendClaimClient(store)
  resetGraphTokenCache()
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
    setOutlookSendClaimClient(null)
    resetGraphTokenCache()
  }
}

async function post(extra: Record<string, unknown> = {}) {
  const response = await handleOutlookRequest(new Request('https://example.invalid/send-outlook-email', {
    method: 'POST',
    headers: { 'x-api-key': 'ops-fixture', 'content-type': 'application/json' },
    body: JSON.stringify({ ...SEND_BODY, ...extra }),
  }))
  return { status: response.status, body: await response.json() }
}

const contentRows = (store: Store) => store.rows.filter((r) => r.item_key.startsWith('email_content:'))

Deno.test('plain door: a repeat of an unconfirmed send is refused and Graph is called once (Codex 7)', async () => {
  const store = makeFakeClaimStore()
  const p = provider(() => new Response('upstream', { status: 503 }))
  await withProvider(store, p, async () => {
    const first = await post()
    assertEquals(first.body.state, 'outcome_unknown')
    const second = await post()
    assertEquals(second.status, 409)
    assertEquals(second.body.state, 'outcome_unknown')
    assertEquals(second.body.retry_safe, false)
    assertEquals(second.body.code, 'send_claim_held')
  })
  assertEquals(p.sendMails(), 1)
  assertEquals(contentRows(store).map((r) => r.state), ['outcome_unknown'])
})

Deno.test('plain door: two identical requests together send once', async () => {
  const store = makeFakeClaimStore()
  // Graph's answer is held until both requests have gone as far as they can,
  // so the two are certainly in flight together (not one after the other).
  const waiting: Array<() => void> = []
  const p = provider(() => new Promise<Response>((resolve) => waiting.push(() => resolve(new Response(null, { status: 202 })))))
  const results = await withProvider(store, p, async () => {
    const both = Promise.all([post(), post()])
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0))
    waiting.splice(0).forEach((release) => release())
    return await both
  })
  assertEquals(p.sendMails(), 1)
  assertEquals(results.map((r) => r.status).sort(), [202, 409])
})

Deno.test('plain door: a caller claim whose email is already held by another attempt is refused', async () => {
  const store = makeFakeClaimStore()
  const p = provider(() => new Response('upstream', { status: 503 }))
  await withProvider(store, p, async () => {
    await post() // unknown: holds the content key under its own attempt
    await store.rpc('claim_outbound_send', { p_keys: ['invoice:X1'], p_attempt_id: 'inv-1', p_lease_seconds: 600 })
    const viaInvoice = await post({ send_claim: { item_key: 'invoice:X1', attempt_id: 'inv-1' } })
    assertEquals(viaInvoice.status, 409)
    assertEquals(viaInvoice.body.code, 'send_claim_held')
  })
  assertEquals(p.sendMails(), 1)
})

Deno.test('plain door: a caller claim that is not live is refused before any send', async () => {
  const store = makeFakeClaimStore()
  const p = provider(() => new Response(null, { status: 202 }))
  const result = await withProvider(store, p, () => post({ send_claim: { item_key: 'invoice:X2', attempt_id: 'never-claimed' } }))
  assertEquals(result.status, 409)
  assertEquals(result.body.code, 'send_claim_not_sending')
  assertEquals(p.sendMails(), 0)
})

Deno.test('plain door: a 2xx carrying an error is outcome unknown, held (Codex 4)', async () => {
  const store = makeFakeClaimStore()
  const p = provider(() => Response.json({ error: { code: 'ErrorSendFailed' } }, { status: 202 }))
  const result = await withProvider(store, p, () => post())
  assertEquals(result.status, 502)
  assertEquals(result.body.state, 'outcome_unknown')
  assertEquals(result.body.retry_safe, false)
  assertEquals(contentRows(store).map((r) => r.state), ['outcome_unknown'])
})

Deno.test('plain door: a 2xx whose body cannot be read is outcome unknown (Codex 4)', async () => {
  const store = makeFakeClaimStore()
  const p = provider(() => new Response(erroredBody(), { status: 202 }))
  const result = await withProvider(store, p, () => post())
  assertEquals(result.status, 502)
  assertEquals(result.body.state, 'outcome_unknown')
  assertEquals(result.body.retry_safe, false)
})

Deno.test('plain door: a readable 403 that says outcomeUnknown is unknown, not retry-safe (Codex 5)', async () => {
  const store = makeFakeClaimStore()
  const p = provider(() => Response.json({ error: { code: 'Forbidden', outcomeUnknown: true } }, { status: 403 }))
  const result = await withProvider(store, p, () => post())
  assertEquals(result.status, 502)
  assertEquals(result.body.state, 'outcome_unknown')
  assertEquals(result.body.retry_safe, false)
})

Deno.test('plain door: a plain readable 400 stays a definite failure and frees the item', async () => {
  const store = makeFakeClaimStore()
  const p = provider(() => new Response('bad request', { status: 400 }))
  const result = await withProvider(store, p, () => post())
  assertEquals(result.body.retry_safe, true)
  assertEquals(contentRows(store).map((r) => r.state), ['failed'])
})

Deno.test('plain door: a clean send settles the claim sent, and a caller claim is settled with it', async () => {
  const store = makeFakeClaimStore()
  const p = provider(() => new Response(null, { status: 202 }))
  await withProvider(store, p, async () => {
    const plain = await post()
    assertEquals(plain.status, 202)
    assertEquals(plain.body.success, true)
    assertEquals(plain.body.retry_safe, false)
    await store.rpc('claim_outbound_send', { p_keys: ['invoice:X3'], p_attempt_id: 'inv-3', p_lease_seconds: 600 })
    const viaInvoice = await post({ subject: 'Fixture invoice', send_claim: { item_key: 'invoice:X3', attempt_id: 'inv-3' } })
    assertEquals(viaInvoice.status, 202)
  })
  assertEquals(store.rows.every((r) => r.state === 'sent'), true)
  assertEquals(store.rowsFor('invoice:X3')[0].state, 'sent')
  assertEquals(p.sendMails(), 2)
})

Deno.test('plain door: a claim store outage refuses with nothing sent', async () => {
  const store = makeFakeClaimStore()
  store.fail('claim_outbound_send')
  const p = provider(() => new Response(null, { status: 202 }))
  const result = await withProvider(store, p, () => post())
  assertEquals(result.status, 503)
  assertEquals(result.body.state, 'not_sent')
  assertEquals(p.sendMails(), 0)
})

Deno.test('reply: a /send 2xx carrying an error is unknown and the hold stays (Codex 4)', async () => {
  const store = makeFakeClaimStore()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/oauth2/v2.0/token')) return Response.json({ access_token: 'reply-token', expires_in: 3600 })
    if (url.endsWith('/createReply')) {
      return Response.json({
        id: 'reply-draft-1',
        toRecipients: [{ emailAddress: { address: 'client@example.com' } }],
        ccRecipients: [],
      }, { status: 201 })
    }
    if (url.endsWith('/reply-draft-1/send')) return Response.json({ error: { code: 'x' } }, { status: 202 })
    return new Response('unexpected provider call', { status: 500 })
  }) as typeof fetch
  resetGraphTokenCache()
  try {
    const hold = makeOutlookSendHold(store, null, 'ops-fixture-actor')
    const error = await assertRejects(() =>
      handleReply({
        action: 'reply',
        mailbox: 'admin@secureworkswa.com.au',
        message_id: 'source-message-1',
        htmlBody: '<p>Reviewed reply</p>',
        content_reviewed: true,
        expected_to: ['client@example.com'],
        expected_cc: [],
      }, hold)
    )
    assert(error instanceof GraphProviderError)
    assertEquals((error as InstanceType<typeof GraphProviderError>).outcomeUnknown, true)
    assert(hold.acquired())
    assertEquals(contentRows(store).map((r) => r.state), ['sending'])
  } finally {
    globalThis.fetch = originalFetch
    resetGraphTokenCache()
  }
})
