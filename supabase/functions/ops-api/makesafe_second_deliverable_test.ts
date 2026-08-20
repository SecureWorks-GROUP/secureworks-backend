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
      sameWoAsActiveJob: false,
    }),
    true,
  );
});

Deno.test("D-3: a family label without a distinct WO is not new work", () => {
  assertEquals(
    isDistinctSecondDeliverable({
      matchedJobId: "job-active-makesafe",
      availableWoCount: 0,
      sameWoAsActiveJob: false,
    }),
    false,
  );
});

Deno.test("D-3: a nudge / no-WO email, same family -> NOT distinct (keeps the silent skip)", () => {
  assertEquals(
    isDistinctSecondDeliverable({
      matchedJobId: "job-active-makesafe",
      availableWoCount: 0, // no servable WO PDF (a nudge / reminder)
      sameWoAsActiveJob: false,
    }),
    false,
  );
});

Deno.test("D-3: ambiguous ref (no company-scoped match, matchedJobId null) -> never distinct", () => {
  assertEquals(
    isDistinctSecondDeliverable({
      matchedJobId: null, // ambiguous ref shared across builders -> never point at a job
      availableWoCount: 1,
      sameWoAsActiveJob: false,
    }),
    false,
  );
});

Deno.test("D-3: no servable WO is never a distinct deliverable", () => {
  assertEquals(
    isDistinctSecondDeliverable({
      matchedJobId: "job-x",
      availableWoCount: 0,
      sameWoAsActiveJob: false,
    }),
    false,
  );
});

Deno.test("D-3: a builder re-SENDING the SAME WO (same WO/PO identity) -> NOT distinct (no duplicate card)", () => {
  // carries a WO PDF, but its WO/PO identity matches the active sibling job -> a re-send,
  // not a second deliverable. Must NOT mint a duplicate review card.
  assertEquals(
    isDistinctSecondDeliverable({
      matchedJobId: "job-active-makesafe",
      availableWoCount: 1,
      sameWoAsActiveJob: true, // same WO/PO identity as the active job
    }),
    false,
  );
});
