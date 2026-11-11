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
//   Accepted    only the accepted quote counts: a sent-only quote or an
//               unbound sealed scope reads unknown.
//   Zero        a 0 the quote snapshot filled in (no commission in the saved
//               pricing) is unknown; a 0 the quote saved stays known.
//   Total       earned_total sums known jobs to the cent and says when it is
//               incomplete.
//   Same jobs   the listed jobs are today's: a deposit in the period and a
//               price above 0; a holding job is listed as before.
//   Read        the Job Profit read is chunked by org and ids, the accepted
//               revision read picks Job Profit's revision, and a failed read
//               fails the answer.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCommissionSummary,
  COMMISSION_SUMMARY_SOURCE,
  readAcceptedRevisionCommissions,
  readCommissionProfitRows,
} from "./commission_summary.ts";

const ORG = "00000000-0000-0000-0000-000000000001";

function job(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "fencing",
    client_name: `Client ${id}`,
    job_number: `ZZTEST-${id}`,
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
    expected_source: "frozen_at_acceptance",
    expected_labour_ex: 3200,
    expected_materials_ex: 2900,
    expected_commission_ex: 585.0,
    ...extra,
  } as any;
}

function build(jobs: any[], earnedOn: Record<string, string>, rows: any[], revisions: any[] = []) {
  return buildCommissionSummary({
    period: "month",
    periodStartIso: "2026-11-01T00:00:00.000Z",
    repUserId: "rep",
    jobs,
    earnedOn,
    profitRows: rows,
    acceptedRevisions: revisions,
  });
}

// An accepted revision row as the reader returns it.
function rev(id: string, extra: Record<string, unknown> = {}) {
  return {
    job_id: id,
    raw_commission: 585,
    raw_internal_commission: null,
    snapshot_commission: 585,
    ...extra,
  } as any;
}

Deno.test("Saved: a job pays its accepted quote's saved commission, not price x margin", () => {
  const out = build([job("a")], { a: "2026-11-05" }, [profit("a")]);
  assertEquals(out.breakdown.length, 1);
  const row = out.breakdown[0];
  assertEquals(row.commission, 585);
  assertEquals(row.commission_status, "known");
  assertEquals(row.commission_source, "frozen_at_acceptance");
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
  // The scoper edited the percentage; the quote saved the resulting figure.
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

Deno.test("Accepted: a sent-only quote or an unbound sealed scope is not the rep's commission", () => {
  const out = build(
    [job("s"), job("f", { type: "patio" })],
    { s: "2026-11-05", f: "2026-11-06" },
    [
      profit("s", { expected_source: "sent_quote_revision", expected_commission_ex: 777 }),
      profit("f", { expected_source: "frozen_scope_revision", expected_commission_ex: 777 }),
    ],
  );
  for (const r of out.breakdown) {
    assertEquals(r.commission, null);
    assertEquals(r.commission_status, "unknown");
    assertEquals(r.commission_reason, "the cost figures are from a quote that was not accepted");
  }
  assertEquals(out.earned_total, 0);
  assertEquals(out.commission_complete, false);
});

Deno.test("Accepted: an accepted revision counts when its saved pricing holds the figure", () => {
  const out = build(
    [job("f"), job("p", { type: "patio" })],
    { f: "2026-11-05", p: "2026-11-06" },
    [
      profit("f", { expected_source: "accepted_quote_revision", expected_commission_ex: 640 }),
      profit("p", { expected_source: "accepted_quote_revision", expected_commission_ex: 210 }),
    ],
    [
      // The fence adapter reads internal.commission before commissionCostEstimate.
      rev("f", { raw_internal_commission: 640, raw_commission: 999, snapshot_commission: 640 }),
      rev("p", { raw_commission: "210.00", snapshot_commission: 210 }),
    ],
  );
  const by = Object.fromEntries(out.breakdown.map((r: any) => [r.job_id, r]));
  assertEquals(by.f.commission, 640);
  assertEquals(by.f.commission_source, "accepted_quote_revision");
  assertEquals(by.p.commission, 210);
  assertEquals(out.earned_total, 850);
  assertEquals(out.commission_complete, true);
});

Deno.test("Accepted: a revision that does not match Job Profit's figure is unknown", () => {
  const out = build(
    [job("m"), job("n")],
    { m: "2026-11-05", n: "2026-11-06" },
    [
      profit("m", { expected_source: "accepted_quote_revision", expected_commission_ex: 640 }),
      profit("n", { expected_source: "accepted_quote_revision", expected_commission_ex: 640 }),
    ],
    [rev("m", { raw_commission: 500, snapshot_commission: 640 })],
  );
  const by = Object.fromEntries(out.breakdown.map((r: any) => [r.job_id, r]));
  assertEquals(by.m.commission, null);
  assertEquals(by.m.commission_reason, "the accepted quote's saved commission does not match its cost figures");
  assertEquals(by.n.commission, null, "no revision read: unknown");
  assertEquals(by.n.commission_reason, "the accepted quote saved no commission");
  assertEquals(out.earned_total, 0);
});

Deno.test("Zero: a 0 the snapshot filled in is unknown; a 0 the quote saved is known", () => {
  const out = build(
    [job("filled"), job("filledp", { type: "patio" }), job("saved"), job("frozen0")],
    { filled: "2026-11-05", filledp: "2026-11-05", saved: "2026-11-06", frozen0: "2026-11-07" },
    [
      profit("filled", { expected_source: "accepted_quote_revision", expected_commission_ex: 0 }),
      profit("filledp", { expected_source: "accepted_quote_revision", expected_commission_ex: 0 }),
      profit("saved", { expected_source: "accepted_quote_revision", expected_commission_ex: 0 }),
      profit("frozen0", { expected_commission_ex: 0 }),
    ],
    [
      // No commission in the saved pricing: the adapters wrote 0 for it.
      rev("filled", { raw_commission: null, raw_internal_commission: null, snapshot_commission: 0 }),
      rev("filledp", { raw_commission: null, raw_internal_commission: 0, snapshot_commission: 0 }),
      // The quote itself saved 0.
      rev("saved", { raw_commission: 0, snapshot_commission: 0 }),
    ],
  );
  const by = Object.fromEntries(out.breakdown.map((r: any) => [r.job_id, r]));
  assertEquals(by.filled.commission, null);
  assertEquals(by.filled.commission_reason, "the accepted quote saved no commission");
  assertEquals(by.filledp.commission, null, "a patio reads commissionCostEstimate only");
  assertEquals(by.saved.commission, 0);
  assertEquals(by.saved.commission_status, "known");
  // The acceptance freeze writes a lane only for a saved number, so 0 there is saved.
  assertEquals(by.frozen0.commission, 0);
  assertEquals(by.frozen0.commission_status, "known");
  assertEquals(out.commission_unknown_count, 2);
});

Deno.test("Same jobs: no price is not listed, a holding job is listed as before", () => {
  const out = build(
    [job("a"), job("e", { pricing_json: {} }), job("h")],
    { a: "2026-11-05", e: "2026-11-05", h: "2026-11-05" },
    [profit("a"), profit("e", { expected_commission_ex: 88 }), profit("h", { holding_job: true })],
  );
  assertEquals(out.breakdown.map((r: any) => r.job_id).sort(), ["a", "h"]);
  assertEquals(out.earned_total, 1170);
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

Deno.test("Read: the accepted revision is Job Profit's (newest acceptance, then version)", async () => {
  const rows = [
    { job_id: "a", version: 1, raw_commission: 100, snapshot_commission: 100, job_documents: { accepted_at: "2026-11-01T00:00:00Z" } },
    { job_id: "a", version: 3, raw_commission: 300, snapshot_commission: 300, job_documents: { accepted_at: "2026-11-02T00:00:00Z" } },
    { job_id: "a", version: 2, raw_commission: 200, snapshot_commission: 200, job_documents: { accepted_at: "2026-11-02T00:00:00Z" } },
    { job_id: "b", version: 1, raw_commission: 50, snapshot_commission: 50, job_documents: { accepted_at: "2026-10-01T00:00:00Z" } },
  ];
  const calls: any[] = [];
  const sb = {
    from(table: string) {
      const q: any = { table };
      const chain: any = {
        select(cols: string) { q.cols = cols; return chain; },
        in(col: string, ids: string[]) { q.in = [col, ids]; return chain; },
        not(col: string, op: string, v: unknown) {
          q.not = [col, op, v];
          calls.push(q);
          return Promise.resolve({ data: rows.filter((r) => q.in[1].includes(r.job_id)), error: null });
        },
      };
      return chain;
    },
  };
  const out = await readAcceptedRevisionCommissions(sb, ["a", "b"]);
  const by = Object.fromEntries(out.map((r) => [r.job_id, r]));
  assertEquals(by.a.raw_commission, 300);
  assertEquals(by.b.raw_commission, 50);
  assertEquals(calls[0].table, "quote_revisions");
  assertEquals(calls[0].not, ["job_documents.accepted_at", "is", null]);
  assert(calls[0].cols.includes("job_documents!inner(accepted_at)"));
  assert(!calls[0].cols.includes("pricing_snapshot_json,"), "projected, never the whole blob");
});

Deno.test("Read: a failed accepted revision read fails the answer", async () => {
  const sb = {
    from() {
      const chain: any = {
        select() { return chain; },
        in() { return chain; },
        not() { return Promise.resolve({ data: null, error: { message: "boom" } }); },
      };
      return chain;
    },
  };
  await assertRejects(() => readAcceptedRevisionCommissions(sb, ["a"]), Error, "accepted quote read failed");
});
