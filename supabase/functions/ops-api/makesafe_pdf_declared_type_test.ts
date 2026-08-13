// deno-lint-ignore-file no-import-prefix

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractPdfDeclaredType } from "./makesafe_pdf_declared_type.ts";

// Header shapes mirror the persisted text layer of live MLB work orders
// (verified read-only against production `work_order_pdf_text`, 2026-07-30).
function woPdfText(typeLines: string[], scope: string): string {
  return [
    "Work Order",
    "Work Order Assigned Secureworks Group Pty Ltd Work Order Number MLB-27148PO-57210",
    "12 Example Street Suburb WA 6000",
    "Some Contact 0400 000 000",
    "Allocation Work Order",
    "Site Contact: Someone",
    ...typeLines,
    scope,
    "Notes",
    "generic per-WO context that must never decide family: roof report assessment",
  ].join("\n");
}

Deno.test("declared type: Makesafe/Emergency Repairs header decides makesafe", () => {
  const read = extractPdfDeclaredType(
    woPdfText(
      ["Makesafe/Emergency Repairs", "Make Safe"],
      "Please make safe to partially collapsing ceiling",
    ),
  );
  assertEquals(read.declaredType, "makesafe");
  assertEquals(read.fenceSubtype, false);
  assertEquals(read.anchored, true);
  assertEquals(read.headerLine, "Makesafe/Emergency Repairs");
});

Deno.test("declared type: Roof Reports EXTERNAL header decides roof", () => {
  const read = extractPdfDeclaredType(
    woPdfText(
      ["Roof Reports", "EXTERNAL"],
      "Please attend site and conduct a two storey roof report noting cause of damage/point of water entry",
    ),
  );
  assertEquals(read.declaredType, "roof");
});

Deno.test("declared type: Assessment Report & Quote INTERNAL decides assessment", () => {
  const read = extractPdfDeclaredType(
    woPdfText(
      ["Assessment Report & Quote", "INTERNAL"],
      "Contractor inspection and assessment of damaged gates",
    ),
  );
  assertEquals(read.declaredType, "assessment");
});

Deno.test("declared type: Temporary Fencing + Make Safe carries the fence subtype", () => {
  const read = extractPdfDeclaredType(
    woPdfText(
      ["Temporary Fencing", "Make Safe"],
      "Please provide MLB with a temporary fence quote for 2 months",
    ),
  );
  assertEquals(read.declaredType, "makesafe");
  assertEquals(read.fenceSubtype, true);
});

Deno.test("declared type: Restoration label + Make Safe stays makesafe (Ruling 9)", () => {
  const read = extractPdfDeclaredType(
    woPdfText(
      ["Restoration", "Make Safe"],
      "Please complete make safe to inside the property",
    ),
  );
  assertEquals(read.declaredType, "makesafe");
  assertEquals(read.restorationLabel, true);
});

Deno.test("declared type: Scaffolding/Access Equipment is its own repair deliverable (Ruling 8)", () => {
  const read = extractPdfDeclaredType(
    woPdfText(
      ["Scaffolding/Access Equipment EXTERNAL"],
      "labour to install scaffolding and remove upon completion",
    ),
  );
  assertEquals(read.declaredType, "repair");
});

Deno.test("declared type: standalone Rapid Repair header decides repair", () => {
  const read = extractPdfDeclaredType(
    woPdfText(
      ["Rapid Repair"],
      "Attend site and repair the damaged gates and driveway.",
    ),
  );
  assertEquals(read.declaredType, "repair");
  assertEquals(read.anchored, true);
  assertEquals(read.headerLine, "Rapid Repair");
});

Deno.test("declared type: scope sentences never fire the header signal", () => {
  // "roof report" wording deep in an unanchored document must not classify.
  const read = extractPdfDeclaredType(
    [
      "Some Other Layout",
      "Line",
      "Customer",
      "Please attend site and conduct a single storey roof report",
    ].join("\n"),
  );
  assertEquals(read.declaredType, null);
});

Deno.test("declared type: conflicting header type lines abstain", () => {
  const read = extractPdfDeclaredType(
    woPdfText(
      ["Roof Reports", "Assessment Report & Quote"],
      "scope",
    ),
  );
  assertEquals(read.declaredType, null);
});

Deno.test("declared type: empty and headerless text abstain", () => {
  assertEquals(extractPdfDeclaredType("").declaredType, null);
  assertEquals(extractPdfDeclaredType(null).declaredType, null);
  assertEquals(
    extractPdfDeclaredType("just some words\nwith no header").declaredType,
    null,
  );
});
