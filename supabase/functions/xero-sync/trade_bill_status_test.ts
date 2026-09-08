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
