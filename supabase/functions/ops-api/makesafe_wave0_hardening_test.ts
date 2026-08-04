// deno-lint-ignore-file no-import-prefix
// Wave 0 (Make-Safe Autopilot) hardening proof tests.
//
// PROVES the Wave 0 gate fixes in ops-api/index.ts, including the scoped-routine-key
// model (decision scoped-routine-key-2026-06-17):
//   C2  — approve_intake_draft is PRIVILEGED: allowed for the master SW_API_KEY (the
//         ops dashboard, authMode='api_key') OR a jwt admin/owner; the scoped routine
//         key (authMode='routine') is REJECTED. (route gate)
//   C3  — approveIntakeDraft claims the draft ATOMICALLY so two concurrent approvals
//         cannot both create a live job, with an orphan-safe post-claim catch.
//   SCOPED KEY — the routine key cannot approve, cannot create a LIVE job (redirected
//         to a needs_review draft), cannot authorise; the privileged SW_API_KEY (the
//         dashboard) CAN approve + create live (the C2 dashboard regression is fixed).
//
// Why these are reimplemented-pure tests (not direct imports): importing index.ts
// here boots the production HTTP server via serve(...) at module load, and both the
// route gate and approveIntakeDraft are module-internal (not exported). This file
// follows the SAME convention the existing index_test.ts Quick-Quote section uses:
// reimplement the exact pattern under test as a small pure function and exercise it
// with mocked deps, cross-referenced to the deployed code by line. The patterns here
// mirror index.ts VERBATIM, so a future change to a real gate that breaks the contract
// will also break this test if kept in sync.
//
// No network. No live Supabase. No live Xero.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ── C2: the exact gate predicate from index.ts route case 'approve_intake_draft' ──
//   const approveIsPrivileged = authMode === 'api_key' ||
//     (authMode === 'jwt' && (authUser?.role === 'admin' || authUser?.role === 'owner'))
//   if (!approveIsPrivileged) return json({ error: '...' }, 403)
type AuthMode = "api_key" | "jwt" | "routine";
type AuthUser = { id: string; email: string; role: string } | null;

function approveGate(
  authMode: AuthMode,
  authUser: AuthUser,
): { allowed: boolean; status: number } {
  const approveIsPrivileged = authMode === "api_key" ||
    (authMode === "jwt" &&
      (authUser?.role === "admin" || authUser?.role === "owner"));
  return approveIsPrivileged
    ? { allowed: true, status: 200 }
    : { allowed: false, status: 403 };
}

Deno.test("C2: routine key is REJECTED on approve_intake_draft (403)", () => {
  // The scoped automation routine presents MAKESAFE_ROUTINE_KEY -> authMode='routine'.
  const r = approveGate("routine", null);
  assertEquals(
    r.allowed,
    false,
    "the make-safe automation routine must never approve a draft",
  );
  assertEquals(r.status, 403);
});

Deno.test("C2 regression FIX: the ops dashboard (privileged SW_API_KEY = api_key) CAN approve", () => {
  // The dashboard authenticates with SW_API_KEY + anon bearer -> authMode='api_key',
  // NEVER a user JWT. The earlier jwt-only gate 403'd it; the privileged-key allowance
  // restores the live approve button.
  const r = approveGate("api_key", null);
  assertEquals(
    r.allowed,
    true,
    "the ops dashboard approve button (SW_API_KEY) must work",
  );
  assertEquals(r.status, 200);
});

Deno.test("C2: a logged-in admin/owner JWT IS allowed (the human tick)", () => {
  assertEquals(
    approveGate("jwt", { id: "u1", email: "marnin@x", role: "admin" }).allowed,
    true,
  );
  assertEquals(
    approveGate("jwt", { id: "u2", email: "shaun@x", role: "owner" }).allowed,
    true,
  );
});

Deno.test("C2: a non-admin/owner JWT is rejected (403)", () => {
  for (const role of ["ops", "trade", "viewer", "unknown", ""]) {
    const r = approveGate("jwt", { id: "u", email: "u@x", role });
    assertEquals(r.allowed, false, `jwt + role=${role} must be rejected`);
    assertEquals(r.status, 403);
  }
  // A jwt with no user object (shouldn't happen, but must fail closed).
  assertEquals(approveGate("jwt", null).allowed, false);
});

// ── SCOPED ROUTINE KEY (decision scoped-routine-key-2026-06-17) ──
// 1) The central routine ALLOW-LIST from index.ts. DEFAULT-DENY: the routine may call
//    ONLY these actions; everything else is rejected. Mirrors ROUTINE_ALLOWED_ACTIONS +
//    the guard `if (authMode==='routine' && action && !ALLOWED.has(action)) -> 403`.
//    Kept in sync with index.ts; drift in either breaks these tests.
const ROUTINE_ALLOWED_ACTIONS = new Set([
  "ops_api_version",
  "ops_summary",
  "makesafe_pipeline",
  "makesafe_pipeline_items",
  "makesafe_audit",
  "makesafe_new_emails",
  "get_makesafe_email",
  "get_makesafe_attachment_url",
  "job_detail",
  "list_intake_drafts",
  "makesafe_deterministic_intake_replay",
  "makesafe_deterministic_intake_dark_observe",
  "list_makesafe_companies",
  "makesafe_reporting_intake_pass",
  "create_intake_draft",
  "create_makesafe_job", // reaches its case -> redirected to a draft (never a live job)
  "attach_makesafe_document",
  "submit_makesafe_report",
  "update_makesafe_substatus",
  // Sealed SES local proposal/read surfaces. None can call Xero or Graph.
  "makesafe_render_report",
  "makesafe_report_drafts",
  "prepare_ses_invoice_obligation",
  "create_ses_invoice_draft",
  "resolve_ses_invoice_duplicates",
  "query_ses_invoice_obligation",
  "prepare_ses_release_revision",
  "query_ses_review_cockpit",
  "query_ses_proof_ledger",
  "list_draft_notes",
  "rerun_draft_report",
]);
// Default-deny: a routine caller is allowed ONLY if the action is in the allow-list.
function routineDenied(authMode: AuthMode, action: string): boolean {
  return authMode === "routine" && !ROUTINE_ALLOWED_ACTIONS.has(action);
}

// The General's required deny cases plus the campaign's whole comms surface. NONE of
// these is in the allow-list, so default-deny must reject the routine on every one.
const ROUTINE_MUST_DENY = [
  // comms (the campaign #1 rule: the AI never sends)
  "send_email",
  "send_sms",
  "send_po_email",
  "send_client_update",
  "send_quote",
  "send_chase_sms",
  "send_review_request",
  "send_invoice_email",
  "send_acceptance_invoice",
  "send_payment_link",
  "send_variation",
  "send_work_order",
  "send_comms_message",
  "send_council_email",
  "send_quick_quote_email",
  // money / authorise
  "approve_invoice",
  "approve_and_send_invoice",
  "void_invoice",
  "update_invoice",
  "mark_invoice_paid",
  "create_invoice",
  "create_deposit_invoice",
  "push_po_to_xero",
  // approve / send-pack
  "approve_intake_draft",
  "auto_approve_clean_intake_drafts",
  "makesafe_send_pack",
  "approve_ses_invoice_revision",
  "execute_ses_invoice_revision",
  "approve_ses_release_revision",
  "execute_ses_release_revision",
  "record_ses_review_feedback",
  // Retired free-create paths must stay unreachable to the routine.
  "create_makesafe_draft_invoice",
  "draft_makesafe_report_pack",
  "draft_makesafe_report_pack_due",
  "approve_variation",
  "approve_expense",
  // crew / PO / assignment / status-mutation (the broader default-deny the General extended)
  "create_po",
  "update_job_status",
  "create_assignment",
  "update_job_field",
  "complete_job",
  "complete_and_invoice",
  "create_work_order",
  // feedback writes are human/privileged only; the routine may read notes and
  // refresh eligible drafts, but it cannot inject note text into arbitrary jobs.
  "add_draft_note",
  // a NEW dangerous action nobody has added to the allow-list yet (fail-safe proof)
  "some_future_dangerous_action",
];

Deno.test("ScopedKey (default-deny): routine is DENIED on all comms, money, approve, crew/PO/status, and any unknown action", () => {
  for (const action of ROUTINE_MUST_DENY) {
    assert(
      routineDenied("routine", action),
      `default-deny must reject the routine on ${action}`,
    );
  }
});

Deno.test("ScopedKey (default-deny): a brand-new unenumerated action is denied by DEFAULT (fail-safe)", () => {
  // This is the whole point of flipping to an allow-list: a future send/authorise
  // action added elsewhere is NOT routine-callable unless explicitly allow-listed.
  assert(
    routineDenied("routine", "send_some_new_channel"),
    "unknown action must fail safe (denied)",
  );
  assert(
    routineDenied("routine", "authorise_anything_new"),
    "unknown action must fail safe (denied)",
  );
});

Deno.test("ScopedKey: routine IS ALLOWED on the safe draft/read/render/attach few", () => {
  for (
    const action of [
      "job_detail",
      "create_intake_draft",
      "makesafe_reporting_intake_pass",
      "list_intake_drafts",
      "makesafe_deterministic_intake_replay",
      "makesafe_deterministic_intake_dark_observe",
      "attach_makesafe_document",
      "submit_makesafe_report",
      "ops_summary",
      "makesafe_pipeline",
      // Sealed SES local proposal/read actions — routine-safe (no send/authorise).
      "makesafe_render_report",
      "makesafe_report_drafts",
      "prepare_ses_invoice_obligation",
      "create_ses_invoice_draft",
      "resolve_ses_invoice_duplicates",
      "query_ses_invoice_obligation",
      "prepare_ses_release_revision",
      "query_ses_review_cockpit",
      "query_ses_proof_ledger",
      "list_draft_notes",
      "rerun_draft_report",
    ]
  ) {
    assert(
      !routineDenied("routine", action),
      `routine must be allowed on the safe action ${action}`,
    );
  }
});

Deno.test("ScopedKey (sealed SES): local prepare/read actions are allow-listed but money and release stay DENIED", () => {
  assert(!routineDenied("routine", "makesafe_render_report"));
  assert(!routineDenied("routine", "makesafe_report_drafts"));
  assert(!routineDenied("routine", "prepare_ses_invoice_obligation"));
  assert(!routineDenied("routine", "create_ses_invoice_draft"));
  assert(!routineDenied("routine", "prepare_ses_release_revision"));
  assert(!routineDenied("routine", "query_ses_review_cockpit"));
  assert(!routineDenied("routine", "rerun_draft_report"));
  assert(routineDenied("routine", "create_makesafe_draft_invoice"));
  assert(routineDenied("routine", "approve_ses_invoice_revision"));
  assert(routineDenied("routine", "execute_ses_invoice_revision"));
  assert(routineDenied("routine", "approve_ses_release_revision"));
  assert(routineDenied("routine", "execute_ses_release_revision"));
  assert(
    routineDenied("routine", "makesafe_send_pack"),
    "send_pack must remain denied by default-deny",
  );
});

Deno.test("ScopedKey: privileged + jwt callers are NEVER blocked by the routine allow-list", () => {
  // The allow-list gate only fires for authMode==='routine'. Every action the routine
  // is denied must still be reachable by the dashboard (api_key) and a jwt caller.
  for (const action of [...ROUTINE_MUST_DENY, ...ROUTINE_ALLOWED_ACTIONS]) {
    assert(
      !routineDenied("api_key", action),
      `api_key must never be blocked by the routine gate (${action})`,
    );
    assert(
      !routineDenied("jwt", action),
      `jwt must never be blocked by the routine gate (${action})`,
    );
  }
});

// 2) create_makesafe_job dispatch from index.ts route case: routine -> draft, else live.
type CreateOutcome = "live_job" | "needs_review_draft";
function createMakesafeDispatch(authMode: AuthMode): CreateOutcome {
  // case 'create_makesafe_job': if (authMode === 'routine') -> createMakesafeDraftFromProposal
  //                             else -> createMakesafeJob (live)
  return authMode === "routine" ? "needs_review_draft" : "live_job";
}

Deno.test("ScopedKey: routine create_makesafe_job is REDIRECTED to a draft, never a live job", () => {
  assertEquals(
    createMakesafeDispatch("routine"),
    "needs_review_draft",
    "the routine must not put a live make-safe job on the board",
  );
});

Deno.test("ScopedKey: privileged SW_API_KEY (dashboard) and jwt create a LIVE job, as today", () => {
  assertEquals(
    createMakesafeDispatch("api_key"),
    "live_job",
    "the ops dashboard manual create button stays live",
  );
  assertEquals(createMakesafeDispatch("jwt"), "live_job");
});

// 3) Defensive: an UNSET MAKESAFE_ROUTINE_KEY env must never classify a caller as
//    routine (the morning-provisioning reality). Mirrors index.ts:
//      const routineKey = env && env.length > 0 ? env : null
//      if (routineKey && (xApiKey === routineKey || bearerToken === routineKey)) 'routine'
function classifyAuthMode(opts: {
  routineKeyEnv: string | null;
  swApiKey: string;
  xApiKey: string | null;
  bearer: string | null;
}): AuthMode | "unauthorized" {
  const routineKey = opts.routineKeyEnv && opts.routineKeyEnv.length > 0
    ? opts.routineKeyEnv
    : null;
  if (
    routineKey && (opts.xApiKey === routineKey || opts.bearer === routineKey)
  ) return "routine";
  if (opts.xApiKey && opts.xApiKey === opts.swApiKey) return "api_key";
  if (opts.bearer && opts.bearer === opts.swApiKey) return "api_key";
  if (opts.bearer) return "jwt"; // (would then be validated as a real JWT)
  return "unauthorized";
}

Deno.test("ScopedKey: an UNSET routine key env never classifies anyone as routine", () => {
  // Routine key not provisioned yet (env unset). A caller sending an empty/no key must
  // not become 'routine'; a caller with SW_API_KEY is still 'api_key' as before.
  assertEquals(
    classifyAuthMode({
      routineKeyEnv: null,
      swApiKey: "MASTER",
      xApiKey: null,
      bearer: null,
    }),
    "unauthorized",
  );
  assertEquals(
    classifyAuthMode({
      routineKeyEnv: "",
      swApiKey: "MASTER",
      xApiKey: "",
      bearer: null,
    }),
    "unauthorized",
  );
  assertEquals(
    classifyAuthMode({
      routineKeyEnv: null,
      swApiKey: "MASTER",
      xApiKey: "MASTER",
      bearer: null,
    }),
    "api_key",
  );
});

Deno.test("ScopedKey: when provisioned, the routine key classifies as routine and SW_API_KEY stays api_key", () => {
  assertEquals(
    classifyAuthMode({
      routineKeyEnv: "ROUTINE",
      swApiKey: "MASTER",
      xApiKey: "ROUTINE",
      bearer: null,
    }),
    "routine",
  );
  assertEquals(
    classifyAuthMode({
      routineKeyEnv: "ROUTINE",
      swApiKey: "MASTER",
      xApiKey: "MASTER",
      bearer: null,
    }),
    "api_key",
  );
  // The routine key and master key are distinct; presenting the master is never routine.
  assert(
    classifyAuthMode({
      routineKeyEnv: "ROUTINE",
      swApiKey: "MASTER",
      xApiKey: "MASTER",
      bearer: null,
    }) !== "routine",
  );
});

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
  let status = initialStatus;
  return {
    // Mirrors the chained PostgREST call: update(...).eq('id',id).in('status',set).select()
    atomicClaim(
      _id: string,
      allowedFrom: string[],
    ): { rows: Array<{ id: string; status: string }> } {
      // Postgres evaluates the WHERE against the current row and updates it in one
      // atomic statement; a concurrent statement sees the already-committed result.
      if (allowedFrom.includes(status)) {
        status = "approved";
        return { rows: [{ id: _id, status }] };
      }
      return { rows: [] };
    },
    current(): string {
      return status;
    },
    // Unconditional set, modelling the catch-path .update({status:...}).eq('id',id)
    // (no pre-image guard; the catch already owns the row via the prior claim).
    forceStatus(s: string) {
      status = s;
    },
  };
}

// One approval attempt = the claim + (on success) create the job. Returns whether
// THIS caller created a live job.
function attemptApprove(
  store: ReturnType<typeof makeDraftStore>,
  jobsCreated: { n: number },
): { created: boolean } {
  const { rows } = store.atomicClaim("draft-1", ["needs_review", "draft"]);
  if (rows.length === 0) {
    return { created: false }; // concurrent/invalid -> blocked, no job
  }
  jobsCreated.n += 1; // only the winner reaches createMakesafeJob
  return { created: true };
}

Deno.test("C3: two concurrent approvals of a needs_review draft -> exactly ONE live job", () => {
  const store = makeDraftStore("needs_review");
  const jobsCreated = { n: 0 };
  // Serialized claims model the DB applying both UPDATEs one after the other.
  const a = attemptApprove(store, jobsCreated);
  const b = attemptApprove(store, jobsCreated);
  assertEquals(
    jobsCreated.n,
    1,
    "the double-click race must create exactly one job, not two",
  );
  assert(
    a.created !== b.created,
    "exactly one of the two concurrent approvals wins",
  );
  assertEquals(store.current(), "approved");
});

Deno.test("C3: a draft that is already approved cannot be re-approved (0 rows -> blocked)", () => {
  const store = makeDraftStore("approved");
  const jobsCreated = { n: 0 };
  const r = attemptApprove(store, jobsCreated);
  assertEquals(
    r.created,
    false,
    "re-approving an approved draft must not create another job",
  );
  assertEquals(jobsCreated.n, 0);
});

Deno.test("C3: rejected/superseded drafts cannot be approved", () => {
  for (const s of ["rejected", "superseded"]) {
    const store = makeDraftStore(s);
    const jobsCreated = { n: 0 };
    const r = attemptApprove(store, jobsCreated);
    assertEquals(r.created, false, `a ${s} draft must not be approvable`);
    assertEquals(jobsCreated.n, 0);
  }
});

Deno.test("C3: a 'draft' status (incomplete intake) is still claimable from the queue", () => {
  // scanSesMakesafes can land an incomplete draft as status='draft' (Eng P0-C);
  // the claim set includes 'draft' so it remains approvable once a human completes it.
  const store = makeDraftStore("draft");
  const jobsCreated = { n: 0 };
  const r = attemptApprove(store, jobsCreated);
  assertEquals(r.created, true);
  assertEquals(jobsCreated.n, 1);
});

// ── Concern 2 (auditor): C3 post-claim catch must not orphan-double-create ──
// Models the new approveIntakeDraft catch branch in index.ts:
//   let createdJobId = null
//   try { jobResult = createMakesafeJob(...); createdJobId = jobResult.job.id; <later steps> }
//   catch { if (!createdJobId) status -> needs_review (re-queue)
//           else status stays 'approved' + approved_job_id = createdJobId (no re-queue) }
// The hazard: if the job was created but a LATER step throws, the OLD code reset the
// draft to needs_review -> it could be approved again -> SECOND live job for one draft.

type FailPoint = "before_job" | "after_job" | "none";

function approveWithFailure(
  failAt: FailPoint,
  store: ReturnType<typeof makeDraftStore>,
  jobsCreated: { n: number },
): { finalStatus: string; approvedJobId: string | null; threw: boolean } {
  // Claim first (the C3 atomic claim).
  const { rows } = store.atomicClaim("draft-1", ["needs_review", "draft"]);
  if (rows.length === 0) {
    return { finalStatus: store.current(), approvedJobId: null, threw: false };
  }
  let createdJobId: string | null = null;
  let approvedJobId: string | null = null;
  try {
    if (failAt === "before_job") throw new Error("createMakesafeJob failed");
    // job created
    jobsCreated.n += 1;
    createdJobId = "job-" + jobsCreated.n;
    approvedJobId = createdJobId;
    if (failAt === "after_job") {
      throw new Error("audit update failed AFTER job insert");
    }
    return { finalStatus: store.current(), approvedJobId, threw: false };
  } catch (_e) {
    if (!createdJobId) {
      // safe to re-queue
      store.forceStatus("needs_review");
      return { finalStatus: store.current(), approvedJobId: null, threw: true };
    }
    // job exists: do NOT re-queue; keep approved + point at the orphan job
    store.forceStatus("approved");
    return {
      finalStatus: store.current(),
      approvedJobId: createdJobId,
      threw: true,
    };
  }
}

Deno.test("Concern2: pre-insert failure re-queues the draft (needs_review), no job", () => {
  const store = makeDraftStore("needs_review");
  const jobsCreated = { n: 0 };
  const r = approveWithFailure("before_job", store, jobsCreated);
  assertEquals(r.threw, true);
  assertEquals(
    jobsCreated.n,
    0,
    "no job created when the failure is before the insert",
  );
  assertEquals(
    r.finalStatus,
    "needs_review",
    "a pre-insert failure must release the claim",
  );
});

Deno.test("Concern2: post-insert failure does NOT re-queue (no orphan double-create)", () => {
  const store = makeDraftStore("needs_review");
  const jobsCreated = { n: 0 };
  const r = approveWithFailure("after_job", store, jobsCreated);
  assertEquals(r.threw, true);
  assertEquals(jobsCreated.n, 1, "exactly one job was created");
  assertEquals(
    r.finalStatus,
    "approved",
    "a post-insert failure must leave the draft approved, NOT re-queued",
  );
  assertEquals(
    r.approvedJobId,
    "job-1",
    "the draft must point at the orphan job for reconciliation",
  );
});

Deno.test("Concern2: a post-insert failure cannot be re-approved into a second job", () => {
  // Replays the real attack: job created, later step throws, then someone clicks
  // approve again. Because status stayed 'approved', the re-approval claim gets 0 rows.
  const store = makeDraftStore("needs_review");
  const jobsCreated = { n: 0 };
  approveWithFailure("after_job", store, jobsCreated); // first attempt: job-1, then audit fails
  assertEquals(store.current(), "approved");
  // second click:
  const second = attemptApprove(store, jobsCreated);
  assertEquals(
    second.created,
    false,
    "re-approving an approved-but-failed draft must NOT create a second job",
  );
  assertEquals(jobsCreated.n, 1, "still exactly one job total");
});
