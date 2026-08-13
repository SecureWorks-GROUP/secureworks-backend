// deno-lint-ignore-file no-explicit-any no-import-prefix

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _pipelineForTest } from "./index.ts";

type Call = {
  table: string;
  select: string;
  filters: Array<{ method: string; column: string; value: unknown }>;
};

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
          return { data: [], error: null };
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
              metadata: { makesafe_job_family: "repair" },
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

  assertEquals(result.total, 1);
  assertEquals(result.columns.processing.length, 1);
  const row = result.columns.processing[0];
  assertEquals(row.job_number, "SWMS-261029");
  assertEquals(row.type, "repair");
  assertEquals(row.ses_family, "repair");
  assertEquals(row.repair_stage, "on_site");
  assertEquals(row.source_type, "makesafe");
  assertEquals("metadata" in row, false);

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

Deno.test("both MakeSafe projections opt into the repair-family exclusion", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  assert(
    source.match(/excludeInsuranceRepairs: true/g)?.length === 3,
    "ops v1, ops v2, and trade MakeSafe projections must all exclude repairs",
  );
});
