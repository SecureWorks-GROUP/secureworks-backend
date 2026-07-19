import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractBuilderWorkOrderIdentity,
  hasUnparseablePoLabel,
  mergeBuilderWorkOrderIdentity,
} from "./makesafe_builder_work_order_identity.ts";

Deno.test("builder identity: extracts MLB claim and PO from work-order filename", () => {
  const identity = extractBuilderWorkOrderIdentity({
    subject: "NEW WORK ORDER - MLB-25096 - Morley Make Safe",
    attachmentNames: [
      "work_order_MLB-25096PO-53582_Morley_make_safe.pdf",
    ],
  });

  assertEquals(identity.builder_claim_ref, "MLB-25096");
  assertEquals(identity.builder_po_number, "PO-53582");
  assertEquals(identity.builder_work_order_number, "MLB-25096PO-53582");
  assertEquals(identity.evidence_sources.includes("attachment_name"), true);
});

Deno.test("builder identity: merges full work-order identity over claim-only external_ref", () => {
  const merged = mergeBuilderWorkOrderIdentity(
    { external_ref: "MLB-25096", confidence: "high" },
    {
      builder_claim_ref: "MLB-25096",
      builder_po_number: "PO-53582",
      builder_work_order_number: "MLB-25096PO-53582",
      evidence_sources: ["attachment_name"],
    },
  );

  assertEquals(merged.external_ref, "MLB-25096PO-53582");
  assertEquals(merged.builder_claim_ref, "MLB-25096");
  assertEquals(merged.builder_po_number, "PO-53582");
  assertEquals(merged.builder_work_order_number, "MLB-25096PO-53582");
  assertEquals(
    merged.external_ref_source,
    "deterministic_builder_work_order_identity",
  );
});

Deno.test("builder identity: body labels can supply PO when subject supplies claim", () => {
  const identity = extractBuilderWorkOrderIdentity({
    subject: "Make Safe MLB-26072",
    bodyText: "Work Order Number: MLB-26072\nPurchase Order: 55443",
  });

  assertEquals(identity.builder_claim_ref, "MLB-26072");
  assertEquals(identity.builder_po_number, "PO-55443");
  assertEquals(identity.builder_work_order_number, "MLB-26072PO-55443");
});

// This extractor feeds the production capture path: its output becomes external_ref.
// Widening the PO label would change the stored ref for subjects already captured
// under the narrower grammar, so the spellings it reads are pinned here. Spaced
// "P O" is read; dotted forms are not, and stay PO-less rather than capturing a
// deliverable under a ref no existing row shares.
Deno.test("builder identity: PO label grammar is unchanged", () => {
  const spaced = extractBuilderWorkOrderIdentity({
    subject: "NEW WO - MLB 25096 - P O 4477",
  });
  assertEquals(spaced.builder_claim_ref, "MLB-25096");
  assertEquals(spaced.builder_po_number, "PO-4477");
  assertEquals(spaced.builder_work_order_number, "MLB-25096PO-4477");

  for (
    const subject of [
      "NEW WO - MLB 25096 - P.O. 4477",
      "NEW WO - MLB 25096 - P.O.#4477",
      "NEW WO - MLB 25096 - purchaseorder 4477",
      "NEW WO - MLB 25096 - P O. 4477",
      "NEW WO - MLB 25096 - P/O 4477",
      "NEW WO - MLB 25096 - P / O 4477",
      "NEW WO - MLB 25096 - Order No 4477",
      "NEW WO - MLB 25096 - Order Number 4477",
      "NEW WO - MLB 25096 - Order #4477",
    ]
  ) {
    const identity = extractBuilderWorkOrderIdentity({ subject });
    assertEquals(identity.builder_claim_ref, "MLB-25096");
    assertEquals(identity.builder_po_number, null);
    assertEquals(identity.builder_work_order_number, null);
    // Unreadable to the canonical grammar, but never invisible: the PO is known to
    // be present so downstream matching can refuse to treat the row as PO-less.
    assertEquals(hasUnparseablePoLabel(subject), true);
  }
});

Deno.test("builder identity: a readable or absent PO label is not reported unparseable", () => {
  assertEquals(hasUnparseablePoLabel("NEW WO - MLB 25096 - PO 4477"), false);
  assertEquals(hasUnparseablePoLabel("NEW WO - MLB 25096 - P O 4477"), false);
  assertEquals(
    hasUnparseablePoLabel("NEW WO - MLB 25096 - purchase order 4477"),
    false,
  );
  assertEquals(hasUnparseablePoLabel("Make Safe - 12 Smith St, Balga"), false);
  assertEquals(hasUnparseablePoLabel("Reply to P.O. Box 1234, Balga"), false);
});

// The bare "order" alternative must not fire on prose or on a builder work-order
// reference, which is an identity the labelled path already reads, not a PO.
Deno.test("builder identity: prose and work-order labels are not unknown POs", () => {
  assertEquals(
    hasUnparseablePoLabel("Crew to attend in order to make safe 250 metres"),
    false,
  );
  assertEquals(hasUnparseablePoLabel("Work Order No 68592 - Balga"), false);
  assertEquals(hasUnparseablePoLabel("Work Order: 68592"), false);
  // Same label, spelled with the spacing and hyphenation the labelled identity
  // grammar (work\s*order) also reads.
  assertEquals(hasUnparseablePoLabel("Work  Order No 68592 - Balga"), false);
  assertEquals(hasUnparseablePoLabel("Work-Order No: 68592"), false);
  assertEquals(hasUnparseablePoLabel("WorkOrder No 68592"), false);
});

// A postal address is not a purchase order.
Deno.test("builder identity: a PO Box address is not a purchase order", () => {
  const identity = extractBuilderWorkOrderIdentity({
    subject: "Make Safe MLB-26072",
    bodyText: "Reply to P.O. Box 1234, Balga WA 6021",
  });

  assertEquals(identity.builder_po_number, null);
});
