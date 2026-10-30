// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch v2: a supplier order's material stage (dispatch_v2_material_stage.ts
// for the rules, dispatch_v2_material_stage_write.ts for the set press,
// docs/dispatch-v2-board-contract.md section 3b), against an in-memory
// stand-in for PostgREST. The stand-in knows the supplier box's columns (a
// wrong column name is a 42703, as live) and keeps the stage migration's
// check, so a write the database would refuse fails here too.
//
// Nothing is sent and nothing touches production. Job, client and supplier
// details are made up.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DISPATCH_MATERIAL_STAGES,
  dispatchMaterialStageOf,
  dispatchMaterialTodo,
  dispatchMaterialWaitingOn,
  dispatchPoMaterialStage,
  dispatchUnsentLineChanges,
} from "./dispatch_v2_material_stage.ts";
import {
  DISPATCH_V2_SET_MATERIAL_STAGE_ACTION,
  type DispatchV2MaterialStageContext,
  runDispatchV2MaterialStageAction,
} from "./dispatch_v2_material_stage_write.ts";
import { dispatchArrival, dispatchBoardWaiting } from "./dispatch_board.ts";
import { DispatchMaterialsError } from "./dispatch_materials_store.ts";

// index.ts reads SUPABASE_URL and the service key into module constants, so
// they are set before it is imported (a closed local port) and restored.
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
  _opsApiRequestHandlerForTest,
  AGENT_READ_ALLOWED_ACTIONS,
  LEAD_INSTALLER_READ_ACTIONS,
} = index;

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000ee";
const TODAY = "2026-10-23";
const NOW = "2026-10-23T03:00:00.000Z";
type Row = Record<string, any>;

function uuid(prefix: string, n: number): string {
  return `${prefix}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
const JOB = {
  fence: uuid("a1", 1),
  makesafe: uuid("a1", 2),
  other: uuid("a1", 3),
};
const SUP = { stratco: uuid("b1", 1), metroll: uuid("b1", 2) };
const BOX = {
  stratco: uuid("c1", 1),
  metroll: uuid("c1", 2),
  makesafe: uuid("c1", 3),
  otherOrg: uuid("c1", 4),
};
const SHAUN = { userId: uuid("d1", 1), email: "shaun@ops.test", orgId: ORG };
const HUGO_SET_AT = "2026-10-22T05:00:00+00:00";

// The supplier box's columns (20261014130000 + 20261023160000 + 20261023214200
// + 20261028170000).
const BOX_COLUMNS = new Set([
  "id",
  "org_id",
  "job_id",
  "supplier_id",
  "supplier_name",
  "position",
  "created_at",
  "created_by",
  "created_by_email",
  "is_main_supplier",
  "delivery_date",
  "delivery_date_source",
  "delivery_date_set_at",
  "delivery_date_set_by_email",
  "delivery_date_confirmed_at",
  "delivery_date_confirmed_by",
  "delivery_date_confirmed_by_email",
  "material_stage",
  "material_stage_set_at",
  "material_stage_set_by_email",
  // 20261029120300_dispatch_v2_box_payment_reopened.sql
  "payment_reopened_at",
]);

// The stage migration's check: a stage from the list, always with when and by
// whom.
function boxChecksPass(row: Row): boolean {
  if (row.material_stage == null) return true;
  return DISPATCH_MATERIAL_STAGES.some((s) => s.key === row.material_stage) &&
    row.material_stage_set_at != null &&
    row.material_stage_set_by_email != null;
}

function noStage(): Row {
  return {
    material_stage: null,
    material_stage_set_at: null,
    material_stage_set_by_email: null,
  };
}

function box(
  id: string,
  jobId: string,
  supplierId: string,
  name: string,
  extra: Row = {},
): Row {
  return {
    id,
    org_id: ORG,
    job_id: jobId,
    supplier_id: supplierId,
    supplier_name: name,
    position: 0,
    created_at: "2026-10-20T00:00:00Z",
    is_main_supplier: false,
    delivery_date: null,
    delivery_date_source: null,
    delivery_date_set_at: null,
    delivery_date_set_by_email: null,
    delivery_date_confirmed_at: null,
    delivery_date_confirmed_by: null,
    delivery_date_confirmed_by_email: null,
    ...noStage(),
    ...extra,
  };
}

function fixture(): Record<string, Row[]> {
  return {
    jobs: [
      {
        id: JOB.fence,
        org_id: ORG,
        type: "fencing",
        status: "in_progress",
        job_number: "SWF-90001",
        client_name: "Test Person",
        site_suburb: "Balcatta",
        ds_ses_family: null,
        ds_makesafe_family: null,
        ds_repair_stage: null,
      },
      {
        id: JOB.makesafe,
        org_id: ORG,
        type: "makesafe",
        status: "scheduled",
        job_number: "SWMS-90002",
        client_name: "Test Two",
        site_suburb: "Osborne Park",
        ds_ses_family: null,
        ds_makesafe_family: null,
        ds_repair_stage: null,
      },
      {
        id: JOB.other,
        org_id: OTHER_ORG,
        type: "fencing",
        status: "awaiting_supplier",
        job_number: "SWF-90003",
        client_name: "Elsewhere",
        site_suburb: "Nowhere",
        ds_ses_family: null,
        ds_makesafe_family: null,
        ds_repair_stage: null,
      },
    ],
    job_material_suppliers: [
      box(BOX.stratco, JOB.fence, SUP.stratco, "Stratco WA", {
        is_main_supplier: true,
      }),
      // Hugo already marked the Metroll order as awaiting payment.
      box(BOX.metroll, JOB.fence, SUP.metroll, "Metroll", {
        position: 1,
        created_at: "2026-10-20T00:01:00Z",
        material_stage: "awaiting_payment",
        material_stage_set_at: HUGO_SET_AT,
        material_stage_set_by_email: "hugo@ops.test",
      }),
      box(BOX.makesafe, JOB.makesafe, SUP.stratco, "Stratco WA"),
      {
        ...box(BOX.otherOrg, JOB.other, SUP.stratco, "Stratco WA"),
        org_id: OTHER_ORG,
      },
    ],
    users: [
      { id: SHAUN.userId, email: SHAUN.email, org_id: ORG },
    ],
    job_events: [],
    // The fence was installed Tue 21 Oct: the crew is on site.
    job_assignments: [
      {
        id: "as1",
        job_id: JOB.fence,
        scheduled_date: "2026-10-21",
        scheduled_end: null,
        assignment_type: "install",
        status: "scheduled",
        is_ghost: false,
        role: null,
        confirmation_status: "confirmed",
      },
    ],
    purchase_orders: [],
    // The Stratco order went on Mon 20 Oct, before the install.
    dispatch_supplier_order_emails: [
      {
        id: uuid("e1", 1),
        job_id: JOB.fence,
        supplier_id: SUP.stratco,
        status: "sent",
        sent_at: "2026-10-20T01:00:00Z",
        delivery_date: "2026-10-21",
      },
    ],
    job_material_lines: [
      {
        id: uuid("f1", 1),
        job_id: JOB.fence,
        supplier_id: SUP.stratco,
        status: "ordered",
        dispatch_order_email_id: uuid("e1", 1),
        purchase_order_id: null,
        created_at: "2026-10-19T00:00:00Z",
        updated_at: "2026-10-20T01:00:00Z",
      },
    ],
  };
}

type Options = {
  // Runs just before an update lands (a second person's press in between).
  beforeUpdate?: (tables: Record<string, Row[]>) => void;
  failEvents?: boolean;
};

// A PostgREST stand-in for the reads and the one update and insert this
// action makes. It records every write.
function makeClient(tables: Record<string, Row[]>, options: Options = {}) {
  const writes: Array<{ table: string; kind: string; row: Row }> = [];

  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let patch: Row | null = null;
    let insertRow: Row | null = null;
    let rowLimit: number | null = null;
    const orders: Array<[string, boolean]> = [];

    const matching = () =>
      (tables[table] || []).filter((row) => filters.every((f) => f(row)));

    const run = (): { data: any; error: any } => {
      if (insertRow) {
        if (table === "job_events" && options.failEvents) {
          return { data: null, error: { message: "job_events is down" } };
        }
        (tables[table] ||= []).push(insertRow);
        writes.push({ table, kind: "insert", row: insertRow });
        return { data: null, error: null };
      }
      if (patch) {
        if (table !== "job_material_suppliers") {
          throw new Error(`unexpected update of ${table}`);
        }
        for (const key of Object.keys(patch)) {
          if (!BOX_COLUMNS.has(key)) {
            return {
              data: null,
              error: { code: "42703", message: `column ${key} does not exist` },
            };
          }
        }
        options.beforeUpdate?.(tables);
        const hits = matching();
        for (const row of hits) {
          if (!boxChecksPass({ ...row, ...patch })) {
            return {
              data: null,
              error: { code: "23514", message: "check violated" },
            };
          }
        }
        for (const row of hits) {
          Object.assign(row, patch);
          writes.push({ table, kind: "update", row: { ...row } });
        }
        return { data: hits.map((r) => ({ ...r })), error: null };
      }
      let rows = matching().map((r) => ({ ...r }));
      rows.sort((a, b) => {
        for (const [column, ascending] of orders) {
          if (a[column] === b[column]) continue;
          const before = a[column] < b[column] ? -1 : 1;
          return ascending ? before : -before;
        }
        return 0;
      });
      if (rowLimit != null) rows = rows.slice(0, rowLimit);
      return { data: rows, error: null };
    };

    const builder: any = {
      select: () => builder,
      update: (p: Row) => ((patch = p), builder),
      insert: (r: Row) => ((insertRow = r), builder),
      eq: (
        c: string,
        v: unknown,
      ) => (filters.push((row) => row[c] === v), builder),
      neq: (
        c: string,
        v: unknown,
      ) => (filters.push((row) => row[c] !== v), builder),
      is: (
        c: string,
        v: unknown,
      ) => (filters.push((row) => (row[c] ?? null) === v), builder),
      in: (
        c: string,
        v: unknown[],
      ) => (filters.push((row) => v.includes(row[c])), builder),
      order: (column: string, o?: { ascending?: boolean }) => {
        orders.push([column, o?.ascending !== false]);
        return builder;
      },
      limit: (n: number) => ((rowLimit = n), builder),
      range: (start: number, end: number) => {
        const r = run();
        return Promise.resolve(
          r.error ? r : { data: r.data.slice(start, end + 1), error: null },
        );
      },
      maybeSingle: () => {
        const r = run();
        return Promise.resolve(
          r.error ? r : { data: r.data[0] ?? null, error: null },
        );
      },
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (r: unknown) => unknown,
      ) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }
  return { client: { from }, writes };
}

function ctx(
  overrides: Partial<DispatchV2MaterialStageContext> = {},
): DispatchV2MaterialStageContext {
  return {
    orgId: ORG,
    actor: SHAUN,
    via: "screen",
    today: TODAY,
    now: () => NOW,
    ...overrides,
  };
}

const run = (client: any, body: any, c = ctx()) =>
  runDispatchV2MaterialStageAction(
    client,
    DISPATCH_V2_SET_MATERIAL_STAGE_ACTION,
    body,
    c,
  ) as Promise<any>;

async function refused(client: any, body: any, c = ctx()) {
  return await assertRejects(
    () => run(client, body, c),
    DispatchMaterialsError,
  ) as DispatchMaterialsError;
}

function boxRow(tables: Record<string, Row[]>, id: string): Row {
  return tables.job_material_suppliers.find((b) => b.id === id)!;
}

function arrivalFor(answer: any, supplierId: string) {
  return answer.arrival.arrival.orders.find((o: any) =>
    o.supplier_id === supplierId
  );
}

// ── The rules for the stage a box shows ────────────────────────────────────

const T = (h: number) => `2026-10-2${h}T01:00:00.000Z`;

Deno.test("stage: a box with nothing on it is Order materials, worked out", () => {
  assertEquals(
    dispatchMaterialStageOf({
      stored: null,
      storedAt: null,
      sentAts: [],
      unsentLineChanges: [],
      confirmedAt: null,
    }),
    { key: "order_materials", source: "worked_out" },
  );
});

Deno.test("stage: a sent email shows Sent to supplier", () => {
  assertEquals(
    dispatchMaterialStageOf({
      stored: null,
      storedAt: null,
      sentAts: [T(0)],
      unsentLineChanges: [],
      confirmedAt: null,
    }),
    { key: "sent", source: "worked_out" },
  );
});

Deno.test("stage: a stage set after the send shows, named as set", () => {
  assertEquals(
    dispatchMaterialStageOf({
      stored: "quote_received",
      storedAt: T(1),
      sentAts: [T(0)],
      unsentLineChanges: [],
      confirmedAt: null,
    }),
    { key: "quote_received", source: "set" },
  );
});

Deno.test("stage: a newer send moves the box back to Sent to supplier", () => {
  assertEquals(
    dispatchMaterialStageOf({
      stored: "delivered",
      storedAt: T(1),
      sentAts: [T(0), T(2)],
      unsentLineChanges: [],
      confirmedAt: null,
    }),
    { key: "sent", source: "worked_out" },
  );
});

Deno.test("stage: a new line to order moves the box back to Order materials", () => {
  assertEquals(
    dispatchMaterialStageOf({
      stored: "delivered",
      storedAt: T(1),
      sentAts: [T(0)],
      unsentLineChanges: [T(3)],
      confirmedAt: null,
    }),
    { key: "order_materials", source: "worked_out" },
  );
});

Deno.test("stage: a stage set after the new line wins (ordered by phone)", () => {
  assertEquals(
    dispatchMaterialStageOf({
      stored: "order_confirmed",
      storedAt: T(4),
      sentAts: [T(0)],
      unsentLineChanges: [T(3)],
      confirmedAt: null,
    }),
    { key: "order_confirmed", source: "set" },
  );
});

Deno.test("stage: a confirmed delivery date lifts an earlier stage, never pulls a later one back", () => {
  assertEquals(
    dispatchMaterialStageOf({
      stored: null,
      storedAt: null,
      sentAts: [T(0)],
      unsentLineChanges: [],
      confirmedAt: T(1),
    }),
    { key: "order_confirmed", source: "worked_out" },
  );
  assertEquals(
    dispatchMaterialStageOf({
      stored: "ready",
      storedAt: T(0),
      sentAts: [],
      unsentLineChanges: [],
      confirmedAt: T(1),
    }),
    { key: "ready", source: "set" },
  );
  // Confirmed before the newest send: that was an earlier order.
  assertEquals(
    dispatchMaterialStageOf({
      stored: null,
      storedAt: null,
      sentAts: [T(2)],
      unsentLineChanges: [],
      confirmedAt: T(1),
    }),
    { key: "sent", source: "worked_out" },
  );
});

Deno.test("stage: who it waits on, and the next thing to do", () => {
  const on = (k: string, booked: boolean) =>
    dispatchMaterialWaitingOn(k, booked);
  assertEquals(
    ["order_materials", "quote_received", "awaiting_payment", "ready"].map((
      k,
    ) => on(k, true)),
    ["us", "us", "us", "us"],
  );
  assertEquals([on("sent", false), on("manufacturing", false)], [
    "supplier",
    "supplier",
  ]);
  assertEquals([on("order_confirmed", false), on("order_confirmed", true)], [
    "us",
    "supplier",
  ]);
  assertEquals(on("delivered", false), "nobody");
  assertEquals(
    dispatchMaterialTodo("order_confirmed", "Stratco WA", false),
    "Book the install and tell the client",
  );
  assertEquals(
    dispatchMaterialTodo("order_confirmed", "Stratco WA", true),
    "Waiting on Stratco WA for the materials",
  );
  assertEquals(
    dispatchMaterialTodo("awaiting_payment", null, true),
    "Pay the supplier",
  );
  assertEquals(dispatchMaterialTodo("delivered", "Metroll", true), null);
  // No em dash in any line a person reads.
  for (const s of DISPATCH_MATERIAL_STAGES) {
    assert(!s.label.includes("—"));
    for (const booked of [true, false]) {
      assert(!(dispatchMaterialTodo(s.key, "X", booked) || "").includes("—"));
    }
  }
});

Deno.test("stage: a purchase order's stage comes from its status", () => {
  assertEquals(
    ["draft", "sent", "authorised", "confirmed", "delivered", "billed", null]
      .map(
        dispatchPoMaterialStage,
      ),
    [
      "order_materials",
      "sent",
      "sent",
      "order_confirmed",
      "delivered",
      "delivered",
      "order_materials",
    ],
  );
});

Deno.test("stage: only lines still to order count as a change", () => {
  const lines = [
    { supplier_id: SUP.stratco, status: "to_order", updated_at: T(1) },
    { supplier_id: SUP.stratco, status: "in_stock", updated_at: T(2) },
    {
      supplier_id: SUP.stratco,
      dispatch_order_email_id: "e",
      updated_at: T(3),
    },
    { supplier_id: SUP.stratco, purchase_order_id: "p", updated_at: T(4) },
    { supplier_id: SUP.metroll, status: "to_order", updated_at: T(5) },
    { supplier_id: SUP.stratco, status: "to_order", created_at: T(6) },
  ];
  assertEquals(dispatchUnsentLineChanges(lines, SUP.stratco), [T(1), T(6)]);
});

// ── The Arrival line: extra orders and waiting on us ───────────────────────

Deno.test("arrival: an order sent on or after the install day is an extra, with no late flag", () => {
  const arrival = dispatchArrival({
    boxes: [
      box(BOX.stratco, JOB.fence, SUP.stratco, "Stratco WA") as any,
    ],
    orders: [],
    sentEmails: [
      {
        id: "e1",
        supplier_id: SUP.stratco,
        status: "sent",
        sent_at: "2026-10-20T01:00:00Z",
        delivery_date: "2026-10-21",
      },
      // The flashing, ordered once the crew was on site, for Mon 27 Oct.
      {
        id: "e2",
        supplier_id: SUP.stratco,
        status: "sent",
        sent_at: "2026-10-22T01:00:00Z",
        delivery_date: "2026-10-27",
      },
    ] as any,
    lines: [],
    installDay: "2026-10-21",
    today: TODAY,
  });
  const order = arrival.orders[0];
  assertEquals(order.extra, true);
  assertEquals(order.delivery_date, "2026-10-27");
  assertEquals(order.flag, null);
  assertEquals(order.material_stage, "sent");
  assertEquals(order.waiting_on, "supplier");
  assertEquals(arrival.counts.extra_open, 1);
  assertEquals(arrival.counts.on_us, 0);
});

Deno.test("arrival: a box date set before the newest send belongs to the earlier order", () => {
  const arrival = dispatchArrival({
    boxes: [
      box(BOX.stratco, JOB.fence, SUP.stratco, "Stratco WA", {
        delivery_date: "2026-10-21",
        delivery_date_source: "by_hand",
        delivery_date_set_at: "2026-10-20T05:00:00Z",
        delivery_date_set_by_email: SHAUN.email,
        delivery_date_confirmed_at: "2026-10-20T05:00:00Z",
        delivery_date_confirmed_by_email: SHAUN.email,
      }) as any,
    ],
    orders: [],
    sentEmails: [
      {
        id: "e2",
        supplier_id: SUP.stratco,
        status: "sent",
        sent_at: "2026-10-22T01:00:00Z",
        delivery_date: "2026-10-27",
      },
    ] as any,
    lines: [],
    installDay: "2026-10-21",
    today: TODAY,
  });
  const order = arrival.orders[0];
  assertEquals(order.delivery_date, "2026-10-27");
  assertEquals(order.date_source, "requested");
  assertEquals(order.date_confirmed, false);
  // The old confirmation does not lift the new order to Order confirmed.
  assertEquals(order.material_stage, "sent");
});

Deno.test("arrival: a new line after the install is an extra still to order, on us", () => {
  const arrival = dispatchArrival({
    boxes: [box(BOX.stratco, JOB.fence, SUP.stratco, "Stratco WA") as any],
    orders: [],
    sentEmails: [
      {
        id: "e1",
        supplier_id: SUP.stratco,
        status: "sent",
        sent_at: "2026-10-20T01:00:00Z",
        delivery_date: "2026-10-21",
      },
    ] as any,
    lines: [
      {
        id: "l2",
        supplier_id: SUP.stratco,
        status: "to_order",
        created_at: "2026-10-22T02:00:00Z",
        updated_at: "2026-10-22T02:00:00Z",
      },
    ],
    installDay: "2026-10-21",
    today: TODAY,
  });
  const order = arrival.orders[0];
  assertEquals(order.material_stage, "order_materials");
  assertEquals(order.extra, true);
  assertEquals(order.waiting_on, "us");
  assertEquals(arrival.waiting_on_us, ["Send the order to Stratco WA"]);
  const waiting = dispatchBoardWaiting(
    { key: "in_progress" } as any,
    arrival,
  );
  assertEquals(waiting, {
    on_us: true,
    todo: ["Send the order to Stratco WA"],
  });
});

Deno.test("arrival: a purchase order made on the install day is an extra", () => {
  const arrival = dispatchArrival({
    boxes: [],
    orders: [
      {
        id: "po1",
        source: "manual",
        supplier_id: SUP.metroll,
        supplier_name: "Metroll",
        status: "confirmed",
        delivery_date: "2026-10-24",
        confirmed_delivery_date: "2026-10-24",
        created_at: "2026-10-21T02:00:00Z",
      },
    ],
    sentEmails: [],
    lines: [],
    installDay: "2026-10-21",
    today: TODAY,
  });
  const order = arrival.orders[0];
  assertEquals(order.extra, true);
  assertEquals(order.material_stage, "order_confirmed");
  assertEquals(order.material_stage_source, "order");
  assertEquals(order.flag, null);
});

// ── Setting a stage ────────────────────────────────────────────────────────

Deno.test("set: a stage by hand is stored, audited and shown on the Arrival line", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  const answer = await run(client, {
    box_id: BOX.stratco,
    material_stage: "manufacturing",
    expected_set_at: null,
  });
  assertEquals(answer.success, true);
  assertEquals(answer.job_status_changed, false);
  const row = boxRow(tables, BOX.stratco);
  assertEquals(row.material_stage, "manufacturing");
  assertEquals(row.material_stage_set_at, NOW);
  assertEquals(row.material_stage_set_by_email, SHAUN.email);
  assertEquals(answer.box, {
    box_id: BOX.stratco,
    job_id: JOB.fence,
    supplier_id: SUP.stratco,
    supplier_name: "Stratco WA",
    material_stage: "manufacturing",
    material_stage_label: "Manufacturing",
    set_at: NOW,
    set_by_email: SHAUN.email,
  });
  const line = arrivalFor(answer, SUP.stratco);
  assertEquals(line.material_stage, "manufacturing");
  assertEquals(line.material_stage_source, "set");
  assertEquals(line.material_stage_set_by_email, SHAUN.email);
  assertEquals(line.waiting_on, "supplier");
  assertEquals(line.todo, "Stratco WA is making it");
  // Metroll still waits on us to pay: that is the job's to-do.
  assertEquals(answer.arrival.waiting, { on_us: true, todo: ["Pay Metroll"] });
  // One box update and one audit row. Nothing else written.
  assertEquals(writes.map((w) => `${w.kind}:${w.table}`), [
    "update:job_material_suppliers",
    "insert:job_events",
  ]);
  const event = tables.job_events[0];
  assertEquals(event.event_type, "dispatch_v2_material_stage_set");
  assertEquals(event.job_id, JOB.fence);
  assertEquals(event.user_id, SHAUN.userId);
  assertEquals(event.detail_json, {
    box_id: BOX.stratco,
    supplier_id: SUP.stratco,
    supplier: "Stratco WA",
    from: null,
    to: "manufacturing",
    via: "screen",
    operator_email: SHAUN.email,
  });
  // The job is untouched.
  assertEquals(
    tables.jobs.find((j) => j.id === JOB.fence)!.status,
    "in_progress",
  );
});

Deno.test("set: by job and supplier, over a stage someone set, with the right guard", async () => {
  const tables = fixture();
  const { client } = makeClient(tables);
  const answer = await run(client, {
    job_id: JOB.fence,
    supplier_id: SUP.metroll,
    material_stage: "order_confirmed",
    expected_set_at: "2026-10-22T05:00:00.000Z",
  });
  assertEquals(answer.box.material_stage, "order_confirmed");
  assertEquals(tables.job_events[0].detail_json.from, "awaiting_payment");
  // The install is booked: Order confirmed now waits on Metroll.
  const line = arrivalFor(answer, SUP.metroll);
  assertEquals(line.waiting_on, "supplier");
});

Deno.test("set: pressing the same stage again stamps it again", async () => {
  const tables = fixture();
  const { client } = makeClient(tables);
  await run(client, {
    box_id: BOX.metroll,
    material_stage: "awaiting_payment",
    expected_set_at: HUGO_SET_AT,
  });
  const row = boxRow(tables, BOX.metroll);
  assertEquals(row.material_stage_set_at, NOW);
  assertEquals(row.material_stage_set_by_email, SHAUN.email);
});

Deno.test("set: picking Awaiting payment stamps the re-open; any other stage leaves it alone", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  await run(client, {
    box_id: BOX.stratco,
    material_stage: "manufacturing",
    expected_set_at: null,
  });
  assertEquals(boxRow(tables, BOX.stratco).payment_reopened_at ?? null, null);
  await run(client, {
    box_id: BOX.metroll,
    material_stage: "awaiting_payment",
    expected_set_at: HUGO_SET_AT,
  });
  const metroll = boxRow(tables, BOX.metroll);
  assertEquals([metroll.material_stage, metroll.payment_reopened_at], ["awaiting_payment", NOW]);
  // Still one box update per press, no other table.
  assertEquals(writes.filter((w) => w.kind === "update").map((w) => w.table), [
    "job_material_suppliers",
    "job_material_suppliers",
  ]);
});

Deno.test("set: the ops key names its person by operator_email, via terminal", async () => {
  const tables = fixture();
  const { client } = makeClient(tables);
  const terminal = ctx({
    via: "terminal",
    actor: { userId: null, email: null, orgId: null },
  });
  const missing = await refused(client, {
    box_id: BOX.stratco,
    material_stage: "sent",
  }, terminal);
  assertEquals([missing.status, (missing.body as any).code], [
    400,
    "operator_required",
  ]);
  const stranger = await refused(client, {
    box_id: BOX.stratco,
    material_stage: "sent",
    operator_email: "nobody@ops.test",
  }, terminal);
  assertEquals([stranger.status, (stranger.body as any).code], [
    400,
    "operator_required",
  ]);
  const answer = await run(client, {
    box_id: BOX.stratco,
    material_stage: "sent",
    operator_email: "SHAUN@ops.test",
  }, terminal);
  assertEquals(answer.box.set_by_email, SHAUN.email);
  assertEquals(tables.job_events[0].detail_json.via, "terminal");
  assertEquals(tables.job_events[0].user_id, null);
});

Deno.test("set: a stale screen is refused with the box as it is now", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  const error = await refused(client, {
    box_id: BOX.metroll,
    material_stage: "delivered",
    expected_set_at: null,
  });
  assertEquals([error.status, (error.body as any).code], [
    409,
    "stage_changed",
  ]);
  assertEquals((error.body as any).box.material_stage, "awaiting_payment");
  assertEquals((error.body as any).box.set_by_email, "hugo@ops.test");
  assertEquals(writes, []);
});

Deno.test("set: two presses at once, the second is refused, not overwritten", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables, {
    beforeUpdate: (t) => {
      const row = t.job_material_suppliers.find((b) => b.id === BOX.stratco)!;
      Object.assign(row, {
        material_stage: "ready",
        material_stage_set_at: "2026-10-23T02:59:00.000Z",
        material_stage_set_by_email: "hugo@ops.test",
      });
    },
  });
  const error = await refused(client, {
    box_id: BOX.stratco,
    material_stage: "delivered",
  });
  assertEquals([error.status, (error.body as any).code], [
    409,
    "stage_changed",
  ]);
  assertEquals((error.body as any).box.material_stage, "ready");
  assertEquals(boxRow(tables, BOX.stratco).material_stage, "ready");
  assertEquals(writes, []);
});

Deno.test("set: a bad request is refused before any write", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  for (
    const body of [
      null,
      { box_id: BOX.stratco },
      { box_id: BOX.stratco, material_stage: "lost" },
      { box_id: "nope", material_stage: "sent" },
      { job_id: JOB.fence, material_stage: "sent" },
      { box_id: BOX.stratco, material_stage: "sent", expected_set_at: "soon" },
    ]
  ) {
    const error = await refused(client, body);
    assertEquals(
      [error.status, (error.body as any).code],
      [400, "invalid_request"],
      JSON.stringify(body),
    );
  }
  assertEquals(writes, []);
});

Deno.test("set: another org's box is not found, and a make-safe is not Dispatch work", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  const other = await refused(client, {
    box_id: BOX.otherOrg,
    material_stage: "sent",
  });
  assertEquals([other.status, (other.body as any).code], [
    404,
    "box_not_found",
  ]);
  const makesafe = await refused(client, {
    box_id: BOX.makesafe,
    material_stage: "sent",
  });
  assertEquals([makesafe.status, (makesafe.body as any).code], [
    409,
    "not_dispatch_work",
  ]);
  assertEquals(writes, []);
});

Deno.test("set: a failed audit row does not undo the stage, and says so", async () => {
  const tables = fixture();
  const { client } = makeClient(tables, { failEvents: true });
  const answer = await run(client, {
    box_id: BOX.stratco,
    material_stage: "ready",
  });
  assertEquals(answer.success, true);
  assertEquals(answer.audit_logged, false);
  assertEquals(boxRow(tables, BOX.stratco).material_stage, "ready");
});

// ── The gate ────────────────────────────────────────────────────────────────

Deno.test("gate: staff only, on no allow-list", () => {
  const url = new URL(
    `https://example.test/functions/v1/ops-api?action=${DISPATCH_V2_SET_MATERIAL_STAGE_ACTION}`,
  );
  for (const role of ["admin", "owner", "ops_manager"]) {
    assertEquals(
      _authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role } }),
      { ok: true },
    );
  }
  for (
    const authUser of [{ role: "installer" }, {
      role: "lead_installer",
      managedVerticals: ["fencing", "patio"],
    }]
  ) {
    const call = _authorizeOpsApiAction({
      url,
      authMode: "jwt",
      authUser,
    }) as any;
    assertEquals([call.ok, call.status, call.code], [
      false,
      403,
      "operator_access_required",
    ], authUser.role);
  }
  assert(
    !AGENT_READ_ALLOWED_ACTIONS.has(DISPATCH_V2_SET_MATERIAL_STAGE_ACTION),
  );
  assert(
    !LEAD_INSTALLER_READ_ACTIONS.has(DISPATCH_V2_SET_MATERIAL_STAGE_ACTION),
  );
});

const ENV: Record<string, string> = {
  ...IMPORT_ENV,
  MAKESAFE_ROUTINE_KEY: ROUTINE_KEY,
};

Deno.test("gate: the routine key is refused, a GET is 405, and a bad id is 400 before any call", async () => {
  const saved = new Map(Object.keys(ENV).map((n) => [n, Deno.env.get(n)]));
  for (const [n, v] of Object.entries(ENV)) Deno.env.set(n, v);
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response("{}", { status: 500 }));
  }) as typeof fetch;
  const at =
    `https://example.invalid/ops-api?action=${DISPATCH_V2_SET_MATERIAL_STAGE_ACTION}`;
  const body = JSON.stringify({
    box_id: "nope",
    material_stage: "sent",
    operator_email: SHAUN.email,
  });
  try {
    const routine = await _opsApiRequestHandlerForTest(
      new Request(at, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ROUTINE_KEY,
        },
        body,
      }),
    );
    assertEquals(routine.status, 403);
    await routine.body?.cancel();
    const get = await _opsApiRequestHandlerForTest(
      new Request(at, {
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${SERVICE_KEY}`,
        },
      }),
    );
    assertEquals(get.status, 405);
    await get.body?.cancel();
    const bad = await _opsApiRequestHandlerForTest(
      new Request(at, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${SERVICE_KEY}`,
        },
        body,
      }),
    );
    assertEquals(bad.status, 400);
    await bad.body?.cancel();
    assertEquals(calls, []);
  } finally {
    globalThis.fetch = original;
    for (const [n, v] of saved) {
      if (v === undefined) Deno.env.delete(n);
      else Deno.env.set(n, v);
    }
  }
});
