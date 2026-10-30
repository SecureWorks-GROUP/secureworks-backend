import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type FrozenAcceptance,
  LABOUR_ACTUAL_OPEN,
  type LastSaveHashes,
  lastSaveHashes,
  MATERIALS_ACTUAL_OPEN,
  NO_REVISION_BINDING,
  PATIO_EXPECTED_SCOPE_PROJECTION,
  PATIO_FROZEN_REVISION_COLUMNS,
  PATIO_LAST_SAVE_HASH_COLUMNS,
  patioExpectedVersusActual,
  type RevisionAcceptance,
} from "./job_profit_patio_expected.ts";
import { canonicalJsonAndHash } from "../_shared/release_packet/canonicalize.ts";
import { jobProfitAction } from "./job_profit.ts";
import {
  BASELINE_REVISION_PROJECTION,
  JOB_ACCEPTANCE_NOT_TRUE,
} from "./job_profit_revision_binding.ts";

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

// The job has a quote accepted, unless a test says not.
const ACCEPTED: FrozenAcceptance = {
  accepted: true,
  source: "job_documents.accepted_at",
};

// A binding no record supplies today: the pure tests pass it only to keep the
// lane arithmetic covered, as if a revision binding existed. The action never
// passes it (NO_REVISION_BINDING).
const BOUND: RevisionAcceptance = { accepted: true, basis: "test_binding" };

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
  // an engine with JP-12 (#1107)
  installerCheck: boolean | null = true,
  acceptance: FrozenAcceptance | null = ACCEPTED,
  revisionAcceptance: RevisionAcceptance | null = BOUND,
) {
  return patioExpectedVersusActual(
    cur,
    frz,
    r,
    hashes,
    installerCheck,
    acceptance,
    revisionAcceptance,
  );
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
    // a missing list is not known, never empty (Sales contract quote 2)
    [{ sell_to_confirm: undefined }, "frozen_sell_to_confirm_not_stated"],
    [{ sell_to_confirm: "none" }, "frozen_sell_to_confirm_not_stated"],
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
  assert(legacy.flags.includes("frozen_sell_to_confirm_not_stated"));
  assertEquals(legacy.frozen_scope!.pricing.sell_to_confirm, null);
});

Deno.test("patio expected: an empty to-confirm list still passes, a missing one is null", () => {
  const out = pe(null, frozen(), row())!;
  assertEquals(out.frozen_scope!.pricing.sell_to_confirm, 0);
  assert(!out.flags.includes("frozen_sell_to_confirm_not_stated"));
  const missing = pe(
    null,
    frozen(record(), pricing({ sell_to_confirm: undefined })),
    row(),
  )!;
  assertEquals(missing.frozen_scope!.pricing.sell_to_confirm, null);
  assert(!missing.flags.includes("frozen_sell_to_confirm"));
});

Deno.test("patio expected: a frozen revision with no recorded acceptance is never compared", () => {
  const cases: Array<[FrozenAcceptance | null, string]> = [
    [{ accepted: false, source: null }, "frozen_not_accepted"],
    [{ accepted: null, source: null }, "frozen_acceptance_not_known"],
    [null, "frozen_acceptance_not_known"],
  ];
  for (const [acceptance, flag] of cases) {
    const out = pe(current(), frozen(), row(), SAME, true, acceptance)!;
    assert(out.flags.includes(flag), flag);
    // the frozen figures are still shown, but compare with nothing
    assertEquals(out.frozen_scope!.expected.materials_ex, 4000, flag);
    assertEquals(out.frozen_scope!.expected.cost_ex, 6000, flag);
    assertEquals(out.lanes.materials.expected_ex, null, flag);
    assertEquals(out.lanes.labour.expected_ex, null, flag);
    assertEquals(out.lanes.materials.variance_ex, null, flag);
    assertEquals(out.lanes.labour.variance_ex, null, flag);
    // actuals still pass through
    assertEquals(out.lanes.materials.actual_ex, 4300, flag);
    assertEquals(out.status, "incomplete", flag);
    assertEquals(out.frozen_scope!.acceptance, {
      accepted: acceptance?.accepted ?? null,
      source: null,
      scope: "job",
    });
  }
  // an accepted run counts as acceptance
  const run = pe(current(), frozen(), row(), SAME, true, {
    accepted: true,
    source: "run_acceptances",
  })!;
  assertEquals(run.lanes.materials.variance_ex, 300);
  assertEquals(run.frozen_scope!.acceptance.source, "run_acceptances");
  assertEquals(run.status, "complete");
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
const QUOTE_ACCEPTED = {
  id: "doc-1",
  job_id: JOB,
  type: "quote",
  accepted_at: "2026-10-20T09:00:00Z",
};

function fake(
  tables: Record<string, any[]>,
  errors: Record<string, string> = {},
  // the JP-12 probe: false is the rule's answer for no lines (#1107 applied)
  probe: { data: unknown; error: { message: string } | null } = {
    data: false,
    error: null,
  },
) {
  const calls: Array<{ table: string; select: unknown; eq: unknown[][] }> = [];
  const rpcs: Array<{ fn: string; args: unknown }> = [];
  return {
    calls,
    rpcs,
    rpc(fn: string, args: unknown) {
      rpcs.push({ fn, args });
      return Promise.resolve(probe);
    },
    from(table: string) {
      const call = { table, select: null as unknown, eq: [] as unknown[][] };
      calls.push(call);
      let rows = [...(tables[table] ?? [])];
      const b: any = {};
      for (const op of ["order", "limit"]) b[op] = () => b;
      b.not = (col: string, op: string, val: unknown) => {
        call.eq.push([`not.${col}.${op}`, val]);
        if (op === "is" && val === null) {
          rows = rows.filter((r) => r[col] !== null && r[col] !== undefined);
        }
        return b;
      };
      b.select = (cols: unknown) => {
        call.select = cols;
        return b;
      };
      b.eq = (col: string, val: unknown) => {
        call.eq.push([col, val]);
        rows = rows.filter((r) => r[col] === val);
        return b;
      };
      b.in = (col: string, vals: unknown[]) => {
        call.eq.push([`in.${col}`, vals]);
        rows = rows.filter((r) => vals.includes(r[col]));
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
    job_documents: [QUOTE_ACCEPTED],
  });
  const out = await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
  assertEquals(out.status, 200);
  const pe = (out.body as any).patio_expected;
  assertEquals(pe.frozen_scope.server_revision.id, "srv-row-9");
  assertEquals(pe.frozen_scope.acceptance, {
    accepted: true,
    source: "job_documents.accepted_at",
    scope: "job",
  });
  assertEquals(pe.frozen_scope.last_save_matches_frozen, true);
  // The job's acceptance may be another revision's: no released quote row
  // binds it to this one, so the frozen figures are shown but compared with
  // nothing.
  assertEquals(pe.frozen_scope.revision_acceptance, {
    accepted: null,
    basis: "accepted_document_not_released",
  });
  assertEquals(pe.frozen_scope.expected.materials_ex, 4000);
  assertEquals(pe.lanes.materials.expected_ex, null);
  assertEquals(pe.lanes.materials.variance_ex, null);
  assertEquals(pe.lanes.materials.actual_ex, 4300);
  assertEquals(pe.flags, ["frozen_revision_acceptance_not_known"]);
  assertEquals(pe.status, "incomplete");
  const jobsReads = c.calls.filter((x) => x.table === "jobs");
  assertEquals(jobsReads.map((x) => x.select), [
    PATIO_EXPECTED_SCOPE_PROJECTION,
    PATIO_LAST_SAVE_HASH_COLUMNS,
    BASELINE_REVISION_PROJECTION,
  ]);
  for (const r of jobsReads) assertEquals(r.eq, [["id", JOB]]);
  assertEquals(c.rpcs, [{
    fn: "job_cost_installer_bill",
    args: {
      p_line_items: [],
    },
  }]);
  const frozenRead = c.calls.find((x) => x.table === "scope_revisions")!;
  assertEquals(frozenRead.select, PATIO_FROZEN_REVISION_COLUMNS);
  assertEquals(frozenRead.eq, [["job_id", JOB], ["status", "frozen"], [
    "tool_kind",
    "patio",
  ]]);
});

Deno.test("job_profit: acceptance is read from quote documents and accepted runs only", async () => {
  const saved = { scope_json: record(), pricing_json: pricing() };
  const h = await lastSaveHashes(saved);
  const base = {
    v_job_profit: [row()],
    jobs: [{ id: JOB, ...current(), ...saved }],
    scope_revisions: [{ job_id: JOB, ...frozen(), ...h }],
  };
  const read = async (
    extra: Record<string, any[]>,
    errors: Record<string, string> = {},
  ) => {
    const c = fake({ ...base, ...extra }, errors);
    const out = await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
    assertEquals(out.status, 200);
    return { c, p: (out.body as any).patio_expected };
  };
  // nothing recorded: not accepted
  const none = await read({
    job_documents: [
      { ...QUOTE_ACCEPTED, accepted_at: null },
      { ...QUOTE_ACCEPTED, id: "doc-v", type: "variation" },
    ],
    run_acceptances: [{ id: "r1", job_id: JOB, status: "pending" }],
  });
  assertEquals(none.p.frozen_scope.acceptance.accepted, false);
  assert(none.p.flags.includes("frozen_not_accepted"));
  assertEquals(none.p.lanes.materials.variance_ex, null);
  const docRead = none.c.calls.find((x) => x.table === "job_documents")!;
  assertEquals(docRead.eq, [["job_id", JOB], ["type", "quote"], [
    "not.accepted_at.is",
    null,
  ]]);
  const runRead = none.c.calls.find((x) => x.table === "run_acceptances")!;
  assertEquals(runRead.eq, [["job_id", JOB], ["status", "accepted"]]);
  // an accepted run
  const run = await read({
    run_acceptances: [{ id: "r1", job_id: JOB, status: "accepted" }],
  });
  assertEquals(run.p.frozen_scope.acceptance.source, "run_acceptances");
  assertEquals(run.p.lanes.materials.variance_ex, null);
  // a failed read with nothing found is not known, and holds the comparison
  for (const table of ["job_documents", "run_acceptances"]) {
    const failed = await read({}, { [table]: "timeout" });
    assertEquals(failed.p.frozen_scope.acceptance.accepted, null, table);
    assert(failed.p.flags.includes("frozen_acceptance_not_known"), table);
    assertEquals(failed.p.lanes.materials.variance_ex, null, table);
  }
  // evidence found counts even when the other read failed
  const found = await read(
    { job_documents: [QUOTE_ACCEPTED] },
    { run_acceptances: "timeout" },
  );
  assertEquals(found.p.frozen_scope.acceptance.accepted, true);
  assertEquals(found.p.lanes.materials.variance_ex, null);
  // every case: revision acceptance is unknown at the action
  assertEquals(
    none.p.frozen_scope.revision_acceptance,
    JOB_ACCEPTANCE_NOT_TRUE,
  );
  assertEquals(
    run.p.frozen_scope.revision_acceptance.basis,
    "no_accepted_document",
  );
  assertEquals(
    found.p.frozen_scope.revision_acceptance.basis,
    "chain_unreadable",
  );
  for (const x of [none, run, found]) {
    assertEquals(x.p.frozen_scope.revision_acceptance.accepted, null);
    assert(x.p.flags.includes("frozen_revision_acceptance_not_known"));
  }
});

Deno.test("job_profit: an accepted revision A never opens a later frozen revision B", async () => {
  // A was sent and accepted; B was frozen later with the same sale and
  // different costs and was never accepted. Only B is the frozen row.
  const recB = record({
    expected: { materials: 4500, labour: 2500, sale: 9000 },
  });
  const saved = { scope_json: recB, pricing_json: pricing() };
  const h = await lastSaveHashes(saved);
  const base = {
    v_job_profit: [row()],
    jobs: [{
      id: JOB,
      ...current(recB),
      ...saved,
      // the time-pinned baseline naming B exactly is not read as a binding
      expected_costs: {
        confidence: "frozen_revision",
        scope_revision_id: "srv-row-9",
        pricing_hash: h.pricing_hash,
      },
    }],
    scope_revisions: [{ job_id: JOB, ...frozen(recB), ...h }],
  };
  const cases: Array<[string, Record<string, any[]>]> = [
    ["quote A accepted", { job_documents: [QUOTE_ACCEPTED] }],
    ["quote A accepted, then superseded", {
      job_documents: [{
        ...QUOTE_ACCEPTED,
        superseded_at: "2026-10-20T10:00:00Z",
      }],
    }],
    ["run A accepted", {
      run_acceptances: [{ id: "r1", job_id: JOB, status: "accepted" }],
    }],
    // A's released quote names A's revision, not the frozen B
    ["quote A released naming A", {
      job_documents: [QUOTE_ACCEPTED],
      quote_revisions: [{
        job_document_id: QUOTE_ACCEPTED.id,
        scope_revision_id: "srv-row-A",
        sent_at: "2026-10-19T09:00:00Z",
      }],
    }],
  ];
  const basis: Record<string, string> = {
    "quote A accepted": "accepted_document_not_released",
    "quote A accepted, then superseded": "accepted_document_not_released",
    "run A accepted": "no_accepted_document",
    "quote A released naming A": "release_not_compared_revision",
  };
  for (const [label, extra] of cases) {
    const c = fake({ ...base, ...extra });
    const out = await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
    const p = (out.body as any).patio_expected;
    assertEquals(p.frozen_scope.acceptance.accepted, true, label);
    assertEquals(
      p.frozen_scope.revision_acceptance,
      { accepted: null, basis: basis[label] },
      label,
    );
    assert(p.flags.includes("frozen_revision_acceptance_not_known"), label);
    // B's figures are shown, never compared
    assertEquals(p.frozen_scope.expected.materials_ex, 4500, label);
    assertEquals(p.lanes.materials.expected_ex, null, label);
    assertEquals(p.lanes.labour.expected_ex, null, label);
    assertEquals(p.lanes.materials.variance_ex, null, label);
    assertEquals(p.lanes.labour.variance_ex, null, label);
    assertEquals(p.status, "incomplete", label);
    // the time-pinned baseline naming B is never enough on its own, and is
    // read as its one projected path only
    for (const r of c.calls.filter((x) => x.table === "jobs")) {
      if (String(r.select).includes("expected_costs")) {
        assertEquals(r.select, BASELINE_REVISION_PROJECTION, label);
      }
    }
  }
});

Deno.test("patio expected: revision acceptance only narrows job acceptance", () => {
  // no seventh argument: unknown, closed
  const bare = patioExpectedVersusActual(
    current(),
    frozen(),
    row(),
    SAME,
    true,
    ACCEPTED,
  )!;
  assertEquals(bare.frozen_scope!.revision_acceptance, {
    accepted: null,
    basis: null,
  });
  assert(bare.flags.includes("frozen_revision_acceptance_not_known"));
  assertEquals(bare.lanes.materials.variance_ex, null);
  assertEquals(bare.status, "incomplete");
  // the action's value: unknown, closed
  const none = pe(
    current(),
    frozen(),
    row(),
    SAME,
    true,
    ACCEPTED,
    NO_REVISION_BINDING,
  )!;
  assertEquals(none.lanes.materials.expected_ex, null);
  assertEquals(
    none.frozen_scope!.revision_acceptance.basis,
    "no_recorded_binding",
  );
  // a binding, if one existed, opens it only beside job acceptance
  const bound = pe(current(), frozen(), row(), SAME, true, ACCEPTED, BOUND)!;
  assertEquals(bound.lanes.materials.variance_ex, 300);
  assertEquals(bound.status, "complete");
  assert(!bound.flags.includes("frozen_revision_acceptance_not_known"));
  for (
    const job of [
      { accepted: false, source: null },
      { accepted: null, source: null },
    ] as FrozenAcceptance[]
  ) {
    const out = pe(current(), frozen(), row(), SAME, true, job, BOUND)!;
    assertEquals(out.lanes.materials.expected_ex, null, String(job.accepted));
    assertEquals(out.status, "incomplete", String(job.accepted));
  }
  // anything but true is not a binding
  const odd = pe(current(), frozen(), row(), SAME, true, ACCEPTED, {
    accepted: false as unknown as true,
    basis: "x",
  })!;
  assertEquals(odd.frozen_scope!.revision_acceptance.accepted, null);
  assertEquals(odd.lanes.materials.expected_ex, null);
});

Deno.test("job_profit: a job with no frozen patio row reads no acceptance", async () => {
  const c = fake({ v_job_profit: [row()], jobs: [{ id: JOB, ...current() }] });
  await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
  assertEquals(
    c.calls.filter((x) =>
      x.table === "job_documents" || x.table === "run_acceptances"
    ).length,
    0,
  );
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

Deno.test("job_profit: a job that is not a patio record asks no installer probe", async () => {
  const c = fake({ v_job_profit: [row()], jobs: [{ id: JOB, ptool: "x" }] });
  await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
  assertEquals(c.rpcs, []);
});

Deno.test("job_profit: an engine without the installer rule holds both patio lanes", async () => {
  const saved = { scope_json: record(), pricing_json: pricing() };
  const h = await lastSaveHashes(saved);
  for (
    const probe of [
      { data: null, error: { message: "function does not exist" } },
      { data: true, error: null },
      { data: null, error: null },
    ]
  ) {
    const c = fake(
      {
        v_job_profit: [row()],
        jobs: [{ id: JOB, ...current(), ...saved }],
        scope_revisions: [{ job_id: JOB, ...frozen(), ...h }],
      },
      {},
      probe,
    );
    const out = await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
    assertEquals(out.status, 200);
    const p = (out.body as any).patio_expected;
    assertEquals(p.lanes.labour.variance_ex, null, JSON.stringify(probe));
    assertEquals(p.lanes.materials.variance_ex, null, JSON.stringify(probe));
    assert(p.flags.includes("installer_confirmation_not_known"));
    assertEquals(p.status, "incomplete");
    // the engine's own figures still pass through
    assertEquals((out.body as any).job.profit_ex, 2450);
  }
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
  "installer_bill_unconfirmed",
];
const LABOUR_OPEN_PINNED = [
  "no_cost_linked",
  "no_labour_linked",
  "unapproved_trade_charges",
  "unclassified_lines",
  "incomplete_invoice_lines",
  "xero_project_exceeds_line_costs",
  "installer_bill_unconfirmed",
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

// Codex review of #1122 at f2a11e61 (21 Oct 2026): confirmed labour beside an
// installer bill no person confirmed must not read as a complete lane or a
// saving. The engine (#1107) leaves the bill out of actual cost, its labour
// lines and any materials lines on the same bill alike, and flags the job.
Deno.test("patio expected: an unconfirmed installer bill holds both lanes open beside confirmed labour", () => {
  const out = pe(
    current(),
    frozen(),
    row({
      actual_labour_ex: 1800,
      completeness: ["installer_bill_unconfirmed"],
    }),
  )!;
  assertEquals(out.lanes.labour.actual_ex, 1800);
  assertEquals(out.lanes.labour.actual_complete, false);
  assertEquals(out.lanes.labour.variance_ex, null);
  assertEquals(out.lanes.materials.actual_complete, false);
  assertEquals(out.lanes.materials.variance_ex, null);
  assert(out.flags.includes("actual_labour_open"));
  assert(out.flags.includes("actual_materials_open"));
  assertEquals(out.status, "incomplete");
});

Deno.test("patio expected: without the installer rule a missing flag is not known, never confirmed", () => {
  for (const check of [null, false]) {
    const out = pe(current(), frozen(), row(), SAME, check)!;
    assertEquals(out.lanes.labour.variance_ex, null, String(check));
    assertEquals(out.lanes.materials.variance_ex, null, String(check));
    assert(out.flags.includes("installer_confirmation_not_known"));
    assertEquals(out.status, "incomplete", String(check));
  }
  const ok = pe(current(), frozen(), row())!;
  assert(!ok.flags.includes("installer_confirmation_not_known"));
  assertEquals(ok.status, "complete");
});

Deno.test("job_profit: a released quote naming the frozen and baseline revision opens the comparison", async () => {
  const saved = { scope_json: record(), pricing_json: pricing() };
  const h = await lastSaveHashes(saved);
  const bound = {
    v_job_profit: [row()],
    // ec_rev stands in for the projected expected_costs->>scope_revision_id
    // path; the fake does not project.
    jobs: [{ id: JOB, ...current(), ...saved, ec_rev: "srv-row-9" }],
    scope_revisions: [{ job_id: JOB, ...frozen(), ...h }],
    job_documents: [QUOTE_ACCEPTED],
    quote_revisions: [
      {
        job_document_id: QUOTE_ACCEPTED.id,
        scope_revision_id: "srv-row-9",
        sent_at: "2026-10-20T08:30:00Z",
      },
      // a staged row, never sent, is not a release
      {
        job_document_id: QUOTE_ACCEPTED.id,
        scope_revision_id: "srv-row-X",
        sent_at: null,
      },
    ],
  };
  const c = fake(bound);
  const out = await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
  assertEquals(out.status, 200);
  const p = (out.body as any).patio_expected;
  assertEquals(p.frozen_scope.revision_acceptance, {
    accepted: true,
    basis: null,
  });
  assert(!p.flags.includes("frozen_revision_acceptance_not_known"));
  assertEquals(p.lanes.materials.expected_ex, 4000);
  assertEquals(p.lanes.materials.variance_ex, 300);
  // The chain is read without time and without a write.
  const chainTables = [
    "job_documents",
    "run_acceptances",
    "job_variations",
    "quote_revisions",
  ];
  for (const t of chainTables) {
    assert(c.calls.some((x) => x.table === t), t);
  }
  const rel = c.calls.find((x) => x.table === "quote_revisions")!;
  assertEquals(rel.select, "job_document_id, scope_revision_id");
  assertEquals(rel.eq, [["in.job_document_id", [QUOTE_ACCEPTED.id]], [
    "not.sent_at.is",
    null,
  ]]);
  // The link column does not exist yet (42703): not known, the read is 200.
  const missing = fake(bound, {
    quote_revisions: "column quote_revisions.scope_revision_id does not exist",
  });
  const m = await jobProfitAction(
    missing,
    new URLSearchParams(`job_id=${JOB}`),
  );
  assertEquals(m.status, 200);
  const mp = (m.body as any).patio_expected;
  assertEquals(mp.frozen_scope.revision_acceptance, {
    accepted: null,
    basis: "chain_unreadable",
  });
  assertEquals(mp.lanes.materials.expected_ex, null);
  assertEquals(mp.lanes.materials.variance_ex, null);
  // Every other chain read failing is not known too.
  for (const t of ["run_acceptances", "job_variations"]) {
    const f = fake(bound, { [t]: "timeout" });
    const fp = ((await jobProfitAction(
      f,
      new URLSearchParams(`job_id=${JOB}`),
    )).body as any).patio_expected;
    assertEquals(
      fp.frozen_scope.revision_acceptance.basis,
      "chain_unreadable",
      t,
    );
    assertEquals(fp.lanes.materials.variance_ex, null, t);
  }
});
