import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _effectiveIntakeReportTypeForTest,
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

Deno.test("clean intake auto-approval allows only high-confidence normal WOs with servable WO PDF", () => {
  const decision = _shouldAutoApproveCleanIntakeForTest({
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

Deno.test("clean intake auto-approval blocks report-tagged and report-only drafts", () => {
  const reportTagged = _shouldAutoApproveCleanIntakeForTest({
    tagReportType: true,
    reportType: "roof_report",
    confidence: "high",
    matchedCompany: { slug: "mlb" },
    externalRef: "MLB-26010",
    clientName: "Test Client",
    siteAddress: "1 Example St",
    attachments: [{
      pdf_url: "https://example.test/report.pdf",
      is_work_order: true,
    }],
  });
  assertEquals(reportTagged.ok, false);
  assertEquals(reportTagged.reason, "report_tagged_manual_review");

  const reportOnly = _shouldAutoApproveCleanIntakeForTest({
    reportType: "assessment_report",
    confidence: "high",
    matchedCompany: { slug: "mlb" },
    externalRef: "MLB-26010",
    clientName: "Test Client",
    siteAddress: "1 Example St",
    attachments: [{
      pdf_url: "https://example.test/report.pdf",
      is_work_order: true,
    }],
  });
  assertEquals(reportOnly.ok, false);
  assertEquals(reportOnly.reason, "report_only_manual_review");
});

Deno.test("clean intake auto-approval blocks weak or ambiguous intake", () => {
  assertEquals(
    _shouldAutoApproveCleanIntakeForTest({
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
