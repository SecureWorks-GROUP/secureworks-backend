// Wave 2 — make-safe report renderer pure-helper tests.
//
// Tests ONLY the pure helpers (slug, filename builder, render hash). The PDF
// drawing path imports jsPDF from esm.sh and is exercised live in deploy QA, not
// here — these tests stay network-free.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 \
//        supabase/functions/ops-api/makesafe_report_render_test.ts
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  makesafeReportFileName,
  makesafeReportHashInput,
  renderHash,
  renderMakesafeReportPdf,
  sanitiseText,
  slug,
} from "./makesafe_report_render.ts";

Deno.test("slug: sanitises non-alphanumerics, trims, caps length", () => {
  assertEquals(slug("12 Smith St, Perth"), "12-Smith-St-Perth");
  assertEquals(slug("MLB-24981"), "MLB-24981");
  assertEquals(slug("///weird___ref///"), "weird-ref");
  assertEquals(slug(""), "make-safe"); // empty fallback
  assertEquals(slug(null), "make-safe");
  assert(slug("x".repeat(200)).length <= 90);
});

Deno.test("filename: contains lowercased 'make safe report' so doc-booleans + gate match", () => {
  const name = makesafeReportFileName("MLB-24981", "12 Smith St");
  // makesafeDocBooleans matches file_name.toLowerCase().includes('make safe report')
  assert(name.toLowerCase().includes("make safe report"), name);
  assert(name.endsWith(".pdf"));
  // The client-send gate is_report_pdf check would also pass on this name.
  assert(name.toLowerCase().includes("mlb-24981"));
});

Deno.test("filename: is deterministic for the same ref+address", () => {
  assertEquals(
    makesafeReportFileName("AJS-100", "5 Beach Rd"),
    makesafeReportFileName("AJS-100", "5 Beach Rd"),
  );
});

Deno.test("renderHash: stable for identical jobs, differs on content change", async () => {
  const job = {
    ref: "MLB-1",
    address: "1 A St",
    scope: "make safe the boundary",
    photos: [],
  };
  const h1 = await renderHash(job);
  const h2 = await renderHash({ ...job });
  assertEquals(h1, h2, "same content -> same hash");
  const h3 = await renderHash({ ...job, scope: "different scope" });
  assert(h1 !== h3, "changed content -> different hash");
  assertEquals(h1.length, 64); // sha-256 hex
});

Deno.test("hash input: photos contribute length/type, not raw bytes", () => {
  const a = makesafeReportHashInput({
    ref: "r",
    address: "a",
    photos: [{ bytesBase64: "AAAA", contentType: "image/jpeg" }],
  });
  const b = makesafeReportHashInput({
    ref: "r",
    address: "a",
    photos: [{ bytesBase64: "BBBB", contentType: "image/jpeg" }],
  });
  // Same length + type -> same serialisation (cheap, stable across re-encodes).
  assertEquals(a, b);
});

Deno.test("sanitiseText: em/en dashes normalised to hyphen (house comms rule)", () => {
  assertEquals(sanitiseText("scope — done – ok"), "scope - done - ok");
  assertEquals(sanitiseText(null), "");
});

function countPdfPages(bytes: Uint8Array): number {
  const text = new TextDecoder().decode(bytes);
  return (text.match(/\/Type\s*\/Page\b/g) || []).length;
}

Deno.test("render PDF: top-down layout keeps normal no-photo reports to sane page count", async () => {
  const rendered = await renderMakesafeReportPdf({
    ref: "SWMS-26651 / MLB-26003 / PO-53480",
    address: "U1 / 25 Kimbara Street, Nollamara WA",
    contact:
      "The Owners of 25 Kimbara Street Nollamara Strata Plan 26544 | 0439 631 353 | Requesting builder: Major Loss Builders",
    date: "2026-06-18",
    arrival: "to confirm",
    crew: "2 trades",
    billing_note:
      "2 trades x 2 hours plus materials, final pricing to be confirmed",
    scope:
      "Make-safe attendance following storm/wind event. Inspect and make safe detached cornice in garage, clear debris, install temporary fencing as required.",
    findings:
      "Garage cornice had detached and debris was present. Ceiling/cornice area required make-safe inspection and temporary controls before builder review.",
    works:
      "Attended site, inspected affected ceiling/cornice area, cleared loose debris, checked immediate safety risks, and documented site condition for builder review.",
    materials:
      "Temporary fencing panels, bases/feet, tarps/roof materials, fixings and consumables where required.",
    photos: [],
  });

  const pages = countPdfPages(rendered.bytes);
  assert(pages >= 1, `expected at least one page, got ${pages}`);
  assert(
    pages <= 3,
    `no-photo make-safe report should not inflate to ${pages} pages`,
  );
  assert(rendered.fileName.toLowerCase().includes("make safe report"));
});
