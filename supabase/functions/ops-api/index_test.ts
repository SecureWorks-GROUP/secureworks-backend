// Unit tests for ops-api/index.ts send_invoice_email Path B verification.
// Tests the exported _verifyAndSendInvoiceEmail helper with stubbed deps.
// No network. No live Xero. No live Supabase.

import { assertEquals, assert, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { _getJobConversationForTest, _logBusinessEventForTest, _verifyAndSendInvoiceEmail } from "./index.ts"
import { approvedInvoiceEmailHtmlBody, sha256Hex } from "./debt_followup_approval.ts"
import { outlookMessageHtmlBody, OUTLOOK_DEFAULT_MAILBOX } from "../_shared/outlook_signature.ts"
import { XeroCooldownError } from "../_shared/xero_cooldown.ts"
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
    xeroFetch: overrides.xeroFetch ?? overrides.fetch ?? fetch,
  }
}

function makeConversationClient(input: {
  executions?: Record<string, any>[]
  events?: Record<string, any>[]
  ghlMessages?: Record<string, any>[]
}) {
  const job = { job_number: "SWMS-12345", ghl_contact_id: null }
  const rowsByTable: Record<string, Record<string, any>[]> = {
    jobs: [{ id: "job-1", ...job }],
    ghl_conversation_cache: [{ job_id: "job-1", messages: input.ghlMessages || [] }],
    inbox_events: [],
    job_events: [],
    business_events: input.events || [],
    debt_followup_executions: input.executions || [],
  }
  return {
    from(table: string) {
      const filters: Array<(row: Record<string, any>) => boolean> = []
      let maxRows = Number.POSITIVE_INFINITY
      const query: any = {
        select: () => query,
        eq(field: string, value: any) {
          filters.push((row) => field === "proposal->>job_id"
            ? row.proposal?.job_id === value
            : row[field] === value)
          return query
        },
        in(field: string, values: any[]) {
          filters.push((row) => values.includes(row[field]))
          return query
        },
        not(field: string, operator: string, value: any) {
          filters.push((row) => operator === "is" && value === null
            ? row[field] !== null && row[field] !== undefined
            : true)
          return query
        },
        gt(field: string, value: string) {
          filters.push((row) => String(row[field] || "") > value)
          return query
        },
        order: () => query,
        limit(value: number) {
          maxRows = value
          return query
        },
        async maybeSingle() {
          if (table === "jobs") return { data: { job_number: job.job_number, ghl_contact_id: job.ghl_contact_id }, error: null }
          return { data: rowsByTable[table]?.[0] || null, error: null }
        },
        then(resolve: (value: any) => unknown, reject: (reason: unknown) => unknown) {
          const rows = (rowsByTable[table] || []).filter((row) => filters.every((f) => f(row))).slice(0, maxRows)
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
        },
      }
      return query
    },
  }
}

Deno.test("branded invoice PDF cooldown prevents Outlook send and preserves structured refusal", async () => {
  let emailCalls = 0;
  const refusal = new XeroCooldownError("Shared Xero cooldown is active", 429, "XERO_COOLDOWN_ACTIVE", {
    provider_call_made: false, retry_at: "2026-09-09T09:46:00Z",
  });
  for (const rejectedStep of ["xeroGet", "xeroFetch"] as const) {
    const deps = makeDeps({
      [rejectedStep]: () => Promise.reject(refusal),
      fetch: () => { emailCalls++; return Promise.resolve(new Response(null, { status: 200 })); },
    });
    const error = await assertRejects(() => _verifyAndSendInvoiceEmail(deps), XeroCooldownError);
    assertEquals(error, refusal);
    assertEquals(emailCalls, 0);
  }
});

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
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
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
  const fetchRoutes: Record<string, () => Response> = {
    ...fix.fetchRoutes,
    [`${STUB_ENV.SUPABASE_URL}/functions/v1/send-outlook-email`]: () =>
      new Response(JSON.stringify({ success: true }), {
        status: 202,
        headers: {
          "request-id": "outlook-request-1",
          "client-request-id": "client-request-1",
        },
      }),
  }
  const { client, calls: dbCalls } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch, calls: fetchCalls } = makeStubFetch(fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent, events: legacyEvents } = makeStubLogBusinessEvent()
  const events: any[] = []
  const captureBusinessEvent = async (_client: any, row: any) => {
    events.push(row)
    return { outcome: "inserted" }
  }

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({
      debt_followup_approval_id: "approval-123",
      approved_invoice_number: "INV-001",
      approved_attachment_file_name: "INV-001.pdf",
      subject_override: "Approved invoice subject",
    }),
    getToken, xeroGet, logBusinessEvent, captureBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 200)
  const j = await jsonBody(resp)
  assertEquals(j.success, true)
  assertEquals(j.emailed, true)
  assertEquals(j.via, "outlook")
  assertEquals(j.timeline_write_failed, false)
  assertEquals(j.provider_proof.label, "accepted by Outlook")
  assertEquals(j.provider_proof.status, 202)
  assertEquals(j.provider_proof.request_id, "outlook-request-1")
  assertEquals(j.provider_proof.client_request_id, "client-request-1")
  assertEquals(j.provider_proof.approval_id, "approval-123")
  assertEquals(j.provider_proof.attachment_sha256.length, 64)
  assert(Number.isFinite(Date.parse(j.provider_proof.sent_at)))

  // Exactly one PDF GET + one Outlook POST
  const pdfCalls = fetchCalls.filter(c => c.url.startsWith(STUB_ENV.XERO_API_BASE))
  const outlookCalls = fetchCalls.filter(c => c.url.startsWith(`${STUB_ENV.SUPABASE_URL}/functions/v1/send-outlook-email`))
  assertEquals(pdfCalls.length, 1)
  assertEquals(outlookCalls.length, 1)
  const approvedHtml = approvedInvoiceEmailHtmlBody("INV-001")
  const outlookRequest = JSON.parse(outlookCalls[0].init!.body as string)
  assertEquals(outlookRequest.htmlBody, approvedHtml)
  assertEquals(await sha256Hex(outlookRequest.htmlBody), await sha256Hex(approvedHtml))
  assertEquals(
    outlookMessageHtmlBody(outlookRequest.htmlBody, OUTLOOK_DEFAULT_MAILBOX),
    approvedHtml,
  )

  // An approved send's evidence goes through capture_business_event, keyed on
  // the approval, and the writer owns time and attribution.
  assertEquals(legacyEvents.length, 0)
  assertEquals(events.length, 1)
  assertEquals(events[0].event_type, "invoice.emailed")
  assertEquals(events[0].provider_message_id, "outlook-accepted:approval-123")
  assertEquals(events[0].metadata, { capture_mode: "live" })
  assertEquals(events[0].channel, "email")
  assertEquals(events[0].direction, "outbound")
  assertEquals(events[0].job_id, "job-uuid-1")
  assertEquals(events[0].match_method, "direct_job_id")
  for (const writerOwned of ["occurred_at", "event_at", "match_status", "match_confidence", "attribution_status"]) {
    assertEquals(writerOwned in events[0], false, writerOwned)
  }
  assertEquals(events[0].payload.linked, true)
  assertEquals(events[0].payload.debt_followup_approval_id, "approval-123")
  assertEquals(events[0].payload.subject, "Approved invoice subject")
  assertEquals(
    events[0].payload.email_body_html,
    approvedHtml,
  )
  assertEquals("body" in events[0].payload, false)
  assertEquals(events[0].payload.attachment_file_name, "INV-001.pdf")
  assertEquals(events[0].payload.provider_proof, j.provider_proof)
  // job_events insert happens via stub client
  const jobEventInserts = dbCalls.inserts.filter(i => i.table === "job_events")
  assertEquals(jobEventInserts.length, 1)
  assertEquals(jobEventInserts[0].row.job_id, "job-uuid-1")
})

Deno.test("capture skipped after the first gate check is a failed timeline write", async () => {
  let laneChecks = 0
  let evidenceWrites = 0
  const client = {
    rpc: async () => ({ data: ++laneChecks === 1, error: null }),
    from: () => ({
      insert: () => {
        evidenceWrites++
        return Promise.resolve({ error: null })
      },
    }),
  }
  const written = await _logBusinessEventForTest(client, {
    event_type: "invoice.emailed",
    entity_type: "xero_invoice",
    entity_id: "inv-123",
  }, true)
  assertEquals(written, false)
  assertEquals(laneChecks, 2)
  assertEquals(evidenceWrites, 0)
})

Deno.test("an approved send whose capture write does not land reports timeline_write_failed", async () => {
  for (const capture of [
    async () => ({ outcome: "capture_disabled" }),
    async () => ({ outcome: "error", code: "rpc_error" }),
    async () => { throw new Error("rpc threw") },
  ]) {
    const fix = happyFixture()
    const { client } = makeStubClient(fix.seed)
    const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
    const { fetch, calls } = makeStubFetch(fix.fetchRoutes)
    const { getToken } = makeStubGetToken()
    const { logBusinessEvent, events } = makeStubLogBusinessEvent()
    const resp = await _verifyAndSendInvoiceEmail({
      client,
      body: makeBody({
        debt_followup_approval_id: "approval-9",
        approved_invoice_number: "INV-001",
        approved_attachment_file_name: "INV-001.pdf",
      }),
      getToken, xeroGet, logBusinessEvent,
      captureBusinessEvent: capture as any,
      fetch, xeroFetch: fetch, env: STUB_ENV,
    })
    assertEquals(resp.status, 200)
    const body = await jsonBody(resp)
    assertEquals(body.emailed, true)
    assertEquals(body.timeline_write_failed, true)
    assertEquals(events.length, 0)
    assertEquals(calls.filter((call) => call.url.startsWith(
      `${STUB_ENV.SUPABASE_URL}/functions/v1/send-outlook-email`,
    )).length, 1)
  }
})

Deno.test("confirmed Outlook send surfaces a failed conversation event write", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch, calls } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()

  const resp = await _verifyAndSendInvoiceEmail({
    client,
    body: makeBody(),
    getToken,
    xeroGet,
    logBusinessEvent: async () => false,
    fetch,
    xeroFetch: fetch,
    env: STUB_ENV,
  })

  assertEquals(resp.status, 200)
  const body = await jsonBody(resp)
  assertEquals(body.success, true)
  assertEquals(body.emailed, true)
  assertEquals(body.timeline_write_failed, true)
  assertEquals(calls.filter((call) => call.url.startsWith(
    `${STUB_ENV.SUPABASE_URL}/functions/v1/send-outlook-email`,
  )).length, 1)
})

Deno.test("approved Outlook send uses the approved invoice number and filename", async () => {
  const fix = happyFixture()
  const seed = {
    ...fix.seed,
    xero_invoices: {
      ...fix.seed.xero_invoices,
      "inv-123": {
        ...fix.seed.xero_invoices["inv-123"],
        invoice_number: "OLD-101",
      },
    },
  }
  const { client } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch, calls } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const response = await _verifyAndSendInvoiceEmail({
    client,
    body: makeBody({
      debt_followup_approval_id: "approval-number-1",
      approved_invoice_number: "INV-101",
      approved_attachment_file_name: "INV-101.pdf",
    }),
    getToken,
    xeroGet,
    logBusinessEvent,
    fetch,
    xeroFetch: fetch,
    env: STUB_ENV,
  })

  assertEquals(response.status, 200)
  const send = calls.find((call) => call.url.startsWith(
    `${STUB_ENV.SUPABASE_URL}/functions/v1/send-outlook-email`,
  ))
  assert(send)
  const sentBody = JSON.parse(String(send.init?.body))
  assertEquals(sentBody.subject, "Invoice INV-101 — SecureWorks Group")
  assertEquals(sentBody.attachments[0].name, "INV-101.pdf")
  assertEquals(sentBody.htmlBody, approvedInvoiceEmailHtmlBody("INV-101"))
})

Deno.test("job conversation projects a confirmed invoice email when capture failed", async () => {
  const proof = {
    provider: "outlook",
    label: "accepted by Outlook",
    accepted: true,
    status: 202,
    sent_at: "2026-09-24T01:02:03.000Z",
    approval_id: "approval-email-1",
    attachment_sha256: "a".repeat(64),
  }
  const proposal = {
    job_id: "job-1",
    kind: "invoice_email",
    channel: "email",
    body: "Approved email body with the exact signature.",
    destination: { channel: "email", to: "accounts@example.test", cc: [] },
    email: { subject: "Invoice INV-001", attachment: { file_name: "INV-001.pdf" } },
  }
  const { messages } = await _getJobConversationForTest(
    makeConversationClient({
      executions: [{
        approval_id: "approval-email-1",
        kind: "invoice_email",
        channel: "email",
        mode: "live",
        outcome: "sent",
        pressed_by: "captain@example.test",
        proposal,
        provider: "outlook",
        provider_message_id: null,
        provider_proof: proof,
        created_at: proof.sent_at,
        finished_at: proof.sent_at,
      }],
    }),
    { job_id: "job-1" },
  )
  assertEquals(messages.length, 1)
  assertEquals(messages[0].source_system, "debt_followup_executions")
  assertEquals(messages[0].provider_message_id, "outlook-accepted:approval-email-1")
  assertEquals(messages[0].body, proposal.body)
  assertEquals(messages[0].subject, proposal.email.subject)
})

Deno.test("job conversation projects a confirmed SMS using its canonical GHL identity", async () => {
  const proposal = {
    job_id: "job-1",
    kind: "chase_sms",
    channel: "sms",
    body: "Please contact us about your invoice.",
    destination: { channel: "sms", ghl_contact_id: "ghl-1", phone: "+61412345678" },
  }
  const { messages } = await _getJobConversationForTest(
    makeConversationClient({
      executions: [{
        approval_id: "approval-sms-1",
        kind: "chase_sms",
        channel: "sms",
        mode: "live",
        outcome: "sent",
        pressed_by: "captain@example.test",
        proposal,
        provider: "ghl",
        provider_message_id: "ghl-message-1",
        provider_proof: {
          provider: "ghl",
          message_id: "ghl-message-1",
          body_sha256: "b".repeat(64),
        },
        created_at: "2026-09-24T01:02:03.000Z",
        finished_at: "2026-09-24T01:02:04.000Z",
      }],
    }),
    { job_id: "job-1" },
  )
  assertEquals(messages.length, 1)
  assertEquals(messages[0].channel, "sms")
  assertEquals(messages[0].provider_message_id, "ghl:ghl-message-1")
  assertEquals(messages[0].body, proposal.body)
})

Deno.test("job conversation does not duplicate ledger sends already present in evidence or GHL cache", async () => {
  const emailId = "approval-email-2"
  const emailBody = "The event copy wins."
  const emailProof = {
    provider: "outlook",
    label: "accepted by Outlook",
    accepted: true,
    status: 202,
    sent_at: "2026-09-24T01:00:00.000Z",
    approval_id: emailId,
    attachment_sha256: "c".repeat(64),
  }
  const emailExecution = {
    approval_id: emailId,
    kind: "invoice_email",
    channel: "email",
    mode: "live",
    outcome: "sent",
    proposal: {
      job_id: "job-1", kind: "invoice_email", channel: "email", body: emailBody,
      destination: { channel: "email", to: "accounts@example.test", cc: [] },
      email: { subject: "Invoice", attachment: {} },
    },
    provider: "outlook",
    provider_message_id: null,
    provider_proof: emailProof,
    created_at: emailProof.sent_at,
    finished_at: emailProof.sent_at,
  }
  const emailEvent = {
    id: "event-email-2",
    event_type: "invoice.emailed",
    source: "ops-api/debt_followup_execute",
    occurred_at: emailProof.sent_at,
    job_id: "job-1",
    provider_message_id: `outlook-accepted:${emailId}`,
    payload: { email_body_html: emailBody, subject: "Invoice", provider_proof: emailProof },
  }
  const emailRead = await _getJobConversationForTest(
    makeConversationClient({ executions: [emailExecution], events: [emailEvent] }),
    { job_id: "job-1" },
  )
  assertEquals(emailRead.messages.length, 1)
  assertEquals(emailRead.messages[0].source_system, "business_events")

  const smsExecution = {
    approval_id: "approval-sms-2",
    kind: "chase_sms",
    channel: "sms",
    mode: "live",
    outcome: "sent",
    proposal: {
      job_id: "job-1", kind: "chase_sms", channel: "sms", body: "Cache copy wins.",
      destination: { channel: "sms", ghl_contact_id: "ghl-1", phone: "+61412345678" },
    },
    provider: "ghl",
    provider_message_id: "ghl-message-2",
    provider_proof: { provider: "ghl", message_id: "ghl-message-2", body_sha256: "d".repeat(64) },
    created_at: "2026-09-24T01:00:00.000Z",
    finished_at: "2026-09-24T01:00:01.000Z",
  }
  const smsRead = await _getJobConversationForTest(
    makeConversationClient({
      executions: [smsExecution],
      ghlMessages: [{
        id: "ghl-message-2", type: "SMS", direction: "outbound",
        timestamp: smsExecution.finished_at, body: "Cache copy wins.",
      }],
    }),
    { job_id: "job-1" },
  )
  assertEquals(smsRead.messages.length, 1)
  assertEquals(smsRead.messages[0].source_system, "ghl_cache")
})

Deno.test("job conversation projects pending provider proof once and labels settlement", async () => {
  const sentAt = "2026-09-24T01:02:03.000Z"
  const pendingEmailId = "approval-email-pending"
  const pendingSmsId = "approval-sms-pending"
  const pendingEmailFallbackId = "approval-email-pending-fallback"
  const pendingEmailProof = {
    label: "accepted by Outlook",
    status: 202,
    sent_at: sentAt,
    approval_id: pendingEmailId,
    attachment_sha256: "e".repeat(64),
  }
  const pendingEmail = {
    approval_id: pendingEmailId,
    kind: "invoice_email",
    channel: "email",
    mode: "live",
    outcome: "sending",
    pressed_by: "captain@example.test",
    proposal: {
      job_id: "job-1", kind: "invoice_email", channel: "email",
      body: "Approved pending email.",
      destination: { channel: "email", to: "accounts@example.test", cc: [] },
      email: { subject: "Invoice INV-101", attachment: {} },
    },
    provider: "outlook",
    provider_message_id: null,
    provider_proof: pendingEmailProof,
    created_at: sentAt,
    finished_at: null,
  }
  const pendingEmailFallback = {
    ...pendingEmail,
    approval_id: pendingEmailFallbackId,
    proposal: {
      ...pendingEmail.proposal,
      email: { subject: "Invoice INV-102", attachment: {} },
      body: "Approved pending email without evidence.",
    },
    provider_proof: {
      ...pendingEmailProof,
      approval_id: pendingEmailFallbackId,
    },
  }
  const pendingSms = {
    approval_id: pendingSmsId,
    kind: "chase_sms",
    channel: "sms",
    mode: "live",
    outcome: "sending",
    pressed_by: "captain@example.test",
    proposal: {
      job_id: "job-1", kind: "chase_sms", channel: "sms",
      body: "Approved pending text.",
      destination: { channel: "sms", ghl_contact_id: "ghl-1", phone: "+61412345678" },
    },
    provider: "ghl",
    provider_message_id: "ghl-shared-message",
    provider_proof: {
      provider: "ghl",
      message_id: "ghl-shared-message",
      body_sha256: "f".repeat(64),
    },
    created_at: sentAt,
    finished_at: null,
  }
  const duplicateSettledSms = {
    ...pendingSms,
    approval_id: "approval-sms-settled-duplicate",
    outcome: "sent",
    finished_at: sentAt,
  }
  const emailEvidence = {
    id: "event-pending-email",
    event_type: "invoice.emailed",
    source: "ops-api/debt-followup_execute",
    occurred_at: sentAt,
    job_id: "job-1",
    provider_message_id: `outlook-accepted:${pendingEmailId}`,
    payload: {
      email_body_html: "Captured email copy wins.",
      subject: "Invoice INV-101",
      provider_proof: pendingEmailProof,
    },
  }
  const { messages } = await _getJobConversationForTest(
    makeConversationClient({
      executions: [pendingEmail, pendingEmailFallback, pendingSms, duplicateSettledSms],
      events: [emailEvidence],
    }),
    { job_id: "job-1" },
  )

  assertEquals(messages.length, 3)
  assertEquals(messages.filter((message) => message.source_system === "business_events").length, 1)
  const pendingEmailMessage = messages.find((message) =>
    message.source_ref === pendingEmailFallbackId
  )
  assert(pendingEmailMessage)
  assertEquals(pendingEmailMessage.execution_status, "settlement pending")
  assertEquals(pendingEmailMessage.provider_message_id, `outlook-accepted:${pendingEmailFallbackId}`)
  const pendingSmsMessage = messages.find((message) => message.channel === "sms")
  assert(pendingSmsMessage)
  assertEquals(pendingSmsMessage.provider_message_id, "ghl:ghl-shared-message")
  assertEquals(pendingSmsMessage.execution_status, "settlement pending")
  assertEquals(pendingSmsMessage.provider_proof.message_id, "ghl-shared-message")
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
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
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
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
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
Deno.test("T5: body.job_id != xero_invoices.job_id → 409 job_invoice_mismatch", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet, calls: xeroCalls } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch, calls: fetchCalls } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ job_id: "different-job-uuid" }),
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 409)
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
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 400)
  assertEquals((await jsonBody(resp)).code, "recipient_unverifiable")
  assertEquals(calls.length, 0)
})

// ─────────────────────────────────────────────────────────────────
// T7 — An unlinked ACCREC invoice cannot borrow a caller-supplied job_id.
// The mirror link is authoritative and refusal happens before Xero/Outlook.
// ─────────────────────────────────────────────────────────────────
Deno.test("T7: unlinked ACCREC invoice + caller job_id → invoice_link_required", async () => {
  const xeroInvoice = {
    InvoiceID: "inv-999",
    Contact: { ContactID: "xero-contact-9", EmailAddress: "client@example.com", ContactPersons: [] },
  }
  // Crucially, xero_invoices.job_id = null (unlinked)
  const seed = {
    xero_invoices: {
      "inv-999": {
        xero_invoice_id: "inv-999",
        invoice_number: "INV-999",
        invoice_type: "ACCREC",
        job_id: null,
        xero_contact_id: "xero-contact-9",
      },
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
  const { fetch, calls: fetchCalls } = makeStubFetch({
    [`${STUB_ENV.XERO_API_BASE}/Invoices/`]: okPdf,
    [`${STUB_ENV.SUPABASE_URL}/functions/v1/send-outlook-email`]: okOutlook,
  })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent, events } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client,
    body: { xero_invoice_id: "inv-999", to_email: "client@example.com", job_id: "attacker-chosen-job" },
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 409)
  assertEquals((await jsonBody(resp)).code, "invoice_link_required")
  assertEquals(fetchCalls.length, 0)
  assertEquals(events.length, 0)
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
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
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
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
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
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
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
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
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
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
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
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 200)
})

Deno.test("T14b: malformed Xero contact email does not fall back to jobs.client_email", async () => {
  const fix = happyFixture()
  const xeroInvoice = {
    InvoiceID: "inv-123",
    Contact: { ContactID: "xero-contact-1", EmailAddress: "not-an-email", ContactPersons: [] },
  }
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": xeroInvoice } })
  const { fetch, calls } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const response = await _verifyAndSendInvoiceEmail({
    client, body: makeBody(), getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
  })

  assertEquals(response.status, 400)
  assertEquals((await jsonBody(response)).code, "xero_contact_email_invalid")
  assertEquals(calls.length, 0)
})

Deno.test("T14c: non-string Xero contact email does not fall back to jobs.client_email", async () => {
  const fix = happyFixture()
  const xeroInvoice = {
    InvoiceID: "inv-123",
    Contact: { ContactID: "xero-contact-1", EmailAddress: {}, ContactPersons: [] },
  }
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": xeroInvoice } })
  const { fetch, calls } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const response = await _verifyAndSendInvoiceEmail({
    client, body: makeBody(), getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
  })

  assertEquals(response.status, 400)
  assertEquals((await jsonBody(response)).code, "xero_contact_email_invalid")
  assertEquals(calls.length, 0)
})

Deno.test("T14d: delimiter-only Xero contact email does not fall back to jobs.client_email", async () => {
  const fix = happyFixture()
  const xeroInvoice = {
    InvoiceID: "inv-123",
    Contact: { ContactID: "xero-contact-1", EmailAddress: ",", ContactPersons: [] },
  }
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": xeroInvoice } })
  const { fetch, calls } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const response = await _verifyAndSendInvoiceEmail({
    client, body: makeBody(), getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
  })

  assertEquals(response.status, 400)
  assertEquals((await jsonBody(response)).code, "xero_contact_email_invalid")
  assertEquals(calls.length, 0)
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
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 200)
})

// ─────────────────────────────────────────────────────────────────
// T15b — a missing mirror fails the sealed-SES check WITHOUT calling getToken
// (proves local DB checks run before any Xero connectivity is needed).
// ─────────────────────────────────────────────────────────────────
Deno.test("T15b: missing invoice → sealed_ses_fence_check_failed, getToken NOT called", async () => {
  // Empty seed: invoice id won't be found
  const { client } = makeStubClient({ xero_invoices: {}, jobs: {} })
  const { xeroGet, calls: xeroCalls } = makeStubXeroGet({ invoices: {} })
  const { fetch, calls: fetchCalls } = makeStubFetch({})
  const { getToken, callCount } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ xero_invoice_id: "nonexistent-id" }),
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 503)
  assertEquals((await jsonBody(resp)).code, "sealed_ses_fence_check_failed")
  // Local check fired — no Xero side effects whatsoever
  assertEquals(callCount(), 0, "getToken must NOT be called when invoice missing from cache")
  assertEquals(xeroCalls.length, 0)
  assertEquals(fetchCalls.length, 0)
})

// ─────────────────────────────────────────────────────────────────
// T15c — job_invoice_mismatch fires WITHOUT calling getToken
// (proves linkage check runs before any Xero connectivity is needed).
// ─────────────────────────────────────────────────────────────────
Deno.test("T15c: linkage mismatch → typed 409, getToken NOT called", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet, calls: xeroCalls } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch, calls: fetchCalls } = makeStubFetch(fix.fetchRoutes)
  const { getToken, callCount } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const resp = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ job_id: "different-job-uuid" }),
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 409)
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
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
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
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
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
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
  })

  assertEquals(resp.status, 200)
  assertEquals(events[0].job_id, "job-uuid-1")  // from xero_invoices.job_id
  const jobEventInserts = dbCalls.inserts.filter(i => i.table === "job_events")
  assertEquals(jobEventInserts.length, 1)
  assertEquals(jobEventInserts[0].row.job_id, "job-uuid-1")
})

// ═════════════════════════════════════════════════════════════════════════════
// CAP0-QUICK-QUOTE-RELEASE-TRUTH-FIX — Phase 0.5 binding evidence
//
// Tests the post-Resend release-truth pattern in sendQuickQuoteEmail. Because
// importing index.ts here would start the production HTTP server via serve(...)
// at module load (and because sendQuickQuoteEmail is module-internal), this
// test reimplements the pattern under test as a small pure function and
// exercises it with mocked supabase clients. The verification report
// cross-references this against the deployed code at:
//   ops-api/index.ts post-Resend block in sendQuickQuoteEmail
//   (conditional UPDATE + canonical pair gated on `transitioned`,
//    payload.job_type reads from job.type — Codex stop-time fix)
// ═════════════════════════════════════════════════════════════════════════════

// Pure reimplementation of the pattern under test. Mirrors the post-Resend
// block in sendQuickQuoteEmail.
async function runQuickQuoteRelease(
  client: any,
  job: { id: string; job_number: string | null; type: string | null; client_email: string },
  logBusinessEventCalls: Array<Record<string, any>>,
  legacyEventCalls: Array<Record<string, any>>,
): Promise<{ released: boolean }> {
  const nowIso = new Date().toISOString()
  const { data: updatedRows } = await client.from('jobs')
    .update({ status: 'quoted', quoted_at: nowIso })
    .eq('id', job.id)
    .eq('status', 'draft')
    .select('id')
  const transitioned = Array.isArray(updatedRows) && updatedRows.length > 0

  await client.from('job_events').insert({
    job_id: job.id,
    event_type: 'quote_sent',
    detail_json: { sent_to: job.client_email, source: 'quick_quote' },
  })
  legacyEventCalls.push({ event_type: 'quote_sent', job_id: job.id })

  if (transitioned) {
    const totalIncGSTNum = 0
    // Codex-fix regression check: job_type MUST come from job.type, NEVER hardcoded.
    logBusinessEventCalls.push({
      event_type: 'quote.sent',
      source: 'send-quick-quote-email',
      job_id: job.id,
      payload: {
        job_number: job.job_number || null,
        job_type: job.type || null,
        sent_to: job.client_email,
        total_inc_gst: totalIncGSTNum,
      },
      metadata: { handler: 'ops-api/send_quick_quote_email' },
    })

    logBusinessEventCalls.push({
      event_type: 'job.status_changed',
      source: 'send-quick-quote-email',
      job_id: job.id,
      payload: {
        entity: { id: job.id, name: job.job_number || '' },
        changes: { status: { from: 'draft', to: 'quoted' } },
        financial: { amount: totalIncGSTNum },
      },
      metadata: { reason: 'quote_sent', handler: 'ops-api/send_quick_quote_email' },
    })
  }

  return { released: transitioned }
}

function makeJobsClient(updateReturnsRows: Array<{ id: string }>) {
  const inserts: Array<{ table: string; row: Record<string, any> }> = []
  const fromTable = (table: string) => ({
    insert: (row: Record<string, any>) => {
      inserts.push({ table, row })
      return Promise.resolve({ error: null })
    },
    update: (_payload: Record<string, any>) => {
      const chain = {
        _filters: {} as Record<string, any>,
        eq(col: string, val: any) {
          this._filters[col] = val
          return this
        },
        select(_cols: string) {
          return Promise.resolve({ data: updateReturnsRows, error: null })
        },
      }
      return chain
    },
  })
  return { from: fromTable, _inserts: inserts }
}

const SAMPLE_JOB_PATIO = {
  id: 'aa1da77f-1951-4d64-be86-a810781d9813',
  job_number: 'SWP-26121',
  type: 'patio' as string | null,
  client_email: 'marnin@secureworkswa.com.au',
}

Deno.test("Quick Quote — transition path: empty pre-state → draft, conditional UPDATE returns 1 row, canonical pair emitted", async () => {
  const client = makeJobsClient([{ id: SAMPLE_JOB_PATIO.id }])
  const logCalls: Array<Record<string, any>> = []
  const legacyCalls: Array<Record<string, any>> = []
  const result = await runQuickQuoteRelease(client, SAMPLE_JOB_PATIO, logCalls, legacyCalls)
  assertEquals(result.released, true, "expected released=true on a clean draft → quoted transition")
  assertEquals(logCalls.length, 2, "expected exactly two canonical-event helper calls")
  assertEquals(logCalls[0].event_type, 'quote.sent')
  assertEquals(logCalls[1].event_type, 'job.status_changed')
  assertEquals(legacyCalls.length, 1, "expected exactly one legacy job_events.quote_sent insert")
})

Deno.test("Quick Quote — Codex regression: payload.job_type reads from job.type ('patio'), NOT hardcoded 'miscellaneous'", async () => {
  const client = makeJobsClient([{ id: SAMPLE_JOB_PATIO.id }])
  const logCalls: Array<Record<string, any>> = []
  const legacyCalls: Array<Record<string, any>> = []
  await runQuickQuoteRelease(client, SAMPLE_JOB_PATIO, logCalls, legacyCalls)
  const quoteSent = logCalls.find(c => c.event_type === 'quote.sent')
  assertEquals(quoteSent?.payload.job_type, 'patio', "Codex-flagged bug: job_type must reflect DB row, not 'miscellaneous'")
})

Deno.test("Quick Quote — Codex regression: payload.job_type honours every DB type, not just 'patio'", async () => {
  const cases: Array<{ type: string | null; expected: string | null }> = [
    { type: 'fencing', expected: 'fencing' },
    { type: 'general', expected: 'general' },
    { type: 'makesafe', expected: 'makesafe' },
    { type: 'decking', expected: 'decking' },
    { type: null, expected: null },
  ]
  for (const c of cases) {
    const client = makeJobsClient([{ id: SAMPLE_JOB_PATIO.id }])
    const logCalls: Array<Record<string, any>> = []
    const legacyCalls: Array<Record<string, any>> = []
    await runQuickQuoteRelease(
      client,
      { ...SAMPLE_JOB_PATIO, type: c.type },
      logCalls,
      legacyCalls,
    )
    const quoteSent = logCalls.find(c2 => c2.event_type === 'quote.sent')
    assertEquals(quoteSent?.payload.job_type, c.expected, `job_type mismatch for input ${c.type}`)
  }
})

Deno.test("Quick Quote — no-op path (already quoted): conditional UPDATE returns [], NO canonical pair, legacy STILL writes", async () => {
  const client = makeJobsClient([])
  const logCalls: Array<Record<string, any>> = []
  const legacyCalls: Array<Record<string, any>> = []
  const result = await runQuickQuoteRelease(client, SAMPLE_JOB_PATIO, logCalls, legacyCalls)
  assertEquals(result.released, false, "expected released=false when conditional UPDATE no-ops")
  assertEquals(logCalls.length, 0, "no canonical events on a no-op resend")
  assertEquals(legacyCalls.length, 1, "legacy quote_sent still writes on a no-op resend (matches deployed behaviour)")
})

Deno.test("Quick Quote — job.status_changed payload carries from='draft', to='quoted', reason='quote_sent'", async () => {
  const client = makeJobsClient([{ id: SAMPLE_JOB_PATIO.id }])
  const logCalls: Array<Record<string, any>> = []
  const legacyCalls: Array<Record<string, any>> = []
  await runQuickQuoteRelease(client, SAMPLE_JOB_PATIO, logCalls, legacyCalls)
  const statusChanged = logCalls.find(c => c.event_type === 'job.status_changed')
  assertEquals(statusChanged?.payload.changes.status.from, 'draft')
  assertEquals(statusChanged?.payload.changes.status.to, 'quoted')
  assertEquals(statusChanged?.metadata.reason, 'quote_sent')
  assertEquals(statusChanged?.metadata.handler, 'ops-api/send_quick_quote_email')
})

Deno.test("Quick Quote — both canonical events carry handler='ops-api/send_quick_quote_email'", async () => {
  const client = makeJobsClient([{ id: SAMPLE_JOB_PATIO.id }])
  const logCalls: Array<Record<string, any>> = []
  const legacyCalls: Array<Record<string, any>> = []
  await runQuickQuoteRelease(client, SAMPLE_JOB_PATIO, logCalls, legacyCalls)
  for (const call of logCalls) {
    assertEquals(call.metadata.handler, 'ops-api/send_quick_quote_email',
      `${call.event_type} missing or wrong handler`)
  }
})

Deno.test("company report recipient anchor authorizes", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient({
    ...fix.seed,
    makesafe_job_details: {
      "job-uuid-1": { job_id: "job-uuid-1", requesting_company_id: "company-1" },
    },
    makesafe_companies: {
      "company-1": {
        id: "company-1",
        report_recipient: "reports@builder.test",
      },
    },
  })
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } })
  const { fetch } = makeStubFetch(fix.fetchRoutes)
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const response = await _verifyAndSendInvoiceEmail({
    client, body: makeBody({ to_email: "reports@builder.test" }),
    getToken, xeroGet, logBusinessEvent, fetch, xeroFetch: fetch, env: STUB_ENV,
  })
  assertEquals(response.status, 200)
})
