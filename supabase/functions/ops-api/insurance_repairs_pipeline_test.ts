// deno-lint-ignore-file no-explicit-any no-import-prefix

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _makesafeBoardActionForTest,
  _makesafeBoardTradeRouteForTest,
  _pipelineForTest,
} from "./index.ts";

type Call = {
  table: string;
  select: string;
  filters: Array<{ method: string; column: string; value: unknown }>;
};

const DETAIL_ONLY_REPAIR_ID = "4a1c6d38-52ef-4b90-8a77-2f0b9e6d41cc";

function pipelineClient() {
  const calls: Call[] = [];
  const repairId = "0993f001-9e5e-420f-afdd-1cd1415084a1";
  return {
    calls,
    from(table: string) {
      const call: Call = { table, select: "", filters: [] };
      calls.push(call);
      const query: any = {};
      query.select = (columns: string) => {
        call.select = columns;
        return query;
      };
      for (const method of ["eq", "in", "not", "or", "is", "neq"]) {
        query[method] = (column: string, value: unknown, extra?: unknown) => {
          call.filters.push({
            method,
            column,
            value: extra === undefined ? value : [value, extra],
          });
          return query;
        };
      }
      query.order = () => query;
      query.limit = () => query;
      query.then = (
        resolve: (value: any) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(resultFor(call)).then(resolve, reject);

      function resultFor(current: Call) {
        if (current.table === "makesafe_job_details") {
          // The id-authority read asks for job_id alone; the detail-store read
          // asks for the identity columns. They are different queries.
          if (current.select === "job_id") {
            return { data: [{ job_id: DETAIL_ONLY_REPAIR_ID }], error: null };
          }
          return {
            data: [{
              job_id: DETAIL_ONLY_REPAIR_ID,
              external_ref: "MLB-24645PO-59875",
              requesting_company_slug: "mlb",
              requesting_company_name: "ML Builders",
            }],
            error: null,
          };
        }
        if (current.table === "jobs" && current.select === "id") {
          const family = current.filters.find((filter) =>
            filter.column === "metadata->>makesafe_job_family"
          );
          return {
            data: family ? [{ id: repairId }] : [],
            error: null,
          };
        }
        if (
          current.table === "jobs" &&
          current.select.startsWith("id, type, status")
        ) {
          return {
            data: [{
              id: repairId,
              type: "makesafe",
              status: "processing",
              client_name: "Midland Resident",
              client_phone: null,
              site_address: null,
              site_suburb: "Midland",
              pj_total_inc: null,
              pj_total: null,
              pj_split_neighbours: null,
              pj_job_neighbours: null,
              ghl_contact_id: null,
              ghl_opportunity_id: null,
              job_number: "SWMS-261029",
              accepted_at: null,
              approvals_at: null,
              deposit_at: null,
              processing_at: "2026-08-07T00:00:00Z",
              scheduled_at: null,
              completed_at: null,
              created_at: "2026-07-21T00:00:00Z",
              updated_at: "2026-08-07T00:00:00Z",
              deposit_invoice_id: null,
              deposit_amount: null,
              council_required: null,
              metadata: {
                makesafe_job_family: "repair",
                external_ref: "MLB-25147",
                builder_work_order_number: "MLB-25147PO-56236",
                builder_po_number: "PO-56236",
                requesting_company: { slug: "mlb", name: "ML Builders" },
              },
            }, {
              // Legacy card admitted by makesafe_job_details.report_type only:
              // jobs.metadata was never populated, so the detail store is the
              // ONLY place its builder identity exists.
              id: DETAIL_ONLY_REPAIR_ID,
              type: "makesafe",
              status: "accepted",
              client_name: "Pingelly Resident",
              client_phone: null,
              site_address: null,
              site_suburb: "Pingelly",
              pj_total_inc: null,
              pj_total: null,
              pj_split_neighbours: null,
              pj_job_neighbours: null,
              ghl_contact_id: null,
              ghl_opportunity_id: null,
              job_number: "SWMS-261192",
              accepted_at: "2026-08-07T00:00:00Z",
              approvals_at: null,
              deposit_at: null,
              processing_at: null,
              scheduled_at: null,
              completed_at: null,
              created_at: "2026-07-21T00:00:00Z",
              updated_at: "2026-08-07T00:00:00Z",
              deposit_invoice_id: null,
              deposit_amount: null,
              council_required: null,
              metadata: null,
            }],
            error: null,
          };
        }
        return { data: [], error: null };
      }

      return query;
    },
  };
}

Deno.test("pipeline?type=repair feeds Midland through the merged Repairs contract", async () => {
  const client = pipelineClient();
  const result = await _pipelineForTest(
    client,
    new URLSearchParams("type=repair"),
  );

  assertEquals(result.total, 2);
  assertEquals(result.columns.processing.length, 1);
  const row = result.columns.processing[0];
  assertEquals(row.job_number, "SWMS-261029");
  assertEquals(row.type, "repair");
  assertEquals(row.ses_family, "repair");
  assertEquals(row.repair_stage, "on_site");
  assertEquals(row.source_type, "makesafe");
  assertEquals("metadata" in row, false);
  // The card carries both builder instruction numbers, lifted off the stripped
  // metadata: the bare work-order reference (not the fused WO+PO vintage) and
  // the purchase order, labelled by the issuing company.
  assertEquals(row.builder_work_order_ref, "MLB-25147");
  assertEquals(row.builder_po_number, "PO-56236");
  assertEquals(row.builder_company_name, "ML Builders");

  const baseRead = client.calls.find((call) =>
    call.table === "jobs" && call.select.startsWith("id, type, status")
  );
  assert(baseRead);
  assertStringIncludes(baseRead.select, ", metadata");
  assertEquals(
    baseRead.filters.some((filter) =>
      filter.method === "in" && filter.column === "id" &&
      Array.isArray(filter.value) && filter.value.includes(row.id)
    ),
    true,
  );
});

Deno.test("pipeline?type=repair serves a metadata-less card off the detail store", async () => {
  const client = pipelineClient();
  const result = await _pipelineForTest(
    client,
    new URLSearchParams("type=repair"),
  );

  assertEquals(result.columns.accepted.length, 1);
  const row = result.columns.accepted[0];
  assertEquals(row.job_number, "SWMS-261192");
  assertEquals(row.type, "repair");
  // jobs.metadata is null on this card, so every field below can only have come
  // from the makesafe_job_details read the pipeline wires into the projection.
  assertEquals(row.builder_work_order_ref, "MLB-24645");
  assertEquals(row.builder_po_number, "PO-59875");
  assertEquals(row.builder_company_name, "ML Builders");
  assertEquals(row.builder_company_slug, "mlb");

  const detailRead = client.calls.find((call) =>
    call.table === "makesafe_job_details" && call.select !== "job_id"
  );
  assert(detailRead);
  assertEquals(
    detailRead.filters.some((filter) =>
      filter.method === "in" && filter.column === "job_id" &&
      Array.isArray(filter.value) &&
      filter.value.includes(DETAIL_ONLY_REPAIR_ID)
    ),
    true,
  );
});

/**
 * Join-capable PostgREST fixture for the canonical board loader. Mirrors the
 * make-safe intake fixture: nested `.eq('jobs.type', …)` reads the embedded
 * relation, and every unseeded table answers empty.
 */
function boardFixtureClient(
  profiles: Record<string, any>,
  rowsByTable: Record<string, any[]>,
) {
  function builder(table: string) {
    const rows =
      (table === "users" ? Object.values(profiles) : rowsByTable[table] || [])
        .slice();
    const predicates: Array<(row: any) => boolean> = [];
    const query: any = {
      select: () => query,
      eq: (column: string, value: any) => {
        predicates.push((row) => {
          if (Object.prototype.hasOwnProperty.call(row ?? {}, column)) {
            return row?.[column] === value;
          }
          if (column.includes(".")) {
            let cursor: any = row;
            for (const part of column.split(".")) cursor = cursor?.[part];
            return cursor === value;
          }
          return row?.[column] === value;
        });
        return query;
      },
      neq: (column: string, value: any) => {
        predicates.push((row) => row?.[column] !== value);
        return query;
      },
      not: (column: string, operator: string, value: string) => {
        if (operator === "in") {
          const excluded = String(value).slice(1, -1).split(",").map((item) =>
            item.replaceAll('"', "")
          );
          predicates.push((row) => !excluded.includes(String(row?.[column])));
        }
        return query;
      },
      gte: (column: string, value: any) => {
        predicates.push((row) => String(row?.[column] || "") >= String(value));
        return query;
      },
      in: (column: string, values: any[]) => {
        predicates.push((row) => values.includes(row?.[column]));
        return query;
      },
      lte: () => query,
      lt: () => query,
      is: () => query,
      or: () => query,
      filter: () => query,
      order: () => query,
      limit: () => query,
      range: (from: number, to: number) =>
        Promise.resolve({
          data: rows.filter((row) => predicates.every((test) => test(row)))
            .slice(from, to + 1),
          error: null,
        }),
      maybeSingle: () =>
        Promise.resolve({
          data: rows.filter((row) =>
            predicates.every((test) => test(row))
          )[0] ||
            null,
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
  return {
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: [], error: null }),
  };
}

const REPAIR_BOARD_JOB = "0993f001-9e5e-420f-afdd-1cd1415084a1";
const MAKESAFE_BOARD_JOB = "6b7d9a2c-1f43-4a58-9c21-a0f7ce55d310";

function boardFixture() {
  return boardFixtureClient({
    "ops-manager-fixture": {
      id: "ops-manager-fixture",
      name: "Ops Fixture",
      role: "ops_manager",
      managed_verticals: ["makesafe"],
    },
  }, {
    jobs: [{
      id: REPAIR_BOARD_JOB,
      job_number: "SWMS-261029",
      type: "makesafe",
      status: "accepted",
      client_name: "Midland Resident",
      site_suburb: "Midland",
      created_at: "2026-07-21T00:00:00Z",
      metadata: { makesafe_job_family: "repair" },
    }, {
      id: MAKESAFE_BOARD_JOB,
      job_number: "SWMS-261179",
      type: "makesafe",
      status: "accepted",
      client_name: "Physical Resident",
      site_suburb: "Morley",
      created_at: "2026-07-21T00:00:00Z",
      metadata: { makesafe_job_family: "general_makesafe" },
    }],
    makesafe_job_details: [{
      job_id: REPAIR_BOARD_JOB,
      substatus: "company_contact_required",
    }, {
      job_id: MAKESAFE_BOARD_JOB,
      substatus: "company_contact_required",
    }],
    job_service_reports: [],
    xero_invoices: [],
    job_documents: [],
    makesafe_report_packs: [],
    job_assignments: [],
    job_events: [],
    job_media: [],
    job_contacts: [],
    makesafe_status_holds: [],
    makesafe_intake_cases: [],
    makesafe_board_status_current: [],
    makesafe_state_projection_config: [{
      singleton: true,
      default_contract_version: "v1",
      compare_enabled: true,
      authority_flipped: false,
    }],
  });
}

function boardCardIds(columns: Record<string, any[]>): string[] {
  return Object.values(columns || {}).flat().map((row: any) => row?.id);
}

Deno.test("ops MakeSafe board serves the make-safe card and never the repair card", async () => {
  const response = await _makesafeBoardActionForTest(
    boardFixture(),
    "api_key",
    null,
    "ops",
    { generatedAt: "2026-08-31T00:00:00Z" },
  );
  const body = JSON.parse(await response.text());

  assertEquals(response.status, 200);
  const ids = boardCardIds(body.columns);
  assertEquals(ids.includes(MAKESAFE_BOARD_JOB), true);
  assertEquals(
    ids.includes(REPAIR_BOARD_JOB),
    false,
    "Repairs is a sibling pipeline and must not appear on the ops MakeSafe board",
  );
  assertEquals(body.column_counts.new, 1);
});

Deno.test("privileged v2 comparison serves the make-safe card and never the repair card", async () => {
  const response = await _makesafeBoardActionForTest(
    boardFixture(),
    "api_key",
    null,
    "ops",
    { generatedAt: "2026-08-31T00:00:00Z", contractVersion: "v2" },
  );
  const body = JSON.parse(await response.text());

  assertEquals(response.status, 200);
  const ids = boardCardIds(body.columns);
  assertEquals(ids.includes(MAKESAFE_BOARD_JOB), true);
  assertEquals(ids.includes(REPAIR_BOARD_JOB), false);
});

Deno.test("trade MakeSafe board serves the make-safe card and never the repair card", async () => {
  const response = await _makesafeBoardTradeRouteForTest(
    boardFixture(),
    "jwt",
    {
      id: "ops-manager-fixture",
      email: "ops.fixture@example.invalid",
      orgId: "fixture-org",
      role: "ops_manager",
      managedVerticals: ["makesafe"],
    },
    { generatedAt: "2026-08-31T00:00:00Z" },
  );
  const body = JSON.parse(await response.text());

  assertEquals(response.status, 200);
  assertEquals(body.projection, "trade");
  const ids = boardCardIds(body.columns);
  assertEquals(ids.includes(MAKESAFE_BOARD_JOB), true);
  assertEquals(ids.includes(REPAIR_BOARD_JOB), false);
});
