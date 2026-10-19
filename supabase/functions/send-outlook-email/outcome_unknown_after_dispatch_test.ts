// deno test --no-check --allow-env --allow-read supabase/functions/send-outlook-email/outcome_unknown_after_dispatch_test.ts
//
// Once the sendMail request may have reached Graph, no failure may be answered
// retry_safe:true: a resend would email the recipient twice. Drives the real
// handler through auth, mailbox verification and sendMail with a stubbed fetch.
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'

// Placeholders only. None of these is, or is shaped from, a real key.
Deno.env.set('SUPABASE_URL', 'https://project-fixture.supabase.co')
Deno.env.set('SW_API_KEY', 'public-fixture')
Deno.env.set('OPS_AGENT_SERVER_KEY', 'ops-fixture')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-fixture')
Deno.env.set('MICROSOFT_TENANT_ID', 'tenant-unknown-fixture')
Deno.env.set('MICROSOFT_CLIENT_ID', 'client-unknown-fixture')
Deno.env.set('MICROSOFT_CLIENT_SECRET', 'secret-unknown-fixture')

const { handleOutlookRequest, resetGraphTokenCache } = await import('./index.ts')

// The self-addressed synthetic shape skips the stored-job fence, so the only
// provider calls are the token, the mailbox read and sendMail.
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

async function send(
  onSendMail: () => Response,
  onOther: (url: string) => Response = () => new Response('unexpected provider call', { status: 500 }),
  extraBody: Record<string, unknown> = {},
) {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method || 'GET'} ${url}`)
    if (url.includes('/oauth2/v2.0/token')) {
      return Promise.resolve(Response.json({ access_token: 'opaque-token', expires_in: 3600 }))
    }
    if (url.includes('/mailFolders/inbox')) return Promise.resolve(Response.json({ id: 'inbox-1' }))
    if (url.endsWith('/sendMail')) return Promise.resolve(onSendMail())
    return Promise.resolve(onOther(url))
  }) as typeof fetch

  resetGraphTokenCache()
  try {
    const response = await handleOutlookRequest(new Request('https://example.invalid/send-outlook-email', {
      method: 'POST',
      headers: { 'x-api-key': 'ops-fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ ...SEND_BODY, ...extraBody }),
    }))
    return { status: response.status, body: await response.json(), calls }
  } finally {

    globalThis.fetch = originalFetch
    resetGraphTokenCache()
  }
}

Deno.test('a sendMail error whose body cannot be read is outcome unknown, never retry-safe', async () => {
  const result = await send(() => new Response(erroredBody(), { status: 503 }))
  assertEquals(result.calls.filter((c) => c.endsWith('/sendMail')).length, 1)
  assertEquals(result.status, 502)
  assertEquals(result.body.state, 'outcome_unknown')
  assertEquals(result.body.retry_safe, false)
})

Deno.test('a plain error after sendMail returned is outcome unknown, never retry-safe', async () => {
  // fetch throwing synchronously for the CRM note escapes the .catch and
  // reaches the generic catch after Graph accepted the send.
  const result = await send(
    () => new Response(null, { status: 202 }),
    (url) => {
      if (url.includes('/functions/v1/ghl-proxy')) throw new Error('note transport failed')
      return Response.json([])
    },
    { ghl_contact_id: 'contact-fixture' },
  )
  assertEquals(result.calls.filter((c) => c.endsWith('/sendMail')).length, 1)
  assertEquals(result.status, 502)
  assertEquals(result.body.state, 'outcome_unknown')
  assertEquals(result.body.retry_safe, false)
})

Deno.test('a sendMail 400 whose body cannot be read is outcome unknown, never retry-safe', async () => {
  const result = await send(() => new Response(erroredBody(), { status: 400 }))
  assertEquals(result.calls.filter((c) => c.endsWith('/sendMail')).length, 1)
  assertEquals(result.status, 502)
  assertEquals(result.body.state, 'outcome_unknown')
  assertEquals(result.body.retry_safe, false)
})

Deno.test('a sendMail 401 after token refresh is outcome unknown, never retry-safe', async () => {
  const result = await send(() => new Response('expired', { status: 401 }))
  assertEquals(result.calls.filter((c) => c.endsWith('/sendMail')).length, 1)
  assertEquals(result.status, 502)
  assertEquals(result.body.state, 'outcome_unknown')
  assertEquals(result.body.retry_safe, false)
})

Deno.test('a Graph 400 on sendMail with a readable body stays a definite failure', async () => {
  const result = await send(() => new Response('bad request', { status: 400 }))
  assertEquals(result.status, 502)
  assertEquals(result.body.retry_safe, true)
})
