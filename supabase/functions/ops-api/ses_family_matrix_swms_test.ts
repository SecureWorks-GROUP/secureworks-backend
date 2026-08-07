// deno-lint-ignore-file no-import-prefix no-explicit-any
//
// Captain ruling 2026-08-07 (Harden SES ticket 04): EVERY physical make-safe
// carries a SWMS regardless of builder. The old AJS builder waiver and the
// WESTERN hrcw-only carve-out are dead. Report-only families (roof,
// assessment) stay swms-not-required at the blocker layer for now — the
// generator includes a SWMS in their packs, and the requirement flips only
// after the Captain has seen a week of accurate generation.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveSesFamilyMatrixRow } from "./ses_family_matrix.ts";

const PHYSICAL_BUILDERS = ["MLB", "AJS", "AJBR", "WESTERN"] as const;

Deno.test("every builder's physical family requires a SWMS", () => {
  const PHYSICAL_FAMILIES = [
    "physical_makesafe",
    "temporary_fencing",
    "repair",
    "restoration",
  ] as const;
  for (const builder_key of PHYSICAL_BUILDERS) {
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
      `${builder_key} physical must carry swms_policy=always`,
    );
    assertEquals(
      matrix.row.swms_waiver_rule,
      null,
      `${builder_key} must carry no SWMS waiver`,
    );
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
