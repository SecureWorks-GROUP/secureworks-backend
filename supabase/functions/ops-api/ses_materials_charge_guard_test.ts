import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  carriedMaterialsChargeDecision,
  decideStandardLabourMaterialsCharge,
  MATERIALS_CHARGE_DECISION_FACT,
  MATERIALS_CHARGE_FIGURE_REQUIRED,
  MATERIALS_CHARGE_FIGURE_UNSUPPORTED,
  materialsChargeDecisionFromRevision,
  materialsChargeDecisionMarker,
  parseSesMaterialsChargeAuthorisation,
  parseSesMaterialsChargeDirective,
  positiveMaterialsChargeExGst,
  recordedMaterialsUsed,
  SES_MATERIALS_CHARGE_AUTHORISATION_SCHEMA,
  type SesMaterialsChargeAuthorisation,
  SesMaterialsChargeAuthorisationError,
} from "./ses_materials_charge_guard.ts";

function authorisation(amount: number): SesMaterialsChargeAuthorisation {
  return {
    schema: SES_MATERIALS_CHARGE_AUTHORISATION_SCHEMA,
    amount_ex_gst: amount,
    authorised_by: "captain@secureworksgroup.app",
    authorised_at: "2026-08-05T02:00:00.000Z",
    decision_key: "materials-figure-2026-08-05-swms-261065",
    reason: "Operator commercial materials figure for the tipping and fixings.",
  };
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
    standing_decision: null,
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
    standing_decision: { decision: "charge", authorisation: authorisation(65) },
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
    standing_decision: { decision: "charge", authorisation: authorisation(65) },
    priced_materials_line_count: 0,
  });
  assertEquals(decision.action, "refuse");
  if (decision.action !== "refuse") return;
  assertEquals(decision.reason_code, MATERIALS_CHARGE_FIGURE_UNSUPPORTED);
});

Deno.test("a positive figure over already-priced materials refuses instead of vanishing", () => {
  const decision = decideStandardLabourMaterialsCharge({
    materials_used: ["Weatherproof sheet x 1"],
    standing_decision: { decision: "charge", authorisation: authorisation(65) },
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
      standing_decision: null,
      priced_materials_line_count: 1,
    }),
    { action: "none" },
  );
});

Deno.test("empty materials_used allows labour-only proposals", () => {
  assertEquals(
    decideStandardLabourMaterialsCharge({
      materials_used: ["Other / none"],
      standing_decision: null,
      priced_materials_line_count: 0,
    }),
    { action: "none" },
  );
});

Deno.test("a committed decision is inherited only for the materials it names", () => {
  const decision = decideStandardLabourMaterialsCharge({
    materials_used: ["Tarps", "Screws x 20"],
    standing_decision: { decision: "charge", authorisation: authorisation(65) },
    priced_materials_line_count: 0,
  });
  if (decision.action !== "charge_line") throw new Error("expected a charge");
  const committed = decision.provenance;

  assertEquals(
    carriedMaterialsChargeDecision({
      prior_materials_charge: committed,
      materials_used: ["Screws x 20", "Tarps"],
    }),
    { decision: "charge", authorisation: authorisation(65) },
  );
  assertEquals(
    carriedMaterialsChargeDecision({
      prior_materials_charge: committed,
      materials_used: ["Tarps", "Screws x 20", "Structural propping timber"],
    }),
    null,
  );
  assertEquals(
    carriedMaterialsChargeDecision({
      prior_materials_charge: committed,
      materials_used: ["Other / none"],
    }),
    null,
  );
  assertEquals(
    carriedMaterialsChargeDecision({
      prior_materials_charge: null,
      materials_used: ["Tarps", "Screws x 20"],
    }),
    null,
  );
  assertEquals(
    carriedMaterialsChargeDecision({
      prior_materials_charge: { ...committed, authorised_by: "" },
      materials_used: ["Tarps", "Screws x 20"],
    }),
    null,
  );
});

Deno.test("a withdrawal is inherited as a withdrawal, not as a missing answer", () => {
  const withdrawn = decideStandardLabourMaterialsCharge({
    materials_used: ["Tarps", "Screws x 20"],
    standing_decision: {
      decision: "none",
      clearance: {
        cleared_by: "captain@secureworksgroup.app",
        cleared_at: "2026-08-05T03:00:00.000Z",
        decision_key: "materials-none-2026-08-05",
        reason: "No materials charge on this card.",
      },
    },
    priced_materials_line_count: 0,
  });
  assertEquals(withdrawn.action, "no_charge_recorded");
  if (withdrawn.action !== "no_charge_recorded") return;
  assertEquals(withdrawn.provenance.decision, "none");

  assertEquals(
    carriedMaterialsChargeDecision({
      prior_materials_charge: withdrawn.provenance,
      materials_used: ["Screws x 20", "Tarps"],
    }),
    {
      decision: "none",
      clearance: {
        cleared_by: "captain@secureworksgroup.app",
        cleared_at: "2026-08-05T03:00:00.000Z",
        decision_key: "materials-none-2026-08-05",
        reason: "No materials charge on this card.",
      },
    },
  );
});

Deno.test("the newest decision on a revision wins over the older one", () => {
  const charge = materialsChargeDecisionMarker(
    { decision: "charge", authorisation: authorisation(65) },
    ["Tarps"],
  );
  const none = materialsChargeDecisionMarker(
    {
      decision: "none",
      clearance: {
        cleared_by: null,
        cleared_at: null,
        decision_key: null,
        reason: null,
      },
    },
    ["Tarps"],
  );
  // Priced revision: the marker rides on the proposal.
  assertEquals(
    materialsChargeDecisionFromRevision({
      local_invoice_proposal: { materials_charge: none },
      blockers: [],
    }),
    none,
  );
  // Refusing revision: it rides on the blocker facts instead, so a decision
  // made while the card could not price is just as durable.
  assertEquals(
    materialsChargeDecisionFromRevision({
      local_invoice_proposal: null,
      blockers: [
        { reason_code: "pricing_evidence_missing" },
        {
          reason_code: "pricing_evidence_missing",
          facts: { [MATERIALS_CHARGE_DECISION_FACT]: none },
        },
      ],
    }),
    none,
  );
  // A revision that decided nothing must not shadow an older decision.
  assertEquals(
    materialsChargeDecisionFromRevision({
      local_invoice_proposal: { line_items: [] },
      blockers: [{ reason_code: "swms_generation_facts_missing" }],
    }),
    null,
  );
  assertEquals(
    materialsChargeDecisionFromRevision({
      local_invoice_proposal: { materials_charge: charge },
      blockers: null,
    }),
    charge,
  );
});

Deno.test("a present null and an attributed zero both withdraw the figure", () => {
  assertEquals(parseSesMaterialsChargeDirective(null), {
    kind: "cleared",
    clearance: {
      cleared_by: null,
      cleared_at: null,
      decision_key: null,
      reason: null,
    },
  });
  assertEquals(
    parseSesMaterialsChargeDirective({
      ...authorisation(0),
      reason: "Materials were billed on the other card.",
    }),
    {
      kind: "cleared",
      clearance: {
        cleared_by: "captain@secureworksgroup.app",
        cleared_at: "2026-08-05T02:00:00.000Z",
        decision_key: "materials-figure-2026-08-05-swms-261065",
        reason: "Materials were billed on the other card.",
      },
    },
  );
  assertEquals(parseSesMaterialsChargeDirective(authorisation(65)), {
    kind: "charge",
    authorisation: authorisation(65),
  });
  // An unattributed zero is neither a figure nor a recorded withdrawal.
  assertThrows(
    () =>
      parseSesMaterialsChargeDirective({
        ...authorisation(0),
        decision_key: "",
      }),
    SesMaterialsChargeAuthorisationError,
  );
});

Deno.test("every refusal a standing figure causes names the clear path", () => {
  const nothingRecorded = decideStandardLabourMaterialsCharge({
    materials_used: ["Other / none"],
    standing_decision: { decision: "charge", authorisation: authorisation(65) },
    priced_materials_line_count: 0,
  });
  const alreadyPriced = decideStandardLabourMaterialsCharge({
    materials_used: ["Tarps"],
    standing_decision: { decision: "charge", authorisation: authorisation(65) },
    priced_materials_line_count: 1,
  });
  for (const decision of [nothingRecorded, alreadyPriced]) {
    if (decision.action !== "refuse") throw new Error("expected a refusal");
    assertStringIncludes(decision.recovery_action, "materials_charge = null");
  }
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
