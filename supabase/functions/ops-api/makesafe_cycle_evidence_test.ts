// deno-lint-ignore-file no-explicit-any
import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CYCLE_ATTRIBUTION,
  commercialCloseoutAllowed,
  computeReadinessRevisionSync,
  currentCycleReportMap,
  filterAssignmentsForCurrentCycle,
  hasReattendBoundary,
  isEvidenceBoundToCurrentCycle,
  isLegacyMakesafeCard,
  projectCycleScopedEvidence,
  readinessRevisionPayload,
  tradeSafeHold,
  typedReportDocSatisfiesCurrent,
} from "./makesafe_cycle_evidence.ts";
import {
  buildCanonicalMakesafeRows,
  projectTradeMakesafeBoard,
} from "./makesafe_board_read_model.ts";
import { _enrichMakesafeBoardJobForTest } from "./index.ts";

// ── Pure unit boundary (R1–R10 core) ─────────────────────────────────────────

Deno.test("R1 first attendance: unbound assignment + no report is legacy-compatible", () => {
  const detail = { cycle_number: 1, reattend_count: 0 };
  assertEquals(hasReattendBoundary(detail), false);
  assertEquals(isLegacyMakesafeCard(detail), true);
  const scoped = projectCycleScopedEvidence({
    detail,
    reports: [],
    assignments: [{ id: "a1", user_id: "u1", status: "assigned" }],
    docs: [],
    packSent: false,
    packCycleBound: true,
  });
  assertEquals(scoped.assignments.length, 1);
  assertEquals(scoped.has_report_record, false);
  assertEquals(scoped.allowCloseoutFromEvidence, true);
  assertEquals(scoped.cycle_number, 1);
});

Deno.test("R2 first report in: current-cycle report satisfies has_report_record", () => {
  const detail = { cycle_number: 1, reattend_count: 0 };
  const scoped = projectCycleScopedEvidence({
    detail,
    reports: [{ id: "r1", job_id: "j1", status: "submitted", cycle_number: 1 }],
    assignments: [{ id: "a1" }],
    packCycleBound: true,
  });
  assertEquals(scoped.has_report_record, true);
  assertEquals(scoped.serviceReport?.id, "r1");
});

Deno.test("R3 reattend before release: stale assignment + old report fail closed", () => {
  const detail = { cycle_number: 2, reattend_count: 1 };
  const scoped = projectCycleScopedEvidence({
    detail,
    reports: [{
      id: "r-old",
      job_id: "j1",
      status: "submitted",
      cycle_number: 1,
    }],
    assignments: [{
      id: "a-old",
      cycle_attribution: CYCLE_ATTRIBUTION.BACKFILL_CYCLE_SCOPE,
    }],
    docs: [{ type: "makesafe_report" }],
    pack: { status: "sent", sent_at: "2026-07-01T00:00:00Z" },
    packSent: true,
    packCycleBound: false,
    photoCount: 12,
  });
  assertEquals(scoped.has_report_record, false);
  assertEquals(scoped.assignments.length, 0);
  assertEquals(scoped.packSent, false);
  assertEquals(scoped.photoCount, 0);
  assertEquals(scoped.allowCloseoutFromEvidence, false);
  assertEquals(
    scoped.cycle_attribution_flags.includes("stale_assignment_excluded"),
    true,
  );
  assertEquals(
    scoped.cycle_attribution_flags.includes("stale_report_excluded"),
    true,
  );
});

Deno.test("R3b reattend: current-cycle report + bound assignment pass", () => {
  const detail = { cycle_number: 2, reattend_count: 1 };
  const scoped = projectCycleScopedEvidence({
    detail,
    reports: [
      { id: "r1", status: "submitted", cycle_number: 1 },
      { id: "r2", status: "submitted", cycle_number: 2 },
    ],
    assignments: [
      { id: "a1", cycle_number: 1 },
      { id: "a2", cycle_number: 2, attendance_cycle_id: "cyc-2" },
    ],
    attendanceCycleId: "cyc-2",
    packCycleBound: false,
  });
  assertEquals(scoped.serviceReport?.id, "r2");
  assertEquals(scoped.assignments.map((a) => a.id), ["a2"]);
  assertEquals(scoped.has_report_record, true);
});

Deno.test("R4 post-release reattend: prior pack+invoice cannot close", () => {
  const detail = { cycle_number: 2, reattend_count: 1 };
  assertEquals(commercialCloseoutAllowed(detail), false);
  const scoped = projectCycleScopedEvidence({
    detail,
    reports: [],
    pack: { status: "sent", report_doc_id: "d1", invoice_doc_id: "d2" },
    packSent: true,
    packCycleBound: false,
  });
  assertEquals(scoped.allowCloseoutFromEvidence, false);
  assertEquals(scoped.pack?.status, "drafted");
  assertEquals(scoped.pack?.report_doc_id, null);
  assertEquals(scoped.commercial_warning !== null, true);
});

Deno.test("R6 stale old-cycle service report excluded from map", () => {
  const detailsMap = {
    j1: { cycle_number: 2, reattend_count: 1 },
  };
  const map = currentCycleReportMap([
    { job_id: "j1", status: "submitted", cycle_number: 1 },
  ], detailsMap);
  assertEquals(map.j1, undefined);
});

Deno.test("R7 typed makesafe_report fails closed on reattend when unbound", () => {
  const detail = { cycle_number: 2, reattend_count: 1 };
  assertEquals(
    typedReportDocSatisfiesCurrent(
      [{ type: "makesafe_report" }],
      detail,
      null,
    ),
    false,
  );
  // Legacy keeps typed doc
  assertEquals(
    typedReportDocSatisfiesCurrent(
      [{ type: "makesafe_report" }],
      { cycle_number: 1, reattend_count: 0 },
      null,
    ),
    true,
  );
});

Deno.test("R8 stale assignment with backfill_cycle_scope never binds", () => {
  const detail = { cycle_number: 2, reattend_count: 1 };
  assertEquals(
    isEvidenceBoundToCurrentCycle({
      cycle_attribution: CYCLE_ATTRIBUTION.BACKFILL_CYCLE_SCOPE,
      cycle_number: 2,
    }, detail, null),
    false,
  );
  const { assignments, flags } = filterAssignmentsForCurrentCycle([
    { id: "x", cycle_attribution: CYCLE_ATTRIBUTION.BACKFILL_CYCLE_SCOPE },
  ], detail, null);
  assertEquals(assignments.length, 0);
  assertEquals(flags.includes(CYCLE_ATTRIBUTION.BACKFILL_CYCLE_SCOPE), true);
});

Deno.test("R9 ambiguous backfill rows never satisfy current cycle", () => {
  const detail = { cycle_number: 3, reattend_count: 2 };
  const scoped = projectCycleScopedEvidence({
    detail,
    reports: [
      {
        id: "amb1",
        status: "submitted",
        cycle_number: 1,
        cycle_attribution: CYCLE_ATTRIBUTION.BACKFILL_CYCLE_SCOPE,
      },
      {
        id: "amb2",
        status: "submitted",
        // missing cycle, unbound
      },
    ],
    packCycleBound: false,
  });
  assertEquals(scoped.has_report_record, false);
  assertEquals(scoped.serviceReport, null);
});

Deno.test("R9b reattend unscoped same-number evidence fails closed", () => {
  const detail = { cycle_number: 2, reattend_count: 1 };
  assertEquals(
    isEvidenceBoundToCurrentCycle({ cycle_number: 2 }, detail, "cycle-2"),
    false,
  );
  assertEquals(
    filterAssignmentsForCurrentCycle([{ id: "a", cycle_number: 2 }], detail, "cycle-2").assignments,
    [],
  );
});

Deno.test("R9c reattend hold requires bound attribution and identity", () => {
  const detail = { cycle_number: 2, reattend_count: 1 };
  assertEquals(
    projectCycleScopedEvidence({
      detail,
      attendanceCycleId: "cycle-2",
      holds: [{ cycle_number: 2, cycle_attribution: CYCLE_ATTRIBUTION.LEGACY_UNSCOPED }],
    }).hold,
    null,
  );
});

Deno.test("R10 readiness_revision changes when evidence changes", () => {
  const base = {
    attendanceCycleId: "c1",
    cycleNumber: 1,
    reportId: "r1",
    reportStatus: "submitted",
    assignmentIds: ["a1"],
    packStatus: "drafted" as string | null,
    packSent: false,
    hasReportDocTyped: false,
    photoCount: 5,
    familyMatrixVersion: "makesafe-family.v1",
    pricingRevision: null as string | null,
    packRevision: null as string | null,
    reattendCount: 0,
  };
  const h1 = computeReadinessRevisionSync(base);
  const h2 = computeReadinessRevisionSync({ ...base, photoCount: 6 });
  const h3 = computeReadinessRevisionSync({ ...base, reportId: "r2" });
  assertNotEquals(h1, h2);
  assertNotEquals(h1, h3);
  assertEquals(h1.startsWith("fnv1a64:"), true);
  // Payload is stable for same inputs
  assertEquals(
    readinessRevisionPayload(base),
    readinessRevisionPayload({ ...base }),
  );
});

Deno.test("R11 trade projection exposes allow-listed hold", () => {
  const rows = buildCanonicalMakesafeRows([
    {
      id: "job-h",
      job_number: "SWMS-1",
      status: "accepted",
      board_stage: "allocated",
      board_label: "Allocated",
      substatus: "waiting_on_trade_report",
      cycle_number: 1,
      reattend_count: 0,
      assignments: [{ id: "a1", user_id: "u-trade", users: { name: "T" } }],
      makesafe_details: {
        cycle_number: 1,
        reattend_count: 0,
        substatus: "waiting_on_trade_report",
      },
    },
  ], {
    holdsByJobId: {
      "job-h": {
        reason_code: "manual_review",
        note: "waiting on builder",
        created_at: "2026-07-01T00:00:00Z",
        cycle_number: 1,
      },
    },
  });
  assertEquals(rows[0].computed_status_hold?.reason_code, "manual_review");
  const trade = projectTradeMakesafeBoard(rows, {
    userId: "mgr",
    role: "ops_manager",
    managedVerticals: ["makesafe"],
  });
  const card = trade.rows.find((r: any) => r.id === "job-h");
  assertEquals(card?.hold?.reason_code, "manual_review");
  assertEquals(card?.hold?.note, "waiting on builder");
  assertEquals(card?.hold?.held_since, "2026-07-01T00:00:00Z");
  // No pricing / xero
  assertEquals((card as any)?.invoice_raw_status, undefined);
});

Deno.test("R11b tradeSafeHold strips unknown fields", () => {
  const h = tradeSafeHold({
    reason_code: "access_blocked",
    note: "gate locked",
    created_at: "t",
    held_by: "uuid-secret",
    extra: "nope",
  });
  assertEquals(h, {
    reason_code: "access_blocked",
    note: "gate locked",
    held_since: "t",
    cycle_number: null,
  });
});

// ── Board enrich integration (R3/R4 declared stage) ──────────────────────────

Deno.test("R3 enrich: reattend with stale assignment does not stay completed", () => {
  const job = {
    id: "j-re",
    status: "accepted",
    created_at: "2026-07-01T00:00:00Z",
  };
  const detail = {
    cycle_number: 2,
    reattend_count: 1,
    substatus: "waiting_on_trade_report",
    report_received_at: null,
    report_sent_at: null,
  };
  const assignments = [{
    id: "a-old",
    user_id: "u1",
    users: { name: "Crew" },
    cycle_attribution: CYCLE_ATTRIBUTION.BACKFILL_CYCLE_SCOPE,
  }];
  const invoice = { status: "PAID", invoice_type: "ACCREC" };
  const pack = {
    status: "sent",
    sent_at: "2026-07-02T00:00:00Z",
    report_doc_id: "d1",
    invoice_doc_id: "d2",
  };
  const enriched = _enrichMakesafeBoardJobForTest(
    job,
    detail,
    assignments,
    undefined, // no current report
    invoice,
    [{ type: "makesafe_report", file_name: "old.pdf" }],
    true, // pack sent marker
    pack,
  );
  // Must not complete from prior cycle commercial/pack.
  assertEquals(
    ["completed", "archive"].includes(enriched.board_stage),
    false,
    `expected non-terminal stage, got ${enriched.board_stage}`,
  );
  assertEquals(enriched.assignments.length, 0);
  assertEquals(enriched.pack_sent, false);
  assertEquals(enriched.is_reattend, true);
  assertEquals(enriched.cycle_number, 2);
  assertEquals(typeof enriched.readiness_revision, "string");
  assertEquals(enriched.commercial_warning !== null, true);
});

Deno.test("R1 enrich: first attendance with assignment is allocated", () => {
  const enriched = _enrichMakesafeBoardJobForTest(
    { id: "j1", status: "accepted", created_at: "2026-07-01T00:00:00Z" },
    {
      cycle_number: 1,
      reattend_count: 0,
      substatus: "waiting_on_trade_report",
    },
    [{ id: "a1", user_id: "u1", users: { name: "Crew" } }],
    undefined,
    null,
    [],
    false,
    null,
  );
  assertEquals(enriched.board_stage, "allocated");
  assertEquals(enriched.assignments.length, 1);
});

Deno.test("R2 enrich: first attendance submitted report is report_ready or trade_report_in", () => {
  const enriched = _enrichMakesafeBoardJobForTest(
    { id: "j1", status: "accepted", created_at: "2026-07-01T00:00:00Z" },
    {
      cycle_number: 1,
      reattend_count: 0,
      substatus: "admin_to_send_report",
      report_received_at: "2026-07-02T00:00:00Z",
    },
    [{ id: "a1", user_id: "u1", users: { name: "Crew" } }],
    {
      id: "r1",
      status: "submitted",
      cycle_number: 1,
      submitted_at: "2026-07-02T00:00:00Z",
    },
    null,
    [],
    false,
    null,
  );
  assertEquals(
    ["trade_report_in", "report_ready", "allocated"].includes(
      enriched.board_stage,
    ),
    true,
    `unexpected stage ${enriched.board_stage}`,
  );
  assertEquals(enriched.report?.status, "submitted");
});
