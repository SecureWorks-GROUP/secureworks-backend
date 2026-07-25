// ════════════════════════════════════════════════════════════
// MAKE-SAFE CANCEL TESTS (M-F, Wave 1 + Wave 2 reopen-to-New)
//
// A builder recalls / reallocates / mistakes a work order; the make-safe manager
// (Hugo) or an admin retires the card. ONE jobs.status='cancelled' write drives
// both boards; reason/who/date live on makesafe_job_details. Reversible via
// reopen_makesafe. NEVER touches Xero.
//
// Covers (contract TESTS block):
//   * cancel authz allow (manager / api_key) vs deny (non-manager JWT)
//   * live-invoice block (DRAFT passes, AUTHORISED/SUBMITTED/PAID block)
//   * non-makesafe reject, empty-note reject, invalid reason_code reject
//   * audit row shape (job_events makesafe_cancelled)
//   * open-assignment close on cancel
//   * idempotent re-cancel (already cancelled -> clean no-op)
//   * board feed: a cancelled job lands in `cancelled` not `new`, 90-day window
//     respected, `total` not inflated
//   * story exemption: manual cancel (cancel_reason set) -> CANCELLED (not CONFLICT)
//   * reopen cancelled -> derived `new`, signals cleared, cycle_number NOT bumped,
//     manager-authed; complete/invoiced reopen stays admin/api-key only
//
// Technique: in-memory Supabase-client stand-in (same shape as
// makesafe_reattendance_test.ts) + the real exported handlers. No network.
//
// RUN:
//   ~/.deno/bin/deno test --no-check --allow-env --allow-net=127.0.0.1 \
//     supabase/functions/ops-api/makesafe_cancel_test.ts
// ════════════════════════════════════════════════════════════

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _cancelMakesafeForTest,
  _deriveMakesafeBoardStage,
  _enrichMakesafeBoardJobForTest,
  _makesafePipelineForTest,
  _reopenMakesafeForTest,
  myJobs,
} from "./index.ts";
import { computeStoryVerdict } from "./makesafe_story.ts";
import { projectTradeMakesafeBoard } from "./makesafe_board_read_model.ts";

type TableRows = Record<string, any[]>;

// In-memory Supabase-client stand-in. Extends the reattendance-test mock with a
// FAITHFUL `.not(col,'in',...)` (so the board's cancelled-exclusion actually
// filters) and `.gte()` (so the cancelled-feed window query works).
function makeClient(seed: TableRows, fail: Record<string, string> = {}) {
  const rows: TableRows = {};
  for (const [table, tableRows] of Object.entries(seed)) {
    rows[table] = tableRows.map((r) => ({ ...r }));
  }
  const nextId = (table: string) =>
    `${table}-${(rows[table] || []).length + 1}`;

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
      // Return an ARRAY-shaped data so closeOpenAssignmentsForJob's (data||[]).length works.
      return { data: matched, error: null };
    };
    const terminal = (single = false) => {
      if (insertRow) return applyInsert();
      if (updateRow) {
        const res = applyUpdate();
        if (single) {
          return { data: (res.data as any[])?.[0] ?? null, error: res.error };
        }
        return res;
      }
      const data = matchingRows();
      return { data: single ? data[0] || null : data, error: null };
    };

    const parseInSet = (val: any): string[] =>
      String(val).replace(/[()"']/g, "").split(",").map((s) => s.trim()).filter(
        Boolean,
      );

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
      not: (col: string, op: string, val: any) => {
        if (op === "in") {
          const set = parseInSet(val);
          preds.push((r) => !set.includes(String(r?.[col])));
        }
        return b;
      },
      in: (col: string, vals: any[]) => {
        preds.push((r) => vals.includes(r?.[col]));
        return b;
      },
      gte: (col: string, val: any) => {
        preds.push((r) => String(r?.[col] ?? "") >= String(val));
        return b;
      },
      or: () => b,
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

// ── seeds ─────────────────────────────────────────────────────────────────────

// A live make-safe with an open crew assignment and a detail row. No invoice.
function cancellableRows(overrides: TableRows = {}): TableRows {
  return {
    jobs: [{
      id: "job-1",
      job_number: "SWF-90001",
      type: "makesafe",
      status: "allocated",
      client_name: "Test Client",
      site_address: "1 Test St",
    }],
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      cycle_number: 1,
    }],
    job_assignments: [{
      id: "as-1",
      job_id: "job-1",
      status: "scheduled", // an OPEN status (_OPEN_ASSIGNMENT_STATUSES)
    }],
    xero_invoices: [],
    work_orders: [],
    job_events: [],
    ...overrides,
  };
}

const MANAGER = {
  authMode: "jwt" as const,
  callerRole: "installer",
  managedVerticals: ["makesafe"],
  operatorEmail: "hugo@secureworkswa.com.au",
};
const NON_MANAGER = {
  authMode: "jwt" as const,
  callerRole: "installer",
  managedVerticals: [] as string[],
  operatorEmail: "crew@secureworkswa.com.au",
};
const API_KEY = { authMode: "api_key" as const, operatorEmail: "ops@x" };

const CANCEL_BODY = {
  job_id: "job-1",
  reason_code: "builder_recalled",
  note: "builder recalled",
};

// ── 1. authz ────────────────────────────────────────────────────────────────

Deno.test("cancel: a make-safe manager (managed_verticals includes makesafe) is allowed", async () => {
  const { client, rows } = makeClient(cancellableRows());
  const res = await _cancelMakesafeForTest(client, {
    body: CANCEL_BODY,
    ...MANAGER,
  });
  assertEquals(res.ok, true);
  assertEquals(res.cancelled, true);
  assertEquals(rows.jobs[0].status, "cancelled");
});

Deno.test("cancel: a non-manager JWT (managed_verticals empty) is refused 403", async () => {
  const { client, rows } = makeClient(cancellableRows());
  await assertRejects(
    () => _cancelMakesafeForTest(client, { body: CANCEL_BODY, ...NON_MANAGER }),
    Error,
    "Not authorized",
  );
  assertEquals(rows.jobs[0].status, "allocated"); // unchanged
});

Deno.test("cancel: the ops api_key path is allowed (trusted-ops posture)", async () => {
  const { client, rows } = makeClient(cancellableRows());
  const res = await _cancelMakesafeForTest(client, {
    body: CANCEL_BODY,
    ...API_KEY,
  });
  assertEquals(res.ok, true);
  assertEquals(rows.jobs[0].status, "cancelled");
});

// ── 2. live-invoice guardrail ─────────────────────────────────────────────────

Deno.test("cancel: a DRAFT invoice does NOT block the cancel", async () => {
  const { client, rows } = makeClient(cancellableRows({
    xero_invoices: [{
      job_id: "job-1",
      invoice_type: "ACCREC",
      status: "DRAFT",
    }],
  }));
  const res = await _cancelMakesafeForTest(client, {
    body: CANCEL_BODY,
    ...MANAGER,
  });
  assertEquals(res.ok, true);
  assertEquals(rows.jobs[0].status, "cancelled");
});

for (const status of ["AUTHORISED", "SUBMITTED", "PAID"]) {
  Deno.test(`cancel: a live ${status} ACCREC invoice BLOCKS the cancel (code live_invoice)`, async () => {
    const { client, rows } = makeClient(cancellableRows({
      xero_invoices: [{ job_id: "job-1", invoice_type: "ACCREC", status }],
    }));
    const res = await _cancelMakesafeForTest(client, {
      body: CANCEL_BODY,
      ...MANAGER,
    });
    assertEquals(res.ok, false);
    assertEquals(res.code, "live_invoice");
    assert(String(res.error).includes("see admin"));
    assertEquals(rows.jobs[0].status, "allocated"); // NOT cancelled
  });
}

Deno.test("cancel: a VOIDED ACCREC invoice does NOT block (only live statuses block)", async () => {
  const { client, rows } = makeClient(cancellableRows({
    xero_invoices: [{
      job_id: "job-1",
      invoice_type: "ACCREC",
      status: "VOIDED",
    }],
  }));
  const res = await _cancelMakesafeForTest(client, {
    body: CANCEL_BODY,
    ...MANAGER,
  });
  assertEquals(res.ok, true);
  assertEquals(rows.jobs[0].status, "cancelled");
});

// ── 3. validation ─────────────────────────────────────────────────────────────

Deno.test("cancel: a non-makesafe job is rejected", async () => {
  const { client } = makeClient(cancellableRows({
    jobs: [{ id: "job-1", type: "fencing", status: "allocated" }],
  }));
  await assertRejects(
    () => _cancelMakesafeForTest(client, { body: CANCEL_BODY, ...MANAGER }),
    Error,
    "not a make-safe job",
  );
});

Deno.test("cancel: an empty note is rejected", async () => {
  const { client } = makeClient(cancellableRows());
  await assertRejects(
    () =>
      _cancelMakesafeForTest(client, {
        body: { job_id: "job-1", reason_code: "other", note: "   " },
        ...MANAGER,
      }),
    Error,
    "note required",
  );
});

Deno.test("cancel: an invalid reason_code is rejected", async () => {
  const { client } = makeClient(cancellableRows());
  await assertRejects(
    () =>
      _cancelMakesafeForTest(client, {
        body: { job_id: "job-1", reason_code: "because", note: "x" },
        ...MANAGER,
      }),
    Error,
    "reason_code required",
  );
});

// ── 4. writes: attribution, audit, assignment close ───────────────────────────

Deno.test("cancel: writes cancel_* attribution, closes assignments, logs makesafe_cancelled", async () => {
  const { client, rows } = makeClient(cancellableRows());
  const res = await _cancelMakesafeForTest(client, {
    body: {
      job_id: "job-1",
      reason_code: "reallocated",
      note: "given to another crew",
    },
    ...MANAGER,
  });
  assertEquals(res.ok, true);

  // jobs.status only (no cancelled_at column written).
  assertEquals(rows.jobs[0].status, "cancelled");
  assertEquals("cancelled_at" in rows.jobs[0], false);

  // attribution on makesafe_job_details.
  const detail = rows.makesafe_job_details[0];
  assertEquals(detail.cancel_reason, "reallocated");
  assertEquals(detail.cancel_note, "given to another crew");
  assertEquals(detail.cancelled_by, "hugo@secureworkswa.com.au");
  assert(!!detail.cancelled_at);

  // open assignment closed to cancelled.
  assertEquals(rows.job_assignments[0].status, "cancelled");

  // audit event shape.
  const evt = rows.job_events.find((e) =>
    e.event_type === "makesafe_cancelled"
  );
  assert(!!evt, "makesafe_cancelled event written");
  assertEquals(evt.job_id, "job-1");
  assertEquals(evt.detail_json.reason_code, "reallocated");
  assertEquals(evt.detail_json.note, "given to another crew");
  assertEquals(evt.detail_json.previous_status, "allocated");
  assertEquals(evt.detail_json.operator, "hugo@secureworkswa.com.au");
  assert(!!evt.detail_json.changed_at);
});

Deno.test("cancel: flips a linked non-cancelled work_orders row to cancelled (best-effort)", async () => {
  const { client, rows } = makeClient(cancellableRows({
    work_orders: [{ id: "wo-1", job_id: "job-1", status: "sent" }],
  }));
  await _cancelMakesafeForTest(client, { body: CANCEL_BODY, ...MANAGER });
  assertEquals(rows.work_orders[0].status, "cancelled");
});

// ── 5. idempotent re-cancel ───────────────────────────────────────────────────

Deno.test("cancel: re-cancelling an already-cancelled job is a clean no-op success", async () => {
  const { client, rows } = makeClient(cancellableRows({
    jobs: [{ id: "job-1", type: "makesafe", status: "cancelled" }],
    job_events: [],
  }));
  const res = await _cancelMakesafeForTest(client, {
    body: CANCEL_BODY,
    ...MANAGER,
  });
  assertEquals(res.ok, true);
  assertEquals(res.idempotent, true);
  // No duplicate audit event written on the no-op.
  assertEquals(rows.job_events.length, 0);
});

Deno.test("cancel: an archived (terminally-dead) make-safe cannot be cancelled", async () => {
  const { client } = makeClient(cancellableRows({
    jobs: [{ id: "job-1", type: "makesafe", status: "archived" }],
  }));
  await assertRejects(
    () => _cancelMakesafeForTest(client, { body: CANCEL_BODY, ...MANAGER }),
    Error,
    "cannot cancel a archived",
  );
});

// ── 6. board classification + feed ─────────────────────────────────────────────

Deno.test("board derive: a cancelled make-safe derives to `cancelled`, not `new`", () => {
  assertEquals(
    _deriveMakesafeBoardStage({ status: "cancelled" }, {}),
    "cancelled",
  );
  // sanity: a bare live job with no signals still derives `new`.
  assertEquals(_deriveMakesafeBoardStage({ status: "accepted" }, {}), "new");
});

Deno.test("board enrich: a cancelled card carries cancel_* fields + Cancelled label", () => {
  const card = _enrichMakesafeBoardJobForTest(
    { id: "job-1", status: "cancelled", created_at: new Date().toISOString() },
    {
      job_id: "job-1",
      cancel_reason: "sent_in_error",
      cancel_note: "wrong address",
      cancelled_by: "hugo@x",
      cancelled_at: "2026-07-09T00:00:00Z",
    },
  );
  assertEquals(card.board_stage, "cancelled");
  assertEquals(card.board_label, "Cancelled");
  assertEquals(card.cancel_reason, "sent_in_error");
  assertEquals(card.cancel_note, "wrong address");
  assertEquals(card.cancelled_by, "hugo@x");
});

Deno.test("board enrich: a live card carries null cancel_* fields", () => {
  const card = _enrichMakesafeBoardJobForTest(
    { id: "job-9", status: "accepted", created_at: new Date().toISOString() },
    { job_id: "job-9" },
  );
  assertEquals(card.cancel_reason, null);
  assertEquals(card.cancelled_at, null);
});

Deno.test("board feed: cancelled job in `cancelled` column, 90-day window respected, total not inflated", async () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const recentCancel = iso(now - 5 * 86_400_000); // within 90 days
  const oldCancel = iso(now - 200 * 86_400_000); // outside 90 days

  const { client } = makeClient({
    jobs: [
      // one ACTIVE make-safe (should count in total, land in `new`)
      {
        id: "job-active",
        job_number: "A",
        type: "makesafe",
        status: "accepted",
        created_at: iso(now),
      },
      // a recently-cancelled make-safe (in window)
      {
        id: "job-recent",
        job_number: "R",
        type: "makesafe",
        status: "cancelled",
        created_at: iso(now - 6 * 86_400_000),
        updated_at: recentCancel,
      },
      // an old cancelled make-safe (out of window)
      {
        id: "job-old",
        job_number: "O",
        type: "makesafe",
        status: "cancelled",
        created_at: iso(now - 210 * 86_400_000),
        updated_at: oldCancel,
      },
    ],
    makesafe_job_details: [
      { job_id: "job-active" },
      {
        job_id: "job-recent",
        cancel_reason: "duplicate",
        cancel_note: "dup",
        cancelled_by: "hugo@x",
        cancelled_at: recentCancel,
      },
      { job_id: "job-old", cancel_reason: "other", cancelled_at: oldCancel },
    ],
    job_service_reports: [],
    xero_invoices: [],
    job_documents: [],
    makesafe_report_packs: [],
    job_assignments: [],
    job_events: [],
  });

  const pipeline: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams(),
  );

  // total = ACTIVE board only (the exclusion keeps cancelled out of the main feed).
  assertEquals(pipeline.total, 1);

  // active job in `new`, not in cancelled.
  assert(
    pipeline.columns.new.find((j: any) => j.id === "job-active"),
    "active in new",
  );

  // recent cancel present in cancelled column, carrying attribution.
  const recent = pipeline.columns.cancelled.find((j: any) =>
    j.id === "job-recent"
  );
  assert(!!recent, "recent cancel in cancelled column");
  assertEquals(recent.cancel_reason, "duplicate");
  assertEquals(recent.board_stage, "cancelled");

  // old cancel outside the 90-day window is NOT fed.
  assert(
    !pipeline.columns.cancelled.find((j: any) => j.id === "job-old"),
    "old cancel excluded by window",
  );

  // a cancelled job never leaks into `new`.
  assert(
    !pipeline.columns.new.find((j: any) => j.id === "job-recent"),
    "cancelled not in new",
  );

  // stage_labels advertises the Cancelled column.
  assertEquals(pipeline.stage_labels.cancelled, "Cancelled");
});

Deno.test("board feed: a cancelled card retains its (now-cancelled) assignment ownership so an allocated-only trade keeps its own worked-then-cancelled make-safe", async () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const recentCancel = iso(now - 5 * 86_400_000);

  const { client } = makeClient({
    jobs: [
      {
        id: "job-mine",
        job_number: "M",
        type: "makesafe",
        status: "cancelled",
        created_at: iso(now - 6 * 86_400_000),
        updated_at: recentCancel,
      },
      {
        id: "job-other",
        job_number: "T",
        type: "makesafe",
        status: "cancelled",
        created_at: iso(now - 6 * 86_400_000),
        updated_at: recentCancel,
      },
    ],
    makesafe_job_details: [
      {
        job_id: "job-mine",
        cancel_reason: "duplicate",
        cancelled_at: recentCancel,
      },
      {
        job_id: "job-other",
        cancel_reason: "duplicate",
        cancelled_at: recentCancel,
      },
    ],
    job_service_reports: [],
    xero_invoices: [],
    job_documents: [],
    makesafe_report_packs: [],
    // Job cancellation closed these open assignments to 'cancelled'. The cancelled
    // read must retain every status (not .neq('status','cancelled')) or the trade's
    // ownership evidence is lost and its own Archive card silently vanishes.
    job_assignments: [
      {
        id: "as-mine",
        job_id: "job-mine",
        user_id: "trade-mine",
        status: "cancelled",
        users: { id: "trade-mine", name: "Mine" },
      },
      {
        id: "as-other",
        job_id: "job-other",
        user_id: "trade-other",
        status: "cancelled",
        users: { id: "trade-other", name: "Other" },
      },
    ],
    job_events: [],
  });

  const pipeline: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams(),
  );

  const mine = pipeline.columns.cancelled.find((j: any) => j.id === "job-mine");
  assert(!!mine, "own cancelled card fed");
  assertEquals((mine.assignments || []).map((a: any) => a.user_id), [
    "trade-mine",
  ]);

  // The allocated-only projection filter keys off assignment membership; with the
  // ownership retained, the trade keeps its own card and never sees another's.
  const board = projectTradeMakesafeBoard(pipeline.columns.cancelled, {
    userId: "trade-mine",
    name: "Mine",
    role: "installer",
    managedVerticals: [],
  });
  assertEquals(board.rows.map((r: any) => r.id), ["job-mine"]);
});

// ── 7. story-reconciler exemption ──────────────────────────────────────────────

function baseEvidence(over: Record<string, unknown> = {}) {
  return {
    jobStatus: "cancelled",
    substatus: null,
    cancelled: true,
    adminSentAttributed: false,
    packSentMarker: false,
    pipelineVerifiedSent: false,
    paid: false,
    invoiceBuilt: false,
    siblingBleed: false,
    attended: false,
    hasReportDoc: false,
    hasInvoiceDoc: false,
    woReceived: false,
    isReportType: false,
    portalVerifiedThisCycle: false,
    hasPortalLink: false,
    ...over,
  } as any;
}

Deno.test("story: a MANUAL cancel with report/invoice evidence returns clean CANCELLED", () => {
  const res = computeStoryVerdict(baseEvidence({
    cancelReasonSet: true,
    invoiceBuilt: true,
    attended: true,
    adminSentAttributed: true,
  }));
  assertEquals(res.verdict, "CANCELLED");
});

Deno.test("story: a LEGACY cancel (no cancel_reason) with evidence still returns CANCELLED-CONFLICT", () => {
  const res = computeStoryVerdict(baseEvidence({
    cancelReasonSet: false,
    invoiceBuilt: true,
    attended: true,
  }));
  assertEquals(res.verdict, "CANCELLED-CONFLICT");
});

Deno.test("story: a manual cancel with no evidence is CANCELLED (baseline)", () => {
  const res = computeStoryVerdict(baseEvidence({ cancelReasonSet: true }));
  assertEquals(res.verdict, "CANCELLED");
});

// ── 8. reopen-to-New (Wave 2) ──────────────────────────────────────────────────

function cancelledReopenRows(over: TableRows = {}): TableRows {
  return {
    jobs: [{ id: "job-1", type: "makesafe", status: "cancelled" }],
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: "2026-07-01T00:00:00Z",
      cycle_number: 3,
      cancel_reason: "builder_recalled",
      cancel_note: "recalled",
      cancelled_by: "hugo@x",
      cancelled_at: "2026-07-08T00:00:00Z",
    }],
    job_assignments: [],
    job_events: [],
    ...over,
  };
}

Deno.test("reopen: a make-safe manager may reopen a CANCELLED job -> derived New, signals cleared, cycle NOT bumped", async () => {
  const { client, rows } = makeClient(cancelledReopenRows());
  const res = await _reopenMakesafeForTest(
    client,
    { job_id: "job-1", reason: "reopen after cancel" },
    {
      privileged: false,
      authMode: "jwt",
      callerRole: "installer",
      managedVerticals: ["makesafe"],
      operatorEmail: "hugo@x",
    },
  );
  assertEquals(res.reopened, true);
  assertEquals(res.previous_status, "cancelled");

  const detail = rows.makesafe_job_details[0];
  // cycle_number NOT bumped on a cancel -> reopen (protects M-C accounting).
  assertEquals(detail.cycle_number, 3);
  // signals + cancel_* cleared so the card derives back to New.
  assertEquals(detail.substatus, null);
  assertEquals(detail.report_received_at, null);
  assertEquals(detail.cancel_reason, null);
  assertEquals(detail.cancel_note, null);
  assertEquals(detail.cancelled_by, null);
  assertEquals(detail.cancelled_at, null);

  // job reactivated + derives to New with the reset detail.
  assertEquals(rows.jobs[0].status, "accepted");
  assertEquals(_deriveMakesafeBoardStage(rows.jobs[0], detail), "new");
});

Deno.test("reopen: a non-manager JWT may NOT reopen a cancelled job", async () => {
  const { client } = makeClient(cancelledReopenRows());
  await assertRejects(
    () =>
      _reopenMakesafeForTest(
        client,
        { job_id: "job-1", reason: "x" },
        {
          privileged: false,
          authMode: "jwt",
          callerRole: "installer",
          managedVerticals: [],
          operatorEmail: "crew@x",
        },
      ),
    Error,
    "Not authorized",
  );
});

Deno.test("reopen: a manager may NOT reopen a COMPLETE job (admin/api-key only)", async () => {
  const { client } = makeClient({
    jobs: [{ id: "job-1", type: "makesafe", status: "complete" }],
    makesafe_job_details: [{ job_id: "job-1", cycle_number: 2 }],
    job_events: [],
  });
  await assertRejects(
    () =>
      _reopenMakesafeForTest(
        client,
        { job_id: "job-1", reason: "x" },
        {
          privileged: false,
          authMode: "jwt",
          callerRole: "installer",
          managedVerticals: ["makesafe"],
          operatorEmail: "hugo@x",
        },
      ),
    Error,
    "requires an admin/owner or the ops key",
  );
});

Deno.test("reopen: the privileged path reopens a COMPLETE job and DOES bump cycle_number", async () => {
  const { client, rows } = makeClient({
    jobs: [{ id: "job-1", type: "makesafe", status: "complete" }],
    makesafe_job_details: [{ job_id: "job-1", cycle_number: 2 }],
    job_events: [],
  });
  const res = await _reopenMakesafeForTest(
    client,
    { job_id: "job-1", reason: "rectification" },
    { privileged: true, authMode: "api_key", operatorEmail: "ops@x" },
  );
  assertEquals(res.reopened, true);
  assertEquals(res.previous_status, "complete");
  assertEquals(rows.makesafe_job_details[0].cycle_number, 3); // bumped
});

// ── 9. W2-A: trade my_jobs windowed cancelled feed ─────────────────────────────
// Without this, a cancelled make-safe vanishes from trade (pool excludes it, the
// assignment feed drops it) and the trade Cancelled column + Reopen button are
// inert. myJobs must feed recently-cancelled (<=90d) make-safes as synthetic
// cards for a make-safe manager/dispatcher only.

type MjJob = Record<string, any>;
type MjDetail = Record<string, any>;

// A faithful-enough Supabase mock for the myJobs read path: models the eq/neq/
// gte/lt/in/not/or filters the handler issues so the 90-day window + manager gate
// + status filter are really exercised (not assumed). Unseeded tables -> [].
function makeMyJobsClient(fx: { jobs: MjJob[]; details: MjDetail[] }) {
  function resolve(st: any): { data: any[]; error: null } {
    if (st.table === "jobs") {
      let rows = fx.jobs.slice();
      if (st.eq.type != null) rows = rows.filter((j) => j.type === st.eq.type);
      if (st.eq.status != null) {
        rows = rows.filter((j) => j.status === st.eq.status);
      }
      if (st.eq.id != null) rows = rows.filter((j) => j.id === st.eq.id);
      if (st.inCol === "id" && st.inVals) {
        rows = rows.filter((j) => st.inVals.includes(j.id));
      }
      if (st.notIn) {
        const ex = new Set<string>();
        for (const m of String(st.notIn).matchAll(/"([^"]+)"/g)) ex.add(m[1]);
        rows = rows.filter((j) => !ex.has(String(j.status)));
      }
      // the plain (non-referenced) or() used by the open pool query
      if (st.refOr && st.refOr.referencedTable == null) {
        rows = rows.filter((j) =>
          String(st.refOr.str).split(",").some((c: string) => {
            const [col, op, ...rest] = c.split(".");
            const val = rest.join(".");
            const cell = String(j[col] ?? "");
            if (op === "eq") return cell === val;
            if (op === "ilike") {
              return cell.toLowerCase().startsWith(
                val.replace(/%$/, "").toLowerCase(),
              );
            }
            return false;
          })
        );
      }
      if (st.gteCol === "updated_at" && st.gteVal != null) {
        rows = rows.filter((j) =>
          String(j.updated_at ?? "") >= String(st.gteVal)
        );
      }
      return { data: rows.map((j) => ({ ...j })), error: null };
    }
    if (st.table === "makesafe_job_details") {
      let rows = fx.details.slice();
      if (st.inCol === "job_id" && st.inVals) {
        rows = rows.filter((d) => st.inVals.includes(d.job_id));
      }
      return { data: rows.map((d) => ({ ...d })), error: null };
    }
    // job_assignments / purchase_orders / job_contacts — none seeded here.
    return { data: [], error: null };
  }
  function from(table: string) {
    const st: any = {
      table,
      eq: {},
      neq: {},
      gteCol: null,
      gteVal: null,
      refOr: null,
      notIn: null,
      inCol: null,
      inVals: null,
    };
    const b: any = {
      select: () => b,
      eq: (k: string, v: unknown) => {
        st.eq[k] = v;
        return b;
      },
      neq: (k: string, v: unknown) => {
        st.neq[k] = v;
        return b;
      },
      gte: (k: string, v: string) => {
        st.gteCol = k;
        st.gteVal = v;
        return b;
      },
      lt: () => b,
      in: (k: string, arr: unknown[]) => {
        st.inCol = k;
        st.inVals = arr;
        return b;
      },
      not: (k: string, op: string, v: string) => {
        if (k === "status" && op === "in") st.notIn = v;
        return b;
      },
      or: (s: string, opts?: { referencedTable?: string }) => {
        st.refOr = { str: s, referencedTable: opts?.referencedTable ?? null };
        return b;
      },
      ilike: () => b,
      order: () => b,
      limit: () => b,
      range: () => b,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (res: (v: any) => any) => res(resolve(st)),
    };
    return b;
  }
  return { from };
}

function allCards(grouped: any): any[] {
  return [
    ...(grouped.today || []),
    ...(grouped.thisWeek || []),
    ...(grouped.upcoming || []),
    ...(grouped.recent || []),
    ...(grouped.makesafePool || []),
  ];
}

function myJobsCancelFixtures() {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    jobs: [
      {
        id: "j-recent",
        type: "makesafe",
        status: "cancelled",
        job_number: "SWF-70001",
        client_name: "Recent",
        updated_at: iso(now - 3 * 86_400_000),
      },
      {
        id: "j-old",
        type: "makesafe",
        status: "cancelled",
        job_number: "SWF-70002",
        client_name: "Old",
        updated_at: iso(now - 200 * 86_400_000),
      },
    ],
    details: [
      {
        job_id: "j-recent",
        cancel_reason: "builder_recalled",
        cancel_note: "recalled",
        cancelled_by: "hugo@x",
        cancelled_at: iso(now - 3 * 86_400_000),
      },
      {
        job_id: "j-old",
        cancel_reason: "duplicate",
        cancelled_at: iso(now - 200 * 86_400_000),
      },
    ],
  };
}

Deno.test("W2-A: a make-safe MANAGER's my_jobs includes a recently-cancelled make-safe with cancel_* attached", async () => {
  const client = makeMyJobsClient(myJobsCancelFixtures());
  // showAll=false, isDispatcher=false, isMakesafeManager=true, poolVerticals=['makesafe']
  const grouped: any = await myJobs(
    client as any,
    "hugo-id",
    false,
    false,
    true,
    ["makesafe"],
    [],
  );
  const cards = allCards(grouped);
  const card = cards.find((c) => c.jobs?.id === "j-recent");
  assert(!!card, "recently-cancelled make-safe present in manager my_jobs");
  assertEquals(card.jobs.status, "cancelled");
  assertEquals(card.assignment_type, "makesafe_cancelled");
  assertEquals(card.role, "makesafe_cancelled");
  // cancel_* rides through on job.makesafe_details.
  assertEquals(card.jobs.makesafe_details.cancel_reason, "builder_recalled");
  assertEquals(card.jobs.makesafe_details.cancelled_by, "hugo@x");
});

Deno.test("W2-A: a cancelled make-safe older than 90 days is EXCLUDED from the feed", async () => {
  const client = makeMyJobsClient(myJobsCancelFixtures());
  const grouped: any = await myJobs(
    client as any,
    "hugo-id",
    false,
    false,
    true,
    ["makesafe"],
    [],
  );
  const cards = allCards(grouped);
  assert(
    !cards.find((c) => c.jobs?.id === "j-old"),
    "the >90-day cancel is not fed",
  );
});

Deno.test("W2-A: a NON-manager (no makesafe pool visibility) does NOT get the cancelled feed", async () => {
  const client = makeMyJobsClient(myJobsCancelFixtures());
  // isDispatcher=false, isMakesafeManager=false, poolVerticals=[]
  const grouped: any = await myJobs(
    client as any,
    "crew-id",
    false,
    false,
    false,
    [],
    [],
  );
  const cards = allCards(grouped);
  assert(
    !cards.find((c) => c.jobs?.id === "j-recent"),
    "non-manager gets no cancelled make-safe cards",
  );
});
