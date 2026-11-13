// Restoration quote PDF (docs/restoration-workflow-v1.md): the priced quote a
// builder approves before restoration works start. TS/jsPDF on the shared
// SecureWorks report design (report_design.ts), so the quote and the reports
// read as one family.
//
// This module renders bytes only. It uploads nothing, sends nothing and
// touches no live system; the ops-api action that calls it files the document.
//
// It is a PRICED document. It is filed as an office-only job document and must
// never reach a trade surface or an SES builder pack; the make-safe report
// stays price-free (its renderer refuses money wording) and this is why the
// quote is its own document rather than a section of the report.

import {
  REPORT_COLOURS,
  REPORT_PAGE,
  ReportCanvas,
} from "./report_design.ts";
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

const { orange: ORANGE, dark: DARK, mid: MID, light: LIGHT, rule: RULE, body: BODY } =
  REPORT_COLOURS;
const MARGIN = REPORT_PAGE.MARGIN;
const CONTENT_W = REPORT_PAGE.CONTENT_W;
const BODY_BOTTOM = REPORT_PAGE.BODY_BOTTOM;

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

  // deno-lint-ignore no-import-prefix
  const { jsPDF } = await import("https://esm.sh/jspdf@2.5.1");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  const canvas = new ReportCanvas(doc, {
    kind: RESTORATION_QUOTE_TITLE,
    title: sanitiseText(input.site_address),
    subtitle: sanitiseText(
      [`Quote ${quote.quote_number}`, input.builder_reference].filter(Boolean)
        .join("  |  "),
    ).slice(0, 128),
    reference: sanitiseText(quote.quote_number),
    referenceNote: formatQuoteDate(input.quote_date),
    tagline: "Emergency services and restoration",
  });
  canvas.hero({ overlap: true });
  canvas.facts(
    restorationQuoteHeaderRows(input).map(([label, value]) => ({
      label,
      value: sanitiseText(value) || "-",
    })),
    3,
  );

  if (quote.scope_of_works) {
    canvas.section("Scope of works", 12);
    canvas.paragraph(quote.scope_of_works);
  }

  // Line table: description | qty | unit | rate ex GST | amount ex GST.
  const COL_QTY = MARGIN + 110;
  const COL_UNIT = MARGIN + 115;
  const COL_RATE = MARGIN + 150;
  const COL_AMOUNT = MARGIN + CONTENT_W - 3;
  const DESC_W = 92;

  const tableHead = (): void => {
    canvas.ensure(8);
    const y = canvas.y;
    doc.setFillColor(...DARK);
    doc.roundedRect(MARGIN, y, CONTENT_W, 7.5, 1.2, 1.2, "F");
    canvas.eyebrow("Description", MARGIN + 3, y + 4.9, [255, 255, 255], 6.2);
    canvas.eyebrow("Qty", COL_QTY, y + 4.9, [255, 255, 255], 6.2, "right");
    canvas.eyebrow("Unit", COL_UNIT, y + 4.9, [255, 255, 255], 6.2);
    canvas.eyebrow("Rate ex GST", COL_RATE, y + 4.9, [255, 255, 255], 6.2, "right");
    canvas.eyebrow("Amount ex GST", COL_AMOUNT, y + 4.9, [255, 255, 255], 6.2, "right");
    canvas.y = y + 7.5;
  };

  // Measure the whole priced table first. When the table and its totals fit
  // on one page they are never split: they start on a new page instead.
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const measured = quote.lines.map((line) => {
    const descLines: string[] = doc.splitTextToSize(
      sanitiseText(line.description),
      DESC_W,
    );
    // jsPDF sets a multi-line description about 3.7 mm per line at 9 pt.
    return { line, descLines, rowH: 8 + (descLines.length - 1) * 3.7 };
  });
  const TOTALS_H = 30;
  const tableH = 7.5 + measured.reduce((sum, m) => sum + m.rowH, 0) + TOTALS_H;
  const freshPageRoom = BODY_BOTTOM - REPORT_PAGE.RUNNING_TOP - 15;
  canvas.section("Quoted works", tableH <= freshPageRoom ? tableH : 30);
  tableHead();
  measured.forEach(({ line, descLines, rowH }, index) => {
    if (canvas.y + rowH > BODY_BOTTOM) {
      canvas.newPage();
      tableHead();
    }
    const y = canvas.y;
    if (index % 2 === 1) {
      doc.setFillColor(...LIGHT);
      doc.rect(MARGIN, y, CONTENT_W, rowH, "F");
    }
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.2);
    doc.line(MARGIN, y + rowH, MARGIN + CONTENT_W, y + rowH);
    doc.setTextColor(...BODY);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(descLines, MARGIN + 3, y + 5.2);
    doc.text(formatQuantity(line.quantity), COL_QTY, y + 5.2, {
      align: "right",
    });
    doc.text(sanitiseText(line.unit || ""), COL_UNIT, y + 5.2);
    doc.text(formatAud(line.unit_price_ex_gst), COL_RATE, y + 5.2, {
      align: "right",
    });
    doc.setTextColor(...DARK);
    doc.text(formatAud(line.line_total_ex_gst), COL_AMOUNT, y + 5.2, {
      align: "right",
    });
    canvas.y = y + rowH;
  });

  // Totals block, right aligned under the amount column.
  canvas.gap(4);
  canvas.ensure(TOTALS_H - 4);
  const totalsRow = (label: string, amount: number): void => {
    const y = canvas.y;
    doc.setTextColor(...MID);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.2);
    doc.text(label, COL_RATE, y + 4.6, { align: "right" });
    doc.setTextColor(...DARK);
    doc.text(formatAud(amount), COL_AMOUNT, y + 4.6, { align: "right" });
    canvas.y = y + 6;
  };
  totalsRow("Subtotal ex GST", quote.subtotal_ex_gst);
  totalsRow("GST", quote.gst);
  {
    const y = canvas.y + 1.5;
    const boxX = COL_UNIT - 3;
    doc.setFillColor(...DARK);
    doc.roundedRect(boxX, y, MARGIN + CONTENT_W - boxX, 10, 1.6, 1.6, "F");
    doc.setFillColor(...ORANGE);
    doc.rect(boxX + 2.2, y + 2.6, 1.1, 4.8, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.text("Total inc GST", COL_RATE, y + 6.5, { align: "right" });
    doc.text(formatAud(quote.total_inc_gst), COL_AMOUNT, y + 6.5, {
      align: "right",
    });
    canvas.y = y + 10 + 7;
  }

  const listItems = (body: string): string[] =>
    sanitiseText(body).split("\n")
      .map((item) => item.replace(/^\s*[-*\u2022]\s*/, "").trim())
      .filter(Boolean);

  if (quote.exclusions) {
    const items = listItems(quote.exclusions);
    canvas.section("Exclusions and assumptions", Math.min(items.length, 2) * 6.5);
    canvas.bullets(items);
  }

  canvas.section("Terms", 2 * 6.5);
  canvas.bullets([...RESTORATION_QUOTE_TERMS]);

  canvas.finish();
  const out = doc.output("arraybuffer") as ArrayBuffer;
  return { bytes: new Uint8Array(out), fileName };
}
