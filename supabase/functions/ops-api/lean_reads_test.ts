import {
  assertEquals,
  assertFalse,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  OPS_SUMMARY_ACTIVE_JOB_COLUMNS,
  OPS_SUMMARY_NEEDS_SCHEDULING_COLUMNS,
  OPS_SUMMARY_SCHEDULE_COLUMNS,
  PIPELINE_PRICING_ALIASES,
  PIPELINE_PRICING_NULL_PATHS,
  PIPELINE_PRICING_PROJECTION,
  pipelinePricingFallbackValues,
  pipelinePricingProjectionValues,
  stripPipelinePricingAliases,
  toOpsSummaryScheduleEvent,
} from "./index.ts";

Deno.test("ops_summary schedule projection matches its unchanged response shape", () => {
  const source = {
    assignment_id: "assignment-1",
    job_id: "job-1",
    client_name: "Test Client",
    site_suburb: "Balcatta",
    site_address: "1 Test Street",
    job_type: "patio",
    assignment_type: "install",
    crew_name: "Crew One",
    assigned_to: ["trade-1"],
    start_time: "07:00:00",
    end_time: "15:00:00",
    assignment_status: "scheduled",
    job_status: "processing",
    job_number: "SWP-9999",
    scope_json: { job: { sitePlanImage: "unused-large-media" } },
    pricing_json: { totalIncGST: 1234.5 },
  };

  const result = toOpsSummaryScheduleEvent(source);
  const projectedColumns = OPS_SUMMARY_SCHEDULE_COLUMNS.split(", ");

  assertEquals(Object.keys(result), projectedColumns);
  assertFalse("job_number" in result);
  assertFalse(projectedColumns.includes("scope_json"));
  assertFalse(projectedColumns.includes("pricing_json"));
});

Deno.test("ops_summary supporting job reads contain only consumed values", () => {
  assertEquals(
    OPS_SUMMARY_NEEDS_SCHEDULING_COLUMNS,
    [
      "id",
      "client_name",
      "site_suburb",
      "type",
      "days_waiting",
    ].join(", "),
  );
  assertEquals(OPS_SUMMARY_ACTIVE_JOB_COLUMNS, "id, status, type");
  assertFalse(OPS_SUMMARY_NEEDS_SCHEDULING_COLUMNS.includes("pricing_json"));
  assertFalse(OPS_SUMMARY_ACTIVE_JOB_COLUMNS.includes("pricing_json"));
});

function oldPipelineValues(row: Record<string, unknown>) {
  const pricing = row.pricing_json as Record<string, unknown> | null;
  return {
    value: pricing?.totalIncGST || pricing?.total || 0,
    neighbours:
      (pricing?.neighbour_splits as Record<string, unknown> | undefined)
        ?.neighbours ||
      (pricing?.job as Record<string, unknown> | undefined)?.neighbours,
  };
}

function projectedRow(row: Record<string, unknown>) {
  const pricing = row.pricing_json as Record<string, unknown> | null;
  return {
    id: row.id,
    type: row.type,
    pj_total_inc: pricing?.totalIncGST ?? null,
    pj_total: pricing?.total ?? null,
    pj_split_neighbours:
      (pricing?.neighbour_splits as Record<string, unknown> | undefined)
        ?.neighbours ?? null,
    pj_job_neighbours:
      (pricing?.job as Record<string, unknown> | undefined)?.neighbours ?? null,
    status: row.status,
  };
}

Deno.test("pipeline JSON paths preserve pricing values and their runtime types", () => {
  const cases: Array<Record<string, unknown>> = [
    {
      id: "numeric-primary",
      type: "patio",
      pricing_json: { totalIncGST: 1234.56, total: 1111 },
      status: "quoted",
    },
    {
      id: "zero-primary-falls-back",
      type: "patio",
      pricing_json: { totalIncGST: 0, total: 789.01 },
      status: "quoted",
    },
    {
      id: "json-string-stays-string",
      type: "patio",
      pricing_json: { totalIncGST: "123.40" },
      status: "quoted",
    },
    {
      id: "split-neighbours-win",
      type: "fencing",
      pricing_json: {
        neighbour_splits: { neighbours: [{ id: 1 }, { id: 2 }] },
        job: { neighbours: [{ id: 3 }] },
      },
      status: "accepted",
    },
    {
      id: "job-neighbours-fallback",
      type: "fencing",
      pricing_json: { neighbour_splits: null, job: { neighbours: ["one"] } },
      status: "accepted",
    },
    {
      id: "missing-pricing",
      type: "fencing",
      pricing_json: null,
      status: "draft",
    },
  ];

  for (const oldRow of cases) {
    const expected = oldPipelineValues(oldRow);
    const actual = pipelinePricingProjectionValues(projectedRow(oldRow));
    assertEquals(actual.value, expected.value, String(oldRow.id));
    assertStrictEquals(
      typeof actual.value,
      typeof expected.value,
      `${oldRow.id}: value type changed`,
    );
    assertStrictEquals(
      Array.isArray(actual.neighbours),
      Array.isArray(expected.neighbours),
      `${oldRow.id}: neighbour-array semantics changed`,
    );
    if (Array.isArray(expected.neighbours)) {
      assertEquals(actual.neighbours, expected.neighbours, String(oldRow.id));
    }
  }
});

Deno.test("malformed pricing_json probe targets exactly the projected paths", () => {
  assertEquals(PIPELINE_PRICING_NULL_PATHS, [
    "pricing_json->totalIncGST",
    "pricing_json->total",
    "pricing_json->neighbour_splits->neighbours",
    "pricing_json->job->neighbours",
  ]);
  assertEquals(
    PIPELINE_PRICING_NULL_PATHS.length,
    PIPELINE_PRICING_PROJECTION.length,
  );
});

Deno.test("double-encoded pricing_json recovers the pre-projection values", () => {
  const blob = {
    totalIncGST: 4321.5,
    neighbour_splits: { neighbours: [{ id: 1 }, { id: 2 }] },
  };
  const doubleEncoded = JSON.stringify(blob);

  // The projection alone sees nothing for such a row: every path is SQL NULL.
  const projectedOnly = pipelinePricingProjectionValues({
    pj_total_inc: null,
    pj_total: null,
    pj_split_neighbours: null,
    pj_job_neighbours: null,
  });
  assertEquals(projectedOnly.value, 0);
  assertFalse(Array.isArray(projectedOnly.neighbours));

  const recovered = pipelinePricingFallbackValues(doubleEncoded);
  const expected = oldPipelineValues({ pricing_json: blob });
  assertEquals(recovered?.value, expected.value);
  assertStrictEquals(typeof recovered?.value, typeof expected.value);
  assertEquals(recovered?.neighbours, expected.neighbours);
});

Deno.test("malformed-blob fallback matches the old chain and never throws", () => {
  assertEquals(pipelinePricingFallbackValues("not json at all"), null);
  assertEquals(pipelinePricingFallbackValues(null), null);
  assertEquals(pipelinePricingFallbackValues(undefined), null);
  assertEquals(pipelinePricingFallbackValues('"a bare json string"'), null);
  assertEquals(pipelinePricingFallbackValues("42"), null);

  const jobNeighbours = { job: { neighbours: ["one", "two", "three"] } };
  assertEquals(
    pipelinePricingFallbackValues(JSON.stringify(jobNeighbours)),
    oldPipelineValues({ pricing_json: jobNeighbours }),
  );

  const zeroFallsBack = { totalIncGST: 0, total: 999 };
  assertEquals(
    pipelinePricingFallbackValues(JSON.stringify(zeroFallsBack))?.value,
    oldPipelineValues({ pricing_json: zeroFallsBack }).value,
  );

  // Already-decoded jsonb objects flow through unchanged.
  assertEquals(
    pipelinePricingFallbackValues(zeroFallsBack),
    oldPipelineValues({ pricing_json: zeroFallsBack }),
  );
});

Deno.test("pipeline aliases are exact, lean, and stripped without changing key order", () => {
  assertEquals(PIPELINE_PRICING_PROJECTION, [
    "pj_total_inc:pricing_json->totalIncGST",
    "pj_total:pricing_json->total",
    "pj_split_neighbours:pricing_json->neighbour_splits->neighbours",
    "pj_job_neighbours:pricing_json->job->neighbours",
  ]);
  assertEquals(PIPELINE_PRICING_ALIASES, [
    "pj_total_inc",
    "pj_total",
    "pj_split_neighbours",
    "pj_job_neighbours",
  ]);
  assertFalse(PIPELINE_PRICING_PROJECTION.includes("pricing_json"));

  const oldRow = {
    id: "job-1",
    type: "fencing",
    pricing_json: { totalIncGST: 2500, job: { neighbours: ["one"] } },
    status: "quoted",
  };
  const { pricing_json: _pricing, ...oldLeanRow } = oldRow;
  const newLeanRow = stripPipelinePricingAliases(projectedRow(oldRow));

  assertEquals(newLeanRow, oldLeanRow);
  assertEquals(Object.keys(newLeanRow), Object.keys(oldLeanRow));
  assertStrictEquals(JSON.stringify(newLeanRow), JSON.stringify(oldLeanRow));
});
