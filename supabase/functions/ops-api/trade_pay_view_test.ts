import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateTradeInvoiceMoney, withTradeInvoiceRecurringDeduction } from "./trade_invoice_money.ts";
import { buildPayView } from "./trade_pay_view.ts";

const opts = { reimbursementsEx: 0, taxSetAsidePercent: null, repayment: null };
const money = (reimbursementEx = 0, gstOn = false) =>
  calculateTradeInvoiceMoney({
    grossEarned: 1120 + reimbursementEx,
    gstOn,
    reimbursementEx,
    superBasis: "inclusive_12_112_v1",
    earningsDate: "2026-12-07",
  });

Deno.test("ZZTEST-P1: server pay rows reconcile and tax remains unknown until set", () => {
  assertEquals(buildPayView(money(), opts), {
    basis: "inclusive_12_112_v1",
    total_inc_super: 1120,
    paid_to_super: 120,
    paid_to_you: 1000,
    reimbursements: 0,
    gst: 0,
    repayment: null,
    into_bank: 1000,
    tax_set_aside: null,
    gst_set_aside: 0,
  });
  assertEquals(
    buildPayView(money(), { ...opts, taxSetAsidePercent: 20 })?.tax_set_aside,
    { percent: 20, amount: 200 },
  );
});

Deno.test("ZZTEST-P1: receipt and GST stay outside the inclusive work total", () => {
  assertEquals(
    buildPayView(money(80, true), { ...opts, reimbursementsEx: 80 }),
    {
      basis: "inclusive_12_112_v1",
      total_inc_super: 1120,
      paid_to_super: 120,
      paid_to_you: 1000,
      reimbursements: 80,
      gst: 112,
      repayment: null,
      into_bank: 1192,
      tax_set_aside: null,
      gst_set_aside: 112,
    },
  );
});

Deno.test("ZZTEST-P1: earlier bases have no pay view", () => {
  for (const super_basis of [null, "employer_12_v2"] as const) {
    assertEquals(buildPayView({ ...money(), super_basis }, opts), null);
  }
});

Deno.test("ZZTEST-P1: repayment and rounded cents are presented without repricing", () => {
  const repayment = { label: "ZZTEST repayment", amount: 10, balance_left: 20 };
  const split = calculateTradeInvoiceMoney({
    grossEarned: 0.14,
    gstOn: false,
    superBasis: "inclusive_12_112_v1",
    earningsDate: "2026-12-07",
  });
  const view = buildPayView({ ...split, trade_payable: 0 }, {
    ...opts,
    repayment,
  });
  assertEquals(view?.paid_to_super, 0.02);
  assertEquals(view?.paid_to_you, 0.12);
  assertEquals(view?.repayment, repayment);
  assertEquals(view?.into_bank, 0);
  assertThrows(() => buildPayView({ ...split, super_amount: NaN }, opts));
});

import { presentTradeInvoiceMoney } from "./trade_invoice_money.ts";
import {
  readTradePayRule,
  readTradePaySettings,
  tradePayTaxPercent,
} from "./trade_pay_rule.ts";
import { payViewRepayment } from "./trade_pay_view.ts";

Deno.test("ZZTEST-P1: persisted presenter keeps the work total separate from receipts", () => {
  const split = money(80, true);
  const invoice = {
    ...split,
    gst: split.gst_amount,
    subtotal_ex: 1200,
    week_start: "2026-12-07",
  };
  const presented = presentTradeInvoiceMoney(invoice, opts);
  assertEquals(
    presented.pay_view,
    buildPayView(split, { ...opts, reimbursementsEx: 80 }),
  );
  assertEquals(presented.trade_payable, 1192);
  const old = calculateTradeInvoiceMoney({
    grossEarned: 1120,
    gstOn: false,
    earningsDate: "2026-12-07",
  });
  const oldInvoice = {
    ...old,
    gst: old.gst_amount,
    subtotal_ex: 1120,
    week_start: "2026-12-07",
  };
  assertEquals(
    presentTradeInvoiceMoney(oldInvoice, opts),
    presentTradeInvoiceMoney(oldInvoice),
  );
  assertEquals(presentTradeInvoiceMoney({ id: "ZZTEST-empty" }, opts), {
    id: "ZZTEST-empty",
    trade_payable: null,
  });
});

Deno.test("ZZTEST-P1: one settings read serves pricing and tax; failures stay unknown", async () => {
  let reads = 0;
  const client = {
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        limit: () => {
          if (table === "trade_pay_settings") reads++;
          return Promise.resolve({
            data: [
              table === "feature_flags" ? { enabled: true } : {
                inclusive_super_from: "2026-12-07",
                tax_set_aside_percent: 20,
              },
            ],
            error: null,
          });
        },
      };
      return query;
    },
  };
  const settings = readTradePaySettings(client);
  assertEquals(await readTradePayRule(client, settings), {
    ok: true,
    on: true,
    from: "2026-12-07",
  });
  assertEquals(tradePayTaxPercent(await settings), 20);
  assertEquals(reads, 1);
  assertEquals(
    tradePayTaxPercent({ data: [{ tax_set_aside_percent: 20 }], error: {} }),
    null,
  );
  assertEquals(tradePayTaxPercent({ data: [{}], error: null }), null);
  const failed = await readTradePaySettings({
    from() {
      throw new Error("ZZTEST unavailable");
    },
  });
  assertEquals(
    buildPayView(money(), {
      ...opts,
      taxSetAsidePercent: tradePayTaxPercent(failed),
    })?.tax_set_aside,
    null,
  );
});

Deno.test("ZZTEST-P1: history uses only the deduction saved on its invoice", () => {
  const invoice = {
    recurring_deduction_label: "ZZTEST repayment",
    recurring_deduction_amount: 10,
  };
  assertEquals(payViewRepayment(invoice), { label: "ZZTEST repayment", amount: 10 });
  assertEquals(payViewRepayment({}), null);
  assertEquals(payViewRepayment({ ...invoice, recurring_deduction_amount: 0 }), null);
  assertEquals(payViewRepayment({ ...invoice, recurring_deduction_amount: "bad" }), null);
});

Deno.test("ZZTEST-P1 HOLD: a Xero read keeps the existing office-change presentation", () => {
  const split = money();
  const invoice = {
    ...split,
    gst: split.gst_amount,
    subtotal_ex: 1120,
    week_start: "2026-12-07",
    xero_adjustments_ex: 25,
    xero_adjustment_lines: [{ description: "ZZTEST office change", amount: 25 }],
    xero_bill_total: 1025,
    xero_bill_status: "AUTHORISED",
  };
  const presented = presentTradeInvoiceMoney(invoice, opts);
  assertEquals(presented.pay_view, undefined);
  assertEquals(presented.payable_after_xero, 1025);
  assertEquals(presented.xero_pays, 1025);
  assertEquals(presented, presentTradeInvoiceMoney(invoice));
  assertEquals(presentTradeInvoiceMoney({ ...invoice, xero_adjustments_ex: 0 }, opts).pay_view, undefined);
});

Deno.test("ZZTEST-P1 HOLD: recurring hire has a row explaining the bank total", () => {
  const split = withTradeInvoiceRecurringDeduction(money(), {
    id: "ZZTEST-hire", label: "ZZTEST ute hire", amount: 40,
  });
  const view = buildPayView(split, opts);
  assertEquals(view?.repayment, { label: "ZZTEST ute hire", amount: 40 });
  assertEquals(view?.into_bank, 960);
  assertEquals(view!.paid_to_you - view!.repayment!.amount, view!.into_bank);
});

Deno.test("ZZTEST-P1 HOLD: historical repayment never labels today's balance as invoice-time balance", () => {
  const invoice = {
    recurring_deduction_id: "ZZTEST-rule",
    recurring_deduction_label: "ZZTEST repayment",
    recurring_deduction_amount: 10,
  };
  assertEquals(payViewRepayment(invoice), {
    label: "ZZTEST repayment", amount: 10,
  });
});

Deno.test("ZZTEST-P1 HOLD: saved invoice presentation needs no repayment service", () => {
  const invoice = {
    ...money(), gst: 0, subtotal_ex: 1120, week_start: "2026-12-07",
    recurring_deduction_id: "ZZTEST-rule",
    recurring_deduction_label: "ZZTEST repayment",
    recurring_deduction_amount: 10,
  };
  // No rule or balance service is available: list and detail still present
  // the invoice's saved amount, never a current balance or a missing invoice.
  const presented = presentTradeInvoiceMoney(invoice, {
    ...opts, repayment: payViewRepayment(invoice),
  });
  assertEquals(presented.pay_view?.repayment, { label: "ZZTEST repayment", amount: 10 });
  assertEquals(presented.pay_view?.into_bank, 990);
});
