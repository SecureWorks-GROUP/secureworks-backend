// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _makesafePipelineForTest } from "./index.ts";

function makeQueryClient(resultsByTable: Record<string, any[]>) {
  function builder(table: string) {
    const rows = (resultsByTable[table] || []).slice();
    const predicates: Array<(row: any) => boolean> = [];
    const query: any = {
      select: () => query,
      eq: (column: string, value: any) => {
        predicates.push((row) => row?.[column] === value);
        return query;
      },
      neq: (column: string, value: any) => {
        predicates.push((row) => row?.[column] !== value);
        return query;
      },
      not: () => query,
      in: (column: string, values: any[]) => {
        predicates.push((row) => values.includes(row?.[column]));
        return query;
      },
      gte: (column: string, value: any) => {
        predicates.push((row) => row?.[column] >= value);
        return query;
      },
      order: () => query,
      limit: () => query,
      range: async (from: number, to: number) => ({
        data: rows.filter((row) => predicates.every((test) => test(row))).slice(
          from,
          to + 1,
        ),
        error: null,
      }),
      then: (resolve: (value: any) => any) =>
        resolve({
          data: rows.filter((row) => predicates.every((test) => test(row))),
          error: null,
        }),
    };
    return query;
  }
  return { from: (table: string) => builder(table) };
}

Deno.test("board population includes detail-authority legacy jobs exactly once", async () => {
  const client = makeQueryClient({
    jobs: [{
      id: "job-detail-only",
      job_number: "LEGACY-26931",
      type: "insurance",
      status: "accepted",
      site_lat: -31.97,
      site_lng: 115.76,
      metadata: {},
      created_at: "2026-07-08T00:00:00Z",
      updated_at: "2026-07-08T00:00:00Z",
    }],
    makesafe_job_details: [{
      job_id: "job-detail-only",
      external_ref: "MLB-24664",
      requesting_company_name: "Major Loss Builders",
      substatus: "company_contact_required",
    }],
    job_service_reports: [],
    xero_invoices: [],
    job_documents: [],
    makesafe_report_packs: [],
    makesafe_report_pack_cycles: [],
    makesafe_docket_revisions_current: [],
    makesafe_board_attention_current: [],
    job_assignments: [],
    job_events: [],
  });

  const result: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams(),
  );
  const cards = Object.values(result.columns).flat() as any[];
  assertEquals(
    cards.filter((row) => row.id === "job-detail-only").length,
    1,
  );
  assertEquals(result.total, 1);
});

/**
 * Active-board TTFB: status=archived jobs early-return stage `archive` and only
 * feed the census on the default paint path. Skipping their stage-dependent
 * joins must not move any other card, and the archived card must still count
 * under archive. include_archive / pipeline default still load full dependents.
 */
Deno.test("skipArchivedStatusDependents keeps archive census without stage-dependent joins for archived status", async () => {
  const invoiceInCalls: string[][] = [];
  const baseTables: Record<string, any[]> = {
    jobs: [
      {
        id: "job-live",
        job_number: "SWMS-LIVE",
        type: "makesafe",
        status: "accepted",
        metadata: {},
        created_at: "2026-07-20T00:00:00Z",
        updated_at: "2026-07-20T00:00:00Z",
      },
      {
        id: "job-arch-status",
        job_number: "SWMS-ARCH",
        type: "makesafe",
        status: "archived",
        metadata: {},
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-10T00:00:00Z",
        completed_at: "2026-01-02T00:00:00Z",
      },
    ],
    makesafe_job_details: [
      {
        job_id: "job-live",
        substatus: "company_contact_required",
        requesting_company_name: "Builder",
      },
      {
        job_id: "job-arch-status",
        substatus: "complete",
        requesting_company_name: "Builder",
      },
    ],
    job_service_reports: [],
    xero_invoices: [{
      id: "inv-arch",
      job_id: "job-arch-status",
      status: "PAID",
      invoice_type: "ACCREC",
      invoice_date: "2026-01-03",
      created_at: "2026-01-03T00:00:00Z",
    }],
    job_documents: [{
      job_id: "job-arch-status",
      type: "work_order",
      file_name: "wo.pdf",
    }],
    makesafe_report_packs: [],
    makesafe_report_pack_cycles: [],
    makesafe_docket_revisions_current: [],
    makesafe_board_attention_current: [],
    job_assignments: [{
      id: "a-live",
      job_id: "job-live",
      user_id: "u1",
      status: "scheduled",
      scheduled_date: "2026-07-21",
      users: { id: "u1", name: "Hugo", phone: null },
    }],
    job_events: [],
    ses_synthetic_livefire_runs: [],
  };

  function makeTrackingClient() {
    function builder(table: string) {
      const rows = (baseTables[table] || []).slice();
      const predicates: Array<(row: any) => boolean> = [];
      const query: any = {
        select: () => query,
        eq: (column: string, value: any) => {
          predicates.push((row) => row?.[column] === value);
          return query;
        },
        neq: (column: string, value: any) => {
          predicates.push((row) => row?.[column] !== value);
          return query;
        },
        not: () => query,
        in: (column: string, values: any[]) => {
          if (table === "xero_invoices" && column === "job_id") {
            invoiceInCalls.push([...values]);
          }
          predicates.push((row) => values.includes(row?.[column]));
          return query;
        },
        gte: () => query,
        order: () => query,
        limit: () => query,
        range: async (from: number, to: number) => ({
          data: rows.filter((row) => predicates.every((test) => test(row))).slice(
            from,
            to + 1,
          ),
          error: null,
        }),
        then: (resolve: (value: any) => any) =>
          resolve({
            data: rows.filter((row) => predicates.every((test) => test(row))),
            error: null,
          }),
      };
      return query;
    }
    return { from: (table: string) => builder(table) };
  }

  const full: any = await _makesafePipelineForTest(
    makeTrackingClient(),
    new URLSearchParams("history=all"),
  );
  invoiceInCalls.length = 0;
  const slim: any = await _makesafePipelineForTest(
    makeTrackingClient(),
    new URLSearchParams("history=all"),
    undefined,
    { skipArchivedStatusDependents: true },
  );

  // Archived-status card stays in archive either way.
  assertEquals(
    full.columns.archive.some((r: any) => r.id === "job-arch-status"),
    true,
  );
  assertEquals(
    slim.columns.archive.some((r: any) => r.id === "job-arch-status"),
    true,
  );
  // Live card placement is identical.
  assertEquals(
    full.columns.allocated.some((r: any) => r.id === "job-live"),
    true,
  );
  assertEquals(
    slim.columns.allocated.some((r: any) => r.id === "job-live"),
    true,
  );
  // Stage-dependent invoice join must not include the archived-status job id.
  const invoiceIds = invoiceInCalls.flat();
  assertEquals(invoiceIds.includes("job-arch-status"), false);
  assertEquals(invoiceIds.includes("job-live"), true);
  // Pipeline still publishes the synthetic-ledger reuse field for the board loader.
  assertEquals(Array.isArray(slim.terminal_synthetic_job_ids), true);
});
