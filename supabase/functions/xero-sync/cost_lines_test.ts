import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { billCostDocument } from "./cost_lines.ts";
const ctx = { orgId: "10000000-0000-4000-8000-000000000001", mirrorBillIds: new Set<string>() };
const bill = {
  xero_invoice_id: "ZZTEST-bill", invoice_type: "ACCPAY", status: "AUTHORISED",
  xero_contact_id: "ZZTEST-supplier", raw_json: { LineAmountTypes: "Exclusive" },
  line_items: [
    { LineItemID: "one", LineAmount: 400, TaxAmount: 40, AccountCode: "310" },
    { LineAmount: 600, TaxAmount: 60, AccountCode: "461" },
  ],
};
Deno.test("bill costs: source amounts, lanes, identities and mirror exclusion", () => {
  const d = billCostDocument(bill, ctx)!;
  assertEquals(d.live, true);
  assertEquals(d.party_id, "ZZTEST-supplier");
  assertEquals(d.lines.map(l => [l.line_key, l.amount_ex, l.lane, l.kind]), [
    ["one",400,"materials","supplier_bill"], ["n:2",600,"other","supplier_bill"],
  ]);
  const inclusive = billCostDocument({ ...bill, raw_json: { LineAmountTypes: "Inclusive" } }, ctx)!;
  assertEquals(inclusive.lines.map(l => l.amount_ex), [360,540]);
  const installer = billCostDocument({ ...bill, line_items: [{ LineAmount: 800, AccountCode: "306" }] }, ctx)!;
  assertEquals([installer.lines[0].kind, installer.lines[0].lane], ["installer_bill","labour"]);
  assertEquals(billCostDocument({ ...bill, status: "VOIDED" },ctx)!.live,false);
  assertEquals(billCostDocument(bill,{ ...ctx, mirrorBillIds: new Set([bill.xero_invoice_id]) }),null);
  assertEquals(billCostDocument({ ...bill, invoice_type: "ACCREC" },ctx),null);
  assertEquals(billCostDocument({ ...bill, line_items: [{ LineAmount: 0 }] },ctx)!.lines,[]);
});
