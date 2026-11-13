// SecureWorks report design system: the ONE visual language every PDF this
// function renders shares (restoration report, make-safe report, roof report,
// restoration quote), so they read as one family.
//
// This module only DRAWS. It owns colours, type scale, page chrome (masthead,
// hero, running header, footer with "Page x of y"), and the building blocks
// (key facts card, at-a-glance band, section headers, paragraphs, bullets,
// numbered steps, definition grid, callout, before/after pair, photo gallery,
// full-page photo plate). It decides no content: each renderer keeps its own
// fields, wording, hashes, limits and file names.
//
// Layout rules the blocks keep for every caller:
//   - nothing is drawn below BODY_BOTTOM, so nothing can touch the footer;
//   - a photo is never split from its caption, and a gallery row never splits;
//   - text is measured before it is drawn, and breaks to a new page cleanly;
//   - photos go to jsPDF as raw bytes (never re-encoded to a string here).

import { MAKESAFE_REPORT_LOGO_DATA_URL } from "./makesafe_report_logo.ts";

export type Rgb = [number, number, number];

export const REPORT_COLOURS = {
  orange: [241, 90, 41] as Rgb, // #F15A29
  dark: [41, 60, 70] as Rgb, // #293C46
  mid: [76, 106, 124] as Rgb, // #4C6A7C
  light: [240, 244, 247] as Rgb, // #F0F4F7
  rule: [214, 222, 228] as Rgb,
  body: [52, 61, 68] as Rgb,
  white: [255, 255, 255] as Rgb,
  // Text on the dark hero.
  heroSoft: [176, 195, 206] as Rgb,
  shadow: [228, 233, 237] as Rgb,
} as const;

export const REPORT_PAGE = {
  W: 210,
  H: 297,
  MARGIN: 16,
  CONTENT_W: 210 - 2 * 16,
  /** Where body content starts on a page after the first. */
  RUNNING_TOP: 29,
  /** Nothing is drawn below this line except the footer. */
  BODY_BOTTOM: 275,
} as const;

const C = REPORT_COLOURS;
const P = REPORT_PAGE;
const PT = 0.3528; // one point in mm

export interface ReportImage {
  data: Uint8Array | string;
  format: "PNG" | "JPEG";
  /** Stable name so one image drawn twice is stored once. */
  alias?: string;
}

export interface ReportChrome {
  /** The kind of document, e.g. "Restoration Report". */
  kind: string;
  /** Hero headline. */
  title: string;
  /** Line(s) under the headline. */
  subtitle?: string;
  /** Shown top right on page one and in the running header and footer. */
  reference: string;
  /** Second masthead line on page one, e.g. a date. */
  referenceNote?: string;
  /** Footer, left. */
  tagline?: string;
  cover?: ReportImage | null;
}

export interface ReportFact {
  label: string;
  value: string;
  /** Take the whole row. */
  wide?: boolean;
}

export interface GalleryPhoto {
  image: ReportImage | null;
  caption: string;
  /** Small label above the caption, e.g. the room. */
  area?: string;
  /** Corner tag, e.g. "Before" or "After". */
  tag?: string;
  /** Text shown when the image cannot be drawn. */
  fallback?: string;
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

export interface GalleryRowItem {
  index: number;
  w: number;
  h: number;
}

/**
 * Justified rows: every photo in a row has the same height, widths follow each
 * photo's own shape, and a full row spans the whole width. Nothing is cropped.
 * Rows are chosen together (not greedily) so heights stay close to the target
 * and the last row is not left with a lone small photo when that can be
 * avoided. Pure, so tests can pin it.
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
        // The last photos are too few to span the width: keep them at a calm
        // size, left aligned.
        const h = Math.min(maxH, targetH * 1.15);
        return { h, cost: 900 + (natural - maxH) ** 2 };
      }
      // Mid-gallery a row always spans the width, even when that makes it
      // tall; a short row with a hole beside it reads as a mistake.
      if (natural <= targetH * 1.9) {
        return { h: natural, cost: (natural - targetH) ** 2 };
      }
      return { h: targetH * 1.9, cost: 20000 + (natural - maxH) ** 2 };
    }
    const squeeze = natural < minH ? 4000 + (minH - natural) * 400 : 0;
    // A row of small photos reads worse than a row of large ones.
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
  private sectionNo = 0;
  private dims = new Map<string, { w: number; h: number } | null>();

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

  /** Small letter-spaced capitals: field labels and eyebrows. */
  eyebrow(
    text: string,
    x: number,
    y: number,
    rgb: Rgb = C.mid,
    size = 6.4,
    align: "left" | "right" = "left",
  ): void {
    const value = reportText(text).toUpperCase();
    this.font(size, "bold");
    this.colour(rgb);
    const space = 0.28;
    if (align === "right") {
      const w = this.doc.getTextWidth(value) + space * (value.length - 1);
      this.doc.text(value, x - w, y, { charSpace: space });
    } else {
      this.doc.text(value, x, y, { charSpace: space });
    }
  }

  eyebrowWidth(text: string, size = 6.4): number {
    const value = reportText(text).toUpperCase();
    this.font(size, "bold");
    return this.doc.getTextWidth(value) + 0.28 * Math.max(0, value.length - 1);
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

  private clipRounded(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    draw: () => void,
  ): void {
    const doc = this.doc;
    doc.saveGraphicsState();
    try {
      if (r > 0) doc.roundedRect(x, y, w, h, r, r, null);
      else doc.rect(x, y, w, h, null);
      doc.clip();
      doc.discardPath();
      draw();
    } finally {
      doc.restoreGraphicsState();
    }
  }

  /** Draw the whole image inside the box, corners rounded. False if it failed. */
  drawImage(
    image: ReportImage | null,
    x: number,
    y: number,
    w: number,
    h: number,
    radius = 1.4,
  ): boolean {
    if (!image) return false;
    try {
      this.clipRounded(x, y, w, h, radius, () => {
        this.doc.addImage(
          image.data,
          image.format,
          x,
          y,
          w,
          h,
          image.alias,
          "FAST",
        );
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Fill the box with the image, cropping the overflow (cover photos only). */
  drawImageCover(
    image: ReportImage,
    x: number,
    y: number,
    w: number,
    h: number,
  ): boolean {
    const size = this.imageSize(image);
    if (!size) return false;
    const scale = Math.max(w / size.w, h / size.h);
    const dw = size.w * scale;
    const dh = size.h * scale;
    try {
      this.clipRounded(x, y, w, h, 0, () => {
        this.doc.addImage(
          image.data,
          image.format,
          x + (w - dw) / 2,
          y + (h - dh) / 2,
          dw,
          dh,
          image.alias,
          "FAST",
        );
      });
      return true;
    } catch {
      return false;
    }
  }

  private logo(x: number, y: number, w: number): void {
    try {
      this.doc.addImage(
        MAKESAFE_REPORT_LOGO_DATA_URL,
        "PNG",
        x,
        y,
        w,
        w * 169 / 1136,
        "sw-logo",
        "FAST",
      );
    } catch {
      this.font(11, "bold");
      this.colour(C.dark);
      this.doc.text("SecureWorks Group", x, y + 5);
    }
  }

  // ── Page chrome ──

  /** First page: masthead, hero panel, optional cover photo. */
  hero(options: { overlap?: boolean } = {}): void {
    const doc = this.doc;
    const chrome = this.chrome;
    doc.setFillColor(...C.orange);
    doc.rect(0, 0, P.W, 2.4, "F");
    this.logo(P.MARGIN, 9.6, 52);
    this.eyebrow(chrome.reference, P.W - P.MARGIN, 13.2, C.dark, 7.4, "right");
    if (chrome.referenceNote) {
      this.font(7.8);
      this.colour(C.mid);
      doc.text(reportText(chrome.referenceNote), P.W - P.MARGIN, 17.6, {
        align: "right",
      });
    }

    const top = 25;
    const cover = chrome.cover && this.imageSize(chrome.cover)
      ? chrome.cover
      : null;
    const coverX = 126;
    const textW = cover ? coverX - P.MARGIN - 10 : P.CONTENT_W - 18;
    const titleLines = this.wrap(chrome.title, textW, 22, "bold").slice(0, 4);
    const subLines = chrome.subtitle
      ? this.wrap(chrome.subtitle, textW, 9.6).slice(0, 3)
      : [];
    const titleLead = 9.2;
    const subLead = 4.9;
    const overlap = options.overlap ? 11 : 0;
    const inner = 13 + 6.5 + titleLines.length * titleLead +
      (subLines.length ? 2.5 + subLines.length * subLead : 0) + 9;
    const heroH = Math.max(cover ? 60 : 46, inner) + overlap;

    doc.setFillColor(...C.dark);
    doc.rect(0, top, P.W, heroH, "F");
    if (cover) {
      this.drawImageCover(cover, coverX, top, P.W - coverX, heroH);
      doc.setFillColor(...C.orange);
      doc.rect(coverX - 1.1, top, 1.1, heroH, "F");
    } else {
      // A quiet mark: three arcs rising from the lower right corner.
      const reach = heroH - 12;
      this.clipRounded(0, top, P.W, heroH, 0, () => {
        doc.setDrawColor(52, 73, 85);
        doc.setLineWidth(7);
        for (const k of [0.4, 0.68, 0.96]) {
          doc.circle(P.W - 6, top + heroH + 6, reach * k, "S");
        }
      });
    }

    let ty = top + 13 + Math.max(0, (heroH - overlap - inner) / 2);
    this.eyebrow(chrome.kind, P.MARGIN, ty, C.orange, 7.6);
    ty += 6.5 + 4.2;
    this.font(22, "bold");
    this.colour(C.white);
    for (const line of titleLines) {
      doc.text(line, P.MARGIN, ty);
      ty += titleLead;
    }
    if (subLines.length) {
      ty += 2.5 - 3.4;
      this.font(9.6);
      this.colour(C.heroSoft);
      for (const line of subLines) {
        doc.text(line, P.MARGIN, ty);
        ty += subLead;
      }
    }
    this.y = top + heroH - overlap + (overlap ? 0 : 8);
  }

  private runningHeader(): void {
    const doc = this.doc;
    doc.setFillColor(...C.orange);
    doc.rect(0, 0, P.W, 2.4, "F");
    this.logo(P.MARGIN, 10, 36);
    this.eyebrow(this.chrome.kind, P.W - P.MARGIN, 12, C.dark, 6.6, "right");
    this.font(7.4);
    this.colour(C.mid);
    doc.text(reportText(this.chrome.reference), P.W - P.MARGIN, 16, {
      align: "right",
    });
    doc.setDrawColor(...C.rule);
    doc.setLineWidth(0.25);
    doc.line(P.MARGIN, 20.5, P.W - P.MARGIN, 20.5);
    this.y = P.RUNNING_TOP;
  }

  newPage(): void {
    this.doc.addPage();
    this.runningHeader();
  }

  remaining(): number {
    return P.BODY_BOTTOM - this.y;
  }

  ensure(height: number): void {
    if (this.y + height > P.BODY_BOTTOM) this.newPage();
  }

  gap(mm: number): void {
    this.y += mm;
  }

  /** Stamp every page's footer once the page count is known. */
  finish(): void {
    const doc = this.doc;
    const total = doc.getNumberOfPages();
    for (let page = 1; page <= total; page++) {
      doc.setPage(page);
      doc.setDrawColor(...C.rule);
      doc.setLineWidth(0.25);
      doc.line(P.MARGIN, P.H - 15, P.W - P.MARGIN, P.H - 15);
      this.font(7.2, "bold");
      this.colour(C.dark);
      doc.text("SecureWorks Group", P.MARGIN, P.H - 10);
      const brandW = doc.getTextWidth("SecureWorks Group");
      this.font(7.2);
      this.colour(C.mid);
      if (this.chrome.tagline) {
        doc.text(
          `|  ${reportText(this.chrome.tagline)}`,
          P.MARGIN + brandW + 2,
          P.H - 10,
        );
      }
      doc.text(reportText(this.chrome.reference), P.W / 2, P.H - 10, {
        align: "center",
      });
      doc.text(`Page ${page} of ${total}`, P.W - P.MARGIN, P.H - 10, {
        align: "right",
      });
    }
  }

  // ── Blocks ──

  /** White card of key facts. Sits over the hero's lower edge when asked. */
  facts(items: ReportFact[], columns = 4): void {
    const doc = this.doc;
    const rows: ReportFact[][] = [];
    let row: ReportFact[] = [];
    for (const item of items) {
      if (item.wide) {
        if (row.length) rows.push(row);
        rows.push([item]);
        row = [];
        continue;
      }
      row.push(item);
      if (row.length === columns) {
        rows.push(row);
        row = [];
      }
    }
    if (row.length) rows.push(row);

    const pad = 5;
    const measured = rows.map((cells) => {
      const colW = cells[0].wide
        ? P.CONTENT_W
        : P.CONTENT_W / Math.max(cells.length, Math.min(columns, 2));
      const lines = cells.map((cell) =>
        this.wrap(cell.value || "-", colW - 2 * pad, 9.6, "bold")
      );
      const h = 6.2 + 4.6 + Math.max(...lines.map((l) => l.length)) * 4.3 + 2.6;
      return { cells, colW, lines, h };
    });
    const total = measured.reduce((sum, m) => sum + m.h, 0);
    this.ensure(total + 4);
    const top = this.y;
    doc.setFillColor(...C.shadow);
    doc.roundedRect(P.MARGIN + 0.5, top + 0.9, P.CONTENT_W, total, 2.2, 2.2, "F");
    doc.setFillColor(...C.white);
    doc.setDrawColor(...C.rule);
    doc.setLineWidth(0.25);
    doc.roundedRect(P.MARGIN, top, P.CONTENT_W, total, 2.2, 2.2, "FD");
    let ry = top;
    measured.forEach((m, rowIndex) => {
      if (rowIndex > 0) {
        doc.setDrawColor(...C.rule);
        doc.setLineWidth(0.2);
        doc.line(P.MARGIN + pad, ry, P.MARGIN + P.CONTENT_W - pad, ry);
      }
      m.cells.forEach((cell, i) => {
        const x = P.MARGIN + i * m.colW;
        if (i > 0) {
          doc.setDrawColor(...C.rule);
          doc.setLineWidth(0.2);
          doc.line(x, ry + 4, x, ry + m.h - 4);
        }
        this.eyebrow(cell.label, x + pad, ry + 6.6);
        this.font(9.6, "bold");
        this.colour(C.dark);
        doc.text(m.lines[i], x + pad, ry + 6.6 + 5.2, {
          lineHeightFactor: 4.3 / (9.6 * PT),
        });
      });
      ry += m.h;
    });
    this.y = top + total + 7;
  }

  /** Light band of headline numbers, with an optional outcome line. */
  glance(
    items: Array<{ label: string; value: string }>,
    outcome?: { label: string; text: string } | null,
  ): void {
    const doc = this.doc;
    const shown = items.filter((item) => reportText(item.value).trim());
    if (!shown.length && !outcome?.text) return;
    const pad = 6;
    // Longer values get a wider column, so a sentence does not stack up.
    const weights = shown.map((item) =>
      Math.max(16, Math.min(40, reportText(item.value).length + 6))
    );
    const weightSum = weights.reduce((sum, w) => sum + w, 0) || 1;
    const colWs = weights.map((w) => P.CONTENT_W * w / weightSum);
    const colXs = colWs.map((_, i) =>
      P.MARGIN + colWs.slice(0, i).reduce((sum, w) => sum + w, 0)
    );
    const lines = shown.map((item, i) =>
      this.wrap(item.value, colWs[i] - pad - 3, 11.5, "bold")
    );
    const colsH = shown.length
      ? 7 + 5.6 + Math.max(...lines.map((l) => l.length)) * 5 + 2.4
      : 0;
    const outcomeLines = outcome?.text
      ? this.wrap(outcome.text, P.CONTENT_W - 2 * pad - 5, 9.6)
      : [];
    const outcomeH = outcomeLines.length ? 7.5 + 4.6 + outcomeLines.length * 4.8 + 1.6 : 0;
    const total = colsH + outcomeH;
    this.ensure(total + 4);
    const top = this.y;
    doc.setFillColor(...C.light);
    doc.roundedRect(P.MARGIN, top, P.CONTENT_W, total, 2.2, 2.2, "F");
    shown.forEach((item, i) => {
      const x = colXs[i];
      if (i > 0) {
        doc.setDrawColor(...C.rule);
        doc.setLineWidth(0.25);
        doc.line(x, top + 5, x, top + colsH - 4);
      }
      this.eyebrow(item.label, x + pad, top + 7.6);
      this.font(11.5, "bold");
      this.colour(C.dark);
      doc.text(lines[i], x + pad, top + 7.6 + 6.2, {
        lineHeightFactor: 5 / (11.5 * PT),
      });
    });
    if (outcomeLines.length && outcome) {
      const oy = top + colsH;
      if (shown.length) {
        doc.setDrawColor(...C.rule);
        doc.setLineWidth(0.25);
        doc.line(P.MARGIN + pad, oy, P.MARGIN + P.CONTENT_W - pad, oy);
      }
      doc.setFillColor(...C.orange);
      doc.circle(P.MARGIN + pad + 1.1, oy + 6.6, 1.1, "F");
      this.eyebrow(outcome.label, P.MARGIN + pad + 5, oy + 7.5, C.orange);
      this.font(9.6);
      this.colour(C.dark);
      doc.text(outcomeLines, P.MARGIN + pad + 5, oy + 7.5 + 5, {
        lineHeightFactor: 4.8 / (9.6 * PT),
      });
    }
    this.y = top + total + 8;
  }

  /** Numbered section header with a hairline running to the margin. */
  section(title: string, keepWith = 14, note?: string): void {
    const doc = this.doc;
    if (this.y > P.RUNNING_TOP + 1) this.y += 3;
    this.ensure(11 + keepWith);
    this.sectionNo++;
    const label = String(this.sectionNo).padStart(2, "0");
    const base = this.y + 5.2;
    this.font(9, "bold");
    this.colour(C.orange);
    doc.text(label, P.MARGIN, base);
    this.font(13.5, "bold");
    this.colour(C.dark);
    const tx = P.MARGIN + 8;
    doc.text(title, tx, base);
    let end = tx + doc.getTextWidth(title);
    if (note) {
      this.font(8);
      this.colour(C.mid);
      doc.text(reportText(note), end + 3, base);
      end += 3 + doc.getTextWidth(reportText(note));
    }
    if (end + 5 < P.W - P.MARGIN) {
      doc.setDrawColor(...C.rule);
      doc.setLineWidth(0.3);
      doc.line(end + 4, base - 1.6, P.W - P.MARGIN, base - 1.6);
    }
    this.y += 11.5;
  }

  /** Small bold lead-in over a paragraph. */
  lead(text: string): void {
    this.ensure(14);
    this.font(9, "bold");
    this.colour(C.dark);
    this.doc.text(reportText(text), P.MARGIN, this.y + 3.2);
    this.y += 5.4;
  }

  /** Body paragraphs. Blank lines in the text separate paragraphs. */
  paragraph(
    text: unknown,
    options: { x?: number; width?: number; rgb?: Rgb; size?: number } = {},
  ): void {
    const x = options.x ?? P.MARGIN;
    const width = options.width ?? P.W - P.MARGIN - x;
    const size = options.size ?? 9.6;
    const leading = size * PT * 1.48;
    const blocks = (reportText(text) || "-").split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = this.wrap(block.trim() || "-", width, size);
      for (let i = 0; i < lines.length; i++) {
        // Keep the last two lines of a paragraph together.
        const need = i === lines.length - 2 ? leading * 2 : leading;
        this.ensure(need);
        this.font(size);
        this.colour(options.rgb ?? C.body);
        this.doc.text(lines[i], x, this.y + 3.3);
        this.y += leading;
      }
      this.y += 2.6;
    }
    this.y += 1;
  }

  bullets(items: string[]): void {
    const size = 9.6;
    const leading = size * PT * 1.48;
    for (const item of items) {
      const lines = this.wrap(item, P.CONTENT_W - 7, size);
      this.ensure(lines.length * leading + 1.6);
      this.doc.setFillColor(...C.orange);
      this.doc.circle(P.MARGIN + 1.6, this.y + 2.1, 0.85, "F");
      this.font(size);
      this.colour(C.body);
      this.doc.text(lines, P.MARGIN + 6, this.y + 3.3, {
        lineHeightFactor: leading / (size * PT),
      });
      this.y += lines.length * leading + 1.6;
    }
    this.y += 2.4;
  }

  /** Numbered steps joined by a thin line: the order the work was done in. */
  steps(items: string[]): void {
    const doc = this.doc;
    const size = 9.6;
    const leading = size * PT * 1.48;
    const cx = P.MARGIN + 3.6;
    const tx = P.MARGIN + 12;
    items.forEach((item, i) => {
      const lines = this.wrap(item, P.W - P.MARGIN - tx, size);
      const h = Math.max(8.2, lines.length * leading + 2.2) + 2;
      const before = this.y;
      this.ensure(h);
      const fresh = this.y !== before;
      const top = this.y;
      if (i > 0 && !fresh) {
        doc.setDrawColor(...C.rule);
        doc.setLineWidth(0.5);
        doc.line(cx, top - 2.2, cx, top + 0.6);
      }
      if (i < items.length - 1) {
        doc.setDrawColor(...C.rule);
        doc.setLineWidth(0.5);
        doc.line(cx, top + 7, cx, top + h - 2.2);
      }
      doc.setFillColor(...C.orange);
      doc.circle(cx, top + 3.8, 3.3, "F");
      this.font(8.2, "bold");
      this.colour(C.white);
      doc.text(String(i + 1), cx, top + 4.85, { align: "center" });
      this.font(size);
      this.colour(C.body);
      doc.text(lines, tx, top + 4.9, {
        lineHeightFactor: leading / (size * PT),
      });
      this.y = top + h;
    });
    this.y += 3;
  }

  /** A quoted block: the instruction we were given, with an optional note. */
  callout(
    label: string,
    text: string,
    note?: string | null,
    options: { plainLabel?: boolean } = {},
  ): void {
    const doc = this.doc;
    const pad = 6;
    const width = P.CONTENT_W - 2 * pad - 2;
    const lines = this.wrap(text, width, 10);
    const noteLines = note ? this.wrap(note, width, 8.2) : [];
    const h = 7 + 4.8 + lines.length * 5.1 +
      (noteLines.length ? 2.4 + noteLines.length * 4 : 0) + 3.4;
    this.ensure(h + 4);
    const top = this.y;
    doc.setFillColor(...C.light);
    doc.roundedRect(P.MARGIN, top, P.CONTENT_W, h, 2.2, 2.2, "F");
    doc.setFillColor(...C.orange);
    doc.rect(P.MARGIN, top + 2.2, 1.3, h - 4.4, "F");
    if (options.plainLabel) {
      // The label as written (not capitals), for headings a reader looks for.
      this.font(8.4, "bold");
      this.colour(C.orange);
      doc.text(reportText(label), P.MARGIN + pad + 1, top + 7.6);
    } else {
      this.eyebrow(label, P.MARGIN + pad + 1, top + 7.4, C.orange);
    }
    this.font(10);
    this.colour(C.dark);
    doc.text(lines, P.MARGIN + pad + 1, top + 7.4 + 5.6, {
      lineHeightFactor: 5.1 / (10 * PT),
    });
    if (noteLines.length) {
      this.font(8.2);
      this.colour(C.mid);
      doc.text(
        noteLines,
        P.MARGIN + pad + 1,
        top + 7.4 + 5.6 + lines.length * 5.1 + 1.8,
        { lineHeightFactor: 4 / (8.2 * PT) },
      );
    }
    this.y = top + h + 7;
  }

  /** Label over value, in columns, split by hairlines. */
  kvGrid(rows: Array<[string, string]>, columns = 2): void {
    const doc = this.doc;
    const colGap = 8;
    const colW = (P.CONTENT_W - colGap * (columns - 1)) / columns;
    for (let i = 0; i < rows.length; i += columns) {
      const cells = rows.slice(i, i + columns);
      const labels = cells.map(([label]) => {
        this.font(6.4, "bold");
        const text = reportText(label).toUpperCase();
        // Letter spacing widens the label; wrap against a narrower box.
        return doc.splitTextToSize(text, colW * 0.78) as string[];
      });
      const values = cells.map(([, value]) =>
        this.wrap(reportText(value).trim() || "-", colW - 2, 9.4)
      );
      const h = Math.max(
        ...cells.map((_, c) =>
          3.6 + labels[c].length * 3.1 + 1.6 + values[c].length * 4.4 + 1.4
        ),
      );
      this.ensure(h);
      const top = this.y;
      cells.forEach((_, c) => {
        const x = P.MARGIN + c * (colW + colGap);
        doc.setDrawColor(...C.rule);
        doc.setLineWidth(0.25);
        doc.line(x, top, x + colW, top);
        this.font(6.4, "bold");
        this.colour(C.mid);
        doc.text(labels[c], x, top + 5, {
          charSpace: 0.28,
          lineHeightFactor: 3.1 / (6.4 * PT),
        });
        this.font(9.4);
        this.colour(C.dark);
        doc.text(values[c], x, top + 5 + labels[c].length * 3.1 + 2.2, {
          lineHeightFactor: 4.4 / (9.4 * PT),
        });
      });
      this.y = top + h;
    }
    this.y += 3;
  }

  /** A quiet line of small grey text. */
  note(text: string): void {
    const lines = this.wrap(text, P.CONTENT_W, 8.4);
    this.ensure(lines.length * 4.2 + 2);
    this.font(8.4);
    this.colour(C.mid);
    this.doc.text(lines, P.MARGIN, this.y + 3, {
      lineHeightFactor: 4.2 / (8.4 * PT),
    });
    this.y += lines.length * 4.2 + 3;
  }

  private tagPill(text: string, x: number, y: number, rgb: Rgb): void {
    const doc = this.doc;
    const w = this.eyebrowWidth(text, 6.2) + 5;
    doc.setFillColor(...rgb);
    doc.roundedRect(x, y, w, 4.8, 2.4, 2.4, "F");
    this.eyebrow(text, x + 2.5, y + 3.35, C.white, 6.2);
  }

  private tagColour(tag: string): Rgb {
    return /after/i.test(tag) ? C.orange : C.dark;
  }

  private numberBadge(n: number, x: number, y: number): void {
    const doc = this.doc;
    const label = String(n).padStart(2, "0");
    doc.setFillColor(...C.dark);
    doc.roundedRect(x, y, 7.4, 4.8, 1.2, 1.2, "F");
    this.font(6.8, "bold");
    this.colour(C.white);
    doc.text(label, x + 3.7, y + 3.4, { align: "center" });
  }

  private photoMissing(
    x: number,
    y: number,
    w: number,
    h: number,
    text: string,
  ): void {
    const doc = this.doc;
    doc.setFillColor(...C.light);
    doc.roundedRect(x, y, w, h, 1.4, 1.4, "F");
    this.font(8);
    this.colour(C.mid);
    doc.text(reportText(text), x + w / 2, y + h / 2, { align: "center" });
  }

  private captionLines(photo: GalleryPhoto, width: number): string[] {
    return photo.caption ? this.wrap(photo.caption, width, 8.2).slice(0, 5) : [];
  }

  private captionHeight(photo: GalleryPhoto, width: number): number {
    return (photo.area ? 3.6 : 0) + this.captionLines(photo, width).length * 3.9;
  }

  private drawCaption(
    photo: GalleryPhoto,
    x: number,
    y: number,
    width: number,
  ): void {
    let cy = y;
    if (photo.area) {
      this.eyebrow(photo.area, x, cy + 2.4, C.mid, 5.8);
      cy += 3.6;
    }
    const lines = this.captionLines(photo, width);
    if (lines.length) {
      this.font(8.2);
      this.colour(C.dark);
      this.doc.text(lines, x, cy + 2.9, {
        lineHeightFactor: 3.9 / (8.2 * PT),
      });
    }
  }

  /**
   * Two photos side by side at one height: the state we found and the state we
   * left. Kept whole on one page.
   */
  beforeAfter(before: GalleryPhoto, after: GalleryPhoto): void {
    const doc = this.doc;
    const gapW = 14;
    const colW = (P.CONTENT_W - gapW) / 2;
    const aspects = [this.aspect(before.image), this.aspect(after.image)];
    const h = Math.min(104, ...aspects.map((a) => colW / a));
    const widths = aspects.map((a) => Math.min(colW, a * h));
    const capH = Math.max(
      this.captionHeight(before, colW),
      this.captionHeight(after, colW),
    );
    const total = 7.5 + h + 3 + capH + 6;
    this.ensure(total);
    const top = this.y;
    [before, after].forEach((photo, i) => {
      const colX = P.MARGIN + i * (colW + gapW);
      const x = colX + (colW - widths[i]) / 2;
      this.tagPill(photo.tag || (i ? "After" : "Before"), x, top, i ? C.orange : C.dark);
      const ok = this.drawImage(photo.image, x, top + 7.5, widths[i], h, 1.6);
      if (!ok) {
        this.photoMissing(x, top + 7.5, widths[i], h, photo.fallback || "Photo could not be shown");
      }
      this.drawCaption(photo, x, top + 7.5 + h + 3, widths[i]);
    });
    // The arrow between them.
    const ax = P.MARGIN + colW + gapW / 2;
    const ay = top + 7.5 + h / 2;
    doc.setFillColor(...C.orange);
    doc.circle(ax, ay, 4.2, "F");
    doc.setDrawColor(...C.white);
    doc.setLineWidth(0.7);
    doc.line(ax - 2, ay, ax + 1.8, ay);
    doc.line(ax + 0.2, ay - 1.6, ax + 1.9, ay);
    doc.line(ax + 0.2, ay + 1.6, ax + 1.9, ay);
    this.y = top + total;
  }

  /**
   * Photo gallery in justified rows. Each photo keeps its own shape (nothing is
   * cropped), a row never splits, and a caption never leaves its photo. When a
   * page ends with room to spare, the room is shared between its rows.
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
    if (!photos.length) return;
    const gapX = 4;
    const gapY = 6.5;
    const wanted = options.targetH ?? 72;
    const aspects = photos.map((photo) => this.aspect(photo.image));
    const WINDOW = 28;

    // What one page would hold from photo `from` at one photo size. `fit`
    // below 1 shrinks every row on the page alike and opens the gutters to
    // match, so both edges stay on the margins and one more row can come up.
    type Placed = { index: number; x: number; w: number; h: number };
    const pagePlan = (
      from: number,
      room: number,
      targetH: number,
      fit: number,
    ) => {
      const slice = aspects.slice(from, from + WINDOW);
      const rows = layoutGalleryRows(slice, P.CONTENT_W, targetH, gapX);
      const taken: Array<{ cells: Placed[]; h: number }> = [];
      let used = 0;
      let count = 0;
      for (const row of rows) {
        const natural = row.reduce((sum, cell) => sum + cell.w, 0) +
          gapX * (row.length - 1);
        const full = natural > P.CONTENT_W - 0.5;
        const widths = row.map((cell) => cell.w * fit);
        const sum = widths.reduce((total, w) => total + w, 0);
        const gutter = full && row.length > 1
          ? (P.CONTENT_W - sum) / (row.length - 1)
          : gapX;
        let x = full && row.length === 1
          ? P.MARGIN + (P.CONTENT_W - sum) / 2
          : P.MARGIN;
        const cells: Placed[] = row.map((cell, i) => {
          const placed = {
            index: from + cell.index,
            x,
            w: widths[i],
            h: cell.h * fit,
          };
          x += widths[i] + gutter;
          return placed;
        });
        const capH = Math.max(
          ...cells.map((cell) => this.captionHeight(photos[cell.index], cell.w)),
        );
        const h = cells[0].h + 2.6 + capH;
        const need = h + (taken.length ? gapY : 0);
        if (used + need > room) break;
        used += need;
        count += row.length;
        taken.push({ cells, h });
      }
      return { taken, used, count };
    };

    let from = 0;
    while (from < photos.length) {
      const room = P.BODY_BOTTOM - this.y;
      const left = photos.length - from;
      // Try a range of photo sizes around the wanted one. If everything left
      // fits, take the largest size that fits. Otherwise take the size that
      // fills this page best, so a page does not end half empty.
      let best: ReturnType<typeof pagePlan> | null = null;
      let bestScore = -Infinity;
      for (const fit of [1, 0.95, 0.9]) {
        for (let k = 1.16; k >= 0.775; k -= 0.03) {
          const candidate = pagePlan(from, room, wanted * k, fit);
          if (!candidate.count) continue;
          const fill = candidate.used / room;
          // Finishing on this page only counts while the photos stay large.
          const finishes = candidate.count >= left && k * fit >= 0.85;
          const score = finishes
            ? 10 + Math.min(k, 1.08) * fit
            : Math.min(fill, 0.94) - Math.abs(1 - k) * 0.12 - (1 - fit) * 0.5;
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }
      }
      if (!best) {
        if (this.y > P.RUNNING_TOP + 0.5) {
          this.newPage();
          options.onContinue?.();
          continue;
        }
        // One row taller than a whole page: draw it anyway, alone.
        const lone = pagePlan(from, 10_000, wanted * 0.78, 0.9);
        best = {
          ...lone,
          taken: lone.taken.slice(0, 1),
          count: lone.taken[0].cells.length,
        };
      }
      const finishesHere = best.count >= left;
      const slack = room - best.used;
      const extra = !finishesHere && best.taken.length > 1
        ? Math.min(6, Math.max(0, slack) / (best.taken.length - 1))
        : 0;
      for (const { cells, h } of best.taken) {
        const top = this.y;
        for (const cell of cells) {
          const photo = photos[cell.index];
          const ok = this.drawImage(photo.image, cell.x, top, cell.w, cell.h);
          if (!ok) {
            this.photoMissing(
              cell.x,
              top,
              cell.w,
              cell.h,
              photo.fallback || "Photo could not be shown",
            );
          }
          this.numberBadge(
            (options.startNumber ?? 1) + cell.index,
            cell.x + 1.8,
            top + 1.8,
          );
          if (photo.tag) {
            const w = this.eyebrowWidth(photo.tag, 6.2) + 5;
            if (w + 12 < cell.w) {
              this.tagPill(
                photo.tag,
                cell.x + cell.w - w - 1.8,
                top + 1.8,
                this.tagColour(photo.tag),
              );
            }
          }
          this.drawCaption(photo, cell.x, top + cell.h + 2.6, cell.w);
        }
        this.y = top + h + gapY + extra;
      }
      from += best.count;
      if (from < photos.length) {
        this.newPage();
        options.onContinue?.();
      }
    }
  }

  /** One large photo filling the rest of the page, caption beneath. */
  plate(photo: GalleryPhoto, counter?: string): void {
    const doc = this.doc;
    const capLines = photo.caption
      ? this.wrap(photo.caption, P.CONTENT_W - 30, 9, "bold").slice(0, 3)
      : [];
    const capH = 5 + Math.max(1, capLines.length) * 4.4 + 4;
    const room = this.remaining() - capH - 1;
    const top = this.y;
    const aspect = this.aspect(photo.image);
    const maxW = P.CONTENT_W - 10;
    const scale = Math.min(maxW / aspect, room - 10);
    const w = aspect * scale;
    const h = scale;
    // The mat hugs the photo, so a wide photo is not lost in a tall grey box.
    const boxH = Math.min(room, h + 10);
    doc.setFillColor(...C.light);
    doc.roundedRect(P.MARGIN, top, P.CONTENT_W, boxH, 2.2, 2.2, "F");
    const ok = this.drawImage(
      photo.image,
      P.MARGIN + (P.CONTENT_W - w) / 2,
      top + (boxH - h) / 2,
      w,
      h,
      1.2,
    );
    if (!ok) {
      this.font(8.4);
      this.colour(C.mid);
      doc.text(
        reportText(photo.fallback || "Photo could not be shown"),
        P.W / 2,
        top + boxH / 2,
        { align: "center" },
      );
    }
    const cy = top + boxH + 5;
    doc.setFillColor(...C.orange);
    doc.rect(P.MARGIN, cy - 0.4, 1.3, Math.max(1, capLines.length) * 4.4 + 1, "F");
    this.font(9, "bold");
    this.colour(C.dark);
    if (capLines.length) {
      doc.text(capLines, P.MARGIN + 4.5, cy + 3.2, {
        lineHeightFactor: 4.4 / (9 * PT),
      });
    }
    if (counter) {
      this.font(8);
      this.colour(C.mid);
      doc.text(counter, P.W - P.MARGIN, cy + 3.2, { align: "right" });
    }
    this.y = P.BODY_BOTTOM;
  }
}
