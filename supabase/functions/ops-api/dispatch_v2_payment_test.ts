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
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchV2AccountsOf,
  dispatchV2PaymentTerms,
  dispatchV2TermsFor,
} from "./dispatch_v2_payment.ts";
import { dispatchV2BoxStage } from "./dispatch_v2_material_stage.ts";
import { dispatchArrival, dispatchArrivalRead } from "./dispatch_board.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000ee";
const TODAY = "2026-10-29";
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
    users: [],
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

type Options = { fail?: string[] };

// A PostgREST stand-in for the reads (and, from the presses' commits, the
// box update and the audit insert). A table named in `fail` answers every
// call with an error, as a missing table or a dropped connection would.
function makeClient(tables: Record<string, Row[]>, options: Options = {}) {
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let rowLimit: number | null = null;
    const orders: Array<[string, boolean]> = [];
    const failed = () => (options.fail || []).includes(table);

    const run = (): { data: any; error: any } => {
      if (failed()) return { data: null, error: { message: `${table} is down` } };
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
  return { client: { from } };
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
