import {
  classifyUnsourced,
  compareCatalogs,
  parityArea,
  parseCatalog,
  renderComparison,
  scopedCatalog,
} from "../compare-public-object-md5.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const a = "a".repeat(32), b = "b".repeat(32);
const fixture = (extra = "") =>
  parseCatalog([
    `view\tv_job_profit\t${a}`,
    `function\tcontext_ledger_due(p_limit integer)\t${a}`,
    `function\tgroup_work_order_share_pay(p_group_id uuid, p_budget_ex numeric)\t${a}`,
    extra,
  ].join("\n"));

Deno.test("identical Job Profit, context and pay bodies compare equal", () => {
  assert(
    compareCatalogs(scopedCatalog(fixture()), scopedCatalog(fixture()))
      .length === 0,
  );
});

for (
  const [area, object] of [
    ["job-profit", "v_job_profit"],
    ["context", "context_ledger_due(p_limit integer)"],
    ["pay", "group_work_order_share_pay(p_group_id uuid, p_budget_ex numeric)"],
  ]
) {
  Deno.test(`${area}: changed, live-only and fresh-only definitions all fail parity`, () => {
    const live = scopedCatalog(fixture());
    const changed = new Map(live);
    const row = [...live.values()].find((row) => row.name === object)!;
    const id = `${row.kind}\t${row.name}`;
    changed.set(id, { ...row, md5: b });
    const missing = new Map(live);
    missing.delete(id);
    const differences = [
      compareCatalogs(live, changed),
      compareCatalogs(live, missing),
      compareCatalogs(missing, live),
    ];
    assert(
      differences.every((rows) => rows.length === 1 && rows[0].name === object),
    );
    assert(
      differences.map((rows) => rows[0].status).join() ===
        "changed,live_only,fresh_only",
    );
  });
}

Deno.test("scope excludes unrelated changes; default comparator still reports them", () => {
  const live = fixture(`function\tunrelated()\t${a}`);
  const fresh = fixture(`function\tunrelated()\t${b}`);
  assert(compareCatalogs(live, fresh).length === 1);
  assert(
    compareCatalogs(scopedCatalog(live), scopedCatalog(fresh)).length === 0,
  );
});

Deno.test("truncated or unrelated catalogs cannot pass an empty domain", () => {
  for (
    const text of [
      `view\tv_job_profit\t${a}`,
      `function\tunrelated()\t${a}`,
    ]
  ) {
    let refused = false;
    try {
      scopedCatalog(parseCatalog(text));
    } catch {
      refused = true;
    }
    assert(refused);
  }
  for (const text of ["", `view\tv_job_profit\tnot-a-digest`]) {
    let refused = false;
    try {
      parseCatalog(text);
    } catch {
      refused = true;
    }
    assert(refused);
  }
});

Deno.test("scope covers entrypoints, money views, crew guards and overloaded signatures", () => {
  for (
    const object of [
      "job_profit(uuid)",
      "job_cost_close(uuid[], date)",
      "v_job_revenue_events",
      "v_bookkeeping_line_evidence_current",
      "bookkeeping_evidence_add(text, jsonb)",
      "job_financials",
      "v_makesafe_charge_ledger",
    ]
  ) {
    assert(parityArea(object) === "job-profit", object);
  }
  for (
    const object of [
      "context_ledger_due(integer)",
      "resolve_context_attribution(business_events)",
      "persist_luna_context_revision(uuid)",
      "attribute_business_event()",
      "ensure_booking_draft_job(text)",
      "v_evidence_health",
      "v_evidence_health_queue",
      "v_unresolved_evidence",
    ]
  ) {
    assert(parityArea(object) === "context", object);
  }
  for (
    const object of [
      "trade_pay_rule_on(date)",
      "trade_is_off_job_crew(uuid)",
      "group_reopen_requires_client_confirmation()",
      "office_issue_group_share_invoices(uuid)",
      "v_trade_charge_resolved",
      "v_invoice_line_completeness",
      "amend_group_work_order_pay_basis(uuid)",
      "approve_job_work_order_by_agent(uuid)",
      "persist_running_trade_invoice_draft_v1(jsonb)",
      "work_orders_job_kind_guard()",
    ]
  ) {
    assert(parityArea(object) === "pay", object);
  }
});

const root = new URL("../../", import.meta.url);
const contractRoot = new URL("supabase/tests/migration-contracts/", root);
Deno.test("director baseline contains catalog identifiers and md5 only, no row data", () => {
  const snapshot = Deno.readTextFileSync(
    new URL("live-public-object-md5.tsv", contractRoot),
  );
  const catalog = parseCatalog(snapshot);
  assert(scopedCatalog(catalog).size > 0);
  for (const row of catalog.values()) {
    assert(
      /^[a-z_][a-z_0-9]*(?:\([a-zA-Z_0-9 ,.\[\]]*\))?$/.test(row.name),
      row.name,
    );
  }
});

Deno.test("every omitted domain migration is inventoried once and still exists", () => {
  const registry = Deno.readTextFileSync(
    new URL("supplemental-migrations.txt", contractRoot),
  )
    .split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
  assert(new Set(registry).size === registry.length);
  assert([...registry].sort().join() === registry.join());
  const cases = new Set(
    [...Deno.readDirSync(contractRoot)].filter((entry) => entry.isDirectory)
      .map((entry) => entry.name),
  );
  const domain =
    /job_profit|job_cost|job_revenue|context|crew_pay|patio_pay|trade_invoice|trade_pay|group_work_order|job_financials|job_expected_cost_baseline|job_work_order_agent_approval/;
  const omitted = [...Deno.readDirSync(new URL("supabase/migrations/", root))]
    .filter((entry) => entry.isFile && entry.name.endsWith(".sql"))
    .map((entry) => entry.name.slice(0, -4))
    .filter((name) => domain.test(name) && !cases.has(name)).sort();
  assert(
    omitted.join() === registry.join(),
    "omitted domain migration not inventoried",
  );
});

Deno.test("unsourced live-only objects are listed without failing an otherwise equal scope", () => {
  const inventory = parseCatalog(`view\tv_evidence_health\t${a}`);
  const live = fixture(`view\tv_evidence_health\t${a}`);
  const { failures, unsourced } = classifyUnsourced(
    compareCatalogs(scopedCatalog(live), scopedCatalog(fixture())),
    inventory,
  );
  assert(failures.length === 0 && unsourced.length === 1);
  const report = renderComparison(
    failures,
    live.size,
    fixture().size,
    unsourced,
  );
  assert(report.includes("Differences: 0;"));
  assert(
    report.includes(
      `| view | v_evidence_health | live-only-unsourced | ${a} |`,
    ),
  );
});

Deno.test("unsourced inventory cannot hide changed, fresh-only or unlisted sourced objects", () => {
  const inventory = parseCatalog(`view\tv_evidence_health\t${a}`);
  const live = fixture(`view\tv_evidence_health\t${a}`);
  for (const fresh of [fixture(`view\tv_evidence_health\t${b}`), live]) {
    const diff = fresh === live
      ? compareCatalogs(fixture(), fresh)
      : compareCatalogs(live, fresh);
    const result = classifyUnsourced(diff, inventory);
    assert(result.failures.length === 1 && result.unsourced.length === 0);
  }
  const result = classifyUnsourced(compareCatalogs(live, new Map()), inventory);
  assert(result.unsourced.length === 1 && result.failures.length === 3);
});

Deno.test("changed live digest and another function overload do not inherit unsourced status", () => {
  const inventory = parseCatalog(`function\tunrelated(p_id uuid)\t${a}`);
  for (
    const row of [
      `function\tunrelated(p_id uuid)\t${b}`,
      `function\tunrelated(p_id text)\t${a}`,
      `view\tunrelated(p_id uuid)\t${a}`,
    ]
  ) {
    const result = classifyUnsourced(
      compareCatalogs(fixture(row), fixture()),
      inventory,
    );
    assert(result.failures.length === 1 && result.unsourced.length === 0);
  }
});

Deno.test("unsourced list includes unrelated-domain objects while scoped failures remain visible", () => {
  const inventory = parseCatalog(`function\tunrelated()\t${a}`);
  const live = fixture(`function\tunrelated()\t${a}`);
  const freshCatalog = fixture();
  freshCatalog.delete("view\tv_job_profit");
  const result = classifyUnsourced(
    compareCatalogs(live, freshCatalog),
    inventory,
  );
  const failures = result.failures.filter((row) => parityArea(row.name));
  const report = renderComparison(
    failures,
    live.size,
    freshCatalog.size,
    result.unsourced,
  );
  assert(failures.length === 1 && report.includes("v_job_profit | live_only"));
  assert(report.includes("unrelated() | live-only-unsourced"));
});

Deno.test("director inventory retains all 23 unsourced snapshot coordinates including six evidence views", () => {
  const inventory = parseCatalog(
    Deno.readTextFileSync(new URL("live-only-unsourced.tsv", contractRoot)),
  );
  const snapshot = parseCatalog(
    Deno.readTextFileSync(new URL("live-public-object-md5.tsv", contractRoot)),
  );
  assert(inventory.size === 23);
  assert(
    [...inventory.values()].filter((row) => parityArea(row.name) === "context")
      .length === 6,
  );
  for (const [id, row] of inventory) {
    assert(snapshot.get(id)?.md5 === row.md5, id);
  }
});
