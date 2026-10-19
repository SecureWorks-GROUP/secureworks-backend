// send-quote's branded invoice email (/send-invoice) holds the same claim,
// `invoice:<id>`, as every ops-api door, before its own invoice_email_send_claims
// row and Resend idempotency key. It is sent only with a Resend message id; a
// 5xx, a throw or a 2xx with no id is unknown and holds the other doors. No
// network: the claim store is in memory and Resend is a stub.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { makeFakeClaimStore } from "../_shared/outbound_send_claim_fake.ts"
import { invoiceSendKey } from "../_shared/outbound_send_claim.ts"
import { _sendInvoiceEmailViaXeroDirect, _verifyAndSendInvoiceEmail } from "../ops-api/index.ts"
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
} from "../ops-api/_test_helpers.ts"
import { dispatchInvoiceResend, takeSharedInvoiceSend } from "./invoice_shared_send.ts"

type Claims = ReturnType<typeof makeFakeClaimStore>

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

async function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: any }> {
  try { return { ok: true, value: await p } } catch (error) { return { ok: false, error } }
}

function sendQuoteClient(claims: Claims) {
  return makeStubClient({ business_events: [], job_events: [], claims }).client
}

// One /send-invoice: take the shared hold, then call Resend under it.
async function brandedSend(claims: Claims, resend: () => Promise<Response>, counter: { calls: number }) {
  const sb = sendQuoteClient(claims)
  const shared = await takeSharedInvoiceSend(sb, { xeroInvoiceId: "inv-123", jobId: "job-uuid-1" })
  if (!shared.ok) return { refused: shared }
  const outcome = await dispatchInvoiceResend(sb, shared, async () => { counter.calls++; return await resend() })
  return { outcome }
}

function outlookPress(claims: Claims, reply: () => Response | Promise<Response>) {
  const fix = happyFixture()
  const seed = { ...fix.seed, business_events: [] as any[], job_events: [] as any[], claims }
  const { client } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const spy = makeStubFetch({
    "https://stub-xero.invalid/Invoices/": fix.fetchRoutes["https://stub-xero.invalid/Invoices/"],
    "https://stub-supabase.invalid/functions/v1/send-outlook-email": reply,
  })
  const { getToken } = makeStubGetToken()
  const biz = makeStubLogBusinessEvent()
  return {
    spy,
    outlookCalls: () => spy.calls.filter((c) => c.url.includes("send-outlook-email")).length,
    run: () => _verifyAndSendInvoiceEmail({
      client, body: makeBody(), getToken, xeroGet,
      logBusinessEvent: biz.logBusinessEvent, fetch: spy.fetch, xeroFetch: spy.fetch, env: STUB_ENV,
    }),
  }
}

const RESEND_OK = () => new Response(JSON.stringify({ id: "re_123" }), { status: 200 })
const OUTLOOK_OK = () =>
  new Response(JSON.stringify({ success: true, accepted: true, delivered: null, delivery_status: "unverified", retry_safe: false }), { status: 202 })

Deno.test("send-quote and an Outlook press of one invoice together send once", async () => {
  const claims = makeFakeClaimStore()
  const resend = { calls: 0 }
  const o = outlookPress(claims, async () => { await tick(); return OUTLOOK_OK() })
  await Promise.all([
    settled(brandedSend(claims, async () => { await tick(); return RESEND_OK() }, resend)),
    settled(o.run()),
  ])
  assertEquals(resend.calls + o.outlookCalls(), 1, "exactly one email went out")
})

Deno.test("a Resend 500 is unknown and holds an ops-api Outlook press of the same invoice", async () => {
  const claims = makeFakeClaimStore()
  const resend = { calls: 0 }
  const first = await brandedSend(claims, async () => new Response("upstream", { status: 500 }), resend)
  assertEquals(first.outcome?.kind, "unknown")
  assertEquals(claims.rowsFor(invoiceSendKey("inv-123"))[0].state, "outcome_unknown")
  const o = outlookPress(claims, OUTLOOK_OK)
  const resp = await o.run()
  assertEquals(resp.status, 409)
  assertEquals((await jsonBody(resp)).code, "invoice_email_outcome_unreconciled")
  assertEquals(o.outlookCalls(), 0)
})

Deno.test("a Resend 200 with no message id is unknown and holds the next send of the invoice", async () => {
  for (const body of ["{}", JSON.stringify({ id: "" }), "not json"]) {
    const claims = makeFakeClaimStore()
    const resend = { calls: 0 }
    const first = await brandedSend(claims, async () => new Response(body, { status: 200 }), resend)
    assertEquals(first.outcome?.kind, "unknown", body)
    const again = await brandedSend(claims, async () => RESEND_OK(), resend)
    assert(again.refused, `held after ${body}`)
    assertEquals(again.refused.status, 409)
    assertEquals(resend.calls, 1)
    const { getToken } = makeStubGetToken()
    const xero = await _sendInvoiceEmailViaXeroDirect({
      client: sendQuoteClient(claims), body: { xero_invoice_id: "inv-123" }, getToken,
      logBusinessEvent: async () => {}, jobId: "job-uuid-1", postEmail: async () => ({}),
    })
    assertEquals(xero.status, 409, `xero direct held after ${body}`)
  }
})

Deno.test("a Resend 200 with a message id is sent, and a definite 4xx is failed and releases", async () => {
  const claims = makeFakeClaimStore()
  const resend = { calls: 0 }
  const sent = await brandedSend(claims, async () => RESEND_OK(), resend)
  assertEquals(sent.outcome?.kind, "sent")
  assertEquals(claims.rowsFor(invoiceSendKey("inv-123"))[0].state, "sent")

  const other = makeFakeClaimStore()
  const rejected = await brandedSend(other, async () => new Response(JSON.stringify({ message: "invalid from" }), { status: 422 }), resend)
  assertEquals(rejected.outcome?.kind, "failed")
  assertEquals(other.rowsFor(invoiceSendKey("inv-123"))[0].state, "failed")
})

Deno.test("send-quote/index.ts takes the shared hold before its own claim and sends through it", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url))
  const shared = src.indexOf("takeSharedInvoiceSend(sb")
  const local = src.indexOf("claimInvoiceEmailSend(", shared)
  const dispatch = src.indexOf("dispatchInvoiceResend(sb, shared", shared)
  assert(shared > 0 && local > shared, "shared hold before the local invoice_email_send_claims row")
  assert(dispatch > local, "Resend is called through dispatchInvoiceResend")
  assert(src.indexOf("sendClaim: body?.send_claim", shared) > shared, "a caller's claim is joined")
})
