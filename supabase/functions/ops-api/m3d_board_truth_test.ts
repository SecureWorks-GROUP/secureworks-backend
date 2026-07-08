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

// ── Mock: capture the job_assignments update chain ─────────────────────────
// closeOpenAssignmentsForJob does:
//   client.from('job_assignments').update(patch).eq('job_id', id).in('status', arr).select('id')
function makeAssignmentClient(opts: { rows?: any[]; error?: any } = {}) {
  const captured: {
    fromCalled: boolean;
    table: string | null;
    update: any;
    eqField: string | null;
    eqVal: any;
    inField: string | null;
    inVals: any;
    selectCols: string | null;
  } = {
    fromCalled: false,
    table: null,
    update: null,
    eqField: null,
    eqVal: null,
    inField: null,
    inVals: null,
    selectCols: null,
  };
  const rows = opts.rows ?? [];
  const client = {
    from(table: string) {
      captured.fromCalled = true;
      captured.table = table;
      const builder: any = {
        update(patch: any) {
          captured.update = patch;
          return builder;
        },
        eq(field: string, val: any) {
          captured.eqField = field;
          captured.eqVal = val;
          return builder;
        },
        in(field: string, vals: any) {
          captured.inField = field;
          captured.inVals = vals;
          return builder;
        },
        select(cols: string) {
          captured.selectCols = cols;
          return { data: opts.error ? null : rows, error: opts.error ?? null };
        },
      };
      return builder;
    },
  };
  return { client, captured };
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
  const { client, captured } = makeAssignmentClient({ rows: [{ id: "a1" }, { id: "a2" }] });
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

Deno.test("closeOpenAssignmentsForJob: closeAs 'cancelled' writes cancelled", async () => {
  const { client, captured } = makeAssignmentClient({ rows: [{ id: "a1" }] });
  const closed = await _closeOpenAssignmentsForJobForTest(client, "job-9", "cancelled");
  assertEquals(closed, 1);
  assertEquals(captured.update.status, "cancelled");
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
  const { client, captured } = makeAssignmentClient({ rows: [{ id: "a1" }] });
  const closed = await _closeOpenAssignmentsForJobForTest(client, "", "complete");
  assertEquals(closed, 0);
  assertEquals(captured.fromCalled, false);
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
