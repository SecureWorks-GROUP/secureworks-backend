// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _filterMakesafeFamilyBackfillCandidatesForScopeForTest,
  _inferMakesafeFamilyForActiveBackfillForTest,
} from "./index.ts";

Deno.test("active family backfill: all canonical families and no pseudo-types", () => {
  assertEquals(
    _inferMakesafeFamilyForActiveBackfillForTest({
      notes:
        "Roof report request - single storey roof report to identify cause of damage/point of water entry",
    }),
    "roof_report",
  );
  assertEquals(
    _inferMakesafeFamilyForActiveBackfillForTest({
      notes:
        "Contractor inspection and assessment for fence damage; quote required",
    }),
    "assessment_report_quote",
  );
  assertEquals(
    _inferMakesafeFamilyForActiveBackfillForTest({
      notes: "Install temporary fencing, approximately 7 panels, 3 month hire",
    }),
    "temp_fence_makesafe",
  );
  assertEquals(
    _inferMakesafeFamilyForActiveBackfillForTest({
      notes: "Water damage restoration works required throughout the dwelling",
    }),
    "restoration",
  );
  assertEquals(
    _inferMakesafeFamilyForActiveBackfillForTest({
      notes:
        "Board up window and make safe ceiling collapse with prop and brace",
    }),
    null,
  );
  assertEquals(
    _inferMakesafeFamilyForActiveBackfillForTest({
      notes: "Make roof watertight as rainwater is entering through the roof",
    }),
    null,
  );
});

Deno.test("active family backfill: explicit job-number scope can hold a stale approved write set", () => {
  const candidates = [
    { job_number: "SWMS-26780", inferred_family: "assessment_report_quote" },
    { job_number: "SWMS-26769", inferred_family: "assessment_report_quote" },
    { job_number: "SWMS-26744", inferred_family: "assessment_report_quote" },
    { job_number: "SWMS-TEST-0611", inferred_family: "temp_fence_makesafe" },
  ];

  assertEquals(
    _filterMakesafeFamilyBackfillCandidatesForScopeForTest(candidates as any, {
      job_numbers: ["swms-26780", "SWMS-26769"],
    }).map((c) => c.job_number),
    ["SWMS-26780", "SWMS-26769"],
  );

  assertEquals(
    _filterMakesafeFamilyBackfillCandidatesForScopeForTest(candidates as any, {
      exclude_job_numbers: "SWMS-TEST-0611 SWMS-26744",
    }).map((c) => c.job_number),
    ["SWMS-26780", "SWMS-26769"],
  );
});
