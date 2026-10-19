// The invoice email hold: every send of an invoice claims `invoice:<id>` in
// outbound_send_claims before anything goes out, so two presses together, an
// Outlook send beside a Xero-direct send, or a press after an unknown outcome
// cannot both send. A checked press reconciles the named attempt with who and
// when, never a live send. Covers both send paths of send_invoice_email
// (Outlook with to_email, and Xero direct without it). No network.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { _sendInvoiceEmailViaXeroDirect, _verifyAndSendInvoiceEmail } from "./index.ts"
import { XeroCooldownError } from "../_shared/xero_cooldown.ts"
import { makeFakeClaimStore } from "../_shared/outbound_send_claim_fake.ts"
import {
  INVOICE_EMAIL_EMAILED_EVENT,
  INVOICE_EMAIL_OUTCOME_RECONCILED_EVENT,
  INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT,
} from "./invoice_email_resend_gate.ts"
import {
  happyFixture,
  jsonBody,
  makeBody,
  makeStubClient,
  makeStubFetch,
  makeStubGetToken,
  makeStubLogBusinessEvent,
  makeStubXeroGet,
  STUB_ENV,
} from "./_test_helpers.ts"

const OUTLOOK_OK = () =>
  new Response(JSON.stringify({ success: true, accepted: true, delivered: null, delivery_status: "unverified", retry_safe: false }), { status: 202 })
const OUTLOOK_UNKNOWN = () => new Response(JSON.stringify({ state: "outcome_unknown", retry_safe: false }), { status: 502 })

function outlookDeps(
  outlookReply: () => Response | Promise<Response>,
  opts: { claims?: ReturnType<typeof makeFakeClaimStore>; bodyOverrides?: Record<string, unknown> } = {},
) {
  const fix = happyFixture()
  const claims = opts.claims ?? makeFakeClaimStore()
  const seed = { ...fix.seed, business_events: [] as any[], job_events: [] as any[], claims }
  const { client, calls } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const spy = makeStubFetch({
    "https://stub-xero.invalid/Invoices/": fix.fetchRoutes["https://stub-xero.invalid/Invoices/"],
    "https://stub-supabase.invalid/functions/v1/send-outlook-email": outlookReply,
  })
  const { getToken } = makeStubGetToken()
  const biz = makeStubLogBusinessEvent()
  return {
    seed, calls, spy, biz, claims,
    deps: (extra: Record<string, unknown> = {}) => ({
      client, body: makeBody({ ...(opts.bodyOverrides ?? {}), ...extra }), getToken, xeroGet,
      logBusinessEvent: biz.logBusinessEvent, fetch: spy.fetch, xeroFetch: spy.fetch, env: STUB_ENV,
    }),
  }
}

const outlookCalls = (spy: { calls: Array<{ url: string }> }) =>
  spy.calls.filter((c) => c.url.includes("send-outlook-email")).length

async function caught(p: Promise<unknown>): Promise<any> {
  try { await p } catch (e) { return e }
  throw new Error("expected a throw")
}

async function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: any }> {
  try { return { ok: true, value: await p } } catch (error) { return { ok: false, error } }
}

// ── Outlook path (to_email given) ──

Deno.test("outlook: an outcome_unknown reply is recorded unknown, says check Sent Items, and holds the next press", async () => {
  const t = outlookDeps(() => new Response(JSON.stringify({
    error: "raw provider text that must not be echoed", state: "outcome_unknown", retry_safe: false, code: "graph_outcome_unknown",
  }), { status: 502 }))

  const err = await caught(_verifyAndSendInvoiceEmail(t.deps()))
  assertEquals(err.status, 502)
  assertEquals(err.body.code, "invoice_email_outcome_unknown")
  assertEquals(err.body.retry_safe, false)
  assert(/Sent Items/.test(err.body.error))
  assert(!/nothing was sent/i.test(err.body.error))
  assert(!JSON.stringify(err.body).includes("raw provider text"))
  assertEquals(outlookCalls(t.spy), 1)
  assertEquals(t.claims.rowsFor("invoice:inv-123").map((r) => r.state), ["outcome_unknown"])

  // Second press: refused on the server, send-outlook-email not called again.
  const second = await _verifyAndSendInvoiceEmail(t.deps())
  assertEquals(second.status, 409)
  const body = await jsonBody(second)
  assertEquals(body.code, "invoice_email_outcome_unreconciled")
  assertEquals(body.retry_safe, false)
  assertEquals(body.state, "outcome_unknown")
  assert(/Sent Items/.test(body.recovery_action))
  assertEquals(outlookCalls(t.spy), 1)
})

Deno.test("outlook: a thrown fetch, an unreadable body, a bare 5xx and a bodyless 403 are all unknown", async () => {
  const replies: Array<() => Response | Promise<Response>> = [
    () => { throw new Error("connection reset") },
    () => new Response("<html>bad gateway</html>", { status: 502 }),
    () => new Response(JSON.stringify({ error: "x" }), { status: 503 }),
    () => new Response(null, { status: 403 }),
    () => new Response("Forbidden", { status: 401 }),
    () => new Response(JSON.stringify({ error: "denied", outcomeUnknown: true }), { status: 403 }),
    () => new Response(JSON.stringify({ error: { message: "x", outcome_unknown: true }, retry_safe: true }), { status: 400 }),
  ]
  for (const [i, reply] of replies.entries()) {
    const t = outlookDeps(reply)
    const err = await caught(_verifyAndSendInvoiceEmail(t.deps()))
    assertEquals(err.body.code, "invoice_email_outcome_unknown", `reply ${i}`)
    assertEquals((await _verifyAndSendInvoiceEmail(t.deps())).status, 409, `reply ${i} holds`)
    assertEquals(outlookCalls(t.spy), 1, `reply ${i} sent once`)
  }
})

Deno.test("outlook: a 2xx that does not say success, or cannot be read, is unknown and holds", async () => {
  const replies: Array<() => Response> = [
    () => new Response(JSON.stringify({ success: false, error: "x" }), { status: 200 }),
    () => new Response(JSON.stringify({ success: true, state: "outcome_unknown" }), { status: 202 }),
    () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    () => new Response("<html>ok</html>", { status: 200 }),
    () => new Response("", { status: 204 }),
  ]
  for (const [i, reply] of replies.entries()) {
    const t = outlookDeps(reply)
    const err = await caught(_verifyAndSendInvoiceEmail(t.deps()))
    assertEquals(err.body.code, "invoice_email_outcome_unknown", `reply ${i}`)
    assertEquals(err.body.retry_safe, false)
    assertEquals((await _verifyAndSendInvoiceEmail(t.deps())).status, 409, `reply ${i} holds`)
    assertEquals(t.claims.rowsFor("invoice:inv-123")[0].state, "outcome_unknown")
  }
})

Deno.test("outlook: a reply that proves nothing was sent stays retry-safe and does not hold", async () => {
  const t = outlookDeps(() => new Response(JSON.stringify({ error: "x", retry_safe: true, code: "graph_draft_failed" }), { status: 502 }))
  const err = await caught(_verifyAndSendInvoiceEmail(t.deps()))
  assertEquals(err.body.code, "invoice_email_failed")
  assertEquals(err.body.retry_safe, true)
  assert(!t.seed.job_events.some((r) => r.event_type === INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT))
  await caught(_verifyAndSendInvoiceEmail(t.deps())) // sends again: same failure, not a 409
  assertEquals(outlookCalls(t.spy), 2)
  assertEquals(t.claims.rowsFor("invoice:inv-123").map((r) => r.state), ["failed", "failed"])
})

Deno.test("outlook: a success settles the claim sent and passes the claim to send-outlook-email", async () => {
  const t = outlookDeps(OUTLOOK_OK)
  assertEquals((await _verifyAndSendInvoiceEmail(t.deps())).status, 200)
  const row = t.claims.rowsFor("invoice:inv-123")[0]
  assertEquals(row.state, "sent")
  const sent = JSON.parse(String(t.spy.calls.find((c) => c.url.includes("send-outlook-email"))!.init?.body))
  assertEquals(sent.send_claim, { item_key: "invoice:inv-123", attempt_id: row.attempt_id })
})

Deno.test("outlook: sent_items_checked reconciles the named attempt with who checked, then sends", async () => {
  let n = 0
  const t = outlookDeps(() => (n++ === 0 ? OUTLOOK_UNKNOWN() : OUTLOOK_OK()))
  await caught(_verifyAndSendInvoiceEmail(t.deps()))
  const ok = await _verifyAndSendInvoiceEmail(t.deps({ sent_items_checked: true, checked_by: "jan@secureworkswa.com.au" }))
  assertEquals(ok.status, 200)
  assertEquals(outlookCalls(t.spy), 2)
  const rows = t.claims.rowsFor("invoice:inv-123")
  assertEquals(rows.map((r) => r.state), ["reconciled_not_sent", "sent"])
  assertEquals(rows[0].reconciled_by, "jan@secureworkswa.com.au")
  assert(rows[0].reconcile_checked_at)
  assert(t.seed.job_events.some((r) => r.event_type === INVOICE_EMAIL_OUTCOME_RECONCILED_EVENT))
})

Deno.test("outlook: a checked press with no named checker is refused and sends nothing", async () => {
  const t = outlookDeps(OUTLOOK_UNKNOWN)
  await caught(_verifyAndSendInvoiceEmail(t.deps()))
  const resp = await _verifyAndSendInvoiceEmail(t.deps({ sent_items_checked: true }))
  assertEquals(resp.status, 409)
  assertEquals((await jsonBody(resp)).code, "send_reconcile_actor_required")
  assertEquals(outlookCalls(t.spy), 1)
  assertEquals(t.claims.rowsFor("invoice:inv-123").map((r) => r.state), ["outcome_unknown"])
})

Deno.test("outlook: a hold that cannot be written or read refuses before any PDF or Outlook call", async () => {
  for (const fn of ["claim_outbound_send", "read_outbound_send_holds"] as const) {
    const t = outlookDeps(OUTLOOK_OK)
    t.claims.fail(fn)
    const resp = await _verifyAndSendInvoiceEmail(t.deps(fn === "read_outbound_send_holds" ? { sent_items_checked: true, checked_by: "jan" } : {}))
    assertEquals(resp.status, 503, fn)
    assertEquals((await jsonBody(resp)).code, "invoice_email_hold_unavailable")
    assertEquals(t.spy.calls.length, 0)
  }
})

Deno.test("outlook: a settle that cannot be written after an unknown still holds the next press", async () => {
  const t = outlookDeps(OUTLOOK_UNKNOWN)
  t.claims.failNext("settle_outbound_send")
  await caught(_verifyAndSendInvoiceEmail(t.deps()))
  assertEquals(t.claims.rowsFor("invoice:inv-123")[0].state, "sending")
  assertEquals((await _verifyAndSendInvoiceEmail(t.deps())).status, 409)
  // Past the lease it reads uncertain, and only a checked press releases it.
  t.claims.advance(901_000)
  const held = await _verifyAndSendInvoiceEmail(t.deps())
  assertEquals((await jsonBody(held)).state, "outcome_unknown")
  assertEquals(outlookCalls(t.spy), 1)
})

Deno.test("outlook: a later invoice.emailed record never clears an earlier unknown", async () => {
  const t = outlookDeps(OUTLOOK_UNKNOWN)
  await caught(_verifyAndSendInvoiceEmail(t.deps()))
  const later = new Date(Date.now() + 60_000).toISOString()
  t.seed.business_events.push({ entity_type: "xero_invoice", entity_id: "inv-123", event_type: INVOICE_EMAIL_EMAILED_EVENT, occurred_at: later })
  t.seed.job_events.push({ job_id: "job-uuid-1", event_type: INVOICE_EMAIL_EMAILED_EVENT, detail_json: { xero_invoice_id: "inv-123" }, created_at: later })
  assertEquals((await _verifyAndSendInvoiceEmail(t.deps())).status, 409)
  assertEquals(outlookCalls(t.spy), 1)
})

Deno.test("IE1: two presses of the same invoice together send exactly once", async () => {
  const t = outlookDeps(OUTLOOK_UNKNOWN)
  const results = await Promise.all([settled(_verifyAndSendInvoiceEmail(t.deps())), settled(_verifyAndSendInvoiceEmail(t.deps()))])
  assertEquals(outlookCalls(t.spy), 1)
  const refused = results.filter((r) => r.ok && (r.value as Response).status === 409)
  assertEquals(refused.length, 1)
})

// ── Xero direct path (no to_email) ──

function xeroDirectDeps(
  postEmail: () => Promise<any>,
  opts: { claims?: ReturnType<typeof makeFakeClaimStore>; jobId?: string | null; captureOff?: boolean } = {},
) {
  const claims = opts.claims ?? makeFakeClaimStore()
  const seed = { business_events: [] as any[], job_events: [] as any[], claims }
  const { client } = makeStubClient(seed)
  const { getToken } = makeStubGetToken()
  const biz = makeStubLogBusinessEvent()
  // The capture lane switched off: logBusinessEvent writes nothing.
  const logBusinessEvent = opts.captureOff ? async () => {} : biz.logBusinessEvent
  let posts = 0
  return {
    seed, biz, claims, posts: () => posts,
    deps: (extra: Record<string, unknown> = {}) => ({
      client, body: { xero_invoice_id: "inv-123", ...extra }, getToken,
      logBusinessEvent, jobId: opts.jobId === undefined ? "job-uuid-1" : opts.jobId,
      postEmail: async () => { posts++; return await postEmail() },
    }),
  }
}

Deno.test("xero direct: a failed POST is unknown, says check Xero, and holds the next press", async () => {
  let first = true
  const t = xeroDirectDeps(async () => {
    if (first) { first = false; throw new Error("Xero API /Invoices/inv-123/Email failed (500): raw") }
    return {}
  })
  const err = await caught(_sendInvoiceEmailViaXeroDirect(t.deps()))
  assertEquals(err.body.code, "invoice_email_outcome_unknown")
  assert(/History in Xero/.test(err.body.error))
  assert(!JSON.stringify(err.body).includes("raw"))
  const second = await _sendInvoiceEmailViaXeroDirect(t.deps())
  assertEquals(second.status, 409)
  assertEquals(t.posts(), 1)
  const third = await _sendInvoiceEmailViaXeroDirect(t.deps({ sent_items_checked: true, checked_by: "jan" }))
  assertEquals(third.status, 200, "reconciled press sends again")
  assertEquals(t.posts(), 2)
})

Deno.test("xero direct: a validation refusal or a cooldown does not hold the next press", async () => {
  const refused = xeroDirectDeps(async () => { throw new Error("Xero validation error: no email address") })
  assertEquals((await caught(_sendInvoiceEmailViaXeroDirect(refused.deps()))).body.code, "invoice_email_refused")
  await caught(_sendInvoiceEmailViaXeroDirect(refused.deps()))
  assertEquals(refused.posts(), 2)

  const cooled = xeroDirectDeps(async () => {
    throw new XeroCooldownError("cooldown", 429, "XERO_COOLDOWN_ACTIVE", { provider_call_made: false })
  })
  assert((await caught(_sendInvoiceEmailViaXeroDirect(cooled.deps()))) instanceof XeroCooldownError)
  assertEquals(cooled.seed.job_events.length, 0)
  assertEquals(cooled.claims.rowsFor("invoice:inv-123")[0].state, "failed")
})

Deno.test("xero direct: a reply that carries an error is unknown, and a 204 is sent", async () => {
  for (const reply of [{ ErrorNumber: 10, Type: "ValidationException" }, { Elements: [{ ValidationErrors: [{ Message: "x" }] }] }, null, []]) {
    const t = xeroDirectDeps(async () => reply)
    const err = await caught(_sendInvoiceEmailViaXeroDirect(t.deps()))
    assertEquals(err.body.code, "invoice_email_outcome_unknown", JSON.stringify(reply))
    assertEquals((await _sendInvoiceEmailViaXeroDirect(t.deps())).status, 409)
  }
  const ok = xeroDirectDeps(async () => ({}))
  assertEquals((await _sendInvoiceEmailViaXeroDirect(ok.deps())).status, 200)
  assertEquals(ok.claims.rowsFor("invoice:inv-123")[0].state, "sent")
  assertEquals(ok.seed.job_events[0].detail_json.xero_invoice_id, "inv-123")
})

Deno.test("xero direct: an unlinked invoice with the capture lane off still holds after an unknown", async () => {
  const t = xeroDirectDeps(async () => { throw new Error("socket hang up") }, { jobId: null, captureOff: true })
  await caught(_sendInvoiceEmailViaXeroDirect(t.deps()))
  assertEquals(t.seed.job_events.length, 0)
  assertEquals(t.seed.business_events.length, 0)
  assertEquals((await _sendInvoiceEmailViaXeroDirect(t.deps())).status, 409)
  assertEquals(t.posts(), 1)
})

Deno.test("IE6: two checked presses together after an unknown send exactly once", async () => {
  let first = true
  const t = xeroDirectDeps(async () => {
    if (first) { first = false; throw new Error("socket hang up") }
    return {}
  })
  await caught(_sendInvoiceEmailViaXeroDirect(t.deps()))
  const results = await Promise.all([
    settled(_sendInvoiceEmailViaXeroDirect(t.deps({ sent_items_checked: true, checked_by: "jan" }))),
    settled(_sendInvoiceEmailViaXeroDirect(t.deps({ sent_items_checked: true, checked_by: "shaun" }))),
  ])
  assertEquals(t.posts(), 2, "one resend on top of the first post")
  assertEquals(results.filter((r) => r.ok && (r.value as Response).status === 200).length, 1)
})

Deno.test("xero direct: a checked press never releases a send still in progress", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const t = xeroDirectDeps(async () => { await gate; return {} })
  const inFlight = _sendInvoiceEmailViaXeroDirect(t.deps())
  await new Promise((r) => setTimeout(r, 0))
  const checked = await _sendInvoiceEmailViaXeroDirect(t.deps({ sent_items_checked: true, checked_by: "jan" }))
  assertEquals(checked.status, 409)
  assertEquals((await jsonBody(checked)).code, "send_reconcile_live_send")
  release()
  assertEquals((await inFlight).status, 200)
  assertEquals(t.posts(), 1)
})

Deno.test("alternate door: an Outlook send and a Xero-direct send of one invoice together send once", async () => {
  const claims = makeFakeClaimStore()
  const o = outlookDeps(OUTLOOK_OK, { claims })
  const x = xeroDirectDeps(async () => ({}), { claims })
  await Promise.all([settled(_verifyAndSendInvoiceEmail(o.deps())), settled(_sendInvoiceEmailViaXeroDirect(x.deps()))])
  assertEquals(outlookCalls(o.spy) + x.posts(), 1)
})

Deno.test("alternate door: an unknown Outlook send holds a Xero-direct send of the same invoice", async () => {
  const claims = makeFakeClaimStore()
  const o = outlookDeps(OUTLOOK_UNKNOWN, { claims })
  const x = xeroDirectDeps(async () => ({}), { claims })
  await caught(_verifyAndSendInvoiceEmail(o.deps()))
  assertEquals((await _sendInvoiceEmailViaXeroDirect(x.deps())).status, 409)
  assertEquals(x.posts(), 0)
})
