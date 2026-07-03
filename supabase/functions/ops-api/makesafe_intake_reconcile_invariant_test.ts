import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { summarizeIntakeReconcileInvariant } from "./makesafe_intake_reconciliation.ts";

// MLB sends from mlbuilders.com.au; the sender pattern is the bare domain.
const SENDER_PATTERNS = ["mlbuilders.com.au"];

Deno.test("invariant: an email with a linked draft is accounted", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{ post_id: "p1", subject: "NEW WORK ORDER - MLB-25096", from_email: "jobs@mlbuilders.com.au" }],
    drafts: [{ graph_message_id: "p1", status: "needs_review" }],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });
  assertEquals(inv.counts.unaccounted, 0);
  assert(inv.live_and_true);
});

Deno.test("invariant: our own outbound copy is accounted, not flagged", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{ post_id: "p2", subject: "Make Safe Report and Invoice - MLB-25096", from_email: "invoices@secureworksgroup.app" }],
    drafts: [],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });
  assertEquals(inv.counts.unaccounted, 0);
});

Deno.test("invariant: an excluded non-work-order subject is accounted", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{ post_id: "p3", subject: "Photo Evidence - MLB-25096 - Balcatta", from_email: "jobs@mlbuilders.com.au" }],
    drafts: [],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });
  assertEquals(inv.counts.unaccounted, 0);
});

Deno.test("invariant: a non-make-safe email from an unknown sender is accounted (not a candidate)", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{ post_id: "p4", subject: "Weekly newsletter", from_email: "news@randomvendor.com" }],
    drafts: [],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });
  assertEquals(inv.counts.unaccounted, 0);
});

Deno.test("invariant: a real WO from a known sender with NO draft and NO job is UNACCOUNTED", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{ post_id: "p5", subject: "NEW WORK ORDER - MLB-99999 12 Some St", from_email: "jobs@mlbuilders.com.au" }],
    drafts: [],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });
  assertEquals(inv.counts.unaccounted, 1);
  assertEquals(inv.live_and_true, false);
  assertEquals(inv.unaccounted[0].post_id, "p5");
  assertEquals(inv.unaccounted[0].reason, "make_safe_candidate_no_draft_no_job");
});

Deno.test("invariant: a known-sender WO whose ref is already a live job is accounted", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{ post_id: "p6", subject: "NEW WORK ORDER - MLB-25096 7 Broughton St", from_email: "jobs@mlbuilders.com.au" }],
    drafts: [],
    jobs: [{ external_ref: "MLB-25096" }],
    senderPatterns: SENDER_PATTERNS,
  });
  assertEquals(inv.counts.unaccounted, 0);
  assert(inv.live_and_true);
});

Deno.test("invariant: a pure ack with no attachment is accounted", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{ post_id: "p7", subject: "Our Ref: MLB-25795 - thanks", from_email: "jobs@mlbuilders.com.au", has_attachments: false }],
    drafts: [],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });
  assertEquals(inv.counts.unaccounted, 0);
});
