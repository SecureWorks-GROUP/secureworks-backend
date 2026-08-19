import type { SesBlocker } from "./ses_docket_envelope.ts";

export type SesPreparationIssueClass = NonNullable<SesBlocker["issue_class"]>;

export interface SesPreparationIssueBuckets {
  hard_blockers: SesBlocker[];
  review_assumptions: SesBlocker[];
  send_gates: SesBlocker[];
  invoice_gates: SesBlocker[];
  /**
   * Commercial taste (hours / rates / materials figure). Visible for Captain
   * review; must never feed the draft-mint 409 wall (Captain 2026-08-19).
   */
  commercial_reviews: SesBlocker[];
}

/**
 * Classification is structural. Phase One always emits a visible report and
 * draft-zero review pack, so an unclassified preparation uncertainty is a
 * review assumption.  The few identity/integrity fences which must remain
 * hard are named explicitly at their emission sites; they still never hide
 * the exception pack. Commercial taste is `commercial_review`: flag, not wall.
 */
export function classifySesPreparationIssue(
  blocker: SesBlocker,
): SesPreparationIssueClass {
  return blocker.issue_class || "review_assumption";
}

export function classifySesPreparationIssues(
  blockers: readonly SesBlocker[],
): SesPreparationIssueBuckets {
  const result: SesPreparationIssueBuckets = {
    hard_blockers: [],
    review_assumptions: [],
    send_gates: [],
    invoice_gates: [],
    commercial_reviews: [],
  };
  for (const blocker of blockers) {
    switch (classifySesPreparationIssue(blocker)) {
      case "identity_safety_hard":
        result.hard_blockers.push(blocker);
        break;
      case "send_gate":
        result.send_gates.push(blocker);
        break;
      case "invoice_gate":
        result.invoice_gates.push(blocker);
        break;
      case "commercial_review":
        result.commercial_reviews.push(blocker);
        break;
      case "review_assumption":
        result.review_assumptions.push(blocker);
        break;
    }
  }
  return result;
}

export function isHardSesPreparationIssue(blocker: SesBlocker): boolean {
  return classifySesPreparationIssue(blocker) === "identity_safety_hard";
}
