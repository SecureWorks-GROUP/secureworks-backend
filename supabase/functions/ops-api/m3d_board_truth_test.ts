// M3d U2 — Board classification truth (backend guard + allocatable-only pool).
// Covers:
//   U2a  closeOpenAssignmentsForJob — status targeting, closeAs mapping,
//        non-blocking failure, idempotency, empty-jobId short-circuit.
//   U2b  _closeAsForJobStatus / _closeAsForMakesafeSubstatus — the terminal-
//        transition -> close-mode mapping the call sites use.
//   U2c  _isAllocatableMakesafePoolDetailForTest — pool visibility excludes
//        company_contact_required + finished substatuses; null stays visible.
//        Paired with _isOpenTradeMakesafeDetailForTest to prove the split:
//        report access still SEES company_contact_required.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _closeAsForJobStatus,
  _closeAsForMakesafeSubstatus,
  _closeOpenAssignmentsForJobForTest,
  _isAllocatableMakesafePoolDetailForTest,
  _isOpenTradeMakesafeDetailForTest,
} from "./index.ts";

// AWST date helpers — mirror index.ts getAWSTDate() so the belt boundary lines
// up with production regardless of when the suite runs.
const AWST_OFFSET_MS = 8 * 60 * 60 * 1000;
function awstDate(offsetDays: number): string {
  return new Date(Date.now() + AWST_OFFSET_MS + offsetDays * 86400000).toISOString().slice(0, 10);
}
const TODAY = awstDate(0);
const PAST = awstDate(-7);
const FUTURE = awstDate(7);

// ── Mock: capture AND simulate the job_assignments update chain ─────────────
// closeOpenAssignmentsForJob does:
//   .from('job_assignments').update(patch).eq('job_id', id).in('status', arr)
//     [.or('scheduled_date.is.null,scheduled_date.lte.<today>')]  // 'complete' only
//     .select('id')
// The mock captures every predicate AND applies eq/in/or to the seeded rows so
// row-survival (the date belt) can be asserted, not just the query shape. Rows
// are seeded as { id, job_id, status, scheduled_date }.
function makeAssignmentClient(opts: { rows?: any[]; error?: any } = {}) {
  const captured: {
    fromCalled: boolean;
    table: string | null;
    update: any;
    eqField: string | null;
    eqVal: any;
    inField: string | null;
    inVals: any;
    orExpr: string | null;
    selectCols: string | null;
    matchedIds: string[];
  } = {
    fromCalled: false,
    table: null,
    update: null,
    eqField: null,
    eqVal: null,
    inField: null,
    inVals: null,
    orExpr: null,
    selectCols: null,
    matchedIds: [],
  };
  const rows = opts.rows ?? [];
  // Evaluate a single PostgREST clause "field.op.value" against a row.
  function clauseMatches(r: any, clause: string): boolean {
    const [field, op, ...rest] = clause.split(".");
    const value = rest.join(".");
    const rv = r[field];
    if (op === "is" && value === "null") return rv === null || rv === undefined;
    if (op === "lte") return rv !== null && rv !== undefined && rv <= value;
    if (op === "gt") return rv !== null && rv !== undefined && rv > value;
    return false;
  }
  const client = {
    from(table: string) {
      captured.fromCalled = true;
      captured.table = table;
      const eqFilters: Record<string, any> = {};
      const inFilters: Record<string, any[]> = {};
      const orGroups: string[][] = [];
      const builder: any = {
        update(patch: any) {
          captured.update = patch;
          return builder;
        },
        eq(field: string, val: any) {
          captured.eqField = field;
          captured.eqVal = val;
          eqFilters[field] = val;
          return builder;
        },
        in(field: string, vals: any) {
          captured.inField = field;
          captured.inVals = vals;
          inFilters[field] = vals;
          return builder;
        },
        or(expr: string) {
          captured.orExpr = expr;
          orGroups.push(expr.split(","));
          return builder;
        },
        select(cols: string) {
          captured.selectCols = cols;
          if (opts.error) return { data: null, error: opts.error };
          // Simulate Postgres: a row is updated only if it satisfies every
          // top-level filter; an .or() group matches when ANY clause matches.
          const matched = rows.filter((r: any) => {
            for (const [f, v] of Object.entries(eqFilters)) if (r[f] !== v) return false;
            for (const [f, vals] of Object.entries(inFilters)) if (!vals.includes(r[f])) return false;
            for (const group of orGroups) if (!group.some((c) => clauseMatches(r, c))) return false;
            return true;
          }).map((r: any) => ({ id: r.id }));
          captured.matchedIds = matched.map((m: any) => m.id);
          return { data: matched, error: null };
        },
      };
      return builder;
    },
  };
  return { client, captured };
}

// Convenience: seed an open assignment row.
function asg(id: string, scheduled_date: string | null, status = "scheduled", job_id = "job-1") {
  return { id, job_id, status, scheduled_date };
}

// ── U2b: _closeAsForJobStatus ──────────────────────────────────────────────
Deno.test("closeAsForJobStatus: every dead status -> cancelled", () => {
  for (const s of ["cancelled", "canceled", "lost", "deleted", "duplicate", "duplicated", "void", "voided"]) {
    assertEquals(_closeAsForJobStatus(s), "cancelled", `dead status ${s}`);
  }
});

Deno.test("closeAsForJobStatus: every finished status -> complete", () => {
  for (const s of ["complete", "completed", "invoiced", "paid", "closed", "archived"]) {
    assertEquals(_closeAsForJobStatus(s), "complete", `finished status ${s}`);
  }
});

Deno.test("closeAsForJobStatus: non-terminal statuses map to null (no close)", () => {
  for (const s of ["scheduled", "in_progress", "quoted", "accepted", "deposit", "processing", "approvals", "rectification", "order_materials", "awaiting_deposit"]) {
    assertEquals(_closeAsForJobStatus(s), null, `non-terminal ${s}`);
  }
});

Deno.test("closeAsForJobStatus: null / undefined / empty map to null", () => {
  assertEquals(_closeAsForJobStatus(null), null);
  assertEquals(_closeAsForJobStatus(undefined), null);
  assertEquals(_closeAsForJobStatus(""), null);
});

Deno.test("closeAsForJobStatus: case-insensitive", () => {
  assertEquals(_closeAsForJobStatus("ARCHIVED"), "complete");
  assertEquals(_closeAsForJobStatus("Cancelled"), "cancelled");
  assertEquals(_closeAsForJobStatus("Invoiced"), "complete");
});

// ── U2b: _closeAsForMakesafeSubstatus ──────────────────────────────────────
Deno.test("closeAsForMakesafeSubstatus: every finished substatus -> complete", () => {
  for (const s of ["complete", "completed", "ready_to_invoice", "admin_to_send_report", "invoiced"]) {
    assertEquals(_closeAsForMakesafeSubstatus(s), "complete", `finished substatus ${s}`);
  }
});

Deno.test("closeAsForMakesafeSubstatus: non-finished substatuses map to null", () => {
  for (const s of ["company_contact_required", "company_contact_done", "pending_allocation", "waiting_on_trade_report", "", null, undefined]) {
    assertEquals(_closeAsForMakesafeSubstatus(s as any), null, `non-finished ${s}`);
  }
});

Deno.test("closeAsForMakesafeSubstatus: case-insensitive", () => {
  assertEquals(_closeAsForMakesafeSubstatus("Admin_To_Send_Report"), "complete");
  assertEquals(_closeAsForMakesafeSubstatus("READY_TO_INVOICE"), "complete");
});

// ── U2a: closeOpenAssignmentsForJob ────────────────────────────────────────
Deno.test("closeOpenAssignmentsForJob: targets only OPEN statuses, sets closeAs + updated_at", async () => {
  const { client, captured } = makeAssignmentClient({ rows: [asg("a1", PAST), asg("a2", PAST)] });
  const closed = await _closeOpenAssignmentsForJobForTest(client, "job-1", "complete");

  assertEquals(closed, 2);
  assertEquals(captured.table, "job_assignments");
  assertEquals(captured.eqField, "job_id");
  assertEquals(captured.eqVal, "job-1");
  assertEquals(captured.inField, "status");
  assertEquals(captured.inVals, ["scheduled", "confirmed", "draft"]);
  assertEquals(captured.update.status, "complete");
  // updated_at must be stamped (ISO string), never left stale.
  assertEquals(typeof captured.update.updated_at, "string");
});

Deno.test("closeOpenAssignmentsForJob: closeAs 'cancelled' writes cancelled and applies NO date belt", async () => {
  const { client, captured } = makeAssignmentClient({ rows: [asg("a1", PAST, "confirmed", "job-9")] });
  const closed = await _closeOpenAssignmentsForJobForTest(client, "job-9", "cancelled");
  assertEquals(closed, 1);
  assertEquals(captured.update.status, "cancelled");
  // Dead-close never adds the scheduled_date filter.
  assertEquals(captured.orExpr, null);
});

Deno.test("closeOpenAssignmentsForJob: 'complete' applies the null-or-<=today (AWST) belt", async () => {
  const { client, captured } = makeAssignmentClient({ rows: [asg("a1", PAST)] });
  await _closeOpenAssignmentsForJobForTest(client, "job-1", "complete");
  assertEquals(captured.orExpr, `scheduled_date.is.null,scheduled_date.lte.${TODAY}`);
});

Deno.test("closeOpenAssignmentsForJob: idempotent — zero open rows returns 0", async () => {
  const { client, captured } = makeAssignmentClient({ rows: [] });
  const closed = await _closeOpenAssignmentsForJobForTest(client, "job-2", "complete");
  assertEquals(closed, 0);
  // Still ran the (harmless) query — a second call simply finds nothing to close.
  assertEquals(captured.fromCalled, true);
});

Deno.test("closeOpenAssignmentsForJob: non-blocking — a DB error returns 0, never throws", async () => {
  const { client } = makeAssignmentClient({ error: { message: "boom" } });
  const closed = await _closeOpenAssignmentsForJobForTest(client, "job-3", "complete");
  assertEquals(closed, 0);
});

Deno.test("closeOpenAssignmentsForJob: empty jobId short-circuits without querying", async () => {
  const { client, captured } = makeAssignmentClient({ rows: [asg("a1", PAST)] });
  const closed = await _closeOpenAssignmentsForJobForTest(client, "", "complete");
  assertEquals(closed, 0);
  assertEquals(captured.fromCalled, false);
});

// ── U2a date belt (FM #319 review): finished keeps future, dead removes it ──
Deno.test("date belt: finished-close CLOSES past, KEEPS a strictly-future re-attend", async () => {
  const { client, captured } = makeAssignmentClient({ rows: [asg("past", PAST), asg("future", FUTURE)] });
  const closed = await _closeOpenAssignmentsForJobForTest(client, "job-1", "complete");
  assertEquals(closed, 1);
  assertEquals(captured.matchedIds, ["past"]); // the future re-attend survives
});

Deno.test("date belt: dead-close REMOVES a strictly-future row (cancelled job's future visits are dead)", async () => {
  const { client } = makeAssignmentClient({ rows: [asg("future", FUTURE)] });
  const closed = await _closeOpenAssignmentsForJobForTest(client, "job-1", "cancelled");
  assertEquals(closed, 1);
});

Deno.test("date belt: boundary — a row dated TODAY closes on a finished-close", async () => {
  const { client, captured } = makeAssignmentClient({ rows: [asg("today", TODAY), asg("future", FUTURE)] });
  const closed = await _closeOpenAssignmentsForJobForTest(client, "job-1", "complete");
  assertEquals(closed, 1);
  assertEquals(captured.matchedIds, ["today"]);
});

Deno.test("date belt: a NULL-dated open row CLOSES on both finished- and dead-close", async () => {
  // FM ruling: an undated open assignment on finished work is stale by definition
  // (a deliberate future booking always carries a date), so finished-close sweeps
  // it via the `scheduled_date.is.null` clause. Dead-close closes it too.
  const finished = makeAssignmentClient({ rows: [asg("nullrow", null)] });
  assertEquals(await _closeOpenAssignmentsForJobForTest(finished.client, "job-1", "complete"), 1);
  const dead = makeAssignmentClient({ rows: [asg("nullrow", null)] });
  assertEquals(await _closeOpenAssignmentsForJobForTest(dead.client, "job-1", "cancelled"), 1);
});

Deno.test("date belt: finished-close closes null + past + today, KEEPS only strictly-future", async () => {
  const { client, captured } = makeAssignmentClient({
    rows: [asg("nullrow", null), asg("past", PAST), asg("today", TODAY), asg("future", FUTURE)],
  });
  const closed = await _closeOpenAssignmentsForJobForTest(client, "job-1", "complete");
  assertEquals(closed, 3);
  assertEquals(captured.matchedIds.sort(), ["nullrow", "past", "today"]);
});

// ── U2c: allocatable-only pool predicate + the report-access split ──────────
Deno.test("allocatable pool: null detail stays visible (preserve today's behaviour)", () => {
  assertEquals(_isAllocatableMakesafePoolDetailForTest(null), true);
  assertEquals(_isAllocatableMakesafePoolDetailForTest(undefined), true);
});

Deno.test("allocatable pool: company_contact_required is EXCLUDED (G2 New = allocatable only)", () => {
  assertEquals(_isAllocatableMakesafePoolDetailForTest({ substatus: "company_contact_required" }), false);
});

Deno.test("allocatable pool: finished substatuses stay excluded (as before)", () => {
  for (const s of ["complete", "completed", "admin_to_send_report", "ready_to_invoice", "invoiced"]) {
    assertEquals(_isAllocatableMakesafePoolDetailForTest({ substatus: s }), false, `finished ${s}`);
  }
});

Deno.test("allocatable pool: a report timestamp still excludes (inherited from isOpenTradeMakesafeDetail)", () => {
  assertEquals(_isAllocatableMakesafePoolDetailForTest({ substatus: "waiting_on_trade_report", report_sent_at: "2026-07-01T00:00:00Z" }), false);
});

Deno.test("allocatable pool: genuinely allocatable substatuses stay visible", () => {
  for (const s of ["waiting_on_trade_report", "pending_allocation", "company_contact_done", "", "none"]) {
    assertEquals(_isAllocatableMakesafePoolDetailForTest({ substatus: s }), true, `allocatable ${s}`);
  }
});

Deno.test("SPLIT PROOF: report-access predicate STILL sees company_contact_required (only pool visibility changed)", () => {
  // isOpenTradeMakesafeDetail powers the field-report path — a trade must still
  // be able to open/report a company_contact_required job. Only the allocatable
  // pool predicate drops it.
  assertEquals(_isOpenTradeMakesafeDetailForTest({ substatus: "company_contact_required" }), true);
  assertEquals(_isAllocatableMakesafePoolDetailForTest({ substatus: "company_contact_required" }), false);
});
