// deno-lint-ignore-file no-explicit-any no-import-prefix
// reporting-api commission_summary (RQ-19.b): a rep's commission is the
// commission saved on the job's accepted quote, the figure Job Profit reads
// (v_job_profit.expected_commission_ex), never price x an assumed margin.
//
// Pins:
//   Saved       a fencing job pays exactly its saved commission, whatever
//               its price or pricing_json.margin_pct says.
//   No 0.35     a job with no saved commission is unknown with a reason,
//               counted nowhere: no 0.35 (or any) fixed margin stands in.
//   Total       earned_total sums known jobs to the cent and says when it is
//               incomplete.
//   Not earned  a job with no deposit in the period is not listed.
//   Holding     a holding job is never a rep's commission.
//   Read        the Job Profit read is chunked by org and ids, and a failed
//               read fails the answer.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCommissionSummary,
  COMMISSION_SUMMARY_SOURCE,
  readCommissionProfitRows,
} from "./commission_summary.ts";

const ORG = "00000000-0000-0000-0000-000000000001";

function job(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "fencing",
    client_name: `Client ${id}`,
    job_number: `SWF-${id}`,
    // A price and a stored margin that the old formula multiplied out:
    // 0.15 x 0.289 x 11000 = 476.85. The saved commission below is not that.
    pricing_json: { totalIncGST: 11000, margin_pct: 28.9 },
    ...extra,
  } as any;
}

function profit(id: string, extra: Record<string, unknown> = {}) {
  return {
    job_id: id,
    quoted_ex: 10000,
    expected_source: "frozen_revision",
    expected_labour_ex: 3200,
    expected_materials_ex: 2900,
    expected_commission_ex: 585.0,
    holding_job: false,
    ...extra,
  } as any;
}

function build(jobs: any[], earnedOn: Record<string, string>, rows: any[]) {
  return buildCommissionSummary({
    period: "month",
    periodStartIso: "2026-11-01T00:00:00.000Z",
    repUserId: "rep",
    jobs,
    earnedOn,
    profitRows: rows,
  });
}

Deno.test("Saved: a job pays its accepted quote's saved commission, not price x margin", () => {
  const out = build([job("a")], { a: "2026-11-05" }, [profit("a")]);
  assertEquals(out.breakdown.length, 1);
  const row = out.breakdown[0];
  assertEquals(row.commission, 585);
  assertEquals(row.commission_status, "known");
  assertEquals(row.commission_source, "frozen_revision");
  assertEquals(row.commission_reason, null);
  assertEquals(row.quoted_ex, 10000);
  assertEquals(row.expected_labour_ex, 3200);
  assertEquals(row.expected_materials_ex, 2900);
  assertEquals(row.value, 11000);
  assert(row.commission !== 476.85, "the old price x margin x rate figure");
  assertEquals(out.earned_total, 585);
  assertEquals(out.commission_complete, true);
  assertEquals(out.formula_snapshot.commission_source, COMMISSION_SUMMARY_SOURCE);
  for (const k of ["rep_rate", "fencing_baseline_gp", "patio_baseline_gp"]) {
    assert(!(k in out.formula_snapshot), `${k} is gone`);
  }
});

Deno.test("Saved: a scoper's edited percentage is paid as saved", () => {
  // The scoper typed 20% of a $2,000 gross profit: $400 saved on the quote.
  const out = build([job("a")], { a: "2026-11-05" }, [
    profit("a", { expected_commission_ex: 400 }),
  ]);
  assertEquals(out.breakdown[0].commission, 400);
  assertEquals(out.earned_total, 400);
});

Deno.test("No 0.35: no saved commission is unknown with a reason, never a fixed margin", () => {
  const noMargin = job("b", { pricing_json: { totalIncGST: 11000 } });
  const out = build(
    [job("a"), noMargin, job("c"), job("d")],
    { a: "2026-11-05", b: "2026-11-06", c: "2026-11-07", d: "2026-11-08" },
    [
      profit("a"),
      profit("b", { expected_source: null, expected_commission_ex: null, expected_labour_ex: null, expected_materials_ex: null }),
      profit("c", { expected_commission_ex: null }),
    ],
  );
  const by = Object.fromEntries(out.breakdown.map((r: any) => [r.job_id, r]));
  // Old formula on b: 0.15 x 0.35 x 11000 = 577.50. Now unknown.
  assertEquals(by.b.commission, null);
  assertEquals(by.b.commission_status, "unknown");
  assertEquals(by.b.commission_reason, "no accepted quote cost figures for this job");
  assertEquals(by.c.commission, null);
  assertEquals(by.c.commission_reason, "the accepted quote saved no commission");
  assertEquals(by.d.commission, null);
  assertEquals(by.d.commission_reason, "Job Profit has no row for this job");
  assertEquals(out.earned_total, 585);
  assertEquals(out.commission_unknown_count, 3);
  assertEquals(out.commission_complete, false);
  assertEquals(out.jobs_count, 4);
});

Deno.test("Total: known jobs add to the cent", () => {
  const out = build(
    [job("a"), job("b"), job("c")],
    { a: "2026-11-05", b: "2026-11-09", c: "2026-11-02" },
    [
      profit("a", { expected_commission_ex: 0.1 }),
      profit("b", { expected_commission_ex: 0.2 }),
      profit("c", { expected_commission_ex: "312.455" }),
    ],
  );
  assertEquals(out.earned_total, 312.76);
  assertEquals(out.breakdown.map((r: any) => r.job_id), ["b", "a", "c"]);
});

Deno.test("Not earned: no deposit in the period, not listed", () => {
  const out = build([job("a"), job("b")], { a: "2026-11-05" }, [profit("a"), profit("b")]);
  assertEquals(out.breakdown.map((r: any) => r.job_id), ["a"]);
  assertEquals(out.earned_total, 585);
});

Deno.test("Holding: a holding job is never a rep's commission", () => {
  const out = build([job("a"), job("h")], { a: "2026-11-05", h: "2026-11-05" }, [
    profit("a"),
    profit("h", { holding_job: true, expected_commission_ex: 900 }),
  ]);
  assertEquals(out.breakdown.map((r: any) => r.job_id), ["a"]);
  assertEquals(out.earned_total, 585);
});

Deno.test("Empty: no earned jobs reads zero and complete", () => {
  const out = build([], {}, []);
  assertEquals(out.earned_total, 0);
  assertEquals(out.jobs_count, 0);
  assertEquals(out.commission_complete, true);
});

Deno.test("Duplicate Job Profit rows for a job fail the answer", () => {
  assertThrows(() => build([job("a")], { a: "2026-11-05" }, [profit("a"), profit("a")]));
});

function fakeSb(fail = false) {
  const calls: any[] = [];
  return {
    calls,
    from(table: string) {
      const q: any = { table };
      const chain = {
        select(cols: string) { q.cols = cols; return chain; },
        eq(col: string, v: unknown) { q.eq = [col, v]; return chain; },
        in(col: string, ids: string[]) {
          q.in = [col, ids];
          calls.push(q);
          return Promise.resolve(
            fail
              ? { data: null, error: { message: "boom" } }
              : { data: ids.map((id) => profit(id)), error: null },
          );
        },
      };
      return chain;
    },
  };
}

Deno.test("Read: v_job_profit by org, chunked ids", async () => {
  const sb = fakeSb();
  const ids = Array.from({ length: 160 }, (_, i) => `j${i}`);
  const rows = await readCommissionProfitRows(sb, ORG, ids);
  assertEquals(rows.length, 160);
  assertEquals(sb.calls.length, 2);
  for (const c of sb.calls) {
    assertEquals(c.table, "v_job_profit");
    assertEquals(c.eq, ["org_id", ORG]);
    assert(c.cols.includes("expected_commission_ex"));
  }
  assertEquals(sb.calls[0].in[1].length, 150);
});

Deno.test("Read: a failed Job Profit read fails the answer", async () => {
  await assertRejects(() => readCommissionProfitRows(fakeSb(true), ORG, ["a"]), Error, "v_job_profit read failed");
});
