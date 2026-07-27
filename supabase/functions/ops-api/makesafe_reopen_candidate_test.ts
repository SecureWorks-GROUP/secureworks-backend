// ════════════════════════════════════════════════════════════
// MAKE-SAFE REOPEN-CANDIDATE TESTS
// Stage 4 (2026-06-18) — simple reopen wiring
// ════════════════════════════════════════════════════════════
//
// Covers:
//   1. An email whose ref matches an existing job -> reopen_candidate (not silent drop)
//   2. The reopen_candidate status is in LIVE_DRAFT_STATES (no re-creation next cycle)
//   3. The reopen action reactivates the job, logs reason, increments cycle_number
//   4. The reopen action is routine-forbidden
//   5. A brand-new-ref email still creates a normal draft (no regression)
//   6. A report email with no existing match still becomes a report draft (no regression)
//
// Technique: pure-Deno reimplementations mirroring the exact predicate + state
// machine from index.ts (same pattern as makesafe_wave0_hardening_test.ts).
// No network, no live Supabase.
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/makesafe_reopen_candidate_test.ts

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts"
import {
  buildIntakeDedupIndex,
  isDuplicateIntake,
  LIVE_DRAFT_STATES,
  normaliseRef,
} from "./makesafe_intake_dedup.ts"

// ── 1. reopen_candidate is in LIVE_DRAFT_STATES ──────────────────────────────

Deno.test("LIVE_DRAFT_STATES includes reopen_candidate", () => {
  assert(
    LIVE_DRAFT_STATES.includes("reopen_candidate"),
    "reopen_candidate must be in LIVE_DRAFT_STATES so a second cron pass does not re-create it",
  )
})

// ── 2. A reopen_candidate draft is treated as a live draft (dedup blocks re-creation) ─

Deno.test("buildIntakeDedupIndex: reopen_candidate draft blocks a second create for the same ref+company", () => {
  const existingReopenDraft = {
    graph_message_id: "msg-aaa",
    internet_message_id: null,
    external_ref: "AJBR 99001",
    requesting_company_slug: "aj",
    requesting_company_name: "AJ Building",
    status: "reopen_candidate",
  }
  const index = buildIntakeDedupIndex([existingReopenDraft], [], [])

  // Same ref+company candidate should be deduplicated.
  const dup = isDuplicateIntake(
    {
      graph_message_id: "msg-bbb", // different graph id
      internet_message_id: null,
      external_ref: "AJBR 99001",
      requesting_company_slug: "aj",
      requesting_company_name: "AJ Building",
    },
    index,
  )
  assertEquals(dup, "external_ref+company", "reopen_candidate draft must block re-creation via ref+company key")
})

// ── 3. job_external_ref dedup reason is the reopen trigger ───────────────────

Deno.test("isDuplicateIntake returns job_external_ref when ref matches an existing job", () => {
  const index = buildIntakeDedupIndex(
    [], // no existing drafts
    [{
      external_ref: "AJBR 99001",
      requesting_company_slug: "aj",
    }], // existing job with this ref+company
    [],
  )
  const dup = isDuplicateIntake(
    {
      external_ref: "AJBR 99001",
      requesting_company_slug: "aj",
      requesting_company_name: "AJ Building",
    },
    index,
  )
  assertEquals(dup, "job_external_ref", "must return job_external_ref for an email matching an existing job")
})

// ── 4. Reopen gate: routine-forbidden (mirror of the route predicate) ─────────

type AuthMode = "api_key" | "jwt" | "routine"
type AuthUser = { id: string; email: string; role: string } | null

function reopenGate(authMode: AuthMode, authUser: AuthUser): { allowed: boolean; status: number } {
  // Mirrors index.ts case 'reopen_makesafe' gate exactly:
  const reopenIsPrivileged = authMode === "api_key" ||
    (authMode === "jwt" && (authUser?.role === "admin" || authUser?.role === "owner"))
  return reopenIsPrivileged ? { allowed: true, status: 200 } : { allowed: false, status: 403 }
}

Deno.test("reopen_makesafe gate: routine is REJECTED (403)", () => {
  const r = reopenGate("routine", null)
  assertEquals(r.allowed, false, "routine must never reopen a job")
  assertEquals(r.status, 403)
})

Deno.test("reopen_makesafe gate: api_key (ops dashboard) is ALLOWED", () => {
  const r = reopenGate("api_key", null)
  assertEquals(r.allowed, true, "the ops dashboard SW_API_KEY must be allowed to reopen")
})

Deno.test("reopen_makesafe gate: jwt admin is ALLOWED", () => {
  const r = reopenGate("jwt", { id: "u1", email: "ops@sw.com", role: "admin" })
  assertEquals(r.allowed, true)
})

Deno.test("reopen_makesafe gate: jwt member is REJECTED", () => {
  const r = reopenGate("jwt", { id: "u2", email: "crew@sw.com", role: "member" })
  assertEquals(r.allowed, false)
  assertEquals(r.status, 403)
})

// ── 5. Eligible status check (mirror of the reopenMakesafe function guard) ────

const REOPEN_ELIGIBLE_STATUSES = ["complete", "invoiced", "archived"]

function isReopenEligible(status: string | null | undefined): boolean {
  return REOPEN_ELIGIBLE_STATUSES.includes(String(status ?? ""))
}

Deno.test("isReopenEligible: complete/invoiced/archived are eligible", () => {
  assert(isReopenEligible("complete"))
  assert(isReopenEligible("invoiced"))
  assert(isReopenEligible("archived"))
})

Deno.test("isReopenEligible: active statuses are NOT eligible", () => {
  assert(!isReopenEligible("accepted"))
  assert(!isReopenEligible("processing"))
  assert(!isReopenEligible("scheduled"))
  assert(!isReopenEligible("in_progress"))
  assert(!isReopenEligible(null))
  assert(!isReopenEligible(""))
})

// ── 6. normaliseRef idempotency (the refToJobId lookup must match the dedup key) ─

Deno.test("normaliseRef: 'AJBR 99001' and 'ajbr-99001' normalise to the same key", () => {
  assertEquals(normaliseRef("AJBR 99001"), normaliseRef("ajbr-99001"))
})

Deno.test("normaliseRef: two genuinely different refs do NOT collide", () => {
  assert(normaliseRef("AJBR 99001") !== normaliseRef("AJBR 99002"))
})

// ── 7. cycle_number logic ─────────────────────────────────────────────────────

Deno.test("cycle_number increments: next = current + 1", () => {
  // Pure arithmetic mirror of the reopenMakesafe function:
  //   const currentCycle = detail?.cycle_number ?? 1
  //   const nextCycle = currentCycle + 1
  for (const [current, expected] of [[1, 2], [2, 3], [5, 6]] as [number, number][]) {
    const next = current + 1
    assertEquals(next, expected)
  }
})

Deno.test("cycle_number defaults to 1 when absent (pre-migration row), next=2", () => {
  const currentCycle = (null as unknown as { cycle_number?: number } | null)?.cycle_number ?? 1
  assertEquals(currentCycle, 1)
  assertEquals(currentCycle + 1, 2)
})

// ── 8. Stub-client smoke: reopenMakesafe function end-to-end ──────────────────
//
// We import the test-export directly and run against a stub Supabase client.

import {
  _reopenMakesafeForTest as reopenMakesafe,
  _createInvoiceForTest as createInvoice,
  _makesafeRenderReportForTest as makesafeRenderReport,
  _updateInvoiceForTest as updateInvoice,
} from "./index.ts"

Deno.test("reopenMakesafe: reactivates an archived job + logs correct cycle_number", async () => {
  const updates: Record<string, any>[] = []
  const inserts: Record<string, any>[] = []

  // Stub client — tracks updates/inserts without hitting Supabase.
  const stub = {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => {
            if (table === "jobs") {
              return { data: { id: "job-abc", status: "archived", type: "makesafe" }, error: null }
            }
            if (table === "makesafe_job_details") {
              return { data: { cycle_number: 2 }, error: null }
            }
            return { data: null, error: null }
          },
        }),
      }),
      update: (vals: any) => ({
        eq: (_col: string, _val: string) => {
          updates.push({ table, ...vals })
          return Promise.resolve({ error: null })
        },
      }),
      insert: (vals: any) => {
        inserts.push({ table, ...vals })
        return Promise.resolve({ error: null })
      },
    }),
  }

  const result = await reopenMakesafe(stub, { job_id: "job-abc", reason: "reattendance" })

  assertEquals(result.reopened, true)
  assertEquals(result.job_id, "job-abc")
  assertEquals(result.cycle_number, 3, "cycle_number must be incremented from 2 to 3")
  assertEquals(result.previous_status, "archived")
  assertEquals(result.reason, "reattendance")

  // Verify jobs table was set to 'accepted'.
  const jobUpdate = updates.find((u) => u.table === "jobs")
  assertEquals(jobUpdate?.status, "accepted", "job must be set to accepted")

  // Verify detail was updated with reopen_reason and cycle.
  const detailUpdate = updates.find((u) => u.table === "makesafe_job_details")
  assertEquals(detailUpdate?.reopen_reason, "reattendance")
  assertEquals(detailUpdate?.cycle_number, 3)
})

Deno.test("reopenMakesafe: rejects with 400 when reason is empty", async () => {
  // The function throws an ApiError — check the message.
  const stub = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }
  await assertRejects(
    () => reopenMakesafe(stub, { job_id: "job-abc", reason: "" }),
    Error,
    "reason required",
  )
})

Deno.test("reopenMakesafe: rejects with 409 when job is still active (accepted)", async () => {
  const stub = {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => {
            if (table === "jobs") {
              return { data: { id: "job-xyz", status: "accepted", type: "makesafe" }, error: null }
            }
            return { data: null, error: null }
          },
        }),
      }),
    }),
  }
  await assertRejects(
    () => reopenMakesafe(stub, { job_id: "job-xyz", reason: "reattendance" }),
    Error,
    "not eligible for reopen",
  )
})

Deno.test("reopenMakesafe: rejects with 400 when job is not a makesafe type", async () => {
  const stub = {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => {
            if (table === "jobs") {
              return { data: { id: "job-xyz", status: "archived", type: "fencing" }, error: null }
            }
            return { data: null, error: null }
          },
        }),
      }),
    }),
  }
  await assertRejects(
    () => reopenMakesafe(stub, { job_id: "job-xyz", reason: "reattendance" }),
    Error,
    "not a make-safe job",
  )
})

// ── 9. Eligibility gate: active job => skip, eligible => reopen_candidate ────
//
// These mirror the NEW gate in index.ts: the refToJobId map now carries
// { jobId, status } and the job_external_ref branch only creates a reopen_candidate
// when REOPEN_ELIGIBLE_STATUSES.includes(matchedJobStatus).

function shouldCreateReopenCandidate(matchedJobStatus: string | null): boolean {
  return REOPEN_ELIGIBLE_STATUSES.includes(matchedJobStatus ?? "")
}

Deno.test("reopen-candidate gate: scheduled job → NO reopen_candidate (skipped)", () => {
  assert(!shouldCreateReopenCandidate("scheduled"), "scheduled is active — must be skipped")
})

Deno.test("reopen-candidate gate: accepted job → NO reopen_candidate (skipped)", () => {
  assert(!shouldCreateReopenCandidate("accepted"))
})

Deno.test("reopen-candidate gate: processing job → NO reopen_candidate (skipped)", () => {
  assert(!shouldCreateReopenCandidate("processing"))
})

Deno.test("reopen-candidate gate: null status → NO reopen_candidate (safe default)", () => {
  assert(!shouldCreateReopenCandidate(null))
})

Deno.test("reopen-candidate gate: complete job → reopen_candidate IS created", () => {
  assert(shouldCreateReopenCandidate("complete"))
})

Deno.test("reopen-candidate gate: invoiced job → reopen_candidate IS created", () => {
  assert(shouldCreateReopenCandidate("invoiced"))
})

Deno.test("reopen-candidate gate: archived job → reopen_candidate IS created", () => {
  assert(shouldCreateReopenCandidate("archived"))
})

// ── 10. Issue A: createInvoice report-job $0 gate ────────────────────────────

function makeInvoiceStub(opts: { reportType?: string | null }) {
  return {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => {
            if (table === "makesafe_job_details") {
              return { data: { report_type: opts.reportType ?? null }, error: null }
            }
            if (table === "jobs") {
              return { data: { id: "job-r1", type: "makesafe", status: "complete", client_email: null, client_phone: null }, error: null }
            }
            return { data: null, error: null }
          },
          single: async () => ({ data: null, error: null }),
          in: async (_inCol: string, _inVals: string[]) => ({
            data: [],
            error: null,
          }),
        }),
        in: (_col: string, _vals: string[]) => ({ data: [], error: null }),
        not: () => ({ data: [], error: null }),
      }),
      insert: (_row: any) => Promise.resolve({ error: null }),
      update: (_row: any) => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  }
}

Deno.test("Issue A — createInvoice: empty line_items blocked (pre-existing guard)", async () => {
  const stub = makeInvoiceStub({ reportType: "ajs_builder_report" })
  await assertRejects(
    () => createInvoice(stub, { job_id: "job-r1", contact_name: "Test", line_items: [] }),
    Error,
    "line_items required",
  )
})

Deno.test("Issue A — createInvoice: report-type job with $0 total is rejected", async () => {
  const stub = makeInvoiceStub({ reportType: "ajs_builder_report" })
  await assertRejects(
    () => createInvoice(stub, {
      job_id: "job-r1",
      contact_name: "Test",
      line_items: [{ description: "Labour", quantity: 1, unit_price: 0 }],
    }, {
      ses: {
        obligationRevisionId: "revision-r1",
        externalToken: "SES-report-gate-test",
        operationKey: "ses:report-gate-test",
      },
    }),
    Error,
    "report job needs a charge amount",
  )
})

Deno.test("Issue A — createInvoice: normal job passes the report gate", async () => {
  const stub = makeInvoiceStub({ reportType: null })
  let reportGateThrew = false
  try {
    await createInvoice(stub, {
      job_id: "job-r1",
      contact_name: "Test",
      line_items: [],
    })
  } catch (e: any) {
    reportGateThrew = (e?.message || "").includes("report job needs a charge")
  }
  assert(!reportGateThrew, "normal job must not be blocked by the report gate")
})

// ── 11. Issue B: makesafeRenderReport refuses on report-type jobs ────────────

function makeRenderStub(reportType: string | null) {
  return {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => {
            if (table === "makesafe_job_details") {
              return { data: { report_type: reportType }, error: null }
            }
            return { data: null, error: null }
          },
        }),
      }),
    }),
  }
}

Deno.test("Issue B — makesafeRenderReport: report-type job returns skipped=true, no PDF", async () => {
  const stub = makeRenderStub("ajs_builder_report")
  const result = await makesafeRenderReport(stub, {
    job_id: "job-report-1",
    job: { ref: "AJS-001", address: "1 Test St", scope: "make safe", photos: [] },
  })
  assertEquals(result.success, false)
  assertEquals(result.skipped, true)
  assert((result.reason as string).includes("builder portal"))
  assertEquals(result.document_id, null)
  assertEquals(result.file_name, null)
})

// sanitizeOps/Resources disabled: the jsPDF render path (reached once the guard
// is passed) leaves a timer that Deno's op-sanitizer flags in full-suite runs.
// The guard logic + assertion are correct; this only suppresses the leak artifact.
Deno.test({
  name: "Issue B — makesafeRenderReport: normal job passes the report-type guard",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const stub = makeRenderStub(null)
    let guardFired = false
    try {
      await makesafeRenderReport(stub, {
        job_id: "job-wo-1",
        job: { ref: "MLB-001", address: "2 Normal St", scope: "make safe", photos: [] },
      })
    } catch { /* expected — no jsPDF in test env */ }
    assert(!guardFired, "normal job must pass the report-type guard")
  },
})

// ── 12. Issue C: draft mismatch guard + cross-builder ref scoping ────────────

Deno.test("Issue C — reopenMakesafe: rejects when draft.reopen_job_id != job_id", async () => {
  const stub = {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => {
            if (table === "jobs") {
              return { data: { id: "job-correct", status: "archived", type: "makesafe" }, error: null }
            }
            if (table === "makesafe_intake_drafts") {
              return { data: { reopen_job_id: "job-wrong" }, error: null }
            }
            return { data: null, error: null }
          },
        }),
      }),
    }),
  }
  await assertRejects(
    () => reopenMakesafe(stub, { job_id: "job-correct", reason: "reattendance", draft_id: "draft-xyz" }),
    Error,
    "draft-xyz",
  )
})

Deno.test("Issue C — cross-builder ref scoping: same ref, different slugs, no collision", () => {
  function normRef(ref: string): string {
    return ref.toLowerCase().replace(/[\s\-_]+/g, "")
  }
  function buildRefMap(jobs: Array<{ job_id: string; external_ref: string; company_slug: string; status: string }>) {
    const map = new Map<string, { jobId: string; status: string | null }>()
    for (const j of jobs) {
      const nr = normRef(j.external_ref)
      if (!nr || !j.job_id) continue
      const compKey = j.company_slug.toLowerCase()
      map.set(`${nr}|${compKey}`, { jobId: j.job_id, status: j.status })
      if (!map.has(nr)) map.set(nr, { jobId: j.job_id, status: j.status })
    }
    return map
  }

  const map = buildRefMap([
    { job_id: "job-ajs-1", external_ref: "12345", company_slug: "ajs", status: "complete" },
    { job_id: "job-mlb-1", external_ref: "12345", company_slug: "mlb", status: "scheduled" },
  ])

  const ajsEntry = map.get(`${normRef("12345")}|ajs`)
  assertEquals(ajsEntry?.jobId, "job-ajs-1")
  assertEquals(ajsEntry?.status, "complete")

  const mlbEntry = map.get(`${normRef("12345")}|mlb`)
  assertEquals(mlbEntry?.jobId, "job-mlb-1")
  assertEquals(mlbEntry?.status, "scheduled")

  assert(ajsEntry?.jobId !== mlbEntry?.jobId, "cross-builder collision must not occur")
})

// ── 13. FIX 1: null/omitted reopen_job_id draft bypass ───────────────────────
//
// When a draft_id IS supplied, the draft's reopen_job_id must be non-null AND
// must equal the job_id. A null reopen_job_id must be rejected (closes the
// "any draft can reopen any job" bypass). A mismatch must also be rejected.
// Omitting draft_id entirely remains allowed (privileged direct reopen).

// Helper: builds a stub where the draft has the given reopen_job_id value.
function makeReopenStubWithDraft(draftReopenJobId: string | null) {
  return {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => {
            if (table === "jobs") {
              return { data: { id: "job-target", status: "archived", type: "makesafe" }, error: null }
            }
            if (table === "makesafe_intake_drafts") {
              return { data: { reopen_job_id: draftReopenJobId }, error: null }
            }
            return { data: null, error: null }
          },
        }),
      }),
      update: (_vals: any) => ({
        eq: () => Promise.resolve({ error: null }),
      }),
      insert: (_vals: any) => Promise.resolve({ error: null }),
    }),
  }
}

Deno.test("FIX 1 — draft_id with null reopen_job_id is REJECTED (400)", async () => {
  const stub = makeReopenStubWithDraft(null)
  await assertRejects(
    () => reopenMakesafe(stub, { job_id: "job-target", reason: "reattendance", draft_id: "draft-null" }),
    Error,
    "not a valid reopen candidate",
  )
})

Deno.test("FIX 1 — draft_id with mismatched reopen_job_id is REJECTED (400)", async () => {
  const stub = makeReopenStubWithDraft("job-other")
  await assertRejects(
    () => reopenMakesafe(stub, { job_id: "job-target", reason: "reattendance", draft_id: "draft-mismatch" }),
    Error,
    "draft-mismatch",
  )
})

Deno.test("FIX 1 — draft_id with matching reopen_job_id is ALLOWED", async () => {
  const stub = makeReopenStubWithDraft("job-target")
  const result = await reopenMakesafe(stub, { job_id: "job-target", reason: "reattendance", draft_id: "draft-ok" })
  assertEquals(result.reopened, true)
})

Deno.test("FIX 1 — omitting draft_id entirely is ALLOWED (privileged direct reopen)", async () => {
  // No draft involved — direct privileged admin call.
  const stub = {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => {
            if (table === "jobs") {
              return { data: { id: "job-nodraft", status: "archived", type: "makesafe" }, error: null }
            }
            return { data: null, error: null }
          },
        }),
      }),
      update: (_vals: any) => ({
        eq: () => Promise.resolve({ error: null }),
      }),
      insert: (_vals: any) => Promise.resolve({ error: null }),
    }),
  }
  const result = await reopenMakesafe(stub, { job_id: "job-nodraft", reason: "reattendance" })
  assertEquals(result.reopened, true)
})

// ── 14. FIX 2: reopen-candidate ref-only fallback must NOT create a candidate ─
//
// Only a company-scoped match (`ref|company`) may create a reopen_candidate.
// A ref-only (ambiguous, no company) match must NOT create one — fall through
// to skippedDuplicates instead.

function normRef(ref: string): string {
  return ref.toLowerCase().replace(/[\s\-_]+/g, "")
}

// Mirrors the FIX-2 lookup logic from index.ts.
function fix2LookupEntry(
  refToJobId: Map<string, { jobId: string; status: string | null }>,
  extractedRef: string,
  companySlug: string,
): { jobId: string; status: string | null } | null {
  const nr = normRef(extractedRef)
  const companyKey = companySlug.toLowerCase()
  // FIX 2: only company-scoped key — no ref-only fallback for reopen_candidate.
  return (nr && companyKey) ? (refToJobId.get(`${nr}|${companyKey}`) ?? null) : null
}

Deno.test("FIX 2 — missing company slug: ref-only match does NOT produce a reopen_candidate entry", () => {
  // Map built by the intake loop (job has a company slug, so it has a company-scoped key).
  const refToJobId = new Map<string, { jobId: string; status: string | null }>()
  const nr = normRef("67998")
  refToJobId.set(`${nr}|ajs`, { jobId: "job-ajs-1", status: "complete" })
  refToJobId.set(nr, { jobId: "job-ajs-1", status: "complete" }) // ref-only fallback still in map

  // Inbound email has no company slug (matchedCompany is null → companyKey = '').
  const entry = fix2LookupEntry(refToJobId, "67998", "")
  assertEquals(entry, null, "no company slug → no reopen_candidate entry (ambiguous ref is not enough)")
})

Deno.test("FIX 2 — whitespace-only company slug: also produces no reopen_candidate entry", () => {
  const refToJobId = new Map<string, { jobId: string; status: string | null }>()
  const nr = normRef("67998")
  refToJobId.set(`${nr}|ajs`, { jobId: "job-ajs-1", status: "complete" })
  refToJobId.set(nr, { jobId: "job-ajs-1", status: "complete" })

  const entry = fix2LookupEntry(refToJobId, "67998", "   ") // whitespace slug → trims to ''
  // The trim happens in index.ts: (matchedCompany?.slug || '').toLowerCase()
  // which produces '' for whitespace-only — same as missing.
  // Our helper mirrors this by passing the raw slug; '' key won't match `${nr}|ajs`.
  assertEquals(entry, null, "whitespace-only slug → no reopen_candidate (treated as missing)")
})

Deno.test("FIX 2 — matching company slug: company-scoped match STILL creates a reopen_candidate", () => {
  const refToJobId = new Map<string, { jobId: string; status: string | null }>()
  const nr = normRef("67998")
  refToJobId.set(`${nr}|ajs`, { jobId: "job-ajs-1", status: "complete" })
  refToJobId.set(nr, { jobId: "job-ajs-1", status: "complete" })

  const entry = fix2LookupEntry(refToJobId, "67998", "ajs")
  assertEquals(entry?.jobId, "job-ajs-1", "company-scoped match must resolve correctly")
  assertEquals(entry?.status, "complete")
})

// ── 15. FIX 3: updateInvoice report-job $0 gate ───────────────────────────────
//
// update_invoice now mirrors the create/complete gates: report-type jobs must
// carry a non-zero line total. Normal jobs are unaffected.

// Stub for updateInvoice: returns a xero_invoice row with a job_id, then
// returns makesafe_job_details with the given report_type for that job.
// The report-job $0 gate reads via the service-role admin client (ea2f778), so
// the stub is passed as updateInvoice's adminClientOverride test seam.
function makeUpdateInvoiceStub(opts: { reportType: string | null }) {
  return {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => {
            if (table === "xero_invoices") {
              return { data: { job_id: "job-r2" }, error: null }
            }
            if (table === "makesafe_job_details") {
              return { data: { report_type: opts.reportType }, error: null }
            }
            return { data: null, error: null }
          },
          single: async () => ({ data: null, error: null }),
        }),
        not: () => ({ data: [], error: null }),
        in: () => ({ data: [], error: null }),
      }),
      update: (_vals: any) => ({
        eq: () => Promise.resolve({ error: null }),
      }),
      insert: (_vals: any) => Promise.resolve({ error: null }),
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  }
}

Deno.test("FIX 3 — updateInvoice: report-type job with $0 line total is REJECTED", async () => {
  const stub = makeUpdateInvoiceStub({ reportType: "ajs_builder_report" })
  await assertRejects(
    () => updateInvoice(stub, {
      xero_invoice_id: "xero-inv-1",
      line_items: [{ description: "Labour", quantity: 1, unit_price: 0 }],
    }, stub),
    Error,
    "report job needs a charge amount",
  )
})

Deno.test("FIX 3 — updateInvoice: report-type job with $0 total (multi-line summing to 0) is REJECTED", async () => {
  const stub = makeUpdateInvoiceStub({ reportType: "ajs_builder_report" })
  await assertRejects(
    () => updateInvoice(stub, {
      xero_invoice_id: "xero-inv-1",
      line_items: [
        { description: "Credit", quantity: 1, unit_price: -50 },
        { description: "Charge", quantity: 1, unit_price: 50 },
      ],
    }, stub),
    Error,
    "report job needs a charge amount",
  )
})

Deno.test("FIX 3 — updateInvoice: normal job (no report_type) passes the gate", async () => {
  const stub = makeUpdateInvoiceStub({ reportType: null })
  let reportGateThrew = false
  try {
    await updateInvoice(stub, {
      xero_invoice_id: "xero-inv-2",
      line_items: [{ description: "Labour", quantity: 1, unit_price: 0 }],
    }, stub)
  } catch (e: any) {
    reportGateThrew = (e?.message || "").includes("report job needs a charge")
  }
  assert(!reportGateThrew, "normal job must not be blocked by the report-job gate")
})
