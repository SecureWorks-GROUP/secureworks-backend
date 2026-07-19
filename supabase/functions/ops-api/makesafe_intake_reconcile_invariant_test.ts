import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { summarizeIntakeReconcileInvariant } from "./makesafe_intake_reconciliation.ts";

// MLB sends from mlbuilders.com.au; the sender pattern is the bare domain.
const SENDER_PATTERNS = ["mlbuilders.com.au"];

Deno.test("invariant: an email with a linked draft is accounted", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "p1",
      subject: "NEW WORK ORDER - MLB-25096",
      from_email: "jobs@mlbuilders.com.au",
    }],
    drafts: [{ graph_message_id: "p1", status: "needs_review" }],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });
  assertEquals(inv.counts.unaccounted, 0);
  assertEquals(inv.items[0].classification, "matched");
  assertEquals(inv.items[0].reason, "source_post_id_matches_draft");
  assert(inv.live_and_true);
});

Deno.test("invariant: our own outbound copy is accounted, not flagged", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "p2",
      subject: "Make Safe Report and Invoice - MLB-25096",
      from_email: "invoices@secureworksgroup.app",
    }],
    drafts: [],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });
  assertEquals(inv.counts.unaccounted, 0);
});

Deno.test("invariant: an excluded non-work-order subject is accounted", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "p3",
      subject: "Photo Evidence - MLB-25096 - Balcatta",
      from_email: "jobs@mlbuilders.com.au",
    }],
    drafts: [],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });
  assertEquals(inv.counts.unaccounted, 0);
});

Deno.test("invariant: a non-make-safe email from an unknown sender is accounted (not a candidate)", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "p4",
      subject: "Weekly newsletter",
      from_email: "news@randomvendor.com",
    }],
    drafts: [],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });
  assertEquals(inv.counts.unaccounted, 0);
});

Deno.test("invariant: a real WO from a known sender with NO draft and NO job is UNACCOUNTED", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "p5",
      subject: "NEW WORK ORDER - MLB-99999 12 Some St",
      from_email: "jobs@mlbuilders.com.au",
    }],
    drafts: [],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });
  assertEquals(inv.counts.unaccounted, 1);
  assertEquals(inv.live_and_true, false);
  assertEquals(inv.unaccounted[0].post_id, "p5");
  assertEquals(inv.unaccounted[0].classification, "genuinely_unaccounted");
  assertEquals(inv.unaccounted[0].evidence, {
    kind: "classification",
    id: "no_durable_capture_evidence",
  });
  assertEquals(
    inv.unaccounted[0].reason,
    "make_safe_candidate_no_draft_no_job",
  );
});

Deno.test("invariant: a known-sender WO whose ref is already a live job is accounted", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "p6",
      subject: "NEW WORK ORDER - MLB-25096 7 Broughton St",
      from_email: "jobs@mlbuilders.com.au",
    }],
    drafts: [],
    jobs: [{ external_ref: "MLB-25096" }],
    senderPatterns: SENDER_PATTERNS,
  });
  assertEquals(inv.counts.unaccounted, 0);
  assertEquals(inv.counts.accounted_alias_revision, 1);
  assertEquals(inv.items[0].classification, "accounted_alias_revision");
  assertEquals(
    inv.items[0].reason,
    "resend_or_revision_matches_live_job_identity",
  );
  assert(inv.live_and_true);
});

Deno.test("invariant: a pure ack with no attachment is accounted", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "p7",
      subject: "Our Ref: MLB-25795 - thanks",
      from_email: "jobs@mlbuilders.com.au",
      has_attachments: false,
    }],
    drafts: [],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });
  assertEquals(inv.counts.unaccounted, 0);
});

Deno.test("invariant regression: z2 twin Graph post ids account against one durable draft", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [
      {
        post_id: "mailbox_sanitized_26567",
        subject: "Our Ref: MLB-26567 - Make Safe",
        from_email: "jobs@mlbuilders.com.au",
        received_at: "2026-07-17T03:20:59.000Z",
        body_preview: "Please attend the insured property. Claim MLB-26567.",
      },
      {
        post_id: "AAMk-sanitized-26567",
        subject: "Our Ref: MLB-26567 - Make Safe",
        from_email: "jobs@mlbuilders.com.au",
        received_at: "2026-07-17T03:21:00.000Z",
        body_preview: "Please attend the insured property. Claim MLB-26567.",
      },
    ],
    drafts: [{
      id: "draft-26567",
      graph_message_id: "AAMk-sanitized-26567",
      external_ref: "MLB-26567",
      subject: "Our Ref: MLB-26567 - Make Safe",
      from_email: "jobs@mlbuilders.com.au",
      body_preview: "Please attend the insured property. Claim MLB-26567.",
      received_at: "2026-07-17T03:21:00.000Z",
      status: "approved",
    }],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });

  assertEquals(inv.counts.unaccounted, 0);
  assertEquals(inv.items.length, 2);
  assertEquals(inv.items.map((item) => item.classification), [
    "accounted_alias_revision",
    "matched",
  ]);
  assertEquals(inv.items[0].reason, "twin_graph_post_content_fingerprint");
  assertEquals(inv.items[0].evidence, { kind: "draft", id: "draft-26567" });
});

Deno.test("invariant regression: z2 claim-only source matches a PO-suffixed captured reference", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "mailbox-sanitized-24659",
      subject: "Our Ref: MLB-24659 - Rapid Repair",
      from_email: "jobs@mlbuilders.com.au",
    }],
    drafts: [],
    jobs: [{ job_id: "job-24659", external_ref: "MLB-24659PO-56155" }],
    senderPatterns: SENDER_PATTERNS,
  });

  assertEquals(inv.counts.unaccounted, 0);
  assertEquals(inv.items[0].classification, "accounted_alias_revision");
  assertEquals(inv.items[0].reason, "claim_reference_alias_of_po_captured_job");
  assertEquals(inv.items[0].raw_reference, "MLB-24659");
  assertEquals(inv.items[0].canonical_claim_ref, "MLB24659");
  assertEquals(inv.items[0].canonical_po_ref, null);
  assertEquals(inv.items[0].evidence, { kind: "job", id: "job-24659" });
});

Deno.test("invariant regression: z2 PO-variant source aliases a captured draft without erasing either representation", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "mailbox-sanitized-26678",
      subject: "NEW WORK ORDER MLB-26678",
      from_email: "jobs@mlbuilders.com.au",
    }],
    drafts: [{
      id: "draft-26678-po55291",
      graph_message_id: "AAMk-sanitized-26678",
      external_ref: "MLB-26678PO-55291",
      status: "needs_review",
    }],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });

  assertEquals(inv.counts.unaccounted, 0);
  assertEquals(
    inv.items[0].reason,
    "claim_reference_alias_of_po_captured_draft",
  );
  assertEquals(inv.items[0].raw_reference, "MLB-26678");
  assertEquals(inv.items[0].evidence, {
    kind: "draft",
    id: "draft-26678-po55291",
  });
});

Deno.test("invariant hostile near-collision: explicit new PO does not collapse into a legacy claim-only job", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "mailbox-sanitized-24404-po55601",
      subject: "NEW WORK ORDER MLB-24404 PO-55601",
      from_email: "jobs@mlbuilders.com.au",
    }],
    drafts: [],
    jobs: [{ job_id: "legacy-job-24404", external_ref: "MLB-24404" }],
    senderPatterns: SENDER_PATTERNS,
  });

  assertEquals(inv.counts.unaccounted, 1);
  assertEquals(inv.items[0].classification, "genuinely_unaccounted");
  assertEquals(inv.items[0].canonical_po_ref, "PO-55601");
});

Deno.test("invariant hostile near-collision: distinct PO deliverables sharing a claim stay separate", () => {
  const commonBody =
    "Attend the same property. Scope wording intentionally identical.";
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "mailbox-sanitized-27037-po2",
      subject: "NEW WORK ORDER MLB-27037 PO-56397",
      from_email: "jobs@mlbuilders.com.au",
      body_preview: commonBody,
      received_at: "2026-07-16T02:00:30.000Z",
    }],
    drafts: [{
      id: "draft-27037-po1",
      graph_message_id: "AAMk-sanitized-27037-po1",
      external_ref: "MLB-27037PO-56395",
      subject: "NEW WORK ORDER MLB-27037 PO-56395",
      from_email: "jobs@mlbuilders.com.au",
      body_preview: commonBody,
      received_at: "2026-07-16T02:00:31.000Z",
      status: "approved",
    }],
    jobs: [{ job_id: "job-27037-po1", external_ref: "MLB-27037PO-56395" }],
    senderPatterns: SENDER_PATTERNS,
  });

  assertEquals(inv.counts.unaccounted, 1);
  assertEquals(inv.unaccounted[0].post_id, "mailbox-sanitized-27037-po2");
  assertEquals(inv.unaccounted[0].classification, "genuinely_unaccounted");
  assertEquals(
    inv.unaccounted[0].reason,
    "distinct_claim_po_has_no_draft_or_job",
  );
  assertEquals(inv.unaccounted[0].canonical_po_ref, "PO-56397");
});

Deno.test("invariant: bare 'Job No <NNNNN>' archetype is accounted by a live job", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "mailbox-sanitized-jobno-68592",
      subject: "Make Safe - Balga - Job No 68592",
      from_email: "workorders@ajs.build",
    }],
    drafts: [],
    jobs: [{ job_id: "job-68592", external_ref: "68592" }],
    senderPatterns: ["ajs.build"],
  });

  assertEquals(inv.counts.unaccounted, 0);
  assertEquals(inv.items[0].classification, "accounted_alias_revision");
  assertEquals(inv.items[0].evidence, { kind: "job", id: "job-68592" });
  assertEquals(inv.items[0].raw_reference, "Job No 68592");
});

Deno.test("invariant: known ref outside the builder claim vocabulary is accounted by a draft", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "mailbox-sanitized-srj-41288",
      subject: "NEW WORK ORDER SRJ-41288 - Mirrabooka",
      from_email: "jobs@mlbuilders.com.au",
    }],
    drafts: [{
      id: "draft-srj-41288",
      graph_message_id: "AAMk-sanitized-srj-41288",
      external_ref: "SRJ-41288",
      subject: "NEW WORK ORDER SRJ-41288 - Mirrabooka",
      from_email: "jobs@mlbuilders.com.au",
      status: "approved",
    }],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });

  assertEquals(inv.counts.unaccounted, 0);
  assertEquals(inv.items[0].classification, "accounted_alias_revision");
  assertEquals(inv.items[0].evidence, { kind: "draft", id: "draft-srj-41288" });
  assertEquals(inv.items[0].canonical_claim_ref, null);
});

Deno.test("invariant hostile near-collision: neighbouring non-prefix refs stay separate", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "mailbox-sanitized-srj-41289",
      subject: "NEW WORK ORDER SRJ-41289 - Mirrabooka",
      from_email: "jobs@mlbuilders.com.au",
    }],
    drafts: [],
    jobs: [{ job_id: "job-srj-41288", external_ref: "SRJ-41288" }],
    senderPatterns: SENDER_PATTERNS,
  });

  assertEquals(inv.counts.unaccounted, 1);
  assertEquals(inv.items[0].classification, "genuinely_unaccounted");
});

Deno.test("invariant hostile near-collision: distinct job numbers are never collapsed", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "mailbox-sanitized-jobno-68593",
      subject: "Make Safe - Balga - Job No 68593",
      from_email: "workorders@ajs.build",
    }],
    drafts: [],
    jobs: [{ job_id: "job-68592", external_ref: "68592" }],
    senderPatterns: ["ajs.build"],
  });

  assertEquals(inv.counts.unaccounted, 1);
  assertEquals(inv.items[0].classification, "genuinely_unaccounted");
});

Deno.test("invariant hostile near-collision: non-prefix ref with an explicit new PO stays visible", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "mailbox-sanitized-srj-41288-po",
      subject: "NEW WORK ORDER SRJ-41288 PO 55601 - Mirrabooka",
      from_email: "jobs@mlbuilders.com.au",
    }],
    drafts: [],
    jobs: [{ job_id: "job-srj-41288", external_ref: "SRJ-41288" }],
    senderPatterns: SENDER_PATTERNS,
  });

  assertEquals(inv.counts.unaccounted, 1);
  assertEquals(inv.items[0].classification, "genuinely_unaccounted");
  assertEquals(inv.items[0].canonical_po_ref, "PO-55601");
});

Deno.test("invariant hostile near-collision: shared suburb postcode is not a work identity", () => {
  const inv = summarizeIntakeReconcileInvariant({
    emails: [{
      post_id: "mailbox-sanitized-postcode-b",
      subject: "Make Safe - 88 Jones Rd, Balcatta WA 6021",
      from_email: "jobs@mlbuilders.com.au",
    }],
    drafts: [{
      id: "draft-postcode-a",
      graph_message_id: "AAMk-sanitized-postcode-a",
      subject: "Make Safe - 12 Smith St, Balcatta WA 6021",
      from_email: "jobs@mlbuilders.com.au",
      status: "approved",
    }],
    jobs: [],
    senderPatterns: SENDER_PATTERNS,
  });

  assertEquals(inv.counts.unaccounted, 1);
  assertEquals(inv.items[0].classification, "genuinely_unaccounted");
});
