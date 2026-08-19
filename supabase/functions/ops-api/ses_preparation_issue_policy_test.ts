import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SesBlocker } from "./ses_docket_envelope.ts";
import { classifySesPreparationIssues } from "./ses_preparation_issue_policy.ts";

function blocker(
  reason_code: string,
  issue_class: NonNullable<SesBlocker["issue_class"]>,
): SesBlocker {
  return {
    state: "blocked",
    reason: reason_code,
    reason_code,
    issue_class,
    searches_attempted: [],
    rejected_candidates: [],
    recovery_action: "review",
  };
}

Deno.test("commercial_review buckets separately from invoice_gate and hard blockers", () => {
  const buckets = classifySesPreparationIssues([
    blocker("spine_missing_lineage", "identity_safety_hard"),
    blocker("optional_swms_missing", "review_assumption"),
    blocker("routing_evidence_missing", "send_gate"),
    blocker("legacy_invoice_gate", "invoice_gate"),
    blocker("pricing_evidence_missing", "commercial_review"),
  ]);
  assertEquals(buckets.hard_blockers.map((b) => b.reason_code), [
    "spine_missing_lineage",
  ]);
  assertEquals(buckets.review_assumptions.map((b) => b.reason_code), [
    "optional_swms_missing",
  ]);
  assertEquals(buckets.send_gates.map((b) => b.reason_code), [
    "routing_evidence_missing",
  ]);
  assertEquals(buckets.invoice_gates.map((b) => b.reason_code), [
    "legacy_invoice_gate",
  ]);
  assertEquals(buckets.commercial_reviews.map((b) => b.reason_code), [
    "pricing_evidence_missing",
  ]);
});
