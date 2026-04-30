// Unit tests for ops-api/index.ts send_invoice_email Path B verification.
// Tests the exported _verifyAndSendInvoiceEmail helper with stubbed deps.
// No network. No live Xero. No live Supabase.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { _verifyAndSendInvoiceEmail } from "./index.ts"
import {
  makeStubClient,
  makeStubXeroGet,
  makeStubFetch,
  makeStubGetToken,
  makeStubLogBusinessEvent,
  STUB_ENV,
  jsonBody,
  makeBody,
  happyFixture,
} from "./_test_helpers.ts"

// Helper: assemble deps for a test. Caller can override any piece.
function makeDeps(overrides: Partial<Parameters<typeof _verifyAndSendInvoiceEmail>[0]> = {}) {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()
  return {
    client, body: makeBody(),
    getToken, xeroGet, logBusinessEvent, fetch,
    env: STUB_ENV,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────
// T1 — Bilal/Richard incident replay
// to_email = wrong, job_id = matches xero_invoices but to_email doesn't match contact
// ─────────────────────────────────────────────────────────────────
Deno.test("T1: mismatched to_email → 400 recipient_mismatch, no PDF/Outlook calls", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch, calls } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent, events } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ to_email: "stranger@hotmail.com" }),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 400)
  const j = await jsonBody(resp)
  assertEquals(j.code, "recipient_mismatch")
  assertEquals(j.received, "stranger@hotmail.com")
  assert(Array.isArray(j.expected) && j.expected.includes("client@example.com"))
  // No PDF or Outlook calls
  assertEquals(calls.length, 0)
  // No audit on rejection
  assertEquals(events.length, 0)
})

// ─────────────────────────────────────────────────────────────────
// T2 — Matching recipient succeeds, PDF + Outlook fetched ONLY after verification
// ─────────────────────────────────────────────────────────────────
Deno.test("T2: matching to_email → 200, PDF + Outlook called once each, audit written", async () => {
  const fix = happyFixture()
  const { client, calls: dbCalls } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch, calls: fetchCalls } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent, events } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody(),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 200)
  const j = await jsonBody(resp)
  assertEquals(j.success, true)
  assertEquals(j.emailed, true)
  assertEquals(j.via, "outlook")

  // Exactly one PDF GET + one Outlook POST
  const pdfCalls = fetchCalls.filter(c => c.url.startsWith(STUB_ENV.XERO_API_BASE))
  const outlookCalls = fetchCalls.filter(c => c.url.startsWith(`${STUB_ENV.SUPABASE_URL}/functions/v1/send-outlook-email`))
  assertEquals(pdfCalls.length, 1)
  assertEquals(outlookCalls.length, 1)

  // Audit written: business_events + job_events (linked path)
  assertEquals(events.length, 1)
  assertEquals(events[0].event_type, "invoice.emailed")
  assertEquals(events[0].job_id, "job-uuid-1")
  assertEquals(events[0].payload.linked, true)
  // job_events insert happens via stub client
  const jobEventInserts = dbCalls.inserts.filter(i => i.table === "job_events")
  assertEquals(jobEventInserts.length, 1)
  assertEquals(jobEventInserts[0].row.job_id, "job-uuid-1")
})

// ─────────────────────────────────────────────────────────────────
// T3 — Mismatched CC returns cc_recipient_mismatch
// ─────────────────────────────────────────────────────────────────
Deno.test("T3: mismatched CC → 400 cc_recipient_mismatch, Outlook not called", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch, calls } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ cc: "stranger@hotmail.com" }),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 400)
  const j = await jsonBody(resp)
  assertEquals(j.code, "cc_recipient_mismatch")
  assertEquals(j.received, "stranger@hotmail.com")
  assertEquals(calls.length, 0)
})

// ─────────────────────────────────────────────────────────────────
// T3b — CC array form is also rejected
// ─────────────────────────────────────────────────────────────────
Deno.test("T3b: CC array with stranger → 400 cc_recipient_mismatch", async () => {
  const deps = makeDeps({ body: makeBody({ cc: ["stranger@hotmail.com"] }) })
  const resp = await _verifyAndSendInvoiceEmail(deps)
  assertEquals(resp.status, 400)
  assertEquals((await jsonBody(resp)).code, "cc_recipient_mismatch")
})

// ─────────────────────────────────────────────────────────────────
// T3c — CC invalid shape rejected before any other check that would need it
// ─────────────────────────────────────────────────────────────────
Deno.test("T3c: CC object → 400 cc_invalid_shape", async () => {
  const deps = makeDeps({ body: makeBody({ cc: { not: "valid" } }) })
  const resp = await _verifyAndSendInvoiceEmail(deps)
  assertEquals(resp.status, 400)
  assertEquals((await jsonBody(resp)).code, "cc_invalid_shape")
})

// ─────────────────────────────────────────────────────────────────
// T4 — Xero lookup failure hard-stops before PDF/Outlook
// ─────────────────────────────────────────────────────────────────
Deno.test("T4: xeroGet throws → 400 xero_contact_lookup_failed, no PDF/Outlook", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: {}, throwOn: ["/Invoices/"] })
  const { fetch, calls } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent, events } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody(),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 400)
  const j = await jsonBody(resp)
  assertEquals(j.code, "xero_contact_lookup_failed")
  assert(typeof j.detail === "string" && j.detail.includes("simulated Xero outage"))
  assertEquals(calls.length, 0)
  assertEquals(events.length, 0)
})

// ─────────────────────────────────────────────────────────────────
// T5 — body.job_id linkage mismatch
// ─────────────────────────────────────────────────────────────────
Deno.test("T5: body.job_id != xero_invoices.job_id → 400 job_invoice_mismatch", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet, calls: xeroCalls } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch, calls: fetchCalls } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ job_id: "different-job-uuid" }),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 400)
  const j = await jsonBody(resp)
  assertEquals(j.code, "job_invoice_mismatch")
  assertEquals(j.received_job_id, "different-job-uuid")
  assertEquals(j.expected_job_id, "job-uuid-1")
  // Linkage check fires BEFORE Xero lookup, so no xeroGet calls and no fetch calls.
  assertEquals(xeroCalls.length, 0)
  assertEquals(fetchCalls.length, 0)
})

// ─────────────────────────────────────────────────────────────────
// T6 — recipient_unverifiable when both sources are empty
// ─────────────────────────────────────────────────────────────────
Deno.test("T6: Xero contact empty + jobs.client_email null → 400 recipient_unverifiable", async () => {
  const fix = happyFixture()
  // Modify fixtures: Xero contact has no email, job has no client_email
  const xeroNoEmail = {
    InvoiceID: "inv-123",
    Contact: { ContactID: "xero-contact-1", EmailAddress: "", ContactPersons: [] },
  }
  const seed = {
    xero_invoices: fix.seed.xero_invoices,
    jobs: { "job-uuid-1": { id: "job-uuid-1", client_email: null } },
  }
  const { client } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": xeroNoEmail } })
  const { fetch, calls } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody(),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 400)
  assertEquals((await jsonBody(resp)).code, "recipient_unverifiable")
  assertEquals(calls.length, 0)
})

// ─────────────────────────────────────────────────────────────────
// T7 — Audit uses verifiedJobId only, never caller-supplied unrelated job_id.
// Setup: xero_invoices.job_id = null (unlinked). Caller passes body.job_id.
// Xero contact has the email so the send proceeds. Audit must NOT stamp
// caller's job_id; it must record null (unlinked).
// ─────────────────────────────────────────────────────────────────
Deno.test("T7: unlinked invoice + caller job_id → audit uses null (verifiedJobId only)", async () => {
  const xeroInvoice = {
    InvoiceID: "inv-999",
    Contact: { ContactID: "xero-contact-9", EmailAddress: "client@example.com", ContactPersons: [] },
  }
  // Crucially, xero_invoices.job_id = null (unlinked)
  const seed = {
    xero_invoices: {
      "inv-999": { xero_invoice_id: "inv-999", invoice_number: "INV-999", job_id: null, xero_contact_id: "xero-contact-9" },
    },
    // The caller's "job_id" exists in jobs but is unrelated — should NOT contribute
    jobs: {
      "attacker-chosen-job": { id: "attacker-chosen-job", client_email: "stranger@hotmail.com" },
    },
  }
  const { client, calls: dbCalls } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-999": xeroInvoice } })
  const okPdf = () => new Response(new Uint8Array([0x25]), { status: 200 })
  const okOutlook = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  const { fetch } = makeStubFetch({
    [`${STUB_ENV.XERO_API_BASE}/Invoices/`]: okPdf,
    [`${STUB_ENV.SUPABASE_URL}/functions/v1/send-outlook-email`]: okOutlook,
  })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent, events } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client,
    body: { xero_invoice_id: "inv-999", to_email: "client@example.com", job_id: "attacker-chosen-job" },
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  // Send succeeds because Xero contact authorizes "client@example.com"
  assertEquals(resp.status, 200)
  // Audit fired: business_events with job_id = undefined (i.e. null), payload.linked = false
  assertEquals(events.length, 1)
  assertEquals(events[0].job_id, undefined)
  assertEquals(events[0].payload.linked, false)
  // job_events NOT inserted (verifiedJobId is null)
  const jobEventInserts = dbCalls.inserts.filter(i => i.table === "job_events")
  assertEquals(jobEventInserts.length, 0)
  // Caller's job_id "attacker-chosen-job" must NEVER appear in any audit
  for (const e of events) {
    assert(e.job_id !== "attacker-chosen-job", "business_events leaked caller job_id")
  }
  for (const insert of dbCalls.inserts) {
    assert(insert.row?.job_id !== "attacker-chosen-job", `${insert.table} leaked caller job_id`)
  }
})

// ─────────────────────────────────────────────────────────────────
// T8 — Drift diagnostic: jobs.client_email differs from Xero
// Caller hits the drifted email → contact_job_recipient_mismatch (more specific code)
// ─────────────────────────────────────────────────────────────────
Deno.test("T8: drift case (Xero=A, jobs.client_email=B, to=B) → contact_job_recipient_mismatch", async () => {
  const xeroInvoice = {
    InvoiceID: "inv-123",
    Contact: { ContactID: "xero-contact-1", EmailAddress: "bilal@xero.test", ContactPersons: [] },
  }
  const seed = {
    xero_invoices: {
      "inv-123": { xero_invoice_id: "inv-123", invoice_number: "INV-001", job_id: "job-uuid-1", xero_contact_id: "xero-contact-1" },
    },
    jobs: { "job-uuid-1": { id: "job-uuid-1", client_email: "drifted@hotmail.com" } },
  }
  const { client } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": xeroInvoice } })
  const { fetch } = makeStubFetch({})
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ to_email: "drifted@hotmail.com" }),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 400)
  const j = await jsonBody(resp)
  assertEquals(j.code, "contact_job_recipient_mismatch")
  assertEquals(j.field, "recipient")
})

// ─────────────────────────────────────────────────────────────────
// T9 — Case/whitespace normalization for To address
// ─────────────────────────────────────────────────────────────────
Deno.test("T9: To with mixed case + whitespace matches lowercased allowlist", async () => {
  const deps = makeDeps({ body: makeBody({ to_email: "  Client@EXAMPLE.com  " }) })
  const resp = await _verifyAndSendInvoiceEmail(deps)
  assertEquals(resp.status, 200)
  const j = await jsonBody(resp)
  assertEquals(j.success, true)
  // Outlook still receives the original (untrimmed) value — that's the documented
  // behaviour. SMTP / Outlook normalises addresses; we only assert validation passed.
  assertEquals(j.to, "  Client@EXAMPLE.com  ")
})

// ─────────────────────────────────────────────────────────────────
// T10 — CC string with comma-separated entries, all valid
// (Xero contact has multiple emails so both CC values are in allowlist.)
// ─────────────────────────────────────────────────────────────────
Deno.test("T10: CC string 'a@x,b@x' both in allowlist → 200, normalized CC sent to Outlook", async () => {
  const xeroInvoice = {
    InvoiceID: "inv-123",
    Contact: {
      ContactID: "xero-contact-1",
      EmailAddress: "client@example.com",
      ContactPersons: [
        { EmailAddress: "ops@example.com" },
        { EmailAddress: "accounts@example.com" },
      ],
    },
  }
  const seed = {
    xero_invoices: { "inv-123": { xero_invoice_id: "inv-123", invoice_number: "INV-001", job_id: "job-uuid-1", xero_contact_id: "xero-contact-1" } },
    jobs: { "job-uuid-1": { id: "job-uuid-1", client_email: "client@example.com" } },
  }
  const { client } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": xeroInvoice } })
  const okPdf = () => new Response(new Uint8Array([0x25]), { status: 200 })
  const okOutlook = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  const { fetch, calls } = makeStubFetch({
    [`${STUB_ENV.XERO_API_BASE}/Invoices/`]: okPdf,
    [`${STUB_ENV.SUPABASE_URL}/functions/v1/send-outlook-email`]: okOutlook,
  })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ cc: "ops@example.com, accounts@example.com" }),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 200)
  // Inspect the body sent to send-outlook-email — cc should be normalized comma-join
  const outlookCall = calls.find(c => c.url.includes("send-outlook-email"))!
  const sent = JSON.parse(outlookCall.init!.body as string)
  assertEquals(sent.cc, "ops@example.com,accounts@example.com")
})

// ─────────────────────────────────────────────────────────────────
// T11 — CC array of distinct emails, all valid
// ─────────────────────────────────────────────────────────────────
Deno.test("T11: CC array ['a@x','b@x'] both in allowlist → 200, joined CC sent", async () => {
  const xeroInvoice = {
    InvoiceID: "inv-123",
    Contact: {
      ContactID: "xero-contact-1",
      EmailAddress: "client@example.com",
      ContactPersons: [
        { EmailAddress: "ops@example.com" },
        { EmailAddress: "accounts@example.com" },
      ],
    },
  }
  const seed = {
    xero_invoices: { "inv-123": { xero_invoice_id: "inv-123", invoice_number: "INV-001", job_id: "job-uuid-1", xero_contact_id: "xero-contact-1" } },
    jobs: { "job-uuid-1": { id: "job-uuid-1", client_email: "client@example.com" } },
  }
  const { client } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": xeroInvoice } })
  const { fetch, calls } = makeStubFetch({
    [`${STUB_ENV.XERO_API_BASE}/Invoices/`]: () => new Response(new Uint8Array([0x25]), { status: 200 }),
    [`${STUB_ENV.SUPABASE_URL}/functions/v1/send-outlook-email`]: () => new Response("{}", { status: 200 }),
  })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ cc: ["ops@example.com", "accounts@example.com"] }),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 200)
  const outlookCall = calls.find(c => c.url.includes("send-outlook-email"))!
  const sent = JSON.parse(outlookCall.init!.body as string)
  assertEquals(sent.cc, "ops@example.com,accounts@example.com")
})

// ─────────────────────────────────────────────────────────────────
// T12 — CC array with comma-injected entry: each ENTRY is split on commas
// (defensive coverage for bad client serialization)
// ─────────────────────────────────────────────────────────────────
Deno.test("T12: CC array with comma-injected entry ['a@x,b@x'] → split, both verified", async () => {
  const xeroInvoice = {
    InvoiceID: "inv-123",
    Contact: {
      ContactID: "xero-contact-1",
      EmailAddress: "client@example.com",
      ContactPersons: [
        { EmailAddress: "ops@example.com" },
        { EmailAddress: "accounts@example.com" },
      ],
    },
  }
  const seed = {
    xero_invoices: { "inv-123": { xero_invoice_id: "inv-123", invoice_number: "INV-001", job_id: "job-uuid-1", xero_contact_id: "xero-contact-1" } },
    jobs: { "job-uuid-1": { id: "job-uuid-1", client_email: "client@example.com" } },
  }
  const { client } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": xeroInvoice } })
  const { fetch, calls } = makeStubFetch({
    [`${STUB_ENV.XERO_API_BASE}/Invoices/`]: () => new Response(new Uint8Array([0x25]), { status: 200 }),
    [`${STUB_ENV.SUPABASE_URL}/functions/v1/send-outlook-email`]: () => new Response("{}", { status: 200 }),
  })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ cc: ["ops@example.com,accounts@example.com"] }),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 200)
  const outlookCall = calls.find(c => c.url.includes("send-outlook-email"))!
  const sent = JSON.parse(outlookCall.init!.body as string)
  assertEquals(sent.cc, "ops@example.com,accounts@example.com")
})

// ─────────────────────────────────────────────────────────────────
// T12b — CC array with comma-injected entry where ONE part is a stranger
// → reject. Defensive: caller can't smuggle by hiding inside a "valid" entry.
// ─────────────────────────────────────────────────────────────────
Deno.test("T12b: CC array ['client@example.com,attacker@x'] → 400 cc_recipient_mismatch", async () => {
  const deps = makeDeps({ body: makeBody({ cc: ["client@example.com,attacker@example.org"] }) })
  const resp = await _verifyAndSendInvoiceEmail(deps)
  assertEquals(resp.status, 400)
  const j = await jsonBody(resp)
  assertEquals(j.code, "cc_recipient_mismatch")
  assertEquals(j.received, "attacker@example.org")
})

// ─────────────────────────────────────────────────────────────────
// T13 — Linked invoice success: caller passes matching body.job_id;
// audit must record verifiedJobId (same value, but proves the source is xero_invoices).
// ─────────────────────────────────────────────────────────────────
Deno.test("T13: linked invoice + matching body.job_id → audit job_id = xero_invoices.job_id", async () => {
  const fix = happyFixture()
  const { client, calls: dbCalls } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent, events } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ job_id: "job-uuid-1" }),  // matches siInv.job_id
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 200)
  // business_events: job_id from verifiedJobId, payload.linked = true
  assertEquals(events.length, 1)
  assertEquals(events[0].job_id, "job-uuid-1")
  assertEquals(events[0].payload.linked, true)
  // job_events: also stamped with verifiedJobId
  const jobEventInserts = dbCalls.inserts.filter(i => i.table === "job_events")
  assertEquals(jobEventInserts.length, 1)
  assertEquals(jobEventInserts[0].row.job_id, "job-uuid-1")
})

// ─────────────────────────────────────────────────────────────────
// T14 — Legacy fallback: Xero succeeds with EMPTY contact emails;
// jobs.client_email is the only source. This is the only path where
// jobs.client_email alone authorizes a send.
// ─────────────────────────────────────────────────────────────────
Deno.test("T14: Xero contact has no email but jobs.client_email matches → 200 (legacy)", async () => {
  const xeroInvoice = {
    InvoiceID: "inv-123",
    Contact: { ContactID: "xero-contact-1", EmailAddress: "", ContactPersons: [] },  // genuinely empty
  }
  const seed = {
    xero_invoices: { "inv-123": { xero_invoice_id: "inv-123", invoice_number: "INV-001", job_id: "job-uuid-1", xero_contact_id: "xero-contact-1" } },
    jobs: { "job-uuid-1": { id: "job-uuid-1", client_email: "legacy@example.com" } },
  }
  const { client } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": xeroInvoice } })
  const okPdf = () => new Response(new Uint8Array([0x25]), { status: 200 })
  const okOutlook = () => new Response("{}", { status: 200 })
  const { fetch } = makeStubFetch({
    [`${STUB_ENV.XERO_API_BASE}/Invoices/`]: okPdf,
    [`${STUB_ENV.SUPABASE_URL}/functions/v1/send-outlook-email`]: okOutlook,
  })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ to_email: "legacy@example.com" }),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 200)
})

// ─────────────────────────────────────────────────────────────────
// T15 — ContactPersons emails are valid recipients (Xero contact's primary may
// differ; ContactPersons array provides additional authorized addresses).
// ─────────────────────────────────────────────────────────────────
Deno.test("T15: ContactPersons email authorizes send", async () => {
  const xeroInvoice = {
    InvoiceID: "inv-123",
    Contact: {
      ContactID: "xero-contact-1",
      EmailAddress: "primary@example.com",
      ContactPersons: [{ EmailAddress: "secondary@example.com" }],
    },
  }
  const seed = {
    xero_invoices: { "inv-123": { xero_invoice_id: "inv-123", invoice_number: "INV-001", job_id: "job-uuid-1", xero_contact_id: "xero-contact-1" } },
    jobs: { "job-uuid-1": { id: "job-uuid-1", client_email: "primary@example.com" } },
  }
  const { client } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": xeroInvoice } })
  const { fetch } = makeStubFetch({
    [`${STUB_ENV.XERO_API_BASE}/Invoices/`]: () => new Response(new Uint8Array([0x25]), { status: 200 }),
    [`${STUB_ENV.SUPABASE_URL}/functions/v1/send-outlook-email`]: () => new Response("{}", { status: 200 }),
  })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ to_email: "secondary@example.com" }),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 200)
})

// ─────────────────────────────────────────────────────────────────
// T15b — invoice_not_cached fires WITHOUT calling getToken
// (proves local DB checks run before any Xero connectivity is needed).
// ─────────────────────────────────────────────────────────────────
Deno.test("T15b: missing invoice → invoice_not_cached, getToken NOT called", async () => {
  // Empty seed: invoice id won't be found
  const { client } = makeStubClient({ xero_invoices: {}, jobs: {} })
  const { xeroGet, calls: xeroCalls } = makeStubXeroGet({ invoices: {} })
  const { fetch, calls: fetchCalls } = makeStubFetch({})
  const { getToken, callCount } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ xero_invoice_id: "nonexistent-id" }),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 400)
  assertEquals((await jsonBody(resp)).code, "invoice_not_cached")
  // Local check fired — no Xero side effects whatsoever
  assertEquals(callCount(), 0, "getToken must NOT be called when invoice missing from cache")
  assertEquals(xeroCalls.length, 0)
  assertEquals(fetchCalls.length, 0)
})

// ─────────────────────────────────────────────────────────────────
// T15c — job_invoice_mismatch fires WITHOUT calling getToken
// (proves linkage check runs before any Xero connectivity is needed).
// ─────────────────────────────────────────────────────────────────
Deno.test("T15c: linkage mismatch → job_invoice_mismatch, getToken NOT called", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet, calls: xeroCalls } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch, calls: fetchCalls } = makeStubFetch(fix.fetchRoutes)
  const { getToken, callCount } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ job_id: "different-job-uuid" }),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 400)
  assertEquals((await jsonBody(resp)).code, "job_invoice_mismatch")
  // Linkage check fired — no Xero side effects whatsoever
  assertEquals(callCount(), 0, "getToken must NOT be called when caller's job_id mismatches")
  assertEquals(xeroCalls.length, 0)
  assertEquals(fetchCalls.length, 0)
})

// ─────────────────────────────────────────────────────────────────
// T15d — Successful verified send DOES call getToken exactly once,
// and it happens AFTER local checks (verified by ordering: invoice cache must
// be readable for getToken to ever be reached).
// ─────────────────────────────────────────────────────────────────
Deno.test("T15d: happy path → getToken called exactly once", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch } = makeStubFetch(fix.fetchRoutes)
  const { getToken, callCount } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody(),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 200)
  assertEquals(callCount(), 1, "getToken must be called exactly once on the happy path")
})

// ─────────────────────────────────────────────────────────────────
// T15e — getToken throws (token endpoint outage) → folded into
// xero_contact_lookup_failed, NOT a 502/raw error. PDF and Outlook never reached.
// ─────────────────────────────────────────────────────────────────
Deno.test("T15e: getToken throws → 400 xero_contact_lookup_failed (folded), no PDF/Outlook", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet, calls: xeroCalls } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch, calls: fetchCalls } = makeStubFetch(fix.fetchRoutes)
  const { getToken, callCount } = makeStubGetToken({ throws: true })
  const { logBusinessEvent, events } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody(),
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 400)
  const j = await jsonBody(resp)
  assertEquals(j.code, "xero_contact_lookup_failed")
  assert(typeof j.detail === "string" && j.detail.includes("simulated Xero token outage"))
  // getToken was reached (we got past local checks) but failed
  assertEquals(callCount(), 1)
  // xeroGet never reached because getToken threw first inside the same try
  assertEquals(xeroCalls.length, 0)
  // No PDF/Outlook calls — rejection happened before any send
  assertEquals(fetchCalls.length, 0)
  // No audit on rejection
  assertEquals(events.length, 0)
})

// ─────────────────────────────────────────────────────────────────
// T16 — Caller omits body.job_id entirely; cache linkage is the source.
// ─────────────────────────────────────────────────────────────────
Deno.test("T16: omitted body.job_id → cache linkage drives audit", async () => {
  const fix = happyFixture()
  const { client, calls: dbCalls } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent, events } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client,
    body: { xero_invoice_id: "inv-123", to_email: "client@example.com" },  // no job_id
    getToken, xeroGet, logBusinessEvent, fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 200)
  assertEquals(events[0].job_id, "job-uuid-1")  // from xero_invoices.job_id
  const jobEventInserts = dbCalls.inserts.filter(i => i.table === "job_events")
  assertEquals(jobEventInserts.length, 1)
  assertEquals(jobEventInserts[0].row.job_id, "job-uuid-1")
})
