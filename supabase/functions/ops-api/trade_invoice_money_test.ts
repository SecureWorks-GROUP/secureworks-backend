// deno-lint-ignore-file no-import-prefix

import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculateTradeInvoiceMoney,
  resolveTradeInvoiceGstOn,
  splitTradeInvoiceXeroLines,
  TradeInvoiceMoneyError,
  validatePersistedTradeInvoiceMoney,
} from "./trade_invoice_money.ts";

Deno.test("trade invoice money: GST off splits gross earned into net pay and 12% super", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 1_000,
    gstOn: false,
    earningsDate: "2026-08-27",
  });

  assertEquals(money, {
    gst_on: false,
    super_rate: 0.12,
    gross_earned: 1_000,
    super_amount: 120,
    net_pay: 880,
    gst_amount: 0,
    trade_payable: 880,
    total_inc: 1_000,
  });
});

Deno.test("trade invoice money: GST on stays 10% of gross and never double-counts super", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 1_000,
    gstOn: true,
    earningsDate: "2026-08-27",
  });

  assertEquals(money.super_amount, 120);
  assertEquals(money.net_pay, 880);
  assertEquals(money.net_pay + money.super_amount, money.gross_earned);
  assertEquals(money.gst_amount, 100);
  assertEquals(money.trade_payable, 980);
  assertEquals(money.total_inc, 1_100);
});

Deno.test("trade invoice money: statutory rate is resolved by date and fails closed outside the owned schedule", () => {
  assertEquals(
    calculateTradeInvoiceMoney({
      grossEarned: 123.45,
      gstOn: false,
      earningsDate: "2025-07-01",
    }).super_amount,
    14.81,
  );

  assertThrows(
    () =>
      calculateTradeInvoiceMoney({
        grossEarned: 100,
        gstOn: false,
        earningsDate: "2025-06-30",
      }),
    TradeInvoiceMoneyError,
    "No statutory Superannuation Guarantee rate",
  );
});

Deno.test("trade invoice money: explicit per-invoice GST choice overrides the stored profile", () => {
  assertEquals(resolveTradeInvoiceGstOn({ gst_on: false }, true), false);
  assertEquals(resolveTradeInvoiceGstOn({ gst_registered: true }, false), true);
  assertEquals(resolveTradeInvoiceGstOn({ gst: false }, true), false);
  assertEquals(resolveTradeInvoiceGstOn({}, true), true);
});

Deno.test("trade invoice money: absent or malformed GST choice fails closed", () => {
  assertThrows(
    () => resolveTradeInvoiceGstOn({}, null),
    TradeInvoiceMoneyError,
    "GST choice is required",
  );
  assertThrows(
    () => resolveTradeInvoiceGstOn({ gst_on: "yes" }, false),
    TradeInvoiceMoneyError,
    "GST choice must be true or false",
  );
});

Deno.test("trade invoice Xero lines carry net earnings plus one worked-out super figure", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 1_000,
    gstOn: true,
    earningsDate: "2026-08-27",
  });
  const lines = splitTradeInvoiceXeroLines(
    [
      {
        Description: "SWF-1 | Labour | 6h @ $100/hr",
        Quantity: 6,
        UnitAmount: 100,
        AccountCode: "306",
        TaxType: "INPUT",
        Tracking: [{ Name: "Business Unit", Option: "SW - FENCING" }],
      },
      {
        Description: "SWF-2 | Labour | 4h @ $100/hr",
        Quantity: 4,
        UnitAmount: 100,
        AccountCode: "306",
        TaxType: "INPUT",
        Tracking: [{ Name: "Business Unit", Option: "SW - FENCING" }],
      },
    ],
    money,
    { superAccountCode: "306" },
  );

  assertEquals(lines.length, 3);
  assert(
    String(lines[0].Description).startsWith(
      "Net earnings after 12.00% super",
    ),
  );
  assert(
    String(lines[2].Description).startsWith(
      "Superannuation Guarantee (12.00%)",
    ),
  );
  assertEquals(lines[2].UnitAmount, 120);
  assertEquals(lines.every((line) => line.TaxType === "INPUT"), true);
  assertEquals(
    lines.reduce(
      (sum, line) => sum + Number(line.Quantity) * Number(line.UnitAmount),
      0,
    ),
    money.gross_earned,
  );
});

Deno.test("trade invoice Xero lines use NoTax when GST is off", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 123.45,
    gstOn: false,
    earningsDate: "2026-08-27",
  });
  const lines = splitTradeInvoiceXeroLines(
    [{
      Description: "Labour",
      Quantity: 3,
      UnitAmount: 41.15,
      AccountCode: "306",
      TaxType: "NONE",
    }],
    money,
    { superAccountCode: "306" },
  );

  assertEquals(lines.map((line) => line.TaxType), ["NONE", "NONE"]);
  assertEquals(lines[0].UnitAmount, 108.64);
  assertEquals(lines[1].UnitAmount, 14.81);
});

Deno.test("persisted money validation rejects legacy or partial rows before Xero", () => {
  assertThrows(
    () =>
      validatePersistedTradeInvoiceMoney({
        subtotal_ex: 1_000,
        gst: 100,
        total_inc: 1_100,
      }),
    TradeInvoiceMoneyError,
    "missing its super/GST split",
  );
});

Deno.test("persisted money validation rejects an unresolved or non-statutory rate before Xero", () => {
  const valid = {
    week_end: "2026-08-27",
    subtotal_ex: 1_000,
    gst: 100,
    gst_on: true,
    super_rate: 0.12,
    super_amount: 120,
    gross_earned: 1_000,
    net_pay: 880,
    total_inc: 1_100,
  };

  assertEquals(validatePersistedTradeInvoiceMoney(valid).super_rate, 0.12);
  assertThrows(
    () => validatePersistedTradeInvoiceMoney({ ...valid, super_rate: 0.11 }),
    TradeInvoiceMoneyError,
    "does not reconcile",
  );
  assertThrows(
    () =>
      validatePersistedTradeInvoiceMoney({
        ...valid,
        week_end: "2025-06-30",
      }),
    TradeInvoiceMoneyError,
    "No statutory Superannuation Guarantee rate",
  );
});
