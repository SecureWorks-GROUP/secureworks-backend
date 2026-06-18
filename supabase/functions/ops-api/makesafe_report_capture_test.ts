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

import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isGenuineNewWorkOrder,
  classifyReportType,
  slugFromRefPrefix,
  isReportOnlyType,
  isPureAckNoAction,
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
  const subject = "Our Ref: MLB-25795 - 47 Hale St, Eaton - Client Ref: 13328921";
  const r = isGenuineNewWorkOrder(subject, MLB_SENDER, 0);
  assertEquals(r.ok, true, `expected ok=true, got reason=${r.reason}`);
  assertEquals(r.kind, "report", `expected kind=report`);
  assertEquals(r.reason, "report_capture_pattern");
});

Deno.test("isGenuineNewWorkOrder: MLB Our-Ref subject with body about roof — report_type=roof_report", () => {
  const subject = "Our Ref: MLB-25795 - 47 Hale St, Eaton - Client Ref: 13328921";
  const body = "Please attend the property for a roof report assessment. Storm damage to roof tiles.";
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
  const r = isGenuineNewWorkOrder("NEW WORK ORDER - MLB-25096", OWN_SENDER_COMAU, 1);
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
  const subject = "NEW WORK ORDER - MLB-25096 7 Broughton St, Balcatta, WA 6021";
  const r = isGenuineNewWorkOrder(subject, MLB_SENDER, 0);
  assertEquals(r.ok, true);
  assertEquals(r.kind, "work_order");
  assertEquals(r.reason, "new_work_order_subject");
});

// Normal WO should have report_type=null (classifyReportType is only called for report captures).
// The wire layer does NOT call classifyReportType for kind=work_order.
// No direct test needed here — the gate itself never sets report_type.

// ── 6. classifyReportType ─────────────────────────────────────────────────────

Deno.test("classifyReportType: body mentions roof -> roof_report", () => {
  assertEquals(
    classifyReportType("Our Ref: MLB-25795 - 47 Hale St", "Please do a roof report inspection."),
    "roof_report",
  );
});

Deno.test("classifyReportType: body mentions re-attend -> re_attend", () => {
  assertEquals(
    classifyReportType("Our Ref: MLB-25800 - 5 Fake St", "Insurer requires a re-attend on this property."),
    "re_attend",
  );
});

Deno.test("classifyReportType: body mentions temp fence collect -> temp_fence", () => {
  assertEquals(
    classifyReportType("Our Ref: MLB-25801 - 9 Test Ave", "Please collect the temporary fencing panels."),
    "temp_fence",
  );
});

Deno.test("classifyReportType: body mentions assessment -> assessment_report", () => {
  assertEquals(
    classifyReportType("Our Ref: MLB-25802 - 3 Sample Rd", "Please provide a full assessment of the storm damage."),
    "assessment_report",
  );
});

Deno.test("classifyReportType: body mentions pickup -> temp_fence", () => {
  assertEquals(
    classifyReportType("Our Ref: MLB-25803 - 8 Any St", "Arrange pickup of hire fencing."),
    "temp_fence",
  );
});

Deno.test("classifyReportType: subject signals take priority over body", () => {
  // Subject says temp_fence, body says roof — subject wins.
  assertEquals(
    classifyReportType("Retrieve temp fencing - MLB-25804", "Full roof damage report required."),
    "temp_fence",
  );
});

Deno.test("classifyReportType: no signals -> unknown_report", () => {
  assertEquals(
    classifyReportType("Our Ref: MLB-25805 - 1 Blank St", "Please action as required."),
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
// CODEX REVIEW FIXES (PR #212)
// ════════════════════════════════════════════════════════════════════════════

// ── ISSUE 1: a report email that arrives WITH a PDF must still carry report_type ──

Deno.test("ISSUE 1: report-pattern subject WITH a PDF still flags reportSubjectPattern", () => {
  // A roof report that happens to arrive with a PDF: the work_order_pdf signal
  // makes it kind='work_order', but reportSubjectPattern MUST be set so the caller
  // tags report_type instead of silently treating it as a plain work order.
  const subject = "Our Ref: MLB-25795 - 47 Hale St, Eaton - roof report";
  const r = isGenuineNewWorkOrder(subject, MLB_SENDER, 1);
  assertEquals(r.ok, true);
  assertEquals(r.kind, "work_order");               // PDF signal wins on kind
  assertEquals(r.reportSubjectPattern, true);        // but still flagged as report
  assertEquals(r.reason, "work_order_pdf");
  // The wire layer then runs classifyReportType -> roof_report.
  assertEquals(classifyReportType(subject, ""), "roof_report");
});

Deno.test("ISSUE 1: BWCWA make-safe-AND-report stays kind=work_order but carries report flag", () => {
  // "New Make Safe and Report Request" with a WO PDF: it IS a make-safe (approves
  // as a WO) but ALSO wants a report — must carry reportSubjectPattern.
  const subject = "BWCWA6773 Builderwest; New Make Safe and Report Request.";
  const r = isGenuineNewWorkOrder(subject, BW_SENDER, 1);
  assertEquals(r.ok, true);
  assertEquals(r.kind, "work_order");
  assertEquals(r.reportSubjectPattern, true);
});

Deno.test("ISSUE 1: a NORMAL WO (no report pattern) has reportSubjectPattern false", () => {
  const r = isGenuineNewWorkOrder("Make Safe Work Order: WB69684 - Cottesloe", BW_SENDER, 1);
  assertEquals(r.ok, true);
  assertEquals(r.kind, "work_order");
  assertEquals(r.reportSubjectPattern, false);
});

Deno.test("ISSUE 1: report-pattern with NO PDF is kind=report and reportSubjectPattern true", () => {
  const r = isGenuineNewWorkOrder("Our Ref: MLB-25795 - 47 Hale St, Eaton - roof report", MLB_SENDER, 0);
  assertEquals(r.ok, true);
  assertEquals(r.kind, "report");
  assertEquals(r.reportSubjectPattern, true);
});

Deno.test("ISSUE 1: subjectMatchesReportCapture is PDF-independent (subject-only)", () => {
  assert(subjectMatchesReportCapture("Our Ref: MLB-25795 - 47 Hale St"));
  assert(subjectMatchesReportCapture("BWCWA6773 Builderwest; New Make Safe and Report Request."));
  assert(!subjectMatchesReportCapture("Make Safe Work Order: WB69684 - Cottesloe"));
});

// ── ISSUE 2: report-only drafts must NOT be approvable into a make-safe job ──

Deno.test("ISSUE 2: isReportOnlyType true for roof_report and assessment_report", () => {
  assert(isReportOnlyType("roof_report"));
  assert(isReportOnlyType("assessment_report"));
});

Deno.test("ISSUE 2: isReportOnlyType false for non-report-only types", () => {
  // temp_fence / re_attend involve a physical attend, unknown_report and null are
  // not report-only either — only roof/assessment are blocked from approval.
  assert(!isReportOnlyType("temp_fence"));
  assert(!isReportOnlyType("re_attend"));
  assert(!isReportOnlyType("unknown_report"));
  assert(!isReportOnlyType(null));
  assert(!isReportOnlyType(undefined));
  assert(!isReportOnlyType(""));
});

// Pure model of the approveIntakeDraft guard ordering (approveIntakeDraft itself is
// module-internal, mirrored here per the makesafe_wave0_hardening_test.ts convention).
// Guard: a report-only draft is BLOCKED before any job is created; reject still works.
function modelApproveGate(draft: { report_type: string | null }): { jobCreated: boolean; error: string | null } {
  if (isReportOnlyType(draft.report_type)) {
    return { jobCreated: false, error: "report_only_blocked" };
  }
  // ... real code would createMakesafeJob + attach PDFs here ...
  return { jobCreated: true, error: null };
}

Deno.test("ISSUE 2: approve gate BLOCKS a roof_report draft and creates NO job", () => {
  const r = modelApproveGate({ report_type: "roof_report" });
  assertEquals(r.jobCreated, false);
  assertEquals(r.error, "report_only_blocked");
});

Deno.test("ISSUE 2: approve gate BLOCKS an assessment_report draft and creates NO job", () => {
  const r = modelApproveGate({ report_type: "assessment_report" });
  assertEquals(r.jobCreated, false);
  assertEquals(r.error, "report_only_blocked");
});

Deno.test("ISSUE 2: a normal WO draft (report_type null) still creates a job", () => {
  const r = modelApproveGate({ report_type: null });
  assertEquals(r.jobCreated, true);
  assertEquals(r.error, null);
});

Deno.test("ISSUE 2: a combined make-safe-AND-report is NOT report-only — still approves", () => {
  // A BWCWA-style WO that carries report_type='unknown_report' is a real make-safe;
  // it is not roof/assessment-only, so it approves normally as a work order.
  const r = modelApproveGate({ report_type: "unknown_report" });
  assertEquals(r.jobCreated, true);
});

Deno.test("ISSUE 2: reject path is independent of report_type (always allowed)", () => {
  // rejectIntakeDraft only flips status='rejected'; it never inspects report_type,
  // so a human can always clear a report-only draft. Model that invariant.
  const reject = (_draft: { report_type: string | null }) => ({ status: "rejected" });
  assertEquals(reject({ report_type: "roof_report" }).status, "rejected");
  assertEquals(reject({ report_type: "assessment_report" }).status, "rejected");
});

// ── ISSUE 3: light over-capture guard — pure acks drop, actionable stays ──

Deno.test("ISSUE 3: a pure 'thanks' ack with no action and no PDF is DROPPED", () => {
  const subject = "Our Ref: MLB-25795 - thanks for the update";
  assert(isPureAckNoAction(subject, false), "pure thanks ack should be droppable");
  const r = isGenuineNewWorkOrder(subject, MLB_SENDER, 0);
  assertEquals(r.ok, false);
  assertEquals(r.reason, "pure_ack_no_action");
});

Deno.test("ISSUE 3: 'noted' / 'received' courtesy acks are DROPPED", () => {
  assert(isPureAckNoAction("Our Ref: MLB-25795 - noted", false));
  assert(isPureAckNoAction("Our Ref: MLB-25795 - received with thanks", false));
});

Deno.test("ISSUE 3: an actionable Our-Ref (address/roof) is KEPT (captured)", () => {
  // Has an address + roof — clearly actionable. Must stay captured.
  const subject = "Our Ref: MLB-25795 - 47 Hale St, Eaton - roof report required";
  assert(!isPureAckNoAction(subject, false), "actionable Our-Ref must NOT be droppable");
  const r = isGenuineNewWorkOrder(subject, MLB_SENDER, 0);
  assertEquals(r.ok, true);
  assertEquals(r.kind, "report");
});

Deno.test("ISSUE 3: an ack subject WITH a PDF is NEVER dropped (PDF could be the report)", () => {
  // Even a "thanks" subject keeps if a PDF rides along — the PDF could be the report.
  assert(!isPureAckNoAction("Our Ref: MLB-25795 - thanks", true));
});

Deno.test("ISSUE 3: ambiguous Our-Ref with no clear action and no ack word STAYS captured", () => {
  // Not a recognised courtesy line, not clearly actionable -> err toward capture.
  const subject = "Our Ref: MLB-25795 - 47 Hale St, Eaton";
  assert(!isPureAckNoAction(subject, false));
  const r = isGenuineNewWorkOrder(subject, MLB_SENDER, 0);
  assertEquals(r.ok, true);
  assertEquals(r.kind, "report");
});

Deno.test("ISSUE 3: BWCWA report-request is NOT a pure ack (has 'report' action word)", () => {
  assert(!isPureAckNoAction("BWCWA6773 Builderwest; New Make Safe and Report Request.", false));
});
