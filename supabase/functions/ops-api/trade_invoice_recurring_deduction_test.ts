/**
 * Trade recurring deductions (owner, 13 Oct 2026): a weekly ute hire amount
 * comes off one trade's weekly invoice. $100 for the invoice week starting
 * Monday 12 Oct 2026, $200 for every invoice week from Monday 19 Oct 2026.
 *
 * Covers the contract in docs/trade-recurring-deductions-2026-10-13.md:
 *   1. the rule: this week 100, next week 200, an earlier week none, a row
 *      switched off or ended none, another trade none, two rows covering one
 *      week none and marked for the office;
 *   2. once per invoice week: a second invoice carries none, a resubmit or
 *      redraft does not double;
 *   3. never a negative invoice: a payable below the deduction takes nothing,
 *      refuses nothing and is marked for the office; an invoice with nothing
 *      payable yet is not marked; a submitted invoice with no week, and a
 *      work-order invoice, take nothing and are marked;
 *   4. the money: the amount paid drops by exactly the deduction with GST on
 *      or off, and gross, super and GST do not move;
 *   5. the Xero bill: its own labelled minus line, and the returned bill is
 *      checked against it;
 *   6. every read shows it, and an invoice with none reads as it always did;
 *   7. the write paths, through the REAL request handler against a
 *      PostgREST-shaped fetch stub: generate_trade_invoice,
 *      save_trade_invoice_draft, submit_trade_invoice and my_hours. A path
 *      that stops calling the rule fails here, not just a helper.
 */
// deno-lint-ignore-file no-explicit-any no-import-prefix
import "./trade_app_visibility_rules_test_env.ts";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _opsApiRequestHandlerForTest } from "./index.ts";
import {
  assertReturnedTradeInvoiceXeroSplit,
  calculateTradeInvoiceMoney,
  isTradeInvoiceRecurringDeductionXeroLine,
  isTradeInvoiceSuperXeroLine,
  presentTradeInvoiceMoney,
  splitTradeInvoiceXeroLines,
  TradeInvoiceMoneyError,
  tradeInvoiceXeroBillSubtotal,
  validatePersistedTradeInvoiceMoney,
  withTradeInvoiceRecurringDeduction,
} from "./trade_invoice_money.ts";
import {
  decideTradeRecurringDeduction,
  loadTradeRecurringDeductionDecision,
  tradeRecurringDeductionInvoiceFields,
  tradeRecurringDeductionResponse,
  tradeRecurringDeductionRulesCovering,
  withTradeRecurringDeductionOfficeNote,
} from "./trade_invoice_recurring_deduction.ts";
import { renderTradeInvoiceAuditPdf } from "./trade_invoice_pdf.ts";
import { tradeMoneyRow } from "./trade_money.ts";

const UTE_TRADE = "0a1e0000-0000-4000-8000-00000000aa01";
const OTHER_TRADE = "0a1e0000-0000-4000-8000-00000000aa02";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const RULE_100 = "0a1e0000-0000-4000-8000-00000000f100";
const RULE_200 = "0a1e0000-0000-4000-8000-00000000f200";
const JOB_A = "0a1e0000-0000-4000-8000-00000000b001";
const CARD_A = "0a1e0000-0000-4000-8000-00000000c001";
const NEW_INVOICE = "0a1e0000-0000-4000-8000-00000000d001";

const THIS_WEEK = "2026-10-12"; // Monday 12 Oct 2026
const NEXT_WEEK = "2026-10-19"; // Monday 19 Oct 2026
const EARLIER_WEEK = "2026-10-05";

// The two rows the migration seeds for the one trade.
const RULES = [
  {
    id: RULE_100,
    user_id: UTE_TRADE,
    label: "Ute hire",
    amount: 100,
    first_week_start: THIS_WEEK,
    last_week_start: THIS_WEEK,
    active: true,
  },
  {
    id: RULE_200,
    user_id: UTE_TRADE,
    label: "Ute hire",
    amount: 200,
    first_week_start: NEXT_WEEK,
    last_week_start: null,
    active: true,
  },
];

const decide = (over: Record<string, unknown> = {}) =>
  decideTradeRecurringDeduction({
    rules: RULES,
    userId: UTE_TRADE,
    weekStart: THIS_WEEK,
    payable: 1000,
    ...over,
  });

// ── 1. The rule ─────────────────────────────────────────────────────────────

Deno.test("ute hire: this week (Monday 12 Oct 2026) is $100", () => {
  const decision = decide();
  assertEquals(decision.outcome, "applied");
  assertEquals(decision.applied, {
    id: RULE_100,
    label: "Ute hire",
    amount: 100,
  });
  assertEquals(decision.note, null);
});

Deno.test("ute hire: every week from Monday 19 Oct 2026 is $200", () => {
  for (const weekStart of [NEXT_WEEK, "2026-10-26", "2027-03-01"]) {
    const decision = decide({ weekStart });
    assertEquals(decision.outcome, "applied", weekStart);
    assertEquals(decision.applied, {
      id: RULE_200,
      label: "Ute hire",
      amount: 200,
    });
  }
});

Deno.test("ute hire: an invoice for an earlier week, or with no week, carries none", () => {
  for (const weekStart of [EARLIER_WEEK, "2026-01-05", null, undefined, ""]) {
    const decision = decide({ weekStart });
    assertEquals(decision.outcome, "none", String(weekStart));
    assertEquals(decision.applied, null);
    assertEquals(decision.rule, null);
    assertEquals(tradeRecurringDeductionInvoiceFields(decision), {});
    assertEquals(tradeRecurringDeductionResponse(decision), {});
  }
});

Deno.test("ute hire: a row switched off takes nothing from then on", () => {
  const off = RULES.map((row) =>
    row.id === RULE_200 ? { ...row, active: false } : row
  );
  assertEquals(decide({ rules: off, weekStart: NEXT_WEEK }).outcome, "none");
  // the other row still stands for its own week
  assertEquals(decide({ rules: off }).applied?.amount, 100);
  // both off: nothing, anywhere
  const allOff = RULES.map((row) => ({ ...row, active: false }));
  for (const weekStart of [THIS_WEEK, NEXT_WEEK]) {
    assertEquals(decide({ rules: allOff, weekStart }).outcome, "none");
  }
  // only an explicit true is on
  const vague = RULES.map((row) => ({ ...row, active: "true" }));
  assertEquals(decide({ rules: vague }).outcome, "none");
});

Deno.test("ute hire: a last week ends it, and the amount changes by ending one row and starting the next", () => {
  const ended = RULES.map((row) =>
    row.id === RULE_200 ? { ...row, last_week_start: "2026-11-30" } : row
  );
  assertEquals(
    decide({ rules: ended, weekStart: "2026-11-30" }).applied?.amount,
    200,
  );
  assertEquals(
    decide({ rules: ended, weekStart: "2026-12-07" }).outcome,
    "none",
  );
  // the office ends the row and adds one from the week the amount changes
  const changed = [...ended, {
    id: "0a1e0000-0000-4000-8000-00000000f250",
    user_id: UTE_TRADE,
    label: "Ute hire",
    amount: 250,
    first_week_start: "2026-12-07",
    last_week_start: null,
    active: true,
  }];
  assertEquals(
    decide({ rules: changed, weekStart: "2026-11-30" }).applied?.amount,
    200,
  );
  assertEquals(
    decide({ rules: changed, weekStart: "2026-12-07" }).applied?.amount,
    250,
  );
});

Deno.test("ute hire: two active rows covering one week take none and mark the invoice for the office", () => {
  // The $200 row was never ended, and a $250 row was added over it.
  const overlapping = [...RULES, {
    id: "0a1e0000-0000-4000-8000-00000000f250",
    user_id: UTE_TRADE,
    label: "Ute hire",
    amount: 250,
    first_week_start: "2026-12-07",
    last_week_start: null,
    active: true,
  }];
  const decision = decide({ rules: overlapping, weekStart: "2026-12-07" });
  assertEquals(decision.outcome, "rules_overlap");
  assertEquals(decision.applied, null);
  assertEquals(decision.rule, null);
  assertStringIncludes(decision.note || "", "NOT taken");
  assertStringIncludes(decision.note || "", "week starting 2026-12-07");
  assertStringIncludes(decision.note || "", "2 active deductions");
  assertStringIncludes(decision.note || "", "Ute hire $200.00");
  assertStringIncludes(decision.note || "", "Ute hire $250.00");
  assertEquals(tradeRecurringDeductionInvoiceFields(decision), {
    recurring_deduction_id: null,
    recurring_deduction_label: null,
    recurring_deduction_amount: null,
    recurring_deduction_note: decision.note,
  });
  // nothing comes off the money
  const money = calculateTradeInvoiceMoney({
    grossEarned: 1000,
    gstOn: false,
    earningsDate: "2026-12-13",
  });
  assertEquals(
    withTradeInvoiceRecurringDeduction(money, decision.applied),
    money,
  );
  // a week only one of them covers is unaffected
  assertEquals(
    decide({ rules: overlapping, weekStart: "2026-11-30" }).applied?.amount,
    200,
  );
  // the two seeded rows never overlap
  for (const weekStart of [THIS_WEEK, NEXT_WEEK]) {
    assertEquals(
      tradeRecurringDeductionRulesCovering(RULES, UTE_TRADE, weekStart).length,
      1,
    );
  }
});

Deno.test("ute hire: a row that cannot be read as a rule is never guessed at", () => {
  for (
    const bad of [
      { amount: 0 },
      { amount: -100 },
      { amount: "abc" },
      { label: "  " },
      { first_week_start: "soon" },
      { last_week_start: "later" },
      { id: "" },
    ]
  ) {
    const rules = [{ ...RULES[0], ...bad }];
    assertEquals(
      tradeRecurringDeductionRulesCovering(rules, UTE_TRADE, THIS_WEEK),
      [],
      JSON.stringify(bad),
    );
    assertEquals(decide({ rules }).outcome, "none", JSON.stringify(bad));
  }
  assertEquals(
    tradeRecurringDeductionRulesCovering("not rows", UTE_TRADE, THIS_WEEK),
    [],
  );
});

Deno.test("ute hire: another trade carries none, in any week", () => {
  for (const weekStart of [THIS_WEEK, NEXT_WEEK]) {
    const decision = decide({ userId: OTHER_TRADE, weekStart });
    assertEquals(decision.outcome, "none");
    assertEquals(tradeRecurringDeductionInvoiceFields(decision), {});
  }
});

// ── 2. Once per invoice week ────────────────────────────────────────────────

Deno.test("ute hire: a second invoice in the same week carries none", () => {
  for (
    const status of [
      "pending_acknowledgment",
      "approved",
      "pushed_to_xero",
      "paid",
    ]
  ) {
    const decision = decide({
      carriers: [{
        id: "first-invoice",
        status,
        invoice_number: "SW-INV-IB-261016-001",
      }],
    });
    assertEquals(decision.outcome, "already_taken", status);
    assertEquals(decision.applied, null);
    assertStringIncludes(decision.note || "", "SW-INV-IB-261016-001");
    assertStringIncludes(decision.note || "", "Ute hire $100.00");
    assertEquals(tradeRecurringDeductionInvoiceFields(decision), {
      recurring_deduction_id: null,
      recurring_deduction_label: null,
      recurring_deduction_amount: null,
      recurring_deduction_note: decision.note,
    });
  }
});

Deno.test("ute hire: a redraft or resubmit of the same invoice does not double it", () => {
  // The draft being replaced, and an invoice ops rejected, are released: the
  // invoice that replaces them carries the deduction, once.
  for (const status of ["draft", "ops-reject", "failed"]) {
    const decision = decide({
      carriers: [{ id: "earlier-copy", status, invoice_number: null }],
    });
    assertEquals(decision.outcome, "applied", status);
    assertEquals(decision.applied?.amount, 100);
  }
});

// ── 3. Never a negative invoice ─────────────────────────────────────────────

Deno.test("ute hire: a payable below the deduction takes nothing and is marked for the office", () => {
  for (const payable of [99.99, 47, 0.01]) {
    const decision = decide({ payable });
    assertEquals(decision.outcome, "payable_below_deduction", String(payable));
    assertEquals(decision.applied, null);
    assertStringIncludes(decision.note || "", "Ute hire $100.00 NOT taken");
    assertStringIncludes(decision.note || "", `$${payable.toFixed(2)}`);
    assertStringIncludes(decision.note || "", "week starting 2026-10-12");
    // nothing is taken off the money
    const money = calculateTradeInvoiceMoney({
      grossEarned: 50,
      gstOn: false,
      earningsDate: "2026-10-18",
    });
    assertEquals(
      withTradeInvoiceRecurringDeduction(money, decision.applied),
      money,
    );
  }
  // exactly covered: taken, and the invoice pays nothing, never less
  const exact = decide({ payable: 100 });
  assertEquals(exact.outcome, "applied");
  // a payable that is not a number is never treated as enough
  assertEquals(
    decide({ payable: "lots" }).outcome,
    "payable_below_deduction",
  );
});

Deno.test("ute hire: an invoice with nothing payable yet shows the week's deduction and carries no note", () => {
  // an empty my_hours preview, or a draft with nothing on it
  const empty = decide({ payable: 0 });
  assertEquals(empty.outcome, "nothing_payable");
  assertEquals(empty.applied, null);
  assertEquals(empty.note, null);
  assertEquals(tradeRecurringDeductionInvoiceFields(empty), {
    recurring_deduction_id: null,
    recurring_deduction_label: null,
    recurring_deduction_amount: null,
    recurring_deduction_note: null,
  });
  // the trade still sees what comes off at submit
  assertEquals(tradeRecurringDeductionResponse(empty), {
    recurring_deduction_week: {
      label: "Ute hire",
      amount: 100,
      week_start: THIS_WEEK,
      applied: false,
      outcome: "nothing_payable",
      note: null,
    },
  });
  // already on another invoice: an empty one still says so
  assertEquals(
    decide({
      payable: 0,
      carriers: [{ id: "first-invoice", status: "approved" }],
    }).outcome,
    "already_taken",
  );
});

// ── 3b. An invoice with no invoice week ─────────────────────────────────────

Deno.test("ute hire: a submitted invoice with no week, or a work-order invoice, takes nothing and is marked for the office", () => {
  for (
    const [kind, words] of [
      ["no_invoice_week", "this invoice has no invoice week"],
      ["work_order_invoice", "this is a work-order invoice"],
    ] as const
  ) {
    // Thursday 15 Oct 2026 is in the week of Monday 12 Oct: the $100 week
    const decision = decide({
      weekStart: null,
      weekless: { kind, day: "2026-10-15" },
    });
    assertEquals(decision.outcome, kind);
    assertEquals(decision.applied, null);
    assertEquals(decision.rule, null);
    assertStringIncludes(decision.note || "", "Ute hire $100.00 NOT applied");
    assertStringIncludes(decision.note || "", words);
    assertStringIncludes(decision.note || "", "week starting 2026-10-12");
    // stored as a note only: no deduction columns, so no money moves
    assertEquals(tradeRecurringDeductionInvoiceFields(decision), {
      recurring_deduction_id: null,
      recurring_deduction_label: null,
      recurring_deduction_amount: null,
      recurring_deduction_note: decision.note,
    });
    // and the response of those routes is what it was
    assertEquals(tradeRecurringDeductionResponse(decision), {});

    // Sunday 25 Oct 2026 is still the week of Monday 19 Oct: the $200 week
    assertStringIncludes(
      decide({ weekStart: null, weekless: { kind, day: "2026-10-25" } }).note ||
        "",
      "Ute hire $200.00 NOT applied",
    );
    // a week before the deduction starts, a trade with no row, a row switched
    // off, and a day that cannot be read: nothing at all
    for (
      const none of [
        decide({ weekStart: null, weekless: { kind, day: "2026-10-11" } }),
        decide({
          weekStart: null,
          userId: OTHER_TRADE,
          weekless: { kind, day: "2026-10-15" },
        }),
        decide({
          weekStart: null,
          rules: RULES.map((row) => ({ ...row, active: false })),
          weekless: { kind, day: "2026-10-15" },
        }),
        decide({ weekStart: null, weekless: { kind, day: "soon" } }),
      ]
    ) {
      assertEquals(none.outcome, "none");
      assertEquals(tradeRecurringDeductionInvoiceFields(none), {});
    }
    // an invoice that has a week is decided by its week, never as weekless
    assertEquals(
      decide({ weekless: { kind, day: "2026-10-25" } }).applied?.amount,
      100,
    );
  }
});

Deno.test("ute hire: the money module refuses a deduction above the payable rather than go negative", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 50,
    gstOn: false,
    earningsDate: "2026-10-18",
  });
  const error = assertThrows(
    () =>
      withTradeInvoiceRecurringDeduction(money, {
        id: RULE_100,
        label: "Ute hire",
        amount: 100,
      }),
    TradeInvoiceMoneyError,
  );
  assertEquals(error.code, "RECURRING_DEDUCTION_INVALID");
  for (const bad of [{ amount: 0 }, { amount: -5 }, { label: " " }]) {
    assertThrows(
      () =>
        withTradeInvoiceRecurringDeduction(money, {
          id: RULE_100,
          label: "Ute hire",
          amount: 10,
          ...bad,
        }),
      TradeInvoiceMoneyError,
    );
  }
});

// ── 4. The money ────────────────────────────────────────────────────────────

Deno.test("ute hire: the amount paid drops by exactly the deduction, GST on or off", () => {
  for (const gstOn of [false, true]) {
    for (const [amount, gross] of [[100, 2208.2], [200, 1000], [200, 333.33]]) {
      const before = calculateTradeInvoiceMoney({
        grossEarned: gross,
        gstOn,
        earningsDate: "2026-10-18",
      });
      const after = withTradeInvoiceRecurringDeduction(before, {
        id: RULE_100,
        label: "Ute hire",
        amount,
      });
      assertEquals(
        Math.round((before.trade_payable - after.trade_payable) * 100),
        amount * 100,
      );
      // nothing else moves: the lines, super and GST are what they were
      const { trade_payable: _a, recurring_deduction: carried, ...restAfter } =
        after;
      const { trade_payable: _b, ...restBefore } = before;
      assertEquals(restAfter, restBefore);
      assertEquals(carried, { id: RULE_100, label: "Ute hire", amount });
      assertEquals(
        tradeInvoiceXeroBillSubtotal(after),
        Math.round((before.net_pay - amount) * 100) / 100,
      );
    }
  }
});

// ── 5. The Xero bill ────────────────────────────────────────────────────────

const WORK_LINES = [{
  Description: "SWP-26001 | SW - PATIOS\nLabour - 20h @ $50/hr",
  Quantity: 20,
  UnitAmount: 50,
  AccountCode: "306",
  TaxType: "INPUT",
  Tracking: [],
}];

Deno.test("ute hire: it is its own labelled minus line on the Xero bill", () => {
  for (const gstOn of [false, true]) {
    const money = withTradeInvoiceRecurringDeduction(
      calculateTradeInvoiceMoney({
        grossEarned: 1000,
        gstOn,
        earningsDate: "2026-10-18",
      }),
      { id: RULE_100, label: "Ute hire", amount: 100 },
    );
    // the super line's account is its own; the deduction's is the bill's
    const lines = splitTradeInvoiceXeroLines(WORK_LINES, money, {
      superAccountCode: "826",
      tradeName: "Isaac",
    });
    assertEquals(lines.length, 3);
    const hire = lines[2];
    assertEquals(
      String(hire.Description).split("\n")[0],
      "Weekly deduction - Ute hire",
    );
    assertStringIncludes(String(hire.Description), "$100.00");
    assertEquals(
      [hire.Quantity, hire.UnitAmount, hire.TaxType, hire.AccountCode],
      [1, -100, "NONE", "306"],
    );
    assert(isTradeInvoiceRecurringDeductionXeroLine(hire));
    assert(!isTradeInvoiceSuperXeroLine(hire));
    // the work line and the super line are exactly what they are without it
    const without = splitTradeInvoiceXeroLines(
      WORK_LINES,
      withTradeInvoiceRecurringDeduction(money, null),
      { superAccountCode: "826", tradeName: "Isaac" },
    );
    assertEquals(lines.slice(0, 2), without);
    // the bill's lines sum to what is paid, before GST
    const billEx = lines.reduce(
      (sum, line) => sum + Number(line.Quantity) * Number(line.UnitAmount),
      0,
    );
    assertEquals(Math.round(billEx * 100) / 100, 840); // 1000 - 60 super - 100
    assertEquals(money.trade_payable, gstOn ? 940 : 840); // + $100 GST when on

    // what Xero returns is checked against it (NONE comes back BASEXCLUDED)
    const returned = lines.map((line) => ({
      ...line,
      TaxType: line.TaxType === "NONE" ? "BASEXCLUDED" : line.TaxType,
    }));
    if (gstOn) assertReturnedTradeInvoiceXeroSplit(returned, money);
    // a bill missing the line, or with the wrong amount, is refused
    assertThrows(
      () => assertReturnedTradeInvoiceXeroSplit(returned.slice(0, 2), money),
      TradeInvoiceMoneyError,
    );
    assertThrows(
      () =>
        assertReturnedTradeInvoiceXeroSplit(
          returned.map((line, index) =>
            index === 2 ? { ...line, UnitAmount: -200 } : line
          ),
          money,
        ),
      TradeInvoiceMoneyError,
    );
    // a bill carrying the line for an invoice that has no deduction is refused
    assertThrows(
      () =>
        assertReturnedTradeInvoiceXeroSplit(
          returned,
          withTradeInvoiceRecurringDeduction(money, null),
        ),
      TradeInvoiceMoneyError,
    );
  }
});

Deno.test("ute hire: a GST-off bill round-trips, and a line with no account is refused", () => {
  const money = withTradeInvoiceRecurringDeduction(
    calculateTradeInvoiceMoney({
      grossEarned: 1000,
      gstOn: false,
      earningsDate: "2026-10-18",
    }),
    { id: RULE_100, label: "Ute hire", amount: 100 },
  );
  const work = WORK_LINES.map((line) => ({ ...line, TaxType: "NONE" }));
  const lines = splitTradeInvoiceXeroLines(work, money, {
    superAccountCode: "306",
    tradeName: "Isaac",
  });
  assertReturnedTradeInvoiceXeroSplit(lines, money);
  // the bill's work lines name no account: the deduction line has none to use
  const error = assertThrows(
    () =>
      splitTradeInvoiceXeroLines(
        work.map(({ AccountCode: _account, ...line }) => line),
        money,
        { superAccountCode: "306", tradeName: "Isaac" },
      ),
    TradeInvoiceMoneyError,
  );
  assertEquals(error.code, "RECURRING_DEDUCTION_INVALID");
});

Deno.test("ute hire: a trade's own 'ute hire' wording on a work line is not the deduction", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 1000,
    gstOn: false,
    earningsDate: "2026-10-18",
  });
  const lines = splitTradeInvoiceXeroLines(
    [{
      ...WORK_LINES[0],
      Description: "Weekly deduction - ute hire for the job",
      TaxType: "NONE",
    }],
    money,
    { superAccountCode: "306", tradeName: "Isaac" },
  );
  // a work line always starts with the trade's name
  assertEquals(String(lines[0].Description).split("\n")[0], "Isaac");
  assert(!isTradeInvoiceRecurringDeductionXeroLine(lines[0]));
  assertReturnedTradeInvoiceXeroSplit(lines, money);
});

Deno.test("ute hire: the audit PDF on the bill shows the line and the cash paid", () => {
  const money = withTradeInvoiceRecurringDeduction(
    calculateTradeInvoiceMoney({
      grossEarned: 1000,
      gstOn: true,
      earningsDate: "2026-10-18",
    }),
    { id: RULE_100, label: "Ute hire", amount: 100 },
  );
  const text = renderTradeInvoiceAuditPdf({
    submittedLines: WORK_LINES,
    money,
    tradeName: "Isaac",
    invoiceNumber: "SW-INV-IB-261016-001",
  }).text.join("\n");
  assertStringIncludes(text, "Cash payable including GST $1040.00");
  assertStringIncludes(text, "Weekly deduction - Ute hire");
  assertStringIncludes(text, "$-100.00");
  assertStringIncludes(text, "CASH PAYABLE after the weekly deduction $940.00");
  // with none, the PDF says what it always said
  const plain = renderTradeInvoiceAuditPdf({
    submittedLines: WORK_LINES,
    money: withTradeInvoiceRecurringDeduction(money, null),
    tradeName: "Isaac",
    invoiceNumber: "SW-INV-IB-261016-001",
  }).text.join("\n");
  assert(!plain.includes("Weekly deduction"));
  assert(!plain.includes("CASH PAYABLE after"));
});

// ── 6. The reads ────────────────────────────────────────────────────────────

const STORED = {
  id: "stored-invoice",
  week_start: THIS_WEEK,
  week_end: "2026-10-18",
  status: "pushed_to_xero",
  gst_on: true,
  super_rate: 0.12,
  super_amount: 120,
  gross_earned: 1000,
  net_pay: 940,
  subtotal_ex: 1000,
  gst: 100,
  total_inc: 1100,
};

Deno.test("ute hire: a stored invoice reads back with the line and the reduced payable", () => {
  const carried = {
    ...STORED,
    recurring_deduction_id: RULE_100,
    recurring_deduction_label: "Ute hire",
    recurring_deduction_amount: "100.00",
    recurring_deduction_note: null,
  };
  const money = validatePersistedTradeInvoiceMoney(carried);
  assertEquals(money.trade_payable, 940);
  assertEquals(money.recurring_deduction, {
    id: RULE_100,
    label: "Ute hire",
    amount: 100,
  });
  const presented = presentTradeInvoiceMoney(carried);
  assertEquals(presented.trade_payable, 940);
  assertEquals(presented.payable_before_deduction, 1040);
  assertEquals(presented.recurring_deduction, {
    id: RULE_100,
    label: "Ute hire",
    amount: 100,
  });
  // my_money: the row owes the reduced figure and names the deduction
  const row = tradeMoneyRow(presented);
  assertEquals([row.payable, row.outstanding], [940, 940]);
  assertEquals(row.recurring_deduction, { label: "Ute hire", amount: 100 });
  // a stored deduction above the payable never reads as a negative invoice
  assertThrows(
    () =>
      validatePersistedTradeInvoiceMoney({
        ...carried,
        recurring_deduction_amount: 5000,
      }),
    TradeInvoiceMoneyError,
  );
});

Deno.test("another trade's stored invoice reads exactly as it did before deductions existed", () => {
  const before = { ...STORED, trade_payable: 1040 };
  // columns absent (a read that never selected them) and columns null
  for (
    const row of [STORED, {
      ...STORED,
      recurring_deduction_id: null,
      recurring_deduction_label: null,
      recurring_deduction_amount: null,
      recurring_deduction_note: null,
    }]
  ) {
    const presented = presentTradeInvoiceMoney(row);
    assertEquals(presented, { ...row, trade_payable: 1040 });
    assert(!("recurring_deduction" in presented));
    assert(!("payable_before_deduction" in presented));
    const money = validatePersistedTradeInvoiceMoney(row);
    assert(!("recurring_deduction" in money));
    assertEquals(money.trade_payable, before.trade_payable);
    assert(!("recurring_deduction" in tradeMoneyRow(presented)));
  }
});

// ── 7. The write paths, through the real request handler ────────────────────

type Stub = {
  user: string;
  // rows of trade_recurring_deductions
  rules?: any[];
  // trade_invoices rows already stored (other invoices of the week)
  invoices?: any[];
  // table name -> PostgREST error message
  fail?: Record<string, string>;
  gstRegistered?: boolean;
  // job_assignments rows of the week. Absent: the one 8-hour card.
  cards?: any[];
};

type Captured = {
  status: number;
  body: any;
  // every trade_invoices insert, as sent
  invoiceInserts: any[];
  // every trade_invoices update, as sent
  invoicePatches: any[];
  rpcCalls: Array<{ name: string; args: any }>;
  writes: string[];
  reads: string[];
};

const CARD = {
  id: CARD_A,
  job_id: JOB_A,
  scheduled_date: "2026-10-12",
  status: "complete",
  invoiced_in: null,
  started_at: "2026-10-12T00:00:00Z",
  completed_at: "2026-10-12T08:00:00Z",
  hours_worked: 8,
  jobs: {
    id: JOB_A,
    type: "patio",
    job_number: "SWP-26001",
    client_name: "Client A",
    site_address: "1 First St",
    site_suburb: "Perth",
    metadata: {},
  },
};
const JOB = { ...CARD.jobs, status: "complete" };

async function callTradeAction(
  action: string,
  body: Record<string, unknown>,
  stub: Stub,
  params: Record<string, string> = {},
): Promise<Captured> {
  const invoiceInserts: any[] = [];
  const invoicePatches: any[] = [];
  const rpcCalls: Array<{ name: string; args: any }> = [];
  const writes: string[] = [];
  const reads: string[] = [];
  // The invoice this request writes, so a later read of it answers what was
  // written (the note merge reads query_note back).
  let written: any = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = String(
      init?.method ?? (input instanceof Request ? input.method : "GET"),
    ).toUpperCase();
    const accept = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    ).get("accept") || "";
    const reply = (rows: any[]) => {
      if (!accept.includes("vnd.pgrst.object")) return Response.json(rows);
      if (rows.length === 1) return Response.json(rows[0]);
      return Response.json({
        code: "PGRST116",
        details: `The result contains ${rows.length} rows`,
        hint: null,
        message: "JSON object requested, multiple (or no) rows returned",
      }, { status: 406 });
    };
    const payload = () => {
      const raw = init?.body;
      return typeof raw === "string" && raw ? JSON.parse(raw) : raw;
    };
    const eq = (column: string): string | null => {
      const match = /^eq\.(.*)$/.exec(url.searchParams.get(column) || "");
      return match ? match[1] : null;
    };

    if (url.pathname.startsWith("/auth/v1/user")) {
      return Promise.resolve(
        Response.json({ id: stub.user, email: "", aud: "authenticated" }),
      );
    }
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(.+)$/);
    if (rpc) {
      rpcCalls.push({ name: rpc[1], args: payload() });
      writes.push(`RPC ${rpc[1]}`);
      return Promise.resolve(Response.json(NEW_INVOICE));
    }
    const table = url.pathname.match(/^\/rest\/v1\/(.+)$/)?.[1] || "";
    if (method === "GET" || method === "HEAD") reads.push(table);
    else writes.push(`${method} ${table}`);
    if (stub.fail?.[table]) {
      return Promise.resolve(
        Response.json({ message: stub.fail[table] }, { status: 500 }),
      );
    }
    if (table === "users") {
      return Promise.resolve(reply([{
        id: stub.user,
        org_id: ORG_ID,
        role: "trade",
        name: stub.user === UTE_TRADE ? "Isaac Belcher" : "Other Trade",
        email: "",
        invoice_type: "hourly",
        managed_verticals: [],
        trade_sees_all_jobs: false,
        default_hourly_rate: null,
        xero_contact_id: null,
        trade_details: { gstRegistered: stub.gstRegistered === true },
      }]));
    }
    if (table === "trade_recurring_deductions") {
      const user = eq("user_id");
      return Promise.resolve(reply(
        (stub.rules ?? RULES).filter((row) =>
          (!user || row.user_id === user) &&
          (eq("active") !== "true" || row.active === true)
        ),
      ));
    }
    if (table === "trade_rates") {
      return Promise.resolve(
        reply([{ hourly_rate: 50, effective_from: "2026-01-01" }]),
      );
    }
    if (table === "job_assignments") {
      return Promise.resolve(
        reply(stub.cards ?? [{ ...CARD, user_id: stub.user }]),
      );
    }
    if (table === "jobs") return Promise.resolve(reply([JOB]));
    if (table === "trade_invoices") {
      if (method === "POST") {
        const row = payload();
        invoiceInserts.push(row);
        written = { id: NEW_INVOICE, query_note: null, ...row };
        return Promise.resolve(reply([{ id: NEW_INVOICE }]));
      }
      if (method === "PATCH") {
        const patch = payload();
        invoicePatches.push(patch);
        if (written) written = { ...written, ...patch };
        return Promise.resolve(reply([{ id: NEW_INVOICE }]));
      }
      if (method === "DELETE") {
        return Promise.resolve(reply([{ id: NEW_INVOICE }]));
      }
      if (eq("id") === NEW_INVOICE) {
        return Promise.resolve(reply(written ? [written] : []));
      }
      // Stored invoices, filtered as PostgREST would for the filters the
      // deduction and the week guards use.
      const carriersOnly =
        url.searchParams.get("recurring_deduction_amount") === "not.is.null";
      return Promise.resolve(
        reply(
          (stub.invoices ?? []).filter((row) =>
            (!eq("user_id") || row.user_id === eq("user_id")) &&
            (!eq("week_start") || row.week_start === eq("week_start")) &&
            (!eq("week_end") || row.week_end === eq("week_end")) &&
            (!eq("status") || row.status === eq("status")) &&
            (!carriersOnly || row.recurring_deduction_amount != null)
          ),
        ),
      );
    }
    return Promise.resolve(reply([]));
  }) as typeof fetch;
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", action);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    const res = await _opsApiRequestHandlerForTest(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer trade-jwt",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return {
      status: res.status,
      body: parsed,
      invoiceInserts,
      invoicePatches,
      rpcCalls,
      writes,
      reads,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const handlerTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

const submit = (
  weekStart: string,
  hours: number,
  over: Record<string, unknown> = {},
) => ({
  week_start: weekStart,
  gst_on: false,
  manual_assignments: [{ assignment_id: CARD_A, hours }],
  ...over,
});

const carriedOn = (row: any) => ({
  id: row.recurring_deduction_id ?? null,
  label: row.recurring_deduction_label ?? null,
  amount: row.recurring_deduction_amount ?? null,
  note: row.recurring_deduction_note ?? null,
});

const notes = (out: Captured): string =>
  out.invoicePatches.map((patch) => String(patch.query_note || "")).join(" ");

handlerTest(
  "generate_trade_invoice: this week's invoice carries Ute hire $100 and pays exactly $100 less",
  async () => {
    for (const gstOn of [false, true]) {
      const out = await callTradeAction(
        "generate_trade_invoice",
        submit(THIS_WEEK, 8, { gst_on: gstOn }),
        { user: UTE_TRADE },
      );
      assertEquals(out.body.success, true, JSON.stringify(out.body));
      assertEquals(out.invoiceInserts.length, 1);
      const stored = out.invoiceInserts[0];
      assertEquals(carriedOn(stored), {
        id: RULE_100,
        label: "Ute hire",
        amount: 100,
        note: null,
      });
      // 8h at $50: $400 gross, $24 worker super, $376 net, GST $40 when on
      assertEquals(
        [stored.subtotal_ex, stored.gross_earned, stored.net_pay, stored.gst],
        [400, 400, 376, gstOn ? 40 : 0],
      );
      assertEquals(out.body.payable_before_deduction, gstOn ? 416 : 376);
      assertEquals(out.body.trade_payable, gstOn ? 316 : 276);
      assertEquals(out.body.recurring_deduction, {
        id: RULE_100,
        label: "Ute hire",
        amount: 100,
      });
      assertEquals(out.body.recurring_deduction_week, {
        label: "Ute hire",
        amount: 100,
        week_start: THIS_WEEK,
        applied: true,
        outcome: "applied",
        note: null,
      });
      // taken, so nothing for the office to chase
      assert(!notes(out).includes("Ute hire"));
    }
  },
);

handlerTest(
  "generate_trade_invoice: next week's invoice carries Ute hire $200",
  async () => {
    const out = await callTradeAction(
      "generate_trade_invoice",
      submit(NEXT_WEEK, 8),
      { user: UTE_TRADE },
    );
    assertEquals(out.body.success, true, JSON.stringify(out.body));
    assertEquals(carriedOn(out.invoiceInserts[0]), {
      id: RULE_200,
      label: "Ute hire",
      amount: 200,
      note: null,
    });
    assertEquals(out.body.trade_payable, 176); // 376 - 200
  },
);

handlerTest(
  "generate_trade_invoice: an invoice for a week before 12 Oct 2026 carries none",
  async () => {
    const out = await callTradeAction(
      "generate_trade_invoice",
      submit(EARLIER_WEEK, 8),
      { user: UTE_TRADE },
    );
    assertEquals(out.body.success, true, JSON.stringify(out.body));
    const stored = out.invoiceInserts[0];
    assert(!("recurring_deduction_amount" in stored));
    assert(!("recurring_deduction" in out.body));
    assert(!("recurring_deduction_week" in out.body));
    assertEquals(out.body.trade_payable, 376);
  },
);

handlerTest(
  "generate_trade_invoice: a second invoice in the same week carries none and says why",
  async () => {
    // The week guard already refuses a second weekly invoice for the same
    // week_end; this is the rule under it, for an invoice that shares the
    // week_start any other way.
    const out = await callTradeAction(
      "generate_trade_invoice",
      submit(THIS_WEEK, 8),
      {
        user: UTE_TRADE,
        invoices: [{
          id: "first-invoice",
          user_id: UTE_TRADE,
          week_start: THIS_WEEK,
          week_end: null,
          status: "pushed_to_xero",
          invoice_number: "SW-INV-IB-261016-001",
          recurring_deduction_amount: 100,
        }],
      },
    );
    assertEquals(out.body.success, true, JSON.stringify(out.body));
    const stored = out.invoiceInserts[0];
    assertEquals(
      [stored.recurring_deduction_id, stored.recurring_deduction_amount],
      [null, null],
    );
    assertStringIncludes(
      stored.recurring_deduction_note,
      "already on invoice SW-INV-IB-261016-001",
    );
    assertEquals(out.body.trade_payable, 376);
    assert(!("recurring_deduction" in out.body));
    assertEquals(out.body.recurring_deduction_week.outcome, "already_taken");
    assertStringIncludes(notes(out), "already on invoice SW-INV-IB-261016-001");
  },
);

handlerTest(
  "generate_trade_invoice: resubmitting after a draft or a rejection carries it once",
  async () => {
    for (const status of ["draft", "ops-reject"]) {
      const out = await callTradeAction(
        "generate_trade_invoice",
        submit(THIS_WEEK, 8),
        {
          user: UTE_TRADE,
          invoices: [{
            id: "earlier-copy",
            user_id: UTE_TRADE,
            week_start: THIS_WEEK,
            week_end: "2026-10-18",
            status,
            invoice_number: null,
            recurring_deduction_amount: 100,
          }],
        },
      );
      assertEquals(out.body.success, true, JSON.stringify(out.body));
      assertEquals(out.invoiceInserts.length, 1, status);
      assertEquals(out.invoiceInserts[0].recurring_deduction_amount, 100);
      assertEquals(out.body.trade_payable, 276);
    }
  },
);

handlerTest(
  "generate_trade_invoice: a total below the deduction is saved in full and marked for the office",
  async () => {
    // 1h at $50: $47 payable, less than the $100
    const out = await callTradeAction(
      "generate_trade_invoice",
      submit(THIS_WEEK, 1),
      { user: UTE_TRADE },
    );
    assertEquals(out.status, 200);
    assertEquals(out.body.success, true, JSON.stringify(out.body));
    const stored = out.invoiceInserts[0];
    assertEquals(
      [stored.recurring_deduction_id, stored.recurring_deduction_amount],
      [null, null],
    );
    assertStringIncludes(
      stored.recurring_deduction_note,
      "Ute hire $100.00 NOT taken",
    );
    assertEquals(out.body.trade_payable, 47);
    assert(out.body.trade_payable >= 0);
    assert(!("recurring_deduction" in out.body));
    assertEquals(
      out.body.recurring_deduction_week.outcome,
      "payable_below_deduction",
    );
    // said where the office reads it
    assertStringIncludes(notes(out), "Ute hire $100.00 NOT taken");
    assertStringIncludes(notes(out), "$47.00");
  },
);

handlerTest(
  "generate_trade_invoice: two active rows covering the week take none and mark the invoice for the office",
  async () => {
    const out = await callTradeAction(
      "generate_trade_invoice",
      submit(NEXT_WEEK, 8),
      {
        user: UTE_TRADE,
        rules: [...RULES, {
          ...RULES[1],
          id: "0a1e0000-0000-4000-8000-00000000f250",
          amount: 250,
          first_week_start: NEXT_WEEK,
        }],
      },
    );
    assertEquals(out.body.success, true, JSON.stringify(out.body));
    const stored = out.invoiceInserts[0];
    assertEquals(
      [stored.recurring_deduction_id, stored.recurring_deduction_amount],
      [null, null],
    );
    assertStringIncludes(
      stored.recurring_deduction_note,
      "2 active deductions cover that week",
    );
    // paid in full, and said where the office reads it
    assertEquals(out.body.trade_payable, 376);
    assert(!("recurring_deduction" in out.body));
    assertStringIncludes(notes(out), "2 active deductions cover that week");
  },
);

// A no-week invoice is for the day it is submitted, so these rows cover every
// week the test can run in.
const ALWAYS_ON = [{
  id: RULE_200,
  user_id: UTE_TRADE,
  label: "Ute hire",
  amount: 150,
  first_week_start: "2020-01-06",
  last_week_start: null,
  active: true,
}];
const noWeek = () => ({
  gst_on: false,
  extra_items: [{
    type: "adjustment",
    description: "Tool allowance",
    quantity: 1,
    rate: 400,
  }],
});

handlerTest(
  "generate_trade_invoice: an invoice with no week takes nothing and is marked for the office",
  async () => {
    const out = await callTradeAction("generate_trade_invoice", noWeek(), {
      user: UTE_TRADE,
      rules: ALWAYS_ON,
    });
    assertEquals(out.body.success, true, JSON.stringify(out.body));
    assertEquals(out.invoiceInserts.length, 1);
    const stored = out.invoiceInserts[0];
    assertEquals(stored.week_start, null);
    assertEquals(
      [
        stored.recurring_deduction_id,
        stored.recurring_deduction_label,
        stored.recurring_deduction_amount,
      ],
      [null, null, null],
    );
    assertStringIncludes(
      stored.recurring_deduction_note,
      "Ute hire $150.00 NOT applied: this invoice has no invoice week",
    );
    // said where the office reads it
    assertStringIncludes(notes(out), "this invoice has no invoice week");
    // nothing is taken and the response is what it was
    assertEquals([stored.subtotal_ex, stored.net_pay], [400, 376]);
    assertEquals(out.body.trade_payable, 376);
    for (
      const key of [
        "recurring_deduction",
        "recurring_deduction_week",
        "payable_before_deduction",
      ]
    ) {
      assert(!(key in out.body), key);
    }
  },
);

handlerTest(
  "generate_trade_invoice: another trade's no-week invoice is unchanged, and an unreadable rule never stops one",
  async () => {
    const withRules = await callTradeAction(
      "generate_trade_invoice",
      noWeek(),
      { user: OTHER_TRADE, rules: ALWAYS_ON },
    );
    const noRules = await callTradeAction("generate_trade_invoice", noWeek(), {
      user: OTHER_TRADE,
      rules: [],
    });
    assertEquals(withRules.body.success, true, JSON.stringify(withRules.body));
    const strip = (row: any) => {
      const { invoice_number: _n, submitted_at: _s, ...rest } = row;
      return rest;
    };
    assertEquals(
      strip(withRules.invoiceInserts[0]),
      strip(noRules.invoiceInserts[0]),
    );
    assert(!("recurring_deduction_note" in withRules.invoiceInserts[0]));
    assertEquals(withRules.invoicePatches, noRules.invoicePatches);

    // Nothing is taken off a no-week invoice either way, so a rule that
    // cannot be read leaves it unmarked rather than refused.
    const unreadable = await callTradeAction(
      "generate_trade_invoice",
      noWeek(),
      { user: UTE_TRADE, fail: { trade_recurring_deductions: "boom" } },
    );
    assertEquals(
      unreadable.body.success,
      true,
      JSON.stringify(unreadable.body),
    );
    assertEquals(unreadable.invoiceInserts.length, 1);
    assert(!("recurring_deduction_note" in unreadable.invoiceInserts[0]));
    assertEquals(unreadable.body.trade_payable, 376);
  },
);

handlerTest(
  "generate_trade_invoice: with the row switched off the invoice carries none",
  async () => {
    const out = await callTradeAction(
      "generate_trade_invoice",
      submit(NEXT_WEEK, 8),
      {
        user: UTE_TRADE,
        rules: RULES.map((row) => ({ ...row, active: false })),
      },
    );
    assertEquals(out.body.success, true, JSON.stringify(out.body));
    assert(!("recurring_deduction_amount" in out.invoiceInserts[0]));
    assertEquals(out.body.trade_payable, 376);
  },
);

handlerTest(
  "generate_trade_invoice: another trade's invoice is unchanged in every figure and field",
  async () => {
    // Same request, same week, another trade: with the ute hire rows in the
    // table and with the table empty. Byte for byte the same.
    const withRules = await callTradeAction(
      "generate_trade_invoice",
      submit(THIS_WEEK, 8, { gst_on: true }),
      { user: OTHER_TRADE },
    );
    const noRules = await callTradeAction(
      "generate_trade_invoice",
      submit(THIS_WEEK, 8, { gst_on: true }),
      { user: OTHER_TRADE, rules: [] },
    );
    assertEquals(withRules.body.success, true, JSON.stringify(withRules.body));
    const strip = (row: any) => {
      const { invoice_number: _n, submitted_at: _s, ...rest } = row;
      return rest;
    };
    assertEquals(
      strip(withRules.invoiceInserts[0]),
      strip(noRules.invoiceInserts[0]),
    );
    const stored = withRules.invoiceInserts[0];
    for (
      const key of [
        "recurring_deduction_id",
        "recurring_deduction_label",
        "recurring_deduction_amount",
        "recurring_deduction_note",
      ]
    ) {
      assert(!(key in stored), key);
    }
    assertEquals(
      [stored.subtotal_ex, stored.net_pay, stored.gst, stored.total_inc],
      [400, 376, 40, 440],
    );
    const bodyOf = (out: Captured) => {
      const { invoice_number: _n, ...rest } = out.body;
      return rest;
    };
    assertEquals(bodyOf(withRules), bodyOf(noRules));
    assertEquals(withRules.body.trade_payable, 416);
    for (
      const key of [
        "recurring_deduction",
        "recurring_deduction_week",
        "payable_before_deduction",
      ]
    ) {
      assert(!(key in withRules.body), key);
    }
    assertEquals(withRules.invoicePatches, noRules.invoicePatches);
    // and no second read is made for a trade with no rule
    assertEquals(withRules.reads, noRules.reads);
  },
);

handlerTest(
  "generate_trade_invoice: when the rule cannot be read nothing is saved",
  async () => {
    const out = await callTradeAction(
      "generate_trade_invoice",
      submit(THIS_WEEK, 8),
      { user: UTE_TRADE, fail: { trade_recurring_deductions: "boom" } },
    );
    assert(out.status >= 500, String(out.status));
    assertEquals(out.invoiceInserts, []);
    assertEquals(out.writes, []);
  },
);

handlerTest(
  "save_trade_invoice_draft: the draft shows Ute hire before he submits, and a redraft carries it once",
  async () => {
    const draft = {
      week_start: THIS_WEEK,
      gst_on: false,
      labour_lines: [{
        job_id: JOB_A,
        job_number: "SWP-26001",
        total_hours: 8,
        hourly_rate: 50,
        line_total_ex: 400,
      }],
    };
    const first = await callTradeAction("save_trade_invoice_draft", draft, {
      user: UTE_TRADE,
    });
    assertEquals(first.body.success, true, JSON.stringify(first.body));
    assertEquals(first.rpcCalls.length, 1);
    assertEquals(first.rpcCalls[0].name, "persist_weekly_trade_invoice_v3");
    assertEquals(carriedOn(first.rpcCalls[0].args.p_invoice), {
      id: RULE_100,
      label: "Ute hire",
      amount: 100,
      note: null,
    });
    assertEquals(first.body.trade_payable, 276);
    assertEquals(first.body.recurring_deduction_week.applied, true);

    // Saving it again replaces the draft: the earlier draft carries the
    // deduction too, and is released, so the new one carries it once.
    const again = await callTradeAction("save_trade_invoice_draft", draft, {
      user: UTE_TRADE,
      invoices: [{
        id: "earlier-draft",
        user_id: UTE_TRADE,
        week_start: THIS_WEEK,
        week_end: "2026-10-18",
        status: "draft",
        recurring_deduction_amount: 100,
      }],
    });
    assertEquals(again.rpcCalls.length, 1);
    assertEquals(
      again.rpcCalls[0].args.p_invoice.recurring_deduction_amount,
      100,
    );
    assertEquals(
      again.rpcCalls[0].args.p_requested_prior_draft_id,
      "earlier-draft",
    );
    assertEquals(again.body.trade_payable, 276);

    // another trade's draft: no keys at all
    const other = await callTradeAction("save_trade_invoice_draft", draft, {
      user: OTHER_TRADE,
    });
    assert(!("recurring_deduction_amount" in other.rpcCalls[0].args.p_invoice));
    assertEquals(other.body.trade_payable, 376);
    assert(!("recurring_deduction_week" in other.body));
  },
);

handlerTest(
  "submit_trade_invoice: the legacy weekly submit carries it too",
  async () => {
    // 8 clocked hours at $50
    const out = await callTradeAction(
      "submit_trade_invoice",
      { week_ending: "2026-10-18", gst_on: false },
      { user: UTE_TRADE },
    );
    assertEquals(out.invoiceInserts.length, 1, JSON.stringify(out.body));
    assertEquals(carriedOn(out.invoiceInserts[0]), {
      id: RULE_100,
      label: "Ute hire",
      amount: 100,
      note: null,
    });
    assertEquals(out.invoiceInserts[0].net_pay, 376);

    const other = await callTradeAction(
      "submit_trade_invoice",
      { week_ending: "2026-10-18", gst_on: false },
      { user: OTHER_TRADE },
    );
    assertEquals(other.invoiceInserts.length, 1, JSON.stringify(other.body));
    assert(!("recurring_deduction_amount" in other.invoiceInserts[0]));
    assertEquals(
      other.invoiceInserts[0].query_note,
      "Validated invoice awaiting Xero ACCPAY creation.",
    );
  },
);

handlerTest(
  "my_hours: the week's Ute hire is shown before he submits, and never for another trade",
  async () => {
    const mine = await callTradeAction("my_hours", {}, { user: UTE_TRADE }, {
      week_ending: "2026-10-18",
    });
    assertEquals(mine.status, 200, JSON.stringify(mine.body));
    assertEquals(mine.body.recurring_deduction_week, {
      label: "Ute hire",
      amount: 100,
      week_start: THIS_WEEK,
      applied: true,
      outcome: "applied",
      note: null,
    });
    // 8 clocked hours at $50: $376, less $100
    assertEquals(mine.body.trade_payable, 276);

    const next = await callTradeAction("my_hours", {}, { user: UTE_TRADE }, {
      week_ending: "2026-10-25",
    });
    assertEquals(next.body.recurring_deduction_week.amount, 200);

    const other = await callTradeAction("my_hours", {}, { user: OTHER_TRADE }, {
      week_ending: "2026-10-18",
    });
    assert(!("recurring_deduction_week" in other.body));
    assert(!("recurring_deduction" in other.body));
    assertEquals(other.body.trade_payable, 376);

    // a rule that cannot be read never fails the hours view
    const unreadable = await callTradeAction(
      "my_hours",
      {},
      { user: UTE_TRADE, fail: { trade_recurring_deductions: "boom" } },
      { week_ending: "2026-10-18" },
    );
    assertEquals(unreadable.status, 200);
    assertEquals(unreadable.body.trade_payable, 376);
  },
);

handlerTest(
  "my_hours: an empty week shows the Ute hire to come and no note for the office",
  async () => {
    const empty = await callTradeAction(
      "my_hours",
      {},
      { user: UTE_TRADE, cards: [] },
      { week_ending: "2026-10-18" },
    );
    assertEquals(empty.status, 200, JSON.stringify(empty.body));
    assertEquals(empty.body.recurring_deduction_week, {
      label: "Ute hire",
      amount: 100,
      week_start: THIS_WEEK,
      applied: false,
      outcome: "nothing_payable",
      note: null,
    });
    assertEquals(empty.body.trade_payable, 0);
    assert(!("recurring_deduction" in empty.body));
  },
);

// ── The office's note on a read ─────────────────────────────────────────────

Deno.test("a 'not taken' reason reaches the office on a read whatever the invoice's status", () => {
  const reason =
    "Ute hire $100.00 NOT taken for the week starting 2026-10-12: the amount payable on this invoice ($47.00) is less than the deduction.";
  // The stored query_note is cleared once the Xero bill reconciles, and
  // replaced while the bill is being pushed or retried.
  for (
    const [status, stored, shown] of [
      ["pushed_to_xero", null, reason],
      ["paid", "", reason],
      [
        "approved",
        "Xero bill BILL-1 was created by ops-api.",
        `Xero bill BILL-1 was created by ops-api. | ${reason}`,
      ],
      // still there from the submit: said once
      ["pending_ops_review", `Manual hours entered. | ${reason}`, null],
    ] as const
  ) {
    const row = {
      id: "stored-invoice",
      status,
      query_note: stored,
      recurring_deduction_note: reason,
    };
    const read = withTradeRecurringDeductionOfficeNote(row);
    assertEquals(read.query_note, shown ?? stored, status);
    assertEquals(read.recurring_deduction_note, reason);
  }
  // an invoice with no reason, and a read that never selected query_note
  // (the trade's own lists), come back exactly as they went in
  for (
    const row of [
      { id: "a", query_note: "Manual hours entered." },
      { id: "b", query_note: null, recurring_deduction_note: null },
      { id: "c", recurring_deduction_note: reason },
    ]
  ) {
    assert(withTradeRecurringDeductionOfficeNote(row) === row);
  }
});

// ── The loader ──────────────────────────────────────────────────────────────

Deno.test("loader: a failed read throws, it never reads as no deduction", async () => {
  const client = (failing: string) => ({
    from(table: string) {
      const result = table === failing
        ? { data: null, error: { message: "boom" } }
        : {
          data: table === "trade_recurring_deductions" ? RULES : [],
          error: null,
        };
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        then: (resolve: (value: unknown) => unknown) => resolve(result),
      };
      return builder;
    },
  });
  for (const table of ["trade_recurring_deductions", "trade_invoices"]) {
    let message = "";
    try {
      await loadTradeRecurringDeductionDecision(client(table), {
        userId: UTE_TRADE,
        weekStart: THIS_WEEK,
        payable: 500,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assertStringIncludes(message, "boom", table);
  }
  // an invoice with no week reads nothing at all
  const untouched = await loadTradeRecurringDeductionDecision(
    {
      from() {
        throw new Error("no read expected");
      },
    },
    { userId: UTE_TRADE, weekStart: null, payable: 500 },
  );
  assertEquals(untouched.outcome, "none");

  // A submitted work-order invoice reads the rules only (the invoices read
  // would fail here) and is marked for the office.
  const workOrder = {
    userId: UTE_TRADE,
    weekStart: null,
    payable: 500,
    weekless: { kind: "work_order_invoice" as const, day: "2026-10-15" },
  };
  const marked = await loadTradeRecurringDeductionDecision(
    client("trade_invoices"),
    workOrder,
  );
  assertEquals(marked.outcome, "work_order_invoice");
  assertEquals(marked.applied, null);
  assertStringIncludes(
    marked.note || "",
    "Ute hire $100.00 NOT applied: this is a work-order invoice",
  );
  // Nothing is taken off it either way, so a failed rule read leaves it
  // unmarked and never stops the submit.
  const unread = await loadTradeRecurringDeductionDecision(
    client("trade_recurring_deductions"),
    workOrder,
  );
  assertEquals(unread.outcome, "none");
});
