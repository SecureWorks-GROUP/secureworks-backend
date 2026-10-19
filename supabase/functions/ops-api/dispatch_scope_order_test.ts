// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch scope order lines, stage 1 (docs/dispatch-scope-order-lines-v1.md).
// The parser, the import against an in-memory stand-in, the scope-engine-v2
// example jobs, and who may call. Nothing here sends.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DispatchScopeOrderError,
  formatScopeOrderLine,
  parseScopeOrder,
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
          existing.job_id === row.job_id && existing.demand_id === row.demand_id
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
    cutList: [{ lengthMm: 6000, qty: 9 }],
  });
  assertEquals(parsed.lines.map((line) => line.demand_id), ["only-known", "missing-flash"]);
  assertEquals(parsed.lines[0].product_unknown, true);
  assertEquals(parsed.lines[0].product, "rhs:100x50x2.0:c450l0");
  assertEquals(parsed.lines[0].supplier_name, "Example Steel");
  assertEquals(parsed.lines[1].product_unknown, true);
  assertEquals(parsed.withheld_demand_ids, ["known-beam"]);
  assert(!JSON.stringify(parsed).includes("SHOULD-NOT-COPY"));
});

function jobRow(id: string, type: string, org = ORG): Row {
  return { id, org_id: org, job_number: "SWX-1", type, status: "accepted" };
}

Deno.test("import: the same scope updates the rows and does not duplicate them", async () => {
  const db = memory([jobRow(JOB, "fencing"), jobRow(MAKESAFE, "makesafe"), jobRow(OTHER_JOB, "patio", OTHER)]);
  const first = await runDispatchScopeOrderAction(db, "dispatch_scope_order_import", new URLSearchParams(), {
    job_id: JOB,
    order: MIXED,
  }, ctx());
  assertEquals(first.sends, false);
  assertEquals((first.lines as Row[]).length, 4);
  assertEquals(first.removed, 0);
  const ids = (first.lines as Row[]).map((line) => line.id);
  const second = await runDispatchScopeOrderAction(db, "dispatch_scope_order_import", new URLSearchParams(), {
    job_id: JOB,
    order: MIXED,
  }, ctx({ userId: "user-2", email: "bea@example.test", orgId: ORG }));
  assertEquals((second.lines as Row[]).map((line) => line.id), ids);
  assertEquals(db.tables.dispatch_scope_order_lines.length, 4);
  assertEquals(second.removed, 0);
  const stored = db.tables.dispatch_scope_order_lines[0];
  assertEquals(stored.created_by, "user-1");
  assertEquals(stored.updated_by, "user-2");
});

Deno.test("import: a smaller scope removes the demands that left, and an empty order does not", async () => {
  const db = memory([jobRow(JOB, "patio")]);
  await runDispatchScopeOrderAction(db, "dispatch_scope_order_import", new URLSearchParams(), {
    job_id: JOB,
    order: MIXED,
  }, ctx());
  const smaller = await runDispatchScopeOrderAction(db, "dispatch_scope_order_import", new URLSearchParams(), {
    job_id: JOB,
    order: [MIXED[0]],
  }, ctx());
  assertEquals((smaller.lines as Row[]).map((line) => line.demand_id), ["fence-rails"]);
  assertEquals(smaller.removed, 3);
  const error = await assertRejects(
    () => runDispatchScopeOrderAction(db, "dispatch_scope_order_import", new URLSearchParams(), {
      job_id: JOB,
      order: { schema: "scope-engine-order/v1", lines: [] },
    }, ctx()),
    DispatchScopeOrderError,
  );
  assertEquals(error.body.code, "no_lines");
  assertEquals(db.tables.dispatch_scope_order_lines.length, 1);
});

Deno.test("import: a make-safe job is accepted and another org is not found", async () => {
  const db = memory([jobRow(MAKESAFE, "makesafe"), jobRow(OTHER_JOB, "patio", OTHER)]);
  const saved = await runDispatchScopeOrderAction(db, "dispatch_scope_order_import", new URLSearchParams(), {
    job_id: MAKESAFE,
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

Deno.test("store: the module does not send and does not call fetch", async () => {
  const source = await Deno.readTextFile(new URL("./dispatch_scope_order_store.ts", import.meta.url));
  assert(!source.includes("dispatch_order_send"));
  assert(!source.includes("fetch("));
});

const EXAMPLE_DIR = new URL("./scope_engine_examples/", import.meta.url);

Deno.test("examples: each scope-engine-v2 example job becomes stated order lines", async () => {
  const names = [];
  for await (const entry of Deno.readDir(EXAMPLE_DIR)) {
    if (entry.name.endsWith(".json")) names.push(entry.name);
  }
  names.sort();
  assertEquals(names.length, 15);
  const printed: string[] = [];
  for (const name of names) {
    const order = JSON.parse(await Deno.readTextFile(new URL(name, EXAMPLE_DIR)));
    const parsed = parseScopeOrder(order);
    assert(parsed.lines.length > 0, name);
    const text = parsed.lines.map(formatScopeOrderLine);
    printed.push(`# ${name}`);
    printed.push(...text);
    for (const line of parsed.lines) {
      assertEquals(line.supplier_name, null, `${name} ${line.demand_id}`);
      if (line.product === null) assertEquals(line.product_unknown, true);
    }
    if (order.schema === "scope-engine-v2/job@1") {
      assert(!parsed.lines.some((line) => line.demand_id === "roof" || line.description.startsWith("roof-area")));
      for (const line of parsed.lines.filter((line) => line.description.startsWith("flashing "))) {
        assertEquals(line.product, null, line.demand_id);
        assertEquals(line.product_unknown, true);
      }
    }
  }
  console.log(printed.join("\n"));

  const stock = parseScopeOrder(JSON.parse(
    await Deno.readTextFile(new URL("order-stock-frame.json", EXAMPLE_DIR)),
  ));
  assertEquals(stock.lines.map((line) => [line.demand_id, line.length_mm, line.product, line.product_unknown]), [
    ["beam-a", 2800, "rhs:100x50x2.0:c450l0", false],
    ["beam-b", 2800, "rhs:100x50x2.0:c450l0", false],
    ["beam-c", 1800, "rhs:100x50x2.0:c450l0", false],
  ]);

  const fascia = parseScopeOrder(JSON.parse(
    await Deno.readTextFile(new URL("attached-fascia.json", EXAMPLE_DIR)),
  ));
  assertEquals(fascia.lines.length, 16);
  assertEquals(fascia.lines.find((line) => line.demand_id === "fascia-beam")?.length_mm, 6000);
  assertEquals(fascia.lines.find((line) => line.demand_id === "post-1")?.length_mm, null);

  const mid = parseScopeOrder(JSON.parse(
    await Deno.readTextFile(new URL("truss-mid-chord.json", EXAMPLE_DIR)),
  ));
  assertEquals(mid.lines.length, 3);
  assertEquals(mid.lines.find((line) => line.demand_id === "outer-beam")?.product, "rhs:76x38x1.6:grade-unpublished");
  assertEquals(mid.lines.find((line) => line.demand_id === "outer-beam")?.product_unknown, false);
  assertEquals(mid.lines.find((line) => line.demand_id === "trusses")?.quantity, 2);

  const hip = parseScopeOrder(JSON.parse(await Deno.readTextFile(new URL("hip.json", EXAMPLE_DIR))));
  assertEquals(hip.lines.find((line) => line.demand_id === "trusses")?.quantity, 0);
  assertEquals(hip.lines.find((line) => line.demand_id === "hip-nw")?.length_mm, 2758);
  assert(!hip.lines.some((line) => line.demand_id.startsWith("gutter-west:downpipe")));
  assert(hip.lines.some((line) => line.demand_id === "gutter-north:downpipe:1"));

  const reverse = parseScopeOrder(JSON.parse(
    await Deno.readTextFile(new URL("reverse-skillion.json", EXAMPLE_DIR)),
  ));
  const box = reverse.lines.find((line) => line.demand_id === "box-gutter");
  assertEquals(box?.product, "custom:box-gutter");
  assertEquals(box?.product_unknown, false);
  assert(!reverse.lines.some((line) => line.product === "flashing-material:colorbond:0.55"));

  const parallel = parseScopeOrder(JSON.parse(
    await Deno.readTextFile(new URL("gable-ridge-parallel.json", EXAMPLE_DIR)),
  ));
  assertEquals(parallel.lines.find((line) => line.demand_id === "trusses")?.quantity, 2);
  assertEquals(parallel.lines.find((line) => line.demand_id === "infill-west")?.quantity, null);
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
