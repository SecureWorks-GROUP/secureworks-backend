// deno-lint-ignore-file no-explicit-any no-import-prefix
/**
 * Trade Bills lists every stuck invoice (saved, no Xero bill), whatever its
 * week, so the office can always reach the button that clears it. The
 * newest-50-by-week read alone missed old stuck invoices.
 */
import "./trade_app_visibility_rules_test_env.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _listTradeInvoicesForTest, STUCK_TRADE_BILLS_CAP } from "./index.ts";

type Row = Record<string, any>;

/** A PostgREST stand-in that honours the filters, order and limit the list uses. */
function tableClient(tables: Record<string, Row[]>) {
  const reads: Array<{ table: string; filters: string[] }> = [];
  const from = (table: string) => {
    const preds: Array<(row: Row) => boolean> = [];
    const filters: string[] = [];
    let orderBy: { column: string; ascending: boolean } | null = null;
    let limitN: number | null = null;
    reads.push({ table, filters });
    const run = () => {
      let rows = (tables[table] || []).filter((row) => preds.every((p) => p(row)));
      if (orderBy) {
        const { column, ascending } = orderBy;
        rows = [...rows].sort((a, b) => {
          const cmp = String(a?.[column] ?? "").localeCompare(String(b?.[column] ?? ""));
          return ascending ? cmp : -cmp;
        });
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    };
    const api: any = {
      select: () => api,
      order(column: string, opts: { ascending?: boolean } = {}) {
        orderBy = { column, ascending: opts.ascending !== false };
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      eq(column: string, value: unknown) {
        filters.push(`${column}=${value}`);
        preds.push((row) => String(row?.[column] ?? "") === String(value));
        return api;
      },
      is(column: string, value: unknown) {
        filters.push(`${column} is ${value}`);
        preds.push((row) => (row?.[column] ?? null) === value);
        return api;
      },
      not(column: string, op: string, value: unknown) {
        if (op !== "is") throw new Error(`unsupported not.${op}`);
        filters.push(`${column} not is ${value}`);
        preds.push((row) => (row?.[column] ?? null) !== value);
        return api;
      },
      then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
    };
    return api;
  };
  return { client: { from }, reads };
}

const day = (n: number) => new Date(Date.UTC(2026, 10, 2) - n * 7 * 86400000).toISOString().slice(0, 10);

function invoice(id: string, weeksAgo: number, extra: Row = {}): Row {
  const week = day(weeksAgo);
  return {
    id,
    week_start: week,
    status: "pushed_to_xero",
    xero_bill_id: `bill-${id}`,
    created_at: `${week}T02:00:00Z`,
    lines: [],
    ...extra,
  };
}

/** 60 recent weekly invoices, newest first by week: more than the list's 50. */
function recentWeekly(): Row[] {
  return Array.from({ length: 60 }, (_, i) => invoice(`recent-${i}`, i));
}

async function list(tables: Record<string, Row[]>, query = "") {
  const { client, reads } = tableClient({ trade_rates: [], ...tables });
  const out = await _listTradeInvoicesForTest(client, new URLSearchParams(query));
  return { out, reads, ids: out.invoices.map((row: Row) => row.id) as string[] };
}

Deno.test("an old stuck invoice outside the newest 50 is listed once", async () => {
  const stuck = invoice("stuck-old", 70, { status: "pending_acknowledgment", xero_bill_id: null });
  const { out, ids } = await list({ trade_invoices: [...recentWeekly(), stuck] });

  assertEquals(ids.filter((id) => id === "stuck-old").length, 1);
  // The newest 50 by week are still there, the old stuck one after them by week.
  assertEquals(ids.length, 51);
  assertEquals(ids.slice(0, 50), recentWeekly().slice(0, 50).map((row) => row.id));
  assertEquals(ids[50], "stuck-old");
  assertEquals(out.stuck_note, undefined);
});

Deno.test("an old invoice that is pushed, paid or has a bill is not added", async () => {
  const old = [
    invoice("old-pushed", 20),
    invoice("old-paid", 21, { status: "paid" }),
    invoice("old-pending-with-bill", 22, { status: "pending_acknowledgment", xero_bill_id: "bill-x" }),
    invoice("old-approved-no-bill", 23, { status: "approved", xero_bill_id: null }),
  ];
  // Twelve weeks of recent invoices push all of these past the newest 50.
  const recent = Array.from({ length: 50 }, (_, i) => invoice(`recent-${i}`, i % 12));
  const { ids } = await list({ trade_invoices: [...recent, ...old] });

  for (const id of ["old-pushed", "old-paid", "old-pending-with-bill", "old-approved-no-bill"]) {
    assertEquals(ids.includes(id), false, id);
  }
  assertEquals(ids.length, 50);
});

Deno.test("a stuck invoice already in the newest 50 is not listed twice", async () => {
  const rows = recentWeekly();
  rows[3] = { ...rows[3], status: "pending_acknowledgment", xero_bill_id: null };
  const { ids } = await list({ trade_invoices: rows });

  assertEquals(ids.filter((id) => id === rows[3].id).length, 1);
  assertEquals(new Set(ids).size, ids.length);
  assertEquals(ids, rows.slice(0, 50).map((row) => row.id));
});

Deno.test("an old stuck invoice with no week is listed once among the no-week ones", async () => {
  const noWeek = Array.from({ length: 55 }, (_, i) =>
    invoice(`noweek-${i}`, i, { week_start: null }));
  noWeek[54] = { ...noWeek[54], status: "pending_acknowledgment", xero_bill_id: null };
  const { ids } = await list({ trade_invoices: noWeek });

  assertEquals(ids.filter((id) => id === "noweek-54").length, 1);
  assertEquals(ids.length, 51);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("a list filtered to another status adds no stuck invoices and skips the read", async () => {
  const stuck = invoice("stuck-old", 70, { status: "pending_acknowledgment", xero_bill_id: null });
  const { ids, reads } = await list(
    { trade_invoices: [...recentWeekly(), stuck] },
    "status=pushed_to_xero",
  );
  assertEquals(ids.includes("stuck-old"), false);
  assertEquals(reads.filter((r) => r.table === "trade_invoices").length, 2);
});

Deno.test("a list filtered to pending acknowledgment still reaches old stuck invoices", async () => {
  const stuck = invoice("stuck-old", 70, { status: "pending_acknowledgment", xero_bill_id: null });
  const { ids } = await list(
    { trade_invoices: [...recentWeekly(), stuck] },
    "status=pending_acknowledgment",
  );
  assertEquals(ids, ["stuck-old"]);
});

Deno.test("the stuck read is bounded and says so when it hits the cap", async () => {
  const stuck = Array.from({ length: STUCK_TRADE_BILLS_CAP + 5 }, (_, i) =>
    invoice(`stuck-${i}`, 70 + i, { status: "pending_acknowledgment", xero_bill_id: null }));
  const { out, ids } = await list({ trade_invoices: [...recentWeekly(), ...stuck] });

  assertEquals(ids.filter((id) => id.startsWith("stuck-")).length, STUCK_TRADE_BILLS_CAP);
  assertEquals(new Set(ids).size, ids.length);
  assertEquals(typeof out.stuck_note, "string");
});

Deno.test("under the cap there is no stuck note", async () => {
  const stuck = Array.from({ length: STUCK_TRADE_BILLS_CAP }, (_, i) =>
    invoice(`stuck-${i}`, 70 + i, { status: "pending_acknowledgment", xero_bill_id: null }));
  const { out, ids } = await list({ trade_invoices: [...recentWeekly(), ...stuck] });
  assertEquals(ids.filter((id) => id.startsWith("stuck-")).length, STUCK_TRADE_BILLS_CAP);
  assertEquals("stuck_note" in out, false);
});
