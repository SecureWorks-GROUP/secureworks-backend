// deno-lint-ignore-file no-import-prefix

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateTradeInvoiceMoney } from "./trade_invoice_money.ts";
import {
  buildTradeInvoiceAuditText,
  pdfFromTextLines,
  renderTradeInvoiceAuditPdf,
  wrapPdfText,
} from "./trade_invoice_pdf.ts";
import { buildTradeInvoiceAuditModel } from "./trade_invoice_money.ts";

Deno.test("audit PDF keeps submitted line amounts and shows one 12%-of-total super line", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 2_208.20,
    gstOn: false,
    earningsDate: "2026-08-28",
  });
  const submitted = [
    {
      Description:
        "SWF-261132 Matthew Dunne Work order $1058.20. Less labour: Ayden 8.5h x $30 = $255.00. 4 Chepstow Way Butler.",
      Quantity: 1,
      UnitAmount: 803.20,
    },
    {
      Description:
        "SWF-26824 Hannah Crugnale Work order $2830.00. Less labour deducted $1,425.00. 24 Wychcross St Westminster.",
      Quantity: 1,
      UnitAmount: 1_405.00,
    },
  ];
  const model = buildTradeInvoiceAuditModel(submitted, money, "Isaac Belcher");
  const text = buildTradeInvoiceAuditText(model, {
    tradeName: "Isaac Belcher",
    invoiceNumber: "SW-INV-I-260828-001",
  }).join("\n");

  assertEquals(text.includes("Net earnings after"), false);
  assertEquals(text.includes("$706.82"), false);
  assert(text.includes("$803.20"));
  assert(text.includes("$1405.00"));
  assert(text.includes("Submitted total $2208.20"));
  assert(text.includes("Super 12.00% of submitted total $264.98"));
  assert(text.includes("Amount payable $1943.22"));
  assert(text.includes("TOTAL payable (submitted total minus super) $1943.22"));
  assertEquals((text.match(/Superannuation Guarantee/g) || []).length, 1);

  const pdf = renderTradeInvoiceAuditPdf({
    submittedLines: submitted,
    money,
    tradeName: "Isaac Belcher",
    invoiceNumber: "SW-INV-I-260828-001",
  });
  const pdfText = new TextDecoder("latin1").decode(pdf.bytes);
  assertEquals(pdfText.startsWith("%PDF-"), true);
  assert(pdfText.includes("Submitted total $2208.20"));
  assert(pdfText.includes("Amount payable $1943.22"));
  assert(
    pdfText.includes("= $803.20") || pdfText.includes("$803.20"),
    "rendered PDF must show the full submitted line total, not a clipped $803.",
  );
  assert(pdfText.includes("$1405.00"), "rendered PDF must show the full $1405.00 line total");
  assert(
    pdfText.includes("$-264.98"),
    "rendered PDF bytes must contain the super minus amount, not a clipped Amount payable $1943.22. P",
  );
  assertEquals(pdfText.includes("Net earnings after"), false);
  assertEquals(pdf.filename, "SW-INV-I-260828-001-audit.pdf");
  assertEquals(pdfText.includes("\u2014"), false);
  assertPdfXrefByteAccurate(pdf.bytes);
});

function assertPdfXrefByteAccurate(bytes: Uint8Array) {
  // latin1 keeps one string index per byte so offsets are real file offsets.
  const ascii = new TextDecoder("latin1").decode(bytes);
  assertEquals(ascii.startsWith("%PDF-"), true);
  const startxref = ascii.match(/startxref\n(\d+)\n%%EOF/);
  assert(startxref, "startxref missing");
  const xrefOffset = Number(startxref[1]);
  assertEquals(ascii.slice(xrefOffset, xrefOffset + 4), "xref");

  const xrefBody = ascii.slice(xrefOffset);
  const table = xrefBody.match(/^xref\n0 (\d+)\n([\s\S]*?)\ntrailer/);
  assert(table, "xref table missing");
  const objectCount = Number(table[1]);
  const entries = table[2].split("\n").filter(Boolean);
  assertEquals(entries.length, objectCount);
  for (let i = 1; i < objectCount; i++) {
    const offset = Number(entries[i].slice(0, 10));
    assertEquals(
      ascii.slice(offset, offset + `${i} 0 obj`.length),
      `${i} 0 obj`,
      `object ${i} is not at xref offset ${offset}`,
    );
  }

  const lengthMatch = ascii.match(/\/Length (\d+)\s*>>\s*\nstream\n/);
  assert(lengthMatch, "content /Length missing");
  const declared = Number(lengthMatch[1]);
  const streamStart = ascii.indexOf("\nstream\n") + "\nstream\n".length;
  const streamEnd = ascii.indexOf("\nendstream", streamStart);
  assertEquals(streamEnd - streamStart, declared);
}

Deno.test("audit PDF xref offsets and /Length are UTF-8 byte-accurate even if a line had an em-dash", () => {
  const bytes = pdfFromTextLines([
    "TAX INVOICE — labour at submitted amounts",
    "Paid to the super fund separately — not part of the amount payable",
    "Amount payable $1943.22",
  ]);
  const ascii = new TextDecoder("latin1").decode(bytes);
  assertEquals(ascii.includes("\u2014"), false);
  assert(ascii.includes("TAX INVOICE - labour at submitted amounts"));
  assert(ascii.includes("Amount payable $1943.22"));
  assertPdfXrefByteAccurate(bytes);
});

Deno.test("wrapPdfText keeps super minus and line totals instead of slicing at 118 chars", () => {
  const superLine =
    "Isaac Belcher Superannuation Guarantee 12.00% of submitted total Submitted total $2208.20. Super $264.98. Amount payable $1943.22. Paid to the super fund separately - not part of the amount payable to Isaac Belcher  $-264.98";
  assert(superLine.length > 118);
  const wrapped = wrapPdfText(superLine);
  assert(wrapped.length > 1);
  assertEquals(wrapped.some((row) => row.length > 118), false);
  assertEquals(wrapped.join(" ").includes("$-264.98"), true);
  assertEquals(wrapped.join(" ").includes("$1943.22"), true);

  const labour =
    "SWF-261132 Matthew Dunne Work order $1058.20. Less labour: Ayden 8.5h x $30 = $255.00. 4 Chepstow Way Butler.  qty 1 x $803.20 = $803.20";
  assert(labour.length > 118);
  const labourRows = wrapPdfText(labour);
  assertEquals(labourRows.join(" ").includes("= $803.20"), true);

  const bytes = pdfFromTextLines([labour, superLine]);
  const rendered = new TextDecoder("latin1").decode(bytes);
  assert(rendered.includes("$-264.98"));
  assert(rendered.includes("= $803.20") || rendered.includes("$803.20"));
  assertPdfXrefByteAccurate(bytes);
});

