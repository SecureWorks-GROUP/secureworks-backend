// Every door that emails an invoice holds the one claim `invoice:<id>` before
// anything goes out: create_invoice with send_email, update_invoice with
// resend_email, approve_and_send_invoice (claimed before the Xero authorise),
// send_invoice_email (Outlook and Xero direct) and send-quote's branded email
// (see send-quote/invoice_shared_send_test.ts). An unknown-send event written
// before the claim store holds them too, and the make-safe pack claims before
// it prepares anything. Each case runs two doors together, or a door against
// a hold, over the in-memory claim store. No network.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import {
  _approveAndSendInvoice,
  _sendCreatedInvoiceEmail,
  _sendInvoiceEmailViaXeroDirect,
  _verifyAndSendInvoiceEmail,
  updateInvoice,
} from "./index.ts"
import { makeFakeClaimStore } from "../_shared/outbound_send_claim_fake.ts"
import { confirmSendDispatch, extendSendClaim } from "../_shared/outbound_send_claim.ts"
import { INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT } from "./invoice_email_resend_gate.ts"
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

type Claims = ReturnType<typeof makeFakeClaimStore>

async function caught(p: Promise<unknown>): Promise<any> {
  try { await p } catch (e) { return e }
  throw new Error("expected a throw")
}

async function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: any }> {
  try { return { ok: true, value: await p } } catch (error) { return { ok: false, error } }
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

function invoiceSeed(claims: Claims, extra: Record<string, unknown> = {}) {
  return {
    xero_invoices: {
      "inv-123": {
        xero_invoice_id: "inv-123", invoice_number: "INV-001", job_id: "job-uuid-1",
        invoice_type: "ACCREC", status: "DRAFT", total: 110, xero_contact_id: "xero-contact-1",
      },
    },
    jobs: { "job-uuid-1": { id: "job-uuid-1", client_email: "client@example.com", client_name: "Jane", type: "fencing" } },
    business_events: [] as any[],
    job_events: [] as any[],
    claims,
    ...extra,
  }
}

// A Xero-direct send_invoice_email press whose post is counted.
function xeroDirect(claims: Claims, postEmail: () => Promise<any>, seedExtra: Record<string, unknown> = {}) {
  const seed = invoiceSeed(claims, seedExtra)
  const { client } = makeStubClient(seed as any)
  const { getToken } = makeStubGetToken()
  const biz = makeStubLogBusinessEvent()
  let posts = 0
  return {
    seed, client, posts: () => posts,
    deps: (extra: Record<string, unknown> = {}) => ({
      client, body: { xero_invoice_id: "inv-123", ...extra }, getToken,
      logBusinessEvent: biz.logBusinessEvent, jobId: "job-uuid-1",
      postEmail: async () => { posts++; return await postEmail() },
    }),
  }
}

// Leave the invoice held: one Xero-direct send whose outcome is unknown.
async function holdInvoice(claims: Claims) {
  const t = xeroDirect(claims, async () => { throw new Error("socket hang up") })
  await caught(_sendInvoiceEmailViaXeroDirect(t.deps()))
  assertEquals(claims.rowsFor("invoice:inv-123")[0].state, "outcome_unknown")
}

// ── create_invoice with send_email ──

Deno.test("create door: create_invoice's email and a send_invoice_email press together send once", async () => {
  const claims = makeFakeClaimStore()
  const x = xeroDirect(claims, async () => { await tick(); return {} })
  let createPosts = 0
  const results = await Promise.all([
    settled(_sendCreatedInvoiceEmail(x.client, {
      xeroInvoiceId: "inv-123", invoiceNumber: "INV-001", jobId: "job-uuid-1", actor: "ops@secureworkswa.com.au",
      postEmail: async () => { createPosts++; await tick(); return {} },
    })),
    settled(_sendInvoiceEmailViaXeroDirect(x.deps())),
  ])
  assertEquals(createPosts + x.posts(), 1, "exactly one email reached Xero")
  const created = results[0]
  assert(created.ok)
  const pressed = results[1]
  assert(pressed.ok)
  const accepted = (created.value as any).status === "accepted" ? 1 : 0
  const pressedOk = (pressed.value as Response).status === 200 ? 1 : 0
  assertEquals(accepted + pressedOk, 1)
})

Deno.test("create door: a held invoice is created without an email, and the refusal is named", async () => {
  const claims = makeFakeClaimStore()
  await holdInvoice(claims)
  const { client } = makeStubClient(invoiceSeed(claims) as any)
  let posts = 0
  const out = await _sendCreatedInvoiceEmail(client, {
    xeroInvoiceId: "inv-123", invoiceNumber: "INV-001", jobId: "job-uuid-1", actor: null,
    postEmail: async () => { posts++; return {} },
  })
  assertEquals(posts, 0)
  assertEquals(out.status, "failed")
  assertEquals(out.error?.code, "invoice_email_outcome_unreconciled")
})

// ── update_invoice with resend_email ──

Deno.test("update door: update_invoice with resend_email is refused while an earlier send is unknown", async () => {
  const claims = makeFakeClaimStore()
  await holdInvoice(claims)
  const { client } = makeStubClient(invoiceSeed(claims) as any)
  const realFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = (async () => { fetches++; throw new Error("no network in this test") }) as typeof fetch
  try {
    const err = await caught(updateInvoice(client, {
      xero_invoice_id: "inv-123",
      line_items: [{ description: "Fence", quantity: 1, unit_price: 100 }],
      resend_email: true,
    }, client))
    assertEquals(err.status, 409, String(err?.message))
    assertEquals(err.body?.code, "invoice_email_outcome_unreconciled")
    assertEquals(err.body?.updated, false)
  } finally {
    globalThis.fetch = realFetch
  }
  assertEquals(fetches, 0, "nothing reached Xero: no edit, no email")
  assertEquals(claims.rowsFor("invoice:inv-123").length, 1)
})

// ── Outlook door with send-outlook-email's own dispatch open ──

Deno.test("outlook door: a fetch failure after send-outlook-email opened its dispatch is held as live", async () => {
  const claims = makeFakeClaimStore()
  const fix = happyFixture()
  const seed = { ...fix.seed, business_events: [] as any[], job_events: [] as any[], claims }
  const { client } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  let outlookCalls = 0
  // send-outlook-email joins the attempt, confirms its own dispatch, then the
  // connection drops before ops-api reads the answer.
  const spy = makeStubFetch({
    "https://stub-xero.invalid/Invoices/": fix.fetchRoutes["https://stub-xero.invalid/Invoices/"],
    "https://stub-supabase.invalid/functions/v1/send-outlook-email": async () => {
      outlookCalls++
      const last = spy.calls[spy.calls.length - 1]
      const sent = JSON.parse(String(last.init?.body))
      const joined = await extendSendClaim({ rpc: claims.rpc } as any, {
        attemptId: sent.send_claim.attempt_id, keys: ["outlook_message:inv-123"], callerItemKey: sent.send_claim.item_key,
      })
      assert(joined.ok, JSON.stringify(joined))
      const fence = await confirmSendDispatch({ rpc: claims.rpc } as any, {
        attemptId: sent.send_claim.attempt_id, dispatchToken: (joined as any).dispatch_token,
      })
      assert(fence.ok, JSON.stringify(fence))
      throw new Error("connection reset by peer")
    },
  })
  const { getToken } = makeStubGetToken()
  const biz = makeStubLogBusinessEvent()
  const deps = (extra: Record<string, unknown> = {}) => ({
    client, body: makeBody(extra), getToken, xeroGet,
    logBusinessEvent: biz.logBusinessEvent, fetch: spy.fetch, xeroFetch: spy.fetch, env: STUB_ENV,
  })
  await caught(_verifyAndSendInvoiceEmail(deps()))
  const checked = await _verifyAndSendInvoiceEmail(deps({ sent_items_checked: true, checked_by: "jan@secureworkswa.com.au" }))
  assertEquals(checked.status, 409)
  assertEquals((await jsonBody(checked)).code, "send_reconcile_live_send")
  assertEquals(outlookCalls, 1, "the checked press sent nothing while the other door may still be sending")
})

// ── An unknown-send event from before the claim store ──

function legacyUnknownSeed(): Record<string, unknown> {
  return {
    business_events: [{
      event_type: INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT, entity_type: "xero_invoice", entity_id: "inv-123",
      occurred_at: "2026-10-01T00:00:00.000Z",
    }],
  }
}

Deno.test("legacy hold: an unknown event with an empty claim store holds, and two checked presses release once", async () => {
  const claims = makeFakeClaimStore()
  const t = xeroDirect(claims, async () => { await tick(); return {} }, legacyUnknownSeed())
  const unchecked = await _sendInvoiceEmailViaXeroDirect(t.deps())
  assertEquals(unchecked.status, 409)
  assertEquals((await jsonBody(unchecked)).code, "invoice_email_outcome_unreconciled")
  assertEquals(t.posts(), 0)

  const results = await Promise.all([
    settled(_sendInvoiceEmailViaXeroDirect(t.deps({ sent_items_checked: true, checked_by: "jan" }))),
    settled(_sendInvoiceEmailViaXeroDirect(t.deps({ sent_items_checked: true, checked_by: "shaun" }))),
  ])
  assertEquals(t.posts(), 1, "one release, one send")
  assertEquals(results.filter((r) => r.ok && (r.value as Response).status === 200).length, 1)
  assertEquals(results.filter((r) => r.ok && (r.value as Response).status === 409).length, 1)
  const reconciled = t.seed.job_events.filter((e: any) => e.event_type === "invoice.email_outcome_reconciled")
  assertEquals(reconciled.length, 1)
})

Deno.test("legacy hold: an unreadable event history refuses with 503 and sends nothing", async () => {
  const claims = makeFakeClaimStore()
  const t = xeroDirect(claims, async () => ({}), { read_errors: { business_events: "permission denied" } })
  const resp = await _sendInvoiceEmailViaXeroDirect(t.deps())
  assertEquals(resp.status, 503)
  assertEquals((await jsonBody(resp)).code, "invoice_email_hold_unavailable")
  assertEquals(t.posts(), 0)
  assertEquals(claims.rowsFor("invoice:inv-123").length, 0)
})

// ── Stricter acceptance ──

Deno.test("acceptance: a Xero reply that says success:false or carries an error is unknown and holds", async () => {
  const replies = [
    { success: false, error: "mailbox unavailable" },
    { Success: false },
    { error: "x" },
    { state: "outcome_unknown" },
    { retry_safe: false },
  ]
  for (const reply of replies) {
    const claims = makeFakeClaimStore()
    const t = xeroDirect(claims, async () => reply)
    const err = await caught(_sendInvoiceEmailViaXeroDirect(t.deps()))
    assertEquals(err.body?.code, "invoice_email_outcome_unknown", JSON.stringify(reply))
    assertEquals(claims.rowsFor("invoice:inv-123")[0].state, "outcome_unknown", JSON.stringify(reply))
    assertEquals((await _sendInvoiceEmailViaXeroDirect(t.deps())).status, 409, JSON.stringify(reply))
    assertEquals(t.posts(), 1)
  }
})

// ── approve_and_send_invoice ──

// The stub client plus the two shapes approve_and_send uses beyond reads:
// .single() and .update(...).eq(...).
function withWrites(client: any): any {
  return {
    rpc: (fn: string, args?: Record<string, unknown>) => client.rpc(fn, args),
    from(table: string) {
      const base = client.from(table)
      return {
        ...base,
        select(cols: string) {
          const s = base.select(cols)
          s.single = s.maybeSingle
          return s
        },
        update(_patch: unknown) {
          const u: any = { eq: () => u, then: (r: (v: any) => any) => Promise.resolve({ error: null }).then(r) }
          return u
        },
      }
    },
  }
}

function approveDeps(claims: Claims, opts: { branded: boolean; brandedReply?: () => Response }) {
  const { client: raw } = makeStubClient(invoiceSeed(claims) as any)
  const client = withWrites(raw)
  const counts = { authorise: 0, xeroEmail: 0, branded: 0, evidence: 0 }
  const { getToken } = makeStubGetToken()
  const deps = {
    client,
    body: { use_branded_email: opts.branded, operator_email: "ops@secureworkswa.com.au" },
    xeroInvoiceId: "inv-123",
    actor: "ops@secureworkswa.com.au",
    orgId: "org-1",
    getToken,
    xeroGet: async () => ({ OnlineInvoices: [{ OnlineInvoiceUrl: "https://in.xero.com/x" }] }),
    xeroPost: async (path: string) => {
      if (path.endsWith("/Email")) { counts.xeroEmail++; return {} }
      counts.authorise++
      return { Invoices: [{ InvoiceID: "inv-123", InvoiceNumber: "INV-001", Total: 110, Status: "AUTHORISED" }] }
    },
    fetch: (async () => {
      counts.branded++
      return opts.brandedReply ? opts.brandedReply() : new Response(JSON.stringify({ success: true }), { status: 200 })
    }) as unknown as typeof fetch,
    env: { SUPABASE_URL: "https://stub-supabase.invalid", SUPABASE_SERVICE_KEY: "stub" },
    writeAuthorisedEvidence: async () => { counts.evidence++ },
  }
  return { deps, counts }
}

Deno.test("approve_and_send: a held invoice refuses the whole action and authorises nothing", async () => {
  for (const branded of [false, true]) {
    const claims = makeFakeClaimStore()
    await holdInvoice(claims)
    const t = approveDeps(claims, { branded })
    const resp = await _approveAndSendInvoice(t.deps)
    assertEquals(resp.status, 409, `branded=${branded}`)
    const body = await jsonBody(resp)
    assertEquals(body.authorised, false)
    assertEquals(body.status_unchanged, true)
    assertEquals(t.counts.authorise, 0, `branded=${branded}: nothing authorised`)
    assertEquals(t.counts.evidence, 0)
    assertEquals(t.counts.branded + t.counts.xeroEmail, 0)
  }
})

Deno.test("approve_and_send: a claim store that cannot answer is 503 with nothing authorised", async () => {
  const claims = makeFakeClaimStore()
  claims.fail("claim_outbound_send")
  const t = approveDeps(claims, { branded: false })
  const resp = await _approveAndSendInvoice(t.deps)
  assertEquals(resp.status, 503)
  const body = await jsonBody(resp)
  assertEquals(body.code, "invoice_email_hold_unavailable")
  assertEquals(body.state, "not_sent")
  assertEquals(body.authorised, false)
  assertEquals(t.counts.authorise, 0)
})

Deno.test("approve_and_send: a branded reply that says success but outcome unknown is unknown and holds", async () => {
  const claims = makeFakeClaimStore()
  const t = approveDeps(claims, {
    branded: true,
    brandedReply: () => new Response(JSON.stringify({ success: true, state: "outcome_unknown", retry_safe: false }), { status: 200 }),
  })
  const resp = await _approveAndSendInvoice(t.deps)
  assertEquals(resp.status, 200)
  const body = await jsonBody(resp)
  assertEquals(body.branded_email_sent, false)
  assertEquals(body.email_outcome_unknown, true)
  assertEquals(claims.rowsFor("invoice:inv-123")[0].state, "outcome_unknown")
  const x = xeroDirect(claims, async () => ({}))
  assertEquals((await _sendInvoiceEmailViaXeroDirect(x.deps())).status, 409)
  assertEquals(x.posts(), 0)
})

// The make-safe pack's claim-store-down case lives with the make-safe harness:
// makesafe_resume_phase1b_test.ts ("send_pack: a claim store that cannot answer ...").
