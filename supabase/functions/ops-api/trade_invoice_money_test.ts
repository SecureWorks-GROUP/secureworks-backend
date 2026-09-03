// deno-lint-ignore-file no-import-prefix require-await

import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertExistingTradeInvoiceXeroBill,
  assertReturnedTradeInvoiceXeroSplit,
  buildTradeInvoiceAuditModel,
  calculateTradeInvoiceMoney,
  checkpointAndAssertReturnedTradeInvoiceXeroSplit,
  presentTradeInvoiceMoney,
  resolvePersistedTradeInvoiceLineAmount,
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

Deno.test("trade invoice money: explicit per-invoice GST choice accepts supported fields", () => {
  assertEquals(resolveTradeInvoiceGstOn({ gst_on: false }), false);
  assertEquals(resolveTradeInvoiceGstOn({ gst_registered: true }), true);
  assertEquals(resolveTradeInvoiceGstOn({ gst: false }), false);
});

Deno.test("trade invoice money: absent or malformed GST choice fails closed", () => {
  assertThrows(
    () => resolveTradeInvoiceGstOn({}),
    TradeInvoiceMoneyError,
    "GST choice is required",
  );
  assertThrows(
    () => resolveTradeInvoiceGstOn({ gst_on: "yes" }),
    TradeInvoiceMoneyError,
    "GST choice must be true or false",
  );
});

Deno.test("trade invoice Xero lines keep labour at work amounts and withhold super as a minus", () => {
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
    { superAccountCode: "306", tradeName: "Israel" },
  );

  assertEquals(lines.length, 3);
  assertEquals(lines[0].Quantity, 6);
  assertEquals(lines[0].UnitAmount, 100);
  assertEquals(lines[1].Quantity, 4);
  assertEquals(lines[1].UnitAmount, 100);
  assertEquals(String(lines[0].Description).startsWith("Israel\n"), true);
  assertEquals(
    String(lines[0].Description).includes("Net earnings after"),
    false,
  );
  assertEquals(
    String(lines[2].Description).includes("Superannuation Guarantee 12.00% of submitted total"),
    true,
  );
  assertEquals(
    String(lines[2].Description).includes("Amount payable $880.00"),
    true,
  );
  assertEquals(
    String(lines[2].Description).includes("Paid to the super fund separately"),
    true,
  );
  assertEquals(lines[2].UnitAmount, -120);
  assertEquals(lines[2].TaxType, "NONE");
  assertEquals(lines.slice(0, 2).every((line) => line.TaxType === "INPUT"), true);
  assertEquals(
    lines.reduce(
      (sum, line) => sum + Number(line.Quantity) * Number(line.UnitAmount),
      0,
    ),
    money.net_pay,
  );
});

Deno.test("Xero split preserves a final deduction and withholds super so the bill total is OSCO pay", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 4_813.40,
    gstOn: false,
    earningsDate: "2026-08-27",
  });
  const lines = splitTradeInvoiceXeroLines(
    [
      {
        Description: "Invoice 31 job blocks",
        Quantity: 1,
        UnitAmount: 5_163.40,
        AccountCode: "306",
        TaxType: "NONE",
      },
      {
        Description: "Final deduction - Car Loan",
        Quantity: 1,
        UnitAmount: -350,
        AccountCode: "306",
        TaxType: "NONE",
      },
    ],
    money,
    { superAccountCode: "306", tradeName: "Henry" },
  );

  assertEquals(lines[0].UnitAmount, 5_163.40);
  assertEquals(lines[1].UnitAmount, -350);
  assertEquals(lines[2].UnitAmount, -577.61);
  assertEquals(
    lines.reduce(
      (sum, line) => sum + Number(line.Quantity) * Number(line.UnitAmount),
      0,
    ),
    money.net_pay,
  );
  assertEquals(money.net_pay, 4_235.79);
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
  assertEquals(lines[0].UnitAmount, 41.15);
  assertEquals(lines[0].Quantity, 3);
  assertEquals(lines[1].UnitAmount, -14.81);
});

Deno.test("returned Xero bill must preserve the worked-out super split", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 1_000,
    gstOn: true,
    earningsDate: "2026-08-27",
  });
  const splitLines = splitTradeInvoiceXeroLines(
    [{
      Description: "Labour",
      Quantity: 10,
      UnitAmount: 100,
      AccountCode: "306",
      TaxType: "INPUT",
    }],
    money,
    { superAccountCode: "306" },
  );

  assertReturnedTradeInvoiceXeroSplit(splitLines, money);
  assertThrows(
    () =>
      assertReturnedTradeInvoiceXeroSplit(
        [{
          Description: "Labour",
          Quantity: 10,
          UnitAmount: 100,
          AccountCode: "306",
          TaxType: "INPUT",
        }],
        money,
      ),
    TradeInvoiceMoneyError,
    "labour at the work amounts and super withheld as a minus",
  );
});

Deno.test("returned Xero identity is checkpointed before a gross-only bill is refused", async () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 1_000,
    gstOn: false,
    earningsDate: "2026-08-27",
  });
  const checkpoints: unknown[] = [];

  await assertRejects(
    () =>
      checkpointAndAssertReturnedTradeInvoiceXeroSplit({
        bill: {
          InvoiceID: "xero-bill-1",
          InvoiceNumber: "BILL-1",
          LineItems: [{
            Description: "Gross-only labour",
            Quantity: 10,
            UnitAmount: 100,
            TaxType: "NONE",
          }],
        },
        money,
        checkpointIdentity: async (identity) => {
          checkpoints.push(identity);
        },
      }),
    TradeInvoiceMoneyError,
    "labour at the work amounts and super withheld as a minus",
  );

  assertEquals(checkpoints, [{
    xeroBillId: "xero-bill-1",
    xeroBillNumber: "BILL-1",
  }]);
});

Deno.test("checkpointed Xero retry accepts only the exact reconciled bill", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 1_000,
    gstOn: false,
    earningsDate: "2026-08-27",
  });
  const lines = splitTradeInvoiceXeroLines(
    [{
      Description: "Labour",
      Quantity: 10,
      UnitAmount: 100,
      AccountCode: "306",
      TaxType: "NONE",
    }],
    money,
    { superAccountCode: "306" },
  );
  assertEquals(
    assertExistingTradeInvoiceXeroBill(
      {
        InvoiceID: "bill-1",
        InvoiceNumber: "BILL-1",
        LineItems: lines,
      },
      "bill-1",
      money,
    ),
    { xeroBillId: "bill-1", xeroBillNumber: "BILL-1" },
  );
  assertThrows(
    () =>
      assertExistingTradeInvoiceXeroBill(
        {
          InvoiceID: "bill-2",
          InvoiceNumber: "BILL-2",
          LineItems: lines,
        },
        "bill-1",
        money,
      ),
    TradeInvoiceMoneyError,
    "exact checkpointed trade bill",
  );
});

Deno.test("retry line recovery validates stored shapes and falls back to line_total_ex without inventing hours", () => {
  assertEquals(
    resolvePersistedTradeInvoiceLineAmount({
      total_hours: 0,
      hourly_rate: 0,
      quantity: null,
      unit_rate: null,
      line_total_ex: 275,
    }),
    {
      quantity: 1,
      unitAmount: 275,
      lineTotalEx: 275,
      basis: "line_total_ex",
    },
  );
  assertEquals(
    resolvePersistedTradeInvoiceLineAmount({
      total_hours: 0,
      hourly_rate: 0,
      quantity: 5,
      unit_rate: 55,
      line_total_ex: 275,
    }).basis,
    "quantity_rate",
  );
  assertThrows(
    () =>
      resolvePersistedTradeInvoiceLineAmount({
        total_hours: 5,
        hourly_rate: 55,
        line_total_ex: 300,
      }),
    TradeInvoiceMoneyError,
    "do not match line_total_ex",
  );
});

Deno.test("retry line recovery rejects absent and empty line_total_ex before numeric coercion", () => {
  for (const lineTotalEx of [null, undefined, "", "   ", false]) {
    assertThrows(
      () =>
        resolvePersistedTradeInvoiceLineAmount({
          total_hours: 0,
          hourly_rate: 0,
          quantity: null,
          unit_rate: null,
          line_total_ex: lineTotalEx,
        }),
      TradeInvoiceMoneyError,
      "missing a validated line_total_ex",
    );
  }
});

Deno.test("invoice presenter publishes server cash payable and leaves legacy history visibly unresolved", () => {
  const persisted = {
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

  assertEquals(presentTradeInvoiceMoney(persisted).trade_payable, 980);
  assertEquals(
    presentTradeInvoiceMoney({
      week_end: "2025-06-30",
      subtotal_ex: 500,
      gst: 0,
      total_inc: 500,
    }).trade_payable,
    null,
  );
  assertThrows(
    () => presentTradeInvoiceMoney({ ...persisted, super_amount: null }),
    TradeInvoiceMoneyError,
    "missing its super/GST split",
  );
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

Deno.test("Israel-style work-order nets keep labour at work amounts; super is minus 12% of gross", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 2_208.20,
    gstOn: false,
    earningsDate: "2026-08-28",
  });
  const lines = splitTradeInvoiceXeroLines(
    [
      {
        Description:
          "SWF-261132 Matthew Dunne\nWork order $1058.20. Less labour: Ayden 8.5h x $30 = $255.00.",
        Quantity: 1,
        UnitAmount: 803.20,
        AccountCode: "306",
        TaxType: "NONE",
      },
      {
        Description:
          "SWF-26824 Hannah Crugnale\nWork order $2830.00. Less labour deducted $1,425.00.",
        Quantity: 1,
        UnitAmount: 1_405.00,
        AccountCode: "306",
        TaxType: "NONE",
      },
    ],
    money,
    { superAccountCode: "306", tradeName: "Israel" },
  );

  assertEquals(money.super_amount, 264.98);
  assertEquals(money.net_pay, 1_943.22);
  assertEquals(lines[0].UnitAmount, 803.20);
  assertEquals(lines[1].UnitAmount, 1_405.00);
  assertEquals(lines[2].UnitAmount, -264.98);
  assertEquals(
    Math.round(
      lines.reduce(
        (sum, line) => sum + Number(line.Quantity) * Number(line.UnitAmount),
        0,
      ) * 100,
    ) / 100,
    1_943.22,
  );
  assertEquals(String(lines[0].Description).startsWith("Israel\n"), true);
  assertEquals(
    String(lines[0].Description).includes("POSSIBLE DUPLICATE"),
    false,
  );
  assertEquals(
    String(lines[0].Description).includes("Net earnings after"),
    false,
  );
  assertEquals(
    String(lines[2].Description).includes("of submitted total"),
    true,
  );
  assertEquals(
    String(lines[2].Description).includes("Amount payable $1943.22"),
    true,
  );
});

Deno.test("audit model does not shrink labour per line; super is 12% of submitted total once", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 2_208.20,
    gstOn: false,
    earningsDate: "2026-08-28",
  });
  const submitted = [
    { Description: "SWF-261132", Quantity: 1, UnitAmount: 803.20 },
    { Description: "SWF-26824", Quantity: 1, UnitAmount: 1_405.00 },
  ];
  const model = buildTradeInvoiceAuditModel(submitted, money, "Isaac Belcher");
  assertEquals(model.submitted_lines[0].unit_amount, 803.20);
  assertEquals(model.submitted_lines[1].unit_amount, 1_405.00);
  assertEquals(model.submitted_lines[0].unit_amount === 706.82, false);
  assertEquals(model.header.submitted_total, 2_208.20);
  assertEquals(model.header.super_amount, 264.98);
  assertEquals(model.header.amount_payable, 1_943.22);
  assertEquals(
    Math.round(
      (model.header.submitted_total - model.header.super_amount) * 100,
    ) / 100,
    model.header.amount_payable,
  );
  assertEquals(model.super_line.kind, "super");
  assertEquals(model.super_line.unit_amount, -264.98);
});
