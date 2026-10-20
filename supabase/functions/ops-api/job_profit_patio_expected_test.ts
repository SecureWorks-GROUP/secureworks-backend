import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PATIO_EXPECTED_SCOPE_PROJECTION,
  patioExpectedVersusActual,
} from "./job_profit_patio_expected.ts";
import { jobProfitAction } from "./job_profit.ts";

const JOB = "00000000-0000-4000-8000-0000000000aa";

// A sealed patio scoper 2.0 revision, as the projected read returns it.
function scope(over: Record<string, unknown> = {}) {
  return {
    ptool: "patio-scoper",
    prev: {
      n: 3,
      scopeRevisionId: "rev-3",
      parentRevisionId: "rev-2",
      frozenId: "frz-abc",
      catalogueRevisionId: "cat-1",
      sealedAt: "2026-10-20T08:00:00Z",
      outputsAgree: true,
    },
    psup: true,
    pexp: { materials: 4000, labour: 2000, sale: 9000 },
    ...over,
  };
}

// The job's v_job_profit row with every lane linked and billed.
function row(over: Record<string, unknown> = {}) {
  return {
    job_id: JOB,
    quoted_ex: 9000,
    actual_materials_ex: 4300,
    actual_labour_ex: 1800,
    actual_commission_ex: 450,
    actual_other_ex: 0,
    actual_cost_ex: 6550,
    invoiced_ex: 9000,
    profit_ex: 2450,
    margin_pct: 27.2,
    completeness: [],
    ...over,
  };
}

Deno.test("patio expected: a complete sealed revision beside complete actuals", () => {
  const out = patioExpectedVersusActual(scope(), row())!;
  assertEquals(out.status, "complete");
  assertEquals(out.revision.n, 3);
  assertEquals(out.revision.frozen_id, "frz-abc");
  assertEquals(out.revision.source, "jobs.scope_json_last_save");
  assertEquals(out.revision.parent_readable, false);
  assertEquals(out.revision.frozen_in_job_system, false);
  assertEquals(out.expected, {
    materials_ex: 4000,
    labour_ex: 2000,
    sale_ex: 9000,
    cost_ex: 6000,
    profit_before_commission_ex: 3000,
    margin_before_commission_pct: 33.3,
  });
  assertEquals(out.lanes.materials, {
    expected_ex: 4000,
    actual_ex: 4300,
    actual_complete: true,
    variance_ex: 300,
  });
  assertEquals(out.lanes.labour.variance_ex, -200);
  // the actual side is the engine's, untouched
  assertEquals(out.actual.profit_ex, 2450);
  assertEquals(out.actual.commission_ex, 450);
  assertEquals(out.sale_matches_sent_quote, true);
  assertEquals(out.flags, []);
});

Deno.test("patio expected: a null lane is not known, never 0, and fixes no margin", () => {
  const out = patioExpectedVersusActual(
    scope({ pexp: { materials: null, labour: 2000, sale: null } }),
    row(),
  )!;
  assertEquals(out.status, "incomplete");
  assertEquals(out.expected.materials_ex, null);
  assertEquals(out.expected.cost_ex, null);
  assertEquals(out.expected.profit_before_commission_ex, null);
  assertEquals(out.expected.margin_before_commission_pct, null);
  assertEquals(
    out.lanes.materials.variance_ex,
    null,
    "no variance against an unknown",
  );
  assertEquals(
    out.lanes.labour.variance_ex,
    -200,
    "a known lane still compares",
  );
  assert(out.flags.includes("expected_materials_not_known"));
  assert(out.flags.includes("expected_sale_not_known"));
  assertEquals(out.sale_matches_sent_quote, null);
});

Deno.test("patio expected: anything that is not a non-negative number is not known", () => {
  const out = patioExpectedVersusActual(
    scope({ pexp: { materials: "4000", labour: -5, sale: NaN } }),
    row(),
  )!;
  assertEquals(out.expected.materials_ex, null);
  assertEquals(out.expected.labour_ex, null);
  assertEquals(out.expected.sale_ex, null);
  assertEquals(out.expected.cost_ex, null);
});

Deno.test("patio expected: supported false gives no expected sale or profit", () => {
  const out = patioExpectedVersusActual(scope({ psup: false }), row())!;
  assertEquals(out.supported, false);
  assertEquals(out.expected.sale_ex, null);
  assertEquals(out.expected.profit_before_commission_ex, null);
  assertEquals(
    out.expected.cost_ex,
    6000,
    "the costs are still the revision's",
  );
  assert(out.flags.includes("family_not_supported"));
  assertEquals(out.status, "incomplete");
  const unstated = patioExpectedVersusActual(
    scope({ psup: undefined }),
    row(),
  )!;
  assertEquals(unstated.expected.sale_ex, null);
  assert(unstated.flags.includes("supported_not_stated"));
});

Deno.test("patio expected: unconfirmed outputs or an unsealed revision fix nothing", () => {
  const prev = { ...scope().prev, outputsAgree: false };
  const out = patioExpectedVersusActual(scope({ prev }), row())!;
  assertEquals(out.expected.materials_ex, null);
  assertEquals(out.expected.cost_ex, null);
  assertEquals(out.lanes.labour.variance_ex, null);
  assert(out.flags.includes("outputs_not_confirmed"));
  const unsealed = patioExpectedVersusActual(
    scope({ prev: { n: 1, outputsAgree: true } }),
    row(),
  )!;
  assertEquals(unsealed.expected.cost_ex, null);
  assert(unsealed.flags.includes("revision_not_sealed"));
});

Deno.test("patio expected: an open actual lane gives no variance, never a false saving", () => {
  for (
    const flag of [
      "materials_not_linked",
      "ordered_not_billed",
      "invoice_emailed_bill_not_placed",
      "open_purchase_orders",
    ]
  ) {
    const out = patioExpectedVersusActual(
      scope(),
      row({ actual_materials_ex: 0, completeness: [flag] }),
    )!;
    assertEquals(out.lanes.materials.actual_complete, false, flag);
    assertEquals(out.lanes.materials.variance_ex, null, flag);
    assert(out.flags.includes("actual_materials_open"), flag);
    assertEquals(out.status, "incomplete", flag);
  }
  const labour = patioExpectedVersusActual(
    scope(),
    row({ completeness: ["unapproved_trade_charges"] }),
  )!;
  assertEquals(labour.lanes.labour.variance_ex, null);
  assertEquals(labour.lanes.materials.variance_ex, 300);
  const nothing = patioExpectedVersusActual(
    scope(),
    row({ actual_labour_ex: null, completeness: [] }),
  )!;
  assertEquals(
    nothing.lanes.labour.actual_complete,
    false,
    "a null actual is not 0",
  );
});

Deno.test("patio expected: a saved revision that is not the quoted one says so", () => {
  const out = patioExpectedVersusActual(scope(), row({ quoted_ex: 8500 }))!;
  assertEquals(out.sale_matches_sent_quote, false);
  assert(out.flags.includes("expected_sale_differs_from_sent_quote"));
  assertEquals(out.status, "incomplete");
  const near = patioExpectedVersusActual(scope(), row({ quoted_ex: 9000.6 }))!;
  assertEquals(
    near.sale_matches_sent_quote,
    true,
    "within a dollar is rounding",
  );
  const none = patioExpectedVersusActual(scope(), row({ quoted_ex: null }))!;
  assertEquals(none.sale_matches_sent_quote, null);
  assert(none.flags.includes("no_sent_quote"));
});

Deno.test("patio expected: the engine's incomplete-cost label travels", () => {
  const out = patioExpectedVersusActual(
    scope(),
    row({ quote_costs_incomplete: true }),
  )!;
  assert(out.flags.includes("quote_costs_incomplete"));
});

Deno.test("patio expected: anything but a patio scoper record is not read", () => {
  assertEquals(patioExpectedVersusActual(null, row()), null);
  assertEquals(
    patioExpectedVersusActual({ ptool: "fence-scoper" }, row()),
    null,
  );
  assertEquals(
    patioExpectedVersusActual({ ptool: "patio-scoper" }, row()),
    null,
  );
});

// job_profit action wiring
function fake(
  tables: Record<string, any[]>,
  errors: Record<string, string> = {},
) {
  const calls: Array<{ table: string; select: unknown; eq: unknown[] }> = [];
  return {
    calls,
    from(table: string) {
      const call = { table, select: null as unknown, eq: [] as unknown[] };
      calls.push(call);
      let rows = [...(tables[table] ?? [])];
      const b: any = {};
      for (const op of ["order", "limit"]) b[op] = () => b;
      b.select = (cols: unknown) => {
        call.select = cols;
        return b;
      };
      b.eq = (col: string, val: unknown) => {
        call.eq = [col, val];
        rows = rows.filter((r) => r[col] === val);
        return b;
      };
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(
          errors[table]
            ? { data: null, error: { message: errors[table] } }
            : { data: rows, error: null },
        );
      return b;
    },
  };
}

Deno.test("job_profit: a patio scoper job carries patio_expected, read by projection", async () => {
  const c = fake({
    v_job_profit: [row()],
    jobs: [{ id: JOB, ...scope() }],
  });
  const out = await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
  assertEquals(out.status, 200);
  const pe = (out.body as any).patio_expected;
  assertEquals(pe.revision.frozen_id, "frz-abc");
  assertEquals(pe.expected.cost_ex, 6000);
  const jobsRead = c.calls.find((x) => x.table === "jobs")!;
  assertEquals(jobsRead.select, PATIO_EXPECTED_SCOPE_PROJECTION);
  assert(
    !String(jobsRead.select).includes("scope_json,"),
    "never the whole blob",
  );
  assertEquals(jobsRead.eq, ["id", JOB]);
});

Deno.test("job_profit: an unreadable scope never fails the profit read", async () => {
  const c = fake({ v_job_profit: [row()] }, { jobs: "timeout" });
  const out = await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
  assertEquals(out.status, 200);
  assertEquals((out.body as any).patio_expected.status, "unreadable");
  assertEquals((out.body as any).job.profit_ex, 2450);
});
