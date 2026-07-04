// ════════════════════════════════════════════════════════════
// B2 — CLASSIFICATION COMMITMENT: model-committed report_type
// ════════════════════════════════════════════════════════════
//
// Pure-Deno, no network. Proves the model's committed report_type is preferred, the
// keyword classifier is the fallback used only on abstain, general/not_a_report map
// to null (a physical make-safe, not a report-only card), and unknown_report is
// preserved as the needs_review safety valve for genuine ambiguity.
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/makesafe_report_type_commit_test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveCommittedReportType } from "./makesafe_intake_gate.ts";

// The high-volume MLB archetype: "Our Ref: MLB-XXXX - <addr>" with no roof/assessment
// keyword in the subject. Keyword-only -> unknown_report (the pile-up). With B2 the
// model reads the body/PDF and commits a class.
const MLB_SUBJECT = "Our Ref: MLB-24363 - 12 Keane Ct, Noranda - Client Ref: 13328238";
const NEUTRAL_BODY = "Please attend and make the property safe.";

Deno.test("B2: model commits roof_report -> used verbatim", () => {
  assertEquals(resolveCommittedReportType("roof_report", MLB_SUBJECT, NEUTRAL_BODY), "roof_report");
});

Deno.test("B2: model commits assessment (alias) -> assessment_report", () => {
  assertEquals(resolveCommittedReportType("assessment", MLB_SUBJECT, NEUTRAL_BODY), "assessment_report");
  assertEquals(resolveCommittedReportType("assessment_report_quote", MLB_SUBJECT, NEUTRAL_BODY), "assessment_report");
});

Deno.test("B2: model commits temp_fence / re_attend -> used verbatim", () => {
  assertEquals(resolveCommittedReportType("temp_fence", MLB_SUBJECT, NEUTRAL_BODY), "temp_fence");
  assertEquals(resolveCommittedReportType("re_attend", MLB_SUBJECT, NEUTRAL_BODY), "re_attend");
});

Deno.test("B2: model commits general_makesafe / not_a_report -> null (physical make-safe, not report-only)", () => {
  assertEquals(resolveCommittedReportType("general_makesafe", MLB_SUBJECT, NEUTRAL_BODY), null);
  assertEquals(resolveCommittedReportType("not_a_report", MLB_SUBJECT, NEUTRAL_BODY), null);
});

Deno.test("B2: model ABSTAINS (empty/unknown) -> keyword fallback", () => {
  // Subject has no roof/assessment keyword and body is neutral -> keyword returns
  // unknown_report (the preserved safety valve).
  assertEquals(resolveCommittedReportType("", MLB_SUBJECT, NEUTRAL_BODY), "unknown_report");
  assertEquals(resolveCommittedReportType(null, MLB_SUBJECT, NEUTRAL_BODY), "unknown_report");
  assertEquals(resolveCommittedReportType("unknown_report", MLB_SUBJECT, NEUTRAL_BODY), "unknown_report");
});

Deno.test("B2: model abstains but keyword CAN classify from body -> uses keyword result", () => {
  // Body mentions roof -> keyword classifies roof_report even though model abstained.
  assertEquals(
    resolveCommittedReportType(null, MLB_SUBJECT, "Please complete the roof report for this property."),
    "roof_report",
  );
});

Deno.test("B2: model commit BEATS a conflicting keyword signal", () => {
  // Subject/body scream 'roof' but the model (reading the PDF) commits temp_fence.
  assertEquals(
    resolveCommittedReportType("temp_fence", "roof report request", "roof roof roof"),
    "temp_fence",
  );
});

Deno.test("B2: an unrecognised model value is treated as abstain -> keyword fallback", () => {
  assertEquals(resolveCommittedReportType("banana", MLB_SUBJECT, NEUTRAL_BODY), "unknown_report");
});
