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

/** Build a one-page PDF. /Length and xref offsets are UTF-8 byte lengths. */
export function pdfFromTextLines(lines: string[]): Uint8Array<ArrayBuffer> {
  const ops = ["BT", "/F1 11 Tf"];
  let y = 760;
  for (const line of lines) {
    const clipped = toAsciiPdfText(line).slice(0, 118);
    ops.push(`1 0 0 1 36 ${y} Tm (${pdfEscape(clipped)}) Tj`);
    y -= 14;
    if (y < 48) break;
  }
  ops.push("ET");
  const stream = utf8(ops.join("\n"));
  const objects: Uint8Array[] = [
    utf8("<< /Type /Catalog /Pages 2 0 R >>"),
    utf8("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    utf8(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    ),
    concatPdfBytes([
      utf8(`<< /Length ${stream.byteLength} >>\nstream\n`),
      stream,
      utf8("\nendstream"),
    ]),
    utf8("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];

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
