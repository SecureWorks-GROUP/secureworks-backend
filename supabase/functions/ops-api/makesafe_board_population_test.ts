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
