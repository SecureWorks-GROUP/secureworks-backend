// T3 unit tests for approve_and_send_invoice recipient verification.
// Tests the exported _verifyApproveAndSendRecipient helper with inline stubs.
// No network, no live Xero, no live Supabase. Self-contained — does not depend
// on any T2 test infrastructure.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { _verifyApproveAndSendRecipient } from "./index.ts"

// ─────────────────────────────────────────────────────────────────
// Inline stubs (intentionally NOT shared with T2 — keeps T3 mergeable independently)
// ─────────────────────────────────────────────────────────────────

type Seed = {
  xero_invoices?: Record<string, any>  // keyed by xero_invoice_id
  jobs?: Record<string, any>           // keyed by id
}
type ClientCalls = { inserts: Array<{ table: string; row: any }> }

function makeStubClient(seed: Seed = {}): { client: any; calls: ClientCalls } {
  const calls: ClientCalls = { inserts: [] }
  const client = {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq(col: string, val: any) {
              return {
                async maybeSingle() {
                  const t = (seed as any)[table] || {}
                  if (col === "xero_invoice_id" || col === "id") {
                    return { data: t[val] || null, error: null }
                  }
                  for (const row of Object.values(t) as any[]) {
                    if (row?.[col] === val) return { data: row, error: null }
                  }
                  return { data: null, error: null }
                },
              }
            },
          }
        },
        async insert(row: any) {
          calls.inserts.push({ table, row })
          return { error: null }
        },
      }
    },
  }
  return { client, calls }
}

function makeStubXeroGet(opts: {
  invoices?: Record<string, any>
  throws?: boolean
}): { xeroGet: (path: string, at: string, ti: string) => Promise<any>; calls: string[] } {
  const calls: string[] = []
  const xeroGet = async (path: string, _at: string, _ti: string) => {
    calls.push(path)
    if (opts.throws) throw new Error("simulated Xero contact-lookup outage")
    if (path.startsWith("/Invoices/")) {
      const id = path.replace("/Invoices/", "")
      const inv = opts.invoices?.[id]
      if (!inv) throw new Error("no fixture for " + path)
      return { Invoices: [inv] }
    }
    throw new Error("unhandled stub path: " + path)
  }
  return { xeroGet, calls }
}

function makeStubGetToken(opts: { throws?: boolean } = {}) {
  let calls = 0
  const getToken = async (_client: any) => {
    calls++
    if (opts.throws) throw new Error("simulated Xero token outage")
    return { accessToken: "stub-token", tenantId: "stub-tenant" }
  }
  return { getToken, callCount: () => calls }
}

function makeStubLogBusinessEvent() {
  const events: any[] = []
  const logBusinessEvent = async (_client: any, event: any) => {
    events.push(event)
  }
  return { logBusinessEvent, events }
}

async function jsonOf(resp: Response) { return await resp.json() }

// Default fixture: invoice cached + linked, job has matching client_email,
// Xero contact has the same email. The "happy path" baseline.
function happyFixture() {
  return {
    seed: {
      xero_invoices: {
        "inv-1": { xero_invoice_id: "inv-1", job_id: "job-1", xero_contact_id: "xc-1" },
      },
      jobs: {
        "job-1": { id: "job-1", client_email: "client@example.com" },
      },
    } satisfies Seed,
    xeroInvoice: {
      InvoiceID: "inv-1",
      Contact: {
        ContactID: "xc-1",
        EmailAddress: "client@example.com",
        ContactPersons: [],
      },
    },
  }
}

// ─────────────────────────────────────────────────────────────────
// A1 — No email_override → verifier returns ok without touching Xero
// (the existing approve_and_send flow handles recipient resolution).
// ─────────────────────────────────────────────────────────────────
Deno.test("A1: no email_override → ok=true, getToken/xeroGet NOT called", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet, calls: xeroCalls } = makeStubXeroGet({ invoices: { "inv-1": fix.xeroInvoice } })
  const { getToken, callCount } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const result = await _verifyApproveAndSendRecipient({
    client,
    body: { xero_invoice_id: "inv-1" },  // no email_override
    getToken, xeroGet, logBusinessEvent,
  })

  assertEquals(result.ok, true)
  assertEquals(callCount(), 0, "getToken must not run when no override")
  assertEquals(xeroCalls.length, 0, "xeroGet must not run when no override")
})

// ─────────────────────────────────────────────────────────────────
// A1b — use_branded_email: false skips verification entirely
// (xero_direct path is safe by construction).
// ─────────────────────────────────────────────────────────────────
Deno.test("A1b: use_branded_email=false → ok=true, no Xero calls even with override", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet, calls } = makeStubXeroGet({ invoices: { "inv-1": fix.xeroInvoice } })
  const { getToken, callCount } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const result = await _verifyApproveAndSendRecipient({
    client,
    body: { xero_invoice_id: "inv-1", email_override: "anyone@whatever.test", use_branded_email: false },
    getToken, xeroGet, logBusinessEvent,
  })

  assertEquals(result.ok, true)
  assertEquals(callCount(), 0)
  assertEquals(calls.length, 0)
})

// ─────────────────────────────────────────────────────────────────
// A2 — email_override matches Xero contact → ok=true
// ─────────────────────────────────────────────────────────────────
Deno.test("A2: matching email_override → ok=true", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-1": fix.xeroInvoice } })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent, events } = makeStubLogBusinessEvent()

  const result = await _verifyApproveAndSendRecipient({
    client,
    body: { xero_invoice_id: "inv-1", email_override: "client@example.com" },
    getToken, xeroGet, logBusinessEvent,
  })

  assertEquals(result.ok, true)
  assertEquals(events.length, 0, "no drift event for matching override")
})

// ─────────────────────────────────────────────────────────────────
// A3 — email_override mismatches everything → 400 recipient_mismatch
// ─────────────────────────────────────────────────────────────────
Deno.test("A3: mismatched email_override → 400 recipient_mismatch", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-1": fix.xeroInvoice } })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const result = await _verifyApproveAndSendRecipient({
    client,
    body: { xero_invoice_id: "inv-1", email_override: "stranger@hotmail.com" },
    getToken, xeroGet, logBusinessEvent,
  })

  assert(!result.ok)
  if (!result.ok) {
    assertEquals(result.response.status, 400)
    const j = await jsonOf(result.response)
    assertEquals(j.code, "recipient_mismatch")
    assertEquals(j.field, "email_override")
    assertEquals(j.received, "stranger@hotmail.com")
    assert(Array.isArray(j.expected) && j.expected.includes("client@example.com"))
  }
})

// ─────────────────────────────────────────────────────────────────
// A4 — Drift: override matches jobs.client_email but not Xero
// → 400 contact_job_recipient_mismatch (more specific than recipient_mismatch)
// ─────────────────────────────────────────────────────────────────
Deno.test("A4: drift case → 400 contact_job_recipient_mismatch", async () => {
  const seed: Seed = {
    xero_invoices: { "inv-1": { xero_invoice_id: "inv-1", job_id: "job-1", xero_contact_id: "xc-1" } },
    jobs: { "job-1": { id: "job-1", client_email: "drifted@hotmail.com" } },
  }
  const xeroInvoice = {
    InvoiceID: "inv-1",
    Contact: { ContactID: "xc-1", EmailAddress: "bilal@xero.test", ContactPersons: [] },
  }
  const { client } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-1": xeroInvoice } })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const result = await _verifyApproveAndSendRecipient({
    client,
    body: { xero_invoice_id: "inv-1", email_override: "drifted@hotmail.com" },
    getToken, xeroGet, logBusinessEvent,
  })

  assert(!result.ok)
  if (!result.ok) {
    const j = await jsonOf(result.response)
    assertEquals(j.code, "contact_job_recipient_mismatch")
    assertEquals(j.field, "email_override")
  }
})

// ─────────────────────────────────────────────────────────────────
// A5 — Acknowledged drift: confirm_drifted_recipient: true overrides the gate.
// Audit row written; ok=true so the caller proceeds with approve+send.
// ─────────────────────────────────────────────────────────────────
Deno.test("A5: confirm_drifted_recipient=true → ok=true, audit row written", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-1": fix.xeroInvoice } })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent, events } = makeStubLogBusinessEvent()

  const result = await _verifyApproveAndSendRecipient({
    client,
    body: {
      xero_invoice_id: "inv-1",
      email_override: "strata@manager.test",
      confirm_drifted_recipient: true,
    },
    getToken, xeroGet, logBusinessEvent,
  })

  assertEquals(result.ok, true)
  assertEquals(events.length, 1)
  assertEquals(events[0].event_type, "invoice.recipient_drift_confirmed")
  assertEquals(events[0].entity_id, "inv-1")
  assertEquals(events[0].job_id, "job-1")
  assertEquals(events[0].payload.override, "strata@manager.test")
  assertEquals(events[0].payload.confirmed_by_caller, true)
  assert(events[0].payload.expected.includes("client@example.com"))
})

// ─────────────────────────────────────────────────────────────────
// A6 — getToken throws → 400 xero_contact_lookup_failed
// (folded into the same hard-stop as the contact-lookup outage).
// ─────────────────────────────────────────────────────────────────
Deno.test("A6: getToken throws → 400 xero_contact_lookup_failed, no approve", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet, calls: xeroCalls } = makeStubXeroGet({ invoices: { "inv-1": fix.xeroInvoice } })
  const { getToken } = makeStubGetToken({ throws: true })
  const { logBusinessEvent, events } = makeStubLogBusinessEvent()

  const result = await _verifyApproveAndSendRecipient({
    client,
    body: { xero_invoice_id: "inv-1", email_override: "client@example.com" },
    getToken, xeroGet, logBusinessEvent,
  })

  assert(!result.ok)
  if (!result.ok) {
    const j = await jsonOf(result.response)
    assertEquals(j.code, "xero_contact_lookup_failed")
    assert(typeof j.detail === "string" && j.detail.includes("simulated Xero token outage"))
  }
  // xeroGet not reached because getToken threw first
  assertEquals(xeroCalls.length, 0)
  // No drift event on rejection
  assertEquals(events.length, 0)
})

// ─────────────────────────────────────────────────────────────────
// A7 — xeroGet contact-lookup throws → 400 xero_contact_lookup_failed
// ─────────────────────────────────────────────────────────────────
Deno.test("A7: xeroGet throws → 400 xero_contact_lookup_failed", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: {}, throws: true })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const result = await _verifyApproveAndSendRecipient({
    client,
    body: { xero_invoice_id: "inv-1", email_override: "client@example.com" },
    getToken, xeroGet, logBusinessEvent,
  })

  assert(!result.ok)
  if (!result.ok) {
    const j = await jsonOf(result.response)
    assertEquals(j.code, "xero_contact_lookup_failed")
    assert(typeof j.detail === "string" && j.detail.includes("simulated Xero contact-lookup outage"))
  }
})

// ─────────────────────────────────────────────────────────────────
// A8 — invoice_not_cached: xero_invoices row missing → 400 invoice_not_cached
// (also proves getToken NOT called when local check fails)
// ─────────────────────────────────────────────────────────────────
Deno.test("A8: invoice_not_cached → 400, getToken NOT called", async () => {
  const { client } = makeStubClient({ xero_invoices: {}, jobs: {} })
  const { xeroGet, calls: xeroCalls } = makeStubXeroGet({ invoices: {} })
  const { getToken, callCount } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const result = await _verifyApproveAndSendRecipient({
    client,
    body: { xero_invoice_id: "inv-missing", email_override: "anyone@example.com" },
    getToken, xeroGet, logBusinessEvent,
  })

  assert(!result.ok)
  if (!result.ok) {
    const j = await jsonOf(result.response)
    assertEquals(j.code, "invoice_not_cached")
  }
  assertEquals(callCount(), 0, "getToken must not run when invoice missing from cache")
  assertEquals(xeroCalls.length, 0)
})

// ─────────────────────────────────────────────────────────────────
// A9 — recipient_unverifiable: Xero empty + jobs.client_email null → 400
// ─────────────────────────────────────────────────────────────────
Deno.test("A9: Xero empty + jobs.client_email null + override present → recipient_unverifiable", async () => {
  const seed: Seed = {
    xero_invoices: { "inv-1": { xero_invoice_id: "inv-1", job_id: "job-1", xero_contact_id: "xc-1" } },
    jobs: { "job-1": { id: "job-1", client_email: null } },
  }
  const xeroInvoice = {
    InvoiceID: "inv-1",
    Contact: { ContactID: "xc-1", EmailAddress: "", ContactPersons: [] },
  }
  const { client } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-1": xeroInvoice } })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const result = await _verifyApproveAndSendRecipient({
    client,
    body: { xero_invoice_id: "inv-1", email_override: "anyone@example.com" },
    getToken, xeroGet, logBusinessEvent,
  })

  assert(!result.ok)
  if (!result.ok) {
    assertEquals((await jsonOf(result.response)).code, "recipient_unverifiable")
  }
})

// ─────────────────────────────────────────────────────────────────
// A10 — Legacy fallback: Xero contact has no email but jobs.client_email matches.
// override = jobs.client_email → ok=true (legacy invoice).
// ─────────────────────────────────────────────────────────────────
Deno.test("A10: Xero empty + jobs.client_email matches override → ok=true (legacy fallback)", async () => {
  const seed: Seed = {
    xero_invoices: { "inv-1": { xero_invoice_id: "inv-1", job_id: "job-1", xero_contact_id: "xc-1" } },
    jobs: { "job-1": { id: "job-1", client_email: "legacy@example.com" } },
  }
  const xeroInvoice = {
    InvoiceID: "inv-1",
    Contact: { ContactID: "xc-1", EmailAddress: "", ContactPersons: [] },
  }
  const { client } = makeStubClient(seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-1": xeroInvoice } })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const result = await _verifyApproveAndSendRecipient({
    client,
    body: { xero_invoice_id: "inv-1", email_override: "legacy@example.com" },
    getToken, xeroGet, logBusinessEvent,
  })

  assertEquals(result.ok, true)
})

// ─────────────────────────────────────────────────────────────────
// A11 — Override case/whitespace insensitivity
// ─────────────────────────────────────────────────────────────────
Deno.test("A11: override '  Client@EXAMPLE.com  ' matches lowercased allowlist", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-1": fix.xeroInvoice } })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const result = await _verifyApproveAndSendRecipient({
    client,
    body: { xero_invoice_id: "inv-1", email_override: "  Client@EXAMPLE.com  " },
    getToken, xeroGet, logBusinessEvent,
  })

  assertEquals(result.ok, true)
})

// ─────────────────────────────────────────────────────────────────
// A12 — Non-string email_override (object) → reject with email_override_invalid_shape.
// Closes the shape-bypass class flagged by Codex stop-hook on 2026-04-30:
// previously a non-string override silently set overrideRaw=null, the verifier
// returned {ok:true}, and the existing case body trusted `body.email_override || ''`
// which is truthy for arrays/objects — forwarding an unverified value to
// the branded send. Mirror of T2's `cc_invalid_shape` pattern.
// ─────────────────────────────────────────────────────────────────
Deno.test("A12: non-string email_override (object) → 400 email_override_invalid_shape", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet, calls } = makeStubXeroGet({ invoices: { "inv-1": fix.xeroInvoice } })
  const { getToken, callCount } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const result = await _verifyApproveAndSendRecipient({
    client,
    body: { xero_invoice_id: "inv-1", email_override: { sneaky: "attacker@evil.com" } },
    getToken, xeroGet, logBusinessEvent,
  })

  assert(!result.ok)
  if (!result.ok) {
    const j = await jsonOf(result.response)
    assertEquals(j.code, "email_override_invalid_shape")
  }
  // Shape gate fires before any Xero call
  assertEquals(callCount(), 0)
  assertEquals(calls.length, 0)
})

// ─────────────────────────────────────────────────────────────────
// A12b [LOAD-BEARING]: array email_override is the same bypass class —
// must reject. JSON-stringify of an array is truthy and would forward
// unverified to the branded send if the shape gate were missing.
// ─────────────────────────────────────────────────────────────────
Deno.test("A12b: array email_override → 400 email_override_invalid_shape", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-1": fix.xeroInvoice } })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const result = await _verifyApproveAndSendRecipient({
    client,
    body: { xero_invoice_id: "inv-1", email_override: ["attacker@evil.com"] },
    getToken, xeroGet, logBusinessEvent,
  })

  assert(!result.ok)
  if (!result.ok) {
    const j = await jsonOf(result.response)
    assertEquals(j.code, "email_override_invalid_shape")
  }
})

// ─────────────────────────────────────────────────────────────────
// A12c: undefined email_override remains a valid no-op — verification skips
// because the override was simply not provided. Confirms the shape gate
// distinguishes "absent" from "wrong shape".
// ─────────────────────────────────────────────────────────────────
Deno.test("A12c: undefined email_override → ok=true (skips verification)", async () => {
  const fix = happyFixture()
  const { client } = makeStubClient(fix.seed)
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-1": fix.xeroInvoice } })
  const { getToken } = makeStubGetToken()
  const { logBusinessEvent } = makeStubLogBusinessEvent()

  const result = await _verifyApproveAndSendRecipient({
    client,
    body: { xero_invoice_id: "inv-1" /* no email_override at all */ },
    getToken, xeroGet, logBusinessEvent,
  })

  assertEquals(result.ok, true)
})
