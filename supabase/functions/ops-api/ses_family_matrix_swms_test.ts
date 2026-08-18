// deno-lint-ignore-file no-import-prefix no-explicit-any
//
// AC18/AC19: every physical family/builder hard-requires a generated SWMS;
// roof and assessment include it without blocking until the accuracy gate.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveSesFamilyMatrixRow,
  sesFamilyRequiresSwms,
} from "./ses_family_matrix.ts";

Deno.test("Docs Ready hard-requires SWMS for every physical family and builder", () => {
  for (
    const builder of ["MLB", "AJS", "AJBR", "WESTERN", "SYNTHETIC"] as const
  ) {
    for (
      const family of [
        "physical_makesafe",
        "temporary_fencing",
        "repair",
        "restoration",
      ] as const
    ) {
      assertEquals(
        sesFamilyRequiresSwms(builder, family),
        true,
        `${builder}:${family}`,
      );
    }
  }
  for (
    const family of [
      "ordinary_roof_portal",
      "own_template_roof",
      "assessment_quote",
    ] as const
  ) {
    assertEquals(sesFamilyRequiresSwms("MLB", family), false, family);
  }
});

Deno.test("matrix generation policy is always for every physical family and builder", () => {
  const PHYSICAL_FAMILIES = [
    "physical_makesafe",
    "temporary_fencing",
    "repair",
    "restoration",
  ] as const;
  for (
    const builder_key of ["MLB", "AJS", "AJBR", "WESTERN"] as const
  ) {
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
        "always",
        `${builder_key}:${family}`,
      );
      assertEquals(matrix.row.swms_waiver_rule, null);
    }
  }
});

Deno.test("roof variants and assessment include SWMS without hard requirement until accuracy gate", () => {
  for (
    const family of [
      "ordinary_roof_portal",
      "own_template_roof",
      "assessment_quote",
    ] as const
  ) {
    const matrix: any = resolveSesFamilyMatrixRow({
      builder_key: "MLB",
      family,
      strata: family === "own_template_roof",
      own_template_requested: family === "own_template_roof",
    });
    assert(matrix.ok, `${family} row must resolve`);
    assert(matrix.row.report_only, `${family} must stay report_only`);
    assertEquals(
      matrix.row.swms_policy,
      "include_not_required_until_accuracy_gate",
    );
    assertEquals(
      matrix.row.swms_waiver_rule,
      "swms-included-not-required-until-accuracy-gate",
    );
  }
});
