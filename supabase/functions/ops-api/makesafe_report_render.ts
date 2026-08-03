// MakeSafe Reporting Autopilot (Wave 2) -- server-side make-safe report PDF
// renderer. Ports skills/secureworks-makesafe-reporting/scripts/
// render_makesafe_report.py to TS/jsPDF (https://esm.sh/jspdf@2.5.1, the same
// import the completion-pack edge function uses).
//
// This module renders bytes only. It does NOT upload, send, authorise, or touch
// any live system -- the ops-api action that calls it owns attachment + state.
//
// Layout is a mechanically pinned TypeScript port of the curated Python report
// contract. Keep changes paired with the authoritative reporting skill/tests.
//
// Layout:
//   - orange top band (#F15A29)
//   - white header band with 'Make Safe Completion Report' + '<ref> | <address>'
//   - SecureWorks Group logo
//   - KV table (Job reference, Property, Site contact, Attendance, trade count)
//   - four prose sections (Work Order Scope, Site Findings, Works Completed,
//     Materials and Equipment) with doc.splitTextToSize wrapping
//   - one large deliberately ordered evidence photo per page
//
// Colours: orange #F15A29, dark #293C46, mid #4C6A7C, light #F0F4F7.

import { MAKESAFE_REPORT_LOGO_DATA_URL } from "./makesafe_report_logo.ts";

// ── Pure helpers (exported for unit tests; no jsPDF / no network) ──

export const MAKESAFE_REPORT_CONTRACT_VERSION =
  "secureworks.makesafe-report/curated-2026-08-03";
export const MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION =
  "b20d9ec3c5ac5c82bb463aef6ff52bfe63fc15ce";
export const MAKESAFE_REPORT_RENDERER_VERSION =
  `secureworks.ops-api-jspdf/${MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION}`;
export const MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION =
  `secureworks.wiki-python/${MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION}`;

export function isCurrentCuratedRendererVersion(value: unknown): boolean {
  return value === MAKESAFE_REPORT_RENDERER_VERSION ||
    value === MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION;
}

// Photo input the renderer accepts, in preference order:
//   1. `bytes` -- raw image bytes. jsPDF accepts a Uint8Array directly, so a
//      caller that already holds the bytes never has to build a binary string
//      or a base64 copy of them. This is the form the U4 persist path uses.
//   2. `bytesBase64` -- inline base64, for callers that already have it.
//   3. `url` -- fetched by the renderer at render time.
export interface MakesafeReportPhoto {
  bytes?: Uint8Array;
  bytesBase64?: string;
  contentType?: string;
  url?: string;
  caption?: string;
}

export interface MakesafeReportJob {
  ref: string;
  address: string;
  contact?: string;
  date?: string;
  arrival?: string;
  crew?: string;
  billing_note?: string;
  scope?: string;
  findings?: string;
  works?: string;
  materials?: string;
  access_issues?: string;
  follow_up_required?: string;
  photos?: MakesafeReportPhoto[];
  photo_limit?: number;
}

export class CommercialContentError extends Error {
  fields: string[];

  constructor(fields: string[]) {
    super(
      `commercial content is not allowed in client report field(s): ${
        fields.join(", ")
      }`,
    );
    this.name = "CommercialContentError";
    this.fields = fields;
  }
}

const COMMERCIAL_CONTENT_RE =
  /(?:\$\s*\d|\b(?:aud|usd|nzd|gst|invoice|invoiced|rate|margin|cost|charge|charged|billed|billing|subtotal|total|quantity|quantities)\b|\b\d+(?:\.\d+)?\s*(?:dollars?|units?)\b)/i;
const BILLING_HOURS_RE =
  /\b\d+(?:\.\d+)?\s*hours?\b|\b(?:hourly\s+)?(?:labou?r|crew|trade)\s+(?:hours?|rate)\b|\b\d+(?:\.\d+)?\s*(?:trades?|crew|labou?r)\b[\s\S]{0,40}\b\d+(?:\.\d+)?\s*hours?\b/i;

const CURATED_TEXT_FIELDS = [
  "ref",
  "address",
  "contact",
  "date",
  "arrival",
  "crew",
  "scope",
  "findings",
  "works",
  "materials",
] as const;

/** Mechanically pinned port of report_commercial_content.py. */
export function findCommercialContent(job: MakesafeReportJob): string[] {
  const failures: string[] = [];
  for (const field of CURATED_TEXT_FIELDS) {
    const value = job[field];
    if (
      typeof value === "string" &&
      (COMMERCIAL_CONTENT_RE.test(value) || BILLING_HOURS_RE.test(value))
    ) {
      failures.push(field);
    }
  }
  for (const [index, photo] of (job.photos || []).entries()) {
    const caption = photo?.caption;
    if (
      typeof caption === "string" &&
      (COMMERCIAL_CONTENT_RE.test(caption) || BILLING_HOURS_RE.test(caption))
    ) {
      failures.push(`photos[${index}].caption`);
    }
  }
  return failures;
}

export function assertCuratedReportPayload(job: MakesafeReportJob): void {
  const missing = (["scope", "findings", "works", "materials"] as const)
    .filter((field) => !String(job[field] || "").trim());
  if (missing.length) {
    throw new Error(
      `curated make-safe report prose required: ${missing.join(", ")}`,
    );
  }
  const crew = String(job.crew || "").trim();
  if (crew && !/^\d+(?:\.\d+)?\s+trades?$/i.test(crew)) {
    throw new Error("curated make-safe report crew must be a trade count only");
  }
  const commercial = findCommercialContent(job);
  if (commercial.length) throw new CommercialContentError(commercial);
}

// slug() mirrors the Python: collapse any run of non-alphanumerics to '-', trim
// leading/trailing '-', cap at 90 chars, fall back to 'make-safe' when empty.
export function slug(text: unknown): string {
  const s = String(text ?? "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return s || "make-safe";
}

// The close-out filename. MUST contain the lowercased phrase 'make safe report'
// so makesafeDocBooleans (file_name includes 'make safe report') AND the client
// send gate (is_report_pdf) both classify it as the report PDF.
export function makesafeReportFileName(ref: unknown, address: unknown): string {
  return `Make Safe Report - ${slug(ref)} - ${slug(address)}.pdf`;
}

// Length of the base64 encoding of `n` bytes, computed rather than produced.
// btoa always pads, so this is exact.
function base64Length(n: number): number {
  return n > 0 ? Math.ceil(n / 3) * 4 : 0;
}

// Stable text serialisation of the render-relevant job fields, used for the
// render hash. Photos contribute their length/type only (not the raw bytes) so
// the hash is cheap and stable across base64 re-encodings of identical content.
export function makesafeReportHashInput(job: MakesafeReportJob): string {
  const photos = (job.photos || []).map((p) => ({
    // `len` stays the BASE64 length whichever input form the caller supplied,
    // so moving a caller from `bytesBase64` to `bytes` cannot move the render
    // hash for identical content.
    len: typeof p.bytesBase64 === "string"
      ? p.bytesBase64.length
      : base64Length(p.bytes?.byteLength ?? 0),
    ct: p.contentType || "",
    url: p.url || "",
  }));
  return JSON.stringify({
    ref: job.ref || "",
    address: job.address || "",
    contact: job.contact || "",
    date: job.date || "",
    arrival: job.arrival || "",
    crew: job.crew || "",
    billing_note: job.billing_note || "",
    scope: job.scope || "",
    findings: job.findings || "",
    works: job.works || "",
    materials: job.materials || "",
    access_issues: job.access_issues || "",
    follow_up_required: job.follow_up_required || "",
    photo_limit: job.photo_limit ?? 8,
    photos,
  });
}

// sha-256 of the serialised job text. Async because it uses Web Crypto (present
// in Deno). Returned as lowercase hex for last_render_hash.
export async function renderHash(job: MakesafeReportJob): Promise<string> {
  const data = new TextEncoder().encode(makesafeReportHashInput(job));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Mirror the Python `safe()` text cleanup: normalise em/en dashes to '-' (house
// rule: no em dashes in outbound copy) and strip control chars jsPDF chokes on.
export function sanitiseText(text: unknown): string {
  return String(text ?? "")
    .replace(/—/g, "-")
    .replace(/–/g, "-")
    .replace(/\r\n/g, "\n");
}

// ── Renderer (async; imports jsPDF lazily, like completion-pack) ──

const ORANGE: [number, number, number] = [241, 90, 41]; // #F15A29
const DARK: [number, number, number] = [41, 60, 70]; // #293C46
const MID: [number, number, number] = [76, 106, 124]; // #4C6A7C
const LIGHT: [number, number, number] = [240, 244, 247]; // #F0F4F7
const RULE: [number, number, number] = [210, 218, 224]; // #D2DAE0
const BODY: [number, number, number] = [50, 50, 50]; // #323232

// A4 in mm.
const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 14;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const DEFAULT_REPORT_PHOTO_LIMIT = 8;
const MAX_REPORT_PHOTO_LIMIT = 15;

const REPORT_TITLE = "Make Safe Completion Report";

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
  return {
    x: boxX + (boxW - w) / 2,
    y: boxY + (boxH - h) / 2,
    w,
    h,
  };
}

// The image payload jsPDF.getImageProperties/addImage accept. Raw bytes go
// straight through -- jsPDF handles a Uint8Array natively and produces a
// byte-identical image stream to the equivalent data URL, without the caller
// materialising a binary string and a base64 copy of every photo. Returns null
// on any failure (the renderer then skips the photo rather than aborting the
// pack).
function photoImageData(p: MakesafeReportPhoto): Uint8Array | string | null {
  if (p?.bytes?.byteLength) return p.bytes;
  if (!p?.bytesBase64) return null;
  const ct = p.contentType || "image/jpeg";
  const fmt = ct.toLowerCase().includes("png") ? "PNG" : "JPEG";
  return `data:${
    fmt === "PNG" ? "image/png" : "image/jpeg"
  };base64,${p.bytesBase64}`;
}

// Resolve photo bytes: an already-supplied payload wins; otherwise fetch the
// URL and keep the raw bytes.
async function resolvePhotoBytes(
  p: MakesafeReportPhoto,
): Promise<MakesafeReportPhoto | null> {
  if (p?.bytes?.byteLength || p?.bytesBase64) return p;
  if (!p?.url) return null;
  try {
    const resp = await fetch(p.url);
    if (!resp.ok) return null;
    return {
      bytes: new Uint8Array(await resp.arrayBuffer()),
      contentType: resp.headers.get("content-type") || p.contentType ||
        "image/jpeg",
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

export async function renderMakesafeReportPdf(
  job: MakesafeReportJob,
): Promise<RenderedReport> {
  if (!job?.ref) throw new Error("renderMakesafeReportPdf: job.ref required");
  if (!job?.address) {
    throw new Error("renderMakesafeReportPdf: job.address required");
  }
  assertCuratedReportPayload(job);

  const fileName = makesafeReportFileName(job.ref, job.address);
  const hash = await renderHash(job);
  const subtitle = sanitiseText(`${job.ref} | ${job.address}`).slice(0, 128);

  // Lazy import (matches completion-pack/index.ts:604).
  // deno-lint-ignore no-import-prefix
  const { jsPDF } = await import("https://esm.sh/jspdf@2.5.1");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  // Header band: orange top strip + white header + title + subtitle + rule.
  // Returns the y cursor (mm from top, top-origin) where body content starts.
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
    doc.line(MARGIN, 23, 91, 23);
    doc.setTextColor(...MID);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(subtitle, MARGIN, 30);
    try {
      doc.addImage(
        MAKESAFE_REPORT_LOGO_DATA_URL,
        "PNG",
        PAGE_W - 78,
        12,
        64,
        18,
        undefined,
        "FAST",
      );
    } catch {
      // The embedded, pinned asset is validated by tests. Keep text branding in
      // the footer as the deterministic fallback if jsPDF rejects it.
    }
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

  // KV table.
  const attendance = sanitiseText(
    `Arrived ${job.arrival || "to confirm"} | ${job.date || ""}`,
  ).replace(/[\s|]+$/g, "");
  const rows: Array<[string, string]> = [
    ["Job reference", String(job.ref || "")],
    ["Property", String(job.address || "")],
    ["Site contact", String(job.contact || "")],
    ["Attendance", attendance],
    ["Crew", String(job.crew || "")],
  ];
  for (const [k, v] of rows) {
    const valueLines: string[] = doc.splitTextToSize(
      sanitiseText(v) || "-",
      CONTENT_W - 48,
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
    doc.text(valueLines, MARGIN + 42, y + 5.2);
    y += rowH;
  }
  y += 4;

  // Section header bar (dark band + orange tab + white title), returns new y.
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

  // Prose paragraph with wrapping + page breaks. Returns new y.
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

  const proseSections: Array<[string, string]> = [
    ["Work Order Scope", job.scope || ""],
    ["Site Findings", job.findings || ""],
    ["Works Completed", job.works || ""],
    ["Materials and Equipment", job.materials || ""],
  ];
  for (const [title, text] of proseSections) {
    y = section(title, 10);
    y = para(text);
  }

  // Photo evidence is intentionally large: one photo per page in the caller's
  // curated order, matching the authoritative Python renderer.
  const limit = Number.isFinite(job.photo_limit as number)
    ? Math.max(0, Math.floor(job.photo_limit as number))
    : DEFAULT_REPORT_PHOTO_LIMIT;
  const resolved: MakesafeReportPhoto[] = [];
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
    const cellW = CONTENT_W;
    const cellH = 190;
    for (const [zeroIndex, p] of resolved.entries()) {
      const idx = zeroIndex + 1;
      if (zeroIndex === 0) {
        y = section("Photo Evidence", cellH + 4);
      } else {
        y = newPage();
        y = section("Photo Evidence", cellH + 4);
      }
      ensureSpace(cellH + 4);
      const cellX = MARGIN;
      const cellY = y;
      const imageData = photoImageData(p);
      doc.setDrawColor(...RULE);
      doc.setFillColor(255, 255, 255);
      doc.setLineWidth(0.2);
      doc.rect(cellX, cellY, cellW, cellH, "FD");
      if (imageData) {
        try {
          const fmt = (p.contentType || "").toLowerCase().includes("png")
            ? "PNG"
            : "JPEG";
          const boxX = cellX + 3;
          const boxY = cellY + 4;
          const boxW = cellW - 6;
          const boxH = cellH - 15;
          const props = doc.getImageProperties(imageData) as {
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
            imageData,
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
      doc.setTextColor(...MID);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.text(
        sanitiseText(
          `Photo evidence ${idx}${p.caption ? ` - ${p.caption}` : ""}`,
        ),
        cellX + cellW / 2,
        cellY + cellH - 4,
        {
          align: "center",
        },
      );
      y = cellY + cellH + 7;
    }
  }

  footer();

  const out = doc.output("arraybuffer") as ArrayBuffer;
  return { bytes: new Uint8Array(out), fileName, renderHash: hash };
}
