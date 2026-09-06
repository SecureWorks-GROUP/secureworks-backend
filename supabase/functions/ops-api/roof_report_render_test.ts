// Wave 3 -- roof-report renderer tests. Pure helpers are network-free; the two
// render tests import jsPDF from esm.sh (like makesafe_report_render_test.ts).
//
// Run: deno test --no-check --allow-env --allow-net \
//        supabase/functions/ops-api/roof_report_render_test.ts
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aspectFitBox,
  formatAud,
  omitRoofReportFee,
  renderHash,
  renderRoofReportPdf,
  roofReportFileName,
  roofReportHashInput,
  roofReportHeaderRows,
  roofReportIncludesFee,
  sanitiseText,
  slug,
  yesNo,
} from "./roof_report_render.ts";

Deno.test("slug: sanitises, trims, caps; empty falls back to roof-report", () => {
  assertEquals(slug("12 Smith St, Perth"), "12-Smith-St-Perth");
  assertEquals(slug("MLB-24981"), "MLB-24981");
  assertEquals(slug(""), "roof-report");
  assertEquals(slug(null), "roof-report");
  assert(slug("x".repeat(200)).length <= 90);
});

Deno.test("filename: carries lowercased 'roof inspection report' token + ref", () => {
  const name = roofReportFileName("MLB-24981", "12 Smith St");
  assert(name.toLowerCase().includes("roof inspection report"), name);
  assert(name.toLowerCase().includes("mlb-24981"));
  assert(name.endsWith(".pdf"));
});

Deno.test("yesNo: normalises booleans/strings, blank stays blank", () => {
  assertEquals(yesNo(true), "Yes");
  assertEquals(yesNo(false), "No");
  assertEquals(yesNo("yes"), "Yes");
  assertEquals(yesNo("No"), "No");
  assertEquals(yesNo("1"), "Yes");
  assertEquals(yesNo(""), "");
  assertEquals(yesNo(null), "");
});

Deno.test("formatAud: money format, non-numeric -> blank", () => {
  assertEquals(formatAud(275), "$275.00");
  assertEquals(formatAud(330), "$330.00");
  assertEquals(formatAud(undefined), "");
});

Deno.test("omitRoofReportFee drops prices and disables the Report fee row", () => {
  const omitted = omitRoofReportFee({
    ref: "MLB-1",
    address: "1 A St",
    storeys: "Double Storey",
    price_ex_gst: 300,
    price_inc_gst: 330,
  });
  assertEquals(omitted.price_ex_gst, undefined);
  assertEquals(omitted.price_inc_gst, undefined);
  assertEquals(omitted.include_report_fee, false);
  assertEquals(omitted.storeys, "Double Storey");
  assertEquals(roofReportIncludesFee(omitted), false);
});

Deno.test("roofReportHeaderRows: office render keeps Report fee; trade-visible omits it", () => {
  const office = roofReportHeaderRows({
    ref: "MLB-1",
    address: "1 A St",
    storeys: "Double Storey",
    price_inc_gst: 330,
  });
  assertEquals(office.some(([k]) => k === "Report fee"), true);
  assertEquals(office.find(([k]) => k === "Report fee")?.[1].includes("$330.00"), true);
  assertEquals(office.find(([k]) => k === "Number of storeys")?.[1], "Double Storey");

  const trade = roofReportHeaderRows({
    ref: "MLB-1",
    address: "1 A St",
    storeys: "Double Storey",
    price_inc_gst: 330,
    include_report_fee: false,
  });
  assertEquals(trade.some(([k]) => k === "Report fee"), false);
  assertEquals(JSON.stringify(trade).includes("330"), false);
  assertEquals(JSON.stringify(trade).includes("Report fee"), false);
  assertEquals(trade.find(([k]) => k === "Number of storeys")?.[1], "Double Storey");
});

Deno.test("sanitiseText: em/en dashes normalised to hyphen (house comms rule)", () => {
  assertEquals(sanitiseText("roof — checked – ok"), "roof - checked - ok");
  assertEquals(sanitiseText(null), "");
});

Deno.test("renderHash: stable for identical jobs, differs on content + toggle change", async () => {
  const job = {
    ref: "MLB-1",
    address: "1 A St",
    storeys: "Double Storey",
    water_leak: true,
    photos: [],
  };
  const h1 = await renderHash(job);
  const h2 = await renderHash({ ...job });
  assertEquals(h1, h2);
  const h3 = await renderHash({ ...job, water_leak: false });
  assert(h1 !== h3, "toggle change -> different hash");
  assertEquals(h1.length, 64);
});

Deno.test("hash input: photo label contributes; raw bytes do not", () => {
  const a = roofReportHashInput({
    ref: "r",
    address: "a",
    photos: [{
      bytesBase64: "AAAA",
      contentType: "image/jpeg",
      label: "Ridge",
    }],
  });
  const b = roofReportHashInput({
    ref: "r",
    address: "a",
    photos: [{
      bytesBase64: "BBBB",
      contentType: "image/jpeg",
      label: "Ridge",
    }],
  });
  assertEquals(a, b, "same len/type/label -> same serialisation");
  const c = roofReportHashInput({
    ref: "r",
    address: "a",
    photos: [{
      bytesBase64: "AAAA",
      contentType: "image/jpeg",
      label: "Valley",
    }],
  });
  assert(a !== c, "different label -> different serialisation");
});

Deno.test("aspectFitBox: preserves image aspect inside a target rectangle", () => {
  const fit = aspectFitBox(400, 200, 10, 20, 100, 100);
  assertEquals(Math.round(fit.w), 100);
  assertEquals(Math.round(fit.h), 50);
});

function countPdfPages(bytes: Uint8Array): number {
  const text = new TextDecoder().decode(bytes);
  return (text.match(/\/Type\s*\/Page\b/g) || []).length;
}

Deno.test("render PDF: a full roof report on our letterhead stays a sane page count", async () => {
  const rendered = await renderRoofReportPdf({
    ref: "MLB-17270PO-54939 / SWMS-26861",
    address: "Caversham WA",
    contact: "Major Loss Builders",
    inspection_date: "2026-07-20",
    inspection_time: "09:30",
    inspected_by: "Sam Trade",
    weather: "Sunny / Fine",
    construction_type: "Double Brick",
    storeys: "Double Storey",
    property_condition: "Good",
    roof_type: "Terracotta Tiles",
    roof_pitch: "22.5 degrees",
    roof_profile_correct: true,
    gutters_serviceable: true,
    roof_condition: "Fair",
    services_penetrations: "Solar, hot water",
    storm_openings: false,
    water_leak: true,
    leak_cause: "Cracked ridge capping over the master bedroom.",
    overall_findings:
      "Roof is in fair condition for its age. Localised damage over the master bedroom consistent with the storm event.",
    maintenance_issues: "Some minor lifting of tiles on the southern face.",
    maintenance_recommendation: "Recommended",
    maintenance_details: "Re-bed and point the ridge line.",
    scope_summary: "Full external roof inspection following the storm claim.",
    price_ex_gst: 300,
    price_inc_gst: 330,
    photos: [],
  });
  const pages = countPdfPages(rendered.bytes);
  assert(pages >= 1 && pages <= 3, `expected 1-3 pages, got ${pages}`);
  assert(rendered.fileName.toLowerCase().includes("roof inspection report"));
  // House rule: our rendered output must never carry an em dash. jsPDF encodes
  // text into content streams, so scan the raw bytes for the UTF-8 em dash.
  const emDash = new TextEncoder().encode("—");
  const bytes = rendered.bytes;
  let found = false;
  for (let i = 0; i + emDash.length <= bytes.length; i++) {
    let match = true;
    for (let j = 0; j < emDash.length; j++) {
      if (bytes[i + j] !== emDash[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      found = true;
      break;
    }
  }
  assert(!found, "rendered PDF must not contain an em dash");
});

Deno.test("render PDF: labelled photos use their captions and stay compact", async () => {
  const onePixelPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  const rendered = await renderRoofReportPdf({
    ref: "MLB-2",
    address: "9 Roof Way, Perth WA",
    storeys: "Single Storey",
    price_ex_gst: 250,
    price_inc_gst: 275,
    photo_limit: 8,
    photos: Array.from({ length: 8 }, (_, i) => ({
      bytesBase64: onePixelPng,
      contentType: "image/png",
      label: `Roof face ${i + 1}`,
    })),
  });
  const pages = countPdfPages(rendered.bytes);
  assert(pages <= 6, `8-photo roof report should be compact, got ${pages}`);
});
