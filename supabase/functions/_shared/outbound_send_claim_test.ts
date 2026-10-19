import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import {
  approvedSendKey,
  canonicalSendId,
  claimSend,
  confirmSendDispatch,
  debtReportSendKey,
  debtStatementSendKey,
  emailContentKey,
  extendSendClaim,
  invoiceSendKey,
  makesafePackSendKey,
  reconcileActor,
  reconcileHeld,
  reconcileThenClaim,
  readSendHolds,
  SEND_CLAIM_LEASE_SECONDS,
  sendClaimRefusalBody,
  sendClaimRefusalStatus,
  settleSend,
} from "./outbound_send_claim.ts"
import { makeFakeClaimStore } from "./outbound_send_claim_fake.ts"

Deno.test("claim: two presses together, exactly one wins", async () => {
  const store = makeFakeClaimStore()
  const [a, b] = await Promise.all([
    claimSend(store, { keys: ["invoice:X1"], attemptId: "a" }),
    claimSend(store, { keys: ["invoice:X1"], attemptId: "b" }),
  ])
  assertEquals([a.ok, b.ok].filter(Boolean).length, 1)
  const loser = a.ok ? b : a
  assert(!loser.ok)
  assertEquals(loser.code, "send_claim_held")
  assertEquals(loser.held[0].state, "sending")
  assertEquals(sendClaimRefusalBody(loser).state, "sending")
  assertEquals(sendClaimRefusalStatus(loser), 409)
})

Deno.test("claim: a sent item frees the key; an unknown one holds it", async () => {
  const store = makeFakeClaimStore()
  assert((await claimSend(store, { keys: ["k"], attemptId: "a" })).ok)
  assertEquals(await settleSend(store, "a", "sent"), { ok: true })
  assert((await claimSend(store, { keys: ["k"], attemptId: "b" })).ok)
  assertEquals(await settleSend(store, "b", "outcome_unknown"), { ok: true })
  const third = await claimSend(store, { keys: ["k"], attemptId: "c" })
  assert(!third.ok)
  const body = sendClaimRefusalBody(third)
  assertEquals(body.state, "outcome_unknown")
  assertEquals(body.retry_safe, false)
})

Deno.test("claim: a later success never clears an earlier unknown", async () => {
  const store = makeFakeClaimStore()
  await claimSend(store, { keys: ["k"], attemptId: "a" })
  await settleSend(store, "a", "outcome_unknown")
  // a second attempt is never admitted, so it can never settle sent over the first
  assert(!(await claimSend(store, { keys: ["k"], attemptId: "b" })).ok)
  assertEquals(store.rowsFor("k").map((r) => r.state), ["outcome_unknown"])
})

Deno.test("claim: an RPC failure or throw refuses (fails closed)", async () => {
  const store = makeFakeClaimStore()
  store.failNext("claim_outbound_send")
  const a = await claimSend(store, { keys: ["k"], attemptId: "a" })
  assert(!a.ok)
  assertEquals(a.code, "send_claim_unavailable")
  assertEquals(sendClaimRefusalStatus(a), 503)
  assertEquals(sendClaimRefusalBody(a).state, "not_sent")
  store.failNext("claim_outbound_send", "throw")
  const b = await claimSend(store, { keys: ["k"], attemptId: "b" })
  assert(!b.ok)
  assertEquals(b.code, "send_claim_unavailable")
  store.fail("read_outbound_send_holds")
  const read = await readSendHolds(store, ["k"])
  assert(!read.ok)
  assertEquals(read.code, "send_claim_unreadable")
})

Deno.test("settle: a lost settle leaves the hold, and it reads stale after the lease", async () => {
  const store = makeFakeClaimStore()
  await claimSend(store, { keys: ["k"], attemptId: "a", leaseSeconds: 60 })
  store.failNext("settle_outbound_send")
  assertEquals(await settleSend(store, "a", "outcome_unknown"), { ok: false, code: "send_settle_failed" })
  store.advance(61_000)
  const again = await claimSend(store, { keys: ["k"], attemptId: "b" })
  assert(!again.ok)
  assertEquals(again.held[0].stale, true)
  // a stale send is shown as uncertain, never as "being sent now"
  assertEquals(sendClaimRefusalBody(again).state, "outcome_unknown")
})

Deno.test("reconcile: a live send is never released", async () => {
  const store = makeFakeClaimStore()
  await claimSend(store, { keys: ["k"], attemptId: "a" })
  const r = await reconcileThenClaim(store, { keys: ["k"], attemptId: "b", actor: "jan@example.test" })
  assert(!r.ok)
  assertEquals(r.code, "send_reconcile_live_send")
  assertEquals(store.rowsFor("k").map((x) => x.state), ["sending"])
})

Deno.test("reconcile: a named checker is required", async () => {
  const store = makeFakeClaimStore()
  await claimSend(store, { keys: ["k"], attemptId: "a" })
  await settleSend(store, "a", "outcome_unknown")
  for (const actor of [null, "", "actor_missing", "unknown"]) {
    const r = await reconcileThenClaim(store, { keys: ["k"], attemptId: `b-${actor}`, actor })
    assert(!r.ok)
    assertEquals(r.code, "send_reconcile_actor_required")
  }
  assertEquals(reconcileActor(null, " ops@x ", "y"), "ops@x")
})

Deno.test("reconcile: two checked presses together, exactly one sends", async () => {
  const store = makeFakeClaimStore()
  await claimSend(store, { keys: ["k"], attemptId: "a" })
  await settleSend(store, "a", "outcome_unknown")
  const [x, y] = await Promise.all([
    reconcileThenClaim(store, { keys: ["k"], attemptId: "b", actor: "jan" }),
    reconcileThenClaim(store, { keys: ["k"], attemptId: "c", actor: "shaun" }),
  ])
  assertEquals([x.ok, y.ok].filter(Boolean).length, 1)
  const loser = x.ok ? y : x
  assert(!loser.ok)
  assert(["send_reconcile_state_changed", "send_reconcile_live_send", "send_claim_held"].includes(loser.code))
  const reconciled = store.rows.filter((r) => r.state === "reconciled_not_sent")
  assertEquals(reconciled.length, 1)
  assert(["jan", "shaun"].includes(reconciled[0].reconciled_by ?? ""))
  assert(reconciled[0].reconcile_checked_at)
})

Deno.test("reconcile: a stale sending row (settle lost) can be released by an explicit check", async () => {
  const store = makeFakeClaimStore()
  await claimSend(store, { keys: ["k"], attemptId: "a", leaseSeconds: 60 })
  store.advance(61_000)
  const r = await reconcileThenClaim(store, { keys: ["k"], attemptId: "b", actor: "jan", evidence: "sent_items_checked" })
  assert(r.ok)
  assertEquals(store.rowsFor("k").map((x) => x.state), ["reconciled_not_sent", "sending"])
})

Deno.test("reconcile: naming a different attempt refuses", async () => {
  const store = makeFakeClaimStore()
  await claimSend(store, { keys: ["k"], attemptId: "a" })
  await settleSend(store, "a", "outcome_unknown")
  const r = await reconcileThenClaim(store, { keys: ["k"], attemptId: "b", actor: "jan", expectedAttemptId: "zzz" })
  assert(!r.ok)
  assertEquals(r.code, "send_reconcile_attempt_mismatch")
  const ok = await reconcileThenClaim(store, { keys: ["k"], attemptId: "c", actor: "jan", expectedAttemptId: "a" })
  assert(ok.ok)
})

Deno.test("reconcile: a failed reconcile write refuses and sends nothing", async () => {
  const store = makeFakeClaimStore()
  await claimSend(store, { keys: ["k"], attemptId: "a" })
  await settleSend(store, "a", "outcome_unknown")
  store.failNext("reconcile_outbound_send")
  const r = await reconcileThenClaim(store, { keys: ["k"], attemptId: "b", actor: "jan" })
  assert(!r.ok)
  assertEquals(r.code, "send_claim_unavailable")
  assertEquals(store.rowsFor("k").map((x) => x.state), ["outcome_unknown"])
})

Deno.test("extend: a door joins its caller's live claim, and a held content key refuses", async () => {
  const store = makeFakeClaimStore()
  await claimSend(store, { keys: ["email_content:abc"], attemptId: "plain" })
  await claimSend(store, { keys: ["invoice:X"], attemptId: "inv" })
  const held = await extendSendClaim(store, { attemptId: "inv", keys: ["email_content:abc"] })
  assert(!held.ok)
  assertEquals(held.code, "send_claim_held")
  const ok = await extendSendClaim(store, { attemptId: "inv", keys: ["email_content:def"] })
  assert(ok.ok)
  await settleSend(store, "inv", "outcome_unknown")
  assertEquals(store.rowsFor("email_content:def")[0].state, "outcome_unknown")
  const notSending = await extendSendClaim(store, { attemptId: "inv", keys: ["email_content:ghi"] })
  assert(!notSending.ok)
  assertEquals(notSending.code, "send_claim_not_sending")
})

Deno.test("email content key: same email, same key; any change, new key", async () => {
  const base = { mailbox: "Admin@x", to: ["b@y", "A@y"], subject: "s", html: "<p>h</p>", attachmentHashes: ["2", "1"] }
  const k1 = await emailContentKey(base)
  const k2 = await emailContentKey({ ...base, mailbox: "admin@x", to: ["a@y", "b@y"], attachmentHashes: ["1", "2"] })
  assertEquals(k1, k2)
  assert(k1 !== await emailContentKey({ ...base, subject: "t" }))
  assert(k1 !== await emailContentKey({ ...base, attachmentHashes: ["1"] }))
})

// ---------------------------------------------------------------------------
// Single-use dispatch, the pre-send fence, caller deferral (Codex review 0cc1a193).

const T0 = Date.parse("2026-10-19T00:00:00Z")

Deno.test("claim: returns a dispatch token that confirms, with a 900 second lease by default", async () => {
  const store = makeFakeClaimStore({ now: T0 })
  assertEquals(SEND_CLAIM_LEASE_SECONDS, 900)
  const claim = await claimSend(store, { keys: ["invoice:X"], attemptId: "a" })
  assert(claim.ok)
  assert(claim.dispatch_token.length > 0)
  assertEquals(store.calls[0].args.p_lease_seconds, 900)
  assertEquals(store.rowsOf("a")[0].lease_until, new Date(T0 + 900_000).toISOString())
  assertEquals(await confirmSendDispatch(store, { attemptId: "a", dispatchToken: claim.dispatch_token }), { ok: true })
  const stranger = await confirmSendDispatch(store, { attemptId: "a", dispatchToken: crypto.randomUUID() })
  assert(!stranger.ok)
  assertEquals(stranger.code, "send_dispatch_fenced")
  // a lease shorter than 30 seconds is raised to 30, as in SQL
  await claimSend(store, { keys: ["invoice:Y"], attemptId: "b", leaseSeconds: 5 })
  assertEquals(store.rowsOf("b")[0].lease_until, new Date(T0 + 30_000).toISOString())
})

Deno.test("extend: single-use; a repeat, with the same keys or others, is dispatch_taken, never success", async () => {
  const store = makeFakeClaimStore()
  const claim = await claimSend(store, { keys: ["invoice:X"], attemptId: "inv" })
  assert(claim.ok)
  const own = await extendSendClaim(store, { attemptId: "inv", keys: ["invoice:X"], callerItemKey: "invoice:X" })
  assert(!own.ok)
  assertEquals(own.code, "send_claim_dispatch_taken")
  const first = await extendSendClaim(store, { attemptId: "inv", keys: ["email_content:abc"], callerItemKey: "invoice:X" })
  assert(first.ok)
  assert(first.dispatch_token && first.dispatch_token !== claim.dispatch_token)
  const repeat = await extendSendClaim(store, { attemptId: "inv", keys: ["email_content:abc"], callerItemKey: "invoice:X" })
  assert(!repeat.ok)
  assertEquals(repeat.code, "send_claim_dispatch_taken")
  const other = await extendSendClaim(store, { attemptId: "inv", keys: ["email_content:def"] })
  assert(!other.ok)
  assertEquals(other.code, "send_claim_dispatch_taken")
  assertEquals(store.rowsFor("email_content:def"), [])
  assertEquals(sendClaimRefusalBody(repeat).state, "sending")
  assertEquals(sendClaimRefusalStatus(repeat), 409)
})

Deno.test("extend: two requests carrying one caller attempt together, exactly one dispatches", async () => {
  for (const keys of [["email_content:same", "email_content:same"], ["email_content:one", "email_content:two"]]) {
    const store = makeFakeClaimStore()
    await claimSend(store, { keys: ["invoice:X"], attemptId: "inv" })
    const [a, b] = await Promise.all(keys.map((k) =>
      extendSendClaim(store, { attemptId: "inv", keys: [k], callerItemKey: "invoice:X" })
    ))
    assertEquals([a.ok, b.ok].filter(Boolean).length, 1)
    const loser = a.ok ? b : a
    assert(!loser.ok)
    assertEquals(loser.code, "send_claim_dispatch_taken")
    assertEquals(store.rowsOf("inv").length, 2)
    assertEquals(new Set(store.rowsOf("inv").map((r) => r.dispatch_token)).size, 1)
  }
})

Deno.test("extend: a caller item key that is not the attempt's own refuses", async () => {
  const store = makeFakeClaimStore()
  await claimSend(store, { keys: ["invoice:X"], attemptId: "inv" })
  const r = await extendSendClaim(store, { attemptId: "inv", keys: ["email_content:abc"], callerItemKey: "invoice:OTHER" })
  assert(!r.ok)
  assertEquals(r.code, "send_claim_item_mismatch")
  assertEquals(store.rowsFor("email_content:abc"), [])
  assertEquals(sendClaimRefusalBody(r).state, "not_sent")
  assertEquals(store.calls.at(-1)?.args.p_caller_item_key, "invoice:OTHER")
  // with no caller key the door's claim is not checked against an item
  assert((await extendSendClaim(store, { attemptId: "inv", keys: ["email_content:abc"] })).ok)
})

Deno.test("extend: the door's token replaces the caller's, which is then fenced", async () => {
  const store = makeFakeClaimStore()
  const claim = await claimSend(store, { keys: ["invoice:X"], attemptId: "inv" })
  assert(claim.ok)
  const door = await extendSendClaim(store, { attemptId: "inv", keys: ["email_content:abc"], callerItemKey: "invoice:X" })
  assert(door.ok)
  const caller = await confirmSendDispatch(store, { attemptId: "inv", dispatchToken: claim.dispatch_token })
  assert(!caller.ok)
  assertEquals(caller.code, "send_dispatch_fenced")
  assertEquals(await confirmSendDispatch(store, { attemptId: "inv", dispatchToken: door.dispatch_token }), { ok: true })
})

Deno.test("settle: a caller settle while the door's dispatch is open is deferred, and the door settles once", async () => {
  const store = makeFakeClaimStore()
  await claimSend(store, { keys: ["invoice:X"], attemptId: "inv" })
  await extendSendClaim(store, { attemptId: "inv", keys: ["email_content:abc"], callerItemKey: "invoice:X" })
  const deferred = await settleSend(store, "inv", "failed", { why: "door 5xx" }, { settler: "caller" })
  assertEquals(deferred, { ok: true, deferred: true, state: "sending" })
  assertEquals(store.rowsOf("inv").map((r) => r.state), ["sending", "sending"])
  assert(store.events.some((e) => e.event === "caller_settle_deferred"))
  assertEquals(await settleSend(store, "inv", "outcome_unknown"), { ok: true })
  assertEquals(store.rowsOf("inv").map((r) => r.state), ["outcome_unknown", "outcome_unknown"])
  assert(store.rowsOf("inv").every((r) => r.dispatch_ended_at !== null))
  assertEquals(await settleSend(store, "inv", "failed", {}, { settler: "caller" }), { ok: false, code: "send_claim_not_sending" })
})

Deno.test("settle: a caller settle with no open extension settles as before; settler is sent and checked", async () => {
  const store = makeFakeClaimStore()
  await claimSend(store, { keys: ["invoice:X"], attemptId: "a" })
  assertEquals(await settleSend(store, "a", "sent", {}, { settler: "caller" }), { ok: true })
  await claimSend(store, { keys: ["invoice:Y"], attemptId: "b" })
  await settleSend(store, "b", "sent")
  assertEquals(store.calls.at(-1)?.args.p_settler, "dispatcher")
  assertEquals(
    await settleSend(store, "b", "sent", {}, { settler: "nobody" as "caller" }),
    { ok: false, code: "send_settle_invalid_settler" },
  )
})

Deno.test("settle: a door's extend and its caller's settle together serialise", async () => {
  const store = makeFakeClaimStore()
  await claimSend(store, { keys: ["invoice:X"], attemptId: "inv" })
  const [ext, settle] = await Promise.all([
    extendSendClaim(store, { attemptId: "inv", keys: ["email_content:abc"], callerItemKey: "invoice:X" }),
    settleSend(store, "inv", "outcome_unknown", {}, { settler: "caller" }),
  ])
  if (ext.ok) {
    assertEquals(settle, { ok: true, deferred: true, state: "sending" })
    assertEquals(store.rowsOf("inv").map((r) => r.state), ["sending", "sending"])
  } else {
    assertEquals(ext.code, "send_claim_not_sending")
    assertEquals(settle, { ok: true })
    assertEquals(store.rowsOf("inv").map((r) => r.state), ["outcome_unknown"])
  }
})

Deno.test("confirm: a lapsed lease, a store failure or a missing token fences", async () => {
  const store = makeFakeClaimStore()
  const claim = await claimSend(store, { keys: ["k"], attemptId: "a", leaseSeconds: 60 })
  assert(claim.ok)
  store.failNext("confirm_outbound_dispatch")
  assertEquals((await confirmSendDispatch(store, { attemptId: "a", dispatchToken: claim.dispatch_token })).ok, false)
  store.failNext("confirm_outbound_dispatch", "throw")
  assertEquals((await confirmSendDispatch(store, { attemptId: "a", dispatchToken: claim.dispatch_token })).ok, false)
  const calls = store.calls.length
  assertEquals((await confirmSendDispatch(store, { attemptId: "a", dispatchToken: "" })).ok, false)
  assertEquals(store.calls.length, calls)
  store.advance(61_000)
  const lapsed = await confirmSendDispatch(store, { attemptId: "a", dispatchToken: claim.dispatch_token })
  assert(!lapsed.ok)
  assertEquals(lapsed.code, "send_dispatch_fenced")
  assertEquals(sendClaimRefusalBody(lapsed).state, "not_sent")
  assertEquals(sendClaimRefusalStatus(lapsed), 409)
})

Deno.test("reconcile: an open dispatch inside its lease is never released, even in outcome_unknown", async () => {
  const store = makeFakeClaimStore()
  await claimSend(store, { keys: ["k"], attemptId: "a", leaseSeconds: 60 })
  await settleSend(store, "a", "outcome_unknown")
  // a dispatch still open on an unknown attempt (the door has not settled)
  for (const r of store.rowsOf("a")) r.dispatch_ended_at = null
  const live = await reconcileHeld(store, { keys: ["k"], result: "not_sent", actor: "jan" })
  assert(!live.ok)
  assertEquals(live.code, "send_reconcile_live_send")
  assertEquals(store.rowsFor("k").map((r) => r.state), ["outcome_unknown"])
  store.advance(61_000)
  const released = await reconcileHeld(store, { keys: ["k"], result: "not_sent", actor: "jan" })
  assert(released.ok)
})

Deno.test("reconcile: a lapsed send released by a named checker fences the late worker's confirm", async () => {
  const store = makeFakeClaimStore()
  const claim = await claimSend(store, { keys: ["k"], attemptId: "a", leaseSeconds: 60 })
  assert(claim.ok)
  store.advance(61_000)
  const r = await reconcileThenClaim(store, { keys: ["k"], attemptId: "b", actor: "jan", evidence: "sent_items_checked" })
  assert(r.ok)
  assertEquals(store.rowsOf("a")[0].dispatch_token, null)
  // even with its lease forced live again the old token never confirms
  store.rowsOf("a")[0].lease_until = new Date(Date.parse(store.rowsOf("a")[0].lease_until) + 3_600_000).toISOString()
  const late = await confirmSendDispatch(store, { attemptId: "a", dispatchToken: claim.dispatch_token })
  assert(!late.ok)
  assertEquals(late.code, "send_dispatch_fenced")
})

Deno.test("reconcile: a reconcile and a late confirm together serialise, in either order", async () => {
  const store = makeFakeClaimStore()
  const claim = await claimSend(store, { keys: ["k"], attemptId: "a", leaseSeconds: 60 })
  assert(claim.ok)
  store.advance(61_000)
  const [rec, conf] = await Promise.all([
    reconcileHeld(store, { keys: ["k"], result: "not_sent", actor: "jan" }),
    confirmSendDispatch(store, { attemptId: "a", dispatchToken: claim.dispatch_token }),
  ])
  assert(rec.ok)
  assert(!conf.ok)
  const live = makeFakeClaimStore()
  const c2 = await claimSend(live, { keys: ["k"], attemptId: "a" })
  assert(c2.ok)
  const [conf2, rec2] = await Promise.all([
    confirmSendDispatch(live, { attemptId: "a", dispatchToken: c2.dispatch_token }),
    live.rpc("reconcile_outbound_send", {
      p_attempt_id: "a", p_expected_state: "sending", p_result: "not_sent", p_actor: "jan",
      p_checked_at: new Date().toISOString(), p_evidence: null,
    }),
  ])
  assertEquals(conf2, { ok: true })
  assertEquals((rec2.data as { code: string }).code, "send_reconcile_live_send")
})

Deno.test("fake: a call waits for the attempt lock another call holds", async () => {
  const store = makeFakeClaimStore()
  await claimSend(store, { keys: ["k"], attemptId: "a" })
  const order: string[] = []
  await Promise.all([
    store.rpc("settle_outbound_send", { p_attempt_id: "a", p_state: "sent", p_settler: "caller" }).then(() => order.push("settle")),
    store.rpc("extend_outbound_send_claim", { p_attempt_id: "a", p_keys: ["c"] }).then((r) => order.push(String((r.data as { code?: string }).code ?? "extended"))),
  ])
  // the settle took the attempt lock first, so the extend saw a settled attempt
  assertEquals(order, ["settle", "send_claim_not_sending"])
})

// ---------------------------------------------------------------------------
// Identity helpers.

Deno.test("keys: UUID-shaped ids are lowercased and trimmed; other ids keep their case", () => {
  const id = "  3F2504E0-4F89-11D3-9A0C-0305E82C3301 "
  assertEquals(canonicalSendId(id), "3f2504e0-4f89-11d3-9a0c-0305e82c3301")
  assertEquals(invoiceSendKey(id), "invoice:3f2504e0-4f89-11d3-9a0c-0305e82c3301")
  assertEquals(invoiceSendKey(id), invoiceSendKey(id.trim().toLowerCase()))
  assertEquals(invoiceSendKey(" INV-0042 "), "invoice:INV-0042")
  assertEquals(debtReportSendKey(id), "debt_report:3f2504e0-4f89-11d3-9a0c-0305e82c3301")
  assertEquals(
    debtStatementSendKey(id, " ABCDEF01-2345-6789-ABCD-EF0123456789"),
    "debt_statement:3f2504e0-4f89-11d3-9a0c-0305e82c3301:abcdef01-2345-6789-abcd-ef0123456789",
  )
  assertEquals(makesafePackSendKey(id), "makesafe_pack:3f2504e0-4f89-11d3-9a0c-0305e82c3301:main")
  assertEquals(makesafePackSendKey(id, " Photo "), "makesafe_pack:3f2504e0-4f89-11d3-9a0c-0305e82c3301:photo")
  assertEquals(approvedSendKey(" abc123 "), "approved_send:abc123")
})

Deno.test("email content key: cc and bcc count, in any order and case", async () => {
  const base = { mailbox: "admin@x", to: ["a@y"], cc: ["C@y", "b@y"], bcc: ["Z@y"], subject: "s", html: "h" }
  const k = await emailContentKey(base)
  assertEquals(k, await emailContentKey({ ...base, cc: ["b@y", "c@y"], bcc: ["z@y"] }))
  assert(k !== await emailContentKey({ ...base, cc: ["b@y"] }))
  assert(k !== await emailContentKey({ ...base, bcc: [] }))
})

Deno.test("email content key: attachments carry name and type; bare hashes are name and type unknown", async () => {
  const base = { mailbox: "admin@x", to: ["a@y"], subject: "s", html: "h" }
  const a = { sha256: "AA", name: "Invoice.pdf", contentType: "Application/PDF" }
  const b = { sha256: "bb", name: "photo.jpg", contentType: "image/jpeg" }
  const k = await emailContentKey({ ...base, attachments: [a, b] })
  assertEquals(k, await emailContentKey({ ...base, attachments: [b, { ...a, sha256: "aa", contentType: "application/pdf" }] }))
  assert(k !== await emailContentKey({ ...base, attachments: [{ ...a, name: "Other.pdf" }, b] }))
  assert(k !== await emailContentKey({ ...base, attachments: [{ ...a, contentType: "text/plain" }, b] }))
  assertEquals(
    await emailContentKey({ ...base, attachmentHashes: ["bb", "aa"] }),
    await emailContentKey({ ...base, attachments: [{ sha256: "AA" }, { sha256: "bb", name: null, contentType: null }] }),
  )
  assert(k !== await emailContentKey({ ...base, attachmentHashes: ["aa", "bb"] }))
})
