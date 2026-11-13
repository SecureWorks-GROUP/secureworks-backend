// deno-lint-ignore-file no-import-prefix

import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculateTradeInvoiceMoney,
  formatTradeInvoiceSuperWithheldDescription,
  TRADE_INVOICE_SUPER_ON_TOP_BASIS,
  validatePersistedTradeInvoiceMoney,
} from "./trade_invoice_money.ts";
import {
  resolveSuperOnTopBasisForPreview,
  resolveSuperOnTopBasisForSubmit,
  superOnTopBasisFor,
  TradeSuperOnTopUnreadable,
} from "./trade_super_on_top.ts";

function fakeClient(result: { data: unknown; error: unknown }) {
  const chain: any = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => result,
  };
  return chain;
}

const ROW = { user_id: "u1", effective_from: "2026-10-19" };

Deno.test("super on top: applies from the start date, inclusive", () => {
  assertEquals(superOnTopBasisFor(ROW, "2026-10-19"), TRADE_INVOICE_SUPER_ON_TOP_BASIS);
  assertEquals(superOnTopBasisFor(ROW, "2026-11-09"), TRADE_INVOICE_SUPER_ON_TOP_BASIS);
  assertEquals(superOnTopBasisFor(ROW, "2026-10-12"), null);
  assertEquals(superOnTopBasisFor(null, "2026-11-09"), null);
  assertEquals(superOnTopBasisFor(ROW, ""), null);
});

Deno.test("super on top: the trade is paid the whole gross, company pays 12% on top", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 1000,
    gstOn: false,
    earningsDate: "2026-11-09",
    superBasis: TRADE_INVOICE_SUPER_ON_TOP_BASIS,
  });
  assertEquals(money.gross_earned, 1000);
  assertEquals(money.super_amount, 120);
  assertEquals(money.worker_withhold, 0);
  assertEquals(money.company_contribution, 120);
  assertEquals(money.net_pay, 1000);
  assertEquals(money.trade_payable, 1000);
  assertEquals(money.company_total_out, 1120);
  assertEquals(money.super_basis, TRADE_INVOICE_SUPER_ON_TOP_BASIS);
});

Deno.test("super on top: an ordinary trade still has 6% withheld", () => {
  const money = calculateTradeInvoiceMoney({ grossEarned: 1000, gstOn: false, earningsDate: "2026-11-09" });
  assertEquals(money.net_pay, 940);
  assertEquals(money.super_basis, undefined);
});

Deno.test("super on top: GST is on the gross, commission carries no super", () => {
  const money = calculateTradeInvoiceMoney({
    grossEarned: 1000,
    gstOn: true,
    earningsDate: "2026-11-09",
    superBasis: TRADE_INVOICE_SUPER_ON_TOP_BASIS,
    commissionEx: 200,
  });
  assertEquals(money.super_amount, 96);
  assertEquals(money.net_pay, 1000);
  assertEquals(money.gst_amount, 100);
  assertEquals(money.trade_payable, 1100);
});

Deno.test("super on top: a stored invoice reads back and its Xero super line says nothing is withheld", () => {
  const money = validatePersistedTradeInvoiceMoney({
    gst_on: false,
    super_rate: 0.12,
    gross_earned: 500,
    super_amount: 60,
    net_pay: 500,
    gst: 0,
    total_inc: 500,
    subtotal_ex: 500,
    super_basis: TRADE_INVOICE_SUPER_ON_TOP_BASIS,
    week_start: "2026-11-02",
    week_end: "2026-11-08",
  });
  assertEquals(money.net_pay, 500);
  assertEquals(money.worker_withhold, 0);
  const text = formatTradeInvoiceSuperWithheldDescription(money, "Ryan");
  assertEquals(text.includes("paid by the company on top. Nothing withheld."), true);
  assertEquals(text.includes("group share"), false);
});

Deno.test("super on top: submit refuses when the list cannot be read, preview shows the ordinary split", async () => {
  const broken = fakeClient({ data: null, error: { message: "boom" } });
  await assertRejects(() => resolveSuperOnTopBasisForSubmit(broken, "u1", "2026-11-09"), TradeSuperOnTopUnreadable);
  assertEquals(await resolveSuperOnTopBasisForPreview(broken, "u1", "2026-11-09"), null);
  const listed = fakeClient({ data: ROW, error: null });
  assertEquals(await resolveSuperOnTopBasisForSubmit(listed, "u1", "2026-11-09"), TRADE_INVOICE_SUPER_ON_TOP_BASIS);
  const unlisted = fakeClient({ data: null, error: null });
  assertEquals(await resolveSuperOnTopBasisForSubmit(unlisted, "u1", "2026-11-09"), null);
});
