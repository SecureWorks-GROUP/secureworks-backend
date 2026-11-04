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
    const q: any = { rows, select: () => q, not: () => q, or: () => q, order: () => q, limit: () => q, in: (_c: string, v: string[]) => ({ ...q, rows: rows.filter((r) => v.includes(r.xero_invoice_id)), then: (f: any) => f({ data: rows.filter((r) => v.includes(r.xero_invoice_id)), error: null }) }), then: (f: any) => f({ data: rows, error: null }) };
    return q;
  };
  const sb = {
    from: (t: string) => t === "xero_invoices" ? query(mirror) : {
      ...query(trade),
      update: (patch: Record<string, unknown>) => ({ eq: (_c: string, id: string) => ({ eq: (_c2: string, guard: unknown) => { writes.push({ id, patch, guard }); return Promise.resolve({ error: null }); } }) }),
    },
  };
  const out = await catchUpTradeBillStatusFromMirror(sb);
  assertEquals(out, { checked: 2, patched: 2, adjusted: 0, failed: 0 });
  assertEquals(writes[0], { id: "t1", guard: "pushed_to_xero", patch: { xero_bill_status: "PAID", amount_paid: 985.6, paid_at: "2026-09-08", status: "paid" } });
  // Part paid: the amount is recorded, the status stays open.
  assertEquals(writes[1], { id: "t2", guard: "pushed_to_xero", patch: { amount_paid: 2289.92 } });
});

// ── V10: the office's changes to a crew bill in Xero ──────────────────────────
// Bills below are real crew bills as Xero holds them (xero_invoices copy, read
// 3 Nov 2026). Amounts, accounts, tax types and the first two description lines
// are Xero's; client names and site addresses are left out. Every expected
// value is the Xero bill's own: its total, and the line the office added.
import {
  isOurTradeBillLine,
  readTradeBillAdjustments,
  TRADE_BILL_UNEXPLAINED_ADJUSTMENT,
  tradeBillAdjustmentsPatch,
} from "./trade_bill_status.ts";

const xline = (Description: string, LineAmount: number, AccountCode = "306", Quantity = 1) => ({
  Description, LineAmount, Quantity, UnitAmount: Math.round((LineAmount / Quantity) * 100) / 100, AccountCode, TaxType: "NONE",
});
const superLine = (detail: string, amount: number, name: string) =>
  xline(`Superannuation Guarantee 12.00% of submitted total\n${detail}\nPaid to the super fund separately - this line withholds the worker share only; the company pays the other half. Not part of the amount payable to ${name}`, amount);

// SW-INV-A-261011-029 (Alyx): app net pay 1438.20, Xero 1338.20.
const ALYX_A261011029 = {
  Type: "ACCPAY", Status: "PAID", Total: 1338.2, LineAmountTypes: "NoTax",
  LineItems: [
    xline("Alyx\nSWF-26968 | SW - FENCING\nWork order $650.00.", 305),
    xline("Alyx\nSWF-261209 | SW - FENCING\nWork order $1465.00.", 1225),
    superLine("Submitted total $1530.00. Super remittance $183.60. Worker withhold $91.80. Company contribution $91.80. Amount payable $1438.20.", -91.8, "Alyx"),
    xline("Vehicle Loan repayment", -100, "611"),
  ],
};
const ALYX_ROW = { status: "paid", net_pay: "1438.20", recurring_deduction_amount: null, users: { name: "Alyx" } };

// SW-INV-A-261015-020 (Anthony): app 631.68, Xero 581.68.
const ANTHONY_A261015020 = {
  Type: "ACCPAY", Status: "PAID", Total: 581.68, LineAmountTypes: "NoTax",
  LineItems: [
    xline("Anthony\nSWMS-261523 | SW - MAKESAFE", 33.6),
    xline("Anthony\nSWF-261240 | SW - FENCING", 268.8, "306", 8),
    xline("Anthony\nSWF-26545 | SW - FENCING", 201.6, "306", 6),
    xline("Anthony\nSWMS-261549 | SW - MAKESAFE", 134.4, "306", 4),
    xline("Anthony\nSWMS-26515 | SW - MAKESAFE", 33.6),
    superLine("Submitted total $672.00. Super remittance $80.64. Worker withhold $40.32. Company contribution $40.32. Amount payable $631.68.", -40.32, "Anthony"),
    xline("Back payment on over payment", -50, "712"),
  ],
};
const ANTHONY_ROW = { status: "paid", net_pay: "631.68", recurring_deduction_amount: null, users: { name: "Anthony" } };

Deno.test("V10: the office's vehicle loan line on Alyx's bill is recorded, named, and app pay less it is what Xero pays", () => {
  const read = readTradeBillAdjustments(ALYX_A261011029, ALYX_ROW);
  assertEquals(read, {
    xero_bill_total: 1338.2,
    xero_adjustments_ex: -100,
    xero_adjustment_lines: [{ description: "Vehicle Loan repayment", amount: -100, account_code: "611", kind: "office_line" }],
  });
  assertEquals(Math.round((1438.2 + read!.xero_adjustments_ex) * 100) / 100, 1338.2);
});

Deno.test("V10: the office's over-payment line on Anthony's bill is recorded on account 712", () => {
  const read = readTradeBillAdjustments(ANTHONY_A261015020, ANTHONY_ROW);
  assertEquals(read?.xero_bill_total, 581.68);
  assertEquals(read?.xero_adjustments_ex, -50);
  assertEquals(read?.xero_adjustment_lines, [{ description: "Back payment on over payment", amount: -50, account_code: "712", kind: "office_line" }]);
});

Deno.test("V10: the office's line is found after a trade rename too: the work lines still name their jobs", () => {
  const read = readTradeBillAdjustments(ALYX_A261011029, { ...ALYX_ROW, users: { name: "Alyx Smuts" } });
  assertEquals(read?.xero_adjustment_lines, [{ description: "Vehicle Loan repayment", amount: -100, account_code: "611", kind: "office_line" }]);
});

Deno.test("V10: a GST bill Xero holds without GST is not a deduction (SW-INV-H-260914-029)", () => {
  // Pushed with GST 214.00 on 2140.00; Xero has it tax-inclusive, total 1883.20.
  const jobs = ["SW1797", "SWMS-26508", "SWMS-26547", "SWMS-261391", "SWMS-261385", "SWMS-261389", "SWMS-261386", "SWMS-261313", "SWMS-261373", "SWMS-261396", "SWMS-261403", "SW1797", "SWMS-261402", "SWMS-261404", "SWMS-261399", "SWMS-261409", "SWMS-261406", "SWMS-261399", "SW1797"];
  const amounts = [240, 80, 80, 80, 80, 80, 80, 160, 80, 120, 80, 200, 180, 80, 40, 160, 80, 160, 80];
  const bill = {
    Type: "ACCPAY", Status: "PAID", Total: 1883.2, LineAmountTypes: "Inclusive",
    LineItems: [
      ...jobs.map((job, i) => ({ ...xline(`Hugo\n${job} | SW - MAKESAFE`, amounts[i]), TaxType: "INPUT" })),
      { ...xline("Superannuation Guarantee 12.00% of submitted total\nSubmitted total $2140.00. Super $256.80. Amount payable $1883.20.", -256.8), TaxType: "BASEXCLUDED" },
    ],
  };
  const read = readTradeBillAdjustments(bill, { status: "paid", net_pay: "1883.20", recurring_deduction_amount: null, users: { name: "Hugo" } });
  assertEquals(read, { xero_bill_total: 1883.2, xero_adjustments_ex: 0, xero_adjustment_lines: [] });
});

Deno.test("V10: our own weekly deduction line is not an office change (SW-INV-I-261029-013, Ute hire 200.00)", () => {
  const bill = {
    Type: "ACCPAY", Status: "PAID", Total: 508.76,
    LineItems: [
      xline("Isaac\nSWP-26941 | SW - PATIOS", 220, "306", 4),
      xline("Isaac\nSWP-261160 | SW - PATIOS", 273, "306", 6.5),
      xline("Isaac\nSWP-261046 | SW - PATIOS", 126, "306", 3),
      xline("Isaac\nSWP-261160 | SW - PATIOS", 135, "306", 3),
      superLine("Submitted total $754.00. Super remittance $90.48. Worker withhold $45.24. Company contribution $45.24. Amount payable $708.76.", -45.24, "Isaac"),
      xline("Weekly deduction - Ute hire\n$200.00 taken off the amount payable to Isaac, after super and GST. Not part of the work billed on this invoice.", -200),
    ],
  };
  const read = readTradeBillAdjustments(bill, { status: "paid", net_pay: "708.76", recurring_deduction_amount: "200.00", users: { name: "Isaac" } });
  assertEquals(read, { xero_bill_total: 508.76, xero_adjustments_ex: 0, xero_adjustment_lines: [] });
});

Deno.test("V10: a minus line we pushed under the trade's name (a fence lead's work-order deduction) is ours", () => {
  const line = xline("Henry\nWorkorder Sonny 3h x $35", -105);
  assertEquals(isOurTradeBillLine(line, "Henry"), true);
  assertEquals(isOurTradeBillLine(xline("Vehicle Loan repayment", -100, "611"), "Henry"), false);
  // A note line the office adds at 0.00 changes no pay and is not listed.
  assertEquals(readTradeBillAdjustments({ ...ALYX_A261011029, LineItems: [...ALYX_A261011029.LineItems, xline("Paid early as agreed", 0, "611")] }, ALYX_ROW)?.xero_adjustment_lines.length, 1);
  // Gross 395.00 (500.00 less the 105.00 deduction), 6% withheld 23.70, net pay 371.30.
  const bill = { Type: "ACCPAY", Status: "AUTHORISED", Total: 371.3, LineItems: [xline("Henry\nSWF-261009 | SW - FENCING", 500), line, superLine("Amount payable $371.30.", -23.7, "Henry")] };
  assertEquals(readTradeBillAdjustments(bill, { status: "pushed_to_xero", net_pay: 371.3, users: { name: "Henry" } }), { xero_bill_total: 371.3, xero_adjustments_ex: 0, xero_adjustment_lines: [] });
});

Deno.test("V10: a difference no line names is kept, unexplained, never dropped (SW-INV-I-260828-006)", () => {
  // 28 Aug push: net-earnings lines already after 12% super, plus a super line.
  const bill = {
    Type: "ACCPAY", Status: "PAID", Total: 1735.01,
    LineItems: [
      xline("Net earnings after 12.00% super\nPOSSIBLE DUPLICATE - verify prior trade invoice before approving\nSWF-261132 | SW - FENCING", 706.82),
      xline("Net earnings after 12.00% super\nPOSSIBLE DUPLICATE - verify prior trade invoice before approving\nSWF-26824 | SW - FENCING", 1236.4),
      xline("Superannuation Guarantee (12.00%) | Gross earned $2208.20 | Amount reserved for super", -208.21),
    ],
  };
  const read = readTradeBillAdjustments(bill, { status: "paid", net_pay: "1943.22", users: { name: "Israel" } });
  assertEquals(read, {
    xero_bill_total: 1735.01,
    xero_adjustments_ex: -208.21,
    xero_adjustment_lines: [{ description: TRADE_BILL_UNEXPLAINED_ADJUSTMENT, amount: -208.21, account_code: null, kind: "unexplained" }],
  });
});

Deno.test("V10: unknown stays unknown: no split, a released invoice or a bill without lines reads as null, never 0", () => {
  assertEquals(readTradeBillAdjustments(ALYX_A261011029, { status: "paid", net_pay: null, users: { name: "Alyx" } }), null);
  assertEquals(readTradeBillAdjustments(ALYX_A261011029, { ...ALYX_ROW, status: "ops-reject" }), null);
  assertEquals(readTradeBillAdjustments({ ...ALYX_A261011029, LineItems: [] }, ALYX_ROW), null);
  assertEquals(readTradeBillAdjustments({ ...ALYX_A261011029, LineItems: undefined }, ALYX_ROW), null);
  assertEquals(readTradeBillAdjustments({ ...ALYX_A261011029, Total: undefined }, ALYX_ROW), null);
});

Deno.test("V10: the patch writes all three columns when the bill says something new, and nothing when it does not", () => {
  const first = tradeBillAdjustmentsPatch(ALYX_A261011029, ALYX_ROW);
  assertEquals(first?.xero_adjustments_ex, -100);
  // As read back from Postgres: numeric strings, jsonb keys reordered.
  const stored = { ...ALYX_ROW, xero_bill_total: "1338.20", xero_adjustments_ex: "-100.00", xero_adjustment_lines: [{ kind: "office_line", amount: -100, description: "Vehicle Loan repayment", account_code: "611" }] };
  assertEquals(tradeBillAdjustmentsPatch(ALYX_A261011029, stored), null);
  // The office removes its line before paying: the record follows Xero.
  const withoutLoan = { ...ALYX_A261011029, Total: 1438.2, LineItems: ALYX_A261011029.LineItems.slice(0, 3) };
  assertEquals(tradeBillAdjustmentsPatch(withoutLoan, stored), { xero_bill_total: 1438.2, xero_adjustments_ex: 0, xero_adjustment_lines: [] });
});

Deno.test("V10 catch-up: a paid bill whose changes were never read is filled once, from the Xero copy", async () => {
  const { catchUpTradeBillStatusFromMirror } = await import("./trade_bill_status.ts");
  const trade = [{ ...ALYX_ROW, id: "t-alyx", xero_bill_status: "PAID", amount_paid: 1338.2, paid_at: "2026-10-16", xero_bill_id: "b-alyx", xero_bill_total: null, xero_adjustments_ex: null, xero_adjustment_lines: null }];
  const mirror = [{ xero_invoice_id: "b-alyx", raw_json: { ...ALYX_A261011029, AmountPaid: 1338.2, FullyPaidOnDate: "2026-10-16" } }];
  const writes: { id: string; patch: Record<string, unknown>; guard: unknown }[] = [];
  const filters: string[] = [];
  const query = (rows: any[]) => {
    const q: any = { select: () => q, not: (c: string, op: string, v: string) => { filters.push(`not ${c} ${op} ${v}`); return q; }, or: (f: string) => { filters.push(`or ${f}`); return q; }, order: () => q, limit: () => q, in: (_c: string, v: string[]) => ({ then: (f: any) => f({ data: rows.filter((r) => v.includes(r.xero_invoice_id)), error: null }) }), then: (f: any) => f({ data: rows, error: null }) };
    return q;
  };
  const sb = {
    from: (t: string) => t === "xero_invoices" ? query(mirror) : {
      ...query(trade),
      update: (patch: Record<string, unknown>) => ({ eq: (_c: string, id: string) => ({ eq: (_c2: string, guard: unknown) => { writes.push({ id, patch, guard }); return Promise.resolve({ error: null }); } }) }),
    },
  };
  const out = await catchUpTradeBillStatusFromMirror(sb);
  assertEquals(out, { checked: 1, patched: 0, adjusted: 1, failed: 0 });
  assertEquals(writes, [{ id: "t-alyx", guard: "paid", patch: { xero_bill_total: 1338.2, xero_adjustments_ex: -100, xero_adjustment_lines: [{ description: "Vehicle Loan repayment", amount: -100, account_code: "611", kind: "office_line" }] } }]);
  // A paid bill is picked up only while its changes are unread; released ones never.
  assertEquals(filters.includes('not status in ("draft","failed","ops-reject")'), true);
  assertEquals(filters.includes("or status.neq.paid,and(xero_adjustments_ex.is.null,net_pay.not.is.null)"), true);
});
