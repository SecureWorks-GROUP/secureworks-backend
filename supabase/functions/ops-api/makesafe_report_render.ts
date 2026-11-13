// MakeSafe Reporting Autopilot (Wave 2) -- server-side make-safe report PDF
// renderer. Ports skills/secureworks-makesafe-reporting/scripts/
// render_makesafe_report.py to TS/jsPDF (https://esm.sh/jspdf@2.5.1, the same
// import the completion-pack edge function uses).
//
// This module renders bytes only. It does NOT upload, send, authorise, or touch
// any live system -- the ops-api action that calls it owns attachment + state.
//
// The look is the shared SecureWorks report design (report_design.ts): hero
// with the property as the headline, key facts card, four numbered prose
// sections, then the deliberately ordered evidence photos in a large gallery
// (every embedded photo, numbered and captioned, nothing cropped). The
// content, field set, hashes, limits and file name are unchanged by the look.
//
// Colours: orange #F15A29, dark #293C46, mid #4C6A7C, light #F0F4F7.

import {
  type GalleryPhoto,
  ReportCanvas,
  type ReportImage,
  reportImageFormat,
} from "./report_design.ts";

// ── Pure helpers (exported for unit tests; no jsPDF / no network) ──

export const MAKESAFE_REPORT_CONTRACT_VERSION =
  "secureworks.makesafe-report/curated-2026-08-03";
export const MAKESAFE_REPORT_TS_SOURCE_REVISION =
  "b20d9ec3c5ac5c82bb463aef6ff52bfe63fc15ce";
// Pinned to the wiki renderer at secureworks-wiki main. These two move
// TOGETHER: the provenance stamp is written server-side from both without
// asking what produced the artifact, so a fingerprint pinned against a stale
// revision would bind a false claim about which renderer made the document.
// Current pin: harness/ops/skills/secureworks-makesafe-reporting/scripts/
// render_makesafe_report.py at the squash commit for wiki PR #325 (per-job
// photo_max_size / photo_quality). Only ONE fingerprint is ever accepted --
// never add a second to smooth a transition.
// Moving them is a THREE-part change: also close the outgoing window and append
// the new identity in makesafe_report_renderer_authority.ts, or every bind made
// under the outgoing pin is silently un-trusted (that module owns the rule, and
// assertMakesafeRendererRegisterMatchesPin() fails the suite if it is skipped).
export const MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION =
  "2cb60bf05f0aecf24d8b6c0a54181de3a8aa3dfb";
export const MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256 =
  "c3e48d4fac7f040c68296bb3b6d6676535fc464d67fedfd10b07b7d7232b54a7";
export const MAKESAFE_REPORT_RENDERER_VERSION =
  `secureworks.ops-api-jspdf/${MAKESAFE_REPORT_TS_SOURCE_REVISION}`;
export const MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION =
  `secureworks.wiki-python/${MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION}`;

export function isCurrentCuratedRendererVersion(value: unknown): boolean {
  return value === MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION;
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
  file?: string;
  evidence_id?: string;
  caption?: string;
  content_sha256?: string;
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

/**
 * Stable provenance input for the authoritative current-wiki renderer.
 *
 * Local file paths are transport details and differ between the reviewed
 * dry-run and apply render. Photo identity is instead bound to the ordered
 * evidence id, client-facing caption, and the exact source bytes.
 */
export function canonicalCurrentWikiReportHashPayload(
  supplied: Record<string, unknown>,
): Record<string, unknown> {
  const photos = Array.isArray(supplied.photos) ? supplied.photos : [];
  return {
    ...supplied,
    photos: photos.map((photo: unknown) => {
      const value = photo && typeof photo === "object"
        ? photo as Record<string, unknown>
        : {};
      return {
        evidence_id: String(value.evidence_id || "").trim(),
        caption: String(value.caption || "").trim(),
        content_sha256: String(value.content_sha256 || "").trim()
          .toLowerCase(),
      };
    }),
  };
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

const DEFAULT_REPORT_PHOTO_LIMIT = 8;
// Board cards routinely carry 20–35 current-cycle completion photos (Tuart
// SWMS-261015 = 23). The previous hard 15-photo cap made a complete curated
// rebuild unreachable for those cards while bind still requires every
// applicable job_media id in photo_evidence. Raise the ceiling; the 8 MiB
// report budget remains the real size gate.
const MAX_REPORT_PHOTO_LIMIT = 40;

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
      caption: p.caption,
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

  // Lazy import (matches completion-pack/index.ts:604).
  // deno-lint-ignore no-import-prefix
  const { jsPDF } = await import("https://esm.sh/jspdf@2.5.1");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  // jsPDF otherwise stamps the wall-clock time into /CreationDate, making
  // identical curated inputs produce different served bytes.
  doc.setCreationDate(new Date("2020-01-01T00:00:00.000Z"));

  // Photo evidence keeps the caller's curated order and its limits.
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
  const images: Array<ReportImage | null> = resolved.map((p, i) => {
    const data = photoImageData(p);
    return data
      ? {
        data,
        format: reportImageFormat(
          data instanceof Uint8Array ? data : null,
          p.contentType,
        ),
        alias: `evidence-${i + 1}`,
      }
      : null;
  });

  const canvas = new ReportCanvas(doc, {
    kind: REPORT_TITLE,
    title: sanitiseText(job.address),
    subtitle: sanitiseText(`Job reference ${job.ref}`).slice(0, 128),
    reference: sanitiseText(job.ref).slice(0, 60),
    cover: images[0] ?? null,
  });
  canvas.hero({ overlap: true });

  canvas.facts([
    { label: "Job reference", value: sanitiseText(job.ref) },
    { label: "Site contact", value: sanitiseText(job.contact) },
    { label: "Property", value: sanitiseText(job.address) },
  ], 3);
  canvas.glance([
    { label: "Attendance", value: sanitiseText(job.date) },
    {
      label: "Arrived",
      value: sanitiseText(job.arrival || "to confirm"),
    },
    { label: "Crew", value: sanitiseText(job.crew) },
  ]);

  canvas.callout(
    "Work Order Scope",
    sanitiseText(job.scope) || "-",
    null,
    { plainLabel: true },
  );
  const proseSections: Array<[string, string]> = [
    ["Site Findings", job.findings || ""],
    ["Works Completed", job.works || ""],
    ["Materials and Equipment", job.materials || ""],
  ];
  for (const [title, text] of proseSections) {
    canvas.section(title, 12);
    canvas.paragraph(sanitiseText(text) || "-");
  }

  if (resolved.length === 0) {
    canvas.section("Photo Evidence", 8);
    canvas.note("No usable photo evidence was available for this report.");
  } else {
    // Every embedded photo, in the caller's curated order, each numbered and
    // captioned. Large photos, two or three to a row; nothing is cropped.
    const count = resolved.length === 1
      ? "1 photo"
      : `${resolved.length} photos`;
    const photos: GalleryPhoto[] = resolved.map((p, zeroIndex) => ({
      image: images[zeroIndex],
      caption: sanitiseText(p.caption).trim() ||
        `Photo evidence ${zeroIndex + 1}`,
      fallback: `Photo evidence ${zeroIndex + 1} (could not embed)`,
    }));
    canvas.section("Photo Evidence", 96, count);
    canvas.gallery(photos, { targetH: resolved.length <= 2 ? 104 : 86 });
  }

  canvas.finish();

  const out = doc.output("arraybuffer") as ArrayBuffer;
  return { bytes: new Uint8Array(out), fileName, renderHash: hash };
}
