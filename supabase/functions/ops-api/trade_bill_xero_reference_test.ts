// deno-lint-ignore-file no-import-prefix
// 2026-09-10 (Alyx audit): Xero ignores `Reference` on ACCPAY, so every trade
// bill landed with a blank reference and the bookkeeper typed it by hand.
// The supplier-bill field is `InvoiceNumber`. Pin it on every trade push path,
// and pin the super line to its own (configurable) account.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tradeBillInvoiceNumber, TRADE_INVOICE_SUPER_XERO_ACCOUNT_CODE, TRADE_INVOICE_XERO_ACCOUNT_CODE } from "./wo_labour_fanout.ts";

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("every trade ACCPAY payload sets InvoiceNumber beside Reference", () => {
  const payloads = INDEX.split("Type: 'ACCPAY',").slice(1);
  assert(payloads.length >= 4, "expected at least the four trade bill payloads");
  let checked = 0;
  for (const p of payloads) {
    const head = p.slice(0, 700);
    if (!/Reference: /.test(head)) continue;
    if (!/Contact: \{ ContactID: (xeroContactId|woXeroContactId|stXeroContactId) \}/.test(head)) continue;
    checked++;
    assert(/InvoiceNumber: tradeBillInvoiceNumber\(/.test(head), "trade bill payload missing InvoiceNumber:\n" + head.slice(0, 300));
  }
  assertEquals(checked, 4, "four trade bill payloads must carry InvoiceNumber");
});

Deno.test("the SW invoice number is preferred, the reference string is the fallback, blanks never win", () => {
  assertEquals(tradeBillInvoiceNumber("SW-INV-A-260830-025", "Alyx | SW-INV-A-260830-025 | SWF-261063"), "SW-INV-A-260830-025");
  assertEquals(tradeBillInvoiceNumber(null, "  ", "Alyx | WE 2026-09-06 | SWF-1"), "Alyx | WE 2026-09-06 | SWF-1");
  assertEquals(tradeBillInvoiceNumber(undefined, ""), "");
  assertEquals(tradeBillInvoiceNumber("x".repeat(300)).length, 255);
});

Deno.test("the super line uses the dedicated account constant on every push path", () => {
  assertEquals((INDEX.match(/superAccountCode: TRADE_INVOICE_SUPER_XERO_ACCOUNT_CODE/g) || []).length, 4);
  assertEquals((INDEX.match(/superAccountCode: TRADE_INVOICE_XERO_ACCOUNT_CODE\b/g) || []).length, 0);
  // Unconfigured, it must fall back to 306 so nothing moves silently.
  if (!Deno.env.get("TRADE_SUPER_XERO_ACCOUNT_CODE")) {
    assertEquals(TRADE_INVOICE_SUPER_XERO_ACCOUNT_CODE, TRADE_INVOICE_XERO_ACCOUNT_CODE);
  }
});
