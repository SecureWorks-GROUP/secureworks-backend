// In-memory stand-in for the six outbound send claim functions
// (20261019170000_outbound_send_claims.sql), for tests only. Same rules and
// refusal codes: one unresolved attempt per item, single-use dispatch with a
// token the pre-send fence checks, caller settles deferred behind an open
// extended dispatch, settle and reconcile compare-and-set, an open or sending
// attempt inside its lease never reconciled, every call logged. Lease
// arithmetic matches the SQL (claim: max(lease, 30) seconds, default 900;
// extend: the later of the attempt's lease and now + 900).
//
// Each call models the database's advisory locks with an async mutex per
// attempt and, for claim and extend, per key in sorted order. A call yields
// once before it takes its locks and once after, before its body runs, so
// concurrent callers interleave as they would against the database and a
// caller holding a lock is really waited on; the body itself runs without
// interruption, as the database's statement does.

export type FakeClaimRow = {
  attempt_id: string
  item_key: string
  state: "sending" | "sent" | "failed" | "outcome_unknown" | "reconciled_sent" | "reconciled_not_sent"
  actor: string | null
  detail: Record<string, unknown>
  claimed_at: string
  lease_until: string
  dispatch_token: string | null
  dispatch_started_at: string | null
  dispatch_ended_at: string | null
  dispatch_via: "claim" | "extend" | null
  settled_detail?: Record<string, unknown>
  reconciled_by?: string
  reconcile_checked_at?: string
  reconcile_evidence?: string | null
}

export type FakeClaimEvent = {
  attempt_id: string
  item_key?: string
  event: string
  from_state?: string
  to_state?: string
  actor?: string | null
  detail?: Record<string, unknown>
}

export type FakeClaimFn =
  | "read_outbound_send_holds"
  | "claim_outbound_send"
  | "extend_outbound_send_claim"
  | "confirm_outbound_dispatch"
  | "settle_outbound_send"
  | "reconcile_outbound_send"

export type FakeClaimStore = {
  rows: FakeClaimRow[]
  events: FakeClaimEvent[]
  calls: Array<{ fn: string; args: Record<string, unknown> }>
  /** Make every later call of fn fail ("error" returns a PostgREST error; "throw" rejects). */
  fail: (fn: FakeClaimFn, mode?: "error" | "throw") => void
  /** Fail only the next call of fn. */
  failNext: (fn: FakeClaimFn, mode?: "error" | "throw") => void
  heal: (fn?: FakeClaimFn) => void
  /** Move the clock (milliseconds since epoch). */
  setNow: (ms: number) => void
  advance: (ms: number) => void
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
  /** Rows for one item, oldest first. */
  rowsFor: (itemKey: string) => FakeClaimRow[]
  /** Rows for one attempt. */
  rowsOf: (attemptId: string) => FakeClaimRow[]
}

const UNRESOLVED = new Set(["sending", "outcome_unknown"])
const DEFAULT_LEASE_SECONDS = 900

function cleanKeys(keys: unknown): string[] | null {
  const list = Array.isArray(keys) ? keys : []
  const clean = [...new Set(list.filter((k) => k != null).map((k) => String(k).trim()).filter(Boolean))].sort()
  return clean.length > 0 ? clean : null
}

export function makeFakeClaimStore(options: { now?: number } = {}): FakeClaimStore {
  const rows: FakeClaimRow[] = []
  const events: FakeClaimEvent[] = []
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const always = new Map<string, "error" | "throw">()
  const once = new Map<string, "error" | "throw">()
  const tails = new Map<string, Promise<void>>()
  let nowMs = options.now ?? Date.parse("2026-10-19T00:00:00Z")
  const iso = (ms: number) => new Date(ms).toISOString()
  const ms = (t: string) => Date.parse(t)

  async function acquire(name: string): Promise<() => void> {
    const prev = tails.get(name) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((resolve) => (release = resolve))
    const tail = prev.then(() => mine)
    tails.set(name, tail)
    await prev
    return () => {
      release()
      if (tails.get(name) === tail) tails.delete(name)
    }
  }

  function lockNames(fn: string, a: Record<string, unknown>): string[] {
    const names = [`attempt:${String(a.p_attempt_id ?? "")}`]
    if (fn === "claim_outbound_send" || fn === "extend_outbound_send_claim") {
      for (const key of cleanKeys(a.p_keys) ?? []) names.push(`key:${key}`)
    }
    return fn === "read_outbound_send_holds" ? [] : names
  }

  function holdsFor(keys: string[]) {
    return rows
      .filter((r) => keys.includes(r.item_key) && UNRESOLVED.has(r.state))
      .sort((a, b) => a.claimed_at.localeCompare(b.claimed_at) || a.item_key.localeCompare(b.item_key))
      .map((r) => ({
        attempt_id: r.attempt_id,
        item_key: r.item_key,
        state: r.state,
        stale: r.state === "sending" && ms(r.lease_until) < nowMs,
        claimed_at: r.claimed_at,
        lease_until: r.lease_until,
        actor: r.actor,
      }))
  }

  function insert(
    keys: string[], attemptId: string, actor: string | null, detail: Record<string, unknown>,
    leaseUntilMs: number, token: string, via: "claim" | "extend", event: "claimed" | "extended",
  ) {
    const held = holdsFor(keys)
    if (held.length > 0) {
      events.push({
        attempt_id: attemptId,
        event: event === "claimed" ? "claim_refused" : "extend_refused",
        actor,
        detail: { code: "send_claim_held", keys },
      })
      return { ok: false, code: "send_claim_held", held }
    }
    for (const key of keys) {
      rows.push({
        attempt_id: attemptId, item_key: key, state: "sending", actor, detail,
        claimed_at: iso(nowMs), lease_until: iso(leaseUntilMs),
        dispatch_token: token, dispatch_started_at: iso(nowMs), dispatch_ended_at: null, dispatch_via: via,
      })
      events.push({ attempt_id: attemptId, item_key: key, event, to_state: "sending", actor, detail })
    }
    return null
  }

  function run(fn: string, a: Record<string, unknown>): unknown {
    const attemptId = String(a.p_attempt_id ?? "")
    const mine = rows.filter((r) => r.attempt_id === attemptId)
    const actor = (a.p_actor as string) ?? null
    const detail = (a.p_detail as Record<string, unknown>) ?? {}
    switch (fn) {
      case "read_outbound_send_holds":
        return holdsFor((a.p_keys as string[]) ?? [])
      case "claim_outbound_send": {
        const keys = cleanKeys(a.p_keys)
        if (!keys || !attemptId) return { ok: false, code: "send_claim_invalid" }
        if (mine.length > 0) {
          events.push({ attempt_id: attemptId, event: "claim_refused", actor, detail: { code: "send_claim_attempt_exists", keys } })
          return { ok: false, code: "send_claim_attempt_exists" }
        }
        const lease = Math.max(a.p_lease_seconds == null ? DEFAULT_LEASE_SECONDS : Number(a.p_lease_seconds), 30)
        const token = crypto.randomUUID()
        const refused = insert(keys, attemptId, actor, detail, nowMs + lease * 1000, token, "claim", "claimed")
        return refused ?? { ok: true, attempt_id: attemptId, keys, dispatch_token: token }
      }
      case "extend_outbound_send_claim": {
        const keys = cleanKeys(a.p_keys)
        if (!keys || !attemptId) return { ok: false, code: "send_claim_invalid" }
        const callerKey = a.p_caller_item_key == null ? null : String(a.p_caller_item_key).trim()
        let code: string | null = null
        if (mine.length === 0 || mine.some((r) => r.state !== "sending")) code = "send_claim_not_sending"
        else if (callerKey !== null && !mine.some((r) => r.item_key === callerKey)) code = "send_claim_item_mismatch"
        else if (mine.some((r) => keys.includes(r.item_key) || r.dispatch_via === "extend")) code = "send_claim_dispatch_taken"
        if (code) {
          events.push({ attempt_id: attemptId, event: "extend_refused", actor, detail: { code, keys, caller_item_key: callerKey } })
          return { ok: false, code }
        }
        const leaseUntil = Math.max(...mine.map((r) => ms(r.lease_until)), nowMs + DEFAULT_LEASE_SECONDS * 1000)
        const token = crypto.randomUUID()
        const refused = insert(keys, attemptId, actor, detail, leaseUntil, token, "extend", "extended")
        if (refused) return refused
        for (const r of rows.filter((x) => x.attempt_id === attemptId)) {
          r.dispatch_token = token
          r.dispatch_started_at = iso(nowMs)
          r.dispatch_ended_at = null
          r.dispatch_via = "extend"
          r.lease_until = iso(leaseUntil)
        }
        return { ok: true, attempt_id: attemptId, keys, dispatch_token: token }
      }
      case "confirm_outbound_dispatch": {
        if (!attemptId) return { ok: false, code: "send_dispatch_fenced" }
        const token = String(a.p_dispatch_token ?? "").trim().toLowerCase()
        const ok = mine.length > 0 && mine.every((r) =>
          r.state === "sending" && r.dispatch_ended_at === null && ms(r.lease_until) > nowMs &&
          r.dispatch_token !== null && r.dispatch_token === token
        )
        events.push({ attempt_id: attemptId, event: ok ? "dispatch_confirmed" : "dispatch_fenced" })
        return ok ? { ok: true, attempt_id: attemptId } : { ok: false, code: "send_dispatch_fenced" }
      }
      case "settle_outbound_send": {
        const state = String(a.p_state ?? "")
        const settler = a.p_settler == null ? "dispatcher" : String(a.p_settler)
        if (!["sent", "failed", "outcome_unknown"].includes(state)) return { ok: false, code: "send_settle_invalid_state" }
        if (!["dispatcher", "caller"].includes(settler)) return { ok: false, code: "send_settle_invalid_settler" }
        if (settler === "caller" && mine.some((r) => r.state === "sending" && r.dispatch_via === "extend" && r.dispatch_ended_at === null)) {
          events.push({
            attempt_id: attemptId, event: "caller_settle_deferred", from_state: "sending", to_state: "sending",
            actor: "caller", detail: { requested_state: state, detail },
          })
          return { ok: true, attempt_id: attemptId, deferred: true, state: "sending" }
        }
        const moved = mine.filter((r) => r.state === "sending")
        if (moved.length === 0) {
          events.push({ attempt_id: attemptId, event: "settle_refused", to_state: state, actor: settler })
          return { ok: false, code: "send_claim_not_sending" }
        }
        for (const r of moved) {
          r.state = state as FakeClaimRow["state"]
          r.settled_detail = detail
          r.dispatch_ended_at = r.dispatch_ended_at ?? iso(nowMs)
          events.push({ attempt_id: attemptId, item_key: r.item_key, event: "settled", from_state: "sending", to_state: state, actor: settler })
        }
        return { ok: true, attempt_id: attemptId, state, rows: moved.length }
      }
      case "reconcile_outbound_send": {
        const expected = String(a.p_expected_state ?? "")
        const result = String(a.p_result ?? "")
        const to = result === "sent" ? "reconciled_sent" : result === "not_sent" ? "reconciled_not_sent" : null
        let code: string | null = null
        if (!to || !UNRESOLVED.has(expected)) code = "send_reconcile_invalid"
        else if (!actor || !actor.trim() || !a.p_checked_at) code = "send_reconcile_actor_required"
        else if (mine.some((r) =>
          ms(r.lease_until) >= nowMs &&
          (r.state === "sending" || (r.dispatch_started_at !== null && r.dispatch_ended_at === null))
        )) code = "send_reconcile_live_send"
        if (!code) {
          const moved = mine.filter((r) => r.state === expected)
          if (moved.length === 0) code = "send_reconcile_state_changed"
          else {
            for (const r of moved) {
              r.state = to as FakeClaimRow["state"]
              r.reconciled_by = actor as string
              r.reconcile_checked_at = String(a.p_checked_at)
              r.reconcile_evidence = (a.p_evidence as string) ?? null
              r.dispatch_token = null
              r.dispatch_ended_at = r.dispatch_ended_at ?? iso(nowMs)
              events.push({ attempt_id: attemptId, item_key: r.item_key, event: "reconciled", from_state: expected, to_state: to as string, actor })
            }
            return { ok: true, attempt_id: attemptId, state: to, rows: moved.length }
          }
        }
        events.push({ attempt_id: attemptId, event: "reconcile_refused", from_state: expected, actor, detail: { code } })
        return { ok: false, code }
      }
      default:
        throw new Error(`fake claim store: unknown rpc ${fn}`)
    }
  }

  return {
    rows,
    events,
    calls,
    fail: (fn, mode = "error") => void always.set(fn, mode),
    failNext: (fn, mode = "error") => void once.set(fn, mode),
    heal: (fn) => (fn ? (always.delete(fn), once.delete(fn)) : (always.clear(), once.clear())) as unknown as void,
    setNow: (value) => void (nowMs = value),
    advance: (delta) => void (nowMs += delta),
    rowsFor: (key) => rows.filter((r) => r.item_key === key),
    rowsOf: (attemptId) => rows.filter((r) => r.attempt_id === attemptId),
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      await Promise.resolve()
      calls.push({ fn, args })
      const mode = once.get(fn) ?? always.get(fn)
      once.delete(fn)
      if (mode === "throw") throw new Error(`simulated ${fn} outage`)
      if (mode === "error") return { data: null, error: { message: `simulated ${fn} failure` } }
      const releases: Array<() => void> = []
      try {
        for (const name of lockNames(fn, args)) releases.push(await acquire(name))
        await Promise.resolve()
        return { data: run(fn, args), error: null }
      } finally {
        for (const release of releases.reverse()) release()
      }
    },
  }
}
