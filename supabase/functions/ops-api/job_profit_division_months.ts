// deno-lint-ignore-file no-explicit-any
// Division x month totals on Xero's accounting basis for
// job_profit_list?view=division_months (finish line A3, 3 Nov 2026).
//
// Reads public.v_job_profit_division_months (migration 20261104235000) and
// sums nothing that view did not already add up: one row per division, month
// and side (revenue, cost), from v_job_profit_xero_basis_lines rows in the
// figure. Basis (CIO decision, 3 Nov 2026): the row's own Xero document date
// and Business Unit tracking (a crew line on its posted bill's date and that
// bill line's tracking, a placement on its bill, a credit on its credit note),
// employer super outside Cost of Sales, and Bookkeeping's overhead and "not a
// job cost" Cost of Sales lines as rows of their own (no job). Per-job figures
// (v_job_profit) are not changed by it, and each job's rows in that view add up
// to its v_job_profit figures to the cent.
//
// Money is read and summed in integer cents. A failed page fails the whole
// answer: a partial total is never returned. A division of null is
// "(no division)" (Xero holds the line with no Business Unit, or the job's
// number and type name none).

export type DivisionMonthsResult = {
  status: number;
  body: Record<string, unknown>;
};

const PAGE_SIZE = 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const NO_DIVISION_LABEL = "(no division)";

type Cell = {
  revenue: bigint;
  cost: bigint;
  overhead_cost: bigint;
  revenue_lines: number;
  cost_lines: number;
  cost_lines_division_from_job: number;
  revenue_lines_division_from_job: number;
};

function emptyCell(): Cell {
  return {
    revenue: 0n,
    cost: 0n,
    overhead_cost: 0n,
    revenue_lines: 0,
    cost_lines: 0,
    cost_lines_division_from_job: 0,
    revenue_lines_division_from_job: 0,
  };
}

// numeric arrives from PostgREST as a number or a string; null is 0 here only
// for the FILTER sums, which are null when no row matched.
function toCents(value: unknown, field: string): bigint {
  if (value === null || value === undefined) return 0n;
  const n = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(n)) {
    throw new Error(`v_job_profit_division_months.${field} is not a number`);
  }
  return BigInt(Math.round(n * 100));
}

function toCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function money(cents: bigint): number {
  return Number(cents) / 100;
}

function present(division: string | null, month: string | null, c: Cell) {
  return {
    division,
    division_label: division ?? NO_DIVISION_LABEL,
    month,
    revenue_ex: money(c.revenue),
    cost_ex: money(c.cost),
    gross_profit_ex: money(c.revenue - c.cost),
    overhead_cost_ex: money(c.overhead_cost),
    revenue_lines: c.revenue_lines,
    cost_lines: c.cost_lines,
    revenue_lines_division_from_job: c.revenue_lines_division_from_job,
    cost_lines_division_from_job: c.cost_lines_division_from_job,
  };
}

function addInto(target: Cell, c: Cell) {
  target.revenue += c.revenue;
  target.cost += c.cost;
  target.overhead_cost += c.overhead_cost;
  target.revenue_lines += c.revenue_lines;
  target.cost_lines += c.cost_lines;
  target.revenue_lines_division_from_job += c.revenue_lines_division_from_job;
  target.cost_lines_division_from_job += c.cost_lines_division_from_job;
}

/** The first day of the month a YYYY-MM-DD date falls in. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/**
 * ops-api `job_profit_list?view=division_months`: from and to (YYYY-MM-DD,
 * optional) choose the months by the month each date falls in. Work-type and
 * status filters do not apply (the figure covers every job and Bookkeeping's
 * overhead lines), so they are refused rather than ignored.
 */
export async function jobProfitDivisionMonthsAction(
  client: any,
  params: URLSearchParams,
  labels: Record<string, unknown>,
): Promise<DivisionMonthsResult> {
  for (const name of ["type", "status", "date_field"]) {
    if ((params.get(name) || "").trim()) {
      return {
        status: 400,
        body: {
          error:
            `${name} does not apply to view=division_months: the figure covers every job and Bookkeeping's overhead lines`,
        },
      };
    }
  }
  const from = (params.get("from") || "").trim() || null;
  const to = (params.get("to") || "").trim() || null;
  if (from && !DATE_RE.test(from)) {
    return { status: 400, body: { error: "from must be YYYY-MM-DD" } };
  }
  if (to && !DATE_RE.test(to)) {
    return { status: 400, body: { error: "to must be YYYY-MM-DD" } };
  }

  const cells = new Map<string, { division: string | null; month: string | null; cell: Cell }>();
  const asOf = new Date().toISOString();
  try {
    for (let offset = 0;; offset += PAGE_SIZE) {
      let query = client.from("v_job_profit_division_months").select(
        "division, month, side, amount_ex, overhead_rows_ex, lines, lines_division_from_job",
      );
      if (from) query = query.gte("month", monthStart(from));
      if (to) query = query.lte("month", monthStart(to));
      query = query.order("month", { ascending: true })
        .order("division", { ascending: true })
        .order("side", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      const { data, error } = await query;
      if (error) {
        return {
          status: 500,
          body: {
            error:
              `job profit division months read failed at row ${offset}: ${error.message}`,
          },
        };
      }
      const rows: Record<string, unknown>[] = data || [];
      for (const row of rows) {
        const division = typeof row.division === "string" && row.division
          ? row.division
          : null;
        const month = typeof row.month === "string" && row.month.length >= 7
          ? row.month.slice(0, 7)
          : null;
        const key = `${month ?? ""}|${division ?? ""}`;
        if (!cells.has(key)) cells.set(key, { division, month, cell: emptyCell() });
        const c = cells.get(key)!.cell;
        const amount = toCents(row.amount_ex, "amount_ex");
        if (row.side === "revenue") {
          c.revenue += amount;
          c.revenue_lines += toCount(row.lines);
          c.revenue_lines_division_from_job += toCount(row.lines_division_from_job);
        } else if (row.side === "cost") {
          c.cost += amount;
          c.overhead_cost += toCents(row.overhead_rows_ex, "overhead_rows_ex");
          c.cost_lines += toCount(row.lines);
          c.cost_lines_division_from_job += toCount(row.lines_division_from_job);
        } else {
          throw new Error(`v_job_profit_division_months.side is not revenue or cost: ${String(row.side)}`);
        }
      }
      if (rows.length < PAGE_SIZE) break;
    }
  } catch (err) {
    return {
      status: 500,
      body: {
        error: `job profit division months failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
    };
  }

  const ordered = [...cells.values()].sort((a, b) =>
    (a.month ?? "") === (b.month ?? "")
      ? (a.division ?? "￿").localeCompare(b.division ?? "￿")
      : (a.month ?? "") < (b.month ?? "")
      ? -1
      : 1
  );
  const byMonth = new Map<string | null, Cell>();
  const byDivision = new Map<string | null, Cell>();
  const total = emptyCell();
  for (const { division, month, cell } of ordered) {
    if (!byMonth.has(month)) byMonth.set(month, emptyCell());
    addInto(byMonth.get(month)!, cell);
    if (!byDivision.has(division)) byDivision.set(division, emptyCell());
    addInto(byDivision.get(division)!, cell);
    addInto(total, cell);
  }

  return {
    status: 200,
    body: {
      view: "division_months",
      basis: "xero",
      rows: ordered.map(({ division, month, cell }) => present(division, month, cell)),
      by_month: [...byMonth.entries()].map(([month, c]) => present(null, month, c))
        .map(({ division: _d, division_label: _l, ...rest }) => rest),
      by_division: [...byDivision.entries()]
        .sort((a, b) => (a[0] ?? "￿").localeCompare(b[0] ?? "￿"))
        .map(([division, c]) => present(division, null, c))
        .map(({ month: _m, ...rest }) => rest),
      totals: (({ division: _d, division_label: _l, month: _m, ...rest }) => rest)(
        present(null, null, total),
      ),
      filters: { from, to },
      as_of: asOf,
      labels,
    },
  };
}
