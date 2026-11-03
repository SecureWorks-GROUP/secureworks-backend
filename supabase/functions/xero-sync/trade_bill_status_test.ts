import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tradeBillStatusPatch, xeroDateToIsoDate } from "./trade_bill_status.ts";

Deno.test("xeroDateToIsoDate handles /Date()/ and ISO", () => {
  assertEquals(xeroDateToIsoDate("/Date(1757289600000+0000)/"), "2025-09-08");
  assertEquals(xeroDateToIsoDate("2026-09-01T00:00:00"), "2026-09-01");
  assertEquals(xeroDateToIsoDate(null), null);
  assertEquals(xeroDateToIsoDate("nope"), null);
});

Deno.test("a PAID bill stamps paid_at, amount_paid, bill status and moves ours to paid", () => {
  const patch = tradeBillStatusPatch(
    { Status: "PAID", AmountPaid: 2420.6, FullyPaidOnDate: "/Date(1757289600000+0000)/" },
    { status: "pushed_to_xero", xero_bill_status: null, amount_paid: 0, paid_at: null },
  );
  assertEquals(patch, { xero_bill_status: "PAID", amount_paid: 2420.6, paid_at: "2025-09-08", status: "paid" });
});

Deno.test("an AUTHORISED bill records approval without pretending payment", () => {
  const patch = tradeBillStatusPatch(
    { Status: "AUTHORISED", AmountPaid: 0 },
    { status: "pushed_to_xero", xero_bill_status: "DRAFT", amount_paid: 0, paid_at: null },
  );
  assertEquals(patch, { xero_bill_status: "AUTHORISED" });
});

Deno.test("no change means no write", () => {
  assertEquals(
    tradeBillStatusPatch({ Status: "PAID", AmountPaid: 100, FullyPaidOnDate: "2026-09-01" }, { status: "paid", xero_bill_status: "PAID", amount_paid: 100, paid_at: "2026-09-01" }),
    null,
  );
  assertEquals(tradeBillStatusPatch({}, { status: "paid" }), null);
});

Deno.test("a released (draft / ops-reject) row never flips to paid but still mirrors the bill", () => {
  const patch = tradeBillStatusPatch({ Status: "PAID", AmountPaid: 50, FullyPaidOnDate: "2026-09-01" }, { status: "ops-reject" });
  assertEquals(patch?.status, undefined);
  assertEquals(patch?.xero_bill_status, "PAID");
});

Deno.test("a partial payment updates amount_paid without paid_at", () => {
  const patch = tradeBillStatusPatch({ Status: "AUTHORISED", AmountPaid: 500 }, { status: "pushed_to_xero", xero_bill_status: "AUTHORISED", amount_paid: 0 });
  assertEquals(patch, { amount_paid: 500 });
});

import { shouldBackfillTradeBillPdf } from "./trade_bill_status.ts";
Deno.test("pdf backfill: only live trade bills Xero reports without attachments", () => {
  const live = { status: "pushed_to_xero" };
  assertEquals(shouldBackfillTradeBillPdf({ Type: "ACCPAY", Status: "DRAFT", HasAttachments: false, LineItems: [{}] }, live), true);
  assertEquals(shouldBackfillTradeBillPdf({ Type: "ACCPAY", Status: "PAID", HasAttachments: false, LineItems: [{}] }, live), true);
  assertEquals(shouldBackfillTradeBillPdf({ Type: "ACCPAY", Status: "DRAFT", HasAttachments: true, LineItems: [{}] }, live), false);
  assertEquals(shouldBackfillTradeBillPdf({ Type: "ACCPAY", Status: "VOIDED", HasAttachments: false, LineItems: [{}] }, live), false);
  assertEquals(shouldBackfillTradeBillPdf({ Type: "ACCREC", Status: "DRAFT", HasAttachments: false, LineItems: [{}] }, live), false);
  assertEquals(shouldBackfillTradeBillPdf({ Type: "ACCPAY", Status: "DRAFT", HasAttachments: false, LineItems: [] }, live), false);
  assertEquals(shouldBackfillTradeBillPdf({ Type: "ACCPAY", Status: "DRAFT", HasAttachments: false, LineItems: [{}] }, { status: "ops-reject" }), false);
});

// Field-ready V12: a real shape, SW-INV-SL-260830-005, PAID in Xero since
// 8 Sep, still pushed_to_xero here. The catch-up marks it paid from the copy;
// a released (ops-reject) row, an already-paid row and a non-bill are left alone.
Deno.test("catch-up: a bill PAID in the Xero copy is marked paid here", async () => {
  const { catchUpTradeBillStatusFromMirror } = await import("./trade_bill_status.ts");
  const trade = [
    { id: "t1", status: "pushed_to_xero", xero_bill_status: "AUTHORISED", amount_paid: 0, paid_at: null, xero_bill_id: "b1" },
    { id: "t2", status: "pushed_to_xero", xero_bill_status: "AUTHORISED", amount_paid: 0, paid_at: null, xero_bill_id: "b2" },
    { id: "t3", status: "approved", xero_bill_status: "AUTHORISED", amount_paid: 0, paid_at: null, xero_bill_id: "b3" },
  ];
  const mirror = [
    { xero_invoice_id: "b1", raw_json: { Type: "ACCPAY", Status: "PAID", AmountPaid: 985.6, FullyPaidOnDate: "/Date(1788849351307+0000)/" } },
    { xero_invoice_id: "b2", raw_json: { Type: "ACCPAY", Status: "AUTHORISED", AmountPaid: 2289.92 } },
    { xero_invoice_id: "b3", raw_json: { Type: "ACCREC", Status: "PAID", AmountPaid: 10 } },
  ];
  const writes: { id: string; patch: Record<string, unknown>; guard: unknown }[] = [];
  const query = (rows: any[]) => {
    const q: any = { rows, select: () => q, not: () => q, limit: () => q, in: (_c: string, v: string[]) => ({ ...q, rows: rows.filter((r) => v.includes(r.xero_invoice_id)), then: (f: any) => f({ data: rows.filter((r) => v.includes(r.xero_invoice_id)), error: null }) }), then: (f: any) => f({ data: rows, error: null }) };
    return q;
  };
  const sb = {
    from: (t: string) => t === "xero_invoices" ? query(mirror) : {
      ...query(trade),
      update: (patch: Record<string, unknown>) => ({ eq: (_c: string, id: string) => ({ eq: (_c2: string, guard: unknown) => { writes.push({ id, patch, guard }); return Promise.resolve({ error: null }); } }) }),
    },
  };
  const out = await catchUpTradeBillStatusFromMirror(sb);
  assertEquals(out, { checked: 2, patched: 2, failed: 0 });
  assertEquals(writes[0], { id: "t1", guard: "pushed_to_xero", patch: { xero_bill_status: "PAID", amount_paid: 985.6, paid_at: "2026-09-08", status: "paid" } });
  // Part paid: the amount is recorded, the status stays open.
  assertEquals(writes[1], { id: "t2", guard: "pushed_to_xero", patch: { amount_paid: 2289.92 } });
});
