// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _buildMakesafeFamilyBackfillCandidatesForTest,
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
  assertEquals(
    _inferMakesafeFamilyForActiveBackfillForTest({
      metadata: {
        builder_email_subject: "**RAPID REPAIR** NEW WORK ORDER - MLB-261163",
      },
    }),
    "repair",
  );
  assertEquals(
    _inferMakesafeFamilyForActiveBackfillForTest({
      detail: { report_type: "repair" },
    }),
    "repair",
  );
  assertEquals(
    _inferMakesafeFamilyForActiveBackfillForTest({
      metadata: {
        builder_email_text_for_trade:
          "Please attend.\nRepair Coordinator | Rapid Repair",
      },
    }),
    null,
  );
});

Deno.test("active family backfill: repairs unknown and MakeSafe cards but never roofs", () => {
  const rows = [
    {
      id: "unknown-repair",
      job_number: "SWMS-1",
      status: "accepted",
      metadata: {
        builder_email_subject: "RAPID REPAIR NEW WORK ORDER",
      },
    },
    {
      id: "makesafe-repair",
      job_number: "SWMS-2",
      status: "accepted",
      metadata: {
        makesafe_job_family: "general_makesafe",
        builder_email_subject: "RAPID REPAIR NEW WORK ORDER",
      },
    },
    {
      id: "roof-protected",
      job_number: "SWMS-3",
      status: "accepted",
      metadata: {
        makesafe_job_family: "roof_report",
        builder_email_subject: "RAPID REPAIR NEW WORK ORDER",
      },
    },
  ];
  const candidates = _buildMakesafeFamilyBackfillCandidatesForTest(
    rows,
    {},
    {},
  );

  assertEquals(candidates.map((row: any) => row.job_number), [
    "SWMS-1",
    "SWMS-2",
  ]);
  assertEquals(candidates.map((row: any) => row.inferred_family), [
    "repair",
    "repair",
  ]);
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
