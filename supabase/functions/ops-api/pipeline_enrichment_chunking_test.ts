// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _pipelineForTest } from "./index.ts";
import { IN_URL_BUDGET } from "./makesafe_compact_reads.ts";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const ENRICHMENT_TABLES = [
  "job_assignments",
  "purchase_orders",
  "work_orders",
  "council_submissions",
  "po_communications",
  "xero_invoices",
  "ops_notes",
  "job_contacts",
  "job_events",
] as const;

type Row = Record<string, unknown>;

function jobId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function encodedIdBytes(ids: string[]): number {
  return ids.reduce((sum, id) => sum + encodeURIComponent(id).length + 1, 0);
}

function fixture(jobCount: number): Record<string, Row[]> {
  const ids = Array.from({ length: jobCount }, (_, index) => jobId(index + 1));
  const perJob = (prefix: string, values: (id: string, index: number) => Row) =>
    ids.map((id, index) => ({
      id: `${prefix}-${index + 1}`,
      job_id: id,
      ...values(id, index),
    }));

  return {
    jobs: ids.map((id, index) => ({
      id,
      org_id: ORG_ID,
      type: "fencing",
      status: "scheduled",
      client_name: `Customer ${index + 1}`,
      client_phone: null,
      site_address: `${index + 1} Example Street`,
      site_suburb: "Balcatta",
      pj_total_inc: 1000 + index,
      pj_total: null,
      pj_split_neighbours: null,
      pj_job_neighbours: null,
      ghl_contact_id: null,
      ghl_opportunity_id: null,
      job_number: `SWF-${1000 + index}`,
      accepted_at: null,
      approvals_at: null,
      deposit_at: null,
      processing_at: null,
      scheduled_at: "2026-08-01T00:00:00.000Z",
      completed_at: null,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
      deposit_invoice_id: null,
      deposit_amount: null,
      council_required: true,
    })),
    job_assignments: perJob("assignment", () => ({
      scheduled_date: "2026-09-15",
      status: "scheduled",
    })),
    purchase_orders: perJob("po", () => ({ status: "submitted" })),
    work_orders: perJob("wo", () => ({ status: "sent" })),
    council_submissions: perJob("council", () => ({
      overall_status: "in_progress",
      current_step_index: 0,
      steps: [{ name: "Lodge" }, { name: "Approve" }],
    })),
    po_communications: perJob("email", () => ({
      direction: "outbound",
      communication_type: "purchase_order",
      created_at: "2026-08-10T00:00:00.000Z",
    })),
    xero_invoices: perJob("invoice", () => ({
      status: "PAID",
      invoice_type: "ACCREC",
      reference: "DEP",
    })),
    ops_notes: perJob("ops-note", () => ({})),
    job_contacts: perJob("contact", () => ({
      status: "active",
      is_primary: false,
    })),
    job_events: perJob("event", () => ({
      event_type: "note",
      detail_json: { text: "Human trade note" },
    })),
  };
}

function makePipelineClient(
  tables: Record<string, Row[]>,
  options: { failTable?: string; maxJobIdBytes?: number } = {},
) {
  const jobIdChunks: Record<string, string[][]> = {};

  function from(table: string) {
    let selectSpec = "";
    const eqFilters: Array<[string, unknown]> = [];
    const neqFilters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    let rowLimit: number | null = null;
    let queryError: { message: string } | null = null;

    const apply = () => {
      // pipeline() issues a second jobs read only for the defensive malformed
      // pricing probe. This fixture has no malformed pricing rows.
      if (table === "jobs" && selectSpec === "id, pricing_json") return [];
      let rows = [...(tables[table] || [])];
      for (const [column, value] of eqFilters) {
        rows = rows.filter((row) => row[column] === value);
      }
      for (const [column, value] of neqFilters) {
        rows = rows.filter((row) => row[column] !== value);
      }
      for (const [column, values] of inFilters) {
        rows = rows.filter((row) => values.includes(row[column]));
      }
      return rowLimit == null ? rows : rows.slice(0, rowLimit);
    };

    const result = () => {
      if (options.failTable === table) {
        return { data: null, error: { message: `${table} forced failure` } };
      }
      if (queryError) return { data: null, error: queryError };
      return { data: apply(), error: null };
    };

    const builder: any = {
      select: (columns: string) => {
        selectSpec = columns;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        eqFilters.push([column, value]);
        return builder;
      },
      neq: (column: string, value: unknown) => {
        neqFilters.push([column, value]);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        inFilters.push([column, values]);
        if (column === "job_id") {
          const ids = values.map(String);
          (jobIdChunks[table] ||= []).push(ids);
          const bytes = encodedIdBytes(ids);
          if (options.maxJobIdBytes != null && bytes > options.maxJobIdBytes) {
            queryError = {
              message: `${table}.job_id .in() list was ${bytes} encoded bytes`,
            };
          }
        }
        return builder;
      },
      not: () => builder,
      or: () => builder,
      is: () => builder,
      order: () => builder,
      limit: (value: number) => {
        rowLimit = value;
        return builder;
      },
      range: async (from: number, to: number) => {
        const resolved = result();
        if (resolved.error) return resolved;
        return { data: (resolved.data || []).slice(from, to + 1), error: null };
      },
      then: (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  }

  return { client: { from }, jobIdChunks };
}

function assertPopulated(card: Record<string, any>) {
  assertEquals(card.assignment_count, 1);
  assertEquals(card.first_scheduled_date, "2026-09-15");
  assertEquals(card.po_count, 1);
  assertEquals(card.wo_count, 1);
  assertEquals(card.ops_notes_count, 1);
  assertEquals(card.comms_notes_count, 1);
  assertEquals(card.council_count, 1);
  assertEquals(card.council_status, "in_progress");
  assertEquals(card.council_step, "1/2");
  assertEquals(card.last_po_email_at, "2026-08-10T00:00:00.000Z");
  assertEquals(card.last_po_email_dir, "outbound");
  assertEquals(card.has_any_invoice, true);
  assertEquals(card.deposit_paid, true);
  assertEquals(card.neighbour_count, 1);
}

Deno.test("pipeline enrichment: a small board still returns populated dates and counts", async () => {
  const { client, jobIdChunks } = makePipelineClient(fixture(3), {
    maxJobIdBytes: IN_URL_BUDGET,
  });

  const result = await _pipelineForTest(
    client,
    new URLSearchParams("type=fencing"),
  );

  assertEquals(result.total, 3);
  assertEquals(result.degraded, undefined);
  assertEquals(result.enrichment_errors, undefined);
  assertEquals(result.columns.scheduled.length, 3);
  assertPopulated(result.columns.scheduled[0]);
  for (const table of ENRICHMENT_TABLES) {
    assertEquals(
      jobIdChunks[table]?.length,
      1,
      `${table} should use one small chunk`,
    );
  }
});

Deno.test("pipeline enrichment: a URL-breaking board chunks all nine reads and merges every row", async () => {
  const jobCount = 377;
  const allIds = Array.from(
    { length: jobCount },
    (_, index) => jobId(index + 1),
  );
  assert(
    encodedIdBytes(allIds) > IN_URL_BUDGET,
    "the counterfactual population must exceed one safe PostgREST URL",
  );
  const { client, jobIdChunks } = makePipelineClient(fixture(jobCount), {
    maxJobIdBytes: IN_URL_BUDGET,
  });

  const result = await _pipelineForTest(
    client,
    new URLSearchParams("type=fencing"),
  );

  assertEquals(result.total, jobCount);
  assertEquals(result.degraded, undefined);
  assertEquals(result.columns.scheduled.length, jobCount);
  assertPopulated(result.columns.scheduled[0]);
  assertPopulated(result.columns.scheduled[jobCount - 1]);
  for (const table of ENRICHMENT_TABLES) {
    const chunks = jobIdChunks[table] || [];
    assert(chunks.length > 1, `${table} must be split across multiple reads`);
    assertEquals(
      chunks.flat().length,
      jobCount,
      `${table} must receive every job id`,
    );
    for (const chunk of chunks) {
      assert(
        encodedIdBytes(chunk) <= IN_URL_BUDGET,
        `${table} emitted an oversized ${encodedIdBytes(chunk)}-byte chunk`,
      );
    }
  }
});

Deno.test("pipeline enrichment: a read failure is logged and signalled without crashing the board", async () => {
  const { client } = makePipelineClient(fixture(3), {
    failTable: "ops_notes",
    maxJobIdBytes: IN_URL_BUDGET,
  });
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) =>
    logged.push(args.map(String).join(" "));
  try {
    const result = await _pipelineForTest(
      client,
      new URLSearchParams("type=fencing"),
    );

    assertEquals(result.total, 3);
    assertEquals(result.degraded, true);
    assertEquals(result.enrichment_errors, ["pipeline.ops_notes"]);
    assertEquals(result.columns.scheduled[0].ops_notes_count, 0);
    assertEquals(result.columns.scheduled[0].assignment_count, 1);
    assertEquals(
      result.columns.scheduled[0].first_scheduled_date,
      "2026-09-15",
    );
    assertEquals(logged.length, 1);
    assertStringIncludes(logged[0], "pipeline.ops_notes query failed");
    assertStringIncludes(logged[0], "ops_notes forced failure");
  } finally {
    console.error = originalError;
  }
});
