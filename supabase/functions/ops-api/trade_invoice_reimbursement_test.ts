import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveReimbursementExtras } from "./trade_invoice_reimbursement.ts";
import { calculateTradeInvoiceMoney } from "./trade_invoice_money.ts";

const receipt = (extra = {}) => ({ id: "ZZTEST-receipt", submitted_by: "ZZTEST-trade", payment_method: "personal_card", receipt_storage_path: "ZZTEST/receipt.png", status: "pending", total_amount: 80, vendor_name: "ZZTEST supplier", receipt_date: "2026-11-16", job_id: "ZZTEST-job", jobs: { job_number: "ZZTEST-01" }, ...extra });
function client(row: unknown, claims: unknown[] = []) {
  return { from(table: string) { return { select() { return this; }, eq() { return this; }, maybeSingle() { return Promise.resolve({ data: row }); }, then(resolve: (r: unknown) => unknown) { return Promise.resolve({ data: claims }).then(resolve); } }; } };
}
const resolve = (row: unknown, options = {}, claims: unknown[] = []) => resolveReimbursementExtras(client(row, claims), { userId: "ZZTEST-trade", items: [{ type: " Reimbursement ", expense_receipt_id: "ZZTEST-receipt", rate: 500 }], flagOn: true, basis: "inclusive_12_112_v1", ...options });

Deno.test("ZZTEST reimbursement checks skip only the receipt in the required order", async () => {
  const cases: [unknown, Record<string, unknown>, unknown[], string][] = [
    [null, { flagOn: false }, [], "reimbursement_switch_off"],
    [null, { basis: null }, [], "reimbursement_switch_off"],
    [null, {}, [], "reimbursement_not_yours"],
    [receipt({ submitted_by: "ZZTEST-other" }), {}, [], "reimbursement_not_yours"],
    [receipt({ payment_method: "company_card", receipt_storage_path: null }), {}, [], "reimbursement_not_personal_spend"],
    [receipt({ receipt_storage_path: "", receipt_photo_url: "", status: "rejected" }), {}, [], "reimbursement_receipt_required"],
    [receipt({ no_receipt_reason: "ZZTEST missing" }), {}, [], "reimbursement_receipt_required"],
    [receipt({ status: "rejected" }), {}, [], "reimbursement_rejected"],
    [receipt(), {}, [{ trade_invoice_id: "ZZTEST-invoice", invoice: { status: "submitted" } }], "reimbursement_already_claimed"],
    [receipt({ xero_bill_id: "ZZTEST-bill" }), {}, [], "reimbursement_already_claimed"],
  ];
  for (const [row, options, claims, code] of cases) {
    const result = await resolve(row, options, claims);
    assertEquals(result.lines, []);
    assertEquals(result.skipped_items.map((s: any) => s.code), [code]);
    const hours = [{ line_type: "labour", line_total_ex: 560 }];
    assertEquals([...hours, ...result.lines], hours);
  }
});
Deno.test("ZZTEST receipt sets the amount and its office backing, with no job held", async () => {
  for (const [row, hold] of [[receipt(), "reimbursement"], [receipt({ status: "approved" }), null], [receipt({ job_id: null, jobs: null, status: "approved" }), "no_job"]] as const) {
    const result = await resolve(row);
    assertEquals(result.skipped_items, []);
    assertEquals(result.lines.length, 1);
    assertEquals(result.lines[0].line_total_ex, 80);
    assertEquals(result.lines[0].unit_rate, 80);
    assertEquals(result.lines[0].hold_reason, hold);
    assertEquals(result.lines[0].office_review_status, hold ? "awaiting" : "approved");
    assertEquals(result.lines[0].job_id, row.job_id);
  }
});
Deno.test("ZZTEST one receipt produces one line; draft and rejected claims do not spend it", async () => {
  const result = await resolve(receipt(), { items: [{ expense_receipt_id: "ZZTEST-receipt" }, { expense_receipt_id: "ZZTEST-receipt" }] }, [{ invoice: { status: "draft" } }, { invoice: { status: "ops-reject" } }]);
  assertEquals(result.lines.length, 1);
});
Deno.test("ZZTEST weekly receipt stays out of the super base and hours", async () => {
  const result = await resolve(receipt());
  const money = calculateTradeInvoiceMoney({ grossEarned: 560 + result.lines[0].line_total_ex, gstOn: false, earningsDate: "2026-11-16", superBasis: "inclusive_12_112_v1", reimbursementEx: 80 });
  assertEquals([money.gross_earned, money.super_base_ex, money.super_amount, money.net_pay], [640, 560, 60, 580]);
  assertEquals(result.lines[0].total_hours ?? 0, 0);
});
