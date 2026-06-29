import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _inferMakesafeFamilyForActiveBackfillForTest } from "./index.ts";

Deno.test("active family backfill: only four canonical families and no pseudo-types", () => {
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
