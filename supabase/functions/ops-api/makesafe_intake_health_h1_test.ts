// deno-lint-ignore-file no-explicit-any
// H1 (INVARIANT #5) — writeIntakeHealth must never let the M1 fail-loud banner go
// silently dark. In the window between merge->auto-deploy and the hand-applied M1.5
// migration, the ledger columns don't exist; PostgREST rejects the full upsert and
// supabase-js returns {error} WITHOUT throwing. The write must detect that and RETRY
// with only the base M1 columns so a dead key stays visible.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _writeIntakeHealthForTest as writeIntakeHealth } from "./index.ts";

function makeClient(opts: { costColumnsExist: boolean; prevBase?: any; prevCost?: any }) {
  const upserts: Array<{ hasCost: boolean; row: any }> = [];
  const from = (_table: string) => ({
    select: (cols: string) => ({
      eq: () => ({
        maybeSingle: () => {
          if (cols.includes("total_model_calls")) {
            return Promise.resolve(
              opts.costColumnsExist
                ? { data: opts.prevCost ?? null, error: null }
                : { data: null, error: { message: 'column "total_model_calls" does not exist' } },
            );
          }
          return Promise.resolve({ data: opts.prevBase ?? null, error: null });
        },
      }),
    }),
    upsert: (row: any) => {
      const hasCost = Object.prototype.hasOwnProperty.call(row, "total_model_calls");
      upserts.push({ hasCost, row });
      if (hasCost && !opts.costColumnsExist) {
        return Promise.resolve({
          error: { message: 'column "total_model_calls" of relation "makesafe_intake_health" does not exist' },
        });
      }
      return Promise.resolve({ error: null });
    },
  });
  return { from, upserts };
}

const COST = {
  model_calls: 3,
  model_skips: 1,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
};

Deno.test("H1: PRE-migration (ledger columns absent) still writes the M1 base banner via retry", async () => {
  const client = makeClient({
    costColumnsExist: false,
    prevBase: { extraction_status: "ok", degraded_since: null, last_successful_extraction_at: null },
  });
  await writeIntakeHealth(client as any, {
    extractionStatus: "degraded",
    degradedReason: "auth_failed",
    anyExtractionSucceeded: false,
    draftsCreated: 5,
    autoFiled: 0,
    cost: COST,
  });
  // Two upserts: the full one (rejected) then the base-only retry (accepted).
  assertEquals(client.upserts.length, 2);
  assertEquals(client.upserts[0].hasCost, true);
  assertEquals(client.upserts[1].hasCost, false);
  // The fail-loud banner IS written by the retry — the M1 fields, degraded, stamped.
  const base = client.upserts[1].row;
  assertEquals(base.extraction_status, "degraded");
  assertEquals(base.degraded_reason, "auth_failed");
  assert(base.degraded_since, "degraded_since must be stamped on the ok->degraded transition");
  assert(base.last_scan_at, "last_scan_at must be written");
  assertEquals(base.last_scan_drafts_created, 5);
  // The base retry must NOT carry any ledger column.
  assertEquals(Object.prototype.hasOwnProperty.call(base, "total_model_calls"), false);
});

Deno.test("H1: POST-migration writes the full row in ONE upsert (no retry)", async () => {
  const client = makeClient({
    costColumnsExist: true,
    prevBase: { extraction_status: "ok", degraded_since: null, last_successful_extraction_at: null },
    prevCost: { total_model_calls: 10, total_model_skips: 2, total_input_tokens: 1000, total_output_tokens: 200, total_cache_read_tokens: 0, total_cache_write_tokens: 0 },
  });
  await writeIntakeHealth(client as any, {
    extractionStatus: "ok",
    degradedReason: null,
    anyExtractionSucceeded: true,
    draftsCreated: 4,
    autoFiled: 1,
    cost: COST,
  });
  assertEquals(client.upserts.length, 1);
  const row = client.upserts[0].row;
  assertEquals(row.hasCost ?? Object.prototype.hasOwnProperty.call(row, "total_model_calls"), true);
  // Lifetime counters increment off the previous totals.
  assertEquals(row.total_model_calls, 13); // 10 + 3
  assertEquals(row.total_model_skips, 3); // 2 + 1
  assertEquals(row.last_scan_model_calls, 3);
  assertEquals(row.extraction_status, "ok");
});

Deno.test("H1: no-cost caller writes base row only, single upsert", async () => {
  const client = makeClient({ costColumnsExist: true, prevBase: { extraction_status: "ok" } });
  await writeIntakeHealth(client as any, {
    extractionStatus: "ok",
    degradedReason: null,
    anyExtractionSucceeded: true,
    draftsCreated: 0,
    autoFiled: 0,
    // no cost
  });
  assertEquals(client.upserts.length, 1);
  assertEquals(client.upserts[0].hasCost, false);
});
