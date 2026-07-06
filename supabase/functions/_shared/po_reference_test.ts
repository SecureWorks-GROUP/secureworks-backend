// Tests for the outbound PO reference-discipline module (U2).
// Run: deno test supabase/functions/_shared/po_reference_test.ts
//
// The two regexes below are COPIED VERBATIM from the live inbound bill-linker so
// the proof is against the real matchers, not a paraphrase:
//   xero-sync/index.ts:486  primary linker
//   xero-sync/index.ts:743  reconcile pass
// If either regex changes in xero-sync, this test must be updated in lockstep
// (that is the whole point — reference format is proven, not assumed).

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  canonicalJobRef,
  isCanonicalJobRef,
  poDeliveryInstruction,
  poEmailReferenceBanner,
  quoteBackInstruction,
} from "./po_reference.ts";

const SYNC_REGEX = /SWMS-\d{4,5}|SW[A-Z]?-?\d{3,5}/i; // xero-sync :486
const RECONCILE_REGEX = /SW[PFDRIM]-\d{5}/i; // xero-sync :743

function survivesBothLinkers(ref: string): boolean {
  return SYNC_REGEX.test(ref) && RECONCILE_REGEX.test(ref);
}

Deno.test("canonicalJobRef: already-canonical refs pass through verbatim (upper)", () => {
  assertEquals(canonicalJobRef("SWF-25010"), "SWF-25010");
  assertEquals(canonicalJobRef("SWP-25029"), "SWP-25029");
  assertEquals(canonicalJobRef("swd-25040"), "SWD-25040");
  // multi-order suffix preserved
  assertEquals(canonicalJobRef("SWF-25010-01"), "SWF-25010-01");
  assertEquals(canonicalJobRef("SWF-25030-REAR-A"), "SWF-25030-REAR-A");
});

Deno.test("canonicalJobRef: embedded canonical token is extracted", () => {
  assertEquals(canonicalJobRef("Job SWF-25010 Bunnings order"), "SWF-25010");
  assertEquals(canonicalJobRef("PO-SWF-25010"), "SWF-25010");
});

Deno.test("canonicalJobRef: non-canonical ref recovers from job_number", () => {
  // bare (no division letter) — NOT emitted, recovered from job_number
  assertEquals(canonicalJobRef("SW-25010", "SWF-25010"), "SWF-25010");
  // hyphenless — NOT emitted, recovered
  assertEquals(canonicalJobRef("SWF25010", "SWF-25010"), "SWF-25010");
  // empty ref — recovered
  assertEquals(canonicalJobRef("", "SWP-25029"), "SWP-25029");
  assertEquals(canonicalJobRef(null, "SWP-25029"), "SWP-25029");
});

Deno.test("canonicalJobRef: never invents when nothing canonical exists", () => {
  // no canonical anywhere → return best raw value, do not fabricate
  assertEquals(canonicalJobRef("SW-25010", "SW-25010"), "SW-25010");
  assertEquals(canonicalJobRef("", ""), "");
});

Deno.test("isCanonicalJobRef: predicate matches the emit contract", () => {
  assert(isCanonicalJobRef("SWF-25010"));
  assert(isCanonicalJobRef("SWP-25029-01"));
  assert(isCanonicalJobRef("SWMS-26878"));
  assert(!isCanonicalJobRef("SW-25010"));
  assert(!isCanonicalJobRef("SWF25010"));
  assert(!isCanonicalJobRef(""));
});

Deno.test("PROOF: every ref canonicalJobRef EMITS survives BOTH live linkers", () => {
  const emitted = [
    canonicalJobRef("SWF-25010"),
    canonicalJobRef("SWP-25029"),
    canonicalJobRef("SWD-25040"),
    canonicalJobRef("SWF-25010-01"),
    canonicalJobRef("Job SWF-25010 Bunnings order"),
    canonicalJobRef("SW-25010", "SWF-25010"),
    canonicalJobRef("SWF25010", "SWP-25029"),
  ];
  for (const ref of emitted) {
    assert(
      survivesBothLinkers(ref),
      `emitted ref "${ref}" must survive BOTH bill-linkers`,
    );
  }
});

Deno.test("REGRESSION: the forbidden forms do NOT survive both linkers", () => {
  // These are exactly the forms the module refuses to emit for a materials PO.
  assert(!survivesBothLinkers("SW-25010"), "bare SW-##### must fail reconcile");
  assert(!survivesBothLinkers("SWF25010"), "hyphenless must fail both");
  assert(!survivesBothLinkers("SWMS-26878"), "SWMS must fail reconcile (materials)");
});

Deno.test("quoteBackInstruction: exact sentence, no em dash", () => {
  assertEquals(
    quoteBackInstruction("SWF-25010"),
    "Please quote SWF-25010 on your invoice so we can match your payment to this job.",
  );
  assert(!quoteBackInstruction("SWF-25010").includes("—")); // no em dash
});

Deno.test("poDeliveryInstruction: preserves an existing delivery note", () => {
  assertEquals(
    poDeliveryInstruction("SWF-25010"),
    "Please quote SWF-25010 on your invoice so we can match your payment to this job.",
  );
  assertEquals(
    poDeliveryInstruction("SWF-25010", "Deliver to: 12 Smith St, Perth"),
    "Deliver to: 12 Smith St, Perth\nPlease quote SWF-25010 on your invoice so we can match your payment to this job.",
  );
});

Deno.test("poEmailReferenceBanner: carries ref + ask prominently", () => {
  const html = poEmailReferenceBanner("SWP-25029");
  assert(html.includes("SWP-25029"));
  assert(html.includes("Please quote SWP-25029 on your invoice"));
  assert(html.includes("Job reference"));
});

// ── EVIDENCE GENERATOR (for Deckhand V) ──────────────────────────────────────
// `deno test --allow-none` prints these. They are the exact strings the two
// outbound channels stamp for one patio job (SWP-25029) and one fence job
// (SWF-25010) — the reproducible sample the DoD asks for.
Deno.test("EVIDENCE: sample outbound artifacts (patio + fence)", () => {
  for (const [label, ref] of [["PATIO", "SWP-25029"], ["FENCE", "SWF-25010"]] as const) {
    console.log(`\n──────── ${label} job ${ref} ────────`);
    console.log(`Xero PurchaseOrder.Reference          : ${canonicalJobRef(ref)}`);
    console.log(`Xero PurchaseOrder.DeliveryInstructions: ${poDeliveryInstruction(ref)}`);
    console.log(`Resend email banner (HTML):`);
    console.log(poEmailReferenceBanner(ref));
    console.log(`Resend email footer Ref line          : Ref: ${canonicalJobRef(ref)}`);
  }
  assert(true);
});
