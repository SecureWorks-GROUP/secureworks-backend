// deno-lint-ignore-file no-explicit-any no-import-prefix
import "./trade_app_visibility_rules_test_env.ts";
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeTime } from "https://deno.land/std@0.224.0/testing/time.ts";
import {
  _labourReconciliationForTest,
  _listTradeInvoicesForTest,
  _setTradeRateForTest,
  _tradeLabourBudgetForTest,
  ApiError,
} from "./index.ts";

type Row = Record<string, any>;
const today = "2031-02-11";
const changeDay = "2031-02-17";
const oldRate = () => ({
  id: "rate-old-fixture",
  user_id: "trade-fixture",
  hourly_rate: 23,
  effective_from: "2031-01-01",
  effective_to: null,
});
const nextRate = () => ({
  ...oldRate(),
  id: "rate-future-fixture",
  hourly_rate: 31,
  effective_from: changeDay,
});

/** In-memory PostgREST boundary: filters, ordering and writes affect stored rows. */
function store(rates: Row[], fault?: "select" | "update") {
  const tables: Record<string, Row[]> = {
    trade_rates: structuredClone(rates),
    trade_invoices: [],
    purchase_orders: [],
    jobs: [{
      id: "job-fixture",
      job_number: "ZZTEST",
      type: "fencing",
      pricing_json: {},
    }],
    job_assignments: [],
  };
  const writes: string[] = [];
  const reads: string[] = [];
  const client = {
    from(table: string) {
      const predicates: Array<(r: Row) => boolean> = [];
      let operation = "select", values: Row = {}, limit = Infinity;
      let sort: { key: string; ascending: boolean } | undefined;
      const predicate = (key: string, op: string, value: any) => (r: Row) => {
        if (op === "is") return (r[key] ?? null) === value;
        if (op === "eq") return r[key] === value;
        if (op === "neq") return r[key] !== value;
        if (r[key] == null) return false;
        if (op === "gt") return r[key] > value;
        if (op === "gte") return r[key] >= value;
        if (op === "lte") return r[key] <= value;
        throw new Error(`unsupported ${op}`);
      };
      const run = () => {
        if (operation === "select") reads.push(table);
        if (table === "trade_rates" && operation === fault) {
          return {
            data: null,
            error: new Error("fixture rate read/write failed"),
          };
        }
        let rows = (tables[table] || []).filter((r) =>
          predicates.every((p) => p(r))
        );
        if (sort) {
          const { key, ascending } = sort;
          rows.sort((a, b) =>
            String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1)
          );
        }
        rows = rows.slice(0, limit);
        if (operation !== "select") writes.push(operation);
        if (operation === "update") {
          rows.forEach((r) => Object.assign(r, values));
        }
        if (operation === "insert") {
          const inserted = {
            id: "rate-inserted-fixture",
            effective_to: null,
            ...values,
          };
          tables[table].push(inserted);
          rows = [inserted];
        }
        return { data: rows, error: null };
      };
      const query: any = {
        select: () => query,
        eq: (k: string, v: any) => {
          predicates.push(predicate(k, "eq", v));
          return query;
        },
        neq: (k: string, v: any) => {
          predicates.push(predicate(k, "neq", v));
          return query;
        },
        is: (k: string, v: any) => {
          predicates.push(predicate(k, "is", v));
          return query;
        },
        gt: (k: string, v: any) => {
          predicates.push(predicate(k, "gt", v));
          return query;
        },
        lte: (k: string, v: any) => {
          predicates.push(predicate(k, "lte", v));
          return query;
        },
        not: (k: string, op: string, v: any) => {
          predicates.push((r) => !predicate(k, op, v)(r));
          return query;
        },
        or: (terms: string) => {
          const alternatives = terms.split(",").map((term) => {
            const [key, op, raw] = term.split(".");
            return predicate(key, op, raw === "null" ? null : raw);
          });
          predicates.push((r) => alternatives.some((p) => p(r)));
          return query;
        },
        order: (key: string, opts: any = {}) => {
          sort = { key, ascending: opts.ascending !== false };
          return query;
        },
        limit: (n: number) => {
          limit = n;
          return query;
        },
        update: (row: Row) => {
          operation = "update";
          values = row;
          return query;
        },
        insert: (row: Row) => {
          operation = "insert";
          values = row;
          return query;
        },
        single: () => {
          const r = run();
          return Promise.resolve({ ...r, data: r.data?.[0] ?? null });
        },
        maybeSingle: () => {
          const r = run();
          return Promise.resolve({ ...r, data: r.data?.[0] ?? null });
        },
        then: (resolve: any, reject: any) =>
          Promise.resolve(run()).then(resolve, reject),
      };
      return query;
    },
  };
  return { client, tables, writes, reads };
}

async function onDay(day: string, run: () => Promise<void>) {
  using _time = new FakeTime(`${day}T04:00:00Z`);
  await run();
}

Deno.test("Set Rate refuses a scheduled future row before changing any rate", () =>
  onDay(today, async () => {
    const s = store([oldRate(), nextRate()]);
    const before = structuredClone(s.tables.trade_rates);
    const error = await assertRejects(
      () =>
        _setTradeRateForTest(s.client, null, {
          user_id: "trade-fixture",
          hourly_rate: 29,
        }),
      ApiError,
    );
    assertEquals(error.status, 409);
    assertEquals(
      error.message,
      `This trade has a new rate starting ${changeDay}. Nothing was changed. Tell the director if the rate needs to change before then.`,
    );
    assertEquals(s.tables.trade_rates, before);
    assertEquals(s.writes, []);
  }));

Deno.test("Set Rate without a future row keeps main's close-and-insert behaviour", () =>
  onDay(today, async () => {
    const s = store([oldRate()]);
    const out = await _setTradeRateForTest(s.client, null, {
      user_id: "trade-fixture",
      hourly_rate: 29,
    });
    assertEquals(out.success, true);
    assertEquals(s.tables.trade_rates[0].effective_to, "2031-02-10");
    assertEquals(out.rate.hourly_rate, 29);
    assertEquals(out.rate.effective_from, today);
    assertEquals(out.rate.effective_to, null);
    assertEquals(s.writes, ["update", "insert"]);
  }));

Deno.test("Set Rate also refuses a bounded future row", () =>
  onDay(today, async () => {
    const s = store([oldRate(), { ...nextRate(), effective_to: "2031-02-28" }]);
    await assertRejects(
      () =>
        _setTradeRateForTest(s.client, null, {
          user_id: "trade-fixture",
          hourly_rate: 29,
        }),
      ApiError,
    );
    assertEquals(s.writes, []);
  }));

Deno.test("Set Rate does not write if future-rate lookup or current-rate close fails", () =>
  onDay(today, async () => {
    for (const fault of ["select", "update"] as const) {
      const s = store([oldRate()], fault);
      await assertRejects(() =>
        _setTradeRateForTest(s.client, null, {
          user_id: "trade-fixture",
          hourly_rate: 29,
        })
      );
      assertEquals(s.writes, []);
    }
  }));

Deno.test("Set Rate keeps trade callers refused", () =>
  onDay(today, async () => {
    const s = store([oldRate()]);
    const error = await assertRejects(
      () =>
        _setTradeRateForTest(s.client, "trade-fixture", { hourly_rate: 29 }),
      ApiError,
    );
    assertEquals(error.status, 403);
    assertEquals(s.writes, []);
  }));

for (const day of [today, changeDay]) {
  Deno.test(`Ops rate panel reads the effective row on ${day}`, () =>
    onDay(day, async () => {
      const s = store([
        { ...oldRate(), effective_to: "2031-02-16" },
        nextRate(),
      ]);
      const out = await _listTradeInvoicesForTest(
        s.client,
        new URLSearchParams(),
      );
      assertEquals(out.rates.map((r: Row) => r.hourly_rate), [
        day === today ? 23 : 31,
      ]);
      assertEquals(s.writes, []);
    }));
}

Deno.test("Ops rate panel with no future rows returns the same open rate as main", () =>
  onDay(today, async () => {
    const s = store([oldRate(), {
      ...oldRate(),
      effective_from: "2030-01-01",
      effective_to: "2030-12-31",
    }]);
    const out = await _listTradeInvoicesForTest(
      s.client,
      new URLSearchParams(),
    );
    assertEquals(out.rates, [{
      ...oldRate(),
      set_by_kind: "not_recorded",
      set_by_name: null,
    }]);
  }));

function attendance(day: string) {
  return {
    job_id: "job-fixture",
    user_id: "trade-fixture",
    scheduled_date: day,
    status: "complete",
    started_at: `${day}T00:00:00Z`,
    completed_at: `${day}T02:00:00Z`,
  };
}

Deno.test("Ops rate panel keeps only the newest effective row per person", () =>
  onDay(changeDay, async () => {
    const s = store([
      oldRate(),
      nextRate(),
      { ...oldRate(), user_id: "second-trade-fixture" },
    ]);
    const out = await _listTradeInvoicesForTest(
      s.client,
      new URLSearchParams(),
    );
    assertEquals(out.rates.map((row: Row) => [row.user_id, row.hourly_rate]), [
      ["trade-fixture", 31],
      ["second-trade-fixture", 23],
    ]);
    assertEquals(s.writes, []);
  }));

const costScreens = {
  office: (s: ReturnType<typeof store>) =>
    _labourReconciliationForTest(
      s.client,
      new URLSearchParams({ job_id: "job-fixture" }),
    ),
  lead: (s: ReturnType<typeof store>) =>
    _tradeLabourBudgetForTest(
      s.client,
      new URLSearchParams({ job_id: "job-fixture" }),
      "office-fixture",
      true,
    ),
};
for (const [label, screen] of Object.entries(costScreens)) {
  Deno.test(`${label} labour screen costs each attendance on its work date across the change`, () =>
    onDay(today, async () => {
      const s = store([
        { ...oldRate(), effective_to: "2031-02-16" },
        nextRate(),
      ]);
      s.tables.job_assignments = [attendance(today), attendance(changeDay)];
      const out = await screen(s);
      assertEquals(out.trades[0].hours, 4);
      assertEquals(out.trades[0].cost, 108);
      assertEquals(out.trades[0].rate, 27);
      assertEquals(out.total_labour_cost ?? out.total_cost, 108);
      assertEquals(
        s.reads.filter((table) => table === "trade_rates").length,
        1,
      );
      assertEquals(s.writes, []);
    }));

  Deno.test(`${label} labour screen with no future rows keeps main's result`, () =>
    onDay(today, async () => {
      const s = store([oldRate()]);
      s.tables.job_assignments = [attendance(today), attendance("2031-02-10")];
      const out = await screen(s);
      assertEquals(
        out.trades.map((r: Row) => ({
          hours: r.hours,
          rate: r.rate,
          cost: r.cost,
        })),
        [{ hours: 4, rate: 23, cost: 92 }],
      );
      assertEquals(
        out.trades[0].name,
        label === "office" ? "Unknown" : "Trade",
      );
    }));

  Deno.test(`${label} labour screen falls back to the Perth start day when undated`, () =>
    onDay(today, async () => {
      const s = store([
        { ...oldRate(), effective_to: "2031-02-16" },
        nextRate(),
      ]);
      s.tables.job_assignments = [{
        ...attendance(today),
        scheduled_date: null,
        started_at: "2031-02-16T16:30:00Z",
        completed_at: "2031-02-16T18:30:00Z",
      }];
      const out = await screen(s);
      assertEquals(out.trades[0].rate, 31);
      assertEquals(out.trades[0].cost, 62);
    }));

  Deno.test(`${label} labour screen reads once per trade and respects gaps in rate history`, () =>
    onDay(today, async () => {
      const s = store([
        { ...oldRate(), effective_to: "2031-02-10" },
        nextRate(),
        { ...oldRate(), user_id: "second-trade-fixture", hourly_rate: 17 },
      ]);
      s.tables.job_assignments = [
        attendance(today),
        attendance(changeDay),
        { ...attendance(today), user_id: "second-trade-fixture" },
        { ...attendance(changeDay), user_id: "second-trade-fixture" },
      ];
      const out = await screen(s);
      assertEquals(
        out.trades.map((row: Row) => ({
          user_id: row.user_id,
          cost: row.cost,
        })),
        [
          { user_id: "trade-fixture", cost: 62 },
          { user_id: "second-trade-fixture", cost: 68 },
        ],
      );
      assertEquals(
        s.reads.filter((table) => table === "trade_rates").length,
        2,
      );
    }));
}
