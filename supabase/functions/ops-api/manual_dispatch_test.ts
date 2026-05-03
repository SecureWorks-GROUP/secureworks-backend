// Tests for manual_dispatch — Loop 6.5 controlled live-readiness bridge.
//
// Spec: secureworks-docs/cio/evidence/secure-sale-cockpit-2026-04-30/
//       loop-6.5-live-readiness-bridge-spec.md
//
// Purity rules:
//   - No real network. Global fetch is replaced with a recorder.
//   - No real Supabase. Stub client mirrors the .from(t).select|update|insert
//     surface manualDispatch actually uses.
//   - MANUAL_DISPATCH_SALT is set per-test via Deno.env so production secrets
//     never leak in.
//   - Tests use _manualDispatchAt with an injected `now` so wall-clock-bound
//     gates (quiet hours, freshness, token replay window) are deterministic.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { _manualDispatchAt as manualDispatch } from "./index.ts"

// ── Stub client ─────────────────────────────────────────────

type Calls = {
  inserts: Array<{ table: string; row: any }>
  updates: Array<{ table: string; patch: any; filters: any[] }>
  selects: Array<{ table: string; filters: any[] }>
}

function makeStubClient(opts: { action: any | null; failApprovalInsert?: boolean }) {
  const calls: Calls = { inserts: [], updates: [], selects: [] }
  const client = {
    from(table: string) {
      let _filters: any[] = []
      let _patch: any = null
      const builder: any = {
        select(_cols: string) { return this },
        eq(col: string, val: any) { _filters.push({ col, val }); return this },
        async single() {
          calls.selects.push({ table, filters: [..._filters] })
          if (table === "ai_proposed_actions") {
            if (!opts.action) return { data: null, error: { message: "row not found" } }
            return { data: opts.action, error: null }
          }
          return { data: null, error: { message: "unexpected single() on " + table } }
        },
        update(patch: any) { _patch = patch; return this },
        async insert(row: any) {
          calls.inserts.push({ table, row })
          if (table === "business_events" && opts.failApprovalInsert
              && row.event_type === "proposed_action.manually_approved") {
            return { error: { message: "simulated insert failure" } }
          }
          return { error: null }
        },
      }
      const updateChainEnd = async () => {
        calls.updates.push({ table, patch: _patch, filters: [..._filters] })
        if (table === "ai_proposed_actions" && _patch?.status === "sent") {
          if (opts.action && opts.action.status === "pending") {
            opts.action.status = "sent"
            return { data: [{ id: opts.action.id }], error: null }
          }
          return { data: [], error: null }
        }
        if (table === "ai_proposed_actions" && _patch?.status === "pending") {
          if (opts.action) opts.action.status = "pending"
          return { data: [{ id: opts.action?.id }], error: null }
        }
        return { data: [{ id: opts.action?.id }], error: null }
      }
      const wrapEq = builder.eq.bind(builder)
      builder.eq = function (col: string, val: any) {
        wrapEq(col, val)
        const proxy: any = {
          eq: builder.eq,
          select: (_cols: string) => ({ then: (resolve: any) => updateChainEnd().then(resolve) }),
          single: builder.single.bind(builder),
          then: (resolve: any, reject: any) => updateChainEnd().then(resolve, reject),
        }
        return proxy
      }
      return builder
    },
  }
  return { client, calls }
}

// ── Helpers ─────────────────────────────────────────────────

const SALT = "test_salt_only_for_unit_tests_never_in_prod"
const SUPABASE_URL = "https://example.supabase.co"

function setEnv() {
  Deno.env.set("MANUAL_DISPATCH_SALT", SALT)
  Deno.env.set("SUPABASE_URL", SUPABASE_URL)
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "stub_service_key")
}

function clearEnv() {
  Deno.env.delete("MANUAL_DISPATCH_SALT")
}

function perthMinuteIso(d: Date): string {
  const perth = new Date(d.getTime() + 8 * 3600 * 1000)
  return perth.toISOString().slice(0, 16)
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function expectedPhrase(method: string, actionId: string, contactName: string | null): string {
  if (method === "canary") {
    return `I authorise one Secure Sale canary SMS to my own number, action_id ${actionId}, now.`
  }
  return `I authorise one Secure Sale manual-pilot SMS to ${contactName || ""}, action_id ${actionId}, now.`
}

async function makeToken(method: string, actionId: string, contactName: string | null, now: Date): Promise<string> {
  const phrase = expectedPhrase(method, actionId, contactName)
  return await sha256Hex(phrase + actionId + perthMinuteIso(now) + SALT)
}

// During-business-hours anchor: 2026-05-15 10:00:00 +08:00 = Perth hour 10 (within 07-20).
const NOW_BUSINESS = new Date("2026-05-15T10:00:00+08:00")

function freshCanaryAction(overrides: Record<string, any> = {}) {
  return {
    id: "a0000000-0000-0000-0000-000000000001",
    job_id: null,
    contact_id: "marnin-contact-id-fixture",
    contact_name: "Marnin Stobbe",
    contact_phone: "+61400000000",
    action_type: "first_contact_sms",
    channel: "sms",
    drafted_message: "[CANARY] hello from Secure Sale loop 6.5",
    status: "pending",
    // Created 1 minute before our test "now" so freshness gate trivially passes.
    created_at: new Date(NOW_BUSINESS.getTime() - 60_000).toISOString(),
    action_payload: {},
    ...overrides,
  }
}

function mockFetch(canned: { ok: boolean; status: number; body: any }) {
  const calls: Array<{ url: string; method: string; body: any }> = []
  // deno-lint-ignore no-explicit-any
  const fakeFetch = async (input: any, init: any) => {
    calls.push({
      url: String(input),
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(init.body) : null,
    })
    return new Response(JSON.stringify(canned.body), {
      status: canned.status,
      headers: { "Content-Type": "application/json" },
    })
  }
  // deno-lint-ignore no-explicit-any
  ;(globalThis as any).fetch = fakeFetch
  return calls
}

// ── Tests ───────────────────────────────────────────────────

Deno.test("rejects when MANUAL_DISPATCH_SALT unset", async () => {
  clearEnv()
  Deno.env.set("SUPABASE_URL", SUPABASE_URL)
  const action = freshCanaryAction()
  const { client } = makeStubClient({ action })
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id,
      approval_token: "anything",
      approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }
  assert(err, "expected error")
  assertEquals(err.status, 500)
  assert(/manual_dispatch_salt_unset/.test(err.message))
})

Deno.test("rejects malformed input — action_id missing", async () => {
  setEnv()
  const { client } = makeStubClient({ action: null })
  let err: any = null
  try {
    await manualDispatch(client, { approval_method: "canary" }, NOW_BUSINESS)
  } catch (e) { err = e }
  assertEquals(err?.status, 400)
  assert(/action_id required/.test(err.message))
})

Deno.test("rejects malformed input — approval_token missing", async () => {
  setEnv()
  const { client } = makeStubClient({ action: null })
  let err: any = null
  try {
    await manualDispatch(client, { action_id: "x", approval_method: "canary" }, NOW_BUSINESS)
  } catch (e) { err = e }
  assertEquals(err?.status, 400)
  assert(/approval_token required/.test(err.message))
})

Deno.test("rejects unknown approval_method", async () => {
  setEnv()
  const { client } = makeStubClient({ action: null })
  let err: any = null
  try {
    await manualDispatch(client, { action_id: "x", approval_token: "x", approval_method: "auto" }, NOW_BUSINESS)
  } catch (e) { err = e }
  assertEquals(err?.status, 400)
  assert(/canary.*manual_pilot/.test(err.message))
})

Deno.test("rejects outside quiet hours (22:30 Perth)", async () => {
  setEnv()
  const lateNow = new Date("2026-05-15T22:30:00+08:00")
  const action = freshCanaryAction()
  const { client } = makeStubClient({ action })
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id, approval_token: "x", approval_method: "canary",
    }, lateNow)
  } catch (e) { err = e }
  assertEquals(err?.status, 400)
  assert(/quiet_hours/.test(err.message), "got: " + err?.message)
})

Deno.test("rejects outside quiet hours (06:00 Perth)", async () => {
  setEnv()
  const earlyNow = new Date("2026-05-15T06:00:00+08:00")
  const action = freshCanaryAction()
  const { client } = makeStubClient({ action })
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id, approval_token: "x", approval_method: "canary",
    }, earlyNow)
  } catch (e) { err = e }
  assertEquals(err?.status, 400)
  assert(/quiet_hours/.test(err.message))
})

Deno.test("rejects when action not found (404)", async () => {
  setEnv()
  const { client } = makeStubClient({ action: null })
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: "missing", approval_token: "x", approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }
  assertEquals(err?.status, 404)
  assert(/action_not_found/.test(err.message))
})

Deno.test("rejects when status != pending (409 already_processed)", async () => {
  setEnv()
  const action = freshCanaryAction({ status: "sent" })
  const { client } = makeStubClient({ action })
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id, approval_token: "x", approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }
  assertEquals(err?.status, 409)
  assert(/already_processed/.test(err.message))
})

Deno.test("rejects when action_type is not first_contact_sms", async () => {
  setEnv()
  const action = freshCanaryAction({ action_type: "followup_sms_t1" })
  const { client } = makeStubClient({ action })
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id, approval_token: "x", approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }
  assertEquals(err?.status, 400)
  assert(/action_type_not_allow_listed/.test(err.message))
})

Deno.test("rejects when action is stale (>24h)", async () => {
  setEnv()
  const stale = new Date(NOW_BUSINESS.getTime() - 26 * 3_600_000).toISOString()
  const action = freshCanaryAction({ created_at: stale })
  const { client } = makeStubClient({ action })
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id, approval_token: "x", approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }
  assertEquals(err?.status, 400)
  assert(/action_stale/.test(err.message))
})

Deno.test("rejects when contact_phone null", async () => {
  setEnv()
  const action = freshCanaryAction({ contact_phone: null })
  const { client } = makeStubClient({ action })
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id, approval_token: "x", approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }
  assertEquals(err?.status, 400)
  assert(/recipient_unresolvable/.test(err.message))
})

Deno.test("rejects when contact_id null", async () => {
  setEnv()
  const action = freshCanaryAction({ contact_id: null })
  const { client } = makeStubClient({ action })
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id, approval_token: "x", approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }
  assertEquals(err?.status, 400)
  assert(/recipient_unresolvable.*contact_id/.test(err.message))
})

Deno.test("rejects when drafted_message empty", async () => {
  setEnv()
  const action = freshCanaryAction({ drafted_message: "" })
  const { client } = makeStubClient({ action })
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id, approval_token: "x", approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }
  assertEquals(err?.status, 400)
  assert(/empty_body/.test(err.message))
})

Deno.test("rejects body too long (>320 chars)", async () => {
  setEnv()
  const action = freshCanaryAction({ drafted_message: "a".repeat(321) })
  const { client } = makeStubClient({ action })
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id, approval_token: "x", approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }
  assertEquals(err?.status, 400)
  assert(/body_too_long/.test(err.message))
})

Deno.test("rejects invalid approval token (403)", async () => {
  setEnv()
  const action = freshCanaryAction()
  const { client } = makeStubClient({ action })
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id,
      approval_token: "0000000000000000000000000000000000000000000000000000000000000000",
      approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }
  assertEquals(err?.status, 403)
  assert(/invalid_approval_token/.test(err.message))
})

Deno.test("SUCCESS — canary fires, audit chain complete, fetch called once", async () => {
  setEnv()
  const action = freshCanaryAction()
  const { client, calls } = makeStubClient({ action })
  const fetchCalls = mockFetch({ ok: true, status: 200, body: { success: true, messageId: "ghl-msg-001" } })

  const token = await makeToken("canary", action.id, action.contact_name, NOW_BUSINESS)
  const result = await manualDispatch(client, {
    action_id: action.id,
    approval_token: token,
    approval_method: "canary",
  }, NOW_BUSINESS)

  assertEquals(result.success, true)
  assertEquals(result.action_id, action.id)
  assertEquals(result.approval_method, "canary")
  assertEquals(result.ghl_message_id, "ghl-msg-001")

  // Audit chain: 2 business_events inserts (manually_approved + dispatched).
  // sms_sent is written by ghl-proxy itself, not by manual_dispatch.
  const events = calls.inserts.filter((c) => c.table === "business_events")
  assertEquals(events.length, 2)
  assertEquals(events[0].row.event_type, "proposed_action.manually_approved")
  assertEquals(events[1].row.event_type, "proposed_action.dispatched")
  assertEquals(events[0].row.entity_id, action.id)
  assertEquals(events[0].row.payload.approval_method, "canary")

  // Status flip happened.
  const updates = calls.updates.filter((c) => c.table === "ai_proposed_actions")
  assertEquals(updates.length, 1)
  assertEquals(updates[0].patch.status, "sent")
  assertEquals(updates[0].patch.action_payload.approval.approval_method, "canary")

  // Fetch fired exactly once at ghl-proxy.
  assertEquals(fetchCalls.length, 1)
  assert(fetchCalls[0].url.includes("/functions/v1/ghl-proxy?action=send_sms"))
  assertEquals(fetchCalls[0].method, "POST")
  assertEquals(fetchCalls[0].body.contactId, action.contact_id)
  assertEquals(fetchCalls[0].body.message, action.drafted_message)
})

Deno.test("token replay window: 4-min-old token still valid", async () => {
  setEnv()
  const action = freshCanaryAction()
  const { client } = makeStubClient({ action })
  mockFetch({ ok: true, status: 200, body: { messageId: "ghl-msg-002" } })

  const fourMinAgo = new Date(NOW_BUSINESS.getTime() - 4 * 60_000)
  const token = await makeToken("canary", action.id, action.contact_name, fourMinAgo)
  const result = await manualDispatch(client, {
    action_id: action.id,
    approval_token: token,
    approval_method: "canary",
  }, NOW_BUSINESS)
  assertEquals(result.success, true)
})

Deno.test("token replay window: 6-min-old token rejected", async () => {
  setEnv()
  const action = freshCanaryAction()
  const { client } = makeStubClient({ action })

  const sixMinAgo = new Date(NOW_BUSINESS.getTime() - 6 * 60_000)
  const token = await makeToken("canary", action.id, action.contact_name, sixMinAgo)
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id,
      approval_token: token,
      approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }
  assertEquals(err?.status, 403)
  assert(/invalid_approval_token/.test(err.message))
})

Deno.test("idempotency: re-firing after success returns 409", async () => {
  setEnv()
  const action = freshCanaryAction()
  const { client } = makeStubClient({ action })
  mockFetch({ ok: true, status: 200, body: { messageId: "ghl-msg-003" } })

  const token = await makeToken("canary", action.id, action.contact_name, NOW_BUSINESS)
  await manualDispatch(client, {
    action_id: action.id, approval_token: token, approval_method: "canary",
  }, NOW_BUSINESS)

  // After success, action.status === 'sent'. Second call must 409.
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id, approval_token: token, approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }
  assertEquals(err?.status, 409)
  assert(/already_processed/.test(err.message))
})

Deno.test("ghl-proxy failure: status rolled back to pending, dispatch_failed event written", async () => {
  setEnv()
  const action = freshCanaryAction()
  const { client, calls } = makeStubClient({ action })
  mockFetch({ ok: false, status: 500, body: { error: "GHL outage" } })

  const token = await makeToken("canary", action.id, action.contact_name, NOW_BUSINESS)
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id, approval_token: token, approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }

  assertEquals(err?.status, 502)
  assert(/ghl_proxy_send_failed/.test(err.message))

  // Both manually_approved AND dispatch_failed rows written.
  const events = calls.inserts.filter((c) => c.table === "business_events")
  assertEquals(events.length, 2)
  assertEquals(events[0].row.event_type, "proposed_action.manually_approved")
  assertEquals(events[1].row.event_type, "proposed_action.dispatch_failed")

  // Two ai_proposed_actions updates: flip to 'sent' then rollback to 'pending'.
  const updates = calls.updates.filter((c) => c.table === "ai_proposed_actions")
  assertEquals(updates.length, 2)
  assertEquals(updates[0].patch.status, "sent")
  assertEquals(updates[1].patch.status, "pending")
})

// ── Codex stop-time #7 — HTTP 200 with failure body must NOT mark dispatched ──
// ghl-proxy can return 200 OK with success:false, dedup_blocked:true, or no
// messageId. All of these mean NO SMS went out. The handler must roll back
// the row and emit dispatch_failed, never dispatched.

Deno.test("ghl-proxy returns 200 + success:false → dispatch_failed, status rolled back", async () => {
  setEnv()
  const action = freshCanaryAction()
  const { client, calls } = makeStubClient({ action })
  mockFetch({ ok: true, status: 200, body: { success: false, error: "GHL token expired" } })

  const token = await makeToken("canary", action.id, action.contact_name, NOW_BUSINESS)
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id, approval_token: token, approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }

  assertEquals(err?.status, 502)
  assert(/success=false|GHL token expired/.test(err.message), "got: " + err?.message)

  const events = calls.inserts.filter((c) => c.table === "business_events")
  assertEquals(events.length, 2)
  assertEquals(events[1].row.event_type, "proposed_action.dispatch_failed")

  // Status flipped to sent, then rolled back to pending.
  const updates = calls.updates.filter((c) => c.table === "ai_proposed_actions")
  assertEquals(updates.length, 2)
  assertEquals(updates[1].patch.status, "pending")
})

Deno.test("ghl-proxy returns 200 + dedup_blocked:true → dispatch_failed, status rolled back", async () => {
  setEnv()
  const action = freshCanaryAction()
  const { client, calls } = makeStubClient({ action })
  // Simulate the case where ghl-proxy returns 200 with dedup_blocked. (The
  // production ghl-proxy actually returns 409, but we lock in defense-in-depth
  // for the 200 variant in case future ghl-proxy versions change status code.)
  mockFetch({
    ok: true, status: 200,
    body: { success: false, dedup_blocked: true, error: "identical SMS sent recently" },
  })

  const token = await makeToken("canary", action.id, action.contact_name, NOW_BUSINESS)
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id, approval_token: token, approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }

  assertEquals(err?.status, 502)

  const events = calls.inserts.filter((c) => c.table === "business_events")
  assertEquals(events[1].row.event_type, "proposed_action.dispatch_failed")
  // Failure event payload preserves the error string for audit.
  assert(/dedup|identical/i.test(events[1].row.payload.error || ""), "got: " + events[1].row.payload.error)

  const updates = calls.updates.filter((c) => c.table === "ai_proposed_actions")
  assertEquals(updates.length, 2)
  assertEquals(updates[1].patch.status, "pending")
})

Deno.test("ghl-proxy returns 200 with no messageId → dispatch_failed, status rolled back", async () => {
  setEnv()
  const action = freshCanaryAction()
  const { client, calls } = makeStubClient({ action })
  // Ambiguous response — 200 OK but no messageId. Treat as failure: we
  // cannot prove the SMS reached the carrier.
  mockFetch({ ok: true, status: 200, body: { success: true } })

  const token = await makeToken("canary", action.id, action.contact_name, NOW_BUSINESS)
  let err: any = null
  try {
    await manualDispatch(client, {
      action_id: action.id, approval_token: token, approval_method: "canary",
    }, NOW_BUSINESS)
  } catch (e) { err = e }

  assertEquals(err?.status, 502)
  assert(/no messageId/i.test(err.message), "got: " + err?.message)

  const events = calls.inserts.filter((c) => c.table === "business_events")
  assertEquals(events[1].row.event_type, "proposed_action.dispatch_failed")

  const updates = calls.updates.filter((c) => c.table === "ai_proposed_actions")
  assertEquals(updates.length, 2)
  assertEquals(updates[1].patch.status, "pending")
})

Deno.test("ghl-proxy returns 200 with id (legacy field name) → success, dispatched", async () => {
  // Some ghl-proxy versions name the field `id`, not `messageId`. Cover both.
  setEnv()
  const action = freshCanaryAction()
  const { client, calls } = makeStubClient({ action })
  mockFetch({ ok: true, status: 200, body: { id: "ghl-msg-legacy-001" } })

  const token = await makeToken("canary", action.id, action.contact_name, NOW_BUSINESS)
  const result = await manualDispatch(client, {
    action_id: action.id, approval_token: token, approval_method: "canary",
  }, NOW_BUSINESS)

  assertEquals(result.success, true)
  assertEquals(result.ghl_message_id, "ghl-msg-legacy-001")

  const events = calls.inserts.filter((c) => c.table === "business_events")
  assertEquals(events[1].row.event_type, "proposed_action.dispatched")
})
