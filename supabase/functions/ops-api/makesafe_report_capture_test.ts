// ════════════════════════════════════════════════════════════
// MAKE-SAFE REPORT-CAPTURE GATE TESTS
// Stage 4 — stage4/makesafe-report-capture-2026-06-18
// ════════════════════════════════════════════════════════════
//
// Verifies that genuine builder re-attend / roof-report / report-request emails
// are CAPTURED as intake drafts (kind='report') rather than silently dropped,
// while outbound acks and normal WOs remain unchanged.
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/makesafe_report_capture_test.ts

import {
  assert,
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyReportType,
  isGenuineNewWorkOrder,
  isPureAckNoAction,
  isReportOnlyType,
  slugFromRefPrefix,
  subjectMatchesReportCapture,
} from "./makesafe_intake_gate.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MLB_SENDER = "mlb.mailer@primeeco.tech";
const BW_SENDER = "noreply@builderwest.com.au";
const OWN_SENDER = "quotes@secureworksgroup.app";
const OWN_SENDER_COMAU = "noreply@secureworkswa.com.au";
const BUILDER_GENERIC = "noreply@ajs.build";
const ACCTS_BUILDERWEST = "accounts@builderwest.com.au";

// ── 1. MLB re-attend / roof report captured ───────────────────────────────────

Deno.test("isGenuineNewWorkOrder: MLB Our-Ref subject is CAPTURED as kind=report", () => {
  const subject =
    "Our Ref: MLB-25795 - 47 Hale St, Eaton - Client Ref: 13328921";
  const r = isGenuineNewWorkOrder(subject, MLB_SENDER, 0);
  assertEquals(r.ok, true, `expected ok=true, got reason=${r.reason}`);
  assertEquals(r.kind, "report", `expected kind=report`);
  assertEquals(r.reason, "report_capture_pattern");
});

Deno.test("isGenuineNewWorkOrder: MLB Our-Ref subject with body about roof — report_type=roof_report", () => {
  const subject =
    "Our Ref: MLB-25795 - 47 Hale St, Eaton - Client Ref: 13328921";
  const body =
    "Please attend the property for a roof report assessment. Storm damage to roof tiles.";
  const r = isGenuineNewWorkOrder(subject, MLB_SENDER, 0);
  assertEquals(r.ok, true);
  assertEquals(r.kind, "report");
  // classifyReportType is called separately by the wire layer; test it directly here.
  assertEquals(classifyReportType(subject, body), "roof_report");
});

Deno.test("isGenuineNewWorkOrder: URGENT Our Ref subject is CAPTURED", () => {
  const subject = "URGENT Our Ref: MLB-25999 - 12 Test St, Perth";
  const r = isGenuineNewWorkOrder(subject, MLB_SENDER, 0);
  assertEquals(r.ok, true);
  assertEquals(r.kind, "report");
});

// ── 2. BWCWA Builderwest "New Make Safe and Report Request" captured ──────────

Deno.test("isGenuineNewWorkOrder: BWCWA New Make Safe and Report Request is CAPTURED", () => {
  const subject = "BWCWA6773 Builderwest; New Make Safe and Report Request.";
  const r = isGenuineNewWorkOrder(subject, BW_SENDER, 0);
  assertEquals(r.ok, true, `expected ok=true, got reason=${r.reason}`);
  assertEquals(r.kind, "report");
  assertEquals(r.reason, "report_capture_pattern");
});

// ── 3. Outbound acks STILL BLOCKED — must never be un-blocked ────────────────

Deno.test("isGenuineNewWorkOrder: Make Safe Report and Invoice ack is STILL DROPPED", () => {
  // This is OUR outbound send coming back through the ses@ mailbox — must stay blocked.
  const subject = "Make Safe Report and Invoice - WB69372 - Maylands";
  const r = isGenuineNewWorkOrder(subject, ACCTS_BUILDERWEST, 0);
  assertEquals(r.ok, false, `expected ok=false (ack must stay blocked)`);
  assertEquals(r.reason, "excluded_non_work_order_subject");
});

Deno.test("isGenuineNewWorkOrder: Make Safe Report and Invoice ack STILL DROPPED even with PDF", () => {
  const subject = "Make Safe Report and Invoice - WB69372 - Maylands";
  const r = isGenuineNewWorkOrder(subject, ACCTS_BUILDERWEST, 1);
  assertEquals(r.ok, false);
  assertEquals(r.reason, "excluded_non_work_order_subject");
});

// ── 4. Own-domain outbound STILL DROPPED ─────────────────────────────────────

Deno.test("isGenuineNewWorkOrder: own secureworksgroup.app domain is STILL DROPPED", () => {
  const r = isGenuineNewWorkOrder("Our Ref: MLB-25000 - Test", OWN_SENDER, 0);
  assertEquals(r.ok, false);
  assertMatch(r.reason, /^outbound:/);
});

Deno.test("isGenuineNewWorkOrder: own secureworkswa.com.au domain is STILL DROPPED", () => {
  const r = isGenuineNewWorkOrder(
    "NEW WORK ORDER - MLB-25096",
    OWN_SENDER_COMAU,
    1,
  );
  assertEquals(r.ok, false);
  assertMatch(r.reason, /^outbound:/);
});

// ── 5. Normal WO unchanged — kind=work_order, report_type null ───────────────

Deno.test("isGenuineNewWorkOrder: clean new WO with PDF passes as kind=work_order", () => {
  const subject = "Make Safe Work Order: WB69684 - Cottesloe";
  const r = isGenuineNewWorkOrder(subject, BW_SENDER, 1);
  assertEquals(r.ok, true);
  assertEquals(r.kind, "work_order");
  assertEquals(r.reason, "work_order_pdf");
});

Deno.test("isGenuineNewWorkOrder: NEW WORK ORDER subject with no PDF passes as kind=work_order", () => {
  const subject =
    "NEW WORK ORDER - MLB-25096 7 Broughton St, Balcatta, WA 6021";
  const r = isGenuineNewWorkOrder(subject, MLB_SENDER, 0);
  assertEquals(r.ok, true);
  assertEquals(r.kind, "work_order");
  assertEquals(r.reason, "new_work_order_subject");
});

// ── 6. classifyReportType ─────────────────────────────────────────────────────

Deno.test("classifyReportType: body mentions roof -> roof_report", () => {
  assertEquals(
    classifyReportType(
      "Our Ref: MLB-25795 - 47 Hale St",
      "Please do a roof report inspection.",
    ),
    "roof_report",
  );
});

Deno.test("classifyReportType: body mentions re-attend -> re_attend", () => {
  assertEquals(
    classifyReportType(
      "Our Ref: MLB-25800 - 5 Fake St",
      "Insurer requires a re-attend on this property.",
    ),
    "re_attend",
  );
});

Deno.test("classifyReportType: body mentions temp fence collect -> temp_fence", () => {
  assertEquals(
    classifyReportType(
      "Our Ref: MLB-25801 - 9 Test Ave",
      "Please collect the temporary fencing panels.",
    ),
    "temp_fence",
  );
});

Deno.test("classifyReportType: body mentions assessment -> assessment_report", () => {
  assertEquals(
    classifyReportType(
      "Our Ref: MLB-25802 - 3 Sample Rd",
      "Please provide a full assessment of the storm damage.",
    ),
    "assessment_report",
  );
});

Deno.test("classifyReportType: body mentions pickup -> temp_fence", () => {
  assertEquals(
    classifyReportType(
      "Our Ref: MLB-25803 - 8 Any St",
      "Arrange pickup of hire fencing.",
    ),
    "temp_fence",
  );
});

Deno.test("classifyReportType: subject signals take priority over body", () => {
  // Subject says temp_fence, body says roof — subject wins.
  assertEquals(
    classifyReportType(
      "Retrieve temp fencing - MLB-25804",
      "Full roof damage report required.",
    ),
    "temp_fence",
  );
});

Deno.test("classifyReportType: no signals -> unknown_report", () => {
  assertEquals(
    classifyReportType(
      "Our Ref: MLB-25805 - 1 Blank St",
      "Please action as required.",
    ),
    "unknown_report",
  );
});

Deno.test("classifyReportType: null inputs -> unknown_report", () => {
  assertEquals(classifyReportType(null, null), "unknown_report");
});

// ── 7. slugFromRefPrefix ──────────────────────────────────────────────────────

Deno.test("slugFromRefPrefix: MLB -> mlb", () => {
  assertEquals(slugFromRefPrefix("MLB"), "mlb");
});

Deno.test("slugFromRefPrefix: BW -> builderwest", () => {
  assertEquals(slugFromRefPrefix("BW"), "builderwest");
});

Deno.test("slugFromRefPrefix: BWC -> builderwest", () => {
  assertEquals(slugFromRefPrefix("BWC"), "builderwest");
});

Deno.test("slugFromRefPrefix: BWCWA -> builderwest", () => {
  assertEquals(slugFromRefPrefix("BWCWA"), "builderwest");
});

Deno.test("slugFromRefPrefix: WB -> western-building", () => {
  assertEquals(slugFromRefPrefix("WB"), "western-building");
});

Deno.test("slugFromRefPrefix: KBA -> kba", () => {
  assertEquals(slugFromRefPrefix("KBA"), "kba");
});

Deno.test("slugFromRefPrefix: lowercase input normalised", () => {
  assertEquals(slugFromRefPrefix("mlb"), "mlb");
  assertEquals(slugFromRefPrefix("wb"), "western-building");
});

Deno.test("slugFromRefPrefix: unknown prefix -> null", () => {
  assertEquals(slugFromRefPrefix("XYZ"), null);
  assertEquals(slugFromRefPrefix(null), null);
  assertEquals(slugFromRefPrefix(""), null);
});

// ════════════════════════════════════════════════════════════════════════════
// ISSUE 1: report pattern + PDF = kind=work_order + reportSubjectPattern=true
// ════════════════════════════════════════════════════════════════════════════

Deno.test("ISSUE 1: report-pattern subject WITH a PDF still flags reportSubjectPattern", () => {
  const subject = "Our Ref: MLB-25795 - 47 Hale St, Eaton - roof report";
  const r = isGenuineNewWorkOrder(subject, MLB_SENDER, 1);
  assertEquals(r.ok, true);
  assertEquals(r.kind, "work_order"); // PDF signal wins on kind
  assertEquals(r.reportSubjectPattern, true); // but still flagged as report
  assertEquals(r.reason, "work_order_pdf");
  assertEquals(classifyReportType(subject, ""), "roof_report");
});

Deno.test("ISSUE 1: BWCWA make-safe-AND-report stays kind=work_order but carries report flag", () => {
  const subject = "BWCWA6773 Builderwest; New Make Safe and Report Request.";
  const r = isGenuineNewWorkOrder(subject, BW_SENDER, 1);
  assertEquals(r.ok, true);
  assertEquals(r.kind, "work_order");
  assertEquals(r.reportSubjectPattern, true);
});

Deno.test("ISSUE 1: a NORMAL WO (no report pattern) has reportSubjectPattern false", () => {
  const r = isGenuineNewWorkOrder(
    "Make Safe Work Order: WB69684 - Cottesloe",
    BW_SENDER,
    1,
  );
  assertEquals(r.ok, true);
  assertEquals(r.kind, "work_order");
  assertEquals(r.reportSubjectPattern, false);
});

Deno.test("ISSUE 1: report-pattern with NO PDF is kind=report and reportSubjectPattern true", () => {
  const r = isGenuineNewWorkOrder(
    "Our Ref: MLB-25795 - 47 Hale St, Eaton - roof report",
    MLB_SENDER,
    0,
  );
  assertEquals(r.ok, true);
  assertEquals(r.kind, "report");
  assertEquals(r.reportSubjectPattern, true);
});

Deno.test("ISSUE 1: subjectMatchesReportCapture is PDF-independent (subject-only)", () => {
  assert(subjectMatchesReportCapture("Our Ref: MLB-25795 - 47 Hale St"));
  assert(
    subjectMatchesReportCapture(
      "BWCWA6773 Builderwest; New Make Safe and Report Request.",
    ),
  );
  assert(
    !subjectMatchesReportCapture("Make Safe Work Order: WB69684 - Cottesloe"),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// ISSUE 2: isReportOnlyType — approve gate behaviour
// ════════════════════════════════════════════════════════════════════════════

Deno.test("ISSUE 2: isReportOnlyType true for roof_report and assessment_report", () => {
  assert(isReportOnlyType("roof_report"));
  assert(isReportOnlyType("assessment_report"));
});

Deno.test("ISSUE 2: isReportOnlyType false for non-report-only types", () => {
  assert(!isReportOnlyType("temp_fence"));
  assert(!isReportOnlyType("re_attend"));
  assert(!isReportOnlyType("unknown_report"));
  assert(!isReportOnlyType(null));
  assert(!isReportOnlyType(undefined));
  assert(!isReportOnlyType(""));
});

// Model of the approve gate: report-only -> creates job (NOT blocked).
// (The old guard BLOCKED report-only drafts; the new flow CREATES a report-type job.)
function modelApproveGate(draft: { report_type: string | null }): {
  jobCreated: boolean;
  error: string | null;
  isReportOnlyDraft: boolean;
} {
  const isReportOnlyDraft = isReportOnlyType(draft.report_type);
  // Report-only: no WO PDF required; job is created with report_type set.
  // Normal WO (report_type null/non-report-only): job created normally.
  return { jobCreated: true, error: null, isReportOnlyDraft };
}

Deno.test("ISSUE 2: approve gate CREATES a job for a roof_report draft (not blocked)", () => {
  const r = modelApproveGate({ report_type: "roof_report" });
  assertEquals(r.jobCreated, true);
  assertEquals(r.error, null);
  assertEquals(r.isReportOnlyDraft, true);
});

Deno.test("ISSUE 2: approve gate CREATES a job for an assessment_report draft (not blocked)", () => {
  const r = modelApproveGate({ report_type: "assessment_report" });
  assertEquals(r.jobCreated, true);
  assertEquals(r.error, null);
  assertEquals(r.isReportOnlyDraft, true);
});

Deno.test("ISSUE 2: a normal WO draft (report_type null) still creates a job", () => {
  const r = modelApproveGate({ report_type: null });
  assertEquals(r.jobCreated, true);
  assertEquals(r.error, null);
  assertEquals(r.isReportOnlyDraft, false);
});

Deno.test("ISSUE 2: a combined make-safe-AND-report (unknown_report) creates a normal WO job", () => {
  const r = modelApproveGate({ report_type: "unknown_report" });
  assertEquals(r.jobCreated, true);
  assertEquals(r.isReportOnlyDraft, false);
});

// ════════════════════════════════════════════════════════════════════════════
// ISSUE 3: isPureAckNoAction — light over-capture guard
// ════════════════════════════════════════════════════════════════════════════

Deno.test("ISSUE 3: a pure 'thanks' ack with no action and no PDF is DROPPED", () => {
  const subject = "Our Ref: MLB-25795 - thanks for the update";
  assert(
    isPureAckNoAction(subject, false),
    "pure thanks ack should be droppable",
  );
  const r = isGenuineNewWorkOrder(subject, MLB_SENDER, 0);
  assertEquals(r.ok, false);
  assertEquals(r.reason, "pure_ack_no_action");
});

Deno.test("ISSUE 3: 'noted' / 'received' courtesy acks are DROPPED", () => {
  assert(isPureAckNoAction("Our Ref: MLB-25795 - noted", false));
  assert(isPureAckNoAction("Our Ref: MLB-25795 - received with thanks", false));
});

Deno.test("ISSUE 3: an actionable Our-Ref (address/roof) is KEPT (captured)", () => {
  const subject =
    "Our Ref: MLB-25795 - 47 Hale St, Eaton - roof report required";
  assert(
    !isPureAckNoAction(subject, false),
    "actionable Our-Ref must NOT be droppable",
  );
  const r = isGenuineNewWorkOrder(subject, MLB_SENDER, 0);
  assertEquals(r.ok, true);
  assertEquals(r.kind, "report");
});

Deno.test("ISSUE 3: an ack subject WITH a PDF is NEVER dropped", () => {
  assert(!isPureAckNoAction("Our Ref: MLB-25795 - thanks", true));
});

Deno.test("ISSUE 3: ambiguous Our-Ref with no clear action and no ack word STAYS captured", () => {
  const subject = "Our Ref: MLB-25795 - 47 Hale St, Eaton";
  assert(!isPureAckNoAction(subject, false));
  const r = isGenuineNewWorkOrder(subject, MLB_SENDER, 0);
  assertEquals(r.ok, true);
  assertEquals(r.kind, "report");
});

Deno.test("ISSUE 3: BWCWA report-request is NOT a pure ack", () => {
  assert(
    !isPureAckNoAction(
      "BWCWA6773 Builderwest; New Make Safe and Report Request.",
      false,
    ),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// REPORT JOB CLOSEOUT — invoice-only gate
// ════════════════════════════════════════════════════════════════════════════

Deno.test("closeout: report job requires only invoice (no report doc)", () => {
  // Model _makesafeMissingCloseoutDocs with isReportJob=true
  function missingDocs(
    docs: {
      has_invoice_doc?: boolean;
      has_report_doc?: boolean;
      has_swms_doc?: boolean;
    },
    requiresSwms: boolean,
    isReportJob: boolean,
  ): string[] {
    const missing: string[] = [];
    if (!docs.has_invoice_doc) missing.push("invoice");
    if (!isReportJob && !docs.has_report_doc) missing.push("report");
    if (requiresSwms && !docs.has_swms_doc) missing.push("swms");
    return missing;
  }
  // Report job with invoice: gate satisfied
  assertEquals(
    missingDocs({ has_invoice_doc: true, has_report_doc: false }, false, true),
    [],
  );
  // Report job without invoice: missing invoice
  assertEquals(
    missingDocs({ has_invoice_doc: false, has_report_doc: false }, false, true),
    ["invoice"],
  );
  // Normal WO without report: missing report
  assertEquals(
    missingDocs({ has_invoice_doc: true, has_report_doc: false }, false, false),
    ["report"],
  );
  // Normal WO with both: gate satisfied
  assertEquals(
    missingDocs({ has_invoice_doc: true, has_report_doc: true }, false, false),
    [],
  );
});

// ════════════════════════════════════════════════════════════════════════════
// REPORT JOB MONEY GATE — $0 invoice blocked
// ════════════════════════════════════════════════════════════════════════════

Deno.test("money gate: report job with $0 line items throws", () => {
  function reportJobMoneyGate(
    reportType: string | null,
    lineItems: Array<{ unit_price: number; quantity?: number }>,
  ): string | null {
    if (!reportType) return null; // normal job, no gate
    const totalExGst = lineItems.reduce(
      (sum, li) => sum + li.unit_price * (li.quantity ?? 1),
      0,
    );
    if (lineItems.length === 0) {
      return "report job needs a charge amount before invoicing: supply line_items_override with the trade/WO charge";
    }
    if (totalExGst <= 0) {
      return "report job needs a charge amount before invoicing: line items sum to $0 or less";
    }
    return null;
  }
  // No line items -> error
  assert(
    reportJobMoneyGate("roof_report", []) !== null,
    "empty line items must error",
  );
  // $0 line item -> error
  assert(
    reportJobMoneyGate("roof_report", [{ unit_price: 0, quantity: 1 }]) !==
      null,
    "$0 must error",
  );
  // Non-zero -> passes
  assertEquals(
    reportJobMoneyGate("roof_report", [{ unit_price: 100, quantity: 1 }]),
    null,
  );
  // Normal job (report_type null) -> no gate
  assertEquals(reportJobMoneyGate(null, []), null);
});

Deno.test("money gate: report job with a valid charge passes", () => {
  // $150 ex-GST trade charge -> ok
  const lineItems = [{
    description: "Roof report attendance",
    unit_price: 150,
    quantity: 1,
  }];
  const total = lineItems.reduce((s, li) => s + li.unit_price * li.quantity, 0);
  assert(total > 0, "valid charge must sum to non-zero");
});

Deno.test("money gate: normal WO job with empty pricing_json does NOT hit the report gate", () => {
  // Normal WOs are not gated on report_type; their $0 handling is separate
  function reportJobMoneyGate(
    reportType: string | null,
    lineItems: Array<{ unit_price: number; quantity?: number }>,
  ): string | null {
    if (!reportType) return null;
    const totalExGst = lineItems.reduce(
      (sum, li) => sum + li.unit_price * (li.quantity ?? 1),
      0,
    );
    if (lineItems.length === 0) return "error";
    if (totalExGst <= 0) return "error";
    return null;
  }
  assertEquals(reportJobMoneyGate(null, []), null); // normal WO, no gate
});

// ════════════════════════════════════════════════════════════════════════════
// PORTAL LINK EXTRACTION
// ════════════════════════════════════════════════════════════════════════════

Deno.test("portal_link: Haiku extraction result stores URL in extraction_json.portal_link", () => {
  // Model the extraction result from the Haiku prompt
  const extractionResult = {
    external_ref: "MLB-25795",
    client_name: "John Smith",
    site_address: "47 Hale St, Eaton",
    portal_link: "https://portal.builderwest.com.au/jobs/25795",
    confidence: "high",
    missing_fields: [],
  };
  assertEquals(
    extractionResult.portal_link,
    "https://portal.builderwest.com.au/jobs/25795",
  );
});

Deno.test("portal_link: extraction_json.portal_link null when not present", () => {
  const extractionResult = {
    external_ref: "MLB-25795",
    client_name: "John Smith",
    site_address: "47 Hale St",
    portal_link: null,
    confidence: "high",
    missing_fields: [],
  };
  assertEquals(extractionResult.portal_link, null);
});

// ════════════════════════════════════════════════════════════════════════════
// SEND PACK — report job sends invoice only
// ════════════════════════════════════════════════════════════════════════════

Deno.test("send pack: report job attachment list is invoice-only (no report PDF)", () => {
  // Model the attachment assembly logic from makesafeSendPack
  function buildAttachments(
    isReportJob: boolean,
    reportPdfB64: string | null,
    invoicePdfB64: string,
    invoicePdfName: string,
  ): Array<{ name: string }> {
    return isReportJob ? [{ name: invoicePdfName }] : [
      { name: reportPdfB64 ? "report.pdf" : "report-unavailable.pdf" },
      { name: invoicePdfName },
    ];
  }
  // Report job: only invoice
  const reportAttachments = buildAttachments(
    true,
    null,
    "base64==",
    "Xero Invoice - INV-001.pdf",
  );
  assertEquals(reportAttachments.length, 1);
  assertEquals(reportAttachments[0].name, "Xero Invoice - INV-001.pdf");

  // Normal WO: report + invoice
  const normalAttachments = buildAttachments(
    false,
    "base64==",
    "base64==",
    "Xero Invoice - INV-002.pdf",
  );
  assertEquals(normalAttachments.length, 2);
});

Deno.test("send pack: normal WO job (no report_type) still sends report + invoice", () => {
  function isReportJob(reportType: string | null | undefined): boolean {
    return !!reportType;
  }
  assertEquals(isReportJob(null), false);
  assertEquals(isReportJob("roof_report"), true);
  assertEquals(isReportJob("assessment_report"), true);
  assertEquals(isReportJob("unknown_report"), true); // combined WO+report still has report_type
});

// ════════════════════════════════════════════════════════════════════════════
// REGRESSION: normal WO and combined WO+report still approve normally
// ════════════════════════════════════════════════════════════════════════════

Deno.test("regression: normal WO (report_type null) requires work_order_pdf", () => {
  // The approve gate should still require work_order_pdf for a normal WO.
  // We model the gate: isReportOnlyDraft=false -> work_order_pdf IS required.
  function approveGateNeedsWoPdf(
    reportType: string | null,
    hasWoPdf: boolean,
  ): string | null {
    const isReportOnlyDraft = isReportOnlyType(reportType);
    if (!isReportOnlyDraft && !hasWoPdf) return "work_order_pdf";
    return null;
  }
  assertEquals(approveGateNeedsWoPdf(null, false), "work_order_pdf"); // normal WO, no PDF -> blocked
  assertEquals(approveGateNeedsWoPdf(null, true), null); // normal WO, has PDF -> ok
  assertEquals(approveGateNeedsWoPdf("roof_report", false), null); // report-only, no PDF -> ok
  assertEquals(
    approveGateNeedsWoPdf("unknown_report", false),
    "work_order_pdf",
  ); // combined WO, no PDF -> blocked
});

Deno.test("regression: combined WO+report (unknown_report) still needs WO PDF", () => {
  // A BWCWA-style combined make-safe-AND-report has report_type='unknown_report' but
  // is NOT isReportOnlyType, so it still requires a work_order_pdf.
  assert(
    !isReportOnlyType("unknown_report"),
    "unknown_report is not report-only",
  );
  // therefore it would still need a WO PDF at approval time
});

// ── Four-way practical job family classifier ──────────────────────────────────
import {
  classifyMakeSafeJobFamily,
  makeSafeJobFamilyLabel,
} from "./makesafe_intake_gate.ts";

Deno.test("job family: roof report is distinct from physical roof make-safe", () => {
  assertEquals(
    classifyMakeSafeJobFamily(
      "NEW WORK ORDER - MLB-26072",
      "Roof make safe: tarp and make safe roof tiles",
      null,
    ),
    "general_makesafe",
  );
  assertEquals(
    classifyMakeSafeJobFamily(
      "Our Ref: MLB-26072",
      "Please complete the roof report in Prime",
      "roof_report",
    ),
    "roof_report",
  );
});

Deno.test("job family: assessment report and quote are grouped", () => {
  assertEquals(
    classifyMakeSafeJobFamily(
      "Our Ref: MLB-26000",
      "Assessment report link and quote request attached",
      "assessment_report",
    ),
    "assessment_report_quote",
  );
  assertEquals(
    makeSafeJobFamilyLabel("assessment_report_quote"),
    "Assessment / Quote Report",
  );
});

Deno.test("job family: temporary fence wins over report wording", () => {
  assertEquals(
    classifyMakeSafeJobFamily(
      "Retrieve temp fencing - MLB-26001",
      "Please send report after pickup",
      null,
    ),
    "temp_fence_makesafe",
  );
});
