// No super on commission (Marnin, business owner, 12 Nov 2026).
//
// Commission lines stay in gross earned but carry no super: super is 12% of
// gross less commission, the worker withhold 6% of it. An invoice priced
// before the change (super on the whole gross, no stored super base) stays
// valid and is never re-priced. Every figure below is made up.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  assertReturnedTradeInvoiceXeroSplit,
  assertTradeInvoiceSuperBaseMatchesLines,
  buildTradeInvoiceAuditModel,
  calculateTradeInvoiceMoney,
  presentTradeInvoiceMoney,
  splitTradeInvoiceXeroLines,
  tradeInvoiceSuperBaseEx,
  TradeInvoiceMoneyError,
  validatePersistedTradeInvoiceMoney,
} from "./trade_invoice_money.ts";
import { commissionLinesTotalEx } from "./trade_invoice_extra_job_authority.ts";
import { buildTradeInvoiceAuditText } from "./trade_invoice_pdf.ts";

const DAY = "2026-11-09";

Deno.test("worked example: $1,000 of hours and $200 commission", () => {
  const money = calculateTradeInvoiceMoney({ grossEarned: 1200, gstOn: false, earningsDate: DAY, commissionEx: 200 });
  assertEquals(money, {
    gst_on: false,
    super_rate: 0.12,
    gross_earned: 1200,
    super_amount: 120,
    worker_withhold: 60,
    company_contribution: 60,
    net_pay: 1140,
    gst_amount: 0,
    trade_payable: 1140,
    total_inc: 1200,
    company_total_out: 1260,
    super_base_ex: 1000,
  });
  // GST stays 10% of the whole gross, commission included.
  const gst = calculateTradeInvoiceMoney({ grossEarned: 1200, gstOn: true, earningsDate: DAY, commissionEx: 200 });
  assertEquals([gst.gst_amount, gst.trade_payable, gst.total_inc, gst.super_amount], [120, 1260, 1320, 120]);
});

Deno.test("no commission: the split is exactly what it was, with no super base", () => {
  for (const commissionEx of [undefined, 0, -50, "abc"]) {
    const money = calculateTradeInvoiceMoney({ grossEarned: 1000, gstOn: false, earningsDate: DAY, commissionEx });
    assertEquals([money.super_amount, money.worker_withhold, money.net_pay], [120, 60, 940]);
    assert(!("super_base_ex" in money), JSON.stringify(commissionEx));
  }
});

Deno.test("an invoice of only commission carries no super; the base never goes below 0", () => {
  const money = calculateTradeInvoiceMoney({ grossEarned: 200, gstOn: false, earningsDate: DAY, commissionEx: 200 });
  assertEquals([money.super_base_ex, money.super_amount, money.worker_withhold, money.net_pay], [0, 0, 0, 200]);
  assertEquals(tradeInvoiceSuperBaseEx(150, 200), 0);
  assertEquals(tradeInvoiceSuperBaseEx(1200, 0), null);
  assertEquals(tradeInvoiceSuperBaseEx(1200, 200), 1000);
});

Deno.test("commission lines are read by the one line-type rule", () => {
  assertEquals(commissionLinesTotalEx([
    { line_type: "commission", line_total_ex: 200 },
    { line_type: " Commission ", line_total_ex: "50.10" },
    { line_type: "labour", line_total_ex: 1000 },
    { line_type: "work order", line_total_ex: 300 },
    { line_type: "commissions", line_total_ex: 999 },
    { line_type: null, line_total_ex: 5 },
  ]), 250.1);
  assertEquals(commissionLinesTotalEx([]), 0);
});

const NEW_ROW = {
  gst_on: false,
  super_rate: 0.12,
  super_amount: 120,
  gross_earned: 1200,
  net_pay: 1140,
  super_base_ex: 1000,
  gst: 0,
  total_inc: 1200,
  subtotal_ex: 1200,
  week_end: DAY,
};

Deno.test("persisted: a stored super base reads back as the commission-free split", () => {
  const money = validatePersistedTradeInvoiceMoney(NEW_ROW);
  assertEquals(
    [money.super_amount, money.worker_withhold, money.company_contribution, money.net_pay, money.trade_payable, money.super_base_ex],
    [120, 60, 60, 1140, 1140, 1000],
  );
  assertEquals(presentTradeInvoiceMoney({ ...NEW_ROW }).trade_payable, 1140);
});

Deno.test("persisted: an invoice priced before 12 Nov 2026 with commission stays valid on the old rule", () => {
  // Super on the whole 1,200, commission included; no super base stored.
  const current = validatePersistedTradeInvoiceMoney({ ...NEW_ROW, super_base_ex: null, super_amount: 144, net_pay: 1128 });
  assertEquals([current.super_amount, current.net_pay, current.super_base_ex], [144, 1128, undefined]);
  // The older full 12% carve-out too.
  const carveOut = validatePersistedTradeInvoiceMoney({ ...NEW_ROW, super_base_ex: undefined, super_amount: 144, net_pay: 1056 });
  assertEquals(carveOut.net_pay, 1056);
});

Deno.test("persisted: a split that does not match its super base is refused", () => {
  const bad = [
    { ...NEW_ROW, super_amount: 144, net_pay: 1128 }, // super on commission with a base stored
    { ...NEW_ROW, net_pay: 1128 }, // withhold on commission
    { ...NEW_ROW, net_pay: 1080 }, // full carve-out with a base
    { ...NEW_ROW, super_base_ex: 1200, super_amount: 144, net_pay: 1128 }, // base not below gross
    { ...NEW_ROW, super_base_ex: -1 },
    { ...NEW_ROW, super_base_ex: "x" },
    // A read that dropped the column sees new figures as a broken old split.
    { ...NEW_ROW, super_base_ex: undefined },
  ];
  for (const row of bad) {
    const e = assertThrows(() => validatePersistedTradeInvoiceMoney(row), TradeInvoiceMoneyError);
    assertEquals(e.code, "MONEY_SPLIT_INVALID", JSON.stringify(row));
  }
});

const XERO_LINES = [
  { Description: "Fixture work", Quantity: 20, UnitAmount: 50, AccountCode: "306", TaxType: "NONE" },
  { Description: "Commission", Quantity: 1, UnitAmount: 200, AccountCode: "306", TaxType: "NONE" },
];

Deno.test("Xero bill: work at the submitted amounts, the withhold line is 6% of gross less commission", () => {
  const money = calculateTradeInvoiceMoney({ grossEarned: 1200, gstOn: false, earningsDate: DAY, commissionEx: 200 });
  const lines = splitTradeInvoiceXeroLines(XERO_LINES, money, { superAccountCode: "306", tradeName: "Fixture Trade" });
  assertEquals(lines.length, 3);
  const withhold = lines[2];
  assertEquals([withhold.Quantity, withhold.UnitAmount, withhold.TaxType], [1, -60, "NONE"]);
  const description = String(withhold.Description);
  assertStringIncludes(description, "Superannuation Guarantee 12.00% of submitted total less commission");
  assertStringIncludes(description, "Commission $200.00 carries no super.");
  assertStringIncludes(description, "Super remittance $120.00 on $1000.00.");
  assertStringIncludes(description, "Amount payable $1140.00.");
  const total = lines.reduce((s, l) => s + Number(l.Quantity) * Number(l.UnitAmount), 0);
  assertEquals(Math.round(total * 100) / 100, 1140);
  // The bill Xero returns is checked against the same figures.
  assertReturnedTradeInvoiceXeroSplit(lines, money);
  // ... and the persisted invoice drives the same bill on a retry.
  const retried = splitTradeInvoiceXeroLines(XERO_LINES, validatePersistedTradeInvoiceMoney(NEW_ROW), {
    superAccountCode: "306",
    tradeName: "Fixture Trade",
  });
  assertEquals(retried, lines);
});

Deno.test("Xero bill: no commission keeps the old withhold wording, byte for byte", () => {
  const money = calculateTradeInvoiceMoney({ grossEarned: 1000, gstOn: false, earningsDate: DAY });
  const lines = splitTradeInvoiceXeroLines([XERO_LINES[0]], money, { superAccountCode: "306", tradeName: "Fixture Trade" });
  assertEquals(
    lines[1].Description,
    [
      "Superannuation Guarantee 12.00% of submitted total",
      "Submitted total $1000.00. Super remittance $120.00. Worker withhold $60.00. Company contribution $60.00. Amount payable $940.00.",
      "Paid to the super fund separately - this line withholds the worker share only; the company pays the other half. Not part of the amount payable to Fixture Trade",
    ].join("\n"),
  );
});

Deno.test("audit PDF names the super base when commission is left out", () => {
  const money = calculateTradeInvoiceMoney({ grossEarned: 1200, gstOn: false, earningsDate: DAY, commissionEx: 200 });
  const model = buildTradeInvoiceAuditModel(XERO_LINES, money, "Fixture Trade");
  assertEquals(model.super_base_ex, 1000);
  const text = buildTradeInvoiceAuditText(model, { invoiceNumber: "SW-INV-ZZ-1", tradeName: "Fixture Trade" });
  assert(text.some((l) => l === "Super 12.00% remittance of submitted total less commission ($1000.00) $120.00"), text.join("\n"));
  const plain = buildTradeInvoiceAuditModel([XERO_LINES[0]], calculateTradeInvoiceMoney({ grossEarned: 1000, gstOn: false, earningsDate: DAY }));
  assertEquals(plain.super_base_ex, null);
});

Deno.test("retry: a stored super base must still match the lines' commission", () => {
  const money = validatePersistedTradeInvoiceMoney(NEW_ROW);
  assertTradeInvoiceSuperBaseMatchesLines(money, commissionLinesTotalEx([
    { line_type: "labour", line_total_ex: 1000 },
    { line_type: "commission", line_total_ex: 200 },
  ]));
  for (const commission of [0, 150]) {
    const e = assertThrows(
      () => assertTradeInvoiceSuperBaseMatchesLines(money, commission),
      TradeInvoiceMoneyError,
    );
    assertEquals(e.code, "MONEY_SPLIT_INVALID");
  }
  // An old-rule invoice with commission lines is left as it was priced.
  const old = validatePersistedTradeInvoiceMoney({ ...NEW_ROW, super_base_ex: null, super_amount: 144, net_pay: 1128 });
  assertTradeInvoiceSuperBaseMatchesLines(old, 200);
});
