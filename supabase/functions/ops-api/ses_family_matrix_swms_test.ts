// deno-lint-ignore-file no-import-prefix no-explicit-any
//
// Captain lock 2026-08-13: Docs Ready requires SWMS only for MLB physical
// MakeSafe. Matrix generation metadata remains separately explicit.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveSesFamilyMatrixRow,
  sesFamilyRequiresSwms,
} from "./ses_family_matrix.ts";

Deno.test("Docs Ready requires SWMS only for the MLB physical MakeSafe family", () => {
  assertEquals(sesFamilyRequiresSwms("MLB", "physical_makesafe"), true);
  for (const builder of ["AJS", "AJBR", "WESTERN", "SYNTHETIC"] as const) {
    assertEquals(
      sesFamilyRequiresSwms(builder, "physical_makesafe"),
      false,
      builder,
    );
  }
  for (
    const family of [
      "ordinary_roof_portal",
      "own_template_roof",
      "assessment_quote",
      "temporary_fencing",
      "repair",
      "restoration",
    ] as const
  ) {
    assertEquals(sesFamilyRequiresSwms("MLB", family), false, family);
  }
});

Deno.test("matrix generation policies remain explicit for every physical-shaped row", () => {
  const PHYSICAL_FAMILIES = [
    "physical_makesafe",
    "temporary_fencing",
    "repair",
    "restoration",
  ] as const;
  for (const builder_key of ["AJS", "AJBR"] as const) {
    for (const family of PHYSICAL_FAMILIES) {
      const matrix: any = resolveSesFamilyMatrixRow({
        builder_key,
        family,
        strata: false,
        own_template_requested: false,
      });
      assert(matrix.ok, `${builder_key} physical row must resolve`);
      assertEquals(
        matrix.row.swms_policy,
        "builder_waiver_unless_hrcw",
        `${builder_key} physical must default to no SWMS`,
      );
      assertEquals(
        matrix.row.swms_waiver_rule,
        "ajs-default-no-swms-unless-hrcw",
      );
    }
  }
  for (const builder_key of ["MLB", "WESTERN"] as const) {
    for (const family of PHYSICAL_FAMILIES) {
      const matrix: any = resolveSesFamilyMatrixRow({
        builder_key,
        family,
        strata: false,
        own_template_requested: false,
      });
      assert(matrix.ok, `${builder_key} physical row must resolve`);
      assertEquals(matrix.row.swms_policy, "always");
      assertEquals(matrix.row.swms_waiver_rule, null);
    }
  }
});

Deno.test("report-only families remain swms-not-required at the blocker layer", () => {
  for (const family of ["ordinary_roof_portal", "assessment_quote"] as const) {
    const matrix: any = resolveSesFamilyMatrixRow({
      builder_key: "MLB",
      family,
      strata: false,
      own_template_requested: false,
    });
    assert(matrix.ok, `${family} row must resolve`);
    assert(matrix.row.report_only, `${family} must stay report_only`);
    assert(
      matrix.row.swms_policy !== "always",
      `${family} requirement flips only after a week of accurate generation`,
    );
  }
});
