// Canonical trade-invoice audit PDF. Labour stays at submitted amounts.
// Super is one 12%-of-submitted-total line. Header, lines, and TOTAL agree.
// This is the document Books sees on the Xero DRAFT — not a per-line 88% shrink.

import {
  type TradeInvoiceAuditModel,
  type TradeInvoiceMoney,
  type TradeInvoiceXeroLine,
  buildTradeInvoiceAuditModel,
} from "./trade_invoice_money.ts";
import { distinctXeroPdfFilenames } from "./xero_attachment.ts";

const moneyLabel = (value: number): string => `$${value.toFixed(2)}`;

export function buildTradeInvoiceAuditText(
  model: TradeInvoiceAuditModel,
  options: { invoiceNumber?: string | null; tradeName?: string | null } = {},
): string[] {
  const tradeName = String(options.tradeName || "").trim() || "Trade";
  const invoiceNumber = String(options.invoiceNumber || "").trim() ||
    "trade-invoice";
  const lines: string[] = [
    "TAX INVOICE - labour at submitted amounts, super 12% of total once",
    `${tradeName}  ${invoiceNumber}`,
    `Submitted total ${moneyLabel(model.header.submitted_total)}`,
    `Super ${
      (model.super_rate * 100).toFixed(2)
    }% of submitted total ${moneyLabel(model.header.super_amount)}`,
    `Amount payable ${moneyLabel(model.header.amount_payable)}`,
    "Lines (submitted amounts - not reduced per line for super)",
  ];
  for (const line of model.submitted_lines) {
    const desc = line.description.replace(/\s+/g, " ").trim();
    lines.push(
      `${desc}  qty ${line.quantity} x ${moneyLabel(line.unit_amount)} = ${
        moneyLabel(line.line_total)
      }`,
    );
  }
  lines.push(
    `${
      model.super_line.description.replace(/\s+/g, " ").trim()
    }  ${moneyLabel(model.super_line.line_total)}`,
  );
  lines.push(
    `TOTAL payable (submitted total minus super) ${
      moneyLabel(model.header.amount_payable)
    }`,
  );
  if (model.gst_amount > 0) {
    lines.push(
      `GST ${moneyLabel(model.gst_amount)} on submitted total. Cash payable including GST ${
        moneyLabel(model.trade_payable)
      }`,
    );
  }
  return lines;
}

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function toAsciiPdfText(text: string): string {
  return text.replace(/[\u2014\u2013\u2212]/g, "-");
}

export const PDF_LINE_WIDTH = 90;
const PAGE_TOP = 760;
const PAGE_BOTTOM = 48;
const LINE_HEIGHT = 14;
const ROWS_PER_PAGE = Math.floor((PAGE_TOP - PAGE_BOTTOM) / LINE_HEIGHT);

/** Word-wrap so money amounts are never sliced off a PDF line. */
export function wrapPdfText(text: string, width = PDF_LINE_WIDTH): string[] {
  const ascii = toAsciiPdfText(String(text || "")).replace(/\s+/g, " ").trim();
  if (!ascii) return [""];
  const words = ascii.split(" ");
  const rows: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current) rows.push(current);
    if (word.length <= width) {
      current = word;
      continue;
    }
    let rest = word;
    while (rest.length > width) {
      rows.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    current = rest;
  }
  if (current) rows.push(current);
  return rows;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concatPdfBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Build a PDF. Long lines wrap; /Length and xref offsets are UTF-8 byte lengths. */
export function pdfFromTextLines(lines: string[]): Uint8Array<ArrayBuffer> {
  const rows = lines.flatMap((line) => wrapPdfText(line));
  const pages: string[][] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_PAGE) {
    pages.push(rows.slice(i, i + ROWS_PER_PAGE));
  }
  if (pages.length === 0) pages.push([""]);

  const contentStreams = pages.map((pageRows) => {
    const ops = ["BT", "/F1 11 Tf"];
    let y = PAGE_TOP;
    for (const row of pageRows) {
      ops.push(`1 0 0 1 36 ${y} Tm (${pdfEscape(row)}) Tj`);
      y -= LINE_HEIGHT;
    }
    ops.push("ET");
    return utf8(ops.join("\n"));
  });

  const pageCount = contentStreams.length;
  const pageIds = contentStreams.map((_, i) => 4 + i * 2);
  const contentIds = contentStreams.map((_, i) => 5 + i * 2);
  const byNumber: Uint8Array[] = [];
  byNumber[1] = utf8("<< /Type /Catalog /Pages 2 0 R >>");
  byNumber[2] = utf8(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
  );
  byNumber[3] = utf8(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  );
  for (let i = 0; i < pageCount; i++) {
    byNumber[pageIds[i]] = utf8(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentIds[i]} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    );
    byNumber[contentIds[i]] = concatPdfBytes([
      utf8(`<< /Length ${contentStreams[i].byteLength} >>\nstream\n`),
      contentStreams[i],
      utf8("\nendstream"),
    ]);
  }

  const objects = byNumber.slice(1);
  const chunks: Uint8Array[] = [utf8("%PDF-1.4\n")];
  const offsets = [0];
  let pos = chunks[0].byteLength;
  objects.forEach((object, index) => {
    offsets.push(pos);
    const start = utf8(`${index + 1} 0 obj\n`);
    const end = utf8("\nendobj\n");
    chunks.push(start, object, end);
    pos += start.byteLength + object.byteLength + end.byteLength;
  });
  const xrefPos = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  chunks.push(utf8(xref));
  return concatPdfBytes(chunks);
}

export function renderTradeInvoiceAuditPdf(input: {
  submittedLines: TradeInvoiceXeroLine[];
  money: TradeInvoiceMoney;
  tradeName?: string | null;
  invoiceNumber?: string | null;
}): { filename: string; bytes: Uint8Array<ArrayBuffer>; text: string[] } {
  const model = buildTradeInvoiceAuditModel(
    input.submittedLines,
    input.money,
    input.tradeName,
  );
  const text = buildTradeInvoiceAuditText(model, {
    invoiceNumber: input.invoiceNumber,
    tradeName: input.tradeName,
  });
  return {
    filename: distinctXeroPdfFilenames(input.invoiceNumber).audit,
    bytes: pdfFromTextLines(text),
    text,
  };
}
