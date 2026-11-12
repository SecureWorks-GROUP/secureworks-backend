// Restoration quote PDF (docs/restoration-workflow-v1.md): the priced quote a
// builder approves before restoration works start. TS/jsPDF on the same
// SecureWorks letterhead chrome as roof_report_render.ts and
// makesafe_report_render.ts.
//
// This module renders bytes only. It uploads nothing, sends nothing and
// touches no live system; the ops-api action that calls it files the document.
//
// It is a PRICED document. It is filed as an office-only job document and must
// never reach a trade surface or an SES builder pack; the make-safe report
// stays price-free (its renderer refuses money wording) and this is why the
// quote is its own document rather than a section of the report.

import type { RestorationQuote } from "./restoration_workflow.ts";

export interface RestorationQuoteDocumentInput {
  quote: RestorationQuote;
  job_number: string;
  /** Builder's claim / work order reference, e.g. "MLR-41228". */
  builder_reference: string | null;
  builder_purchase_order: string | null;
  builder_name: string | null;
  /** The builder's person the quote is addressed to, when known. */
  attention: string | null;
  site_address: string;
  /** The insured / policyholder name as the work order gave it. */
  insured_name: string | null;
  /** The quote's date, as an ISO date (the day it was prepared). */
  quote_date: string;
}

export interface RenderedRestorationQuote {
  bytes: Uint8Array;
  fileName: string;
}

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
const BODY_TOP = 47;

export const RESTORATION_QUOTE_TITLE = "Restoration Quote";

// ── Pure helpers (exported for unit tests; no jsPDF / no network) ──

function slug(value: unknown): string {
  return String(value ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Stable per quote revision, so re-rendering a draft replaces its own file. */
export function restorationQuoteFileName(
  quoteNumber: unknown,
  builderReference: unknown,
): string {
  const ref = slug(builderReference);
  return `Restoration Quote - ${slug(quoteNumber) || "quote"}${
    ref ? ` - ${ref}` : ""
  }.pdf`;
}

export function formatAud(amount: unknown): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "-";
  const fixed = Math.abs(n).toFixed(2);
  const [whole, cents] = fixed.split(".");
  return `${n < 0 ? "-" : ""}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

export function formatQuantity(quantity: unknown): string {
  const n = Number(quantity);
  if (!Number.isFinite(n)) return "-";
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** "2026-11-12" -> "12 November 2026" (date only; no time zone arithmetic). */
export function formatQuoteDate(isoDate: unknown): string {
  const match = String(isoDate ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(isoDate ?? "");
  const months = [
    "January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December",
  ];
  const month = months[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : String(isoDate);
}

// House rule: no em dashes in outbound copy; jsPDF also chokes on CRLF.
export function sanitiseText(value: unknown): string {
  return String(value ?? "")
    .replace(/[—–]/g, "-")
    .replace(/\r\n/g, "\n");
}

export function restorationQuoteHeaderRows(
  input: RestorationQuoteDocumentInput,
): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Quote number", input.quote.quote_number],
    ["Quote date", formatQuoteDate(input.quote_date)],
    ["Valid for", `${input.quote.validity_days} days`],
  ];
  if (input.builder_name) {
    rows.push([
      "Prepared for",
      input.attention
        ? `${input.attention}, ${input.builder_name}`
        : input.builder_name,
    ]);
  }
  if (input.builder_reference) {
    rows.push(["Builder reference", input.builder_reference]);
  }
  if (input.builder_purchase_order) {
    rows.push(["Purchase order", input.builder_purchase_order]);
  }
  rows.push(["Our job number", input.job_number]);
  rows.push(["Site address", input.site_address]);
  if (input.insured_name) rows.push(["Insured", input.insured_name]);
  return rows;
}

export const RESTORATION_QUOTE_TERMS: readonly string[] = [
  "All amounts are in Australian dollars. GST is shown separately.",
  "Works start once this quote is approved in writing or by an updated purchase order.",
  "Works outside the scope above, or found once works are under way, are quoted separately before they are done.",
];

// ── Renderer (async; imports jsPDF lazily, like the report renderers) ──

export async function renderRestorationQuotePdf(
  input: RestorationQuoteDocumentInput,
): Promise<RenderedRestorationQuote> {
  const quote = input.quote;
  if (!quote?.quote_number) {
    throw new Error("renderRestorationQuotePdf: quote number required");
  }
  if (!input.site_address) {
    throw new Error("renderRestorationQuotePdf: site address required");
  }
  if (!quote.lines?.length) {
    throw new Error("renderRestorationQuotePdf: quote has no lines");
  }

  const fileName = restorationQuoteFileName(
    quote.quote_number,
    input.builder_reference,
  );
  const subtitle = sanitiseText(
    [input.builder_reference, input.site_address].filter(Boolean).join(" | "),
  ).slice(0, 128);

  // deno-lint-ignore no-import-prefix
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
    doc.text(RESTORATION_QUOTE_TITLE, MARGIN, 20);
    doc.setDrawColor(...ORANGE);
    doc.setLineWidth(0.6);
    doc.line(MARGIN, 23, 70, 23);
    doc.setTextColor(...MID);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(subtitle, MARGIN, 30);
    doc.setTextColor(...DARK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("SecureWorks Group", PAGE_W - MARGIN, 20, { align: "right" });
    doc.setTextColor(...MID);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.text("Emergency services and restoration", PAGE_W - MARGIN, 25, {
      align: "right",
    });
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.3);
    doc.line(MARGIN, 41, PAGE_W - MARGIN, 41);
    return BODY_TOP;
  };

  const footer = (): void => {
    doc.setTextColor(...MID);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.text(
      `SecureWorks Group | ${quote.quote_number} | Page ${doc.getNumberOfPages()}`,
      PAGE_W / 2,
      PAGE_H - 9,
      { align: "center" },
    );
  };

  let y = header();
  const BODY_BOTTOM = PAGE_H - 18;
  const ensureSpace = (height: number): void => {
    if (y + height > BODY_BOTTOM) {
      footer();
      doc.addPage();
      y = header();
    }
  };

  const section = (title: string, followingHeightHint = 0): void => {
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
  };

  const para = (body: string): void => {
    doc.setTextColor(...BODY);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.4);
    for (const block of sanitiseText(body).split("\n")) {
      const lines: string[] = doc.splitTextToSize(block || " ", CONTENT_W);
      for (const line of lines) {
        ensureSpace(4.5);
        doc.text(line, MARGIN, y);
        y += 4.5;
      }
    }
    y += 4;
  };

  // Details as a two-column grid (the site address takes a full row), so the
  // header stays short and the priced table fits on the first page.
  const kvGrid = (rows: Array<[string, string]>): void => {
    const half = CONTENT_W / 2;
    const cellLines = (value: string, width: number): string[] => {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.4);
      return doc.splitTextToSize(sanitiseText(value) || "-", width);
    };
    const drawCell = (
      x: number,
      width: number,
      rowH: number,
      label: string,
      lines: string[],
    ): void => {
      doc.setFillColor(...LIGHT);
      doc.setDrawColor(...RULE);
      doc.setLineWidth(0.2);
      doc.rect(x, y, width, rowH, "FD");
      doc.setTextColor(...MID);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7);
      doc.text(label.toUpperCase(), x + 3, y + 5.2);
      doc.setTextColor(...DARK);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.4);
      doc.text(lines, x + 35, y + 5.2);
    };
    const full = rows.filter(([label]) => label === "Site address");
    const paired = rows.filter(([label]) => label !== "Site address");
    for (let i = 0; i < paired.length; i += 2) {
      const left = paired[i];
      const right = paired[i + 1];
      const leftLines = cellLines(left[1], half - 38);
      const rightLines = right ? cellLines(right[1], half - 38) : [];
      const rowH = Math.max(
        8.5,
        5 + Math.max(leftLines.length, rightLines.length) * 4.1,
      );
      ensureSpace(rowH);
      drawCell(MARGIN, half, rowH, left[0], leftLines);
      if (right) drawCell(MARGIN + half, half, rowH, right[0], rightLines);
      else drawCell(MARGIN + half, half, rowH, "", []);
      y += rowH;
    }
    for (const [label, value] of full) {
      const lines = cellLines(value, CONTENT_W - 38);
      const rowH = Math.max(8.5, 5 + lines.length * 4.1);
      ensureSpace(rowH);
      drawCell(MARGIN, CONTENT_W, rowH, label, lines);
      y += rowH;
    }
  };

  kvGrid(restorationQuoteHeaderRows(input));
  y += 6;

  if (quote.scope_of_works) {
    section("Scope of works", 12);
    para(quote.scope_of_works);
  }

  // Line table: description | qty | unit | rate ex GST | amount ex GST.
  const COL_QTY = MARGIN + 108;
  const COL_UNIT = MARGIN + 124;
  const COL_RATE = MARGIN + 151;
  const COL_AMOUNT = MARGIN + CONTENT_W - 3;
  const DESC_W = 92;

  const tableHead = (): void => {
    ensureSpace(8);
    doc.setFillColor(...LIGHT);
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.2);
    doc.rect(MARGIN, y, CONTENT_W, 7.5, "FD");
    doc.setTextColor(...MID);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.text("DESCRIPTION", MARGIN + 3, y + 4.9);
    doc.text("QTY", COL_QTY, y + 4.9, { align: "right" });
    doc.text("UNIT", COL_UNIT, y + 4.9);
    doc.text("RATE EX GST", COL_RATE, y + 4.9, { align: "right" });
    doc.text("AMOUNT EX GST", COL_AMOUNT, y + 4.9, { align: "right" });
    y += 7.5;
  };

  // Measure the whole priced table first. When the table and its totals fit
  // on one page they are never split: they start on a new page instead.
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.8);
  const measured = quote.lines.map((line) => {
    const descLines: string[] = doc.splitTextToSize(
      sanitiseText(line.description),
      DESC_W,
    );
    // jsPDF sets a multi-line description about 3.6 mm per line at 8.8 pt.
    return { line, descLines, rowH: 7.5 + (descLines.length - 1) * 3.6 };
  });
  const TOTALS_H = 26;
  const tableH = 13 + 7.5 + measured.reduce((sum, m) => sum + m.rowH, 0) +
    TOTALS_H;
  const freshPageRoom = BODY_BOTTOM - BODY_TOP;
  section("Quoted works", tableH <= freshPageRoom ? tableH - 13 : 30);
  tableHead();
  for (const { line, descLines, rowH } of measured) {
    if (y + rowH > BODY_BOTTOM) {
      footer();
      doc.addPage();
      y = header();
      tableHead();
    }
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.2);
    doc.rect(MARGIN, y, CONTENT_W, rowH, "D");
    doc.setTextColor(...BODY);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.8);
    doc.text(descLines, MARGIN + 3, y + 5);
    doc.text(formatQuantity(line.quantity), COL_QTY, y + 5, {
      align: "right",
    });
    doc.text(sanitiseText(line.unit || ""), COL_UNIT, y + 5);
    doc.text(formatAud(line.unit_price_ex_gst), COL_RATE, y + 5, {
      align: "right",
    });
    doc.text(formatAud(line.line_total_ex_gst), COL_AMOUNT, y + 5, {
      align: "right",
    });
    y += rowH;
  }

  // Totals block, right aligned under the amount column.
  y += 3;
  ensureSpace(TOTALS_H - 2);
  const totalsRow = (label: string, amount: number, strong = false): void => {
    doc.setTextColor(...(strong ? DARK : MID));
    doc.setFont("helvetica", strong ? "bold" : "normal");
    doc.setFontSize(strong ? 10.5 : 9.2);
    doc.text(label, COL_RATE, y + 4.6, { align: "right" });
    doc.setTextColor(...DARK);
    doc.text(formatAud(amount), COL_AMOUNT, y + 4.6, { align: "right" });
    y += strong ? 7.5 : 6;
  };
  totalsRow("Subtotal ex GST", quote.subtotal_ex_gst);
  totalsRow("GST", quote.gst);
  doc.setDrawColor(...ORANGE);
  doc.setLineWidth(0.5);
  doc.line(COL_UNIT, y, MARGIN + CONTENT_W, y);
  y += 1;
  totalsRow("Total inc GST", quote.total_inc_gst, true);
  y += 5;

  const bullets = (items: string[]): void => {
    doc.setTextColor(...BODY);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.2);
    for (const item of items) {
      const lines: string[] = doc.splitTextToSize(item, CONTENT_W - 6);
      ensureSpace(lines.length * 4.4 + 1.2);
      doc.setFillColor(...ORANGE);
      doc.circle(MARGIN + 1.4, y - 1.2, 0.7, "F");
      doc.text(lines, MARGIN + 5, y);
      y += lines.length * 4.4 + 1.2;
    }
    y += 4;
  };
  const listItems = (body: string): string[] =>
    sanitiseText(body).split("\n")
      .map((item) => item.replace(/^\s*[-*\u2022]\s*/, "").trim())
      .filter(Boolean);

  if (quote.exclusions) {
    const items = listItems(quote.exclusions);
    section("Exclusions and assumptions", Math.min(items.length, 3) * 5.6);
    bullets(items);
  }

  section("Terms", 3 * 5.6);
  bullets([...RESTORATION_QUOTE_TERMS]);

  footer();
  const out = doc.output("arraybuffer") as ArrayBuffer;
  return { bytes: new Uint8Array(out), fileName };
}
