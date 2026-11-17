// One super rule (P1-01): every amount includes super. The fund gets 12/112
// of the total less reimbursements, the person the rest. Tests to the cent.
// Stand-in figures only (ZZTEST); no person's name or rate.
// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertReturnedTradeInvoiceXeroSplit,
  assertTradeInvoiceSuperBaseMatchesLines,
  buildTradeInvoiceAuditModel,
  calculateTradeInvoiceMoney,
  isTradeInvoiceReimbursementLine,
  presentTradeInvoiceMoney,
  reimbursementLinesTotalEx,
  splitTradeInvoiceXeroLines,
  tradeInvoiceInclusiveSuper,
  TRADE_INVOICE_EMPLOYER_SUPER_BASIS,
  TRADE_INVOICE_INCLUSIVE_SUPER_BASIS,
  type TradeInvoiceXeroLine,
  validatePersistedTradeInvoiceMoney,
} from "./trade_invoice_money.ts";
import { buildTradeInvoiceAuditText } from "./trade_invoice_pdf.ts";
import {
  chooseTradeInvoiceSuperBasis,
  linesCarryGroupShare,
  readTradeSuperInclusiveState,
  resolveTradeInvoiceSuperBasisForPreview,
  resolveTradeInvoiceSuperBasisForSubmit,
  TradeSuperInclusiveUnreadable,
} from "./trade_super_inclusive.ts";

const INCLUSIVE = TRADE_INVOICE_INCLUSIVE_SUPER_BASIS;

/** Exact 12/112 of a cents amount, rounded half up, in cents (BigInt). */
function exactSuperCents(baseCents: number): number {
  const num = BigInt(baseCents) * 12n;
  const q = num / 112n;
  const r = num % 112n;
  return Number(r * 2n >= 112n ? q + 1n : q);
}

function inclusive(gross: number, reimbursementEx = 0, gstOn = false) {
  return calculateTradeInvoiceMoney({
    grossEarned: gross,
    gstOn,
    earningsDate: "2026-11-22",
    superBasis: INCLUSIVE,
    reimbursementEx,
  });
}

Deno.test("super = total x 12/112 to the cent: worked example", () => {
  const m = inclusive(1120);
  assertEquals(m.super_amount, 120);
  assertEquals(m.net_pay, 1000);
  assertEquals(m.worker_withhold, 120);
  assertEquals(m.company_contribution, 0);
  assertEquals(m.company_total_out, 1120);
  assertEquals(m.super_base_ex ?? null, null);
  assertEquals(m.super_basis, INCLUSIVE);
  assertEquals(m.super_rate, 0.12);
  assertEquals(m.trade_payable, 1000);
});

Deno.test("super = total x 12/112 to the cent: every cent from 0 to 3000.00 and the half-cent ties", () => {
  for (let cents = 0; cents <= 300000; cents++) {
    const base = cents / 100;
    const want = exactSuperCents(cents) / 100;
    if (tradeInvoiceInclusiveSuper(base) !== want) {
      throw new Error(`base ${base}: got ${tradeInvoiceInclusiveSuper(base)}, want ${want}`);
    }
  }
  // 1000.02 * 12 / 112 = 107.145 exactly: half a cent rounds up, as the
  // database's round(numeric, 2) does.
  assertEquals(tradeInvoiceInclusiveSuper(1000.02), 107.15);
  const m = inclusive(1000.02);
  assertEquals(m.super_amount, 107.15);
  assertEquals(m.net_pay, 892.87);
  // Large totals stay exact.
  assertEquals(tradeInvoiceInclusiveSuper(123456.78), exactSuperCents(12345678) / 100);
});

Deno.test("GST stays 10% of the whole total; super is on the ex GST total", () => {
  const m = inclusive(1120, 0, true);
  assertEquals(m.gst_amount, 112);
  assertEquals(m.total_inc, 1232);
  assertEquals(m.super_amount, 120);
  assertEquals(m.trade_payable, 1112);
});

Deno.test("a reimbursement line carries zero super", () => {
  const lines = [
    { line_type: "labour", line_total_ex: 1120 },
    { line_type: "materials", line_total_ex: 200 },
  ];
  const reimbursement = reimbursementLinesTotalEx(lines);
  assertEquals(reimbursement, 200);
  const m = inclusive(1320, reimbursement);
  assertEquals(m.super_base_ex, 1120);
  assertEquals(m.super_amount, 120);
  assertEquals(m.net_pay, 1200);
  // Only reimbursements: no super at all, paid in full.
  const only = inclusive(200, 200);
  assertEquals(only.super_base_ex, 0);
  assertEquals(only.super_amount, 0);
  assertEquals(only.net_pay, 200);
});

Deno.test("super comes out of every line paid to a person; only reimbursements are free", () => {
  for (const t of ["labour", "work order", "work_order", "travel", "commission", "make safe", "equipment", "other", "materials_deduction", "travel_logistics_deduction"]) {
    assertEquals(isTradeInvoiceReimbursementLine(t), false, t);
  }
  for (const t of ["materials", " Materials ", "reimbursement"]) {
    assertEquals(isTradeInvoiceReimbursementLine(t), true, t);
  }
  // Commission carries super under this rule (no commission carve-out).
  const m = calculateTradeInvoiceMoney({
    grossEarned: 1120,
    gstOn: false,
    earningsDate: "2026-11-22",
    superBasis: INCLUSIVE,
    commissionEx: 560,
  });
  assertEquals(m.super_amount, 120);
  assertEquals(m.super_base_ex ?? null, null);
});

Deno.test("an invoice before the start date is priced exactly as today", () => {
  const state = { on: true, startsOn: "2026-11-16" };
  assertEquals(
    chooseTradeInvoiceSuperBasis(state, { weekStart: "2026-11-09", pricedOn: "2026-11-15" }),
    null,
  );
  assertEquals(
    chooseTradeInvoiceSuperBasis(state, { weekStart: "2026-11-16", pricedOn: "2026-11-22" }),
    INCLUSIVE,
  );
  // No week: the day it is priced decides.
  assertEquals(chooseTradeInvoiceSuperBasis(state, { pricedOn: "2026-11-15" }), null);
  assertEquals(chooseTradeInvoiceSuperBasis(state, { pricedOn: "2026-11-16" }), INCLUSIVE);
  // A week that starts before the date stays on today's rule even when priced after it.
  assertEquals(
    chooseTradeInvoiceSuperBasis(state, { weekStart: "2026-11-09", pricedOn: "2026-11-20" }),
    null,
  );

  const before = calculateTradeInvoiceMoney({
    grossEarned: 1000,
    gstOn: false,
    earningsDate: "2026-11-15",
    superBasis: chooseTradeInvoiceSuperBasis(state, { weekStart: "2026-11-09", pricedOn: "2026-11-15" }),
  });
  const today = calculateTradeInvoiceMoney({ grossEarned: 1000, gstOn: false, earningsDate: "2026-11-15" });
  assertEquals(before, today);
  assertEquals(before.super_amount, 120);
  assertEquals(before.net_pay, 940);
  assert(!("super_basis" in before));
});

Deno.test("switch off, or no start date: today's rule for every week", () => {
  for (const state of [{ on: false, startsOn: "2026-11-16" }, { on: true, startsOn: null }]) {
    assertEquals(chooseTradeInvoiceSuperBasis(state, { weekStart: "2026-11-23", pricedOn: "2026-11-29" }), null);
  }
});

Deno.test("a group share keeps its group's rule", () => {
  const state = { on: true, startsOn: "2026-11-16" };
  assertEquals(
    chooseTradeInvoiceSuperBasis(state, { groupBasis: TRADE_INVOICE_EMPLOYER_SUPER_BASIS, weekStart: "2026-11-16", pricedOn: "2026-11-22" }),
    TRADE_INVOICE_EMPLOYER_SUPER_BASIS,
  );
  assertEquals(
    chooseTradeInvoiceSuperBasis(state, { carriesGroupShare: true, weekStart: "2026-11-16", pricedOn: "2026-11-22" }),
    null,
  );
  assertEquals(linesCarryGroupShare([{ line_type: "group share" }]), true);
  assertEquals(linesCarryGroupShare([{ group_share_id: "x", line_type: "labour" }]), true);
  assertEquals(linesCarryGroupShare([{ line_type: "labour" }]), false);
});

function fakeClient(tables: Record<string, { data?: unknown; error?: unknown }>) {
  const reads: string[] = [];
  return {
    reads,
    from(table: string) {
      reads.push(table);
      const result = tables[table] ?? { data: [], error: null };
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        limit: () => Promise.resolve(result),
      };
      return builder;
    },
  };
}

Deno.test("the switch and start date are read; missing switch is off", async () => {
  assertEquals(await readTradeSuperInclusiveState(fakeClient({})), { ok: true, on: false, startsOn: null });
  const off = fakeClient({ feature_flags: { data: [{ enabled: false }] } });
  assertEquals(await readTradeSuperInclusiveState(off), { ok: true, on: false, startsOn: null });
  assertEquals(off.reads, ["feature_flags"]);
  const on = fakeClient({
    feature_flags: { data: [{ enabled: true }] },
    trade_super_inclusive_settings: { data: [{ starts_on: "2026-11-16" }] },
  });
  assertEquals(await readTradeSuperInclusiveState(on), { ok: true, on: true, startsOn: "2026-11-16" });
  assertEquals(
    await resolveTradeInvoiceSuperBasisForSubmit(on, { weekStart: "2026-11-16", pricedOn: "2026-11-22" }),
    INCLUSIVE,
  );
});

Deno.test("an unreadable rule refuses a submit and shows today's rule on a preview", async () => {
  const broken = fakeClient({ feature_flags: { error: { message: "down" } } });
  await assertRejects(
    () => resolveTradeInvoiceSuperBasisForSubmit(broken, { weekStart: "2026-11-16", pricedOn: "2026-11-22" }),
    TradeSuperInclusiveUnreadable,
  );
  assertEquals(
    await resolveTradeInvoiceSuperBasisForPreview(broken, { weekStart: "2026-11-16", pricedOn: "2026-11-22" }),
    null,
  );
  const badDate = fakeClient({
    feature_flags: { data: [{ enabled: true }] },
    trade_super_inclusive_settings: { error: { message: "down" } },
  });
  await assertRejects(
    () => resolveTradeInvoiceSuperBasisForSubmit(badDate, { pricedOn: "2026-11-22" }),
    TradeSuperInclusiveUnreadable,
  );
  // A group share never needs the switch.
  assertEquals(
    await resolveTradeInvoiceSuperBasisForSubmit(broken, { carriesGroupShare: true, pricedOn: "2026-11-22" }),
    null,
  );
});

const LINES: TradeInvoiceXeroLine[] = [
  { Description: "ZZTEST labour", Quantity: 28, UnitAmount: 40, AccountCode: "310" } as any,
  { Description: "ZZTEST materials", Quantity: 1, UnitAmount: 200, AccountCode: "310" } as any,
];

Deno.test("the Xero draft bill carries the three figures and passes the returned split check", () => {
  const m = inclusive(1320, 200);
  const lines = splitTradeInvoiceXeroLines(LINES, m, { superAccountCode: "478", tradeName: "ZZTEST Crew" });
  assertEquals(lines.length, 3);
  const superLine = lines[2];
  assertEquals(superLine.UnitAmount, -120);
  assertEquals(superLine.TaxType, "NONE");
  const text = String(superLine.Description);
  assert(text.startsWith("Superannuation Guarantee"));
  assertStringIncludes(text, "Total $1320.00");
  assertStringIncludes(text, "Paid to you $1200.00");
  assertStringIncludes(text, "Paid to your super fund $120.00");
  // Nothing on top: the job cost reader of company contributions finds none.
  assert(!/company contribution/i.test(text));
  const billTotal = lines.reduce((s, l) => s + Number(l.Quantity ?? 1) * Number(l.UnitAmount ?? 0), 0);
  assertEquals(Math.round(billTotal * 100) / 100, 1200);

  // Xero hands the lines back with LineAmount: the split check passes.
  const returned = lines.map((l) => ({
    ...l,
    LineAmount: Math.round(Number(l.Quantity ?? 1) * Number(l.UnitAmount ?? 0) * 100) / 100,
  }));
  assertReturnedTradeInvoiceXeroSplit(returned, m);

  const pdf = buildTradeInvoiceAuditText(buildTradeInvoiceAuditModel(LINES, m, "ZZTEST Crew"), {
    invoiceNumber: "ZZTEST-1",
    tradeName: "ZZTEST Crew",
  }).join("\n");
  assertStringIncludes(pdf, "Total $1320.00");
  assertStringIncludes(pdf, "Paid to you $1200.00");
  assertStringIncludes(pdf, "Paid to your super fund $120.00");
});

Deno.test("a stored inclusive invoice validates, presents the three figures, and its base must match its lines", () => {
  const stored = {
    gst_on: false,
    super_rate: 0.12,
    super_amount: 120,
    gross_earned: 1320,
    net_pay: 1200,
    super_basis: INCLUSIVE,
    super_base_ex: 1120,
    subtotal_ex: 1320,
    gst: 0,
    total_inc: 1320,
    week_end: "2026-11-22",
  };
  const money = validatePersistedTradeInvoiceMoney(stored);
  assertEquals(money.super_amount, 120);
  const presented = presentTradeInvoiceMoney(stored);
  assertEquals(presented.super_inclusive, { total: 1320, paid_to_you: 1200, paid_to_super_fund: 120 });
  assertEquals(presented.trade_payable, 1200);
  // Base matches the stored lines.
  assertTradeInvoiceSuperBaseMatchesLines(money, 0, 200);
  // A materials line changed after pricing: refused before Xero.
  assertThrows(() => assertTradeInvoiceSuperBaseMatchesLines(money, 0, 100));
  assertThrows(() => assertTradeInvoiceSuperBaseMatchesLines(money, 0, 0));
  // 12% of the total stamped inclusive: refused.
  assertThrows(() => validatePersistedTradeInvoiceMoney({ ...stored, super_base_ex: null, super_amount: 158.4, net_pay: 1161.6 }));
  // An old-rule invoice presents no new figures.
  const old = presentTradeInvoiceMoney({
    gst_on: false, super_rate: 0.12, super_amount: 120, gross_earned: 1000, net_pay: 940,
    subtotal_ex: 1000, gst: 0, total_inc: 1000, week_end: "2026-11-15",
  });
  assert(!("super_inclusive" in old));
});

Deno.test("job cost: employer super on top is zero for an inclusive invoice", () => {
  // 20261030170000 trade_employer_super: super_amount - (subtotal_ex - net_pay).
  for (const [gross, reimb] of [[1120, 0], [1320, 200], [1000.02, 0], [57.5, 12.25]]) {
    const m = inclusive(gross, reimb);
    assertEquals(Math.round((m.super_amount - (m.gross_earned - m.net_pay)) * 100) / 100, 0);
  }
});
