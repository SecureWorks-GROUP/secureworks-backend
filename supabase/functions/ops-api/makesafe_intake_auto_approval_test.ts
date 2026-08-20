// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _effectiveIntakeReportTypeForTest,
  _shouldAutoApproveCleanIntakeDraftRowForTest,
  _shouldAutoApproveCleanIntakeForTest,
} from "./index.ts";

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
