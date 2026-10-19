import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import {
  claimSend,
  emailContentKey,
  extendSendClaim,
  reconcileActor,
  reconcileThenClaim,
  readSendHolds,
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
