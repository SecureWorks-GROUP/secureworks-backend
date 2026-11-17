// One super rule (P1-01.3): which rule prices an invoice. The switch
// trade_pay_inclusive_super_v1 and trade_pay_settings.inclusive_super_from
// decide it by the invoice's pay day. Stand-in figures only.
// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { TRADE_INVOICE_INCLUSIVE_SUPER_BASIS } from "./trade_invoice_money.ts";
import {
  readTradePayRule,
  resolveTradePayBasisForPreview,
  resolveTradePayBasis,
  TRADE_PAY_INCLUSIVE_FLAG,
  tradePayBasisFor,
  TradePayRuleUnreadable,
  tradePayStoredBasis,
} from "./trade_pay_rule.ts";

const INCLUSIVE = TRADE_INVOICE_INCLUSIVE_SUPER_BASIS;
const FROM = "2026-12-07"; // a made-up Monday

Deno.test("pay rule: off, no date, the day before, the day of, the day after, no day", () => {
  assertEquals(tradePayBasisFor({ on: false, from: FROM }, "2026-12-07"), null);
  assertEquals(tradePayBasisFor({ on: true, from: null }, "2026-12-07"), null);
  assertEquals(tradePayBasisFor({ on: true, from: FROM }, "2026-12-06"), null);
  assertEquals(tradePayBasisFor({ on: true, from: FROM }, "2026-12-07"), INCLUSIVE);
  assertEquals(tradePayBasisFor({ on: true, from: FROM }, "2026-12-08"), INCLUSIVE);
  assertEquals(tradePayBasisFor({ on: true, from: FROM }, null), null);
  assertEquals(tradePayBasisFor({ on: true, from: FROM }, "not a day"), null);
});

Deno.test("pay rule: spec test 7, the week decides, not the day it is sent", () => {
  const rule = { on: true, from: FROM };
  // The week of 30 Nov, sent on 9 Dec: the caller passes week_start.
  assertEquals(tradePayBasisFor(rule, "2026-11-30"), null);
  assertEquals(tradePayBasisFor(rule, "2026-12-07"), INCLUSIVE);
});

type Reply = { data?: unknown; error?: unknown };

function fakeClient(tables: { feature_flags?: Reply; trade_pay_settings?: Reply; throws?: boolean }) {
  const seen: Array<{ table: string; filters: Record<string, unknown> }> = [];
  return {
    seen,
    from(table: string) {
      if (tables.throws) throw new Error("network down");
      const filters: Record<string, unknown> = {};
      const chain: any = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        limit: () => {
          seen.push({ table, filters });
          return Promise.resolve((tables as any)[table] ?? { data: [], error: null });
        },
      };
      return chain;
    },
  };
}

Deno.test("pay rule: reads the switch and the start date; a missing switch or row is off", async () => {
  const client = fakeClient({
    feature_flags: { data: [{ enabled: true }], error: null },
    trade_pay_settings: { data: [{ inclusive_super_from: FROM }], error: null },
  });
  assertEquals(await readTradePayRule(client), { ok: true, on: true, from: FROM });
  assertEquals(client.seen, [
    { table: "feature_flags", filters: { flag_name: TRADE_PAY_INCLUSIVE_FLAG } },
    { table: "trade_pay_settings", filters: { id: 1 } },
  ]);
  assertEquals(
    await readTradePayRule(fakeClient({ feature_flags: { data: [], error: null }, trade_pay_settings: { data: [], error: null } })),
    { ok: true, on: false, from: null },
  );
});

Deno.test("pay rule: spec test 8, an unreadable rule refuses a submit and shows no money on a preview", async () => {
  for (
    const client of [
      fakeClient({ feature_flags: { data: [{ enabled: true }], error: null }, trade_pay_settings: { data: null, error: { message: "boom" } } }),
      fakeClient({ feature_flags: { data: null, error: { message: "boom" } }, trade_pay_settings: { data: [], error: null } }),
      fakeClient({ feature_flags: { data: [{ enabled: true }], error: null }, trade_pay_settings: { data: [{ inclusive_super_from: 7 }], error: null } }),
      fakeClient({ throws: true }),
    ]
  ) {
    const err = await assertRejects(() => resolveTradePayBasis(client, null, FROM), TradePayRuleUnreadable);
    assertEquals((err as TradePayRuleUnreadable).code, "pay_rule_unreadable");
    assertEquals(await resolveTradePayBasisForPreview(client, null, FROM), { basis: null, unavailable: true });
  }
});

Deno.test("pay rule: with the switch off, a fault reading the start date still prices on the old rule", async () => {
  for (
    const settings of [
      { data: null, error: { message: "relation does not exist" } },
      { data: [{ inclusive_super_from: 7 }], error: null },
    ]
  ) {
    const client = () => fakeClient({ feature_flags: { data: [{ enabled: false }], error: null }, trade_pay_settings: settings });
    assertEquals(await readTradePayRule(client()), { ok: true, on: false, from: null });
    assertEquals(await resolveTradePayBasis(client(), null, FROM), null);
    assertEquals(await resolveTradePayBasisForPreview(client(), null, FROM), { basis: null, unavailable: false });
  }
});

Deno.test("pay rule: a readable rule prices a submit and a preview the same way", async () => {
  const client = () =>
    fakeClient({
      feature_flags: { data: [{ enabled: true }], error: null },
      trade_pay_settings: { data: [{ inclusive_super_from: FROM }], error: null },
    });
  assertEquals(await resolveTradePayBasis(client(), null, "2026-12-14"), INCLUSIVE);
  assertEquals(await resolveTradePayBasis(client(), null, "2026-11-30"), null);
  assertEquals(await resolveTradePayBasisForPreview(client(), null, "2026-12-14"), { basis: INCLUSIVE, unavailable: false });
});

Deno.test("pay rule: a priced stored invoice keeps its basis; only a new or unpriced one reads the switch", async () => {
  let reads = 0;
  const counting = {
    from(table: string) {
      reads += 1;
      const rows = table === "feature_flags"
        ? [{ enabled: true }]
        : [{ inclusive_super_from: FROM }];
      const query: any = {
        select: () => query,
        eq: () => query,
        limit: () => Promise.resolve({ data: rows, error: null }),
      };
      return query;
    },
  };
  const day = "2026-12-14";
  const cases: Array<[unknown, string | null, number]> = [
    [null, INCLUSIVE, 2],
    [{ gross_earned: null, super_basis: null }, INCLUSIVE, 2],
    [{ gross_earned: 100, super_basis: null }, null, 0],
    [{ gross_earned: 100, super_basis: INCLUSIVE }, INCLUSIVE, 0],
  ];
  for (const [prior, basis, expectedReads] of cases) {
    reads = 0;
    assertEquals(await resolveTradePayBasis(counting, prior as any, day), basis);
    assertEquals(reads, expectedReads);
  }
  assertEquals(tradePayStoredBasis({ gross_earned: 0, super_basis: null }), { priced: true, basis: null });
  const err = await assertRejects(
    () => resolveTradePayBasis(counting, { gross_earned: 100, super_basis: "made_up_v9" }, day),
    TradePayRuleUnreadable,
  );
  assertEquals(err.code, "pay_rule_unreadable");
});

const undatedDraft = { status: "draft", invoice_source: "hourly", week_start: null, week_end: null, gross_earned: 1120, super_basis: null };
const changeoverClient = (on = true, fail = false) => fakeClient({
  feature_flags: { data: [{ enabled: on }] },
  trade_pay_settings: fail ? { error: "unreadable" } : { data: [{ inclusive_super_from: "2026-11-23" }] },
});

Deno.test("pay rule: an undated draft dated 22 Nov stays old; 23 Nov and later are inclusive", async () => {
  for (const [day, expected] of [["2026-11-22", null], ["2026-11-23", INCLUSIVE], ["2026-11-24", INCLUSIVE]] as const) {
    assertEquals(await resolveTradePayBasis(changeoverClient(), undatedDraft, day), expected);
  }
});

Deno.test("pay rule: undated draft off or missing start keeps stored basis; unreadable refuses then retries", async () => {
  assertEquals(await resolveTradePayBasis(changeoverClient(false, true), undatedDraft, "2026-11-23"), null);
  assertEquals(await resolveTradePayBasis(changeoverClient(false), { ...undatedDraft, super_basis: INCLUSIVE }, "2026-11-23"), INCLUSIVE);
  assertEquals(await resolveTradePayBasis(fakeClient({ feature_flags: { data: [{ enabled: true }] } }), undatedDraft, "2026-11-23"), null);
  await assertRejects(() => resolveTradePayBasis(changeoverClient(true, true), undatedDraft, "2026-11-23"), TradePayRuleUnreadable);
  assertEquals(await resolveTradePayBasis(changeoverClient(), undatedDraft, "2026-11-23"), INCLUSIVE);
});

Deno.test("pay rule: office-dated or non-draft stored invoices never change basis", async () => {
  for (const prior of [
    { ...undatedDraft, week_start: "2026-11-16", week_end: "2026-11-22" },
    { ...undatedDraft, week_start: "2026-11-16" },
    { ...undatedDraft, week_end: "2026-11-22" },
    { ...undatedDraft, status: "submitted" },
    { ...undatedDraft, invoice_source: "work_order" },
    { ...undatedDraft, invoice_source: undefined },
  ]) {
    assertEquals(await resolveTradePayBasis(fakeClient({ throws: true }), prior, "2026-11-23"), null);
  }
});
