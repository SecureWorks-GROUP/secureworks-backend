// deno-lint-ignore-file no-import-prefix

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateTradeInvoiceMoney } from "./trade_invoice_money.ts";
import {
  buildTradeInvoiceAuditText,
  renderTradeInvoiceAuditPdf,
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
      Description: "SWF-261132 Matthew Dunne",
      Quantity: 1,
      UnitAmount: 803.20,
    },
    {
      Description: "SWF-26824 Hannah Crugnale",
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
  const pdfText = new TextDecoder().decode(pdf.bytes);
  assertEquals(pdfText.startsWith("%PDF-"), true);
  assert(pdfText.includes("Submitted total $2208.20"));
  assert(pdfText.includes("Amount payable $1943.22"));
  assertEquals(pdfText.includes("Net earnings after"), false);
});
