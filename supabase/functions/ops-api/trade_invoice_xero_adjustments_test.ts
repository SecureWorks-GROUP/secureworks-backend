// deno-lint-ignore-file no-import-prefix
// Group WO field-ready check V10: the crew member's pay is what Xero pays, with
// each change the office made to the bill in Xero named. Rows below are the
// stored money of real crew invoices and what xero-sync records from their
// Xero bills (xero_invoices copy, read 3 Nov 2026). Expected values are the
// Xero bill's total and the office's own line, never this code's output.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { presentTradeInvoiceMoney } from "./trade_invoice_money.ts";
import { tradeMoneyRow } from "./trade_money.ts";

// SW-INV-A-261011-029 (Alyx): app net pay 1438.20; Xero 1338.20 after the
// office's "Vehicle Loan repayment" -100.00 on account 611.
const ALYX_A261011029 = {
  id: "ti-alyx",
  invoice_number: "SW-INV-A-261011-029",
  week_start: "2026-09-28",
  week_end: "2026-10-04",
  status: "paid",
  xero_bill_status: "PAID",
  amount_paid: "1338.20",
  paid_at: "2026-10-16",
  subtotal_ex: "1530.00",
  gross_earned: "1530.00",
  super_rate: "0.120000",
  super_amount: "183.60",
  net_pay: "1438.20",
  gst: "0.00",
  gst_on: false,
  total_inc: "1530.00",
  xero_bill_total: "1338.20",
  xero_adjustments_ex: "-100.00",
  xero_adjustment_lines: [{ kind: "office_line", amount: -100, description: "Vehicle Loan repayment", account_code: "611" }],
};

// SW-INV-A-261101-023 (Anthony): still open in Xero (AUTHORISED, nothing paid);
// app 284.26, Xero 234.26 after the office's "Repay Over payment" -50.00 on 712.
const ANTHONY_A261101023 = {
  id: "ti-anthony",
  invoice_number: "SW-INV-A-261101-023",
  week_start: "2026-10-26",
  week_end: "2026-11-01",
  status: "pushed_to_xero",
  xero_bill_status: "AUTHORISED",
  amount_paid: "0.00",
  paid_at: null,
  subtotal_ex: "302.40",
  gross_earned: "302.40",
  super_rate: "0.120000",
  super_amount: "36.29",
  net_pay: "284.26",
  gst: "0.00",
  gst_on: false,
  total_inc: "302.40",
  created_at: "2026-11-01T13:36:26Z",
  xero_bill_total: "234.26",
  xero_adjustments_ex: "-50.00",
  xero_adjustment_lines: [{ kind: "office_line", amount: -50, description: "Repay Over payment", account_code: "712" }],
};

Deno.test("V10 read: Alyx's invoice shows the office's vehicle loan line and pays what Xero pays", () => {
  const out = presentTradeInvoiceMoney(ALYX_A261011029);
  // The app's own figure is unchanged; the pay figure after Xero is Xero's.
  assertEquals(out.trade_payable, 1438.2);
  assertEquals(out.xero_adjustments, {
    total: -100,
    lines: [{ description: "Vehicle Loan repayment", amount: -100, account_code: "611", kind: "office_line" }],
  });
  assertEquals(out.payable_after_xero, 1338.2);
  assertEquals(out.xero_pays, 1338.2);
});

Deno.test("V10 read: a bill not read yet adds nothing (unknown, never 0)", () => {
  const out = presentTradeInvoiceMoney({ ...ALYX_A261011029, xero_bill_total: null, xero_adjustments_ex: null, xero_adjustment_lines: null });
  assertEquals(out.trade_payable, 1438.2);
  assertEquals("xero_adjustments" in out, false);
  assertEquals("payable_after_xero" in out, false);
  assertEquals("xero_pays" in out, false);
});

Deno.test("V10 read: a GST bill Xero holds without GST is no deduction, and Xero's lower total still shows (SW-INV-H-260914-029)", () => {
  const out = presentTradeInvoiceMoney({
    week_end: "2026-09-13",
    status: "paid",
    xero_bill_status: "PAID",
    subtotal_ex: "2140.00",
    gross_earned: "2140.00",
    super_rate: "0.120000",
    super_amount: "256.80",
    net_pay: "1883.20",
    gst: "214.00",
    gst_on: true,
    total_inc: "2354.00",
    xero_bill_total: "1883.20",
    xero_adjustments_ex: "0.00",
    xero_adjustment_lines: [],
  });
  assertEquals(out.xero_adjustments, { total: 0, lines: [] });
  assertEquals(out.payable_after_xero, 2097.2);
  assertEquals(out.xero_pays, 1883.2);
});

Deno.test("V10 read: a voided bill keeps its recorded changes but Xero pays nothing on it, so no xero_pays", () => {
  const out = presentTradeInvoiceMoney({ ...ALYX_A261011029, xero_bill_status: "VOIDED" });
  assertEquals(out.payable_after_xero, 1338.2);
  assertEquals("xero_pays" in out, false);
});

Deno.test("V10 my money: an open bill is owed what Xero will pay, with the office's line named (SW-INV-A-261101-023)", () => {
  const row = tradeMoneyRow(presentTradeInvoiceMoney(ANTHONY_A261101023));
  assertEquals(row.payable, 234.26);
  assertEquals(row.outstanding, 234.26);
  assertEquals(row.trade_payable, 284.26);
  assertEquals(row.xero_pays, 234.26);
  assertEquals(row.xero_adjustments, {
    total: -50,
    lines: [{ description: "Repay Over payment", amount: -50, account_code: "712", kind: "office_line" }],
  });
});

Deno.test("V10 my money: a paid bill's payable is what Xero paid, so no false 'Invoiced' gap", () => {
  const row = tradeMoneyRow(presentTradeInvoiceMoney(ALYX_A261011029));
  assertEquals(row.payable, 1338.2);
  assertEquals(row.amount_paid, 1338.2);
  assertEquals(row.outstanding, 0);
});
