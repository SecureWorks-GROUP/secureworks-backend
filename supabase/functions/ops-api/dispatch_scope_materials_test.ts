// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch scope material lines, stage 2
// (docs/dispatch-scope-material-lines-v1.md).
// Supplier match, copy onto job_material_lines, and who may call.
// Nothing here sends, and no price is invented.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DISPATCH_MATERIAL_LINES_PER_JOB_MAX } from "./dispatch_materials.ts";
import { DispatchScopeOrderError } from "./dispatch_scope_order.ts";
import { runDispatchScopeOrderAction } from "./dispatch_scope_order_store.ts";
import {
  confirmedUnitPrice,
  fencePostCutMm,
  matchSupplier,
  normaliseSupplierName,
  scopeLineCopyReasons,
  stockShorterThanCut,
  type SupplierCandidate,
} from "./dispatch_scope_materials.ts";
import {
  DISPATCH_SCOPE_MATERIAL_ACTIONS,
  runDispatchScopeMaterialAction,
  scopeMaterialLineId,
} from "./dispatch_scope_materials_store.ts";

const SERVICE_KEY = "test-service-role-key";
const ROUTINE_KEY = "test-routine-key";
const IMPORT_ENV: Record<string, string> = {
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
};
const index = await (async () => {
  const saved = new Map(
    Object.keys(IMPORT_ENV).map((name) => [name, Deno.env.get(name)]),
  );
  for (const [name, value] of Object.entries(IMPORT_ENV)) Deno.env.set(name, value);
  try {
    return await import("./index.ts");
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
})();
const {
  _authorizeOpsApiAction,
  _opsApiRequestHandlerForTest,
  AGENT_READ_ALLOWED_ACTIONS,
  LEAD_INSTALLER_READ_ACTIONS,
} = index;

const ORG = "00000000-0000-0000-0000-000000000001";
const JOB = "a1000000-0000-4000-8000-000000000001";
const BUILDEX = "b1000000-0000-4000-8000-000000000001";
const CMI = "b1000000-0000-4000-8000-000000000002";
const METROLL = "b1000000-0000-4000-8000-000000000003";
const METROLL_PERTH = "b1000000-0000-4000-8000-000000000004";
const STRAMIT = "b1000000-0000-4000-8000-000000000005";
const STRATCO = "b1000000-0000-4000-8000-000000000006";
const EXAMPLE_STEEL = "b1000000-0000-4000-8000-000000000007";
const MANUAL = "c1000000-0000-4000-8000-000000000001";
const ORDER_DIR = new URL("./scope_engine_orders/", import.meta.url);
const FIXTURES = ["attached-fascia", "attached-wall", "carport", "courtyard"] as const;

type Row = Record<string, any>;

const CATALOGUE: SupplierCandidate[] = [
  { id: BUILDEX, name: "Buildex", is_active: true },
  { id: CMI, name: "CMI", is_active: true },
  { id: METROLL, name: "Metroll", is_active: true },
  { id: METROLL_PERTH, name: "Metroll Perth", is_active: true },
  { id: STRAMIT, name: "Stramit", is_active: true },
  { id: STRATCO, name: "Stratco", is_active: true },
  { id: EXAMPLE_STEEL, name: "Example Steel", is_active: true },
];

function jobRow(): Row {
  return { id: JOB, org_id: ORG, job_number: "SWX-1", type: "patio", status: "accepted" };
}

function ctx(actor: { userId: string | null; email: string | null; orgId: string | null } = {
  userId: "user-1",
  email: "ada@example.test",
  orgId: ORG,
}) {
  return { orgId: ORG, actor, now: () => "2026-10-19T00:00:00.000Z" };
}

function memory(seed: {
  suppliers?: Row[];
  lines?: Row[];
  chosen?: Row[];
  prices?: Row[];
  priceError?: boolean;
} = {}) {
  const tables: Record<string, Row[]> = {
    jobs: [jobRow()],
    dispatch_scope_order_lines: [],
    suppliers: (seed.suppliers ?? CATALOGUE).map((row) => ({ ...row, org_id: ORG })),
    job_material_lines: (seed.lines ?? []).map((row) => ({ ...row })),
    job_material_suppliers: (seed.chosen ?? []).map((row) => ({ ...row })),
    material_price_ledger: (seed.prices ?? []).map((row) => ({ ...row, org_id: row.org_id ?? ORG })),
  };
  const rpcCalls: string[] = [];
  const fromCalls: string[] = [];
  return {
    tables,
    rpcCalls,
    fromCalls,
    from(name: string) {
      if (!(name in tables)) throw new Error(`unexpected table ${name}`);
      fromCalls.push(name);
      return new Builder(tables, name, seed.priceError === true);
    },
    rpc(name: string, args: { p: Row }) {
      rpcCalls.push(name);
      if (name === "dispatch_replace_scope_order_lines") {
        return Promise.resolve(replaceOrder(tables, args.p));
      }
      if (name === "dispatch_replace_scope_material_lines") {
        return Promise.resolve(replaceMaterials(tables, args.p));
      }
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
    },
  };
}

function replaceOrder(tables: Record<string, Row[]>, payload: Row) {
  const lines = Array.isArray(payload.lines) ? payload.lines as Row[] : [];
  if (!payload.scope_id || !payload.order_version || lines.length === 0) {
    return { data: null, error: { message: "no_lines" } };
  }
  const table = tables.dispatch_scope_order_lines;
  const prior = table.filter((row) => row.job_id === payload.job_id && row.scope_id === payload.scope_id);
  const priorByDemand = new Map(prior.map((row) => [row.demand_id, row]));
  const actor = payload.actor ?? {};
  const insertedIds = new Set<string>();
  const inserted = lines.map((line) => {
    const old = priorByDemand.get(line.demand_id);
    insertedIds.add(line.demand_id);
    return {
      ...line,
      supplier_match: null,
      org_id: payload.org_id,
      job_id: payload.job_id,
      scope_id: payload.scope_id,
      order_version: payload.order_version,
      created_at: old?.created_at ?? payload.now,
      created_by: old?.created_by ?? actor.user_id ?? null,
      created_by_email: old?.created_by_email ?? actor.email ?? null,
      updated_at: payload.now,
      updated_by: actor.user_id ?? null,
      updated_by_email: actor.email ?? null,
    };
  });
  tables.dispatch_scope_order_lines = [
    ...table.filter((row) => !(row.job_id === payload.job_id && row.scope_id === payload.scope_id)),
    ...inserted,
  ];
  return {
    data: { removed: prior.filter((row) => !insertedIds.has(row.demand_id)).length },
    error: null,
  };
}

function replaceMaterials(tables: Record<string, Row[]>, payload: Row) {
  const lines = Array.isArray(payload.lines) ? payload.lines as Row[] : [];
  const scopeId = typeof payload.scope_id === "string" ? payload.scope_id.trim() : "";
  if (!scopeId) return { data: null, error: { message: "scope_id_required" } };
  const jobId = payload.job_id;
  const table = tables.job_material_lines;
  const heldDemands = new Set(
    table.filter((row) =>
      row.job_id === jobId && row.source === "scope" && row.scope_id === scopeId && row.purchase_order_id
    ).map((row) => row.demand_id),
  );
  const keep = table.filter((row) =>
    !(row.job_id === jobId && row.source === "scope" && row.scope_id === scopeId && !row.purchase_order_id)
  ).length;
  const add = lines.filter((line) => !heldDemands.has(line.demand_id)).length;
  if (keep + add > DISPATCH_MATERIAL_LINES_PER_JOB_MAX) {
    return { data: null, error: { message: "too_many_lines" } };
  }
  const prior = table.filter((row) =>
    row.job_id === jobId && row.source === "scope" && row.scope_id === scopeId
  );
  const priorByDemand = new Map(prior.map((row) => [row.demand_id, row]));
  const incoming = new Set(lines.map((line) => line.demand_id));
  const removed = prior.filter((row) => !row.purchase_order_id && !incoming.has(row.demand_id)).length;
  const held = prior.filter((row) => row.purchase_order_id).length;
  const chosen = tables.job_material_suppliers;
  const onJob = new Set(chosen.filter((row) => row.job_id === jobId).map((row) => row.supplier_id));
  let position = chosen.filter((row) => row.job_id === jobId)
    .reduce((max, row) => Math.max(max, Number(row.position ?? 0)), -1);
  const seen = new Set<string>();
  const actor = payload.actor ?? {};
  for (const supplier of Array.isArray(payload.suppliers) ? payload.suppliers as Row[] : []) {
    if (seen.has(supplier.supplier_id)) continue;
    seen.add(supplier.supplier_id);
    if (onJob.has(supplier.supplier_id)) continue;
    position += 1;
    chosen.push({
      org_id: payload.org_id,
      job_id: jobId,
      supplier_id: supplier.supplier_id,
      supplier_name: supplier.supplier_name,
      position,
      created_by: actor.user_id ?? null,
      created_by_email: actor.email ?? null,
    });
  }
  tables.job_material_lines = table.filter((row) =>
    !(row.job_id === jobId && row.source === "scope" && row.scope_id === scopeId && !row.purchase_order_id)
  );
  const still = new Set(
    tables.job_material_lines.filter((row) => row.job_id === jobId && row.scope_id === scopeId)
      .map((row) => row.demand_id),
  );
  let copied = 0;
  for (const line of lines) {
    if (still.has(line.demand_id)) continue;
    const old = priorByDemand.get(line.demand_id);
    const kept = old && !old.purchase_order_id ? old : null;
    tables.job_material_lines.push({
      ...line,
      org_id: payload.org_id,
      job_id: jobId,
      scope_id: scopeId,
      supplier_id: kept ? kept.supplier_id : line.supplier_id,
      description: kept ? kept.description : line.description,
      quantity: line.quantity,
      unit: kept ? kept.unit ?? null : line.unit ?? null,
      status: kept ? kept.status : "to_order",
      source: "scope",
      product: kept ? kept.product ?? null : line.product ?? null,
      length_mm: line.length_mm ?? null,
      stock_length_mm: line.stock_length_mm ?? null,
      stock_qty: line.stock_qty ?? null,
      cut_size: line.cut_size ?? null,
      cuts: line.cuts ?? [],
      unit_price: kept ? kept.unit_price ?? null : line.unit_price ?? null,
      purchase_order_id: null,
      position: kept ? kept.position : line.position,
      created_at: old?.created_at ?? payload.now,
      created_by: old?.created_by ?? actor.user_id ?? null,
      created_by_email: old?.created_by_email ?? actor.email ?? null,
      updated_at: payload.now,
      updated_by: actor.user_id ?? null,
      updated_by_email: actor.email ?? null,
    });
    copied += 1;
  }
  for (const flag of Array.isArray(payload.flags) ? payload.flags as Row[] : []) {
    const row = tables.dispatch_scope_order_lines.find((item) =>
      item.job_id === jobId && item.scope_id === scopeId && item.demand_id === flag.demand_id
    );
    if (row) row.supplier_match = flag.supplier_match;
  }
  return { data: { removed, copied, held }, error: null };
}

class Builder {
  private filters: { op: "eq" | "in"; key: string; value: unknown }[] = [];
  private orders: { key: string; ascending: boolean }[] = [];
  private limitN: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  constructor(
    private tables: Record<string, Row[]>,
    private name: string,
    private priceError: boolean,
  ) {}
  select() {
    return this;
  }
  eq(key: string, value: unknown) {
    this.filters.push({ op: "eq", key, value });
    return this;
  }
  in(key: string, value: unknown[]) {
    this.filters.push({ op: "in", key, value });
    return this;
  }
  order(key: string, opts?: { ascending?: boolean }) {
    this.orders.push({ key, ascending: opts?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  maybeSingle() {
    const { data, error } = this.exec();
    return Promise.resolve({ data: (data ?? [])[0] ?? null, error });
  }
  then(
    resolve: (value: { data: Row[] | null; error: { message: string } | null }) => unknown,
    reject?: (reason: unknown) => unknown,
  ) {
    return Promise.resolve(this.exec()).then(resolve, reject);
  }
  private matching(): Row[] {
    return this.tables[this.name].filter((row) =>
      this.filters.every((filter) => {
        if (filter.op === "eq") return row[filter.key] === filter.value;
        return (filter.value as unknown[]).includes(row[filter.key]);
      })
    );
  }
  private exec(): { data: Row[] | null; error: { message: string } | null } {
    if (this.priceError && this.name === "material_price_ledger") {
      return { data: null, error: { message: "ledger down" } };
    }
    const rows = this.matching().map((row) => ({ ...row }));
    rows.sort((a, b) => {
      for (const order of this.orders) {
        const dir = order.ascending ? 1 : -1;
        if (a[order.key] < b[order.key]) return -1 * dir;
        if (a[order.key] > b[order.key]) return 1 * dir;
      }
      return 0;
    });
    const sliced = this.rangeFrom === null
      ? rows
      : rows.slice(this.rangeFrom, (this.rangeTo ?? rows.length) + 1);
    const limited = this.limitN === null ? sliced : sliced.slice(0, this.limitN);
    return { data: limited, error: null };
  }
}

function supplier(id: string, name: string, extra: Row = {}): Row {
  return { id, name, aliases: [], is_active: true, org_id: ORG, ...extra };
}

async function importOrder(db: ReturnType<typeof memory>, scopeId: string, order: unknown, actor = ctx()) {
  return await runDispatchScopeOrderAction(db, "dispatch_scope_order_import", new URLSearchParams(), {
    job_id: JOB,
    scope_id: scopeId,
    order_version: "patio-bought-items-2026-10-17",
    order,
  }, actor);
}

async function applyScope(
  db: ReturnType<typeof memory>,
  scopeId: string,
  actor = ctx(),
  extra: Row = {},
) {
  return await runDispatchScopeMaterialAction(db, "dispatch_scope_order_apply", new URLSearchParams(), {
    job_id: JOB,
    scope_id: scopeId,
    ...extra,
  }, actor);
}

function linesFor(rows: Row[], scopeId: string): Row[] {
  return rows.filter((row) => row.scope_id === scopeId);
}

function sampleOf(db: ReturnType<typeof memory>, scopeId: string) {
  const names = new Map(
    db.tables.job_material_suppliers.filter((row) => row.job_id === JOB)
      .map((row) => [row.supplier_id, row.supplier_name]),
  );
  return linesFor(db.tables.job_material_lines, scopeId)
    .sort((a, b) => a.position - b.position || (a.demand_id < b.demand_id ? -1 : 1))
    .map((row) => ({
      demand_id: row.demand_id,
      product: row.product,
      description: row.description,
      quantity: row.quantity,
      unit: row.unit,
      length_mm: row.length_mm,
      stock_length_mm: row.stock_length_mm,
      stock_qty: row.stock_qty,
      cuts: row.cuts,
      supplier_id: row.supplier_id,
      supplier_name: names.get(row.supplier_id) ?? null,
      status: row.status,
      source: row.source,
      unit_price: row.unit_price ?? null,
      scope_id: row.scope_id,
    }));
}

const FENCE = {
  schemaVersion: "supplier-order/v1",
  suppliers: [{
    supplier: "Example Steel",
    lines: [{
      demandIds: ["post-1"],
      productId: "post:shs:65x65",
      description: "Fence post",
      quantity: 1,
      unit: "each",
      lengthMm: 2700,
      cuts: [{ lengthMm: 2550, qty: 1 }],
      requirements: [{ references: ["post-1"] }],
    }],
  }],
};

function knownOrder(supplierName: string, extra: Row = {}) {
  return {
    schemaVersion: "supplier-order/v1",
    suppliers: [{
      supplier: supplierName,
      lines: [{
        demandIds: ["post-1"],
        productId: "post:shs:65x65",
        description: "Fence post",
        quantity: 1,
        unit: "each",
        lengthMm: 2700,
        cuts: [{ lengthMm: 2550, qty: 1 }],
        ...extra,
      }],
    }],
  };
}

Deno.test("match: exact, normalised and alias hit; a place name and punctuation do not", () => {
  assertEquals(normaliseSupplierName("  Stratco\u00a0 "), "stratco");
  assertEquals(matchSupplier("Stratco", CATALOGUE), {
    status: "matched",
    supplier_id: STRATCO,
    supplier_name: "Stratco",
  });
  assertEquals(matchSupplier(" stratco ", CATALOGUE).status, "matched");
  assertEquals(matchSupplier("Stratco.", CATALOGUE), {
    status: "unmatched",
    reason: "supplier_unmatched",
  });
  const perth = matchSupplier("Metroll Perth", CATALOGUE);
  assert(perth.status === "matched");
  assertEquals(perth.supplier_id, METROLL_PERTH);
  const metroll = matchSupplier("Metroll", CATALOGUE);
  assert(metroll.status === "matched");
  assertEquals(metroll.supplier_id, METROLL);
  const blank = matchSupplier("   ", CATALOGUE);
  assert(blank.status === "unmatched");
  assertEquals(blank.reason, "supplier_not_stated");
  const missing = matchSupplier(null, CATALOGUE);
  assert(missing.status === "unmatched");
  assertEquals(missing.reason, "supplier_not_stated");
  const aliased = matchSupplier("Metroll Perth", [
    { id: METROLL, name: "Metroll WA", aliases: ["Metroll Perth"], is_active: true },
  ]);
  assertEquals(aliased, { status: "matched", supplier_id: METROLL, supplier_name: "Metroll WA" });
  assertEquals(matchSupplier("Stratco", [
    { id: STRATCO, name: "Stratco", is_active: true },
    { id: BUILDEX, name: "stratco", is_active: true },
  ]).status, "ambiguous");
  assertEquals(matchSupplier("Stratco", [
    { id: STRATCO, name: "Stratco", is_active: false },
  ]), { status: "unmatched", reason: "supplier_inactive" });
  const activeWins = matchSupplier("Stratco", [
    { id: STRATCO, name: "Stratco", is_active: true },
    { id: BUILDEX, name: "Stratco", is_active: false },
  ]);
  assert(activeWins.status === "matched");
  assertEquals(activeWins.supplier_id, STRATCO);
  assertEquals(matchSupplier("Stratco", [
    { id: STRATCO, name: "Stratco", is_active: null },
  ]).status, "matched");
});

Deno.test("price: a confirmed ledger row is used, and nothing else is", () => {
  const rows = [
    {
      id: "b",
      material_code: "practice-cmi-patioline",
      supplier_name: "CMI",
      unit_price: 10,
      status: "confirmed",
      confirmed_at: "2026-09-01T00:00:00Z",
    },
    {
      id: "a",
      material_code: "practice-cmi-patioline",
      supplier_name: "cmi",
      unit_price: 19.5,
      status: "confirmed",
      confirmed_at: "2026-10-01T00:00:00Z",
    },
    {
      id: "p",
      material_code: "practice-cmi-patioline",
      supplier_name: "CMI",
      unit_price: 99,
      status: "pending",
      confirmed_at: "2026-11-01T00:00:00Z",
    },
    {
      id: "s",
      material_code: "practice-cmi-patioline",
      supplier_name: "Stratco",
      unit_price: 40,
      status: "confirmed",
      confirmed_at: "2026-12-01T00:00:00Z",
    },
    {
      id: "n",
      material_code: "practice-cmi-patioline",
      supplier_name: "CMI",
      unit_price: -1,
      status: "confirmed",
      confirmed_at: "2026-12-02T00:00:00Z",
    },
    {
      id: "z",
      material_code: "other",
      supplier_name: "CMI",
      unit_price: 0,
      status: "confirmed",
      confirmed_at: "2026-10-02T00:00:00Z",
    },
  ];
  assertEquals(confirmedUnitPrice("practice-cmi-patioline", ["CMI"], rows), 19.5);
  assertEquals(confirmedUnitPrice("other", ["CMI"], rows), 0);
  assertEquals(confirmedUnitPrice("practice-cmi-patioline", ["Stratco"], rows), 40);
  assertEquals(
    confirmedUnitPrice("practice-cmi-patioline", ["Metroll WA", "Metroll Perth"], [{
      id: "1",
      material_code: "practice-cmi-patioline",
      supplier_name: "metroll perth",
      unit_price: 8,
      status: "confirmed",
      confirmed_at: "2026-10-01T00:00:00Z",
    }]),
    8,
  );
  assertEquals(confirmedUnitPrice("missing", ["CMI"], rows), null);
  const tied = confirmedUnitPrice("post", ["Example Steel"], [
    {
      id: "m",
      material_code: "post",
      supplier_name: "Example Steel",
      unit_price: 2,
      status: "confirmed",
      confirmed_at: "2026-10-01T00:00:00Z",
    },
    {
      id: "a",
      material_code: "post",
      supplier_name: "Example Steel",
      unit_price: 3,
      status: "confirmed",
      confirmed_at: "2026-10-01T00:00:00Z",
    },
  ]);
  assertEquals(tied, 3);
});

Deno.test("price: confirmed_at is a timestamp, so .9Z is newer than a whole Z", () => {
  const row = (id: string, unit_price: number, confirmed_at: string) => ({
    id,
    material_code: "post",
    supplier_name: "Example Steel",
    unit_price,
    status: "confirmed",
    confirmed_at,
  });
  // Lexicographic order puts 00:00:00Z after 00:00:00.9Z because "." < "Z".
  assertEquals(confirmedUnitPrice("post", ["Example Steel"], [
    row("old", 3, "2026-10-01T00:00:00Z"),
    row("new", 4, "2026-10-01T00:00:00.9Z"),
  ]), 4);
  assertEquals(confirmedUnitPrice("post", ["Example Steel"], [
    row("whole", 7, "2026-10-01T00:00:00+00:00"),
    row("mid", 5, "2026-10-01T00:00:00.5+00:00"),
    row("later", 6, "2026-10-01T00:00:00.9+00:00"),
  ]), 6);
  assertEquals(confirmedUnitPrice("post", ["Example Steel"], [
    row("b", 8, "2026-10-01T00:00:00Z"),
    row("a", 9, "2026-10-01T00:00:00+00:00"),
  ]), 9);
  assertEquals(confirmedUnitPrice("post", ["Example Steel"], [
    row("b", 1, "2026-10-01T00:00:00.9Z"),
    row("a", 2, "2026-10-01T00:00:00.900+00:00"),
  ]), 2);
  assertEquals(confirmedUnitPrice("post", ["Example Steel"], [
    row("bad", 11, "not-a-time"),
    row("ok", 12, "2026-10-01T00:00:00Z"),
  ]), 12);
  assertEquals(confirmedUnitPrice("post", ["Example Steel"], [
    { ...row("none", 13, "2026-10-01T00:00:00Z"), confirmed_at: null },
    row("ok", 14, "2026-10-01T00:00:00Z"),
  ]), 14);
});

Deno.test("copy: a bar shorter than a cut is flagged, and a fence post is sheet plus rail plus 600", () => {
  assertEquals(fencePostCutMm(1800, 150), 2550);
  const matched = matchSupplier("Example Steel", CATALOGUE);
  const lengths = (stock: number | null, cuts: number[]) => ({
    stock_length_mm: stock,
    cuts: cuts.map((length_mm) => ({ length_mm })),
  });
  assertEquals(stockShorterThanCut(2400, [{ length_mm: 2550 }]), true);
  assertEquals(stockShorterThanCut(2700, [{ length_mm: 2550 }]), false);
  assertEquals(stockShorterThanCut(2550, [{ length_mm: 2550 }]), false);
  assertEquals(stockShorterThanCut(null, [{ length_mm: 2550 }]), false);
  assertEquals(
    stockShorterThanCut(2700, [{ length_mm: 2400 }, { length_mm: 2800 }]),
    true,
  );
  assertEquals(
    scopeLineCopyReasons(false, matched, lengths(2700, [fencePostCutMm(1800, 150)])),
    [],
  );
  assertEquals(
    scopeLineCopyReasons(false, matched, lengths(2400, [2550])),
    ["stock_shorter_than_cut"],
  );
  assertEquals(
    scopeLineCopyReasons(true, { status: "ambiguous", reason: "supplier_ambiguous" }, lengths(2400, [2550])),
    ["unknown_product", "supplier_ambiguous", "stock_shorter_than_cut"],
  );
});

Deno.test("apply: fence post, four patio fixtures, re-import, and a manual line", async () => {
  const manual = {
    id: MANUAL,
    org_id: ORG,
    job_id: JOB,
    supplier_id: STRATCO,
    description: "Hand added post cap",
    quantity: 4,
    unit: "each",
    status: "not_reviewed",
    source: "manual",
    position: 0,
    scope_id: null,
    demand_id: null,
    purchase_order_id: null,
    product: null,
    unit_price: null,
  };
  const db = memory({
    lines: [manual],
    prices: [
      {
        id: "price-old",
        material_code: "practice-cmi-patioline",
        supplier_name: "CMI",
        unit_price: 10,
        status: "confirmed",
        confirmed_at: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "price-new",
        material_code: "practice-cmi-patioline",
        supplier_name: "CMI",
        unit_price: 19.5,
        status: "confirmed",
        confirmed_at: "2026-10-01T00:00:00.000Z",
      },
      {
        id: "price-pending",
        material_code: "practice-cmi-patioline",
        supplier_name: "CMI",
        unit_price: 99,
        status: "pending",
        confirmed_at: "2026-11-01T00:00:00.000Z",
      },
      {
        id: "price-other",
        material_code: "practice-cmi-patioline",
        supplier_name: "Stratco",
        unit_price: 40,
        status: "confirmed",
        confirmed_at: "2026-12-01T00:00:00.000Z",
      },
    ],
  });
  const supplierCount = db.tables.suppliers.length;
  const counts: Record<string, { order: number; copied: number; flagged: number }> = {};
  let fasciaGutterId = "";
  for (const name of FIXTURES) {
    const order = JSON.parse(await Deno.readTextFile(new URL(`${name}.json`, ORDER_DIR)));
    const stated = new Set<string>();
    for (const group of order.suppliers ?? []) stated.add(group.supplier);
    for (const label of stated) {
      assert(
        CATALOGUE.some((row) => row.name === label),
        `${name} states ${label}`,
      );
    }
    const saved = await importOrder(db, `example-${name}`, order);
    assertEquals(saved.sends, false);
    const stored = db.tables.dispatch_scope_order_lines.filter((row) => row.scope_id === `example-${name}`);
    const known = stored.filter((row) => row.product_unknown !== true && row.product);
    const named = stored.find((row) => row.product === "practice-cmi-patioline");
    if (name === "attached-fascia") {
      assertEquals(named?.product_unknown, false);
      assertEquals(named?.price_to_confirm, true);
      assert(stored.some((row) => row.product_unknown === true));
    }
    const applied = await applyScope(db, `example-${name}`);
    assertEquals(applied.sends, false);
    const copied = linesFor(applied.material_lines as Row[], `example-${name}`);
    assertEquals(copied.length, known.length, name);
    assertEquals((applied.flagged as Row[]).length, stored.length - known.length, name);
    assert(copied.every((row) => row.status === "to_order" && row.source === "scope"));
    counts[name] = { order: stored.length, copied: copied.length, flagged: (applied.flagged as Row[]).length };
    if (name === "attached-fascia") {
      const gutter = copied.find((row) => row.product === "practice-cmi-patioline");
      assert(gutter, "fascia gutter");
      fasciaGutterId = gutter.id;
      assertEquals(gutter.supplier_id, CMI);
      assertEquals(gutter.quantity, 1);
      assertEquals(gutter.stock_length_mm, 7000);
      assertEquals(gutter.length_mm, 6000);
      assertEquals(gutter.cuts, [{ length_mm: 6000, qty: 1 }]);
      assertEquals(gutter.unit_price, 19.5);
      assertEquals(gutter.id, await scopeMaterialLineId(JOB, "example-attached-fascia", gutter.demand_id));
      const post = copied.find((row) => row.product === "p-stratco-est2-09090po31-colour");
      assertEquals(post?.supplier_id, STRATCO);
      assertEquals(post?.unit_price ?? null, null);
    }
  }
  assertEquals(db.tables.suppliers.length, supplierCount);
  const hand = db.tables.job_material_lines.find((row) => row.id === MANUAL);
  assertEquals(hand, manual);

  await importOrder(db, "fence-example", FENCE);
  const fence = await applyScope(db, "fence-example");
  assertEquals(fence.sends, false);
  const fenceLines = linesFor(fence.material_lines as Row[], "fence-example");
  assertEquals(fenceLines.length, 1);
  assertEquals(fence.copied, 1);
  assertEquals(fence.flagged, []);
  const post = fenceLines[0];
  assertEquals(post.demand_id, "post-1");
  assertEquals(post.product, "post:shs:65x65");
  assertEquals(post.quantity, 1);
  assertEquals(post.stock_length_mm, 2700);
  assertEquals(post.stock_qty, 1);
  assertEquals(post.length_mm, 2550);
  assertEquals(post.cuts, [{ length_mm: 2550, qty: 1 }]);
  assertEquals(post.supplier_id, EXAMPLE_STEEL);
  assertEquals(post.status, "to_order");
  assertEquals(post.unit_price ?? null, null);
  assertEquals(post.scope_id, "fence-example");
  assertEquals(
    db.tables.job_material_suppliers.find((row) => row.supplier_id === EXAMPLE_STEEL)?.supplier_name,
    "Example Steel",
  );
  assertEquals(db.tables.job_material_lines.find((row) => row.id === MANUAL), manual);

  const wallBefore = JSON.stringify(sampleOf(db, "example-attached-wall"));
  const fascia = JSON.parse(await Deno.readTextFile(new URL("attached-fascia.json", ORDER_DIR)));
  const gutterPurchase = fascia.suppliers.flatMap((group: Row) => group.lines).find((line: Row) =>
    line.productId === "practice-cmi-patioline"
  );
  gutterPurchase.quantity = 2;
  await importOrder(db, "example-attached-fascia", fascia, ctx({
    userId: "user-2",
    email: "bea@example.test",
    orgId: ORG,
  }));
  const cleared = db.tables.dispatch_scope_order_lines.find((row) =>
    row.scope_id === "example-attached-fascia" && row.product === "practice-cmi-patioline"
  );
  assertEquals(cleared?.supplier_match ?? null, null);
  assertEquals(cleared?.created_by, "user-1");
  const again = await applyScope(db, "example-attached-fascia", ctx({
    userId: "user-2",
    email: "bea@example.test",
    orgId: ORG,
  }));
  const gutterAgain = (again.material_lines as Row[]).find((row) => row.id === fasciaGutterId);
  assert(gutterAgain, "reapplied gutter");
  assertEquals(gutterAgain.quantity, 2);
  assertEquals(gutterAgain.created_by, "user-1");
  assertEquals(gutterAgain.updated_by, "user-2");
  assertEquals(gutterAgain.unit_price, 19.5);
  const restored = db.tables.dispatch_scope_order_lines.find((row) => row.product === "practice-cmi-patioline" &&
    row.scope_id === "example-attached-fascia"
  );
  assertEquals(restored?.supplier_match, "matched");
  assertEquals(JSON.stringify(sampleOf(db, "example-attached-wall")), wallBefore);
  assertEquals(db.tables.job_material_lines.find((row) => row.id === MANUAL), manual);
  assertEquals(linesFor(db.tables.job_material_lines, "fence-example").length, 1);

  const listed = await runDispatchScopeMaterialAction(
    db,
    "dispatch_scope_material_lines",
    new URLSearchParams({ job_id: JOB }),
    null,
    ctx(),
  );
  assertEquals(listed.sends, false);
  assert((listed.material_lines as Row[]).some((row) => row.id === MANUAL));
  console.log("NOTE 19.50 is a planted confirmed material_price_ledger row for practice-cmi-patioline at CMI. The fixtures carry no price.");
  console.log("COUNTS " + JSON.stringify({ fixtures: counts, fence: { copied: 1, flagged: 0 } }));
  console.log(
    "SAMPLE fascia after re-import (gutter quantity was set to 2 in this test; the engine document is quantity 1, stock 1 x 7000, cut 1 x 6000) " +
      JSON.stringify(sampleOf(db, "example-attached-fascia")),
  );
  console.log("SAMPLE fence " + JSON.stringify(sampleOf(db, "fence-example")));
});

Deno.test("apply: stock shorter than a cut is flagged and not copied", async () => {
  const db = memory({ suppliers: [supplier(EXAMPLE_STEEL, "Example Steel")] });
  await importOrder(db, "short-stock", knownOrder("Example Steel", {
    lengthMm: 2400,
    cuts: [{ lengthMm: 2550, qty: 1 }],
  }));
  const stored = db.tables.dispatch_scope_order_lines.find((row) => row.scope_id === "short-stock");
  assertEquals(stored?.product_unknown, false);
  assertEquals(stored?.stock_length_mm, 2400);
  assertEquals(stored?.length_mm, 2550);
  const applied = await applyScope(db, "short-stock");
  assertEquals(applied.copied, 0);
  assertEquals(linesFor(db.tables.job_material_lines, "short-stock"), []);
  assertEquals((applied.flagged as Row[])[0].reasons, ["stock_shorter_than_cut"]);

  await importOrder(db, "short-and-unknown", knownOrder("Example Steel", {
    productId: "rhs:100",
    description: "Beam to confirm",
    toConfirm: ["length"],
    demandIds: ["beam-x"],
    lengthMm: 2400,
    cuts: [{ lengthMm: 2550, qty: 1 }],
  }));
  const both = await applyScope(db, "short-and-unknown");
  assertEquals(both.copied, 0);
  assertEquals((both.flagged as Row[])[0].reasons, ["unknown_product", "stock_shorter_than_cut"]);
});

Deno.test("apply: re-apply updates quantity and cuts and keeps a hand price and status", async () => {
  const db = memory({ suppliers: [supplier(EXAMPLE_STEEL, "Example Steel"), supplier(STRATCO, "Stratco")] });
  await importOrder(db, "fence-example", FENCE);
  const first = await applyScope(db, "fence-example");
  const shown = (first.material_lines as Row[])[0];
  assertEquals(shown.unit_price ?? null, null);
  assertEquals(shown.status, "to_order");
  const line = db.tables.job_material_lines.find((row) => row.demand_id === "post-1");
  assert(line, "stored post");
  line.unit_price = 88;
  line.status = "in_stock";
  line.description = "Hand wording";
  line.position = 7;
  db.tables.material_price_ledger.push({
    id: "price-later",
    org_id: ORG,
    material_code: "practice-cmi-patioline",
    supplier_name: "Stratco",
    unit_price: 50,
    status: "confirmed",
    confirmed_at: "2026-10-02T00:00:00.9Z",
  });
  const revised = knownOrder("Stratco", {
    productId: "practice-cmi-patioline",
    description: "Scope wording",
    quantity: 4,
    unit: "length",
    lengthMm: 2700,
    cuts: [{ lengthMm: 2400, qty: 2 }],
  });
  await importOrder(db, "fence-example", revised, ctx({
    userId: "user-2",
    email: "bea@example.test",
    orgId: ORG,
  }));
  const again = await applyScope(db, "fence-example", ctx({
    userId: "user-2",
    email: "bea@example.test",
    orgId: ORG,
  }));
  const kept = (again.material_lines as Row[]).find((row) => row.demand_id === "post-1");
  assert(kept, "reapplied post");
  assertEquals(kept.quantity, 4);
  assertEquals(kept.stock_qty, 4);
  assertEquals(kept.length_mm, 2400);
  assertEquals(kept.stock_length_mm, 2700);
  assertEquals(kept.cuts, [{ length_mm: 2400, qty: 2 }]);
  assertEquals(kept.cut_size, "2 x 2400 mm");
  assertEquals(kept.unit_price, 88);
  assertEquals(kept.status, "in_stock");
  assertEquals(kept.description, "Hand wording");
  assertEquals(kept.product, "post:shs:65x65");
  assertEquals(kept.unit, "each");
  assertEquals(kept.supplier_id, EXAMPLE_STEEL);
  assertEquals(kept.position, 7);
  assertEquals(kept.created_by, "user-1");
  assertEquals(kept.updated_by, "user-2");
  assertEquals(again.copied, 1);
});

Deno.test("apply: an ambiguous supplier is flagged and not copied", async () => {
  const db = memory({
    suppliers: [
      supplier(STRATCO, "Stratco"),
      supplier(BUILDEX, "stratco"),
    ],
  });
  await importOrder(db, "fence-example", knownOrder("Stratco"));
  const applied = await applyScope(db, "fence-example");
  assertEquals(applied.copied, 0);
  assertEquals(linesFor(db.tables.job_material_lines, "fence-example"), []);
  assertEquals((applied.flagged as Row[])[0].reasons, ["supplier_ambiguous"]);
  assertEquals((applied.flagged as Row[])[0].supplier_match, "ambiguous");
});

Deno.test("apply: an unknown product is not copied even when the supplier matches", async () => {
  const db = memory({ suppliers: [supplier(STRATCO, "Stratco")] });
  await importOrder(db, "fence-example", knownOrder("Stratco", {
    productId: "rhs:100",
    description: "Beam to confirm",
    toConfirm: ["length"],
    demandIds: ["beam-x"],
  }));
  const applied = await applyScope(db, "fence-example");
  assertEquals(applied.copied, 0);
  assertEquals(db.tables.job_material_lines, []);
  const flagged = (applied.flagged as Row[])[0];
  assertEquals(flagged.product_unknown, true);
  assertEquals(flagged.reasons, ["unknown_product"]);
  assertEquals(flagged.supplier_match, "matched");
});

Deno.test("apply: an alias matches, and an inactive record does not", async () => {
  const aliasDb = memory({
    suppliers: [supplier(METROLL, "Metroll WA", { aliases: ["Metroll Perth"] })],
  });
  await importOrder(aliasDb, "metroll-scope", knownOrder("Metroll Perth"));
  const aliased = await applyScope(aliasDb, "metroll-scope");
  assertEquals(aliased.copied, 1);
  assertEquals(aliasDb.tables.job_material_suppliers[0].supplier_name, "Metroll WA");
  assertEquals((aliased.material_lines as Row[])[0].supplier_id, METROLL);

  const desk = memory({
    suppliers: [supplier(EXAMPLE_STEEL, "Example Steel")],
    chosen: [{
      org_id: ORG,
      job_id: JOB,
      supplier_id: EXAMPLE_STEEL,
      supplier_name: "Example Steel (desk)",
      position: 0,
    }],
  });
  await importOrder(desk, "fence-example", FENCE);
  await applyScope(desk, "fence-example");
  assertEquals(desk.tables.job_material_suppliers[0].supplier_name, "Example Steel (desk)");
  assertEquals(desk.tables.suppliers.length, 1);

  const inactive = memory({
    suppliers: [supplier(STRATCO, "Stratco", { is_active: false })],
  });
  await importOrder(inactive, "fence-example", knownOrder("Stratco"));
  const refused = await applyScope(inactive, "fence-example");
  assertEquals(refused.copied, 0);
  assertEquals((refused.flagged as Row[])[0].reasons, ["supplier_inactive"]);
  assertEquals((refused.flagged as Row[])[0].supplier_match, "unmatched");
  assertEquals(inactive.tables.job_material_suppliers, []);
});

Deno.test("apply: a body price is ignored, a held line stays, and a miss writes nothing", async () => {
  const db = memory({ suppliers: [supplier(EXAMPLE_STEEL, "Example Steel")] });
  await importOrder(db, "fence-example", FENCE);
  const first = await applyScope(db, "fence-example", ctx(), { unit_price: 999 });
  assertEquals((first.material_lines as Row[])[0].unit_price ?? null, null);
  const id = (first.material_lines as Row[])[0].id;
  db.tables.job_material_lines[0].purchase_order_id = "d1000000-0000-4000-8000-000000000001";
  const bumped = structuredClone(FENCE);
  bumped.suppliers[0].lines[0].quantity = 9;
  await importOrder(db, "fence-example", bumped);
  const held = await applyScope(db, "fence-example");
  assertEquals(held.copied, 0);
  assertEquals(held.held, 1);
  const row = db.tables.job_material_lines.find((line) => line.id === id);
  assertEquals(row?.quantity, 1);
  assertEquals(row?.purchase_order_id, "d1000000-0000-4000-8000-000000000001");

  const empty = memory();
  const before = empty.fromCalls.slice();
  const error = await assertRejects(
    () => applyScope(empty, "missing-scope"),
    DispatchScopeOrderError,
  );
  assertEquals(error.body.code, "no_lines");
  assertEquals(empty.rpcCalls, []);
  assertEquals(empty.tables.job_material_lines, []);
  assert(!empty.fromCalls.includes("suppliers"));
  assert(!empty.fromCalls.includes("material_price_ledger"));
  assert(before.length === 0);
});

Deno.test("apply: over the line cap, a ledger error, and a full price page write nothing", async () => {
  const full = memory({
    suppliers: [supplier(EXAMPLE_STEEL, "Example Steel")],
    lines: Array.from({ length: DISPATCH_MATERIAL_LINES_PER_JOB_MAX }, (_, index) => ({
      id: `e1000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      job_id: JOB,
      org_id: ORG,
      supplier_id: EXAMPLE_STEEL,
      description: "Hand line",
      quantity: 1,
      status: "not_reviewed",
      source: "manual",
      position: index,
      scope_id: null,
      demand_id: null,
    })),
    chosen: [{
      job_id: JOB,
      supplier_id: EXAMPLE_STEEL,
      supplier_name: "Example Steel",
      position: 0,
    }],
  });
  await importOrder(full, "fence-example", FENCE);
  const calls = full.rpcCalls.length;
  const capped = await assertRejects(() => applyScope(full, "fence-example"), DispatchScopeOrderError);
  assertEquals(capped.status, 409);
  assertEquals(capped.body.code, "too_many_lines");
  assertEquals(full.rpcCalls.length, calls);
  assertEquals(full.tables.job_material_lines.length, DISPATCH_MATERIAL_LINES_PER_JOB_MAX);

  const broken = memory({
    suppliers: [supplier(EXAMPLE_STEEL, "Example Steel")],
    priceError: true,
  });
  await importOrder(broken, "fence-example", FENCE);
  const priceCalls = broken.rpcCalls.length;
  const failed = await assertRejects(() => applyScope(broken, "fence-example"), DispatchScopeOrderError);
  assertEquals(failed.body.code, "price_read_failed");
  assertEquals(broken.rpcCalls.length, priceCalls);
  assertEquals(broken.tables.job_material_lines, []);

  const page = memory({
    suppliers: [supplier(EXAMPLE_STEEL, "Example Steel")],
    prices: Array.from({ length: 200 }, (_, index) => ({
      id: `p${String(index).padStart(4, "0")}`,
      material_code: "post:shs:65x65",
      supplier_name: "Example Steel",
      unit_price: 1,
      status: "confirmed",
      confirmed_at: "2026-10-01T00:00:00.000Z",
    })),
  });
  await importOrder(page, "fence-example", FENCE);
  const pageCalls = page.rpcCalls.length;
  const fullPage = await assertRejects(() => applyScope(page, "fence-example"), DispatchScopeOrderError);
  assertEquals(fullPage.body.code, "price_read_failed");
  assertEquals(page.rpcCalls.length, pageCalls);
  assertEquals(page.tables.job_material_lines, []);
});

Deno.test("store: the module does not send, fetch, or insert a supplier", async () => {
  const source = await Deno.readTextFile(new URL("./dispatch_scope_materials_store.ts", import.meta.url));
  assert(!source.includes("fetch("));
  assert(!source.includes("purchase_orders"));
  assert(!source.includes("job_events"));
  assert(!source.includes(".insert("));
  assert(!source.includes("scope_json"));
});

Deno.test("gate: the two material actions are staff only", () => {
  assertEquals([...DISPATCH_SCOPE_MATERIAL_ACTIONS], [
    "dispatch_scope_material_lines",
    "dispatch_scope_order_apply",
  ]);
  for (const action of DISPATCH_SCOPE_MATERIAL_ACTIONS) {
    const url = new URL(`https://example.test/functions/v1/ops-api?action=${action}`);
    for (const role of ["admin", "owner", "ops_manager"]) {
      assertEquals(_authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role } }), { ok: true });
    }
    for (const authUser of [
      { role: "installer" },
      { role: "lead_installer", managedVerticals: ["fencing", "patio"] },
    ]) {
      const refused = _authorizeOpsApiAction({ url, authMode: "jwt", authUser }) as any;
      assertEquals(refused.ok, false);
      assertEquals(refused.status, 403);
      assertEquals(refused.code, "operator_access_required");
    }
    const anonymous = _authorizeOpsApiAction({ url, authMode: "none" }) as any;
    assertEquals(anonymous.status, 401);
    assert(!AGENT_READ_ALLOWED_ACTIONS.has(action));
    assert(!LEAD_INSTALLER_READ_ACTIONS.has(action));
  }
});

const ENV: Record<string, string> = { ...IMPORT_ENV, MAKESAFE_ROUTINE_KEY: ROUTINE_KEY };

async function withEnvAndFetchSpy<T>(fn: (calls: string[]) => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(ENV).map((name) => [name, Deno.env.get(name)]));
  for (const [name, value] of Object.entries(ENV)) Deno.env.set(name, value);
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response("{}", { status: 500 }));
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

Deno.test("gate: the routine key is refused before any call, and apply by GET is 405", async () => {
  await withEnvAndFetchSpy(async (calls) => {
    for (const action of DISPATCH_SCOPE_MATERIAL_ACTIONS) {
      const res = await _opsApiRequestHandlerForTest(new Request(
        `https://example.invalid/ops-api?action=${action}&job_id=${JOB}`,
        {
          method: action === "dispatch_scope_material_lines" ? "GET" : "POST",
          headers: { "content-type": "application/json", "x-api-key": ROUTINE_KEY },
          body: action === "dispatch_scope_material_lines" ? undefined : JSON.stringify({ job_id: JOB }),
        },
      ));
      assertEquals(res.status, 403, action);
      await res.body?.cancel();
    }
    const headers = { "content-type": "application/json", authorization: `Bearer ${SERVICE_KEY}` };
    const get = await _opsApiRequestHandlerForTest(new Request(
      "https://example.invalid/ops-api?action=dispatch_scope_order_apply",
      { headers },
    ));
    assertEquals(get.status, 405);
    await get.body?.cancel();
    const bad = await _opsApiRequestHandlerForTest(new Request(
      "https://example.invalid/ops-api?action=dispatch_scope_material_lines&job_id=nope",
      { headers },
    ));
    assertEquals(bad.status, 400);
    assertEquals((await bad.json()).code, "invalid_request");
    assertEquals(calls, []);
  });
});
