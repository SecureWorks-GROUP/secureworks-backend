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
} from "./makesafe_intake_gate.ts";
import { _repairFamilyVerdictForApproval } from "./index.ts";

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
