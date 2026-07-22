#!/usr/bin/env -S deno run --allow-net --allow-write
// Regenerates the roof-report sample PDF from fixture data (PR evidence).
// The rendered PDF is gitignored (repo policy: no *.pdf in git); this script is
// the reproducible source of that evidence.
//
// Run from the repo root:
//   deno run --allow-net --allow-write \
//     scripts/render-roof-report-sample.ts [out.pdf]
//
// Verified output (2026-07-22): 4 pages, "Double Storey $385.00 inc GST",
// file name "Roof Inspection Report - MLB-17270PO-54939-SWMS-26861 - Caversham-WA.pdf",
// no em dashes in the rendered bytes.

import { renderRoofReportPdf } from "../supabase/functions/ops-api/roof_report_render.ts";
import {
  buildRoofReportJob,
  roofReportPrice,
} from "../supabase/functions/ops-api/roof_report_template.ts";

// Fixture: a SWMS-26861-style strata roof report (Caversham / MLB).
const fields = {
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
  services_penetrations: "Solar panels, gas hot water flue, TV aerial",
  storm_openings: false,
  water_leak: true,
  leak_cause: "Cracked ridge capping above the master bedroom.",
  overall_findings:
    "The roof is in fair condition for its age. Localised damage was observed over the master bedroom, consistent with the reported storm event. The balance of the roof presented no active water entry at the time of inspection.",
  maintenance_issues: "Minor lifting of tiles on the southern face.",
  maintenance_recommendation: "Recommended",
  maintenance_details:
    "Re-bed and re-point the full ridge line and replace three cracked tiles on the southern face.",
  scope_summary:
    "Full external roof inspection following the storm claim, including ridge, valleys, gutters and penetrations.",
};
const meta = {
  ref: "MLB-17270PO-54939 / SWMS-26861",
  address: "Caversham WA",
  contact: "Major Loss Builders",
};
// A 1x1 PNG stands in for on-site photos so the script needs no fixture assets.
const onePx =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const photos = [
  {
    bytesBase64: onePx,
    contentType: "image/png",
    label: "Front elevation and roof line",
  },
  {
    bytesBase64: onePx,
    contentType: "image/png",
    label: "Cracked ridge capping above master bedroom",
  },
  {
    bytesBase64: onePx,
    contentType: "image/png",
    label: "Southern face - lifted tiles",
  },
];

const price = roofReportPrice(fields.storeys);
const job = buildRoofReportJob(fields, meta, photos);
const rendered = await renderRoofReportPdf(job as never);

const out = Deno.args[0] || "docs/evidence/roof-report-sample-fixture.pdf";
await Deno.writeFile(out, rendered.bytes);
const pages =
  (new TextDecoder().decode(rendered.bytes).match(/\/Type\s*\/Page\b/g) || [])
    .length;
console.log("wrote:", out);
console.log("file_name:", rendered.fileName);
console.log("bytes:", rendered.bytes.length, "pages:", pages);
console.log("fee:", price.storey_label, "$" + price.inc_gst + " inc GST");
