import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertReadOnlySql,
  CENSUS_SQL,
  classifyCensusRows,
  summariseDriftBuckets,
} from "./fence-freeze-orderability-census.ts";
import { canonicalJsonAndHash } from "../supabase/functions/_shared/release_packet/canonicalize.ts";

Deno.test("census SQL is a SELECT the write-verb guard accepts", () => {
  assertReadOnlySql(CENSUS_SQL);
});

Deno.test("census SQL write-verb guard refuses an update", () => {
  assertThrows(
    () => assertReadOnlySql("update scope_revisions set status = 'frozen'"),
    Error,
    "non-SELECT",
  );
  assertThrows(
    () => assertReadOnlySql("select id from scope_revisions; delete from scope_revisions"),
    Error,
    "write verb",
  );
});

Deno.test("classifyCensusRows measures a lineal-metres freeze as not_orderable", async () => {
  const scope = { job: { address: "1 Test St", suburb: "Fremantle" } };
  const pricing = {
    line_items: [{ description: "fence", quantity: 10, unit: "m", unit_price: 125, cost_price: null }],
    totalCostEstimate: 4902,
  };
  const { canonical: scope_canonical_text, hash: scope_hash } = await canonicalJsonAndHash(scope);
  const { canonical: pricing_canonical_text, hash: pricing_hash } = await canonicalJsonAndHash(pricing);
  const reports = await classifyCensusRows([{
    id: "rev-1",
    job_id: "job-1",
    revision_number: 1,
    status: "frozen",
    tool_kind: "fencing",
    tool_version: "fence-designer@test",
    scope_hash,
    pricing_hash,
    frozen_at: "2026-08-01T00:00:00.000Z",
    frozen_by_user_id: "user-1",
    scope_canonical_text,
    pricing_canonical_text,
    live_scope_json: scope,
    live_pricing_json: { ...pricing, totalCostEstimate: 5693 },
  }]);
  assertEquals(reports.length, 1);
  assertEquals(reports[0].verdict, "not_orderable");
  assertEquals(reports[0].drift.dollar_delta, 791);
  assertEquals(reports[0].drift.scope_hash_match, true);
});

Deno.test("classifyCensusRows detects scope-only drift", async () => {
  const scope = { job: { address: "1 Test St", suburb: "Fremantle" } };
  const pricing = {
    line_items: [{ description: "fence", quantity: 10, unit: "m", unit_price: 125 }],
    totalCostEstimate: 4902,
  };
  const { canonical: scope_canonical_text, hash: scope_hash } = await canonicalJsonAndHash(scope);
  const { canonical: pricing_canonical_text, hash: pricing_hash } = await canonicalJsonAndHash(pricing);
  const [report] = await classifyCensusRows([{
    id: "rev-scope-drift",
    job_id: "job-1",
    revision_number: 1,
    status: "frozen",
    tool_kind: "fencing",
    tool_version: "fence-designer@test",
    scope_hash,
    pricing_hash,
    frozen_at: "2026-08-01T00:00:00.000Z",
    frozen_by_user_id: "user-1",
    scope_canonical_text,
    pricing_canonical_text,
    live_scope_json: {
      job: { address: "2 Changed St", suburb: "Fremantle" },
    },
    live_pricing_json: pricing,
  }]);

  assertEquals(report.drift.scope_hash_match, false);
  assertEquals(report.drift.pricing_hash_match, true);
  assertEquals(report.drift.drifted, true);
  assertEquals(report.drift.dollar_delta, 0);
});

Deno.test("census keeps missing live scope in a separate not_comparable bucket", async () => {
  const scope = { job: { address: "1 Test St", suburb: "Fremantle" } };
  const pricing = {
    line_items: [{ description: "fence", quantity: 10, unit: "m", unit_price: 125 }],
    totalCostEstimate: 4902,
  };
  const { canonical: scope_canonical_text, hash: scope_hash } = await canonicalJsonAndHash(scope);
  const { canonical: pricing_canonical_text, hash: pricing_hash } = await canonicalJsonAndHash(pricing);
  const base = {
    job_id: "job-1",
    revision_number: 1,
    status: "frozen",
    tool_kind: "fencing",
    tool_version: "fence-designer@test",
    scope_hash,
    pricing_hash,
    frozen_at: "2026-08-01T00:00:00.000Z",
    frozen_by_user_id: "user-1",
    scope_canonical_text,
    pricing_canonical_text,
  };
  const reports = await classifyCensusRows([
    {
      ...base,
      id: "matched",
      live_scope_json: scope,
      live_pricing_json: pricing,
    },
    {
      ...base,
      id: "drifted",
      live_scope_json: { job: { address: "2 Changed St", suburb: "Fremantle" } },
      live_pricing_json: pricing,
    },
    {
      ...base,
      id: "not-comparable",
      live_scope_json: null,
      live_pricing_json: pricing,
    },
  ]);

  assertEquals(summariseDriftBuckets(reports), {
    matched: 1,
    drifted: 1,
    not_comparable: 1,
  });
  assertEquals(reports[2].drift.comparison, "not_comparable");
  assertEquals(reports[2].drift.drifted, false);
  assertEquals(reports[2].drift.scope_hash_match, null);
  assertEquals(reports[2].drift.not_comparable_reasons, ["live_scope_missing"]);
  assertEquals(
    Object.values(summariseDriftBuckets(reports)).reduce((sum, count) => sum + count, 0),
    reports.length,
  );
});
