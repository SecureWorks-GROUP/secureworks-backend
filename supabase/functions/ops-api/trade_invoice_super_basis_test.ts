/**
 * Super on top for one trade's own invoices (owner, 11 Nov 2026).
 *
 * Covers trade_invoice_super_basis.ts:
 *   1. the rule: no setting is the ordinary split; a setting in effect on the
 *      earnings day prices the invoice on top and names its row; a setting
 *      that has ended, has not started, is another trade's or carries an
 *      unknown basis does nothing; a group share keeps the group's basis;
 *   2. the money: on top, the trade is paid the submitted total in full, the
 *      company pays the whole 12%, and Job Profit's company super
 *      (super_amount - (subtotal_ex - net_pay)) is the full 12%, not 6%;
 *   3. the office switch: on adds one dated row with who set it, on twice
 *      adds nothing, off ends the row the day before, off on the same day
 *      leaves it covering no day, and a bad request changes nothing;
 *   4. the wiring: every place ops-api prices a trade's own invoice asks this
 *      module, the trade's own profile action cannot reach the setting, and
 *      the migration is the one this code needs.
 */
// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculateTradeInvoiceMoney,
  splitTradeInvoiceXeroLines,
  TRADE_INVOICE_EMPLOYER_SUPER_BASIS,
  validatePersistedTradeInvoiceMoney,
} from "./trade_invoice_money.ts";
import {
  decideTradeInvoiceSuperBasis,
  loadTradeInvoiceSuperBasis,
  ORDINARY_TRADE_SUPER_BASIS,
  setTradeSuperOnTop,
  tradeSuperBasisInvoiceFields,
  TradeSuperBasisError,
  type TradeSuperBasisSetting,
  tradeSuperBasisSettingOn,
} from "./trade_invoice_super_basis.ts";

const ANN = "f1110000-0000-4000-8000-00000000000a";
const BOB = "f1110000-0000-4000-8000-00000000000b";
const ORG = "00000000-0000-0000-0000-000000000001";

function setting(
  overrides: Partial<TradeSuperBasisSetting> = {},
): TradeSuperBasisSetting {
  return {
    id: "5e770000-0000-4000-8000-000000000001",
    user_id: ANN,
    super_basis: TRADE_INVOICE_EMPLOYER_SUPER_BASIS,
    effective_from: "2026-11-02",
    effective_to: null,
    created_by: "user:office",
    created_at: "2026-11-02T01:00:00Z",
    ...overrides,
  };
}

/** A PostgREST-shaped client over two in-memory tables. */
function fakeClient(seed: {
  settings?: TradeSuperBasisSetting[];
  users?: Array<{ id: string; org_id: string }>;
  failRead?: boolean;
}) {
  const settings: any[] = [...(seed.settings || [])];
  const users = seed.users || [{ id: ANN, org_id: ORG }, {
    id: BOB,
    org_id: ORG,
  }];
  const writes: Array<{ op: string; row: any }> = [];
  const from = (table: string) => {
    const filters: Array<(row: any) => boolean> = [];
    let op: "select" | "insert" | "update" = "select";
    let patch: any = null;
    const rows = () => table === "users" ? users : settings;
    const run = () => {
      if (seed.failRead && table !== "users" && op === "select") {
        return { data: null, error: { message: "unreadable" } };
      }
      if (op === "insert") {
        if (
          settings.some((r) =>
            r.user_id === patch.user_id && r.effective_to == null
          )
        ) {
          return { data: null, error: { code: "23505", message: "one open" } };
        }
        const row = {
          id: `5e770000-0000-4000-8000-${
            String(settings.length + 2).padStart(12, "0")
          }`,
          effective_to: null,
          created_at: "2026-11-11T02:00:00Z",
          ...patch,
        };
        settings.push(row);
        writes.push({ op, row });
        return { data: [row], error: null };
      }
      const hit = rows().filter((row) => filters.every((f) => f(row)));
      if (op === "update") {
        for (const row of hit) Object.assign(row, patch);
        writes.push({ op, row: { ...patch } });
      }
      return { data: hit, error: null };
    };
    const q: any = {
      select: () => q,
      insert: (row: any) => {
        op = "insert";
        patch = row;
        return q;
      },
      update: (row: any) => {
        op = "update";
        patch = row;
        return q;
      },
      eq: (col: string, value: unknown) => {
        filters.push((row) => row[col] === value);
        return q;
      },
      is: (col: string, value: unknown) => {
        filters.push((row) => (row[col] ?? null) === value);
        return q;
      },
      lte: (col: string, value: string) => {
        filters.push((row) => String(row[col]) <= value);
        return q;
      },
      order: () => q,
      limit: () => q,
      maybeSingle: () => {
        const out = run();
        return Promise.resolve({
          data: out.data ? out.data[0] ?? null : null,
          error: out.error,
        });
      },
      single: () => {
        const out = run();
        return Promise.resolve({
          data: out.data ? out.data[0] ?? null : null,
          error: out.error,
        });
      },
      then: (resolve: any, reject: any) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return q;
  };
  return { client: { from }, settings, writes };
}

// ── 1. The rule ─────────────────────────────────────────────────────

Deno.test("no setting is the ordinary split", () => {
  assertEquals(tradeSuperBasisSettingOn([], ANN, "2026-11-08"), null);
  assertEquals(
    decideTradeInvoiceSuperBasis({ hasGroupShare: false, setting: null }),
    ORDINARY_TRADE_SUPER_BASIS,
  );
  assertEquals(tradeSuperBasisInvoiceFields(ORDINARY_TRADE_SUPER_BASIS), {});
});

Deno.test("a setting in effect on the earnings day prices the invoice on top", () => {
  const row = setting();
  assertEquals(tradeSuperBasisSettingOn([row], ANN, "2026-11-08"), row);
  assertEquals(tradeSuperBasisSettingOn([row], ANN, "2026-11-02"), row);
  const decision = decideTradeInvoiceSuperBasis({
    hasGroupShare: false,
    setting: row,
  });
  assertEquals(decision, {
    superBasis: TRADE_INVOICE_EMPLOYER_SUPER_BASIS,
    settingId: row.id,
  });
  assertEquals(tradeSuperBasisInvoiceFields(decision), {
    super_basis_setting_id: row.id,
  });
});

Deno.test("a setting that does not cover the day, or is not this trade's, does nothing", () => {
  assertEquals(tradeSuperBasisSettingOn([setting()], ANN, "2026-11-01"), null);
  assertEquals(
    tradeSuperBasisSettingOn(
      [setting({ effective_to: "2026-11-08" })],
      ANN,
      "2026-11-15",
    ),
    null,
  );
  // Turned off the day it was turned on: it covers no day.
  assertEquals(
    tradeSuperBasisSettingOn(
      [setting({ effective_to: "2026-11-01" })],
      ANN,
      "2026-11-02",
    ),
    null,
  );
  assertEquals(tradeSuperBasisSettingOn([setting()], BOB, "2026-11-08"), null);
  assertEquals(
    tradeSuperBasisSettingOn(
      [setting({ super_basis: "something_else" })],
      ANN,
      "2026-11-08",
    ),
    null,
  );
  assertEquals(tradeSuperBasisSettingOn([setting()], ANN, "not a day"), null);
});

Deno.test("a group share keeps the group's basis whatever the trade's setting", async () => {
  assertEquals(
    decideTradeInvoiceSuperBasis({
      hasGroupShare: true,
      groupSuperBasis: null,
      setting: setting(),
    }),
    { superBasis: null, settingId: null },
  );
  assertEquals(
    decideTradeInvoiceSuperBasis({
      hasGroupShare: true,
      groupSuperBasis: TRADE_INVOICE_EMPLOYER_SUPER_BASIS,
      setting: null,
    }),
    { superBasis: TRADE_INVOICE_EMPLOYER_SUPER_BASIS, settingId: null },
  );
  // The setting is not even read for a group share.
  const { client } = fakeClient({ settings: [setting()], failRead: true });
  assertEquals(
    await loadTradeInvoiceSuperBasis(client, {
      userId: ANN,
      earningsDay: "2026-11-08",
      hasGroupShare: true,
      groupSuperBasis: null,
    }),
    { superBasis: null, settingId: null },
  );
});

Deno.test("the stored setting is read for the trade and the day; an unreadable one refuses", async () => {
  const row = setting();
  const { client } = fakeClient({ settings: [row] });
  assertEquals(
    await loadTradeInvoiceSuperBasis(client, {
      userId: ANN,
      earningsDay: "2026-11-08",
      hasGroupShare: false,
    }),
    { superBasis: TRADE_INVOICE_EMPLOYER_SUPER_BASIS, settingId: row.id },
  );
  assertEquals(
    await loadTradeInvoiceSuperBasis(client, {
      userId: BOB,
      earningsDay: "2026-11-08",
      hasGroupShare: false,
    }),
    ORDINARY_TRADE_SUPER_BASIS,
  );
  const broken = fakeClient({ settings: [row], failRead: true });
  const error = await assertRejects(
    () =>
      loadTradeInvoiceSuperBasis(broken.client, {
        userId: ANN,
        earningsDay: "2026-11-08",
        hasGroupShare: false,
      }),
    TradeSuperBasisError,
  );
  assertEquals(error.status, 503);
});

// ── 2. The money ────────────────────────────────────────────────────

Deno.test("on top pays the submitted total in full and the company the whole 12%", () => {
  const ordinary = calculateTradeInvoiceMoney({
    grossEarned: 1000,
    gstOn: false,
    earningsDate: "2026-11-08",
  });
  const onTop = calculateTradeInvoiceMoney({
    grossEarned: 1000,
    gstOn: false,
    earningsDate: "2026-11-08",
    superBasis: TRADE_INVOICE_EMPLOYER_SUPER_BASIS,
  });
  assertEquals(ordinary.net_pay, 940);
  assertEquals(ordinary.super_basis ?? null, null);
  assertEquals(onTop.net_pay, 1000);
  assertEquals(onTop.worker_withhold, 0);
  assertEquals(onTop.super_amount, 120);
  assertEquals(onTop.company_contribution, 120);
  assertEquals(onTop.company_total_out, 1120);
  assertEquals(onTop.super_basis, TRADE_INVOICE_EMPLOYER_SUPER_BASIS);
  // Job Profit's company super for the invoice (v_job_cost_events:
  // super_amount - (subtotal_ex - net_pay)).
  const jobProfitSuper = (m: typeof onTop) =>
    Math.round((m.super_amount - (m.gross_earned - m.net_pay)) * 100) / 100;
  assertEquals(jobProfitSuper(onTop), 120);
  assertEquals(jobProfitSuper(ordinary), 60);
  // GST is still 10% of the submitted total, on top of the full pay.
  const withGst = calculateTradeInvoiceMoney({
    grossEarned: 1000,
    gstOn: true,
    earningsDate: "2026-11-08",
    superBasis: TRADE_INVOICE_EMPLOYER_SUPER_BASIS,
  });
  assertEquals(withGst.gst_amount, 100);
  assertEquals(withGst.trade_payable, 1100);
});

Deno.test("a saved on-top invoice re-checks and bills Xero at the full amount with several lines", () => {
  const persisted = validatePersistedTradeInvoiceMoney({
    subtotal_ex: 1000,
    gross_earned: 1000,
    net_pay: 1000,
    gst: 0,
    gst_on: false,
    total_inc: 1000,
    super_rate: 0.12,
    super_amount: 120,
    super_basis: TRADE_INVOICE_EMPLOYER_SUPER_BASIS,
    week_start: "2026-11-02",
    week_end: "2026-11-08",
  });
  assertEquals(persisted.net_pay, 1000);
  assertEquals(persisted.worker_withhold, 0);
  const lines = splitTradeInvoiceXeroLines(
    [
      { Description: "Mon", Quantity: 8, UnitAmount: 50 },
      { Description: "Tue", Quantity: 8, UnitAmount: 50 },
      { Description: "Travel", Quantity: 1, UnitAmount: 200 },
    ] as any,
    persisted,
    { tradeName: "Ann Synthetic", superAccountCode: "000" } as any,
  ) as any[];
  const total = lines.reduce(
    (sum, line) => sum + Number(line.Quantity) * Number(line.UnitAmount),
    0,
  );
  assertEquals(Math.round(total * 100) / 100, 1000);
  const superLine = lines.find((line) =>
    String(line.Description).includes("Superannuation Guarantee")
  );
  assert(superLine, "the super line is still on the bill");
  assertEquals(Math.abs(Number(superLine.UnitAmount)), 0);
  assert(String(superLine.Description).includes("paid by the company on top"));
  assert(!String(superLine.Description).includes("group share"));
});

// ── 3. The office switch ────────────────────────────────────────────

Deno.test("on adds one dated row with who set it; on twice adds nothing", async () => {
  const { client, settings } = fakeClient({});
  const first = await setTradeSuperOnTop(client, {
    userId: ANN,
    on: true,
    actor: "user:office",
    today: "2026-11-11",
  });
  assertEquals(first.super_on_top, true);
  assertEquals(first.changed, true);
  assertEquals(settings.length, 1);
  assertEquals(settings[0].user_id, ANN);
  assertEquals(settings[0].org_id, ORG);
  assertEquals(settings[0].super_basis, TRADE_INVOICE_EMPLOYER_SUPER_BASIS);
  assertEquals(settings[0].effective_from, "2026-11-11");
  assertEquals(settings[0].created_by, "user:office");
  const again = await setTradeSuperOnTop(client, {
    userId: ANN,
    on: true,
    actor: "user:other",
    today: "2026-11-12",
  });
  assertEquals(again.changed, false);
  assertEquals(settings.length, 1);
  // The office can start it from an earlier day.
  const backdated = await setTradeSuperOnTop(client, {
    userId: BOB,
    on: true,
    effectiveFrom: "2026-11-02",
    actor: "user:office",
    today: "2026-11-11",
  });
  assertEquals(backdated.setting?.effective_from, "2026-11-02");
});

Deno.test("off ends the row the day before and keeps it as history", async () => {
  const { client, settings } = fakeClient({ settings: [setting()] });
  const off = await setTradeSuperOnTop(client, {
    userId: ANN,
    on: false,
    actor: "user:office",
    today: "2026-11-11",
  });
  assertEquals(off.super_on_top, false);
  assertEquals(off.changed, true);
  assertEquals(settings.length, 1);
  assertEquals(settings[0].effective_to, "2026-11-10");
  assertEquals(settings[0].ended_by, "user:office");
  // The week that ended before it was turned off keeps it; the next does not.
  assert(tradeSuperBasisSettingOn(settings, ANN, "2026-11-08"));
  assertEquals(tradeSuperBasisSettingOn(settings, ANN, "2026-11-15"), null);
  const again = await setTradeSuperOnTop(client, {
    userId: ANN,
    on: false,
    actor: "user:office",
    today: "2026-11-11",
  });
  assertEquals(again.changed, false);
});

Deno.test("off on the day it was turned on leaves it covering no day", async () => {
  const { client, settings } = fakeClient({
    settings: [setting({ effective_from: "2026-11-11" })],
  });
  await setTradeSuperOnTop(client, {
    userId: ANN,
    on: false,
    actor: "user:office",
    today: "2026-11-11",
  });
  assertEquals(settings[0].effective_to, "2026-11-10");
  assertEquals(tradeSuperBasisSettingOn(settings, ANN, "2026-11-15"), null);
  assertEquals(tradeSuperBasisSettingOn(settings, ANN, "2026-11-11"), null);
});

Deno.test("a bad request changes nothing", async () => {
  const { client, writes } = fakeClient({});
  for (
    const input of [
      { userId: "", on: true },
      { userId: ANN, on: "yes" },
      { userId: ANN, on: true, effectiveFrom: "2026-13-40" },
      { userId: "f1110000-0000-4000-8000-0000000000ff", on: true },
    ]
  ) {
    await assertRejects(
      () =>
        setTradeSuperOnTop(client, {
          ...input,
          actor: "user:office",
          today: "2026-11-11",
        } as any),
      TradeSuperBasisError,
    );
  }
  assertEquals(writes.length, 0);
});

// ── 4. The wiring ───────────────────────────────────────────────────

const HERE = new URL(".", import.meta.url);
const INDEX_SRC = await Deno.readTextFile(new URL("index.ts", HERE));
const RUNNING_SRC = await Deno.readTextFile(
  new URL("trade_invoice_running_draft.ts", HERE),
);
const MIGRATION_SRC = await Deno.readTextFile(
  new URL(
    "../../migrations/20261111173000_trade_super_on_top.sql",
    HERE,
  ),
);

Deno.test("every place ops-api prices a trade's own invoice asks the rule", () => {
  // Submit, draft save, the hours preview and the legacy submit.
  for (
    const call of [
      "tradeInvoiceMoney(subtotal, gstOn, invoiceEarningsDate, invoiceSuperBasis.superBasis)",
      "tradeInvoiceMoney(draftSubtotal, draftGstOn, draftWeekEnd, draftSuperBasis.superBasis)",
      "tradeInvoiceMoney(subtotal, previewGstOn, weekEnding, previewSuperBasis.superBasis)",
      "tradeInvoiceMoney(subtotal, stGstOn, week_ending, stSuperBasis.superBasis)",
    ]
  ) {
    assert(INDEX_SRC.includes(call), `missing: ${call}`);
  }
  // Each saved header names the setting that priced it.
  for (
    const fields of [
      "...tradeSuperBasisInvoiceFields(invoiceSuperBasis)",
      "...tradeSuperBasisInvoiceFields(draftSuperBasis)",
      "...tradeSuperBasisInvoiceFields(stSuperBasis)",
    ]
  ) {
    assert(INDEX_SRC.includes(fields), `missing: ${fields}`);
  }
  assertEquals(
    INDEX_SRC.split("...tradeSuperBasisInvoiceFields(draftSuperBasis)").length -
      1,
    2,
  );
  // The running draft prices its header the same way.
  assert(RUNNING_SRC.includes("superBasis: superBasis.superBasis"));
  assert(RUNNING_SRC.includes("...tradeSuperBasisInvoiceFields(superBasis)"));
  assert(
    RUNNING_SRC.includes(
      "headerFor(user, weekStart, weekEnd, notes, gstOn, lines, superBasis)",
    ),
  );
  // A group release is decided by the group's basis, not the invoice's.
  assert(
    INDEX_SRC.includes("officeReviewHold && groupInvoiceBasis.superBasis"),
  );
  assert(!INDEX_SRC.includes("officeReviewHold && money.super_basis"));
});

Deno.test("only the office action writes the setting", () => {
  assertEquals(INDEX_SRC.split("setTradeSuperOnTop(client").length - 1, 1);
  assert(INDEX_SRC.includes("case 'set_trade_super_on_top_ops':"));
  // The table is named in the rule module only; no trade action can address it.
  assert(!INDEX_SRC.includes("trade_super_bases"));
  assert(!RUNNING_SRC.includes("trade_super_bases"));
});

Deno.test("the migration is the one this code needs", () => {
  assert(
    MIGRATION_SRC.includes(
      "CREATE TABLE IF NOT EXISTS public.trade_super_bases",
    ),
  );
  assert(
    MIGRATION_SRC.includes(
      "REVOKE ALL ON TABLE public.trade_super_bases FROM PUBLIC, anon, authenticated",
    ),
  );
  assert(
    MIGRATION_SRC.includes("ADD COLUMN IF NOT EXISTS super_basis_setting_id"),
  );
  assert(MIGRATION_SRC.includes("i.super_basis_setting_id IS NULL"));
  assert(!/INSERT INTO public\.trade_super_bases/i.test(MIGRATION_SRC));
  assert(!/UPDATE public\.trade_invoices/i.test(MIGRATION_SRC));
});
