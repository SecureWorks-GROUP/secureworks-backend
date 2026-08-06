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
import type {
  SesInvoicedMaterialsEvidence,
  SesReleasedCycleEvidence,
} from "./ses_invoiced_materials_evidence.ts";

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

// ---------------------------------------------------------------------------
// Settled cards: money already billed, and cycles already shipped, are answers
// to the materials question. The operator is asked only when nobody has
// answered it in either instrument.
// ---------------------------------------------------------------------------

const RECORDED = ["Star picket x 2", "Zip ties x 20", "Fixings / consumables"];

function invoicedEvidence(
  materials_ex_gst = 172,
): SesInvoicedMaterialsEvidence {
  return {
    invoice_id: "xero-uuid-1",
    invoice_number: "INV-0942",
    status: "AUTHORISED",
    materials_ex_gst,
    materials_lines: [
      {
        description: "MLB-23067 - Star pickets supplied - 2 units",
        amount_ex_gst: 27,
      },
      {
        description: "MLB-23067 - Cable ties and small consumables",
        amount_ex_gst: 25,
      },
      {
        description: "MLB-23067 - Temporary fence hire: 2 panels",
        amount_ex_gst: 120,
      },
    ],
    labour_line_count: 1,
    excluded_service_line_count: 0,
  };
}

function releasedEvidence(): SesReleasedCycleEvidence {
  return {
    route_kinds: ["invoice", "photo", "report"],
    last_proven_at: "2026-08-05T11:26:31.529Z",
    invoice_numbers: ["INV-1137"],
    invoice_statuses: ["AUTHORISED"],
  };
}

Deno.test("an issued invoice that prices materials answers instead of asking", () => {
  const decision = decideStandardLabourMaterialsCharge({
    materials_used: RECORDED,
    standing_decision: null,
    priced_materials_line_count: 0,
    invoiced_materials_evidence: invoicedEvidence(),
  });
  assertEquals(decision.action, "already_invoiced");
  if (decision.action !== "already_invoiced") throw new Error("unreachable");
  assertEquals(decision.invoice.invoice_number, "INV-0942");
  // No charge line: that money is committed on the invoice, so a second one
  // here is what a later mint would double-bill.
  assertEquals(decision.provenance.materials_charge_ex_gst, 0);
  assertEquals(decision.provenance.already_invoiced_materials_ex_gst, 172);
  assertEquals(decision.provenance.decision, "already_invoiced");
  assertStringIncludes(String(decision.provenance.note), "INV-0942");
});

Deno.test("a labour-only invoice leaves the materials question standing", () => {
  // The load-bearing distinction. The reading refuses upstream, so what reaches
  // the guard is a null evidence — and the ask must survive it unchanged.
  const decision = decideStandardLabourMaterialsCharge({
    materials_used: RECORDED,
    standing_decision: null,
    priced_materials_line_count: 0,
    invoiced_materials_evidence: null,
  });
  assertEquals(decision.action, "refuse");
  if (decision.action !== "refuse") throw new Error("unreachable");
  assertEquals(decision.reason_code, MATERIALS_CHARGE_FIGURE_REQUIRED);
  assertStringIncludes(decision.recovery_action, "prepare_ses_docket_revision");
});

Deno.test("an operator figure outranks the invoice reading", () => {
  // A human who answered on the operator surface has said what to bill. The
  // invoice reading is the fallback for cards where nobody has.
  const decision = decideStandardLabourMaterialsCharge({
    materials_used: RECORDED,
    standing_decision: { decision: "charge", authorisation: authorisation(90) },
    priced_materials_line_count: 0,
    invoiced_materials_evidence: invoicedEvidence(),
  });
  assertEquals(decision.action, "charge_line");
  if (decision.action !== "charge_line") throw new Error("unreachable");
  assertEquals(decision.amount_ex_gst, 90);

  const cleared = decideStandardLabourMaterialsCharge({
    materials_used: RECORDED,
    standing_decision: {
      decision: "none",
      clearance: {
        cleared_by: "captain@secureworksgroup.app",
        cleared_at: "2026-08-06T01:00:00.000Z",
        decision_key: "materials-none-2026-08-06",
        reason: "No materials charge on this card.",
      },
    },
    priced_materials_line_count: 0,
    invoiced_materials_evidence: invoicedEvidence(),
  });
  assertEquals(cleared.action, "no_charge_recorded");
});

Deno.test("typed priced materials outrank the invoice reading and never turn into a refusal", () => {
  // The regression this ordering exists to prevent: a card that prices
  // correctly today must not start refusing as a double-charge conflict just
  // because its invoice also itemises materials.
  const decision = decideStandardLabourMaterialsCharge({
    materials_used: RECORDED,
    standing_decision: null,
    priced_materials_line_count: 2,
    invoiced_materials_evidence: invoicedEvidence(),
  });
  assertEquals(decision.action, "none");
});

Deno.test("a shipped and billed cycle is never asked to price anything", () => {
  // Woodvale SWMS-261128 / Ballajura SWMS-26902: already shipped with three
  // route proofs and billed. Anyone who supplied a figure here would have
  // double-billed the builder.
  const decision = decideStandardLabourMaterialsCharge({
    materials_used: RECORDED,
    standing_decision: null,
    priced_materials_line_count: 0,
    invoiced_materials_evidence: null,
    released_cycle_evidence: releasedEvidence(),
  });
  assertEquals(decision.action, "already_released");
  if (decision.action !== "already_released") throw new Error("unreachable");
  assertEquals(decision.provenance.decision, "already_released");
  assertEquals(decision.provenance.materials_charge_ex_gst, 0);
  assertEquals(decision.provenance.invoice_numbers, ["INV-1137"]);
  assertStringIncludes(String(decision.provenance.note), "already shipped");
});

Deno.test("terminal outranks every other answer, and refuses a figure rather than double-billing", () => {
  // Terminal beats the invoice reading — it has to, because the eight already
  // sent cards mirror no invoice lines at all and the invoice reading cannot
  // see them.
  const overInvoiced = decideStandardLabourMaterialsCharge({
    materials_used: RECORDED,
    standing_decision: null,
    priced_materials_line_count: 0,
    invoiced_materials_evidence: invoicedEvidence(),
    released_cycle_evidence: releasedEvidence(),
  });
  assertEquals(overInvoiced.action, "already_released");

  // A figure supplied NOW against a released cycle is the Koondoola trap. It is
  // refused loudly, never silently dropped and never silently billed.
  const supplied = decideStandardLabourMaterialsCharge({
    materials_used: RECORDED,
    standing_decision: { decision: "charge", authorisation: authorisation(90) },
    priced_materials_line_count: 0,
    released_cycle_evidence: releasedEvidence(),
    standing_decision_supplied_now: true,
  });
  assertEquals(supplied.action, "refuse");
  if (supplied.action !== "refuse") throw new Error("unreachable");
  assertEquals(supplied.reason_code, MATERIALS_CHARGE_FIGURE_UNSUPPORTED);
  assertStringIncludes(supplied.reason, "already shipped");
  assertStringIncludes(supplied.reason, "second time");
});

Deno.test("terminal never rewrites the decision a shipped card already carried", () => {
  // Mosman Park SWMS-261147 and Gidgegannup SWMS-26953 shipped WITH a materials
  // charge line. That inherited figure is the money the builder was billed, so
  // terminal stands aside and it reproduces unchanged — overriding it would
  // rewrite a shipped docket to say something other than what was billed, and
  // re-key a revision that is already signed off.
  const inherited = decideStandardLabourMaterialsCharge({
    materials_used: RECORDED,
    standing_decision: { decision: "charge", authorisation: authorisation(45) },
    priced_materials_line_count: 0,
    released_cycle_evidence: releasedEvidence(),
    standing_decision_supplied_now: false,
  });
  assertEquals(inherited.action, "charge_line");
  if (inherited.action !== "charge_line") throw new Error("unreachable");
  assertEquals(inherited.amount_ex_gst, 45);

  // The same holds for an inherited withdrawal (Koondoola SWMS-261025 carries
  // one): it keeps saying what it said.
  const inheritedNone = decideStandardLabourMaterialsCharge({
    materials_used: RECORDED,
    standing_decision: {
      decision: "none",
      clearance: {
        cleared_by: null,
        cleared_at: null,
        decision_key: null,
        reason: null,
      },
    },
    priced_materials_line_count: 0,
    released_cycle_evidence: releasedEvidence(),
  });
  assertEquals(inheritedNone.action, "no_charge_recorded");
});

Deno.test("a settled reading is recorded but never inherited as a standing decision", () => {
  // Both markers are readings of live state, not answers a human gave. A later
  // prepare must re-derive them: a voided invoice or a re-attendance has to be
  // able to reopen the question, and a zero-charge marker must never read back
  // as an operator NONE nobody decided.
  for (
    const marker of [
      decideStandardLabourMaterialsCharge({
        materials_used: RECORDED,
        standing_decision: null,
        priced_materials_line_count: 0,
        invoiced_materials_evidence: invoicedEvidence(),
      }),
      decideStandardLabourMaterialsCharge({
        materials_used: RECORDED,
        standing_decision: null,
        priced_materials_line_count: 0,
        released_cycle_evidence: releasedEvidence(),
      }),
    ]
  ) {
    if (
      marker.action !== "already_invoiced" &&
      marker.action !== "already_released"
    ) {
      throw new Error(`unexpected action ${marker.action}`);
    }
    // It IS committed to the revision, so the audit trail keeps it…
    assertEquals(
      materialsChargeDecisionFromRevision({
        local_invoice_proposal: { materials_charge: marker.provenance },
        blockers: null,
      }),
      marker.provenance,
    );
    // …and it is NOT inherited as a decision.
    assertEquals(
      carriedMaterialsChargeDecision({
        prior_materials_charge: marker.provenance,
        materials_used: RECORDED,
      }),
      null,
    );
  }
});
