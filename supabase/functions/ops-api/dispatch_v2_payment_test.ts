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
  dispatchV2ReplyStage,
  dispatchV2ReplyTiedToOrder,
  dispatchV2TermsFor,
} from "./dispatch_v2_payment.ts";
import {
  dispatchV2BuildEmail,
  dispatchV2DateModeOf,
  dispatchV2DateModeParam,
  dispatchV2EmptyDetailLines,
} from "./dispatch_v2_emails.ts";
import {
  dispatchMaterialStageLabelFor,
  dispatchMaterialStageOf,
  dispatchMaterialTodo,
  dispatchMaterialWaitingOn,
  dispatchShortDay,
  dispatchV2BoxDateMode,
  dispatchV2BoxStage,
} from "./dispatch_v2_material_stage.ts";
import {
  dispatchArrival,
  dispatchArrivalRead,
  dispatchPaymentHold,
} from "./dispatch_board.ts";
import { postgrestDispatchRepliesSources } from "./dispatch_v2_replies_sources.ts";
import {
  DISPATCH_V2_MARK_PAID_ACTION,
  DISPATCH_V2_PAYMENT_ACTIONS,
  DISPATCH_V2_SET_DATE_MODE_ACTION,
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
  "order_date_mode",
  "order_date_mode_set_at",
  "order_date_mode_set_by_email",
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
    order_date_mode: null,
    order_date_mode_set_at: null,
    order_date_mode_set_by_email: null,
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
    held_by_payment: false,
  });
  // Unpaid: the send stands.
  assertEquals(dispatchMaterialStageOf({ ...base, payment: paymentOf({}) }), {
    key: "sent",
    source: "worked_out",
    held_by_payment: false,
  });
  // A person's later pick beats the payment.
  assertEquals(
    dispatchMaterialStageOf({
      ...base,
      stored: "ready",
      storedAt: "2026-10-28T07:00:00.000Z",
      payment: paid,
    }),
    { key: "ready", source: "set", held_by_payment: false },
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

// Every press on a supplier box this module runs: the payment step and the
// date choice (piece C) share one gate.
const BOX_PRESS_ACTIONS = [
  ...DISPATCH_V2_PAYMENT_ACTIONS,
  DISPATCH_V2_SET_DATE_MODE_ACTION,
];

Deno.test("paid gate: staff only, on no allow-list", () => {
  for (const action of BOX_PRESS_ACTIONS) {
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
    for (const action of BOX_PRESS_ACTIONS) {
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
    held_by_payment: false,
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
    { key: "ready", source: "set", held_by_payment: false },
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

// ── A4: the payment gate on a confirmed date ────────────────────────────────

const CONFIRMED_AT = "2026-10-28T03:00:00.000Z";

function confirmedBox(extra: Row = {}): Row {
  return box(BOX.lysaght, SUP.lysaght, "Lysaght", {
    delivery_date: "2026-11-05",
    delivery_date_set_at: CONFIRMED_AT,
    delivery_date_confirmed_at: CONFIRMED_AT,
    ...extra,
  });
}

Deno.test("gate: a confirmed date on an unpaid pay-first box lifts it only to Awaiting payment", () => {
  const view = dispatchV2BoxStage({
    box: confirmedBox(),
    emails: [sentEmail(EMAIL.lysaght, SUP.lysaght)],
    lines: [],
    terms: "pay_first",
  });
  assertEquals([view.key, view.source], ["awaiting_payment", "worked_out"]);
  assertEquals(view.held_by_payment, true);
  // The date stays saved and shown.
  assertEquals([view.box_date, view.box_date_confirmed], ["2026-11-05", true]);
  assertEquals(view.payment.holds_stage, true);
  assertEquals(view.todo, "Pay Lysaght");
  assertEquals(view.waiting_on, "us");
});

Deno.test("gate: on account, paid, Pay on or unknown terms lift to Order confirmed as before", () => {
  const sent = [sentEmail(EMAIL.lysaght, SUP.lysaght)];
  for (const terms of ["on_account", "unknown"] as const) {
    const view = dispatchV2BoxStage({ box: confirmedBox(), emails: sent, lines: [], terms });
    assertEquals([view.key, view.payment.holds_stage], ["order_confirmed", false], terms);
  }
  const paid = dispatchV2BoxStage({
    box: confirmedBox({ paid_at: PAID_AT, paid_by_email: SHAUN.email }),
    emails: sent,
    lines: [],
    terms: "pay_first",
  });
  assertEquals([paid.key, paid.payment.holds_stage], ["order_confirmed", false]);
  const tagged = dispatchV2BoxStage({
    box: confirmedBox({
      pay_on: "delivery",
      pay_on_set_at: TAGGED_AT,
      pay_on_set_by_email: SHAUN.email,
    }),
    emails: sent,
    lines: [],
    terms: "pay_first",
  });
  assertEquals([tagged.key, tagged.payment.holds_stage], ["order_confirmed", false]);
});

Deno.test("gate: a box already at Awaiting payment stays there and shows it is held", () => {
  const shown = dispatchMaterialStageOf({
    stored: "awaiting_payment",
    storedAt: "2026-10-28T02:00:00.000Z",
    sentAts: [SENT_AT],
    unsentLineChanges: [],
    confirmedAt: CONFIRMED_AT,
    terms: "pay_first",
  });
  assertEquals(shown, {
    key: "awaiting_payment",
    source: "set",
    held_by_payment: true,
  });
  // A stage past Order confirmed is never touched, so never held.
  assertEquals(
    dispatchMaterialStageOf({
      stored: "manufacturing",
      storedAt: "2026-10-28T02:00:00.000Z",
      sentAts: [SENT_AT],
      unsentLineChanges: [],
      confirmedAt: CONFIRMED_AT,
      terms: "pay_first",
    }),
    { key: "manufacturing", source: "set", held_by_payment: false },
  );
});

Deno.test("gate: a caller of the old rule gets the old answer and shape", () => {
  assertEquals(
    dispatchMaterialStageOf({
      stored: null,
      storedAt: null,
      sentAts: [SENT_AT],
      unsentLineChanges: [],
      confirmedAt: CONFIRMED_AT,
    }),
    { key: "order_confirmed", source: "worked_out" },
  );
});

Deno.test("gate: the Arrival line and Mark paid agree with the gate", async () => {
  const tables = fixture();
  Object.assign(boxRow(tables, BOX.lysaght), {
    delivery_date: "2026-11-05",
    delivery_date_set_at: CONFIRMED_AT,
    delivery_date_confirmed_at: CONFIRMED_AT,
  });
  const { client } = makeClient(tables);
  const read: any = await dispatchArrivalRead(client, JOB.fence, ORG, TODAY);
  const lysaght = orderFor(read.arrival, SUP.lysaght);
  assertEquals(lysaght.material_stage, "awaiting_payment");
  assertEquals(lysaght.held_by_payment, true);
  assertEquals(lysaght.payment.holds_stage, true);
  assertEquals(lysaght.delivery_date, "2026-11-05");
  const answer = await press(client, DISPATCH_V2_MARK_PAID_ACTION, {
    box_id: BOX.lysaght,
  });
  assertEquals(answer.box.material_stage, "order_confirmed");
  assertEquals(answer.box.payment.holds_stage, false);
  assertEquals(
    orderFor(answer.arrival.arrival, SUP.lysaght).held_by_payment,
    false,
  );
  assertEquals(tables.job_events[0].detail_json.had_date, true);
  assertEquals(tables.job_events[0].detail_json.stage_before, "awaiting_payment");
});

// ── A5: a matched supplier reply moves a Sent box on ────────────────────────

const REPLY_AT = "2026-10-28T04:58:00.000Z";
const NEWEST = { id: EMAIL.lysaght, sent_at: SENT_AT };

function reply(id: string, extra: Row = {}): any {
  return {
    id,
    job_id: JOB.fence,
    state: "matched",
    order_id: EMAIL.lysaght,
    received_at: REPLY_AT,
    matched_at: "2026-10-28T05:01:00.000Z",
    rung: "thread",
    ...extra,
  };
}

const REPLY = { one: uuid("b3", 1), two: uuid("b3", 2) };

function sentStage(extra: Partial<Parameters<typeof dispatchMaterialStageOf>[0]> = {}) {
  return dispatchMaterialStageOf({
    stored: null,
    storedAt: null,
    sentAts: [SENT_AT],
    unsentLineChanges: [],
    confirmedAt: null,
    terms: "pay_first",
    newestSent: NEWEST,
    replies: [reply(REPLY.one)],
    ...extra,
  });
}

Deno.test("reply: pay first goes to Awaiting payment, on account to Quote received, unknown nowhere", () => {
  assertEquals(dispatchV2ReplyStage("pay_first"), "awaiting_payment");
  assertEquals(dispatchV2ReplyStage("on_account"), "quote_received");
  assertEquals(dispatchV2ReplyStage("unknown"), null);
});

Deno.test("reply: tied to the order only when matched, naming the newest order email, after it was sent", () => {
  assert(dispatchV2ReplyTiedToOrder(reply(REPLY.one), NEWEST));
  assert(!dispatchV2ReplyTiedToOrder(reply(REPLY.one, { state: "needs_confirmation" }), NEWEST));
  assert(!dispatchV2ReplyTiedToOrder(reply(REPLY.one, { order_id: EMAIL.stratco }), NEWEST));
  assert(!dispatchV2ReplyTiedToOrder(reply(REPLY.one, { received_at: BEFORE_SEND }), NEWEST));
  // No received time: when it was matched.
  assert(dispatchV2ReplyTiedToOrder(reply(REPLY.one, { received_at: null }), NEWEST));
  assert(!dispatchV2ReplyTiedToOrder(reply(REPLY.one), null));
  assert(!dispatchV2ReplyTiedToOrder(reply(REPLY.one), { id: null, sent_at: SENT_AT }));
});

Deno.test("reply: a Sent box moves on and names the earliest reply", () => {
  const shown = sentStage({
    replies: [
      reply(REPLY.two, { received_at: "2026-10-28T06:00:00.000Z" }),
      reply(REPLY.one),
    ],
  });
  assertEquals(shown, {
    key: "awaiting_payment",
    source: "reply",
    held_by_payment: false,
    reply: { email_id: REPLY.one, received_at: REPLY_AT, rung: "thread" },
  });
  assertEquals(sentStage({ terms: "on_account" }).key, "quote_received");
  assertEquals(sentStage({ terms: "unknown" }).key, "sent");
  // No replies passed: the old answer, with no reply key.
  assertEquals("reply" in sentStage({ replies: undefined }), false);
});

Deno.test("reply: never moves a box that is past Sent, paid, or picked after the reply", () => {
  // A person picked Manufacturing after the send.
  assertEquals(
    sentStage({ stored: "manufacturing", storedAt: "2026-10-28T02:00:00.000Z" }).key,
    "manufacturing",
  );
  // Paid: Order confirmed from the payment, not the reply.
  const paid = sentStage({
    payment: paymentOf({ paidAt: PAID_AT, paidByEmail: SHAUN.email }),
  });
  assertEquals([paid.key, paid.source, paid.reply], ["order_confirmed", "payment", null]);
  // A person picked Sent again after the reply came in: the pick stands.
  const picked = sentStage({ stored: "sent", storedAt: "2026-10-28T07:00:00.000Z" });
  assertEquals([picked.key, picked.source], ["sent", "set"]);
  // A newer order went after the reply: the reply was for the earlier one.
  const newer = sentStage({
    sentAts: [SENT_AT, "2026-10-28T08:00:00.000Z"],
    newestSent: { id: uuid("f2", 3), sent_at: "2026-10-28T08:00:00.000Z" },
  });
  assertEquals(newer.key, "sent");
});

Deno.test("reply: a confirmed date already in place is not undone by a later reply", () => {
  const onAccount = sentStage({
    terms: "on_account",
    confirmedAt: "2026-10-28T03:00:00.000Z",
  });
  assertEquals([onAccount.key, onAccount.source], ["order_confirmed", "worked_out"]);
  const payFirst = sentStage({ confirmedAt: "2026-10-28T03:00:00.000Z" });
  assertEquals(
    [payFirst.key, payFirst.source, payFirst.held_by_payment],
    ["awaiting_payment", "worked_out", true],
  );
});

Deno.test("reply: a date confirmed after the reply is held by the gate, and the reply stays named", () => {
  const shown = sentStage({ confirmedAt: "2026-10-28T06:00:00.000Z" });
  assertEquals(shown, {
    key: "awaiting_payment",
    source: "reply",
    held_by_payment: true,
    reply: { email_id: REPLY.one, received_at: REPLY_AT, rung: "thread" },
  });
});

function withReplies(flag: boolean | null): Record<string, Row[]> {
  const tables = fixture();
  tables.feature_flags = flag === null
    ? []
    : [{ flag_name: "dispatch_v2_replies_v1", enabled: flag }];
  tables.dispatch_v2_supplier_emails = [
    reply(REPLY.one),
    // Not matched yet: never moves a box.
    reply(REPLY.two, { state: "needs_confirmation", order_id: EMAIL.stratco }),
  ];
  return tables;
}

Deno.test("reply: dispatch_arrival moves a box on a matched reply while the replies switch is on", async () => {
  const { client } = makeClient(withReplies(true));
  const read: any = await dispatchArrivalRead(client, JOB.fence, ORG, TODAY);
  assertEquals(read.replies_read, "ok");
  const lysaght = orderFor(read.arrival, SUP.lysaght);
  assertEquals(lysaght.material_stage, "awaiting_payment");
  assertEquals(lysaght.material_stage_source, "reply");
  assertEquals(lysaght.material_stage_reply, {
    email_id: REPLY.one,
    received_at: REPLY_AT,
    rung: "thread",
  });
  assertEquals(lysaght.todo, "Pay Lysaght");
  // Stratco's reply is not matched: still Sent.
  const stratco = orderFor(read.arrival, SUP.stratco);
  assertEquals([stratco.material_stage, stratco.material_stage_reply], ["sent", null]);
});

Deno.test("reply: switch off, no switch row, or a failed read: nothing moves", async () => {
  for (const flag of [false, null]) {
    const { client } = makeClient(withReplies(flag));
    const read: any = await dispatchArrivalRead(client, JOB.fence, ORG, TODAY);
    assertEquals(read.replies_read, "ok");
    assertEquals(orderFor(read.arrival, SUP.lysaght).material_stage, "sent");
  }
  for (const table of ["feature_flags", "dispatch_v2_supplier_emails"]) {
    const { client } = makeClient(withReplies(true), { fail: [table] });
    const read: any = await dispatchArrivalRead(client, JOB.fence, ORG, TODAY);
    assertEquals(read.replies_read, "failed", table);
    assertEquals(read.arrival_read, "ok");
    assertEquals(orderFor(read.arrival, SUP.lysaght).material_stage, "sent");
  }
});

Deno.test("reply: Mark paid on a box a reply moved confirms the order", async () => {
  const tables = withReplies(true);
  const { client } = makeClient(tables);
  const answer = await press(client, DISPATCH_V2_MARK_PAID_ACTION, {
    box_id: BOX.lysaght,
  });
  assertEquals(answer.box.material_stage, "order_confirmed");
  assertEquals(tables.job_events[0].detail_json.stage_before, "awaiting_payment");
  assertEquals(
    orderFor(answer.arrival.arrival, SUP.lysaght).material_stage_source,
    "payment",
  );
});

// ── A6: Order confirmed with no date waits on the supplier ──────────────────

Deno.test("no date: Order confirmed with no date for the order waits on the supplier for one", () => {
  const noDate = { hasDate: false };
  for (const installBooked of [false, true]) {
    assertEquals(
      dispatchMaterialWaitingOn("order_confirmed", installBooked, noDate),
      "supplier",
    );
    assertEquals(
      dispatchMaterialTodo("order_confirmed", "Lysaght", installBooked, noDate),
      "Waiting on Lysaght for a date",
    );
  }
  // With a date, or with no context (a purchase order, an older caller): as
  // before.
  for (const context of [{ hasDate: true }, undefined]) {
    assertEquals(dispatchMaterialWaitingOn("order_confirmed", false, context), "us");
    assertEquals(
      dispatchMaterialTodo("order_confirmed", "Lysaght", false, context),
      "Book the install and tell the client",
    );
    assertEquals(dispatchMaterialWaitingOn("order_confirmed", true, context), "supplier");
    assertEquals(
      dispatchMaterialTodo("order_confirmed", "Lysaght", true, context),
      "Waiting on Lysaght for the materials",
    );
  }
  // Only Order confirmed changes.
  assertEquals(dispatchMaterialTodo("awaiting_payment", "Lysaght", false, noDate), "Pay Lysaght");
  assertEquals(dispatchMaterialWaitingOn("sent", false, noDate), "supplier");
});

Deno.test("no date: a paid box with no date waits on the supplier; a date of either kind books the install", () => {
  const paid = box(BOX.lysaght, SUP.lysaght, "Lysaght", {
    paid_at: PAID_AT,
    paid_by_email: SHAUN.email,
  });
  const view = dispatchV2BoxStage({
    box: paid,
    emails: [sentEmail(EMAIL.lysaght, SUP.lysaght)],
    lines: [],
    terms: "pay_first",
  });
  assertEquals([view.key, view.waiting_on, view.todo], [
    "order_confirmed",
    "supplier",
    "Waiting on Lysaght for a date",
  ]);
  // The date the order email asked for counts.
  const asked = dispatchV2BoxStage({
    box: paid,
    emails: [sentEmail(EMAIL.lysaght, SUP.lysaght, { delivery_date: "2026-11-05" })],
    lines: [],
    terms: "pay_first",
  });
  assertEquals([asked.waiting_on, asked.todo], ["us", "Book the install and tell the client"]);
  // So does the box's own date (not confirmed).
  const own = dispatchV2BoxStage({
    box: { ...paid, delivery_date: "2026-11-05", delivery_date_set_at: PAID_AT },
    emails: [sentEmail(EMAIL.lysaght, SUP.lysaght)],
    lines: [],
    terms: "pay_first",
  });
  assertEquals(own.todo, "Book the install and tell the client");
  // A box date from before the newest send is an earlier order's: no date.
  const old = dispatchV2BoxStage({
    box: { ...paid, delivery_date: "2026-11-05", delivery_date_set_at: BEFORE_SEND },
    emails: [sentEmail(EMAIL.lysaght, SUP.lysaght)],
    lines: [],
    terms: "pay_first",
  });
  assertEquals(old.todo, "Waiting on Lysaght for a date");
});

Deno.test("no date: however the box got to Order confirmed, with an install booked too", () => {
  const picked = box(BOX.stratco, SUP.stratco, "Stratco WA", {
    material_stage: "order_confirmed",
    material_stage_set_at: PAID_AT,
    material_stage_set_by_email: SHAUN.email,
  });
  const view = dispatchV2BoxStage({
    box: picked,
    emails: [sentEmail(EMAIL.stratco, SUP.stratco)],
    lines: [],
    terms: "on_account",
    installDay: "2026-11-09",
  });
  assertEquals([view.key, view.source, view.waiting_on, view.todo], [
    "order_confirmed",
    "set",
    "supplier",
    "Waiting on Stratco WA for a date",
  ]);
});

Deno.test("no date: Mark paid on a box with no date leaves it off the waiting-on-us list", async () => {
  const tables = fixture();
  const { client } = makeClient(tables);
  const answer = await press(client, DISPATCH_V2_MARK_PAID_ACTION, {
    box_id: BOX.lysaght,
  });
  assertEquals(answer.box.material_stage, "order_confirmed");
  const lysaght = orderFor(answer.arrival.arrival, SUP.lysaght);
  assertEquals([lysaght.waiting_on, lysaght.todo], [
    "supplier",
    "Waiting on Lysaght for a date",
  ]);
  assert(!answer.arrival.arrival.waiting_on_us.some((line: string) => line.includes("Book the install")));
});

// ── A7: hold the job move while a box is unpaid ─────────────────────────────

// Only Stratco (on account) and Lysaght (pay first) on the job.
function twoBoxes(): Record<string, Row[]> {
  const tables = fixture();
  tables.job_material_suppliers = tables.job_material_suppliers.filter((b) =>
    b.id === BOX.stratco || b.id === BOX.lysaght
  );
  return tables;
}

Deno.test("hold: the Arrival line counts the unpaid boxes and names their suppliers", async () => {
  const { client } = makeClient(twoBoxes());
  const read: any = await dispatchArrivalRead(client, JOB.fence, ORG, TODAY);
  assertEquals(read.arrival.counts.unpaid, 1);
  assertEquals(read.arrival.counts.held_by_payment, 0);
  assertEquals(read.arrival.payment, {
    any_unpaid: true,
    unpaid_suppliers: ["Lysaght"],
  });
  assertEquals(read.payment_hold, true);
  assertEquals(dispatchPaymentHold(read.arrival), true);
});

Deno.test("hold: a held confirmed date is counted; paying every box lifts the hold", async () => {
  const tables = twoBoxes();
  tables.job_material_suppliers = tables.job_material_suppliers.map((b) =>
    b.id === BOX.lysaght ? confirmedBox({ position: 1 }) : b
  );
  const { client } = makeClient(tables);
  const before: any = await dispatchArrivalRead(client, JOB.fence, ORG, TODAY);
  assertEquals([before.arrival.counts.unpaid, before.arrival.counts.held_by_payment], [1, 1]);
  const answer = await press(client, DISPATCH_V2_MARK_PAID_ACTION, {
    box_id: BOX.lysaght,
  });
  assertEquals(answer.arrival.payment_hold, false);
  assertEquals(answer.arrival.arrival.payment, {
    any_unpaid: false,
    unpaid_suppliers: [],
  });
  assertEquals(answer.arrival.arrival.counts.unpaid, 0);
});

Deno.test("hold: a delivered box never holds the job; Pay on lifts it too", async () => {
  for (const extra of [
    { material_stage: "delivered", material_stage_set_at: PAID_AT },
    { pay_on: "pickup", pay_on_set_at: PAID_AT, pay_on_set_by_email: SHAUN.email },
  ]) {
    const tables = twoBoxes();
    tables.job_material_suppliers = tables.job_material_suppliers.map((b) =>
      b.id === BOX.lysaght ? { ...b, ...extra } : b
    );
    const { client } = makeClient(tables);
    const read: any = await dispatchArrivalRead(client, JOB.fence, ORG, TODAY);
    assertEquals(read.payment_hold, false);
  }
});

Deno.test("hold: unknown when the account list or the Arrival line could not be read", async () => {
  for (const table of ["dispatch_approved_supplier_emails", "job_material_suppliers"]) {
    const { client } = makeClient(twoBoxes(), { fail: [table] });
    const read: any = await dispatchArrivalRead(client, JOB.fence, ORG, TODAY);
    assertEquals(read.payment_hold, null, table);
    if (read.arrival) assertEquals(read.arrival.payment, null);
  }
  assertEquals(dispatchPaymentHold(null), null);
});

Deno.test("hold: Accept's payment read names the hold and the accepted box's payment", async () => {
  const { client } = makeClient(twoBoxes());
  const sources = postgrestDispatchRepliesSources(client);
  const held = await sources.paymentHold!({
    orgId: ORG,
    jobId: JOB.fence,
    supplierId: SUP.lysaght,
    now: NOW,
  });
  assertEquals([held.read, held.hold, held.suppliers], ["ok", true, ["Lysaght"]]);
  assertEquals(held.box_payment?.state, "unpaid");
  // The on-account box: no payment needed, the job is still held by Lysaght.
  const stratco = await sources.paymentHold!({
    orgId: ORG,
    jobId: JOB.fence,
    supplierId: SUP.stratco,
    now: NOW,
  });
  assertEquals([stratco.hold, stratco.box_payment?.state], [true, "not_needed"]);
  // A failed read never throws: it says failed.
  const { client: down } = makeClient(twoBoxes(), {
    fail: ["dispatch_approved_supplier_email_links"],
  });
  const failed = await postgrestDispatchRepliesSources(down).paymentHold!({
    orgId: ORG,
    jobId: JOB.fence,
    supplierId: SUP.lysaght,
    now: NOW,
  });
  assertEquals(failed, { read: "failed", hold: null, suppliers: [], box_payment: null });
});

// ── A8: pickup wording and install-day pickup ───────────────────────────────

const PICKUP_BODY = "Hi, please have the following ready for pickup.\nDate: \n";
const INSTALL_DAY = "2026-11-05";

function pickupEmail(extra: Row = {}): Row {
  return sentEmail(EMAIL.lysaght, SUP.lysaght, {
    body_text: PICKUP_BODY,
    delivery_date: INSTALL_DAY,
    ...extra,
  });
}

Deno.test("pickup: the short day, the Picked up label and the ready wording", () => {
  assertEquals(dispatchShortDay("2026-11-02"), "Mon 2/11");
  assertEquals(dispatchShortDay("2026-12-25"), "Fri 25/12");
  assertEquals(dispatchMaterialStageLabelFor("delivered", "pickup"), "Picked up");
  assertEquals(dispatchMaterialStageLabelFor("delivered", "delivery"), "Delivered");
  assertEquals(dispatchMaterialStageLabelFor("delivered"), "Delivered");
  assertEquals(dispatchMaterialStageLabelFor("ready", "pickup"), "Materials ready");
  const pickup = { hasDate: true, fulfilment: "pickup" as const, date: "2026-11-02" };
  assertEquals(
    dispatchMaterialTodo("ready", "Lysaght", false, pickup),
    "Materials ready to be picked up, Mon 2/11",
  );
  assertEquals(
    dispatchMaterialTodo("ready", "Lysaght", false, { ...pickup, hasDate: false, date: null }),
    "Materials ready to be picked up",
  );
  assertEquals(
    dispatchMaterialTodo("ready", "Lysaght", false, { hasDate: true, fulfilment: "delivery" }),
    "Arrange delivery from Lysaght",
  );
  // Not known (nothing sent) or no context: as before.
  assertEquals(
    dispatchMaterialTodo("ready", "Lysaght", false, { hasDate: false, fulfilment: null }),
    "Arrange delivery or pickup from Lysaght",
  );
  assertEquals(dispatchMaterialTodo("ready", "Lysaght", false), "Arrange delivery or pickup from Lysaght");
  // Ready waits on us either way.
  assertEquals(dispatchMaterialWaitingOn("ready", false, pickup), "us");
});

Deno.test("pickup: a box at each stage, and skips_ready only on the install's first day", () => {
  const at = (stage: string) =>
    box(BOX.lysaght, SUP.lysaght, "Lysaght", {
      material_stage: stage,
      material_stage_set_at: PAID_AT,
    });
  const ready = dispatchV2BoxStage({
    box: at("ready"),
    emails: [pickupEmail()],
    lines: [],
    terms: "pay_first",
    installDay: INSTALL_DAY,
  });
  assertEquals(ready.todo, "Materials ready to be picked up, Thu 5/11");
  assertEquals(ready.skips_ready, true);
  const delivered = dispatchV2BoxStage({
    box: at("delivered"),
    emails: [pickupEmail()],
    lines: [],
    terms: "pay_first",
    installDay: INSTALL_DAY,
  });
  assertEquals([delivered.key, delivered.label], ["delivered", "Picked up"]);
  // The install's first day decides, not the day the board shows.
  const later = dispatchV2BoxStage({
    box: at("ready"),
    emails: [pickupEmail()],
    lines: [],
    terms: "pay_first",
    installDay: "2026-11-06",
    installFirstDay: INSTALL_DAY,
  });
  assertEquals(later.skips_ready, true);
  // Another day, no install, or a delivery: no skip.
  for (
    const [email, installDay] of [
      [pickupEmail({ delivery_date: "2026-11-04" }), INSTALL_DAY],
      [pickupEmail(), null],
      [sentEmail(EMAIL.lysaght, SUP.lysaght, { delivery_date: INSTALL_DAY }), INSTALL_DAY],
    ] as Array<[Row, string | null]>
  ) {
    const view = dispatchV2BoxStage({
      box: at("ready"),
      emails: [email],
      lines: [],
      terms: "pay_first",
      installDay,
    });
    assertEquals(view.skips_ready, false);
  }
  const delivery = dispatchV2BoxStage({
    box: at("ready"),
    emails: [sentEmail(EMAIL.lysaght, SUP.lysaght, { delivery_date: INSTALL_DAY })],
    lines: [],
    terms: "pay_first",
  });
  assertEquals(delivery.todo, "Arrange delivery from Lysaght");
});

Deno.test("pickup: the Arrival line carries the label and skips_ready from the install bookings", async () => {
  const tables = fixture();
  tables.dispatch_supplier_order_emails = [
    pickupEmail(),
    sentEmail(EMAIL.stratco, SUP.stratco),
  ];
  tables.job_material_suppliers = tables.job_material_suppliers.map((b) =>
    b.id === BOX.lysaght
      ? { ...b, material_stage: "delivered", material_stage_set_at: PAID_AT }
      : b
  );
  tables.job_assignments = [{
    id: uuid("a9", 1),
    job_id: JOB.fence,
    scheduled_date: INSTALL_DAY,
    scheduled_end: null,
    assignment_type: "install",
    status: "scheduled",
    is_ghost: false,
    role: "lead",
    confirmation_status: "confirmed",
  }];
  const { client } = makeClient(tables);
  const read: any = await dispatchArrivalRead(client, JOB.fence, ORG, TODAY);
  const lysaght = orderFor(read.arrival, SUP.lysaght);
  assertEquals(lysaght.material_stage_label, "Picked up");
  assertEquals(lysaght.skips_ready, true);
  assertEquals(orderFor(read.arrival, SUP.stratco).skips_ready, false);
});

// ── C1: ASAP or Pick a date on each box ─────────────────────────────────────

const ASAP_BODY = "Hi Team, could we please order the following for delivery:\n\nDate: ASAP\nAddress: 1 Test St\n";

Deno.test("asap: the date mode from a body and from an email's Date line", () => {
  assertEquals(dispatchV2DateModeParam("asap"), "asap");
  assertEquals(dispatchV2DateModeParam("date"), "date");
  assertEquals(dispatchV2DateModeParam(undefined), null);
  assertEquals(dispatchV2DateModeParam(null), null);
  assertEquals(dispatchV2DateModeParam("soon"), undefined);
  assertEquals(dispatchV2DateModeOf(ASAP_BODY), "asap");
  assertEquals(dispatchV2DateModeOf("Hi\r\nDate: asap \r\nAddress: x\r\n"), "asap");
  assertEquals(dispatchV2DateModeOf("Hi\nDate: 4 November 2026\n"), "date");
  assertEquals(dispatchV2DateModeOf("Hi\nDate:\n"), "date");
  assertEquals(dispatchV2DateModeOf("Hi, no date line here"), "date");
  assertEquals(dispatchV2DateModeOf(null), "date");
});

Deno.test("asap: the email says Date: ASAP, needs no date and can be sent", () => {
  const job = {
    job_number: "SWF-90101",
    client_name: "Test Person",
    client_phone: "0400 000 000",
    site_address: "1 Test St",
    site_suburb: "Balcatta",
  };
  const asap = dispatchV2BuildEmail({
    job,
    workType: "fencing",
    isMainSupplier: false,
    lines: [{ id: "l1", description: "Post", quantity: 2 }],
    deliveryDate: null,
    dateMode: "asap",
  });
  assert(asap.body_text.includes("\nDate: ASAP\n"));
  assert(!asap.missing.includes("date"));
  assertEquals(dispatchV2EmptyDetailLines(asap.body_text).includes("date"), false);
  // Pick a date with no date: the Date line is empty, and the send is held.
  const picked = dispatchV2BuildEmail({
    job,
    workType: "fencing",
    isMainSupplier: false,
    lines: [{ id: "l1", description: "Post", quantity: 2 }],
    deliveryDate: null,
    dateMode: "date",
  });
  assert(picked.missing.includes("date"));
  assert(dispatchV2EmptyDetailLines(picked.body_text).includes("date"));
});

Deno.test("asap: a box's mode, from its newest sent email, its own choice, or worked out", () => {
  const sentAsap = { date_mode: "asap" as const };
  const sentDate = { date_mode: "date" as const };
  // A sent order: the email's Date line, whatever the box says now.
  assertEquals(
    dispatchV2BoxDateMode({ stored: "date", boxHasDate: false, newestSent: sentAsap }),
    { mode: "asap", derived: false },
  );
  assertEquals(
    dispatchV2BoxDateMode({ stored: null, boxHasDate: false, newestSent: sentDate }),
    { mode: "date", derived: true },
  );
  // Nothing sent: the box's choice.
  assertEquals(
    dispatchV2BoxDateMode({ stored: "date", boxHasDate: false, newestSent: null }),
    { mode: "date", derived: false },
  );
  // A box made before piece C (NULL): date when it or its open email has a
  // date, else ASAP.
  const nul = { stored: null, newestSent: null };
  assertEquals(dispatchV2BoxDateMode({ ...nul, boxHasDate: true }), { mode: "date", derived: true });
  assertEquals(
    dispatchV2BoxDateMode({ ...nul, boxHasDate: false, openEmail: { delivery_date: "2026-11-05" } }),
    { mode: "date", derived: true },
  );
  assertEquals(
    dispatchV2BoxDateMode({ ...nul, boxHasDate: false, openEmail: { body_text: "Date: 5 November 2026\n" } }),
    { mode: "date", derived: true },
  );
  assertEquals(
    dispatchV2BoxDateMode({ ...nul, boxHasDate: false, openEmail: { body_text: ASAP_BODY } }),
    { mode: "asap", derived: true },
  );
  assertEquals(dispatchV2BoxDateMode({ ...nul, boxHasDate: false }), { mode: "asap", derived: true });
});

Deno.test("asap: the Arrival line carries each box's mode; a purchase order has none", () => {
  const arrival = dispatchArrival({
    today: TODAY,
    installDay: null,
    boxes: [
      box(BOX.lysaght, SUP.lysaght, "Lysaght"),
      box(BOX.stratco, SUP.stratco, "Stratco WA", { position: 1, order_date_mode: "date" }),
    ],
    sentEmails: [sentEmail(EMAIL.lysaght, SUP.lysaght, { body_text: ASAP_BODY })] as any,
    orders: [{ id: uuid("p2", 1), source: "other", supplier_name: "Other Co", status: "sent" }],
  });
  assertEquals(arrival.orders.map((o) => [o.supplier_name, o.date_mode]), [
    ["Lysaght", "asap"],
    ["Stratco WA", "date"],
    ["Other Co", null],
  ]);
});

Deno.test("asap: the date choice press writes the box, logs it, and the same choice writes nothing", async () => {
  const tables = fixture();
  const { client, writes } = makeClient(tables);
  const answer = await press(client, DISPATCH_V2_SET_DATE_MODE_ACTION, {
    box_id: BOX.stratco,
    date_mode: "date",
  });
  assertEquals([answer.success, answer.unchanged, answer.job_status_changed], [true, false, false]);
  const row = boxRow(tables, BOX.stratco);
  assertEquals(
    [row.order_date_mode, row.order_date_mode_set_at, row.order_date_mode_set_by_email],
    ["date", NOW, SHAUN.email],
  );
  assertEquals(writes.map((w) => `${w.kind}:${w.table}`), [
    "update:job_material_suppliers",
    "insert:job_events",
  ]);
  assertEquals(tables.job_events[0].event_type, "dispatch_v2_date_mode_set");
  assertEquals(tables.job_events[0].detail_json, {
    box_id: BOX.stratco,
    supplier_id: SUP.stratco,
    supplier: "Stratco WA",
    from: null,
    to: "date",
    via: "screen",
    operator_email: SHAUN.email,
  });
  // The order emails are never touched.
  assertEquals(tables.dispatch_supplier_order_emails, fixture().dispatch_supplier_order_emails);
  const again = await press(client, DISPATCH_V2_SET_DATE_MODE_ACTION, {
    box_id: BOX.stratco,
    date_mode: "date",
  });
  assertEquals(again.unchanged, true);
  assertEquals(writes.length, 2);
});

Deno.test("asap: choosing ASAP keeps a date already on the box; a bad choice is refused", async () => {
  const tables = fixture();
  tables.job_material_suppliers = tables.job_material_suppliers.map((b) =>
    b.id === BOX.lysaght ? confirmedBox({ order_date_mode: "date" }) : b
  );
  const { client } = makeClient(tables);
  await press(client, DISPATCH_V2_SET_DATE_MODE_ACTION, {
    box_id: BOX.lysaght,
    date_mode: "asap",
  });
  const row = boxRow(tables, BOX.lysaght);
  assertEquals([row.order_date_mode, row.delivery_date], ["asap", "2026-11-05"]);
  for (const date_mode of [undefined, "soon", null]) {
    const r = await refused(client, DISPATCH_V2_SET_DATE_MODE_ACTION, {
      box_id: BOX.lysaght,
      date_mode,
    });
    assertEquals([r.status, r.code], [400, "invalid_request"]);
  }
});
