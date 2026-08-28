// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _combinedSplitRecoveryDecisionForTest,
  _effectiveIntakeReportTypeForTest,
  _shouldAutoApproveCleanIntakeDraftRowForTest,
  _shouldAutoApproveCleanIntakeForTest,
} from "./index.ts";

Deno.test("combined recovery refuses a missing secondary card binding", () => {
  assertEquals(
    _combinedSplitRecoveryDecisionForTest(true, [{
      mint_role: "primary",
      job_id: "job-primary",
    }]),
    {
      action: "review",
      missing_roles: ["secondary_report"],
    },
  );
});

Deno.test("combined recovery settles only when both historical cards exist", () => {
  assertEquals(
    _combinedSplitRecoveryDecisionForTest(true, [
      { mint_role: "primary", job_id: "job-primary" },
      { mint_role: "secondary_report", job_id: "job-secondary" },
    ]),
    {
      action: "settle_existing",
      missing_roles: [],
    },
  );
});

Deno.test("effectiveIntakeReportType classifies legacy NULL body-only roof reports", () => {
  const reportType = _effectiveIntakeReportTypeForTest({
    subject: "Our Ref: MLB-26010 - Eaton",
    body_preview: "Please complete the ROOF REPORT and upload via the portal.",
    report_type: null,
    extraction_json: {},
    attachments_json: [{ file_name: "roof_report_scope.pdf" }],
  });
  assertEquals(reportType, "roof_report");
});

Deno.test("effectiveIntakeReportType preserves explicit report_type", () => {
  const reportType = _effectiveIntakeReportTypeForTest({
    subject: "Our Ref: MLB-26010 - Eaton",
    body_preview: "roof report wording appears here",
    report_type: "assessment_report",
  });
  assertEquals(reportType, "assessment_report");
});

Deno.test("effectiveIntakeReportType does not fallback-classify rows with clear WO PDFs", () => {
  const reportType = _effectiveIntakeReportTypeForTest({
    subject: "Our Ref: MLB-26010 - Eaton",
    body_preview:
      "roof report wording appears here but the attachment is the work order",
    report_type: null,
    extraction_json: {},
    attachments_json: [{
      file_name: "Work Order MLB-26010.pdf",
      pdf_url: "https://example.test/wo.pdf",
      is_work_order: true,
    }],
  });
  assertEquals(reportType, null);
});

Deno.test("clean intake auto-approval allows only high-confidence normal WOs with servable WO PDF", () => {
  const decision = _shouldAutoApproveCleanIntakeForTest({
    jobFamily: "general_makesafe",
    confidence: "high",
    matchedCompany: { slug: "ajs", name: "AJ Building & Restoration" },
    externalRef: "AJBR 67922",
    clientName: "Test Client",
    siteAddress: "1 Example St, Woodvale WA",
    missingFields: [],
    attachments: [{
      file_name: "Works Order.pdf",
      pdf_url: "https://example.test/wo.pdf",
      is_work_order: true,
    }],
  });
  assert(decision.ok, decision.reason);
});

Deno.test("SecureWorks cover sheet cannot satisfy the intake WO floor", () => {
  const decision = _shouldAutoApproveCleanIntakeForTest({
    jobFamily: "general_makesafe",
    confidence: "high",
    matchedCompany: { slug: "aj" },
    externalRef: "AJBR-70001",
    clientName: "present",
    siteAddress: "present",
    missingFields: [],
    attachments: [{
      file_name: "work-order-SWMS-27001.pdf",
      pdf_url: "https://example.test/work-order-SWMS-27001.pdf",
      is_work_order: true,
    }],
  });
  assertEquals(decision, { ok: false, reason: "missing_work_order_pdf" });
});

Deno.test("clean intake auto-approval allows report-worded rows only when a WO PDF is clear", () => {
  const reportWordedWorkOrder = _shouldAutoApproveCleanIntakeForTest({
    jobFamily: "roof_report",
    tagReportType: true,
    reportType: "roof_report",
    confidence: "high",
    matchedCompany: { slug: "mlb" },
    externalRef: "MLB-26010",
    clientName: "Test Client",
    siteAddress: "1 Example St",
    attachments: [{
      file_name: "Work Order MLB-26010.pdf",
      pdf_url: "https://example.test/wo.pdf",
      is_work_order: true,
    }],
  });
  assertEquals(reportWordedWorkOrder.ok, true);
  assertEquals(
    reportWordedWorkOrder.reason,
    "clean_high_confidence_work_order",
  );

  const reportOnly = _shouldAutoApproveCleanIntakeForTest({
    jobFamily: "assessment_report_quote",
    reportType: "assessment_report",
    confidence: "high",
    matchedCompany: { slug: "mlb" },
    externalRef: "MLB-26010",
    clientName: "Test Client",
    siteAddress: "1 Example St",
    attachments: [{
      file_name: "assessment_report_scope.pdf",
      pdf_url: "https://example.test/report.pdf",
    }],
  });
  assertEquals(reportOnly.ok, false);
  assertEquals(reportOnly.reason, "report_only_manual_review");
});

Deno.test("clean intake auto-approval blocks weak or ambiguous intake", () => {
  assertEquals(
    _shouldAutoApproveCleanIntakeForTest({
      jobFamily: "general_makesafe",
      confidence: "medium",
      matchedCompany: { slug: "ajs" },
      externalRef: "AJBR 67922",
      clientName: "Test Client",
      siteAddress: "1 Example St",
      attachments: [{
        pdf_url: "https://example.test/wo.pdf",
        is_work_order: true,
      }],
    }).ok,
    false,
  );

  assertEquals(
    _shouldAutoApproveCleanIntakeForTest({
      jobFamily: "general_makesafe",
      confidence: "high",
      matchedCompany: { slug: "ajs" },
      externalRef: "AJBR 67922",
      clientName: "Test Client",
      siteAddress: "1 Example St",
      missingFields: ["site_address"],
      attachments: [{
        pdf_url: "https://example.test/wo.pdf",
        is_work_order: true,
      }],
    }).reason,
    "missing_fields:site_address",
  );

  assertEquals(
    _shouldAutoApproveCleanIntakeForTest({
      jobFamily: "general_makesafe",
      confidence: "high",
      matchedCompany: { slug: "ajs" },
      externalRef: "AJBR 67922",
      clientName: "Test Client",
      siteAddress: "1 Example St",
      attachments: [
        { pdf_url: "https://example.test/a.pdf" },
        { pdf_url: "https://example.test/b.pdf" },
      ],
    }).reason,
    "multiple_pdfs_no_designated_work_order",
  );
});

Deno.test("clean intake board sweep accepts legacy pending draft rows with complete WO fields", () => {
  const decision = _shouldAutoApproveCleanIntakeDraftRowForTest({
    status: "needs_review",
    confidence: "high",
    requesting_company_slug: "ajs",
    requesting_company_name: "AJ Building & Restoration",
    external_ref: "AJBR 68001",
    client_name: "Test Client",
    site_address: "10 Example Rd, Perth WA",
    missing_fields: ["client_phone"],
    report_type: null,
    subject: "AJBR 68001 Work Order",
    body_preview: "Please attend make safe",
    extraction_json: {},
    attachments_json: [{
      file_name: "Work Order.pdf",
      pdf_url: "https://example.test/wo.pdf",
      is_work_order: true,
    }],
  });
  assertEquals(decision, {
    ok: true,
    reason: "clean_high_confidence_work_order",
  });
});

Deno.test("clean intake board sweep blocks report-only legacy rows before auto promotion", () => {
  const decision = _shouldAutoApproveCleanIntakeDraftRowForTest({
    status: "needs_review",
    confidence: "high",
    requesting_company_slug: "mlb",
    external_ref: "MLB-26072",
    client_name: "Test Client",
    site_address: "1 Roof Way",
    subject: "MLB-26072 roof assessment report request",
    body_preview: "Please complete the roof report only",
    report_type: null,
    attachments_json: [{
      file_name: "roof_report_scope.pdf",
      pdf_url: "https://example.test/report.pdf",
    }],
  });
  assertEquals(decision.ok, false);
  assertEquals(decision.reason, "report_only_manual_review");
});

Deno.test("clean intake auto-approval blocks an uncertain family without WO/PO identity", () => {
  const decision = _shouldAutoApproveCleanIntakeForTest({
    jobFamily: null,
    confidence: "high",
    matchedCompany: { slug: "mlb" },
    externalRef: "MLB-25953",
    clientName: "Test Client",
    siteAddress: "241 Old Coast Rd",
    missingFields: [],
    attachments: [{
      file_name: "Work Order MLB-25953.pdf",
      pdf_url: "https://example.test/wo.pdf",
      is_work_order: true,
    }],
  });
  assertEquals(decision, {
    ok: false,
    reason: "work_order_family_needs_review",
  });
});

Deno.test("clean intake board sweep blocks a legacy family conflicting with AJS authority", () => {
  const decision = _shouldAutoApproveCleanIntakeDraftRowForTest({
    status: "needs_review",
    confidence: "high",
    requesting_company_slug: "aj",
    external_ref: "AJBR-70062",
    client_name: "Test Client",
    site_address: "1 Example St",
    report_type: "assessment_report",
    subject: "AJBR-70062 Work Order",
    body_preview: "Please complete the assessment report",
    extraction_json: {
      makesafe_job_family: "assessment_report_quote",
    },
    attachments_json: [{
      file_name: "AJBR-70062 Work Order.pdf",
      pdf_url: "https://example.test/wo.pdf",
      is_work_order: true,
    }],
  });
  assertEquals(decision, {
    ok: false,
    reason: "work_order_family_needs_review",
  });
});

// Ruled 2026-08-28 (repair-siphon taxonomy): the repair lane runs SUPERVISED.
// An SWR- mint is irreversible, so even a perfectly clean, PDF-declared repair
// draft parks for a human tap instead of auto-filing. These two tests
// previously asserted auto-approval; they now pin the brake.
Deno.test("clean intake board sweep parks a PDF-declared repair family for a human", () => {
  const decision = _shouldAutoApproveCleanIntakeDraftRowForTest({
    status: "needs_review",
    confidence: "high",
    requesting_company_slug: "mlb",
    external_ref: "MLB-25953",
    client_name: "Test Client",
    site_address: "241 Old Coast Rd",
    subject: "NEW WORK ORDER - MLB-25953",
    body_preview: null,
    description: "Attend site as instructed.",
    extraction_json: {
      makesafe_job_family: "repair",
      work_order_pdf_text: [{
        attachment_name: "work_order_MLB-25953_PO-57001.pdf",
        status: "extracted",
        text: [
          "Allocation Work Order",
          "Rapid Repair",
          "Attend site as instructed.",
        ].join("\n"),
      }],
    },
    attachments_json: [{
      file_name: "work_order_MLB-25953_PO-57001.pdf",
      pdf_url: "https://example.test/wo.pdf",
      is_work_order: true,
    }],
  });
  assertEquals(decision, {
    ok: false,
    reason: "repair_family_supervised_review",
  });
});

Deno.test("clean intake board sweep parks a deterministic AJS Rapid Repair draft too", () => {
  const decision = _shouldAutoApproveCleanIntakeDraftRowForTest({
    status: "needs_review",
    confidence: "high",
    requesting_company_slug: "aj",
    external_ref: "AJBR-70991",
    client_name: "Test Client",
    site_address: "8 Repair Road",
    subject: "RAPID REPAIR WORK ORDER AJBR-70991",
    body_preview: "Please attend the attached work order.",
    extraction_json: {
      makesafe_job_family: "repair",
      work_order_pdf_text: [{
        attachment_name: "AJBR-70991 Work Order.pdf",
        status: "extracted",
        text: [
          "Allocation Work Order",
          "Scope of Works: attend and repair the damaged gate",
        ].join("\n"),
      }],
    },
    attachments_json: [{
      file_name: "AJBR-70991 Work Order.pdf",
      pdf_url: "https://example.test/wo.pdf",
      is_work_order: true,
    }],
  });
  assertEquals(decision, {
    ok: false,
    reason: "repair_family_supervised_review",
  });
});

Deno.test("clean intake board sweep accepts a PDF-declared physical family", () => {
  const decision = _shouldAutoApproveCleanIntakeDraftRowForTest({
    status: "needs_review",
    confidence: "high",
    requesting_company_slug: "mlb",
    external_ref: "MLB-25954",
    client_name: "Test Client",
    site_address: "243 Old Coast Rd",
    subject: "NEW WORK ORDER - MLB-25954",
    body_preview: null,
    description: "Attend site as instructed.",
    extraction_json: {
      makesafe_job_family: "general_makesafe",
      work_order_pdf_text: [{
        attachment_name: "work_order_MLB-25954_PO-57002.pdf",
        status: "extracted",
        text: [
          "Allocation Work Order",
          "Makesafe/Emergency Repairs",
          "Make Safe",
          "Attend site as instructed.",
        ].join("\n"),
      }],
    },
    attachments_json: [{
      file_name: "work_order_MLB-25954_PO-57002.pdf",
      pdf_url: "https://example.test/wo.pdf",
      is_work_order: true,
    }],
  });
  assertEquals(decision, {
    ok: true,
    reason: "clean_high_confidence_work_order",
  });
});

Deno.test("clean intake board sweep accepts a PDF-scope temporary-fence family", () => {
  const decision = _shouldAutoApproveCleanIntakeDraftRowForTest({
    status: "needs_review",
    confidence: "high",
    requesting_company_slug: "mlb",
    external_ref: "MLB-25955",
    client_name: "Test Client",
    site_address: "245 Old Coast Rd",
    subject: "NEW WORK ORDER - MLB-25955",
    body_preview: null,
    description: "Attend site as instructed.",
    extraction_json: {
      makesafe_job_family: "temp_fence_makesafe",
      work_order_pdf_text: [{
        attachment_name: "work_order_MLB-25955_PO-57003.pdf",
        status: "extracted",
        text: [
          "Allocation Work Order",
          "Scope of Works: install temporary fencing",
          "Work Order Terms and Conditions",
        ].join("\n"),
      }],
    },
    attachments_json: [{
      file_name: "work_order_MLB-25955_PO-57003.pdf",
      pdf_url: "https://example.test/wo.pdf",
      is_work_order: true,
    }],
  });
  assertEquals(decision, {
    ok: true,
    reason: "clean_high_confidence_work_order",
  });
});

Deno.test("clean intake board sweep keeps boilerplate-only PDF family in review", () => {
  const decision = _shouldAutoApproveCleanIntakeDraftRowForTest({
    status: "needs_review",
    confidence: "high",
    requesting_company_slug: "mlb",
    external_ref: "MLB-25956",
    client_name: "Test Client",
    site_address: "247 Old Coast Rd",
    subject: "NEW WORK ORDER - MLB-25956",
    body_preview: null,
    description: "Attend site as instructed.",
    extraction_json: {
      makesafe_job_family: "general_makesafe",
      work_order_pdf_text: [{
        attachment_name: "work_order_MLB-25956_PO-57004.pdf",
        status: "extracted",
        text: [
          "Allocation Work Order",
          "Contractors must hold current insurance.",
          "Period Trade Contract Conditions",
        ].join("\n"),
      }],
    },
    attachments_json: [{
      file_name: "work_order_MLB-25956_PO-57004.pdf",
      pdf_url: "https://example.test/wo.pdf",
      is_work_order: true,
    }],
  });
  assertEquals(decision, {
    ok: false,
    reason: "work_order_family_needs_review",
  });
});
