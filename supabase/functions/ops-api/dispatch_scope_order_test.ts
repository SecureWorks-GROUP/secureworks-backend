// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch scope order lines, stage 1 (docs/dispatch-scope-order-lines-v1.md).
// The parser, the import against an in-memory stand-in, the scope-engine-v2
// supplier orders, and who may call. Nothing here sends.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DispatchScopeOrderError,
  formatScopeOrderLine,
  parseScopeOrder,
  type ScopeOrderLine,
} from "./dispatch_scope_order.ts";
import {
  DISPATCH_SCOPE_ORDER_ACTIONS,
  runDispatchScopeOrderAction,
} from "./dispatch_scope_order_store.ts";

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
const OTHER = "00000000-0000-0000-0000-0000000000ee";
const JOB = "a1000000-0000-4000-8000-000000000001";
const MAKESAFE = "a1000000-0000-4000-8000-000000000002";
const OTHER_JOB = "a1000000-0000-4000-8000-000000000003";
const SCOPE = "scope-a";
const VERSION = "v1";

type Row = Record<string, any>;

function memory(jobs: Row[]) {
  const tables: Record<string, Row[]> = {
    jobs: jobs.map((row) => ({ ...row })),
    dispatch_scope_order_lines: [],
  };
  return {
    tables,
    from(name: string) {
      if (!(name in tables)) throw new Error(`unexpected table ${name}`);
      return new Builder(tables, name);
    },
    rpc(name: string, args: { p: Row }) {
      if (name !== "dispatch_replace_scope_order_lines") {
        return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
      }
      const payload = args.p;
      const lines = Array.isArray(payload.lines) ? payload.lines as Row[] : [];
      if (!payload.scope_id || !payload.order_version || lines.length === 0) {
        return Promise.resolve({ data: null, error: { message: "no_lines" } });
      }
      const table = tables.dispatch_scope_order_lines;
      const prior = table.filter((row) =>
        row.job_id === payload.job_id && row.scope_id === payload.scope_id
      );
      const priorByDemand = new Map(prior.map((row) => [row.demand_id, row]));
      const actor = payload.actor ?? {};
      const insertedIds = new Set<string>();
      const inserted = lines.map((line) => {
        const old = priorByDemand.get(line.demand_id);
        insertedIds.add(line.demand_id);
        return {
          ...line,
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
        ...table.filter((row) =>
          !(row.job_id === payload.job_id && row.scope_id === payload.scope_id)
        ),
        ...inserted,
      ];
      return Promise.resolve({
        data: { removed: prior.filter((row) => !insertedIds.has(row.demand_id)).length },
        error: null,
      });
    },
  };
}

class Builder {
  private filters: { op: "eq" | "in"; key: string; value: unknown }[] = [];
  private orders: string[] = [];
  private mode: "select" | "delete" | "upsert" = "select";
  private upsertRows: Row[] | null = null;
  constructor(private tables: Record<string, Row[]>, private name: string) {}
  select() {
    this.mode = "select";
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
  order(key: string) {
    this.orders.push(key);
    return this;
  }
  delete() {
    this.mode = "delete";
    return this;
  }
  upsert(rows: Row[]) {
    this.mode = "upsert";
    this.upsertRows = rows;
    return this;
  }
  maybeSingle() {
    const { data, error } = this.exec();
    return Promise.resolve({ data: (data ?? [])[0] ?? null, error });
  }
  then(resolve: (value: { data: Row[] | null; error: null }) => unknown, reject?: (reason: unknown) => unknown) {
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
  private exec(): { data: Row[] | null; error: null } {
    if (this.mode === "upsert") {
      for (const row of this.upsertRows ?? []) {
        const index = this.tables[this.name].findIndex((existing) =>
          existing.job_id === row.job_id && existing.scope_id === row.scope_id &&
          existing.demand_id === row.demand_id
        );
        if (index >= 0) this.tables[this.name][index] = { ...this.tables[this.name][index], ...row };
        else this.tables[this.name].push({ ...row });
      }
      return { data: null, error: null };
    }
    if (this.mode === "delete") {
      const drop = new Set(this.matching().map((row) => row.id));
      this.tables[this.name] = this.tables[this.name].filter((row) => !drop.has(row.id));
      return { data: null, error: null };
    }
    const rows = this.matching().map((row) => ({ ...row }));
    rows.sort((a, b) => {
      for (const key of this.orders) {
        if (a[key] < b[key]) return -1;
        if (a[key] > b[key]) return 1;
      }
      return 0;
    });
    return { data: rows, error: null };
  }
}

function ctx(actor: { userId: string | null; email: string | null; orgId: string | null } = {
  userId: "user-1",
  email: "ada@example.test",
  orgId: ORG,
}) {
  return { orgId: ORG, actor, now: () => "2026-10-18T00:00:00.000Z" };
}

function body(order: unknown, extra: Row = {}): Row {
  return { job_id: JOB, scope_id: SCOPE, order_version: VERSION, order, ...extra };
}

const MIXED = [
  {
    id: "fence-rails",
    engineKey: "synthetic:rail",
    description: "Synthetic fencing rails",
    colour: "Surfmist",
    unit: "m",
    quantity: 8.4,
    cuts: [{ lengthMm: 2800, qty: 3 }],
    profile: "ignored",
    toConfirm: [],
  },
  {
    id: "fixings",
    engineKey: "synthetic:screw",
    description: "Synthetic rail screws",
    unit: "each",
    quantity: 103,
    cuts: [],
    toConfirm: [],
  },
  {
    id: "flashing",
    engineKey: "synthetic:apron",
    description: "Synthetic folded apron",
    colour: "Surfmist",
    unit: "m2",
    quantity: 1.874,
    cuts: [{ lengthMm: 2342, qty: 2 }],
    profile: "apron",
    toConfirm: [],
  },
  {
    id: "missing",
    engineKey: "synthetic:unknown",
    description: "Unconfirmed latch",
    unit: "each",
    quantity: 1,
    cuts: [],
    toConfirm: [],
  },
];

Deno.test("parser: a demand list keeps stated products and does not flag the word unknown", () => {
  const parsed = parseScopeOrder(MIXED);
  assertEquals(parsed.withheld_demand_ids, []);
  assertEquals(parsed.lines.map((line) => ({
    demand_id: line.demand_id,
    product: line.product,
    product_unknown: line.product_unknown,
    quantity: line.quantity,
    unit: line.unit,
    length_mm: line.length_mm,
    stock_length_mm: line.stock_length_mm,
    stock_qty: line.stock_qty,
    cut_size: line.cut_size,
    supplier_name: line.supplier_name,
  })), [
    {
      demand_id: "fence-rails",
      product: "synthetic:rail",
      product_unknown: false,
      quantity: 8.4,
      unit: "m",
      length_mm: 2800,
      stock_length_mm: null,
      stock_qty: null,
      cut_size: "3 x 2800 mm",
      supplier_name: null,
    },
    {
      demand_id: "fixings",
      product: "synthetic:screw",
      product_unknown: false,
      quantity: 103,
      unit: "each",
      length_mm: null,
      stock_length_mm: null,
      stock_qty: null,
      cut_size: null,
      supplier_name: null,
    },
    {
      demand_id: "flashing",
      product: "synthetic:apron",
      product_unknown: false,
      quantity: 1.874,
      unit: "m2",
      length_mm: 2342,
      stock_length_mm: null,
      stock_qty: null,
      cut_size: "2 x 2342 mm",
      supplier_name: null,
    },
    {
      demand_id: "missing",
      product: "synthetic:unknown",
      product_unknown: false,
      quantity: 1,
      unit: "each",
      length_mm: null,
      stock_length_mm: null,
      stock_qty: null,
      cut_size: null,
      supplier_name: null,
    },
  ]);
});

Deno.test("parser: a blank product stays flagged, and candidates are never chosen", () => {
  const parsed = parseScopeOrder({
    schema: "scope-engine-order/v1",
    lines: [{
      demand_id: "mystery",
      product: null,
      product_unknown: false,
      description: "Something",
      quantity: 1,
      unit: "each",
      candidates: ["rhs:100x50x2.0:c450l0"],
    }],
  });
  assertEquals(parsed.lines[0].product, null);
  assertEquals(parsed.lines[0].product_unknown, true);
  assertEquals(parsed.lines[0].price_to_confirm, false);
});

Deno.test("parser: a named product with only the price note stays known", () => {
  const parsed = parseScopeOrder({
    schemaVersion: "supplier-order/v1",
    suppliers: [{
      supplier: "CMI",
      lines: [{
        demandIds: ["gutter"],
        productId: "practice-cmi-patioline",
        description: "Gutter",
        quantity: 1,
        unit: "each",
        toConfirm: [" To Confirm "],
      }, {
        demandIds: ["flash"],
        productId: "apron",
        description: "Apron",
        quantity: 1,
        toConfirm: ["length"],
      }, {
        demandIds: ["blank"],
        description: "Blank",
        quantity: 1,
        toConfirm: ["to confirm"],
      }, {
        demandIds: ["mixed"],
        productId: "rhs:100x50",
        description: "Mixed",
        quantity: 1,
        toConfirm: ["to confirm", "length"],
      }],
    }],
  });
  const gutter = parsed.lines.find((line) => line.demand_id === "gutter");
  assertEquals(gutter?.product_unknown, false);
  assertEquals(gutter?.price_to_confirm, true);
  assertEquals(gutter?.product, "practice-cmi-patioline");
  const flash = parsed.lines.find((line) => line.demand_id === "flash");
  assertEquals(flash?.product_unknown, true);
  assertEquals(flash?.price_to_confirm, false);
  const blank = parsed.lines.find((line) => line.demand_id === "blank");
  assertEquals(blank?.product, null);
  assertEquals(blank?.product_unknown, true);
  assertEquals(blank?.price_to_confirm, true);
  const mixed = parsed.lines.find((line) => line.demand_id === "mixed");
  assertEquals(mixed?.product_unknown, true);
  assertEquals(mixed?.price_to_confirm, false);
});

Deno.test("parser: a string quantity is refused", async () => {
  const error = await assertRejects(
    () => Promise.resolve().then(() => parseScopeOrder([{
      id: "rails",
      engineKey: "synthetic:rail",
      description: "Rails",
      quantity: "8.4",
      unit: "m",
    }])),
    DispatchScopeOrderError,
  );
  assertEquals(error.status, 400);
  assertEquals(error.body.code, "invalid_order");
});

Deno.test("parser: a repeated demand writes nothing because parse throws first", async () => {
  const error = await assertRejects(
    () => Promise.resolve().then(() => parseScopeOrder({
      schema: "scope-engine-order/v1",
      lines: [
        { demand_id: "a", product: "p", description: "One", quantity: 1 },
        { demand_id: "a", product: "p", description: "Two", quantity: 1 },
      ],
    })),
    DispatchScopeOrderError,
  );
  assertEquals(error.body.code, "invalid_order");
});

Deno.test("parser: a mixed unresolved purchase line is withheld, not split", () => {
  const parsed = parseScopeOrder({
    schemaVersion: "supplier-order/v1",
    suppliers: [{
      supplier: "Example Steel",
      lines: [{
        demandIds: ["known-beam", "missing-flash"],
        productId: "rhs:100x50x2.0:c450l0",
        description: "Mixed bar",
        quantity: 1,
        unit: "each",
        sku: "SHOULD-NOT-COPY",
        cost: 12.5,
        candidates: ["other"],
      }, {
        demandIds: ["only-known"],
        productId: "rhs:100x50x2.0:c450l0",
        description: "Known bar",
        quantity: 2,
        unit: "each",
        toConfirm: ["length"],
      }],
    }],
    unresolved: [{
      demand: {
        id: "missing-flash",
        engineKey: "synthetic:apron",
        description: "Apron",
        quantity: 1,
        unit: "each",
      },
    }],
  });
  assertEquals(parsed.lines.map((line) => line.demand_id), ["only-known", "missing-flash"]);
  assertEquals(parsed.lines[0].product_unknown, true);
  assertEquals(parsed.lines[0].price_to_confirm, false);
  assertEquals(parsed.lines[0].product, "rhs:100x50x2.0:c450l0");
  assertEquals(parsed.lines[0].supplier_name, "Example Steel");
  assertEquals(parsed.lines[1].product_unknown, true);
  assertEquals(parsed.lines[1].price_to_confirm, false);
  assertEquals(parsed.withheld_demand_ids, ["known-beam"]);
  assert(!JSON.stringify(parsed).includes("SHOULD-NOT-COPY"));
});

Deno.test("parser: 3 x 2800 rails bought as 2 x 6000 bars keep both lengths", () => {
  const parsed = parseScopeOrder({
    schemaVersion: "supplier-order/v1",
    suppliers: [{
      supplier: "Example Steel",
      lines: [{
        demandIds: ["fence-rails"],
        productId: "rail:rhs",
        description: "Fence rails",
        quantity: 2,
        unit: "each",
        lengthMm: 6000,
        cuts: [{ lengthMm: 2800, qty: 3 }],
        requirements: [{ id: "fence-rails", references: ["fence-bay-1"] }],
      }],
    }],
  });
  const line = parsed.lines[0];
  assertEquals(line.demand_id, "fence-rails");
  assertEquals(line.quantity, 2);
  assertEquals(line.stock_length_mm, 6000);
  assertEquals(line.stock_qty, 2);
  assertEquals(line.length_mm, 2800);
  assertEquals(line.cuts, [{ length_mm: 2800, qty: 3 }]);
  assertEquals(line.element_refs, ["fence-bay-1"]);
});

Deno.test("parser: a 2700 fence post stores the 2550 cut from sheet, plinth and embedment", () => {
  // 1800 sheet + 150 plinth rail + 600 in the ground. The engine's patio
  // post length is a different rule; this fixture is the fence cut.
  assertEquals(1800 + 150 + 600, 2550);
  const parsed = parseScopeOrder({
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
        requirements: [{ id: "post-1", references: ["post-1"] }],
      }],
    }],
  });
  const line = parsed.lines[0];
  assertEquals(line.demand_id, "post-1");
  assertEquals(line.quantity, 1);
  assertEquals(line.stock_length_mm, 2700);
  assertEquals(line.stock_qty, 1);
  assertEquals(line.length_mm, 2550);
  assertEquals(line.cuts, [{ length_mm: 2550, qty: 1 }]);
  assertEquals(line.element_refs, ["post-1"]);
  console.log(formatScopeOrderLine(line));
});

Deno.test("parser: cutList fills an empty purchase line and does not replace cuts already on the bar", () => {
  const parsed = parseScopeOrder({
    schemaVersion: "supplier-order/v1",
    suppliers: [{
      name: "Stratco",
      lines: [{
        demandIds: ["beam"],
        productId: "rhs",
        description: "Beam with no cuts of its own",
        quantity: 2,
        unit: "length",
        lengthMm: 6000,
        cuts: [],
        requirements: [],
      }, {
        demandIds: ["offcut"],
        productId: "rhs",
        description: "Bar that already names its piece",
        quantity: 1,
        unit: "length",
        lengthMm: 8000,
        cuts: [{ lengthMm: 1925, qty: 1 }],
        requirements: [{ references: ["front-beam"] }],
      }],
    }],
    cutList: [{
      id: "beam",
      description: "Beam pieces",
      quantity: 8.4,
      unit: "m",
      cuts: [{ lengthMm: 2800, qty: 3 }],
      references: ["bay-1"],
    }, {
      id: "offcut",
      description: "Fuller demand",
      quantity: 14,
      unit: "m",
      cuts: [{ lengthMm: 6000, qty: 2 }, { lengthMm: 1925, qty: 1 }],
      references: ["front-beam", "rafters"],
    }],
  });
  const beam = parsed.lines.find((line) => line.demand_id === "beam");
  assertEquals(beam?.stock_length_mm, 6000);
  assertEquals(beam?.stock_qty, 2);
  assertEquals(beam?.length_mm, 2800);
  assertEquals(beam?.cuts, [{ length_mm: 2800, qty: 3 }]);
  assertEquals(beam?.element_refs, ["bay-1"]);
  assertEquals(beam?.supplier_name, "Stratco");
  const offcut = parsed.lines.find((line) => line.demand_id === "offcut");
  assertEquals(offcut?.cuts, [{ length_mm: 1925, qty: 1 }]);
  assertEquals(offcut?.element_refs, ["front-beam"]);
});

Deno.test("parser: a cutList entry with no demand id is refused", async () => {
  const error = await assertRejects(
    () => Promise.resolve().then(() => parseScopeOrder({
      schemaVersion: "supplier-order/v1",
      suppliers: [],
      cutList: [{ lengthMm: 6000, qty: 9 }],
    })),
    DispatchScopeOrderError,
  );
  assertEquals(error.body.code, "invalid_order");
});

Deno.test("parser: two stock lengths of material-2 become two stable rows", () => {
  const order = {
    schemaVersion: "supplier-order/v1",
    suppliers: [{
      name: "Stratco",
      lines: [{
        demandIds: ["material-2"],
        productId: "p-stratco-ert2-010050po80-colour",
        description: "8.0 m (Colour)",
        quantity: 4,
        unit: "length",
        lengthMm: 8000,
        cuts: [{ lengthMm: 6000, qty: 2 }, { lengthMm: 3460, qty: 4 }],
        requirements: [{ references: ["rafters", "fascia-beam"] }],
      }, {
        demandIds: ["material-2"],
        productId: "p-stratco-ert2-010050po65-colour",
        description: "6.5 m (Colour)",
        quantity: 1,
        unit: "length",
        lengthMm: 6500,
        cuts: [{ lengthMm: 1925, qty: 1 }],
        requirements: [{ references: ["fascia-beam", "rafters"] }],
      }],
    }],
  };
  const first = parseScopeOrder(order);
  const second = parseScopeOrder(order);
  assertEquals(first.lines.map((line) => line.demand_id), second.lines.map((line) => line.demand_id));
  assertEquals(first.lines.map((line) => line.demand_id), [
    "fascia-beam.rafters|p-stratco-ert2-010050po80-colour|8000",
    "fascia-beam.rafters|p-stratco-ert2-010050po65-colour|6500",
  ]);
  assert(first.lines.every((line) => !/^material-\d+$/.test(line.demand_id)));
  assertEquals(first.lines[0].element_refs, ["fascia-beam", "rafters"]);
  assertEquals(first.lines[0].stock_length_mm, 8000);
  assertEquals(first.lines[1].stock_length_mm, 6500);
});

Deno.test("parser: a scope-engine-v2 job is not an order", async () => {
  const error = await assertRejects(
    () => Promise.resolve().then(() => parseScopeOrder({
      schema: "scope-engine-v2/job@1",
      elements: [],
    })),
    DispatchScopeOrderError,
  );
  assertEquals(error.body.code, "invalid_order");
  assert(String(error.body.error).includes("not an order"));
});

function jobRow(id: string, type: string, org = ORG): Row {
  return { id, org_id: org, job_number: "SWX-1", type, status: "accepted" };
}

function must(row: Row | undefined, label: string): Row {
  assert(row, label);
  return row;
}

Deno.test("import: the same scope updates a changed quantity and does not duplicate the row", async () => {
  const db = memory([jobRow(JOB, "fencing"), jobRow(MAKESAFE, "makesafe"), jobRow(OTHER_JOB, "patio", OTHER)]);
  const first = await runDispatchScopeOrderAction(db, "dispatch_scope_order_import", new URLSearchParams(), body(MIXED), ctx());
  assertEquals(first.sends, false);
  assertEquals((first.lines as Row[]).length, 4);
  assertEquals(first.removed, 0);
  const ids = (first.lines as Row[]).map((line) => line.id);
  const changed = MIXED.map((row) => row.id === "fence-rails" ? { ...row, quantity: 9.5 } : row);
  const second = await runDispatchScopeOrderAction(
    db,
    "dispatch_scope_order_import",
    new URLSearchParams(),
    body(changed, { order_version: "v2" }),
    ctx({ userId: "user-2", email: "bea@example.test", orgId: ORG }),
  );
  assertEquals((second.lines as Row[]).map((line) => line.id), ids);
  assertEquals(db.tables.dispatch_scope_order_lines.length, 4);
  assertEquals(second.removed, 0);
  const rails = must((second.lines as Row[]).find((line) => line.demand_id === "fence-rails"), "rails");
  assertEquals(rails.quantity, 9.5);
  assertEquals(rails.order_version, "v2");
  const stored = must(
    db.tables.dispatch_scope_order_lines.find((row) => row.demand_id === "fence-rails"),
    "stored rails",
  );
  assertEquals(stored.created_by, "user-1");
  assertEquals(stored.updated_by, "user-2");
});

Deno.test("import: a smaller scope removes the demands that left, and an empty order does not", async () => {
  const db = memory([jobRow(JOB, "patio")]);
  await runDispatchScopeOrderAction(db, "dispatch_scope_order_import", new URLSearchParams(), body(MIXED), ctx());
  const smaller = await runDispatchScopeOrderAction(
    db,
    "dispatch_scope_order_import",
    new URLSearchParams(),
    body([MIXED[0]]),
    ctx(),
  );
  assertEquals((smaller.lines as Row[]).map((line) => line.demand_id), ["fence-rails"]);
  assertEquals(smaller.removed, 3);
  const error = await assertRejects(
    () => runDispatchScopeOrderAction(db, "dispatch_scope_order_import", new URLSearchParams(), body({
      schema: "scope-engine-order/v1",
      lines: [],
    }), ctx()),
    DispatchScopeOrderError,
  );
  assertEquals(error.body.code, "no_lines");
  assertEquals(db.tables.dispatch_scope_order_lines.length, 1);
});

Deno.test("import: a second scope does not delete the first, and post-1 is not one row", async () => {
  const db = memory([jobRow(JOB, "patio")]);
  const post = (description: string) => ({
    schemaVersion: "supplier-order/v1",
    suppliers: [{
      supplier: "Example Steel",
      lines: [{
        demandIds: ["post-1"],
        productId: description === "Fence post" ? "post:fence" : "post:patio",
        description,
        quantity: 1,
        unit: "each",
        lengthMm: description === "Fence post" ? 2700 : 3100,
        cuts: [{ lengthMm: description === "Fence post" ? 2550 : 2846, qty: 1 }],
        requirements: [{ references: ["post-1"] }],
      }],
    }],
  });
  const patio = await runDispatchScopeOrderAction(
    db,
    "dispatch_scope_order_import",
    new URLSearchParams(),
    body(post("Patio post"), { scope_id: "patio-scope" }),
    ctx(),
  );
  const fence = await runDispatchScopeOrderAction(
    db,
    "dispatch_scope_order_import",
    new URLSearchParams(),
    body(post("Fence post"), { scope_id: "fence-scope" }),
    ctx(),
  );
  assertEquals((fence.lines as Row[]).length, 2);
  const patioRow = (fence.lines as Row[]).find((line) => line.scope_id === "patio-scope");
  const fenceRow = (fence.lines as Row[]).find((line) => line.scope_id === "fence-scope");
  assertEquals(patioRow?.demand_id, "post-1");
  assertEquals(fenceRow?.demand_id, "post-1");
  assert(patioRow?.id !== fenceRow?.id);
  assertEquals(patioRow?.id, (patio.lines as Row[])[0].id);
  assertEquals(fenceRow?.stock_length_mm, 2700);
  assertEquals(fenceRow?.length_mm, 2550);
  assertEquals(db.tables.dispatch_scope_order_lines.length, 2);
});

Deno.test("import: a make-safe job is accepted and another org is not found", async () => {
  const db = memory([jobRow(MAKESAFE, "makesafe"), jobRow(OTHER_JOB, "patio", OTHER)]);
  const saved = await runDispatchScopeOrderAction(db, "dispatch_scope_order_import", new URLSearchParams(), {
    job_id: MAKESAFE,
    scope_id: SCOPE,
    order_version: VERSION,
    order: MIXED.slice(0, 1),
  }, ctx());
  assertEquals(saved.sends, false);
  assertEquals((saved.lines as Row[]).length, 1);
  const missing = await assertRejects(
    () => runDispatchScopeOrderAction(db, "dispatch_scope_order_lines", new URLSearchParams(`job_id=${OTHER_JOB}`), {}, ctx()),
    DispatchScopeOrderError,
  );
  assertEquals(missing.status, 404);
  assertEquals(missing.body.code, "job_not_found");
});

Deno.test("import: a bad id is refused before any table is opened", async () => {
  const db = memory([]);
  const error = await assertRejects(
    () => runDispatchScopeOrderAction(db, "dispatch_scope_order_lines", new URLSearchParams("job_id=nope"), null, ctx()),
    DispatchScopeOrderError,
  );
  assertEquals(error.status, 400);
  assertEquals(error.body.code, "invalid_request");
});

Deno.test("import: a missing scope and an oversized order are refused before any table is opened", async () => {
  const db = {
    from() {
      throw new Error("table opened");
    },
    rpc() {
      throw new Error("rpc opened");
    },
  };
  const missing = await assertRejects(
    () => runDispatchScopeOrderAction(db, "dispatch_scope_order_import", new URLSearchParams(), {
      job_id: JOB,
      order: MIXED,
    }, ctx()),
    DispatchScopeOrderError,
  );
  assertEquals(missing.body.code, "invalid_request");
  const huge = await assertRejects(
    () => runDispatchScopeOrderAction(db, "dispatch_scope_order_import", new URLSearchParams(), {
      job_id: JOB,
      scope_id: SCOPE,
      order_version: VERSION,
      order: { schema: "nope", pad: "x".repeat(2_000_000) },
    }, ctx()),
    DispatchScopeOrderError,
  );
  assertEquals(huge.status, 400);
  assertEquals(huge.body.code, "order_too_large");
});

Deno.test("store: the module does not send and does not call fetch", async () => {
  const source = await Deno.readTextFile(new URL("./dispatch_scope_order_store.ts", import.meta.url));
  assert(!source.includes("dispatch_order_send"));
  assert(!source.includes("fetch("));
});

const EXAMPLE_DIR = new URL("./scope_engine_examples/", import.meta.url);
const ORDER_DIR = new URL("./scope_engine_orders/", import.meta.url);
const POSITIONAL = /^material-\d+(\|material-\d+)*$/;

Deno.test("examples: a job document is refused and a demand list keeps its references", async () => {
  const names = [];
  for await (const entry of Deno.readDir(EXAMPLE_DIR)) {
    if (entry.name.endsWith(".json")) names.push(entry.name);
  }
  names.sort();
  assertEquals(names.length, 15);
  let jobs = 0;
  for (const name of names) {
    const order = JSON.parse(await Deno.readTextFile(new URL(name, EXAMPLE_DIR)));
    if (order && order.schema === "scope-engine-v2/job@1") {
      jobs += 1;
      const error = await assertRejects(
        () => Promise.resolve().then(() => parseScopeOrder(order)),
        DispatchScopeOrderError,
      );
      assertEquals(error.body.code, "invalid_order", name);
      continue;
    }
    const parsed = parseScopeOrder(order);
    assert(parsed.lines.length > 0, name);
    assertEquals(parsed.lines.find((line) => line.demand_id === "fence-rails")?.element_refs, [
      "fence-bay-1",
      "fence-bay-2",
    ]);
    assertEquals(parsed.lines.find((line) => line.demand_id === "fence-rails")?.stock_length_mm, null);
  }
  assertEquals(jobs, 14);
});

type ExpectLine = {
  refs: string[];
  product: string;
  quantity: number;
  stock_length_mm: number | null;
  stock_qty: number | null;
  length_mm: number | null;
  cuts: { length_mm: number; qty: number }[];
};

function expectLine(lines: ScopeOrderLine[], spec: ExpectLine): ScopeOrderLine {
  const refs = [...spec.refs].sort().join(",");
  const found = lines.filter((line) =>
    line.element_refs.join(",") === refs &&
    line.product === spec.product &&
    line.stock_length_mm === spec.stock_length_mm
  );
  assertEquals(found.length, 1, `${refs} ${spec.product} ${spec.stock_length_mm}`);
  const line = found[0];
  assertEquals(line.quantity, spec.quantity);
  assertEquals(line.stock_qty, spec.stock_qty);
  assertEquals(line.length_mm, spec.length_mm);
  assertEquals(line.cuts, spec.cuts);
  assertEquals(line.product_unknown, false);
  assertEquals(line.price_to_confirm, true);
  assert(!POSITIONAL.test(line.demand_id), line.demand_id);
  return line;
}

const ENGINE_ORDERS: Record<string, { count: number; lines: ExpectLine[] }> = {
  "attached-fascia": {
    count: 27,
    lines: [
      {
        refs: ["post-1", "post-2", "post-3"],
        product: "p-stratco-est2-09090po31-colour",
        quantity: 3,
        stock_length_mm: 3100,
        stock_qty: 3,
        length_mm: 2846,
        cuts: [{ length_mm: 2846, qty: 3 }],
      },
      {
        refs: ["sheets"],
        product: "metroll-spanplus-330-042",
        quantity: 19,
        stock_length_mm: 3555,
        stock_qty: 19,
        length_mm: 3555,
        cuts: [{ length_mm: 3555, qty: 19 }],
      },
      {
        refs: ["gutter"],
        product: "practice-cmi-patioline",
        quantity: 1,
        stock_length_mm: 7000,
        stock_qty: 1,
        length_mm: 6000,
        cuts: [{ length_mm: 6000, qty: 1 }],
      },
      {
        refs: ["end-beam-east", "end-beam-west", "fascia-beam", "front-beam", "house-purlins", "rafters"],
        product: "p-stratco-ert2-010050po80-colour",
        quantity: 4,
        stock_length_mm: 8000,
        stock_qty: 4,
        length_mm: null,
        cuts: [
          { length_mm: 1925, qty: 1 },
          { length_mm: 1950, qty: 1 },
          { length_mm: 3460, qty: 4 },
          { length_mm: 6000, qty: 2 },
        ],
      },
      {
        refs: ["end-beam-east", "end-beam-west", "fascia-beam", "front-beam", "house-purlins", "rafters"],
        product: "p-stratco-ert2-010050po65-colour",
        quantity: 1,
        stock_length_mm: 6500,
        stock_qty: 1,
        length_mm: 1925,
        cuts: [{ length_mm: 1925, qty: 1 }],
      },
    ],
  },
  "attached-wall": {
    count: 24,
    lines: [
      {
        refs: ["post-1", "post-2", "post-3"],
        product: "p-stratco-est2-09090po31-colour",
        quantity: 3,
        stock_length_mm: 3100,
        stock_qty: 3,
        length_mm: 2733,
        cuts: [{ length_mm: 2733, qty: 3 }],
      },
      {
        refs: ["sheets"],
        product: "metroll-spanplus-330-042",
        quantity: 19,
        stock_length_mm: 3552,
        stock_qty: 19,
        length_mm: 3552,
        cuts: [{ length_mm: 3552, qty: 19 }],
      },
      {
        refs: ["gutter"],
        product: "practice-cmi-patioline",
        quantity: 1,
        stock_length_mm: 7000,
        stock_qty: 1,
        length_mm: 6000,
        cuts: [{ length_mm: 6000, qty: 1 }],
      },
      {
        refs: ["end-beam-east", "end-beam-west", "front-beam", "rafters", "wall-beam"],
        product: "p-stratco-ert2-010050po80-colour",
        quantity: 2,
        stock_length_mm: 8000,
        stock_qty: 2,
        length_mm: 3406,
        cuts: [{ length_mm: 3406, qty: 4 }],
      },
    ],
  },
  carport: {
    count: 22,
    lines: [
      {
        refs: ["post-be", "post-bm", "post-bw", "post-fe", "post-fm", "post-fw"],
        product: "p-stratco-est2-09090po40-colour",
        quantity: 6,
        stock_length_mm: 4000,
        stock_qty: 6,
        length_mm: null,
        cuts: [{ length_mm: 3243, qty: 3 }, { length_mm: 3550, qty: 3 }],
      },
      {
        refs: ["sheets"],
        product: "metroll-spanplus-330-042",
        quantity: 19,
        stock_length_mm: 6058,
        stock_qty: 19,
        length_mm: 6058,
        cuts: [{ length_mm: 6058, qty: 19 }],
      },
      {
        refs: ["gutter"],
        product: "practice-cmi-patioline",
        quantity: 1,
        stock_length_mm: 7000,
        stock_qty: 1,
        length_mm: 6000,
        cuts: [{ length_mm: 6000, qty: 1 }],
      },
      {
        refs: ["back-beam", "end-beam-east", "end-beam-west", "front-beam", "purlins", "rafters"],
        product: "p-stratco-ert2-010050po80-colour",
        quantity: 3,
        stock_length_mm: 8000,
        stock_qty: 3,
        length_mm: null,
        cuts: [
          { length_mm: 1925, qty: 2 },
          { length_mm: 1950, qty: 1 },
          { length_mm: 5913, qty: 1 },
          { length_mm: 6000, qty: 2 },
        ],
      },
    ],
  },
  courtyard: {
    count: 31,
    lines: [
      {
        refs: ["post-1", "post-2", "post-3"],
        product: "p-stratco-est2-09090po40-colour",
        quantity: 3,
        stock_length_mm: 4000,
        stock_qty: 3,
        length_mm: 3365,
        cuts: [{ length_mm: 3365, qty: 3 }],
      },
      {
        refs: ["sheets"],
        product: "metroll-spanplus-330-042",
        quantity: 15,
        stock_length_mm: 6054,
        stock_qty: 15,
        length_mm: 6054,
        cuts: [{ length_mm: 6054, qty: 15 }],
      },
      {
        refs: ["gutter"],
        product: "practice-cmi-patioline",
        quantity: 1,
        stock_length_mm: 7000,
        stock_qty: 1,
        length_mm: 4870,
        cuts: [{ length_mm: 4870, qty: 1 }],
      },
      {
        refs: ["fascia-beam", "purlins"],
        product: "p-stratco-ert2-010050po65-colour",
        quantity: 2,
        stock_length_mm: 6500,
        stock_qty: 2,
        length_mm: null,
        cuts: [
          { length_mm: 1548, qty: 2 },
          { length_mm: 1573, qty: 1 },
          { length_mm: 4870, qty: 1 },
        ],
      },
      {
        refs: ["carry-beam", "end-beam-east", "end-beam-west", "front-beam", "rafters"],
        product: "p-stratco-ert2-015050po65-colour",
        quantity: 6,
        stock_length_mm: 6500,
        stock_qty: 6,
        length_mm: null,
        cuts: [{ length_mm: 4870, qty: 2 }, { length_mm: 5909, qty: 4 }],
      },
    ],
  },
};

function bannedKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) bannedKeys(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (["cost", "sku", "knownSubtotalExGst", "candidates", "priceObservations", "bars"].includes(key)) {
        found.push(key);
      }
      bannedKeys(child, found);
    }
  }
  return found;
}

Deno.test("orders: the four createOrder fixtures import qty, stock length and cuts", async () => {
  const printed: string[] = [];
  const db = memory([jobRow(JOB, "patio")]);
  let fasciaPostId = "";
  for (const [name, spec] of Object.entries(ENGINE_ORDERS)) {
    const text = await Deno.readTextFile(new URL(`${name}.json`, ORDER_DIR));
    const order = JSON.parse(text);
    assertEquals(bannedKeys(order), [], name);
    assertEquals(order.revisions.catalogue, "patio-bought-items-2026-10-17");
    const parsed = parseScopeOrder(order);
    assertEquals(parsed.lines.length, spec.count, name);
    assert(parsed.lines.every((line) => !POSITIONAL.test(line.demand_id)), name);
    printed.push(`# ${name}`);
    for (const expected of spec.lines) {
      const line = expectLine(parsed.lines, expected);
      printed.push(formatScopeOrderLine(line));
    }
    if (name === "attached-fascia") {
      const rhs = parsed.lines.find((line) =>
        line.stock_length_mm === 8000 && line.element_refs.includes("rafters")
      );
      assertEquals(
        rhs?.demand_id,
        "end-beam-east.end-beam-west.fascia-beam.front-beam.house-purlins.rafters|p-stratco-ert2-010050po80-colour|8000",
      );
      const saved = await runDispatchScopeOrderAction(
        db,
        "dispatch_scope_order_import",
        new URLSearchParams(),
        {
          job_id: JOB,
          scope_id: "example-attached-fascia",
          order_version: order.revisions.catalogue,
          order,
        },
        ctx(),
      );
      assertEquals(saved.sends, false);
      assertEquals((saved.lines as Row[]).length, 27);
      const post = must((saved.lines as Row[]).find((line) =>
        line.product === "p-stratco-est2-09090po31-colour" && line.stock_length_mm === 3100
      ), "fascia post");
      fasciaPostId = post.id;
      assertEquals(post.quantity, 3);
      assertEquals(post.cuts, [{ length_mm: 2846, qty: 3 }]);
      assertEquals(post.scope_id, "example-attached-fascia");
      assertEquals(post.order_version, "patio-bought-items-2026-10-17");
      const bumped = structuredClone(order);
      const postLine = bumped.suppliers.flatMap((group: Row) => group.lines).find((line: Row) =>
        line.productId === "p-stratco-est2-09090po31-colour"
      );
      postLine.quantity = 4;
      const again = await runDispatchScopeOrderAction(
        db,
        "dispatch_scope_order_import",
        new URLSearchParams(),
        {
          job_id: JOB,
          scope_id: "example-attached-fascia",
          order_version: "patio-bought-items-2026-10-17",
          order: bumped,
        },
        ctx({ userId: "user-2", email: "bea@example.test", orgId: ORG }),
      );
      const postAgain = must((again.lines as Row[]).find((line) => line.id === fasciaPostId), "reimported post");
      assertEquals(postAgain.quantity, 4);
      assertEquals(again.removed, 0);
      const stored = must(
        db.tables.dispatch_scope_order_lines.find((row) => row.id === fasciaPostId),
        "stored post",
      );
      assertEquals(stored.created_by, "user-1");
    }
  }
  const fence = await runDispatchScopeOrderAction(db, "dispatch_scope_order_import", new URLSearchParams(), {
    job_id: JOB,
    scope_id: "fence-example",
    order_version: "fence-rule-v1",
    order: {
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
    },
  }, ctx());
  assertEquals((fence.lines as Row[]).filter((line) => line.scope_id === "example-attached-fascia").length, 27);
  const fencePost = must((fence.lines as Row[]).find((line) => line.scope_id === "fence-example"), "fence post");
  assertEquals(fencePost.demand_id, "post-1");
  assertEquals(fencePost.quantity, 1);
  assertEquals(fencePost.stock_length_mm, 2700);
  assertEquals(fencePost.stock_qty, 1);
  assertEquals(fencePost.cuts, [{ length_mm: 2550, qty: 1 }]);
  assert(fencePost.id !== fasciaPostId);
  printed.push("# fence");
  printed.push(formatScopeOrderLine({
    demand_id: fencePost.demand_id,
    product: fencePost.product,
    product_unknown: fencePost.product_unknown,
    description: fencePost.description,
    quantity: fencePost.quantity,
    unit: fencePost.unit,
    length_mm: fencePost.length_mm,
    stock_length_mm: fencePost.stock_length_mm,
    stock_qty: fencePost.stock_qty,
    cut_size: fencePost.cut_size,
    cuts: fencePost.cuts,
    element_refs: fencePost.element_refs,
    supplier_name: fencePost.supplier_name,
    price_to_confirm: fencePost.price_to_confirm === true,
  }));
  assertEquals(fencePost.product_unknown, false);
  assertEquals(fencePost.price_to_confirm, false);
  const courtyard = parseScopeOrder(JSON.parse(
    await Deno.readTextFile(new URL("courtyard.json", ORDER_DIR)),
  ));
  const hashed = courtyard.lines.find((line) =>
    line.product === "p-buildex-1-310-9070-1tpcs-12-14x20-hex-teks-sl-c3-" &&
    line.element_refs.includes("riser-1")
  );
  assert(/^[h][0-9a-f]{16}$/.test(hashed?.demand_id ?? ""), hashed?.demand_id);
  console.log(printed.join("\n"));
});

Deno.test("gate: the two actions are staff only", () => {
  assertEquals(DISPATCH_SCOPE_ORDER_ACTIONS.length, 2);
  for (const action of DISPATCH_SCOPE_ORDER_ACTIONS) {
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

Deno.test("gate: the routine key is refused before any call, and a write by GET is 405", async () => {
  await withEnvAndFetchSpy(async (calls) => {
    for (const action of DISPATCH_SCOPE_ORDER_ACTIONS) {
      const res = await _opsApiRequestHandlerForTest(new Request(
        `https://example.invalid/ops-api?action=${action}&job_id=${JOB}`,
        {
          method: action === "dispatch_scope_order_lines" ? "GET" : "POST",
          headers: { "content-type": "application/json", "x-api-key": ROUTINE_KEY },
          body: action === "dispatch_scope_order_lines" ? undefined : JSON.stringify({ job_id: JOB }),
        },
      ));
      assertEquals(res.status, 403, action);
      await res.body?.cancel();
    }
    const headers = { "content-type": "application/json", authorization: `Bearer ${SERVICE_KEY}` };
    const get = await _opsApiRequestHandlerForTest(new Request(
      "https://example.invalid/ops-api?action=dispatch_scope_order_import",
      { headers },
    ));
    assertEquals(get.status, 405);
    await get.body?.cancel();
    const bad = await _opsApiRequestHandlerForTest(new Request(
      "https://example.invalid/ops-api?action=dispatch_scope_order_lines&job_id=nope",
      { headers },
    ));
    assertEquals(bad.status, 400);
    assertEquals((await bad.json()).code, "invalid_request");
    assertEquals(calls, []);
  });
});
