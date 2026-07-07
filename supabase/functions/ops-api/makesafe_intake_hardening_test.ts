// Intake engine hardening (request 2026-07-06). Covers the three build items:
//   1. wrong-type guard (roof/assessment keyword-fallback vs a real WO PDF),
//   2. cancellation path (CANCELLED WORK ORDER must never mint a draft),
//   3. one email -> two cards (combined make-safe + report is flagged, never auto-filed),
// plus the default-OFF opt-in auto-approval flag. The real live failure cases are named:
// the MLB-25769 cancellation twins and the wrong-type roof fallback.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isGenuineNewWorkOrder,
  mappedModelReportType,
  subjectIsCancellation,
  textHasExplicitReportRequest,
} from "./makesafe_intake_gate.ts";
import {
  _autoApproveCleanIntakeEnabledForTest as autoApproveEnabled,
  _effectiveIntakeReportTypeForTest as effectiveReportType,
  _flagCombinedIntakeObligationForTest as flagCombined,
  _hasPositiveReportOnlyEvidenceForTest as hasPositiveReportEvidence,
  _shouldAutoApproveCleanIntakeDraftRowForTest as sweepDecision,
  _shouldAutoApproveCleanIntakeForTest as gateDecision,
} from "./index.ts";

const WO_PDF = {
  file_name: "Work Order MLB-26010.pdf",
  pdf_url: "https://example.test/wo.pdf",
  is_work_order: true,
};

// ── Item 2: cancellation path ───────────────────────────────────────────────────

Deno.test("subjectIsCancellation: recognises CANCELLED WORK ORDER + variants", () => {
  assert(
    subjectIsCancellation(
      "CANCELLED WORK ORDER - MLB-25769 34 Carbine Loop, Millbridge, WA 6232",
    ),
  );
  assert(subjectIsCancellation("Cancellation - Work Order MLB-25769"));
  assert(subjectIsCancellation("Please cancel this work order - AJBR 67251"));
  assert(subjectIsCancellation("WITHDRAWN - Make Safe - Job No 67996"));
});

Deno.test("subjectIsCancellation: does NOT flag genuine new work orders", () => {
  assertEquals(
    subjectIsCancellation(
      "NEW WORK ORDER - MLB-25096 7 Broughton St, Balcatta",
    ),
    false,
  );
  assertEquals(
    subjectIsCancellation("Make Safe - QUINNS ROCKS - Job No 67996"),
    false,
  );
  assertEquals(
    subjectIsCancellation("Our Ref: MLB-26010 - roof report request"),
    false,
  );
});

Deno.test("isGenuineNewWorkOrder: MLB-25769 CANCELLED WORK ORDER twin is dropped, not minted", () => {
  // The live twin-draft incident: this subject carries 'work order' so it used to pass
  // subjectLooksLikeNewWorkOrder and mint a NEW draft (two of them, in fact).
  const r = isGenuineNewWorkOrder(
    "CANCELLED WORK ORDER - MLB-25769 34 Carbine Loop, Millbridge, WA 6232",
    "admin@mlbuilders.com.au",
    0,
  );
  assertEquals(r.ok, false);
  assertEquals(r.reason, "cancelled_work_order");
});

Deno.test("isGenuineNewWorkOrder: a cancellation WITH a PDF is still dropped", () => {
  const r = isGenuineNewWorkOrder(
    "CANCELLED WORK ORDER - MLB-25769 34 Carbine Loop",
    "admin@mlbuilders.com.au",
    1,
  );
  assertEquals(r.ok, false);
  assertEquals(r.reason, "cancelled_work_order");
});

Deno.test("isGenuineNewWorkOrder: genuine NEW WORK ORDER still comes in (no cancellation false-positive)", () => {
  const r = isGenuineNewWorkOrder(
    "NEW WORK ORDER - MLB-25096 7 Broughton St, Balcatta",
    "jobs@mlbuilders.com.au",
    1,
  );
  assertEquals(r.ok, true);
  assertEquals(r.reason, "work_order_pdf");
});

// ── Item 1: wrong-type guard ────────────────────────────────────────────────────

Deno.test("wrong-type roof fallback: explicit roof_report + WO PDF + no report evidence -> demoted to general", () => {
  // A physical roof make-safe whose keyword fallback mis-typed it roof_report. With a
  // servable WO PDF and NO positive report-only evidence, it must NOT stick report-only
  // (which strands the WO unattached at ready_to_invoice) — demote to null.
  const rt = effectiveReportType({
    subject: "NEW WORK ORDER - MLB-26010 12 Example St",
    body_preview: "Attend site and make safe the damaged roof section.",
    report_type: "roof_report",
    extraction_json: {},
    attachments_json: [WO_PDF],
  });
  assertEquals(rt, null);
});

Deno.test("wrong-type guard: explicit roof_report STICKS when the model committed it (positive evidence)", () => {
  const rt = effectiveReportType({
    subject: "Our Ref: MLB-26010 - Eaton",
    body_preview: "please attend",
    report_type: "roof_report",
    extraction_json: { report_type: "roof_report" },
    attachments_json: [WO_PDF],
  });
  assertEquals(rt, "roof_report");
});

Deno.test("wrong-type guard: explicit assessment_report STICKS on explicit report wording", () => {
  const rt = effectiveReportType({
    subject: "Our Ref: MLB-26010 - Eaton",
    body_preview:
      "Please complete the assessment report and upload via the portal.",
    report_type: "assessment_report",
    extraction_json: {},
    attachments_json: [WO_PDF],
  });
  assertEquals(rt, "assessment_report");
});

Deno.test("wrong-type guard: report_type is preserved when there is NO WO PDF", () => {
  const rt = effectiveReportType({
    subject: "Our Ref: MLB-26010 - Eaton",
    body_preview: "roof make safe",
    report_type: "roof_report",
    extraction_json: {},
    attachments_json: [],
  });
  assertEquals(rt, "roof_report");
});

Deno.test("hasPositiveReportOnlyEvidence: model commit / explicit wording / report attachment all count", () => {
  assert(
    hasPositiveReportEvidence(
      { subject: "x" },
      { report_type: "roof_report" },
      [WO_PDF],
    ),
  );
  assert(
    hasPositiveReportEvidence({ subject: "make safe and report - MLB-1" }, {}, [
      WO_PDF,
    ]),
  );
  assert(
    hasPositiveReportEvidence({ subject: "x" }, {}, [{
      file_name: "roof_report_scope.pdf",
      pdf_url: "u",
    }]),
  );
  // A bare "roof" with a real WO PDF is NOT positive evidence.
  assertEquals(
    hasPositiveReportEvidence({ subject: "roof make safe" }, {}, [WO_PDF]),
    false,
  );
});

Deno.test("mappedModelReportType: maps model commitments, no keyword fallback", () => {
  assertEquals(mappedModelReportType("roof"), "roof_report");
  assertEquals(mappedModelReportType("general_makesafe"), "general_makesafe");
  assertEquals(mappedModelReportType("not_a_report"), "general_makesafe");
  assertEquals(mappedModelReportType(""), null);
  assertEquals(mappedModelReportType("something_unrecognised"), null);
});

// ── Item 3: combined make-safe + report ─────────────────────────────────────────

Deno.test("flagCombinedIntakeObligation: WO PDF + report request -> records secondary obligation + blocking field", () => {
  const extraction: Record<string, unknown> = { report_type: "roof_report" };
  const missing: string[] = [];
  const obligation = flagCombined(
    {
      subject: "Make Safe and Report - MLB-26010",
      body_preview: "attend, make safe, and provide a roof report",
    },
    extraction,
    [WO_PDF],
    missing,
    "roof_report",
  );
  assert(obligation);
  assertEquals(obligation?.type, "roof_report");
  const secondary = extraction.secondary_obligation as { reason: string };
  assertEquals(secondary.reason, "combined_makesafe_and_report");
  assert(missing.includes("combined_makesafe_and_report"));
});

Deno.test("flagCombinedIntakeObligation: a plain make-safe WO (no report obligation) is NOT combined", () => {
  const extraction: Record<string, unknown> = {};
  const missing: string[] = [];
  const obligation = flagCombined(
    {
      subject: "NEW WORK ORDER - MLB-26010",
      body_preview: "attend and make safe",
    },
    extraction,
    [WO_PDF],
    missing,
    null,
  );
  assertEquals(obligation, null);
  assertEquals(missing.length, 0);
  assertEquals(extraction.secondary_obligation, undefined);
});

Deno.test("flagCombinedIntakeObligation: a report-only email (no WO PDF) is NOT combined", () => {
  const extraction: Record<string, unknown> = { report_type: "roof_report" };
  const missing: string[] = [];
  const obligation = flagCombined(
    {
      subject: "Our Ref: MLB-26010 - roof report request",
      body_preview: "complete the roof report",
    },
    extraction,
    [{ file_name: "roof_report_scope.pdf", pdf_url: "u" }],
    missing,
    "roof_report",
  );
  assertEquals(obligation, null);
});

Deno.test("gate: a combined obligation can never auto-approve", () => {
  const d = gateDecision({
    combinedObligation: true,
    confidence: "high",
    matchedCompany: { slug: "mlb" },
    externalRef: "MLB-26010",
    clientName: "Test Client",
    siteAddress: "1 Example St",
    attachments: [WO_PDF],
  });
  assertEquals(d.ok, false);
  assertEquals(d.reason, "combined_makesafe_and_report_manual_review");
});

Deno.test("gate: a cancellation can never auto-approve", () => {
  const d = gateDecision({
    cancelled: true,
    confidence: "high",
    matchedCompany: { slug: "mlb" },
    externalRef: "MLB-25769",
    clientName: "Test Client",
    siteAddress: "34 Carbine Loop",
    attachments: [WO_PDF],
  });
  assertEquals(d.ok, false);
  assertEquals(d.reason, "cancelled_work_order");
});

Deno.test("sweep: a stored MLB-25769 cancellation twin is blocked from auto-promotion", () => {
  const d = sweepDecision({
    status: "needs_review",
    confidence: "high",
    requesting_company_slug: "mlb",
    external_ref: "MLB-25769",
    client_name: "Test Client",
    site_address: "34 Carbine Loop, Millbridge WA",
    subject:
      "CANCELLED WORK ORDER - MLB-25769 34 Carbine Loop, Millbridge, WA 6232",
    body_preview: "Please note the 2 work orders has since been cancelled.",
    report_type: null,
    attachments_json: [WO_PDF],
  });
  assertEquals(d.ok, false);
  assertEquals(d.reason, "cancelled_work_order");
});

Deno.test("sweep: a stored combined make-safe+report draft is blocked from auto-promotion", () => {
  const d = sweepDecision({
    status: "needs_review",
    confidence: "high",
    requesting_company_slug: "bwc",
    external_ref: "BWCWA-1234",
    client_name: "Test Client",
    site_address: "9 Example Rd",
    subject: "New Make Safe and Report Request - BWCWA-1234",
    body_preview: "Attend, make safe and provide an assessment report.",
    report_type: "assessment_report",
    extraction_json: { report_type: "assessment_report" },
    attachments_json: [WO_PDF],
  });
  assertEquals(d.ok, false);
  assertEquals(d.reason, "combined_makesafe_and_report_manual_review");
});

// ── Auto-approval flag: default OFF (opt-in) ─────────────────────────────────────

Deno.test("autoApproveCleanIntakeEnabled: default OFF; only 'true' enables", () => {
  const prior = Deno.env.get("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE");
  try {
    Deno.env.delete("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE");
    assertEquals(autoApproveEnabled(), false); // unset -> OFF
    Deno.env.set("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE", "false");
    assertEquals(autoApproveEnabled(), false);
    Deno.env.set("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE", "1");
    assertEquals(autoApproveEnabled(), false); // anything other than 'true' -> OFF
    Deno.env.set("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE", "true");
    assertEquals(autoApproveEnabled(), true);
  } finally {
    if (prior === undefined) {
      Deno.env.delete("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE");
    } else Deno.env.set("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE", prior);
  }
});

Deno.test("textHasExplicitReportRequest: explicit report wording vs bare keyword", () => {
  assert(textHasExplicitReportRequest("please provide a roof report"));
  assert(textHasExplicitReportRequest("make safe and report"));
  assert(textHasExplicitReportRequest("assessment report required"));
  assertEquals(textHasExplicitReportRequest("make safe the roof"), false);
  assertEquals(
    textHasExplicitReportRequest("temporary fencing collection"),
    false,
  );
});
