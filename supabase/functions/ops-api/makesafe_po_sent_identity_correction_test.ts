// deno-lint-ignore-file no-import-prefix
// Track A D1 fixtures: the two real poisoned-PO shapes from production.
// 335 cases carried builder_po_canonical "BOX" (a permissive planner regex read
// "P.O. Box <digits>" signature addresses as purchase orders) and one carried
// "SENT" (the MLB-24481 chaser "Do we have an install date. PO sent 24/6.").
// The v2 grammar in makesafe_builder_work_order_identity.ts is the only PO
// source for every make-safe path; these tests pin that it yields NO identity
// for either poisoned shape while real PO spellings keep parsing. The
// historical rows are repaired by migration
// 20260730090000_makesafe_po_sent_identity_correction.sql.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractBuilderWorkOrderIdentity,
  hasAnyPoLabel,
  hasUnparseablePoLabel,
} from "./makesafe_builder_work_order_identity.ts";
import { normaliseMakesafeIdentity } from "../_shared/makesafe_intake_case_model.ts";

// The exact production shape behind the single po:SENT case
// (case 34848e85, emails received 2026-07-14, subject verbatim).
const SENT_SUBJECT =
  "Our Ref: MLB-24481 - 29 Gymea Ct, Armadale - Client Ref: 13330402 - Other Ref:";
const SENT_BODY = [
  "Hi team",
  "",
  "Do we have an install date. PO sent 24/6.",
  "Kind Regards,",
  "HEAD OFFICE PERTH: 39 Resource Way, Malaga WA 6090 E: admin@mlbuilders.com.au",
].join("\n");

Deno.test("po sent: the MLB-24481 chaser yields claim only, never PO 'SENT'", () => {
  const identity = extractBuilderWorkOrderIdentity({
    subject: SENT_SUBJECT,
    bodyText: SENT_BODY,
  });

  assertEquals(identity.builder_claim_ref, "MLB-24481");
  assertEquals(identity.builder_po_number, null);
  assertEquals(identity.builder_work_order_number, null);
});

Deno.test("po sent: 'PO sent 24/6' is not a PO label in either grammar", () => {
  // No digits follow the label directly, so the canonical grammar skips it and
  // the loose grammar cannot flag it as an unparseable PO either: the case
  // must not be strandable as permanent PO doubt.
  assertEquals(
    hasAnyPoLabel("Do we have an install date. PO sent 24/6."),
    false,
  );
  assertEquals(
    hasUnparseablePoLabel("Do we have an install date. PO sent 24/6."),
    false,
  );
});

Deno.test("po sent: re-derived identity falls below the identity floor", () => {
  // The repaired case ends with claim context only: no WO, no PO, so no
  // wo_po_identity_key. It can never again mint the poisoned 'po:SENT' key.
  const identity = extractBuilderWorkOrderIdentity({
    subject: SENT_SUBJECT,
    bodyText: SENT_BODY,
  });
  const canonical = normaliseMakesafeIdentity({
    externalRefRaw: identity.builder_claim_ref,
    builderWoRaw: identity.builder_work_order_number,
    builderPoRaw: identity.builder_po_number,
    deliverableRefRaw: "general_makesafe",
  });

  assertEquals(canonical.externalRefCanonical, "MLB-24481");
  assertEquals(canonical.builderPoCanonical, null);
  assertEquals(canonical.woPoIdentityKey, null);
});

Deno.test("po box: an MLB signature block never yields PO 'BOX'", () => {
  // The 335-case shape: the builder's signature carries a postal address on a
  // line the labelled-body scan reads (bare "PO" is a scan trigger). The
  // canonical grammar still refuses it because "Box" sits between the label
  // and the digits.
  for (
    const signatureLine of [
      "PO Box 2143, Malaga WA 6090",
      "Reply to P.O. Box 2143, Malaga WA 6090",
      "Post: PO Box 517 Balcatta WA 6914",
    ]
  ) {
    const identity = extractBuilderWorkOrderIdentity({
      subject: "NEW WORK ORDER - MLB-26499 - Make Safe",
      bodyText: `Please attend site.\n${signatureLine}`,
    });

    assertEquals(identity.builder_claim_ref, "MLB-26499");
    assertEquals(identity.builder_po_number, null);
    assertEquals(identity.builder_work_order_number, null);
  }
});

Deno.test("po grammar: real PO spellings still parse to digits-only identity", () => {
  // Regression guard for the repair direction the replay proves: a recomputed
  // identity must match the PO token in the work-order filename.
  const fromFilename = extractBuilderWorkOrderIdentity({
    subject: SENT_SUBJECT,
    attachmentNames: ["work_order_MLB-24481PO-54176_MLB.pdf"],
  });
  assertEquals(fromFilename.builder_po_number, "PO-54176");
  assertEquals(fromFilename.builder_work_order_number, "MLB-24481PO-54176");

  const fromBody = extractBuilderWorkOrderIdentity({
    bodyText: "Purchase Order No: 55622 for MLB-26721",
  });
  assertEquals(fromBody.builder_po_number, "PO-55622");

  const canonical = normaliseMakesafeIdentity({
    externalRefRaw: fromFilename.builder_claim_ref,
    builderWoRaw: fromFilename.builder_work_order_number,
    builderPoRaw: fromFilename.builder_po_number,
    deliverableRefRaw: "general_makesafe",
  });
  assertEquals(
    canonical.woPoIdentityKey,
    "wo:MLB-24481PO-54176/po:PO-54176",
  );
});
