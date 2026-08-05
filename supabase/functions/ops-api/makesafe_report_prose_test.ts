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
  quantifiedMaterialItems,
  reportProseNeedsComposition,
  resolveMakesafeReportProseSections,
  sanitiseReportProse,
} from "./makesafe_report_prose.ts";

Deno.test("report prose contract version is pinned", () => {
  assertEquals(
    MAKESAFE_REPORT_PROSE_CONTRACT_VERSION,
    "report-prose-paragraphs/v1",
  );
});

Deno.test("style rules demand paragraphs and forbid invention/filler", () => {
  const joined = MAKESAFE_REPORT_PROSE_STYLE_RULES.join("\n");
  assertStringIncludes(joined, "short explanatory paragraphs");
  assertStringIncludes(joined, "Never invent");
  assertStringIncludes(joined, "No em dashes");
  assertStringIncludes(joined, "write less");
  assertStringIncludes(joined, "bullet lists");
});

Deno.test("sanitiseReportProse strips em and en dashes", () => {
  assertEquals(
    sanitiseReportProse("Fitted timber — then bugles – done."),
    "Fitted timber - then bugles - done.",
  );
});

Deno.test("quantifiedMaterialItems drops tick-box noise", () => {
  assertEquals(
    quantifiedMaterialItems([
      "Timber x 1m",
      "Bugle screws x 5",
      "Tarps / roof materials",
      "Fixings / consumables",
      "Other / none",
    ]),
    ["Timber x 1m", "Bugle screws x 5"],
  );
});

// Real trade evidence from SWMS-26953 Gidgegannup (five-pack elevated run).
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

// Prior elevated short-sentence blurbs (what the Captain called too terse).
const GIDGE_BEFORE = {
  scope:
    "Make safe the roof structure under the roof-mounted hot water system.",
  findings:
    "Storm / wind. The hot water system on the roof is not engineered for the load. Timber beams have dipped under the weight.",
  works:
    "Fitted two structural timber pieces with bugle screws from the base plate to the underpurlin, giving the roof extra support under the hot water system.",
  materials: "Timber 1 m. Bugle screws x 5.",
};

Deno.test("Gidgegannup trade evidence becomes short explanatory paragraphs", () => {
  const prose = composeMakesafeReportProseFromTradeEvidence(GIDGE_CHECKLIST);

  // Purpose, not a form dump.
  assertStringIncludes(prose.scope.toLowerCase(), "hot water");
  assert(!/make-safe type:/i.test(prose.scope));
  assert(!/^\s*damage:/im.test(prose.scope));

  // Findings paragraph: cause + damage, complete sentences.
  assertStringIncludes(prose.findings, "Storm / wind");
  assertStringIncludes(prose.findings.toLowerCase(), "hot water");
  assertStringIncludes(prose.findings.toLowerCase(), "timber");
  assert(!prose.findings.includes("—"));
  assert(!/^\s*[-*]\s+/m.test(prose.findings));

  // Works paragraph: timber + bugles, not a bare fragment.
  assertStringIncludes(prose.works.toLowerCase(), "bugle");
  assertStringIncludes(prose.works.toLowerCase(), "timber");
  assert(/[.!?]\s+[A-Z]/.test(prose.works) || prose.works.endsWith("."));

  // Materials: quantified only.
  assertStringIncludes(prose.materials, "Timber x 1m");
  assertStringIncludes(prose.materials, "Bugle screws x 5");
  assert(!/tarps \/ roof materials/i.test(prose.materials));
});

Deno.test("Woodvale trade evidence connects tile work without inventing asbestos or collapse", () => {
  const prose = composeMakesafeReportProseFromTradeEvidence(WOODVALE_CHECKLIST);

  assertStringIncludes(prose.scope.toLowerCase(), "water");
  assertStringIncludes(prose.findings.toLowerCase(), "bedroom");
  assertStringIncludes(prose.works.toLowerCase(), "silicon");
  assertStringIncludes(prose.works.toLowerCase(), "flashing");
  assertStringIncludes(prose.works.toLowerCase(), "batten");

  // Honesty: never invent hazard classes or collapse claims.
  assert(!/asbestos/i.test(JSON.stringify(prose)));
  assert(!/collaps/i.test(JSON.stringify(prose)));
  assert(!/at risk/i.test(JSON.stringify(prose)));
});

Deno.test("thin evidence writes less rather than inventing materials", () => {
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
  assertStringIncludes(
    prose.materials.toLowerCase(),
    "no quantified materials",
  );
  assert(!/star picket/i.test(prose.materials));
});

Deno.test("reportProseNeedsComposition detects raw checklist dumps and bullets", () => {
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
    reportProseNeedsComposition("- cracked tiles\n- water in", GIDGE_CHECKLIST),
    true,
  );
  assertEquals(
    reportProseNeedsComposition(GIDGE_BEFORE.works, GIDGE_CHECKLIST),
    false,
  );
});

Deno.test("resolveMakesafeReportProseSections keeps good draft prose and replaces dumps", () => {
  const good = resolveMakesafeReportProseSections(
    GIDGE_BEFORE,
    GIDGE_CHECKLIST,
  );
  assertEquals(good.works, GIDGE_BEFORE.works);

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
