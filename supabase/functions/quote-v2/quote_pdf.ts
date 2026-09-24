// Quote v2 stage 3: the customer quote as a PDF, rendered on the server from
// ONE party's frozen revision. PROGRAM BRANCH ONLY.
//
// Same model and wording as quote_document.ts (the HTML), laid out on A4 with
// jsPDF (https://esm.sh/jspdf@2.5.1, the import the make-safe and roof
// reports already use). Fonts and logo are embedded, and the creation date
// and file id come from the frozen revision, so the same revision renders the
// same bytes every time; a send preview hashes them.

import {
  alsoBuild,
  BRAND,
  divisionFor,
  familyHeading,
  isShared,
  longDate,
  quantityText,
  type QuoteDocumentView,
  quoteReference,
  shareSentence,
  termsFor,
} from "./quote_document.ts";
import { money } from "./format.ts";
import {
  JAKARTA_BOLD_TTF_BASE64,
  JAKARTA_REGULAR_TTF_BASE64,
  LOGO_WHITE_PNG_BASE64,
} from "./brand/assets.ts";

// deno-lint-ignore no-explicit-any
type Pdf = any;

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 18;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = PAGE_H - 24;
const HEADER_H = 26;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

interface Run {
  text: string;
  bold: boolean;
}

/** The approved terms HTML (p, ul, li, b) as blocks of bold/regular runs. */
export function termsBlocks(
  html: string,
): { bullet: boolean; runs: Run[] }[] {
  const blocks: { bullet: boolean; runs: Run[] }[] = [];
  const re = /<(p|li)>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const runs: Run[] = [];
    for (const part of m[2].split(/(<b>[\s\S]*?<\/b>)/)) {
      if (!part) continue;
      const bold = part.startsWith("<b>");
      const text = part.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&");
      if (text) runs.push({ text, bold });
    }
    blocks.push({ bullet: m[1] === "li", runs });
  }
  return blocks;
}

class Layout {
  y = 0;
  constructor(
    public doc: Pdf,
    public view: QuoteDocumentView,
  ) {}

  font(size: number, bold = false, color: string = BRAND.ink) {
    this.doc.setFont("PJS", bold ? "bold" : "normal");
    this.doc.setFontSize(size);
    this.doc.setTextColor(...rgb(color));
  }

  fill(color: string) {
    this.doc.setFillColor(...rgb(color));
  }

  header() {
    const d = this.doc;
    this.fill(BRAND.slate);
    d.rect(0, 0, PAGE_W, HEADER_H, "F");
    this.fill("#2C3B44");
    d.rect(0, HEADER_H, PAGE_W, 1.2, "F");
    this.fill(BRAND.orange);
    d.rect(0, HEADER_H, 42, 1.2, "F");
    d.addImage(
      LOGO_WHITE_PNG_BASE64,
      "PNG",
      MARGIN,
      9,
      49.2,
      8,
      "logo",
      "FAST",
    );
    this.font(9, true, "#FFFFFF");
    const ref = quoteReference(this.view);
    const x = PAGE_W - MARGIN;
    d.text(`Quote ${ref}`, x, 12, { align: "right" });
    this.font(8.5, false, "#D6DEE3");
    d.text(`Issued ${longDate(this.view.issued_on)}`, x, 17, {
      align: "right",
    });
    this.y = HEADER_H + 10;
  }

  newPage() {
    this.doc.addPage("a4", "portrait");
    this.header();
  }

  ensure(h: number) {
    if (this.y + h > BOTTOM) this.newPage();
  }

  eyebrow(text: string, x = MARGIN) {
    this.font(8, true, BRAND.orange);
    this.doc.text(text.toUpperCase(), x, this.y, { charSpace: 0.3 });
  }

  paragraph(
    text: string,
    size = 10,
    color: string = BRAND.ink,
    width = CONTENT_W,
  ) {
    this.font(size, false, color);
    const lines: string[] = this.doc.splitTextToSize(text, width);
    const lh = size * 0.47;
    for (const line of lines) {
      this.ensure(lh);
      this.doc.text(line, MARGIN, this.y);
      this.y += lh;
    }
  }

  section(title: string, need = 14) {
    this.ensure(need);
    this.y += 4;
    this.eyebrow(title);
    this.y += 5.5;
  }

  noteBox(text: string) {
    this.font(9.5, false, BRAND.ink);
    const lines: string[] = this.doc.splitTextToSize(text, CONTENT_W - 10);
    const h = lines.length * 4.4 + 5;
    this.ensure(h + 3);
    this.fill(BRAND.soft);
    this.doc.rect(MARGIN, this.y, CONTENT_W, h, "F");
    this.fill(BRAND.orange);
    this.doc.rect(MARGIN, this.y, 1.2, h, "F");
    let ty = this.y + 5.2;
    for (const line of lines) {
      this.doc.text(line, MARGIN + 5, ty);
      ty += 4.4;
    }
    this.y += h + 3;
  }

  bullets(items: string[], x: number, width: number): number {
    let y = this.y;
    this.font(9.5, false, BRAND.ink);
    for (const item of items) {
      const lines: string[] = this.doc.splitTextToSize(item, width - 5);
      this.fill(BRAND.orange);
      this.doc.rect(x, y - 2.4, 1.8, 1.8, "F");
      for (const line of lines) {
        this.doc.text(line, x + 5, y);
        y += 4.4;
      }
      y += 1.4;
    }
    return y;
  }

  /** Word-wrapped bold/regular runs; returns the new y. */
  richText(
    runs: Run[],
    x: number,
    y: number,
    width: number,
    size: number,
  ): number {
    const d = this.doc;
    const lh = size * 0.42;
    const words: Run[] = [];
    for (const r of runs) {
      for (const w of r.text.split(/(\s+)/)) {
        if (w) words.push({ text: w, bold: r.bold });
      }
    }
    let cx = x;
    for (const w of words) {
      d.setFont("PJS", w.bold ? "bold" : "normal");
      d.setFontSize(size);
      if (/^\s+$/.test(w.text)) {
        if (cx > x) cx += d.getTextWidth(" ");
        continue;
      }
      const ww = d.getTextWidth(w.text);
      if (cx > x && cx + ww > x + width) {
        y += lh;
        cx = x;
      }
      d.text(w.text, cx, y);
      cx += ww;
    }
    return y + lh;
  }
}

export interface QuotePdfOptions {
  /** Frozen time of the revision: the PDF's creation date. */
  frozenAt?: string;
}

async function loadJsPdf() {
  // deno-lint-ignore no-import-prefix
  const mod = await import("https://esm.sh/jspdf@2.5.1");
  return mod.jsPDF;
}

export async function renderQuotePdf(
  v: QuoteDocumentView,
  opts: QuotePdfOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const JsPdf = await loadJsPdf();
  const doc: Pdf = new JsPdf({ unit: "mm", format: "a4", compress: true });
  doc.addFileToVFS("PJS-Regular.ttf", JAKARTA_REGULAR_TTF_BASE64);
  doc.addFont("PJS-Regular.ttf", "PJS", "normal");
  doc.addFileToVFS("PJS-Bold.ttf", JAKARTA_BOLD_TTF_BASE64);
  doc.addFont("PJS-Bold.ttf", "PJS", "bold");
  const ref = quoteReference(v);
  doc.setProperties({
    title: `Quote ${ref} - SecureWorks Group`,
    subject: v.scope?.title ?? "Quote",
    author: "SecureWorks Group",
    creator: "SecureWorks Group quotes",
  });
  // Deterministic bytes: the creation date is the issue day and the file id
  // is derived from the revision's content hash.
  doc.setCreationDate(
    new Date(opts.frozenAt ?? `${v.issued_on}T00:00:00+08:00`),
  );
  doc.setFileId(
    v.content_hash.replace(/^sha256:/, "").slice(0, 32).toUpperCase(),
  );

  const L = new Layout(doc, v);
  const div = divisionFor(v.family);
  const shared = isShared(v);
  const scope = v.scope ?? {};
  L.header();

  // Title band.
  L.fill(BRAND.navy);
  doc.rect(0, HEADER_H + 1.2, PAGE_W, 26, "F");
  L.y = HEADER_H + 11;
  L.eyebrow(familyHeading(v.family));
  L.font(16, true, "#FFFFFF");
  const titleLines: string[] = doc.splitTextToSize(
    scope.title || "Your quote",
    CONTENT_W,
  ).slice(0, 2);
  let ty = L.y + 7;
  for (const t of titleLines) {
    doc.text(t, MARGIN, ty);
    ty += 6.5;
  }
  L.y = HEADER_H + 1.2 + 26 + 10;

  // Prepared for.
  const top = L.y;
  L.eyebrow("Prepared for");
  L.font(18, true, BRAND.navy);
  doc.text(v.party.first_name, MARGIN, top + 8);
  L.font(10, false, BRAND.ink);
  if (v.site_suburb) doc.text(`Site ${v.site_suburb} WA`, MARGIN, top + 14);
  L.font(9, false, BRAND.steel);
  const rx = PAGE_W - MARGIN;
  doc.text(`Quote ${ref}`, rx, top, { align: "right" });
  doc.text(`Issued ${longDate(v.issued_on)}`, rx, top + 4.6, {
    align: "right",
  });
  doc.text(`Valid until ${longDate(v.valid_until)}`, rx, top + 9.2, {
    align: "right",
  });
  L.y = top + 18;
  doc.setDrawColor(...rgb(BRAND.line));
  doc.line(MARGIN, L.y, PAGE_W - MARGIN, L.y);
  L.y += 4;

  if (scope.summary) {
    L.section("The work");
    L.paragraph(scope.summary);
  }

  // What it costs.
  L.section("What it costs", 24);
  const colAmount = PAGE_W - MARGIN - 3;
  const colJob = shared ? colAmount - 34 : null;
  const colQty = (colJob ?? colAmount) - 30;
  const descW = colQty - 22 - (MARGIN + 3);
  const tableHeader = () => {
    L.fill(BRAND.slate);
    doc.rect(MARGIN, L.y - 5, CONTENT_W, 8, "F");
    L.font(7.5, true, "#FFFFFF");
    doc.text("ITEM", MARGIN + 3, L.y);
    doc.text("QTY", colQty, L.y, { align: "right" });
    if (colJob) doc.text("JOB EX GST", colJob, L.y, { align: "right" });
    doc.text(
      shared ? "YOUR SHARE EX GST" : "AMOUNT EX GST",
      colAmount,
      L.y,
      { align: "right" },
    );
    L.y += 8;
  };
  tableHeader();
  for (const line of v.lines) {
    L.font(9.5, false, BRAND.ink);
    const lines: string[] = doc.splitTextToSize(line.description, descW);
    const h = lines.length * 4.4 + 3.2;
    if (L.y + h > BOTTOM) {
      L.newPage();
      tableHeader();
    }
    let ly = L.y;
    for (const t of lines) {
      doc.text(t, MARGIN + 3, ly);
      ly += 4.4;
    }
    doc.text(quantityText(line.qty, line.unit), colQty, L.y, {
      align: "right",
    });
    if (colJob) {
      doc.text(money(line.line_total_ex_gst), colJob, L.y, { align: "right" });
    }
    L.font(9.5, true, BRAND.ink);
    doc.text(money(line.your_share_ex_gst), colAmount, L.y, {
      align: "right",
    });
    L.y += h - 3.2 + 1;
    doc.setDrawColor(...rgb(BRAND.line));
    doc.line(MARGIN, L.y - 1.2, PAGE_W - MARGIN, L.y - 1.2);
    L.y += 3.4;
  }
  L.ensure(8);
  L.font(9, false, BRAND.steel);
  doc.text(
    `${shared ? "Your share ex GST" : "Total ex GST"} ${
      money(v.party.share.ex_gst)
    }  ·  GST ${money(v.party.share.gst)}`,
    PAGE_W - MARGIN,
    L.y,
    { align: "right" },
  );
  L.y += 5;

  // Investment panel.
  L.ensure(30);
  const iy = L.y;
  L.fill(BRAND.slate);
  doc.rect(MARGIN, iy, CONTENT_W, 24, "F");
  L.fill(BRAND.orange);
  doc.rect(MARGIN, iy, 2, 24, "F");
  L.font(8, true, BRAND.orange);
  doc.text(
    (shared ? "Your share" : "Your investment").toUpperCase(),
    MARGIN + 7,
    iy + 9,
    {
      charSpace: 0.3,
    },
  );
  L.font(8.5, false, "#C9D3D9");
  doc.text(
    shared
      ? "Your share of the work, including GST"
      : "Quoted work, including GST",
    MARGIN + 7,
    iy + 14.5,
  );
  L.font(24, true, "#FFFFFF");
  doc.text(money(v.party.share.inc_gst), PAGE_W - MARGIN - 6, iy + 13, {
    align: "right",
  });
  L.font(7.5, false, "#C9D3D9");
  doc.text(
    "Everything described above, installed by our own crew.",
    PAGE_W - MARGIN - 6,
    iy + 19.5,
    { align: "right" },
  );
  L.y = iy + 28;
  if (shared) L.noteBox(shareSentence(v));
  L.noteBox(
    `This price holds until ${
      longDate(v.valid_until)
    }. After that date we will need to requote.`,
  );

  // Included and not included.
  const inc = scope.inclusions?.length
    ? scope.inclusions
    : ["The work described above, supplied and installed."];
  const exc = scope.exclusions?.length
    ? scope.exclusions
    : ["Nothing beyond the work described above."];
  L.ensure(24);
  L.y += 4;
  const half = (CONTENT_W - 10) / 2;
  const x2 = MARGIN + half + 10;
  L.eyebrow("What is included");
  L.eyebrow("What is not included", x2);
  L.y += 5.5;
  const yInc = L.bullets(inc, MARGIN, half);
  const yExc = L.bullets(exc, x2, half);
  L.y = Math.max(yInc, yExc) + 1;

  if (scope.notes) {
    L.section("Notes");
    L.paragraph(scope.notes);
  }

  // Accepting.
  // Steps and the contact line stay together.
  L.section("Accepting this quote", 36);
  const steps = [
    [
      "Step 1",
      "Open your quote link and press Accept, or confirm in writing by email or SMS.",
    ],
    [
      "Step 2",
      "We confirm your install date in writing and order your materials.",
    ],
    ["Step 3", "We build it, then walk the finished work with you."],
  ];
  const sw = (CONTENT_W - 12) / 3;
  let maxY = L.y;
  steps.forEach(([label, text], i) => {
    const sx = MARGIN + i * (sw + 6);
    doc.setDrawColor(...rgb(BRAND.line));
    doc.line(sx, L.y - 3, sx + sw, L.y - 3);
    L.font(7.5, true, BRAND.orange);
    doc.text(label.toUpperCase(), sx, L.y + 1);
    L.font(9, false, BRAND.ink);
    let sy = L.y + 6;
    for (const t of doc.splitTextToSize(text, sw) as string[]) {
      doc.text(t, sx, sy);
      sy += 4.2;
    }
    maxY = Math.max(maxY, sy);
  });
  L.y = maxY + 2;
  L.ensure(6);
  L.font(9, false, BRAND.steel);
  doc.text(
    `Call or text ${div.phone}  ·  Email ${div.email}  ·  Quote ${ref}`,
    MARGIN,
    L.y,
  );

  // Terms, in two columns from a fresh page.
  const terms = termsFor(v.family);
  if (terms.length) {
    L.newPage();
    L.font(14, true, BRAND.navy);
    doc.text("Terms and conditions", MARGIN, L.y);
    L.y += 7;
    const colW = (CONTENT_W - 8) / 2;
    const startY = L.y;
    let col = 0;
    let y = startY;
    const colX = () => MARGIN + col * (colW + 8);
    const room = (h: number) => {
      if (y + h <= PAGE_H - 19.5) return;
      if (col === 0) {
        col = 1;
        y = startY;
      } else {
        L.newPage();
        col = 0;
        y = L.y;
      }
    };
    const size = 6.7;
    const measure = (block: { bullet: boolean; runs: Run[] }) =>
      (doc.splitTextToSize(
          block.runs.map((r) => r.text).join(""),
          colW - (block.bullet ? 4 : 0),
        ) as string[]).length * size * 0.42 + 1.6;
    terms.forEach(([title, html], i) => {
      const blocks = termsBlocks(html);
      L.font(size, false, BRAND.ink);
      room(4 + (blocks[0] ? measure(blocks[0]) : 0));
      L.font(7.6, true, BRAND.orange);
      doc.text(
        `${String(i + 1).padStart(2, "0")} ${title.toUpperCase()}`,
        colX(),
        y,
      );
      y += 4;
      for (const block of blocks) {
        // Measured first so a block never splits across columns.
        L.font(size, false, BRAND.ink);
        room(measure(block));
        if (block.bullet) {
          L.fill(BRAND.orange);
          doc.rect(colX(), y - 1.9, 1.4, 1.4, "F");
        }
        L.font(size, false, BRAND.ink);
        y = L.richText(
          block.runs,
          colX() + (block.bullet ? 4 : 0),
          y,
          colW - (block.bullet ? 4 : 0),
          size,
        ) + (block.bullet ? 0.4 : 1.2);
      }
      y += 2;
    });
  }

  // Footers, now the page count is known.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...rgb(BRAND.line));
    doc.line(MARGIN, PAGE_H - 17, PAGE_W - MARGIN, PAGE_H - 17);
    L.font(7.5, true, BRAND.ink);
    doc.text(
      `Licensed and insured  ·  Our own crew, not subcontracted  ·  ${
        alsoBuild(v.family)
      }`,
      MARGIN,
      PAGE_H - 12.5,
    );
    L.font(7.5, false, BRAND.steel);
    doc.text(
      `${BRAND.company}  ·  ABN ${BRAND.abn}  ·  ${BRAND.web}  ·  Quote ${ref}`,
      MARGIN,
      PAGE_H - 8.5,
    );
    doc.text(`Page ${p} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 8.5, {
      align: "right",
    });
  }
  return new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
}
