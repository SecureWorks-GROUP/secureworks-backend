import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type FrozenAcceptance, type LastSaveHashes, lastSaveHashes, NO_REVISION_BINDING, patioExpectedVersusActual, type RevisionAcceptance } from "./job_profit_patio_expected.ts";
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

Deno.test("patio_expected: a job budget baseline (ruling 17 step 5) is the accepted one; a sent quote is not", () => {
  const budget = pe(current(), frozen(), row({ expected_source: "job_budget" })) as any;
  assertEquals(budget.commercial_baseline.source, "job_budget");
  assertEquals(budget.commercial_baseline.accepted, true);
  const sent = pe(current(), frozen(), row({ expected_source: "sent_quote_revision" })) as any;
  assertEquals(sent.commercial_baseline.accepted, false);
});
