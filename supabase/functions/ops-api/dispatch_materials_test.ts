// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch slice 4, Materials by supplier (docs/dispatch-slice-4-contract.md):
// the rules in dispatch_materials.ts, the read and six writes in
// dispatch_materials_store.ts against an in-memory stand-in for PostgREST that
// keeps the migration's keys and checks, the two Dispatch list fields on
// `pipeline&dispatch=1`, and who may call. Supplier and job names here are
// made up.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cleanDispatchQuantity,
  cleanDispatchSketch,
  cleanSuggestedDescription,
  DISPATCH_MATERIALS_LIST_SELECT,
  dispatchCanSuggest,
  dispatchMaterialCounts,
  dispatchMaterialCountsByJob,
  dispatchMaterialDisplayStatus,
  flattenDispatchOrderLine,
} from "./dispatch_materials.ts";
import {
  DISPATCH_MATERIALS_ACTIONS,
  DispatchMaterialsContext,
  DispatchMaterialsError,
  runDispatchMaterialsAction,
} from "./dispatch_materials_store.ts";

// index.ts reads SUPABASE_URL and the service key into module constants, so
// they are set before it is imported (a closed local port: any real database
// call fails loudly) and restored straight after.
const SERVICE_KEY = "test-service-role-key";
const ROUTINE_KEY = "test-routine-key";
const IMPORT_ENV: Record<string, string> = {
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
};
const index = await (async () => {
  const saved = new Map(
    Object.keys(IMPORT_ENV).map((n) => [n, Deno.env.get(n)]),
  );
  for (const [name, value] of Object.entries(IMPORT_ENV)) {
    Deno.env.set(name, value);
  }
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
  _extractMaterialsFromScopeForTest,
  _opsApiRequestHandlerForTest,
  _pipelineForTest,
  AGENT_READ_ALLOWED_ACTIONS,
  LEAD_INSTALLER_READ_ACTIONS,
} = index;

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000ee";
const ROW_CEILING = 1000;

type Row = Record<string, any>;

function uuid(prefix: string, index: number): string {
  return `${prefix}000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
const JOB = {
  patio: uuid("a1", 1),
  fence: uuid("a1", 2),
  makesafe: uuid("a1", 3),
  repairMakesafe: uuid("a1", 4),
  otherOrg: uuid("a1", 5),
  patioNoScope: uuid("a1", 6),
  patioPricingOnly: uuid("a1", 7),
  repair: uuid("a1", 8),
};
const SUP = {
  steel: uuid("b1", 1),
  sheets: uuid("b1", 2),
  inactive: uuid("b1", 3),
  noEmail: uuid("b1", 4),
  otherOrg: uuid("b1", 5),
};
const line = (index: number) => uuid("c1", index);

// A scope shaped like the note's SWP-26701 (section 9.2).
const PATIO_SCOPE = {
  config: {
    length: "7700",
    projection: "4200",
    roofing: "solarspan75",
    postQtyOverride: 3,
    postSize: "90x90",
    beamSize: "100x50",
    roofStyle: "skillion",
  },
};

function job(id: string, overrides: Row = {}): Row {
  return {
    id,
    org_id: ORG_ID,
    job_number: `SWX-${id.slice(-3)}`,
    type: "patio",
    status: "order_materials",
    metadata: null,
    scope_json: null,
    pricing_json: null,
    ...overrides,
  };
}

function seed(): Record<string, Row[]> {
  return {
    jobs: [
      job(JOB.patio, { scope_json: PATIO_SCOPE }),
      job(JOB.fence, { type: "fencing", scope_json: PATIO_SCOPE }),
      job(JOB.makesafe, { type: "makesafe" }),
      job(JOB.repairMakesafe, {
        type: "makesafe",
        metadata: { ses_family: "repair" },
      }),
      job(JOB.otherOrg, { org_id: OTHER_ORG }),
      job(JOB.patioNoScope, { scope_json: { config: {} } }),
      job(JOB.patioPricingOnly, {
        scope_json: { config: {} },
        pricing_json: {
          items: [{
            description: "Colorbond steel panel",
            quantity: 4,
            unit_price: 250,
          }],
        },
      }),
      job(JOB.repair, { type: "repair" }),
    ],
    suppliers: [
      {
        id: SUP.steel,
        org_id: ORG_ID,
        name: "Example Steel",
        email: "orders@example.test",
        is_active: true,
      },
      {
        id: SUP.sheets,
        org_id: ORG_ID,
        name: "Example Sheets",
        email: " sheets@example.test ",
        is_active: true,
      },
      {
        id: SUP.inactive,
        org_id: ORG_ID,
        name: "Old Supplier",
        email: "old@example.test",
        is_active: false,
      },
      {
        id: SUP.noEmail,
        org_id: ORG_ID,
        name: "No Email Supplies",
        email: null,
        is_active: true,
      },
      {
        id: SUP.otherOrg,
        org_id: OTHER_ORG,
        name: "Elsewhere",
        email: null,
        is_active: true,
      },
    ],
    purchase_orders: [],
    job_material_suppliers: [],
    job_material_lines: [],
    job_dispatch_workings: [],
  };
}

// ── An in-memory PostgREST stand-in ─────────────────────────────────────────
// It applies the filters these reads use and keeps the migration's keys and
// checks, so a write the database would refuse is refused here with the same
// SQLSTATE. Every request is recorded.

type Recorded = {
  table: string;
  kind: "select" | "insert" | "update" | "delete";
  select: string;
  filters: Array<[string, string, unknown]>;
};

const STORED_STATUSES = ["not_reviewed", "to_order", "in_stock"];

function projectValue(row: Row, expression: string): unknown {
  const textPath = /^(\w+)->>(\w+)$/.exec(expression);
  if (textPath) {
    const value = row[textPath[1]]?.[textPath[2]];
    return value === undefined || value === null ? null : String(value);
  }
  const jsonPath = expression.split("->");
  if (jsonPath.length > 1) {
    let value: any = row[jsonPath[0]];
    for (const key of jsonPath.slice(1)) value = value?.[key];
    return value ?? null;
  }
  return row[expression];
}

function project(row: Row, select: string): Row {
  if (!select || select === "*") return { ...row };
  const out: Row = {};
  for (const raw of select.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const colon = item.indexOf(":");
    const alias = colon >= 0 ? item.slice(0, colon) : item;
    const expression = colon >= 0 ? item.slice(colon + 1) : item;
    out[alias] = alias in row && colon >= 0
      ? row[alias]
      : projectValue(row, expression);
  }
  return out;
}

function makeDb(initial: Record<string, Row[]> = seed()) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(initial)) {
    tables[name] = rows.map((row) => structuredClone(row));
  }
  const requests: Recorded[] = [];
  // "kind:table" -> fail that request with a PostgREST-shaped error.
  const failures = new Set<string>();
  let clock = Date.UTC(2026, 9, 14, 3, 0, 0);
  const tick = () => new Date(clock += 1000).toISOString();

  function violation(code: string, message: string) {
    return { data: null, error: { code, message } };
  }

  function from(table: string) {
    const request: Recorded = {
      table,
      kind: "select",
      select: "",
      filters: [],
    };
    requests.push(request);
    const orders: Array<[string, boolean]> = [];
    let rowLimit: number | null = null;
    let range: [number, number] | null = null;
    let singleMode: "single" | "maybe" | null = null;
    let returning: string | null = null;
    let countHead = false;
    let payload: any = null;

    const matches = (row: Row) =>
      request.filters.every(([op, column, value]) => {
        const actual = projectValue(row, column);
        if (op === "eq") {
          return actual !== null && actual !== undefined &&
            String(actual) === String(value);
        }
        if (op === "neq") {
          return actual !== null && actual !== undefined &&
            String(actual) !== String(value);
        }
        if (op === "in") {
          return (value as unknown[]).map(String).includes(String(actual));
        }
        if (op === "is") return (actual ?? null) === value;
        return true;
      });

    const sortRows = (rows: Row[]) =>
      rows.sort((a, b) => {
        for (const [column, ascending] of orders) {
          if (a[column] === b[column]) continue;
          const before = a[column] < b[column] ? -1 : 1;
          return ascending ? before : -before;
        }
        return 0;
      });

    const execute = (): any => {
      if (failures.has(`${request.kind}:${table}`)) {
        return violation("XX000", `forced failure on ${request.kind} ${table}`);
      }
      const rows = tables[table] ||= [];
      if (request.kind === "select") {
        if (table === "jobs" && request.select === "id, pricing_json") {
          return { data: [], error: null };
        }
        let found = sortRows(rows.filter(matches));
        if (countHead) return { data: null, count: found.length, error: null };
        if (range) {
          found = found.slice(
            range[0],
            Math.min(range[1] + 1, range[0] + ROW_CEILING),
          );
        } else found = found.slice(0, ROW_CEILING);
        if (rowLimit != null) found = found.slice(0, rowLimit);
        const projected = found.map((row) =>
          table === "jobs" && request.select.includes("pj_total_inc")
            ? { ...row, ...project(row, request.select) }
            : project(row, request.select)
        );
        return finish(projected);
      }
      if (request.kind === "insert") {
        const incoming = Array.isArray(payload) ? payload : [payload];
        const staged: Row[] = [];
        for (const raw of incoming) {
          const row = { ...raw };
          const failure = checkInsert(table, row, [...rows, ...staged]);
          if (failure) return failure;
          staged.push(row);
        }
        rows.push(...staged);
        return finish(staged.map((row) => project(row, returning || "*")));
      }
      if (request.kind === "update") {
        const targets = rows.filter(matches);
        for (const target of targets) {
          const next = { ...target, ...payload };
          const failure = checkRow(table, next);
          if (failure) return failure;
        }
        for (const target of targets) Object.assign(target, payload);
        return finish(targets.map((row) => project(row, returning || "*")));
      }
      // delete
      const targets = rows.filter(matches);
      if (table === "job_material_suppliers") {
        for (const target of targets) {
          if (
            tables.job_material_lines.some((l) =>
              l.job_id === target.job_id && l.supplier_id === target.supplier_id
            )
          ) {
            return violation(
              "23503",
              "job_material_lines_supplier_on_job_fkey",
            );
          }
        }
      }
      tables[table] = rows.filter((row) => !targets.includes(row));
      return finish(targets.map((row) => project(row, returning || "id")));
    };

    const finish = (rows: Row[]) => {
      if (singleMode === "single") {
        return rows.length === 1
          ? { data: rows[0], error: null }
          : violation("PGRST116", "not one row");
      }
      if (singleMode === "maybe") {
        return rows.length > 1
          ? violation("PGRST116", "more than one row")
          : { data: rows[0] ?? null, error: null };
      }
      if (request.kind !== "select" && returning === null) {
        return { data: null, error: null };
      }
      return { data: rows, error: null };
    };

    function checkRow(name: string, row: Row) {
      if (name === "job_material_lines") {
        if (!STORED_STATUSES.includes(row.status)) {
          return violation("23514", "job_material_lines_status_valid");
        }
        const chosen = tables.job_material_suppliers.some((s) =>
          s.job_id === row.job_id && s.supplier_id === row.supplier_id
        );
        if (!chosen) {
          return violation("23503", "job_material_lines_supplier_on_job_fkey");
        }
      }
      return null;
    }

    function checkInsert(name: string, row: Row, existing: Row[]) {
      const now = tick();
      if (name === "job_material_suppliers") {
        row.id ??= crypto.randomUUID();
        row.created_at ??= now;
        if (
          existing.some((r) =>
            r.job_id === row.job_id && r.supplier_id === row.supplier_id
          )
        ) {
          return violation("23505", "job_material_suppliers_job_supplier_key");
        }
      }
      if (name === "job_material_lines") {
        row.status ??= "not_reviewed";
        row.source ??= "manual";
        row.purchase_order_id ??= null;
        row.created_at ??= now;
        row.updated_at ??= now;
        if (existing.some((r) => r.id === row.id)) {
          return violation("23505", "job_material_lines_pkey");
        }
      }
      if (name === "job_dispatch_workings") {
        for (
          const key of [
            "working_out",
            "working_out_updated_at",
            "sketch_png",
            "sketch_updated_at",
          ]
        ) row[key] ??= null;
        if (existing.some((r) => r.job_id === row.job_id)) {
          return violation("23505", "job_dispatch_workings_pkey");
        }
      }
      return checkRow(name, row);
    }

    const builder: any = {
      select(columns: string, options?: { count?: string; head?: boolean }) {
        if (request.kind === "select") request.select = columns;
        else returning = columns;
        if (options?.head) countHead = true;
        return builder;
      },
      insert(value: any) {
        request.kind = "insert";
        payload = value;
        return builder;
      },
      update(value: any) {
        request.kind = "update";
        payload = value;
        return builder;
      },
      delete() {
        request.kind = "delete";
        return builder;
      },
      eq(column: string, value: unknown) {
        request.filters.push(["eq", column, value]);
        return builder;
      },
      neq(column: string, value: unknown) {
        request.filters.push(["neq", column, value]);
        return builder;
      },
      in(column: string, values: unknown[]) {
        request.filters.push(["in", column, values]);
        return builder;
      },
      is(column: string, value: unknown) {
        // The pipeline's pricing probe filters on JSON paths; it is answered
        // empty above, so its filters are ignored.
        if (!column.includes("->")) request.filters.push(["is", column, value]);
        return builder;
      },
      or() {
        return builder;
      },
      not() {
        return builder;
      },
      order(column: string, options?: { ascending?: boolean }) {
        orders.push([column, options?.ascending !== false]);
        return builder;
      },
      limit(value: number) {
        rowLimit = value;
        return builder;
      },
      range(start: number, end: number) {
        range = [start, end];
        return Promise.resolve(execute());
      },
      single() {
        singleMode = "single";
        return builder;
      },
      maybeSingle() {
        singleMode = "maybe";
        return builder;
      },
      then(
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
    };
    return builder;
  }

  const writes = () => requests.filter((r) => r.kind !== "select");
  return { client: { from }, tables, requests, writes, failures };
}

// The server's clock, one second a call, so two saves never share a stamp.
let serverClock = Date.UTC(2026, 9, 14, 4, 0, 0);
function ctx(
  overrides: Partial<DispatchMaterialsContext> = {},
): DispatchMaterialsContext {
  return {
    orgId: ORG_ID,
    actor: {
      userId: uuid("d1", 1),
      email: "shaun@example.test",
      orgId: ORG_ID,
    },
    extractMaterialsFromScope: (scope) =>
      _extractMaterialsFromScopeForTest(scope, null),
    now: () => new Date(serverClock += 1000).toISOString(),
    ...overrides,
  };
}

const NO_PARAMS = new URLSearchParams();

function call(
  db: ReturnType<typeof makeDb>,
  action: string,
  body: Row = {},
  context = ctx(),
) {
  return runDispatchMaterialsAction(
    db.client,
    action,
    NO_PARAMS,
    body,
    context,
  ) as Promise<any>;
}

function read(db: ReturnType<typeof makeDb>, jobId: string, context = ctx()) {
  return runDispatchMaterialsAction(
    db.client,
    "dispatch_materials",
    new URLSearchParams({ job_id: jobId }),
    {},
    context,
  ) as Promise<any>;
}

async function refused(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<DispatchMaterialsError> {
  const error = await assertRejects(
    () => promise,
    DispatchMaterialsError,
  ) as DispatchMaterialsError;
  assertEquals(error.status, status, error.message);
  assertEquals(error.body.code, code, error.message);
  return error;
}

// The tables a materials action may write. Nothing else, ever.
const OWN_TABLES = new Set([
  "job_material_suppliers",
  "job_material_lines",
  "job_dispatch_workings",
]);
function assertOnlyOwnWrites(db: ReturnType<typeof makeDb>) {
  for (const write of db.writes()) {
    assert(
      OWN_TABLES.has(write.table),
      `${write.kind} on ${write.table} is not a Dispatch materials table`,
    );
  }
}

async function jobWithSuppliers(
  jobId = JOB.patio,
  suppliers = [SUP.steel, SUP.sheets],
) {
  const db = makeDb();
  for (const supplierId of suppliers) {
    await call(db, "dispatch_materials_add_supplier", {
      job_id: jobId,
      supplier_id: supplierId,
    });
  }
  return db;
}

async function addLine(
  db: ReturnType<typeof makeDb>,
  id: string,
  fields: Row = {},
  jobId = JOB.patio,
) {
  const answer = await call(db, "dispatch_materials_save_line", {
    job_id: jobId,
    line: {
      id,
      supplier_id: SUP.steel,
      description: "90x90 posts",
      quantity: 3,
      unit: "ea",
      ...fields,
    },
  });
  return answer.line;
}

// ── The one status and count rule ───────────────────────────────────────────

Deno.test("rule: display status is on_po whenever an order is stamped, else the stored status", () => {
  assertEquals(
    dispatchMaterialDisplayStatus({ status: "in_stock" }),
    "in_stock",
  );
  assertEquals(
    dispatchMaterialDisplayStatus({ status: "to_order" }),
    "to_order",
  );
  assertEquals(
    dispatchMaterialDisplayStatus({ status: "not_reviewed" }),
    "not_reviewed",
  );
  assertEquals(
    dispatchMaterialDisplayStatus({
      status: "in_stock",
      purchase_order_id: uuid("e1", 1),
    }),
    "on_po",
  );
});

Deno.test("rule: ready counts In stock only, never a line on an order; no line is 0 and 0", () => {
  assertEquals(dispatchMaterialCounts([]), { total: 0, ready: 0 });
  assertEquals(dispatchMaterialCounts(null), { total: 0, ready: 0 });
  assertEquals(
    dispatchMaterialCounts([
      { status: "in_stock", purchase_order_id: null },
      { status: "in_stock", purchase_order_id: null },
      { status: "to_order", purchase_order_id: null },
      { status: "not_reviewed", purchase_order_id: null },
      { status: "in_stock", purchase_order_id: uuid("e1", 1) },
    ]),
    { total: 5, ready: 2 },
  );
  const byJob = dispatchMaterialCountsByJob([
    { job_id: "a", status: "in_stock", purchase_order_id: null },
    { job_id: "a", status: "to_order", purchase_order_id: null },
    { job_id: "b", status: "in_stock", purchase_order_id: uuid("e1", 1) },
  ]);
  assertEquals(byJob.get("a"), { total: 2, ready: 1 });
  assertEquals(byJob.get("b"), { total: 1, ready: 0 });
  assertEquals(byJob.get("c"), undefined);
});

Deno.test("rule: the suggestion is offered on a patio job with no line only", () => {
  assertEquals(dispatchCanSuggest("patio", 0), true);
  assertEquals(dispatchCanSuggest("patio", 1), false);
  for (const type of ["fencing", "repair", "decking", "makesafe"]) {
    assertEquals(dispatchCanSuggest(type, 0), false);
  }
});

Deno.test("rule: a quantity is a number 0 or more, or null; text is refused, never coerced", () => {
  assertEquals(cleanDispatchQuantity(null), { ok: true, value: null });
  assertEquals(cleanDispatchQuantity(undefined), { ok: true, value: null });
  assertEquals(cleanDispatchQuantity(0), { ok: true, value: 0 });
  assertEquals(cleanDispatchQuantity(2.5), { ok: true, value: 2.5 });
  for (const bad of ["abc", "3", "", -1, NaN, Infinity, 1e10, {}, []]) {
    assertEquals(cleanDispatchQuantity(bad).ok, false, String(bad));
  }
});

Deno.test("rule: a stored order line is flattened to item, quantity and unit, never a price", () => {
  const shapes = [
    { description: "Sheets", quantity: 4, unit_price: 55 },
    { description: "Posts", quantity: 3, unit: "ea" },
    { description: "Rail", quantity: 2, unit: "m", unit_amount: 12 },
    {
      account_code: "300",
      description: "Synced",
      line_amount: 99,
      quantity: 1,
      tax_amount: 9,
      unit_price: 90,
    },
    {
      description: "Caps",
      line_total: 40,
      quantity: "8",
      unit: "ea",
      unit_amount: 5,
    },
    { description: "Screws", quantity: 100 },
  ];
  for (const shape of shapes) {
    const flat = flattenDispatchOrderLine(shape);
    assertEquals(Object.keys(flat).sort(), ["description", "quantity", "unit"]);
    assertEquals(flat.description, shape.description);
  }
  assertEquals(flattenDispatchOrderLine(shapes[0]), {
    description: "Sheets",
    quantity: 4,
    unit: null,
  });
  assertEquals(flattenDispatchOrderLine(shapes[4]).quantity, "8");
  assertEquals(flattenDispatchOrderLine(null), {
    description: null,
    quantity: null,
    unit: null,
  });
});

const PNG_HEADER = String.fromCharCode(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
);
const PNG = "data:image/png;base64," + btoa(PNG_HEADER + "rest-of-image");

Deno.test("rule: a sketch is a PNG data URL of at most 400,000 characters, or null", () => {
  assertEquals(cleanDispatchSketch(PNG), { ok: true, value: PNG });
  assertEquals(cleanDispatchSketch(null), { ok: true, value: null });
  for (
    const bad of [
      "data:image/jpeg;base64," + btoa(PNG_HEADER),
      "data:image/png;base64," + btoa("GIF89a-not-a-png"),
      "data:image/png;base64,!!!not base64",
      "data:image/png;base64," + btoa(PNG_HEADER) +
      "A".repeat(400_000),
      "",
      42,
    ]
  ) {
    assertEquals(cleanDispatchSketch(bad).ok, false);
  }
});

Deno.test("rule: suggested descriptions lose the long dash and the multiplication sign", () => {
  assertEquals(
    cleanSuggestedDescription("SolarSpan 75mm — 4.2m projection × 8 panels"),
    "SolarSpan 75mm, 4.2m projection x 8 panels",
  );
  assertEquals(cleanSuggestedDescription("100x50 — 7.7m"), "100x50, 7.7m");
  assertEquals(cleanSuggestedDescription("x".repeat(400)).length, 300);
  assertEquals(cleanSuggestedDescription(null), "");
});

// ── The read ────────────────────────────────────────────────────────────────

Deno.test("read: a job with nothing yet answers empty lists, 0 and 0, null workings, and orders ok", async () => {
  const db = makeDb();
  const answer = await read(db, JOB.patio);
  assertEquals(answer.job_id, JOB.patio);
  assertEquals(answer.work_type, "patio");
  assertEquals(answer.suppliers, []);
  assertEquals(answer.lines, []);
  assertEquals(answer.counts, { total: 0, ready: 0 });
  assertEquals(answer.can_suggest, true);
  assertEquals(answer.workings, {
    working_out: null,
    working_out_updated_at: null,
    sketch_png: null,
    sketch_updated_at: null,
  });
  assertEquals(answer.orders, []);
  assertEquals(answer.orders_status, "ok");
  assertEquals(db.writes(), []);
});

Deno.test("read: 400 for a missing or malformed id, 404 for another organisation, 409 for a make-safe", async () => {
  const db = makeDb();
  await refused(read(db, ""), 400, "invalid_request");
  await refused(read(db, "not-a-uuid"), 400, "invalid_request");
  await refused(read(db, uuid("a1", 99)), 404, "job_not_found");
  await refused(read(db, JOB.otherOrg), 404, "job_not_found");
  await refused(read(db, JOB.makesafe), 409, "not_dispatch_work");
  // A signed-in user of another organisation cannot read this one's job.
  await refused(
    read(
      db,
      JOB.patio,
      ctx({ actor: { userId: null, email: null, orgId: OTHER_ORG } }),
    ),
    404,
    "job_not_found",
  );
  // `jobId` is accepted as well as `job_id`.
  const answer = await runDispatchMaterialsAction(
    db.client,
    "dispatch_materials",
    new URLSearchParams({ jobId: JOB.fence }),
    {},
    ctx(),
  ) as any;
  assertEquals(answer.work_type, "fencing");
  assertEquals(answer.can_suggest, false);
});

Deno.test("read: a repair-family job stored as makesafe is allowed, as a repair", async () => {
  const answer = await read(makeDb(), JOB.repairMakesafe);
  assertEquals(answer.work_type, "repair");
  assertEquals(answer.can_suggest, false);
});

Deno.test("read: suppliers in position order, the contact's name and email now, a gone contact falls back", async () => {
  const db = await jobWithSuppliers(JOB.patio, [
    SUP.sheets,
    SUP.noEmail,
    SUP.steel,
  ]);
  // The steel contact is renamed after it was chosen; the sheets contact is retired.
  db.tables.suppliers.find((s) => s.id === SUP.steel)!.name =
    "Example Steel Pty";
  db.tables.suppliers.find((s) => s.id === SUP.sheets)!.is_active = false;
  const answer = await read(db, JOB.patio);
  assertEquals(
    answer.suppliers.map((
      s: Row,
    ) => [s.supplier_id, s.name, s.email, s.active, s.position]),
    [
      [SUP.sheets, "Example Sheets", null, false, 1],
      [SUP.noEmail, "No Email Supplies", null, true, 2],
      [SUP.steel, "Example Steel Pty", "orders@example.test", true, 3],
    ],
  );
  for (const supplier of answer.suppliers) assert(supplier.added_at);
});

Deno.test("read: the job's orders, oldest first, deleted left out, lines flattened, no money", async () => {
  const db = makeDb();
  db.tables.purchase_orders.push(
    {
      id: uuid("e1", 2),
      org_id: ORG_ID,
      job_id: JOB.fence,
      po_number: "PO-2",
      supplier_name: "Example Sheets",
      status: "sent",
      created_at: "2026-09-02T00:00:00Z",
      subtotal: 100,
      tax: 10,
      total: 110,
      line_items: [{ description: "Sheets", quantity: 4, unit_price: 25 }],
    },
    {
      id: uuid("e1", 1),
      org_id: ORG_ID,
      job_id: JOB.fence,
      po_number: "PO-1",
      supplier_name: "Example Steel",
      status: "draft",
      created_at: "2026-09-01T00:00:00Z",
      total: 300,
      line_items: [
        { description: "Posts", quantity: 3, unit: "ea" },
        {
          account_code: "300",
          description: "Rail",
          quantity: 2,
          line_amount: 80,
          tax_amount: 8,
        },
      ],
    },
    {
      id: uuid("e1", 3),
      org_id: ORG_ID,
      job_id: JOB.fence,
      po_number: "PO-3",
      supplier_name: "Example Steel",
      status: "deleted",
      created_at: "2026-09-03T00:00:00Z",
      line_items: [],
    },
  );
  const answer = await read(db, JOB.fence);
  assertEquals(answer.orders_status, "ok");
  assertEquals(
    answer.orders.map((o: Row) => [o.po_number, o.status, o.lines.length]),
    [
      ["PO-1", "draft", 2],
      ["PO-2", "sent", 1],
    ],
  );
  assertEquals(answer.orders[0].lines[1], {
    description: "Rail",
    quantity: 2,
    unit: null,
  });
  const text = JSON.stringify(answer.orders);
  for (
    const money of [
      "total",
      "subtotal",
      "tax",
      "unit_price",
      "line_amount",
      "account_code",
      "unit_amount",
    ]
  ) {
    assert(!text.includes(money), `${money} leaked into the orders`);
  }
  const ordersRead = db.requests.find((r) => r.table === "purchase_orders")!;
  // Slice 5 adds the Dispatch order columns, slice 6 the delivery columns;
  // still no price, total or tax.
  assertEquals(
    ordersRead.select,
    "id, po_number, supplier_name, status, created_at, updated_at, line_items, supplier_id, source, pdf_version, last_sent_pdf_version, last_sent_at, xero_po_id, po_type, delivery_date, confirmed_delivery_date, confirmed_delivery_set_at, confirmed_delivery_set_by, confirmed_delivery_set_by_email, delivery_sighted_at, delivery_sighted_by, delivery_sighted_by_email",
  );
  assertEquals(db.writes(), []);
});

Deno.test("read: a failed orders read answers orders_status failed and no orders key; the lines still show", async () => {
  const db = await jobWithSuppliers();
  await addLine(db, line(1));
  db.failures.add("select:purchase_orders");
  const answer = await read(db, JOB.patio);
  assertEquals(answer.orders_status, "failed");
  assert(!("orders" in answer));
  assertEquals(answer.lines.length, 1);
});

for (
  const table of [
    "job_material_suppliers",
    "job_material_lines",
    "job_dispatch_workings",
    "suppliers",
  ]
) {
  Deno.test(`read: a failed ${table} read is a 500, never an empty section`, async () => {
    const db = await jobWithSuppliers();
    db.failures.add(`select:${table}`);
    await refused(read(db, JOB.patio), 500, "materials_read_failed");
  });
}

Deno.test("read: the read writes nothing and reads only its own five tables after the job", async () => {
  const db = await jobWithSuppliers();
  await addLine(db, line(1));
  const before = db.requests.length;
  await read(db, JOB.patio);
  const reads = db.requests.slice(before);
  assertEquals(reads.filter((r) => r.kind !== "select"), []);
  assertEquals(
    [...new Set(reads.map((r) => r.table))].sort(),
    [
      "job_dispatch_workings",
      "job_material_lines",
      "job_material_suppliers",
      "jobs",
      "purchase_orders",
      "suppliers",
    ],
  );
  assert(
    !reads.some((r) =>
      r.table === "jobs" && /scope_json|pricing_json/.test(r.select)
    ),
  );
});

// ── Suppliers ───────────────────────────────────────────────────────────────

Deno.test("add supplier: one row; twice is unchanged; inactive 409; unknown or another org's 404", async () => {
  const db = makeDb();
  const first = await call(db, "dispatch_materials_add_supplier", {
    job_id: JOB.patio,
    supplier_id: SUP.steel,
  });
  assertEquals(first.success, true);
  assertEquals(first.supplier, {
    supplier_id: SUP.steel,
    name: "Example Steel",
    email: "orders@example.test",
    active: true,
    position: 1,
    added_at: first.supplier.added_at,
  });
  assertEquals(first.counts, { total: 0, ready: 0 });
  const stored = db.tables.job_material_suppliers[0];
  assertEquals(stored.supplier_name, "Example Steel");
  assertEquals(stored.created_by, uuid("d1", 1));
  assertEquals(stored.created_by_email, "shaun@example.test");

  const again = await call(db, "dispatch_materials_add_supplier", {
    job_id: JOB.patio,
    supplier_id: SUP.steel,
  });
  assertEquals(again.unchanged, true);
  assertEquals(db.tables.job_material_suppliers.length, 1);

  await refused(
    call(db, "dispatch_materials_add_supplier", {
      job_id: JOB.patio,
      supplier_id: SUP.inactive,
    }),
    409,
    "supplier_inactive",
  );
  await refused(
    call(db, "dispatch_materials_add_supplier", {
      job_id: JOB.patio,
      supplier_id: uuid("b1", 99),
    }),
    404,
    "supplier_not_found",
  );
  await refused(
    call(db, "dispatch_materials_add_supplier", {
      job_id: JOB.patio,
      supplier_id: SUP.otherOrg,
    }),
    404,
    "supplier_not_found",
  );
  await refused(
    call(db, "dispatch_materials_add_supplier", {
      job_id: JOB.patio,
      supplier_id: "nope",
    }),
    400,
    "invalid_request",
  );
  assertEquals(db.tables.job_material_suppliers.length, 1);

  // A contact with no email can be chosen: nothing is blocked.
  const noEmail = await call(db, "dispatch_materials_add_supplier", {
    job_id: JOB.patio,
    supplier_id: SUP.noEmail,
  });
  assertEquals(noEmail.supplier.email, null);
  assertEquals(noEmail.supplier.position, 2);
  assertOnlyOwnWrites(db);
});

Deno.test("remove supplier: an empty one goes; one with a line is 409 and stays; not on the job is unchanged", async () => {
  const db = await jobWithSuppliers();
  await addLine(db, line(1));
  await refused(
    call(db, "dispatch_materials_remove_supplier", {
      job_id: JOB.patio,
      supplier_id: SUP.steel,
    }),
    409,
    "supplier_has_lines",
  );
  assertEquals(db.tables.job_material_suppliers.length, 2);

  const removed = await call(db, "dispatch_materials_remove_supplier", {
    job_id: JOB.patio,
    supplier_id: SUP.sheets,
  });
  assertEquals(removed.success, true);
  assertEquals(removed.counts, { total: 1, ready: 0 });
  assertEquals(db.tables.job_material_suppliers.map((s) => s.supplier_id), [
    SUP.steel,
  ]);

  const again = await call(db, "dispatch_materials_remove_supplier", {
    job_id: JOB.patio,
    supplier_id: SUP.sheets,
  });
  assertEquals(again.unchanged, true);
  assertOnlyOwnWrites(db);
});

// ── Lines ───────────────────────────────────────────────────────────────────

Deno.test("save line: insert; the same id twice is one row; the answer is the read's shape with counts", async () => {
  const db = await jobWithSuppliers();
  const answer = await call(db, "dispatch_materials_save_line", {
    job_id: JOB.patio,
    line: {
      id: line(1),
      supplier_id: SUP.steel,
      description: "  90x90 posts  ",
      quantity: 3,
      unit: "",
    },
  });
  assertEquals(answer.line, {
    id: line(1),
    supplier_id: SUP.steel,
    description: "90x90 posts",
    quantity: 3,
    unit: null,
    status: "not_reviewed",
    display_status: "not_reviewed",
    purchase_order_id: null,
    source: "manual",
    position: 1,
    updated_at: answer.line.updated_at,
  });
  assertEquals(answer.counts, { total: 1, ready: 0 });
  const stored = db.tables.job_material_lines[0];
  assertEquals(stored.created_by, uuid("d1", 1));
  assertEquals(stored.updated_by_email, "shaun@example.test");

  const writesBefore = db.writes().length;
  const retry = await call(db, "dispatch_materials_save_line", {
    job_id: JOB.patio,
    line: {
      id: line(1),
      supplier_id: SUP.steel,
      description: "90x90 posts",
      quantity: 3,
    },
  });
  assertEquals(retry.unchanged, true);
  assertEquals(retry.line.id, line(1));
  assertEquals(db.tables.job_material_lines.length, 1);
  assertEquals(db.writes().length, writesBefore);
  assertOnlyOwnWrites(db);
});

Deno.test("save line: update guarded on expected_updated_at; a wrong stamp is 409 with the stored line and writes nothing", async () => {
  const db = await jobWithSuppliers();
  const first = await addLine(db, line(1));
  const updated = await call(db, "dispatch_materials_save_line", {
    job_id: JOB.patio,
    line: {
      id: line(1),
      supplier_id: SUP.steel,
      description: "100x100 posts",
      quantity: 4,
      unit: "ea",
    },
    expected_updated_at: first.updated_at,
  });
  assertEquals(updated.line.description, "100x100 posts");
  assertEquals(updated.line.quantity, 4);
  assert(updated.line.updated_at !== first.updated_at);

  const snapshot = structuredClone(db.tables.job_material_lines);
  const stale = await refused(
    call(db, "dispatch_materials_save_line", {
      job_id: JOB.patio,
      line: {
        id: line(1),
        supplier_id: SUP.steel,
        description: "stale tab",
        quantity: 1,
      },
      expected_updated_at: first.updated_at,
    }),
    409,
    "line_changed",
  );
  assertEquals((stale.body.line as Row).description, "100x100 posts");
  assertEquals(db.tables.job_material_lines, snapshot);
});

Deno.test("save line: a line id from another job is 409 line_not_on_job", async () => {
  const db = await jobWithSuppliers();
  await call(db, "dispatch_materials_add_supplier", {
    job_id: JOB.fence,
    supplier_id: SUP.steel,
  });
  await addLine(db, line(1));
  await refused(
    call(db, "dispatch_materials_save_line", {
      job_id: JOB.fence,
      line: { id: line(1), supplier_id: SUP.steel, description: "x" },
    }),
    409,
    "line_not_on_job",
  );
  await refused(
    call(db, "dispatch_materials_delete_line", {
      job_id: JOB.fence,
      id: line(1),
      expected_updated_at: db.tables.job_material_lines[0].updated_at,
    }),
    409,
    "line_not_on_job",
  );
  assertEquals(db.tables.job_material_lines.length, 1);
});

Deno.test("save line: moving to a chosen supplier puts the line last; to one not on the job is 409", async () => {
  const db = await jobWithSuppliers();
  const a = await addLine(db, line(1));
  await addLine(db, line(2), { supplier_id: SUP.sheets });
  await addLine(db, line(3), { supplier_id: SUP.sheets });
  const moved = await call(db, "dispatch_materials_save_line", {
    job_id: JOB.patio,
    line: {
      id: line(1),
      supplier_id: SUP.sheets,
      description: a.description,
      quantity: a.quantity,
      unit: a.unit,
    },
    expected_updated_at: a.updated_at,
  });
  assertEquals(moved.line.supplier_id, SUP.sheets);
  assertEquals(moved.line.position, 4);
  assertEquals(moved.counts, { total: 3, ready: 0 });

  await refused(
    call(db, "dispatch_materials_save_line", {
      job_id: JOB.patio,
      line: {
        id: line(1),
        supplier_id: SUP.noEmail,
        description: a.description,
      },
      expected_updated_at: moved.line.updated_at,
    }),
    409,
    "supplier_not_on_job",
  );
  await refused(
    call(db, "dispatch_materials_save_line", {
      job_id: JOB.patio,
      line: { id: line(4), supplier_id: SUP.noEmail, description: "new" },
    }),
    409,
    "supplier_not_on_job",
  );
  assertEquals(
    db.tables.job_material_lines.find((l) => l.id === line(1))!.supplier_id,
    SUP.sheets,
  );
});

Deno.test("save line: each of the three statuses saves; a fourth, an empty item and a text Qty are 400", async () => {
  const db = await jobWithSuppliers();
  let current = await addLine(db, line(1), { status: "to_order" });
  assertEquals(current.status, "to_order");
  for (const status of ["not_reviewed", "to_order", "in_stock"]) {
    const answer = await call(db, "dispatch_materials_save_line", {
      job_id: JOB.patio,
      line: {
        id: line(1),
        supplier_id: SUP.steel,
        description: "Posts",
        quantity: 3,
        status,
      },
      expected_updated_at: current.updated_at,
    });
    current = answer.line;
    assertEquals(current.status, status);
    assertEquals(current.display_status, status);
    assertEquals(answer.counts.ready, status === "in_stock" ? 1 : 0);
  }
  const bad: Row[] = [
    { status: "on_po" },
    { status: "delivered" },
    { description: "   " },
    { description: "" },
    { description: "x".repeat(301) },
    { quantity: "abc" },
    { quantity: -2 },
    { unit: "u".repeat(31) },
  ];
  for (const fields of bad) {
    await refused(
      call(db, "dispatch_materials_save_line", {
        job_id: JOB.patio,
        line: {
          id: line(1),
          supplier_id: SUP.steel,
          description: "Posts",
          quantity: 3,
          ...fields,
        },
        expected_updated_at: current.updated_at,
      }),
      400,
      "invalid_request",
    );
  }
  await refused(
    call(db, "dispatch_materials_save_line", { job_id: JOB.patio }),
    400,
    "invalid_request",
  );
  await refused(
    call(db, "dispatch_materials_save_line", {
      job_id: JOB.patio,
      line: { id: "not-a-uuid", supplier_id: SUP.steel, description: "Posts" },
    }),
    400,
    "invalid_request",
  );
  assertEquals(db.tables.job_material_lines[0].status, "in_stock");
});

Deno.test("save and delete: a line on an order is 409 line_on_order and nothing is written", async () => {
  const db = await jobWithSuppliers();
  const stub = await addLine(db, line(1), { status: "in_stock" });
  // No slice 4 path can set this; slice 5 will.
  db.tables.job_material_lines[0].purchase_order_id = uuid("e1", 1);
  const snapshot = structuredClone(db.tables.job_material_lines);
  await refused(
    call(db, "dispatch_materials_save_line", {
      job_id: JOB.patio,
      line: {
        id: line(1),
        supplier_id: SUP.steel,
        description: "Posts",
        status: "to_order",
      },
      expected_updated_at: stub.updated_at,
    }),
    409,
    "line_on_order",
  );
  await refused(
    call(db, "dispatch_materials_delete_line", {
      job_id: JOB.patio,
      id: line(1),
      expected_updated_at: stub.updated_at,
    }),
    409,
    "line_on_order",
  );
  assertEquals(db.tables.job_material_lines, snapshot);
  const answer = await read(db, JOB.patio);
  assertEquals(answer.lines[0].display_status, "on_po");
  assertEquals(answer.counts, { total: 1, ready: 0 });
});

Deno.test("save line: purchase_order_id and source sent by a caller are ignored", async () => {
  const db = await jobWithSuppliers();
  const created = await addLine(db, line(1), {
    purchase_order_id: uuid("e1", 1),
    source: "scope",
  });
  assertEquals(created.purchase_order_id, null);
  assertEquals(created.source, "manual");
});

Deno.test("save line: a job holds at most 500 lines", async () => {
  const db = await jobWithSuppliers();
  for (let index = 1; index <= 500; index++) {
    db.tables.job_material_lines.push({
      id: uuid("f1", index),
      org_id: ORG_ID,
      job_id: JOB.patio,
      supplier_id: SUP.steel,
      description: `Line ${index}`,
      quantity: 1,
      unit: null,
      status: "not_reviewed",
      purchase_order_id: null,
      source: "manual",
      position: index,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
    });
  }
  await refused(
    call(db, "dispatch_materials_save_line", {
      job_id: JOB.patio,
      line: {
        id: line(1),
        supplier_id: SUP.steel,
        description: "one too many",
      },
    }),
    409,
    "too_many_lines",
  );
  assertEquals(db.tables.job_material_lines.length, 500);
  // Editing a line on a full job still works.
  const edited = await call(db, "dispatch_materials_save_line", {
    job_id: JOB.patio,
    line: { id: uuid("f1", 1), supplier_id: SUP.steel, description: "Edited" },
    expected_updated_at: "2026-10-01T00:00:00.000Z",
  });
  assertEquals(edited.line.description, "Edited");
  // The read returns every line, never capped.
  assertEquals((await read(db, JOB.patio)).lines.length, 500);
});

Deno.test("save line: an edit to a line removed elsewhere is 409 line_changed and never brings it back", async () => {
  const db = await jobWithSuppliers();
  const a = await addLine(db, line(1));
  await call(db, "dispatch_materials_delete_line", {
    job_id: JOB.patio,
    id: line(1),
    expected_updated_at: a.updated_at,
  });
  const gone = await refused(
    call(db, "dispatch_materials_save_line", {
      job_id: JOB.patio,
      line: { id: line(1), supplier_id: SUP.steel, description: "edited late" },
      expected_updated_at: a.updated_at,
    }),
    409,
    "line_changed",
  );
  assertEquals(gone.body.line, null);
  assertEquals(db.tables.job_material_lines, []);
});

Deno.test("delete line: once with the right stamp; twice is unchanged; a wrong stamp is 409 and keeps it", async () => {
  const db = await jobWithSuppliers();
  const a = await addLine(db, line(1));
  const b = await addLine(db, line(2), { status: "in_stock" });
  await refused(
    call(db, "dispatch_materials_delete_line", {
      job_id: JOB.patio,
      id: line(1),
      expected_updated_at: "2026-01-01T00:00:00.000Z",
    }),
    409,
    "line_changed",
  );
  await refused(
    call(db, "dispatch_materials_delete_line", {
      job_id: JOB.patio,
      id: line(1),
    }),
    400,
    "invalid_request",
  );
  const gone = await call(db, "dispatch_materials_delete_line", {
    job_id: JOB.patio,
    id: line(1),
    expected_updated_at: a.updated_at,
  });
  assertEquals(gone.counts, { total: 1, ready: 1 });
  const twice = await call(db, "dispatch_materials_delete_line", {
    job_id: JOB.patio,
    id: line(1),
    expected_updated_at: a.updated_at,
  });
  assertEquals(twice.unchanged, true);
  assertEquals(db.tables.job_material_lines.map((l) => l.id), [b.id]);
  assertOnlyOwnWrites(db);
});

// ── Make-safe ───────────────────────────────────────────────────────────────

Deno.test("make-safe: every action is 409 not_dispatch_work and writes nothing; a repair-family make-safe works", async () => {
  const db = makeDb();
  const bodies: Record<string, Row> = {
    dispatch_materials_add_supplier: { supplier_id: SUP.steel },
    dispatch_materials_remove_supplier: { supplier_id: SUP.steel },
    dispatch_materials_save_line: {
      line: { id: line(1), supplier_id: SUP.steel, description: "Posts" },
    },
    dispatch_materials_delete_line: {
      id: line(1),
      expected_updated_at: "2026-10-01T00:00:00Z",
    },
    dispatch_materials_suggest: { supplier_id: SUP.steel },
    dispatch_materials_save_workings: { working_out: "sums" },
  };
  for (const [action, body] of Object.entries(bodies)) {
    await refused(
      call(db, action, { job_id: JOB.makesafe, ...body }),
      409,
      "not_dispatch_work",
    );
  }
  await refused(read(db, JOB.makesafe), 409, "not_dispatch_work");
  assertEquals(db.writes(), []);

  await call(db, "dispatch_materials_add_supplier", {
    job_id: JOB.repairMakesafe,
    supplier_id: SUP.steel,
  });
  const saved = await addLine(db, line(1), {}, JOB.repairMakesafe);
  assertEquals(saved.id, line(1));
  const ws = await call(db, "dispatch_materials_save_workings", {
    job_id: JOB.repairMakesafe,
    working_out: "sums",
  });
  assertEquals(ws.success, true);
  await refused(
    call(db, "dispatch_materials_suggest", {
      job_id: JOB.repairMakesafe,
      supplier_id: SUP.steel,
    }),
    409,
    "no_suggestion_for_work_type",
  );
});

// ── The scope suggestion ────────────────────────────────────────────────────

Deno.test("suggest: a patio scope shaped like SWP-26701 adds the four lines, cleaned, with no price", async () => {
  const db = await jobWithSuppliers();
  const answer = await call(db, "dispatch_materials_suggest", {
    job_id: JOB.patio,
    supplier_id: SUP.steel,
  });
  assertEquals(answer.added, 4);
  assertEquals(
    answer.lines.map((
      l: Row,
    ) => [
      l.description,
      l.quantity,
      l.unit,
      l.status,
      l.source,
      l.supplier_id,
    ]),
    [
      [
        "SolarSpan 75mm, 4.2m projection x 8 panels",
        8,
        null,
        "not_reviewed",
        "scope",
        SUP.steel,
      ],
      ["90x90 posts", 3, null, "not_reviewed", "scope", SUP.steel],
      ["100x50, 7.7m", 1, null, "not_reviewed", "scope", SUP.steel],
      [
        "Concrete footings (400x400x500mm)",
        3,
        null,
        "not_reviewed",
        "scope",
        SUP.steel,
      ],
    ],
  );
  assertEquals(answer.counts, { total: 4, ready: 0 });
  for (const stored of db.tables.job_material_lines) {
    assert(!("unit_price" in stored) && !("notes" in stored));
    assert(!/[—×]/.test(stored.description));
  }
  // The scope is read once, for this job, and the pricing never.
  const jobReads = db.requests.filter((r) => r.table === "jobs");
  assert(jobReads.every((r) => !r.select.includes("pricing_json")));
  assertEquals(
    jobReads.filter((r) => r.select.includes("scope_json")).length,
    1,
  );
  assertOnlyOwnWrites(db);

  // Once the job has a line, the suggestion is refused and no longer offered.
  await refused(
    call(db, "dispatch_materials_suggest", {
      job_id: JOB.patio,
      supplier_id: SUP.sheets,
    }),
    409,
    "lines_exist",
  );
  assertEquals((await read(db, JOB.patio)).can_suggest, false);
});

Deno.test("suggest: two presses at once add the scope lines once; the second is 409 lines_exist", async () => {
  const db = await jobWithSuppliers();
  const [first, second] = await Promise.allSettled([
    call(db, "dispatch_materials_suggest", {
      job_id: JOB.patio,
      supplier_id: SUP.steel,
    }),
    call(db, "dispatch_materials_suggest", {
      job_id: JOB.patio,
      supplier_id: SUP.sheets,
    }),
  ]);
  const settled = [first, second];
  const won = settled.filter((r) => r.status === "fulfilled");
  const lost = settled.filter((r) => r.status === "rejected");
  assertEquals(won.length, 1);
  assertEquals(lost.length, 1);
  const error = (lost[0] as PromiseRejectedResult).reason;
  assert(error instanceof DispatchMaterialsError);
  assertEquals(error.status, 409);
  assertEquals(error.body.code, "lines_exist");
  const stored = db.tables.job_material_lines.filter((l) =>
    l.job_id === JOB.patio
  );
  assertEquals(stored.length, 4);
  assertEquals(
    stored.map((l) => l.position).sort(),
    [1, 2, 3, 4],
  );
  assertEquals((await read(db, JOB.patio)).counts, { total: 4, ready: 0 });
});

Deno.test("suggest: not a patio job 409, even with a patio-shaped scope; supplier not on the job 409", async () => {
  const db = await jobWithSuppliers(JOB.fence);
  await refused(
    call(db, "dispatch_materials_suggest", {
      job_id: JOB.fence,
      supplier_id: SUP.steel,
    }),
    409,
    "no_suggestion_for_work_type",
  );
  await refused(
    call(db, "dispatch_materials_suggest", {
      job_id: JOB.patio,
      supplier_id: SUP.steel,
    }),
    409,
    "supplier_not_on_job",
  );
  assertEquals(db.tables.job_material_lines, []);
});

Deno.test("suggest: a scope with nothing gives added 0, and a quote's pricing items never become lines", async () => {
  for (const jobId of [JOB.patioNoScope, JOB.patioPricingOnly]) {
    const db = await jobWithSuppliers(jobId);
    const answer = await call(db, "dispatch_materials_suggest", {
      job_id: jobId,
      supplier_id: SUP.steel,
    });
    assertEquals(answer.success, true);
    assertEquals(answer.added, 0);
    assertEquals(answer.lines, []);
    assertEquals(db.tables.job_material_lines, []);
    assert(db.requests.every((r) => !r.select.includes("pricing_json")));
  }
  // The same job through scope_to_po's own call (with pricing) would have
  // returned the quote's line with its price: the null pricing is the guard.
  const withPricing = _extractMaterialsFromScopeForTest(
    { config: {} },
    {
      items: [{
        description: "Colorbond steel panel",
        quantity: 4,
        unit_price: 250,
      }],
    },
  );
  assertEquals(withPricing.length, 1);
});

Deno.test("suggest: a scope the extractor cannot read is 409 scope_unreadable, never zero lines", async () => {
  const db = await jobWithSuppliers();
  await refused(
    call(
      db,
      "dispatch_materials_suggest",
      { job_id: JOB.patio, supplier_id: SUP.steel },
      ctx({
        extractMaterialsFromScope: () => {
          throw new SyntaxError("Unexpected token");
        },
      }),
    ),
    409,
    "scope_unreadable",
  );
  assertEquals(db.tables.job_material_lines, []);
});

// ── Working out and sketch ──────────────────────────────────────────────────

Deno.test("workings: save text and a sketch, each guarded on its own stamp", async () => {
  const db = makeDb();
  const text = await call(db, "dispatch_materials_save_workings", {
    job_id: JOB.patio,
    working_out: "42 m run / 2.4 m bays = 18 bays",
  });
  assert(text.workings.working_out_updated_at);
  assertEquals(text.workings.sketch_updated_at, null);
  assert(!("sketch_png" in text.workings));

  // Saving the sketch with a null expected stamp works though the row exists:
  // the two fields never collide.
  const sketch = await call(db, "dispatch_materials_save_workings", {
    job_id: JOB.patio,
    sketch_png: PNG,
    expected_sketch_updated_at: null,
  });
  assert(sketch.workings.sketch_updated_at);
  assertEquals(
    sketch.workings.working_out_updated_at,
    text.workings.working_out_updated_at,
  );
  assert(!JSON.stringify(sketch).includes("base64"));

  // A wrong stamp on either is 409 with that field's stored value.
  const staleText = await refused(
    call(db, "dispatch_materials_save_workings", {
      job_id: JOB.patio,
      working_out: "older tab",
      expected_working_out_updated_at: "2026-01-01T00:00:00.000Z",
    }),
    409,
    "workings_changed",
  );
  assertEquals(staleText.body.working_out, "42 m run / 2.4 m bays = 18 bays");
  const staleSketch = await refused(
    call(db, "dispatch_materials_save_workings", {
      job_id: JOB.patio,
      sketch_png: PNG,
    }),
    409,
    "workings_changed",
  );
  assertEquals(staleSketch.body.sketch_png, PNG);

  // The right stamp saves; saving the text leaves the sketch's stamp alone.
  const textAgain = await call(db, "dispatch_materials_save_workings", {
    job_id: JOB.patio,
    working_out: "40 m run",
    expected_working_out_updated_at: text.workings.working_out_updated_at,
  });
  assertEquals(
    textAgain.workings.sketch_updated_at,
    sketch.workings.sketch_updated_at,
  );

  // null clears the sketch; an empty string clears the text.
  const cleared = await call(db, "dispatch_materials_save_workings", {
    job_id: JOB.patio,
    sketch_png: null,
    expected_sketch_updated_at: sketch.workings.sketch_updated_at,
  });
  await call(db, "dispatch_materials_save_workings", {
    job_id: JOB.patio,
    working_out: "",
    expected_working_out_updated_at: textAgain.workings.working_out_updated_at,
  });
  const after = await read(db, JOB.patio);
  assertEquals(after.workings.working_out, null);
  assertEquals(after.workings.sketch_png, null);
  assertEquals(
    after.workings.sketch_updated_at,
    cleared.workings.sketch_updated_at,
  );
  assertEquals(db.tables.job_dispatch_workings.length, 1);
  assertEquals(
    db.tables.job_dispatch_workings[0].working_out_updated_by_email,
    "shaun@example.test",
  );
  assertOnlyOwnWrites(db);
});

Deno.test("workings: first saves of the text and the sketch at once both land", async () => {
  const db = makeDb();
  const [text, sketch] = await Promise.all([
    call(db, "dispatch_materials_save_workings", {
      job_id: JOB.patio,
      working_out: "18 bays",
    }),
    call(db, "dispatch_materials_save_workings", {
      job_id: JOB.patio,
      sketch_png: PNG,
    }),
  ]);
  assert(text.workings.working_out_updated_at);
  assert(sketch.workings.sketch_updated_at);
  assertEquals(db.tables.job_dispatch_workings.length, 1);
  const after = await read(db, JOB.patio);
  assertEquals(after.workings.working_out, "18 bays");
  assertEquals(after.workings.sketch_png, PNG);

  const db2 = makeDb();
  const results = await Promise.allSettled([
    call(db2, "dispatch_materials_save_workings", {
      job_id: JOB.patio,
      working_out: "first tab",
    }),
    call(db2, "dispatch_materials_save_workings", {
      job_id: JOB.patio,
      working_out: "second tab",
    }),
  ]);
  const lost = results.filter((r) => r.status === "rejected");
  assertEquals(lost.length, 1);
  const error = (lost[0] as PromiseRejectedResult).reason;
  assert(error instanceof DispatchMaterialsError);
  assertEquals(error.status, 409);
  assertEquals(error.body.code, "workings_changed");
});

Deno.test("workings: a job with no row expects null; anything else is 409", async () => {
  const db = makeDb();
  await refused(
    call(db, "dispatch_materials_save_workings", {
      job_id: JOB.patio,
      working_out: "sums",
      expected_working_out_updated_at: "2026-10-01T00:00:00.000Z",
    }),
    409,
    "workings_changed",
  );
  assertEquals(db.tables.job_dispatch_workings, []);
});

Deno.test("workings: not a PNG, over 400,000 characters, text over 20,000, both or neither field: 400", async () => {
  const db = makeDb();
  const bad: Row[] = [
    { sketch_png: "data:image/png;base64," + btoa("not a png") },
    { sketch_png: "data:image/jpeg;base64," + btoa(PNG_HEADER) },
    { sketch_png: PNG + "A".repeat(400_000) },
    { sketch_png: "" },
    { working_out: "x".repeat(20_001) },
    { working_out: 42 },
    { working_out: "a", sketch_png: null },
    {},
  ];
  for (const body of bad) {
    await refused(
      call(db, "dispatch_materials_save_workings", {
        job_id: JOB.patio,
        ...body,
      }),
      400,
      "invalid_request",
    );
  }
  assertEquals(db.tables.job_dispatch_workings, []);
  const atLimit = await call(db, "dispatch_materials_save_workings", {
    job_id: JOB.patio,
    working_out: "x".repeat(20_000),
  });
  assertEquals(atLimit.success, true);
});

// ── The read and every write agree on counts ────────────────────────────────

Deno.test("counts: the read, each write's answer and the list's fields agree", async () => {
  const db = await jobWithSuppliers();
  const a = await addLine(db, line(1), { status: "in_stock" });
  await addLine(db, line(2), { status: "to_order" });
  const third = await call(db, "dispatch_materials_save_line", {
    job_id: JOB.patio,
    line: {
      id: line(3),
      supplier_id: SUP.sheets,
      description: "Sheets",
      status: "in_stock",
    },
  });
  assertEquals(third.counts, { total: 3, ready: 2 });
  assertEquals((await read(db, JOB.patio)).counts, { total: 3, ready: 2 });

  db.tables.jobs = [listJob(JOB.patio)];
  const list = await _pipelineForTest(
    db.client,
    new URLSearchParams("dispatch=1"),
  );
  const row = Object.values(list.columns).flat()[0] as Row;
  assertEquals(row.materials_lines_total, 3);
  assertEquals(row.materials_lines_ready, 2);
  assertEquals(a.display_status, "in_stock");
});

// ── The Dispatch list ───────────────────────────────────────────────────────

function listJob(id: string, overrides: Row = {}): Row {
  return job(id, {
    client_name: "Example Customer",
    site_address: "1 Example Street",
    site_suburb: "Balcatta",
    pj_total_inc: 1000,
    pj_total: null,
    pj_split_neighbours: null,
    pj_job_neighbours: null,
    updated_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  });
}

function listDb() {
  const db = makeDb({
    ...seed(),
    jobs: [
      listJob(JOB.patio),
      listJob(JOB.fence, { type: "fencing", status: "scheduled" }),
    ],
  });
  db.tables.job_material_suppliers.push({
    job_id: JOB.patio,
    supplier_id: SUP.steel,
    position: 1,
  });
  const base = {
    org_id: ORG_ID,
    job_id: JOB.patio,
    supplier_id: SUP.steel,
    source: "manual",
  };
  db.tables.job_material_lines.push(
    {
      ...base,
      id: line(1),
      status: "in_stock",
      purchase_order_id: null,
      position: 1,
    },
    {
      ...base,
      id: line(2),
      status: "in_stock",
      purchase_order_id: uuid("e1", 1),
      position: 2,
    },
    {
      ...base,
      id: line(3),
      status: "to_order",
      purchase_order_id: null,
      position: 3,
    },
  );
  return db;
}

Deno.test("list: dispatch=1 carries the two fields per row and dispatch_materials ok; a job with no line is 0 and 0", async () => {
  const db = listDb();
  const result: any = await _pipelineForTest(
    db.client,
    new URLSearchParams("dispatch=1"),
  );
  assertEquals(result.dispatch_materials, "ok");
  assert(!result.degraded);
  const byId = Object.fromEntries(
    (Object.values(result.columns).flat() as Row[]).map((row) => [row.id, row]),
  );
  assertEquals(byId[JOB.patio].materials_lines_total, 3);
  assertEquals(byId[JOB.patio].materials_lines_ready, 1);
  assertEquals(byId[JOB.fence].materials_lines_total, 0);
  assertEquals(byId[JOB.fence].materials_lines_ready, 0);
  const materialsReads = db.requests.filter((r) =>
    r.table === "job_material_lines"
  );
  assertEquals(materialsReads.length, 1);
  assertEquals(materialsReads[0].select, DISPATCH_MATERIALS_LIST_SELECT);
  assertEquals(
    DISPATCH_MATERIALS_LIST_SELECT,
    "job_id, status, purchase_order_id",
  );
  assert(!db.requests.some((r) => r.table === "job_dispatch_workings"));
  assert(!db.requests.some((r) => r.select.includes("sketch_png")));
  assertEquals(db.writes(), []);
});

Deno.test("list: a failed materials read says failed and leaves both fields off every row, never 0, never degraded", async () => {
  const db = listDb();
  db.failures.add("select:job_material_lines");
  const result: any = await _pipelineForTest(
    db.client,
    new URLSearchParams("dispatch=1"),
  );
  assertEquals(result.dispatch_materials, "failed");
  assert(
    !result.degraded,
    "a failed materials read must not mark the whole list degraded",
  );
  assertEquals(result.total, 2);
  for (const row of Object.values(result.columns).flat() as Row[]) {
    assert(!("materials_lines_total" in row));
    assert(!("materials_lines_ready" in row));
  }
});

Deno.test("list: the plain pipeline answer carries none of the new keys and never reads the materials", async () => {
  const db = listDb();
  const result: any = await _pipelineForTest(
    db.client,
    new URLSearchParams(""),
  );
  assert(!("dispatch_materials" in result));
  for (const row of Object.values(result.columns).flat() as Row[]) {
    assert(!("materials_lines_total" in row));
    assert(!("materials_lines_ready" in row));
  }
  assert(!db.requests.some((r) => r.table === "job_material_lines"));
});

Deno.test("list: an empty Dispatch answer still says dispatch_materials ok", async () => {
  const db = listDb();
  const result: any = await _pipelineForTest(
    db.client,
    new URLSearchParams("dispatch=1&search=no-such-job"),
  );
  assertEquals(result.total, 0);
  assertEquals(result.dispatch_materials, "ok");
});

// ── Who may call ────────────────────────────────────────────────────────────

Deno.test("gate: the seven actions are staff only: a trade or division manager is refused, and no allow-list names them", () => {
  assertEquals(DISPATCH_MATERIALS_ACTIONS.length, 7);
  for (const action of DISPATCH_MATERIALS_ACTIONS) {
    const url = new URL(
      `https://example.test/functions/v1/ops-api?action=${action}`,
    );
    for (const role of ["admin", "owner", "ops_manager"]) {
      assertEquals(
        _authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role } }),
        { ok: true },
      );
    }
    for (
      const authUser of [
        { role: "installer" },
        { role: "lead_installer", managedVerticals: ["fencing", "patio"] },
      ]
    ) {
      const refusedCall = _authorizeOpsApiAction({
        url,
        authMode: "jwt",
        authUser,
      }) as any;
      assertEquals(refusedCall.ok, false);
      assertEquals(refusedCall.status, 403);
      assertEquals(refusedCall.code, "operator_access_required");
    }
    const anonymous = _authorizeOpsApiAction({ url, authMode: "none" }) as any;
    assertEquals(anonymous.status, 401);
    assert(!AGENT_READ_ALLOWED_ACTIONS.has(action));
    assert(!LEAD_INSTALLER_READ_ACTIONS.has(action));
  }
});

// The routine key is refused by the real request handler's default-deny
// before any database call. (The read-only agent credential's allow-list is
// checked above; its key is classified as the server key today.)
const ENV: Record<string, string> = {
  ...IMPORT_ENV,
  MAKESAFE_ROUTINE_KEY: ROUTINE_KEY,
};

async function withEnvAndFetchSpy<T>(
  fn: (calls: string[]) => Promise<T>,
): Promise<T> {
  const saved = new Map(
    Object.keys(ENV).map((name) => [name, Deno.env.get(name)]),
  );
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

Deno.test("gate: the routine key is refused on all seven, before any call", async () => {
  await withEnvAndFetchSpy(async (calls) => {
    for (const action of DISPATCH_MATERIALS_ACTIONS) {
      for (const key of [ROUTINE_KEY]) {
        const res = await _opsApiRequestHandlerForTest(
          new Request(
            `https://example.invalid/ops-api?action=${action}&job_id=${JOB.patio}`,
            {
              method: action === "dispatch_materials" ? "GET" : "POST",
              headers: { "content-type": "application/json", "x-api-key": key },
              body: action === "dispatch_materials"
                ? undefined
                : JSON.stringify({ job_id: JOB.patio }),
            },
          ),
        );
        assertEquals(res.status, 403, `${action} with ${key}`);
        await res.body?.cancel();
      }
    }
    assertEquals(calls, []);
  });
});

Deno.test("gate: the privileged key reaches the actions; a write by GET is 405 and a bad id is 400, with no database call", async () => {
  await withEnvAndFetchSpy(async (calls) => {
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${SERVICE_KEY}`,
    };
    const get = await _opsApiRequestHandlerForTest(
      new Request(
        "https://example.invalid/ops-api?action=dispatch_materials_save_line",
        { headers },
      ),
    );
    assertEquals(get.status, 405);
    await get.body?.cancel();
    const bad = await _opsApiRequestHandlerForTest(
      new Request(
        "https://example.invalid/ops-api?action=dispatch_materials&job_id=nope",
        { headers },
      ),
    );
    assertEquals(bad.status, 400);
    assertEquals((await bad.json()).code, "invalid_request");
    assertEquals(calls, []);
  });
});
