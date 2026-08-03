// deno-lint-ignore-file no-import-prefix
// Wave 2 — make-safe report renderer pure-helper tests.
//
// Covers pure helpers plus the curated PDF contract. The drawing tests use only
// inline privacy-safe images; no live job or client data is involved.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 \
//        supabase/functions/ops-api/makesafe_report_render_test.ts
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aspectFitBox,
  CommercialContentError,
  findCommercialContent,
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

const CURATED_JOB = {
  ref: "REF-70062",
  address: "Privacy-safe test property",
  contact: "Site representative",
  date: "2026-08-03",
  arrival: "08:30",
  crew: "2 trades",
  scope: "Stabilise the damaged boundary pending permanent repair.",
  findings: "The boundary fence was unstable after severe weather.",
  works:
    "Propped the damaged fence upright and secured the affected span pending replacement.",
  materials: "Star pickets x 20.",
};

Deno.test("render PDF: top-down layout keeps normal no-photo reports to sane page count", async () => {
  const rendered = await renderMakesafeReportPdf({
    ...CURATED_JOB,
    // Legacy commercial inputs remain accepted but are deliberately ignored.
    billing_note: "2 trades x 3 hours, $480 ex GST",
    access_issues: "Internal invoice follow-up required.",
    follow_up_required: "Charge on the next invoice.",
    photos: [],
  });

  const pages = countPdfPages(rendered.bytes);
  assert(pages >= 1, `expected at least one page, got ${pages}`);
  assert(
    pages <= 3,
    `no-photo make-safe report should not inflate to ${pages} pages`,
  );
  assert(rendered.fileName.toLowerCase().includes("make safe report"));
  const pdf = new TextDecoder("latin1").decode(rendered.bytes);
  assert(!/billing time|invoice|\$480|gst|access and follow-up/i.test(pdf));
  for (
    const heading of [
      "Work Order Scope",
      "Site Findings",
      "Works Completed",
      "Materials and Equipment",
    ]
  ) {
    assertStringIncludes(pdf, heading);
  }
  assertStringIncludes(pdf, "Star pickets x 20");
  assertStringIncludes(pdf, "Propped the damaged fence upright");
  assertStringIncludes(pdf, "/Subtype /Image");
});

Deno.test("aspectFitBox: preserves image aspect inside a target rectangle", () => {
  const fit = aspectFitBox(400, 200, 10, 20, 100, 100);
  assertEquals(Math.round(fit.w), 100);
  assertEquals(Math.round(fit.h), 50);
  assertEquals(Math.round(fit.x), 10);
  assertEquals(Math.round(fit.y), 45);
});

Deno.test("render PDF: eight curated photos use one large evidence page each", async () => {
  const onePixelPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  const rendered = await renderMakesafeReportPdf({
    ...CURATED_JOB,
    photo_limit: 8,
    photos: Array.from({ length: 8 }, (_unused, index) => ({
      bytesBase64: onePixelPng,
      contentType: "image/png",
      caption: `Deliberate evidence ${index + 1}`,
    })),
  });

  const pages = countPdfPages(rendered.bytes);
  assertEquals(pages, 9);
  const pdf = new TextDecoder("latin1").decode(rendered.bytes);
  for (let index = 1; index <= 8; index++) {
    assertStringIncludes(pdf, `Deliberate evidence ${index}`);
  }
});

Deno.test("commercial guard is pinned to rendered fields and ignores legacy billing_note", () => {
  assertEquals(
    findCommercialContent({
      ...CURATED_JOB,
      billing_note: "Invoice total $480 plus GST",
    }),
    [],
  );
  assertEquals(
    findCommercialContent({
      ...CURATED_JOB,
      works: "2 trades completed 3 hours billed at $480",
    }),
    ["works"],
  );
});

Deno.test("renderer fails closed on commercial prose and crew names", async () => {
  await assertRejects(
    () =>
      renderMakesafeReportPdf({
        ...CURATED_JOB,
        works: "2 trades completed 3 hours billed at $480",
      }),
    CommercialContentError,
    "works",
  );
  await assertRejects(
    () => renderMakesafeReportPdf({ ...CURATED_JOB, crew: "Field Person" }),
    Error,
    "trade count only",
  );
});

Deno.test("repeat curated renders are stable under the existing PDF ID normalisation contract", async () => {
  const first = await renderMakesafeReportPdf(CURATED_JOB);
  const second = await renderMakesafeReportPdf({ ...CURATED_JOB });
  const normalise = (pdf: Uint8Array) =>
    new TextDecoder("latin1").decode(pdf).replace(
      /\/ID \[ <[0-9A-F]+> <[0-9A-F]+> \]/,
      "/ID [ <ID> <ID> ]",
    );
  assertEquals(first.renderHash, second.renderHash);
  assertEquals(normalise(first.bytes), normalise(second.bytes));
});
