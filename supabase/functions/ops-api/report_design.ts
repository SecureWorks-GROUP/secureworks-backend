// SecureWorks report design: the ONE visual language every PDF this function
// renders shares (restoration report, make-safe report, roof report,
// restoration quote), so they read as one family.
//
// The look is a sober consultant's report (owner, 13 Nov 2026: "official, not
// slop"): a plain letterhead with the company's details and one thin orange
// rule, a ruled document control table, numbered sections and paragraphs
// (1.1, 1.2), ruled tables with hairline borders and a light grey key column,
// a photographic record as a two-per-row ruled schedule ("Photo N" under each
// photo), a running header and a footer with "Page x of y". No dark panels, no
// rounded cards, no pills, no icons, no coloured fills beyond the light grey.
//
// This module only DRAWS. It decides no content: each renderer keeps its own
// fields, wording, hashes, limits and file names.
//
// Layout rules the blocks keep for every caller:
//   - nothing is drawn below BODY_BOTTOM, so nothing can touch the footer;
//   - a photo is never split from its caption, and a table row never splits;
//   - text is measured before it is drawn, and breaks to a new page cleanly;
//   - photos go to jsPDF as raw bytes (never re-encoded to a string here).

export type Rgb = [number, number, number];

export const REPORT_COLOURS = {
  orange: [241, 90, 41] as Rgb, // #F15A29, the one accent: the letterhead rule
  ink: [20, 20, 20] as Rgb,
  grey: [84, 84, 84] as Rgb,
  hair: [140, 140, 140] as Rgb,
  shade: [241, 241, 241] as Rgb,
  white: [255, 255, 255] as Rgb,
  // Older names, kept so a caller that names them still draws in this palette.
  dark: [20, 20, 20] as Rgb,
  mid: [84, 84, 84] as Rgb,
  body: [20, 20, 20] as Rgb,
  light: [241, 241, 241] as Rgb,
  rule: [140, 140, 140] as Rgb,
} as const;

export const REPORT_PAGE = {
  W: 210,
  H: 297,
  MARGIN: 20,
  CONTENT_W: 210 - 2 * 20,
  /** Where body content starts on a page after the first. */
  RUNNING_TOP: 24,
  /** Nothing is drawn below this line except the footer. */
  BODY_BOTTOM: 278,
} as const;

/** Company details printed on the letterhead and in the closing block. */
export const REPORT_COMPANY = {
  name: "SecureWorks Group",
  tagline: "Emergency make safe and insurance restoration",
  abn: "ABN 64 689 223 416",
  address: "15 Utah Gr, Joondalup WA 6027",
  email: "admin@secureworkswa.com.au",
  phone: "+61 489 267 771",
} as const;

const C = REPORT_COLOURS;
const P = REPORT_PAGE;
const PT = 0.3528; // one point in mm
const HAIR_W = 0.18; // hairline, mm
const BODY = 9.6; // body text size, pt
const LEAD = 4.7; // body leading, mm
const NUM_W = 11; // hanging indent for 1.1, 1.2 ..., mm

export interface ReportImage {
  data: Uint8Array | string;
  format: "PNG" | "JPEG";
  /** Stable name so one image drawn twice is stored once. */
  alias?: string;
}

export interface ReportChrome {
  /** The kind of document, e.g. "Restoration Report". */
  kind: string;
  /** What the document is about, under the kind on page one. */
  title: string;
  /** Line(s) under the title, e.g. the property address. */
  subtitle?: string;
  /** Report or quote number: running header and footer. */
  reference: string;
  /** A second line beside the reference, e.g. a date (page one only). */
  referenceNote?: string;
  /** Running header, right: usually the property. */
  site?: string;
  /** Older field; the footer now carries the company and ABN. */
  tagline?: string;
  /** Older field; this design has no cover photo. */
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
  /** The room or area, e.g. "Activity room". */
  area?: string;
  /** "Before" or "After", printed at the start of the caption. */
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

/** "Photo 3  Before: wall unit ..." without saying Before twice. */
export function photoCaptionText(photo: GalleryPhoto): string {
  const caption = reportText(photo.caption).trim();
  const tag = reportText(photo.tag).trim();
  if (tag && !caption.toLowerCase().startsWith(tag.toLowerCase())) {
    return caption ? `${tag}: ${caption}` : tag;
  }
  return caption;
}

export interface GalleryRowItem {
  index: number;
  w: number;
  h: number;
}

/**
 * Justified rows: every photo in a row has the same height, widths follow each
 * photo's own shape, and a full row spans the whole width. Nothing is cropped.
 * Pure. No longer used for the photographic record (a fixed two-per-row
 * schedule), kept for callers and tests that lay photos out by shape.
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

/** One cell of a ruled table. */
export interface TableCell {
  text: string;
  /** Bold text (key cells and header rows). */
  bold?: boolean;
  /** Light grey fill (key cells and header rows). */
  shade?: boolean;
  /** Smaller grey line(s) under the text. */
  note?: string;
  /** Right-align (money and quantities). */
  align?: "left" | "right";
}

export class ReportCanvas {
  readonly doc: Doc;
  readonly chrome: ReportChrome;
  y = 0;
  private sectionNo = 0;
  private paraNo = 0;
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

  /** A small bold field label (plain case, no letter spacing). */
  eyebrow(
    text: string,
    x: number,
    y: number,
    rgb: Rgb = C.grey,
    size = 7.6,
    align: "left" | "right" = "left",
  ): void {
    this.font(size, "bold");
    this.colour(rgb);
    this.doc.text(reportText(text), x, y, align === "right" ? { align: "right" } : undefined);
  }

  eyebrowWidth(text: string, size = 7.6): number {
    this.font(size, "bold");
    return this.doc.getTextWidth(reportText(text));
  }

  private hairline(x1: number, y1: number, x2: number, y2: number): void {
    this.doc.setDrawColor(...C.hair);
    this.doc.setLineWidth(HAIR_W);
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

  /** Draw the whole image in the box, square corners. False if it failed. */
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

  // ── Page chrome ──

  /** Page one: letterhead, one orange rule, then the document's title block. */
  hero(_options: { overlap?: boolean } = {}): void {
    const doc = this.doc;
    const chrome = this.chrome;
    const right = P.W - P.MARGIN;
    this.font(19, "bold");
    this.colour(C.ink);
    doc.text(REPORT_COMPANY.name, P.MARGIN, 22);
    this.font(8.5);
    this.colour(C.grey);
    doc.text(REPORT_COMPANY.tagline, P.MARGIN, 27);
    this.font(8.5);
    this.colour(C.ink);
    let ry = 17.5;
    for (
      const line of [
        REPORT_COMPANY.abn,
        REPORT_COMPANY.address,
        REPORT_COMPANY.email,
        REPORT_COMPANY.phone,
      ]
    ) {
      doc.text(line, right, ry, { align: "right" });
      ry += 3.9;
    }
    doc.setDrawColor(...C.orange);
    doc.setLineWidth(0.39);
    doc.line(P.MARGIN, 32, right, 32);

    let ty = 43;
    this.font(17, "bold");
    this.colour(C.ink);
    doc.text(reportText(chrome.kind), P.MARGIN, ty);
    ty += 6.4;
    const sub = [chrome.title, chrome.subtitle]
      .map((t) => reportText(t).trim())
      .filter(Boolean)
      .join("\n");
    if (sub) {
      const lines = this.wrap(sub, P.CONTENT_W, 10.5).slice(0, 5);
      this.font(10.5);
      this.colour(C.grey);
      doc.text(lines, P.MARGIN, ty, { lineHeightFactor: 4.9 / (10.5 * PT) });
      ty += lines.length * 4.9;
    }
    this.y = ty + 3;
  }

  private runningHeader(): void {
    const doc = this.doc;
    this.font(8);
    this.colour(C.grey);
    doc.text(
      `${reportText(this.chrome.kind)}  ${reportText(this.chrome.reference)}`,
      P.MARGIN,
      14,
    );
    if (this.chrome.site) {
      doc.text(reportText(this.chrome.site), P.W - P.MARGIN, 14, { align: "right" });
    }
    this.hairline(P.MARGIN, 16, P.W - P.MARGIN, 16);
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

  /**
   * Close the document: an "issued by" block and "End of report" (unless
   * asked not to), then every page's footer once the page count is known.
   */
  finish(options: { endOfReport?: boolean; issuedOn?: string } = {}): void {
    const doc = this.doc;
    if (options.endOfReport !== false) {
      const rows: Array<[string, string]> = [
        ["Report issued by", `${REPORT_COMPANY.name}, ${REPORT_COMPANY.abn}`],
      ];
      if (options.issuedOn) rows.push(["Date of issue", options.issuedOn]);
      rows.push(["Enquiries", `${REPORT_COMPANY.email}, ${REPORT_COMPANY.phone}`]);
      const h = this.tableHeight([40, P.CONTENT_W - 40], rows.map(keyRow)) + 12;
      this.y += 4;
      this.ensure(h);
      this.table([40, P.CONTENT_W - 40], rows.map(keyRow));
      this.font(8.8);
      this.colour(C.grey);
      doc.text("End of report", P.W / 2, this.y + 4, { align: "center" });
      this.y += 8;
    }
    const total = doc.getNumberOfPages();
    for (let page = 1; page <= total; page++) {
      doc.setPage(page);
      this.hairline(P.MARGIN, P.H - 15, P.W - P.MARGIN, P.H - 15);
      this.font(8);
      this.colour(C.grey);
      doc.text(`${REPORT_COMPANY.name}  ${REPORT_COMPANY.abn}`, P.MARGIN, P.H - 10.8);
      doc.text(reportText(this.chrome.reference), P.W / 2, P.H - 10.8, {
        align: "center",
      });
      doc.text(`Page ${page} of ${total}`, P.W - P.MARGIN, P.H - 10.8, {
        align: "right",
      });
    }
  }

  // ── Ruled tables ──

  private cellLines(cell: TableCell, width: number): { text: string[]; note: string[] } {
    const inner = width - 2 * 1.8;
    // A key like "Gutters/valleys/downpipes" may break after a slash, never mid-word.
    const raw = cell.shade ? String(cell.text || "-").replace(/\/(?=\S)/g, "/ ") : cell.text || "-";
    return {
      text: this.wrap(raw, inner, 9, cell.bold ? "bold" : "normal"),
      note: cell.note ? this.wrap(cell.note, inner, 8) : [],
    };
  }

  private rowHeight(widths: number[], row: TableCell[]): number {
    let h = 0;
    row.forEach((cell, i) => {
      const { text, note } = this.cellLines(cell, widths[i]);
      h = Math.max(h, 2.2 + text.length * 4.1 + (note.length ? 1 + note.length * 3.7 : 0) + 1.5);
    });
    return h;
  }

  tableHeight(widths: number[], rows: TableCell[][]): number {
    return rows.reduce((sum, row) => sum + this.rowHeight(widths, row), 0);
  }

  /**
   * A ruled table: hairline grid, light grey on shaded cells, 9pt text. A row
   * never splits; a table that runs over a page carries on, repeating its
   * header row when it has one.
   */
  table(
    widths: number[],
    rows: TableCell[][],
    options: { header?: boolean; x?: number } = {},
  ): void {
    const doc = this.doc;
    const header = options.header ? rows[0] : null;
    const drawRow = (row: TableCell[]) => {
      const h = this.rowHeight(widths, row);
      const top = this.y;
      let x = options.x ?? P.MARGIN;
      row.forEach((cell, i) => {
        const w = widths[i];
        if (cell.shade) {
          doc.setFillColor(...C.shade);
          doc.rect(x, top, w, h, "F");
        }
        const { text, note } = this.cellLines(cell, w);
        this.font(9, cell.bold ? "bold" : "normal");
        this.colour(C.ink);
        if (cell.align === "right") {
          doc.text(text, x + w - 1.8, top + 2.2 + 3, {
            lineHeightFactor: 4.1 / (9 * PT),
            align: "right",
          });
        } else {
          doc.text(text, x + 1.8, top + 2.2 + 3, { lineHeightFactor: 4.1 / (9 * PT) });
        }
        if (note.length) {
          this.font(8);
          this.colour(C.grey);
          doc.text(note, x + 1.8, top + 2.2 + text.length * 4.1 + 1 + 2.7, {
            lineHeightFactor: 3.7 / (8 * PT),
          });
        }
        doc.setDrawColor(...C.hair);
        doc.setLineWidth(HAIR_W);
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

  // ── Blocks ──

  /** Document control: label and value pairs, two pairs a row. */
  facts(items: ReportFact[], columns = 4): void {
    const pairs = Math.max(1, Math.min(2, Math.floor(columns / 2) || 1));
    const keyW = 31;
    const valW = P.CONTENT_W / pairs - keyW;
    const rows: TableCell[][] = [];
    let row: TableCell[] = [];
    const flush = () => {
      if (!row.length) return;
      if (row.length < pairs * 2) {
        // A short last row: the last value takes the rest of the row.
        rows.push(row);
      } else rows.push(row);
      row = [];
    };
    for (const item of items) {
      if (item.wide) {
        flush();
        rows.push([
          { text: item.label, bold: true, shade: true },
          { text: item.value },
        ]);
        continue;
      }
      row.push({ text: item.label, bold: true, shade: true }, { text: item.value });
      if (row.length === pairs * 2) flush();
    }
    flush();
    // Draw each row with widths that fit its own cell count.
    for (const cells of rows) {
      const widths = cells.length === 2
        ? [keyW, P.CONTENT_W - keyW]
        : pairs === 2
        ? [keyW, valW, keyW, valW]
        : [keyW, P.CONTENT_W - keyW];
      const h = this.rowHeight(widths, cells);
      this.ensure(h);
      this.table(widths, [cells]);
    }
    this.y += 4;
  }

  /** Site attendance: one ruled row a figure, the outcome last. */
  glance(
    items: Array<{ label: string; value: string }>,
    outcome?: { label: string; text: string } | null,
  ): void {
    const rows: TableCell[][] = items
      .filter((item) => reportText(item.value).trim())
      .map((item) => keyRow([item.label, item.value]));
    if (outcome?.text) rows.push(keyRow([outcome.label, outcome.text]));
    if (!rows.length) return;
    this.table([40, P.CONTENT_W - 40], rows);
    this.y += 4;
  }

  /** "3.   Observations": numbered section heading, kept with what follows. */
  section(title: string, keepWith = 14, note?: string): void {
    const doc = this.doc;
    if (this.y > P.RUNNING_TOP + 1) this.y += 4;
    this.ensure(9 + keepWith);
    this.sectionNo++;
    this.paraNo = 0;
    const base = this.y + 4.4;
    this.font(11.5, "bold");
    this.colour(C.ink);
    const label = `${this.sectionNo}.`;
    doc.text(label, P.MARGIN, base);
    doc.text(reportText(title), P.MARGIN + NUM_W, base);
    if (note) {
      const end = P.MARGIN + NUM_W + doc.getTextWidth(reportText(title));
      this.font(8.6);
      this.colour(C.grey);
      doc.text(reportText(note), end + 3, base);
    }
    this.y += 8.4;
  }

  /** The next paragraph number in this section, e.g. "4.3". */
  private nextNumber(): string {
    this.paraNo++;
    return `${this.sectionNo}.${this.paraNo}`;
  }

  /** Small bold lead-in over a paragraph. */
  lead(text: string): void {
    this.ensure(14);
    this.font(BODY, "bold");
    this.colour(C.ink);
    this.doc.text(reportText(text), P.MARGIN + (this.sectionNo ? NUM_W : 0), this.y + 3.4);
    this.y += 5.6;
  }

  /**
   * Body paragraphs. Blank lines separate paragraphs. Inside a section each
   * paragraph is numbered (4.1, 4.2) with a hanging indent, unless `plain`.
   */
  paragraph(
    text: unknown,
    options: { x?: number; width?: number; rgb?: Rgb; size?: number; plain?: boolean } = {},
  ): void {
    const numbered = !options.plain && options.x === undefined && this.sectionNo > 0;
    const x = options.x ?? P.MARGIN + (numbered ? NUM_W : 0);
    const width = options.width ?? P.W - P.MARGIN - x;
    const size = options.size ?? BODY;
    const leading = size * PT * 1.45;
    const blocks = (reportText(text) || "-").split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = this.wrap(block.trim() || "-", width, size);
      const label = numbered ? this.nextNumber() : "";
      for (let i = 0; i < lines.length; i++) {
        // Keep a paragraph's first two and last two lines together.
        const need = i === 0 || i === lines.length - 2
          ? leading * Math.min(2, lines.length - i)
          : leading;
        this.ensure(need);
        this.font(size);
        this.colour(options.rgb ?? C.ink);
        if (i === 0 && label) this.doc.text(label, P.MARGIN, this.y + 3.4);
        this.doc.text(lines[i], x, this.y + 3.4);
        this.y += leading;
      }
      this.y += 1.8;
    }
  }

  /** A lettered list (a), (b) under the paragraph before it. */
  bullets(items: string[]): void {
    const size = BODY;
    const leading = size * PT * 1.45;
    const lx = P.MARGIN + (this.sectionNo ? NUM_W : 0);
    const tx = lx + 7;
    items.forEach((item, i) => {
      const lines = this.wrap(item, P.W - P.MARGIN - tx, size);
      this.ensure(lines.length * leading + 1.4);
      this.font(size);
      this.colour(C.ink);
      this.doc.text(`(${letter(i)})`, lx, this.y + 3.4);
      this.doc.text(lines, tx, this.y + 3.4, {
        lineHeightFactor: leading / (size * PT),
      });
      this.y += lines.length * leading + 1.4;
    });
    this.y += 1.6;
  }

  /** The work done, in order: a ruled "Item / Description of work" table. */
  steps(items: string[]): void {
    const rows: TableCell[][] = [
      [{ text: "Item", bold: true, shade: true }, {
        text: "Description of work",
        bold: true,
        shade: true,
      }],
      ...items.map((item) => [{ text: this.nextNumber() }, { text: item }]),
    ];
    const widths = [16, P.CONTENT_W - 16];
    // Keep the header with at least its first two rows.
    this.ensure(this.tableHeight(widths, rows.slice(0, 3)));
    this.table(widths, rows, { header: true });
    this.y += 4;
  }

  /** The instruction we were given: a ruled row, label on the left. */
  callout(
    label: string,
    text: string,
    note?: string | null,
    _options: { plainLabel?: boolean } = {},
  ): void {
    const row: TableCell[] = [
      { text: label, bold: true, shade: true },
      { text, note: note || undefined },
    ];
    const widths = [40, P.CONTENT_W - 40];
    this.ensure(this.rowHeight(widths, row));
    this.table(widths, [row]);
    this.y += 4;
  }

  /** Label and value pairs in a ruled table, `columns` pairs a row. */
  kvGrid(rows: Array<[string, string]>, columns = 2): void {
    const pairs = Math.max(1, Math.min(2, columns));
    const keyW = pairs === 2 ? 38 : 50;
    const valW = P.CONTENT_W / pairs - keyW;
    for (let i = 0; i < rows.length; i += pairs) {
      const cells = rows.slice(i, i + pairs).flatMap(([k, v]) => [
        { text: k, bold: true, shade: true } as TableCell,
        { text: reportText(v).trim() || "-" } as TableCell,
      ]);
      const widths = cells.length === 2 && pairs === 2
        ? [keyW, P.CONTENT_W - keyW]
        : pairs === 2
        ? [keyW, valW, keyW, valW]
        : [keyW, P.CONTENT_W - keyW];
      this.ensure(this.rowHeight(widths, cells));
      this.table(widths, [cells]);
    }
    this.y += 4;
  }

  /** A quiet line of small grey text. */
  note(text: string): void {
    const x = P.MARGIN + (this.sectionNo ? NUM_W : 0);
    const lines = this.wrap(text, P.W - P.MARGIN - x, 8.8);
    this.ensure(lines.length * 4.1 + 2);
    this.font(8.8);
    this.colour(C.grey);
    this.doc.text(lines, x, this.y + 3.2, {
      lineHeightFactor: 4.1 / (8.8 * PT),
    });
    this.y += lines.length * 4.1 + 2.6;
  }

  // ── Photographic record ──

  private photoMissing(x: number, y: number, w: number, h: number, text: string): void {
    this.font(8.4);
    this.colour(C.grey);
    this.doc.text(reportText(text), x + w / 2, y + h / 2, { align: "center" });
  }


  /**
   * One ruled schedule row: up to two photo cells, each with "Photo N" and the
   * caption in a ruled cell beneath. The row is kept whole on one page.
   */
  private scheduleRow(
    cells: Array<{ photo: GalleryPhoto; number: number | null }>,
    perRow = 2,
  ): void {
    const doc = this.doc;
    const colW = P.CONTENT_W / perRow;
    // Two rows of two fill a page; the compact schedule fits three rows of three.
    const boxH = perRow >= 3 ? 52 : 84;
    const imgH = boxH + (perRow >= 3 ? 6 : 8);
    const capFor = (c: { photo: GalleryPhoto; number: number | null }) => {
      const label = c.number != null ? `Photo ${c.number}` : "";
      const body = photoCaptionText(c.photo);
      this.font(8.8, "bold");
      const labelW = label ? doc.getTextWidth(label) + 2.4 : 0;
      const lines = this.wrap(body || " ", colW - 2 * 1.8 - labelW, 8.8);
      return { label, labelW, lines };
    };
    const caps = cells.map(capFor);
    const capH = 2.6 + Math.max(...caps.map((c) => c.lines.length)) * 4 + 2;
    const total = imgH + capH;
    this.ensure(total);
    const top = this.y;
    cells.forEach((c, i) => {
      const x = P.MARGIN + i * colW;
      const a = this.aspect(c.photo.image);
      const maxW = colW - (perRow >= 3 ? 8 : 16);
      const w = Math.min(maxW, boxH * a);
      const h = w / a;
      const ok = this.drawImage(c.photo.image, x + (colW - w) / 2, top + (imgH - h) / 2, w, h);
      if (!ok) {
        this.photoMissing(x, top, colW, imgH, c.photo.fallback || "Photo could not be shown");
      }
      doc.setDrawColor(...C.hair);
      doc.setLineWidth(HAIR_W);
      doc.rect(x, top, colW, imgH, "S");
      doc.rect(x, top + imgH, colW, capH, "S");
      const cap = caps[i];
      const cy = top + imgH + 2.6 + 3;
      if (cap.label) {
        this.font(8.8, "bold");
        this.colour(C.ink);
        doc.text(cap.label, x + 1.8, cy);
      }
      this.font(8.8);
      this.colour(C.ink);
      doc.text(cap.lines, x + 1.8 + cap.labelW, cy, {
        lineHeightFactor: 4 / (8.8 * PT),
      });
    });
    this.y = top + total + 5;
  }

  /**
   * The photographic record: a ruled schedule, two photos to a row (three when
   * `targetH` asks for small photos, for long roof visits), numbered "Photo 1",
   * "Photo 2" in order. Nothing is cropped, a photo never leaves its caption,
   * and a row never splits across pages.
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
    const start = options.startNumber ?? 1;
    const perRow = (options.targetH ?? 84) <= 66 ? 3 : 2;
    for (let i = 0; i < photos.length; i += perRow) {
      const row = photos.slice(i, i + perRow).map((photo, j) => ({
        photo,
        number: start + i + j,
      }));
      const before = this.doc.getNumberOfPages();
      this.scheduleRow(row, perRow);
      if (this.doc.getNumberOfPages() !== before) options.onContinue?.();
    }
  }

  /** Two photos side by side: the state we found and the state we left. */
  beforeAfter(before: GalleryPhoto, after: GalleryPhoto): void {
    this.scheduleRow([
      { photo: { ...before, tag: before.tag || "Before" }, number: null },
      { photo: { ...after, tag: after.tag || "After" }, number: null },
    ]);
  }

  /** One photo in its own ruled cell, caption beneath. */
  plate(photo: GalleryPhoto, counter?: string): void {
    const n = counter ? Number(String(counter).split(/\D+/)[0]) : NaN;
    this.scheduleRow([{ photo, number: Number.isFinite(n) && n > 0 ? n : null }]);
  }
}

function letter(i: number): string {
  return i < 26 ? String.fromCharCode(97 + i) : String(i + 1);
}

function keyRow([label, value]: [string, string]): TableCell[] {
  return [{ text: label, bold: true, shade: true }, { text: value || "-" }];
}
