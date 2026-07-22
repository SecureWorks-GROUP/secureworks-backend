// Wave 3 -- roof-report template + pricing + validation pure-helper tests.
// Network-free.
//
// Run: deno test --no-check \
//        supabase/functions/ops-api/roof_report_template_test.ts
import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRoofReportJob,
  getRoofReportTemplate,
  normaliseStorey,
  ROOF_REPORT_FIELDS,
  ROOF_REPORT_PACK_KIND,
  ROOF_REPORT_TEMPLATE_VERSION,
  roofReportPrice,
  sanitiseRoofPhotosMeta,
  sanitiseRoofReportFields,
  STOREY_DOUBLE,
  STOREY_SINGLE,
  validateRoofReportForSubmit,
} from "./roof_report_template.ts";

Deno.test("template: exposes versioned schema, sections, storey pricing driver", () => {
  const t = getRoofReportTemplate();
  assertEquals(t.version, ROOF_REPORT_TEMPLATE_VERSION);
  assertEquals(t.pack_kind, ROOF_REPORT_PACK_KIND);
  assert(t.sections.length >= 5);
  // The storey field is the pricing driver and is required.
  const storey = t.fields.find((f) => f.key === "storeys");
  assert(storey, "storeys field present");
  assertEquals(storey?.pricingDriver, true);
  assertEquals(storey?.required, true);
  assertEquals(storey?.options, [STOREY_SINGLE, STOREY_DOUBLE]);
  // Photos field exists (the labelled-evidence bonus).
  assert(t.fields.some((f) => f.key === "photos" && f.type === "photos"));
  // Pricing block carries both locked figures.
  assertEquals(t.pricing.single.inc_gst, 275);
  assertEquals(t.pricing.double.inc_gst, 385);
});

Deno.test("template: no field label or option contains an em dash (house rule)", () => {
  for (const f of ROOF_REPORT_FIELDS) {
    assert(!f.label.includes("—"), `em dash in label ${f.key}`);
    assert(!(f.help || "").includes("—"), `em dash in help ${f.key}`);
    for (const o of f.options || []) {
      assert(!o.includes("—"), `em dash in option ${f.key}:${o}`);
    }
  }
});

Deno.test("storey pricing: locked 2026-07-16 figures, single vs double", () => {
  const single = roofReportPrice(STOREY_SINGLE);
  assertEquals(single, {
    storey: "single",
    storey_label: STOREY_SINGLE,
    ex_gst: 250,
    inc_gst: 275,
  });
  const double = roofReportPrice(STOREY_DOUBLE);
  assertEquals(double, {
    storey: "double",
    storey_label: STOREY_DOUBLE,
    ex_gst: 350,
    inc_gst: 385,
  });
});

Deno.test("normaliseStorey: tolerant of casing/synonyms, null on unknown", () => {
  assertEquals(normaliseStorey("Single Storey"), "single");
  assertEquals(normaliseStorey("single"), "single");
  assertEquals(normaliseStorey("1"), "single");
  assertEquals(normaliseStorey("one storey"), "single");
  assertEquals(normaliseStorey("Double Storey"), "double");
  assertEquals(normaliseStorey("two"), "double");
  assertEquals(normaliseStorey("2"), "double");
  assertEquals(normaliseStorey(""), null);
  assertEquals(normaliseStorey("triple"), null);
  assertEquals(normaliseStorey(undefined), null);
});

Deno.test("roofReportPrice: throws rather than guessing an unknown storey", () => {
  assertThrows(() => roofReportPrice(""), Error, "storey required");
  assertThrows(() => roofReportPrice("mansion"), Error, "storey required");
});

Deno.test("validateRoofReportForSubmit: requires required fields + a resolvable storey", () => {
  // Empty bag -> all required fields flagged.
  const empty = validateRoofReportForSubmit({});
  assertEquals(empty.ok, false);
  assert(
    empty.errors.some((e) => e.includes("storeys".length ? "storeys" : "")) ||
      empty.errors.length >= 3,
  );

  // Complete required fields.
  const ok = validateRoofReportForSubmit({
    inspection_date: "2026-07-20",
    inspected_by: "Sam Trade",
    storeys: STOREY_DOUBLE,
  });
  assertEquals(ok.ok, true);
  assertEquals(ok.errors.length, 0);

  // A present-but-unrecognised storey is a distinct error.
  const badStorey = validateRoofReportForSubmit({
    inspection_date: "2026-07-20",
    inspected_by: "Sam Trade",
    storeys: "penthouse",
  });
  assertEquals(badStorey.ok, false);
  assert(badStorey.errors.some((e) => e.toLowerCase().includes("storeys")));
});

Deno.test("sanitiseRoofReportFields: drops unknown + photo keys, keeps text fields", () => {
  const out = sanitiseRoofReportFields({
    inspected_by: "Sam",
    storeys: STOREY_SINGLE,
    roof_type: "Colorbond",
    photos: [{ url: "x" }], // photos handled separately, never in the text bag
    evil_key: "drop me",
  });
  assertEquals(out, {
    inspected_by: "Sam",
    storeys: STOREY_SINGLE,
    roof_type: "Colorbond",
  });
});

Deno.test("sanitiseRoofPhotosMeta: keeps url+label+contentType, strips base64 bytes, caps count", () => {
  const meta = sanitiseRoofPhotosMeta([
    {
      url: "https://x/1.jpg",
      label: "Ridge cap",
      contentType: "image/jpeg",
      bytesBase64: "AAAA",
    },
    { label: "no url" }, // dropped: no URL to resolve later
    { url: "https://x/2.jpg" },
  ]);
  assertEquals(meta.length, 2);
  assertEquals(meta[0], {
    url: "https://x/1.jpg",
    label: "Ridge cap",
    contentType: "image/jpeg",
  });
  assert(!("bytesBase64" in meta[0]), "base64 bytes must never be persisted");
  // Cap.
  const many = sanitiseRoofPhotosMeta(
    Array.from({ length: 30 }, (_, i) => ({ url: `u${i}` })),
    20,
  );
  assertEquals(many.length, 20);
});

Deno.test("buildRoofReportJob: maps fields + computes fee from storey; draft with no storey leaves fee undefined", () => {
  const meta = { ref: "MLB-1 / SWMS-2", address: "1 A St, Perth" };
  const job = buildRoofReportJob(
    {
      storeys: STOREY_DOUBLE,
      roof_type: "Terracotta Tiles",
      water_leak: true,
      overall_findings: "Roof in fair condition.",
    },
    meta,
    [{ url: "https://x/1.jpg", label: "Ridge" }],
  );
  assertEquals(job.ref, "MLB-1 / SWMS-2");
  assertEquals(job.storeys, STOREY_DOUBLE);
  assertEquals(job.price_ex_gst, 350);
  assertEquals(job.price_inc_gst, 385);
  assertEquals(job.roof_type, "Terracotta Tiles");
  assertEquals((job.photos as any[]).length, 1);

  // Draft with no storey: no fee, but still builds.
  const draftJob = buildRoofReportJob({ roof_type: "Colorbond" }, meta, []);
  assertEquals(draftJob.price_inc_gst, undefined);
  assertEquals(draftJob.roof_type, "Colorbond");
});
