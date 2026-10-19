// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch slice 6 (docs/dispatch-slice-6-contract.md): the Deliveries rules
// and the three dispatch_delivery_* writes. Shipped with migration contracts
// only; these pin the rules module and the write boundary. Fixtures carry
// made-up order numbers and no client data.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchConfirmedState,
  dispatchDelivery,
  dispatchDeliveryListFields,
  dispatchDeliveryRailLine,
  dispatchDeliveryRows,
  dispatchDeliverySummary,
  isDispatchDeliveryDate,
} from "./dispatch_deliveries.ts";
import { runDispatchDeliveriesAction } from "./dispatch_deliveries_store.ts";
import { DispatchMaterialsError } from "./dispatch_materials_store.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const JOB = "00000000-0000-4000-8000-000000000002";
const PO = "00000000-0000-4000-8000-000000000003";
const USER = "00000000-0000-4000-8000-000000000004";
const T0 = "2026-10-19T01:00:00.000Z";
const NOW = "2026-10-19T02:00:00.000Z";

// ---------------------------------------------------------------- rules

Deno.test("rules: confirmed state reads a date, then status, then sighting", () => {
  assertEquals(
    dispatchConfirmedState({ confirmed_delivery_date: "2026-10-20" }),
    "date",
  );
  assertEquals(dispatchConfirmedState({ status: "Confirmed" }), "status_only");
  assertEquals(dispatchConfirmedState({ status: "billed" }), "status_only");
  assertEquals(dispatchConfirmedState({ status: "sent" }), "waiting");
  assertEquals(
    dispatchConfirmedState({ status: "sent", delivery_sighted_at: T0 }),
    "not_confirmed",
  );
});

Deno.test("rules: step and editability of one order", () => {
  assertEquals(dispatchDelivery({ status: "sent" }).step, 1);
  assertEquals(dispatchDelivery({ status: "confirmed" }).step, 2);
  assertEquals(
    dispatchDelivery({ confirmed_delivery_date: "2026-10-20" }).step,
    2,
  );
  assertEquals(dispatchDelivery({ delivery_sighted_at: T0 }).step, 3);
  assertEquals(dispatchDelivery({ xero_po_id: "x" }).expected_editable, false);
  assertEquals(dispatchDelivery({}).expected_editable, true);
  const reader = dispatchDelivery({ confirmed_delivery_date: "2026-10-20" });
  assertEquals(reader.confirmed.by_hand, false);
  assertEquals(reader.confirmed.set_by, null);
});

Deno.test("rules: names come from users, else the stored email", () => {
  const order = {
    confirmed_delivery_date: "2026-10-20",
    confirmed_delivery_set_at: T0,
    confirmed_delivery_set_by: USER,
    confirmed_delivery_set_by_email: "a@example.test",
    delivery_sighted_at: T0,
    delivery_sighted_by: null,
    delivery_sighted_by_email: "b@example.test",
  };
  const d = dispatchDelivery(order, new Map([[USER, "Person A"]]));
  assertEquals(d.confirmed.set_by, "Person A");
  assertEquals(d.sighted?.by, "b@example.test");
});

Deno.test("rules: counted excludes gone and non-material orders", () => {
  const orders = [
    { id: "1", status: "sent", delivery_sighted_at: T0 },
    { id: "2", status: "draft", po_type: "material" },
    { id: "3", status: "cancelled", delivery_sighted_at: T0 },
    { id: "4", status: "deleted" },
    { id: "5", status: "sent", po_type: "labour" },
  ];
  assertEquals(dispatchDeliverySummary(orders), {
    counted: 2,
    sighted: 1,
    all_sighted: false,
  });
  assertEquals(dispatchDeliveryListFields(orders), {
    deliveries_orders_total: 2,
    deliveries_orders_sighted: 1,
  });
  assertEquals(dispatchDeliverySummary([]).all_sighted, false);
});

Deno.test("rules: rows per chosen supplier, then outside orders, oldest first", () => {
  const rows = dispatchDeliveryRows(
    [{ supplier_id: "s1", name: "Supplier One" }, {
      supplier_id: "s2",
      name: "Supplier Two",
    }],
    [
      {
        id: "b",
        source: "dispatch",
        supplier_id: "s1",
        created_at: "2026-10-02",
      },
      {
        id: "a",
        source: "dispatch",
        supplier_id: "s1",
        created_at: "2026-10-01",
      },
      // Same supplier id but not made in Dispatch: never under the supplier.
      { id: "c", source: null, supplier_id: "s2", created_at: "2026-09-01" },
      { id: "d", source: "dispatch", supplier_id: "s1", status: "cancelled" },
    ],
  );
  assertEquals(
    rows.map((r) =>
      r.kind === "order" ? r.purchase_order_id : `none:${r.supplier_id}`
    ),
    ["a", "b", "none:s2", "c"],
  );
});

Deno.test("rules: rail line", () => {
  assertEquals(dispatchDeliveryRailLine(0, 0, 3), null);
  assertEquals(dispatchDeliveryRailLine(null, 0, 3), null);
  assertEquals(
    dispatchDeliveryRailLine(3, 1, 3),
    "1 of 3 orders sighted on site.",
  );
  assertEquals(
    dispatchDeliveryRailLine(2, 2, 3),
    "Every order on this job is sighted on site. Press Materials on site to move the job.",
  );
  assertEquals(
    dispatchDeliveryRailLine(2, 2, 5),
    "Every order on this job is sighted on site.",
  );
});

Deno.test("rules: a delivery date is a real calendar date", () => {
  assert(isDispatchDeliveryDate("2028-02-29"));
  assert(!isDispatchDeliveryDate("2026-02-30"));
  assert(!isDispatchDeliveryDate("2026-2-3"));
  assert(!isDispatchDeliveryDate(null));
});

// ---------------------------------------------------------------- writes

type Row = Record<string, any>;

// A small PostgREST stand-in: eq/neq/in filters, update returns the changed
// rows and moves updated_at (the live trg_po_updated trigger), errors on demand.
function fakeClient(
  tables: Record<string, Row[]>,
  fail: Record<string, string> = {},
) {
  const writes: { table: string; op: string; value: Row }[] = [];
  const from = (table: string) => {
    const rows = (tables[table] ||= []);
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "update" | "insert" = "select";
    let value: Row = {};
    const run = () => {
      if (fail[`${table}.${op}`]) {
        return { data: null, error: { message: fail[`${table}.${op}`] } };
      }
      if (op === "insert") {
        rows.push({ ...value });
        writes.push({ table, op, value });
        return { data: null, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of hit) Object.assign(r, value, { updated_at: NOW });
        if (hit.length) writes.push({ table, op, value });
      }
      return { data: hit.map((r) => ({ ...r })), error: null };
    };
    const b: any = {
      select: () => b,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), b),
      in: (
        k: string,
        vs: unknown[],
      ) => (filters.push((r) => vs.includes(r[k])), b),
      // The shared operator lookup reads users case-blind with escaped
      // wildcards; an exact case-blind compare is enough here.
      ilike: (k: string, v: string) => (
        filters.push((r) =>
          String(r[k] ?? "").toLowerCase() ===
            v.replace(/\\/g, "").toLowerCase()
        ), b
      ),
      update: (v: Row) => ((op = "update"), (value = v), b),
      insert: (v: Row) => ((op = "insert"), (value = v), b),
      maybeSingle: () => {
        const res = run();
        return Promise.resolve({
          data: res.data?.[0] ?? null,
          error: res.error,
        });
      },
      then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad),
    };
    return b;
  };
  return { client: { from }, writes };
}

function world(order: Row = {}, job: Row = {}) {
  return {
    purchase_orders: [{
      id: PO,
      org_id: ORG,
      job_id: JOB,
      po_number: "PO-TEST-1",
      supplier_name: "Supplier One",
      status: "sent",
      po_type: "material",
      updated_at: T0,
      ...order,
    }],
    jobs: [{
      id: JOB,
      org_id: ORG,
      job_number: "SWF-TEST",
      type: "fencing",
      ...job,
    }],
    users: [{
      id: USER,
      email: "person@example.test",
      org_id: ORG,
      name: "Person A",
    }],
  };
}

const screen = {
  orgId: ORG,
  actor: { userId: USER, email: "person@example.test", orgId: ORG },
  via: "screen" as const,
  now: () => NOW,
} as any;
const terminal = {
  orgId: ORG,
  actor: { userId: null, email: null, orgId: null },
  via: "terminal" as const,
  now: () => NOW,
} as any;

async function refused(p: Promise<unknown>, status: number, code: string) {
  const err = await assertRejects(() => p, DispatchMaterialsError);
  assertEquals((err as any).status, status);
  assertEquals((err as any).body.code, code);
}

const PO_COLUMNS_ALLOWED = new Set([
  "delivery_date",
  "confirmed_delivery_date",
  "confirmed_delivery_set_at",
  "confirmed_delivery_set_by",
  "confirmed_delivery_set_by_email",
  "delivery_sighted_at",
  "delivery_sighted_by",
  "delivery_sighted_by_email",
]);

function assertBoundary(writes: { table: string; op: string; value: Row }[]) {
  for (const w of writes) {
    assert(
      (w.table === "purchase_orders" && w.op === "update") ||
        (w.table === "job_events" && w.op === "insert"),
      `unexpected write ${w.op} ${w.table}`,
    );
    if (w.table === "purchase_orders") {
      for (const key of Object.keys(w.value)) {
        assert(PO_COLUMNS_ALLOWED.has(key), `wrote ${key}`);
      }
    }
  }
}

Deno.test("write: set expected writes delivery_date only and one event", async () => {
  const { client, writes } = fakeClient(world());
  const res: any = await runDispatchDeliveriesAction(
    client,
    "dispatch_delivery_set_expected",
    {
      purchase_order_id: PO,
      expected_updated_at: T0,
      delivery_date: "2026-10-22",
    },
    screen,
  );
  assertEquals(res.order.delivery.expected, "2026-10-22");
  assertEquals(writes.map((w) => `${w.op}:${w.table}`), [
    "update:purchase_orders",
    "insert:job_events",
  ]);
  assertEquals(writes[0].value, { delivery_date: "2026-10-22" });
  assertEquals(writes[1].value.event_type, "po_delivery_expected_set");
  assertEquals(
    writes[1].value.detail_json.operator_email,
    "person@example.test",
  );
  assertBoundary(writes);
});

Deno.test("write: expected date on an order in Xero is refused", async () => {
  const { client, writes } = fakeClient(world({ xero_po_id: "xero-1" }));
  await refused(
    runDispatchDeliveriesAction(client, "dispatch_delivery_set_expected", {
      purchase_order_id: PO,
      expected_updated_at: T0,
      delivery_date: "2026-10-22",
    }, screen),
    409,
    "order_in_xero",
  );
  assertEquals(writes, []);
});

Deno.test("write: a stale screen gets 409 order_changed and nothing is written", async () => {
  const { client, writes } = fakeClient(
    world({ updated_at: "2026-10-19T01:30:00.000Z" }),
  );
  await refused(
    runDispatchDeliveriesAction(client, "dispatch_delivery_mark_sighted", {
      purchase_order_id: PO,
      expected_updated_at: T0,
      sighted: true,
    }, screen),
    409,
    "order_changed",
  );
  assertEquals(writes, []);
});

Deno.test("write: confirmed by hand stamps the person; null clears all four", async () => {
  const w = world();
  const { client, writes } = fakeClient(w);
  await runDispatchDeliveriesAction(client, "dispatch_delivery_set_confirmed", {
    purchase_order_id: PO,
    expected_updated_at: T0,
    confirmed_delivery_date: "2026-10-23",
    via: "deliveries",
  }, screen);
  assertEquals(writes[0].value, {
    confirmed_delivery_date: "2026-10-23",
    confirmed_delivery_set_at: NOW,
    confirmed_delivery_set_by: USER,
    confirmed_delivery_set_by_email: "person@example.test",
  });
  await runDispatchDeliveriesAction(client, "dispatch_delivery_set_confirmed", {
    purchase_order_id: PO,
    expected_updated_at: NOW,
    confirmed_delivery_date: null,
    via: "thread",
  }, screen);
  assertEquals(writes[2].value, {
    confirmed_delivery_date: null,
    confirmed_delivery_set_at: null,
    confirmed_delivery_set_by: null,
    confirmed_delivery_set_by_email: null,
  });
  assertEquals(writes[3].value.detail_json.via, "thread");
  assertBoundary(writes);
});

Deno.test("write: a reader's date set again by a person is stamped as theirs", async () => {
  const { client, writes } = fakeClient(
    world({ confirmed_delivery_date: "2026-10-23" }),
  );
  const res: any = await runDispatchDeliveriesAction(
    client,
    "dispatch_delivery_set_confirmed",
    {
      purchase_order_id: PO,
      expected_updated_at: T0,
      confirmed_delivery_date: "2026-10-23",
      via: "deliveries",
    },
    screen,
  );
  assert(!res.unchanged);
  assertEquals(
    writes[0].value.confirmed_delivery_set_by_email,
    "person@example.test",
  );
});

Deno.test("write: sighted on, then off; the same press twice changes nothing", async () => {
  const { client, writes } = fakeClient(world());
  await runDispatchDeliveriesAction(client, "dispatch_delivery_mark_sighted", {
    purchase_order_id: PO,
    expected_updated_at: T0,
    sighted: true,
  }, screen);
  const again: any = await runDispatchDeliveriesAction(
    client,
    "dispatch_delivery_mark_sighted",
    {
      purchase_order_id: PO,
      expected_updated_at: NOW,
      sighted: true,
    },
    screen,
  );
  assertEquals(again.unchanged, true);
  await runDispatchDeliveriesAction(client, "dispatch_delivery_mark_sighted", {
    purchase_order_id: PO,
    expected_updated_at: NOW,
    sighted: false,
  }, screen);
  assertEquals(writes.map((w) => w.value.event_type ?? w.table), [
    "purchase_orders",
    "po_delivery_sighted",
    "purchase_orders",
    "po_delivery_sighted_cleared",
  ]);
  assertEquals(
    writes[3].value.detail_json.was_sighted_by_email,
    "person@example.test",
  );
  assertBoundary(writes);
});

Deno.test("write: the ops key must name a person in users; by-id stays null", async () => {
  const { client, writes } = fakeClient(world());
  await refused(
    runDispatchDeliveriesAction(client, "dispatch_delivery_mark_sighted", {
      purchase_order_id: PO,
      expected_updated_at: T0,
      sighted: true,
    }, terminal),
    400,
    "operator_required",
  );
  await refused(
    runDispatchDeliveriesAction(client, "dispatch_delivery_mark_sighted", {
      purchase_order_id: PO,
      expected_updated_at: T0,
      sighted: true,
      operator_email: "nobody@example.test",
    }, terminal),
    400,
    "operator_required",
  );
  assertEquals(writes, []);
  await runDispatchDeliveriesAction(client, "dispatch_delivery_mark_sighted", {
    purchase_order_id: PO,
    expected_updated_at: T0,
    sighted: true,
    // Typed in another case: matched case-blind, stored as users has it.
    operator_email: " Person@Example.test ",
  }, terminal);
  assertEquals(writes[0].value.delivery_sighted_by, null);
  assertEquals(
    writes[0].value.delivery_sighted_by_email,
    "person@example.test",
  );
});

Deno.test("write: refusals in the contract's order", async () => {
  const cases: [Row, Row, number, string][] = [
    [{ org_id: "other" }, {}, 404, "order_not_found"],
    [{}, { type: "makesafe" }, 409, "not_dispatch_work"],
    [{ status: "cancelled" }, {}, 409, "order_cancelled"],
    [{ po_type: "labour" }, {}, 409, "not_material"],
  ];
  for (const [order, job, status, code] of cases) {
    const { client, writes } = fakeClient(world(order, job));
    await refused(
      runDispatchDeliveriesAction(client, "dispatch_delivery_mark_sighted", {
        purchase_order_id: PO,
        expected_updated_at: T0,
        sighted: true,
      }, screen),
      status,
      code,
    );
    assertEquals(writes, []);
  }
  const { client } = fakeClient(world());
  await refused(
    runDispatchDeliveriesAction(client, "dispatch_delivery_set_expected", {
      purchase_order_id: PO,
      expected_updated_at: T0,
      delivery_date: "2026-02-30",
    }, screen),
    400,
    "invalid_request",
  );
});

Deno.test("write: a failed audit row is reported, the landed write stands", async () => {
  const { client, writes } = fakeClient(world(), {
    "job_events.insert": "boom",
  });
  const res: any = await runDispatchDeliveriesAction(
    client,
    "dispatch_delivery_mark_sighted",
    {
      purchase_order_id: PO,
      expected_updated_at: T0,
      sighted: true,
    },
    screen,
  );
  assertEquals(res.audit_logged, false);
  assertEquals(writes.map((w) => w.table), ["purchase_orders"]);
});

Deno.test("write: a failed order write is a 500, never a quiet success", async () => {
  const { client } = fakeClient(world(), { "purchase_orders.update": "boom" });
  await refused(
    runDispatchDeliveriesAction(client, "dispatch_delivery_mark_sighted", {
      purchase_order_id: PO,
      expected_updated_at: T0,
      sighted: true,
    }, screen),
    500,
    "deliveries_write_failed",
  );
});

Deno.test("write: the ops key cannot name a person from another organisation", async () => {
  const w = world();
  w.users = [{
    id: USER,
    email: "person@example.test",
    org_id: "other-org",
    name: "Person A",
  }];
  const { client, writes } = fakeClient(w);
  await refused(
    runDispatchDeliveriesAction(client, "dispatch_delivery_mark_sighted", {
      purchase_order_id: PO,
      expected_updated_at: T0,
      sighted: true,
      operator_email: "person@example.test",
    }, terminal),
    400,
    "operator_required",
  );
  assertEquals(writes, []);
});
