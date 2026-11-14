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
  REPORT_PAGE,
  ReportCanvas,
  type TableCell,
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

const CONTENT_W = REPORT_PAGE.CONTENT_W;

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
    site: sanitiseText(input.site_address).slice(0, 90),
  });
  canvas.hero();
  canvas.facts(
    restorationQuoteHeaderRows(input).map(([label, value]) => ({
      label,
      value: sanitiseText(value) || "-",
    })),
    4,
  );

  if (quote.scope_of_works) {
    canvas.section("Scope of works", 12);
    canvas.paragraph(quote.scope_of_works);
  }

  // Ruled price table: item | description | qty | unit | rate | amount.
  const widths = [12, CONTENT_W - 12 - 14 - 16 - 26 - 28, 14, 16, 26, 28];
  const head: TableCell[] = [
    { text: "Item", bold: true, shade: true },
    { text: "Description", bold: true, shade: true },
    { text: "Qty", bold: true, shade: true, align: "right" },
    { text: "Unit", bold: true, shade: true },
    { text: "Rate ex GST", bold: true, shade: true, align: "right" },
    { text: "Amount ex GST", bold: true, shade: true, align: "right" },
  ];
  const rows: TableCell[][] = [
    head,
    ...quote.lines.map((line, i) => [
      { text: String(i + 1) },
      { text: sanitiseText(line.description) },
      { text: formatQuantity(line.quantity), align: "right" as const },
      { text: sanitiseText(line.unit || "") },
      { text: formatAud(line.unit_price_ex_gst), align: "right" as const },
      { text: formatAud(line.line_total_ex_gst), align: "right" as const },
    ]),
  ];
  const totalsW = [42, 28];
  const totals: TableCell[][] = [
    [{ text: "Subtotal ex GST", bold: true, shade: true }, {
      text: formatAud(quote.subtotal_ex_gst),
      align: "right",
    }],
    [{ text: "GST", bold: true, shade: true }, { text: formatAud(quote.gst), align: "right" }],
    [{ text: "Total inc GST", bold: true, shade: true }, {
      text: formatAud(quote.total_inc_gst),
      bold: true,
      align: "right",
    }],
  ];
  // When the table and its totals fit on one page they are never split.
  const tableH = canvas.tableHeight(widths, rows) + 3 + canvas.tableHeight(totalsW, totals);
  const freshPageRoom = REPORT_PAGE.BODY_BOTTOM - REPORT_PAGE.RUNNING_TOP - 15;
  canvas.section("Quoted works", tableH <= freshPageRoom ? tableH : 30);
  canvas.table(widths, rows, { header: true });
  canvas.gap(3);
  canvas.ensure(canvas.tableHeight(totalsW, totals));
  canvas.table(totalsW, totals, {
    x: REPORT_PAGE.MARGIN + CONTENT_W - totalsW[0] - totalsW[1],
  });
  canvas.gap(4);

  const listItems = (body: string): string[] =>
    sanitiseText(body).split("\n")
      .map((item) => item.replace(/^\s*[-*\u2022]\s*/, "").trim())
      .filter(Boolean);

  if (quote.exclusions) {
    const items = listItems(quote.exclusions);
    canvas.section("Exclusions and assumptions", Math.min(items.length, 2) * 6.5);
    canvas.bullets(items);
  }

  canvas.section("Terms", RESTORATION_QUOTE_TERMS.length * 6.5);
  canvas.bullets([...RESTORATION_QUOTE_TERMS]);

  canvas.finish({ endOfReport: false });
  const out = doc.output("arraybuffer") as ArrayBuffer;
  return { bytes: new Uint8Array(out), fileName };
}
