// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertProductionSupabaseUrl,
  buildConditionalUpdateSql,
  evaluateCorrection,
  parseFixture,
  readOnlyFetch,
} from "../apply-board-safe-fixes-v1.ts";

const fixtureUrl = new URL(
  "../board-safe-fixes-v1.fixture.txt",
  import.meta.url,
);

Deno.test("SAFE fixture contains only the adjudicated 194 transitions", async () => {
  const corrections = parseFixture(await Deno.readTextFile(fixtureUrl));
  assertEquals(corrections.length, 194);
  assertEquals(
    corrections.filter((row) =>
      row.column === "jobs.metadata.makesafe_job_family"
    ).length,
    114,
  );
  assertEquals(
    corrections.filter((row) =>
      row.column === "makesafe_job_details.report_type"
    ).length,
    79,
  );
  assertEquals(
    corrections.filter((row) =>
      row.column === "makesafe_job_details.requesting_company_slug"
    ).length,
    1,
  );
  assertEquals(
    corrections.filter((row) => row.after === "general_makesafe").length,
    87,
  );
  assertEquals(
    corrections.filter((row) => row.after === "temp_fence_makesafe").length,
    27,
  );
  assertEquals(
    corrections.filter((row) => row.after === "roof_report").length,
    31,
  );
  assertEquals(
    corrections.filter((row) => row.after === "assessment_report").length,
    48,
  );
});

Deno.test("family backfill stays physical in the production classifier", () => {
  const evaluation = evaluateCorrection(
    {
      card: "SWMS-1",
      column: "jobs.metadata.makesafe_job_family",
      current: null,
      after: "temp_fence_makesafe",
      rationale: "test",
    },
    [{
      id: "job-1",
      job_number: "SWMS-1",
      metadata: {},
      type: "makesafe",
      status: "accepted",
      updated_at: "2026-07-31T00:00:00Z",
    }],
    [{
      job_id: "job-1",
      report_type: null,
      requesting_company_slug: "bw",
      updated_at: "2026-07-31T00:00:00Z",
    }],
  );
  assertEquals(evaluation.eligible, true);
  assertEquals(evaluation.board_kind_before, "physical_makesafe");
  assertEquals(evaluation.board_kind_after, "physical_makesafe");
});

Deno.test("report type forward fill preserves family-derived board kind", () => {
  const evaluation = evaluateCorrection(
    {
      card: "SWMS-2",
      column: "makesafe_job_details.report_type",
      current: null,
      after: "assessment_report",
      rationale: "test",
    },
    [{
      id: "job-2",
      job_number: "SWMS-2",
      metadata: { makesafe_job_family: "assessment_report_quote" },
      type: "makesafe",
      status: "accepted",
      updated_at: "2026-07-31T00:00:00Z",
    }],
    [{
      job_id: "job-2",
      report_type: null,
      requesting_company_slug: "aj",
      updated_at: "2026-07-31T00:00:00Z",
    }],
  );
  assertEquals(evaluation.eligible, true);
  assertEquals(evaluation.board_kind_before, "assessment_report_quote");
  assertEquals(evaluation.board_kind_after, "assessment_report_quote");
});

Deno.test("current mismatch is skipped rather than forced", () => {
  const evaluation = evaluateCorrection(
    {
      card: "SWMS-3",
      column: "makesafe_job_details.requesting_company_slug",
      current: "ajbr",
      after: "aj",
      rationale: "test",
    },
    [{
      id: "job-3",
      job_number: "SWMS-3",
      metadata: {},
      type: "makesafe",
      status: "accepted",
      updated_at: "2026-07-31T00:00:00Z",
    }],
    [{
      job_id: "job-3",
      report_type: null,
      requesting_company_slug: "wb",
      updated_at: "2026-07-31T00:00:00Z",
    }],
  );
  assertEquals(evaluation.eligible, false);
  assertEquals(evaluation.reason, "current_value_mismatch");
});

Deno.test("Supabase client transport rejects mutations", async () => {
  const fetcher = readOnlyFetch();
  await assertRejects(
    () =>
      fetcher("https://example.supabase.co/rest/v1/jobs", {
        method: "DELETE",
      }),
    Error,
    "read-only transport refused DELETE",
  );
  await assertRejects(
    () =>
      fetcher("https://example.supabase.co/rest/v1/job_assignments", {
        method: "PATCH",
      }),
    Error,
    "read-only transport refused PATCH",
  );
});

Deno.test("reads cannot authorize writes against a different project", () => {
  assertEquals(
    assertProductionSupabaseUrl("https://kevgrhcjxspbxgovpmfl.supabase.co"),
    "https://kevgrhcjxspbxgovpmfl.supabase.co",
  );
  let message = "";
  try {
    assertProductionSupabaseUrl("https://staging-example.supabase.co");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(
    message,
    "SUPABASE_URL must target production project kevgrhcjxspbxgovpmfl",
  );
});

Deno.test("conditional SQL locks both classifier inputs and updates one JSON key", () => {
  const sql = buildConditionalUpdateSql(
    {
      card: "SWMS-4",
      column: "jobs.metadata.makesafe_job_family",
      current: null,
      after: "general_makesafe",
      rationale: "test",
    },
    {
      id: "123e4567-e89b-42d3-a456-426614174000",
      job_number: "SWMS-4",
      metadata: { retained: true },
      type: "makesafe",
      status: "accepted",
      updated_at: "2026-07-31T00:00:00Z",
    },
    {
      job_id: "123e4567-e89b-42d3-a456-426614174000",
      report_type: null,
      requesting_company_slug: "bw",
      updated_at: "2026-07-31T00:00:00Z",
    },
  );
  assertEquals(sql.includes("FOR UPDATE OF j, d"), true);
  assertEquals(
    sql.includes(
      "(j.metadata->>'makesafe_job_family') IS NOT DISTINCT FROM NULL",
    ),
    true,
  );
  assertEquals(sql.includes("d.report_type IS NOT DISTINCT FROM NULL"), true);
  assertEquals(
    sql.includes("d.requesting_company_slug IS NOT DISTINCT FROM 'bw'"),
    true,
  );
  assertEquals(sql.includes("SET metadata = jsonb_set("), true);
  assertEquals(sql.includes("'{makesafe_job_family}'"), true);
});
