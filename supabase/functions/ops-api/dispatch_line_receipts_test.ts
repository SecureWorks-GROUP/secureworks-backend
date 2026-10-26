// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch S5, partial deliveries (docs/dispatch-partial-deliveries-v1.md):
// the rules in dispatch_line_receipts.ts, the two receipt writes in
// dispatch_deliveries_store.ts and the wider dispatch_materials read, against
// an in-memory stand-in for PostgREST that keeps the migration's guards
// (20261020180000_dispatch_line_receipts.sql). Job numbers, suppliers and
// people here are made up.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cleanDispatchReceipt,
  dispatchLineDeliveryView,
  dispatchOnSiteSummary,
  dispatchPerthToday,
  dispatchReceiptWarning,
  dispatchSightingCoversLine,
} from "./dispatch_line_receipts.ts";
import {
  dispatchMaterialCounts,
  dispatchMaterialDisplayStatus,
} from "./dispatch_materials.ts";
import {
  dispatchDeliveryListFields,
  dispatchDeliveryRailLine,
  dispatchSightedOrderIds,
} from "./dispatch_deliveries.ts";
import {
  DISPATCH_DELIVERY_ACTIONS,
  runDispatchDeliveriesAction,
} from "./dispatch_deliveries_store.ts";
import {
  DispatchMaterialsError,
  runDispatchMaterialsAction,
} from "./dispatch_materials_store.ts";

type Row = Record<string, any>;

const ORG = "00000000-0000-0000-0000-000000000001";
const id = (prefix: string, n: number) =>
  `${prefix}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const JOB = { patio: id("a5", 1), makesafe: id("a5", 2) };
const SUP = id("b5", 1);
const PO = { panels: id("c5", 1), outside: id("c5", 2), gone: id("c5", 3) };
const LINE = {
  panels: id("d5", 1),
  rails: id("d5", 2),
  caps: id("d5", 3),
  offOrder: id("d5", 4),
  onGone: id("d5", 5),
};
const R = (n: number) => id("e5", n);
const USER = id("f5", 1);
const NOW = "2026-10-20T03:00:00.000Z"; // 11:00 in Perth
const TODAY = "2026-10-20";

// ── Pure rules ──────────────────────────────────────────────────────────────

const order = (over: Row = {}): Row => ({
  id: PO.panels,
  status: "submitted",
  po_type: "material",
  delivery_sighted_at: null,
  ...over,
});
const lineOn = (lineId: string, quantity: number | null, over: Row = {}) => ({
  id: lineId,
  job_id: JOB.patio,
  status: "to_order",
  purchase_order_id: PO.panels,
  quantity,
  purchase_order_attached_at: null,
  ...over,
});
const receipt = (n: number, lineId: string, quantity: number, over = {}) => ({
  id: R(n),
  line_id: lineId,
  purchase_order_id: PO.panels,
  quantity,
  received_on: "2026-10-19",
  created_at: `2026-10-19T0${n}:00:00Z`,
  created_by_email: "person@example.test",
  voided_at: null,
  ...over,
});

Deno.test("rule: with no receipt the line reads exactly as slice 6 read it", () => {
  const lines = [
    lineOn(LINE.panels, 42),
    lineOn(LINE.rails, 10, { purchase_order_id: PO.outside }),
    { id: LINE.offOrder, status: "in_stock", purchase_order_id: null },
  ];
  const orders = [
    order({ delivery_sighted_at: "2026-10-18T01:00:00Z" }),
    order({ id: PO.outside }),
  ];
  const view = dispatchLineDeliveryView(lines, orders, []);
  const sighted = dispatchSightedOrderIds(orders);
  for (const line of lines) {
    assertEquals(
      dispatchMaterialDisplayStatus(line, view),
      dispatchMaterialDisplayStatus(line, sighted),
    );
  }
  assertEquals(dispatchMaterialCounts(lines, view), {
    total: 3,
    ready: 2,
  });
  const summary = dispatchOnSiteSummary(orders, view);
  assertEquals(summary, {
    on_site: 1,
    all_on_site: false,
    lines_part_delivered: 0,
  });
});

Deno.test("rule: 18 of 42 is part delivered, not ready, and the order is not on site; 24 more completes it", () => {
  const lines = [lineOn(LINE.panels, 42)];
  const orders = [order()];
  const first = dispatchLineDeliveryView(lines, orders, [
    receipt(1, LINE.panels, 18),
  ]);
  assertEquals(
    dispatchMaterialDisplayStatus(lines[0], first),
    "part_delivered",
  );
  assertEquals(first.received.get(LINE.panels), 18);
  assertEquals(dispatchMaterialCounts(lines, first), { total: 1, ready: 0 });
  assertEquals(dispatchOnSiteSummary(orders, first), {
    on_site: 0,
    all_on_site: false,
    lines_part_delivered: 1,
  });
  const second = dispatchLineDeliveryView(lines, orders, [
    receipt(1, LINE.panels, 18),
    receipt(2, LINE.panels, 24),
  ]);
  assertEquals(dispatchMaterialDisplayStatus(lines[0], second), "delivered");
  assertEquals(second.received.get(LINE.panels), 42);
  assertEquals(dispatchOnSiteSummary(orders, second), {
    on_site: 1,
    all_on_site: true,
    lines_part_delivered: 0,
  });
});

Deno.test("rule: a voided receipt counts for nothing but stays listed; a receipt on an earlier order counts for nothing", () => {
  const lines = [lineOn(LINE.panels, 42)];
  const view = dispatchLineDeliveryView(lines, [order()], [
    receipt(1, LINE.panels, 42, { voided_at: "2026-10-19T05:00:00Z" }),
    receipt(2, LINE.panels, 42, { purchase_order_id: PO.outside }),
  ]);
  assertEquals(dispatchMaterialDisplayStatus(lines[0], view), "on_po");
  assertEquals(view.received.get(LINE.panels), 0);
  const listed = view.receipts.get(LINE.panels) as any[];
  assertEquals(listed.length, 1);
  assertEquals(listed[0].voided, true);
});

Deno.test("rule (W1): a sighting covers only lines already on the order; a line added after it needs its own receipts", () => {
  const sightedAt = "2026-10-18T01:00:00Z";
  const lines = [
    lineOn(LINE.panels, 42, {
      purchase_order_attached_at: "2026-10-17T01:00:00Z",
    }),
    // Put on the order before S5 shipped: no stamp, covered as in slice 6.
    lineOn(LINE.rails, 10),
    lineOn(LINE.caps, 6, {
      purchase_order_attached_at: "2026-10-19T01:00:00Z",
    }),
  ];
  const orders = [order({ delivery_sighted_at: sightedAt })];
  assert(dispatchSightingCoversLine(lines[0], orders[0]));
  assert(dispatchSightingCoversLine(lines[1], orders[0]));
  assert(!dispatchSightingCoversLine(lines[2], orders[0]));
  const view = dispatchLineDeliveryView(lines, orders, []);
  assertEquals(
    lines.map((l) => dispatchMaterialDisplayStatus(l, view)),
    ["delivered", "delivered", "on_po"],
  );
  assertEquals(dispatchOnSiteSummary(orders, view).on_site, 0);
  const received = dispatchLineDeliveryView(lines, orders, [
    receipt(1, LINE.caps, 2, { created_at: "2026-10-19T02:00:00Z" }),
  ]);
  assertEquals(
    dispatchMaterialDisplayStatus(lines[2], received),
    "part_delivered",
  );
  const done = dispatchLineDeliveryView(lines, orders, [
    receipt(1, LINE.caps, 6, { created_at: "2026-10-19T02:00:00Z" }),
  ]);
  assertEquals(dispatchMaterialDisplayStatus(lines[2], done), "delivered");
  assertEquals(dispatchOnSiteSummary(orders, done).on_site, 1);
});

Deno.test("rule: a line with no quantity is delivered by one live receipt; over-supply is delivered with a warning", () => {
  const lines = [lineOn(LINE.panels, null), lineOn(LINE.rails, 0)];
  const none = dispatchLineDeliveryView(lines, [order()], []);
  assertEquals(dispatchMaterialDisplayStatus(lines[0], none), "on_po");
  const view = dispatchLineDeliveryView(lines, [order()], [
    receipt(1, LINE.panels, 1),
    receipt(2, LINE.rails, 1),
  ]);
  assertEquals(dispatchMaterialDisplayStatus(lines[0], view), "delivered");
  assertEquals(dispatchMaterialDisplayStatus(lines[1], view), "delivered");
  assertEquals(dispatchReceiptWarning(lineOn(LINE.caps, 42), 40, 5), {
    code: "over_quantity",
    ordered: 42,
    received: 45,
  });
  assertEquals(dispatchReceiptWarning(lineOn(LINE.caps, 42), 40, 2), null);
  assertEquals(dispatchReceiptWarning(lineOn(LINE.caps, null), 0, 1), null);
  // Thousandths add up exactly.
  const fine = dispatchLineDeliveryView([lineOn(LINE.caps, 0.3)], [order()], [
    receipt(1, LINE.caps, 0.1),
    receipt(2, LINE.caps, 0.2),
  ]);
  assert(fine.delivered.has(LINE.caps));
});

Deno.test("rule: an order with no line on it is on site only when sighted; cancelled and labour orders never count", () => {
  const orders = [
    order({ id: PO.outside, delivery_sighted_at: "2026-10-18T01:00:00Z" }),
    order({ id: PO.gone, status: "cancelled" }),
    order({ id: PO.panels, po_type: "labour" }),
  ];
  const view = dispatchLineDeliveryView([], orders, []);
  assertEquals(dispatchOnSiteSummary(orders, view), {
    on_site: 1,
    all_on_site: true,
    lines_part_delivered: 0,
  });
});

Deno.test("rule: the rail line reads as slice 6 with no part delivery, and names the part lines otherwise", () => {
  assertEquals(
    dispatchDeliveryRailLine(2, 1, 4),
    "1 of 2 orders sighted on site.",
  );
  assertEquals(
    dispatchDeliveryRailLine(2, 1, 4, 0),
    "1 of 2 orders sighted on site.",
  );
  assertEquals(
    dispatchDeliveryRailLine(2, 0, 4, 1),
    "0 of 2 orders on site; 1 line part delivered.",
  );
  assertEquals(
    dispatchDeliveryRailLine(1, 0, 4, 3),
    "0 of 1 order on site; 3 lines part delivered.",
  );
  assertEquals(
    dispatchDeliveryRailLine(1, 1, 6, 0),
    "Every order on this job is sighted on site.",
  );
  assertEquals(dispatchDeliveryRailLine(0, 0, 4, 2), null);
  // On site by what arrived, not by a sighting: "on site", never "sighted".
  assertEquals(
    dispatchDeliveryRailLine(2, 1, 4, 0, 0),
    "1 of 2 orders on site.",
  );
  assertEquals(
    dispatchDeliveryRailLine(1, 1, 3, 0, 0),
    "Every order on this job is on site. Press Materials on site to move the job.",
  );
  assertEquals(
    dispatchDeliveryRailLine(1, 1, 5, 0, 0),
    "Every order on this job is on site.",
  );
  // A sighted order whose added line has not arrived (W1): on site 0 of 1.
  assertEquals(
    dispatchDeliveryRailLine(1, 0, 4, 0, 1),
    "0 of 1 order on site.",
  );
  // Equal counts are slice 6's line, byte for byte.
  assertEquals(
    dispatchDeliveryRailLine(2, 1, 4, 0, 1),
    "1 of 2 orders sighted on site.",
  );
});

Deno.test("rule: the list adds the two S5 fields only when the receipts were read", () => {
  const orders = [order()];
  assertEquals(dispatchDeliveryListFields(orders), {
    deliveries_orders_total: 1,
    deliveries_orders_sighted: 0,
  });
  assertEquals(
    dispatchDeliveryListFields(orders, { on_site: 0, lines_part_delivered: 1 }),
    {
      deliveries_orders_total: 1,
      deliveries_orders_sighted: 0,
      deliveries_orders_on_site: 0,
      deliveries_lines_part_delivered: 1,
    },
  );
});

Deno.test("rule: what a caller sends is checked; today is Perth's", () => {
  const good = {
    client_receipt_id: R(1),
    line_id: LINE.panels,
    quantity: 18,
    received_on: TODAY,
    note: "  first part  ",
  };
  const ok = cleanDispatchReceipt(good, NOW);
  assert(ok.ok);
  assertEquals(ok.ok && ok.value.note, "first part");
  for (
    const [patch, error] of [
      [{ client_receipt_id: "x" }, "client_receipt_id must be a uuid"],
      [{ line_id: null }, "line_id must be a uuid"],
      [{ quantity: 0 }, "quantity must be a number above 0"],
      [{ quantity: -1 }, "quantity must be a number above 0"],
      [{ quantity: "18" }, "quantity must be a number above 0"],
      [{ quantity: 0.0001 }, "quantity must be a number above 0"],
      [{ quantity: 1e12 }, "quantity is too large"],
      [
        { received_on: "2026-02-30" },
        "received_on must be a real date YYYY-MM-DD",
      ],
      [{ received_on: "2026-10-21" }, "received_on cannot be after today"],
      [{ note: "x".repeat(301) }, "note must be at most 300 characters"],
      [{ note: 4 }, "note must be text"],
    ] as const
  ) {
    const result = cleanDispatchReceipt({ ...good, ...patch }, NOW);
    assertEquals(result, { ok: false, error }, JSON.stringify(patch));
  }
  // 23:30 UTC on the 20th is the 21st in Perth.
  assertEquals(dispatchPerthToday("2026-10-20T23:30:00Z"), "2026-10-21");
  assert(
    cleanDispatchReceipt(
      { ...good, received_on: "2026-10-21" },
      "2026-10-20T23:30:00Z",
    ).ok,
  );
});

// ── An in-memory PostgREST stand-in with the migration's guards ─────────────

type Recorded = {
  table: string;
  kind: "select" | "insert" | "update" | "delete";
  select: string;
};

function project(row: Row, select: string): Row {
  if (!select || select === "*") return { ...row };
  const out: Row = {};
  for (const raw of select.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const colon = item.indexOf(":");
    const alias = colon >= 0 ? item.slice(0, colon) : item;
    const expression = colon >= 0 ? item.slice(colon + 1) : item;
    const path = /^(\w+)->>(\w+)$/.exec(expression);
    out[alias] = path
      ? (row[path[1]]?.[path[2]] ?? null)
      : (row[expression] ?? null);
  }
  return out;
}

function makeDb(initial: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(initial)) {
    tables[name] = rows.map((row) => structuredClone(row));
  }
  const requests: Recorded[] = [];
  const failures = new Set<string>();
  const fail = (code: string, message: string) => ({
    data: null,
    error: { code, message },
  });

  function guardReceiptInsert(row: Row) {
    if (tables.job_material_line_receipts.some((r) => r.id === row.id)) {
      return fail("23505", "job_material_line_receipts_pkey");
    }
    if (!(Number(row.quantity) > 0)) return fail("23514", "quantity");
    if (!row.created_by_email) return fail("23514", "created_by_email");
    const line = tables.job_material_lines.find((l) => l.id === row.line_id);
    if (!line) return fail("23503", "line");
    if (
      line.job_id !== row.job_id ||
      line.purchase_order_id !== row.purchase_order_id
    ) {
      return fail("23514", "dispatch line receipt: order");
    }
    if (row.received_on > TODAY) return fail("23514", "future");
    return null;
  }

  function from(table: string) {
    const request: Recorded = { table, kind: "select", select: "" };
    requests.push(request);
    const filters: Array<(row: Row) => boolean> = [];
    const order: Array<[string, boolean]> = [];
    let range: [number, number] | null = null;
    let single: "single" | "maybe" | null = null;
    let returning: string | null = null;
    let payload: any = null;

    const run = (): any => {
      if (failures.has(`${request.kind}:${table}`)) {
        return fail("XX000", `forced failure on ${request.kind} ${table}`);
      }
      const rows = tables[table] ||= [];
      const matched = rows.filter((row) => filters.every((f) => f(row)));
      let out: Row[];
      if (request.kind === "select") {
        out = matched.sort((a, b) => {
          for (const [column, asc] of order) {
            if (a[column] === b[column]) continue;
            return (a[column] < b[column] ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
        if (range) out = out.slice(range[0], range[1] + 1);
        out = out.map((row) => project(row, request.select));
      } else if (request.kind === "insert") {
        const incoming = (Array.isArray(payload) ? payload : [payload]).map((
          r: Row,
        ) => ({ ...r }));
        for (const row of incoming) {
          if (table === "job_material_line_receipts") {
            row.note ??= null;
            row.voided_at ??= null;
            row.voided_by ??= null;
            row.voided_by_email ??= null;
            const refused = guardReceiptInsert(row);
            if (refused) return refused;
          }
        }
        rows.push(...incoming);
        out = incoming.map((row) => project(row, returning || "*"));
      } else if (request.kind === "update") {
        if (table === "job_material_line_receipts") {
          for (const row of matched) {
            if (row.voided_at) return fail("23514", "voided receipt");
            const keys = Object.keys(payload).sort().join(",");
            if (keys !== "voided_at,voided_by,voided_by_email") {
              return fail("23514", "only the void");
            }
          }
        }
        for (const row of matched) Object.assign(row, payload);
        out = matched.map((row) => project(row, returning || "*"));
      } else {
        if (table === "job_material_line_receipts") {
          return fail("23514", "never deleted");
        }
        if (
          table === "job_material_lines" &&
          matched.some((l) =>
            tables.job_material_line_receipts.some((r) => r.line_id === l.id)
          )
        ) {
          return fail("23503", "job_material_line_receipts_line_id_fkey");
        }
        tables[table] = rows.filter((row) => !matched.includes(row));
        out = matched.map((row) => project(row, returning || "id"));
      }
      if (single === "single") {
        return out.length === 1
          ? { data: out[0], error: null }
          : fail("PGRST116", "not one row");
      }
      if (single === "maybe") return { data: out[0] ?? null, error: null };
      if (request.kind !== "select" && returning === null) {
        return { data: null, error: null };
      }
      return { data: out, error: null };
    };

    const builder: any = {
      select(columns = "*") {
        if (request.kind === "select") request.select = columns;
        else returning = columns;
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
        filters.push((row) =>
          row[column] !== null && row[column] !== undefined &&
          String(row[column]) === String(value)
        );
        return builder;
      },
      neq(column: string, value: unknown) {
        filters.push((row) =>
          row[column] !== null && row[column] !== undefined &&
          String(row[column]) !== String(value)
        );
        return builder;
      },
      in(column: string, values: unknown[]) {
        filters.push((row) => values.map(String).includes(String(row[column])));
        return builder;
      },
      is(column: string, value: unknown) {
        filters.push((row) => (row[column] ?? null) === value);
        return builder;
      },
      order(column: string, opts: { ascending?: boolean } = {}) {
        order.push([column, opts.ascending !== false]);
        return builder;
      },
      range(a: number, b: number) {
        range = [a, b];
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle() {
        single = "maybe";
        return builder;
      },
      single() {
        single = "single";
        return builder;
      },
      then(resolve: any, reject: any) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    client: { from },
    tables,
    requests,
    failures,
    writes: () => requests.filter((r) => r.kind !== "select"),
  };
}

function seed(): Record<string, Row[]> {
  const line = (lineId: string, over: Row) => ({
    id: lineId,
    org_id: ORG,
    job_id: JOB.patio,
    supplier_id: SUP,
    description: "Panel",
    quantity: 42,
    unit: null,
    status: "to_order",
    purchase_order_id: PO.panels,
    source: "manual",
    position: 1,
    created_at: "2026-10-15T01:00:00Z",
    updated_at: "2026-10-15T01:00:00Z",
    purchase_order_attached_at: "2026-10-15T01:00:00Z",
    ...over,
  });
  const po = (poId: string, over: Row) => ({
    id: poId,
    org_id: ORG,
    job_id: JOB.patio,
    po_number: "PO-9000001",
    supplier_name: "Example Panels",
    status: "submitted",
    po_type: "material",
    source: null,
    supplier_id: null,
    line_items: [],
    xero_po_id: null,
    delivery_date: null,
    confirmed_delivery_date: null,
    confirmed_delivery_set_at: null,
    delivery_sighted_at: null,
    delivery_sighted_by: null,
    delivery_sighted_by_email: null,
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
    ...over,
  });
  return {
    jobs: [
      {
        id: JOB.patio,
        org_id: ORG,
        job_number: "SWP-990001",
        type: "patio",
        metadata: null,
      },
      {
        id: JOB.makesafe,
        org_id: ORG,
        job_number: "SWMS-990002",
        type: "makesafe",
        metadata: null,
      },
    ],
    users: [{
      id: USER,
      org_id: ORG,
      name: "Example Person",
      email: "person@example.test",
    }],
    suppliers: [{
      id: SUP,
      org_id: ORG,
      name: "Example Panels",
      email: "orders@example.test",
      is_active: true,
    }],
    job_material_suppliers: [{
      id: id("aa", 1),
      org_id: ORG,
      job_id: JOB.patio,
      supplier_id: SUP,
      supplier_name: "Example Panels",
      position: 1,
      created_at: "2026-10-15T00:00:00Z",
    }],
    job_dispatch_workings: [],
    purchase_orders: [
      po(PO.panels, {}),
      po(PO.gone, { po_number: "PO-9000002", status: "cancelled" }),
    ],
    job_material_lines: [
      line(LINE.panels, { description: "Panel 2.4m", quantity: 42 }),
      line(LINE.rails, { description: "Rail", quantity: null, position: 2 }),
      line(LINE.offOrder, {
        description: "Screws",
        purchase_order_id: null,
        purchase_order_attached_at: null,
        status: "in_stock",
        position: 3,
      }),
      line(LINE.onGone, {
        description: "Old line",
        purchase_order_id: PO.gone,
        position: 4,
      }),
    ],
    job_material_line_receipts: [],
    job_events: [],
  };
}

const screen = {
  orgId: ORG,
  actor: { userId: USER, email: "person@example.test", orgId: ORG },
  via: "screen" as const,
  now: () => NOW,
};

function record(db: ReturnType<typeof makeDb>, body: Row, ctx: any = screen) {
  return runDispatchDeliveriesAction(
    db.client,
    "dispatch_delivery_record_receipt",
    {
      job_id: JOB.patio,
      line_id: LINE.panels,
      received_on: TODAY,
      ...body,
    },
    ctx,
  ) as Promise<any>;
}

function voidIt(
  db: ReturnType<typeof makeDb>,
  receiptId: string,
  ctx: any = screen,
) {
  return runDispatchDeliveriesAction(
    db.client,
    "dispatch_delivery_void_receipt",
    { job_id: JOB.patio, receipt_id: receiptId },
    ctx,
  ) as Promise<any>;
}

async function refused(
  promise: Promise<unknown>,
  status: number,
  code: string,
) {
  const error = await assertRejects(() => promise, DispatchMaterialsError);
  assertEquals(
    [(error as any).status, (error as any).body.code],
    [status, code],
  );
}

function rowCounts(db: ReturnType<typeof makeDb>) {
  return Object.fromEntries(
    Object.entries(db.tables).map(([name, rows]) => [name, rows.length]),
  );
}

function snapshot(db: ReturnType<typeof makeDb>, table: string) {
  return JSON.stringify(db.tables[table]);
}

// ── The writes ──────────────────────────────────────────────────────────────

Deno.test("record: one receipt row and nothing else; the line reads 18 of 42 part delivered; the order is not on site", async () => {
  const db = makeDb(seed());
  const before = rowCounts(db);
  const lines = snapshot(db, "job_material_lines");
  const orders = snapshot(db, "purchase_orders");
  const answer = await record(db, {
    client_receipt_id: R(1),
    quantity: 18,
    note: "First part",
  });
  assertEquals(answer.success, true);
  assertEquals(answer.receipt.quantity, 18);
  assertEquals(answer.receipt.recorded_by, "Example Person");
  assertEquals(answer.line.display_status, "part_delivered");
  assertEquals(answer.line.received_quantity, 18);
  assertEquals(answer.deliveries, {
    counted: 1,
    sighted: 0,
    all_sighted: false,
    on_site: 0,
    all_on_site: false,
    lines_part_delivered: 1,
  });
  // Screws are in stock; the panels are not ready yet.
  assertEquals(answer.counts, { total: 4, ready: 1 });
  assert(!("warning" in answer));
  // Exactly the one receipt row, and no other write of any kind.
  const after = rowCounts(db);
  assertEquals(after.job_material_line_receipts, 1);
  assertEquals(
    { ...after, job_material_line_receipts: 0 },
    { ...before, job_material_line_receipts: 0 },
  );
  assertEquals(
    db.writes().map((w) => `${w.kind}:${w.table}`),
    ["insert:job_material_line_receipts"],
  );
  assertEquals(snapshot(db, "job_material_lines"), lines);
  assertEquals(snapshot(db, "purchase_orders"), orders);
  const stored = db.tables.job_material_line_receipts[0];
  assertEquals(stored.purchase_order_id, PO.panels);
  assertEquals(stored.created_by, USER);
  assertEquals(stored.created_by_email, "person@example.test");
  assertEquals(stored.received_on, TODAY);
});

Deno.test("record: a retried press with the same client_receipt_id makes one row", async () => {
  const db = makeDb(seed());
  await record(db, { client_receipt_id: R(1), quantity: 18 });
  const again = await record(db, { client_receipt_id: R(1), quantity: 18 });
  assertEquals(again.unchanged, true);
  assertEquals(db.tables.job_material_line_receipts.length, 1);
  await refused(
    record(db, {
      client_receipt_id: R(1),
      line_id: LINE.rails,
      quantity: 1,
    }),
    409,
    "receipt_id_in_use",
  );
});

Deno.test("record: the second part completes the line and the order is on site; the read agrees", async () => {
  const db = makeDb(seed());
  // The order's other line (no quantity) arrives in full.
  await record(db, {
    client_receipt_id: R(1),
    line_id: LINE.rails,
    quantity: 1,
  });
  await record(db, {
    client_receipt_id: R(2),
    quantity: 18,
    received_on: "2026-10-16",
  });
  const mid: any = await runDispatchMaterialsAction(
    db.client,
    "dispatch_materials",
    new URLSearchParams(`job_id=${JOB.patio}`) as any,
    {},
    { ...screen, extractMaterialsFromScope: () => [] } as any,
  );
  const panelsMid = mid.lines.find((l: any) => l.id === LINE.panels);
  assertEquals(panelsMid.display_status, "part_delivered");
  const row = mid.deliveries.rows.find((r: any) =>
    r.purchase_order_id === PO.panels
  );
  assertEquals([row.on_site, row.lines_part_delivered], [false, 1]);
  assertEquals(mid.deliveries.lines_part_delivered, 1);
  assertEquals(
    dispatchDeliveryRailLine(
      mid.deliveries.counted,
      mid.deliveries.on_site,
      4,
      mid.deliveries.lines_part_delivered,
    ),
    "0 of 1 order on site; 1 line part delivered.",
  );

  const done = await record(db, { client_receipt_id: R(3), quantity: 24 });
  assertEquals(done.line.display_status, "delivered");
  assertEquals(done.line.received_quantity, 42);
  assertEquals(done.deliveries.on_site, 1);
  assertEquals(done.deliveries.all_on_site, true);
  assertEquals(
    done.deliveries.sighted,
    0,
    "a receipt never marks the order sighted",
  );
  const read: any = await runDispatchMaterialsAction(
    db.client,
    "dispatch_materials",
    new URLSearchParams(`job_id=${JOB.patio}`) as any,
    {},
    { ...screen, extractMaterialsFromScope: () => [] } as any,
  );
  const panels = read.lines.find((l: any) => l.id === LINE.panels);
  assertEquals(panels.display_status, "delivered");
  assertEquals(panels.received_quantity, 42);
  assertEquals(panels.receipts.map((r: any) => r.quantity), [18, 24]);
  assertEquals(panels.receipts[0].received_on, "2026-10-16");
  // A line on no order is exactly as slice 4 projected it.
  const screws = read.lines.find((l: any) => l.id === LINE.offOrder);
  assert(!("received_quantity" in screws) && !("receipts" in screws));
  assertEquals(read.deliveries.on_site, 1);
  assertEquals(read.counts, done.counts);
  assertEquals(
    dispatchDeliveryRailLine(
      read.deliveries.counted,
      read.deliveries.on_site,
      4,
      read.deliveries.lines_part_delivered,
    ),
    "Every order on this job is sighted on site. Press Materials on site to move the job.",
  );
});

Deno.test("record: over the line's quantity is allowed with a warning", async () => {
  const db = makeDb(seed());
  await record(db, { client_receipt_id: R(1), quantity: 40 });
  const over = await record(db, { client_receipt_id: R(2), quantity: 5 });
  assertEquals(over.warning, {
    code: "over_quantity",
    ordered: 42,
    received: 45,
  });
  assertEquals(over.line.display_status, "delivered");
});

Deno.test("record: refusals: no order, cancelled order, make-safe, bad quantity, future date, a second full receipt", async () => {
  const db = makeDb(seed());
  await refused(
    record(db, {
      client_receipt_id: R(1),
      line_id: LINE.offOrder,
      quantity: 1,
    }),
    409,
    "line_not_on_order",
  );
  await refused(
    record(db, { client_receipt_id: R(1), line_id: LINE.onGone, quantity: 1 }),
    409,
    "order_cancelled",
  );
  await refused(
    record(db, { client_receipt_id: R(1), job_id: JOB.makesafe, quantity: 1 }),
    409,
    "not_dispatch_work",
  );
  await refused(
    record(db, { client_receipt_id: R(1), line_id: id("d5", 99), quantity: 1 }),
    404,
    "line_not_found",
  );
  for (const quantity of [0, -3]) {
    await refused(
      record(db, { client_receipt_id: R(1), quantity }),
      400,
      "invalid_request",
    );
  }
  await refused(
    record(db, {
      client_receipt_id: R(1),
      quantity: 1,
      received_on: "2026-10-21",
    }),
    400,
    "invalid_request",
  );
  // No quantity: received once, in full, with quantity 1.
  await refused(
    record(db, { client_receipt_id: R(1), line_id: LINE.rails, quantity: 3 }),
    400,
    "invalid_request",
  );
  await record(db, {
    client_receipt_id: R(1),
    line_id: LINE.rails,
    quantity: 1,
  });
  await refused(
    record(db, { client_receipt_id: R(2), line_id: LINE.rails, quantity: 1 }),
    409,
    "line_already_received",
  );
  assertEquals(db.tables.job_material_line_receipts.length, 1);
});

Deno.test("record: the ops key must name a person in users", async () => {
  const db = makeDb(seed());
  const terminal = {
    orgId: ORG,
    actor: { userId: null, email: null, orgId: null },
    via: "terminal" as const,
    now: () => NOW,
  };
  await refused(
    record(db, { client_receipt_id: R(1), quantity: 2 }, terminal),
    400,
    "operator_required",
  );
  const answer = await record(
    db,
    {
      client_receipt_id: R(1),
      quantity: 2,
      operator_email: "Person@Example.test",
    },
    terminal,
  );
  assertEquals(answer.success, true);
  const stored = db.tables.job_material_line_receipts[0];
  assertEquals([stored.created_by, stored.created_by_email], [
    null,
    "person@example.test",
  ]);
});

Deno.test("void: sets only the void, keeps the row, and a second void is a no-op", async () => {
  const db = makeDb(seed());
  await record(db, { client_receipt_id: R(1), quantity: 18 });
  const before = { ...db.tables.job_material_line_receipts[0] };
  const voided = await voidIt(db, R(1));
  assertEquals(voided.receipt.voided, true);
  assertEquals(voided.receipt.voided_by, "Example Person");
  assertEquals(voided.line.display_status, "on_po");
  assertEquals(voided.line.received_quantity, 0);
  assertEquals(voided.deliveries.lines_part_delivered, 0);
  const after = db.tables.job_material_line_receipts[0];
  assertEquals(db.tables.job_material_line_receipts.length, 1);
  assertEquals(
    { ...after, voided_at: null, voided_by: null, voided_by_email: null },
    before,
  );
  assertEquals(after.voided_by_email, "person@example.test");
  const writes = db.writes().length;
  const again = await voidIt(db, R(1));
  assertEquals(again.unchanged, true);
  assertEquals(db.writes().length, writes);
  await refused(voidIt(db, R(9)), 404, "receipt_not_found");
});

Deno.test("sighting: Mark sighted writes no receipt; it covers lines already on the order, not one put on later (W1)", async () => {
  const db = makeDb(seed());
  const order = db.tables.purchase_orders.find((o) => o.id === PO.panels)!;
  const sighted = await runDispatchDeliveriesAction(
    db.client,
    "dispatch_delivery_mark_sighted",
    {
      purchase_order_id: PO.panels,
      expected_updated_at: order.updated_at,
      sighted: true,
    },
    { ...screen, now: () => "2026-10-18T01:00:00.000Z" },
  ) as any;
  assertEquals(db.tables.job_material_line_receipts.length, 0);
  assertEquals(sighted.deliveries.on_site, 1);
  assertEquals(sighted.counts, { total: 4, ready: 3 });
  // A line goes on the sighted order afterwards (the database stamps it).
  db.tables.job_material_lines.push({
    ...db.tables.job_material_lines[0],
    id: LINE.caps,
    description: "Cap",
    quantity: 6,
    position: 5,
    purchase_order_attached_at: "2026-10-19T01:00:00Z",
  });
  const read: any = await runDispatchMaterialsAction(
    db.client,
    "dispatch_materials",
    new URLSearchParams(`job_id=${JOB.patio}`) as any,
    {},
    { ...screen, extractMaterialsFromScope: () => [] } as any,
  );
  const caps = read.lines.find((l: any) => l.id === LINE.caps);
  assertEquals(caps.display_status, "on_po");
  assertEquals(
    read.lines.find((l: any) => l.id === LINE.panels).display_status,
    "delivered",
  );
  assertEquals([read.deliveries.sighted, read.deliveries.on_site], [1, 0]);
  const got = await record(db, {
    client_receipt_id: R(1),
    line_id: LINE.caps,
    quantity: 6,
  });
  assertEquals(got.line.display_status, "delivered");
  assertEquals(got.deliveries.on_site, 1);
});

Deno.test("read: a failed receipts read is a failed orders read, never nothing received", async () => {
  const db = makeDb(seed());
  db.failures.add("select:job_material_line_receipts");
  const read: any = await runDispatchMaterialsAction(
    db.client,
    "dispatch_materials",
    new URLSearchParams(`job_id=${JOB.patio}`) as any,
    {},
    { ...screen, extractMaterialsFromScope: () => [] } as any,
  );
  assertEquals(read.orders_status, "failed");
  assert(!("deliveries" in read));
});

Deno.test("delete line: a line with a receipt cannot be deleted", async () => {
  const db = makeDb(seed());
  await record(db, { client_receipt_id: R(1), quantity: 2 });
  const line = db.tables.job_material_lines.find((l) => l.id === LINE.panels)!;
  // Taken off its order (as an order update does), it keeps its receipt.
  line.purchase_order_id = null;
  await refused(
    runDispatchMaterialsAction(
      db.client,
      "dispatch_materials_delete_line",
      new URLSearchParams() as any,
      {
        job_id: JOB.patio,
        id: LINE.panels,
        expected_updated_at: line.updated_at,
      },
      { ...screen, extractMaterialsFromScope: () => [] } as any,
    ),
    409,
    "line_has_receipts",
  );
});

Deno.test("actions: the two S5 actions are delivery actions", () => {
  assert(
    DISPATCH_DELIVERY_ACTIONS.includes("dispatch_delivery_record_receipt"),
  );
  assert(DISPATCH_DELIVERY_ACTIONS.includes("dispatch_delivery_void_receipt"));
});
