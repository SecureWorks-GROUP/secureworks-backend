// M-G FIX 1 — report-in guard DB-wiring tests.
//
// Covers loadMakesafeReportIn + the two assert helpers against a chainable
// in-memory client (schema-shaped: makesafe_job_details / jobs / job_service_reports
// / job_documents). The pure decision logic (reportInSatisfied /
// substatusAdvanceNeedsReportIn) is unit-tested in makesafe_portal_guard_test.ts;
// these tests prove the loader reads the right tables/columns and, critically, that
// the guard NO-OPS for a non-make-safe job so ordinary patio/fence invoicing is
// never blocked. Live-validation on a throwaway job is still required before deploy
// (in-memory mocks do not enforce schema — see the M-F archived_at lesson).
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _assertMakesafeReportInForAdvance,
  _assertMakesafeReportInForInvoice,
  _loadMakesafeReportIn,
} from "./index.ts";

type TableRows = Record<string, any[]>;

function makeClient(seed: TableRows) {
  const rows: TableRows = {};
  for (const [t, r] of Object.entries(seed)) rows[t] = r.map((x) => ({ ...x }));
  function builder(table: string) {
    if (!rows[table]) rows[table] = [];
    const preds: Array<(r: any) => boolean> = [];
    let maxRows: number | null = null;
    const matched = () => {
      const m = rows[table].filter((r) => preds.every((p) => p(r)));
      return maxRows === null ? m : m.slice(0, maxRows);
    };
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => {
        preds.push((r) => r?.[c] === v);
        return b;
      },
      neq: (c: string, v: any) => {
        preds.push((r) => r?.[c] !== v);
        return b;
      },
      in: (c: string, vs: any[]) => {
        preds.push((r) => vs.includes(r?.[c]));
        return b;
      },
      order: () => b,
      limit: (n: number) => {
        maxRows = n;
        return b;
      },
      maybeSingle: async () => ({ data: matched()[0] || null, error: null }),
      single: async () => ({ data: matched()[0] || null, error: null }),
      then: (resolve: (v: any) => any) =>
        resolve({ data: matched(), error: null }),
    };
    return b;
  }
  return { from: (t: string) => builder(t) };
}

const PHYSICAL_DETAIL = {
  job_id: "job-1",
  report_type: null,
  cycle_number: 1,
};

Deno.test("reportIn wiring: non-make-safe job -> guard no-ops (ordinary invoicing untouched)", async () => {
  const client = makeClient({ makesafe_job_details: [], jobs: [], job_service_reports: [], job_documents: [] });
  const state = await _loadMakesafeReportIn(client, "patio-99");
  assertEquals(state.isMakesafe, false);
  // must NOT throw for a non-make-safe job
  await _assertMakesafeReportInForInvoice(client, "patio-99");
  await _assertMakesafeReportInForAdvance(client, "patio-99", "ready_to_invoice");
});

Deno.test("reportIn wiring: physical make-safe, NO report -> invoice + advance refused", async () => {
  const client = makeClient({
    makesafe_job_details: [PHYSICAL_DETAIL],
    jobs: [{ id: "job-1", metadata: { makesafe_job_family: "general_makesafe" } }],
    job_service_reports: [],
    job_documents: [],
  });
  const state = await _loadMakesafeReportIn(client, "job-1");
  assertEquals(state.isMakesafe, true);
  assertEquals(state.isReportType, false);
  await assertRejects(() => _assertMakesafeReportInForInvoice(client, "job-1"), Error, "report-in guard");
  await assertRejects(
    () => _assertMakesafeReportInForAdvance(client, "job-1", "ready_to_invoice"),
    Error,
    "report-in guard",
  );
});

Deno.test("reportIn wiring: physical make-safe with a submitted current-cycle report -> allowed", async () => {
  const client = makeClient({
    makesafe_job_details: [PHYSICAL_DETAIL],
    jobs: [{ id: "job-1", metadata: { makesafe_job_family: "general_makesafe" } }],
    job_service_reports: [{ job_id: "job-1", status: "submitted", cycle_number: 1 }],
    job_documents: [],
  });
  await _assertMakesafeReportInForInvoice(client, "job-1"); // no throw
});

Deno.test("reportIn wiring: physical make-safe evidenced by a typed makesafe_report doc -> allowed", async () => {
  const client = makeClient({
    makesafe_job_details: [PHYSICAL_DETAIL],
    jobs: [{ id: "job-1", metadata: { makesafe_job_family: "temp_fence_makesafe" } }],
    job_service_reports: [],
    job_documents: [{ job_id: "job-1", type: "makesafe_report" }],
  });
  await _assertMakesafeReportInForInvoice(client, "job-1"); // no throw
});

Deno.test("reportIn wiring: re-attend cycle 2 with only a cycle-1 report -> refused", async () => {
  const client = makeClient({
    makesafe_job_details: [{ job_id: "job-1", report_type: null, cycle_number: 2 }],
    jobs: [{ id: "job-1", metadata: { makesafe_job_family: "general_makesafe" } }],
    job_service_reports: [{ job_id: "job-1", status: "submitted", cycle_number: 1 }],
    job_documents: [],
  });
  await assertRejects(() => _assertMakesafeReportInForInvoice(client, "job-1"), Error, "cycle 2");
});

Deno.test("reportIn wiring: report-type card -> guard no-ops (portal guard owns it)", async () => {
  const client = makeClient({
    makesafe_job_details: [{ job_id: "job-1", report_type: "roof_report", cycle_number: 1 }],
    jobs: [{ id: "job-1", metadata: {} }],
    job_service_reports: [],
    job_documents: [],
  });
  const state = await _loadMakesafeReportIn(client, "job-1");
  assertEquals(state.isReportType, true);
  await _assertMakesafeReportInForInvoice(client, "job-1"); // no throw (report-type)
});

Deno.test("reportIn wiring: report-family metadata (report_type NULL) is treated as report-type", async () => {
  const client = makeClient({
    makesafe_job_details: [{ job_id: "job-1", report_type: null, cycle_number: 1 }],
    jobs: [{ id: "job-1", metadata: { makesafe_job_family: "roof_report" } }],
    job_service_reports: [],
    job_documents: [],
  });
  const state = await _loadMakesafeReportIn(client, "job-1");
  assertEquals(state.isReportType, true, "roof_report family self-heals to report-type before report_type is set");
  await _assertMakesafeReportInForInvoice(client, "job-1"); // no throw
});

Deno.test("reportIn wiring: advance to a PRE-report substatus is never gated", async () => {
  const client = makeClient({
    makesafe_job_details: [PHYSICAL_DETAIL],
    jobs: [{ id: "job-1", metadata: { makesafe_job_family: "general_makesafe" } }],
    job_service_reports: [],
    job_documents: [],
  });
  // no report, but moving to waiting_on_trade_report is fine (pre-report)
  await _assertMakesafeReportInForAdvance(client, "job-1", "waiting_on_trade_report");
});
