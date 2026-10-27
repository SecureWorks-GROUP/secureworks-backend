// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch v2: a supplier order's delivery date set, changed or cleared by
// hand (dispatch_v2_delivery_date.ts, docs/dispatch-v2-board-contract.md
// section 3a), against an in-memory stand-in for PostgREST. The stand-in knows
// the supplier box's columns (a wrong column name is a 42703, as live) and
// keeps the board migration's three checks, so a write the database would
// refuse fails here too.
//
// Nothing is sent and nothing touches production. Job, client and supplier
// details are made up.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DISPATCH_V2_SET_DELIVERY_DATE_ACTION,
  type DispatchV2DeliveryDateContext,
  runDispatchV2DeliveryDateAction,
} from "./dispatch_v2_delivery_date.ts";
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

// The supplier box's columns (20261014130000 + 20261023160000 + 20261023214200).
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
]);

// The board migration's three checks.
function boxChecksPass(row: Row): boolean {
  const src = row.delivery_date_source;
  if (src != null && src !== "by_hand" && src !== "supplier_reply") {
    return false;
  }
  if (
    row.delivery_date != null &&
    (row.delivery_date_set_at == null || row.delivery_date_source == null)
  ) return false;
  if (
    row.delivery_date_confirmed_at != null &&
    (row.delivery_date == null || row.delivery_date_confirmed_by_email == null)
  ) return false;
  return true;
}

function emptyDate(): Row {
  return {
    delivery_date: null,
    delivery_date_source: null,
    delivery_date_set_at: null,
    delivery_date_set_by_email: null,
    delivery_date_confirmed_at: null,
    delivery_date_confirmed_by: null,
    delivery_date_confirmed_by_email: null,
  };
}

function fixture(): Record<string, Row[]> {
  return {
    jobs: [
      {
        id: JOB.fence,
        org_id: ORG,
        type: "fencing",
        status: "awaiting_supplier",
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
      {
        id: BOX.stratco,
        org_id: ORG,
        job_id: JOB.fence,
        supplier_id: SUP.stratco,
        supplier_name: "Stratco WA",
        position: 0,
        created_at: "2026-10-20T00:00:00Z",
        is_main_supplier: true,
        ...emptyDate(),
      },
      // A date already accepted from a supplier reply.
      {
        id: BOX.metroll,
        org_id: ORG,
        job_id: JOB.fence,
        supplier_id: SUP.metroll,
        supplier_name: "Metroll",
        position: 1,
        created_at: "2026-10-20T00:01:00Z",
        is_main_supplier: false,
        ...emptyDate(),
        delivery_date: "2026-10-28",
        delivery_date_source: "supplier_reply",
        delivery_date_set_at: "2026-10-22T05:00:00+00:00",
        delivery_date_set_by_email: "hugo@ops.test",
        delivery_date_confirmed_at: "2026-10-22T05:00:00+00:00",
        delivery_date_confirmed_by: uuid("d1", 2),
        delivery_date_confirmed_by_email: "hugo@ops.test",
      },
      {
        id: BOX.makesafe,
        org_id: ORG,
        job_id: JOB.makesafe,
        supplier_id: SUP.stratco,
        supplier_name: "Stratco WA",
        position: 0,
        created_at: "2026-10-20T00:00:00Z",
        is_main_supplier: false,
        ...emptyDate(),
      },
      {
        id: BOX.otherOrg,
        org_id: OTHER_ORG,
        job_id: JOB.other,
        supplier_id: SUP.stratco,
        supplier_name: "Stratco WA",
        position: 0,
        created_at: "2026-10-20T00:00:00Z",
        is_main_supplier: false,
        ...emptyDate(),
      },
    ],
    users: [
      { id: SHAUN.userId, email: SHAUN.email, org_id: ORG },
    ],
    job_events: [],
    job_assignments: [
      {
        id: "as1",
        job_id: JOB.fence,
        scheduled_date: "2026-10-30",
        scheduled_end: null,
        assignment_type: "install",
        status: "scheduled",
        is_ghost: false,
        role: null,
        confirmation_status: "tentative",
      },
    ],
    purchase_orders: [],
    // The Stratco order email went, asking for Mon 27 Oct.
    dispatch_supplier_order_emails: [
      {
        id: uuid("e1", 1),
        job_id: JOB.fence,
        supplier_id: SUP.stratco,
        status: "sent",
        sent_at: "2026-10-21T01:00:00Z",
        delivery_date: "2026-10-27",
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
          const next = { ...row, ...patch };
          if (!boxChecksPass(next)) {
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
  overrides: Partial<DispatchV2DeliveryDateContext> = {},
): DispatchV2DeliveryDateContext {
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
  runDispatchV2DeliveryDateAction(
    client,
    DISPATCH_V2_SET_DELIVERY_DATE_ACTION,
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

// ── Setting a date ──────────────────────────────────────────────────────────

Deno.test("set: a date by hand, not confirmed, is a ring on the Arrival line", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  const answer = await run(client, {
    box_id: BOX.stratco,
    delivery_date: "2026-10-29",
    confirmed: false,
  });
  assertEquals(answer.success, true);
  assertEquals(answer.job_status_changed, false);
  const box = boxRow(tables, BOX.stratco);
  assertEquals(box.delivery_date, "2026-10-29");
  assertEquals(box.delivery_date_source, "by_hand");
  assertEquals(box.delivery_date_set_at, NOW);
  assertEquals(box.delivery_date_set_by_email, SHAUN.email);
  assertEquals(box.delivery_date_confirmed_at, null);
  assertEquals(answer.box.confirmed, false);
  assertEquals(answer.box.delivery_date_source, "by_hand");
  const line = arrivalFor(answer, SUP.stratco);
  assertEquals(line.delivery_date, "2026-10-29");
  assertEquals(line.date_source, "box");
  assertEquals(line.mark, "ring");
  assertEquals(line.box_id, BOX.stratco);
  assertEquals(line.box_date_source, "by_hand");
  assertEquals(line.box_date_set_by_email, SHAUN.email);
  // One box update and one audit row. Nothing else written.
  assertEquals(writes.map((w) => `${w.kind}:${w.table}`), [
    "update:job_material_suppliers",
    "insert:job_events",
  ]);
  const event = tables.job_events[0];
  assertEquals(event.event_type, "dispatch_v2_delivery_date_set");
  assertEquals(event.user_id, SHAUN.userId);
  assertEquals(event.job_id, JOB.fence);
  assertEquals(event.detail_json.box_id, BOX.stratco);
  assertEquals(event.detail_json.supplier, "Stratco WA");
  assertEquals(event.detail_json.from, {
    delivery_date: null,
    confirmed: false,
    source: null,
  });
  assertEquals(event.detail_json.to, {
    delivery_date: "2026-10-29",
    confirmed: false,
    source: "by_hand",
  });
  assertEquals(event.detail_json.operator_email, SHAUN.email);
  assertEquals(event.detail_json.via, "screen");
  // The job is untouched.
  assertEquals(
    tables.jobs.find((j) => j.id === JOB.fence)!.status,
    "awaiting_supplier",
  );
});

Deno.test("set: Confirmed makes the date solid, named to the person", async () => {
  const tables = fixture();
  const { client } = makeClient(tables);
  const answer = await run(client, {
    box_id: BOX.stratco,
    delivery_date: "2026-10-29",
    confirmed: true,
  });
  const box = boxRow(tables, BOX.stratco);
  assertEquals(box.delivery_date_confirmed_at, NOW);
  assertEquals(box.delivery_date_confirmed_by, SHAUN.userId);
  assertEquals(box.delivery_date_confirmed_by_email, SHAUN.email);
  assertEquals(answer.box.confirmed, true);
  assertEquals(answer.box.confirmed_by_email, SHAUN.email);
  const line = arrivalFor(answer, SUP.stratco);
  assertEquals(line.mark, "solid");
  assertEquals(line.date_confirmed, true);
  assertEquals(answer.arrival.arrival.counts.confirmed, 2);
});

Deno.test("set: a date after the install is still saved, and the line flags it red", async () => {
  const tables = fixture();
  const { client } = makeClient(tables);
  const answer = await run(client, {
    box_id: BOX.stratco,
    delivery_date: "2026-11-03",
    confirmed: true,
  });
  const line = arrivalFor(answer, SUP.stratco);
  assertEquals(line.flag, "after_install");
  assertEquals(answer.arrival.arrival.all_confirmed_in_time, false);
});

Deno.test("set: by hand overrides a date accepted from a supplier reply", async () => {
  const tables = fixture();
  const { client } = makeClient(tables);
  const answer = await run(client, {
    box_id: BOX.metroll,
    delivery_date: "2026-10-29",
    confirmed: false,
  });
  const box = boxRow(tables, BOX.metroll);
  assertEquals(box.delivery_date, "2026-10-29");
  assertEquals(box.delivery_date_source, "by_hand");
  assertEquals(box.delivery_date_set_by_email, SHAUN.email);
  // Not confirmed by hand, so the reply's confirmation goes with its date.
  assertEquals(box.delivery_date_confirmed_at, null);
  assertEquals(box.delivery_date_confirmed_by, null);
  assertEquals(box.delivery_date_confirmed_by_email, null);
  const event = tables.job_events[0];
  assertEquals(event.detail_json.replaced_supplier_reply, true);
  assertEquals(event.detail_json.from, {
    delivery_date: "2026-10-28",
    confirmed: true,
    source: "supplier_reply",
  });
  assertEquals(arrivalFor(answer, SUP.metroll).box_date_source, "by_hand");
});

Deno.test("set: the same date saved again over a supplier reply is stamped as by hand", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  const answer = await run(client, {
    box_id: BOX.metroll,
    delivery_date: "2026-10-28",
    confirmed: true,
  });
  assert(!answer.unchanged);
  assertEquals(writes.length, 2);
  const box = boxRow(tables, BOX.metroll);
  assertEquals(box.delivery_date_source, "by_hand");
  assertEquals(box.delivery_date_confirmed_by_email, SHAUN.email);
});

Deno.test("set: unticking Confirmed keeps the date as a ring", async () => {
  const tables = fixture();
  const { client } = makeClient(tables);
  await run(client, {
    box_id: BOX.stratco,
    delivery_date: "2026-10-29",
    confirmed: true,
  });
  const answer = await run(client, {
    box_id: BOX.stratco,
    delivery_date: "2026-10-29",
    confirmed: false,
  });
  assertEquals(boxRow(tables, BOX.stratco).delivery_date_confirmed_at, null);
  assertEquals(arrivalFor(answer, SUP.stratco).mark, "ring");
  assertEquals(tables.job_events.length, 2);
});

Deno.test("set: the box can be named by job_id and supplier_id", async () => {
  const tables = fixture();
  const { client } = makeClient(tables);
  const answer = await run(client, {
    job_id: JOB.fence,
    supplier_id: SUP.stratco,
    delivery_date: "2026-10-29",
    confirmed: false,
  });
  assertEquals(answer.box.box_id, BOX.stratco);
  assertEquals(boxRow(tables, BOX.stratco).delivery_date, "2026-10-29");
});

// ── Clearing ────────────────────────────────────────────────────────────────

Deno.test("clear: takes the box's own date off; the line falls back to the date our email asked for", async () => {
  const tables = fixture();
  const { client } = makeClient(tables);
  await run(client, {
    box_id: BOX.stratco,
    delivery_date: "2026-10-29",
    confirmed: true,
  });
  const answer = await run(client, {
    box_id: BOX.stratco,
    delivery_date: null,
  });
  assertEquals(boxRow(tables, BOX.stratco), {
    ...boxRow(tables, BOX.stratco),
    ...emptyDate(),
  });
  assertEquals(answer.box.delivery_date, null);
  const line = arrivalFor(answer, SUP.stratco);
  assertEquals(line.delivery_date, "2026-10-27");
  assertEquals(line.date_source, "requested");
  assertEquals(line.mark, "ring");
  assertEquals(line.box_date_source, null);
  assertEquals(
    tables.job_events[1].event_type,
    "dispatch_v2_delivery_date_cleared",
  );
  assertEquals(tables.job_events[1].detail_json.to, {
    delivery_date: null,
    confirmed: false,
    source: null,
  });
});

Deno.test("clear: a supplier-reply date can be cleared too", async () => {
  const tables = fixture();
  const { client } = makeClient(tables);
  const answer = await run(client, {
    box_id: BOX.metroll,
    delivery_date: null,
    confirmed: false,
  });
  assertEquals(boxRow(tables, BOX.metroll).delivery_date, null);
  assertEquals(tables.job_events[0].detail_json.replaced_supplier_reply, true);
  // Metroll's order email never went: no date at all now.
  assertEquals(arrivalFor(answer, SUP.metroll).mark, "none");
});

// ── Nothing to do ───────────────────────────────────────────────────────────

Deno.test("unchanged: the same by-hand date and tick, or clearing an empty box, writes nothing", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  await run(client, {
    box_id: BOX.stratco,
    delivery_date: "2026-10-29",
    confirmed: true,
  });
  assertEquals(writes.length, 2);
  const again = await run(client, {
    box_id: BOX.stratco,
    delivery_date: "2026-10-29",
    confirmed: true,
  });
  assertEquals(again.unchanged, true);
  assertEquals(again.box.delivery_date, "2026-10-29");
  assert(again.arrival);
  const emptyClear = await run(makeClient(fixture()).client, {
    box_id: BOX.stratco,
    delivery_date: null,
  });
  assertEquals(emptyClear.unchanged, true);
  assertEquals(writes.length, 2);
});

// ── Refusals ────────────────────────────────────────────────────────────────

Deno.test("refuse: bad requests are 400 before any write", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  for (
    const body of [
      null,
      { box_id: BOX.stratco },
      { box_id: BOX.stratco, delivery_date: "2026-02-30", confirmed: false },
      { box_id: BOX.stratco, delivery_date: "29/10/2026", confirmed: false },
      { box_id: BOX.stratco, delivery_date: "2026-10-29" },
      { box_id: BOX.stratco, delivery_date: "2026-10-29", confirmed: "yes" },
      { box_id: BOX.stratco, delivery_date: null, confirmed: true },
      { box_id: "nope", delivery_date: "2026-10-29", confirmed: false },
      { job_id: JOB.fence, delivery_date: "2026-10-29", confirmed: false },
      {
        box_id: BOX.stratco,
        delivery_date: "2026-10-29",
        confirmed: false,
        expected_set_at: "soon",
      },
    ]
  ) {
    const err = await refused(client, body);
    assertEquals(err.status, 400, JSON.stringify(body));
    assertEquals(err.body.code, "invalid_request");
  }
  assertEquals(writes, []);
});

Deno.test("refuse: an unknown box, another organisation's box, and a make-safe job", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  const missing = await refused(client, {
    box_id: uuid("c1", 99),
    delivery_date: "2026-10-29",
    confirmed: false,
  });
  assertEquals([missing.status, missing.body.code], [404, "box_not_found"]);
  const elsewhere = await refused(client, {
    box_id: BOX.otherOrg,
    delivery_date: "2026-10-29",
    confirmed: false,
  });
  assertEquals([elsewhere.status, elsewhere.body.code], [404, "box_not_found"]);
  const makesafe = await refused(client, {
    box_id: BOX.makesafe,
    delivery_date: "2026-10-29",
    confirmed: false,
  });
  assertEquals([makesafe.status, makesafe.body.code], [
    409,
    "not_dispatch_work",
  ]);
  assertEquals(writes, []);
});

Deno.test("refuse: the ops key must name a person in users", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  const key = ctx({
    via: "terminal",
    actor: { userId: null, email: null, orgId: null },
  });
  const none = await refused(client, {
    box_id: BOX.stratco,
    delivery_date: "2026-10-29",
    confirmed: false,
  }, key);
  assertEquals([none.status, none.body.code], [400, "operator_required"]);
  const stranger = await refused(client, {
    box_id: BOX.stratco,
    delivery_date: "2026-10-29",
    confirmed: false,
    operator_email: "who@nowhere.test",
  }, key);
  assertEquals([stranger.status, stranger.body.code], [
    400,
    "operator_required",
  ]);
  assertEquals(writes, []);
  const ok = await run(client, {
    box_id: BOX.stratco,
    delivery_date: "2026-10-29",
    confirmed: true,
    operator_email: "SHAUN@ops.test",
  }, key);
  assertEquals(ok.success, true);
  const box = boxRow(tables, BOX.stratco);
  assertEquals(box.delivery_date_set_by_email, SHAUN.email);
  assertEquals(box.delivery_date_confirmed_by, null);
  assertEquals(box.delivery_date_confirmed_by_email, SHAUN.email);
  assertEquals(tables.job_events[0].user_id, null);
  assertEquals(tables.job_events[0].detail_json.via, "terminal");
});

Deno.test("refuse: a screen that showed an older date is told it changed", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  const err = await refused(client, {
    box_id: BOX.metroll,
    delivery_date: "2026-10-29",
    confirmed: false,
    expected_set_at: null,
  });
  assertEquals([err.status, err.body.code], [409, "date_changed"]);
  assertEquals((err.body.box as any).delivery_date, "2026-10-28");
  assertEquals(writes, []);
  // The stamp it did show, written another way, still matches.
  const ok = await run(client, {
    box_id: BOX.metroll,
    delivery_date: "2026-10-29",
    confirmed: false,
    expected_set_at: "2026-10-22T05:00:00.000Z",
  });
  assertEquals(ok.success, true);
});

Deno.test("refuse: a second press landing first is not quietly overwritten", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables, {
    beforeUpdate: (t) => {
      Object.assign(boxRow(t, BOX.stratco), {
        delivery_date: "2026-10-30",
        delivery_date_source: "supplier_reply",
        delivery_date_set_at: "2026-10-23T02:59:00Z",
        delivery_date_set_by_email: "hugo@ops.test",
      });
    },
  });
  const err = await refused(client, {
    box_id: BOX.stratco,
    delivery_date: "2026-10-29",
    confirmed: false,
  });
  assertEquals([err.status, err.body.code], [409, "date_changed"]);
  assertEquals((err.body.box as any).delivery_date, "2026-10-30");
  assertEquals(writes, []);
  assertEquals(tables.job_events, []);
});

Deno.test("audit: a failed job_events insert does not undo the date, and says so", async () => {
  const tables = fixture();
  const { client } = makeClient(tables, { failEvents: true });
  const answer = await run(client, {
    box_id: BOX.stratco,
    delivery_date: "2026-10-29",
    confirmed: false,
  });
  assertEquals(answer.success, true);
  assertEquals(answer.audit_logged, false);
  assertEquals(boxRow(tables, BOX.stratco).delivery_date, "2026-10-29");
});

// ── The gate ────────────────────────────────────────────────────────────────

Deno.test("gate: staff only, on no allow-list", () => {
  const url = new URL(
    `https://example.test/functions/v1/ops-api?action=${DISPATCH_V2_SET_DELIVERY_DATE_ACTION}`,
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
  assert(!AGENT_READ_ALLOWED_ACTIONS.has(DISPATCH_V2_SET_DELIVERY_DATE_ACTION));
  assert(
    !LEAD_INSTALLER_READ_ACTIONS.has(DISPATCH_V2_SET_DELIVERY_DATE_ACTION),
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
    `https://example.invalid/ops-api?action=${DISPATCH_V2_SET_DELIVERY_DATE_ACTION}`;
  const body = JSON.stringify({
    box_id: "nope",
    delivery_date: "2026-10-29",
    confirmed: false,
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
