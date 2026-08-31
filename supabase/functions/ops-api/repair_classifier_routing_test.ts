// deno-lint-ignore-file no-explicit-any no-import-prefix
//
// The classifier must actually route a real repair.
//
// A production risk assessment found the pipeline was built correctly and would
// still have left the Repairs board empty:
//
//   * 0 of the 3 live repair cards were classified `repair` at mint. Both that
//     came through deterministic intake carry `GENERAL_MAKESAFE` on their case.
//   * In 90 days across 1685 work-order PDFs: zero `Rapid Repair` declared
//     headers, two `Scaffolding/Access Equipment`, and 242
//     `Makesafe/Emergency Repairs`.
//   * Both `**RAPID REPAIR**` subjects in that window were approved as
//     `general_makesafe`, because the approval-time fallback classifier wrapped
//     the NON-deterministic decider and was therefore structurally incapable of
//     ever emitting `repair`.
//
// These tests reproduce the two real shapes and prove they now route to repair,
// with controls proving ordinary make-safe work still routes to make-safe.
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyMakeSafeJobFamily,
  decideDeterministicMakeSafeJobFamily,
  decideMakeSafeJobFamily,
  detectRepairLegSignal,
} from "./makesafe_intake_gate.ts";
import { extractPdfDeclaredType } from "./makesafe_pdf_declared_type.ts";
import {
  _repairFamilyVerdictForApproval,
  _shouldAutoApproveCleanIntakeForTest,
} from "./index.ts";

// ── The two real shapes from the assessment ──────────────────────────────────

// MLB-26303, 2026-08-07. The builder puts the repair label in the SUBJECT; the
// body reads like ordinary physical make-safe work, which is why the ladder
// answers general_makesafe and the upgrade has to carry it.
const RAPID_REPAIR_SUBJECT =
  "**RAPID REPAIR** NEW WORK ORDER - WO-26303 - 14 Bannister Road";
const PHYSICAL_MAKESAFE_BODY = [
  "Please attend site and make safe.",
  "Tarp the damaged roof section and board up the broken window to the rear.",
  "Contact the tenant before attending.",
].join("\n");

// The labelled dispatch line. Deliberately distinguishable from an email
// signature that merely mentions the company name.
const DISPATCH_LINE_BODY = [
  "New allocation attached.",
  "Dispatch Class: Rapid Repairs",
  "Attend and rectify the damaged eaves and gutter run.",
].join("\n");

// The false positive the labelled-line rule exists to reject.
const SIGNATURE_ONLY_BODY = [
  "Please attend and make safe the storm-damaged roof.",
  "",
  "Kind regards,",
  "Chantelle Nicholls",
  "Repair Coordinator | Rapid Repair",
  "PO Box 2143 Malaga WA 6944",
].join("\n");

Deno.test("a **RAPID REPAIR** work order routes to repair on the approval fallback", () => {
  // This is the exact regression. classifyMakeSafeJobFamily is what
  // approveIntakeDraft falls back to when a draft is not flagged
  // deterministic_intake, and it used to wrap the decider with no upgrade.
  assertEquals(
    classifyMakeSafeJobFamily(RAPID_REPAIR_SUBJECT, PHYSICAL_MAKESAFE_BODY),
    "repair",
  );

  // The deterministic layer already agreed; the fallback now matches it rather
  // than contradicting it.
  assertEquals(
    decideDeterministicMakeSafeJobFamily(
      RAPID_REPAIR_SUBJECT,
      PHYSICAL_MAKESAFE_BODY,
    ).family,
    "repair",
  );
});

Deno.test("a labelled Dispatch Class: Rapid Repairs line routes to repair", () => {
  assertEquals(
    classifyMakeSafeJobFamily("NEW WORK ORDER - WO-27249", DISPATCH_LINE_BODY),
    "repair",
  );
});

Deno.test("the declared repair PDF header still routes to repair", () => {
  // Unchanged by this fix — the header already reached repair through the shared
  // ladder. Asserted so the fallback change cannot regress it.
  for (const declaredType of ["repair"]) {
    assertEquals(
      classifyMakeSafeJobFamily(
        "NEW WORK ORDER - WO-11111",
        "Erect scaffolding to the eastern elevation.",
        null,
        { pdfDeclaredType: { declaredType } as any },
      ),
      "repair",
    );
  }
});

// ── Controls: ordinary make-safe work is untouched ───────────────────────────

Deno.test("CONTROL: an ordinary physical make-safe still routes to make-safe", () => {
  assertEquals(
    classifyMakeSafeJobFamily("NEW WORK ORDER - WO-24001", PHYSICAL_MAKESAFE_BODY),
    "general_makesafe",
  );
});

Deno.test("CONTROL: a Rapid Repair email SIGNATURE cannot retag a make-safe", () => {
  // The body rule requires a LABELLED standalone dispatch line precisely so the
  // company name in a signature block is inert. Eight rows in the live text
  // sweep matched this shape.
  assertEquals(
    classifyMakeSafeJobFamily("NEW WORK ORDER - WO-24002", SIGNATURE_ONLY_BODY),
    "general_makesafe",
  );
});

Deno.test("CONTROL: MLB's Makesafe/Emergency Repairs category is still a make-safe", () => {
  // 242 of the last 90 days' work-order headers. The grammar maps it to
  // make-safe on purpose and this fix deliberately does not touch that — reading
  // that label as repair is an unmade captain decision. If this test ever flips,
  // it flips on a ruling, not by accident.
  assertEquals(
    classifyMakeSafeJobFamily(
      "NEW WORK ORDER - WO-26999",
      "Attend and make safe following storm damage.",
      null,
      { pdfDeclaredType: { declaredType: "makesafe" } as any },
    ),
    "general_makesafe",
  );
});

Deno.test("CONTROL: the upgrade cannot overwrite a family the ladder actually decided", () => {
  // The rapid-repair upgrade only fires when the ladder returned
  // general_makesafe or abstained. A roof report that happens to carry the
  // subject label stays a roof report.
  const roof = classifyMakeSafeJobFamily(
    RAPID_REPAIR_SUBJECT,
    "Conduct a single storey roof report and submit via the portal.",
    null,
    { pdfDeclaredType: { declaredType: "roof" } as any },
  );
  assertEquals(roof, "roof_report");

  const assessment = classifyMakeSafeJobFamily(
    RAPID_REPAIR_SUBJECT,
    "Assessment and quote required.",
    null,
    { pdfDeclaredType: { declaredType: "assessment" } as any },
  );
  assertEquals(assessment, "assessment_report_quote");
});

Deno.test("CONTROL: the non-deterministic decider is itself unchanged", () => {
  // Only the back-compat WRAPPER moved. decideMakeSafeJobFamily still has no
  // rapid-repair upgrade, so every caller that deliberately wants the raw ladder
  // gets exactly what it got before.
  assertEquals(
    decideMakeSafeJobFamily(RAPID_REPAIR_SUBJECT, PHYSICAL_MAKESAFE_BODY).family,
    "general_makesafe",
  );
});

// ── The approval seam must not downgrade a persisted repair verdict ──────────

Deno.test("a persisted repair verdict survives approval without the deterministic flag", () => {
  // deterministicDraftFamilyForApproval only honours a stored family when
  // extraction.deterministic_intake === true. Everything else fell through to
  // the fallback classifier, which re-decided from scratch and downgraded the
  // verdict. That is what happened to MLB-26303.
  assertEquals(
    _repairFamilyVerdictForApproval({ makesafe_job_family: "repair" }, false),
    "repair",
  );
  assertEquals(
    _repairFamilyVerdictForApproval(
      { makesafe_job_family: "repair", deterministic_intake: false },
      false,
    ),
    "repair",
  );
  assertEquals(
    _repairFamilyVerdictForApproval({ makesafe_job_family: "  REPAIR " }, false),
    "repair",
  );
});

Deno.test("CONTROL: the repair rescue claims nothing else", () => {
  // Repair-only by design: 'repair' is never a classifier's default or abstain
  // answer, so its presence is positive evidence. Every other family keeps
  // exactly today's gating.
  for (
    const family of [
      "general_makesafe",
      "temp_fence_makesafe",
      "roof_report",
      "assessment_report_quote",
      "restoration",
      null,
      undefined,
      "",
      "repairs",
    ]
  ) {
    assertEquals(
      _repairFamilyVerdictForApproval({ makesafe_job_family: family }, false),
      null,
      `${family} must not be rescued`,
    );
  }
  assertEquals(_repairFamilyVerdictForApproval({}, false), null);
  assertEquals(_repairFamilyVerdictForApproval(null, false), null);

  // And a combined split's PRIMARY is a physical make-safe that must never
  // inherit the draft's family, repair included.
  assertEquals(
    _repairFamilyVerdictForApproval({ makesafe_job_family: "repair" }, true),
    null,
  );
});

// ── Ruled 2026-08-28 (repair-siphon taxonomy): verbs decide, nouns do not ────
//
// The corpus test behind these fixtures: 394 deliverable work orders over 61
// days held exactly 8 repairs, every one a fence/gate/sheet REPLACEMENT. The
// replacement verbs identified all of them and nothing else; the bare words
// "repair" (17% precision), "carpentry" (0%) and "shed" (5%) identified noise.
// Sealed alongside: dual-scope work orders mint the MAKE-SAFE card first and
// flag a repair LEG for a human-spawned child (Ruling 5, two-card dual scope).

// MLB-24659 shape: a pure replacement scope with no emergency leg.
const REPLACEMENT_SCOPE_BODY = [
  "NEW WORK ORDER attached.",
  "Remove and dispose of damaged 1800mm Hardieflex fencing, supply and",
  "install 1800mm Colorbond fencing to match, remove and replace metal gate.",
].join("\n");

// MLB-24481 shape: an emergency temp-fence leg AND a replacement leg in one
// work order. The make-safe card wins; the replacement rides as a leg flag.
const DUAL_SCOPE_BODY = [
  "Please attend to make safe. Install temporary fencing to secure the",
  "property, approx 8 panels.",
  "Quote to remove and replace storm damaged fence panels with 1800H Colorbond.",
].join("\n");

const TEMP_FENCE_ONLY_BODY =
  "Please attend to supply and install temporary fencing around the pool, approx 10 metres.";

Deno.test("a replacement scope with no emergency leg routes to repair", () => {
  const decision = decideMakeSafeJobFamily(
    "NEW WORK ORDER - MLB-24659",
    REPLACEMENT_SCOPE_BODY,
  );
  assertEquals(decision.family, "repair");
  assertEquals(decision.evidence, "repair_replacement_scope");
  assertEquals(
    classifyMakeSafeJobFamily("NEW WORK ORDER - MLB-24659", REPLACEMENT_SCOPE_BODY),
    "repair",
  );
});

Deno.test("the Fencing EXTERNAL declared header reads as repair", () => {
  // MLB-24319 PO-56427 — a real MLB allocation header the grammar did not know,
  // observed on a confirmed fence replacement.
  const parsed = extractPdfDeclaredType([
    "Work Order",
    "Work Order Assigned SecureWorks Group Work Order Number MLB-24319PO-56427",
    "Allocation Work Order",
    "Site contact 0400 000 000",
    "Fencing EXTERNAL",
    "Material for remove, dispose and replace hardies fibre cement fencing",
  ].join("\n"));
  assertEquals(parsed.declaredType, "repair");
  assertEquals(parsed.fenceSubtype, false);
  assertEquals(
    classifyMakeSafeJobFamily(
      "NEW WORK ORDER - MLB-24319",
      "See attached work order.",
      null,
      { pdfDeclaredType: parsed },
    ),
    "repair",
  );
});

Deno.test("CONTROL: the Temporary Fencing header is untouched by the Fencing pattern", () => {
  const parsed = extractPdfDeclaredType([
    "Allocation Work Order",
    "Site contact 0400 000 000",
    "Temporary Fencing",
    "Make Safe",
  ].join("\n"));
  assertEquals(parsed.declaredType, "makesafe");
  assertEquals(parsed.fenceSubtype, true);
});

Deno.test("Ruling 5: a dual-scope work order stays make-safe and flags the repair leg", () => {
  // The emergency leg wins the card — Hugo and Ryan's temp fence must never
  // leave the MakeSafe board because a replacement leg rode along.
  assertEquals(
    classifyMakeSafeJobFamily("NEW WORK ORDER - MLB-24481", DUAL_SCOPE_BODY),
    "temp_fence_makesafe",
  );
  const leg = detectRepairLegSignal("NEW WORK ORDER - MLB-24481", DUAL_SCOPE_BODY);
  assertEquals(leg.detected, true);
  assertEquals(leg.evidence, "remove and replace");
});

Deno.test("CONTROL: a plain temp-fence install is not a repair leg", () => {
  assertEquals(
    classifyMakeSafeJobFamily("NEW WORK ORDER - AJBR-67081", TEMP_FENCE_ONLY_BODY),
    "temp_fence_makesafe",
  );
  assertEquals(
    detectRepairLegSignal("NEW WORK ORDER - AJBR-67081", TEMP_FENCE_ONLY_BODY)
      .detected,
    false,
  );
});

Deno.test("CONTROL: the corpus-measured noise words never reach repair", () => {
  // "carpentry" is AJ's trade dispatch label (0% precision) ...
  assertEquals(
    classifyMakeSafeJobFamily(
      "MAKE SAFE REQUEST - Carpentry",
      "MAKE SAFE REQUEST - Carpentry BUSINESS HOURS. Please attend the property to conduct make safe to a double storey ceiling.",
      null,
      { builder: "ajbr" },
    ),
    "general_makesafe",
  );
  // ... "shed" is make-safe TO a damaged shed (5%) ...
  const shed =
    "Make safe to shed. Tarp damaged roof sheeting and secure the property.";
  assertEquals(
    classifyMakeSafeJobFamily("NEW WORK ORDER - MLB-25387", shed),
    "general_makesafe",
  );
  assertEquals(detectRepairLegSignal(null, shed).detected, false);
  // ... and "repair" inside make-safe phrasing (17%) moves nothing.
  const tempRepair =
    "Identify area where water is entering and make temporary repair to make water tight.";
  assertEquals(
    classifyMakeSafeJobFamily("NEW WORK ORDER - AJBR-67870", tempRepair),
    "general_makesafe",
  );
  assertEquals(detectRepairLegSignal(null, tempRepair).detected, false);
});

Deno.test("Ruled 2026-08-28: a repair-family draft never auto-approves (supervised lane)", () => {
  // An SWR- mint is irreversible, so the lane runs with a human tap on every
  // repair draft until the captains release the brake.
  assertEquals(
    _shouldAutoApproveCleanIntakeForTest({ jobFamily: "repair" } as any),
    { ok: false, reason: "repair_family_supervised_review" },
  );
  // CONTROL: the brake is repair-specific — every other family proceeds to the
  // ordinary evidence gates and fails on those, never on the brake.
  const control = _shouldAutoApproveCleanIntakeForTest(
    { jobFamily: "general_makesafe" } as any,
  );
  assertEquals(control.ok, false);
  assertEquals(control.reason, "missing_work_order_pdf");
});

// ── Captain ruling 2026-08-31: the identified-work-order repair complement ───
//
// "A properly identified, readable work order that is NOT general make-safe,
// NOT a roof report, NOT an assessment/quote report, and NOT a temporary fence
// make-safe is repair." The complement applies ONLY to a genuine abstention
// (`ambiguous_scope`) over a readable scope with settled instruction identity —
// the floor the 2026-08-25 scout report said a bare not-one-of-three test
// lacks. Every boundary the captain set explicitly is a control below.

import { applyIdentifiedWorkOrderRepairComplement } from "./makesafe_intake_gate.ts";

const FLOOR_PASSED = { scopeReadable: true, identityProved: true };

Deno.test("the complement turns an identified readable abstention into repair", () => {
  assertEquals(
    applyIdentifiedWorkOrderRepairComplement(
      { family: null, evidence: "ambiguous_scope" },
      FLOOR_PASSED,
    ),
    { family: "repair", evidence: "identified_wo_repair_complement" },
  );
});

Deno.test("CONTROL: the complement never fires below the quality floor", () => {
  // An unreadable or boilerplate-only work order is not a readable work order.
  assertEquals(
    applyIdentifiedWorkOrderRepairComplement(
      { family: null, evidence: "ambiguous_scope" },
      { scopeReadable: false, identityProved: true },
    ).family,
    null,
  );
  // An unknown builder / insufficient identity yields no canonical key.
  assertEquals(
    applyIdentifiedWorkOrderRepairComplement(
      { family: null, evidence: "ambiguous_scope" },
      { scopeReadable: true, identityProved: false },
    ).family,
    null,
  );
});

Deno.test("CONTROL: restoration parks stay parked — the complement reads only ambiguous_scope", () => {
  for (
    const evidence of ["text_restoration_park", "ajs_restoration_park"] as const
  ) {
    assertEquals(
      applyIdentifiedWorkOrderRepairComplement(
        { family: null, evidence },
        FLOOR_PASSED,
      ),
      { family: null, evidence },
      `${evidence} must keep parking`,
    );
  }
});

Deno.test("CONTROL: the complement can never move a positively classified family", () => {
  const positives = [
    { family: "general_makesafe", evidence: "physical_makesafe" },
    { family: "temp_fence_makesafe", evidence: "text_temp_fence" },
    { family: "temp_fence_makesafe", evidence: "typed_temp_fence" },
    { family: "roof_report", evidence: "typed_roof_report" },
    { family: "assessment_report_quote", evidence: "text_assessment_report" },
    { family: "restoration", evidence: "typed_restoration" },
    { family: "general_makesafe", evidence: "ajs_make_safe_floor" },
    { family: "repair", evidence: "pdf_declared_type_header" },
  ] as const;
  for (const decision of positives) {
    assertEquals(
      applyIdentifiedWorkOrderRepairComplement(decision as any, FLOOR_PASSED),
      decision,
      `${decision.family}/${decision.evidence} must pass through unchanged`,
    );
  }
});
