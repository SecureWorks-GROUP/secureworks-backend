import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fyStartFor, fyLabelFor, summariseTradeMoney, superMarkedPaidWords, tradeMoneyRow } from "./trade_money.ts";

const paid = tradeMoneyRow({
  id: "i1", invoice_number: "SW-INV-H-260801-020", week_end: "2026-08-02", status: "paid", xero_bill_status: "PAID",
  paid_at: "2026-08-10", amount_paid: 2420.6, gross_earned: 2470, super_amount: 296.4, gst: 247, gst_on: true, trade_payable: 2420.6, total_inc: 2717,
});
const owed = tradeMoneyRow({
  id: "i2", invoice_number: "SW-INV-H-260904-026", week_end: "2026-09-06", status: "pushed_to_xero", xero_bill_status: "AUTHORISED",
  amount_paid: 0, gross_earned: 1000, super_amount: 120, gst: 100, gst_on: true, trade_payable: 980, total_inc: 1100,
});
const legacy = tradeMoneyRow({ id: "i3", week_end: "2026-09-06", status: "pushed_to_xero", xero_bill_status: "DRAFT", total_inc: 500, amount_paid: 0, figures_error: "MONEY_SPLIT_INVALID" });
const voided = tradeMoneyRow({ id: "i4", week_end: "2026-09-06", status: "pushed_to_xero", xero_bill_status: "VOIDED", trade_payable: 300, total_inc: 330 });
const draft = tradeMoneyRow({ id: "i5", week_end: "2026-09-13", status: "draft", trade_payable: 200, total_inc: 220 });

Deno.test("financial year starts 1 July", () => {
  assertEquals(fyStartFor("2026-09-08"), "2026-07-01");
  assertEquals(fyStartFor("2026-03-01"), "2025-07-01");
  assertEquals(fyLabelFor("2026-09-08"), "FY 2026/27");
});

Deno.test("row: paid invoice has no outstanding; owed invoice is payable minus paid", () => {
  assertEquals(paid.paid, true);
  assertEquals(paid.outstanding, 0);
  assertEquals(paid.payable, 2420.6);
  assertEquals(owed.paid, false);
  assertEquals(owed.outstanding, 980);
  assertEquals(owed.bucket, "2026-09");
});

Deno.test("row: a legacy row with a bad split is listed, counts its cash, and is flagged", () => {
  assertEquals(legacy.figures_ok, false);
  assertEquals(legacy.gross_earned, null);
  assertEquals(legacy.payable, 500);
  assertEquals(legacy.counts, true);
  assertEquals(typeof legacy.figures_note, "string");
});

Deno.test("row: voided bills and released drafts never count", () => {
  assertEquals(voided.counts, false);
  assertEquals(voided.outstanding, 0);
  assertEquals(draft.counts, false);
});

Deno.test("summary: this month, FYTD, all time and month buckets", () => {
  const s = summariseTradeMoney([paid, owed, legacy, voided, draft], "2026-09-08");
  assertEquals(s.fy_label, "FY 2026/27");
  assertEquals(s.month.invoices, 2);
  assertEquals(s.month.payable, 1480);
  assertEquals(s.month.outstanding, 1480);
  assertEquals(s.month.figures_incomplete, 1);
  assertEquals(s.fytd.invoices, 3);
  assertEquals(s.fytd.gross_earned, 3470);
  assertEquals(s.fytd.super_amount, 416.4);
  assertEquals(s.fytd.gst, 347);
  assertEquals(s.fytd.paid_total, 2420.6);
  assertEquals(s.fytd.outstanding, 1480);
  assertEquals(s.all_time.invoices, 3);
  assertEquals(s.months.map((m) => m.month), ["2026-09", "2026-08"]);
  assertEquals(s.months[1].label, "Aug 2026");
  assertEquals(s.invoices.length, 5, "every row is listed, counted or not");
});

Deno.test("summary: an invoice from last financial year is all-time only", () => {
  const old = tradeMoneyRow({ id: "o", week_end: "2026-05-03", status: "paid", xero_bill_status: "PAID", trade_payable: 100, amount_paid: 100, total_inc: 110 });
  const s = summariseTradeMoney([old, owed], "2026-09-08");
  assertEquals(s.fytd.invoices, 1);
  assertEquals(s.all_time.invoices, 2);
  assertEquals(s.months.length, 2);
  const s2 = summariseTradeMoney([old, owed], "2026-09-08", 3);
  assertEquals(s2.months.length, 1, "months window trims old buckets");
});

import { readTradePayHistory } from "./trade_pay_history_read.ts";
import { TRADE_PREVIEW_READS } from "./trade_owner_preview.ts";

type TestRow = Record<string, any>;
const historyToday = "2026-09-08";
function invoice(id: string, week: string, end: string, overrides: TestRow = {}): TestRow {
  return {
    id, invoice_number: id, user_id: "trade-a", week_start: week, week_end: end,
    status: "approved", gst_on: false, gst: 0, super_rate: 0.12, super_basis: "inclusive_12_112_v1",
    gross_earned: 112.01, subtotal_ex: 112.01, total_inc: 112.01, super_amount: 12,
    net_pay: 100.01, amount_paid: 0, pay_run_id: null, xero_bill_id: "bill-" + id, reimbursements: [], ...overrides,
  };
}

function historyStore() {
  const tables: Record<string, TestRow[]> = {
    trade_invoices: [
      invoice("a1", "2026-08-24", "2026-08-30", { amount_paid: 23.45, pay_run_id: "closed" }),
      invoice("a2", "2026-08-24", "2026-08-30", { gross_earned: 115.02, total_inc: 115.02,
        subtotal_ex: 115.02, super_base_ex: 112.01, net_pay: 103.02, pay_run_id: "open" }),
      invoice("a3", "2026-08-31", "2026-09-06", { super_basis: null, gross_earned: 100,
        subtotal_ex: 100, total_inc: 100, super_amount: 12, net_pay: 94, amount_paid: 94 }),
      invoice("b", "2026-08-31", "2026-09-06", { user_id: "trade-b", pay_run_id: "other" }),
    ],
    trade_pay_runs: [{ id: "closed", super_marked_paid_at: historyToday }, { id: "open", super_marked_paid_at: null },
      { id: "other", super_marked_paid_at: historyToday }],
    trade_rates: [{ user_id: "trade-b", id: "r3", effective_from: "2026-05-01", hourly_rate: 9 },
      { user_id: "trade-a", id: "r2", effective_from: "2026-05-01", hourly_rate: 2 },
      { user_id: "trade-a", id: "r1", effective_from: "2026-01-01", hourly_rate: 1 }],
    trade_pay_settings: [{ id: 1, tax_set_aside_percent: 20 }],
  };
  const state = { fault: "", noRunColumn: false, reads: [] as string[] };
  const client = { from(table: string) {
    state.reads.push(table);
    let rows = [...tables[table]];
    let fields = "";
    const sorting: string[] = [];
    const result = () => {
      if (state.fault === table) return { data: null, error: { code: "57014", message: "private detail" } };
      if (state.noRunColumn && fields.endsWith(",pay_run_id")) {
        return { data: null, error: { code: "42703", message: "column trade_invoices.pay_run_id does not exist" } };
      }
      return { data: rows.map(row => {
        if (table === "trade_invoices" && !fields.includes("reimbursements:")) {
          return Object.fromEntries(fields.split(",").map(key => [key, row[key]]));
        }
        const copy = { ...row };
        if (!fields.includes("pay_run_id")) delete copy.pay_run_id;
        return copy;
      }), error: null };
    };
    const q = {
      select(cols: string) { fields = cols; return q; },
      eq(key: string, value: unknown) {
        if (key !== "reimbursements.line_type") rows = rows.filter(row => row[key] === value);
        return q;
      },
      not(key: string, _op: string, list: string) {
        rows = rows.filter(row => !list.slice(1, -1).split(",").includes(row[key]));
        return q;
      },
      or(filter: string) {
        const floor = filter.split(",")[0].split(".")[2];
        rows = rows.filter(row => row.week_end === null || row.week_end >= floor);
        return q;
      },
      lt(key: string, value: string) { rows = rows.filter(row => row[key] != null && row[key] < value); return q; },
      in(key: string, ids: string[]) { rows = rows.filter(row => ids.includes(row[key])); return result(); },
      order(key: string) { sorting.push(key); return q; },
      range(start: number, end: number) {
        rows.sort((a, b) => {
          for (const key of sorting) {
            const cmp = String(a[key]).localeCompare(String(b[key]));
            if (cmp) return cmp;
          }
          return 0;
        });
        rows = rows.slice(start, end + 1);
        return result();
      },
      limit() { return result(); },
    };
    return q;
  } };
  return { client, tables, state };
}

Deno.test("pay history: the office's super stamp is shown as a Perth day", () => {
  assertEquals(superMarkedPaidWords("2026-11-17T17:30:00Z"), { marked_paid_on: "2026-11-18", words: "Marked paid by the office on 18 Nov 2026" });
  assertThrows(() => superMarkedPaidWords("not a date"));
});

Deno.test("pay history: three invoices reconcile across weeks, months, FY, super and tax", async () => {
  const { client } = historyStore();
  const { status, body } = await readTradePayHistory(client, "trade-a", historyToday, null);
  assertEquals(status, 200);
  assert("weeks" in body);
  const august = { total_inc_super: 224.02, paid_to_super: 24, paid_to_you: 200.02, reimbursements: 3.01, paid_into_bank: 23.45, invoices: 2 };
  const september = { total_inc_super: 106, paid_to_super: 12, paid_to_you: 94, reimbursements: 0, paid_into_bank: 94, invoices: 1 };
  const fy = { total_inc_super: 330.02, paid_to_super: 36, paid_to_you: 294.02, reimbursements: 3.01, paid_into_bank: 117.45, invoices: 3 };
  assertEquals(body.weeks, [{ week_start: "2026-08-31", ...september }, { week_start: "2026-08-24", ...august }]);
  assertEquals(body.months, [{ month: "2026-09", label: "Sep 2026", ...september }, { month: "2026-08", label: "Aug 2026", ...august }]);
  assertEquals(body.years, [{ fy_label: "FY 2026/27", ...fy }]);
  assertEquals(body.this_year_vs_last.this_fy, fy);
  assertEquals(body.super.since_start, 36);
  assertEquals(body.super.not_recorded_count, 0);
  assertEquals(body.super.this_fy, 36);
  assertEquals(body.super.by_invoice.map(row => [row.invoice_id, row.status]), [
    ["a3", "to_be_paid"], ["a2", "to_be_paid"], ["a1", "marked_paid_by_office"],
  ]);
  // Director 15:22: the office marked it paid; My pay never says it reached the fund.
  const marked = body.super.by_invoice.find(row => row.invoice_id === "a1");
  assertEquals([marked?.marked_paid_on, marked?.words], ["2026-09-08", "Marked paid by the office on 8 Sep 2026"]);
  assert(!JSON.stringify(body).toLowerCase().includes("fund"), "no fund wording anywhere in My pay");
  assertEquals(body.super.by_invoice.find(row => row.invoice_id === "a2")?.words, undefined);
  assertEquals(body.tax_set_aside, { percent: 20, this_fy_amount: 58.8 });
  assertEquals(body.rate_history, [{ effective_from: "2026-01-01", hourly_rate: 1 }, { effective_from: "2026-05-01", hourly_rate: 2 }]);

  const other = await readTradePayHistory(client, "trade-b", historyToday, "1");
  assert("super" in other.body);
  assertEquals(other.body.super.by_invoice.map(row => row.invoice_id), ["b"]);
  assertEquals(other.body.super.since_start, 12);
  assertEquals(other.body.rate_history, [{ effective_from: "2026-05-01", hourly_rate: 9 }]);
});

Deno.test("history uses the legacy invoice total and counts unrecorded super across the trade's lifetime", async () => {
  const { tables, client } = historyStore();
  const legacySplit = { super_amount: null, super_basis: null, super_rate: null, net_pay: null,
    total_inc: 22.11, gst: 2.01, amount_paid: 7.07 };
  tables.trade_invoices.push(
    invoice("legacy", "2026-08-31", "2026-09-06", legacySplit),
    invoice("prior", "2024-01-01", "2024-01-07", legacySplit),
    invoice("void", "2024-01-01", "2024-01-07", { ...legacySplit, xero_bill_status: "VOIDED" }),
    invoice("future", "2026-09-14", "2026-09-20", legacySplit),
    invoice("other", "2026-08-31", "2026-09-06", { ...legacySplit, user_id: "trade-b" }),
  );
  const read = () => readTradePayHistory(client, "trade-a", historyToday, "1");
  const { status, body } = await read();
  assertEquals(status, 200);
  assert("weeks" in body);
  const week = { total_inc_super: 128.11, paid_to_you: 116.11, paid_to_super: 12, reimbursements: 0,
    paid_into_bank: 101.07, invoices: 2 };
  assertEquals(body.weeks[0], { week_start: "2026-08-31", ...week });
  assertEquals(body.months[0], { month: "2026-09", label: "Sep 2026", ...week });
  assertEquals(body.this_year_vs_last.this_fy, { total_inc_super: 352.13, paid_to_you: 316.13,
    paid_to_super: 36, reimbursements: 3.01, paid_into_bank: 124.52, invoices: 4 });
  assertEquals(body.super.since_start, 36);
  assertEquals(body.super.not_recorded_count, 2);
  assertEquals(body.super.by_invoice.find(i => i.invoice_id === "legacy"), {
    invoice_id: "legacy", invoice_number: "legacy", week_start: "2026-08-31", amount: 0, status: "not_recorded",
  });
  assertEquals(body.tax_set_aside?.this_fy_amount, 63.22);
  const legacy = tables.trade_invoices.find(i => i.id === "legacy")!;
  legacy.net_pay = 1;
  assertEquals(await read(), { status, body });
  legacy.total_inc = null;
  assertEquals((await read()).status, 503);
});

Deno.test("an invoice with no Xero bill is listed as not_in_xero and left out of every paid and super total", async () => {
  const { tables, client } = historyStore();
  const legacySplit = { super_amount: null, super_basis: null, super_rate: null, net_pay: null,
    total_inc: 22.11, gst: 2.01, amount_paid: 7.07 };
  const read = (years: string | null = "1") => readTradePayHistory(client, "trade-a", historyToday, years);
  tables.trade_invoices.push(invoice("legacy", "2026-08-31", "2026-09-06", legacySplit));
  const baseline = await read();
  assert("super" in baseline.body);
  assertEquals(baseline.body.super.not_in_xero_count, 0);

  tables.trade_invoices.push(
    // Recent, recorded super, never pushed: on paid and super totals it would add 12 super and 100.01 paid.
    invoice("unbilled", "2026-08-31", "2026-09-06", { xero_bill_id: null, amount_paid: 5, pay_run_id: "closed" }),
    // Recent legacy split with no bill: not_in_xero wins over not_recorded.
    invoice("unbilled-legacy", "2026-08-24", "2026-08-30", { ...legacySplit, xero_bill_id: "" }),
    // Older than the read window: kept out of lifetime super.
    invoice("unbilled-old", "2024-01-01", "2024-01-07", { xero_bill_id: null }),
    // A voided bill stays out entirely, as on main.
    invoice("void-unbilled", "2026-08-31", "2026-09-06", { xero_bill_id: null, xero_bill_status: "VOIDED" }),
    // Another trade's unbilled invoice never reaches this trade.
    invoice("other-unbilled", "2026-08-31", "2026-09-06", { user_id: "trade-b", xero_bill_id: null }),
  );
  const { status, body } = await read();
  assertEquals(status, 200);
  assert("super" in body && "super" in baseline.body);
  assertEquals(body.weeks, baseline.body.weeks);
  assertEquals(body.months, baseline.body.months);
  assertEquals(body.years, baseline.body.years);
  assertEquals(body.this_year_vs_last, baseline.body.this_year_vs_last);
  assertEquals(body.tax_set_aside, baseline.body.tax_set_aside);
  assertEquals(body.super.this_fy, baseline.body.super.this_fy);
  assertEquals(body.super.since_start, baseline.body.super.since_start);
  assertEquals(body.super.not_recorded_count, baseline.body.super.not_recorded_count);
  assertEquals(body.super.not_recorded_count, 1);
  assertEquals(body.super.not_in_xero_count, 3);
  assertEquals(body.super.by_invoice.filter(i => i.status === "not_in_xero"), [
    { invoice_id: "unbilled", invoice_number: "unbilled", week_start: "2026-08-31", amount: 0, status: "not_in_xero" },
    { invoice_id: "unbilled-legacy", invoice_number: "unbilled-legacy", week_start: "2026-08-24", amount: 0, status: "not_in_xero" },
  ]);
  assertEquals(body.super.by_invoice.find(i => i.invoice_id === "a1")?.status, "marked_paid_by_office");
  assertEquals(body.super.by_invoice.find(i => i.invoice_id === "legacy")?.status, "not_recorded");

  // The office pushes the bill: a retry counts it like any other invoice.
  tables.trade_invoices.find(i => i.id === "unbilled")!.xero_bill_id = "bill-pushed";
  const pushed = await read();
  assert("super" in pushed.body);
  assertEquals(pushed.body.super.not_in_xero_count, 2);
  assertEquals(pushed.body.super.since_start, baseline.body.super.since_start + 12);
  assertEquals(pushed.body.super.by_invoice.find(i => i.invoice_id === "unbilled")?.status, "marked_paid_by_office");

  // A row returned without the bill column refuses rather than counting as billed or unbilled.
  delete tables.trade_invoices.find(i => i.id === "a2")!.xero_bill_id;
  assertEquals((await read()).status, 503);
});

Deno.test("missing super on an invoice with a recorded basis still refuses recent and older reads", async () => {
  const { tables, client } = historyStore();
  const row = invoice("partial", "2026-08-31", "2026-09-06", { super_amount: null });
  tables.trade_invoices.push(row);
  const read = () => readTradePayHistory(client, "trade-a", historyToday, "1");
  assertEquals((await read()).status, 503);
  row.week_end = "2024-01-07";
  assertEquals((await read()).status, 503);
  row.super_basis = null;
  assertEquals((await read()).status, 200);
});

Deno.test("one-year history still compares to the same point last FY and counts lifetime super", async () => {
  const { tables, client } = historyStore();
  tables.trade_invoices.push(invoice("on", "2025-09-08", "2025-09-08"), invoice("after", "2025-09-08", "2025-09-09"),
    invoice("older", "2024-01-01", "2024-01-07"), invoice("future", "2026-09-14", "2026-09-20"));
  for (const status of ["draft", "ops-reject", "failed"]) tables.trade_invoices.push(invoice(status, "", historyToday, { status }));
  tables.trade_invoices.push(invoice("void", "", historyToday, { xero_bill_status: "VOIDED", net_pay: null }));
  const { body } = await readTradePayHistory(client, "trade-a", historyToday, "1");
  assert("weeks" in body);
  assertEquals(body.years?.length, 1);
  assertEquals(body.this_year_vs_last?.last_fy_same_point.paid_to_you, 100.01);
  assertEquals(body.super?.since_start, 72);
  assertEquals(body.super?.by_invoice.length, 3);
});

Deno.test("only the missing pay-run column falls back; a failed read or missing figure refuses and can be retried", async () => {
  const { tables, client, state } = historyStore();
  const read = () => readTradePayHistory(client, "trade-a", historyToday, null);
  for (const table of Object.keys(tables)) {
    state.fault = table;
    const { status, body } = await read();
    assertEquals(status, 503);
    assertEquals(body, { code: "pay_history_unreadable", error: "Could not read your pay history. Try again." });
  }
  state.fault = "";
  tables.trade_invoices[0].amount_paid = null;
  assertEquals((await read()).status, 503);
  tables.trade_invoices[0].amount_paid = 7.19;
  tables.trade_pay_settings[0].tax_set_aside_percent = null;
  state.noRunColumn = true;
  const { body } = await read();
  assert("weeks" in body);
  assertEquals(body.super?.by_invoice.every(i => i.status === "to_be_paid"), true);
  assertEquals(body.tax_set_aside, null);
  assertEquals(body.this_year_vs_last?.this_fy.paid_into_bank, 101.19);
  tables.trade_pay_settings.length = 0;
  assertEquals((await read()).status, 503);
});

Deno.test("history requires a signed-in trade and valid range before any pay read; preview cannot select someone else", async () => {
  const { state, client } = historyStore();
  assertEquals((await readTradePayHistory(client, "", historyToday, null)).status, 401);
  for (const years of ["0", "8", "1.5"]) {
    assertEquals((await readTradePayHistory(client, "trade-a", historyToday, years)).status, 400);
  }
  assertEquals(state.reads, []);
  assertEquals(TRADE_PREVIEW_READS.has("my_pay_history"), false);
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const route = index.slice(index.indexOf("case 'my_pay_history': {")).split("\n          }")[0];
  assertEquals(route.includes("readTradePayHistory(client, tradeUser.id, getAWSTDate(), url.searchParams.get('years'))"), true);
  assertEquals(route.includes("req.method !== 'GET'"), true);
});

Deno.test("history pages beyond 250 invoices and only trims the displayed periods", async () => {
  const { client, tables } = historyStore();
  tables.trade_invoices = [];
  for (let n = 0; n < 260; n++) {
    const date = new Date(Date.UTC(2031, 8, 7 - n * 7));
    const end = date.toISOString().slice(0, 10);
    date.setUTCDate(date.getUTCDate() - 6);
    tables.trade_invoices.push(invoice(String(n), date.toISOString().slice(0, 10), end));
  }
  const { body } = await readTradePayHistory(client, "trade-a", "2031-09-08", "7");
  assert("weeks" in body);
  assertEquals(body.weeks?.length, 26);
  assertEquals(body.months?.length, 24);
  assertEquals(body.super?.by_invoice.length, 260);
  assertEquals(body.years?.reduce((sum, y) => sum + y.invoices, 0), 260);
});

Deno.test("history sums a recorded older split before the pricing calculator's first supported date", async () => {
  const { client, tables } = historyStore();
  tables.trade_invoices = [invoice("early", "2024-09-02", "2024-09-08", {
    super_basis: null, super_rate: 0.115, gross_earned: 19.85, subtotal_ex: 19.85, total_inc: 19.85,
    net_pay: 19.85, super_amount: 2.28, amount_paid: 18,
  })];
  const { body } = await readTradePayHistory(client, "trade-a", historyToday, "7");
  assert("years" in body);
  assertEquals(body.years, [{ fy_label: "FY 2024/25", total_inc_super: 22.13, paid_to_you: 19.85,
    paid_to_super: 2.28, reimbursements: 0, paid_into_bank: 18, invoices: 1 }]);
});
