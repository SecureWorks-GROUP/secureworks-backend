// Intake engine hardening (request 2026-07-06). Covers the three build items:
//   1. wrong-type guard (roof/assessment keyword-fallback vs a real WO PDF),
//   2. cancellation path (CANCELLED WORK ORDER must never mint a draft),
//   3. one email -> two cards (combined make-safe + report is flagged, never auto-filed),
// plus the default-on auto-approval flag and explicit false brake. The real live failure cases are named:
// the MLB-25769 cancellation twins and the wrong-type roof fallback.
// deno-lint-ignore-file no-import-prefix

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
  _combinedSplitObligationForTest as combinedSplit,
  _effectiveIntakeReportTypeForTest as effectiveReportType,
  _emailCarriesMultipleWorkOrdersForTest as multipleWorkOrders,
  _flagCombinedIntakeObligationForTest as flagCombined,
  _hasPositiveReportOnlyEvidenceForTest as hasPositiveReportEvidence,
  _shouldAutoApproveCleanIntakeDraftRowForTest as sweepDecision,
  _shouldAutoApproveCleanIntakeForTest as gateDecision,
  _stripBuilderTemplateBoilerplateForTest as stripBoilerplate,
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

Deno.test("isGenuineNewWorkOrder: MLB-25769 cancellation routes deterministically, never mints", () => {
  // The live twin-draft incident: this subject carries 'work order' so it used to pass
  // subjectLooksLikeNewWorkOrder and mint a NEW draft (two of them, in fact).
  const r = isGenuineNewWorkOrder(
    "CANCELLED WORK ORDER - MLB-25769 34 Carbine Loop, Millbridge, WA 6232",
    "admin@mlbuilders.com.au",
    0,
  );
  assertEquals(r.ok, false);
  assertEquals(r.reason, "cancelled_work_order");
  assertEquals(r.route, "deterministic_cancellation");
});

Deno.test("isGenuineNewWorkOrder: a cancellation with a PDF still routes deterministically", () => {
  const r = isGenuineNewWorkOrder(
    "CANCELLED WORK ORDER - MLB-25769 34 Carbine Loop",
    "admin@mlbuilders.com.au",
    1,
  );
  assertEquals(r.ok, false);
  assertEquals(r.reason, "cancelled_work_order");
  assertEquals(r.route, "deterministic_cancellation");
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

Deno.test("flagCombinedIntakeObligation: a SINGLE WO with report wording is NOT combined (retune)", () => {
  // Pre-retune this recorded a secondary obligation; Marnin's rule: one WO = one card,
  // so a single make-safe-and-report-worded WO must NOT flag combined.
  const extraction: Record<string, unknown> = {
    report_type: "roof_report",
    builder_po_number: "PO-26010",
  };
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
  assertEquals(obligation, null);
  assertEquals(missing.length, 0);
  assertEquals(extraction.secondary_obligation, undefined);
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

// ── Item 3b + RETUNE (Marnin 2026-07-07): one WO = one card; only a genuine TWO-WO
// email splits ──────────────────────────────────────────────────────────────────

// MLB dispatch boilerplate — on EVERY MLB WO incl. pure report orders; must be treated
// as template noise, never obligation evidence.
const MLB_BOILERPLATE =
  "Upon completion of works you must provide before and after photos, and your SWMS with your invoice.";

// The LIVE Joondalup work order (ef939f3e / MLB-26721PO-55622): a SINGLE roof-report WO
// — one PO number, one WO PDF. Its scope is a roof report; per the rule it is ONE
// roof-report card and must NEVER flag a combined obligation (that produced the spurious
// make-safe twin SWMS-26929).
const JOONDALUP_WO_PDF = {
  file_name: "work_order_MLB-26721PO-55622_Secureworks_Group_Pty_Ltd.pdf",
  pdf_url: "https://example.test/wo.pdf",
  is_work_order: true,
};
const JOONDALUP_EMAIL = {
  subject:
    "NEW WORK ORDER - MLB-26721 R104/ 189 Lakeside Drive, Joondalup, WA 6027",
  body_preview:
    "You've been assigned the above work order for Job MLB-26721. Three storey roof report noting cause of damage/point of water entry. " +
    MLB_BOILERPLATE,
  description:
    "Three storey roof report noting cause of damage/point of water entry.",
};
const JOONDALUP_EXTRACTION = {
  report_type: "roof_report",
  builder_po_number: "PO-55622",
  builder_work_order_number: "MLB-26721PO-55622",
  external_ref: "MLB-26721PO-55622",
};

Deno.test("retune: the live Joondalup single WO does NOT carry multiple work orders", () => {
  assertEquals(
    multipleWorkOrders(JOONDALUP_EMAIL, JOONDALUP_EXTRACTION, [
      JOONDALUP_WO_PDF,
    ]),
    false,
  );
});

Deno.test("retune: the Joondalup single roof-report WO NEVER flags combined (one card)", () => {
  const extraction: Record<string, unknown> = { ...JOONDALUP_EXTRACTION };
  const missing: string[] = [];
  const obligation = flagCombined(
    JOONDALUP_EMAIL,
    extraction,
    [JOONDALUP_WO_PDF],
    missing,
    "roof_report",
  );
  assertEquals(obligation, null);
  assertEquals(missing.length, 0);
  assertEquals(extraction.secondary_obligation, undefined);
});

Deno.test("retune: the Joondalup WO is typed by its scope -> a single roof_report card", () => {
  const rt = effectiveReportType({
    subject: JOONDALUP_EMAIL.subject,
    body_preview: JOONDALUP_EMAIL.body_preview,
    report_type: "roof_report",
    extraction_json: JOONDALUP_EXTRACTION,
    attachments_json: [JOONDALUP_WO_PDF],
  });
  assertEquals(rt, "roof_report");
});

Deno.test("retune: the Joondalup single-WO draft is sweep-eligible as ONE card (no combined block)", () => {
  const draft = {
    confidence: "high",
    requesting_company_slug: "mlb",
    external_ref: "MLB-26721PO-55622",
    client_name: "The Owners of 189 Lakeside Drive Joondalup Strata Plan 34016",
    site_address: "R104/ 189 Lakeside Drive",
    report_type: "roof_report",
    subject: JOONDALUP_EMAIL.subject,
    body_preview: JOONDALUP_EMAIL.body_preview,
    missing_fields: ["portal_link"],
    attachments_json: [JOONDALUP_WO_PDF],
    extraction_json: JOONDALUP_EXTRACTION, // NO secondary_obligation post-retune
  };
  const d = sweepDecision(draft);
  assertEquals(d.ok, true, `expected eligible; got ${d.reason}`);
});

// A GENUINE two-work-order email: two distinct PO numbers + two WO PDFs, one of which is
// a report. THIS must split.
const TWO_WO_PDF_A = {
  file_name: "work_order_MLB-30001PO-60001_Secureworks_Group_Pty_Ltd.pdf",
  pdf_url: "https://example.test/a.pdf",
  is_work_order: true,
};
const TWO_WO_PDF_B = {
  file_name: "work_order_MLB-30001PO-60002_Secureworks_Group_Pty_Ltd.pdf",
  pdf_url: "https://example.test/b.pdf",
  is_work_order: true,
};
const TWO_WO_EMAIL = {
  subject: "Make safe and roof report - MLB-30001 12 Test St",
  body_preview:
    "Attend and make safe the damaged section (PO-60001) AND complete a roof report (PO-60002). " +
    MLB_BOILERPLATE,
  description: "make safe plus roof report",
};

Deno.test("retune: a genuine TWO-PO / two-WO-PDF email DOES carry multiple work orders", () => {
  assertEquals(
    multipleWorkOrders(TWO_WO_EMAIL, {
      report_type: "roof_report",
      builder_po_number: "PO-60001",
    }, [
      TWO_WO_PDF_A,
      TWO_WO_PDF_B,
    ]),
    true,
  );
});

Deno.test("retune: a genuine two-WO email DOES flag combined (splits into two cards)", () => {
  const extraction: Record<string, unknown> = {
    report_type: "roof_report",
    builder_po_number: "PO-60001",
  };
  const missing: string[] = [];
  const obligation = flagCombined(
    TWO_WO_EMAIL,
    extraction,
    [TWO_WO_PDF_A, TWO_WO_PDF_B],
    missing,
    "roof_report",
  );
  assert(obligation);
  assertEquals(obligation?.type, "roof_report");
  assert(missing.includes("combined_makesafe_and_report"));
});

// A boilerplate-only make-safe WO: the ONLY report-ish text is the MLB template line.
const MAKESAFE_ONLY_EMAIL = {
  subject: "NEW WORK ORDER - MLB-40001 5 Fix St, Balga",
  body_preview:
    "You've been assigned a work order to attend site and make safe the damaged fence. " +
    MLB_BOILERPLATE,
  description: "make safe the damaged fence",
};

Deno.test("retune: a boilerplate-only make-safe WO is NOT combined and types as a make-safe card", () => {
  const extraction: Record<string, unknown> = { builder_po_number: "PO-70001" };
  const missing: string[] = [];
  const obligation = flagCombined(
    MAKESAFE_ONLY_EMAIL,
    extraction,
    [{
      file_name: "work_order_MLB-40001PO-70001.pdf",
      pdf_url: "u",
      is_work_order: true,
    }],
    missing,
    null,
  );
  assertEquals(obligation, null);
  // report_type null + a servable WO PDF -> make-safe card (not report-only).
  const rt = effectiveReportType({
    subject: MAKESAFE_ONLY_EMAIL.subject,
    body_preview: MAKESAFE_ONLY_EMAIL.body_preview,
    report_type: null,
    extraction_json: extraction,
    attachments_json: [{
      file_name: "work_order_MLB-40001PO-70001.pdf",
      pdf_url: "u",
      is_work_order: true,
    }],
  });
  assertEquals(rt, null);
});

Deno.test("retune: stripBuilderTemplateBoilerplate removes the MLB dispatch line, keeps real scope", () => {
  const stripped = stripBoilerplate(
    "Three storey roof report noting cause of damage. " + MLB_BOILERPLATE,
  );
  assert(stripped.toLowerCase().includes("roof report"));
  assert(!/swms with your invoice/i.test(stripped));
  assert(!/before and after photos/i.test(stripped));
});

Deno.test("item3b: combinedSplitObligation returns the report type for an unambiguous obligation", () => {
  assertEquals(
    combinedSplit({
      secondary_obligation: {
        type: "roof_report",
        reason: "combined_makesafe_and_report",
      },
    }),
    { reportType: "roof_report" },
  );
  assertEquals(
    combinedSplit({
      secondary_obligation: {
        type: "assessment_report",
        reason: "combined_makesafe_and_report",
      },
    }),
    { reportType: "assessment_report" },
  );
});

Deno.test("item3b: an AMBIGUOUS combined obligation (unknown_report) is NOT splittable", () => {
  assertEquals(
    combinedSplit({
      secondary_obligation: {
        type: "unknown_report",
        reason: "combined_makesafe_and_report",
      },
    }),
    null,
  );
  assertEquals(combinedSplit({}), null);
  assertEquals(
    combinedSplit({
      secondary_obligation: { type: "roof_report", reason: "something_else" },
    }),
    null,
  );
});

Deno.test("item3b: gate lets an UNAMBIGUOUS combined obligation through (to be split)", () => {
  const d = gateDecision({
    combinedObligation: true,
    combinedSplittable: true,
    confidence: "high",
    matchedCompany: { slug: "mlb" },
    externalRef: "MLB-26721PO-55622",
    clientName: "Test Client",
    siteAddress: "1 Example St",
    missingFields: ["portal_link", "combined_makesafe_and_report"],
    attachments: [WO_PDF],
  });
  assertEquals(d.ok, true);
});

Deno.test("item3b: gate still BLOCKS an ambiguous combined obligation (not splittable)", () => {
  const d = gateDecision({
    combinedObligation: true,
    combinedSplittable: false,
    confidence: "high",
    matchedCompany: { slug: "mlb" },
    externalRef: "MLB-26010",
    clientName: "Test Client",
    siteAddress: "1 Example St",
    missingFields: ["combined_makesafe_and_report"],
    attachments: [WO_PDF],
  });
  assertEquals(d.ok, false);
  assertEquals(d.reason, "combined_makesafe_and_report_manual_review");
});

Deno.test("item3b: a draft carrying an AMBIGUOUS (unknown_report) obligation stays manual", () => {
  const ambiguous = {
    confidence: "high",
    requesting_company_slug: "mlb",
    external_ref: "MLB-30001",
    client_name: "Test Client",
    site_address: "1 Example St",
    report_type: null,
    missing_fields: ["combined_makesafe_and_report"],
    attachments_json: [TWO_WO_PDF_A, TWO_WO_PDF_B],
    extraction_json: {
      secondary_obligation: {
        type: "unknown_report",
        reason: "combined_makesafe_and_report",
      },
    },
  };
  const d = sweepDecision(ambiguous);
  assertEquals(d.ok, false);
});

Deno.test("item3b: a single-obligation clean make-safe WO is unchanged (still eligible)", () => {
  const plain = {
    confidence: "high",
    requesting_company_slug: "mlb",
    external_ref: "MLB-26010",
    client_name: "Test Client",
    site_address: "1 Example St",
    missing_fields: [],
    attachments_json: [WO_PDF],
    extraction_json: {},
  };
  const d = sweepDecision(plain);
  assertEquals(d.ok, true, `expected eligible; got ${d.reason}`);
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

Deno.test("sweep: a genuine two-WO combined draft with no stored obligation is blocked (retune)", () => {
  // Two WO PDFs (two POs) + report evidence, but no scan-set secondary_obligation
  // (a legacy row): the recompute detects the combined obligation but it isn't proven
  // splittable, so it stays manual rather than auto-promoting a single card.
  const d = sweepDecision({
    status: "needs_review",
    confidence: "high",
    requesting_company_slug: "bwc",
    external_ref: "BWCWA-1234",
    client_name: "Test Client",
    site_address: "9 Example Rd",
    subject: "New Make Safe and Report Request - BWCWA-1234",
    body_preview:
      "Attend, make safe (PO-1001) and provide an assessment report (PO-1002).",
    report_type: "assessment_report",
    extraction_json: { report_type: "assessment_report" },
    attachments_json: [
      {
        file_name: "work_order_BWCWA-1234PO-1001.pdf",
        pdf_url: "a",
        is_work_order: true,
      },
      {
        file_name: "work_order_BWCWA-1234PO-1002.pdf",
        pdf_url: "b",
        is_work_order: true,
      },
    ],
  });
  assertEquals(d.ok, false);
  assertEquals(d.reason, "combined_makesafe_and_report_manual_review");
});

// ── Auto-approval flag: default ON with an explicit deployment brake ──────────────

Deno.test("autoApproveCleanIntakeEnabled: default ON; explicit 'false' disables", () => {
  const prior = Deno.env.get("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE");
  try {
    Deno.env.delete("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE");
    assertEquals(autoApproveEnabled(), true); // unset -> ON
    Deno.env.set("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE", "false");
    assertEquals(autoApproveEnabled(), false);
    Deno.env.set("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE", "1");
    assertEquals(autoApproveEnabled(), true); // only exact 'false' disables
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
