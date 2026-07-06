// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE CROSS-PATH DEDUP TESTS
// Mission: fix/makesafe-intake-bugs (BUG 1)
// ════════════════════════════════════════════════════════════
//
// Pure-Deno, no network. Proves that a SECOND scan of an email that already has a
// draft (from EITHER the old user-mailbox path or the new group-sync path) is a
// no-op — even when the graph_message_id differs (the BICTON 67998 case).
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/makesafe_intake_dedup_test.ts

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildIntakeDedupIndex,
  interleaveOldestNewestForFairScan,
  isDuplicateIntake,
  normaliseCompany,
  normaliseRef,
  refCompanyKey,
  registerIntakeDraft,
  SUPPRESSED_DRAFT_STATES,
  workOrderCompanyKey,
} from "./makesafe_intake_dedup.ts";

// ── Real-shaped rows from the live BICTON 67998 duplicate (2026-06-16) ────────────
// Row A came via the OLD path (has an internet_message_id); Row B via the NEW
// group-sync path (internet_message_id = null). DIFFERENT graph_message_id, SAME
// external_ref + company.
const BICTON_OLD = {
  graph_message_id: "AAMkADE1Zjk0...AAITobseAAA=", // old-path id
  internet_message_id:
    "<MEAPR01MB3749907984E1BEE00EC0B162A7E52@MEAPR01MB3749.ausprd01.prod.outlook.com>",
  external_ref: "AJBR 67998",
  requesting_company_slug: "aj",
  requesting_company_name: "AJ Building & Restoration",
  status: "draft",
};

// The NEW group-sync candidate for the SAME email: different graph id, null internet id.
const BICTON_NEW_CANDIDATE = {
  graph_message_id: "AAMkADA3OWRl...AAASAhAKAAA=", // new-path id (different!)
  internet_message_id: null,
  external_ref: "AJBR 67998",
  requesting_company_slug: "aj",
  requesting_company_name: "AJ Building & Restoration",
};

Deno.test("normaliseRef: collapses spacing/dashes/case", () => {
  assertEquals(normaliseRef("AJBR 67998"), "AJBR67998");
  assertEquals(normaliseRef("ajbr-67998"), "AJBR67998");
  assertEquals(normaliseRef(" AJBR/67998 "), "AJBR67998");
  assertEquals(normaliseRef("MLB-25096"), "MLB25096");
  assertEquals(normaliseRef(null), "");
  assertEquals(normaliseRef(undefined), "");
});

Deno.test("normaliseCompany: prefers slug, falls back to name", () => {
  assertEquals(normaliseCompany("aj", "AJ Building & Restoration"), "aj");
  assertEquals(
    normaliseCompany(null, "AJ Building & Restoration"),
    "ajbuildingrestoration",
  );
  assertEquals(normaliseCompany("", "ML Builders"), "mlbuilders");
  assertEquals(normaliseCompany(null, null), "");
});

Deno.test("refCompanyKey: empty ref yields empty key (never matches)", () => {
  assertEquals(refCompanyKey(null, "aj", null), "");
  assertEquals(refCompanyKey("", "aj", null), "");
  assertEquals(refCompanyKey("AJBR 67998", "aj", null), "AJBR67998|aj");
});

Deno.test("refCompanyKey: ref WITHOUT a known company yields empty key (no cross-builder collide)", () => {
  // A bare ref with no company must NOT build a collidable key, or two unknown-company
  // emails sharing a ref from DIFFERENT builders would wrongly dedup against each other.
  assertEquals(refCompanyKey("AJBR 67998", null, null), "");
  assertEquals(refCompanyKey("AJBR 67998", "", ""), "");
});

Deno.test("SCAN FAIRNESS: bounded scans sample oldest and newest candidates", () => {
  const newestFirst = ["newest", "newer", "middle", "older", "oldest"];
  assertEquals(interleaveOldestNewestForFairScan(newestFirst), [
    "oldest",
    "newest",
    "older",
    "newer",
    "middle",
  ]);
  assertEquals(
    interleaveOldestNewestForFairScan(newestFirst).slice(0, 4),
    ["oldest", "newest", "older", "newer"],
    "a cap of four must include both oldest backlog and fresh mail",
  );
});

Deno.test("BUG-1 SAFETY: two unknown-company candidates with the SAME ref do NOT collide", () => {
  // First unknown-company draft on ref AJBR 67998.
  const index = buildIntakeDedupIndex([
    {
      graph_message_id: "g1",
      external_ref: "AJBR 67998",
      requesting_company_slug: null,
      requesting_company_name: null,
      status: "draft",
    },
  ]);
  // A DIFFERENT email, no company, same ref -> must NOT be treated as a duplicate
  // (we cannot prove it is the same builder, so prefer a reviewable draft).
  const reason = isDuplicateIntake(
    {
      graph_message_id: "g2",
      external_ref: "AJBR 67998",
      requesting_company_slug: null,
      requesting_company_name: null,
    },
    index,
  );
  assertEquals(reason, null);
});

// ── THE CORE BUG 1 ASSERTION ──────────────────────────────────────────────────
Deno.test("BUG 1: a NEW group-sync candidate for an OLD-path draft is a DUPLICATE (cross-path)", () => {
  const index = buildIntakeDedupIndex([BICTON_OLD]);
  // graph id differs, internet id is null -> the only thing that catches it is
  // (normalised ref + company). It MUST be recognised as a duplicate.
  const reason = isDuplicateIntake(BICTON_NEW_CANDIDATE, index);
  assertEquals(
    reason,
    "external_ref+company",
    "cross-path dup must be caught on ref+company",
  );
});

Deno.test("JOB-FAMILY: same MLB ref/company but different family is NOT a duplicate", () => {
  const index = buildIntakeDedupIndex([{
    ...BICTON_OLD,
    external_ref: "MLB-25911",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    makesafe_job_family: "assessment_report_quote",
  }]);

  const reason = isDuplicateIntake({
    graph_message_id: "new-temp-fence-id",
    external_ref: "MLB-25911",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    makesafe_job_family: "temp_fence_makesafe",
  }, index);

  assertEquals(
    reason,
    null,
    "assessment/quote and temp-fence MakeSafe under one MLB ref must both surface",
  );
});

Deno.test("JOB-FAMILY: same MLB ref/company and same family is still a duplicate", () => {
  const index = buildIntakeDedupIndex([{
    ...BICTON_OLD,
    external_ref: "MLB-25911",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    makesafe_job_family: "assessment_report_quote",
  }]);

  const reason = isDuplicateIntake({
    graph_message_id: "new-assessment-copy-id",
    external_ref: "MLB-25911",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    makesafe_job_family: "assessment_report_quote",
  }, index);

  assertEquals(
    reason,
    "external_ref+company",
    "same-family resend must remain deduped",
  );
});

Deno.test("WORK-ORDER IDENTITY: same MLB claim/family but different PO is NOT a duplicate", () => {
  const index = buildIntakeDedupIndex([{
    ...BICTON_OLD,
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    makesafe_job_family: "general_makesafe",
    builder_work_order_number: "MLB-25096PO-53582",
    builder_po_number: "PO-53582",
  }]);

  const reason = isDuplicateIntake({
    graph_message_id: "morley-new-wo",
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    makesafe_job_family: "general_makesafe",
    builder_work_order_number: "MLB-25096PO-53583",
    builder_po_number: "PO-53583",
  }, index);

  assertEquals(
    reason,
    null,
    "a new MLB PO/work-order under the same claim must surface as a new intake",
  );
});

Deno.test("WORK-ORDER IDENTITY: same MLB claim/family and same PO is a duplicate", () => {
  const index = buildIntakeDedupIndex([{
    ...BICTON_OLD,
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    makesafe_job_family: "general_makesafe",
    builder_work_order_number: "MLB-25096PO-53582",
    builder_po_number: "PO-53582",
  }]);

  const reason = isDuplicateIntake({
    graph_message_id: "morley-same-wo-rescan",
    external_ref: "MLB 25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    makesafe_job_family: "general_makesafe",
    builder_work_order_number: "MLB 25096 PO 53582",
    builder_po_number: "53582",
  }, index);

  assertEquals(reason, "builder_work_order_identity");
});

Deno.test("WORK-ORDER IDENTITY: same claim/family against legacy no-identity row routes to review", () => {
  const index = buildIntakeDedupIndex([{
    ...BICTON_OLD,
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    makesafe_job_family: "general_makesafe",
  }]);

  const reason = isDuplicateIntake({
    graph_message_id: "morley-legacy-comparison",
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    makesafe_job_family: "general_makesafe",
    builder_work_order_number: "MLB-25096PO-53582",
    builder_po_number: "PO-53582",
  }, index);

  assertEquals(reason, "work_order_identity_needs_review");
});

Deno.test("WORK-ORDER IDENTITY: different draft PO still allows same live-job PO to block", () => {
  const index = buildIntakeDedupIndex(
    [{
      ...BICTON_OLD,
      external_ref: "MLB-25096",
      requesting_company_slug: "mlb",
      requesting_company_name: "ML Builders",
      makesafe_job_family: "general_makesafe",
      builder_work_order_number: "MLB-25096PO-53582",
      builder_po_number: "PO-53582",
    }],
    [{
      external_ref: "MLB-25096",
      requesting_company_slug: "mlb",
      makesafe_job_family: "general_makesafe",
      builder_work_order_number: "MLB-25096PO-53583",
      builder_po_number: "PO-53583",
    }],
  );

  const reason = isDuplicateIntake({
    graph_message_id: "morley-same-as-live-job",
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    makesafe_job_family: "general_makesafe",
    builder_work_order_number: "MLB-25096PO-53583",
    builder_po_number: "PO-53583",
  }, index);

  assertEquals(reason, "job_external_ref");
});

Deno.test("WORK-ORDER IDENTITY: job-only full WO ref without metadata still blocks same PO", () => {
  const index = buildIntakeDedupIndex([], [{
    external_ref: "MLB-25096PO-53582",
    requesting_company_slug: "mlb",
    makesafe_job_family: "general_makesafe",
  }]);

  const reason = isDuplicateIntake({
    graph_message_id: "morley-same-as-full-ref-job",
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    makesafe_job_family: "general_makesafe",
    builder_work_order_number: "MLB-25096PO-53582",
    builder_po_number: "PO-53582",
  }, index);

  assertEquals(reason, "job_external_ref");
});

Deno.test("WORK-ORDER IDENTITY: normalises work-order and PO with company", () => {
  assertEquals(
    workOrderCompanyKey("MLB 25096 PO 53582", "53582", "mlb", "ML Builders"),
    "MLB25096PO53582|53582|mlb",
  );
});

Deno.test("JOB-FAMILY: legacy unknown-family draft routes known-family candidate to review", () => {
  const index = buildIntakeDedupIndex([{
    graph_message_id: "old-path",
    external_ref: "MLB-26001",
    requesting_company_slug: "mlb",
    status: "draft",
    makesafe_job_family: null,
  }]);

  assertEquals(
    isDuplicateIntake({
      graph_message_id: "new-path",
      external_ref: "MLB 26001",
      requesting_company_slug: "mlb",
      makesafe_job_family: "roof_report",
    }, index),
    "unknown_family_needs_review",
  );
});

Deno.test("JOB-FAMILY: existing live job on same ref only blocks matching family", () => {
  const index = buildIntakeDedupIndex([], [
    {
      external_ref: "MLB-25911",
      requesting_company_slug: "mlb",
      makesafe_job_family: "assessment_report_quote",
    },
  ]);

  const tempFenceReason = isDuplicateIntake({
    external_ref: "MLB-25911",
    requesting_company_slug: "mlb",
    makesafe_job_family: "temp_fence_makesafe",
  }, index);
  assertEquals(
    tempFenceReason,
    null,
    "later temp-fence WO must not be hidden by assessment live job",
  );

  const assessmentReason = isDuplicateIntake({
    external_ref: "MLB-25911",
    requesting_company_slug: "mlb",
    makesafe_job_family: "assessment_report_quote",
  }, index);
  assertEquals(
    assessmentReason,
    "job_external_ref",
    "same-family job must still dedupe",
  );
});

Deno.test("JOB-FAMILY: legacy unknown-family job routes known-family candidate to review", () => {
  const index = buildIntakeDedupIndex([], [{
    external_ref: "MLB-26002",
    requesting_company_slug: "mlb",
    makesafe_job_family: null,
  }]);

  assertEquals(
    isDuplicateIntake({
      external_ref: "MLB 26002",
      requesting_company_slug: "mlb",
      makesafe_job_family: "temp_fence_makesafe",
    }, index),
    "job_unknown_family_needs_review",
  );
});

Deno.test("graph_message_id exact match is caught first (within-path)", () => {
  const index = buildIntakeDedupIndex([BICTON_OLD]);
  const reason = isDuplicateIntake(
    { graph_message_id: BICTON_OLD.graph_message_id },
    index,
  );
  assertEquals(reason, "graph_message_id");
});

Deno.test("internet_message_id exact match is caught (old<->old)", () => {
  const index = buildIntakeDedupIndex([BICTON_OLD]);
  const reason = isDuplicateIntake(
    {
      graph_message_id: "totally-different",
      internet_message_id: BICTON_OLD.internet_message_id,
    },
    index,
  );
  assertEquals(reason, "internet_message_id");
});

Deno.test("an existing JOB on the same ref makes the candidate a duplicate", () => {
  const index = buildIntakeDedupIndex([], [{
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
  }]);
  const reason = isDuplicateIntake({
    external_ref: "MLB 25096",
    requesting_company_slug: "mlb",
  }, index);
  assertEquals(reason, "job_external_ref");
});

Deno.test("JOB-COMPANY: same ref/family but different live-job company does NOT suppress", () => {
  const index = buildIntakeDedupIndex([], [{
    external_ref: "25096",
    requesting_company_slug: "mlb",
    makesafe_job_family: "general_makesafe",
  }]);
  const reason = isDuplicateIntake({
    external_ref: "25096",
    requesting_company_slug: "aj",
    makesafe_job_family: "general_makesafe",
  }, index);
  assertEquals(reason, null);
});

Deno.test("a genuinely NEW email (new ref, new ids) is NOT a duplicate", () => {
  const index = buildIntakeDedupIndex([BICTON_OLD]);
  const reason = isDuplicateIntake(
    {
      graph_message_id: "brand-new-id",
      internet_message_id: null,
      external_ref: "AJBR 70011",
      requesting_company_slug: "aj",
      requesting_company_name: "AJ Building & Restoration",
    },
    index,
  );
  assertEquals(reason, null);
});

Deno.test("same ref but DIFFERENT company is NOT a duplicate (no false collide)", () => {
  const index = buildIntakeDedupIndex([BICTON_OLD]);
  const reason = isDuplicateIntake(
    {
      external_ref: "AJBR 67998",
      requesting_company_slug: "mlb",
      requesting_company_name: "ML Builders",
    },
    index,
  );
  assertEquals(reason, null);
});

Deno.test("a candidate with NO usable key is NOT treated as a duplicate", () => {
  const index = buildIntakeDedupIndex([BICTON_OLD]);
  const reason = isDuplicateIntake({
    graph_message_id: null,
    internet_message_id: null,
    external_ref: null,
  }, index);
  assertEquals(reason, null);
});

// ── Idempotency: a SECOND scan of an already-drafted email is a NO-OP ──────────
Deno.test("BUG 1: second scan of an already-drafted email creates NO new draft (idempotent)", () => {
  // First scan: BICTON had no draft yet -> not a duplicate -> a draft is created.
  const index = buildIntakeDedupIndex([]); // empty store
  const firstReason = isDuplicateIntake(BICTON_NEW_CANDIDATE, index);
  assertEquals(firstReason, null, "first scan should create the draft");
  // Simulate the insert registering in the index.
  registerIntakeDraft(BICTON_NEW_CANDIDATE, index);

  // Second scan of the SAME email (group-sync candidate again): now a duplicate.
  const secondReason = isDuplicateIntake(BICTON_NEW_CANDIDATE, index);
  assert(
    secondReason !== null,
    "second scan of the same email must be a no-op (duplicate)",
  );

  // And the OLD-path variant of the same email (different graph id) is ALSO caught.
  const oldVariantReason = isDuplicateIntake(
    {
      graph_message_id: BICTON_OLD.graph_message_id,
      internet_message_id: BICTON_OLD.internet_message_id,
      external_ref: BICTON_OLD.external_ref,
      requesting_company_slug: BICTON_OLD.requesting_company_slug,
      requesting_company_name: BICTON_OLD.requesting_company_name,
    },
    index,
  );
  assert(
    oldVariantReason !== null,
    "the old-path variant of an already-drafted email must also be a no-op",
  );
});

Deno.test("two copies of the same email WITHIN one batch: first creates, second is a no-op", () => {
  const index = buildIntakeDedupIndex([]);
  // Copy 1
  assertEquals(isDuplicateIntake(BICTON_NEW_CANDIDATE, index), null);
  registerIntakeDraft(BICTON_NEW_CANDIDATE, index);
  // Copy 2 in the SAME batch (e.g. the email appeared twice in the candidate window)
  const dup = isDuplicateIntake(
    {
      graph_message_id: "yet-another-id",
      internet_message_id: null,
      ...{
        external_ref: BICTON_NEW_CANDIDATE.external_ref,
        requesting_company_slug: BICTON_NEW_CANDIDATE.requesting_company_slug,
        requesting_company_name: BICTON_NEW_CANDIDATE.requesting_company_name,
      },
    },
    index,
  );
  assertEquals(dup, "external_ref+company");
});

// ── F1 + Codex F3: suppressed_rejected scan-guard (mission makesafe-wo-capture-recovery-2026-06-17) ──
// These tests prove:
//   1. A re-scan of an already-rejected email (same/older received_at) -> suppressed_rejected.
//   2. A NEWER email for the same ref+company (corrected resend) -> NOT suppressed (fresh draft).
//   3. force_recapture=true bypasses suppressed_rejected.
//   4. force_recapture still CANNOT duplicate a LIVE draft.
//   5. A genuinely-new WO (no rejected match) is NOT affected.
//   6. SUPPRESSED_DRAFT_STATES exports the correct values.
//   7. Candidate with no received_at against a rejected key -> NOT suppressed (fail-open).

const BALCATTA_REJECTED = {
  graph_message_id: "AAMkADA3_old_user_mailbox_id==",
  internet_message_id: "<primeecoemail...mlb.mailer@primeeco.tech>",
  external_ref: "MLB-25096",
  requesting_company_slug: "mlb",
  requesting_company_name: "ML Builders",
  status: "rejected",
  received_at: "2026-06-16T12:48:00.000Z",
};

Deno.test("SUPPRESSED_DRAFT_STATES includes rejected and superseded", () => {
  assert(
    SUPPRESSED_DRAFT_STATES.includes("rejected"),
    "rejected must be in SUPPRESSED_DRAFT_STATES",
  );
  assert(
    SUPPRESSED_DRAFT_STATES.includes("superseded"),
    "superseded must be in SUPPRESSED_DRAFT_STATES",
  );
});

Deno.test("F3/Codex F3: re-scan of already-rejected email (same received_at) -> suppressed_rejected", () => {
  // Normal scan: live drafts empty, rejected draft with a known received_at.
  const index = buildIntakeDedupIndex(
    [], // no live drafts
    [], // no jobs
    [BALCATTA_REJECTED], // rejected draft with received_at
  );
  const candidate = {
    graph_message_id: "AAMkADA3_new_group_sync_id==", // different path id
    internet_message_id: null,
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    received_at: "2026-06-16T12:48:00.000Z", // SAME received_at as rejected
  };
  const reason = isDuplicateIntake(candidate, index);
  assertEquals(
    reason,
    "suppressed_rejected",
    "re-scan of same email must be suppressed",
  );
});

Deno.test("F3/Codex F3: older email than rejected draft -> suppressed_rejected", () => {
  const index = buildIntakeDedupIndex([], [], [BALCATTA_REJECTED]);
  const candidate = {
    graph_message_id: "older-id==",
    internet_message_id: null,
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    received_at: "2026-06-15T08:00:00.000Z", // OLDER than the rejected one
  };
  const reason = isDuplicateIntake(candidate, index);
  assertEquals(
    reason,
    "suppressed_rejected",
    "older email than rejected draft must be suppressed",
  );
});

Deno.test("F3/Codex F3: NEWER email (corrected resend) with same ref+company -> NOT suppressed", () => {
  // Builder re-sends a corrected WO for the same ref AFTER the first was rejected.
  // The new email has a LATER received_at — must create a fresh draft.
  const index = buildIntakeDedupIndex([], [], [BALCATTA_REJECTED]);
  const candidate = {
    graph_message_id: "corrected-resend-group-id==",
    internet_message_id: null,
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    received_at: "2026-06-17T09:30:00.000Z", // NEWER than the rejected one
  };
  const reason = isDuplicateIntake(candidate, index);
  assertEquals(
    reason,
    null,
    "corrected resend (newer received_at) must NOT be suppressed",
  );
});

Deno.test("F3/Codex F3: candidate with NO received_at against rejected key -> NOT suppressed (fail-open)", () => {
  // A candidate with unknown received_at could be a real corrected WO.
  // Fail-open: let it through to create a reviewable draft rather than silently drop.
  const index = buildIntakeDedupIndex([], [], [BALCATTA_REJECTED]);
  const candidate = {
    graph_message_id: "unknown-date-id==",
    internet_message_id: null,
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    // received_at: absent (undefined)
  };
  const reason = isDuplicateIntake(candidate, index);
  assertEquals(
    reason,
    null,
    "candidate with no received_at must NOT be suppressed (fail-open)",
  );
});

Deno.test("F1: rejected draft with no received_at -> rejected key stored with empty string -> suppresses ONLY candidate with older/equal received_at (or same fail-open)", () => {
  // When the rejected row itself has no received_at, key is stored with "".
  // A candidate with received_at="" (or absent) -> fail-open (won't be <= "").
  const rejectedNoTs = {
    ...BALCATTA_REJECTED,
    received_at: null,
  };
  const index = buildIntakeDedupIndex([], [], [rejectedNoTs]);
  // Candidate with a real received_at that is later than "" (i.e. any non-empty string)
  // The stored value is "" (empty), candidate.received_at="2026-06-16T..." > "" in lexical compare.
  // So NOT suppressed.
  const candidateWithTs = {
    graph_message_id: "id-with-ts==",
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    received_at: "2026-06-16T12:48:00.000Z",
  };
  const reason = isDuplicateIntake(candidateWithTs, index);
  assertEquals(
    reason,
    null,
    "when rejected row has no received_at (stored as ''), a real received_at candidate is NOT suppressed",
  );
});

Deno.test("F1: force_recapture=true bypasses suppressed_rejected regardless of received_at", () => {
  const index = buildIntakeDedupIndex([], [], [BALCATTA_REJECTED]);
  const candidate = {
    graph_message_id: "AAMkADA3_new_group_sync_id==",
    internet_message_id: null,
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    received_at: "2026-06-16T12:48:00.000Z", // same date but force_recapture overrides
    force_recapture: true,
  };
  const reason = isDuplicateIntake(candidate, index);
  assertEquals(
    reason,
    null,
    "force_recapture must bypass suppressed_rejected and allow creation",
  );
});

Deno.test("F1: force_recapture still blocked by a LIVE refCompany match (cannot duplicate LIVE)", () => {
  const liveDraft = {
    graph_message_id: "AAMkADA3_live_group_sync_id==",
    internet_message_id: null,
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    status: "needs_review",
  };
  const index = buildIntakeDedupIndex(
    [liveDraft], // a LIVE draft already exists
    [],
    [BALCATTA_REJECTED], // also a rejected one
  );
  const candidate = {
    graph_message_id: "AAMkADA3_different_group_sync==",
    internet_message_id: null,
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    received_at: "2026-06-16T12:48:00.000Z",
    force_recapture: true, // tries to force, but LIVE draft blocks
  };
  const reason = isDuplicateIntake(candidate, index);
  assertEquals(
    reason,
    "external_ref+company",
    "force_recapture must NOT bypass a LIVE draft match",
  );
});

Deno.test("F1: a genuinely-new WO (no rejected match) is NOT affected by suppressed_rejected guard", () => {
  const index = buildIntakeDedupIndex([], [], [BALCATTA_REJECTED]);
  const candidate = {
    graph_message_id: "brand-new-id-for-different-job",
    internet_message_id: null,
    external_ref: "MLB-25900", // different ref — genuinely new
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    received_at: "2026-06-16T12:48:00.000Z",
  };
  const reason = isDuplicateIntake(candidate, index);
  assertEquals(
    reason,
    null,
    "genuinely-new WO must pass through regardless of rejected guard",
  );
});

Deno.test("F1: unknown-company rejected draft does NOT build a suppression key (no false positives)", () => {
  // A rejected draft with NO company must not suppress a future unrelated candidate.
  const rejectedNoCompany = {
    graph_message_id: "some-old-id==",
    external_ref: "MLB-99999",
    requesting_company_slug: null,
    requesting_company_name: null,
    status: "rejected",
    received_at: "2026-06-16T12:48:00.000Z",
  };
  const index = buildIntakeDedupIndex([], [], [rejectedNoCompany]);
  const candidate = {
    graph_message_id: "new-id-==",
    external_ref: "MLB-99999",
    requesting_company_slug: null,
    requesting_company_name: null,
    received_at: "2026-06-16T12:48:00.000Z",
  };
  // No company -> refCompanyKey returns "" -> no suppression key built -> not suppressed
  const reason = isDuplicateIntake(candidate, index);
  assertEquals(
    reason,
    null,
    "unknown-company rejected draft must NOT build a suppression key",
  );
});

Deno.test("F1: live-state behaviour unchanged — existing tests still hold with rejectedDrafts arg", () => {
  // Passing an empty rejectedDrafts must not change any existing dedup behaviour.
  const index = buildIntakeDedupIndex([BICTON_OLD], [], []);
  const reason = isDuplicateIntake(BICTON_NEW_CANDIDATE, index);
  assertEquals(
    reason,
    "external_ref+company",
    "cross-path dup must still be caught with empty rejectedDrafts",
  );
});
