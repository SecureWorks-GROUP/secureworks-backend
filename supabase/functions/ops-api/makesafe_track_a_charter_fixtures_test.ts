// Track A (TRACK-A-INTAKE-DIFF-2026-07-30) — sealed charter fixtures as CI.
//
// FAMILY-CLASSIFICATION-CHARTER.md v1.1: "Once sealed, this charter's examples
// are the classifier's test fixtures; a code change that breaks a sealed
// example fails CI." Each test names its charter example / Captain ruling.
// Header texts mirror the live MLB WO PDF text layer (D2 evidence probe).

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decideMakeSafeJobFamily } from "./makesafe_intake_gate.ts";
import { extractPdfDeclaredType } from "./makesafe_pdf_declared_type.ts";
import { extractBuilderWorkOrderIdentity } from "./makesafe_builder_work_order_identity.ts";

function headered(typeLines: string[], scope: string): string {
  return [
    "Work Order",
    "Work Order Assigned Secureworks Group Pty Ltd Work Order Number MLB-00000PO-00000",
    "Allocation Work Order",
    "Site Contact: Someone",
    ...typeLines,
    scope,
  ].join("\n");
}

function decideWithPdf(
  typeLines: string[],
  scope: string,
  builder: string | null = "mlb",
) {
  const text = headered(typeLines, scope);
  return decideMakeSafeJobFamily(null, null, null, {
    builder,
    pdfScopeText: scope,
    pdfDeclaredType: extractPdfDeclaredType(text),
  });
}

Deno.test("charter MLB-27148 PO-57210: two storey roof report -> roof_report", () => {
  const decision = decideWithPdf(
    ["Roof Reports", "EXTERNAL"],
    "Please attend site and conduct a two storey roof report noting cause of damage/point of water entry",
  );
  assertEquals(decision.family, "roof_report");
  assertEquals(decision.evidence, "pdf_declared_type_header");
});

Deno.test("charter MLB-27148 PO-57211: make safe collapsing ceiling -> physical makesafe", () => {
  const decision = decideWithPdf(
    ["Makesafe/Emergency Repairs", "Make Safe"],
    "Please make safe to partially collapsing ceiling",
  );
  assertEquals(decision.family, "general_makesafe");
  assertEquals(decision.evidence, "pdf_declared_type_header");
});

Deno.test("charter MLB-26190 PO-53964: 'assess roof to tarp' approach wording stays makesafe (sealed rule 4)", () => {
  const decision = decideWithPdf(
    ["Makesafe/Emergency Repairs", "Make Safe"],
    "Make safe ceiling in bedroom. Assess roof to tarp and ensure roof is water tight",
  );
  assertEquals(decision.family, "general_makesafe");
});

Deno.test("charter MLB-26190 PO-53966: roof report request -> roof_report", () => {
  const decision = decideWithPdf(
    ["Roof Reports", "EXTERNAL"],
    "Roof report request - single storey roof inspection to identify cause of damage/point of water entry",
  );
  assertEquals(decision.family, "roof_report");
});

Deno.test("Ruling 5 flip MLB-25765 PO-54176: header Assessment Report & Quote beats roof inference", () => {
  // The 2026-07-29 audit inferred roof_report from draft text; the header wins.
  const decision = decideWithPdf(
    ["Assessment Report & Quote", "INTERNAL"],
    "roof related scope wording that previously inferred a roof report",
  );
  assertEquals(decision.family, "assessment_report_quote");
  assertEquals(decision.evidence, "pdf_declared_type_header");
});

Deno.test("micro pass MLB-25765 PO-54177: header Roof Reports EXTERNAL -> roof_report", () => {
  const decision = decideWithPdf(
    ["Roof Reports", "EXTERNAL"],
    "Roof report request",
  );
  assertEquals(decision.family, "roof_report");
});

Deno.test("micro pass MLB-25881 PO-54673: header Makesafe/Emergency Repairs resolves the flaky-extraction case", () => {
  const decision = decideWithPdf(
    ["Makesafe/Emergency Repairs", "Make Safe"],
    "patio ceiling down",
  );
  assertEquals(decision.family, "general_makesafe");
});

Deno.test("Ruling 6 Group A (MLB-25074/25730/25732/26057/26104/26119/26246): assessment header decides over mixed scope", () => {
  for (
    const scope of [
      "Roof report and make safe on tiled roof",
      "Initial assessment and make-safe work for damages to eaves at property and fence",
      "make-safe assessment and allocation",
      "Plumber has fixed the leak. Assessment and make-safe work required for water damage",
      "Assessment and make-safe work for water damage. spa tub flooding",
      "Fence damage. Temporary fence required. Fencing is also part of the pool fencing",
    ]
  ) {
    const decision = decideWithPdf(
      ["Assessment Report & Quote", "INTERNAL"],
      scope,
    );
    assertEquals(decision.family, "assessment_report_quote", scope);
    assertEquals(decision.evidence, "pdf_declared_type_header", scope);
  }
});

Deno.test("charter MLB-26189 negation trap: 'No temp fencing required' never classifies temp_fence", () => {
  const decision = decideWithPdf(
    ["Assessment Report & Quote", "INTERNAL"],
    "Fence damage. Contractor inspection and assessment. No temp fencing required already has temp fencing in place",
  );
  assertEquals(decision.family, "assessment_report_quote");
  // Without the header the negation guard still keeps it out of temp_fence.
  const bare = decideMakeSafeJobFamily(
    null,
    "Fence damage. Contractor inspection and assessment. No temp fencing required already has temp fencing in place",
    null,
    { builder: "mlb" },
  );
  assertEquals(bare.family, "assessment_report_quote");
});

Deno.test("charter MLB-26323: danger present but requested deliverable is the report (sealed rule 4)", () => {
  const decision = decideWithPdf(
    ["Roof Reports", "EXTERNAL"],
    "Corner of roof collapsed. risk of collapse. Two storey roof report required",
  );
  assertEquals(decision.family, "roof_report");
});

Deno.test("charter MLB-26010 PO-54250: install temporary fence -> makesafe temp fence subtype", () => {
  const decision = decideWithPdf(
    ["Temporary Fencing", "Make Safe"],
    "Install temporary fence for make-safe. 3-month hire including collection",
  );
  assertEquals(decision.family, "temp_fence_makesafe");
});

Deno.test("Ruling 8 MLB-25147 PO-56236: scaffolding PO is its own repair deliverable", () => {
  const decision = decideWithPdf(
    ["Scaffolding/Access Equipment EXTERNAL"],
    "labour to install scaffolding and remove upon completion",
  );
  assertEquals(decision.family, "repair");
});

Deno.test("Ruling 9 MLB-27093 PO-56481: restoration label corroborates only; scope decides makesafe", () => {
  const decision = decideWithPdf(
    ["Restoration", "Make Safe"],
    "Please complete make safe to inside the property",
  );
  assertEquals(decision.family, "general_makesafe");
});

Deno.test("Ruling 9 AJBR-68592: another party's restoration job parks unclassified, never guessed", () => {
  const decision = decideMakeSafeJobFamily(null, null, null, {
    builder: "ajs_ajbr",
    pdfScopeText:
      "Remove whole cabinets in walk-in wardrobe for restoration trade to commence. Further works - carpentry restoration",
  });
  assertEquals(decision.family, null);
  assertEquals(decision.evidence, "ajs_restoration_park");
});

Deno.test("AJS floor holds: ordinary AJ instructions remain physical makesafe", () => {
  const decision = decideMakeSafeJobFamily(null, null, null, {
    builder: "ajs_ajbr",
    pdfScopeText: "Assessment report wording that must never promote AJ work",
  });
  assertEquals(decision.family, "general_makesafe");
  assertEquals(decision.evidence, "ajs_make_safe_floor");
});

Deno.test("Ruling 15: text-only restoration parks instead of classifying (recipe unsealed)", () => {
  const decision = decideMakeSafeJobFamily(null, null, null, {
    builder: "mlb",
    pdfScopeText: "Water damage restoration works required for the dwelling",
  });
  assertEquals(decision.family, null);
  assertEquals(decision.evidence, "text_restoration_park");
});

Deno.test("charter S6 trap: 'make safe report' wording is a makesafe, not an assessment", () => {
  const decision = decideWithPdf(
    ["Makesafe/Emergency Repairs", "Make Safe"],
    "Attend site, complete make safe report and secure the property",
  );
  assertEquals(decision.family, "general_makesafe");
});

// Track A D6 (standing rule + Ruling 5): the subject line never decides
// family and never anchors identity.
Deno.test("D6: a report-flavoured subject cannot flip a physical make-safe scope", () => {
  const decision = decideMakeSafeJobFamily(
    "Roof report required MLB-27200",
    "Please attend and make safe the storm damaged ceiling",
    null,
    { builder: "mlb" },
  );
  assertEquals(decision.family, "general_makesafe");
});

Deno.test("D6: a 'NEW WORK ORDER' subject alone assigns no family (abstain, not guess)", () => {
  const decision = decideMakeSafeJobFamily(
    "NEW WORK ORDER - MLB-27201 12 Format Street, Perth",
    "",
    null,
    { builder: "mlb" },
  );
  assertEquals(decision.family, null);
  assertEquals(decision.evidence, "ambiguous_scope");
});

Deno.test("D6: the attachment filename (S0) beats a reused subject ref for identity", () => {
  const identity = extractBuilderWorkOrderIdentity({
    subject: "NEW WORK ORDER - MLB-11111 1 Reused Subject Way",
    attachmentNames: [
      "work_order_MLB-22222PO-33333_Secureworks_Group_Pty_Ltd.pdf",
    ],
    bodyText: null,
    externalRef: null,
  });
  assertEquals(identity.builder_claim_ref, "MLB-22222");
  assertEquals(identity.builder_po_number, "PO-33333");
});

Deno.test("D6: the subject still fills identity when it is the only evidence", () => {
  const identity = extractBuilderWorkOrderIdentity({
    subject:
      "Our Ref: MLB-24363 - 12 Keane Ct, Noranda - Client Ref: 13328238 - Other Ref:",
    attachmentNames: [],
    bodyText: null,
    externalRef: null,
  });
  assertEquals(identity.builder_claim_ref, "MLB-24363");
});
