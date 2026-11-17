// deno-lint-ignore-file no-import-prefix require-await

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertExistingTradeInvoiceXeroBill,
  assertReturnedTradeInvoiceXeroSplit,
  buildTradeInvoiceAuditModel,
  calculateTradeInvoiceMoney,
  checkpointAndAssertReturnedTradeInvoiceXeroSplit,
  normaliseXeroTaxType,
  presentTradeInvoiceMoney,
  resolvePersistedTradeInvoiceLineAmount,
  resolveTradeInvoiceGstOn,
  splitTradeInvoiceXeroLines,
  TRADE_INVOICE_COMPANY_CONTRIBUTION_RATE,
  TRADE_INVOICE_SUPER_RATE,
  TRADE_INVOICE_WORKER_WITHHOLD_RATE,
  TradeInvoiceMoneyError,
  validatePersistedTradeInvoiceMoney,
  assertTradeInvoiceSuperBaseMatchesLines,
  groupedMoneyLabel,
  isTradeInvoiceReimbursementLine,
  reimbursementLinesTotalEx,
  TRADE_INVOICE_INCLUSIVE_SUPER_BASIS,
  tradeInvoiceInclusiveSuper,
  type TradeInvoiceXeroLine,
} from "./trade_invoice_money.ts";
import { buildTradeInvoiceAuditText } from "./trade_invoice_pdf.ts";

Deno.test("captain 2026-09-18: $1000 gross keeps 12% super remittance and pays the boy $940", () => {
  assertEquals(
    TRADE_INVOICE_WORKER_WITHHOLD_RATE +
      TRADE_INVOICE_COMPANY_CONTRIBUTION_RATE,
    TRADE_INVOICE_SUPER_RATE,
  );
  const money = calculateTradeInvoiceMoney({
    grossEarned: 1_000,
    gstOn: false,
    earningsDate: "2026-09-18",
  });

  assertEquals(money, {
    gst_on: false,
    super_rate: 0.12,
    gross_earned: 1_000,
    super_amount: 120,
    worker_withhold: 60,
    company_contribution: 60,
    net_pay: 940,
    gst_amount: 0,
    trade_payable: 940,
    total_inc: 1_000,
    company_total_out: 1_060,
  });
});

Deno.test("trade invoice money: GST on stays 10% of gross; company cost and invoice face diverge", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 1_000,
    gstOn: true,
    earningsDate: "2026-08-27",
  });

  assertEquals(money.super_amount, 120);
  assertEquals(money.worker_withhold, 60);
  assertEquals(money.company_contribution, 60);
  assertEquals(money.net_pay, 940);
  assertEquals(
    money.worker_withhold + money.company_contribution,
    money.super_amount,
  );
  assertEquals(money.net_pay + money.super_amount, money.company_total_out);
  assertEquals(money.gst_amount, 100);
  assertEquals(money.trade_payable, 1_040);
  assertEquals(money.total_inc, 1_100);
  assertEquals(money.company_total_out, 1_060);
});

Deno.test("trade invoice money: GST is 10% of gross earned, never of net pay after super", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 2_208.20,
    gstOn: true,
    earningsDate: "2026-08-28",
  });
  // Audit 2026-09: a fixture that put GST on net pay would expect 194.32 here.
  assertEquals(money.gst_amount, 220.82);
  assertEquals(
    money.gst_amount === Math.round(money.net_pay * 0.1 * 100) / 100,
    false,
  );
  assertEquals(money.total_inc, 2_429.02);
  assertEquals(money.net_pay, 2_075.71);
  assertEquals(money.trade_payable, 2_296.53);
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
    String(lines[2].Description).includes(
      "Superannuation Guarantee 12.00% of submitted total",
    ),
    true,
  );
  assertEquals(
    String(lines[2].Description).includes("Amount payable $940.00"),
    true,
  );
  assertEquals(
    String(lines[2].Description).includes("Super remittance $120.00"),
    true,
  );
  assertEquals(
    String(lines[2].Description).includes("Worker withhold $60.00"),
    true,
  );
  assertEquals(
    String(lines[2].Description).includes("Paid to the super fund separately"),
    true,
  );
  assertEquals(lines[2].UnitAmount, -60);
  assertEquals(lines[2].TaxType, "NONE");
  assertEquals(
    lines.slice(0, 2).every((line) => line.TaxType === "INPUT"),
    true,
  );
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
  assertEquals(lines[2].UnitAmount, -288.80);
  assertEquals(
    Math.round(
      lines.reduce(
        (sum, line) => sum + Number(line.Quantity) * Number(line.UnitAmount),
        0,
      ) * 100,
    ) / 100,
    money.net_pay,
  );
  assertEquals(money.net_pay, 4_524.60);
  assertEquals(money.super_amount, 577.61);
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
  assertEquals(lines[1].UnitAmount, -7.41);
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
    net_pay: 940,
    total_inc: 1_100,
  };

  assertEquals(presentTradeInvoiceMoney(persisted).trade_payable, 1_040);
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
    net_pay: 940,
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
  assertEquals(money.worker_withhold, 132.49);
  assertEquals(money.net_pay, 2_075.71);
  assertEquals(lines[0].UnitAmount, 803.20);
  assertEquals(lines[1].UnitAmount, 1_405.00);
  assertEquals(lines[2].UnitAmount, -132.49);
  assertEquals(
    Math.round(
      lines.reduce(
        (sum, line) => sum + Number(line.Quantity) * Number(line.UnitAmount),
        0,
      ) * 100,
    ) / 100,
    2_075.71,
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
    String(lines[2].Description).includes("Amount payable $2075.71"),
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
  assertEquals(model.header.amount_payable, 2_075.71);
  assertEquals(
    Math.round(
      (model.header.submitted_total - money.worker_withhold) * 100,
    ) / 100,
    model.header.amount_payable,
  );
  assertEquals(model.super_line.kind, "super");
  assertEquals(model.super_line.unit_amount, -132.49);
});

// 2026-09-08: the shape Xero actually returns for a pushed trade bill (Hugo,
// SW-INV-H-260904-026): labour INPUT, super BASEXCLUDED (Xero's spelling of NONE).
Deno.test("returned split: Xero's BASEXCLUDED super line is accepted as NONE", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 2470,
    gstOn: true,
    earningsDate: "2026-09-04",
  });
  const returned = [
    {
      Description: "Hugo\nSWF-261281 | SW - FENCING\nLabour",
      Quantity: 1,
      UnitAmount: 710,
      TaxType: "INPUT",
    },
    {
      Description: "Hugo\nSWMS-261344 | SW - MAKESAFE\nMS and RR",
      Quantity: 44,
      UnitAmount: 40,
      TaxType: "INPUT",
    },
    {
      Description: "Superannuation Guarantee 12.00% of submitted total",
      Quantity: 1,
      UnitAmount: -148.2,
      TaxType: "BASEXCLUDED",
    },
  ];
  assertReturnedTradeInvoiceXeroSplit(returned, money);
  // GST off: labour comes back BASEXCLUDED too.
  const moneyOff = calculateTradeInvoiceMoney({
    grossEarned: 1000,
    gstOn: false,
    earningsDate: "2026-09-04",
  });
  assertReturnedTradeInvoiceXeroSplit([
    {
      Description: "Labour",
      Quantity: 1,
      UnitAmount: 1000,
      TaxType: "BASEXCLUDED",
    },
    {
      Description: "Superannuation Guarantee 12.00% of submitted total",
      Quantity: 1,
      UnitAmount: -60,
      TaxType: "BASEXCLUDED",
    },
  ], moneyOff);
  // A taxed super line is still wrong.
  assertThrows(() =>
    assertReturnedTradeInvoiceXeroSplit([
      {
        Description: "Labour",
        Quantity: 1,
        UnitAmount: 2470,
        TaxType: "INPUT",
      },
      {
        Description: "Superannuation Guarantee 12.00% of submitted total",
        Quantity: 1,
        UnitAmount: -148.2,
        TaxType: "INPUT",
      },
    ], money), TradeInvoiceMoneyError);
  assertEquals(normaliseXeroTaxType("basexcluded"), "NONE");
  assertEquals(normaliseXeroTaxType("INPUT"), "INPUT");
});

Deno.test("captain 2026-09-18: $1333.33 rounding still reconciles to the cent", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 1_333.33,
    gstOn: false,
    earningsDate: "2026-09-18",
  });
  assertEquals(money.super_amount, 160);
  assertEquals(money.worker_withhold, 80);
  assertEquals(money.company_contribution, 80);
  assertEquals(money.net_pay, 1_253.33);
  assertEquals(money.company_total_out, 1_413.33);
  assertEquals(
    money.worker_withhold + money.company_contribution,
    money.super_amount,
  );
  assertEquals(money.net_pay + money.super_amount, money.company_total_out);
  assertEquals(money.net_pay + money.worker_withhold, money.gross_earned);
});

Deno.test("validator accepts the new 6% withhold shape and the historical 12% carve-out, and rejects a tamper", () => {
  const current = {
    week_end: "2026-09-18",
    subtotal_ex: 1_000,
    gst: 0,
    gst_on: false,
    super_rate: 0.12,
    super_amount: 120,
    gross_earned: 1_000,
    net_pay: 940,
    total_inc: 1_000,
  };
  const accepted = validatePersistedTradeInvoiceMoney(current);
  assertEquals(accepted.net_pay, 940);
  assertEquals(accepted.worker_withhold, 60);
  assertEquals(accepted.company_contribution, 60);
  assertEquals(accepted.company_total_out, 1_060);

  const legacy = validatePersistedTradeInvoiceMoney({
    ...current,
    net_pay: 880,
  });
  assertEquals(legacy.net_pay, 880);
  assertEquals(legacy.worker_withhold, 120);
  assertEquals(legacy.company_contribution, 0);
  assertEquals(legacy.company_total_out, 1_000);

  assertThrows(
    () => validatePersistedTradeInvoiceMoney({ ...current, net_pay: 900 }),
    TradeInvoiceMoneyError,
    "does not reconcile",
  );
  assertThrows(
    () => validatePersistedTradeInvoiceMoney({ ...current, net_pay: 1_000 }),
    TradeInvoiceMoneyError,
    "does not reconcile",
  );
  assertThrows(
    () =>
      validatePersistedTradeInvoiceMoney({
        ...current,
        super_amount: 60,
        net_pay: 940,
      }),
    TradeInvoiceMoneyError,
    "does not reconcile",
  );
});

// ── One super rule (P1-01.2, .4): every amount includes super ───────────────
// The fund gets 12/112 of the total less reimbursements; the person the rest.
// Stand-in ZZTEST figures only.

const INCLUSIVE = TRADE_INVOICE_INCLUSIVE_SUPER_BASIS;

function inclusiveMoney(
  gross: number,
  opts: { reimbursementEx?: number; gstOn?: boolean; commissionEx?: number } = {},
) {
  return calculateTradeInvoiceMoney({
    grossEarned: gross,
    gstOn: opts.gstOn ?? false,
    earningsDate: "2026-12-13",
    superBasis: INCLUSIVE,
    commissionEx: opts.commissionEx,
    reimbursementEx: opts.reimbursementEx,
  });
}

/** Exact 12/112 of a cents amount, rounded half up, in cents (BigInt). */
function exactInclusiveSuperCents(baseCents: number): number {
  const num = BigInt(baseCents) * 12n;
  const q = num / 112n;
  const r = num % 112n;
  return Number(r * 2n >= 112n ? q + 1n : q);
}

Deno.test("inclusive super: spec test 1, total 1,120.00 gives super 120.00 and pays 1,000.00", () => {
  const m = inclusiveMoney(1120);
  assertEquals(
    [m.super_basis, m.super_amount, m.net_pay, m.gst_amount, m.trade_payable, m.total_inc],
    [INCLUSIVE, 120, 1000, 0, 1000, 1120],
  );
  assertEquals([m.worker_withhold, m.company_contribution, m.company_total_out], [120, 0, 1120]);
  assert(!("super_base_ex" in m));
});

Deno.test("inclusive super: spec tests 2 and 3, 1,000.00 and the 0.14 tie", () => {
  const a = inclusiveMoney(1000);
  assertEquals([a.super_amount, a.net_pay], [107.14, 892.86]);
  assertEquals(Math.round(a.net_pay * 0.12 * 100) / 100, a.super_amount);
  const b = inclusiveMoney(0.14);
  assertEquals([b.super_amount, b.net_pay], [0.02, 0.12]);
});

Deno.test("inclusive super: spec test 4, a reimbursement carries no super and no GST", () => {
  const m = inclusiveMoney(1200, { reimbursementEx: 80, gstOn: true, commissionEx: 448 });
  assertEquals(
    [m.super_base_ex, m.super_amount, m.net_pay, m.gst_amount, m.trade_payable, m.total_inc],
    [1120, 120, 1080, 112, 1192, 1312],
  );
  const off = inclusiveMoney(1200, { reimbursementEx: 80 });
  assertEquals([off.net_pay, off.trade_payable], [1080, 1080]);
});

Deno.test("inclusive super: spec test 5, a reimbursement-only invoice pays it all", () => {
  const m = inclusiveMoney(80, { reimbursementEx: 80 });
  assertEquals([m.super_base_ex, m.super_amount, m.net_pay, m.trade_payable], [0, 0, 80, 80]);
});

Deno.test("inclusive super: commission is in the base on the new rule", () => {
  const withCommission = inclusiveMoney(1120, { commissionEx: 448 });
  const without = inclusiveMoney(1120);
  assertEquals(withCommission, without);
});

Deno.test("inclusive super: spec test 6, 10 hours at 56.00 is 560.00, super 60.00, paid 500.00", () => {
  const m = inclusiveMoney(10 * 56);
  assertEquals([m.gross_earned, m.super_amount, m.net_pay], [560, 60, 500]);
});

Deno.test("inclusive super: every whole cent 0.01 to 300.00 matches the exact fraction and validates", () => {
  for (let cents = 1; cents <= 30000; cents++) {
    const amount = cents / 100;
    assertEquals(Math.round(tradeInvoiceInclusiveSuper(amount) * 100), exactInclusiveSuperCents(cents), `at ${amount}`);
    const m = inclusiveMoney(amount);
    const stored = {
      gst_on: m.gst_on,
      super_rate: m.super_rate,
      super_amount: m.super_amount,
      gross_earned: m.gross_earned,
      net_pay: m.net_pay,
      subtotal_ex: m.gross_earned,
      gst: m.gst_amount,
      total_inc: m.total_inc,
      super_basis: m.super_basis,
      week_end: "2026-12-13",
    };
    assertEquals(validatePersistedTradeInvoiceMoney(stored).net_pay, m.net_pay);
  }
});

Deno.test("inclusive super: only a reimbursement line is free of super", () => {
  assert(isTradeInvoiceReimbursementLine("reimbursement"));
  for (const t of ["labour", "travel", "commission", "group share", "work order", "materials", "other"]) {
    assert(!isTradeInvoiceReimbursementLine(t), t);
  }
  assertEquals(
    reimbursementLinesTotalEx([
      { line_type: "labour", line_total_ex: 560 },
      { line_type: "reimbursement", line_total_ex: 79.995 },
      { line_type: "Reimbursement", line_total_ex: 0.01 },
    ]),
    80.01,
  );
});

Deno.test("inclusive super: the old rule is unchanged", () => {
  const old = calculateTradeInvoiceMoney({ grossEarned: 1000, gstOn: true, earningsDate: "2026-11-29" });
  assertEquals([old.super_amount, old.net_pay, old.gst_amount, old.total_inc], [120, 940, 100, 1100]);
  assert(!("super_basis" in old));
});

Deno.test("inclusive super: a stored invoice validates, presents its figures, and its base must match its lines", () => {
  const stored = {
    gst_on: true,
    super_rate: 0.12,
    super_amount: 120,
    gross_earned: 1200,
    net_pay: 1080,
    super_basis: INCLUSIVE,
    super_base_ex: 1120,
    subtotal_ex: 1200,
    gst: 112,
    total_inc: 1312,
    week_end: "2026-12-13",
  };
  const money = validatePersistedTradeInvoiceMoney(stored);
  assertEquals([money.super_amount, money.trade_payable], [120, 1192]);
  const presented = presentTradeInvoiceMoney(stored);
  assertEquals(presented.super_inclusive, { total: 1200, paid_to_you: 1080, paid_to_super_fund: 120 });
  assertTradeInvoiceSuperBaseMatchesLines(money, 0, 80);
  assertThrows(() => assertTradeInvoiceSuperBaseMatchesLines(money, 0, 40));
  // GST on the whole gross is refused on the new rule.
  assertThrows(() => validatePersistedTradeInvoiceMoney({ ...stored, gst: 120, total_inc: 1320 }));
  // 12% of the total stamped inclusive is refused.
  assertThrows(() =>
    validatePersistedTradeInvoiceMoney({ ...stored, super_base_ex: null, gst_on: false, gst: 0, total_inc: 1200, super_amount: 144, net_pay: 1056 })
  );
});

const INCLUSIVE_LINES: TradeInvoiceXeroLine[] = [
  { Description: "ZZTEST labour", Quantity: 20, UnitAmount: 56, AccountCode: "310" } as TradeInvoiceXeroLine,
];

Deno.test("inclusive super: spec test 9, the Xero draft bill carries the three figures", () => {
  const m = inclusiveMoney(1120);
  const lines = splitTradeInvoiceXeroLines(INCLUSIVE_LINES, m, { superAccountCode: "478", tradeName: "ZZTEST Crew" });
  assertEquals(lines.length, 2);
  assertEquals([lines[0].Quantity, lines[0].UnitAmount, lines[0].TaxType], [20, 56, "NONE"]);
  const superLine = lines[1];
  assertEquals([superLine.UnitAmount, superLine.TaxType], [-120, "NONE"]);
  const text = String(superLine.Description);
  assert(text.startsWith("Superannuation Guarantee"), text);
  assertStringIncludes(text, "Total (includes super) $1,120.00");
  assertStringIncludes(text, "Paid to the super fund $120.00");
  assertStringIncludes(text, "$1,000.00");
  assert(!/company contribution/i.test(text), text);
  const total = lines.reduce((sum, l) => sum + Number(l.Quantity ?? 1) * Number(l.UnitAmount ?? 0), 0);
  assertEquals(Math.round(total * 100) / 100, 1000);
  const returned = lines.map((l) => ({
    ...l,
    LineAmount: Math.round(Number(l.Quantity ?? 1) * Number(l.UnitAmount ?? 0) * 100) / 100,
  }));
  assertReturnedTradeInvoiceXeroSplit(returned, m);

  const gst = splitTradeInvoiceXeroLines(INCLUSIVE_LINES, inclusiveMoney(1120, { gstOn: true }), { superAccountCode: "478" });
  assertEquals([gst[0].TaxType, gst[1].TaxType], ["INPUT", "NONE"]);
});

Deno.test("inclusive super: a GST trade's reimbursement is held back from Xero, never sent with GST on it", () => {
  const m = inclusiveMoney(1200, { reimbursementEx: 80, gstOn: true });
  const withReimbursement: TradeInvoiceXeroLine[] = [
    ...INCLUSIVE_LINES,
    { Description: "ZZTEST reimbursement", Quantity: 1, UnitAmount: 80, AccountCode: "310" } as TradeInvoiceXeroLine,
  ];
  assertThrows(
    () => splitTradeInvoiceXeroLines(withReimbursement, m, { superAccountCode: "478" }),
    TradeInvoiceMoneyError,
    "reimbursement",
  );
  // Without GST the bill goes, with the reimbursement named on the super line.
  const noGst = inclusiveMoney(1200, { reimbursementEx: 80 });
  const lines = splitTradeInvoiceXeroLines(withReimbursement, noGst, { superAccountCode: "478" });
  assertStringIncludes(String(lines.at(-1)?.Description), "Reimbursements $80.00 carry no super.");
  const total = lines.reduce((sum, l) => sum + Number(l.Quantity ?? 1) * Number(l.UnitAmount ?? 0), 0);
  assertEquals(Math.round(total * 100) / 100, 1080);
});

Deno.test("inclusive super: the audit PDF reads Total (includes super), Paid to your super fund, Paid to you", () => {
  const m = inclusiveMoney(1120);
  const text = buildTradeInvoiceAuditText(buildTradeInvoiceAuditModel(INCLUSIVE_LINES, m, "ZZTEST Crew"), {
    invoiceNumber: "ZZTEST-1",
    tradeName: "ZZTEST Crew",
  }).join("\n");
  const total = text.indexOf("Total (includes super) $1120.00");
  const fund = text.indexOf("Paid to your super fund $120.00");
  const you = text.indexOf("Paid to you $1000.00");
  assert(total >= 0 && fund > total && you > fund, text);
  assert(!/withheld/i.test(text), text);
});

Deno.test("inclusive super: job cost reads no company super on top", () => {
  // 20261030170000 trade_employer_super: super_amount - (subtotal_ex - net_pay).
  for (const [gross, reimbursement] of [[1120, 0], [1200, 80], [1000.02, 0], [57.5, 12.25]]) {
    const m = inclusiveMoney(gross, { reimbursementEx: reimbursement });
    assertEquals(Math.round((m.super_amount - (m.gross_earned - m.net_pay)) * 100) / 100, 0);
  }
});

Deno.test("inclusive super: money labels group thousands", () => {
  assertEquals(
    [groupedMoneyLabel(1120), groupedMoneyLabel(0.5), groupedMoneyLabel(1234567.891), groupedMoneyLabel(-80)],
    ["$1,120.00", "$0.50", "$1,234,567.89", "-$80.00"],
  );
});
