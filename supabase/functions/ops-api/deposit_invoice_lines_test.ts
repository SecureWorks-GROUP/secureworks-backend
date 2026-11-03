// B2 (Scope Engine finish line, 3 Nov 2026): the deposit invoice equals the accepted revision's deposit to the cent.
// The deposit is an inc-GST figure (the sealed revision's deposit.total_deposit_inc_gst). Sent as an ex-GST line
// (round(inc / 1.1)) with Xero adding 10% GST, about 1 in 11 inc-GST amounts land a cent off, because no ex-GST cent
// amount plus its rounded GST gives them; SWP-26248 Rev 10's deposit is one. Sent inc-GST (LineAmountTypes
// Inclusive), Xero's total is the deposit exactly. No Xero call: Xero's totalling is worked here as Xero works it
// (Exclusive: each line plus its own GST rounded to the cent; Inclusive: the line amounts as given).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { depositInvoiceLines } from "./deposit_invoice_lines.ts";

const r2 = (x: number) => Math.round(x * 100) / 100;
type Line = { quantity: number; unit_price: number };
function xeroTotal(types: "Inclusive" | "Exclusive", lines: Line[]): number {
  const amounts = lines.map((l) => r2(l.quantity * l.unit_price));
  if (types === "Inclusive") return r2(amounts.reduce((s, a) => s + a, 0));
  return r2(amounts.reduce((s, a) => s + a + r2(a * 0.1), 0));
}
// The lines as createDepositInvoice built them before: one ex-GST line, Xero adds GST.
const asItStood = (inc: number): Line[] => [{ quantity: 1, unit_price: r2(inc / 1.1) }];

Deno.test("B2: every deposit from $100.00 to $20,000.00 gives a Xero total equal to it to the cent", () => {
  let off = 0;
  for (let c = 10000; c <= 2000000; c++) {
    const inc = c / 100;
    const { line_amount_types, line_items } = depositInvoiceLines({ depositIncGst: inc, description: "Deposit", accountCode: "200" });
    if (Math.round(xeroTotal(line_amount_types, line_items) * 100) !== c) off++;
  }
  assertEquals(off, 0);
});

Deno.test("B2: a deposit no ex-GST line can make (100.04) is exact; the line carries the deposit itself, inc GST", () => {
  const out = depositInvoiceLines({ depositIncGst: 100.04, description: "Deposit (50% of $200.08 inc GST)", accountCode: "200" });
  assertEquals(out.line_amount_types, "Inclusive");
  assertEquals(out.line_items, [{ description: "Deposit (50% of $200.08 inc GST)", quantity: 1, unit_price: 100.04, account_code: "200" }]);
  assertEquals(xeroTotal(out.line_amount_types, out.line_items), 100.04);
});

Deno.test("B2: council fees added beside the deposit stay inc GST and add exactly; empty or zero extras are left out", () => {
  const out = depositInvoiceLines({
    depositIncGst: 1430.37, description: "Deposit", accountCode: "200",
    extras: [{ description: "Council / planning application fee", amount_inc_gst: 412.29 }, { description: "", amount_inc_gst: 5 }, { description: "Nothing", amount_inc_gst: 0 }],
  });
  assertEquals(out.line_items.length, 2);
  assertEquals(out.line_items[1].unit_price, 412.29);
  assertEquals(xeroTotal(out.line_amount_types, out.line_items), r2(1430.37 + 412.29));
});

Deno.test("B2 planted fault: the ex-GST line as it stood misses such deposits by a cent, so this test can tell", () => {
  assert(xeroTotal("Exclusive", asItStood(100.04)) !== 100.04);
  let off = 0;
  for (let c = 10000; c <= 200000; c++) if (Math.round(xeroTotal("Exclusive", asItStood(c / 100)) * 100) !== c) off++;
  assert(off > 0, "the old rule must miss some deposits");
});

Deno.test("B2: createDepositInvoice sends these lines with their own line type, and createInvoice passes it to Xero", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const dep = src.slice(src.indexOf("async function createDepositInvoice("), src.indexOf("async function createUnifiedInvoice("));
  assert(dep.includes("depositInvoiceLines("), "createDepositInvoice builds its lines with depositInvoiceLines");
  assert(dep.includes("line_amount_types: depositLines.line_amount_types"), "and passes their line type to createInvoice");
  assert(!dep.includes("depositAmountIncGst / 1.1") && !dep.includes("amount_inc_gst / 1.1"), "and no longer turns the deposit or extras into ex-GST lines");
  const inv = src.slice(src.indexOf("async function createInvoice("), src.indexOf("async function createInvoice(") + 20000);
  assert(inv.includes("LineAmountTypes: lineAmountTypes"), "createInvoice sends the caller's line type to Xero");
});
