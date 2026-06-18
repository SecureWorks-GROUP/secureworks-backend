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
