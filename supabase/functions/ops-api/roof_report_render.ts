// SecureWorks own-letterhead Roof Report (Wave 3) -- server-side roof-report PDF
// renderer. Mirrors makesafe_report_render.ts (TS/jsPDF via
// https://esm.sh/jspdf@2.5.1, the same import completion-pack and the make-safe
// report renderer use). The make-safe skill's render_makesafe_report.py is the
// layout ancestor; this is the roof-report sibling.
//
// This module renders bytes only. It does NOT upload, send, authorise, or touch
// any live system -- the ops-api action that calls it owns attachment + state.
//
// The look is the shared SecureWorks report design (report_design.ts): hero
// with the property as the headline, key facts card (Job reference, Property,
// Site contact, Inspection date, Inspected by, Weather, Number of storeys;
// Report fee inc GST only when include_report_fee is not false, since
// trade-visible attaches omit the fee), Property Details and Roof Findings
// grids, Maintenance, Scope of Inspection, then a labelled photo gallery.
// The content, field set, hash, limits and file name are unchanged by the look.
//
// Colours: orange #F15A29, dark #293C46, mid #4C6A7C, light #F0F4F7.

import {
  type GalleryPhoto,
  ReportCanvas,
  type ReportImage,
  reportImageFormat,
} from "./report_design.ts";

// ── Pure helpers (exported for unit tests; no jsPDF / no network) ──

export interface RoofReportPhoto {
  bytesBase64?: string;
  contentType?: string;
  url?: string;
  // Small copy for the evidence grid; the full photo stays on the job.
  thumbUrl?: string;
  label?: string;
}

export interface RoofReportJob {
  ref: string;
  address: string;
  contact?: string;
  client?: string;
  job_number?: string;
  inspection_date?: string;
  inspection_time?: string;
  inspected_by?: string;
  weather?: string;
  construction_type?: string;
  storeys?: string;
  property_condition?: string;
  roof_type?: string;
  roof_pitch?: string;
  roof_profile_correct?: boolean | string;
  gutters_serviceable?: boolean | string;
  gutters_notes?: string;
  roof_condition?: string;
  services_penetrations?: string;
  storm_openings?: boolean | string;
  storm_openings_notes?: string;
  water_leak?: boolean | string;
  leak_cause?: string;
  overall_findings?: string;
  maintenance_issues?: string;
  maintenance_recommendation?: string;
  maintenance_details?: string;
  scope_summary?: string;
  price_ex_gst?: number;
  price_inc_gst?: number;
  // Office / invoice letterhead may show the locked client report fee.
  // Trade-visible attaches set this false so allocated / makesafe_open
  // viewers get the report content without the fee row.
  include_report_fee?: boolean;
  photos?: RoofReportPhoto[];
  photo_limit?: number;
}

// slug() mirrors the make-safe renderer: collapse any run of non-alphanumerics
// to '-', trim leading/trailing '-', cap at 90 chars, fall back to 'roof-report'
// when empty.
export function slug(text: unknown): string {
  const s = String(text ?? "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return s || "roof-report";
}

// The close-out filename. Contains the lowercased phrase 'roof inspection report'
// so a doc classifier keying on the file name treats it as the roof report PDF
// (distinct from the make-safe 'make safe report' token).
export function roofReportFileName(ref: unknown, address: unknown): string {
  return `Roof Inspection Report - ${slug(ref)} - ${slug(address)}.pdf`;
}

// Normalise a Yes/No toggle value to display text. Accepts booleans, 'yes'/'no',
// 'true'/'false', 1/0. Returns '' for unset so an unanswered toggle renders '-'.
export function yesNo(v: unknown): string {
  if (v === undefined || v === null || String(v).trim() === "") return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  const s = String(v).trim().toLowerCase();
  if (s === "yes" || s === "true" || s === "1" || s === "y") return "Yes";
  if (s === "no" || s === "false" || s === "0" || s === "n") return "No";
  return String(v);
}

// Strip the client report fee from a render job so a trade-visible PDF can
// keep the inspection content without the locked $275/$385 fee row.
export function omitRoofReportFee<T extends RoofReportJob>(job: T): T {
  const next = { ...job, include_report_fee: false };
  delete next.price_ex_gst;
  delete next.price_inc_gst;
  return next;
}

export function roofReportIncludesFee(job: Pick<RoofReportJob, "include_report_fee" | "price_inc_gst">): boolean {
  return job.include_report_fee !== false && job.price_inc_gst != null;
}

// Header KV rows. The Report fee line is office-only; trade-visible renders
// keep storeys and drop the fee.
export function roofReportHeaderRows(job: RoofReportJob): Array<[string, string]> {
  const attendance = sanitiseText(
    `${job.inspection_date || "to confirm"}${
      job.inspection_time ? " " + job.inspection_time : ""
    }`,
  ).trim();
  const rows: Array<[string, string]> = [
    ["Job reference", String(job.ref || "")],
    ["Property", String(job.address || "")],
    ["Site contact", String(job.contact || job.client || "")],
    ["Inspection date", attendance],
    ["Inspected by", String(job.inspected_by || "")],
    ["Weather", String(job.weather || "")],
    ["Number of storeys", String(job.storeys || "")],
  ];
  if (roofReportIncludesFee(job)) {
    const feeLine = `${formatAud(job.price_inc_gst)} inc GST${
      job.storeys ? " (" + sanitiseText(job.storeys) + ")" : ""
    }`;
    rows.push(["Report fee", feeLine]);
  }
  return rows;
}

// Format an AUD money value for the report fee line.
export function formatAud(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return "$" + v.toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Stable text serialisation of the render-relevant job fields, used for the
// render hash. Photos contribute their length/type/label only (not raw bytes) so
// the hash is cheap and stable across base64 re-encodings of identical content.
export function roofReportHashInput(job: RoofReportJob): string {
  const photos = (job.photos || []).map((p) => ({
    len: (p.bytesBase64 || "").length,
    ct: p.contentType || "",
    url: p.url || "",
    thumb: p.thumbUrl || "",
    label: p.label || "",
  }));
  return JSON.stringify({
    ref: job.ref || "",
    address: job.address || "",
    contact: job.contact || "",
    client: job.client || "",
    job_number: job.job_number || "",
    inspection_date: job.inspection_date || "",
    inspection_time: job.inspection_time || "",
    inspected_by: job.inspected_by || "",
    weather: job.weather || "",
    construction_type: job.construction_type || "",
    storeys: job.storeys || "",
    property_condition: job.property_condition || "",
    roof_type: job.roof_type || "",
    roof_pitch: job.roof_pitch || "",
    roof_profile_correct: yesNo(job.roof_profile_correct),
    gutters_serviceable: yesNo(job.gutters_serviceable),
    roof_condition: job.roof_condition || "",
    services_penetrations: job.services_penetrations || "",
    storm_openings: yesNo(job.storm_openings),
    water_leak: yesNo(job.water_leak),
    leak_cause: job.leak_cause || "",
    overall_findings: job.overall_findings || "",
    maintenance_issues: job.maintenance_issues || "",
    maintenance_recommendation: job.maintenance_recommendation || "",
    maintenance_details: job.maintenance_details || "",
    scope_summary: job.scope_summary || "",
    price_ex_gst: job.include_report_fee === false ? "" : (job.price_ex_gst ?? ""),
    price_inc_gst: job.include_report_fee === false ? "" : (job.price_inc_gst ?? ""),
    include_report_fee: job.include_report_fee !== false,
    photo_limit: job.photo_limit ?? DEFAULT_REPORT_PHOTO_LIMIT,
    photos,
  });
}

// sha-256 of the serialised job text. Async (Web Crypto, present in Deno).
export async function renderHash(job: RoofReportJob): Promise<string> {
  const data = new TextEncoder().encode(roofReportHashInput(job));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Normalise em/en dashes to '-' (house rule: no em dashes in outbound copy) and
// strip CRLF jsPDF chokes on.
export function sanitiseText(text: unknown): string {
  return String(text ?? "")
    .replace(/—/g, "-")
    .replace(/–/g, "-")
    .replace(/\r\n/g, "\n");
}

// ── Renderer (async; imports jsPDF lazily, like the make-safe renderer) ──

// 2026-09-08: all photos on the visit go in (Marnin). About six per page.
const DEFAULT_REPORT_PHOTO_LIMIT = 200;
const MAX_REPORT_PHOTO_LIMIT = 200;

const REPORT_TITLE = "Roof Inspection Report";

export function aspectFitBox(
  sourceW: number,
  sourceH: number,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
): { x: number; y: number; w: number; h: number } {
  const sw = Number(sourceW);
  const sh = Number(sourceH);
  if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw <= 0 || sh <= 0) {
    return { x: boxX, y: boxY, w: boxW, h: boxH };
  }
  const scale = Math.min(boxW / sw, boxH / sh);
  const w = sw * scale;
  const h = sh * scale;
  return { x: boxX + (boxW - w) / 2, y: boxY + (boxH - h) / 2, w, h };
}

// A photo the renderer holds ready to draw. Fetched photos stay as raw bytes:
// jsPDF takes a Uint8Array, so no base64 copy of every photo is built.
interface ResolvedRoofPhoto {
  data: Uint8Array | string;
  contentType: string;
  label?: string;
}

async function resolvePhotoBytes(
  p: RoofReportPhoto,
): Promise<ResolvedRoofPhoto | null> {
  if (p?.bytesBase64) {
    const ct = p.contentType || "image/jpeg";
    const png = ct.toLowerCase().includes("png");
    return {
      data: `data:${png ? "image/png" : "image/jpeg"};base64,${p.bytesBase64}`,
      contentType: ct,
      label: p.label,
    };
  }
  const src = p?.thumbUrl || p?.url;
  if (!src) return null;
  try {
    let resp = await fetch(src);
    if (!resp.ok && p?.thumbUrl && p?.url && src !== p.url) resp = await fetch(p.url);
    if (!resp.ok) return null;
    return {
      data: new Uint8Array(await resp.arrayBuffer()),
      contentType: resp.headers.get("content-type") || p.contentType ||
        "image/jpeg",
      label: p.label,
    };
  } catch {
    return null;
  }
}

export interface RenderedReport {
  bytes: Uint8Array;
  fileName: string;
  renderHash: string;
}

export async function renderRoofReportPdf(
  job: RoofReportJob,
): Promise<RenderedReport> {
  if (!job?.ref) throw new Error("renderRoofReportPdf: job.ref required");
  if (!job?.address) {
    throw new Error("renderRoofReportPdf: job.address required");
  }

  const fileName = roofReportFileName(job.ref, job.address);
  const hash = await renderHash(job);

  const { jsPDF } = await import("https://esm.sh/jspdf@2.5.1");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  const canvas = new ReportCanvas(doc, {
    kind: REPORT_TITLE,
    title: sanitiseText(job.address),
    subtitle: sanitiseText(`Job reference ${job.ref}`).slice(0, 128),
    reference: sanitiseText(job.ref).slice(0, 60),
    tagline: "Outdoor living and make safe",
  });
  canvas.hero({ overlap: true });
  canvas.facts(
    roofReportHeaderRows(job).map(([label, value]) => ({
      label,
      value: sanitiseText(value),
    })),
    3,
  );

  const kv = (rows: Array<[string, string]>, columns = 2): void =>
    canvas.kvGrid(rows.map(([k, v]) => [k, sanitiseText(v)]), columns);

  // A bold lead-in followed by the trade's own words, verbatim.
  const labelledPara = (label: string, text: unknown): void => {
    const clean = sanitiseText(String(text ?? "")).trim();
    if (!clean) return;
    canvas.lead(label);
    canvas.paragraph(clean);
  };

  canvas.section("Property Details", 30);
  kv([
    ["Construction type", String(job.construction_type || "")],
    ["Property condition", String(job.property_condition || "")],
    ["Roof type", String(job.roof_type || "")],
    ["Roof pitch", String(job.roof_pitch || "")],
    ["Roof profile correct", yesNo(job.roof_profile_correct)],
    ["Gutters/valleys/downpipes serviceable", yesNo(job.gutters_serviceable)],
    ["Roof condition", String(job.roof_condition || "")],
    ["Services / penetrations", String(job.services_penetrations || "")],
  ]);
  labelledPara("Gutters, valleys and downpipes", job.gutters_notes);

  // Roof Findings: the Yes/No block + leak cause + narrative.
  canvas.section("Roof Findings", 22);
  kv([
    ["Storm-created openings in roof", yesNo(job.storm_openings)],
    ["Water leak through roof", yesNo(job.water_leak)],
  ]);
  canvas.gap(-4);
  kv([["Cause of water leak", String(job.leak_cause || "")]], 1);
  labelledPara("Storm-created openings", job.storm_openings_notes);
  labelledPara("Roof condition and findings", job.overall_findings || "");

  // Maintenance.
  canvas.section("Maintenance", 16);
  kv([
    [
      "Maintenance recommended / required",
      String(job.maintenance_recommendation || ""),
    ],
  ], 1);
  const maint = [
    job.maintenance_issues ? `Issues present: ${job.maintenance_issues}` : "",
    job.maintenance_details ? `Details: ${job.maintenance_details}` : "",
  ].filter(Boolean).join("\n\n");
  canvas.paragraph(sanitiseText(maint) || "-");

  // Scope of Inspection (prose).
  canvas.section("Scope of Inspection", 10);
  canvas.paragraph(sanitiseText(job.scope_summary || "") || "-");

  // Photo evidence: a labelled gallery, caption = the photo label when supplied.
  const limit = Number.isFinite(job.photo_limit as number)
    ? Math.max(0, Math.floor(job.photo_limit as number))
    : DEFAULT_REPORT_PHOTO_LIMIT;
  const resolved: ResolvedRoofPhoto[] = [];
  for (
    const p of (job.photos || []).slice(
      0,
      Math.min(limit, MAX_REPORT_PHOTO_LIMIT),
    )
  ) {
    const r = await resolvePhotoBytes(p);
    if (r) resolved.push(r);
  }
  if (resolved.length === 0) {
    canvas.section("Photo Evidence", 8);
    canvas.note("No usable photo evidence was available for this report.");
  } else {
    // 2026-09-08: about six per page so a 137-photo visit is a couple of dozen
    // pages of thumbnails, not 69 pages of full-size images.
    const photos: GalleryPhoto[] = resolved.map((p, i) => {
      const image: ReportImage = {
        data: p.data,
        format: reportImageFormat(
          p.data instanceof Uint8Array ? p.data : null,
          p.contentType,
        ),
        alias: `roof-photo-${i + 1}`,
      };
      return {
        image,
        // The trade-supplied label wins; fall back to a numbered caption so an
        // unlabelled photo still reads.
        caption: sanitiseText(p.label).trim() || `Photo evidence ${i + 1}`,
        fallback: `Photo evidence ${i + 1} (could not embed)`,
      };
    });
    canvas.section(`Photo Evidence (${resolved.length})`, 80);
    canvas.gallery(photos, { targetH: 64 });
  }

  canvas.finish();

  const out = doc.output("arraybuffer") as ArrayBuffer;
  return { bytes: new Uint8Array(out), fileName, renderHash: hash };
}
