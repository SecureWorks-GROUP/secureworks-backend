// The invoice email resend gate: after an outcome we cannot confirm, the next
// press is refused until someone has checked Sent Items and said so. Covers the
// pure rule, the fail-closed read, and both send paths of send_invoice_email
// (Outlook with to_email, and Xero direct without it). No network.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { _sendInvoiceEmailViaXeroDirect, _verifyAndSendInvoiceEmail } from "./index.ts"
import { XeroCooldownError } from "../_shared/xero_cooldown.ts"
import {
  INVOICE_EMAIL_EMAILED_EVENT,
  INVOICE_EMAIL_OUTCOME_RECONCILED_EVENT,
  INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT,
  invoiceEmailGateFromRows,
  readInvoiceEmailGate,
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

// ── The pure rule ──

Deno.test("gate: no rows is clear", () => {
  assertEquals(invoiceEmailGateFromRows([]), { state: "clear" })
})

Deno.test("gate: newest row unknown holds the send", () => {
  const gate = invoiceEmailGateFromRows([
    { event_type: INVOICE_EMAIL_EMAILED_EVENT, at: "2026-10-19T01:00:00Z" },
    { event_type: INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT, at: "2026-10-19T02:00:00Z" },
  ])
  assertEquals(gate, { state: "unreconciled", unknown_since: "2026-10-19T02:00:00Z" })
})

Deno.test("gate: a later reconcile or a later confirmed send clears it", () => {
  for (const later of [INVOICE_EMAIL_OUTCOME_RECONCILED_EVENT, INVOICE_EMAIL_EMAILED_EVENT]) {
    const gate = invoiceEmailGateFromRows([
      { event_type: INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT, at: "2026-10-19T02:00:00Z" },
      { event_type: later, at: "2026-10-19T03:00:00Z" },
    ])
    assertEquals(gate, { state: "clear" }, later)
  }
})

Deno.test("gate: an unknown in either store holds it (job_events alone, business_events off)", async () => {
  const { client } = makeStubClient({
    business_events: [],
    job_events: [{
      job_id: "job-1", event_type: INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT,
      detail_json: { xero_invoice_id: "inv-123" }, created_at: "2026-10-19T02:00:00Z",
    }],
  })
  assertEquals((await readInvoiceEmailGate(client, "inv-123")).state, "unreconciled")
  assertEquals((await readInvoiceEmailGate(client, "inv-other")).state, "clear")
})

Deno.test("gate: an unreadable store refuses, never reads as clear", async () => {
  for (const table of ["business_events", "job_events"]) {
    const { client } = makeStubClient({ read_errors: { [table]: "timeout" } })
    assertEquals((await readInvoiceEmailGate(client, "inv-123")).state, "unreadable", table)
  }
  const throwing = { from() { throw new Error("transport down") } }
  assertEquals((await readInvoiceEmailGate(throwing, "inv-123")).state, "unreadable")
})

// ── Outlook path (to_email given) ──

function outlookDeps(outlookReply: () => Response | Promise<Response>, bodyOverrides: Record<string, unknown> = {}) {
  const fix = happyFixture()
  const seed = { ...fix.seed, business_events: [] as any[], job_events: [] as any[] }
  const { client, calls } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const spy = makeStubFetch({
    "https://stub-xero.invalid/Invoices/": fix.fetchRoutes["https://stub-xero.invalid/Invoices/"],
    "https://stub-supabase.invalid/functions/v1/send-outlook-email": outlookReply,
  })
  const { getToken } = makeStubGetToken()
  const biz = makeStubLogBusinessEvent()
  return {
    seed, calls, spy, biz,
    deps: (extra: Record<string, unknown> = {}) => ({
      client, body: makeBody({ ...bodyOverrides, ...extra }), getToken, xeroGet,
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
  assert(t.seed.job_events.some((r) => r.event_type === INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT))
  assertEquals(outlookCalls(t.spy), 1)

  // Second press: refused on the server, send-outlook-email not called again.
  const second = await _verifyAndSendInvoiceEmail(t.deps())
  assertEquals(second.status, 409)
  assertEquals((await jsonBody(second)).code, "invoice_email_outcome_unreconciled")
  assertEquals(outlookCalls(t.spy), 1)
})

Deno.test("outlook: a thrown fetch, an unreadable body and a bare 5xx are all unknown", async () => {
  const replies: Array<() => Response | Promise<Response>> = [
    () => { throw new Error("connection reset") },
    () => new Response("<html>bad gateway</html>", { status: 502 }),
    () => new Response(JSON.stringify({ error: "x" }), { status: 503 }),
  ]
  for (const reply of replies) {
    const t = outlookDeps(reply)
    const err = await caught(_verifyAndSendInvoiceEmail(t.deps()))
    assertEquals(err.body.code, "invoice_email_outcome_unknown")
    assertEquals((await _verifyAndSendInvoiceEmail(t.deps())).status, 409)
  }
})

Deno.test("outlook: a reply that says nothing was sent stays retry-safe and does not hold", async () => {
  const t = outlookDeps(() => new Response(JSON.stringify({ error: "x", retry_safe: true, code: "graph_draft_failed" }), { status: 502 }))
  const err = await caught(_verifyAndSendInvoiceEmail(t.deps()))
  assertEquals(err.body.code, "invoice_email_failed")
  assertEquals(err.body.retry_safe, true)
  assert(!t.seed.job_events.some((r) => r.event_type === INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT))
  await caught(_verifyAndSendInvoiceEmail(t.deps())) // sends again: same failure, not a 409
  assertEquals(outlookCalls(t.spy), 2)
})

Deno.test("outlook: sent_items_checked reconciles the hold, records it, and sends", async () => {
  let n = 0
  const t = outlookDeps(() => (n++ === 0
    ? new Response(JSON.stringify({ state: "outcome_unknown", retry_safe: false }), { status: 502 })
    : new Response(JSON.stringify({ ok: true }), { status: 200 })))
  await caught(_verifyAndSendInvoiceEmail(t.deps()))
  const ok = await _verifyAndSendInvoiceEmail(t.deps({ sent_items_checked: true }))
  assertEquals(ok.status, 200)
  assertEquals(outlookCalls(t.spy), 2)
  assert(t.seed.job_events.some((r) => r.event_type === INVOICE_EMAIL_OUTCOME_RECONCILED_EVENT))
  assert(t.biz.events.some((e) => e.event_type === INVOICE_EMAIL_OUTCOME_RECONCILED_EVENT))
})

Deno.test("outlook: an unreadable gate refuses before any PDF or Outlook call", async () => {
  const t = outlookDeps(() => new Response("{}", { status: 200 }))
  ;(t.seed as any).read_errors = { job_events: "timeout" }
  const resp = await _verifyAndSendInvoiceEmail(t.deps())
  assertEquals(resp.status, 409)
  assertEquals((await jsonBody(resp)).code, "invoice_email_gate_unreadable")
  assertEquals(t.spy.calls.length, 0)
})

// ── Xero direct path (no to_email) ──

function xeroDirectDeps(postEmail: () => Promise<any>) {
  const seed = { business_events: [] as any[], job_events: [] as any[] }
  const { client } = makeStubClient(seed)
  const { getToken } = makeStubGetToken()
  const biz = makeStubLogBusinessEvent()
  let posts = 0
  return {
    seed, biz, posts: () => posts,
    deps: (extra: Record<string, unknown> = {}) => ({
      client, body: { xero_invoice_id: "inv-123", ...extra }, getToken,
      logBusinessEvent: biz.logBusinessEvent, jobId: "job-uuid-1",
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
  const third = await _sendInvoiceEmailViaXeroDirect(t.deps({ sent_items_checked: true }))
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
})

Deno.test("xero direct: a confirmed send writes invoice.emailed with the invoice id the gate reads", async () => {
  const t = xeroDirectDeps(async () => ({}))
  assertEquals((await _sendInvoiceEmailViaXeroDirect(t.deps())).status, 200)
  assertEquals(t.seed.job_events[0].detail_json.xero_invoice_id, "inv-123")
})
