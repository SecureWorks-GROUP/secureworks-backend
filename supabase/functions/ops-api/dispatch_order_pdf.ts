// deno-lint-ignore-file no-explicit-any
// Dispatch slice 5: the purchase order PDF. Contract:
// docs/dispatch-slice-5-contract.md, section "The PDF".
//
// jsPDF, the same import the make-safe report renders with
// (makesafe_report_render.ts), A4 portrait. The creation date and the file id
// are fixed from the order's own facts, so the same order makes the same bytes.
// It carries the order, the job number, the quote-back line and the delivery
// address, and nothing else: no price, no total, no job notes, no client name,
// no phone number.

import {
  type DispatchOrderLine,
  formatDispatchQuantity,
  perthDate,
  sha256Hex,
} from "./dispatch_orders.ts";
import { DISPATCH_ORDERS_ADDRESS } from "./dispatch_order_send.ts";

export type DispatchOrderPdfInput = {
  poNumber: string;
  version: number;
  // The order's date: the day it was first made, so every version agrees.
  orderedAt: string;
  jobNumber: string | null;
  supplierName: string;
  deliverTo: string | null;
  lines: DispatchOrderLine[];
};

export type DispatchOrderPdf = {
  bytes: Uint8Array;
  sha256: string;
  pageCount: number;
  lineCount: number;
};

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 18;
const COL_ITEM_W = 128;
const COL_QTY_X = MARGIN + COL_ITEM_W + 4;
const COL_UNIT_X = COL_QTY_X + 20;
const ROW_LINE_H = 5;
const ORANGE: [number, number, number] = [241, 90, 41];
const STEEL: [number, number, number] = [41, 60, 70];
const MUTE: [number, number, number] = [76, 106, 124];

// jsPDF's built-in Helvetica is WinAnsi: anything outside it is replaced so a
// stray character can never break the file.
export function dispatchPdfText(value: unknown): string {
  return String(value ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/×/g, "x")
    .replace(/[^\x20-\x7e -ÿ]/g, "?");
}

export async function renderDispatchOrderPdf(
  input: DispatchOrderPdfInput,
): Promise<DispatchOrderPdf> {
  if (!input.poNumber) {
    throw new Error("renderDispatchOrderPdf: poNumber required");
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new Error("renderDispatchOrderPdf: at least one line required");
  }
  // deno-lint-ignore no-import-prefix
  const { jsPDF } = await import("https://esm.sh/jspdf@2.5.1");
  const doc: any = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  });
  doc.setCreationDate(new Date("2020-01-01T00:00:00.000Z"));
  const fileId = (await sha256Hex(
    JSON.stringify([
      input.poNumber,
      input.version,
      input.orderedAt,
      input.lines,
    ]),
  )).slice(0, 32);
  doc.setFileId(fileId);
  doc.setProperties({
    title: dispatchPdfText(`Purchase order ${input.poNumber}`),
  });

  const jobRef = input.jobNumber ? dispatchPdfText(input.jobNumber) : null;

  // The head: on page one in full, on later pages the order number only.
  const firstPageHead = (): number => {
    doc.setFillColor(...ORANGE);
    doc.rect(0, 0, PAGE_W, 5, "F");
    doc.setTextColor(...STEEL);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.text("PURCHASE ORDER", MARGIN, 20);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text("SecureWorks Group", PAGE_W - MARGIN, 15, { align: "right" });
    doc.setTextColor(...MUTE);
    doc.text(DISPATCH_ORDERS_ADDRESS, PAGE_W - MARGIN, 20, { align: "right" });

    let y = 32;
    const field = (label: string, value: string) => {
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...MUTE);
      doc.setFontSize(9);
      doc.text(label.toUpperCase(), MARGIN, y);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...STEEL);
      doc.setFontSize(11);
      const wrapped = doc.splitTextToSize(
        dispatchPdfText(value),
        PAGE_W - MARGIN * 2 - 38,
      );
      doc.text(wrapped, MARGIN + 38, y);
      y += Math.max(1, wrapped.length) * 5.5 + 1.5;
    };
    field("Order number", input.poNumber);
    if (input.version > 1) {
      field("Version", `Updated, version ${input.version}`);
    }
    field("Date", perthDate(input.orderedAt) || "");
    field("Job number", jobRef || "Not recorded");
    field("Supplier", input.supplierName || "");
    field("Deliver to", input.deliverTo || "Not recorded on the job");

    if (jobRef) {
      y += 2;
      doc.setDrawColor(...ORANGE);
      doc.setLineWidth(0.6);
      doc.rect(MARGIN, y - 5, PAGE_W - MARGIN * 2, 10);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(...STEEL);
      doc.text(
        `Please quote ${jobRef} on your delivery docket and invoice.`,
        MARGIN + 3,
        y + 1.5,
      );
      y += 10;
    }
    return y + 4;
  };
  const laterPageHead = (): number => {
    doc.setFillColor(...ORANGE);
    doc.rect(0, 0, PAGE_W, 5, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...STEEL);
    doc.text(`PURCHASE ORDER ${dispatchPdfText(input.poNumber)}`, MARGIN, 15);
    return 24;
  };
  const tableHead = (y: number): number => {
    doc.setFillColor(238, 242, 244);
    doc.rect(MARGIN, y - 4.5, PAGE_W - MARGIN * 2, 7, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(...MUTE);
    doc.text("ITEM", MARGIN + 2, y);
    doc.text("QTY", COL_QTY_X, y);
    doc.text("UNIT", COL_UNIT_X, y);
    return y + 7;
  };

  let y = tableHead(firstPageHead());
  const bottom = PAGE_H - MARGIN - 8;
  doc.setFont("helvetica", "normal");
  for (const line of input.lines) {
    doc.setFontSize(10.5);
    const item = doc.splitTextToSize(
      dispatchPdfText(line.description),
      COL_ITEM_W - 4,
    );
    const unit = doc.splitTextToSize(
      dispatchPdfText(line.unit ?? ""),
      PAGE_W - MARGIN - COL_UNIT_X,
    );
    const height = Math.max(item.length, unit.length, 1) * ROW_LINE_H + 2;
    if (y + height > bottom) {
      doc.addPage();
      y = tableHead(laterPageHead());
      doc.setFontSize(10.5);
    }
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...STEEL);
    doc.text(item, MARGIN + 2, y);
    if (line.quantity !== null && line.quantity !== undefined) {
      doc.text(formatDispatchQuantity(line.quantity), COL_QTY_X, y);
    } else {
      // No quantity yet: say so in the column, never leave it blank.
      doc.setFontSize(8);
      doc.text("To confirm", COL_QTY_X, y);
      doc.setFontSize(10.5);
    }
    if (unit.length > 0 && unit[0]) doc.text(unit, COL_UNIT_X, y);
    y += height;
    doc.setDrawColor(217, 225, 230);
    doc.setLineWidth(0.2);
    doc.line(MARGIN, y - 4, PAGE_W - MARGIN, y - 4);
  }

  const pageCount: number = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...MUTE);
    doc.text(`Page ${page} of ${pageCount}`, PAGE_W / 2, PAGE_H - 10, {
      align: "center",
    });
  }

  const bytes = new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
  return {
    bytes,
    sha256: await sha256Hex(bytes),
    pageCount,
    lineCount: input.lines.length,
  };
}

// `<job_id>/<po_number>-v<version>.pdf`; a version written beside a clash
// (two updates at once) carries a short suffix so neither file is overwritten.
export function dispatchOrderPdfPath(
  jobId: string,
  poNumber: string,
  version: number,
  suffix?: string,
): string {
  return `${jobId}/${poNumber}-v${version}${suffix ? `-${suffix}` : ""}.pdf`;
}
