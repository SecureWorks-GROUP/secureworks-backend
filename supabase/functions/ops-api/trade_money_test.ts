import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fyStartFor, fyLabelFor, summariseTradeMoney, tradeMoneyRow } from "./trade_money.ts";

const paid = tradeMoneyRow({
  id: "i1", invoice_number: "SW-INV-H-260801-020", week_end: "2026-08-02", status: "paid", xero_bill_status: "PAID",
  paid_at: "2026-08-10", amount_paid: 2420.6, gross_earned: 2470, super_amount: 296.4, gst: 247, gst_on: true, trade_payable: 2420.6, total_inc: 2717,
});
const owed = tradeMoneyRow({
  id: "i2", invoice_number: "SW-INV-H-260904-026", week_end: "2026-09-06", status: "pushed_to_xero", xero_bill_status: "AUTHORISED",
  amount_paid: 0, gross_earned: 1000, super_amount: 120, gst: 100, gst_on: true, trade_payable: 980, total_inc: 1100,
});
const legacy = tradeMoneyRow({ id: "i3", week_end: "2026-09-06", status: "pushed_to_xero", xero_bill_status: "DRAFT", total_inc: 500, amount_paid: 0, figures_error: "MONEY_SPLIT_INVALID" });
const voided = tradeMoneyRow({ id: "i4", week_end: "2026-09-06", status: "pushed_to_xero", xero_bill_status: "VOIDED", trade_payable: 300, total_inc: 330 });
const draft = tradeMoneyRow({ id: "i5", week_end: "2026-09-13", status: "draft", trade_payable: 200, total_inc: 220 });

Deno.test("financial year starts 1 July", () => {
  assertEquals(fyStartFor("2026-09-08"), "2026-07-01");
  assertEquals(fyStartFor("2026-03-01"), "2025-07-01");
  assertEquals(fyLabelFor("2026-09-08"), "FY 2026/27");
});

Deno.test("row: paid invoice has no outstanding; owed invoice is payable minus paid", () => {
  assertEquals(paid.paid, true);
  assertEquals(paid.outstanding, 0);
  assertEquals(paid.payable, 2420.6);
  assertEquals(owed.paid, false);
  assertEquals(owed.outstanding, 980);
  assertEquals(owed.bucket, "2026-09");
});

Deno.test("row: a legacy row with a bad split is listed, counts its cash, and is flagged", () => {
  assertEquals(legacy.figures_ok, false);
  assertEquals(legacy.gross_earned, null);
  assertEquals(legacy.payable, 500);
  assertEquals(legacy.counts, true);
  assertEquals(typeof legacy.figures_note, "string");
});

Deno.test("row: voided bills and released drafts never count", () => {
  assertEquals(voided.counts, false);
  assertEquals(voided.outstanding, 0);
  assertEquals(draft.counts, false);
});

Deno.test("summary: this month, FYTD, all time and month buckets", () => {
  const s = summariseTradeMoney([paid, owed, legacy, voided, draft], "2026-09-08");
  assertEquals(s.fy_label, "FY 2026/27");
  assertEquals(s.month.invoices, 2);
  assertEquals(s.month.payable, 1480);
  assertEquals(s.month.outstanding, 1480);
  assertEquals(s.month.figures_incomplete, 1);
  assertEquals(s.fytd.invoices, 3);
  assertEquals(s.fytd.gross_earned, 3470);
  assertEquals(s.fytd.super_amount, 416.4);
  assertEquals(s.fytd.gst, 347);
  assertEquals(s.fytd.paid_total, 2420.6);
  assertEquals(s.fytd.outstanding, 1480);
  assertEquals(s.all_time.invoices, 3);
  assertEquals(s.months.map((m) => m.month), ["2026-09", "2026-08"]);
  assertEquals(s.months[1].label, "Aug 2026");
  assertEquals(s.invoices.length, 5, "every row is listed, counted or not");
});

Deno.test("summary: an invoice from last financial year is all-time only", () => {
  const old = tradeMoneyRow({ id: "o", week_end: "2026-05-03", status: "paid", xero_bill_status: "PAID", trade_payable: 100, amount_paid: 100, total_inc: 110 });
  const s = summariseTradeMoney([old, owed], "2026-09-08");
  assertEquals(s.fytd.invoices, 1);
  assertEquals(s.all_time.invoices, 2);
  assertEquals(s.months.length, 2);
  const s2 = summariseTradeMoney([old, owed], "2026-09-08", 3);
  assertEquals(s2.months.length, 1, "months window trims old buckets");
});
