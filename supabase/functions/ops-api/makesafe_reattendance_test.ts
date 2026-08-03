// deno-lint-ignore-file no-import-prefix no-explicit-any require-await

// ════════════════════════════════════════════════════════════
// MAKE-SAFE RE-ATTENDANCE TESTS (M-C)
//
// A builder asks a crew to re-attend the SAME make-safe (temp fence blows down
// again) with no new work order. A manager puts the already-reported card back
// into `allocated` as a re-attend visit; the crew submits ANOTHER report; BOTH
// reports are retained; the card returns to trade-reports-in carrying a visible
// visit marker. These tests cover the new transition, the additive (cycle-scoped)
// report storage, and prove the single-report flow is unchanged.
//
// RUN:
//   ~/.deno/bin/deno test --no-check --allow-env --allow-net=127.0.0.1 \
//     supabase/functions/ops-api/makesafe_reattendance_test.ts
// ════════════════════════════════════════════════════════════

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _makesafePipelineForTest,
  _reattendMakesafeForTest,
  _submitMakesafeReportForTest,
} from "./index.ts";

type TableRows = Record<string, any[]>;

// In-memory Supabase-client stand-in (same shape as makesafe_submit_report_test).
// Supports the select/eq/neq/not/in/order/limit/range/insert/update/single/then
// surface the make-safe handlers use. order() is a no-op — cycle logic must not
// depend on query ordering.
function makeClient(
  seed: TableRows,
  fail: Record<string, string | { message: string; code?: string }> = {},
  options: { hideFirstCycleReportRead?: boolean } = {},
) {
  const rows: TableRows = {};
  let hidFirstCycleReportRead = false;
  for (const [table, tableRows] of Object.entries(seed)) {
    rows[table] = tableRows.map((r) => ({ ...r }));
  }
  const nextId = (table: string) =>
    `${table}-${(rows[table] || []).length + 1}`;

  function builder(table: string) {
    if (!rows[table]) rows[table] = [];
    const preds: Array<(r: any) => boolean> = [];
    const filterColumns = new Set<string>();
    let insertRow: any = null;
    let upsertRow: any = null;
    let updateRow: any = null;
    let maxRows: number | null = null;

    const matchingRows = () => {
      const matched = rows[table].filter((r) => preds.every((p) => p(r)));
      return maxRows === null ? matched : matched.slice(0, maxRows);
    };
    const failKey = (op: string) => `${table}.${op}`;
    const failure = (op: string) => {
      const configured = fail[failKey(op)];
      if (!configured) return null;
      const error = typeof configured === "string"
        ? { message: configured }
        : configured;
      return { data: null, error };
    };
    const applyInsert = () => {
      const failed = failure("insert");
      if (failed) return failed;
      const row = { id: insertRow.id || nextId(table), ...insertRow };
      rows[table].push(row);
      return { data: row, error: null };
    };
    const applyUpdate = () => {
      const failed = failure("update");
      if (failed) return failed;
      const matched = matchingRows();
      for (const row of matched) Object.assign(row, updateRow);
      return { data: matched[0] || null, error: null };
    };
    const applyUpsert = () => {
      const failed = failure("upsert");
      if (failed) return failed;
      const existing = rows[table].find((row) =>
        row.job_id === upsertRow.job_id &&
        row.cycle_number === upsertRow.cycle_number
      );
      if (existing) {
        Object.assign(existing, upsertRow);
        return { data: existing, error: null };
      }
      const row = { id: upsertRow.id || nextId(table), ...upsertRow };
      rows[table].push(row);
      return { data: row, error: null };
    };
    const terminal = (single = false) => {
      if (insertRow) return applyInsert();
      if (upsertRow) return applyUpsert();
      if (updateRow) return applyUpdate();
      const data = matchingRows();
      return { data: single ? data[0] || null : data, error: null };
    };

    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => {
        filterColumns.add(col);
        preds.push((r) => r?.[col] === val);
        return b;
      },
      neq: (col: string, val: any) => {
        preds.push((r) => r?.[col] !== val);
        return b;
      },
      is: (col: string, val: any) => {
        preds.push((r) => val === null ? r?.[col] == null : r?.[col] === val);
        return b;
      },
      not: () => b,
      gte: () => b,
      or: () => b,
      in: (col: string, vals: any[]) => {
        preds.push((r) => vals.includes(r?.[col]));
        return b;
      },
      order: () => b,
      limit: (n: number) => {
        maxRows = n;
        return b;
      },
      range: async (from: number, to: number) => ({
        data: matchingRows().slice(from, to + 1),
        error: null,
      }),
      insert: (row: any) => {
        insertRow = row;
        return b;
      },
      upsert: (row: any) => {
        upsertRow = row;
        return b;
      },
      update: (row: any) => {
        updateRow = row;
        return b;
      },
      maybeSingle: async () => {
        if (
          options.hideFirstCycleReportRead &&
          !hidFirstCycleReportRead &&
          table === "job_service_reports" &&
          filterColumns.has("cycle_number")
        ) {
          hidFirstCycleReportRead = true;
          return { data: null, error: null };
        }
        return terminal(true);
      },
      single: async () => terminal(true),
      then: (resolve: (v: any) => any) => resolve(terminal()),
    };
    return b;
  }

  return { client: { from: (table: string) => builder(table) }, rows };
}

// A make-safe job that has already been reported once (sitting in Trade Report In).
function reportedRows(overrides: TableRows = {}): TableRows {
  return {
    jobs: [{
      id: "job-1",
      job_number: "SWMS-26001",
      type: "makesafe",
      status: "scheduled",
      client_name: "Test Builder",
      site_address: "1 Test St",
      site_suburb: "Perth",
      metadata: {},
      created_at: "2026-07-01T01:00:00Z",
      updated_at: "2026-07-01T01:00:00Z",
    }],
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "admin_to_send_report",
      report_received_at: "2026-07-02T02:00:00Z",
      report_sent_at: null,
      cycle_number: 1,
      reattend_count: 0,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    }],
    makesafe_attendance_cycles: [{
      id: "cycle-1",
      job_id: "job-1",
      cycle_number: 1,
      open_reason: "first_attendance",
    }],
    job_service_reports: [{
      id: "report-1",
      job_id: "job-1",
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
      status: "submitted",
      submitted_at: "2026-07-02T02:00:00Z",
      checklist_json: { work_done: "First visit: temp fence stood up." },
    }],
    // 5 completion photos so a second submit passes the photo gate.
    job_media: Array.from({ length: 5 }, (_, i) => ({
      id: `media-${i + 1}`,
      job_id: "job-1",
      type: "photo",
      phase: "completion",
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    })),
    job_assignments: [{
      id: "assign-1",
      job_id: "job-1",
      user_id: "trade-1",
      scheduled_date: "2026-07-02",
      status: "scheduled",
    }],
    job_events: [],
    xero_invoices: [],
    job_documents: [],
    makesafe_report_packs: [],
    ...overrides,
  };
}

function reattendArgs(overrides: Record<string, any> = {}) {
  return {
    body: {
      job_id: "job-1",
      reason: "temp fence blew down again",
      ...overrides,
    },
    callerRole: "ops_manager",
    managedVerticals: [],
  };
}

function secondReportBody(overrides: Record<string, any> = {}) {
  return {
    job_id: "job-1",
    userId: "trade-1",
    arrival_time: "2026-07-08T08:30:00+08:00",
    damage_description: "Fence blew down again.",
    damage_cause: "Storm",
    job_type: "Fence make safe",
    work_done: "Second visit: re-secured the temp fence.",
    materials_used: ["star pickets"],
    labour_hours: 1.5,
    trade_count: 1,
    status: "submitted",
    ...overrides,
  };
}

function addCurrentCyclePhotos(rows: TableRows, attendanceCycleId: string) {
  for (let i = 0; i < 5; i++) {
    rows.job_media.push({
      id: `media-cycle-2-${i + 1}`,
      job_id: "job-1",
      type: "photo",
      phase: "completion",
      attendance_cycle_id: attendanceCycleId,
      cycle_attribution: "bound",
    });
  }
}

// ── 1. Re-attend transition: reported card → allocated re-attend visit ─────────

Deno.test("reattend_makesafe puts a reported card back to allocated as visit #1", async () => {
  const { client, rows } = makeClient(reportedRows());

  const res: any = await _reattendMakesafeForTest(client, reattendArgs());

  assertEquals(res.ok, true);
  assertEquals(res.reattended, true);
  assertEquals(res.reattend_count, 1);
  assertEquals(res.cycle_number, 2);
  assertEquals(res.substatus, "waiting_on_trade_report");

  const detail = rows.makesafe_job_details[0];
  assertEquals(detail.substatus, "waiting_on_trade_report");
  assertEquals(
    detail.report_received_at,
    null,
    "report_received_at is cleared for the new visit",
  );
  assertEquals(detail.cycle_number, 2);
  assertEquals(detail.reattend_count, 1);
  assertEquals(detail.last_reattend_reason, "temp fence blew down again");
  assert(detail.last_reattend_at, "last_reattend_at is stamped");

  // Report #1 is retained, untouched.
  assertEquals(rows.job_service_reports.length, 1);
  assertEquals(rows.job_service_reports[0].id, "report-1");
  assertEquals(rows.job_service_reports[0].status, "submitted");

  // Audit event written.
  const evt = rows.job_events.find((e: any) =>
    e.event_type === "makesafe_reattend"
  );
  assert(evt, "a makesafe_reattend event is recorded");
  assertEquals(evt.detail_json.reattend_count, 1);

  // Board: the card is now in Allocated (not report_ready / trade_report_in).
  const pipeline: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams(),
  );
  const inAllocated = pipeline.columns.allocated.find((j: any) =>
    j.id === "job-1"
  );
  assert(inAllocated, "re-attended card sits in Allocated awaiting the visit");
  assertEquals(inAllocated.reattend_count, 1);
  assertEquals(inAllocated.is_reattend, true);
  assert(
    !pipeline.columns.report_ready.find((j: any) => j.id === "job-1"),
    "not in report_ready",
  );
  assert(
    !pipeline.columns.trade_report_in.find((j: any) => j.id === "job-1"),
    "not in trade_report_in",
  );
});

// ── 2. Second report is ADDITIVE and returns the card to Trade Report In ──────

Deno.test("second report after re-attend is additive (both reports kept) and card returns to Trade Report In", async () => {
  const { client, rows } = makeClient(reportedRows());
  const originalFirstReport = structuredClone(rows.job_service_reports[0]);

  const reattend: any = await _reattendMakesafeForTest(
    client,
    reattendArgs(),
  );
  addCurrentCyclePhotos(rows, reattend.attendance_cycle_id);
  const submitRes: any = await _submitMakesafeReportForTest(
    client,
    secondReportBody(),
  );

  assertEquals(submitRes.ok, true);
  assertEquals(submitRes.board_sync.ok, true);

  // TWO reports now: cycle 1 (untouched) + cycle 2 (new). Report #1 never overwritten.
  assertEquals(rows.job_service_reports.length, 2);
  const r1 = rows.job_service_reports.find((r: any) => r.id === "report-1");
  const r2 = rows.job_service_reports.find((r: any) => r.id !== "report-1");
  assertEquals(r1, originalFirstReport);
  assertEquals(r1.cycle_number, 1);
  assertEquals(
    r1.checklist_json.work_done,
    "First visit: temp fence stood up.",
  );
  assertEquals(r2.cycle_number, 2);
  assertEquals(r1.attendance_cycle_id, "cycle-1");
  assertEquals(r2.attendance_cycle_id, reattend.attendance_cycle_id);
  assertEquals(r1.cycle_attribution, "bound");
  assertEquals(r2.cycle_attribution, "bound");
  assert(r1.submitted_at, "visit one keeps its own submitted time");
  assert(r2.submitted_at, "visit two gets its own submitted time");
  assertEquals(
    r2.checklist_json.work_done,
    "Second visit: re-secured the temp fence.",
  );
  const photosByCycle = new Map<string, number>();
  for (const media of rows.job_media) {
    if (media.type !== "photo" || !media.attendance_cycle_id) continue;
    photosByCycle.set(
      media.attendance_cycle_id,
      (photosByCycle.get(media.attendance_cycle_id) || 0) + 1,
    );
  }
  assertEquals(photosByCycle.get("cycle-1"), 5);
  assertEquals(photosByCycle.get(reattend.attendance_cycle_id), 5);

  // The prior unbound visit assignment cannot suppress the authoritative
  // current-cycle submitter binding created by the final report.
  assertEquals(rows.job_assignments.length, 2);
  const currentCycleAssignment = rows.job_assignments.find((a: any) =>
    a.attendance_cycle_id === reattend.attendance_cycle_id
  );
  assert(currentCycleAssignment, "visit two has a current-cycle assignment");
  assertEquals(currentCycleAssignment.user_id, "trade-1");
  assertEquals(currentCycleAssignment.cycle_attribution, "bound");
  assertEquals(currentCycleAssignment.status, "complete");

  // Detail flips back to report-in, keeping the re-attend marker.
  const detail = rows.makesafe_job_details[0];
  assertEquals(detail.substatus, "admin_to_send_report");
  assertEquals(detail.reattend_count, 1);

  // Board: back in Trade Report In, still flagged as a re-attend.
  const pipeline: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams(),
  );
  const inTradeReportIn = pipeline.columns.trade_report_in.find((j: any) =>
    j.id === "job-1"
  );
  assert(
    inTradeReportIn,
    "re-attend's second report lands back in Trade Report In",
  );
  assertEquals(inTradeReportIn.reattend_count, 1);
  assertEquals(inTradeReportIn.is_reattend, true);

  // One job with two reports is still exactly one board card and one active job.
  const cards = Object.values(pipeline.columns).flat().filter((card: any) =>
    card.id === "job-1"
  );
  assertEquals(cards.length, 1);
  assertEquals(pipeline.total, 1);
});

Deno.test("retrying the second report cannot create a third report", async () => {
  const { client, rows } = makeClient(reportedRows());
  const reattend: any = await _reattendMakesafeForTest(
    client,
    reattendArgs(),
  );
  addCurrentCyclePhotos(rows, reattend.attendance_cycle_id);

  await _submitMakesafeReportForTest(client, secondReportBody());
  const reportIds = rows.job_service_reports.map((report: any) => report.id)
    .sort();

  await assertRejects(
    () => _submitMakesafeReportForTest(client, secondReportBody()),
    Error,
    "Report already submitted",
  );
  assertEquals(rows.job_service_reports.length, 2);
  assertEquals(
    rows.job_service_reports.map((report: any) => report.id).sort(),
    reportIds,
  );
});

Deno.test("a concurrent cycle conflict reuses the existing report", async () => {
  const { client, rows } = makeClient(
    reportedRows({
      makesafe_job_details: [{
        job_id: "job-1",
        substatus: "waiting_on_trade_report",
        report_received_at: null,
        cycle_number: 2,
        reattend_count: 1,
        attendance_cycle_id: "cycle-2",
        cycle_attribution: "bound",
      }],
      makesafe_attendance_cycles: [{
        id: "cycle-2",
        job_id: "job-1",
        cycle_number: 2,
        open_reason: "reattend_makesafe",
      }],
      job_service_reports: [
        reportedRows().job_service_reports[0],
        {
          id: "report-2",
          job_id: "job-1",
          cycle_number: 2,
          attendance_cycle_id: "cycle-2",
          cycle_attribution: "bound",
          status: "submitted",
          submitted_by: "trade-1",
          submitted_at: "2026-07-28T02:00:00Z",
        },
      ],
      job_media: Array.from({ length: 5 }, (_, i) => ({
        id: `media-cycle-2-${i + 1}`,
        job_id: "job-1",
        type: "photo",
        phase: "completion",
        attendance_cycle_id: "cycle-2",
        cycle_attribution: "bound",
      })),
    }),
    {
      "job_service_reports.insert": { message: "duplicate key", code: "23505" },
    },
    { hideFirstCycleReportRead: true },
  );

  const res: any = await _submitMakesafeReportForTest(
    client,
    secondReportBody(),
  );

  assertEquals(res.ok, true);
  assertEquals(rows.job_service_reports.length, 2);
  assertEquals(
    rows.job_service_reports.filter((r: any) =>
      r.attendance_cycle_id === "cycle-2"
    ).length,
    1,
  );
});

// ── 3. submit_makesafe_report does NOT block the re-attend's second submit ─────

Deno.test("second submit after re-attend is not blocked as a duplicate", async () => {
  const { client, rows } = makeClient(reportedRows());
  const reattend: any = await _reattendMakesafeForTest(
    client,
    reattendArgs(),
  );
  addCurrentCyclePhotos(rows, reattend.attendance_cycle_id);
  // Must not throw "Report already submitted" — the cycle-2 lookup finds nothing.
  const res: any = await _submitMakesafeReportForTest(
    client,
    secondReportBody(),
  );
  assertEquals(res.ok, true);
});

// ── 4. Eligibility guards ─────────────────────────────────────────────────────

Deno.test("reattend_makesafe requires a reason", async () => {
  const { client } = makeClient(reportedRows());
  await assertRejects(
    () => _reattendMakesafeForTest(client, reattendArgs({ reason: "  " })),
    Error,
    "reason required",
  );
});

Deno.test("reattend_makesafe refuses a cancelled make-safe", async () => {
  const { client } = makeClient(reportedRows({
    jobs: [{ id: "job-1", type: "makesafe", status: "cancelled" }],
  }));
  await assertRejects(
    () => _reattendMakesafeForTest(client, reattendArgs()),
    Error,
    "cannot re-attend a cancelled",
  );
});

Deno.test("reattend_makesafe refuses a job with no submitted report", async () => {
  const { client } = makeClient(reportedRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      reattend_count: 0,
    }],
    job_service_reports: [],
    jobs: [{ id: "job-1", type: "makesafe", status: "scheduled" }],
  }));
  await assertRejects(
    () => _reattendMakesafeForTest(client, reattendArgs()),
    Error,
    "no submitted report to re-attend",
  );
});

Deno.test("reattend_makesafe PROCEEDS on a job with a live invoice and flags bill-manually (billing decoupled)", async () => {
  const { client, rows } = makeClient(reportedRows({
    xero_invoices: [{
      job_id: "job-1",
      invoice_type: "ACCREC",
      status: "AUTHORISED",
      invoice_number: "INV-100",
    }],
  }));

  // No longer a 412 — the re-attend is captured, with a non-fatal manual-bill flag.
  const res: any = await _reattendMakesafeForTest(client, reattendArgs());
  assertEquals(res.ok, true);
  assertEquals(res.reattended, true);
  assertEquals(res.reattend_count, 1);
  assertEquals(res.cycle_number, 2);
  assertEquals(
    res.bill_reattend_manually,
    true,
    "admin-visible flag: bill this re-attend manually",
  );
  assertEquals(res.billing_review_required, true);
  assertEquals(res.billing_review_event.ok, true);
  assert(res.warning, "a non-fatal warning is surfaced");
  assert(
    String(res.warning).includes("live invoice"),
    "warning explains the job already has a live invoice",
  );

  // Field-work capture happened: detail advanced to the new visit.
  const detail = rows.makesafe_job_details[0];
  assertEquals(detail.substatus, "waiting_on_trade_report");
  assertEquals(detail.cycle_number, 2);
  assertEquals(detail.reattend_count, 1);

  // No invoice state was touched — the row is exactly as seeded.
  assertEquals(rows.xero_invoices.length, 1);
  assertEquals(rows.xero_invoices[0].status, "AUTHORISED");
  assertEquals(rows.xero_invoices[0].invoice_number, "INV-100");

  // The flag is also stamped on the audit event for the admin card.
  const evt = rows.job_events.find((e: any) =>
    e.event_type === "makesafe_reattend"
  );
  assert(evt, "a makesafe_reattend event is recorded");
  assertEquals(evt.detail_json.bill_reattend_manually, true);
  const review = rows.job_events.find((e: any) =>
    e.event_type === "makesafe_reattend_billing_review_required"
  );
  assert(review, "a durable billing-review fact is recorded");
  assertEquals(review.detail_json.attendance_cycle_id, res.attendance_cycle_id);
  assertEquals(review.detail_json.prior_invoice_summary, [{
    xero_id: null,
    status: "AUTHORISED",
    number: "INV-100",
    amount: null,
  }]);
  assertEquals(review.detail_json.disposition, null);
});

Deno.test("reattend_makesafe on a job with only a VOIDED invoice does not flag bill-manually", async () => {
  const { client } = makeClient(reportedRows({
    xero_invoices: [{
      job_id: "job-1",
      invoice_type: "ACCREC",
      status: "VOIDED",
      invoice_number: "INV-099",
    }],
  }));

  const res: any = await _reattendMakesafeForTest(client, reattendArgs());
  assertEquals(res.ok, true);
  assertEquals(res.bill_reattend_manually, false);
  assertEquals(res.billing_review_required, false);
  assertEquals(
    res.warning,
    undefined,
    "no warning when there is no live invoice",
  );
});

Deno.test("reattend_makesafe flags review when a prior pack was sent without a live invoice", async () => {
  const { client, rows } = makeClient(reportedRows({
    makesafe_report_packs: [{
      id: "pack-1",
      job_id: "job-1",
      pack_kind: "main",
      status: "sent",
      sent_at: "2026-07-03T04:00:00Z",
    }],
  }));

  const res: any = await _reattendMakesafeForTest(client, reattendArgs());
  assertEquals(res.ok, true);
  assertEquals(res.bill_reattend_manually, false);
  assertEquals(res.prior_pack_sent, true);
  assertEquals(res.billing_review_required, true);
  assert(String(res.warning).includes("prior report pack"));
  const review = rows.job_events.find((e: any) =>
    e.event_type === "makesafe_reattend_billing_review_required"
  );
  assert(review);
  assertEquals(review.detail_json.review_reason, "prior_pack_sent");
  assertEquals(review.detail_json.disposition, null);
});

Deno.test("reattend current-cycle photo gate rejects five stale photos", async () => {
  const { client, rows } = makeClient(reportedRows());
  await _reattendMakesafeForTest(client, reattendArgs());

  await assertRejects(
    () => _submitMakesafeReportForTest(client, secondReportBody()),
    Error,
    "at least 5 current-visit photos (found 0)",
  );
  assertEquals(rows.job_service_reports.length, 1);
});

Deno.test("an assigned trade may start their own reattendance", async () => {
  const { client, rows } = makeClient(reportedRows());
  const res: any = await _reattendMakesafeForTest(client, {
    body: { job_id: "job-1", reason: "second visit needed" },
    callerUserId: "trade-1",
    callerRole: "installer",
    managedVerticals: [],
  });

  assertEquals(res.ok, true);
  assertEquals(res.authorization_relationship, "assigned_trade");
  assertEquals(res.cycle_number, 2);
  assertEquals(rows.job_events[0].user_id, "trade-1");
  assertEquals(
    rows.makesafe_job_details[0].last_reattend_reason,
    "second visit needed",
  );
});

Deno.test("reattend_makesafe refuses an unrelated signed-in user", async () => {
  const { client } = makeClient(reportedRows());
  await assertRejects(
    () =>
      _reattendMakesafeForTest(client, {
        body: { job_id: "job-1", reason: "again" },
        callerUserId: "unrelated-trade",
        callerRole: "lead_installer",
        managedVerticals: [],
      }),
    Error,
    "Not authorized",
  );
});

Deno.test("a cancelled assignment does not authorise reattendance", async () => {
  const seed = reportedRows();
  seed.job_assignments[0].status = "cancelled";
  const { client } = makeClient(seed);
  await assertRejects(
    () =>
      _reattendMakesafeForTest(client, {
        body: { job_id: "job-1", reason: "again" },
        callerUserId: "trade-1",
        callerRole: "installer",
        managedVerticals: [],
      }),
    Error,
    "Not authorized",
  );
});

Deno.test("declined, observer, ghost, and open-pool assignments do not authorise reattendance", async () => {
  for (
    const assignment of [
      { status: "declined" },
      { status: "scheduled", role: "observer" },
      { status: "scheduled", assignment_type: "ghost" },
      { status: "scheduled", assignment_type: "makesafe_open" },
    ]
  ) {
    const seed = reportedRows();
    seed.job_assignments = [{
      id: "assign-1",
      job_id: "job-1",
      user_id: "trade-1",
      ...assignment,
    }];
    const { client } = makeClient(seed);
    await assertRejects(
      () =>
        _reattendMakesafeForTest(client, {
          body: { job_id: "job-1", reason: "again" },
          callerUserId: "trade-1",
          callerRole: "installer",
          managedVerticals: [],
        }),
      Error,
      "Not authorized",
    );
  }
});

Deno.test("a reattendance retry replays the winning cycle without creating another transition", async () => {
  const { client, rows } = makeClient(reportedRows());
  const first: any = await _reattendMakesafeForTest(client, reattendArgs());
  const replay: any = await _reattendMakesafeForTest(
    client,
    reattendArgs({ reason: "a different reason" }),
  );

  assertEquals(first.cycle_number, 2);
  assertEquals(replay.idempotent_replay, true);
  assertEquals(replay.cycle_number, 2);
  assertEquals(replay.reason, "temp fence blew down again");
  assertEquals(rows.makesafe_job_details[0].cycle_number, 2);
  assertEquals(
    rows.job_events.filter((event: any) =>
      event.event_type === "makesafe_reattend"
    ).length,
    1,
  );
});

Deno.test("a make-safe vertical manager may re-attend", async () => {
  const { client } = makeClient(reportedRows());
  const res: any = await _reattendMakesafeForTest(client, {
    body: { job_id: "job-1", reason: "again" },
    callerRole: "lead_installer",
    managedVerticals: ["makesafe"],
  });
  assertEquals(res.ok, true);
});

// ── 5. A completed/closed card is reactivated on re-attend ────────────────────

Deno.test("reattend_makesafe reactivates a completed card (status -> accepted)", async () => {
  const { client, rows } = makeClient(reportedRows({
    jobs: [{
      id: "job-1",
      job_number: "SWMS-26001",
      type: "makesafe",
      status: "complete",
      completed_at: "2026-07-03T00:00:00Z",
      metadata: {},
      created_at: "2026-07-01T01:00:00Z",
    }],
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "complete",
      report_received_at: "2026-07-02T02:00:00Z",
      cycle_number: 1,
      reattend_count: 0,
    }],
  }));

  const res: any = await _reattendMakesafeForTest(client, reattendArgs());
  assertEquals(res.ok, true);
  assertEquals(res.previous_status, "complete");
  assertEquals(rows.jobs[0].status, "accepted");
  assertEquals(rows.jobs[0].completed_at, null);
  assertEquals(rows.makesafe_job_details[0].reattend_count, 1);
});

// ── 6. REGRESSION: the single-report flow is unchanged ────────────────────────

Deno.test("regression: a first-attendance report defaults to cycle 1 and is not a re-attend", async () => {
  const { client, rows } = makeClient(reportedRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      reattend_count: 0,
    }],
    job_service_reports: [],
  }));

  const res: any = await _submitMakesafeReportForTest(
    client,
    secondReportBody(),
  );
  assertEquals(res.ok, true);
  assertEquals(rows.job_service_reports.length, 1);
  assertEquals(rows.job_service_reports[0].cycle_number, 1);

  const pipeline: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams(),
  );
  const card = pipeline.columns.trade_report_in.find((j: any) =>
    j.id === "job-1"
  );
  assert(card, "a normal first report lands in Trade Report In");
  assertEquals(card.reattend_count, 0);
  assertEquals(card.is_reattend, false);
});
