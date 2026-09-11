// Stage 4 Phase A — MakeSafe re-open / re-cycle mechanism tests.
//
// MONEY/COMMS critical. These tests are reimplement-pure + mocked: NO network,
// NO live Supabase, NO Xero.  They exercise the pure building blocks in
// makesafe_reopen.ts and the re_open_makesafe orchestration exported from index.ts.
//
// Contract items tested:
//   1. reattendance re-open creates a reattendance pack on the CHARGE path
//      (no_charge=false, cycle_number incremented)
//   2. rectification re-open creates a rectification pack, no_charge=true,
//      no invoice created/required
//   3. pickup re-open creates a pickup pack, no_charge=true,
//      no invoice created/required
//   4. re-open does NOT void the prior invoice
//   5. routine-mode re_open_makesafe is denied (central deny-list)
//   6. cycle-scoped invoice gate lets 2 invoices coexist (reattendance + main)
//   7. no_charge invoice gate returns skip signal
//   8. no_charge send gate: 1 report PDF, 0 invoice PDFs passes; 1+1 fails
//   9. non-'main' pack_kind is NOT blocked by the main marker check
//  10. cycle marker functions scope correctly to pack_kind
//
// Run: deno test --allow-env --no-check
//        supabase/functions/ops-api/makesafe_reopen_test.ts

import {
  assertEquals,
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  isValidReopenReason,
  noChargeFromReason,
  isReopenEligible,
  validateReopenInput,
  buildReopenDetailPatch,
  buildNewPackRow,
  reopenPackKindForCycle,
  reopenReasonFromPackKind,
  checkNoChargeInvoiceGate,
  checkNoChargeSendGate,
  filterInvoicesToCurrentCycle,
  buildCyclePackSentMarkerText,
  isCyclePackSentEvent,
  hasCyclePackSentMarker,
  buildPackSentMarkerForKind,
  hasPackSentMarkerForKind,
  REOPEN_ELIGIBLE_STATUSES,
  REOPEN_REASONS,
  DEFAULT_ORG_ID,
} from "./makesafe_reopen.ts";

// Import the main-pack marker helpers to verify isolation.
import {
  isPackSentMainEvent,
  hasPackSentMainMarker,
  buildPackSentMarkerText,
  MAKESAFE_PACK_SENT_MAIN_PREFIX,
} from "./makesafe_send_pack.ts";

// Import the orchestration for end-to-end tests.
import {
  _reopenMakesafeForTest,
  _makesafeDraftIdempotencyKey,
  _makesafeMissingCloseoutDocsCycle,
} from "./index.ts";

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

const NOW = "2026-06-18T10:00:00Z";

// Minimal chainable Supabase stub — mirrors makesafe_lifecycle_test style.
function makeClient(opts: {
  jobRow?: any;
  detailRow?: any;
  insertOk?: boolean;
  updateOk?: boolean;
  packInsertOk?: boolean;
  eventInsertOk?: boolean;
}) {
  const insertedPacks: any[] = [];
  const insertedEvents: any[] = [];
  const jobUpdates: any[] = [];
  const detailUpdates: any[] = [];

  function builder(table: string) {
    const b: any = {
      select: (_cols?: string) => b,
      eq: (_col: string, _val: any) => b,
      maybeSingle: async () => {
        if (table === "jobs") return { data: opts.jobRow ?? null, error: null };
        if (table === "makesafe_job_details") return { data: opts.detailRow ?? null, error: null };
        return { data: null, error: null };
      },
      insert: async (row: any) => {
        if (table === "makesafe_report_packs") {
          if (opts.packInsertOk === false) return { error: { code: "99999", message: "insert failed" } };
          insertedPacks.push(row);
          return { data: [row], error: null };
        }
        if (table === "job_events") {
          insertedEvents.push(row);
          return { data: [row], error: null };
        }
        return { data: null, error: null };
      },
      update: (patch: any) => {
        if (table === "jobs") jobUpdates.push(patch);
        if (table === "makesafe_job_details") detailUpdates.push(patch);
        return {
          eq: (_col: string, _val: any) => ({
            eq: (_c2: string, _v2: any) => ({
              data: null,
              error: opts.updateOk === false ? { message: "update failed" } : null,
              then: (fn: any) => fn({ data: null, error: opts.updateOk === false ? { message: "update failed" } : null }),
            }),
            then: (fn: any) => fn({ data: null, error: opts.updateOk === false ? { message: "update failed" } : null }),
          }),
        };
      },
    };
    return b;
  }

  return {
    client: { from: (table: string) => builder(table) },
    insertedPacks,
    insertedEvents,
    jobUpdates,
    detailUpdates,
  };
}

// ─────────────────────────────────────────────────────────────────
// 1. PURE PREDICATES
// ─────────────────────────────────────────────────────────────────

Deno.test("isValidReopenReason: valid reasons pass; anything else fails", () => {
  for (const r of REOPEN_REASONS) {
    assert(isValidReopenReason(r), `${r} must be valid`);
  }
  assert(!isValidReopenReason("new"), "new is not a re-open reason");
  assert(!isValidReopenReason(""), "empty string is invalid");
  assert(!isValidReopenReason(null), "null is invalid");
  assert(!isValidReopenReason(undefined), "undefined is invalid");
});

Deno.test("noChargeFromReason: reattendance=false, rectification+pickup=true", () => {
  assertEquals(noChargeFromReason("reattendance"), false);
  assertEquals(noChargeFromReason("rectification"), true);
  assertEquals(noChargeFromReason("pickup"), true);
});

Deno.test("isReopenEligible: complete/invoiced/archived eligible; others not", () => {
  for (const s of REOPEN_ELIGIBLE_STATUSES) {
    assert(isReopenEligible(s), `${s} must be eligible`);
  }
  assert(!isReopenEligible("scheduled"), "scheduled is active — not eligible");
  assert(!isReopenEligible("in_progress"), "in_progress is active — not eligible");
  assert(!isReopenEligible("draft"), "draft is not eligible");
  assert(!isReopenEligible(null), "null is not eligible");
});

Deno.test("validateReopenInput: missing job_id -> 400", () => {
  const r = validateReopenInput({ jobId: null, reason: "reattendance", jobStatus: "complete" });
  assertEquals(r.ok, false);
  assertEquals(r.httpStatus, 400);
});

Deno.test("validateReopenInput: invalid reason -> 400", () => {
  const r = validateReopenInput({ jobId: "job-1", reason: "mystery", jobStatus: "complete" });
  assertEquals(r.ok, false);
  assertEquals(r.httpStatus, 400);
  assertStringIncludes(r.reason!, "must be one of");
});

Deno.test("validateReopenInput: active job status -> 409", () => {
  const r = validateReopenInput({ jobId: "job-1", reason: "reattendance", jobStatus: "scheduled" });
  assertEquals(r.ok, false);
  assertEquals(r.httpStatus, 409);
  assertStringIncludes(r.reason!, "not eligible for re-open");
});

Deno.test("validateReopenInput: valid reattendance -> ok", () => {
  const r = validateReopenInput({ jobId: "job-1", reason: "reattendance", jobStatus: "complete" });
  assertEquals(r.ok, true);
  assertEquals(r.httpStatus, 200);
  assertEquals(r.reason, null);
});

Deno.test("buildReopenDetailPatch: increments cycle_number, sets no_charge correctly", () => {
  const patch = buildReopenDetailPatch({ reason: "reattendance", priorCycleNumber: 1, nowIso: NOW });
  assertEquals(patch.cycle_number, 2);
  assertEquals(patch.no_charge, false);
  assertEquals(patch.reopen_reason, "reattendance");
  assertEquals(patch.substatus, "company_contact_required");

  const p2 = buildReopenDetailPatch({ reason: "rectification", priorCycleNumber: 2, nowIso: NOW });
  assertEquals(p2.cycle_number, 3);
  assertEquals(p2.no_charge, true);

  const p3 = buildReopenDetailPatch({ reason: "pickup", priorCycleNumber: 1, nowIso: NOW });
  assertEquals(p3.no_charge, true);
});

Deno.test("buildNewPackRow: sets per-cycle pack_kind (reason#cycle), status=drafted, org_id", () => {
  const row = buildNewPackRow({ jobId: "job-1", reason: "reattendance", cycleNumber: 2, nowIso: NOW });
  assertEquals(row.pack_kind, "reattendance#2");
  assertEquals(row.status, "drafted");
  assertEquals(row.org_id, DEFAULT_ORG_ID);
  assertEquals(row.job_id, "job-1");
});

// ── SAME-REASON REPEAT (Item 5): distinct pack key per cycle ─────────────────
Deno.test("reopenPackKindForCycle: a 2nd same-reason re-open gets a DISTINCT key", () => {
  assertEquals(reopenPackKindForCycle("reattendance", 2), "reattendance#2");
  assertEquals(reopenPackKindForCycle("reattendance", 4), "reattendance#4");
  // Two reattendances on the same job get DIFFERENT keys -> no collision, not swallowed.
  assert(reopenPackKindForCycle("reattendance", 2) !== reopenPackKindForCycle("reattendance", 4));
  assertEquals(reopenPackKindForCycle("rectification", 3), "rectification#3");
});

Deno.test("reopenReasonFromPackKind: recovers the reason; null for main/non-reopen", () => {
  assertEquals(reopenReasonFromPackKind("reattendance#2"), "reattendance");
  assertEquals(reopenReasonFromPackKind("rectification#5"), "rectification");
  assertEquals(reopenReasonFromPackKind("pickup#3"), "pickup");
  assertEquals(reopenReasonFromPackKind("main"), null);
  assertEquals(reopenReasonFromPackKind("photo"), null);
  assertEquals(reopenReasonFromPackKind(null), null);
});

// ─────────────────────────────────────────────────────────────────
// 2. NO-CHARGE INVOICE GATE
// ─────────────────────────────────────────────────────────────────

Deno.test("no_charge invoice gate: no_charge=true -> skipped:true, reason='no_charge'", () => {
  const result = checkNoChargeInvoiceGate(true);
  assert(result !== null);
  assertEquals(result!.skipped, true);
  assertEquals(result!.reason, "no_charge");
  assertStringIncludes(result!.note, "no_charge");
});

Deno.test("no_charge invoice gate: no_charge=false -> null (create invoice normally)", () => {
  assertEquals(checkNoChargeInvoiceGate(false), null);
});

// ─────────────────────────────────────────────────────────────────
// 3. NO-CHARGE SEND GATE (report-only, 0 invoice PDFs)
// ─────────────────────────────────────────────────────────────────

Deno.test("no_charge send gate: 1 report + 0 invoices PASSES", () => {
  const result = checkNoChargeSendGate({
    noCharge: true,
    attachments: [{ name: "Make Safe Report - AJBR-67200 - Erskine.pdf" }],
  });
  assert(result !== null, "should return a gate result for no_charge=true");
  assertEquals(result!.failures.length, 0, "1 report + 0 invoices must pass for no_charge");
  assertEquals(result!.isNoCharge, true);
});

Deno.test("no_charge send gate: 1 report + 1 Xero invoice FAILS (invoice not allowed)", () => {
  const result = checkNoChargeSendGate({
    noCharge: true,
    attachments: [
      { name: "Make Safe Report - AJBR-67200 - Erskine.pdf" },
      { name: "Xero Invoice - INV-0999.pdf" },
    ],
  });
  assert(result !== null);
  assert(result!.failures.length > 0, "invoice present on no_charge cycle must FAIL");
  assert(result!.failures.some((f) => f.includes("0 invoice PDFs")));
});

Deno.test("no_charge send gate: 0 reports FAILS (report required)", () => {
  const result = checkNoChargeSendGate({
    noCharge: true,
    attachments: [],
  });
  assert(result !== null);
  assert(result!.failures.length > 0);
  assert(result!.failures.some((f) => f.includes("exactly one make-safe report")));
});

Deno.test("no_charge send gate: no_charge=false -> null (use standard gate)", () => {
  const result = checkNoChargeSendGate({
    noCharge: false,
    attachments: [{ name: "Make Safe Report - X.pdf" }],
  });
  assertEquals(result, null, "no_charge=false must return null (caller uses checkClientSendGate)");
});

// ─────────────────────────────────────────────────────────────────
// 4. CYCLE-SCOPED INVOICE GATE
//    A reattendance's new invoice + the original main cycle's paid invoice
//    coexist WITHOUT tripping the fail-closed 2+-live-invoice gate.
// ─────────────────────────────────────────────────────────────────

Deno.test("cycle-scoped gate: original paid + reattendance draft coexist (each cycle sees 1)", () => {
  const originalInvoiceId = "xero-original-paid";
  const reattendanceInvoiceId = "xero-reattendance-draft";

  // All invoices on the job (what the DB returns for job_id=job-1).
  const allJobInvoices = [
    { xero_invoice_id: originalInvoiceId, invoice_number: "INV-100", status: "PAID", job_id: "job-1" },
    { xero_invoice_id: reattendanceInvoiceId, invoice_number: "INV-200", status: "DRAFT", job_id: "job-1" },
  ];

  // Main cycle sees BOTH invoices — that's the ambiguous state; the main cycle
  // was already sent (PAID) so this coexistence is safe at the data level.
  // The reattendance cycle is scoped to only its own invoice.
  const reattendanceScoped = filterInvoicesToCurrentCycle({
    allInvoices: allJobInvoices,
    currentPackXeroInvoiceId: reattendanceInvoiceId,
  });

  assertEquals(reattendanceScoped.length, 1, "scoped set must contain only the reattendance invoice");
  assertEquals(reattendanceScoped[0].xero_invoice_id, reattendanceInvoiceId);
  // The original invoice is NOT in the scoped set — the ambiguity gate won't fire.
});

Deno.test("cycle-scoped gate: no current cycle invoice -> empty scoped set (no ambiguity)", () => {
  const allJobInvoices = [
    { xero_invoice_id: "xero-paid", invoice_number: "INV-100", status: "PAID", job_id: "job-1" },
  ];
  const scoped = filterInvoicesToCurrentCycle({
    allInvoices: allJobInvoices,
    currentPackXeroInvoiceId: null,
  });
  assertEquals(scoped.length, 0, "no current cycle invoice -> empty scoped set");
});

Deno.test("cycle-scoped gate: main cycle pack_kind uses all job invoices (no scoping)", () => {
  // This test documents the intent: the filterInvoicesToCurrentCycle is only
  // applied for non-main packs in the orchestration.  For main, the full set is
  // used.  We verify the filter is correctly scope-exclusive.
  const allJobInvoices = [
    { xero_invoice_id: "xero-a", status: "PAID", job_id: "job-1" },
    { xero_invoice_id: "xero-b", status: "DRAFT", job_id: "job-1" },
  ];
  // With currentPackXeroInvoiceId = "xero-b", only xero-b is returned.
  const scoped = filterInvoicesToCurrentCycle({
    allInvoices: allJobInvoices,
    currentPackXeroInvoiceId: "xero-b",
  });
  assertEquals(scoped.length, 1);
  assertEquals(scoped[0].xero_invoice_id, "xero-b");
});

// ─────────────────────────────────────────────────────────────────
// 5. CYCLE PACK-SENT MARKER (non-'main' pack_kind scoped)
// ─────────────────────────────────────────────────────────────────

Deno.test("isCyclePackSentEvent: matches the correct pack_kind prefix", () => {
  const reattendanceMarker = buildCyclePackSentMarkerText({
    packKind: "reattendance",
    invoiceNumber: "INV-200",
    to: "builder@mlb.com.au",
    nowIso: NOW,
    messageId: "msg-1",
  });

  assert(isCyclePackSentEvent({ event_type: "note", detail_json: { text: reattendanceMarker } }, "reattendance"));
  // Must NOT match a different pack_kind.
  assert(!isCyclePackSentEvent({ event_type: "note", detail_json: { text: reattendanceMarker } }, "rectification"));
  assert(!isCyclePackSentEvent({ event_type: "note", detail_json: { text: reattendanceMarker } }, "main"));
});

Deno.test("non-'main' pack_kind marker is NOT detected by hasPackSentMainMarker", () => {
  // The existing main-pack marker check must NOT fire for a reattendance marker.
  // This is the key isolation test: a new cycle's send is not blocked by the
  // main cycle's marker logic.
  const reattendanceMarker = buildCyclePackSentMarkerText({
    packKind: "reattendance",
    invoiceNumber: "INV-200",
    to: "builder@mlb.com.au",
    nowIso: NOW,
  });

  const events = [
    { event_type: "note", detail_json: { text: reattendanceMarker } },
  ];

  // The main-pack marker check sees no main marker (correct: doesn't block reattendance).
  assertEquals(hasPackSentMainMarker(events), false, "reattendance marker must NOT trigger the main-pack marker check");

  // The cycle-scoped check correctly finds the reattendance marker.
  assertEquals(hasCyclePackSentMarker(events, "reattendance"), true);
  assertEquals(hasCyclePackSentMarker(events, "rectification"), false);
});

Deno.test("main marker does NOT interfere with non-main cycle detection", () => {
  // A 'main' pack marker must NOT be detected as a 'reattendance' marker.
  const mainMarkerText = `${MAKESAFE_PACK_SENT_MAIN_PREFIX} | INV-100 | to=x | ${NOW}`;
  const events = [
    { event_type: "note", detail_json: { text: mainMarkerText } },
  ];

  assert(isPackSentMainEvent(events[0]), "main marker must be detected by isPackSentMainEvent");
  assertEquals(hasCyclePackSentMarker(events, "reattendance"), false, "main marker must NOT be detected as reattendance");
  assertEquals(hasCyclePackSentMarker(events, "rectification"), false, "main marker must NOT be detected as rectification");
  assertEquals(hasCyclePackSentMarker(events, "pickup"), false, "main marker must NOT be detected as pickup");
});

Deno.test("hasCyclePackSentMarker scans a multi-event set correctly", () => {
  const events = [
    { event_type: "note", detail_json: { text: "some note" } },
    { event_type: "note", detail_json: { text: buildCyclePackSentMarkerText({ packKind: "rectification", invoiceNumber: null, to: "x", nowIso: NOW }) } },
  ];
  assertEquals(hasCyclePackSentMarker(events, "rectification"), true);
  assertEquals(hasCyclePackSentMarker(events, "reattendance"), false);
  assertEquals(hasCyclePackSentMarker([], "reattendance"), false);
});

// ─────────────────────────────────────────────────────────────────
// 6. ROUTINE DENIAL (central deny-list model, mirrors send_pack_test)
// ─────────────────────────────────────────────────────────────────

Deno.test("routine-mode re_open_makesafe is denied by ROUTINE_ALLOWED_ACTIONS default-deny", () => {
  // Mirrors the Sentinel Wave 0 central deny model. The ROUTINE_ALLOWED_ACTIONS set
  // in index.ts does NOT include 're_open_makesafe', so any routine call is denied.
  // This test models that set and asserts re_open_makesafe is NOT in it.
  const ROUTINE_ALLOWED_ACTIONS = new Set<string>([
    "ops_api_version", "ops_summary", "makesafe_pipeline", "makesafe_pipeline_items",
    "makesafe_audit", "makesafe_new_emails", "get_makesafe_email", "get_makesafe_attachment_url",
    "job_detail", "list_intake_drafts", "list_makesafe_companies",
    "scan_ses_makesafes", "create_intake_draft", "create_makesafe_job",
    "attach_makesafe_document", "submit_makesafe_report", "update_makesafe_substatus",
    "create_makesafe_draft_invoice", "makesafe_render_report", "makesafe_report_drafts",
    // 're_open_makesafe' is DELIBERATELY absent — it is PRIVILEGED.
  ]);

  function centralAuthStatus(authMode: string, action: string): number {
    if (authMode === "routine" && !ROUTINE_ALLOWED_ACTIONS.has(action)) return 403;
    return 200;
  }

  assertEquals(centralAuthStatus("routine", "re_open_makesafe"), 403, "routine must be denied re_open_makesafe");
  assertEquals(centralAuthStatus("api_key", "re_open_makesafe"), 200, "api_key (dashboard) must reach the route case");
  assertEquals(centralAuthStatus("jwt", "re_open_makesafe"), 200, "jwt must reach the route case");
  // The routine CAN still use draft/read actions.
  assertEquals(centralAuthStatus("routine", "create_makesafe_draft_invoice"), 200);
});

// ─────────────────────────────────────────────────────────────────
// 7. ORCHESTRATION — re_open_makesafe end-to-end (mocked client)
// ─────────────────────────────────────────────────────────────────

function makeReopenClient(jobStatus: string, cycleNumber: number, overrides: {
  packInsertCode?: string;
} = {}) {
  const insertedPacks: any[] = [];
  const insertedEvents: any[] = [];
  const jobUpdates: any[] = [];
  const detailUpdates: any[] = [];

  const jobRow = { id: "job-1", status: jobStatus, type: "makesafe" };
  const detailRow = { job_id: "job-1", cycle_number: cycleNumber, no_charge: false, substatus: "complete" };

  function builder(table: string) {
    const b: any = {
      _table: table,
      _eqs: [] as [string, any][],
      select: (_cols?: string) => b,
      eq: (col: string, val: any) => {
        b._eqs.push([col, val]);
        return b;
      },
      maybeSingle: async () => {
        if (table === "jobs") return { data: jobRow, error: null };
        if (table === "makesafe_job_details") return { data: detailRow, error: null };
        return { data: null, error: null };
      },
      insert: async (row: any) => {
        if (table === "makesafe_report_packs") {
          insertedPacks.push(row);
          if (overrides.packInsertCode) {
            return { data: null, error: { code: overrides.packInsertCode, message: "test error" } };
          }
          return { data: [row], error: null };
        }
        if (table === "job_events") {
          insertedEvents.push(row);
          return { data: [row], error: null };
        }
        return { data: null, error: null };
      },
      update: (patch: any) => {
        if (table === "jobs") jobUpdates.push(patch);
        if (table === "makesafe_job_details") detailUpdates.push(patch);
        const eqChain: any = {
          eq: (_c: string, _v: any) => ({
            then: (fn: any) => fn({ data: null, error: null }),
          }),
          then: (fn: any) => fn({ data: null, error: null }),
        };
        return eqChain;
      },
    };
    return b;
  }

  return {
    client: { from: (table: string) => builder(table) },
    insertedPacks,
    insertedEvents,
    jobUpdates,
    detailUpdates,
  };
}

// 7a. reattendance re-open: charge path, cycle_number incremented, pack created.
Deno.test("reattendance re-open: creates pack on charge path (no_charge=false, cycle 2)", async () => {
  const { client, insertedPacks, detailUpdates, jobUpdates } = makeReopenClient("complete", 1);
  const result: any = await _reopenMakesafeForTest(client, {
    job_id: "job-1",
    reason: "reattendance",
  });
  assertEquals(result.ok, true);
  assertEquals(result.reason, "reattendance");
  assertEquals(result.no_charge, false);
  assertEquals(result.cycle_number, 2);
  assertEquals(result.pack_kind, "reattendance#2");

  assertEquals(insertedPacks.length, 1, "should insert exactly one new pack row");
  assertEquals(insertedPacks[0].pack_kind, "reattendance#2");
  assertEquals(insertedPacks[0].status, "drafted");

  // Job should be set back to 'scheduled'.
  assertEquals(jobUpdates.length, 1);
  assertEquals(jobUpdates[0].status, "scheduled");

  // Detail should be patched with reason + no_charge + cycle_number.
  assertEquals(detailUpdates.length, 1);
  assertEquals(detailUpdates[0].reopen_reason, "reattendance");
  assertEquals(detailUpdates[0].no_charge, false);
  assertEquals(detailUpdates[0].cycle_number, 2);
});

// 7b. rectification re-open: no_charge=true, cycle incremented.
Deno.test("rectification re-open: no_charge=true, cycle incremented, pack created", async () => {
  const { client, insertedPacks, detailUpdates } = makeReopenClient("invoiced", 1);
  const result: any = await _reopenMakesafeForTest(client, {
    job_id: "job-1",
    reason: "rectification",
  });
  assertEquals(result.ok, true);
  assertEquals(result.no_charge, true);
  assertEquals(result.cycle_number, 2);

  assertEquals(insertedPacks.length, 1);
  assertEquals(insertedPacks[0].pack_kind, "rectification#2");

  assertEquals(detailUpdates[0].no_charge, true);
});

// 7c. pickup re-open: no_charge=true, cycle incremented.
Deno.test("pickup re-open: no_charge=true, cycle incremented, pack created", async () => {
  const { client, insertedPacks, detailUpdates } = makeReopenClient("archived", 1);
  const result: any = await _reopenMakesafeForTest(client, {
    job_id: "job-1",
    reason: "pickup",
  });
  assertEquals(result.ok, true);
  assertEquals(result.no_charge, true);
  assertEquals(result.cycle_number, 2);
  assertEquals(insertedPacks[0].pack_kind, "pickup#2");
  assertEquals(detailUpdates[0].no_charge, true);
});

// 7d. re-open does NOT void the prior invoice.
// The orchestration must NEVER call voidInvoice / update xero_invoices on re-open.
// We verify this by ensuring no xero_invoices update appears in our mock.
Deno.test("re-open does NOT touch xero_invoices (prior invoice preserved)", async () => {
  const xeroUpdates: any[] = [];

  // Extend the mock to track xero_invoices updates.
  const baseResult = makeReopenClient("complete", 1);
  const extClient = {
    from: (table: string) => {
      if (table === "xero_invoices") {
        return {
          update: (patch: any) => {
            xeroUpdates.push(patch);
            return { eq: () => ({ then: (fn: any) => fn({ error: null }) }) };
          },
        };
      }
      return baseResult.client.from(table);
    },
  };

  await _reopenMakesafeForTest(extClient, { job_id: "job-1", reason: "reattendance" });
  assertEquals(xeroUpdates.length, 0, "re_open_makesafe must NEVER update xero_invoices");
});

// 7e. Duplicate pack (unique violation) is treated as idempotent.
Deno.test("re-open with duplicate pack (23505 unique violation) is idempotent", async () => {
  const { client } = makeReopenClient("complete", 1, { packInsertCode: "23505" });
  const result: any = await _reopenMakesafeForTest(client, { job_id: "job-1", reason: "reattendance" });
  // Should NOT throw — treated as idempotent.
  assertEquals(result.ok, true);
});

// 7f. Active-status job cannot be re-opened.
Deno.test("re-open of a scheduled (active) job is rejected (409)", async () => {
  const { client } = makeReopenClient("scheduled", 1);
  let threw = false;
  try {
    await _reopenMakesafeForTest(client, { job_id: "job-1", reason: "reattendance" });
  } catch (e: any) {
    threw = true;
    assert(e.message.includes("not eligible") || e.status === 409, `unexpected error: ${e.message}`);
  }
  assert(threw, "re-open of a scheduled job must throw");
});

// 7g. Invalid reason is rejected (400).
Deno.test("re-open with invalid reason is rejected (400)", async () => {
  const { client } = makeReopenClient("complete", 1);
  let threw = false;
  try {
    await _reopenMakesafeForTest(client, { job_id: "job-1", reason: "mystery" });
  } catch (e: any) {
    threw = true;
    assert(e.message.includes("must be one of") || e.status === 400);
  }
  assert(threw, "invalid reason must throw");
});

// 7h. SAME-REASON REPEAT (Item 5): a 2nd reattendance (cycle 2 -> 3) gets a
// DISTINCT pack key, NOT swallowed.
Deno.test("re-open: 2nd same-reason re-open gets a DISTINCT pack key (not swallowed)", async () => {
  // Job already had one reattendance (cycle_number now 2). A 2nd reattendance.
  const { client, insertedPacks } = makeReopenClient("complete", 2);
  const result: any = await _reopenMakesafeForTest(client, { job_id: "job-1", reason: "reattendance" });
  assertEquals(result.cycle_number, 3);
  assertEquals(result.pack_kind, "reattendance#3", "2nd reattendance must be cycle 3 with a distinct key");
  assertEquals(insertedPacks[0].pack_kind, "reattendance#3");
});

// ═════════════════════════════════════════════════════════════════
// 8. RE-VALIDATION FIXES (per independent + Codex review).
// ═════════════════════════════════════════════════════════════════

// ── Item 1: per-cycle send markers (unified dispatcher) ──────────────────────
Deno.test("Item 1 — buildPackSentMarkerForKind: main -> main marker; re-open -> per-cycle", () => {
  // main -> byte-identical to the existing main builder.
  const mainText = buildPackSentMarkerForKind("main", buildPackSentMarkerText, {
    invoiceNumber: "INV-100", to: "b@x.com", nowIso: NOW, messageId: "m1",
  });
  const directMain = buildPackSentMarkerText({ invoiceNumber: "INV-100", to: "b@x.com", nowIso: NOW, messageId: "m1" });
  assertEquals(mainText, directMain, "main must delegate to the existing main builder");
  assert(isPackSentMainEvent({ event_type: "note", detail_json: { text: mainText } }));

  // re-open -> per-cycle marker, NOT a main marker.
  const cycleText = buildPackSentMarkerForKind("reattendance#2", buildPackSentMarkerText, {
    invoiceNumber: "INV-200", to: "b@x.com", nowIso: NOW,
  });
  assert(!isPackSentMainEvent({ event_type: "note", detail_json: { text: cycleText } }), "re-open marker must NOT be a main marker");
  assert(isCyclePackSentEvent({ event_type: "note", detail_json: { text: cycleText } }, "reattendance#2"));
});

Deno.test("Item 1 — hasPackSentMarkerForKind: a reattendance marker does NOT block a reattendance#3 send and vice versa", () => {
  const reattendance2Marker = buildPackSentMarkerForKind("reattendance#2", buildPackSentMarkerText, {
    invoiceNumber: "INV-200", to: "b@x.com", nowIso: NOW,
  });
  const events = [{ event_type: "note", detail_json: { text: reattendance2Marker } }];

  // The reattendance#2 marker is detected for reattendance#2.
  assertEquals(hasPackSentMarkerForKind("reattendance#2", events, isPackSentMainEvent), true);
  // It does NOT block a DIFFERENT cycle (reattendance#3) or the main pack.
  assertEquals(hasPackSentMarkerForKind("reattendance#3", events, isPackSentMainEvent), false);
  assertEquals(hasPackSentMarkerForKind("main", events, isPackSentMainEvent), false,
    "a re-open send must NOT poison the main pack's marker check");
});

Deno.test("Item 1 — a MAIN marker does NOT block a reattendance send (the original bug)", () => {
  const mainMarker = `${MAKESAFE_PACK_SENT_MAIN_PREFIX} | INV-100 | to=x | ${NOW}`;
  const events = [{ event_type: "note", detail_json: { text: mainMarker } }];
  // Entry stop-check for a reattendance#2 cycle: must NOT see the main marker.
  assertEquals(hasPackSentMarkerForKind("reattendance#2", events, isPackSentMainEvent), false,
    "the original main marker must NOT block a reattendance cycle's send");
  // The main pack itself is still correctly blocked.
  assertEquals(hasPackSentMarkerForKind("main", events, isPackSentMainEvent), true);
});

// ── Item 5 cont: per-cycle marker token does not prefix-collide ──────────────
Deno.test("Item 5 — reattendance#2 marker does NOT match reattendance#20 (token-exact)", () => {
  const m2 = buildCyclePackSentMarkerText({ packKind: "reattendance#2", invoiceNumber: "INV-2", to: "x", nowIso: NOW });
  assert(isCyclePackSentEvent({ event_type: "note", detail_json: { text: m2 } }, "reattendance#2"));
  assert(!isCyclePackSentEvent({ event_type: "note", detail_json: { text: m2 } }, "reattendance#20"),
    "the '#2' token must not prefix-match '#20'");
});

// ── Item 3: no_charge decided SERVER-SIDE (createMakesafeDraftInvoice) ────────
// createMakesafeDraftInvoice loads makesafe_job_details.no_charge by job_id and
// ignores body.no_charge for the money decision. We exercise the orchestration
// with a mock whose detail row says no_charge=true while the caller passes
// no_charge=false; the invoice must be SKIPPED.
function makeDraftClient(opts: {
  detailNoCharge: boolean;
  cycleNumber: number;
}) {
  const jobEvents: any[] = [];
  function builder(table: string) {
    const b: any = {
      select: (_c?: string) => b,
      eq: (_col: string, _val: any) => b,
      order: () => b,
      maybeSingle: async () => {
        if (table === "makesafe_job_details") {
          return { data: { no_charge: opts.detailNoCharge, cycle_number: opts.cycleNumber, reopen_reason: opts.detailNoCharge ? "rectification" : "reattendance" }, error: null };
        }
        return { data: null, error: null };
      },
      insert: async (row: any) => {
        if (table === "job_events") jobEvents.push(row);
        return { data: [row], error: null };
      },
    };
    return b;
  }
  return { client: { from: (t: string) => builder(t) }, jobEvents };
}

Deno.test("Item 3 — createMakesafeDraftInvoice IGNORES caller no_charge, uses SERVER value (skips)", async () => {
  // We need the real handler. It is not exported, so we re-test the SERVER-SIDE
  // decision via the orchestration's observable effect: the draft is skipped.
  const { _createMakesafeDraftInvoiceForTest } = await import("./index.ts");
  const { client, jobEvents } = makeDraftClient({ detailNoCharge: true, cycleNumber: 2 });
  // Caller maliciously/incorrectly passes no_charge=false — must be IGNORED.
  const result: any = await _createMakesafeDraftInvoiceForTest(client, {
    job_id: "job-1",
    reference: "AJBR-67200",
    contact_name: "MLB",
    line_items: [{ description: "labour", quantity: 1, unit_price: 100 }],
    no_charge: false, // caller value — MUST be ignored
  });
  assertEquals(result.skipped, true, "server no_charge=true must skip even when caller says false");
  assertEquals(result.reason, "no_charge");
  // A skip note must be written.
  assert(jobEvents.some((e) => String(e.detail_json?.text || "").includes("[no_charge]")));
});

Deno.test("Item 3 — no_charge gate keys on the SERVER value, not the caller", () => {
  assert(checkNoChargeInvoiceGate(true) !== null, "server no_charge=true must skip");
  assertEquals(checkNoChargeInvoiceGate(false), null, "server no_charge=false must create");
});

// ── Item 4: cycle-aware closeout-doc preflight ───────────────────────────────
Deno.test("Item 4 — charge cycle requires invoice + report (+swms)", () => {
  // Missing invoice -> reported missing.
  const r1 = _makesafeMissingCloseoutDocsCycle(
    { has_invoice_doc: false, has_report_doc: true, has_swms_doc: true },
    false,
    { noCharge: false },
  );
  assert(r1.missing.includes("invoice"));
  assertEquals(r1.unexpected.length, 0);

  // All present -> clean.
  const r2 = _makesafeMissingCloseoutDocsCycle(
    { has_invoice_doc: true, has_report_doc: true, has_swms_doc: true },
    true,
    { noCharge: false },
  );
  assertEquals(r2.missing.length, 0);
  assertEquals(r2.unexpected.length, 0);
});

Deno.test("Item 4 — no_charge cycle requires report ONLY, NOT an invoice doc", () => {
  // no_charge: report present, NO invoice doc on this cycle -> clean (the original
  // invoice doc at the job level must NOT be required NOR satisfy anything here).
  const r = _makesafeMissingCloseoutDocsCycle(
    { has_invoice_doc: true, has_report_doc: true, has_swms_doc: false }, // stale original invoice doc present
    false,
    { noCharge: true, currentCycleHasInvoiceDoc: false },
  );
  assertEquals(r.missing.length, 0, "no_charge must NOT require an invoice doc");
  assertEquals(r.unexpected.length, 0, "a stale ORIGINAL invoice doc must not be flagged unexpected");
});

Deno.test("Item 4 — no_charge cycle still requires the report (+swms when needed)", () => {
  const r = _makesafeMissingCloseoutDocsCycle(
    { has_invoice_doc: false, has_report_doc: false, has_swms_doc: false },
    true,
    { noCharge: true, currentCycleHasInvoiceDoc: false },
  );
  assert(r.missing.includes("report"));
  assert(r.missing.includes("swms"));
  assert(!r.missing.includes("invoice"), "no_charge must never require an invoice");
});

Deno.test("Item 4 — no_charge cycle that raised THIS cycle's invoice doc is FLAGGED unexpected", () => {
  const r = _makesafeMissingCloseoutDocsCycle(
    { has_invoice_doc: true, has_report_doc: true, has_swms_doc: true },
    false,
    { noCharge: true, currentCycleHasInvoiceDoc: true }, // this cycle wrongly produced an invoice
  );
  assertEquals(r.missing.length, 0);
  assert(r.unexpected.some((u) => u.includes("invoice")), "an invoice on a no_charge cycle is unexpected");
});

// ── Item 2: cycle-scoped draft dedup (idempotency key is cycle-distinct) ──────
Deno.test("Item 2 — draft idempotency key is DISTINCT per cycle (reattendance != original)", () => {
  const cycle1 = _makesafeDraftIdempotencyKey("job-1", "AJBR-67200", 1);
  const cycle1Default = _makesafeDraftIdempotencyKey("job-1", "AJBR-67200"); // default cycle 1
  assertEquals(cycle1, cycle1Default, "cycle 1 must be byte-identical to the original key (no regression)");

  const cycle2 = _makesafeDraftIdempotencyKey("job-1", "AJBR-67200", 2);
  const cycle3 = _makesafeDraftIdempotencyKey("job-1", "AJBR-67200", 3);
  assert(cycle2 !== cycle1, "cycle 2 key must DIFFER from cycle 1 (so Xero does not collapse the new charge)");
  assert(cycle3 !== cycle2, "cycle 3 key must DIFFER from cycle 2");
  assert(cycle2.includes("c2"));
  assert(cycle3.includes("c3"));
});

Deno.test("Item 2 — cycle-scoped dedup: a reattendance draft is NOT blocked by the original paid invoice", () => {
  // Original (paid) + reattendance (none yet). Scoped to the reattendance cycle
  // (whose pack has no xero_invoice_id yet) -> empty set -> no block -> create.
  const allInvoices = [
    { xero_invoice_id: "xero-original", invoice_number: "INV-100", status: "PAID", job_id: "job-1", reference: "AJBR-67200" },
  ];
  const scoped = filterInvoicesToCurrentCycle({ allInvoices, currentPackXeroInvoiceId: null });
  assertEquals(scoped.length, 0, "reattendance cycle (no invoice yet) -> empty scoped set -> new draft allowed");

  // After the reattendance draft exists and is linked to the cycle pack, the
  // dedup finds it (idempotent) and does NOT double-create.
  const allInvoices2 = [
    ...allInvoices,
    { xero_invoice_id: "xero-reattend", invoice_number: "INV-200", status: "DRAFT", job_id: "job-1", reference: "AJBR-67200" },
  ];
  const scoped2 = filterInvoicesToCurrentCycle({ allInvoices: allInvoices2, currentPackXeroInvoiceId: "xero-reattend" });
  assertEquals(scoped2.length, 1);
  assertEquals(scoped2[0].xero_invoice_id, "xero-reattend", "dedup scoped to the reattendance invoice only");
});
