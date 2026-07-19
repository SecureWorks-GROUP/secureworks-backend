import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractBuilderWorkOrderIdentity,
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

// "P.O." and "P.O.#" are the same label as "PO" everywhere else in the intake
// grammar. If the canonical extractor cannot read them, the PO never reaches
// builder_po_number and the PO-separation guards go blind to a real deliverable.
Deno.test("builder identity: dotted PO spellings parse as a PO", () => {
  for (
    const subject of [
      "NEW WO - MLB 25096 - P.O. 4477",
      "NEW WO - MLB 25096 - P.O.#4477",
      "NEW WO - MLB 25096 - P O 4477",
    ]
  ) {
    const identity = extractBuilderWorkOrderIdentity({ subject });
    assertEquals(identity.builder_claim_ref, "MLB-25096");
    assertEquals(identity.builder_po_number, "PO-4477");
    assertEquals(identity.builder_work_order_number, "MLB-25096PO-4477");
  }
});

// A postal address is not a purchase order.
Deno.test("builder identity: a PO Box address is not a purchase order", () => {
  const identity = extractBuilderWorkOrderIdentity({
    subject: "Make Safe MLB-26072",
    bodyText: "Reply to P.O. Box 1234, Balga WA 6021",
  });

  assertEquals(identity.builder_po_number, null);
});
