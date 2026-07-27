// deno-lint-ignore-file no-import-prefix

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyCancellation } from "./makesafe_cancellation_classifier.ts";
import {
  buildDeterministicIntakePlan,
  type DeterministicCompanyProfile,
  type DeterministicSourceItem,
} from "./makesafe_deterministic_intake.ts";

const PROFILE: DeterministicCompanyProfile = {
  id: "company-mlb",
  slug: "mlb",
  name: "MLB",
  senderPatterns: ["mlbuilders.com.au"],
};

function source(body: string): DeterministicSourceItem {
  return {
    postId: `post-${body.length}`,
    fromEmail: "dispatch@mlbuilders.com.au",
    subject: "Work Order MLB-25769 WO-25769",
    body,
    receivedAt: "2026-07-27T00:00:00.000Z",
    attachments: [],
    links: [],
  };
}

Deno.test("shared cancellation classifier accepts subject, imperative and passive forms", () => {
  assertEquals(
    classifyCancellation({ subject: "CANCELLED WORK ORDER - MLB-25769" }),
    { isCancellation: true, matchedForm: "subject" },
  );
  assertEquals(
    classifyCancellation({ currentMessageText: "Cancel it please." }),
    { isCancellation: true, matchedForm: "direct_imperative" },
  );
  assertEquals(
    classifyCancellation({
      currentMessageText: "The work order has been withdrawn.",
    }),
    { isCancellation: true, matchedForm: "passive_notice" },
  );
});

Deno.test("shared cancellation classifier rejects policy, negation and quoted history", () => {
  for (
    const currentMessageText of [
      "Please review the cancellation policy.",
      "Do not cancel this work order.",
      "Thanks.\n\nFrom: Builder\nSubject: Old message\nCancel this work order.",
      "The invoice has been cancelled.",
      "Please cancel.",
      "Void.",
    ]
  ) {
    assertEquals(
      classifyCancellation({ currentMessageText }),
      { isCancellation: false, matchedForm: null },
    );
  }
});

Deno.test("deterministic story and intent use the same cancellation classifier", () => {
  const plan = buildDeterministicIntakePlan(
    [source("Please cancel this work order.")],
    [PROFILE],
  );
  assertEquals(plan.cases.length, 1);
  assertEquals(plan.cases[0].reasonCode, "cancellation_target_not_found");
  assertEquals(plan.cases[0].targetRelation, "cancellation_of");
  assertEquals(
    plan.cases[0].story.some((event) => event.kind === "cancellation"),
    true,
  );
});
