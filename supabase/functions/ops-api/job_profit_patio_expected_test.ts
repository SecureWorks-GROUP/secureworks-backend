import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PATIO_EXPECTED_SCOPE_PROJECTION,
  PATIO_FROZEN_REVISION_COLUMNS,
  patioExpectedVersusActual,
} from "./job_profit_patio_expected.ts";
import { jobProfitAction } from "./job_profit.ts";

const JOB = "00000000-0000-4000-8000-0000000000aa";

const REVISION = {
  n: 3,
  scopeRevisionId: "rev-3",
  parentRevisionId: "rev-2",
  frozenId: "frz-abc",
  catalogueRevisionId: "cat-1",
  sealedAt: "2026-10-20T08:00:00Z",
  outputsAgree: true,
};

// The patio scoper 2.0 record as the scoper saves it to scope_json.
function record(over: Record<string, unknown> = {}) {
  return {
    tool: "patio-scoper",
    version: "2.0",
    revision: REVISION,
    family: "skillion",
    supported: true,
    lines: [],
    expected: { materials: 4000, labour: 2000, sale: 9000 },
    ...over,
  };
}

// The projected last-save read of that record.
function current(rec: Record<string, any> = record()) {
  return {
    ptool: rec.tool,
    prev: rec.revision,
    psup: rec.supported,
    pexp: rec.expected,
  };
}

// The pricing_json the scoper saves beside it (Sales section 4).
function pricing(over: Record<string, unknown> = {}) {
  return {
    tool: "patio-scoper",
    revision: { n: 3, frozenId: "frz-abc", sealed: true },
    supported: true,
    pricing_complete: true,
    sell_to_confirm: [],
    internal: { costs_complete: true, costs_to_confirm: [] },
    ...over,
  };
}

// The job's frozen scope_revisions row: its id is the server's, never the
// tool's frozenId.
function frozen(
  rec: Record<string, unknown> = record(),
  pr: Record<string, unknown> = pricing(),
  over: Record<string, unknown> = {},
) {
  return {
    id: "srv-row-9",
    revision_number: 2,
    status: "frozen",
    tool_kind: "patio",
    tool_version: "patio-scoper/2.0",
    frozen_at: "2026-10-20T08:01:00Z",
    scope_canonical_text: JSON.stringify(rec),
    pricing_canonical_text: JSON.stringify(pr),
    ...over,
  };
}

// The job's v_job_profit row with every lane linked and billed.
function row(over: Record<string, unknown> = {}) {
  return {
    job_id: JOB,
    quoted_ex: 9000,
    expected_source: "accepted_quote_revision",
    expected_labour_ex: 1900,
    expected_materials_ex: 4100,
    expected_commission_ex: 450,
    expected_cost_ex: 6450,
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

Deno.test("patio expected: a frozen revision beside complete actuals, three sources kept apart", () => {
  const out = patioExpectedVersusActual(current(), frozen(), row())!;
  assertEquals(out.status, "complete");
  // frozen scope: server row and tool revision are different identities
  assertEquals(out.frozen_scope!.server_revision.id, "srv-row-9");
  assertEquals(out.frozen_scope!.server_revision.revision_number, 2);
  assertEquals(out.frozen_scope!.tool_revision.frozen_id, "frz-abc");
  assertEquals(out.frozen_scope!.tool_revision.n, 3);
  assertEquals(out.frozen_scope!.same_revision_as_current, true);
  assertEquals(out.frozen_scope!.expected, {
    materials_ex: 4000,
    labour_ex: 2000,
    sale_ex: 9000,
    cost_ex: 6000,
    profit_before_commission_ex: 3000,
    margin_before_commission_pct: 33.3,
  });
  // current estimate: labelled a draft, carried apart
  assertEquals(out.current_estimate!.label, "draft_current_estimate");
  assertEquals(out.current_estimate!.source, "jobs.scope_json_last_save");
  // commercial baseline: the engine's own figures, untouched
  assertEquals(out.commercial_baseline, {
    label: "commercial_baseline",
    source: "accepted_quote_revision",
    accepted: true,
    labour_ex: 1900,
    materials_ex: 4100,
    commission_ex: 450,
    cost_ex: 6450,
  });
  // lanes compare the FROZEN scope with actuals, never the baseline
  assertEquals(out.lanes.materials, {
    expected_ex: 4000,
    actual_ex: 4300,
    actual_complete: true,
    variance_ex: 300,
  });
  assertEquals(out.lanes.labour.variance_ex, -200);
  assertEquals(out.actual.profit_ex, 2450);
  assertEquals(out.sale_matches_sent_quote, true);
  assertEquals(out.flags, []);
});

Deno.test("patio expected: a last save with no frozen revision is a draft only, never compared", () => {
  const out = patioExpectedVersusActual(current(), null, row())!;
  assertEquals(out.frozen_scope, null);
  assertEquals(
    out.current_estimate!.expected.cost_ex,
    6000,
    "the draft shows its own figures",
  );
  assertEquals(out.lanes.materials.expected_ex, null);
  assertEquals(out.lanes.materials.variance_ex, null);
  assertEquals(out.sale_matches_sent_quote, null);
  assert(out.flags.includes("revision_not_frozen"));
  assertEquals(out.status, "incomplete");
});

Deno.test("patio expected: a newer last save than the frozen revision is named, the frozen one is compared", () => {
  const newer = record({
    revision: { ...REVISION, n: 4, frozenId: "frz-new" },
    expected: { materials: 9999, labour: 9999, sale: 30000 },
  });
  const out = patioExpectedVersusActual(current(newer), frozen(), row())!;
  assertEquals(out.frozen_scope!.same_revision_as_current, false);
  assert(out.flags.includes("last_save_not_frozen"));
  assertEquals(
    out.lanes.materials.expected_ex,
    4000,
    "the frozen figure, not the draft",
  );
  assertEquals(out.current_estimate!.expected.materials_ex, 9999);
});

Deno.test("patio expected: a null lane is not known, never 0, and fixes no margin", () => {
  const rec = record({
    expected: { materials: null, labour: 2000, sale: null },
  });
  const out = patioExpectedVersusActual(current(rec), frozen(rec), row())!;
  const e = out.frozen_scope!.expected;
  assertEquals(e.materials_ex, null);
  assertEquals(e.cost_ex, null);
  assertEquals(e.profit_before_commission_ex, null);
  assertEquals(e.margin_before_commission_pct, null);
  assertEquals(out.lanes.materials.variance_ex, null);
  assertEquals(
    out.lanes.labour.variance_ex,
    null,
    "no lane compares when no cost is fixed",
  );
  assert(out.flags.includes("expected_materials_not_known"));
  assert(out.flags.includes("expected_sale_not_known"));
  assertEquals(out.status, "incomplete");
});

Deno.test("patio expected: anything that is not a non-negative number is not known", () => {
  const rec = record({
    expected: { materials: "4000", labour: -5, sale: null },
  });
  const out = patioExpectedVersusActual(null, frozen(rec), row())!;
  assertEquals(out.frozen_scope!.expected.materials_ex, null);
  assertEquals(out.frozen_scope!.expected.labour_ex, null);
  assertEquals(out.frozen_scope!.expected.cost_ex, null);
});

Deno.test("patio expected: incomplete frozen pricing fixes no cost, profit or margin", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ pricing_complete: false }, "frozen_pricing_incomplete"],
    [
      { internal: { costs_complete: false, costs_to_confirm: ["Labour"] } },
      "frozen_costs_incomplete",
    ],
    [
      { revision: { n: 3, frozenId: "frz-abc", sealed: false } },
      "frozen_pricing_not_sealed",
    ],
    [{ sell_to_confirm: ["Gutter"] }, "frozen_sell_to_confirm"],
  ];
  for (const [over, flag] of cases) {
    const out = patioExpectedVersusActual(
      null,
      frozen(record(), pricing(over)),
      row(),
    )!;
    assertEquals(out.frozen_scope!.expected.cost_ex, null, flag);
    assertEquals(
      out.frozen_scope!.expected.profit_before_commission_ex,
      null,
      flag,
    );
    assertEquals(out.lanes.labour.variance_ex, null, flag);
    assert(out.flags.includes(flag), flag);
    assertEquals(out.status, "incomplete", flag);
  }
  const named = patioExpectedVersusActual(
    null,
    frozen(
      record(),
      pricing({
        internal: { costs_complete: false, costs_to_confirm: ["Labour", 7] },
      }),
    ),
    row(),
  )!;
  assertEquals(named.frozen_scope!.pricing.costs_to_confirm, ["Labour"]);
  // pricing with none of the flags is read as before
  const legacy = patioExpectedVersusActual(
    null,
    frozen(record(), { totalExGST: 9000 }),
    row(),
  )!;
  assertEquals(legacy.frozen_scope!.expected.cost_ex, 6000);
});

Deno.test("patio expected: supported false gives no expected sale or profit", () => {
  const rec = record({ supported: false });
  const out = patioExpectedVersusActual(null, frozen(rec), row())!;
  assertEquals(out.frozen_scope!.expected.sale_ex, null);
  assertEquals(out.frozen_scope!.expected.profit_before_commission_ex, null);
  assertEquals(
    out.frozen_scope!.expected.cost_ex,
    6000,
    "the costs are still the revision's",
  );
  assert(out.flags.includes("family_not_supported"));
  assertEquals(out.status, "incomplete");
  const unstated = patioExpectedVersusActual(
    null,
    frozen(record({ supported: "yes" })),
    row(),
  )!;
  assertEquals(unstated.frozen_scope!.expected.sale_ex, null);
  assert(unstated.flags.includes("supported_not_stated"));
});

Deno.test("patio expected: unconfirmed outputs or an unsealed revision fix nothing", () => {
  const rec = record({ revision: { ...REVISION, outputsAgree: false } });
  const out = patioExpectedVersusActual(null, frozen(rec), row())!;
  assertEquals(out.frozen_scope!.expected.materials_ex, null);
  assertEquals(out.frozen_scope!.expected.cost_ex, null);
  assert(out.flags.includes("outputs_not_confirmed"));
  const unsealed = patioExpectedVersusActual(
    null,
    frozen(record({ revision: { n: 1, outputsAgree: true } })),
    row(),
  )!;
  assertEquals(unsealed.frozen_scope!.expected.cost_ex, null);
  assert(unsealed.flags.includes("revision_not_sealed"));
});

Deno.test("patio expected: only a frozen patio row is read", () => {
  for (
    const over of [
      { status: "superseded" },
      { status: "draft" },
      { tool_kind: "fencing" },
    ]
  ) {
    const out = patioExpectedVersusActual(
      current(),
      frozen(record(), pricing(), over),
      row(),
    )!;
    assertEquals(out.frozen_scope, null, JSON.stringify(over));
    assert(out.flags.includes("revision_not_frozen"));
  }
  const broken = patioExpectedVersusActual(
    current(),
    frozen(record(), pricing(), { scope_canonical_text: "{not json" }),
    row(),
  )!;
  assertEquals(broken.frozen_scope, null);
  assert(broken.flags.includes("frozen_revision_unreadable"));
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
      null,
      frozen(),
      row({ actual_materials_ex: 0, completeness: [flag] }),
    )!;
    assertEquals(out.lanes.materials.actual_complete, false, flag);
    assertEquals(out.lanes.materials.variance_ex, null, flag);
    assert(out.flags.includes("actual_materials_open"), flag);
    assertEquals(out.status, "incomplete", flag);
  }
  const labour = patioExpectedVersusActual(
    null,
    frozen(),
    row({ completeness: ["unapproved_trade_charges"] }),
  )!;
  assertEquals(labour.lanes.labour.variance_ex, null);
  assertEquals(labour.lanes.materials.variance_ex, 300);
  const nothing = patioExpectedVersusActual(
    null,
    frozen(),
    row({ actual_labour_ex: null }),
  )!;
  assertEquals(
    nothing.lanes.labour.actual_complete,
    false,
    "a null actual is not 0",
  );
});

Deno.test("patio expected: a frozen revision that is not the quoted one says so", () => {
  const out = patioExpectedVersusActual(
    null,
    frozen(),
    row({ quoted_ex: 8500 }),
  )!;
  assertEquals(out.sale_matches_sent_quote, false);
  assert(out.flags.includes("expected_sale_differs_from_sent_quote"));
  assertEquals(out.status, "incomplete");
  const near = patioExpectedVersusActual(
    null,
    frozen(),
    row({ quoted_ex: 9000.6 }),
  )!;
  assertEquals(
    near.sale_matches_sent_quote,
    true,
    "within a dollar is rounding",
  );
  const none = patioExpectedVersusActual(
    null,
    frozen(),
    row({ quoted_ex: null }),
  )!;
  assertEquals(none.sale_matches_sent_quote, null);
  assert(none.flags.includes("no_sent_quote"));
});

Deno.test("patio expected: baseline acceptance and the engine's incomplete label travel", () => {
  const sent = patioExpectedVersusActual(
    null,
    frozen(),
    row({ expected_source: "sent_quote_revision" }),
  )!;
  assertEquals(sent.commercial_baseline.accepted, false);
  const none = patioExpectedVersusActual(
    null,
    frozen(),
    row({
      expected_source: null,
      expected_cost_ex: null,
      quote_costs_incomplete: true,
    }),
  )!;
  assertEquals(none.commercial_baseline.source, null);
  assertEquals(none.commercial_baseline.cost_ex, null);
  assert(none.flags.includes("quote_costs_incomplete"));
});

Deno.test("patio expected: anything but a patio scoper record is not read", () => {
  assertEquals(patioExpectedVersusActual(null, null, row()), null);
  assertEquals(
    patioExpectedVersusActual({ ptool: "fence-scoper" }, null, row()),
    null,
  );
  assertEquals(
    patioExpectedVersusActual({ ptool: "patio-scoper" }, null, row()),
    null,
  );
});

// job_profit action wiring
function fake(
  tables: Record<string, any[]>,
  errors: Record<string, string> = {},
) {
  const calls: Array<{ table: string; select: unknown; eq: unknown[][] }> = [];
  return {
    calls,
    from(table: string) {
      const call = { table, select: null as unknown, eq: [] as unknown[][] };
      calls.push(call);
      let rows = [...(tables[table] ?? [])];
      const b: any = {};
      for (const op of ["order", "limit"]) b[op] = () => b;
      b.select = (cols: unknown) => {
        call.select = cols;
        return b;
      };
      b.eq = (col: string, val: unknown) => {
        call.eq.push([col, val]);
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

Deno.test("job_profit: a patio job carries patio_expected from the frozen revision, by projection", async () => {
  const c = fake({
    v_job_profit: [row()],
    jobs: [{ id: JOB, ...current() }],
    scope_revisions: [{ job_id: JOB, ...frozen() }],
  });
  const out = await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
  assertEquals(out.status, 200);
  const pe = (out.body as any).patio_expected;
  assertEquals(pe.frozen_scope.server_revision.id, "srv-row-9");
  assertEquals(pe.lanes.materials.variance_ex, 300);
  const jobsRead = c.calls.find((x) => x.table === "jobs")!;
  assertEquals(jobsRead.select, PATIO_EXPECTED_SCOPE_PROJECTION);
  assertEquals(jobsRead.eq, [["id", JOB]]);
  const frozenRead = c.calls.find((x) => x.table === "scope_revisions")!;
  assertEquals(frozenRead.select, PATIO_FROZEN_REVISION_COLUMNS);
  assertEquals(frozenRead.eq, [["job_id", JOB], ["status", "frozen"], [
    "tool_kind",
    "patio",
  ]]);
});

Deno.test("job_profit: an unreadable scope never fails the profit read", async () => {
  for (const table of ["jobs", "scope_revisions"]) {
    const c = fake({ v_job_profit: [row()] }, { [table]: "timeout" });
    const out = await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
    assertEquals(out.status, 200, table);
    assertEquals((out.body as any).patio_expected.status, "unreadable", table);
    assertEquals((out.body as any).job.profit_ex, 2450, table);
  }
});
