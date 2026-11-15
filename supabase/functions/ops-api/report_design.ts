// SecureWorks report design: the ONE visual language every PDF this function
// renders shares (restoration report, make-safe report, roof report,
// restoration quote), so they read as one family.
//
// The look was approved by the owner on 13 Nov 2026 from a design mockup:
//   - the SecureWorks Group logo top left, the document's name and reference
//     top right, one orange rule under them;
//   - every section opens with a slate title bar (white capitals);
//   - job information sits in a ruled table, a light grey label cell beside
//     each value, two pairs to a row;
//   - descriptions sit in a ruled box under their bar: short paragraphs,
//     orange square bullets, and numbered steps for work done in order;
//   - photos sit in ruled cells on a light grey ground, never cropped, with
//     "Photo N" and the caption in a ruled cell beneath (a large before and
//     after pair when there is one, then four to a row);
//   - a footer on every page with the company, ABN, contacts and
//     "Page x of y", and a closing "Report issued by" table.
//
// This module only DRAWS. It decides no content: each renderer keeps its own
// fields, wording, hashes, limits and file names.
//
// Layout rules the blocks keep for every caller:
//   - nothing is drawn below BODY_BOTTOM, so nothing can touch the footer;
//   - a photo is never split from its caption, and a table row never splits;
//   - text is measured before it is drawn, and breaks to a new page cleanly;
//   - photos go to jsPDF as raw bytes (never re-encoded to a string here).

import { MAKESAFE_REPORT_LOGO_DATA_URL } from "./makesafe_report_logo.ts";

export type Rgb = [number, number, number];

export const REPORT_COLOURS = {
  slate: [41, 60, 70] as Rgb, // #293C46, text and title bars
  mid: [76, 106, 124] as Rgb, // #4C6A7C, labels and quiet text
  light: [240, 244, 247] as Rgb, // #F0F4F7, label cells and photo ground
  line: [195, 206, 214] as Rgb, // #C3CED6, table rules
  orange: [241, 90, 41] as Rgb, // #F15A29, the brand accent
  barNote: [201, 214, 222] as Rgb, // quiet text on a title bar
  white: [255, 255, 255] as Rgb,
  // Older names, kept so a caller that names them still draws in this palette.
  dark: [41, 60, 70] as Rgb,
  ink: [41, 60, 70] as Rgb,
  body: [41, 60, 70] as Rgb,
  grey: [76, 106, 124] as Rgb,
  hair: [195, 206, 214] as Rgb,
  rule: [195, 206, 214] as Rgb,
  shade: [240, 244, 247] as Rgb,
} as const;

export const REPORT_PAGE = {
  W: 210,
  H: 297,
  MARGIN: 15,
  CONTENT_W: 210 - 2 * 15,
  /** Where body content starts on a page after the first. */
  RUNNING_TOP: 25,
  /** Nothing is drawn below this line except the footer. */
  BODY_BOTTOM: 281,
} as const;

/** Company details printed in the footer and the closing table. */
export const REPORT_COMPANY = {
  name: "SecureWorks Group",
  abn: "64 689 223 416",
  address: "15 Utah Gr, Joondalup WA 6027",
  email: "admin@secureworkswa.com.au",
  phone: "+61 489 267 771",
} as const;

const C = REPORT_COLOURS;
const P = REPORT_PAGE;
const PT = 0.3528; // one point in mm
const RULE_W = 0.3; // table rule, mm
const BAR_H = 7.2; // section title bar, mm
const PAD = 3.2; // inside a description box, mm
const BODY = 9; // body text size, pt
const LEAD = BODY * PT * 1.42; // body leading, mm
const LOGO_RATIO = 1136 / 169; // logo width over height

export interface ReportImage {
  data: Uint8Array | string;
  format: "PNG" | "JPEG";
  /** Stable name so one image drawn twice is stored once. */
  alias?: string;
}

export interface ReportChrome {
  /** The kind of document, e.g. "Restoration Report". */
  kind: string;
  /** What the document is about (kept for callers; not printed in this look). */
  title?: string;
  /** Older field, not printed in this look. */
  subtitle?: string;
  /** Report or quote number: top right and the running header. */
  reference: string;
  /** Beside the reference on page one, e.g. "Issued 13 November 2026". */
  referenceNote?: string;
  /** Running header, after the reference: usually the property. */
  site?: string;
  /** Older fields, not printed in this look. */
  tagline?: string;
  cover?: ReportImage | null;
}

export interface ReportFact {
  label: string;
  value: string;
  /** Take the whole row. */
  wide?: boolean;
  /** Smaller line(s) after the value, e.g. a quote approval. */
  note?: string;
}

export interface GalleryPhoto {
  image: ReportImage | null;
  caption: string;
  /** The room or area, e.g. "Activity room" (not printed in this look). */
  area?: string;
  /** "Before", "During" or "After": a small orange word before the caption. */
  tag?: string;
  /** Text shown when the image cannot be drawn. */
  fallback?: string;
}

/** One cell of a ruled table. */
export interface TableCell {
  text: string;
  /** A label cell: light grey, small bold label text. */
  shade?: boolean;
  /** Bold value text. */
  bold?: boolean;
  /** Smaller grey line(s) after the text. */
  note?: string;
  /** Right-align (money and quantities). */
  align?: "left" | "right";
}

/** PNG or JPEG, read from the bytes when we hold them. */
export function reportImageFormat(
  data: Uint8Array | string | null | undefined,
  contentType?: string,
): "PNG" | "JPEG" {
  if (data instanceof Uint8Array && data.byteLength > 3) {
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e) return "PNG";
    if (data[0] === 0xff && data[1] === 0xd8) return "JPEG";
  }
  return String(contentType || "").toLowerCase().includes("png")
    ? "PNG"
    : "JPEG";
}

/** House rule: no long dashes in outbound copy; jsPDF also chokes on CRLF. */
export function reportText(value: unknown): string {
  return String(value ?? "")
    .replace(/[—–]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/\r\n/g, "\n");
}

/** The caption without a leading "Before:" when the tag already says it. */
export function photoCaptionText(photo: GalleryPhoto): string {
  const caption = reportText(photo.caption).trim();
  const tag = reportText(photo.tag).trim();
  if (!tag) return caption;
  const re = new RegExp(`^${tag}\\s*[:\\-]\\s*`, "i");
  const rest = caption.replace(re, "");
  if (rest === caption || !rest) return caption;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export interface GalleryRowItem {
  index: number;
  w: number;
  h: number;
}

/**
 * Justified rows: every photo in a row has the same height, widths follow each
 * photo's own shape, and a full row spans the whole width. Nothing is cropped.
 * Pure. Not used by the ruled photo grid; kept for callers and tests that lay
 * photos out by shape.
 */
export function layoutGalleryRows(
  aspects: number[],
  width: number,
  targetH: number,
  gap: number,
  maxH = targetH * 1.4,
): GalleryRowItem[][] {
  const n = aspects.length;
  if (!n) return [];
  const minH = targetH * 0.6;
  const rowHeight = (from: number, to: number): { h: number; cost: number } => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += aspects[i];
    const natural = (width - gap * (to - from - 1)) / sum;
    if (natural > maxH) {
      if (to === n) {
        const h = Math.min(maxH, targetH * 1.15);
        return { h, cost: 900 + (natural - maxH) ** 2 };
      }
      if (natural <= targetH * 1.9) {
        return { h: natural, cost: (natural - targetH) ** 2 };
      }
      return { h: targetH * 1.9, cost: 20000 + (natural - maxH) ** 2 };
    }
    const squeeze = natural < minH ? 4000 + (minH - natural) * 400 : 0;
    const off = natural < targetH
      ? (targetH - natural) * 1.8
      : natural - targetH;
    return { h: natural, cost: off ** 2 + squeeze };
  };
  const best: number[] = new Array(n + 1).fill(Infinity);
  const cut: number[] = new Array(n + 1).fill(0);
  best[0] = 0;
  for (let to = 1; to <= n; to++) {
    for (let from = Math.max(0, to - 8); from < to; from++) {
      const total = best[from] + rowHeight(from, to).cost;
      if (total < best[to]) {
        best[to] = total;
        cut[to] = from;
      }
    }
  }
  const bounds: Array<[number, number]> = [];
  for (let to = n; to > 0; to = cut[to]) bounds.unshift([cut[to], to]);
  return bounds.map(([from, to]) => {
    const { h } = rowHeight(from, to);
    const row: GalleryRowItem[] = [];
    for (let i = from; i < to; i++) row.push({ index: i, w: aspects[i] * h, h });
    return row;
  });
}

// deno-lint-ignore no-explicit-any
type Doc = any;

export class ReportCanvas {
  readonly doc: Doc;
  readonly chrome: ReportChrome;
  y = 0;
  private dims = new Map<string, { w: number; h: number } | null>();
  /** Top of the open description box, or null when none is open. */
  private boxTop: number | null = null;
  /** The open box carried over from a page break: it needs a top rule. */
  private boxContinued = false;
  /** The last section title, repeated when photos run onto a new page. */
  private lastTitle = "";

  constructor(doc: Doc, chrome: ReportChrome) {
    this.doc = doc;
    this.chrome = chrome;
  }

  // ── Text primitives ──

  font(size: number, style: "normal" | "bold" | "italic" = "normal"): void {
    this.doc.setFont("helvetica", style);
    this.doc.setFontSize(size);
  }

  colour(rgb: Rgb): void {
    this.doc.setTextColor(rgb[0], rgb[1], rgb[2]);
  }

  wrap(
    text: unknown,
    width: number,
    size: number,
    style: "normal" | "bold" | "italic" = "normal",
  ): string[] {
    this.font(size, style);
    const out: string[] = [];
    for (const block of reportText(text).split("\n")) {
      const lines: string[] = this.doc.splitTextToSize(block || " ", width);
      out.push(...lines);
    }
    return out;
  }

  /** A small bold label in plain case. */
  eyebrow(
    text: string,
    x: number,
    y: number,
    rgb: Rgb = C.mid,
    size = 7.8,
    align: "left" | "right" = "left",
  ): void {
    this.font(size, "bold");
    this.colour(rgb);
    this.doc.text(reportText(text), x, y, align === "right" ? { align: "right" } : undefined);
  }

  eyebrowWidth(text: string, size = 7.8): number {
    this.font(size, "bold");
    return this.doc.getTextWidth(reportText(text));
  }

  private rule(x1: number, y1: number, x2: number, y2: number): void {
    this.doc.setDrawColor(...C.line);
    this.doc.setLineWidth(RULE_W);
    this.doc.line(x1, y1, x2, y2);
  }

  // ── Images ──

  private imageSize(image: ReportImage): { w: number; h: number } | null {
    const key = image.alias || "";
    if (key && this.dims.has(key)) return this.dims.get(key) ?? null;
    let size: { w: number; h: number } | null = null;
    try {
      const props = this.doc.getImageProperties(image.data) as {
        width?: number;
        height?: number;
      };
      const w = Number(props?.width || 0);
      const h = Number(props?.height || 0);
      if (w > 0 && h > 0) size = { w, h };
    } catch {
      size = null;
    }
    if (key) this.dims.set(key, size);
    return size;
  }

  /** Width over height; 4:3 when the image cannot be read. */
  aspect(image: ReportImage | null): number {
    if (!image) return 4 / 3;
    const size = this.imageSize(image);
    return size ? size.w / size.h : 4 / 3;
  }

  /** Draw the whole image in the box. False if it failed. */
  drawImage(
    image: ReportImage | null,
    x: number,
    y: number,
    w: number,
    h: number,
    _radius = 0,
  ): boolean {
    if (!image) return false;
    try {
      this.doc.addImage(image.data, image.format, x, y, w, h, image.alias, "FAST");
      return true;
    } catch {
      return false;
    }
  }

  /** Older entry point: this design never crops, so it fits the whole image. */
  drawImageCover(
    image: ReportImage,
    x: number,
    y: number,
    w: number,
    h: number,
  ): boolean {
    const a = this.aspect(image);
    const dw = Math.min(w, h * a);
    const dh = dw / a;
    return this.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  private logo(x: number, y: number, h: number): void {
    try {
      this.doc.addImage(
        MAKESAFE_REPORT_LOGO_DATA_URL,
        "PNG",
        x,
        y,
        h * LOGO_RATIO,
        h,
        "sw-logo",
        "FAST",
      );
    } catch {
      this.font(h * 1.6, "bold");
      this.colour(C.slate);
      this.doc.text(REPORT_COMPANY.name, x, y + h * 0.8);
    }
  }

  private orangeRule(y: number): void {
    this.doc.setDrawColor(...C.orange);
    this.doc.setLineWidth(0.8);
    this.doc.line(P.MARGIN, y, P.W - P.MARGIN, y);
  }

  // ── Page chrome ──

  /** Page one: logo, the document's name and reference, one orange rule. */
  hero(_options: { overlap?: boolean } = {}): void {
    const doc = this.doc;
    const right = P.W - P.MARGIN;
    this.logo(P.MARGIN, 11.5, 9.5);
    this.font(15, "bold");
    this.colour(C.slate);
    doc.text(reportText(this.chrome.kind), right, 16.2, { align: "right" });
    const sub = [this.chrome.reference, this.chrome.referenceNote]
      .map((t) => reportText(t).trim())
      .filter(Boolean)
      .join("  |  ");
    if (sub) {
      this.font(8.4);
      this.colour(C.mid);
      doc.text(sub, right, 21, { align: "right" });
    }
    this.orangeRule(25.4);
    this.y = 27;
  }

  private runningHeader(): void {
    const doc = this.doc;
    const right = P.W - P.MARGIN;
    this.logo(P.MARGIN, 10.5, 6);
    const rest = [this.chrome.reference, this.chrome.site]
      .map((t) => reportText(t).trim())
      .filter(Boolean)
      .join("  |  ");
    this.font(8);
    this.colour(C.mid);
    const restW = doc.getTextWidth(rest);
    doc.text(rest, right, 15, { align: "right" });
    this.font(8, "bold");
    this.colour(C.slate);
    doc.text(reportText(this.chrome.kind), right - restW - 3, 15, { align: "right" });
    this.orangeRule(19.6);
    this.y = P.RUNNING_TOP;
  }

  newPage(): void {
    this.doc.addPage();
    this.runningHeader();
  }

  remaining(): number {
    return P.BODY_BOTTOM - this.y;
  }

  /** Make room for `height`, carrying an open description box over the break. */
  ensure(height: number): void {
    if (this.y + height <= P.BODY_BOTTOM) return;
    const carry = this.boxTop !== null;
    if (carry) this.closeBox(true);
    this.newPage();
    if (carry) {
      this.boxTop = this.y;
      this.boxContinued = true;
      this.y += PAD - 0.6;
    }
  }

  gap(mm: number): void {
    this.y += mm;
  }

  // ── Description box ──

  private openBox(): void {
    if (this.boxTop !== null) return;
    this.boxTop = this.y;
    this.boxContinued = false;
    this.y += PAD - 0.6;
  }

  /** Draw the open box's rules. `cut` leaves the bottom open at a page break. */
  private closeBox(cut = false): void {
    if (this.boxTop === null) return;
    const top = this.boxTop;
    const bottom = cut ? Math.min(this.y + 1, P.BODY_BOTTOM) : this.y + PAD - 1;
    const x1 = P.MARGIN;
    const x2 = P.W - P.MARGIN;
    this.rule(x1, top, x1, bottom);
    this.rule(x2, top, x2, bottom);
    if (!cut) this.rule(x1, bottom, x2, bottom);
    if (this.boxContinued) this.rule(x1, top, x2, top);
    this.boxTop = null;
    this.boxContinued = false;
    this.y = bottom;
  }

  private get innerX(): number {
    return P.MARGIN + PAD;
  }

  private get innerW(): number {
    return P.CONTENT_W - 2 * PAD;
  }

  // ── Sections ──

  /** A slate title bar, kept with the first `keepWith` mm of what follows. */
  section(title: string, keepWith = 14, note?: string): void {
    const doc = this.doc;
    this.closeBox();
    if (this.y > P.RUNNING_TOP + 1) this.y += 4.6;
    this.ensure(BAR_H + keepWith);
    const top = this.y;
    doc.setFillColor(...C.slate);
    doc.rect(P.MARGIN, top, P.CONTENT_W, BAR_H, "F");
    const label = reportText(title).toUpperCase();
    this.font(8.4, "bold");
    this.colour(C.white);
    doc.text(label, P.MARGIN + 2.6, top + 4.8, { charSpace: 0.35 });
    const labelW = doc.getTextWidth(label) + label.length * 0.35;
    if (note) {
      this.font(8.2);
      this.colour(C.barNote);
      // A long note is cut to the room left beside the title, never wrapped.
      const room = P.CONTENT_W - 12 - labelW;
      let shown = reportText(note);
      if (doc.getTextWidth(shown) > room) {
        while (shown.length > 1 && doc.getTextWidth(`${shown}...`) > room) shown = shown.slice(0, -1);
        shown = `${shown.trimEnd()}...`;
      }
      doc.text(shown, P.W - P.MARGIN - 2.6, top + 4.8, { align: "right" });
    }
    this.lastTitle = title;
    this.y = top + BAR_H;
  }

  // ── Ruled tables ──

  private cellLines(cell: TableCell, width: number): { text: string[]; note: string[] } {
    const inner = width - 2 * 2.6;
    // A label like "Gutters/valleys/downpipes" may break after a slash, never mid-word.
    const raw = cell.shade
      ? String(cell.text || "-").replace(/\/(?=\S)/g, "/ ")
      : cell.text || "-";
    const size = cell.shade ? 7.8 : BODY;
    return {
      text: this.wrap(raw, inner, size, cell.shade || cell.bold ? "bold" : "normal"),
      note: cell.note ? this.wrap(cell.note, inner, 8) : [],
    };
  }

  private rowHeight(widths: number[], row: TableCell[]): number {
    let h = 0;
    row.forEach((cell, i) => {
      const { text, note } = this.cellLines(cell, widths[i]);
      const lead = cell.shade ? 3.5 : 4.1;
      h = Math.max(h, 2.2 + text.length * lead + (note.length ? 0.6 + note.length * 3.6 : 0) + 1.6);
    });
    return Math.max(h, 7.6);
  }

  tableHeight(widths: number[], rows: TableCell[][]): number {
    return rows.reduce((sum, row) => sum + this.rowHeight(widths, row), 0);
  }

  /**
   * A ruled table: light rules, light grey label cells. A row never splits; a
   * table that runs over a page carries on, repeating its header row when it
   * has one.
   */
  table(
    widths: number[],
    rows: TableCell[][],
    options: { header?: boolean; x?: number } = {},
  ): void {
    const doc = this.doc;
    this.closeBox();
    const header = options.header ? rows[0] : null;
    const drawRow = (row: TableCell[]) => {
      const h = this.rowHeight(widths, row);
      const top = this.y;
      let x = options.x ?? P.MARGIN;
      row.forEach((cell, i) => {
        const w = widths[i];
        if (cell.shade) {
          doc.setFillColor(...C.light);
          doc.rect(x, top, w, h, "F");
        }
        const { text, note } = this.cellLines(cell, w);
        const size = cell.shade ? 7.8 : BODY;
        const lead = cell.shade ? 3.5 : 4.1;
        this.font(size, cell.shade || cell.bold ? "bold" : "normal");
        this.colour(cell.shade ? C.mid : C.slate);
        const baseline = top + 2.2 + (cell.shade ? 2.6 : 3);
        if (cell.align === "right") {
          doc.text(text, x + w - 2.6, baseline, {
            lineHeightFactor: lead / (size * PT),
            align: "right",
          });
        } else {
          doc.text(text, x + 2.6, baseline, { lineHeightFactor: lead / (size * PT) });
        }
        if (note.length) {
          this.font(8);
          this.colour(C.mid);
          doc.text(note, x + 2.6, top + 2.2 + text.length * lead + 0.6 + 2.6, {
            lineHeightFactor: 3.6 / (8 * PT),
          });
        }
        doc.setDrawColor(...C.line);
        doc.setLineWidth(RULE_W);
        doc.rect(x, top, w, h, "S");
        x += w;
      });
      this.y = top + h;
    };
    rows.forEach((row, i) => {
      const h = this.rowHeight(widths, row);
      if (this.y + h > P.BODY_BOTTOM) {
        this.newPage();
        if (header && i > 0) drawRow(header);
      }
      drawRow(row);
    });
  }

  /** Label and value pairs, two to a row; a wide fact takes the whole row. */
  facts(items: ReportFact[], columns = 4): void {
    const pairs = columns >= 3 ? 2 : 1;
    const keyW = 31;
    const half = P.CONTENT_W / 2;
    const rows: TableCell[][] = [];
    let row: TableCell[] = [];
    const cellsOf = (item: ReportFact): TableCell[] => [
      { text: item.label, shade: true },
      { text: reportText(item.value).trim() || "-", note: item.note },
    ];
    for (const item of items) {
      if (item.wide || pairs === 1) {
        if (row.length) rows.push(row);
        row = [];
        rows.push(cellsOf(item));
        continue;
      }
      row.push(...cellsOf(item));
      if (row.length === 4) {
        rows.push(row);
        row = [];
      }
    }
    if (row.length) rows.push(row);
    for (const cells of rows) {
      const widths = cells.length === 4
        ? [keyW, half - keyW, keyW, half - keyW]
        : [keyW, P.CONTENT_W - keyW];
      this.table(widths, [cells]);
    }
  }

  /** Attendance figures as label and value pairs, the outcome on its own row. */
  glance(
    items: Array<{ label: string; value: string }>,
    outcome?: { label: string; text: string } | null,
  ): void {
    const facts: ReportFact[] = items
      .filter((item) => reportText(item.value).trim())
      .map((item) => ({ label: item.label, value: item.value }));
    if (outcome?.text) facts.push({ label: outcome.label, value: outcome.text, wide: true });
    if (facts.length) this.facts(facts, 4);
  }

  /** The instruction we were given: one wide row, label on the left. */
  callout(
    label: string,
    text: string,
    note?: string | null,
    _options: { plainLabel?: boolean } = {},
  ): void {
    this.facts([{ label, value: text, note: note || undefined, wide: true }], 4);
  }

  /** Label and value pairs in a ruled table, `columns` pairs a row. */
  kvGrid(rows: Array<[string, string]>, columns = 2): void {
    this.facts(
      rows.map(([label, value]) => ({ label, value, wide: columns < 2 })),
      columns >= 2 ? 4 : 2,
    );
  }

  // ── Descriptions (inside a ruled box under the section bar) ──

  /** Small bold lead-in over a paragraph. */
  lead(text: string): void {
    this.openBox();
    this.ensure(LEAD * 3);
    this.font(BODY, "bold");
    this.colour(C.slate);
    this.doc.text(reportText(text), this.innerX, this.y + 3.2);
    this.y += LEAD + 0.6;
  }

  /** Body paragraphs. Blank lines separate paragraphs. */
  paragraph(
    text: unknown,
    options: { x?: number; width?: number; rgb?: Rgb; size?: number; plain?: boolean } = {},
  ): void {
    this.openBox();
    const x = options.x ?? this.innerX;
    const width = options.width ?? this.innerX + this.innerW - x;
    const size = options.size ?? BODY;
    const leading = size * PT * 1.42;
    const blocks = (reportText(text) || "-").split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = this.wrap(block.trim() || "-", width, size);
      for (let i = 0; i < lines.length; i++) {
        // Keep a paragraph's first two and last two lines together.
        const need = i === 0 || i === lines.length - 2
          ? leading * Math.min(2, lines.length - i)
          : leading;
        this.ensure(need);
        this.font(size);
        this.colour(options.rgb ?? C.slate);
        this.doc.text(lines[i], x, this.y + 3.2);
        this.y += leading;
      }
      this.y += 1.6;
    }
  }

  /** Orange square bullets. */
  bullets(items: string[]): void {
    this.openBox();
    const tx = this.innerX + 5;
    const width = this.innerX + this.innerW - tx;
    for (const item of items) {
      const lines = this.wrap(item, width, BODY);
      this.ensure(lines.length * LEAD + 1);
      this.doc.setFillColor(...C.orange);
      this.doc.rect(this.innerX + 0.6, this.y + 1.55, 1.6, 1.6, "F");
      this.font(BODY);
      this.colour(C.slate);
      this.doc.text(lines, tx, this.y + 3.2, {
        lineHeightFactor: LEAD / (BODY * PT),
      });
      this.y += lines.length * LEAD + 1;
    }
    this.y += 0.8;
  }

  /** Work done in order: "1." in orange, then the step. */
  steps(items: string[]): void {
    this.openBox();
    const tx = this.innerX + 7;
    const width = this.innerX + this.innerW - tx;
    items.forEach((item, i) => {
      const lines = this.wrap(item, width, BODY);
      this.ensure(lines.length * LEAD + 1);
      this.font(BODY, "bold");
      this.colour(C.orange);
      this.doc.text(`${i + 1}.`, this.innerX, this.y + 3.2);
      this.font(BODY);
      this.colour(C.slate);
      this.doc.text(lines, tx, this.y + 3.2, {
        lineHeightFactor: LEAD / (BODY * PT),
      });
      this.y += lines.length * LEAD + 1;
    });
    this.y += 0.8;
  }

  /** A quiet line of small grey text. */
  note(text: string): void {
    this.openBox();
    const lines = this.wrap(text, this.innerW, 8.4);
    this.ensure(lines.length * 3.9 + 1.4);
    this.font(8.4);
    this.colour(C.mid);
    this.doc.text(lines, this.innerX, this.y + 3, {
      lineHeightFactor: 3.9 / (8.4 * PT),
    });
    this.y += lines.length * 3.9 + 1.4;
  }

  // ── Photos ──

  /** Caption lines: tag and "Photo N" lead the first line, then the caption. */
  private captionLayout(
    photo: GalleryPhoto,
    number: number | null,
    width: number,
    size: number,
  ): { prefix: Array<{ text: string; w: number; tag: boolean }>; lines: string[] } {
    const doc = this.doc;
    const prefix: Array<{ text: string; w: number; tag: boolean }> = [];
    const tag = reportText(photo.tag).trim().toUpperCase();
    if (tag) {
      this.font(size - 1.4, "bold");
      prefix.push({ text: tag, w: doc.getTextWidth(tag) + 0.35 * tag.length + 1.6, tag: true });
    }
    if (number != null) {
      const label = `Photo ${number}`;
      this.font(size, "bold");
      prefix.push({ text: label, w: doc.getTextWidth(label) + 1.6, tag: false });
    }
    const lead = prefix.reduce((sum, p) => sum + p.w, 0);
    // Words fill the first line after the prefix, then wrap at the full width.
    this.font(size);
    const words = photoCaptionText(photo).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    let room = width - lead;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (doc.getTextWidth(next) <= room || !line) {
        line = next;
      } else {
        lines.push(line);
        line = word;
        room = width;
      }
    }
    if (line || !lines.length) lines.push(line);
    return { prefix, lines };
  }

  /**
   * One row of photo cells: each photo on a light grey ground, never cropped,
   * with its caption in a ruled cell beneath. The row is kept whole on a page.
   */
  private photoRow(
    cells: Array<{ photo: GalleryPhoto; number: number | null }>,
    perRow: number,
    photoH: number,
  ): void {
    const doc = this.doc;
    const colW = P.CONTENT_W / perRow;
    const size = perRow <= 2 ? 8.8 : 8;
    const capLead = size * PT * 1.32;
    const layouts = cells.map((c) => this.captionLayout(c.photo, c.number, colW - 4.4, size));
    const capH = Math.max(
      perRow <= 2 ? 7.4 : 11,
      ...layouts.map((l) => 3 + l.lines.length * capLead + 1.6),
    );
    const total = photoH + capH;
    if (this.y + total > P.BODY_BOTTOM) {
      this.newPage();
      this.section(this.lastTitle || "Photos", total, "Continued");
    }
    const top = this.y;
    cells.forEach((c, i) => {
      const x = P.MARGIN + i * colW;
      doc.setFillColor(...C.light);
      doc.rect(x, top, colW, photoH, "F");
      const a = this.aspect(c.photo.image);
      const pad = perRow <= 2 ? 2.4 : 2;
      const maxW = colW - 2 * pad;
      const maxH = photoH - 2 * pad;
      const w = Math.min(maxW, maxH * a);
      const h = w / a;
      const ok = this.drawImage(c.photo.image, x + (colW - w) / 2, top + (photoH - h) / 2, w, h);
      if (!ok) {
        this.font(8);
        this.colour(C.mid);
        doc.text(
          reportText(c.photo.fallback || "Photo could not be shown"),
          x + colW / 2,
          top + photoH / 2,
          { align: "center" },
        );
      }
      doc.setDrawColor(...C.line);
      doc.setLineWidth(RULE_W);
      doc.rect(x, top, colW, photoH + capH, "S");
      this.rule(x, top + photoH, x + colW, top + photoH);
      const layout = layouts[i];
      const by = top + photoH + 3 + size * PT * 0.72;
      let cx = x + 2.2;
      for (const p of layout.prefix) {
        if (p.tag) {
          this.font(size - 1.4, "bold");
          this.colour(C.orange);
          doc.text(p.text, cx, by, { charSpace: 0.35 });
        } else {
          this.font(size, "bold");
          this.colour(C.slate);
          doc.text(p.text, cx, by);
        }
        cx += p.w;
      }
      this.font(size);
      this.colour(C.slate);
      layout.lines.forEach((line, li) => {
        doc.text(line, li === 0 ? cx : x + 2.2, by + li * capLead);
      });
    });
    this.y = top + total;
  }

  /**
   * The photos: four to a row (two when there are only two), numbered
   * "Photo 1", "Photo 2" in order. Nothing is cropped, a photo never leaves its
   * caption, and a row that runs over a page carries the section bar with it.
   */
  gallery(
    photos: GalleryPhoto[],
    options: {
      targetH?: number;
      startNumber?: number;
      /** Called at the top of each page the gallery continues on. */
      onContinue?: () => void;
    } = {},
  ): void {
    this.closeBox();
    const start = options.startNumber ?? 1;
    const perRow = photos.length <= 2 ? 2 : 4;
    const photoH = perRow === 2 ? 96 : 54;
    for (let i = 0; i < photos.length; i += perRow) {
      const row = photos.slice(i, i + perRow).map((photo, j) => ({
        photo,
        number: start + i + j,
      }));
      const before = this.doc.getNumberOfPages();
      this.photoRow(row, perRow, photoH);
      if (this.doc.getNumberOfPages() !== before) options.onContinue?.();
    }
  }

  /** The state we found beside the state we left, two large cells. */
  beforeAfter(
    before: GalleryPhoto,
    after: GalleryPhoto,
    numbers: [number | null, number | null] = [null, null],
  ): void {
    this.closeBox();
    this.photoRow([
      { photo: { ...before, tag: before.tag || "Before" }, number: numbers[0] },
      { photo: { ...after, tag: after.tag || "After" }, number: numbers[1] },
    ], 2, 96);
  }

  /** One photo in its own large cell, caption beneath. */
  plate(photo: GalleryPhoto, counter?: string): void {
    this.closeBox();
    const n = counter ? Number(String(counter).split(/\D+/)[0]) : NaN;
    this.photoRow([{ photo, number: Number.isFinite(n) && n > 0 ? n : null }], 2, 96);
  }

  // ── Close ──

  /**
   * Close the document: a "Report issued by" table (unless asked not to),
   * then every page's footer once the page count is known.
   */
  finish(options: { endOfReport?: boolean; issuedOn?: string } = {}): void {
    const doc = this.doc;
    this.closeBox();
    if (options.endOfReport !== false) {
      const facts: ReportFact[] = [
        { label: "Company", value: REPORT_COMPANY.name },
        options.issuedOn
          ? { label: "Date of issue", value: options.issuedOn }
          : { label: "ABN", value: REPORT_COMPANY.abn },
      ];
      if (options.issuedOn) {
        facts.push({ label: "ABN", value: REPORT_COMPANY.abn });
        facts.push({ label: "Address", value: REPORT_COMPANY.address });
      } else {
        facts.push({ label: "Address", value: REPORT_COMPANY.address, wide: true });
      }
      facts.push({ label: "Email", value: REPORT_COMPANY.email });
      facts.push({ label: "Phone", value: REPORT_COMPANY.phone });
      this.section("Report issued by", 7.6 * 3);
      this.facts(facts, 4);
    }
    const total = doc.getNumberOfPages();
    for (let page = 1; page <= total; page++) {
      doc.setPage(page);
      const fy = P.H - 13;
      this.rule(P.MARGIN, fy, P.W - P.MARGIN, fy);
      this.font(7.4, "bold");
      this.colour(C.slate);
      doc.text(REPORT_COMPANY.name, P.MARGIN, fy + 4.2);
      const nameW = doc.getTextWidth(REPORT_COMPANY.name);
      this.font(7.4);
      this.colour(C.mid);
      doc.text(
        `ABN ${REPORT_COMPANY.abn}   |   ${REPORT_COMPANY.email}   |   ${REPORT_COMPANY.phone}`,
        P.MARGIN + nameW + 2.4,
        fy + 4.2,
      );
      doc.text(`Page ${page} of ${total}`, P.W - P.MARGIN, fy + 4.2, { align: "right" });
    }
  }
}
