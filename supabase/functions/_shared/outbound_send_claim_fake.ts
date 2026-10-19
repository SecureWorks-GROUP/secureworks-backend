// In-memory stand-in for the five outbound send claim functions
// (20261019170000_outbound_send_claims.sql), for tests only. Same rules: one
// unresolved attempt per item, settle and reconcile are compare-and-set, a live
// sending attempt is never reconciled, every call is logged. Each call yields
// once before it runs, so concurrent callers interleave as they would against
// the database, and the body of each call runs without interruption, as the
// database's statement does.

export type FakeClaimRow = {
  attempt_id: string
  item_key: string
  state: "sending" | "sent" | "failed" | "outcome_unknown" | "reconciled_sent" | "reconciled_not_sent"
  actor: string | null
  detail: Record<string, unknown>
  claimed_at: string
  lease_until: string
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
}

const UNRESOLVED = new Set(["sending", "outcome_unknown"])

export function makeFakeClaimStore(options: { now?: number } = {}): FakeClaimStore {
  const rows: FakeClaimRow[] = []
  const events: FakeClaimEvent[] = []
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const always = new Map<string, "error" | "throw">()
  const once = new Map<string, "error" | "throw">()
  let nowMs = options.now ?? Date.parse("2026-10-19T00:00:00Z")
  const iso = (ms: number) => new Date(ms).toISOString()

  function holdsFor(keys: string[]) {
    return rows
      .filter((r) => keys.includes(r.item_key) && UNRESOLVED.has(r.state))
      .sort((a, b) => a.claimed_at.localeCompare(b.claimed_at) || a.item_key.localeCompare(b.item_key))
      .map((r) => ({
        attempt_id: r.attempt_id,
        item_key: r.item_key,
        state: r.state,
        stale: r.state === "sending" && Date.parse(r.lease_until) < nowMs,
        claimed_at: r.claimed_at,
        lease_until: r.lease_until,
        actor: r.actor,
      }))
  }

  function insert(keys: string[], attemptId: string, actor: string | null, detail: Record<string, unknown>, leaseSeconds: number, event: string) {
    const clean = [...new Set(keys.filter(Boolean))].sort()
    if (clean.length === 0 || !attemptId) return { ok: false, code: "send_claim_invalid" }
    const fresh = clean.filter((k) => !rows.some((r) => r.attempt_id === attemptId && r.item_key === k))
    const held = holdsFor(fresh).filter((h) => h.attempt_id !== attemptId)
    if (held.length > 0) {
      events.push({ attempt_id: attemptId, event: "claim_refused", actor, detail: { code: "send_claim_held", keys: clean } })
      return { ok: false, code: "send_claim_held", held }
    }
    for (const key of fresh) {
      rows.push({
        attempt_id: attemptId,
        item_key: key,
        state: "sending",
        actor,
        detail,
        claimed_at: iso(nowMs),
        lease_until: iso(nowMs + leaseSeconds * 1000),
      })
      events.push({ attempt_id: attemptId, item_key: key, event, to_state: "sending", actor, detail })
    }
    return { ok: true, attempt_id: attemptId, keys: clean }
  }

  function run(fn: string, a: Record<string, unknown>): unknown {
    switch (fn) {
      case "read_outbound_send_holds":
        return holdsFor((a.p_keys as string[]) ?? [])
      case "claim_outbound_send": {
        const attemptId = String(a.p_attempt_id ?? "")
        if (rows.some((r) => r.attempt_id === attemptId)) return { ok: false, code: "send_claim_attempt_exists" }
        return insert((a.p_keys as string[]) ?? [], attemptId, (a.p_actor as string) ?? null,
          (a.p_detail as Record<string, unknown>) ?? {}, Number(a.p_lease_seconds ?? 600), "claimed")
      }
      case "extend_outbound_send_claim": {
        const attemptId = String(a.p_attempt_id ?? "")
        const mine = rows.filter((r) => r.attempt_id === attemptId)
        if (mine.length === 0 || mine.some((r) => r.state !== "sending")) return { ok: false, code: "send_claim_not_sending" }
        const leaseMs = Math.max(...mine.map((r) => Date.parse(r.lease_until))) - nowMs
        return insert((a.p_keys as string[]) ?? [], attemptId, (a.p_actor as string) ?? null,
          (a.p_detail as Record<string, unknown>) ?? {}, Math.max(1, Math.round(leaseMs / 1000)), "extended")
      }
      case "settle_outbound_send": {
        const attemptId = String(a.p_attempt_id ?? "")
        const state = String(a.p_state ?? "")
        if (!["sent", "failed", "outcome_unknown"].includes(state)) return { ok: false, code: "send_settle_invalid_state" }
        const moved = rows.filter((r) => r.attempt_id === attemptId && r.state === "sending")
        if (moved.length === 0) {
          events.push({ attempt_id: attemptId, event: "settle_refused", to_state: state })
          return { ok: false, code: "send_claim_not_sending" }
        }
        for (const r of moved) {
          r.state = state as FakeClaimRow["state"]
          r.settled_detail = (a.p_detail as Record<string, unknown>) ?? {}
          events.push({ attempt_id: attemptId, item_key: r.item_key, event: "settled", from_state: "sending", to_state: state })
        }
        return { ok: true, attempt_id: attemptId, state, rows: moved.length }
      }
      case "reconcile_outbound_send": {
        const attemptId = String(a.p_attempt_id ?? "")
        const expected = String(a.p_expected_state ?? "")
        const result = String(a.p_result ?? "")
        const actor = (a.p_actor as string) ?? null
        const to = result === "sent" ? "reconciled_sent" : result === "not_sent" ? "reconciled_not_sent" : null
        let code: string | null = null
        if (!to || !UNRESOLVED.has(expected)) code = "send_reconcile_invalid"
        else if (!actor || !actor.trim() || !a.p_checked_at) code = "send_reconcile_actor_required"
        else if (expected === "sending" && rows.some((r) => r.attempt_id === attemptId && r.state === "sending" && Date.parse(r.lease_until) >= nowMs)) {
          code = "send_reconcile_live_send"
        }
        if (!code) {
          const moved = rows.filter((r) => r.attempt_id === attemptId && r.state === expected)
          if (moved.length === 0) code = "send_reconcile_state_changed"
          else {
            for (const r of moved) {
              r.state = to as FakeClaimRow["state"]
              r.reconciled_by = actor as string
              r.reconcile_checked_at = String(a.p_checked_at)
              r.reconcile_evidence = (a.p_evidence as string) ?? null
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
    setNow: (ms) => void (nowMs = ms),
    advance: (ms) => void (nowMs += ms),
    rowsFor: (key) => rows.filter((r) => r.item_key === key),
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      await Promise.resolve()
      calls.push({ fn, args })
      const mode = once.get(fn) ?? always.get(fn)
      once.delete(fn)
      if (mode === "throw") throw new Error(`simulated ${fn} outage`)
      if (mode === "error") return { data: null, error: { message: `simulated ${fn} failure` } }
      return { data: run(fn, args), error: null }
    },
  }
}
