// Tests for the MakeSafe lifecycle gate:
//  - makesafePipeline surfaces per-job close-out doc booleans (has_*),
//  - an issued job without a current DRAFT stays below Docs Ready rather than
//    silently completing or claiming pre-Xero readiness,
//  - the 7-day completed-vs-archive boundary,
//  - completeAndInvoice's substatus advance for make-safe jobs.
//
// Run: deno test --allow-all --no-check supabase/functions/ops-api/makesafe_lifecycle_test.ts
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _advanceMakesafeSubstatusOnInvoice,
  _deriveMakesafeBoardStage,
  _isMakesafeCompletedWithin7Days,
  _isMakesafeMlbCompany,
  _makesafeMissingCloseoutDocs,
  _makesafePipelineForTest,
  _requiresMakesafeSwms,
  _updateMakesafeSubstatus,
} from "./index.ts";
import { internalEvidenceOrigin } from "./makesafe_write_origin.ts";

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
      gte: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      // .range() supports the paginated readers (buildPackSentMap /
      // _fetchAllByJobIdChunked / the paginated jobs query). The seeded set is
      // small (<1000) so we return it all on the first page and [] thereafter so
      // the bounded pagination loop terminates.
      range: async (from: number, _to: number) => ({
        data: from === 0 ? rows : [],
        error: null,
      }),
      // Thenable so `await client.from(t)...` resolves to { data, error }.
      then: (resolve: (v: any) => any) => resolve(result),
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

const NOW = "2026-06-10T03:00:00Z";

// Tests that route through _makesafePipelineForTest exercise the LIVE pipeline,
// which derives completed-vs-archive against the real wall clock (Date.now()) —
// the test NOW constant is NOT threaded into the pipeline path. Fixtures meant to
// represent "invoiced today" must therefore be anchored to the real now so the
// <7-day completed window holds regardless of the calendar date the suite runs on
// (a hard-coded 2026-06-10 silently flips to 'archive' once real-now drifts >7d).
const RECENT_ISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // ~1 day ago
const RECENT_DATE = RECENT_ISO.slice(0, 10); // YYYY-MM-DD for invoice_date

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
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "complete",
      requesting_company_name: "Acme Restorations",
    }],
    job_service_reports: [{
      job_id: "job-1",
      status: "submitted",
      submitted_at: "2026-06-09T00:00:00Z",
    }],
    xero_invoices: [{
      job_id: "job-1",
      status: "AUTHORISED",
      invoice_type: "ACCREC",
      invoice_date: "2026-06-09",
    }],
    job_documents: [
      {
        job_id: "job-1",
        type: "work_order",
        file_name: "Work Order SWMS-26001.pdf",
      },
      {
        job_id: "job-1",
        type: "general",
        file_name: "Make Safe Report SWMS-26001.pdf",
      },
      {
        job_id: "job-1",
        type: "general",
        file_name: "Tax Invoice INV-1234.pdf",
      },
    ],
    job_assignments: [],
  });

  const res: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams(),
  );
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
    makesafe_job_details: [{
      job_id: "job-swms",
      substatus: "complete",
      requesting_company_name: "Acme",
    }],
    job_service_reports: [],
    xero_invoices: [{
      job_id: "job-swms",
      status: "AUTHORISED",
      invoice_type: "ACCREC",
      invoice_date: "2026-06-09",
    }],
    job_documents: [
      {
        job_id: "job-swms",
        type: "general",
        file_name: "SWMS Roof Make Safe SWMS-26010.pdf",
      },
    ],
    job_assignments: [],
  });
  const res: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams(),
  );
  const job = (Object.values(res.columns).flat() as any[]).find((j: any) =>
    j.id === "job-swms"
  );
  assertEquals(job.has_swms_doc, true);
});

// ── (b) issued job WITHOUT a current DRAFT stays below Docs Ready ──────────
Deno.test("makesafePipeline keeps an AUTHORISED report job in trade_report_in", async () => {
  const client = makeQueryClient({
    jobs: [jobRow({ id: "job-2" })],
    makesafe_job_details: [{
      job_id: "job-2",
      substatus: "complete",
      requesting_company_name: "Acme Restorations",
    }],
    job_service_reports: [{
      job_id: "job-2",
      status: "submitted",
      submitted_at: "2026-06-09T00:00:00Z",
    }],
    xero_invoices: [{
      job_id: "job-2",
      status: "AUTHORISED",
      invoice_type: "ACCREC",
      invoice_date: "2026-06-09",
    }],
    // No invoice/report PDFs attached.
    job_documents: [{
      job_id: "job-2",
      type: "work_order",
      file_name: "Work Order SWMS-26002.pdf",
    }],
    job_assignments: [],
  });

  const res: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams(),
  );
  // Must NOT land in completed/archive.
  assertEquals(res.columns.completed.length, 0);
  assertEquals(res.columns.archive.length, 0);
  const job = res.columns.trade_report_in.find((j: any) => j.id === "job-2");
  assertEquals(!!job, true);
  assertEquals(job.board_stage, "trade_report_in");
  assertEquals(job.docs_missing, true);
  assertEquals((job.missing_docs || []).includes("invoice"), true);
  assertEquals((job.missing_docs || []).includes("report"), true);
});

Deno.test("makesafePipeline lets an invoiced job with both docs reach completed", async () => {
  const client = makeQueryClient({
    jobs: [jobRow({ id: "job-3", completed_at: RECENT_ISO })],
    makesafe_job_details: [{
      job_id: "job-3",
      substatus: "complete",
      requesting_company_name: "Acme Restorations",
    }],
    job_service_reports: [{
      job_id: "job-3",
      status: "submitted",
      submitted_at: RECENT_ISO,
    }],
    xero_invoices: [{
      job_id: "job-3",
      status: "AUTHORISED",
      invoice_type: "ACCREC",
      invoice_date: RECENT_DATE,
    }],
    job_documents: [
      {
        job_id: "job-3",
        type: "general",
        file_name: "Make Safe Report SWMS-26003.pdf",
      },
      { job_id: "job-3", type: "general", file_name: "Tax Invoice INV-3.pdf" },
    ],
    job_assignments: [],
  });

  const res: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams(),
  );
  const job = res.columns.completed.find((j: any) => j.id === "job-3");
  assertEquals(!!job, true);
  assertEquals(job.docs_missing, false);
});

// ── Gate unit coverage: MLB requires SWMS, non-MLB does not ─────────────────
Deno.test("close-out gate requires SWMS only for MLB jobs", () => {
  const docs = {
    has_invoice_doc: true,
    has_report_doc: true,
    has_swms_doc: false,
  };
  // Non-MLB: invoice + report is enough.
  assertEquals(_makesafeMissingCloseoutDocs(docs, false), []);
  // MLB: SWMS additionally required.
  assertEquals(_makesafeMissingCloseoutDocs(docs, true), ["swms"]);
});

Deno.test("SWMS requirement follows the sealed MLB physical-family rule", () => {
  const physical = { metadata: { makesafe_job_family: "physical_makesafe" } };
  const roof = { metadata: { makesafe_job_family: "roof_report" } };
  const assessment = {
    metadata: { makesafe_job_family: "assessment_report_quote" },
  };

  assertEquals(
    _requiresMakesafeSwms({ requesting_company_slug: "mlb" }, physical),
    true,
  );
  assertEquals(
    _requiresMakesafeSwms({ requesting_company_slug: "mlb" }, roof),
    false,
  );
  assertEquals(
    _requiresMakesafeSwms({ requesting_company_slug: "mlb" }, assessment),
    false,
  );
  assertEquals(
    _requiresMakesafeSwms({ requesting_company_slug: "builderwest" }, physical),
    false,
  );
});

Deno.test("send preflight and attachment paths share the SWMS requirement", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const start = source.indexOf("async function makesafeSendPack(");
  const end = source.indexOf("\nasync function ", start + 1);
  const sendFunction = source.slice(start, end < 0 ? undefined : end);

  assertStringIncludes(
    sendFunction,
    "const requiresSwms = _requiresMakesafeSwms(detail, job)",
  );
  assertStringIncludes(
    sendFunction,
    "_makesafeMissingCloseoutDocs(docFlags, requiresSwms, isReportJob)",
  );
  assertStringIncludes(sendFunction, "if (requiresSwms) {");
  assertStringIncludes(sendFunction, ": requiresSwms");
  assertEquals(sendFunction.includes("shouldAttachSwms"), false);
});

Deno.test("MLB company detected from slug, name, or builder reference", () => {
  assertEquals(
    _isMakesafeMlbCompany({ requesting_company_slug: "mlb" }, {}),
    true,
  );
  assertEquals(
    _isMakesafeMlbCompany(
      { requesting_company_name: "Major Loss Builders" },
      {},
    ),
    true,
  );
  assertEquals(_isMakesafeMlbCompany({ external_ref: "MLB-25250" }, {}), true);
  assertEquals(
    _isMakesafeMlbCompany({ requesting_company_name: "Acme Restorations" }, {}),
    false,
  );
});

Deno.test("MLB physical job with AUTHORISED invoice but no DRAFT stays allocated", () => {
  const stage = _deriveMakesafeBoardStage(
    {
      status: "invoiced",
      completed_at: NOW,
      metadata: { makesafe_job_family: "physical_makesafe" },
    },
    { substatus: "complete", requesting_company_slug: "mlb" },
    [],
    null,
    { status: "AUTHORISED", invoice_date: "2026-06-10" },
    NOW,
    { has_invoice_doc: true, has_report_doc: true, has_swms_doc: false },
  );
  assertEquals(stage, "allocated");
});

Deno.test("MLB report-only and non-MLB jobs are not held for missing SWMS", () => {
  const completeDocsWithoutSwms = {
    has_invoice_doc: true,
    has_report_doc: true,
    has_swms_doc: false,
  };
  const invoice = { status: "AUTHORISED", invoice_date: "2026-06-10" };

  const mlbRoof = _deriveMakesafeBoardStage(
    {
      status: "invoiced",
      completed_at: NOW,
      metadata: { makesafe_job_family: "roof_report" },
    },
    {
      substatus: "complete",
      requesting_company_slug: "mlb",
      report_type: "roof",
    },
    [],
    null,
    invoice,
    NOW,
    completeDocsWithoutSwms,
  );
  const mlbAssessment = _deriveMakesafeBoardStage(
    {
      status: "invoiced",
      completed_at: NOW,
      metadata: { makesafe_job_family: "assessment_report_quote" },
    },
    {
      substatus: "complete",
      requesting_company_slug: "mlb",
      report_type: "assessment",
    },
    [],
    null,
    invoice,
    NOW,
    completeDocsWithoutSwms,
  );
  const nonMlb = _deriveMakesafeBoardStage(
    {
      status: "invoiced",
      completed_at: NOW,
      metadata: { makesafe_job_family: "physical_makesafe" },
    },
    { substatus: "complete", requesting_company_slug: "builderwest" },
    [],
    null,
    invoice,
    NOW,
    completeDocsWithoutSwms,
  );

  assertEquals(mlbRoof, "completed");
  assertEquals(mlbAssessment, "completed");
  assertEquals(nonMlb, "completed");
});

// ── (c) 7-day completed-vs-archive boundary ─────────────────────────────────
Deno.test("MakeSafe completed-vs-archive uses a 7-day window", () => {
  // 6 days ago -> within window.
  assertEquals(
    _isMakesafeCompletedWithin7Days("2026-06-04T03:00:01Z", NOW),
    true,
  );
  // Exactly 7 days ago -> outside (>= 7 days archives).
  assertEquals(
    _isMakesafeCompletedWithin7Days("2026-06-03T03:00:00Z", NOW),
    false,
  );
  // 10 days ago -> outside.
  assertEquals(
    _isMakesafeCompletedWithin7Days("2026-05-31T03:00:00Z", NOW),
    false,
  );
  // Unknown date -> stays in completed (fallback preserved).
  assertEquals(_isMakesafeCompletedWithin7Days(null, NOW), true);
  assertEquals(_isMakesafeCompletedWithin7Days("not-a-date", NOW), true);
});

Deno.test("board stage archives an invoiced+docs job older than 7 days", () => {
  const docs = {
    has_invoice_doc: true,
    has_report_doc: true,
    has_swms_doc: true,
  };
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
  const advanced = await _advanceMakesafeSubstatusOnInvoice(client, {
    type: "makesafe",
  }, "job-x");
  assertEquals(advanced, true);
  const subUpdate = updates.find((u: any) =>
    u.table === "makesafe_job_details"
  );
  assertEquals(!!subUpdate, true);
  assertEquals(subUpdate.row.substatus, "complete");
});

Deno.test("completeAndInvoice does not advance substatus for non-makesafe jobs", async () => {
  const { client, updates } = makeUpdateClient();
  const advanced = await _advanceMakesafeSubstatusOnInvoice(client, {
    type: "patio",
  }, "job-y");
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
  const advanced = await _advanceMakesafeSubstatusOnInvoice(client, {
    type: "makesafe",
  }, "job-z");
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
  // Rescue SES T2: pass an internal source so the external evidence guards
  // (which need a fuller client mock) stay out of the way — the regression
  // under test is the event-insert idiom, which runs on every source.
  const res = await _updateMakesafeSubstatus(client, {
    job_id: "job-a",
    substatus: "complete",
  }, { origin: internalEvidenceOrigin("event_insert_regression") });
  assertEquals(res.ok, true);
  assertEquals(eventInserted, true);
});
