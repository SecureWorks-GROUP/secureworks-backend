// SES Item 10 -- the guard suite that proves the rules-clean definition is real.
//
// The spec's acceptance check, verbatim: "one test per guard in the list above:
// with that guard flagging, the invoice STOPS AT DRAFT and the card names the
// flagging guard. A guard that cannot fail the automation is not part of the
// definition, and this suite is what proves the definition is real."
//
// So the shape here is deliberate and should not be simplified: a single
// rules-clean BASELINE, then one mutation per guard. If the baseline ever stops
// classifying clean the whole suite goes vacuous, which is why the first test
// asserts it directly.

import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifySesInvoiceRulesClean,
  deriveSealedProposal,
  SES_RULES_CLEAN_CONTRACT_VERSION,
  SES_RULES_CLEAN_GUARDS,
  type SesRulesCleanEvidence,
  type SesRulesCleanGuardId,
} from "./makesafe_invoice_rules_clean.ts";
import { resolveSesInvoiceDuplicates } from "./makesafe_invoice_duplicate_resolver.ts";

const CYCLE = "cycle-current";

/**
 * A card that IS rules-clean: MLB physical make-safe, 2 trades x 5 hours at the
 * sealed $85, no materials, no override, no live money, independently proven
 * pack. Modelled on the live shape of the board's only family-A-and-B-clean
 * card at the 2026-08-06 shadow run.
 */
function baseline(): SesRulesCleanEvidence {
  return {
    job_id: "job-1",
    job_number: "SWMS-000001",
    family: "physical_makesafe",
    // The determination point is a POSITIVE CLAIM, never inferred from what
    // happens to be absent: this baseline is a pre-mint card.
    determination_point: "pre_mint",
    docket: {
      revision_id: "rev-1",
      job_id: "job-1",
      stage: "pre_xero",
      state: "ready",
      blockers: [],
      pre_xero_docs_ready: true,
      attendance_cycle_ids: [CYCLE],
      local_invoice_proposal: {
        basis: "standard_labour_materials",
        builder_reference: "MLB-25147",
        trades: 2,
        billable_hours_per_trade: 5,
        reported_hours_per_trade: 5,
        billable_hours_floor: 3,
        subtotal_ex_gst: 850,
        line_items: [{
          description: "MLB-25147 - make-safe attendance - 2 trades x 5 hours",
          quantity: 10,
          unit_price_ex_gst: 85,
        }],
      },
    },
    current_attendance_cycle_id: CYCLE,
    composed_reference: "MLB-25147",
    duplicate: {
      job_id: "job-1",
      match_tier: null,
      ambiguity: "none",
      live_invoices: [],
      allows_create: true,
      reason_codes: [],
    },
    full_accrec_scan: { rows_scanned: 930, matches: 0 },
    report_evidence_independent: true,
  };
}

function mutate(
  change: (evidence: SesRulesCleanEvidence) => void,
): SesRulesCleanEvidence {
  const evidence = baseline();
  change(evidence);
  return evidence;
}

/**
 * The shared assertion for every guard case: the determination PARKS, the named
 * guard is among what parked it, and it did not come back clean.
 */
function assertParksOn(
  evidence: SesRulesCleanEvidence,
  guard: SesRulesCleanGuardId,
  expected: "flagged" | "unevaluable",
): void {
  const verdict = classifySesInvoiceRulesClean(evidence);
  assertEquals(
    verdict.verdict,
    "parks",
    `expected ${guard} to park the card, got ${verdict.verdict}`,
  );
  assert(
    verdict.parked_on.includes(guard),
    `expected ${guard} in parked_on, got ${verdict.parked_on.join(",")}`,
  );
  const outcome = verdict.guards.find((row) => row.id === guard)!;
  assertEquals(outcome.status, expected, `${guard} status`);
  assert(outcome.detail.length > 10, `${guard} must state why on the card`);
}

// ── The baseline. Without this the whole suite proves nothing. ─────────────

Deno.test("the rules-clean baseline classifies clean, so every guard case below is a real mutation", () => {
  const verdict = classifySesInvoiceRulesClean(baseline());
  assertEquals(
    verdict.verdict,
    "rules_clean",
    JSON.stringify(verdict.parked_on),
  );
  assertEquals(verdict.parked_on.length, 0);
  assertEquals(verdict.park_reason, null);
  assertEquals(verdict.contract_version, SES_RULES_CLEAN_CONTRACT_VERSION);
  // Every guard on the closed list produced an outcome; none was skipped.
  assertEquals(verdict.guards.length, SES_RULES_CLEAN_GUARDS.length);
  for (const guard of verdict.guards) assertEquals(guard.status, "clean");
});

// ── Family A: identity and duplication ────────────────────────────────────

Deno.test("A1: a live invoice on any duplicate tier parks the card", () => {
  assertParksOn(
    mutate((evidence) => {
      evidence.duplicate = {
        job_id: "job-1",
        match_tier: "reference_po_base",
        ambiguity: "none",
        live_invoices: [{
          job_id: null,
          xero_invoice_id: "x-1",
          invoice_number: "INV-1",
          status: "AUTHORISED",
          reference: "MLB-25147PO-56481",
        }],
        allows_create: false,
        reason_codes: ["blocked_duplicate_live"],
      };
    }),
    "A1_duplicate_resolver_all_tiers",
    "flagged",
  );
});

Deno.test("A2: every duplicate ambiguity state parks, it never warns", () => {
  for (
    const ambiguity of [
      "multi_live",
      "sibling_po",
      "void_only",
      "mirror_xero_mismatch",
    ] as const
  ) {
    assertParksOn(
      mutate((evidence) => {
        evidence.duplicate = {
          job_id: "job-1",
          match_tier: null,
          ambiguity,
          live_invoices: [],
          // The dangerous case: the probe says create is allowed AND records an
          // ambiguity. That combination is exactly what reached a real card.
          allows_create: true,
          reason_codes: [],
        };
      }),
      "A2_ambiguity_is_refusal",
      "flagged",
    );
  }
});

Deno.test("A3: an empty builder reference can never be rules-clean", () => {
  assertParksOn(
    mutate((evidence) => {
      evidence.composed_reference = "   ";
    }),
    "A3_builder_reference_present",
    "flagged",
  );
});

Deno.test("A4: the full live-ACCREC scan finding money parks the card", () => {
  assertParksOn(
    mutate((evidence) => {
      evidence.full_accrec_scan = { rows_scanned: 930, matches: 1 };
    }),
    "A4_full_accrec_scan",
    "flagged",
  );
});

Deno.test("A5: an excluded invoice that is not this card's own current DRAFT parks", () => {
  // AUTHORISED, so not a thing this automation may advance.
  assertParksOn(
    mutate((evidence) => {
      evidence.determination_point = "authorise";
      evidence.obligation = { revision_id: "ob-1" };
      evidence.subject_invoice = {
        xero_invoice_id: "x-9",
        status: "AUTHORISED",
        invoice_obligation_revision_id: "ob-1",
        sub_total: 850,
        totals_source: "xero_api",
      };
    }),
    "A5_subject_invoice_is_our_current_draft",
    "flagged",
  );
  // A DRAFT bound to somebody else's obligation revision: excluding it from the
  // duplicate question would hide money that is not ours.
  assertParksOn(
    mutate((evidence) => {
      evidence.determination_point = "authorise";
      evidence.obligation = { revision_id: "ob-1" };
      evidence.subject_invoice = {
        xero_invoice_id: "x-9",
        status: "DRAFT",
        invoice_obligation_revision_id: "ob-other",
        sub_total: 850,
        totals_source: "xero_api",
      };
    }),
    "A5_subject_invoice_is_our_current_draft",
    "flagged",
  );
});

Deno.test("A5: this card's own current DRAFT is the subject, not a duplicate", () => {
  const verdict = classifySesInvoiceRulesClean(mutate((evidence) => {
    evidence.determination_point = "authorise";
    evidence.obligation = { revision_id: "ob-1" };
    evidence.subject_invoice = {
      xero_invoice_id: "x-9",
      status: "DRAFT",
      invoice_obligation_revision_id: "ob-1",
      // 2 trades x 5 hours at the sealed $85 is $850 ex, and the DRAFT in Xero
      // carries exactly that. This is the case that must stay clean, or the
      // A6 cases below prove nothing.
      sub_total: 850,
      total: 935,
      totals_source: "xero_api",
    };
  }));
  assertEquals(verdict.verdict, "rules_clean", verdict.parked_on.join(","));
});

Deno.test("A5: an absent or unreadable subject at the authorise point parks, it never passes", () => {
  // The card says it is advancing an existing DRAFT and supplies none. That is
  // missing evidence, and missing evidence is not passing evidence.
  assertParksOn(
    mutate((evidence) => {
      evidence.determination_point = "authorise";
      evidence.obligation = { revision_id: "ob-1" };
      evidence.subject_invoice = null;
    }),
    "A5_subject_invoice_is_our_current_draft",
    "unevaluable",
  );
  // And a read that failed says so, rather than being absorbed as "absent".
  assertParksOn(
    mutate((evidence) => {
      evidence.determination_point = "authorise";
      evidence.subject_invoice_read_error = "xero_invoices unreadable";
    }),
    "A5_subject_invoice_is_our_current_draft",
    "unevaluable",
  );
});

Deno.test("A5: an unstated or unrecognised determination point parks the card", () => {
  for (
    const change of [
      (evidence: SesRulesCleanEvidence) => {
        delete evidence.determination_point;
      },
      (evidence: SesRulesCleanEvidence) => {
        evidence.determination_point = null;
      },
      (evidence: SesRulesCleanEvidence) => {
        (evidence as { determination_point: unknown }).determination_point =
          "after_the_fact";
      },
    ]
  ) {
    assertParksOn(
      mutate(change),
      "A5_subject_invoice_is_our_current_draft",
      "unevaluable",
    );
  }
  // A pre-mint claim contradicted by a supplied invoice is a flag, not a pass.
  assertParksOn(
    mutate((evidence) => {
      evidence.determination_point = "pre_mint";
      evidence.subject_invoice = {
        xero_invoice_id: "x-9",
        status: "DRAFT",
        invoice_obligation_revision_id: "ob-1",
      };
    }),
    "A5_subject_invoice_is_our_current_draft",
    "flagged",
  );
});

Deno.test("A6: a Xero DRAFT whose own total is not the sealed total parks the card", () => {
  // The draft stays editable in Xero after the mint. Everything upstream can be
  // correct and the money still wrong; A6 is the only guard that looks at it.
  assertParksOn(
    mutate((evidence) => {
      evidence.determination_point = "authorise";
      evidence.obligation = { revision_id: "ob-1" };
      evidence.subject_invoice = {
        xero_invoice_id: "x-9",
        status: "DRAFT",
        invoice_obligation_revision_id: "ob-1",
        sub_total: 1250,
        totals_source: "xero_api",
      };
    }),
    "A6_xero_draft_total_is_the_sealed_total",
    "flagged",
  );
});

Deno.test("A6: an absent, non-numeric or unreadable Xero total parks rather than passing", () => {
  const draft = (
    extra: Record<string, unknown>,
  ): (evidence: SesRulesCleanEvidence) => void =>
  (evidence) => {
    evidence.determination_point = "authorise";
    evidence.obligation = { revision_id: "ob-1" };
    evidence.subject_invoice = {
      xero_invoice_id: "x-9",
      status: "DRAFT",
      invoice_obligation_revision_id: "ob-1",
      ...extra,
    };
  };
  for (
    const change of [
      // No total at all.
      draft({ totals_source: "xero_api" }),
      // A total that is not a number.
      draft({ sub_total: "850.00", totals_source: "xero_api" }),
      // A total with no stated origin: it cannot be trusted as the money.
      draft({ sub_total: 850 }),
      // The read itself failed.
      draft({
        sub_total: 850,
        totals_source: "xero_api",
        totals_read_error: "Xero 503",
      }),
    ]
  ) {
    assertParksOn(
      mutate(change),
      "A6_xero_draft_total_is_the_sealed_total",
      "unevaluable",
    );
  }
});

// ── The PO-suffix regression, in BOTH directions ──────────────────────────
//
// This is the incident the whole item is built around, and the spec requires it
// to exist before automation switches on. It drives the REAL resolver rather
// than a hand-written resolution, because the defect was in the resolver.

Deno.test("PO suffix: a card is refused whichever side carries the purchase order", () => {
  const bareOnCard = resolveSesInvoiceDuplicates(
    [{ job_id: "job-1", external_ref: "MLB-27093" }],
    [{
      job_id: null,
      xero_invoice_id: "x-1",
      invoice_number: "INV-1",
      status: "AUTHORISED",
      reference: "MLB-27093PO-56481",
      invoice_type: "ACCREC",
    }],
  )[0];
  assertFalse(bareOnCard.allows_create, "bare card ref vs PO-bearing invoice");

  const poOnCard = resolveSesInvoiceDuplicates(
    [{ job_id: "job-1", external_ref: "MLB-27093PO-56481" }],
    [{
      job_id: null,
      xero_invoice_id: "x-1",
      invoice_number: "INV-1",
      status: "AUTHORISED",
      reference: "MLB-27093",
      invoice_type: "ACCREC",
    }],
  )[0];
  assertFalse(poOnCard.allows_create, "PO-bearing card ref vs bare invoice");

  // And the classifier parks on both, rather than reading the resolver's
  // refusal as anything softer.
  for (const duplicate of [bareOnCard, poOnCard]) {
    assertParksOn(
      mutate((evidence) => {
        evidence.duplicate = duplicate;
      }),
      "A1_duplicate_resolver_all_tiers",
      "flagged",
    );
  }
});

// ── Family B: pricing ─────────────────────────────────────────────────────

Deno.test("B1: a pricing basis with no sealed derivation parks, it does not pass", () => {
  assertParksOn(
    mutate((evidence) => {
      evidence.docket!.local_invoice_proposal!.basis = "temporary_fence_hire";
    }),
    "B1_pricing_basis_sealed",
    "unevaluable",
  );
});

Deno.test("B2: any line the sealed law would not have produced parks the card", () => {
  // An extra line nobody modelled. This is the whitelist doing its job: the
  // fault shape does not have to be anticipated to be refused.
  assertParksOn(
    mutate((evidence) => {
      evidence.docket!.local_invoice_proposal!.line_items = [
        {
          description: "MLB-25147 - make-safe attendance - 2 trades x 5 hours",
          quantity: 10,
          unit_price_ex_gst: 85,
        },
        {
          description: "MLB-25147 - site allowance",
          quantity: 1,
          unit_price_ex_gst: 120,
        },
      ];
    }),
    "B2_sealed_line_derivation",
    "flagged",
  );
  // Hand-edited builder-facing wording on an otherwise correct line.
  assertParksOn(
    mutate((evidence) => {
      evidence.docket!.local_invoice_proposal!.line_items = [{
        description: "MLB-25147 - emergency callout (2 trades, 5 hours)",
        quantity: 10,
        unit_price_ex_gst: 85,
      }];
    }),
    "B2_sealed_line_derivation",
    "flagged",
  );
});

Deno.test("B3: a labour rate that is not the sealed builder rate parks the card", () => {
  assertParksOn(
    mutate((evidence) => {
      evidence.docket!.local_invoice_proposal!.line_items = [{
        description: "MLB-25147 - make-safe attendance - 2 trades x 5 hours",
        quantity: 10,
        unit_price_ex_gst: 110,
      }];
    }),
    "B3_company_labour_schedule",
    "flagged",
  );
});

Deno.test("B4: billing under the sealed attendance floor parks the card", () => {
  assertParksOn(
    mutate((evidence) => {
      const proposal = evidence.docket!.local_invoice_proposal!;
      proposal.trades = 1;
      proposal.reported_hours_per_trade = 1;
      proposal.billable_hours_per_trade = 1;
      proposal.billable_hours_floor = 1;
      proposal.line_items = [{
        description: "MLB-25147 - make-safe attendance - 1 trade x 1 hours",
        quantity: 1,
        unit_price_ex_gst: 85,
      }];
    }),
    "B4_attendance_hours_floor",
    "flagged",
  );
  // And the card names the rule it actually broke: the hours, not a line count
  // downstream of them.
  const verdict = classifySesInvoiceRulesClean(mutate((evidence) => {
    const proposal = evidence.docket!.local_invoice_proposal!;
    proposal.billable_hours_per_trade = 8;
    proposal.line_items = [{
      description: "MLB-25147 - make-safe attendance - 2 trades x 8 hours",
      quantity: 16,
      unit_price_ex_gst: 85,
    }];
  }));
  assert(verdict.park_reason);
  assert(
    verdict.park_reason.toLowerCase().includes("hour"),
    verdict.park_reason,
  );
});

Deno.test("B5: a roof report off the sealed storey rate parks the card", () => {
  // A double-storey roof priced at the SUPERSEDED $350 ex, the shape three
  // pre-ruling dockets still carry. The skill's Python report-rate guard tests
  // the roof price one-sidedly (`ex + 0.01 < expected`, a FLOOR), so it reports
  // clean on any overcharge; the sealed derivation compares the rate itself and
  // does not. Both directions are asserted here for that reason.
  assertParksOn(
    mutate((evidence) => {
      evidence.family = "own_template_roof";
      evidence.docket!.local_invoice_proposal = {
        basis: "roof_storey_fixed",
        builder_reference: "MLB-27100",
        storeys: "double",
        line_items: [{
          description: "MLB-27100 - Double Storey roof report",
          quantity: 1,
          unit_price_ex_gst: 350,
        }],
      };
    }),
    "B5_report_rate",
    "flagged",
  );
  // The sealed price for the same card is clean.
  const sealed = classifySesInvoiceRulesClean(mutate((evidence) => {
    evidence.family = "own_template_roof";
    evidence.docket!.local_invoice_proposal = {
      basis: "roof_storey_fixed",
      builder_reference: "MLB-27100",
      storeys: "double",
      line_items: [{
        description: "MLB-27100 - Double Storey roof report",
        quantity: 1,
        unit_price_ex_gst: 300,
      }],
    };
  }));
  assertEquals(sealed.verdict, "rules_clean", sealed.parked_on.join(","));
});

Deno.test("B6: a zero, empty or negative invoice parks the card", () => {
  for (
    const lines of [
      [],
      [{
        description: "MLB-25147 - make-safe attendance - 2 trades x 5 hours",
        quantity: 10,
        unit_price_ex_gst: 0,
      }],
      [{
        description: "MLB-25147 - make-safe attendance - 2 trades x 5 hours",
        quantity: 10,
        unit_price_ex_gst: -85,
      }],
    ]
  ) {
    assertParksOn(
      mutate((evidence) => {
        evidence.docket!.local_invoice_proposal!.line_items = lines;
      }),
      "B6_nonzero",
      "flagged",
    );
  }
});

Deno.test("B7: hand-priced money parks, including a rate override with a full audit trail", () => {
  // A bare flag with no audit trail is not an approval...
  assertParksOn(
    mutate((evidence) => {
      evidence.docket!.local_invoice_proposal!.line_items = [{
        description: "MLB-25147 - make-safe attendance - 2 trades x 5 hours",
        quantity: 10,
        unit_price_ex_gst: 85,
        rate_override_approved: true,
      }];
    }),
    "B7_no_hand_pricing",
    "flagged",
  );
  // ...and a COMPLETE one is still hand-priced, which is the Captain's press.
  assertParksOn(
    mutate((evidence) => {
      evidence.docket!.local_invoice_proposal!.line_items = [{
        description: "MLB-25147 - make-safe attendance - 2 trades x 5 hours",
        quantity: 10,
        unit_price_ex_gst: 85,
        rate_override_approved: true,
        rate_override_by: "Captain Marnin Stobbe",
        rate_override_at: "2026-08-06T01:00:00.000Z",
      }];
    }),
    "B7_no_hand_pricing",
    "flagged",
  );
  // A Captain commercial quantity override on the bound obligation likewise.
  assertParksOn(
    mutate((evidence) => {
      evidence.commercial_quantity_override = { authorised_by: "Captain" };
    }),
    "B7_no_hand_pricing",
    "flagged",
  );
  // And an operator materials-charge decision.
  assertParksOn(
    mutate((evidence) => {
      evidence.docket!.local_invoice_proposal!.materials_charge = {
        amount_ex_gst: 45,
      };
    }),
    "B7_no_hand_pricing",
    "flagged",
  );
});

Deno.test("B8: a materials-bearing invoice parks until item 08 seals a rate card", () => {
  assertParksOn(
    mutate((evidence) => {
      evidence.docket!.local_invoice_proposal!.line_items = [
        {
          description: "MLB-25147 - make-safe attendance - 2 trades x 5 hours",
          quantity: 10,
          unit_price_ex_gst: 85,
        },
        {
          description: "MLB-25147 - Materials used: Timber x 1m; Fixings",
          quantity: 1,
          unit_price_ex_gst: 45,
        },
      ];
    }),
    "B8_materials_rate_card_sealed",
    "flagged",
  );
  // The AJS star-picket carve-out is SEALED, but it is still a material, and
  // the ticket's dependency names labour-only and report-rate as the unaffected
  // classes. Widening to it is a D5 question, not a code decision.
  assertParksOn(
    mutate((evidence) => {
      evidence.docket!.local_invoice_proposal!.line_items = [
        {
          description: "MLB-25147 - make-safe attendance - 2 trades x 5 hours",
          quantity: 10,
          unit_price_ex_gst: 85,
        },
        {
          description:
            "MLB-25147 - Star pickets supplied to prop and secure existing fence",
          quantity: 20,
          unit_price_ex_gst: 13.5,
        },
      ];
    }),
    "B8_materials_rate_card_sealed",
    "flagged",
  );
});

// ── Family C: evidence and readiness ──────────────────────────────────────

Deno.test("C1: a docket that is not zero-blocker ready parks the card", () => {
  for (
    const change of [
      (evidence: SesRulesCleanEvidence) => {
        evidence.docket!.blockers = [{ code: "pricing_evidence_missing" }];
      },
      (evidence: SesRulesCleanEvidence) => {
        evidence.docket!.state = "blocked";
      },
      (evidence: SesRulesCleanEvidence) => {
        evidence.docket!.pre_xero_docs_ready = false;
      },
      (evidence: SesRulesCleanEvidence) => {
        evidence.docket!.stage = "invoice_bound";
      },
    ]
  ) {
    assertParksOn(mutate(change), "C1_docket_ready_zero_blockers", "flagged");
  }
});

Deno.test("C2: a docket that does not cover this card's current cycle parks it", () => {
  assertParksOn(
    mutate((evidence) => {
      evidence.docket!.attendance_cycle_ids = ["cycle-previous"];
    }),
    "C2_docket_bound_to_this_card_and_cycle",
    "flagged",
  );
  assertParksOn(
    mutate((evidence) => {
      evidence.docket!.job_id = "job-other";
    }),
    "C2_docket_bound_to_this_card_and_cycle",
    "flagged",
  );
});

Deno.test("C3: a self-vouched or unproven pack parks the card", () => {
  assertParksOn(
    mutate((evidence) => {
      evidence.report_evidence_independent = false;
    }),
    "C3_report_evidence_floor",
    "flagged",
  );
  assertParksOn(
    mutate((evidence) => {
      evidence.report_evidence_independent = null;
    }),
    "C3_report_evidence_floor",
    "unevaluable",
  );
});

// ── A guard that ERRORS parks the card. Never clean. ──────────────────────

Deno.test("a guard that cannot evaluate parks the card, in every family", () => {
  const cases: Array<
    [string, (e: SesRulesCleanEvidence) => void, SesRulesCleanGuardId]
  > = [
    ["duplicate read", (e) => {
      e.duplicate_read_error = "PostgREST 503";
    }, "A1_duplicate_resolver_all_tiers"],
    ["duplicate absent", (e) => {
      e.duplicate = null;
    }, "A1_duplicate_resolver_all_tiers"],
    ["full scan error", (e) => {
      e.full_accrec_scan_error = "Xero mirror unreadable";
    }, "A4_full_accrec_scan"],
    ["full scan absent", (e) => {
      e.full_accrec_scan = null;
    }, "A4_full_accrec_scan"],
    ["priced lines read", (e) => {
      e.priced_lines_read_error = "obligation unreadable";
    }, "B2_sealed_line_derivation"],
    ["docket read", (e) => {
      e.docket_read_error = "PostgREST 503";
    }, "C1_docket_ready_zero_blockers"],
    ["report proof read", (e) => {
      e.report_evidence_read_error = "storage unreachable";
    }, "C3_report_evidence_floor"],
  ];
  for (const [label, change, guard] of cases) {
    const verdict = classifySesInvoiceRulesClean(mutate(change));
    assertEquals(verdict.verdict, "parks", label);
    const outcome = verdict.guards.find((row) => row.id === guard)!;
    assertEquals(outcome.status, "unevaluable", `${label} -> ${guard}`);
  }
});

Deno.test("an absent docket parks every readiness and pricing guard, none of them clean", () => {
  const verdict = classifySesInvoiceRulesClean(mutate((evidence) => {
    evidence.docket = null;
  }));
  assertEquals(verdict.verdict, "parks");
  for (const guard of verdict.guards) {
    if (guard.family === "B" || guard.family === "C") {
      assertEquals(guard.status, "unevaluable", guard.id);
    }
  }
});

// ── Structural invariants ────────────────────────────────────────────────

Deno.test("no path from a rules-clean determination reaches send", () => {
  const clean = classifySesInvoiceRulesClean(baseline());
  assertEquals(clean.verdict, "rules_clean");
  // The determination carries no send affordance, on either verdict.
  assertEquals(clean.authorises_send, false);
  assertEquals(
    classifySesInvoiceRulesClean(mutate((e) => {
      e.composed_reference = null;
    })).authorises_send,
    false,
  );
  // And nothing in the serialised verdict names a route, recipient or send
  // beyond the one key that exists to say it does not. Strip that key and the
  // whole payload must be silent about the send path.
  const { authorises_send: _explicitlyFalse, ...rest } = clean;
  const serialised = JSON.stringify(rest).toLowerCase();
  for (const marker of ["route", "recipient", "send", "mail", "graph"]) {
    assertFalse(
      serialised.includes(marker),
      `the determination must not mention "${marker}"`,
    );
  }
});

Deno.test("every guard on the closed list is answered on every verdict", () => {
  const ids = SES_RULES_CLEAN_GUARDS.map((guard) => guard.id);
  assertEquals(new Set(ids).size, ids.length, "guard ids must be unique");
  for (
    const evidence of [
      baseline(),
      mutate((e) => {
        e.docket = null;
      }),
      mutate((e) => {
        e.duplicate_read_error = "boom";
      }),
      {
        job_id: "bare",
        docket: null,
        duplicate: null,
      } as SesRulesCleanEvidence,
    ]
  ) {
    const verdict = classifySesInvoiceRulesClean(evidence);
    assertEquals(verdict.guards.map((guard) => guard.id), ids);
  }
});

Deno.test("a bare evidence object with nothing in it parks rather than passing", () => {
  const verdict = classifySesInvoiceRulesClean(
    { job_id: "bare", docket: null, duplicate: null } as SesRulesCleanEvidence,
  );
  assertEquals(verdict.verdict, "parks");
  assertEquals(
    // NOTHING on a bare card is clean. A5 used to be, on the strength of an
    // absent `subject_invoice` -- which is missing evidence read as passing
    // evidence, the blind-guard shape this module exists to refuse.
    verdict.guards.filter((guard) => guard.status === "clean").map((g) => g.id),
    [],
  );
});

Deno.test("the park reason names the guard, so the card can show why it waits", () => {
  const verdict = classifySesInvoiceRulesClean(mutate((evidence) => {
    evidence.composed_reference = "";
  }));
  assert(verdict.park_reason);
  assert(
    verdict.park_reason.includes("A3_builder_reference_present"),
    verdict.park_reason,
  );
  assert(
    verdict.park_reason.toLowerCase().includes("captain"),
    "a parked card must say it is waiting on his press",
  );
});

Deno.test("the sealed derivation refuses rather than guessing a missing fact", () => {
  for (
    const proposal of [
      { basis: "standard_labour_materials", builder_reference: "MLB-1" },
      {
        basis: "standard_labour_materials",
        builder_reference: "MLB-1",
        trades: 2,
      },
      { basis: "roof_storey_fixed", builder_reference: "MLB-1" },
      { basis: "assessment_fixed", builder_reference: "MLB-1" },
      { basis: "standard_labour_materials", builder_reference: "" },
    ]
  ) {
    const derived = deriveSealedProposal(proposal, "physical_makesafe");
    assertEquals(derived.lines, null, JSON.stringify(proposal));
    assert(derived.undeterminable, JSON.stringify(proposal));
  }
  // An unrecognised SES family has no sealed builder-facing wording, so the
  // derivation refuses instead of inventing a line the builder would read.
  const unknownFamily = deriveSealedProposal({
    basis: "standard_labour_materials",
    builder_reference: "MLB-1",
    trades: 1,
    billable_hours_per_trade: 3,
    reported_hours_per_trade: 3,
  }, "some_new_family");
  assertEquals(unknownFamily.lines, null);
  assert(unknownFamily.undeterminable);
});
