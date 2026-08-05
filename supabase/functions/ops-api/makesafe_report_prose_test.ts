// Make-safe report prose paragraph contract.
//
// Run:
//   deno test --no-check --allow-env \
//     supabase/functions/ops-api/makesafe_report_prose_test.ts

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  composeMakesafeReportProseFromTradeEvidence,
  MAKESAFE_REPORT_PROSE_CONTRACT_VERSION,
  MAKESAFE_REPORT_PROSE_STYLE_RULES,
  materialItemsForReport,
  reportProseNeedsComposition,
  resolveMakesafeReportProseSections,
  sanitiseReportProse,
} from "./makesafe_report_prose.ts";

Deno.test("report prose contract version is pinned", () => {
  assertEquals(
    MAKESAFE_REPORT_PROSE_CONTRACT_VERSION,
    "report-prose-paragraphs/v2",
  );
});

Deno.test("style rules demand connected form-facts and forbid invention", () => {
  const joined = MAKESAFE_REPORT_PROSE_STYLE_RULES.join("\n");
  assertStringIncludes(joined, "short explanatory paragraphs");
  assertStringIncludes(joined, "Never invent");
  assertStringIncludes(joined, "showed signs of");
  assertStringIncludes(joined, "No em dashes");
  assertStringIncludes(joined, "write less");
});

Deno.test("sanitiseReportProse strips em and en dashes", () => {
  assertEquals(
    sanitiseReportProse("Fitted timber \u2014 then bugles \u2013 done."),
    "Fitted timber - then bugles - done.",
  );
});

Deno.test("materialItemsForReport keeps tarp ticks and drops pure noise only", () => {
  assertEquals(
    materialItemsForReport([
      "Timber x 1m",
      "Bugle screws x 5",
      "Tarps / roof materials",
      "Fixings / consumables",
      "Other / none",
    ]).items,
    ["Timber x 1m", "Bugle screws x 5", "Tarps / roof materials"],
  );
  // Tarp alone is a real material name the trade recorded - keep it.
  assertEquals(
    materialItemsForReport(["Tarps / roof materials"]).items,
    ["Tarps / roof materials"],
  );
  // Empty list: do not invent consumable ticks.
  const empty = materialItemsForReport([]);
  assertEquals(empty.items, []);
  assertEquals(empty.had_consumable_ticks_only, false);
  const ticksOnly = materialItemsForReport([
    "Fixings / consumables",
    "Other / none",
  ]);
  assertEquals(ticksOnly.items, []);
  assertEquals(ticksOnly.had_consumable_ticks_only, true);
});

// Real trade evidence from SWMS-26953 Gidgegannup.
const GIDGE_CHECKLIST = {
  job_type: "Other",
  damage_cause: "Storm / wind",
  damage_description:
    "Make-safe type: Other: Installation of structural timber\nDamage: Hot water system on top of roof not engineered, create dip in timber beams, as design was not made to support the weight.",
  work_done:
    "Secured 2 structural timber pieces using bugle screws from the base plate to the underperlin. Giving extra support to the roof to hold up the hot water system.",
  materials_used: [
    "Timber x 1m",
    "Bugle screws x 5",
    "Tarps / roof materials",
    "Fixings / consumables",
    "Other / none",
  ],
};

// Real trade evidence from SWMS-261128 Woodvale.
const WOODVALE_CHECKLIST = {
  job_type: "Ceiling / water ingress",
  damage_cause: "Storm / wind",
  damage_description:
    "Make-safe type: Ceiling / water ingress\nDamage: Water ingress into corner of cupboard in bedroom.",
  work_done:
    "Siliconed over cracked ridge cap pointing and large gaps between tiles. As well flashing taped larger gaps between tiles and re secured a batten that was unsecured.",
  materials_used: [
    "Silicone x 1",
    "Flashing tape x 1m",
    "Tarps / roof materials",
    "Fixings / consumables",
    "Other / none",
  ],
};

Deno.test("Gidgegannup: connected form-facts, no invented inspection findings", () => {
  const prose = composeMakesafeReportProseFromTradeEvidence(GIDGE_CHECKLIST);

  // Scope uses form nouns only - hot water + roof - not invented framing inspection.
  assertStringIncludes(prose.scope.toLowerCase(), "hot water");
  assertStringIncludes(prose.scope.toLowerCase(), "roof");
  assert(!/showed signs/i.test(prose.scope));
  assert(!/overload/i.test(prose.scope));
  assert(!/make-safe type:/i.test(prose.scope));
  assert(!/^make safe the other/i.test(prose.scope));

  // Findings: cause + damage connected, form facts only.
  assertStringIncludes(prose.findings.toLowerCase(), "storm");
  assertStringIncludes(prose.findings.toLowerCase(), "hot water");
  assertStringIncludes(prose.findings.toLowerCase(), "timber");
  assertStringIncludes(prose.findings.toLowerCase(), "dip");
  assert(!/showed signs of/i.test(prose.findings));
  assert(!/was found to be/i.test(prose.findings));
  assert(!/appeared/i.test(prose.findings));
  assert(!/asbestos/i.test(prose.findings));
  assert(!/collaps/i.test(prose.findings));

  // Works: action + form's own purpose (extra support / hold up HWS).
  assertStringIncludes(prose.works.toLowerCase(), "bugle");
  assertStringIncludes(prose.works.toLowerCase(), "timber");
  assertStringIncludes(prose.works.toLowerCase(), "underpurlin");
  assert(
    /support|hold up/i.test(prose.works),
    "works should keep the form's purpose clause about support",
  );

  // Materials: quantified + real tarp tick, not pure noise alone.
  assertStringIncludes(prose.materials, "Timber x 1m");
  assertStringIncludes(prose.materials, "Bugle screws x 5");
  assert(!/fixings \/ consumables/i.test(prose.materials));
  assert(!/other \/ none/i.test(prose.materials));
});

Deno.test("Woodvale: water ingress facts without inventing roof path or collapse", () => {
  const prose = composeMakesafeReportProseFromTradeEvidence(WOODVALE_CHECKLIST);

  assertStringIncludes(prose.scope.toLowerCase(), "water");
  assertStringIncludes(prose.findings.toLowerCase(), "bedroom");
  assertStringIncludes(prose.findings.toLowerCase(), "cupboard");
  // Form did not say "through the roof" - do not invent that path.
  assert(
    !/through the roof/i.test(prose.findings),
    "must not invent path through the roof",
  );
  assertStringIncludes(prose.works.toLowerCase(), "silicon");
  assertStringIncludes(prose.works.toLowerCase(), "flashing");
  assertStringIncludes(prose.works.toLowerCase(), "batten");
  assert(!/asbestos/i.test(JSON.stringify(prose)));
  assert(!/collaps/i.test(JSON.stringify(prose)));
  assert(!/at risk/i.test(JSON.stringify(prose)));
});

Deno.test("scope-phrase-invention: shed token must not invent destroyed backyard", () => {
  const prose = composeMakesafeReportProseFromTradeEvidence({
    job_type: "Other",
    damage_cause: "Storm / wind",
    damage_description:
      "Make-safe type: Other\nDamage: Shed roller door dented by tree branch.",
    work_done: "Secured roller door.",
    materials_used: [],
  });
  assert(!/destroyed/i.test(prose.scope));
  assert(!/backyard/i.test(prose.scope));
  assertStringIncludes(prose.scope.toLowerCase(), "shed");
});

Deno.test("scope-phrase-invention: prop alone must not invent drooping ceiling", () => {
  const prose = composeMakesafeReportProseFromTradeEvidence({
    job_type: "Other",
    damage_cause: "Storm / wind",
    damage_description:
      "Make-safe type: Other\nDamage: Ceiling cornice cracked at bedroom.",
    work_done: "Propped patio post.",
    materials_used: [],
  });
  assert(!/drooping/i.test(prose.scope));
  assert(!/drooping/i.test(prose.findings));
});

Deno.test("form-label-leaks: bare Other and empty findings stay honest", () => {
  const prose = composeMakesafeReportProseFromTradeEvidence({
    job_type: "Other",
    damage_cause: "",
    damage_description: "Make-safe type: Other\nDamage: Garage door off track.",
    work_done: "Secured garage door.",
    materials_used: [],
  });
  assert(!/^make safe the other\.?$/i.test(prose.scope));
  assert(!/^other\.?$/i.test(prose.findings));

  const emptyFindings = composeMakesafeReportProseFromTradeEvidence({
    job_type: "Ceiling / water ingress",
    damage_cause: "",
    damage_description: "",
    work_done: "Made safe.",
    materials_used: [],
  });
  assertStringIncludes(
    emptyFindings.findings.toLowerCase(),
    "not recorded",
  );
  assert(!/^ceiling \/ water ingress\.?$/i.test(emptyFindings.findings));
});

Deno.test("materials empty list does not invent consumable ticks", () => {
  const prose = composeMakesafeReportProseFromTradeEvidence({
    job_type: "Other",
    damage_cause: "Storm / wind",
    damage_description: "Damage: Fence panel loose.",
    work_done: "Resecured panel.",
    materials_used: [],
  });
  assertEquals(
    prose.materials,
    "No materials were recorded on the trade form.",
  );
  assert(!/consumable ticks/i.test(prose.materials));
});

Deno.test("thin shed evidence writes less rather than inventing materials", () => {
  const prose = composeMakesafeReportProseFromTradeEvidence({
    job_type: "Patio / structure",
    damage_cause: "Storm / wind",
    damage_description:
      "Make-safe type: Patio / structure\nDamage: Destroyed shed flat on ground in backyard of dwelling.",
    work_done: "Removal and disposal of shed.",
    materials_used: [
      "Bases / feet",
      "Tarps / roof materials",
      "Fixings / consumables",
      "Other / none",
    ],
  });
  assertStringIncludes(prose.works.toLowerCase(), "shed");
  // Real ticks kept.
  assertStringIncludes(prose.materials.toLowerCase(), "tarp");
});

Deno.test("reportProseNeedsComposition detects raw dumps and bare form labels", () => {
  assertEquals(
    reportProseNeedsComposition(
      GIDGE_CHECKLIST.damage_description,
      GIDGE_CHECKLIST,
    ),
    true,
  );
  assertEquals(
    reportProseNeedsComposition("Storm / wind", GIDGE_CHECKLIST),
    true,
  );
  assertEquals(
    reportProseNeedsComposition("Make safe the other.", GIDGE_CHECKLIST),
    true,
  );
  assertEquals(
    reportProseNeedsComposition("- cracked tiles\n- water in", GIDGE_CHECKLIST),
    true,
  );
});

Deno.test("resolveMakesafeReportProseSections replaces dumps", () => {
  const replaced = resolveMakesafeReportProseSections(
    {
      scope: GIDGE_CHECKLIST.damage_description,
      findings: GIDGE_CHECKLIST.damage_cause,
      works: GIDGE_CHECKLIST.work_done,
      materials: GIDGE_CHECKLIST.materials_used.join(", "),
    },
    GIDGE_CHECKLIST,
  );
  assert(!/make-safe type:/i.test(replaced.scope));
  assertStringIncludes(replaced.materials, "Timber x 1m");
  assert(!/fixings \/ consumables/i.test(replaced.materials));
});
