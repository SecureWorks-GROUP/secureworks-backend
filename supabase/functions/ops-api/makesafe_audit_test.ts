// Tests for the make-safe token-efficiency Phase 2 backend changes:
//  - pack_sent surfaced + verified-sent board-gate softening (items 2.2 / 2.3),
//  - sw_makesafe_audit compact reader: jobs[] + known_refs[] (item 2.1),
//  - audit-mode full invoice list incl. VOIDED/DELETED + match_tier (item 2.4).
//
// Run: deno test --allow-all --no-check supabase/functions/ops-api/makesafe_audit_test.ts
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _deriveMakesafeBoardStage,
  _makesafeAuditForTest,
  _makesafePipelineForTest,
  _prepareMakesafeInvoiceRefsForTest,
  _resolveMakesafeJobInvoicesForTest,
} from "./index.ts";
import { IN_URL_BUDGET } from "./makesafe_compact_reads.ts";

const NOW = "2026-06-10T03:00:00Z";

// _makesafePipelineForTest runs the LIVE pipeline, which derives completed-vs-archive
// against the real wall clock (Date.now()), not the NOW constant. Fixtures meant to
// represent "invoiced today / completed today" are anchored to the real now so the
// <7-day completed window holds whatever calendar date the suite runs on. A hard-coded
// 2026-06-10 invoice_date silently flips a verified-sent job to 'archive' once real-now
// drifts more than 7 days past it (the suite was authored when now was within that window).
const RECENT_ISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // ~1 day ago
const RECENT_DATE = RECENT_ISO.slice(0, 10); // YYYY-MM-DD for invoice_date

// ── Chainable query stub (extends the makesafe_lifecycle pattern) ──
// Every builder method returns the same builder; awaiting it resolves to
// { data: rows, error: null }. Unlike the lifecycle stub, this one APPLIES the
// .eq()/.in() predicates so a table queried twice with different filters (e.g.
// makesafe_intake_drafts: pending vs approved) returns the correct subset —
// matching real PostgREST behaviour, which makesafeAudit relies on.
type InCall = { table: string; column: string; values: any[]; encodedBytes: number };
type OrderCall = { table: string; column: string; ascending: boolean };
type QueryClientOptions = {
  maxInEncodedBytes?: number;
  forceInErrorTables?: Set<string>;
  inCalls?: InCall[];
  orderCalls?: OrderCall[];
};

function encodedInBytes(values: any[]): number {
  return values.reduce((total, value) => total + encodeURIComponent(String(value)).length + 1, 0);
}

function makeQueryClient(
  resultsByTable: Record<string, any[]>,
  options: QueryClientOptions = {},
) {
  function builder(table: string) {
    const rows = (resultsByTable[table] || []).slice();
    const preds: Array<(r: any) => boolean> = [];
    let rowLimit: number | null = null;
    let queryError: { message: string } | null = null;
    const filteredRows = () => {
      const filtered = rows.filter((r) => preds.every((p) => p(r)));
      return rowLimit == null ? filtered : filtered.slice(0, rowLimit);
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
        const encodedBytes = encodedInBytes(vals);
        options.inCalls?.push({ table, column: col, values: vals.slice(), encodedBytes });
        if (options.forceInErrorTables?.has(table)) {
          queryError = { message: `forced ${table} join failure` };
        } else if (
          options.maxInEncodedBytes != null && encodedBytes > options.maxInEncodedBytes
        ) {
          queryError = {
            message: `${table}.${col} encoded .in() list is ${encodedBytes} bytes ` +
              `(budget ${options.maxInEncodedBytes})`,
          };
        }
        preds.push((r) => vals.includes(r?.[col]));
        return b;
      },
      gte: (col: string, val: any) => {
        preds.push((r) => r?.[col] >= val);
        return b;
      },
      // Records the ORDER BY key chain per table. .range() is LIMIT/OFFSET, so a
      // paginated read is only page-stable when its last order key is unique.
      order: (col: string, opts?: { ascending?: boolean }) => {
        options.orderCalls?.push({ table, column: col, ascending: opts?.ascending !== false });
        return b;
      },
      limit: (count: number) => {
        rowLimit = count;
        return b;
      },
      // Paginated read terminal (fetchAllRows): applies the recorded predicates
      // then returns rows in [from, to] inclusive (real PostgREST .range()).
      range: async (from: number, to: number) => {
        if (queryError) return { data: null, error: queryError };
        return { data: filteredRows().slice(from, to + 1), error: null };
      },
      then: (resolve: (v: any) => any) => {
        if (queryError) return resolve({ data: null, error: queryError });
        return resolve({ data: filteredRows(), error: null });
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

function jobRow(over: Record<string, any> = {}) {
  return {
    id: "job-1",
    job_number: "SWMS-26001",
    type: "makesafe",
    status: "invoiced",
    client_name: "Test Client",
    site_address: "1 Test St",
    site_lat: -31.95,
    site_lng: 115.86,
    metadata: {},
    created_at: "2026-06-08T00:00:00Z",
    updated_at: "2026-06-09T00:00:00Z",
    completed_at: "2026-06-09T00:00:00Z",
    ...over,
  };
}

function volumeSeed(count: number): Record<string, any[]> {
  const jobs: any[] = [];
  const details: any[] = [];
  const documents: any[] = [];
  const reports: any[] = [];
  for (let i = 0; i < count; i++) {
    const suffix = String(i).padStart(12, "0");
    const jobId = `00000000-0000-4000-8000-${suffix}`;
    jobs.push(jobRow({
      id: jobId,
      job_number: `SWMS-${String(30000 + i)}`,
      status: "pending",
      completed_at: null,
    }));
    details.push({
      job_id: jobId,
      external_ref: `AJBR-${String(70000 + i)}`,
      requesting_company_name: "AJ Grant Building",
      requesting_company_slug: "aj-grant",
      substatus: "company_contact_required",
    });
    documents.push(
      { job_id: jobId, type: "work_order", file_name: `WO-${i}.pdf` },
      { job_id: jobId, type: "makesafe_report", file_name: `REPORT-${i}.pdf` },
      { job_id: jobId, type: "invoice", file_name: `INV-${i}.pdf` },
      { job_id: jobId, type: "swms", file_name: `SWMS document ${i}.pdf` },
    );
    reports.push({ job_id: jobId, status: "submitted", submitted_at: NOW });
  }
  return {
    jobs,
    makesafe_job_details: details,
    job_documents: documents,
    job_service_reports: reports,
    xero_invoices: [],
    makesafe_intake_drafts: [],
    makesafe_report_packs: [],
    job_assignments: [],
    job_events: [],
    pipeline_items: [],
    makesafe_card_story: [],
  };
}

// The MAKESAFE_PACK_SENT | main marker note row.
function packSentNote(jobId: string) {
  return {
    job_id: jobId,
    event_type: "note",
    detail_json: {
      text:
        "MAKESAFE_PACK_SENT | main | INV-1 | to=builder@x.com | 2026-06-09T00:00:00Z | msgid=abc",
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Item 2.3 — board-gate fix (pure derivation tests)
// ─────────────────────────────────────────────────────────────────

Deno.test("2.3 sent+invoiced(authorised)+complete+missing-report → completed (soft warning, not held)", () => {
  const stage = _deriveMakesafeBoardStage(
    jobRow({ completed_at: NOW }),
    { substatus: "complete" },
    [],
    null,
    { status: "AUTHORISED", invoice_date: "2026-06-10" },
    NOW,
    { has_invoice_doc: true, has_report_doc: false, has_swms_doc: false }, // report missing
    true, // pack_sent
  );
  assertEquals(stage, "completed");
});

Deno.test("2.3 sent+invoiced+complete+missing-SWMS (MLB) → completed (soft warning, not held)", () => {
  const stage = _deriveMakesafeBoardStage(
    jobRow({ completed_at: NOW }),
    { substatus: "complete", external_ref: "MLB-25250" },
    [],
    null,
    { status: "AUTHORISED", invoice_date: "2026-06-10" },
    NOW,
    { has_invoice_doc: true, has_report_doc: true, has_swms_doc: false }, // SWMS missing on an MLB job
    true,
  );
  assertEquals(stage, "completed");
});

Deno.test("2.3 NOT-sent+missing-report → still HELD in report_ready (hard gate stays)", () => {
  const stage = _deriveMakesafeBoardStage(
    jobRow({ completed_at: NOW }),
    { substatus: "complete" },
    [],
    null,
    { status: "AUTHORISED", invoice_date: "2026-06-10" },
    NOW,
    { has_invoice_doc: true, has_report_doc: false, has_swms_doc: false },
    false, // NOT sent
  );
  assertEquals(stage, "report_ready");
});

Deno.test("2.3 pack_sent alone (DRAFT invoice, not authorised) does NOT soften the gate", () => {
  // Guardrail: pack_sent must coincide with an AUTHORISED invoice + substatus
  // complete to relax the gate. A draft-only invoice keeps the hard hold.
  const stage = _deriveMakesafeBoardStage(
    jobRow({ status: "complete", completed_at: NOW }),
    { substatus: "complete" },
    [],
    null,
    { status: "DRAFT", invoice_date: "2026-06-10" }, // not authorised
    NOW,
    { has_invoice_doc: false, has_report_doc: false, has_swms_doc: false },
    true, // pack_sent true but invoice is only DRAFT
  );
  // No active invoice (DRAFT is not "active" for hasActiveMakesafeInvoice? it is
  // non-void, so invoiceDone is true) — but verifiedSent is false (not AUTHORISED),
  // so the hard gate holds it.
  assertEquals(stage, "report_ready");
});

// ─────────────────────────────────────────────────────────────────
// Item 2.2 — pack_sent surfaced through makesafePipeline + soft docs_warning
// ─────────────────────────────────────────────────────────────────

Deno.test("2.2 makesafePipeline surfaces pack_sent and a verified-sent job completes with docs_warning", async () => {
  const client = makeQueryClient({
    jobs: [jobRow({ id: "job-sent", completed_at: RECENT_ISO })],
    makesafe_job_details: [{
      job_id: "job-sent",
      substatus: "complete",
      requesting_company_name: "Acme Restorations",
    }],
    job_service_reports: [{
      job_id: "job-sent",
      status: "submitted",
      submitted_at: RECENT_ISO,
    }],
    xero_invoices: [{
      job_id: "job-sent",
      status: "AUTHORISED",
      invoice_type: "ACCREC",
      invoice_date: RECENT_DATE,
    }],
    // invoice attached, but report PDF missing → soft warning on a sent job.
    job_documents: [{
      job_id: "job-sent",
      type: "general",
      file_name: "Tax Invoice INV-9.pdf",
    }],
    job_assignments: [],
    job_events: [packSentNote("job-sent")],
  });
  const res: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams(),
  );
  const job = (Object.values(res.columns).flat() as any[]).find((j: any) =>
    j.id === "job-sent"
  );
  assert(job, "job present");
  assertEquals(job.pack_sent, true);
  assertEquals(job.board_stage, "completed");
  assertEquals(job.docs_missing, false); // not a hard hold
  assertEquals(job.docs_warning, true); // surfaced as a soft warning
  assert((job.warning_docs || []).includes("report"));
});

Deno.test("2.2 an un-sent invoiced job with missing docs stays a HARD hold (docs_missing), pack_sent false", async () => {
  const client = makeQueryClient({
    jobs: [jobRow({ id: "job-held" })],
    makesafe_job_details: [{
      job_id: "job-held",
      substatus: "complete",
      requesting_company_name: "Acme Restorations",
    }],
    job_service_reports: [{
      job_id: "job-held",
      status: "submitted",
      submitted_at: NOW,
    }],
    xero_invoices: [{
      job_id: "job-held",
      status: "AUTHORISED",
      invoice_type: "ACCREC",
      invoice_date: "2026-06-09",
    }],
    job_documents: [{
      job_id: "job-held",
      type: "work_order",
      file_name: "Work Order SWMS-26002.pdf",
    }],
    job_assignments: [],
    job_events: [], // no pack-sent marker
  });
  const res: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams(),
  );
  const job = res.columns.report_ready.find((j: any) => j.id === "job-held");
  assert(job, "held in report_ready");
  assertEquals(job.pack_sent, false);
  assertEquals(job.docs_missing, true);
  assertEquals(job.docs_warning, false);
  assert((job.missing_docs || []).includes("invoice"));
  assert((job.missing_docs || []).includes("report"));
});

// ─────────────────────────────────────────────────────────────────
// Item 2.4 — audit-mode full invoice list (incl. VOIDED/DELETED + match_tier)
// ─────────────────────────────────────────────────────────────────

Deno.test("2.4 duplicate-invoice still surfaced (two live invoices on one job)", () => {
  const rows = [
    {
      job_id: "j1",
      status: "AUTHORISED",
      invoice_number: "INV-1",
      reference: "AJBR 67457",
    },
    {
      job_id: "j1",
      status: "AUTHORISED",
      invoice_number: "INV-2",
      reference: "AJBR 67457",
    },
  ];
  const inv = _resolveMakesafeJobInvoicesForTest(rows, "j1", "AJBR-67457");
  assertEquals(inv.length, 2); // BOTH surface — the duplicate shows
  assertEquals(inv.every((i: any) => i.match_tier === "job_id"), true);
});

Deno.test("2.4 void-history still surfaced (deleted + voided + authorised all returned)", () => {
  const rows = [
    {
      job_id: "j2",
      status: "AUTHORISED",
      invoice_number: "INV-A",
      reference: "WB68926",
    },
    {
      job_id: "j2",
      status: "VOIDED",
      invoice_number: "INV-B",
      reference: "WB68926",
    },
    {
      job_id: "j2",
      status: "DELETED",
      invoice_number: "INV-C",
      reference: "WB68926",
    },
  ];
  const inv = _resolveMakesafeJobInvoicesForTest(rows, "j2", "WB68926");
  assertEquals(inv.length, 3); // void history is NOT collapsed away
  const byStatus = Object.fromEntries(
    inv.map((i: any) => [i.status, i.voided]),
  );
  assertEquals(byStatus["AUTHORISED"], false);
  assertEquals(byStatus["VOIDED"], true);
  assertEquals(byStatus["DELETED"], true);
});

Deno.test("2.4 reference + substring tiers tag correctly; <5-char ref does not substring-match", () => {
  const rows = [
    {
      job_id: null,
      status: "AUTHORISED",
      invoice_number: "INV-X",
      reference: "AJBR 67248",
    },
  ];
  // exact (normalised) reference match
  assertEquals(
    _resolveMakesafeJobInvoicesForTest(rows, "nojob", "ajbr67248")[0]
      .match_tier,
    "reference",
  );
  // substring (bare digits inside the ref)
  assertEquals(
    _resolveMakesafeJobInvoicesForTest(rows, "nojob", "67248")[0].match_tier,
    "reference_substring",
  );
  // short token (<5 chars) must NOT substring-match
  assertEquals(
    _resolveMakesafeJobInvoicesForTest(rows, "nojob", "672").length,
    0,
  );
});

// The whole-board audit resolves EVERY job against EVERY ACCREC invoice, so the
// reference normalisation is hoisted to one pass per read. Prove the hoisted keys
// are byte-identical in effect to normalising inside the loop (and that a short /
// absent key list still falls back per row rather than silently losing a match).
Deno.test("2.4 hoisted invoice reference keys resolve identically to per-row normalisation", () => {
  const rows = [
    { job_id: "j1", status: "AUTHORISED", invoice_number: "INV-1", reference: "AJBR 67457" },
    { job_id: null, status: "PAID", invoice_number: "INV-2", reference: "Job AJBR-67457 makesafe" },
    { job_id: "other", status: "VOIDED", invoice_number: "INV-3", reference: null },
  ];
  const keys = _prepareMakesafeInvoiceRefsForTest(rows);
  assertEquals(keys, ["ajbr67457", "jobajbr67457makesafe", ""]);

  const cases: Array<[string | null, string | null]> = [
    ["j1", "AJBR-67457"],
    ["nojob", "67457"],
    ["nojob", null],
    ["j1", null],
    [null, "ajbr67457"],
  ];
  for (const [jobId, ref] of cases) {
    const hoisted = _resolveMakesafeJobInvoicesForTest(rows, jobId, ref, keys);
    assertEquals(hoisted, _resolveMakesafeJobInvoicesForTest(rows, jobId, ref));
    // A truncated key list must recompute the missing rows, never drop them.
    assertEquals(hoisted, _resolveMakesafeJobInvoicesForTest(rows, jobId, ref, keys.slice(0, 1)));
  }
  assertEquals(
    _resolveMakesafeJobInvoicesForTest(rows, "j1", "AJBR-67457", keys)
      .map((m: any) => m.match_tier),
    ["job_id", "reference_substring"],
  );
});

// ─────────────────────────────────────────────────────────────────
// Item 2.1 — sw_makesafe_audit jobs[] + known_refs[] shape
// ─────────────────────────────────────────────────────────────────

async function assertWholeBoardVolume(count: number) {
  const inCalls: InCall[] = [];
  const seed = volumeSeed(count);
  const client = makeQueryClient(seed, {
    // Reproduce the live gateway constraint: the old single 392/500 UUID joins
    // fail here. Every repaired job-scoped read must stay within this budget.
    maxInEncodedBytes: IN_URL_BUDGET,
    inCalls,
  });

  const audit: any = await _makesafeAuditForTest(client, new URLSearchParams());
  const fallback: any = await _makesafePipelineForTest(client, new URLSearchParams());
  const fallbackJobs = Object.values(fallback.columns).flat() as any[];
  const fallbackById = new Map(fallbackJobs.map((row: any) => [row.id, row]));

  assertEquals(audit.jobs.length, count, "whole audit must return every job");
  assertEquals(fallbackJobs.length, count, "fallback board must return every job");
  assertEquals(
    audit.jobs.map((row: any) => row.job_id).sort(),
    fallbackJobs.map((row: any) => row.id).sort(),
    "whole audit and fallback board ids must reconcile",
  );
  for (const auditRow of audit.jobs) {
    const fallbackRow = fallbackById.get(auditRow.job_id);
    assert(fallbackRow, `fallback row ${auditRow.job_id} present`);
    assertEquals(
      auditRow.substatus,
      fallbackRow.substatus,
      `substatus reconciles for ${auditRow.job_id}`,
    );
    for (const flag of ["has_wo", "has_report_doc", "has_invoice_doc", "has_swms_doc"]) {
      assertEquals(auditRow[flag], true, `${flag} populated for ${auditRow.job_id}`);
      assertEquals(
        auditRow[flag],
        fallbackRow[flag],
        `${flag} reconciles for ${auditRow.job_id}`,
      );
    }
  }
  assert(inCalls.length > 3, "volume fixture must exercise chunked joins");
  assert(
    inCalls.every((call) => call.encodedBytes <= IN_URL_BUDGET),
    "no issued .in() join may exceed the encoded URL budget",
  );
}

for (const count of [392, 500]) {
  Deno.test(`2.1 makesafeAudit ${count}-row whole board keeps substatuses and documents complete`, async () => {
    await assertWholeBoardVolume(count);
  });
}

Deno.test("2.1 makesafeAudit paginates above the legacy 500-job cap", async () => {
  const count = 501;
  const client = makeQueryClient(volumeSeed(count), {
    maxInEncodedBytes: IN_URL_BUDGET,
  });
  const audit: any = await _makesafeAuditForTest(client, new URLSearchParams());
  assertEquals(audit.jobs.length, count);
  assertEquals(audit.jobs.every((row: any) => row.substatus != null), true);
  assertEquals(audit.jobs.every((row: any) => row.has_wo === true), true);
});

// .range() pagination is LIMIT/OFFSET: two pages of the SAME query are only
// guaranteed to partition the rows when the ORDER BY is a TOTAL order. A
// non-unique sort key (invoice_date, or no ORDER BY at all) lets a tied row land
// on neither page — a dropped job_documents row reads as has_wo=false, a dropped
// invoice reads as uninvoiced. Every paginated audit read must therefore END on a
// unique key: `id`, or `job_id` for the two tables keyed BY the job id (they have
// no `id` column at all, so ordering by `id` there would be a PostgREST 400).
const AUDIT_PAGE_TIE_BREAKER: Record<string, string> = {
  jobs: "id",
  makesafe_job_details: "job_id",
  makesafe_card_story: "job_id",
  job_documents: "id",
  job_service_reports: "id",
  job_events: "id",
  xero_invoices: "id",
  makesafe_intake_drafts: "id",
};

Deno.test("2.1 every paginated makesafe_audit read ends on a unique page tie-breaker", async () => {
  const orderCalls: OrderCall[] = [];
  const seed = volumeSeed(3);
  const firstJobId = seed.jobs[0].id;
  seed.xero_invoices = [{
    job_id: firstJobId,
    status: "AUTHORISED",
    invoice_number: "INV-1",
    reference: "AJBR-70000",
    invoice_type: "ACCREC",
    invoice_date: RECENT_DATE,
  }];
  seed.makesafe_intake_drafts = [
    {
      external_ref: "AJBR-79999",
      graph_message_id: "msg-pending",
      internet_message_id: null,
      status: "needs_review",
      approved_job_id: null,
    },
    {
      external_ref: "AJBR-70000",
      graph_message_id: "msg-approved",
      internet_message_id: null,
      status: "approved",
      approved_job_id: firstJobId,
    },
  ];
  seed.makesafe_card_story = [{
    job_id: firstJobId,
    story_verdict: "OK",
    needs_agent: false,
    recheck_enqueued: false,
    evidence_gaps: [],
    blockers: [],
    computed_at: NOW,
  }];

  await _makesafeAuditForTest(makeQueryClient(seed, { orderCalls }), new URLSearchParams());

  const keysFor = (table: string) =>
    orderCalls.filter((c) => c.table === table).map((c) => c.column);
  for (const [table, tieBreaker] of Object.entries(AUDIT_PAGE_TIE_BREAKER)) {
    const keys = keysFor(table);
    assert(keys.length > 0, `${table} read must be explicitly ordered`);
    assertEquals(keys.at(-1), tieBreaker, `${table} must end its ORDER BY on ${tieBreaker}`);
  }
  // The two job-keyed tables carry no `id` column — ordering by it would 400.
  assertEquals(keysFor("makesafe_job_details").includes("id"), false);
  assertEquals(keysFor("makesafe_card_story").includes("id"), false);
  // Sort semantics preserved: newest-first jobs and newest-first invoices, with
  // the PK only breaking ties (_resolveLiveMakesafeInvoice relies on that order).
  assertEquals(keysFor("jobs"), ["created_at", "id"]);
  assertEquals(keysFor("xero_invoices"), ["invoice_date", "id"]);
  assertEquals(
    orderCalls.filter((c) => c.table === "xero_invoices").every((c) => c.ascending === false),
    true,
  );
});

Deno.test("2.1 makesafeAudit rejects a required join failure instead of returning partial rows", async () => {
  const client = makeQueryClient(volumeSeed(3), {
    forceInErrorTables: new Set(["job_documents"]),
  });
  await assertRejects(
    () => _makesafeAuditForTest(client, new URLSearchParams()),
    Error,
    "job_documents (job_id join) failed: forced job_documents join failure",
  );
});

Deno.test("2.1 makesafeAudit returns compact jobs[] with raw substatus, doc booleans, distinct invoice statuses, generated_at", async () => {
  const client = makeQueryClient({
    jobs: [
      jobRow({
        id: "j-aud",
        job_number: "SWMS-24981",
        status: "complete",
        site_lat: null,
        site_lng: null,
      }),
    ],
    makesafe_job_details: [
      {
        job_id: "j-aud",
        external_ref: "MLB-24981",
        requesting_company_name: "Major Loss Builders",
        requesting_company_slug: "mlb",
        substatus: "pending_allocation",
      },
    ],
    job_documents: [
      {
        job_id: "j-aud",
        type: "work_order",
        file_name: "Work Order SWMS-24981.pdf",
      },
    ],
    job_service_reports: [],
    // Duplicate authorised invoices on the same job — both must surface.
    xero_invoices: [
      {
        job_id: "j-aud",
        status: "AUTHORISED",
        invoice_number: "INV-0324",
        reference: "MLB-24981",
        invoice_type: "ACCREC",
        invoice_date: "2026-06-09",
      },
      {
        job_id: "j-aud",
        status: "VOIDED",
        invoice_number: "INV-0300",
        reference: "MLB-24981",
        invoice_type: "ACCREC",
        invoice_date: "2026-06-01",
      },
    ],
    makesafe_intake_drafts: [],
  });
  const res: any = await _makesafeAuditForTest(client, new URLSearchParams());
  assert(typeof res.generated_at === "string");
  assertEquals(res.jobs.length, 1);
  const j = res.jobs[0];
  assertEquals(j.external_ref, "MLB-24981");
  assertEquals(j.substatus, "pending_allocation"); // RAW (not normalised)
  assertEquals(j.substatus_legacy, true); // board-truth convenience flag
  assertEquals(j.geocoded, false); // both lat/lng null
  assertEquals(j.has_wo, true);
  assertEquals(j.has_report_doc, false);
  assertEquals(j.has_invoice_doc, false); // no invoice PDF attached (board-lie case)
  assertEquals(j.has_report_record, false);
  // invoice_status = comma-joined DISTINCT statuses → duplicates/void history SHOW.
  assert(j.invoice_status.includes("AUTHORISED"));
  assert(j.invoice_status.includes("VOIDED"));
  // full mapped list incl. voided.
  assertEquals(j.invoices.length, 2);
  assert(j.invoices.some((i: any) => i.voided === true));
});

// has_report_record must count a typed job_documents row (type='makesafe_report')
// as a filed report — the close-out skill files reports via attach_makesafe_document
// (M3 typed-doc path) and never writes a job_service_reports row. Without this OR
// every report the skill produces reads as missing. (SWMS-26582 MLB-20773
// Mirrabooka, SWMS-26584 AJBR-67713 Ferndale are real jobs in this exact state.)
Deno.test("2.1 has_report_record is TRUE for a typed makesafe_report doc with no job_service_reports row", async () => {
  const client = makeQueryClient({
    jobs: [jobRow({ id: "j-rep", job_number: "SWMS-26582", status: "complete" })],
    makesafe_job_details: [
      {
        job_id: "j-rep",
        external_ref: "MLB-20773",
        requesting_company_name: "Major Loss Builders",
        requesting_company_slug: "mlb",
        substatus: "complete",
      },
    ],
    job_documents: [
      // The skill-filed report: a typed makesafe_report doc whose file_name does
      // NOT contain "make safe report" (so the heuristic has_report_doc may miss
      // it, but the typed-OR must still mark the record present).
      {
        job_id: "j-rep",
        type: "makesafe_report",
        file_name: "SWMS-26582 completion.pdf",
      },
    ],
    job_service_reports: [], // no record row at all — the bug case
    xero_invoices: [],
    makesafe_intake_drafts: [],
  });
  const res: any = await _makesafeAuditForTest(client, new URLSearchParams());
  const j = res.jobs[0];
  assertEquals(j.has_report_record, true); // typed doc counts as a filed report
});

Deno.test("2.1 has_report_record stays FALSE with neither a report row nor a makesafe_report doc", async () => {
  const client = makeQueryClient({
    jobs: [jobRow({ id: "j-none", job_number: "SWMS-27000", status: "complete" })],
    makesafe_job_details: [
      { job_id: "j-none", external_ref: "MLB-27000", substatus: "complete" },
    ],
    // Only a work-order doc and an unrelated invoice doc — neither is a report.
    job_documents: [
      { job_id: "j-none", type: "work_order", file_name: "Work Order SWMS-27000.pdf" },
      { job_id: "j-none", type: "invoice", file_name: "INV-9999 invoice.pdf" },
    ],
    job_service_reports: [],
    xero_invoices: [],
    makesafe_intake_drafts: [],
  });
  const res: any = await _makesafeAuditForTest(client, new URLSearchParams());
  const j = res.jobs[0];
  assertEquals(j.has_report_record, false); // no signal → still false (no false positive)
});

Deno.test("2.1 known_refs[] unions jobs (with source_email_id from the approved draft) and pending drafts", async () => {
  const client = makeQueryClient({
    jobs: [jobRow({ id: "j-live", job_number: "SWMS-30001" })],
    makesafe_job_details: [{
      job_id: "j-live",
      external_ref: "AJBR-67457",
      substatus: "complete",
    }],
    job_documents: [],
    job_service_reports: [],
    xero_invoices: [],
    // One pending draft (no job yet) + one approved draft linked to j-live (gives j-live its email id).
    makesafe_intake_drafts: [
      {
        external_ref: "AJBR-67999",
        graph_message_id: "EMAIL-NEW",
        status: "needs_review",
        approved_job_id: null,
      },
      {
        external_ref: "AJBR-67457",
        graph_message_id: "EMAIL-LIVE",
        status: "approved",
        approved_job_id: "j-live",
      },
    ],
  });
  const res: any = await _makesafeAuditForTest(client, new URLSearchParams());
  const refs = res.known_refs;
  // job ref carries source_email_id recovered from the approved draft.
  const liveRef = refs.find((r: any) => r.job_number === "SWMS-30001");
  assert(liveRef, "job ref present");
  assertEquals(liveRef.external_ref, "AJBR-67457");
  assertEquals(liveRef.source_email_id, "EMAIL-LIVE");
  // pending draft contributes a job_number: null ref with its email id.
  const draftRef = refs.find((r: any) =>
    r.job_number === null && r.external_ref === "AJBR-67999"
  );
  assert(draftRef, "pending draft ref present");
  assertEquals(draftRef.source_email_id, "EMAIL-NEW");
  assertEquals(draftRef.substatus, null);
});

// ─────────────────────────────────────────────────────────────────
// W2-D — invoice-bleed fix. The audit jobs[] row must resolve THIS card's
// invoice fields (invoice_status / invoice_no / live_invoice_* / invoices[])
// STRICTLY by job_id. When two cards share an external_ref (a make-safe + its
// roof-report / assessment sibling on the same property), a ref/substring
// match must NEVER let one card inherit the other's invoice — an uninvoiced
// card must read as uninvoiced, and the shared-ref invoice is surfaced under
// sibling_invoices only (fails OBVIOUS, not silent).
// Proven live bleed cases (2026-07-07 whole-board run, sw_job_detail cross-reads):
//   MLB-25387, MLB-25911, MLB-26072 (sibling INV-0844),
//   MLB-26122 (sibling PAID INV-0851 shown on an uninvoiced roof-report card).
// ─────────────────────────────────────────────────────────────────

// Two make-safe cards sharing one builder ref; exactly ONE invoice, linked by
// job_id to card A. Card B (the uninvoiced sibling) must NOT inherit it.
// Parametrised over three of the four proven refs (exact-reference tier).
for (
  const c of [
    { ref: "MLB-26122", inv: "INV-0851", status: "PAID" }, //  PAID bleed onto a roof-report card
    { ref: "MLB-26072", inv: "INV-0844", status: "AUTHORISED" },
    { ref: "MLB-25387", inv: "INV-0777", status: "AUTHORISED" },
  ]
) {
  Deno.test(`W2-D ${c.ref}: uninvoiced sibling does NOT inherit ${c.status} ${c.inv} (job_id-strict)`, async () => {
    const client = makeQueryClient({
      jobs: [
        jobRow({ id: "jA", job_number: "SWMS-90001", status: "invoiced" }),
        jobRow({ id: "jB", job_number: "SWMS-90002", status: "complete" }),
      ],
      makesafe_job_details: [
        { job_id: "jA", external_ref: c.ref, requesting_company_slug: "mlb", substatus: "complete" },
        { job_id: "jB", external_ref: c.ref, requesting_company_slug: "mlb", substatus: "waiting_on_trade_report" },
      ],
      job_documents: [],
      job_service_reports: [],
      // ONE invoice, linked to card A by job_id, sharing the property ref.
      xero_invoices: [
        {
          job_id: "jA",
          status: c.status,
          invoice_number: c.inv,
          reference: c.ref,
          invoice_type: "ACCREC",
          invoice_date: "2026-06-20",
        },
      ],
      makesafe_intake_drafts: [],
    });
    const res: any = await _makesafeAuditForTest(client, new URLSearchParams());
    const a = res.jobs.find((j: any) => j.job_id === "jA");
    const b = res.jobs.find((j: any) => j.job_id === "jB");

    // Card A owns the invoice (job_id tier).
    assertEquals(a.invoice_status, c.status);
    assertEquals(a.invoice_no, c.inv);
    assertEquals(a.live_invoice_no, c.inv);
    assertEquals(a.live_invoice_status, c.status);
    assertEquals(a.invoices.length, 1);
    assertEquals(a.invoices[0].match_tier, "job_id");
    assertEquals(a.sibling_invoices.length, 0);

    // Card B is UNINVOICED — every scalar invoice field is null (no bleed).
    assertEquals(b.invoice_status, null);
    assertEquals(b.invoice_no, null);
    assertEquals(b.live_invoice_no, null);
    assertEquals(b.live_invoice_status, null);
    assertEquals(b.invoices.length, 0);
    // ...but the shared-ref invoice is still VISIBLE under sibling_invoices.
    assertEquals(b.sibling_invoices.length, 1);
    assertEquals(b.sibling_invoices[0].invoice_number, c.inv);
    assertEquals(b.sibling_invoices[0].status, c.status);
    assertEquals(b.sibling_invoices[0].match_tier, "reference");
  });
}

// MLB-25911 — the substring-tier bleed: the invoice's reference is a superset of
// the card's external_ref (e.g. an appended stage/suffix), so the old
// reference_substring fallback attributed it to the uninvoiced sibling.
Deno.test("W2-D MLB-25911: substring-ref invoice does NOT bleed onto the uninvoiced sibling", async () => {
  const client = makeQueryClient({
    jobs: [
      jobRow({ id: "jA", job_number: "SWMS-91001", status: "invoiced" }),
      jobRow({ id: "jB", job_number: "SWMS-91002", status: "complete" }),
    ],
    makesafe_job_details: [
      { job_id: "jA", external_ref: "MLB-25911", requesting_company_slug: "mlb", substatus: "complete" },
      { job_id: "jB", external_ref: "MLB-25911", requesting_company_slug: "mlb", substatus: "waiting_on_trade_report" },
    ],
    job_documents: [],
    job_service_reports: [],
    xero_invoices: [
      {
        job_id: "jA",
        status: "AUTHORISED",
        invoice_number: "INV-0810",
        // reference is a SUPERSET of the ref -> only the substring tier would match jB.
        reference: "MLB-25911 STAGE2",
        invoice_type: "ACCREC",
        invoice_date: "2026-06-18",
      },
    ],
    makesafe_intake_drafts: [],
  });
  const res: any = await _makesafeAuditForTest(client, new URLSearchParams());
  const a = res.jobs.find((j: any) => j.job_id === "jA");
  const b = res.jobs.find((j: any) => j.job_id === "jB");

  assertEquals(a.invoice_no, "INV-0810");
  assertEquals(a.invoices.length, 1);
  assertEquals(a.sibling_invoices.length, 0);

  assertEquals(b.invoice_status, null);
  assertEquals(b.invoice_no, null);
  assertEquals(b.invoices.length, 0);
  assertEquals(b.sibling_invoices.length, 1);
  assertEquals(b.sibling_invoices[0].invoice_number, "INV-0810");
  assertEquals(b.sibling_invoices[0].match_tier, "reference_substring");
});

// Both siblings legitimately invoiced (each its own job_id-linked invoice under
// the shared ref): each card shows ONLY its own invoice, neither cross-bleeds,
// and the OTHER card's invoice appears in sibling_invoices (visible, not owned).
Deno.test("W2-D two invoiced siblings: each owns only its own invoice, no cross-bleed", async () => {
  const client = makeQueryClient({
    jobs: [
      jobRow({ id: "jA", job_number: "SWMS-92001", status: "invoiced" }),
      jobRow({ id: "jB", job_number: "SWMS-92002", status: "invoiced" }),
    ],
    makesafe_job_details: [
      { job_id: "jA", external_ref: "MLB-26999", requesting_company_slug: "mlb", substatus: "complete" },
      { job_id: "jB", external_ref: "MLB-26999", requesting_company_slug: "mlb", substatus: "complete" },
    ],
    job_documents: [],
    job_service_reports: [],
    xero_invoices: [
      { job_id: "jA", status: "AUTHORISED", invoice_number: "INV-0900", reference: "MLB-26999", invoice_type: "ACCREC", invoice_date: "2026-06-21" },
      { job_id: "jB", status: "PAID", invoice_number: "INV-0901", reference: "MLB-26999", invoice_type: "ACCREC", invoice_date: "2026-06-22" },
    ],
    makesafe_intake_drafts: [],
  });
  const res: any = await _makesafeAuditForTest(client, new URLSearchParams());
  const a = res.jobs.find((j: any) => j.job_id === "jA");
  const b = res.jobs.find((j: any) => j.job_id === "jB");

  // Each card's own invoice only.
  assertEquals(a.invoice_no, "INV-0900");
  assertEquals(a.invoice_status, "AUTHORISED");
  assertEquals(a.invoices.length, 1);
  assertEquals(a.invoices[0].invoice_number, "INV-0900");
  assertEquals(b.invoice_no, "INV-0901");
  assertEquals(b.invoice_status, "PAID");
  assertEquals(b.invoices.length, 1);
  assertEquals(b.invoices[0].invoice_number, "INV-0901");

  // The other card's invoice is visible-but-not-owned (ref tier), never in invoices[].
  assertEquals(a.sibling_invoices.length, 1);
  assertEquals(a.sibling_invoices[0].invoice_number, "INV-0901");
  assertEquals(b.sibling_invoices.length, 1);
  assertEquals(b.sibling_invoices[0].invoice_number, "INV-0900");
});
