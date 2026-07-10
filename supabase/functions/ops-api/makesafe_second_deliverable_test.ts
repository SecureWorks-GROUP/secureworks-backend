// M-G WORKSTREAM D-3 — the dropped-second-work-order decision.
//
// The scanSesMakesafes disposition silently skipped a same-ref candidate whose first
// job is still ACTIVE, on the assumption it was a re-scan. isDistinctSecondDeliverable
// is the pure decision that now routes a genuinely distinct second deliverable to its
// own needs_review draft instead of dropping it (Marnin's "we aren't making the second WO").
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isDistinctSecondDeliverable } from "./index.ts";

Deno.test("D-3: a second WO carrying its OWN servable WO PDF -> distinct (surfaced, not dropped)", () => {
  assertEquals(
    isDistinctSecondDeliverable({
      matchedJobId: "job-active-makesafe",
      availableWoCount: 1, // its own WO PDF
      candidateFamily: "general_makesafe",
      hasFamilySpecificSibling: true, // even same-family: a distinct WO is not a re-scan
      hasFamilyAgnosticSibling: true,
    }),
    true,
  );
});

Deno.test("D-3: a different-family sibling under the same ref -> distinct (roof report vs make-safe)", () => {
  assertEquals(
    isDistinctSecondDeliverable({
      matchedJobId: "job-active-makesafe",
      availableWoCount: 0, // no new PDF, but the sibling is a different family
      candidateFamily: "roof_report",
      hasFamilySpecificSibling: false, // no ref+company+roof_report job exists
      hasFamilyAgnosticSibling: true, // but a ref+company job (the make-safe) exists
    }),
    true,
  );
});

Deno.test("D-3: a nudge / no-WO email, same family -> NOT distinct (keeps the silent skip)", () => {
  assertEquals(
    isDistinctSecondDeliverable({
      matchedJobId: "job-active-makesafe",
      availableWoCount: 0, // no servable WO PDF (a nudge / reminder)
      candidateFamily: "general_makesafe",
      hasFamilySpecificSibling: true, // same family as the active job
      hasFamilyAgnosticSibling: true,
    }),
    false,
  );
});

Deno.test("D-3: ambiguous ref (no company-scoped match, matchedJobId null) -> never distinct", () => {
  assertEquals(
    isDistinctSecondDeliverable({
      matchedJobId: null, // ambiguous ref shared across builders -> never point at a job
      availableWoCount: 1,
      candidateFamily: "roof_report",
      hasFamilySpecificSibling: false,
      hasFamilyAgnosticSibling: false,
    }),
    false,
  );
});

Deno.test("D-3: different-family signal needs a family-agnostic sibling to exist", () => {
  // family-specific miss but ALSO no family-agnostic hit -> not a sibling situation
  assertEquals(
    isDistinctSecondDeliverable({
      matchedJobId: "job-x",
      availableWoCount: 0,
      candidateFamily: "roof_report",
      hasFamilySpecificSibling: false,
      hasFamilyAgnosticSibling: false,
    }),
    false,
  );
});
