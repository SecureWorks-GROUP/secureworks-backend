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
function makeClient(seed: TableRows, fail: Record<string, string> = {}) {
  const rows: TableRows = {};
  for (const [table, tableRows] of Object.entries(seed)) {
    rows[table] = tableRows.map((r) => ({ ...r }));
  }
  const nextId = (table: string) => `${table}-${(rows[table] || []).length + 1}`;

  function builder(table: string) {
    if (!rows[table]) rows[table] = [];
    const preds: Array<(r: any) => boolean> = [];
    let insertRow: any = null;
    let updateRow: any = null;
    let maxRows: number | null = null;

    const matchingRows = () => {
      const matched = rows[table].filter((r) => preds.every((p) => p(r)));
      return maxRows === null ? matched : matched.slice(0, maxRows);
    };
    const failKey = (op: string) => `${table}.${op}`;
    const failure = (op: string) =>
      fail[failKey(op)]
        ? { data: null, error: { message: fail[failKey(op)] } }
        : null;
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
    const terminal = (single = false) => {
      if (insertRow) return applyInsert();
      if (updateRow) return applyUpdate();
      const data = matchingRows();
      return { data: single ? data[0] || null : data, error: null };
    };

    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => {
        preds.push((r) => r?.[col] === val);
        return b;
      },
      neq: (col: string, val: any) => {
        preds.push((r) => r?.[col] !== val);
        return b;
      },
      not: () => b,
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
      update: (row: any) => {
        updateRow = row;
        return b;
      },
      maybeSingle: async () => terminal(true),
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
    }],
    job_service_reports: [{
      id: "report-1",
      job_id: "job-1",
      cycle_number: 1,
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
    body: { job_id: "job-1", reason: "temp fence blew down again", ...overrides },
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
  assertEquals(detail.report_received_at, null, "report_received_at is cleared for the new visit");
  assertEquals(detail.cycle_number, 2);
  assertEquals(detail.reattend_count, 1);
  assertEquals(detail.last_reattend_reason, "temp fence blew down again");
  assert(detail.last_reattend_at, "last_reattend_at is stamped");

  // Report #1 is retained, untouched.
  assertEquals(rows.job_service_reports.length, 1);
  assertEquals(rows.job_service_reports[0].id, "report-1");
  assertEquals(rows.job_service_reports[0].status, "submitted");

  // Audit event written.
  const evt = rows.job_events.find((e: any) => e.event_type === "makesafe_reattend");
  assert(evt, "a makesafe_reattend event is recorded");
  assertEquals(evt.detail_json.reattend_count, 1);

  // Board: the card is now in Allocated (not report_ready / trade_report_in).
  const pipeline: any = await _makesafePipelineForTest(client, new URLSearchParams());
  const inAllocated = pipeline.columns.allocated.find((j: any) => j.id === "job-1");
  assert(inAllocated, "re-attended card sits in Allocated awaiting the visit");
  assertEquals(inAllocated.reattend_count, 1);
  assertEquals(inAllocated.is_reattend, true);
  assert(!pipeline.columns.report_ready.find((j: any) => j.id === "job-1"), "not in report_ready");
  assert(!pipeline.columns.trade_report_in.find((j: any) => j.id === "job-1"), "not in trade_report_in");
});

// ── 2. Second report is ADDITIVE and returns the card to Trade Report In ──────

Deno.test("second report after re-attend is additive (both reports kept) and card returns to Trade Report In", async () => {
  const { client, rows } = makeClient(reportedRows());

  await _reattendMakesafeForTest(client, reattendArgs());
  const submitRes: any = await _submitMakesafeReportForTest(client, secondReportBody());

  assertEquals(submitRes.ok, true);
  assertEquals(submitRes.board_sync.ok, true);

  // TWO reports now: cycle 1 (untouched) + cycle 2 (new). Report #1 never overwritten.
  assertEquals(rows.job_service_reports.length, 2);
  const r1 = rows.job_service_reports.find((r: any) => r.id === "report-1");
  const r2 = rows.job_service_reports.find((r: any) => r.id !== "report-1");
  assertEquals(r1.cycle_number, 1);
  assertEquals(r1.checklist_json.work_done, "First visit: temp fence stood up.");
  assertEquals(r2.cycle_number, 2);
  assertEquals(r2.checklist_json.work_done, "Second visit: re-secured the temp fence.");

  // Detail flips back to report-in, keeping the re-attend marker.
  const detail = rows.makesafe_job_details[0];
  assertEquals(detail.substatus, "admin_to_send_report");
  assertEquals(detail.reattend_count, 1);

  // Board: back in Trade Report In, still flagged as a re-attend.
  const pipeline: any = await _makesafePipelineForTest(client, new URLSearchParams());
  const inTradeReportIn = pipeline.columns.trade_report_in.find((j: any) => j.id === "job-1");
  assert(inTradeReportIn, "re-attend's second report lands back in Trade Report In");
  assertEquals(inTradeReportIn.reattend_count, 1);
  assertEquals(inTradeReportIn.is_reattend, true);
});

// ── 3. submit_makesafe_report does NOT block the re-attend's second submit ─────

Deno.test("second submit after re-attend is not blocked as a duplicate", async () => {
  const { client } = makeClient(reportedRows());
  await _reattendMakesafeForTest(client, reattendArgs());
  // Must not throw "Report already submitted" — the cycle-2 lookup finds nothing.
  const res: any = await _submitMakesafeReportForTest(client, secondReportBody());
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

Deno.test("reattend_makesafe refuses a job that already has a live invoice (out of v1 scope)", async () => {
  const { client } = makeClient(reportedRows({
    xero_invoices: [{
      job_id: "job-1",
      invoice_type: "ACCREC",
      status: "AUTHORISED",
      invoice_number: "INV-100",
    }],
  }));
  await assertRejects(
    () => _reattendMakesafeForTest(client, reattendArgs()),
    Error,
    "priced per case",
  );
});

Deno.test("reattend_makesafe refuses a caller who manages neither the vertical nor is a dispatcher", async () => {
  const { client } = makeClient(reportedRows());
  await assertRejects(
    () =>
      _reattendMakesafeForTest(client, {
        body: { job_id: "job-1", reason: "again" },
        callerRole: "lead_installer",
        managedVerticals: [],
      }),
    Error,
    "Not authorized",
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

  const res: any = await _submitMakesafeReportForTest(client, secondReportBody());
  assertEquals(res.ok, true);
  assertEquals(rows.job_service_reports.length, 1);
  assertEquals(rows.job_service_reports[0].cycle_number, 1);

  const pipeline: any = await _makesafePipelineForTest(client, new URLSearchParams());
  const card = pipeline.columns.trade_report_in.find((j: any) => j.id === "job-1");
  assert(card, "a normal first report lands in Trade Report In");
  assertEquals(card.reattend_count, 0);
  assertEquals(card.is_reattend, false);
});
