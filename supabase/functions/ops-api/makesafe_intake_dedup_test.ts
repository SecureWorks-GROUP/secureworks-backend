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

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildIntakeDedupIndex,
  isDuplicateIntake,
  normaliseCompany,
  normaliseRef,
  refCompanyKey,
  registerIntakeDraft,
} from "./makesafe_intake_dedup.ts";

// ── Real-shaped rows from the live BICTON 67998 duplicate (2026-06-16) ────────────
// Row A came via the OLD path (has an internet_message_id); Row B via the NEW
// group-sync path (internet_message_id = null). DIFFERENT graph_message_id, SAME
// external_ref + company.
const BICTON_OLD = {
  graph_message_id:
    "AAMkADE1Zjk0...AAITobseAAA=", // old-path id
  internet_message_id: "<MEAPR01MB3749907984E1BEE00EC0B162A7E52@MEAPR01MB3749.ausprd01.prod.outlook.com>",
  external_ref: "AJBR 67998",
  requesting_company_slug: "aj",
  requesting_company_name: "AJ Building & Restoration",
  status: "draft",
};

// The NEW group-sync candidate for the SAME email: different graph id, null internet id.
const BICTON_NEW_CANDIDATE = {
  graph_message_id:
    "AAMkADA3OWRl...AAASAhAKAAA=", // new-path id (different!)
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
  assertEquals(normaliseCompany(null, "AJ Building & Restoration"), "ajbuildingrestoration");
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

Deno.test("BUG-1 SAFETY: two unknown-company candidates with the SAME ref do NOT collide", () => {
  // First unknown-company draft on ref AJBR 67998.
  const index = buildIntakeDedupIndex([
    { graph_message_id: "g1", external_ref: "AJBR 67998", requesting_company_slug: null, requesting_company_name: null, status: "draft" },
  ]);
  // A DIFFERENT email, no company, same ref -> must NOT be treated as a duplicate
  // (we cannot prove it is the same builder, so prefer a reviewable draft).
  const reason = isDuplicateIntake(
    { graph_message_id: "g2", external_ref: "AJBR 67998", requesting_company_slug: null, requesting_company_name: null },
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
  assertEquals(reason, "external_ref+company", "cross-path dup must be caught on ref+company");
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
    { graph_message_id: "totally-different", internet_message_id: BICTON_OLD.internet_message_id },
    index,
  );
  assertEquals(reason, "internet_message_id");
});

Deno.test("an existing JOB on the same ref makes the candidate a duplicate", () => {
  const index = buildIntakeDedupIndex([], ["MLB-25096"]);
  const reason = isDuplicateIntake({ external_ref: "MLB 25096", requesting_company_slug: "mlb" }, index);
  assertEquals(reason, "job_external_ref");
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
    { external_ref: "AJBR 67998", requesting_company_slug: "mlb", requesting_company_name: "ML Builders" },
    index,
  );
  assertEquals(reason, null);
});

Deno.test("a candidate with NO usable key is NOT treated as a duplicate", () => {
  const index = buildIntakeDedupIndex([BICTON_OLD]);
  const reason = isDuplicateIntake({ graph_message_id: null, internet_message_id: null, external_ref: null }, index);
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
  assert(secondReason !== null, "second scan of the same email must be a no-op (duplicate)");

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
  assert(oldVariantReason !== null, "the old-path variant of an already-drafted email must also be a no-op");
});

Deno.test("two copies of the same email WITHIN one batch: first creates, second is a no-op", () => {
  const index = buildIntakeDedupIndex([]);
  // Copy 1
  assertEquals(isDuplicateIntake(BICTON_NEW_CANDIDATE, index), null);
  registerIntakeDraft(BICTON_NEW_CANDIDATE, index);
  // Copy 2 in the SAME batch (e.g. the email appeared twice in the candidate window)
  const dup = isDuplicateIntake(
    { graph_message_id: "yet-another-id", internet_message_id: null, ...{
      external_ref: BICTON_NEW_CANDIDATE.external_ref,
      requesting_company_slug: BICTON_NEW_CANDIDATE.requesting_company_slug,
      requesting_company_name: BICTON_NEW_CANDIDATE.requesting_company_name,
    } },
    index,
  );
  assertEquals(dup, "external_ref+company");
});
