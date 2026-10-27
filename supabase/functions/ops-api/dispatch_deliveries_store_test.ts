// deno-lint-ignore-file no-explicit-any
// Behaviour of the three delivery writers against an in-memory store.
// No network, no live database. What a caller can observe: the answer, the
// order row, and the job_events row.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  markDispatchDeliverySighted,
  setDispatchDeliveryConfirmed,
  setDispatchDeliveryExpected,
  type DispatchDeliveriesContext,
} from "./dispatch_deliveries_store.ts";
import { DispatchMaterialsError } from "./dispatch_materials_store.ts";
import { makeDispatchMemory } from "./dispatch_memory_client.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const JOB = "a1000000-0000-4000-8000-000000000010";
const USER = "d1000000-0000-4000-8000-000000000010";
const PO = "e1000000-0000-4000-8000-000000000010";
const LINE_ON_ORDER = "c1000000-0000-4000-8000-000000000010";
const LINE_STOCK = "c1000000-0000-4000-8000-000000000011";
const STAMP = "2026-10-18T03:00:00.000Z";
const WHEN = "2026-10-18T04:00:00.000Z";

function job(over: Record<string, unknown> = {}) {
  return {
    id: JOB,
    org_id: ORG,
    job_number: "SWF-900001",
    type: "fencing",
    status: "accepted",
    site_address: "1 Example St",
    site_suburb: "Exampleton",
    metadata: null,
    council_required: false,
    ...over,
  };
}

function order(over: Record<string, unknown> = {}) {
  return {
    id: PO,
    org_id: ORG,
    job_id: JOB,
    po_number: "PO-1000001",
    supplier_name: "Example Steel",
    supplier_id: "b1000000-0000-4000-8000-000000000010",
    source: "dispatch",
    status: "sent",
    po_type: null,
    line_items: [],
    reference: null,
    xero_po_id: null,
    created_at: STAMP,
    updated_at: STAMP,
    pdf_path: null,
    pdf_sha256: null,
    pdf_version: 1,
    last_sent_pdf_version: 1,
    last_sent_at: STAMP,
    delivery_date: null,
    delivery_confirmed_at: null,
    confirmed_delivery_date: null,
    confirmed_delivery_set_at: null,
    confirmed_delivery_set_by: null,
    confirmed_delivery_set_by_email: null,
    delivery_sighted_at: null,
    delivery_sighted_by: null,
    delivery_sighted_by_email: null,
    ...over,
  };
}

// The writers spread these onto the answer. The inferred return type drops
// them because the extra object is a record, so a caller reads them off the
// object the way the JSON response does.
function seen(value: object, key: string): unknown {
  return Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function world(over: {
  job?: Record<string, unknown>;
  order?: Record<string, unknown>;
} = {}) {
  return makeDispatchMemory({
    jobs: [job(over.job)],
    users: [{
      id: USER,
      org_id: ORG,
      name: "Office Person",
      email: "office@example.test",
    }],
    purchase_orders: [order(over.order)],
    job_material_lines: [
      {
        id: LINE_ON_ORDER,
        job_id: JOB,
        status: "to_order",
        purchase_order_id: PO,
      },
      {
        id: LINE_STOCK,
        job_id: JOB,
        status: "in_stock",
        purchase_order_id: null,
      },
    ],
    job_events: [],
    job_dispatch_state: [],
  });
}

function screen(): DispatchDeliveriesContext {
  return {
    orgId: ORG,
    actor: { userId: USER, email: "office@example.test", orgId: ORG },
    via: "screen",
    now: () => WHEN,
  };
}

async function refused(run: () => Promise<unknown>): Promise<DispatchMaterialsError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DispatchMaterialsError) return error;
    throw error;
  }
  throw new Error("the write was accepted");
}

Deno.test("delivery: a press sets the expected date, and the same date again writes nothing", async () => {
  const memory = world();
  const first = await setDispatchDeliveryExpected(memory, {
    purchase_order_id: PO,
    expected_updated_at: STAMP,
    delivery_date: "2026-10-22",
  }, screen());
  assertEquals(first.success, true);
  assertEquals(first.order.delivery.expected, "2026-10-22");
  assertEquals(first.order.delivery.expected_editable, true);
  assertEquals(first.order.delivery.step, 1);
  assertEquals(first.deliveries, { counted: 1, sighted: 0, all_sighted: false });
  assertEquals(first.counts, { total: 2, ready: 1 });
  assertEquals(memory.rows("purchase_orders")[0].delivery_date, "2026-10-22");
  assertEquals(memory.rows("purchase_orders")[0].status, "sent");
  assertEquals(memory.rows("purchase_orders")[0].delivery_confirmed_at, null);
  assertEquals(memory.rows("purchase_orders")[0].xero_po_id, null);
  assertEquals(memory.rows("jobs")[0].status, "accepted");
  assertEquals(memory.rows("job_dispatch_state"), []);
  const event = memory.rows("job_events")[0];
  assertEquals(event.event_type, "po_delivery_expected_set");
  assertEquals(event.user_id, USER);
  assertEquals(event.detail_json, {
    po_id: PO,
    po_number: "PO-1000001",
    supplier: "Example Steel",
    from: null,
    to: "2026-10-22",
    operator_email: "office@example.test",
  });
  const stamp = first.order.updated_at;
  assertEquals(typeof stamp, "string");
  assertEquals(stamp === STAMP, false);

  const again = await setDispatchDeliveryExpected(memory, {
    purchase_order_id: PO,
    expected_updated_at: stamp,
    delivery_date: "2026-10-22",
  }, screen());
  assertEquals(seen(again, "unchanged"), true);
  assertEquals(again.order.updated_at, stamp);
  assertEquals(memory.rows("job_events").length, 1);
});

Deno.test("delivery: a stale updated_at is refused and the order stays as it was", async () => {
  const memory = world();
  const first = await setDispatchDeliveryExpected(memory, {
    purchase_order_id: PO,
    expected_updated_at: STAMP,
    delivery_date: "2026-10-22",
  }, screen());
  const error = await refused(() =>
    setDispatchDeliveryExpected(memory, {
      purchase_order_id: PO,
      expected_updated_at: STAMP,
      delivery_date: "2026-10-24",
    }, screen())
  );
  assertEquals(error.status, 409);
  assertEquals(error.body.code, "order_changed");
  assertEquals((error.body.order as any).delivery.expected, "2026-10-22");
  assertEquals((error.body.order as any).updated_at, first.order.updated_at);
  assertEquals(memory.rows("purchase_orders")[0].delivery_date, "2026-10-22");
  assertEquals(memory.rows("job_events").length, 1);
});

Deno.test("delivery: a failed audit insert keeps the write and says so", async () => {
  const memory = world();
  memory.failNext("insert", "job_events", {
    code: "XX000",
    message: "audit down",
  });
  const answer = await setDispatchDeliveryExpected(memory, {
    purchase_order_id: PO,
    expected_updated_at: STAMP,
    delivery_date: "2026-10-22",
  }, screen());
  assertEquals(answer.success, true);
  assertEquals(seen(answer, "audit_logged"), false);
  assertEquals(answer.order.delivery.expected, "2026-10-22");
  assertEquals(memory.rows("purchase_orders")[0].delivery_date, "2026-10-22");
  assertEquals(memory.rows("job_events"), []);
});

Deno.test("delivery: an order in Xero refuses an expected date and still takes a confirmed date", async () => {
  const memory = world({ order: { xero_po_id: "xero-po-1" } });
  const blocked = await refused(() =>
    setDispatchDeliveryExpected(memory, {
      purchase_order_id: PO,
      expected_updated_at: STAMP,
      delivery_date: "2026-10-22",
    }, screen())
  );
  assertEquals(blocked.status, 409);
  assertEquals(blocked.body.code, "order_in_xero");
  assertEquals(memory.rows("purchase_orders")[0].delivery_date, null);
  assertEquals(memory.rows("job_events"), []);

  const confirmed = await setDispatchDeliveryConfirmed(memory, {
    purchase_order_id: PO,
    expected_updated_at: STAMP,
    confirmed_delivery_date: "2026-10-23",
    via: "thread",
  }, screen());
  assertEquals(confirmed.order.delivery.confirmed.date, "2026-10-23");
  assertEquals(confirmed.order.delivery.confirmed.by_hand, true);
  assertEquals(memory.rows("purchase_orders")[0].xero_po_id, "xero-po-1");
  assertEquals(memory.rows("job_events")[0].detail_json.via, "thread");
});

Deno.test("delivery: a date the reply reader wrote is stamped when a person sets it again", async () => {
  const memory = world({
    order: {
      confirmed_delivery_date: "2026-10-23",
      confirmed_delivery_set_at: null,
    },
  });
  const answer = await setDispatchDeliveryConfirmed(memory, {
    purchase_order_id: PO,
    expected_updated_at: STAMP,
    confirmed_delivery_date: "2026-10-23",
    via: "deliveries",
  }, screen());
  assertEquals(seen(answer, "unchanged"), undefined);
  assertEquals(memory.rows("purchase_orders")[0].confirmed_delivery_set_at, WHEN);
  assertEquals(memory.rows("purchase_orders")[0].confirmed_delivery_set_by, USER);
  assertEquals(
    memory.rows("purchase_orders")[0].confirmed_delivery_set_by_email,
    "office@example.test",
  );
  assertEquals(memory.rows("job_events")[0].event_type, "po_delivery_confirmed_set");
});

Deno.test("delivery: clearing a hand-set date, and setting the same hand-set date, are different", async () => {
  const memory = world();
  const set = await setDispatchDeliveryConfirmed(memory, {
    purchase_order_id: PO,
    expected_updated_at: STAMP,
    confirmed_delivery_date: "2026-10-23",
    via: "deliveries",
  }, screen());
  const same = await setDispatchDeliveryConfirmed(memory, {
    purchase_order_id: PO,
    expected_updated_at: set.order.updated_at,
    confirmed_delivery_date: "2026-10-23",
    via: "deliveries",
  }, screen());
  assertEquals(seen(same, "unchanged"), true);
  assertEquals(memory.rows("job_events").length, 1);

  const cleared = await setDispatchDeliveryConfirmed(memory, {
    purchase_order_id: PO,
    expected_updated_at: set.order.updated_at,
    confirmed_delivery_date: null,
    via: "deliveries",
  }, screen());
  assertEquals(cleared.order.delivery.confirmed.state, "waiting");
  const row = memory.rows("purchase_orders")[0];
  assertEquals(row.confirmed_delivery_date, null);
  assertEquals(row.confirmed_delivery_set_at, null);
  assertEquals(row.confirmed_delivery_set_by, null);
  assertEquals(row.confirmed_delivery_set_by_email, null);
  assertEquals(memory.rows("job_events")[1].detail_json.to, null);
});

Deno.test("delivery: sighting a line's order counts it ready, and clearing the sighting removes the name", async () => {
  const memory = world();
  const marked = await markDispatchDeliverySighted(memory, {
    purchase_order_id: PO,
    expected_updated_at: STAMP,
    sighted: true,
  }, screen());
  assertEquals(marked.order.delivery.sighted, {
    at: WHEN,
    by: "Office Person",
  });
  assertEquals(marked.order.delivery.step, 3);
  assertEquals(marked.counts, { total: 2, ready: 2 });
  assertEquals(marked.deliveries, { counted: 1, sighted: 1, all_sighted: true });
  assertEquals(memory.rows("job_events")[0].event_type, "po_delivery_sighted");

  const again = await markDispatchDeliverySighted(memory, {
    purchase_order_id: PO,
    expected_updated_at: marked.order.updated_at,
    sighted: true,
  }, screen());
  assertEquals(seen(again, "unchanged"), true);
  assertEquals(memory.rows("job_events").length, 1);

  const cleared = await markDispatchDeliverySighted(memory, {
    purchase_order_id: PO,
    expected_updated_at: marked.order.updated_at,
    sighted: false,
  }, screen());
  assertEquals(cleared.order.delivery.sighted, null);
  assertEquals(cleared.counts, { total: 2, ready: 1 });
  const row = memory.rows("purchase_orders")[0];
  assertEquals(row.delivery_sighted_at, null);
  assertEquals(row.delivery_sighted_by, null);
  assertEquals(row.delivery_sighted_by_email, null);
  assertEquals(memory.rows("job_events")[1].event_type, "po_delivery_sighted_cleared");
  assertEquals(memory.rows("job_events")[1].detail_json.was_sighted_at, WHEN);
});

Deno.test("delivery: the ops key stores the named person's email and no user id", async () => {
  const memory = world();
  const answer = await setDispatchDeliveryExpected(memory, {
    purchase_order_id: PO,
    expected_updated_at: STAMP,
    delivery_date: "2026-10-22",
    operator_email: "Office@Example.Test",
  }, {
    orgId: ORG,
    actor: { userId: null, email: null, orgId: null },
    via: "terminal",
    now: () => WHEN,
  });
  assertEquals(answer.success, true);
  assertEquals(memory.rows("job_events")[0].user_id, null);
  assertEquals(
    memory.rows("job_events")[0].detail_json.operator_email,
    "office@example.test",
  );
});

Deno.test("delivery: refusals leave the order and the event log alone", async () => {
  const cases: Array<{
    name: string;
    job?: Record<string, unknown>;
    order?: Record<string, unknown>;
    body: Record<string, unknown>;
    status: number;
    code: string;
  }> = [
    {
      name: "make-safe",
      job: { type: "makesafe", job_number: "SWMS-900001" },
      body: { delivery_date: "2026-10-22" },
      status: 409,
      code: "not_dispatch_work",
    },
    {
      name: "cancelled",
      order: { status: "cancelled" },
      body: { delivery_date: "2026-10-22" },
      status: 409,
      code: "order_cancelled",
    },
    {
      name: "labour",
      order: { po_type: "labour" },
      body: { delivery_date: "2026-10-22" },
      status: 409,
      code: "not_material",
    },
    {
      name: "bad date",
      body: { delivery_date: "22/10/2026" },
      status: 400,
      code: "invalid_request",
    },
    {
      name: "bad id",
      body: { purchase_order_id: "nope", delivery_date: "2026-10-22" },
      status: 400,
      code: "invalid_request",
    },
    {
      name: "other org",
      order: { org_id: "00000000-0000-4000-8000-000000000099" },
      body: { delivery_date: "2026-10-22" },
      status: 404,
      code: "order_not_found",
    },
    {
      name: "unnamed ops key",
      body: { delivery_date: "2026-10-22", terminal: true },
      status: 400,
      code: "operator_required",
    },
    {
      name: "unknown operator",
      body: {
        delivery_date: "2026-10-22",
        operator_email: "nobody@example.test",
        terminal: true,
      },
      status: 400,
      code: "operator_required",
    },
  ];
  for (const item of cases) {
    const memory = world({ job: item.job, order: item.order });
    const terminal = item.body.terminal === true;
    const { terminal: _drop, ...body } = item.body;
    const error = await refused(() =>
      setDispatchDeliveryExpected(memory, {
        purchase_order_id: PO,
        expected_updated_at: STAMP,
        ...body,
      }, terminal
        ? {
          orgId: ORG,
          actor: { userId: null, email: null, orgId: null },
          via: "terminal",
          now: () => WHEN,
        }
        : screen())
    );
    assertEquals(error.status, item.status, item.name);
    assertEquals(error.body.code, item.code, item.name);
    assertEquals(memory.rows("job_events"), [], item.name);
    assertEquals(memory.rows("purchase_orders")[0].delivery_date, null, item.name);
  }
});

Deno.test("delivery: a repair-family job stored as make-safe can take a date", async () => {
  const memory = world({
    job: {
      type: "makesafe",
      metadata: { ses_family: "repair" },
    },
  });
  const answer = await setDispatchDeliveryExpected(memory, {
    purchase_order_id: PO,
    expected_updated_at: STAMP,
    delivery_date: "2026-10-22",
  }, screen());
  assertEquals(answer.success, true);
  assertEquals(memory.rows("purchase_orders")[0].delivery_date, "2026-10-22");
});

Deno.test("delivery: a failed counts read does not undo the date", async () => {
  const memory = world();
  memory.fail("select", "job_material_lines");
  const answer = await setDispatchDeliveryExpected(memory, {
    purchase_order_id: PO,
    expected_updated_at: STAMP,
    delivery_date: "2026-10-22",
  }, screen());
  assertEquals(answer.success, true);
  assertEquals(answer.counts, null);
  assertEquals(memory.rows("purchase_orders")[0].delivery_date, "2026-10-22");
  assertEquals(memory.rows("job_events").length, 1);
});
