// Wave 0 (Make-Safe Autopilot) hardening proof tests.
//
// PROVES the two red-team gate fixes in ops-api/index.ts:
//   C2 — approve_intake_draft is human-only: the automation api-key is REJECTED,
//        only an authenticated admin/owner JWT may approve. (route gate ~1796-1809)
//   C3 — approveIntakeDraft claims the draft ATOMICALLY so two concurrent
//        approvals cannot both create a live job. (claim ~8744-8755)
//
// Why these are reimplemented-pure tests (not direct imports): importing index.ts
// here boots the production HTTP server via serve(...) at module load, and both the
// route gate and approveIntakeDraft are module-internal (not exported). This file
// follows the SAME convention the existing index_test.ts Quick-Quote section uses:
// reimplement the exact pattern under test as a small pure function and exercise it
// with mocked deps, cross-referenced to the deployed code by line. The pattern here
// mirrors index.ts VERBATIM (predicate + conditional UPDATE), so a future change to
// the real gate that breaks the contract will also break this test if kept in sync.
//
// No network. No live Supabase. No live Xero.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"

// ── C2: the exact gate predicate from index.ts route case 'approve_intake_draft' ──
//   const approveIsHuman = authMode === 'jwt' && (authUser?.role === 'admin' || authUser?.role === 'owner')
//   if (!approveIsHuman) return json({ error: '...' }, 403)
type AuthMode = "api_key" | "jwt"
type AuthUser = { id: string; email: string; role: string } | null

function approveGate(authMode: AuthMode, authUser: AuthUser): { allowed: boolean; status: number } {
  const approveIsHuman = authMode === "jwt" && (authUser?.role === "admin" || authUser?.role === "owner")
  return approveIsHuman ? { allowed: true, status: 200 } : { allowed: false, status: 403 }
}

Deno.test("C2: routine api-key is REJECTED on approve_intake_draft (403)", () => {
  // The routine authenticates as api_key (a VALID SW_API_KEY, but not a human).
  const r = approveGate("api_key", null)
  assertEquals(r.allowed, false, "the automation api-key must never be allowed to approve a draft")
  assertEquals(r.status, 403)
})

Deno.test("C2: api-key is rejected even if some authUser context were present", () => {
  // Defence-in-depth: api_key mode is rejected regardless of any role value.
  for (const role of ["admin", "owner", "ops", "unknown", "viewer"]) {
    const r = approveGate("api_key", { id: "x", email: "x@x", role })
    assertEquals(r.allowed, false, `api_key + role=${role} must still be rejected`)
    assertEquals(r.status, 403)
  }
})

Deno.test("C2: a logged-in admin/owner JWT IS allowed (the human tick)", () => {
  assertEquals(approveGate("jwt", { id: "u1", email: "marnin@x", role: "admin" }).allowed, true)
  assertEquals(approveGate("jwt", { id: "u2", email: "shaun@x", role: "owner" }).allowed, true)
})

Deno.test("C2: a non-admin/owner JWT is rejected (403)", () => {
  for (const role of ["ops", "trade", "viewer", "unknown", ""]) {
    const r = approveGate("jwt", { id: "u", email: "u@x", role })
    assertEquals(r.allowed, false, `jwt + role=${role} must be rejected`)
    assertEquals(r.status, 403)
  }
  // A jwt with no user object (shouldn't happen, but must fail closed).
  assertEquals(approveGate("jwt", null).allowed, false)
})

// ── C3: the exact atomic-claim from approveIntakeDraft in index.ts ──
//   const { data: claimed } = await client.from('makesafe_intake_drafts')
//     .update({ status: 'approved', updated_at })
//     .eq('id', draft_id)
//     .in('status', ['needs_review', 'draft'])
//     .select()
//   if (!claimed || claimed.length === 0) throw new Error(... concurrent approval blocked)
//
// We model the table as a single-row store with a serialized conditional UPDATE,
// exactly as PostgREST applies the `.eq(id).in(status,[...])` predicate atomically
// in Postgres. Two callers race for the same draft; only the one whose UPDATE
// matched the pre-image (status in needs_review/draft) gets a row back.

function makeDraftStore(initialStatus: string) {
  let status = initialStatus
  return {
    // Mirrors the chained PostgREST call: update(...).eq('id',id).in('status',set).select()
    atomicClaim(_id: string, allowedFrom: string[]): { rows: Array<{ id: string; status: string }> } {
      // Postgres evaluates the WHERE against the current row and updates it in one
      // atomic statement; a concurrent statement sees the already-committed result.
      if (allowedFrom.includes(status)) {
        status = "approved"
        return { rows: [{ id: _id, status }] }
      }
      return { rows: [] }
    },
    current(): string {
      return status
    },
  }
}

// One approval attempt = the claim + (on success) create the job. Returns whether
// THIS caller created a live job.
function attemptApprove(store: ReturnType<typeof makeDraftStore>, jobsCreated: { n: number }): { created: boolean } {
  const { rows } = store.atomicClaim("draft-1", ["needs_review", "draft"])
  if (rows.length === 0) {
    return { created: false } // concurrent/invalid -> blocked, no job
  }
  jobsCreated.n += 1 // only the winner reaches createMakesafeJob
  return { created: true }
}

Deno.test("C3: two concurrent approvals of a needs_review draft -> exactly ONE live job", () => {
  const store = makeDraftStore("needs_review")
  const jobsCreated = { n: 0 }
  // Serialized claims model the DB applying both UPDATEs one after the other.
  const a = attemptApprove(store, jobsCreated)
  const b = attemptApprove(store, jobsCreated)
  assertEquals(jobsCreated.n, 1, "the double-click race must create exactly one job, not two")
  assert(a.created !== b.created, "exactly one of the two concurrent approvals wins")
  assertEquals(store.current(), "approved")
})

Deno.test("C3: a draft that is already approved cannot be re-approved (0 rows -> blocked)", () => {
  const store = makeDraftStore("approved")
  const jobsCreated = { n: 0 }
  const r = attemptApprove(store, jobsCreated)
  assertEquals(r.created, false, "re-approving an approved draft must not create another job")
  assertEquals(jobsCreated.n, 0)
})

Deno.test("C3: rejected/superseded drafts cannot be approved", () => {
  for (const s of ["rejected", "superseded"]) {
    const store = makeDraftStore(s)
    const jobsCreated = { n: 0 }
    const r = attemptApprove(store, jobsCreated)
    assertEquals(r.created, false, `a ${s} draft must not be approvable`)
    assertEquals(jobsCreated.n, 0)
  }
})

Deno.test("C3: a 'draft' status (incomplete intake) is still claimable from the queue", () => {
  // scanSesMakesafes can land an incomplete draft as status='draft' (Eng P0-C);
  // the claim set includes 'draft' so it remains approvable once a human completes it.
  const store = makeDraftStore("draft")
  const jobsCreated = { n: 0 }
  const r = attemptApprove(store, jobsCreated)
  assertEquals(r.created, true)
  assertEquals(jobsCreated.n, 1)
})
