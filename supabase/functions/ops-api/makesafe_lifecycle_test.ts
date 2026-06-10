// Tests for the MakeSafe lifecycle gate:
//  - makesafePipeline surfaces per-job close-out doc booleans (has_*),
//  - an invoiced job WITHOUT invoice+report docs is held pre-complete
//    (report_ready, docs_missing) rather than silently marked completed,
//  - the 7-day completed-vs-archive boundary,
//  - completeAndInvoice's substatus advance for make-safe jobs.
//
// Run: deno test --allow-all --no-check supabase/functions/ops-api/makesafe_lifecycle_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _advanceMakesafeSubstatusOnInvoice,
  _deriveMakesafeBoardStage,
  _isMakesafeCompletedWithin7Days,
  _isMakesafeMlbCompany,
  _makesafeMissingCloseoutDocs,
  _makesafePipelineForTest,
  _updateMakesafeSubstatus,
} from "./index.ts";

// ── Chainable Supabase query stub ──────────────────────────────────────────
// Every builder method returns the same builder; the builder is awaitable and
// resolves to { data, error }. `resultsByTable` maps a table name to the rows
// returned for any query against it (the production code does its own filtering
// in JS on top of these, so we just return the seeded rows per table).
function makeQueryClient(resultsByTable: Record<string, any[]>) {
  function builder(table: string) {
    const rows = resultsByTable[table] || [];
    const result = { data: rows, error: null };
    const b: any = {
      select: () => b,
      eq: () => b,
      neq: () => b,
      not: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      // Thenable so `await client.from(t)...` resolves to { data, error }.
      then: (resolve: (v: any) => any) => resolve(result),
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

const NOW = "2026-06-10T03:00:00Z";

function jobRow(over: Record<string, any> = {}) {
  return {
    id: "job-1",
    job_number: "SWMS-26001",
    type: "makesafe",
    status: "invoiced",
    client_name: "Test Client",
    site_address: "1 Test St",
    metadata: {},
    created_at: "2026-06-08T00:00:00Z",
    updated_at: "2026-06-09T00:00:00Z",
    completed_at: "2026-06-09T00:00:00Z",
    ...over,
  };
}

// ── (a) makesafePipeline surfaces the has_* doc booleans ────────────────────
Deno.test("makesafePipeline surfaces per-job close-out doc booleans", async () => {
  const client = makeQueryClient({
    jobs: [jobRow({ id: "job-1" })],
    makesafe_job_details: [{ job_id: "job-1", substatus: "complete", requesting_company_name: "Acme Restorations" }],
    job_service_reports: [{ job_id: "job-1", status: "submitted", submitted_at: "2026-06-09T00:00:00Z" }],
    xero_invoices: [{ job_id: "job-1", status: "AUTHORISED", invoice_type: "ACCREC", invoice_date: "2026-06-09" }],
    job_documents: [
      { job_id: "job-1", type: "work_order", file_name: "Work Order SWMS-26001.pdf" },
      { job_id: "job-1", type: "general", file_name: "Make Safe Report SWMS-26001.pdf" },
      { job_id: "job-1", type: "general", file_name: "Tax Invoice INV-1234.pdf" },
    ],
    job_assignments: [],
  });

  const res: any = await _makesafePipelineForTest(client, new URLSearchParams());
  const all = Object.values(res.columns).flat() as any[];
  const job = all.find((j: any) => j.id === "job-1");
  assertEquals(job.has_wo, true);
  assertEquals(job.has_report_doc, true);
  assertEquals(job.has_invoice_doc, true);
  // The SWMS-26001 job number prefix must NOT count as a SWMS document.
  assertEquals(job.has_swms_doc, false);
});

Deno.test("makesafeDocBooleans: a real SWMS doc is detected, the job-number prefix is not", async () => {
  const client = makeQueryClient({
    jobs: [jobRow({ id: "job-swms" })],
    makesafe_job_details: [{ job_id: "job-swms", substatus: "complete", requesting_company_name: "Acme" }],
    job_service_reports: [],
    xero_invoices: [{ job_id: "job-swms", status: "AUTHORISED", invoice_type: "ACCREC", invoice_date: "2026-06-09" }],
    job_documents: [
      { job_id: "job-swms", type: "general", file_name: "SWMS Roof Make Safe SWMS-26010.pdf" },
    ],
    job_assignments: [],
  });
  const res: any = await _makesafePipelineForTest(client, new URLSearchParams());
  const job = (Object.values(res.columns).flat() as any[]).find((j: any) => j.id === "job-swms");
  assertEquals(job.has_swms_doc, true);
});

// ── (b) invoiced job WITHOUT invoice+report docs is held pre-complete ───────
Deno.test("makesafePipeline holds an invoiced job with missing docs in report_ready", async () => {
  const client = makeQueryClient({
    jobs: [jobRow({ id: "job-2" })],
    makesafe_job_details: [{ job_id: "job-2", substatus: "complete", requesting_company_name: "Acme Restorations" }],
    job_service_reports: [{ job_id: "job-2", status: "submitted", submitted_at: "2026-06-09T00:00:00Z" }],
    xero_invoices: [{ job_id: "job-2", status: "AUTHORISED", invoice_type: "ACCREC", invoice_date: "2026-06-09" }],
    // No invoice/report PDFs attached.
    job_documents: [{ job_id: "job-2", type: "work_order", file_name: "Work Order SWMS-26002.pdf" }],
    job_assignments: [],
  });

  const res: any = await _makesafePipelineForTest(client, new URLSearchParams());
  // Must NOT land in completed/archive.
  assertEquals(res.columns.completed.length, 0);
  assertEquals(res.columns.archive.length, 0);
  const job = res.columns.report_ready.find((j: any) => j.id === "job-2");
  assertEquals(!!job, true);
  assertEquals(job.board_stage, "report_ready");
  assertEquals(job.docs_missing, true);
  // Both invoice and report PDFs are missing here.
  assertEquals((job.missing_docs || []).includes("invoice"), true);
  assertEquals((job.missing_docs || []).includes("report"), true);
});

Deno.test("makesafePipeline lets an invoiced job with both docs reach completed", async () => {
  const client = makeQueryClient({
    jobs: [jobRow({ id: "job-3", completed_at: NOW })],
    makesafe_job_details: [{ job_id: "job-3", substatus: "complete", requesting_company_name: "Acme Restorations" }],
    job_service_reports: [{ job_id: "job-3", status: "submitted", submitted_at: NOW }],
    xero_invoices: [{ job_id: "job-3", status: "AUTHORISED", invoice_type: "ACCREC", invoice_date: "2026-06-10" }],
    job_documents: [
      { job_id: "job-3", type: "general", file_name: "Make Safe Report SWMS-26003.pdf" },
      { job_id: "job-3", type: "general", file_name: "Tax Invoice INV-3.pdf" },
    ],
    job_assignments: [],
  });

  const res: any = await _makesafePipelineForTest(client, new URLSearchParams());
  const job = res.columns.completed.find((j: any) => j.id === "job-3");
  assertEquals(!!job, true);
  assertEquals(job.docs_missing, false);
});

// ── Gate unit coverage: MLB requires SWMS, non-MLB does not ─────────────────
Deno.test("close-out gate requires SWMS only for MLB jobs", () => {
  const docs = { has_invoice_doc: true, has_report_doc: true, has_swms_doc: false };
  // Non-MLB: invoice + report is enough.
  assertEquals(_makesafeMissingCloseoutDocs(docs, false), []);
  // MLB: SWMS additionally required.
  assertEquals(_makesafeMissingCloseoutDocs(docs, true), ["swms"]);
});

Deno.test("MLB company detected from slug, name, or builder reference", () => {
  assertEquals(_isMakesafeMlbCompany({ requesting_company_slug: "mlb" }, {}), true);
  assertEquals(_isMakesafeMlbCompany({ requesting_company_name: "Major Loss Builders" }, {}), true);
  assertEquals(_isMakesafeMlbCompany({ external_ref: "MLB-25250" }, {}), true);
  assertEquals(_isMakesafeMlbCompany({ requesting_company_name: "Acme Restorations" }, {}), false);
});

Deno.test("MLB job with invoice+report but no SWMS is held in report_ready", () => {
  const stage = _deriveMakesafeBoardStage(
    { status: "invoiced", completed_at: NOW },
    { substatus: "complete", requesting_company_slug: "mlb" },
    [],
    null,
    { status: "AUTHORISED", invoice_date: "2026-06-10" },
    NOW,
    { has_invoice_doc: true, has_report_doc: true, has_swms_doc: false },
  );
  assertEquals(stage, "report_ready");
});

// ── (c) 7-day completed-vs-archive boundary ─────────────────────────────────
Deno.test("MakeSafe completed-vs-archive uses a 7-day window", () => {
  // 6 days ago -> within window.
  assertEquals(_isMakesafeCompletedWithin7Days("2026-06-04T03:00:01Z", NOW), true);
  // Exactly 7 days ago -> outside (>= 7 days archives).
  assertEquals(_isMakesafeCompletedWithin7Days("2026-06-03T03:00:00Z", NOW), false);
  // 10 days ago -> outside.
  assertEquals(_isMakesafeCompletedWithin7Days("2026-05-31T03:00:00Z", NOW), false);
  // Unknown date -> stays in completed (fallback preserved).
  assertEquals(_isMakesafeCompletedWithin7Days(null, NOW), true);
  assertEquals(_isMakesafeCompletedWithin7Days("not-a-date", NOW), true);
});

Deno.test("board stage archives an invoiced+docs job older than 7 days", () => {
  const docs = { has_invoice_doc: true, has_report_doc: true, has_swms_doc: true };
  // Completed 8 days before NOW (uses invoice_date as the completion ts).
  const archived = _deriveMakesafeBoardStage(
    { status: "invoiced" },
    { substatus: "complete", requesting_company_name: "Acme" },
    [],
    null,
    { status: "AUTHORISED", invoice_date: "2026-06-02" },
    NOW,
    docs,
  );
  assertEquals(archived, "archive");
  // Completed 1 day before NOW -> still completed.
  const completed = _deriveMakesafeBoardStage(
    { status: "invoiced" },
    { substatus: "complete", requesting_company_name: "Acme" },
    [],
    null,
    { status: "AUTHORISED", invoice_date: "2026-06-09" },
    NOW,
    docs,
  );
  assertEquals(completed, "completed");
});

// ── (d) completeAndInvoice advances make-safe substatus to complete ─────────
function makeUpdateClient() {
  const updates: any[] = [];
  const inserts: any[] = [];
  const client: any = {
    from(table: string) {
      return {
        update(row: any) {
          updates.push({ table, row });
          return {
            eq() {
              return {
                select() {
                  return {
                    async single() {
                      return { data: { job_id: "job-x", ...row }, error: null };
                    },
                  };
                },
              };
            },
          };
        },
        insert(row: any) {
          inserts.push({ table, row });
          // Realistic PostgREST builder: a thenable (delegates to a real Promise) with NO `.catch`.
          const p = Promise.resolve({ error: null });
          return { then: p.then.bind(p) };
        },
      };
    },
  };
  return { client, updates, inserts };
}

Deno.test("completeAndInvoice advances makesafe substatus to complete", async () => {
  const { client, updates } = makeUpdateClient();
  const advanced = await _advanceMakesafeSubstatusOnInvoice(client, { type: "makesafe" }, "job-x");
  assertEquals(advanced, true);
  const subUpdate = updates.find((u: any) => u.table === "makesafe_job_details");
  assertEquals(!!subUpdate, true);
  assertEquals(subUpdate.row.substatus, "complete");
});

Deno.test("completeAndInvoice does not advance substatus for non-makesafe jobs", async () => {
  const { client, updates } = makeUpdateClient();
  const advanced = await _advanceMakesafeSubstatusOnInvoice(client, { type: "patio" }, "job-y");
  assertEquals(advanced, false);
  assertEquals(updates.length, 0);
});

Deno.test("makesafe substatus advance never throws when the update fails", async () => {
  // Client whose update path throws: the helper must swallow it and return false.
  const client: any = {
    from() {
      return {
        update() {
          return {
            eq() {
              return {
                select() {
                  return {
                    async single() {
                      throw new Error("db down");
                    },
                  };
                },
              };
            },
          };
        },
        insert() {
          return { catch: (_fn: any) => Promise.resolve({ error: null }) };
        },
      };
    },
  };
  const advanced = await _advanceMakesafeSubstatusOnInvoice(client, { type: "makesafe" }, "job-z");
  assertEquals(advanced, false);
});

Deno.test("updateMakesafeSubstatus tolerates a PostgREST insert builder that lacks .catch", async () => {
  // Regression: the real supabase-js insert() returns a thenable that has NO `.catch` method, so
  // `client.from('job_events').insert(...).catch(...)` threw "catch is not a function" AFTER the
  // makesafe_job_details update had already committed — surfacing a spurious 500 on a successful
  // substatus change (and silently defeating advanceMakesafeSubstatusOnInvoice). The event-log
  // insert must be fire-and-forget via `.then().catch()`. This mock reproduces the real builder:
  // a thenable (delegates to a real Promise) with no `.catch`. The OLD code throws here; the fix
  // resolves cleanly with { ok: true }.
  let eventInserted = false;
  const client: any = {
    from(table: string) {
      if (table === "job_events") {
        return {
          insert(_row: any) {
            eventInserted = true;
            const p = Promise.resolve({ error: null });
            return { then: p.then.bind(p) }; // thenable, intentionally NO `.catch`
          },
        };
      }
      return {
        update() {
          return {
            eq() {
              return {
                select() {
                  return {
                    single: async () => ({
                      data: { job_id: "job-a", substatus: "complete" },
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  const res = await _updateMakesafeSubstatus(client, { job_id: "job-a", substatus: "complete" });
  assertEquals(res.ok, true);
  assertEquals(eventInserted, true);
});
