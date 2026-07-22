// SecureWorks own-letterhead Roof Report (Wave 3) -- server-side roof-report PDF
// renderer. Mirrors makesafe_report_render.ts (TS/jsPDF via
// https://esm.sh/jspdf@2.5.1, the same import completion-pack and the make-safe
// report renderer use). The make-safe skill's render_makesafe_report.py is the
// layout ancestor; this is the roof-report sibling.
//
// This module renders bytes only. It does NOT upload, send, authorise, or touch
// any live system -- the ops-api action that calls it owns attachment + state.
//
// Layout (mirrors the make-safe report chrome, roof-report content):
//   - orange top band (#F15A29)
//   - white header band with 'Roof Inspection Report' + '<ref> | <address>'
//   - KV table (Job reference, Property, Site contact, Inspection date,
//     Inspected by, Weather, Number of storeys, Report fee inc GST)
//   - Property Details KV grid + Roof Findings Yes/No block
//   - prose sections (Scope of Inspection, Roof Condition and Findings,
//     Maintenance) with doc.splitTextToSize wrapping
//   - labelled photo evidence grid (two per page, caption = photo label)
//
// Colours: orange #F15A29, dark #293C46, mid #4C6A7C, light #F0F4F7.

// ── Pure helpers (exported for unit tests; no jsPDF / no network) ──

export interface RoofReportPhoto {
  bytesBase64?: string;
  contentType?: string;
  url?: string;
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
  roof_condition?: string;
  services_penetrations?: string;
  storm_openings?: boolean | string;
  water_leak?: boolean | string;
  leak_cause?: string;
  overall_findings?: string;
  maintenance_issues?: string;
  maintenance_recommendation?: string;
  maintenance_details?: string;
  scope_summary?: string;
  price_ex_gst?: number;
  price_inc_gst?: number;
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
    price_ex_gst: job.price_ex_gst ?? "",
    price_inc_gst: job.price_inc_gst ?? "",
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

const ORANGE: [number, number, number] = [241, 90, 41]; // #F15A29
const DARK: [number, number, number] = [41, 60, 70]; // #293C46
const MID: [number, number, number] = [76, 106, 124]; // #4C6A7C
const LIGHT: [number, number, number] = [240, 244, 247]; // #F0F4F7
const RULE: [number, number, number] = [210, 218, 224]; // #D2DAE0
const BODY: [number, number, number] = [50, 50, 50]; // #323232

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 14;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const DEFAULT_REPORT_PHOTO_LIMIT = 12;
const MAX_REPORT_PHOTO_LIMIT = 20;

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

function photoDataUrl(p: RoofReportPhoto): string | null {
  if (!p?.bytesBase64) return null;
  const ct = p.contentType || "image/jpeg";
  const fmt = ct.toLowerCase().includes("png") ? "PNG" : "JPEG";
  return `data:${
    fmt === "PNG" ? "image/png" : "image/jpeg"
  };base64,${p.bytesBase64}`;
}

async function resolvePhotoBytes(
  p: RoofReportPhoto,
): Promise<RoofReportPhoto | null> {
  if (p?.bytesBase64) return p;
  if (!p?.url) return null;
  try {
    const resp = await fetch(p.url);
    if (!resp.ok) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return {
      bytesBase64: btoa(bin),
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
  const subtitle = sanitiseText(`${job.ref} | ${job.address}`).slice(0, 128);

  const { jsPDF } = await import("https://esm.sh/jspdf@2.5.1");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  const header = (): number => {
    doc.setFillColor(...ORANGE);
    doc.rect(0, 0, PAGE_W, 5, "F");
    doc.setFillColor(255, 255, 255);
    doc.rect(0, 5, PAGE_W, 40, "F");
    doc.setTextColor(...DARK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(REPORT_TITLE, MARGIN, 20);
    doc.setDrawColor(...ORANGE);
    doc.setLineWidth(0.6);
    doc.line(MARGIN, 23, 78, 23);
    doc.setTextColor(...MID);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(subtitle, MARGIN, 30);
    // SecureWorks Group letterhead label, top-right.
    doc.setTextColor(...DARK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("SecureWorks Group", PAGE_W - MARGIN, 20, { align: "right" });
    doc.setTextColor(...MID);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.text("Outdoor living and make safe", PAGE_W - MARGIN, 25, {
      align: "right",
    });
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.3);
    doc.line(MARGIN, 41, PAGE_W - MARGIN, 41);
    return 52;
  };

  const footer = (): void => {
    doc.setTextColor(...MID);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    const pageNo = doc.getNumberOfPages();
    doc.text(`SecureWorks Group | Page ${pageNo}`, PAGE_W / 2, PAGE_H - 9, {
      align: "center",
    });
  };

  const newPage = (): number => {
    footer();
    doc.addPage();
    return header();
  };

  let y = header();
  const BODY_BOTTOM = PAGE_H - 18;

  const ensureSpace = (height: number): void => {
    if (y + height > BODY_BOTTOM) y = newPage();
  };

  // KV table renderer, reused for the header block and property details.
  const kvTable = (rowsIn: Array<[string, string]>): void => {
    for (const [k, v] of rowsIn) {
      const valueLines: string[] = doc.splitTextToSize(
        sanitiseText(v) || "-",
        CONTENT_W - 52,
      );
      const rowH = Math.max(8.5, 5 + valueLines.length * 4.1);
      ensureSpace(rowH);
      doc.setFillColor(...LIGHT);
      doc.setDrawColor(...RULE);
      doc.setLineWidth(0.2);
      doc.rect(MARGIN, y, CONTENT_W, rowH, "FD");
      doc.setTextColor(...MID);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.5);
      doc.text(k.toUpperCase(), MARGIN + 4, y + 5.2);
      doc.setTextColor(...DARK);
      doc.setFontSize(8.4);
      doc.text(valueLines, MARGIN + 46, y + 5.2);
      y += rowH;
    }
  };

  const attendance = sanitiseText(
    `${job.inspection_date || "to confirm"}${
      job.inspection_time ? " " + job.inspection_time : ""
    }`,
  ).trim();
  const feeLine = job.price_inc_gst != null
    ? `${formatAud(job.price_inc_gst)} inc GST${
      job.storeys ? " (" + sanitiseText(job.storeys) + ")" : ""
    }`
    : "";
  kvTable([
    ["Job reference", String(job.ref || "")],
    ["Property", String(job.address || "")],
    ["Site contact", String(job.contact || job.client || "")],
    ["Inspection date", attendance],
    ["Inspected by", String(job.inspected_by || "")],
    ["Weather", String(job.weather || "")],
    ["Number of storeys", String(job.storeys || "")],
    ["Report fee", feeLine],
  ]);
  y += 4;

  // Section header bar (dark band + orange tab + white title).
  const section = (title: string, followingHeightHint = 0): number => {
    ensureSpace(8 + 5 + Math.max(0, followingHeightHint));
    doc.setFillColor(...DARK);
    doc.rect(MARGIN, y, CONTENT_W, 8, "F");
    doc.setFillColor(...ORANGE);
    doc.rect(MARGIN, y, 2.3, 8, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.text(title, MARGIN + 6, y + 5.4);
    y += 13;
    return y;
  };

  const para = (text: string): number => {
    doc.setTextColor(...BODY);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.4);
    const clean = sanitiseText(text) || "-";
    const lines: string[] = doc.splitTextToSize(clean, CONTENT_W);
    const lineH = 4.5;
    for (const line of lines) {
      ensureSpace(lineH);
      doc.text(line, MARGIN, y);
      y += lineH;
    }
    y += 4;
    return y;
  };

  // Property Details as a KV grid.
  y = section("Property Details", 40);
  kvTable([
    ["Construction type", String(job.construction_type || "")],
    ["Property condition", String(job.property_condition || "")],
    ["Roof type", String(job.roof_type || "")],
    ["Roof pitch", String(job.roof_pitch || "")],
    ["Roof profile correct", yesNo(job.roof_profile_correct)],
    ["Gutters/valleys/downpipes serviceable", yesNo(job.gutters_serviceable)],
    ["Roof condition", String(job.roof_condition || "")],
    ["Services / penetrations", String(job.services_penetrations || "")],
  ]);
  y += 4;

  // Roof Findings: the Yes/No block + leak cause + narrative.
  y = section("Roof Findings", 20);
  kvTable([
    ["Storm-created openings in roof", yesNo(job.storm_openings)],
    ["Water leak through roof", yesNo(job.water_leak)],
    ["Cause of water leak", String(job.leak_cause || "")],
  ]);
  y += 2;
  y = para(job.overall_findings || "");

  // Maintenance.
  y = section("Maintenance", 10);
  kvTable([
    [
      "Maintenance recommended / required",
      String(job.maintenance_recommendation || ""),
    ],
  ]);
  y += 2;
  const maint = [
    job.maintenance_issues ? `Issues present: ${job.maintenance_issues}` : "",
    job.maintenance_details ? `Details: ${job.maintenance_details}` : "",
  ].filter(Boolean).join("\n\n");
  y = para(maint);

  // Scope of Inspection (prose).
  y = section("Scope of Inspection", 10);
  y = para(job.scope_summary || "");

  // Photo evidence: two per page, caption = the photo label when supplied.
  const limit = Number.isFinite(job.photo_limit as number)
    ? Math.max(0, Math.floor(job.photo_limit as number))
    : DEFAULT_REPORT_PHOTO_LIMIT;
  const resolved: RoofReportPhoto[] = [];
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
    y = section("Photo Evidence", 8);
    doc.setTextColor(...MID);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.3);
    doc.text(
      "No usable photo evidence was available for this report.",
      MARGIN,
      y,
    );
    y += 5;
  } else {
    const rows = 2;
    const gap = 5;
    const cellW = CONTENT_W;
    const cellH = 100;
    const gridH = rows * cellH + gap;
    let idx = 0;
    while (idx < resolved.length) {
      if (idx === 0) {
        y = section("Photo Evidence", gridH + 4);
      } else {
        y = newPage();
        y = section("Photo Evidence", gridH + 4);
      }
      ensureSpace(gridH + 4);
      const gridTop = y;
      for (let slot = 0; slot < rows && idx < resolved.length; slot++) {
        const p = resolved[idx];
        idx++;
        const cellX = MARGIN;
        const cellY = gridTop + slot * (cellH + gap);
        const dataUrl = photoDataUrl(p);
        doc.setDrawColor(...RULE);
        doc.setFillColor(255, 255, 255);
        doc.setLineWidth(0.2);
        doc.rect(cellX, cellY, cellW, cellH, "FD");
        if (dataUrl) {
          try {
            const fmt = (p.contentType || "").toLowerCase().includes("png")
              ? "PNG"
              : "JPEG";
            const boxX = cellX + 3;
            const boxY = cellY + 4;
            const boxW = cellW - 6;
            const boxH = cellH - 15;
            const props = doc.getImageProperties(dataUrl) as {
              width?: number;
              height?: number;
            };
            const fit = aspectFitBox(
              Number(props?.width || 0),
              Number(props?.height || 0),
              boxX,
              boxY,
              boxW,
              boxH,
            );
            doc.addImage(
              dataUrl,
              fmt,
              fit.x,
              fit.y,
              fit.w,
              fit.h,
              undefined,
              "FAST",
            );
          } catch {
            doc.setTextColor(...MID);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(8);
            doc.text(
              `Photo evidence ${idx} (could not embed)`,
              cellX + cellW / 2,
              cellY + cellH / 2,
              { align: "center" },
            );
          }
        }
        // Caption: the trade-supplied label wins; fall back to a numbered
        // caption so an unlabelled photo still reads.
        const caption = sanitiseText(p.label).trim() ||
          `Photo evidence ${idx}`;
        doc.setTextColor(...MID);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.text(caption, cellX + cellW / 2, cellY + cellH - 4, {
          align: "center",
        });
      }
      y = gridTop + gridH + 7;
    }
  }

  footer();

  const out = doc.output("arraybuffer") as ArrayBuffer;
  return { bytes: new Uint8Array(out), fileName, renderHash: hash };
}
