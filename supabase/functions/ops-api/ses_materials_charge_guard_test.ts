import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideStandardLabourMaterialsCharge,
  MATERIALS_CHARGE_FIGURE_REQUIRED,
  MATERIALS_CHARGE_FIGURE_UNSUPPORTED,
  parseSesMaterialsChargeAuthorisation,
  positiveMaterialsChargeExGst,
  recordedMaterialsUsed,
  SES_MATERIALS_CHARGE_AUTHORISATION_SCHEMA,
  SesMaterialsChargeAuthorisationError,
} from "./ses_materials_charge_guard.ts";

function authorisation(amount: number) {
  return {
    schema: SES_MATERIALS_CHARGE_AUTHORISATION_SCHEMA,
    amount_ex_gst: amount,
    authorised_by: "captain@secureworksgroup.app",
    authorised_at: "2026-08-05T02:00:00.000Z",
    decision_key: "materials-figure-2026-08-05-swms-261065",
    reason: "Operator commercial materials figure for the tipping and fixings.",
  } as const;
}

Deno.test("recordedMaterialsUsed drops none/placeholder ticks and keeps real materials", () => {
  assertEquals(
    recordedMaterialsUsed([
      "Polycarb sheet x 1",
      "Other / none",
      "None",
      "  ",
      "n/a",
      "Tarps / roof materials",
    ]),
    ["Polycarb sheet x 1", "Tarps / roof materials"],
  );
  assertEquals(recordedMaterialsUsed("One weatherproof sheet installed."), [
    "One weatherproof sheet installed.",
  ]);
  assertEquals(recordedMaterialsUsed([]), []);
  assertEquals(recordedMaterialsUsed(null), []);
  assertEquals(recordedMaterialsUsed("None"), []);
  assertEquals(
    recordedMaterialsUsed([
      { key: "tarp", selected: true, label: "Tarps / roof materials" },
      { key: "none", selected: false, label: "Other / none" },
    ]),
    ["Tarps / roof materials"],
  );
});

Deno.test("an unticked checklist row is not a recorded material", () => {
  assertEquals(
    recordedMaterialsUsed([
      { label: "Tarps", checked: false },
      { label: "Star pickets", checked: true },
      { label: "Screws" },
    ]),
    ["Star pickets", "Screws"],
  );
});

Deno.test("an empty description does not drop a labelled material", () => {
  assertEquals(
    recordedMaterialsUsed([
      { description: "", label: "Tarps", checked: true },
      { description: "   ", name: "Polycarb sheet" },
    ]),
    ["Tarps", "Polycarb sheet"],
  );
});

Deno.test("key underscores read as words but builder-visible hyphens survive", () => {
  assertEquals(
    recordedMaterialsUsed([
      { key: "star_pickets" },
      "Tarps - heavy duty",
      "Non-slip mesh",
    ]),
    ["star pickets", "Tarps - heavy duty", "Non-slip mesh"],
  );
});

Deno.test("positiveMaterialsChargeExGst rejects zero and non-numbers", () => {
  assertEquals(positiveMaterialsChargeExGst(65), 65);
  assertEquals(positiveMaterialsChargeExGst("65.5"), 65.5);
  assertEquals(positiveMaterialsChargeExGst(0), null);
  assertEquals(positiveMaterialsChargeExGst(-1), null);
  assertEquals(positiveMaterialsChargeExGst("x"), null);
});

Deno.test("silent labour-only when materials_used is present must ask one figure", () => {
  const decision = decideStandardLabourMaterialsCharge({
    materials_used: ["Polycarb disposal / tipping", "Screws x 20"],
    operator_charge: null,
    priced_materials_line_count: 0,
  });
  assertEquals(decision.action, "refuse");
  if (decision.action !== "refuse") return;
  assertEquals(decision.reason_code, MATERIALS_CHARGE_FIGURE_REQUIRED);
  assertEquals(decision.materials, [
    "Polycarb disposal / tipping",
    "Screws x 20",
  ]);
  // The recovery action must name a path the operator can actually run.
  assertStringIncludes(
    decision.recovery_action,
    "prepare_ses_docket_revision",
  );
  assertStringIncludes(decision.recovery_action, "materials_charge");
});

Deno.test("an authorised operator figure produces one builder-readable charge line", () => {
  const decision = decideStandardLabourMaterialsCharge({
    materials_used: ["Polycarb disposal / tipping"],
    operator_charge: authorisation(65),
    priced_materials_line_count: 0,
  });
  assertEquals(decision.action, "charge_line");
  if (decision.action !== "charge_line") return;
  assertEquals(decision.amount_ex_gst, 65);
  assertEquals(decision.materials, ["Polycarb disposal / tipping"]);
  // Builder-facing wording only — no internal jargon on the money document.
  assertEquals(
    decision.description,
    "Materials used: Polycarb disposal / tipping",
  );
  assertEquals(decision.provenance.estimate, false);
  assertEquals(
    decision.provenance.decision_key,
    "materials-figure-2026-08-05-swms-261065",
  );
});

Deno.test("a positive figure with nothing to charge for refuses instead of vanishing", () => {
  const decision = decideStandardLabourMaterialsCharge({
    materials_used: ["Other / none"],
    operator_charge: authorisation(65),
    priced_materials_line_count: 0,
  });
  assertEquals(decision.action, "refuse");
  if (decision.action !== "refuse") return;
  assertEquals(decision.reason_code, MATERIALS_CHARGE_FIGURE_UNSUPPORTED);
});

Deno.test("a positive figure over already-priced materials refuses instead of vanishing", () => {
  const decision = decideStandardLabourMaterialsCharge({
    materials_used: ["Weatherproof sheet x 1"],
    operator_charge: authorisation(65),
    priced_materials_line_count: 1,
  });
  assertEquals(decision.action, "refuse");
  if (decision.action !== "refuse") return;
  assertEquals(decision.reason_code, MATERIALS_CHARGE_FIGURE_UNSUPPORTED);
});

Deno.test("typed priced materials lines satisfy the guard without a one-figure field", () => {
  assertEquals(
    decideStandardLabourMaterialsCharge({
      materials_used: ["Tarps / roof materials"],
      operator_charge: null,
      priced_materials_line_count: 1,
    }),
    { action: "none" },
  );
});

Deno.test("empty materials_used allows labour-only proposals", () => {
  assertEquals(
    decideStandardLabourMaterialsCharge({
      materials_used: ["Other / none"],
      operator_charge: null,
      priced_materials_line_count: 0,
    }),
    { action: "none" },
  );
});

Deno.test("an unattributable or non-positive materials figure is refused at the door", () => {
  assertThrows(
    () => parseSesMaterialsChargeAuthorisation({ amount_ex_gst: 65 }),
    SesMaterialsChargeAuthorisationError,
  );
  assertThrows(
    () =>
      parseSesMaterialsChargeAuthorisation({
        ...authorisation(65),
        amount_ex_gst: 0,
      }),
    SesMaterialsChargeAuthorisationError,
  );
  assertThrows(
    () =>
      parseSesMaterialsChargeAuthorisation({
        ...authorisation(65),
        decision_key: "  ",
      }),
    SesMaterialsChargeAuthorisationError,
  );
  assertEquals(
    parseSesMaterialsChargeAuthorisation(authorisation(65.129)).amount_ex_gst,
    65.13,
  );
});
