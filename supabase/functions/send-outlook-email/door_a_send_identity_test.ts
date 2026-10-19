// deno test --no-check --allow-env --allow-read supabase/functions/send-outlook-email/door_a_send_identity_test.ts
//
// Door A: the send-outlook-email door and the approved-email door hold one
// delivery identity, join a caller's claim as its single dispatcher, fence
// every mutating Graph call, refuse a 2xx that says its outcome is uncertain,
// hold invoice:<id> for an invoice-anchored plain send, and release a checked
// recovery once. Every case runs requests together (Promise.all) over the fake
// claim store; no real provider or database is called. Each case names the
// review finding it closes (codex-review-uncertain-send-0cc1a193.md P1#1, #3,
// #7; codex-recheck-containment-cc12df7c.md must-fix 4).
// deno-lint-ignore-file no-explicit-any no-import-prefix
import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'

// Placeholders only. None of these is, or is shaped from, a real key.
Deno.env.set('SUPABASE_URL', 'https://project-fixture.supabase.co')
Deno.env.set('SW_API_KEY', 'public-fixture')
Deno.env.set('OPS_AGENT_SERVER_KEY', 'ops-fixture')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-fixture')
Deno.env.set('MICROSOFT_TENANT_ID', 'tenant-doora-fixture')
Deno.env.set('MICROSOFT_CLIENT_ID', 'client-doora-fixture')
Deno.env.set('MICROSOFT_CLIENT_SECRET', 'secret-doora-fixture')

const {
  handleOutlookRequest,
  handleReply,
  makeOutlookSendHold,
  OutlookSendFenced,
  outlookSendFencedBody,
  resetGraphTokenCache,
  setOutlookSendClaimClient,
} = await import('./index.ts')
const { makeFakeClaimStore } = await import('../_shared/outbound_send_claim_fake.ts')
const { ApprovedSendRefusal, recordApproval } = await import('../_shared/approved_send.ts')
const { makeDeps, RECORDER } = await import('../_shared/approved_send_test_fakes.ts')
const { sendApprovedEmail } = await import('./approved_send_email.ts')
const { assertGraphSendAccepted } = await import('./graph_send_accept.ts')
type Store = ReturnType<typeof makeFakeClaimStore>
type GraphCall = Parameters<typeof sendApprovedEmail>[0]['graph']

const MAILBOX = 'marnin@secureworkswa.com.au'
const SUPPRESS = '<!-- suppress-auto-appended-default-signature -->'
const HTML = `<p>Hi, the revised scope is below.</p>${SUPPRESS}`
const CALLER = { actor: 'seat:rayleigh', credentialClass: 'ops_agent_server_key' }
const INVOICE_ID = 'AB12CD34-0000-4000-8000-00000000F00D'

// A plain request with no job, invoice or PDF: the SES fence lets it through.
const PLAIN = {
  from: MAILBOX,
  to: 'ses@secureworkswa.com.au',
  subject: 'Door A fixture',
  htmlBody: HTML,
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
    if (url.includes('/rest/v1/xero_invoices')) {
      // An ACCPAY bill with no job: the invoice fence passes without a job read.
      return Promise.resolve(Response.json([{ job_id: null, invoice_type: 'ACCPAY' }]))
    }
    if (url.endsWith('/sendMail')) return Promise.resolve(onSendMail())
    return Promise.resolve(Response.json([]))
  }) as typeof fetch
  return { calls, fetchImpl, sendMails: () => calls.filter((c) => c.endsWith('/sendMail')).length }
}

async function withProvider<T>(
  client: { rpc: Store['rpc'] },
  p: ReturnType<typeof provider>,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = p.fetchImpl
  setOutlookSendClaimClient(client)
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
    body: JSON.stringify({ ...PLAIN, ...extra }),
  }))
  return { status: response.status, body: await response.json() }
}

/** A claim client that runs `before` once, just ahead of the onCall-th dispatch confirm (of one attempt, if named). */
function fenceOnConfirm(store: Store, before: () => Promise<void>, onCall = 1, attemptId: string | null = null) {
  let seen = 0
  return {
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      if (
        fn === 'confirm_outbound_dispatch' && (attemptId === null || args.p_attempt_id === attemptId) &&
        ++seen === onCall
      ) await before()
      return store.rpc(fn, args)
    },
  }
}

/** A provider answer held until released, so two sends overlap for certain. */
function gate() {
  const waiting: Array<() => void> = []
  return {
    hold: (answer: () => Response) => new Promise<Response>((resolve) => waiting.push(() => resolve(answer()))),
    waiting: () => waiting.length,
    releaseAll: () => waiting.splice(0).forEach((release) => release()),
  }
}

async function settleTicks(times = 50) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Reconcile one attempt by name, as a checked press would, once its lease has passed. */
async function reconcileAttempt(store: Store, attemptId: string) {
  store.advance(901_000)
  const result = await store.rpc('reconcile_outbound_send', {
    p_attempt_id: attemptId,
    p_expected_state: 'sending',
    p_result: 'not_sent',
    p_actor: 'office:jo',
    p_checked_at: new Date().toISOString(),
    p_evidence: 'sent_items_checked',
  })
  assertEquals((result.data as any)?.ok, true)
}

// ── Approved door fixtures ──

function approvedGraph(onSend: () => Response = () => new Response(null, { status: 202 })) {
  const sends: string[] = []
  const posts: string[] = []
  let counter = 0
  const graph: GraphCall = (path, init = {}) => {
    const method = String(init.method || 'GET')
    const body = init.body ? JSON.parse(String(init.body)) : null
    if (method === 'POST' && path.endsWith('/messages')) {
      posts.push(path)
      counter += 1
      return Promise.resolve(Response.json({ id: `draft-${counter}`, internetMessageId: `<m-${counter}@sw>`, ...body }))
    }
    if (path.endsWith('/send')) {
      sends.push(path)
      return Promise.resolve(onSend())
    }
    if (path.endsWith('/attachments') || method === 'DELETE') return Promise.resolve(new Response(null, { status: 202 }))
    return Promise.reject(new Error(`unexpected Graph call ${method} ${path}`))
  }
  return { graph, sends, posts }
}

function approvedDeps(graph: GraphCall) {
  return { ...makeDeps(), graph, verifyMailbox: () => Promise.resolve() }
}

async function recordEmail(d: ReturnType<typeof approvedDeps>, email: Record<string, unknown> = {}): Promise<string> {
  const body = {
    channel: 'email',
    approved_by: 'marnin',
    approved_at: '2026-09-29T01:55:00Z',
    approval_words: 'Yes, send the revised scope to the SES inbox.',
    approval_source: 'door A fixture',
    email: {
      mailbox: MAILBOX,
      mode: 'new',
      reply_to_message_id: null,
      to: ['ses@secureworkswa.com.au'],
      cc: [],
      bcc: [],
      subject: PLAIN.subject,
      html_body: HTML,
      attachments: [],
      ...email,
    },
  }
  const preview = await recordApproval(d, RECORDER, body)
  const live = await recordApproval(d, RECORDER, { ...body, dry_run: false, expected_payload_hash: preview.payload_hash })
  d.clock.advanceMinutes(1)
  return live.approval_id!
}

const rowsByPrefix = (store: Store, prefix: string) => store.rows.filter((r) => r.item_key.startsWith(prefix))

// ── P1#1 / containment 4: joining a caller claim ──

Deno.test('P1#1: the same supplied attempt sent twice at once gives one Graph send, as its one dispatcher', async () => {
  const store = makeFakeClaimStore()
  const held = gate()
  const p = provider(() => held.hold(() => new Response(null, { status: 202 })))
  await store.rpc('claim_outbound_send', { p_keys: ['invoice:x1'], p_attempt_id: 'inv-1', p_lease_seconds: 900 })
  const claim = { send_claim: { item_key: 'invoice:x1', attempt_id: 'inv-1' } }
  const results = await withProvider(store, p, async () => {
    const both = Promise.all([post(claim), post(claim)])
    await settleTicks()
    held.releaseAll()
    return await both
  })
  assertEquals(p.sendMails(), 1)
  assertEquals(results.map((r) => r.status).sort(), [202, 409])
  const refused = results.find((r) => r.status === 409)!
  assertEquals(refused.body.code, 'send_claim_dispatch_taken')
  assertEquals(refused.body.state, 'sending')
  assertEquals(refused.body.retry_safe, false)
  // The door joined with the caller's item, confirmed its token before Graph,
  // and settled the attempt as the dispatcher.
  const extend = store.calls.find((c) => c.fn === 'extend_outbound_send_claim')!
  assertEquals(extend.args.p_caller_item_key, 'invoice:x1')
  assert(store.events.some((e) => e.attempt_id === 'inv-1' && e.event === 'dispatch_confirmed'))
  assert(store.events.some((e) => e.attempt_id === 'inv-1' && e.event === 'settled' && e.actor === 'dispatcher'))
  assertEquals(store.rowsOf('inv-1').map((r) => r.state), ['sent', 'sent'])
})

Deno.test('P1#1: a caller claim that names another item is refused not_sent, nothing sent', async () => {
  const store = makeFakeClaimStore()
  const p = provider(() => new Response(null, { status: 202 }))
  await store.rpc('claim_outbound_send', { p_keys: ['invoice:x2'], p_attempt_id: 'inv-2', p_lease_seconds: 900 })
  const results = await withProvider(store, p, () =>
    Promise.all([
      post({ send_claim: { item_key: 'invoice:someone-else', attempt_id: 'inv-2' } }),
      post({ subject: 'Door A other', send_claim: { item_key: 'debt_report:org-9', attempt_id: 'inv-2' } }),
    ]))
  for (const result of results) {
    assertEquals(result.status, 409)
    assertEquals(result.body.code, 'send_claim_item_mismatch')
    assertEquals(result.body.state, 'not_sent')
  }
  assertEquals(p.sendMails(), 0)
})

Deno.test('P1#1: a reconcile between join and send sends nothing (fence), and the door does not settle it', async () => {
  const store = makeFakeClaimStore()
  const p = provider(() => new Response(null, { status: 202 }))
  await store.rpc('claim_outbound_send', { p_keys: ['invoice:x6'], p_attempt_id: 'inv-6', p_lease_seconds: 900 })
  const client = fenceOnConfirm(store, () => reconcileAttempt(store, 'inv-6'), 1, 'inv-6')
  const claim = { send_claim: { item_key: 'invoice:x6', attempt_id: 'inv-6' } }
  const results = await withProvider(client, p, () => Promise.all([post(claim), post(claim)]))
  const fenced = results.find((r) => r.body.code === 'send_dispatch_fenced')!
  assertEquals(fenced.status, 409)
  assertEquals(fenced.body.state, 'not_sent')
  assertEquals(fenced.body.retry_safe, true) // no mutating call had been made
  // The other request carrying the same attempt was refused before any send:
  // in progress while the first held the dispatch, not sending once reconciled.
  const other = results.find((r) => r !== fenced)!
  assertEquals(other.status, 409)
  assert(['send_claim_dispatch_taken', 'send_claim_not_sending'].includes(other.body.code))
  assertEquals(p.sendMails(), 0)
  assertEquals(store.rowsOf('inv-6').map((r) => r.state), ['reconciled_not_sent', 'reconciled_not_sent'])
})

Deno.test('P1#1: a fence after the reply draft is made stops before /send and is unknown', async () => {
  const store = makeFakeClaimStore()
  const graphCalls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/oauth2/v2.0/token')) return Response.json({ access_token: 'reply-token', expires_in: 3600 })
    graphCalls.push(`${init?.method || 'GET'} ${url}`)
    if (url.endsWith('/createReply')) {
      return Response.json({
        id: 'reply-draft-9',
        toRecipients: [{ emailAddress: { address: 'client@example.com' } }],
        ccRecipients: [],
      }, { status: 201 })
    }
    return new Response(null, { status: 202 })
  }) as typeof fetch
  resetGraphTokenCache()
  try {
    let attemptId = ''
    const client = fenceOnConfirm(store, async () => {
      attemptId = store.rows[0].attempt_id
      await reconcileAttempt(store, attemptId)
    }, 2)
    const hold = makeOutlookSendHold(client, null, 'ops-fixture-actor')
    const replies = await Promise.allSettled([
      handleReply({
        action: 'reply',
        mailbox: 'admin@secureworkswa.com.au',
        message_id: 'source-message-9',
        htmlBody: `<p>Reviewed reply</p>${SUPPRESS}`,
        content_reviewed: true,
        expected_to: ['client@example.com'],
        expected_cc: [],
      }, hold),
    ])
    const error = (replies[0] as PromiseRejectedResult).reason
    assert(error instanceof OutlookSendFenced)
    assertEquals(error.mutated, true)
    const body = outlookSendFencedBody(error)
    assertEquals(body.state, 'outcome_unknown')
    assertEquals(body.retry_safe, false)
    assertEquals(graphCalls.some((c) => c.endsWith('/send')), false)
    assertEquals(graphCalls.filter((c) => c.endsWith('/createReply')).length, 1)
  } finally {
    globalThis.fetch = originalFetch
    resetGraphTokenCache()
  }
})

Deno.test('P1#1: an approved send fenced before its draft sends nothing and is 409', async () => {
  const g = approvedGraph()
  const d = approvedDeps(g.graph)
  const id = await recordEmail(d)
  const store = d.store.claims
  const realRpc = store.rpc
  let fenced = false
  ;(store as any).rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    if (fn === 'confirm_outbound_dispatch' && !fenced) {
      fenced = true
      await reconcileAttempt({ ...store, rpc: realRpc } as Store, `approved_send:${id}`)
    }
    return realRpc(fn, args)
  }
  const [result] = await Promise.all([sendApprovedEmail(d, id, CALLER)])
  assertEquals(result.status, 409)
  assertEquals(result.body.code, 'send_dispatch_fenced')
  assertEquals(g.posts.length + g.sends.length, 0)
})

// ── P1#3: one delivery identity across both doors ──

Deno.test('P1#3: an approved send and a plain send of the identical message at once give one send', async () => {
  const held = gate()
  const accepted = () => new Response(null, { status: 202 })
  const g = approvedGraph(() => accepted())
  const graph: GraphCall = (path, init, options) =>
    path.endsWith('/send') ? (g.sends.push(path), held.hold(accepted)) : g.graph(path, init, options)
  const d = approvedDeps(graph)
  const id = await recordEmail(d)
  const p = provider(() => held.hold(accepted))
  const results = await withProvider(d.store.claims, p, async () => {
    const both = Promise.allSettled([sendApprovedEmail(d, id, CALLER), post()])
    // Hold every provider send open until both requests have gone as far as they can.
    await settleTicks()
    held.releaseAll()
    return await both
  })
  assertEquals(g.sends.length + p.sendMails(), 1)
  assertEquals(rowsByPrefix(d.store.claims, 'email_content:').length, 1)
  assertEquals(results.filter((r) => r.status === 'fulfilled' && ((r.value as any).status === 202)).length, 1)
})

Deno.test('P1#3: an approved send while a plain send of the same content is unknown is refused, approval unused', async () => {
  const g = approvedGraph()
  const d = approvedDeps(g.graph)
  const id = await recordEmail(d)
  const p = provider(() => new Response('upstream', { status: 503 }))
  const [plain] = await withProvider(d.store.claims, p, () => Promise.all([post()]))
  assertEquals(plain.body.state, 'outcome_unknown')
  const refused = await assertRejects(() => sendApprovedEmail(d, id, CALLER), ApprovedSendRefusal)
  assertEquals((refused as InstanceType<typeof ApprovedSendRefusal>).code, 'send_claim_held')
  assertEquals(((refused as any).evidence).state, 'outcome_unknown')
  assertEquals(d.store.rows.get(id)!.status, 'approved')
  assertEquals(g.posts.length + g.sends.length, 0)
  assertEquals(p.sendMails(), 1)
})

Deno.test('P1#3: reordered and recased recipients give the same key and are held across doors', async () => {
  const g = approvedGraph()
  const d = approvedDeps(g.graph)
  const id = await recordEmail(d, {
    to: ['a@example.com', 'b@example.com'],
    cc: ['c@example.com', 'd@example.com'],
  })
  const p = provider(() => new Response('upstream', { status: 503 }))
  const [first, again] = await withProvider(d.store.claims, p, async () => {
    const unknown = await post({ to: 'B@example.com, a@example.com', cc: 'd@example.com, C@example.com' })
    return [unknown, await post({ to: 'a@example.com, b@example.com', cc: 'c@example.com, d@example.com' })]
  })
  assertEquals(first.body.state, 'outcome_unknown')
  assertEquals(again.status, 409)
  assertEquals(again.body.code, 'send_claim_held')
  const refused = await assertRejects(() => sendApprovedEmail(d, id, CALLER), ApprovedSendRefusal)
  assertEquals((refused as InstanceType<typeof ApprovedSendRefusal>).code, 'send_claim_held')
  assertEquals(g.sends.length, 0)
  assertEquals(p.sendMails(), 1)
})

Deno.test('P1#3: a plain invoice-anchored request is refused while invoice:<id> is held, and holds it itself', async () => {
  const store = makeFakeClaimStore()
  const p = provider(() => new Response(null, { status: 202 }))
  // Another door's unconfirmed invoice send (the key is the lowercased id).
  await store.rpc('claim_outbound_send', {
    p_keys: [`invoice:${INVOICE_ID.toLowerCase()}`],
    p_attempt_id: 'ops-invoice-1',
    p_lease_seconds: 900,
  })
  await store.rpc('settle_outbound_send', { p_attempt_id: 'ops-invoice-1', p_state: 'outcome_unknown', p_detail: {} })
  const results = await withProvider(store, p, () =>
    Promise.all([
      post({ subject: 'Invoice by mail', xero_invoice_id: INVOICE_ID }),
      post({ subject: 'Invoice by mail, again', attachments: [], xero_invoice_id: INVOICE_ID }),
    ]))
  for (const result of results) {
    assertEquals(result.status, 409)
    assertEquals(result.body.code, 'send_claim_held')
    assertEquals(result.body.held[0].item_key, `invoice:${INVOICE_ID.toLowerCase()}`)
  }
  assertEquals(p.sendMails(), 0)

  // A different invoice is free; the send holds its invoice key with its content.
  const other = 'ab12cd34-0000-4000-8000-00000000beef'
  const sent = await withProvider(store, p, () => post({ subject: 'Other invoice', xero_invoice_id: other }))
  assertEquals(sent.status, 202)
  const [row] = store.rowsFor(`invoice:${other}`)
  assertEquals(row.state, 'sent')
  assertEquals(store.rowsOf(row.attempt_id).map((r) => r.item_key.split(':')[0]).sort(), ['email_content', 'invoice'])
})

// ── P1#7: a 2xx that says its outcome is uncertain ──

Deno.test('P1#7: a 2xx {state:"outcome_unknown"} and a 2xx {retry_safe:false} are unknown and held', async () => {
  const store = makeFakeClaimStore()
  let n = 0
  const p = provider(() =>
    (n++ % 2 === 0)
      ? Response.json({ state: 'outcome_unknown' }, { status: 202 })
      : Response.json({ error: null, retry_safe: false }, { status: 200 })
  )
  const results = await withProvider(store, p, async () => {
    const first = await Promise.all([post({ subject: 'Uncertain A' }), post({ subject: 'Uncertain B' })])
    const repeats = await Promise.all([post({ subject: 'Uncertain A' }), post({ subject: 'Uncertain B' })])
    return { first, repeats }
  })
  for (const result of results.first) {
    assertEquals(result.status, 502)
    assertEquals(result.body.state, 'outcome_unknown')
    assertEquals(result.body.retry_safe, false)
  }
  for (const result of results.repeats) {
    assertEquals(result.status, 409)
    assertEquals(result.body.code, 'send_claim_held')
  }
  assertEquals(p.sendMails(), 2)
  assertEquals(rowsByPrefix(store, 'email_content:').map((r) => r.state), ['outcome_unknown', 'outcome_unknown'])
  // The same predicate, nested under error, and the empty 202 that stays accepted.
  await assertRejects(() => assertGraphSendAccepted(Response.json({ error: { state: 'outcome_unknown' } }, { status: 202 })))
  await assertRejects(() => assertGraphSendAccepted(Response.json({ retry_safe: false }, { status: 202 })))
  await assertGraphSendAccepted(new Response(null, { status: 202 }))
})

Deno.test('P1#7: an approved final send whose 2xx says retry_safe:false is outcome_unknown, held', async () => {
  const g = approvedGraph(() => Response.json({ retry_safe: false }, { status: 202 }))
  const d = approvedDeps(g.graph)
  const id = await recordEmail(d)
  const [result] = await Promise.all([sendApprovedEmail(d, id, CALLER)])
  assertEquals(result.body.state, 'outcome_unknown')
  assertEquals(rowsByPrefix(d.store.claims, 'email_content:').map((r) => r.state), ['outcome_unknown'])
})

// ── Checked recovery on the plain door ──

Deno.test('checked recovery: two concurrent checked plain recoveries release once, and the checker is recorded', async () => {
  const store = makeFakeClaimStore()
  const held = gate()
  let first = true
  const p = provider(() => {
    if (first) {
      first = false
      return new Response('upstream', { status: 503 })
    }
    return held.hold(() => new Response(null, { status: 202 }))
  })
  const results = await withProvider(store, p, async () => {
    const unknown = await post()
    assertEquals(unknown.body.state, 'outcome_unknown')
    store.advance(901_000)
    const checked = { sent_items_checked: true, checked_by: 'office:jo' }
    const both = Promise.all([post(checked), post(checked)])
    // Hold the recovery send open until both presses have gone as far as they can.
    await settleTicks()
    held.releaseAll()
    return await both
  })
  assertEquals(p.sendMails(), 2) // the unknown first send, then exactly one recovery
  assertEquals(results.map((r) => r.status).sort(), [202, 409])
  const released = store.rows.filter((r) => r.state === 'reconciled_not_sent')
  assertEquals(released.length, 1)
  assertEquals(released[0].reconciled_by, 'office:jo')
  assert(released[0].reconcile_checked_at)
})

Deno.test('checked recovery: refused without a named checker, and a wrong held attempt is refused', async () => {
  const store = makeFakeClaimStore()
  const p = provider(() => new Response('upstream', { status: 503 }))
  const [noChecker, blankChecker, wrongAttempt] = await withProvider(store, p, async () => {
    await post()
    store.advance(901_000)
    return await Promise.all([
      post({ sent_items_checked: true }),
      post({ sent_items_checked: true, checked_by: '  ' }),
      post({ sent_items_checked: true, checked_by: 'office:jo', held_attempt_id: 'outlook:not-the-one' }),
    ])
  })
  assertEquals(noChecker.status, 400)
  assertEquals(noChecker.body.code, 'checked_by_required')
  assertEquals(blankChecker.body.code, 'checked_by_required')
  assertEquals(wrongAttempt.status, 409)
  assertEquals(wrongAttempt.body.code, 'send_reconcile_attempt_mismatch')
  assertEquals(p.sendMails(), 1)
  assertEquals(rowsByPrefix(store, 'email_content:').map((r) => r.state), ['outcome_unknown'])
})
