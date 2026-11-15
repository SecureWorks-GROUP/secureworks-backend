// Restoration report PDF (docs/restoration-board-v1.md, "Report"): the report
// a builder's claims team reads after we attend a restoration job. What we were
// asked to do, what we found, what we did in order, what we used, and the
// photos, on the shared SecureWorks report design (report_design.ts).
//
// This module renders bytes only. It uploads nothing, sends nothing and touches
// no live system; the ops-api action that calls it files the document.
//
// It is a price-free document: the quote is its own document
// (restoration_quote_render.ts) and this report refuses money wording, because
// it is filed where a trade can read it.

import {
  type GalleryPhoto,
  REPORT_PAGE,
  ReportCanvas,
  type ReportFact,
  type ReportImage,
  reportImageFormat,
  reportText,
} from "./report_design.ts";

export type RestorationPhotoStage = "before" | "during" | "after";

export interface RestorationReportPhoto {
  bytes: Uint8Array;
  /** e.g. "image/jpeg". The bytes decide when they disagree. */
  mime?: string;
  caption?: string;
  /** Where in the property, e.g. "Activity room". */
  area?: string;
  /** Read from a caption that starts "Before" or "After" when not given. */
  stage?: RestorationPhotoStage;
  /** Use this photo on the cover as well (the property front). */
  cover?: boolean;
}

export interface RestorationReportSection {
  paragraphs?: string[];
  bullets?: string[];
  /** Paragraphs that follow the list. */
  closing?: string[];
}

export interface RestorationReportInput {
  job_number: string;
  builder_name?: string | null;
  /** Builder's work order or claim reference, e.g. "MLB-40707". */
  builder_reference?: string | null;
  builder_purchase_order?: string | null;
  site_address: string;
  policyholder?: string | null;
  /** As it should read, e.g. "Friday 13 November 2026". */
  attended_on?: string | null;
  /** e.g. "7:00am". */
  arrived_at?: string | null;
  /** e.g. "Two SecureWorks technicians, 3.5 hours each". */
  crew_line?: string | null;
  /** One line for the summary band, e.g. "Wall cleared, cabinetry kept on site". */
  outcome?: string | null;
  /** The headline, e.g. "Cabinetry removal from the wet wall, activity room". */
  subtitle?: string | null;
  work_order_instruction?: string | null;
  /** e.g. "13 November 2026": printed as the date of issue at the end. */
  issued_on?: string | null;
  /** e.g. "Quote SWMS-261710-Q1, approved by ML Builders on 11 November 2026". */
  approved_quote_note?: string | null;
  findings?: RestorationReportSection | null;
  works_completed?: RestorationReportSection | null;
  materials?: RestorationReportSection | string | null;
  photos?: RestorationReportPhoto[];
}

export interface RenderedRestorationReport {
  bytes: Uint8Array;
  fileName: string;
  pages: number;
  photos_embedded: number;
}

export const RESTORATION_REPORT_TITLE = "Restoration Report";
/** Photos past this are not drawn; the action refuses before it gets here. */
export const RESTORATION_REPORT_MAX_PHOTOS = 60;

// ── Pure helpers (exported for unit tests; no jsPDF / no network) ──

function slug(value: unknown): string {
  return String(value ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 80);
}

/**
 * Stable per job, so rendering again replaces the same document. Contains
 * "make safe report" in no form: a restoration report is its own file name.
 */
export function restorationReportFileName(
  jobNumber: unknown,
  builderReference: unknown,
): string {
  const ref = slug(builderReference);
  return `Restoration Report - ${slug(jobNumber) || "job"}${
    ref ? ` - ${ref}` : ""
  }.pdf`;
}

const MONEY_RE =
  /(?:\$\s*\d|\b(?:aud|gst|invoice|invoiced|margin|subtotal)\b|\b\d+(?:\.\d+)?\s*dollars?\b|\bex\s+gst\b|\binc\s+gst\b)/i;
const INTERNAL_RE = /\b(?:docket|revision|attendance cycle)\b/i;

function sectionTexts(
  section: RestorationReportSection | string | null | undefined,
): string[] {
  if (!section) return [];
  if (typeof section === "string") return [section];
  return [
    ...(section.paragraphs || []),
    ...(section.bullets || []),
    ...(section.closing || []),
  ];
}

/**
 * Fields whose wording must not go on a builder-facing, trade-readable report:
 * money, or our own internal words. Returns the field names, empty when clean.
 */
export function restorationReportWordingProblems(
  input: RestorationReportInput,
): string[] {
  const fields: Array<[string, string[]]> = [
    ["subtitle", [input.subtitle || ""]],
    ["crew_line", [input.crew_line || ""]],
    ["outcome", [input.outcome || ""]],
    ["work_order_instruction", [input.work_order_instruction || ""]],
    ["approved_quote_note", [input.approved_quote_note || ""]],
    ["findings", sectionTexts(input.findings)],
    ["works_completed", sectionTexts(input.works_completed)],
    ["materials", sectionTexts(input.materials)],
    ["photos", (input.photos || []).map((p) => `${p.caption || ""} ${p.area || ""}`)],
  ];
  const problems: string[] = [];
  for (const [name, texts] of fields) {
    if (texts.some((t) => MONEY_RE.test(t) || INTERNAL_RE.test(t))) {
      problems.push(name);
    }
  }
  return problems;
}

/** The stage a photo shows: given, or read from how its caption starts. */
export function restorationPhotoStage(
  photo: Pick<RestorationReportPhoto, "stage" | "caption">,
): RestorationPhotoStage | null {
  if (photo.stage) return photo.stage;
  const caption = String(photo.caption || "").trim();
  if (/^before\b/i.test(caption)) return "before";
  if (/^after\b/i.test(caption)) return "after";
  if (/^during\b/i.test(caption)) return "during";
  return null;
}

/** "Before: wall unit" -> "Wall unit" once the photo carries a Before tag. */
export function captionWithoutStage(caption: unknown): string {
  const text = reportText(caption).trim();
  const rest = text.replace(/^(?:before|after|during)\s*[:\-]\s*/i, "");
  if (rest === text || !rest) return text;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Split a fused "MLB-40707PO-64727" into its work order and purchase order. */
export function splitBuilderReference(
  reference: unknown,
  purchaseOrder?: unknown,
): { work_order: string; purchase_order: string } {
  const ref = reportText(reference).trim();
  const po = reportText(purchaseOrder).trim();
  if (po) return { work_order: ref, purchase_order: po };
  const m = ref.match(/^(.+?)\s*(PO-?\d+)$/i);
  if (m && m[1].trim()) {
    const poText = m[2].toUpperCase().replace(/^PO(?=\d)/, "PO-");
    return { work_order: m[1].trim(), purchase_order: poText };
  }
  return { work_order: ref, purchase_order: "" };
}

/** Materials short enough to sit in the job details table. */
function materialsFitsTable(
  materials: RestorationReportSection | string | null | undefined,
): boolean {
  const texts = sectionTexts(materials).map((t) => reportText(t).trim()).filter(Boolean);
  return texts.length <= 1 && (texts[0] || "").length <= 90;
}

/** The job details table: every fact about the job, two to a row. */
export function restorationReportFacts(
  input: RestorationReportInput,
): ReportFact[] {
  const { work_order, purchase_order } = splitBuilderReference(
    input.builder_reference,
    input.builder_purchase_order,
  );
  const v = (value: unknown) => reportText(value).trim() || "-";
  const facts: ReportFact[] = [
    { label: "Our reference", value: v(input.job_number) },
    { label: "Date attended", value: v(input.attended_on) },
    { label: "Builder", value: v(input.builder_name) },
    { label: "Arrived", value: v(input.arrived_at) },
    { label: "Builder reference", value: v(work_order) },
    { label: "Attended by", value: v(input.crew_line) },
    { label: "Purchase order", value: v(purchase_order) },
    { label: "Policyholder", value: v(input.policyholder) },
    { label: "Property", value: v(input.site_address), wide: true },
  ];
  const instruction = reportText(input.work_order_instruction).trim();
  if (instruction) {
    facts.push({
      label: "Work order",
      value: instruction,
      note: reportText(input.approved_quote_note).trim() || undefined,
      wide: true,
    });
  }
  if (materialsFitsTable(input.materials)) {
    const text = sectionTexts(input.materials).map((t) => reportText(t).trim()).filter(Boolean)[0];
    if (text) facts.push({ label: "Materials used", value: text, wide: true });
  }
  return facts;
}

function cleanList(items: string[] | undefined): string[] {
  return (items || []).map((item) => reportText(item).trim()).filter(Boolean);
}

// ── Renderer (async; imports jsPDF lazily, like the other report renderers) ──

export async function renderRestorationReportPdf(
  input: RestorationReportInput,
): Promise<RenderedRestorationReport> {
  if (!String(input?.job_number || "").trim()) {
    throw new Error("renderRestorationReportPdf: job number required");
  }
  if (!String(input?.site_address || "").trim()) {
    throw new Error("renderRestorationReportPdf: site address required");
  }
  const problems = restorationReportWordingProblems(input);
  if (problems.length) {
    throw new Error(
      `restoration report wording not allowed in: ${problems.join(", ")}`,
    );
  }

  // deno-lint-ignore no-import-prefix
  const { jsPDF } = await import("https://esm.sh/jspdf@2.5.1");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  // Same inputs, same bytes: jsPDF otherwise stamps the wall clock.
  doc.setCreationDate(new Date("2020-01-01T00:00:00.000Z"));
  doc.setProperties({
    title: `${RESTORATION_REPORT_TITLE} ${reportText(input.job_number)}`,
    author: "SecureWorks Group",
  });

  const supplied = (input.photos || []).filter((p) => p?.bytes?.byteLength)
    .slice(0, RESTORATION_REPORT_MAX_PHOTOS);
  const images: ReportImage[] = supplied.map((photo, i) => ({
    data: photo.bytes,
    format: reportImageFormat(photo.bytes, photo.mime),
    alias: `photo-${i}`,
  }));

  const site = reportText(input.site_address).trim();
  const issuedOn = reportText(input.issued_on).trim();
  const canvas = new ReportCanvas(doc, {
    kind: RESTORATION_REPORT_TITLE,
    reference: reportText(input.job_number),
    referenceNote: issuedOn ? `Issued ${issuedOn}` : undefined,
    site,
  });

  canvas.hero();

  // Job details: every fact about the job in one ruled table.
  canvas.section("Job details", 40);
  canvas.facts(restorationReportFacts(input), 4);

  const prose = (section: RestorationReportSection | null | undefined): void => {
    for (const text of cleanList(section?.paragraphs)) canvas.paragraph(text);
  };

  if (sectionTexts(input.findings).some((t) => t.trim())) {
    canvas.section("What we found", 16);
    prose(input.findings);
    const items = cleanList(input.findings?.bullets);
    if (items.length) canvas.bullets(items);
    for (const text of cleanList(input.findings?.closing)) canvas.paragraph(text);
  }

  if (sectionTexts(input.works_completed).some((t) => t.trim())) {
    canvas.section("What we did", 16, reportText(input.subtitle) || undefined);
    prose(input.works_completed);
    const steps = cleanList(input.works_completed?.bullets);
    if (steps.length) canvas.steps(steps);
  }

  // Outcome: the closing lines of the works, or the one-line outcome.
  const outcome = cleanList(input.works_completed?.closing);
  if (!outcome.length && reportText(input.outcome).trim()) {
    outcome.push(reportText(input.outcome).trim());
  }
  if (outcome.length) {
    canvas.section("Outcome", 12);
    canvas.bullets(outcome);
  }

  // Materials that need more than a line get their own section.
  const materials = typeof input.materials === "string"
    ? { paragraphs: [input.materials] }
    : input.materials;
  if (!materialsFitsTable(input.materials) && sectionTexts(materials).some((t) => t.trim())) {
    canvas.section("Materials", 10);
    prose(materials);
    const items = cleanList(materials?.bullets);
    if (items.length) canvas.bullets(items);
    for (const text of cleanList(materials?.closing)) canvas.paragraph(text);
  }

  // Photos: the first before and the first after side by side, then the rest
  // four to a row, numbered in that order.
  const gallery: GalleryPhoto[] = supplied.map((photo, i) => {
    const stage = restorationPhotoStage(photo);
    return {
      image: images[i],
      caption: reportText(photo.caption).trim(),
      area: photo.area ? reportText(photo.area).trim() : undefined,
      tag: stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : undefined,
      fallback: `Photo ${i + 1} could not be shown`,
    };
  });
  const stages = supplied.map((photo) => restorationPhotoStage(photo));
  const beforeIndex = stages.indexOf("before");
  const afterIndex = stages.indexOf("after");
  let number = 1;
  if (beforeIndex >= 0 && afterIndex >= 0 && beforeIndex !== afterIndex) {
    canvas.section("Photos", 112, "Before and after");
    canvas.beforeAfter(gallery[beforeIndex], gallery[afterIndex], [1, 2]);
    number = 3;
  }
  const rest = gallery.filter((_, i) =>
    !(number === 3 && (i === beforeIndex || i === afterIndex))
  );
  if (rest.length) {
    canvas.section("Photos", 70, number === 3 ? "The works" : undefined);
    canvas.gallery(rest, { startNumber: number });
  } else if (!gallery.length) {
    canvas.section("Photos", 10);
    canvas.note("No photos were supplied with this report.");
  }

  canvas.finish({ issuedOn: reportText(input.issued_on).trim() || undefined });
  const out = doc.output("arraybuffer") as ArrayBuffer;
  return {
    bytes: new Uint8Array(out),
    fileName: restorationReportFileName(
      input.job_number,
      input.builder_reference,
    ),
    pages: doc.getNumberOfPages(),
    photos_embedded: gallery.length,
  };
}

export const RESTORATION_REPORT_PAGE = REPORT_PAGE;
