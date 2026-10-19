// The approved-send content hold, through a fake Graph and a fake claim store.
// No real provider or database is ever called. Each case names the review
// finding it closes (checker uncertain-send-check-c3de7498.md, Codex review).
// deno-lint-ignore-file no-explicit-any no-import-prefix
import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { ApprovedSendRefusal, recordApproval } from '../_shared/approved_send.ts'
import { emailApprovalBody, makeDeps, RECORDER } from '../_shared/approved_send_test_fakes.ts'
import { type GraphCall, sendApprovedEmail } from './approved_send_email.ts'

const DOC_ID = '11111111-1111-4111-8111-111111111111'
const CALLER = { actor: 'seat:rayleigh', credentialClass: 'ops_agent_server_key' }

type SendBehaviour = 'ok' | 'error_body_2xx' | 'unreadable_2xx' | 'hang' | 'timeout'

function graphFake(behaviour: () => SendBehaviour) {
  const sends: string[] = []
  const hangs: Array<(r: Response) => void> = []
  let counter = 0
  const drafts = new Map<string, Record<string, unknown>>()
  const graph: GraphCall = (path, init = {}) => {
    const method = String(init.method || 'GET')
    const body = init.body ? JSON.parse(String(init.body)) : null
    if (path.endsWith('/createReply') && method === 'POST') {
      counter += 1
      const draft = { id: `draft-${counter}`, internetMessageId: `<m-${counter}@sw>` }
      drafts.set(draft.id, draft)
      return Promise.resolve(new Response(JSON.stringify(draft), { status: 200 }))
    }
    if (method === 'PATCH') {
      const id = decodeURIComponent(path.split('/').pop() || '')
      const draft = { ...(drafts.get(id) || {}), ...body }
      drafts.set(id, draft)
      return Promise.resolve(new Response(JSON.stringify(draft), { status: 200 }))
    }
    if (path.endsWith('/messages') && method === 'POST') {
      counter += 1
      const draft = { id: `draft-${counter}`, internetMessageId: `<m-${counter}@sw>`, ...body }
      return Promise.resolve(new Response(JSON.stringify(draft), { status: 200 }))
    }
    if (path.endsWith('/send')) {
      sends.push(path)
      const mode = behaviour()
      if (mode === 'hang') return new Promise<Response>((resolve) => hangs.push(resolve))
      if (mode === 'timeout') {
        return Promise.reject(Object.assign(new Error('gateway timeout'), { outcomeUnknown: true }))
      }
      if (mode === 'error_body_2xx') {
        return Promise.resolve(new Response(JSON.stringify({ error: { code: 'ErrorSendAsDenied' } }), { status: 202 }))
      }
      if (mode === 'unreadable_2xx') return Promise.resolve(new Response('<html>proxy</html>', { status: 202 }))
      return Promise.resolve(new Response(null, { status: 202 }))
    }
    if (path.endsWith('/attachments') || method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 202 }))
    }
    return Promise.reject(new Error(`unexpected Graph call ${method} ${path}`))
  }
  return { graph, sends, release: (r: Response) => hangs.shift()?.(r) }
}

function deps(graph: GraphCall) {
  const base = makeDeps()
  base.files.put({ source: 'job_document', id: DOC_ID }, '%PDF-1.7 revised quote', 'Quote-v2.pdf')
  return { ...base, graph, verifyMailbox: () => Promise.resolve() }
}

async function record(d: ReturnType<typeof deps>, extra: Record<string, unknown> = {}): Promise<string> {
  const body = { ...emailApprovalBody(), ...extra }
  const preview = await recordApproval(d, RECORDER, body)
  const live = await recordApproval(d, RECORDER, { ...body, dry_run: false, expected_payload_hash: preview.payload_hash })
  d.clock.advanceMinutes(1) // real time passes between recording and sending
  return live.approval_id!
}

async function tick(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 0))
  assert(check(), 'condition never became true')
}

Deno.test('AS3: a re-approval while the first send is still sending is refused, checked or not', async () => {
  let mode: SendBehaviour = 'hang'
  const g = graphFake(() => mode)
  const d = deps(g.graph)
  const first = await record(d)
  const inFlight = sendApprovedEmail(d, first, CALLER)
  await until(() => g.sends.length === 1)

  const plain = await assertRejects(() => record(d), ApprovedSendRefusal)
  assertEquals((plain as ApprovedSendRefusal).code, 'approval_prior_outcome_unknown')
  const checked = await assertRejects(() => record(d, { sent_items_checked: true }), ApprovedSendRefusal)
  assertEquals((checked as ApprovedSendRefusal).code, 'send_reconcile_live_send')

  mode = 'ok'
  g.release(new Response(null, { status: 202 }))
  assertEquals((await inFlight).body.state, 'sent')
  assertEquals(g.sends.length, 1)
})

Deno.test('Codex2: two approvals recorded before either sends; the second cannot send while the first is unresolved', async () => {
  let mode: SendBehaviour = 'hang'
  const g = graphFake(() => mode)
  const d = deps(g.graph)
  const a = await record(d)
  const b = await record(d)
  const inFlight = sendApprovedEmail(d, a, CALLER)
  await until(() => g.sends.length === 1)

  // B while A is sending: held, B left unused.
  const live = await assertRejects(() => sendApprovedEmail(d, b, CALLER), ApprovedSendRefusal)
  assertEquals((live as ApprovedSendRefusal).code, 'send_claim_held')
  assertEquals(((live as ApprovedSendRefusal).evidence as any).state, 'sending')
  assertEquals(d.store.rows.get(b)!.status, 'approved')

  // A ends unknown: B is still held, now as uncertain.
  mode = 'timeout'
  g.release(new Response('', { status: 504 }))
  await inFlight
  const after = await assertRejects(() => sendApprovedEmail(d, b, CALLER), ApprovedSendRefusal)
  assertEquals((after as ApprovedSendRefusal).code, 'send_claim_held')
  assertEquals(((after as ApprovedSendRefusal).evidence as any).state, 'outcome_unknown')
  assertEquals(((after as ApprovedSendRefusal).evidence as any).retry_safe, false)
  assertEquals(g.sends.length, 1)
})

Deno.test('Codex2: two approvals of the same content pressed together send once', async () => {
  let mode: SendBehaviour = 'hang'
  const g = graphFake(() => mode)
  const d = deps(g.graph)
  const a = await record(d)
  const b = await record(d)
  const both = Promise.allSettled([sendApprovedEmail(d, a, CALLER), sendApprovedEmail(d, b, CALLER)])
  await until(() => g.sends.length === 1)
  await tick(200)
  mode = 'ok'
  g.release(new Response(null, { status: 202 }))
  const results = await both
  assertEquals(results.filter((r) => r.status === 'fulfilled').length, 1)
  const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
  assertEquals((refused.reason as ApprovedSendRefusal).code, 'send_claim_held')
  assertEquals(g.sends.length, 1)
})

Deno.test('AS4: an outcome write that is lost still holds the content', async () => {
  const g = graphFake(() => 'timeout')
  const d = deps(g.graph)
  const pre = await record(d)
  const first = await record(d)
  d.store.loseOutcomeWrites = true
  await sendApprovedEmail(d, first, CALLER)
  assertEquals(d.store.rows.get(first)!.status, 'sending')

  const again = await assertRejects(() => record(d), ApprovedSendRefusal)
  assertEquals((again as ApprovedSendRefusal).code, 'approval_prior_outcome_unknown')
  const other = await assertRejects(() => sendApprovedEmail(d, pre, CALLER), ApprovedSendRefusal)
  assertEquals((other as ApprovedSendRefusal).code, 'send_claim_held')
  assertEquals(g.sends.length, 1)
})

Deno.test('AS4: an outcome write and its claim settle both lost: held while live, then held as uncertain', async () => {
  const g = graphFake(() => 'timeout')
  const d = deps(g.graph)
  const pre = await record(d)
  const first = await record(d)
  d.store.loseOutcomeWrites = true
  d.store.claims.fail('settle_outbound_send')
  await sendApprovedEmail(d, first, CALLER)
  d.store.claims.heal()

  const live = await assertRejects(() => sendApprovedEmail(d, pre, CALLER), ApprovedSendRefusal)
  assertEquals(((live as ApprovedSendRefusal).evidence as any).state, 'sending')
  d.store.claims.advance(16 * 60_000) // past the 900 s lease
  const stale = await assertRejects(() => sendApprovedEmail(d, pre, CALLER), ApprovedSendRefusal)
  assertEquals(((stale as ApprovedSendRefusal).evidence as any).state, 'outcome_unknown')
  // Only an explicit check releases it.
  const checked = await record(d, { sent_items_checked: true })
  assert(checked)
  assertEquals(g.sends.length, 1)
})

Deno.test('AS5: two checked re-approvals together, exactly one sends', async () => {
  let mode: SendBehaviour = 'timeout'
  const g = graphFake(() => mode)
  const d = deps(g.graph)
  const first = await record(d)
  await sendApprovedEmail(d, first, CALLER)
  mode = 'ok'
  const body = { ...emailApprovalBody(), sent_items_checked: true }
  const preview = await recordApproval(d, RECORDER, body)
  const live = { ...body, dry_run: false, expected_payload_hash: preview.payload_hash }
  const records = await Promise.allSettled([
    recordApproval(d, RECORDER, live),
    recordApproval(d, RECORDER, live),
  ])
  d.clock.advanceMinutes(1)
  const ids = records.filter((r) => r.status === 'fulfilled')
    .map((r) => (r as PromiseFulfilledResult<any>).value.approval_id as string)
  assert(ids.length >= 1)
  const sends = await Promise.allSettled(ids.map((id) => sendApprovedEmail(d, id, CALLER)))
  assertEquals(sends.filter((r) => r.status === 'fulfilled').length, 1)
  assertEquals(g.sends.length, 2) // the unknown first send, then exactly one resend
  const reconciled = d.store.claims.rows.filter((r) => r.state === 'reconciled_not_sent' && r.attempt_id === `approved_send:${first}`)
  // The first attempt held the approval key and the delivery key; both are released together.
  assertEquals(reconciled.map((r) => r.item_key.split(':')[0]).sort(), ['approved_send', 'email_content'])
  for (const row of reconciled) {
    assertEquals(row.reconciled_by, RECORDER.actor)
    assert(row.reconcile_checked_at)
  }
})

Deno.test('AS5: after a checked re-approval, an approval recorded earlier stays held and only the checked one sends', async () => {
  let mode: SendBehaviour = 'timeout'
  const g = graphFake(() => mode)
  const d = deps(g.graph)
  const earlier = await record(d)
  const first = await record(d)
  await sendApprovedEmail(d, first, CALLER)
  mode = 'ok'
  const checked = await record(d, { sent_items_checked: true })
  const stale = await assertRejects(() => sendApprovedEmail(d, earlier, CALLER), ApprovedSendRefusal)
  assertEquals((stale as ApprovedSendRefusal).code, 'send_claim_held')
  // A second checked re-approval takes the hold over; the first checked one is then held.
  const later = await record(d, { sent_items_checked: true })
  const superseded = await assertRejects(() => sendApprovedEmail(d, checked, CALLER), ApprovedSendRefusal)
  assertEquals((superseded as ApprovedSendRefusal).code, 'send_claim_held')
  assertEquals((await sendApprovedEmail(d, later, CALLER)).body.state, 'sent')
  assertEquals(g.sends.length, 2)
})

Deno.test('Codex4: a 2xx final send carrying an error is outcome_unknown, never sent', async () => {
  const g = graphFake(() => 'error_body_2xx')
  const d = deps(g.graph)
  const id = await record(d)
  const result = await sendApprovedEmail(d, id, CALLER)
  assertEquals(result.body.state, 'outcome_unknown')
  assertEquals(d.store.rows.get(id)!.status, 'outcome_unknown')
  await assertRejects(() => record(d), ApprovedSendRefusal)
})

Deno.test('Codex4: a 2xx final send with an unreadable body is outcome_unknown, never sent', async () => {
  const g = graphFake(() => 'unreadable_2xx')
  const d = deps(g.graph)
  const id = await record(d)
  const result = await sendApprovedEmail(d, id, CALLER)
  assertEquals(result.body.state, 'outcome_unknown')
  assertEquals(result.body.retry_safe, false)
})

Deno.test('a send claim that cannot be written sends nothing and leaves the approval unused', async () => {
  const g = graphFake(() => 'ok')
  const d = deps(g.graph)
  const id = await record(d)
  d.store.claims.failNext('claim_outbound_send')
  const refused = await assertRejects(() => sendApprovedEmail(d, id, CALLER), ApprovedSendRefusal)
  assertEquals((refused as ApprovedSendRefusal).status, 503)
  assertEquals(d.store.rows.get(id)!.status, 'approved')
  assertEquals(g.sends.length, 0)
  await tick()
})
