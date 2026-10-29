// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch v2: the payment step on a supplier order (dispatch_v2_payment.ts
// for the rules, dispatch_v2_payment_write.ts for the presses,
// docs/dispatch-v2-board-contract.md section 3c), against an in-memory
// stand-in for PostgREST. The stand-in knows the supplier box's columns (a
// wrong column name is a 42703, as live) and keeps the migrations' checks, so
// a write the database would refuse fails here too.
//
// Nothing is sent and nothing touches production. Job, client and supplier
// details are made up.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchV2AccountsOf,
  dispatchV2PaymentOf,
  dispatchV2PaymentTerms,
  dispatchV2TermsFor,
} from "./dispatch_v2_payment.ts";
import {
  dispatchMaterialStageOf,
  dispatchV2BoxStage,
} from "./dispatch_v2_material_stage.ts";
import { dispatchArrival, dispatchArrivalRead } from "./dispatch_board.ts";
import {
  DISPATCH_V2_MARK_PAID_ACTION,
  DISPATCH_V2_PAYMENT_ACTIONS,
  DISPATCH_V2_SET_PAY_ON_ACTION,
  DISPATCH_V2_UNDO_PAID_ACTION,
  type DispatchV2PaymentContext,
  runDispatchV2PaymentAction,
} from "./dispatch_v2_payment_write.ts";
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
const TODAY = "2026-10-29";
const NOW = "2026-10-29T03:00:00.000Z";
type Row = Record<string, any>;

function uuid(prefix: string, n: number): string {
  return `${prefix}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
const JOB = { fence: uuid("a2", 1) };
// Stratco is on account; Lysaght pays first; Unlisted has no approved entry;
// Retired is linked to an entry that is no longer active.
const SUP = {
  stratco: uuid("b2", 1),
  lysaght: uuid("b2", 2),
  unlisted: uuid("b2", 3),
  retired: uuid("b2", 4),
};
const APPROVED = {
  stratco: uuid("e2", 1),
  lysaght: uuid("e2", 2),
  retired: uuid("e2", 3),
};
const BOX = {
  stratco: uuid("c2", 1),
  lysaght: uuid("c2", 2),
  unlisted: uuid("c2", 3),
  retired: uuid("c2", 4),
};
const EMAIL = { lysaght: uuid("f2", 1), stratco: uuid("f2", 2) };
const SENT_AT = "2026-10-28T01:00:00.000Z";
const SHAUN = { userId: uuid("d2", 1), email: "shaun@ops.test", orgId: ORG };

// The supplier box's columns (20261014130000 + 20261023160000 + 20261023214200
// + 20261028170000 + 20261029120100 + 20261029120200).
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
  "paid_at",
  "paid_by",
  "paid_by_email",
  "pay_on",
  "pay_on_set_at",
  "pay_on_set_by",
  "pay_on_set_by_email",
]);

// The migrations' checks on the box, as Postgres would keep them.
function boxChecksPass(row: Row): boolean {
  // 20261029120100: a paid stamp always says by whom.
  if ((row.paid_at == null) !== (row.paid_by_email == null)) return false;
  // 20261029120200: a Pay on tag is pickup or delivery, with when and by whom.
  if (row.pay_on != null && !["pickup", "delivery"].includes(row.pay_on)) {
    return false;
  }
  if ((row.pay_on == null) !== (row.pay_on_set_at == null)) return false;
  if ((row.pay_on == null) !== (row.pay_on_set_by_email == null)) return false;
  return true;
}

function box(
  id: string,
  supplierId: string,
  name: string,
  extra: Row = {},
): Row {
  return {
    id,
    org_id: ORG,
    job_id: JOB.fence,
    supplier_id: supplierId,
    supplier_name: name,
    position: 0,
    created_at: "2026-10-27T00:00:00Z",
    is_main_supplier: false,
    delivery_date: null,
    delivery_date_source: null,
    delivery_date_set_at: null,
    delivery_date_set_by_email: null,
    delivery_date_confirmed_at: null,
    delivery_date_confirmed_by: null,
    delivery_date_confirmed_by_email: null,
    material_stage: null,
    material_stage_set_at: null,
    material_stage_set_by_email: null,
    paid_at: null,
    paid_by: null,
    paid_by_email: null,
    pay_on: null,
    pay_on_set_at: null,
    pay_on_set_by: null,
    pay_on_set_by_email: null,
    ...extra,
  };
}

function sentEmail(id: string, supplierId: string, extra: Row = {}): Row {
  return {
    id,
    job_id: JOB.fence,
    supplier_id: supplierId,
    status: "sent",
    sent_at: SENT_AT,
    delivery_date: null,
    body_text: "Hi, please deliver the following.\nDate: \n",
    ...extra,
  };
}

function accountTables(): Record<string, Row[]> {
  return {
    dispatch_approved_supplier_emails: [
      { id: APPROVED.stratco, org_id: ORG, name: "Stratco WA", active: true, on_account: true },
      { id: APPROVED.lysaght, org_id: ORG, name: "Lysaght", active: true, on_account: false },
      // A retired entry still marked on account: retired means no link.
      { id: APPROVED.retired, org_id: ORG, name: "Old Supplier", active: false, on_account: true },
      // Another organisation's entry is never read.
      { id: uuid("e2", 9), org_id: OTHER_ORG, name: "Lysaght", active: true, on_account: true },
    ],
    dispatch_approved_supplier_email_links: [
      { supplier_id: SUP.stratco, approved_id: APPROVED.stratco, org_id: ORG },
      { supplier_id: SUP.lysaght, approved_id: APPROVED.lysaght, org_id: ORG },
      { supplier_id: SUP.retired, approved_id: APPROVED.retired, org_id: ORG },
    ],
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
        job_number: "SWF-90101",
        client_name: "Test Person",
        site_suburb: "Balcatta",
        ds_ses_family: null,
        ds_makesafe_family: null,
        ds_repair_stage: null,
      },
    ],
    job_material_suppliers: [
      box(BOX.stratco, SUP.stratco, "Stratco WA"),
      box(BOX.lysaght, SUP.lysaght, "Lysaght", { position: 1 }),
      box(BOX.unlisted, SUP.unlisted, "Corner Hardware", { position: 2 }),
      box(BOX.retired, SUP.retired, "Old Supplier", { position: 3 }),
    ],
    users: [{ id: SHAUN.userId, email: SHAUN.email, org_id: ORG }],
    job_events: [],
    job_assignments: [],
    purchase_orders: [],
    dispatch_supplier_order_emails: [
      sentEmail(EMAIL.lysaght, SUP.lysaght),
      sentEmail(EMAIL.stratco, SUP.stratco),
    ],
    job_material_lines: [],
    ...accountTables(),
  };
}

type Options = {
  fail?: string[];
  // Runs just before an update lands (a second person's press in between).
  beforeUpdate?: (tables: Record<string, Row[]>) => void;
  failEvents?: boolean;
};

// A PostgREST stand-in for the reads, the one box update and the audit
// insert the presses make. It records every write; an update of any other
// table throws. A table named in `fail` answers every call with an error, as
// a missing table or a dropped connection would.
function makeClient(tables: Record<string, Row[]>, options: Options = {}) {
  const writes: Array<{ table: string; kind: string; row: Row }> = [];
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let rowLimit: number | null = null;
    let patch: Row | null = null;
    let insertRow: Row | null = null;
    const orders: Array<[string, boolean]> = [];
    const failed = () => (options.fail || []).includes(table);

    const run = (): { data: any; error: any } => {
      if (failed()) return { data: null, error: { message: `${table} is down` } };
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
        const hits = (tables[table] || []).filter((row) =>
          filters.every((f) => f(row))
        );
        for (const row of hits) {
          if (!boxChecksPass({ ...row, ...patch })) {
            return { data: null, error: { code: "23514", message: "check violated" } };
          }
        }
        for (const row of hits) {
          Object.assign(row, patch);
          writes.push({ table, kind: "update", row: { ...row } });
        }
        return { data: hits.map((r) => ({ ...r })), error: null };
      }
      let rows = (tables[table] || []).filter((row) =>
        filters.every((f) => f(row))
      ).map((r) => ({ ...r }));
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
      eq: (c: string, v: unknown) => (filters.push((row) => row[c] === v), builder),
      neq: (c: string, v: unknown) => (filters.push((row) => row[c] !== v), builder),
      is: (c: string, v: unknown) => (filters.push((row) => (row[c] ?? null) === v), builder),
      in: (c: string, v: unknown[]) => (filters.push((row) => v.includes(row[c])), builder),
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
  overrides: Partial<DispatchV2PaymentContext> = {},
): DispatchV2PaymentContext {
  return {
    orgId: ORG,
    actor: SHAUN,
    via: "screen",
    today: TODAY,
    now: () => NOW,
    ...overrides,
  };
}

const press = (client: any, action: string, body: any, c = ctx()) =>
  runDispatchV2PaymentAction(client, action, body, c) as Promise<any>;

// A refused press: its HTTP status, its code and the rest of its body.
async function refused(client: any, action: string, body: any, c = ctx()) {
  const e = await assertRejects(
    () => press(client, action, body, c),
    DispatchMaterialsError,
  ) as DispatchMaterialsError;
  return { status: e.status, code: e.body.code, body: e.body as any };
}

function boxRow(tables: Record<string, Row[]>, id: string): Row {
  return tables.job_material_suppliers.find((b) => b.id === id)!;
}

// The parts of a payment the rules decide, for short asserts.
function paymentOf(input: Partial<Parameters<typeof dispatchV2PaymentOf>[0]>) {
  return dispatchV2PaymentOf({
    terms: "pay_first",
    paidAt: null,
    paidByEmail: null,
    newestSentAt: SENT_AT,
    storedStage: null,
    storedStageAt: null,
    ...input,
  });
}

function orderFor(arrival: any, supplierId: string) {
  return arrival.orders.find((o: any) => o.supplier_id === supplierId);
}

// ── A1: on account or pay first ─────────────────────────────────────────────

Deno.test("terms: on account only when an active entry says so; unknown when the read failed", () => {
  assertEquals(
    dispatchV2PaymentTerms({ readOk: true, linked: true, onAccount: true }),
    "on_account",
  );
  assertEquals(
    dispatchV2PaymentTerms({ readOk: true, linked: true, onAccount: false }),
    "pay_first",
  );
  // Not linked to the approved list at all: pay first, so nothing slips past.
  assertEquals(
    dispatchV2PaymentTerms({ readOk: true, linked: false, onAccount: null }),
    "pay_first",
  );
  assertEquals(
    dispatchV2PaymentTerms({ readOk: false, linked: true, onAccount: true }),
    "unknown",
  );
});

Deno.test("terms: the account list maps each linked supplier; a retired entry is no link", () => {
  const t = accountTables();
  const accounts = dispatchV2AccountsOf(
    t.dispatch_approved_supplier_email_links,
    t.dispatch_approved_supplier_emails.filter((e) => e.org_id === ORG),
  );
  assertEquals(accounts.readOk, true);
  assertEquals(dispatchV2TermsFor(accounts, SUP.stratco), "on_account");
  assertEquals(dispatchV2TermsFor(accounts, SUP.lysaght), "pay_first");
  assertEquals(dispatchV2TermsFor(accounts, SUP.unlisted), "pay_first");
  assertEquals(dispatchV2TermsFor(accounts, SUP.retired), "pay_first");
  // Either read failed, or never read: unknown for everyone.
  assertEquals(
    dispatchV2TermsFor(dispatchV2AccountsOf(null, []), SUP.stratco),
    "unknown",
  );
  assertEquals(
    dispatchV2TermsFor(dispatchV2AccountsOf([], null), SUP.lysaght),
    "unknown",
  );
  assertEquals(dispatchV2TermsFor(null, SUP.stratco), "unknown");
});

Deno.test("terms: the box helper carries the terms and leaves the stage as before", () => {
  const view = dispatchV2BoxStage({
    box: box(BOX.lysaght, SUP.lysaght, "Lysaght"),
    emails: [sentEmail(EMAIL.lysaght, SUP.lysaght)],
    lines: [],
    terms: "pay_first",
    installDay: null,
  });
  assertEquals(view.key, "sent");
  assertEquals(view.source, "worked_out");
  assertEquals(view.payment.terms, "pay_first");
  assertEquals(view.newest_sent?.id, EMAIL.lysaght);
  // Left out: unknown (today's rule).
  const plain = dispatchV2BoxStage({
    box: box(BOX.lysaght, SUP.lysaght, "Lysaght"),
    emails: [],
    lines: [],
  });
  assertEquals(plain.payment.terms, "unknown");
  assertEquals(plain.key, "order_materials");
});

Deno.test("terms: the Arrival line shows each box's terms; a purchase order has no payment", () => {
  const t = fixture();
  const arrival = dispatchArrival({
    boxes: t.job_material_suppliers,
    orders: [{
      id: "po1",
      job_id: JOB.fence,
      supplier_id: null,
      supplier_name: "Xero order",
      source: "xero",
      status: "sent",
      po_type: "material",
      created_at: "2026-10-20T00:00:00Z",
    }],
    sentEmails: t.dispatch_supplier_order_emails,
    lines: [],
    installDay: null,
    today: TODAY,
    accounts: dispatchV2AccountsOf(
      t.dispatch_approved_supplier_email_links,
      t.dispatch_approved_supplier_emails.filter((e) => e.org_id === ORG),
    ),
  });
  assertEquals(orderFor(arrival, SUP.stratco).payment.terms, "on_account");
  assertEquals(orderFor(arrival, SUP.lysaght).payment.terms, "pay_first");
  assertEquals(orderFor(arrival, SUP.unlisted).payment.terms, "pay_first");
  assertEquals(orderFor(arrival, SUP.retired).payment.terms, "pay_first");
  const po = arrival.orders.find((o) => o.key === "po:po1")!;
  assertEquals(po.payment, null);
});

Deno.test("terms: dispatch_arrival reads the account list for its organisation and says so", async () => {
  const { client } = makeClient(fixture());
  const answer: any = await dispatchArrivalRead(client, JOB.fence, ORG, TODAY);
  assertEquals(answer.accounts_read, "ok");
  assertEquals(answer.arrival_read, "ok");
  assertEquals(orderFor(answer.arrival, SUP.stratco).payment.terms, "on_account");
  // Another organisation's on-account Lysaght entry is never read.
  assertEquals(orderFor(answer.arrival, SUP.lysaght).payment.terms, "pay_first");
});

Deno.test("terms: a failed account read gives unknown terms and never blanks the Arrival line", async () => {
  for (
    const table of [
      "dispatch_approved_supplier_emails",
      "dispatch_approved_supplier_email_links",
    ]
  ) {
    const { client } = makeClient(fixture(), { fail: [table] });
    const answer: any = await dispatchArrivalRead(client, JOB.fence, ORG, TODAY);
    assertEquals(answer.accounts_read, "failed");
    assertEquals(answer.arrival_read, "ok");
    assert(answer.arrival.orders.length === 4);
    for (const order of answer.arrival.orders) {
      assertEquals(order.payment.terms, "unknown");
    }
    // Today's stage, unchanged.
    assertEquals(orderFor(answer.arrival, SUP.lysaght).material_stage, "sent");
  }
});

// ── A2: Mark paid and Undo paid ─────────────────────────────────────────────

const PAID_AT = "2026-10-28T05:00:00.000Z";
const BEFORE_SEND = "2026-10-27T05:00:00.000Z";

Deno.test("paid: a pay-first box with no stamp is unpaid and holds the job up", () => {
  const p = paymentOf({});
  assertEquals(p.state, "unpaid");
  assertEquals(p.paid, false);
  assertEquals(p.blocks_job_move, true);
  assertEquals(p.can_mark_paid, true);
  assertEquals(p.can_undo_paid, false);
  assertEquals(p.guard, { paid_at: null, pay_on_set_at: null });
  // A delivered box never holds the job up.
  assertEquals(paymentOf({ materialStage: "delivered" }).blocks_job_move, false);
});

Deno.test("paid: a stamp after the newest send counts for the current order", () => {
  const p = paymentOf({ paidAt: PAID_AT, paidByEmail: SHAUN.email });
  assertEquals(p.state, "paid");
  assertEquals([p.paid, p.paid_at, p.paid_by_email], [true, PAID_AT, SHAUN.email]);
  assertEquals(p.earlier_order_paid_at, null);
  assertEquals([p.blocks_job_move, p.can_mark_paid, p.can_undo_paid], [false, false, true]);
  assertEquals(p.guard, { paid_at: PAID_AT, pay_on_set_at: null });
});

Deno.test("paid: a stamp from before the newest send is an earlier order's", () => {
  const p = paymentOf({ paidAt: BEFORE_SEND, paidByEmail: SHAUN.email });
  assertEquals(p.state, "unpaid");
  assertEquals(p.paid, false);
  assertEquals(p.earlier_order_paid_at, BEFORE_SEND);
  assertEquals(p.can_mark_paid, true);
  // The guard is the raw stamp, so Mark paid again guards on what is stored.
  assertEquals(p.guard, { paid_at: BEFORE_SEND, pay_on_set_at: null });
  // The same moment as the send does not count either.
  assertEquals(paymentOf({ paidAt: SENT_AT, paidByEmail: SHAUN.email }).paid, false);
});

Deno.test("paid: picking Awaiting payment by hand after the stamp re-opens it", () => {
  const p = paymentOf({
    paidAt: PAID_AT,
    paidByEmail: SHAUN.email,
    storedStage: "awaiting_payment",
    storedStageAt: "2026-10-28T06:00:00.000Z",
  });
  assertEquals([p.state, p.paid], ["unpaid", false]);
  // A hand pick of any other stage leaves the stamp counting.
  const other = paymentOf({
    paidAt: PAID_AT,
    paidByEmail: SHAUN.email,
    storedStage: "ready",
    storedStageAt: "2026-10-28T06:00:00.000Z",
  });
  assertEquals(other.paid, true);
});

Deno.test("paid: on account needs no payment; unknown terms say so", () => {
  const onAccount = paymentOf({ terms: "on_account" });
  assertEquals(onAccount.state, "not_needed");
  assertEquals([onAccount.blocks_job_move, onAccount.can_mark_paid], [false, false]);
  const unknown = paymentOf({ terms: "unknown" });
  assertEquals(unknown.state, "unknown");
  assertEquals([unknown.blocks_job_move, unknown.can_mark_paid], [false, true]);
});

Deno.test("paid: the stage shows Order confirmed from the payment, unless something newer happened", () => {
  const paid = paymentOf({ paidAt: PAID_AT, paidByEmail: SHAUN.email });
  const base = {
    stored: null,
    storedAt: null,
    sentAts: [SENT_AT],
    unsentLineChanges: [],
    confirmedAt: null,
  };
  assertEquals(dispatchMaterialStageOf({ ...base, payment: paid }), {
    key: "order_confirmed",
    source: "payment",
  });
  // Unpaid: the send stands.
  assertEquals(dispatchMaterialStageOf({ ...base, payment: paymentOf({}) }), {
    key: "sent",
    source: "worked_out",
  });
  // A person's later pick beats the payment.
  assertEquals(
    dispatchMaterialStageOf({
      ...base,
      stored: "ready",
      storedAt: "2026-10-28T07:00:00.000Z",
      payment: paid,
    }),
    { key: "ready", source: "set" },
  );
  // A new order sent after the stamp: the stamp is the earlier order's.
  const view = dispatchV2BoxStage({
    box: box(BOX.lysaght, SUP.lysaght, "Lysaght", {
      paid_at: PAID_AT,
      paid_by_email: SHAUN.email,
    }),
    emails: [
      sentEmail(EMAIL.lysaght, SUP.lysaght),
      sentEmail(uuid("f2", 3), SUP.lysaght, { sent_at: "2026-10-28T08:00:00.000Z" }),
    ],
    lines: [],
    terms: "pay_first",
  });
  assertEquals([view.key, view.source], ["sent", "worked_out"]);
  assertEquals(view.payment.earlier_order_paid_at, PAID_AT);
  assertEquals(view.payment.state, "unpaid");
});

Deno.test("paid: Mark paid stamps the box, logs the press and moves it to Order confirmed", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  const answer = await press(client, DISPATCH_V2_MARK_PAID_ACTION, {
    box_id: BOX.lysaght,
    expected_paid_at: null,
  });
  assertEquals(answer.success, true);
  assertEquals(answer.unchanged, false);
  assertEquals(answer.job_status_changed, false);
  assertEquals("audit_logged" in answer, false);
  const row = boxRow(tables, BOX.lysaght);
  assertEquals([row.paid_at, row.paid_by, row.paid_by_email], [NOW, SHAUN.userId, SHAUN.email]);
  assertEquals(answer.box.material_stage, "order_confirmed");
  assertEquals(answer.box.payment.state, "paid");
  assertEquals(orderFor(answer.arrival.arrival, SUP.lysaght).material_stage_source, "payment");
  // One box update and one audit line, nothing else.
  assertEquals(writes.map((w) => `${w.kind}:${w.table}`), [
    "update:job_material_suppliers",
    "insert:job_events",
  ]);
  const event = tables.job_events[0];
  assertEquals(event.event_type, "dispatch_v2_marked_paid");
  assertEquals(event.user_id, SHAUN.userId);
  assertEquals(event.detail_json, {
    box_id: BOX.lysaght,
    supplier_id: SUP.lysaght,
    supplier: "Lysaght",
    order_email_id: EMAIL.lysaght,
    replaced_paid_at: null,
    had_date: false,
    stage_before: "sent",
    stage_after: "order_confirmed",
    via: "screen",
    operator_email: SHAUN.email,
  });
  assertEquals(tables.jobs[0].status, "awaiting_supplier");

  // A second press: already paid, nothing written.
  const again = await press(client, DISPATCH_V2_MARK_PAID_ACTION, { box_id: BOX.lysaght });
  assertEquals(again.unchanged, true);
  assertEquals(writes.length, 2);
});

Deno.test("paid: Mark paid over an earlier order's stamp replaces it and says so", async () => {
  const tables = fixture();
  Object.assign(boxRow(tables, BOX.lysaght), {
    paid_at: BEFORE_SEND,
    paid_by_email: "old@ops.test",
  });
  const { client } = makeClient(tables);
  const answer = await press(client, DISPATCH_V2_MARK_PAID_ACTION, {
    box_id: BOX.lysaght,
    expected_paid_at: BEFORE_SEND,
  });
  assertEquals(answer.unchanged, false);
  assertEquals(boxRow(tables, BOX.lysaght).paid_at, NOW);
  assertEquals(tables.job_events[0].detail_json.replaced_paid_at, BEFORE_SEND);
});

Deno.test("paid: an on-account box is refused with no write", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  const e = await refused(client, DISPATCH_V2_MARK_PAID_ACTION, { box_id: BOX.stratco });
  assertEquals([e.status, e.code], [409, "on_account"]);
  assertEquals(writes, []);
});

Deno.test("paid: a guard that no longer matches is refused with the box as it is now", async () => {
  const tables = fixture();
  Object.assign(boxRow(tables, BOX.lysaght), {
    paid_at: PAID_AT,
    paid_by_email: "someone@ops.test",
  });
  const { client, writes } = makeClient(tables);
  const e: any = await refused(client, DISPATCH_V2_MARK_PAID_ACTION, {
    box_id: BOX.lysaght,
    expected_paid_at: null,
  });
  assertEquals([e.status, e.code], [409, "paid_changed"]);
  assertEquals(e.body.box.payment.paid_at, PAID_AT);
  assertEquals(writes, []);
});

Deno.test("paid: a failed account read refuses the press before any write", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables, {
    fail: ["dispatch_approved_supplier_emails"],
  });
  const e = await refused(client, DISPATCH_V2_MARK_PAID_ACTION, { box_id: BOX.lysaght });
  assertEquals([e.status, e.code], [500, "dispatch_read_failed"]);
  assertEquals(writes, []);
});

Deno.test("paid: a second press landing first is refused, not overwritten", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables, {
    beforeUpdate: (t) =>
      Object.assign(t.job_material_suppliers.find((b) => b.id === BOX.lysaght)!, {
        paid_at: "2026-10-29T02:59:00.000Z",
        paid_by_email: "other@ops.test",
      }),
  });
  const e = await refused(client, DISPATCH_V2_MARK_PAID_ACTION, { box_id: BOX.lysaght });
  assertEquals([e.status, e.code], [409, "paid_changed"]);
  assertEquals(boxRow(tables, BOX.lysaght).paid_by_email, "other@ops.test");
  assertEquals(writes.filter((w) => w.table === "job_events"), []);
});

Deno.test("paid: a failed audit insert keeps the write and says audit_logged false", async () => {
  const tables = fixture();
  const { client } = makeClient(tables, { failEvents: true });
  const answer = await press(client, DISPATCH_V2_MARK_PAID_ACTION, { box_id: BOX.lysaght });
  assertEquals(answer.success, true);
  assertEquals(answer.audit_logged, false);
  assertEquals(boxRow(tables, BOX.lysaght).paid_at, NOW);
});

Deno.test("paid: the ops key names its person by operator_email", async () => {
  const tables = fixture();
  const { client } = makeClient(tables);
  const terminal = ctx({
    via: "terminal",
    actor: { userId: null, email: null, orgId: null },
  });
  const missing = await refused(
    client,
    DISPATCH_V2_MARK_PAID_ACTION,
    { box_id: BOX.lysaght },
    terminal,
  );
  assertEquals([missing.status, missing.code], [400, "operator_required"]);
  const stranger = await refused(client, DISPATCH_V2_MARK_PAID_ACTION, {
    box_id: BOX.lysaght,
    operator_email: "nobody@ops.test",
  }, terminal);
  assertEquals([stranger.status, stranger.code], [400, "operator_required"]);
  const answer = await press(client, DISPATCH_V2_MARK_PAID_ACTION, {
    box_id: BOX.lysaght,
    operator_email: "SHAUN@ops.test",
  }, terminal);
  assertEquals(answer.unchanged, false);
  const row = boxRow(tables, BOX.lysaght);
  assertEquals([row.paid_by, row.paid_by_email], [null, SHAUN.email]);
  assertEquals(tables.job_events[0].detail_json.via, "terminal");
});

Deno.test("paid: bad requests and boxes off the job are refused", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  const bad = await refused(client, DISPATCH_V2_MARK_PAID_ACTION, { box_id: "nope" });
  assertEquals([bad.status, bad.code], [400, "invalid_request"]);
  const guard = await refused(client, DISPATCH_V2_MARK_PAID_ACTION, {
    box_id: BOX.lysaght,
    expected_paid_at: "yesterday",
  });
  assertEquals(guard.status, 400);
  const missing = await refused(client, DISPATCH_V2_MARK_PAID_ACTION, {
    box_id: uuid("c2", 99),
  });
  assertEquals([missing.status, missing.code], [404, "box_not_found"]);
  const unknown = await refused(client, "dispatch_v2_pay_everyone", {
    box_id: BOX.lysaght,
  });
  assertEquals(unknown.status, 400);
  assertEquals(writes, []);
});

Deno.test("paid: Undo paid needs the stamp it undoes, takes it off and logs it", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  await press(client, DISPATCH_V2_MARK_PAID_ACTION, { box_id: BOX.lysaght });
  const noGuard = await refused(client, DISPATCH_V2_UNDO_PAID_ACTION, {
    box_id: BOX.lysaght,
  });
  assertEquals([noGuard.status, noGuard.code], [400, "invalid_request"]);
  const wrong = await refused(client, DISPATCH_V2_UNDO_PAID_ACTION, {
    box_id: BOX.lysaght,
    expected_paid_at: PAID_AT,
  });
  assertEquals([wrong.status, wrong.code], [409, "paid_changed"]);
  const answer = await press(client, DISPATCH_V2_UNDO_PAID_ACTION, {
    box_id: BOX.lysaght,
    expected_paid_at: NOW,
  });
  assertEquals(answer.unchanged, false);
  const row = boxRow(tables, BOX.lysaght);
  assertEquals([row.paid_at, row.paid_by, row.paid_by_email], [null, null, null]);
  assertEquals(answer.box.material_stage, "sent");
  assertEquals(answer.box.payment.state, "unpaid");
  const event = tables.job_events[1];
  assertEquals(event.event_type, "dispatch_v2_paid_undone");
  assertEquals(event.detail_json, {
    box_id: BOX.lysaght,
    supplier_id: SUP.lysaght,
    supplier: "Lysaght",
    undone_paid_at: NOW,
    undone_paid_by_email: SHAUN.email,
    stage_before: "order_confirmed",
    stage_after: "sent",
    via: "screen",
    operator_email: SHAUN.email,
  });
  assertEquals(writes.length, 4);
  // Nothing left to undo.
  const again = await press(client, DISPATCH_V2_UNDO_PAID_ACTION, {
    box_id: BOX.lysaght,
    expected_paid_at: null,
  });
  assertEquals(again.unchanged, true);
  assertEquals(writes.length, 4);
});

Deno.test("paid gate: staff only, on no allow-list", () => {
  for (const action of DISPATCH_V2_PAYMENT_ACTIONS) {
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
      ], `${action} ${authUser.role}`);
    }
    assert(!AGENT_READ_ALLOWED_ACTIONS.has(action));
    assert(!LEAD_INSTALLER_READ_ACTIONS.has(action));
  }
});

const ENV: Record<string, string> = {
  ...IMPORT_ENV,
  MAKESAFE_ROUTINE_KEY: ROUTINE_KEY,
};

Deno.test("paid gate: the routine key is refused, a GET is 405, and a bad id is 400 before any call", async () => {
  const saved = new Map(Object.keys(ENV).map((n) => [n, Deno.env.get(n)]));
  for (const [n, v] of Object.entries(ENV)) Deno.env.set(n, v);
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response("{}", { status: 500 }));
  }) as typeof fetch;
  try {
    for (const action of DISPATCH_V2_PAYMENT_ACTIONS) {
      const at = `https://example.invalid/ops-api?action=${action}`;
      const body = JSON.stringify({
        box_id: "nope",
        expected_paid_at: null,
        operator_email: SHAUN.email,
      });
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
      assertEquals(routine.status, 403, action);
      await routine.body?.cancel();
      const get = await _opsApiRequestHandlerForTest(
        new Request(at, {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${SERVICE_KEY}`,
          },
        }),
      );
      assertEquals(get.status, 405, action);
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
      assertEquals(bad.status, 400, action);
      await bad.body?.cancel();
    }
    assertEquals(calls, []);
  } finally {
    globalThis.fetch = original;
    for (const [n, v] of saved) {
      if (v === undefined) Deno.env.delete(n);
      else Deno.env.set(n, v);
    }
  }
});

// ── A3: Pay on pickup or delivery ───────────────────────────────────────────

const TAGGED_AT = "2026-10-28T04:00:00.000Z";

Deno.test("pay on: a tag after the newest send counts and confirms the order without paying", () => {
  const p = paymentOf({
    payOn: "pickup",
    payOnSetAt: TAGGED_AT,
    payOnSetByEmail: SHAUN.email,
  });
  assertEquals(p.state, "pay_on_pickup");
  assertEquals([p.pay_on, p.pay_on_set_at, p.pay_on_set_by_email], [
    "pickup",
    TAGGED_AT,
    SHAUN.email,
  ]);
  assertEquals(p.paid, false);
  // Not unpaid, so it never holds the job up; Mark paid is still offered.
  assertEquals([p.blocks_job_move, p.can_mark_paid, p.can_set_pay_on], [
    false,
    true,
    true,
  ]);
  assertEquals(p.guard, { paid_at: null, pay_on_set_at: TAGGED_AT });
  assertEquals(
    paymentOf({
      payOn: "delivery",
      payOnSetAt: TAGGED_AT,
      payOnSetByEmail: SHAUN.email,
    }).state,
    "pay_on_delivery",
  );
});

Deno.test("pay on: paid wins when both count, and both stamps are kept", () => {
  const p = paymentOf({
    paidAt: PAID_AT,
    paidByEmail: SHAUN.email,
    payOn: "pickup",
    payOnSetAt: TAGGED_AT,
    payOnSetByEmail: SHAUN.email,
  });
  assertEquals(p.state, "paid");
  assertEquals([p.paid_at, p.pay_on], [PAID_AT, "pickup"]);
});

Deno.test("pay on: a tag from before the newest send is an earlier order's", () => {
  const p = paymentOf({
    payOn: "pickup",
    payOnSetAt: BEFORE_SEND,
    payOnSetByEmail: SHAUN.email,
  });
  assertEquals(p.state, "unpaid");
  assertEquals(p.pay_on, null);
  assertEquals(p.earlier_order_pay_on_set_at, BEFORE_SEND);
  assertEquals(p.guard.pay_on_set_at, BEFORE_SEND);
  // Anything other than pickup or delivery is no tag.
  assertEquals(
    paymentOf({
      payOn: "later",
      payOnSetAt: TAGGED_AT,
      payOnSetByEmail: SHAUN.email,
    }).pay_on,
    null,
  );
});

Deno.test("pay on: allowed on account, where it shows the tag instead of not needed", () => {
  const p = paymentOf({
    terms: "on_account",
    payOn: "delivery",
    payOnSetAt: TAGGED_AT,
    payOnSetByEmail: SHAUN.email,
  });
  assertEquals(p.state, "pay_on_delivery");
  assertEquals([p.can_mark_paid, p.can_set_pay_on], [false, true]);
});

Deno.test("pay on: the stage shows Order confirmed from the tag; the payment step never moves a box back", () => {
  const base = {
    stored: null,
    storedAt: null,
    sentAts: [SENT_AT],
    unsentLineChanges: [],
    confirmedAt: null,
  };
  const tagged = paymentOf({
    payOn: "pickup",
    payOnSetAt: TAGGED_AT,
    payOnSetByEmail: SHAUN.email,
  });
  assertEquals(dispatchMaterialStageOf({ ...base, payment: tagged }), {
    key: "order_confirmed",
    source: "payment",
  });
  // Materials ready picked after the tag; Mark paid pressed later on the day
  // of pickup: the box stays at Materials ready.
  const both = paymentOf({
    paidAt: "2026-10-28T09:00:00.000Z",
    paidByEmail: SHAUN.email,
    payOn: "pickup",
    payOnSetAt: TAGGED_AT,
    payOnSetByEmail: SHAUN.email,
    storedStage: "ready",
    storedStageAt: "2026-10-28T06:00:00.000Z",
  });
  assertEquals(
    dispatchMaterialStageOf({
      ...base,
      stored: "ready",
      storedAt: "2026-10-28T06:00:00.000Z",
      payment: both,
    }),
    { key: "ready", source: "set" },
  );
});

Deno.test("pay on: setting the tag writes it, logs it and confirms the order; the same tag again writes nothing", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  const answer = await press(client, DISPATCH_V2_SET_PAY_ON_ACTION, {
    box_id: BOX.lysaght,
    pay_on: "pickup",
    expected_set_at: null,
  });
  assertEquals(answer.unchanged, false);
  assertEquals(answer.job_status_changed, false);
  const row = boxRow(tables, BOX.lysaght);
  assertEquals(
    [row.pay_on, row.pay_on_set_at, row.pay_on_set_by, row.pay_on_set_by_email],
    ["pickup", NOW, SHAUN.userId, SHAUN.email],
  );
  assertEquals(answer.box.material_stage, "order_confirmed");
  assertEquals(answer.box.payment.state, "pay_on_pickup");
  assertEquals(writes.map((w) => `${w.kind}:${w.table}`), [
    "update:job_material_suppliers",
    "insert:job_events",
  ]);
  const event = tables.job_events[0];
  assertEquals(event.event_type, "dispatch_v2_pay_on_set");
  assertEquals(event.detail_json, {
    box_id: BOX.lysaght,
    supplier_id: SUP.lysaght,
    supplier: "Lysaght",
    from: null,
    to: "pickup",
    order_email_id: EMAIL.lysaght,
    stage_before: "sent",
    stage_after: "order_confirmed",
    via: "screen",
    operator_email: SHAUN.email,
  });
  const again = await press(client, DISPATCH_V2_SET_PAY_ON_ACTION, {
    box_id: BOX.lysaght,
    pay_on: "pickup",
  });
  assertEquals(again.unchanged, true);
  assertEquals(writes.length, 2);
  assertEquals(tables.jobs[0].status, "awaiting_supplier");
});

Deno.test("pay on: Mark paid can still be pressed later, and both stamps stay", async () => {
  const tables = fixture();
  const { client } = makeClient(tables);
  await press(client, DISPATCH_V2_SET_PAY_ON_ACTION, {
    box_id: BOX.lysaght,
    pay_on: "delivery",
  });
  const later = ctx({ now: () => "2026-10-29T04:00:00.000Z" });
  const answer = await press(
    client,
    DISPATCH_V2_MARK_PAID_ACTION,
    { box_id: BOX.lysaght },
    later,
  );
  assertEquals(answer.unchanged, false);
  assertEquals(answer.box.payment.state, "paid");
  assertEquals(answer.box.payment.pay_on, "delivery");
  assertEquals(answer.box.material_stage, "order_confirmed");
  const row = boxRow(tables, BOX.lysaght);
  assertEquals([row.pay_on, row.paid_at], ["delivery", "2026-10-29T04:00:00.000Z"]);
});

Deno.test("pay on: allowed on an on-account box, and without the account list", async () => {
  const tables = fixture();
  const { client } = makeClient(tables, {
    fail: ["dispatch_approved_supplier_emails"],
  });
  const answer = await press(client, DISPATCH_V2_SET_PAY_ON_ACTION, {
    box_id: BOX.stratco,
    pay_on: "delivery",
  });
  assertEquals(answer.unchanged, false);
  assertEquals(boxRow(tables, BOX.stratco).pay_on, "delivery");
  assertEquals(answer.box.material_stage, "order_confirmed");
});

Deno.test("pay on: switching the tag, and taking it off, each log what changed", async () => {
  const tables = fixture();
  const { client } = makeClient(tables);
  await press(client, DISPATCH_V2_SET_PAY_ON_ACTION, {
    box_id: BOX.lysaght,
    pay_on: "pickup",
  });
  const switched = await press(client, DISPATCH_V2_SET_PAY_ON_ACTION, {
    box_id: BOX.lysaght,
    pay_on: "delivery",
    expected_set_at: NOW,
  }, ctx({ now: () => "2026-10-29T03:30:00.000Z" }));
  assertEquals(switched.box.payment.state, "pay_on_delivery");
  assertEquals(tables.job_events[1].detail_json.from, "pickup");
  assertEquals(tables.job_events[1].detail_json.to, "delivery");

  const cleared = await press(client, DISPATCH_V2_SET_PAY_ON_ACTION, {
    box_id: BOX.lysaght,
    pay_on: null,
    expected_set_at: "2026-10-29T03:30:00.000Z",
  });
  assertEquals(cleared.unchanged, false);
  const row = boxRow(tables, BOX.lysaght);
  assertEquals(
    [row.pay_on, row.pay_on_set_at, row.pay_on_set_by, row.pay_on_set_by_email],
    [null, null, null, null],
  );
  assertEquals(cleared.box.material_stage, "sent");
  const event = tables.job_events[2];
  assertEquals(event.event_type, "dispatch_v2_pay_on_cleared");
  assertEquals([event.detail_json.from, event.detail_json.to], ["delivery", null]);
  assertEquals(
    [event.detail_json.stage_before, event.detail_json.stage_after],
    ["order_confirmed", "sent"],
  );

  // No tag to take off: nothing written.
  const empty = await press(client, DISPATCH_V2_SET_PAY_ON_ACTION, {
    box_id: BOX.lysaght,
    pay_on: null,
  });
  assertEquals(empty.unchanged, true);
  assertEquals(tables.job_events.length, 3);
});

Deno.test("pay on: a bad value is refused, and a changed tag is refused with the box as it is now", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  const missing = await refused(client, DISPATCH_V2_SET_PAY_ON_ACTION, {
    box_id: BOX.lysaght,
  });
  assertEquals([missing.status, missing.code], [400, "invalid_request"]);
  const bad = await refused(client, DISPATCH_V2_SET_PAY_ON_ACTION, {
    box_id: BOX.lysaght,
    pay_on: "later",
  });
  assertEquals([bad.status, bad.code], [400, "invalid_request"]);
  Object.assign(boxRow(tables, BOX.lysaght), {
    pay_on: "pickup",
    pay_on_set_at: TAGGED_AT,
    pay_on_set_by_email: "someone@ops.test",
  });
  const changed = await refused(client, DISPATCH_V2_SET_PAY_ON_ACTION, {
    box_id: BOX.lysaght,
    pay_on: "delivery",
    expected_set_at: null,
  });
  assertEquals([changed.status, changed.code], [409, "pay_on_changed"]);
  assertEquals(changed.body.box.payment.pay_on, "pickup");
  assertEquals(writes, []);
});
