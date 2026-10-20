import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  LABOUR_ACTUAL_OPEN,
  type LastSaveHashes,
  lastSaveHashes,
  MATERIALS_ACTUAL_OPEN,
  PATIO_EXPECTED_SCOPE_PROJECTION,
  PATIO_FROZEN_REVISION_COLUMNS,
  PATIO_LAST_SAVE_HASH_COLUMNS,
  patioExpectedVersusActual,
} from "./job_profit_patio_expected.ts";
import { canonicalJsonAndHash } from "../_shared/release_packet/canonicalize.ts";
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

// Stand-in hashes: the last save is the frozen revision unless a test says not.
const SAME: LastSaveHashes = {
  scope_hash: "a".repeat(64),
  pricing_hash: "b".repeat(64),
};

function pe(
  cur: Record<string, unknown> | null,
  frz: Record<string, unknown> | null,
  r: Record<string, unknown>,
  hashes: LastSaveHashes | null = SAME,
) {
  return patioExpectedVersusActual(cur, frz, r, hashes);
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
    scope_hash: SAME.scope_hash,
    pricing_hash: SAME.pricing_hash,
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
  const out = pe(current(), frozen(), row())!;
  assertEquals(out.status, "complete");
  // frozen scope: server row and tool revision are different identities
  assertEquals(out.frozen_scope!.server_revision.id, "srv-row-9");
  assertEquals(out.frozen_scope!.server_revision.revision_number, 2);
  assertEquals(out.frozen_scope!.tool_revision.frozen_id, "frz-abc");
  assertEquals(out.frozen_scope!.tool_revision.n, 3);
  assertEquals(out.frozen_scope!.last_save_matches_frozen, true);
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
  const out = pe(current(), null, row())!;
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
  const out = pe(current(newer), frozen(), row(), {
    ...SAME,
    scope_hash: "c".repeat(64),
  })!;
  assertEquals(out.frozen_scope!.last_save_matches_frozen, false);
  assertEquals(out.frozen_scope!.scope_hash_match, false);
  assertEquals(out.frozen_scope!.pricing_hash_match, true);
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
  const out = pe(current(rec), frozen(rec), row())!;
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
  const out = pe(null, frozen(rec), row())!;
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
    const out = pe(
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
  const named = pe(
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
  // pricing that does not state it is complete and sealed fixes no cost
  // (Sales final revision contract: a missing flag is not a yes)
  const legacy = pe(
    null,
    frozen(record(), { totalExGST: 9000 }),
    row(),
  )!;
  assertEquals(legacy.frozen_scope!.expected.cost_ex, null);
  assertEquals(legacy.frozen_scope!.expected.materials_ex, 4000);
  assert(legacy.flags.includes("frozen_pricing_complete_not_stated"));
  assert(legacy.flags.includes("frozen_pricing_seal_not_stated"));
  assertEquals(legacy.lanes.materials.variance_ex, null);
});

Deno.test("patio expected: supported false gives no expected sale or profit", () => {
  const rec = record({ supported: false });
  const out = pe(null, frozen(rec), row())!;
  assertEquals(out.frozen_scope!.expected.sale_ex, null);
  assertEquals(out.frozen_scope!.expected.profit_before_commission_ex, null);
  assertEquals(
    out.frozen_scope!.expected.cost_ex,
    6000,
    "the costs are still the revision's",
  );
  assert(out.flags.includes("family_not_supported"));
  assertEquals(out.status, "incomplete");
  const unstated = pe(
    null,
    frozen(record({ supported: "yes" })),
    row(),
  )!;
  assertEquals(unstated.frozen_scope!.expected.sale_ex, null);
  assert(unstated.flags.includes("supported_not_stated"));
});

Deno.test("patio expected: unconfirmed outputs or an unsealed revision fix nothing", () => {
  const rec = record({ revision: { ...REVISION, outputsAgree: false } });
  const out = pe(null, frozen(rec), row())!;
  assertEquals(out.frozen_scope!.expected.materials_ex, null);
  assertEquals(out.frozen_scope!.expected.cost_ex, null);
  assert(out.flags.includes("outputs_not_confirmed"));
  const unsealed = pe(
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
    const out = pe(
      current(),
      frozen(record(), pricing(), over),
      row(),
    )!;
    assertEquals(out.frozen_scope, null, JSON.stringify(over));
    assert(out.flags.includes("revision_not_frozen"));
  }
  const broken = pe(
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
    const out = pe(
      null,
      frozen(),
      row({ actual_materials_ex: 0, completeness: [flag] }),
    )!;
    assertEquals(out.lanes.materials.actual_complete, false, flag);
    assertEquals(out.lanes.materials.variance_ex, null, flag);
    assert(out.flags.includes("actual_materials_open"), flag);
    assertEquals(out.status, "incomplete", flag);
  }
  const labour = pe(
    null,
    frozen(),
    row({ completeness: ["unapproved_trade_charges"] }),
  )!;
  assertEquals(labour.lanes.labour.variance_ex, null);
  assertEquals(labour.lanes.materials.variance_ex, 300);
  const nothing = pe(
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
  const out = pe(
    null,
    frozen(),
    row({ quoted_ex: 8500 }),
  )!;
  assertEquals(out.sale_matches_sent_quote, false);
  assert(out.flags.includes("expected_sale_differs_from_sent_quote"));
  assertEquals(out.status, "incomplete");
  const near = pe(
    null,
    frozen(),
    row({ quoted_ex: 9000.6 }),
  )!;
  assertEquals(
    near.sale_matches_sent_quote,
    true,
    "within a dollar is rounding",
  );
  const none = pe(
    null,
    frozen(),
    row({ quoted_ex: null }),
  )!;
  assertEquals(none.sale_matches_sent_quote, null);
  assert(none.flags.includes("no_sent_quote"));
});

Deno.test("patio expected: baseline acceptance and the engine's incomplete label travel", () => {
  const sent = pe(
    null,
    frozen(),
    row({ expected_source: "sent_quote_revision" }),
  )!;
  assertEquals(sent.commercial_baseline.accepted, false);
  const none = pe(
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
  assertEquals(pe(null, null, row()), null);
  assertEquals(
    pe({ ptool: "fence-scoper" }, null, row()),
    null,
  );
  assertEquals(
    pe({ ptool: "patio-scoper" }, null, row()),
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
  // The frozen row carries the hashes freeze_scope stored over the save.
  const saved = { scope_json: record(), pricing_json: pricing() };
  const h = await lastSaveHashes(saved);
  const c = fake({
    v_job_profit: [row()],
    jobs: [{ id: JOB, ...current(), ...saved }],
    scope_revisions: [{ job_id: JOB, ...frozen(), ...h }],
  });
  const out = await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
  assertEquals(out.status, 200);
  const pe = (out.body as any).patio_expected;
  assertEquals(pe.frozen_scope.server_revision.id, "srv-row-9");
  assertEquals(pe.frozen_scope.last_save_matches_frozen, true);
  assertEquals(pe.lanes.materials.variance_ex, 300);
  assertEquals(pe.flags, []);
  const jobsReads = c.calls.filter((x) => x.table === "jobs");
  assertEquals(jobsReads.map((x) => x.select), [
    PATIO_EXPECTED_SCOPE_PROJECTION,
    PATIO_LAST_SAVE_HASH_COLUMNS,
  ]);
  for (const r of jobsReads) assertEquals(r.eq, [["id", JOB]]);
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

Deno.test("patio expected: freshness is by hash, never by the tool's frozenId", () => {
  // Same frozenId in the last save, but the scope was edited after the
  // freeze: the hash differs, so it is not the frozen revision.
  const out = pe(current(), frozen(), row(), {
    ...SAME,
    scope_hash: "d".repeat(64),
  })!;
  assertEquals(out.current_estimate!.tool_revision.frozen_id, "frz-abc");
  assertEquals(out.frozen_scope!.tool_revision.frozen_id, "frz-abc");
  assertEquals(out.frozen_scope!.last_save_matches_frozen, false);
  assert(out.flags.includes("last_save_not_frozen"));
  // Pricing moved alone is also a newer save.
  const priced = pe(current(), frozen(), row(), {
    ...SAME,
    pricing_hash: "e".repeat(64),
  })!;
  assertEquals(priced.frozen_scope!.last_save_matches_frozen, false);
});

Deno.test("patio expected: freshness not compared is named, never assumed", () => {
  for (
    const [hashes, frz] of [
      [null, frozen()],
      [{ scope_hash: null, pricing_hash: null }, frozen()],
      [SAME, frozen(record(), pricing(), { scope_hash: null })],
      [SAME, frozen(record(), pricing(), { pricing_hash: "not-a-hash" })],
    ] as Array<[LastSaveHashes | null, Record<string, unknown>]>
  ) {
    const out = pe(current(), frz, row(), hashes)!;
    assertEquals(out.frozen_scope!.last_save_matches_frozen, null);
    assert(out.flags.includes("last_save_freshness_not_checked"));
    assert(!out.flags.includes("last_save_not_frozen"));
    // the frozen figures are still the ones compared
    assertEquals(out.lanes.materials.expected_ex, 4000);
  }
});

Deno.test("patio expected: last-save hashes are freeze_scope's (key order does not matter)", async () => {
  const scope = record();
  const pr = pricing();
  const h = await lastSaveHashes({ scope_json: scope, pricing_json: pr });
  assertEquals(h.scope_hash, (await canonicalJsonAndHash(scope)).hash);
  assertEquals(h.pricing_hash, (await canonicalJsonAndHash(pr)).hash);
  const reordered = Object.fromEntries(Object.entries(scope).reverse());
  assertEquals(
    (await lastSaveHashes({ scope_json: reordered })).scope_hash,
    h.scope_hash,
  );
  assertEquals(await lastSaveHashes({ scope_json: "x", pricing_json: null }), {
    scope_hash: null,
    pricing_hash: null,
  });
});

Deno.test("job_profit: a save edited after the freeze reads not frozen, by hash", async () => {
  const saved = { scope_json: record(), pricing_json: pricing() };
  const h = await lastSaveHashes(saved);
  const edited = {
    scope_json: record({ lines: [{ code: "x" }] }),
    pricing_json: pricing(),
  };
  const c = fake({
    v_job_profit: [row()],
    jobs: [{ id: JOB, ...current(), ...edited }],
    scope_revisions: [{ job_id: JOB, ...frozen(), ...h }],
  });
  const pe = ((await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`)))
    .body as any).patio_expected;
  assertEquals(pe.frozen_scope.scope_hash_match, false);
  assertEquals(pe.frozen_scope.pricing_hash_match, true);
  assert(pe.flags.includes("last_save_not_frozen"));
});

Deno.test("job_profit: a job with no frozen patio row makes no whole-scope read", async () => {
  const c = fake({ v_job_profit: [row()], jobs: [{ id: JOB, ...current() }] });
  await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
  assertEquals(c.calls.filter((x) => x.table === "jobs").length, 1);
});

// Pinned literally: removing a flag from either list fails here.
const MATERIALS_OPEN_PINNED = [
  "no_cost_linked",
  "materials_not_linked",
  "open_purchase_orders",
  "ordered_not_billed",
  "invoice_emailed_bill_not_placed",
  "unclassified_lines",
  "incomplete_invoice_lines",
  "xero_project_exceeds_line_costs",
];
const LABOUR_OPEN_PINNED = [
  "no_cost_linked",
  "no_labour_linked",
  "unapproved_trade_charges",
  "unclassified_lines",
  "incomplete_invoice_lines",
  "xero_project_exceeds_line_costs",
];

Deno.test("patio expected: every open flag holds its lane (lists pinned)", () => {
  assertEquals(
    [...MATERIALS_ACTUAL_OPEN].sort(),
    [...MATERIALS_OPEN_PINNED].sort(),
  );
  assertEquals([...LABOUR_ACTUAL_OPEN].sort(), [...LABOUR_OPEN_PINNED].sort());
  for (const flag of MATERIALS_OPEN_PINNED) {
    const out = pe(null, frozen(), row({ completeness: [flag] }))!;
    assertEquals(out.lanes.materials.variance_ex, null, flag);
    assert(out.flags.includes("actual_materials_open"), flag);
  }
  for (const flag of LABOUR_OPEN_PINNED) {
    const out = pe(null, frozen(), row({ completeness: [flag] }))!;
    assertEquals(out.lanes.labour.variance_ex, null, flag);
    assert(out.flags.includes("actual_labour_open"), flag);
  }
  // informational engine flags do not hold a lane
  for (
    const flag of ["text_matched_lines", "xero_project_linked_by_contact_only"]
  ) {
    const out = pe(null, frozen(), row({ completeness: [flag] }))!;
    assertEquals(out.lanes.materials.variance_ex, 300, flag);
  }
});

Deno.test("patio expected: an unreadable completeness list holds both lanes open", () => {
  for (const c of [null, undefined, "materials_not_linked", {}]) {
    const out = pe(null, frozen(), row({ completeness: c }))!;
    assertEquals(out.lanes.materials.variance_ex, null, String(c));
    assertEquals(out.lanes.labour.variance_ex, null, String(c));
    assert(out.flags.includes("actual_completeness_unreadable"), String(c));
    assertEquals(out.status, "incomplete", String(c));
  }
});
