import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import {
  AUTO_RELEASE_ACTOR,
  autoReleaseVoidedTradeInvoices,
} from "./trade_invoice_voided_release.ts";
import { FakeDb } from "./trade_invoice_controls_test_fakes.ts";

type Row = Record<string, any>;

const invoice = (n: number, extra: Row = {}): Row => ({
  id: `inv-${n}`,
  org_id: "org",
  user_id: `worker-${n}`,
  status: "pushed_to_xero",
  invoice_number: `SW-INV-T-000000-00${n}`,
  xero_bill_id: `bill-${n}`,
  xero_bill_status: "VOIDED",
  amount_paid: 0,
  paid_at: null,
  override_details: null,
  query_note: null,
  created_at: `2026-01-0${n}T00:00:00Z`,
  ...extra,
});
const line = (n: number, extra: Row = {}): Row => ({
  id: `line-${n}`,
  trade_invoice_id: `inv-${n}`,
  line_type: "labour",
  group_share_id: null,
  ...extra,
});
const bill = (n: number, extra: Row = {}): Row => ({
  InvoiceID: `bill-${n}`,
  Type: "ACCPAY",
  Status: "VOIDED",
  AmountPaid: 0,
  AmountCredited: 0,
  Payments: [],
  CreditNotes: [],
  ...extra,
});

function setup(invoices: Row[], lines: Row[], bills: Record<string, Row>) {
  const db = new FakeDb({ trade_invoices: invoices, trade_invoice_lines: lines });
  let providerReads = 0;
  let tokenReads = 0;
  const deps = {
    getToken: () => {
      tokenReads++;
      return Promise.resolve({ accessToken: "token", tenantId: "tenant" });
    },
    xeroGet: (path: string) => {
      providerReads++;
      const id = decodeURIComponent(path.split("/").pop() || "");
      const found = bills[id];
      return Promise.resolve({ Invoices: found ? [found] : [] });
    },
  };
  return {
    db,
    deps,
    providerReads: () => providerReads,
    tokenReads: () => tokenReads,
  };
}

const row = (db: FakeDb, id: string) =>
  db.rows("trade_invoices").find((r) => r.id === id)!;

Deno.test("auto release frees an unpaid voided or deleted week, keeps its Xero identity and records an event", async () => {
  const t = setup(
    [invoice(1), invoice(2, { xero_bill_status: "DELETED", status: "approved" })],
    [line(1), line(2)],
    { "bill-1": bill(1), "bill-2": bill(2, { Status: "DELETED" }) },
  );
  const result = await autoReleaseVoidedTradeInvoices(t.db.client(), t.deps);
  assertEquals(result.released, ["inv-1", "inv-2"]);
  assertEquals(result.skipped, []);
  for (const id of ["inv-1", "inv-2"]) {
    const r = row(t.db, id);
    assertEquals(r.status, "ops-reject");
    assertEquals(r.xero_bill_id, id.replace("inv", "bill"));
    assertEquals(r.override_details.voided_release.automatic, true);
    assertEquals(r.override_details.voided_release.actor, AUTO_RELEASE_ACTOR);
  }
  assertEquals(row(t.db, "inv-2").xero_bill_status, "DELETED");
  assertEquals(row(t.db, "inv-2").override_details.voided_release.prior_status, "approved");
  const events = t.db.rows("trade_invoice_events");
  assertEquals(events.map((e) => e.event_type), ["voided_bill_released", "voided_bill_released"]);
  assertEquals(events.map((e) => e.detail.automatic), [true, true]);
  assertEquals(t.tokenReads(), 1, "one Xero token for the whole run");
  // Lines are history and are never touched.
  assertEquals(t.db.writes.filter((w) => w.table === "trade_invoice_lines").length, 0);
});

Deno.test("nothing paid means nothing paid: any payment, credit or allocation in Xero leaves the week held", async () => {
  const paid: Row[] = [
    { AmountPaid: 0.01 },
    { AmountPaid: null },
    { AmountPaid: undefined },
    { AmountCredited: 5 },
    { BatchPaymentID: "batch" },
    { Payments: [{ PaymentID: "p" }] },
    { CreditNotes: [{ CreditNoteID: "c" }] },
    { Prepayments: [{}] },
    { Overpayments: [{}] },
    { Payments: {} },
  ];
  for (const change of paid) {
    const providerBill = bill(1, change);
    if ("AmountPaid" in change && change.AmountPaid === undefined) delete providerBill.AmountPaid;
    const t = setup([invoice(1)], [line(1)], { "bill-1": providerBill });
    const result = await autoReleaseVoidedTradeInvoices(t.db.client(), t.deps);
    assertEquals(result.released, [], JSON.stringify(change));
    assertEquals(result.skipped, [{ invoice_id: "inv-1", code: "voided_release_settled" }]);
    assertEquals(row(t.db, "inv-1").status, "pushed_to_xero");
    assertEquals(t.db.rows("trade_invoice_events").length, 0);
  }
});

Deno.test("a local payment, a group share, a live bill or a missing bill is never released", async () => {
  const cases: { inv: Row; lines: Row[]; providerBill: Row | null; code: string }[] = [
    { inv: invoice(1, { amount_paid: 10 }), lines: [line(1)], providerBill: bill(1), code: "voided_release_settled" },
    { inv: invoice(1, { paid_at: "2026-01-01" }), lines: [line(1)], providerBill: bill(1), code: "voided_release_settled" },
    { inv: invoice(1), lines: [line(1, { group_share_id: "share" })], providerBill: bill(1), code: "voided_release_group_invoice" },
    { inv: invoice(1), lines: [line(1, { line_type: "group share" })], providerBill: bill(1), code: "voided_release_group_invoice" },
    { inv: invoice(1), lines: [], providerBill: bill(1), code: "voided_release_no_lines" },
    { inv: invoice(1), lines: [line(1)], providerBill: bill(1, { Status: "AUTHORISED" }), code: "voided_release_not_voided" },
    { inv: invoice(1), lines: [line(1)], providerBill: bill(1, { Status: "PAID", AmountPaid: 100 }), code: "voided_release_not_voided" },
    { inv: invoice(1), lines: [line(1)], providerBill: bill(1, { InvoiceID: "other" }), code: "voided_release_identity" },
    { inv: invoice(1), lines: [line(1)], providerBill: bill(1, { Type: "ACCREC" }), code: "voided_release_identity" },
    { inv: invoice(1), lines: [line(1)], providerBill: null, code: "voided_release_unreadable" },
    { inv: invoice(1, { override_details: [1] }), lines: [line(1)], providerBill: bill(1), code: "voided_release_history_shape" },
  ];
  for (const c of cases) {
    const t = setup([c.inv], c.lines, c.providerBill ? { "bill-1": c.providerBill } : {});
    const result = await autoReleaseVoidedTradeInvoices(t.db.client(), t.deps);
    if (c.inv.paid_at) {
      // The read itself filters paid rows out.
      assertEquals(result.checked, 0);
      continue;
    }
    assertEquals(result.released, [], c.code);
    assertEquals(result.skipped, [{ invoice_id: "inv-1", code: c.code }]);
    assertEquals(row(t.db, "inv-1").status, c.inv.status);
  }
});

Deno.test("only pushed or approved rows whose copy says voided or deleted are nominated", async () => {
  const t = setup(
    [
      invoice(1, { xero_bill_status: "AUTHORISED" }),
      invoice(2, { status: "paid" }),
      invoice(3, { status: "ops-reject" }),
      invoice(4, { xero_bill_id: null }),
      invoice(5),
    ],
    [line(1), line(2), line(3), line(4), line(5)],
    { "bill-1": bill(1), "bill-2": bill(2), "bill-3": bill(3), "bill-5": bill(5) },
  );
  const result = await autoReleaseVoidedTradeInvoices(t.db.client(), t.deps);
  assertEquals(result.checked, 1);
  assertEquals(result.released, ["inv-5"]);
  assertEquals(t.providerReads(), 1);
});

Deno.test("a row that changes during the release writes nothing, and a second run is a no-op", async () => {
  const t = setup([invoice(1)], [line(1)], { "bill-1": bill(1) });
  t.db.beforeUpdate = (table) => {
    if (table === "trade_invoices") row(t.db, "inv-1").query_note = "Office is looking at this";
  };
  const first = await autoReleaseVoidedTradeInvoices(t.db.client(), t.deps);
  assertEquals(first.skipped, [{ invoice_id: "inv-1", code: "voided_release_changed" }]);
  assertEquals(row(t.db, "inv-1").status, "pushed_to_xero");

  t.db.beforeUpdate = () => {};
  const second = await autoReleaseVoidedTradeInvoices(t.db.client(), t.deps);
  assertEquals(second.released, ["inv-1"]);
  const third = await autoReleaseVoidedTradeInvoices(t.db.client(), t.deps);
  assertEquals(third.checked, 0);
  assertEquals(t.db.rows("trade_invoice_events").length, 1);
});

Deno.test("a failed event write never undoes the release and is reported", async () => {
  const t = setup([invoice(1)], [line(1)], { "bill-1": bill(1) });
  t.db.failOn = (table, kind) =>
    table === "trade_invoice_events" && kind === "insert" ? { message: "down" } : null;
  const result = await autoReleaseVoidedTradeInvoices(t.db.client(), t.deps);
  assertEquals(result.released, ["inv-1"]);
  assertEquals(result.events_unrecorded, ["inv-1"]);
  assertEquals(row(t.db, "inv-1").override_details.voided_release.xero_bill_id, "bill-1");
});

Deno.test("a provider outage on one bill is skipped and does not stop later bills; a rate limit ends the run", async () => {
  const t = setup([invoice(1), invoice(2)], [line(1), line(2)], { "bill-2": bill(2) });
  const outage = {
    ...t.deps,
    xeroGet: (path: string) =>
      path.endsWith("bill-1") ? Promise.reject(new Error("Xero 500")) : t.deps.xeroGet(path),
  };
  const result = await autoReleaseVoidedTradeInvoices(t.db.client(), outage);
  assertEquals(result.skipped, [{ invoice_id: "inv-1", code: "voided_release_provider_error" }]);
  assertEquals(result.released, ["inv-2"]);
  assertEquals(row(t.db, "inv-1").status, "pushed_to_xero");

  const limited = setup([invoice(3)], [line(3)], { "bill-3": bill(3) });
  await assertRejects(
    () =>
      autoReleaseVoidedTradeInvoices(limited.db.client(), {
        ...limited.deps,
        xeroGet: () => Promise.reject(new XeroCooldownError("limited", 429, "XERO_RATE_LIMITED")),
      }),
    XeroCooldownError,
  );
  assertEquals(row(limited.db, "inv-3").status, "pushed_to_xero");
});
