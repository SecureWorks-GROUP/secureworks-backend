// deno-lint-ignore-file no-import-prefix no-explicit-any
// Other supplier orders on a Dispatch job: made-up numbers and suppliers.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  countsInCommitted,
  isOpenOrder,
  jobOrderOverlap,
  orderOrigin,
  otherOpenSupplierOrders,
} from "./dispatch_other_supplier_orders.ts";

const JOB = "00000000-0000-4000-8000-000000000001";
const STEEL = "00000000-0000-4000-8000-0000000000b1";
const SHEETS = "00000000-0000-4000-8000-0000000000b2";

const po = (over: Record<string, any>) => ({
  id: crypto.randomUUID(),
  job_id: JOB,
  status: "submitted",
  source: null,
  subtotal: 0,
  ...over,
});
const dispatch = (over: Record<string, any> = {}) =>
  po({
    po_number: "PO-1000001",
    source: "dispatch",
    status: "draft",
    supplier_id: STEEL,
    ...over,
  });
const office = (over: Record<string, any> = {}) =>
  po({
    po_number: "PO-0901",
    supplier_name: "Example Steel",
    supplier_id: STEEL,
    subtotal: 812.5,
    total: 893.75,
    ...over,
  });

Deno.test("origin: Dispatch by source, quote builder by version id, else office or Xero", () => {
  assertEquals(orderOrigin(dispatch()), "dispatch");
  assertEquals(
    orderOrigin(po({ quote_builder_version_id: "v1" })),
    "quote_builder",
  );
  assertEquals(orderOrigin(po({ source: null })), "office_or_xero");
  assertEquals(orderOrigin(po({ source: "" })), "office_or_xero");
});

Deno.test("open: closed statuses, a linked bill, an invoice received or a matched bill fact are not open", () => {
  for (const status of ["billed", "cancelled", "VOIDED", "deleted"]) {
    assertEquals(isOpenOrder(office({ status })), false, status);
  }
  assertEquals(isOpenOrder(office({ xero_bill_id: "b" })), false);
  assertEquals(
    isOpenOrder(office({ invoice_received_at: "2026-10-01" })),
    false,
  );
  const o = office();
  assertEquals(isOpenOrder(o, new Set([o.id])), false);
  assertEquals(isOpenOrder(office({ status: "draft" })), true);
});

Deno.test("committed mirrors the engine: a draft is not committed, a zero-amount order is", () => {
  assertEquals(countsInCommitted(office({ status: "draft" })), false);
  assertEquals(countsInCommitted(office({ status: "authorised" })), true);
  assertEquals(
    countsInCommitted(dispatch({ status: "submitted", subtotal: 0 })),
    true,
  );
  assertEquals(
    countsInCommitted(office({ subtotal: null, total: null })),
    false,
  );
  assertEquals(countsInCommitted(office({ job_id: null })), false);
});

Deno.test("screen: lists open non-Dispatch orders with no dollar figure, and says where they came from", () => {
  const answer = otherOpenSupplierOrders([
    dispatch(),
    office(),
    office({ po_number: "PO-0902", status: "billed" }),
    po({
      po_number: "PO-0903",
      supplier_name: "Example Sheets",
      quote_builder_version_id: "v1",
      status: "draft",
      subtotal: 40,
    }),
  ]);
  assertEquals(
    answer.orders.map((
      o,
    ) => [o.po_number, o.origin, o.priced, o.in_committed]),
    [
      ["PO-0901", "office_or_xero", true, true],
      ["PO-0903", "quote_builder", true, false],
    ],
  );
  assertEquals(
    answer.note,
    "This job already has PO-0901 (Example Steel), PO-0903 (Example Sheets) from the old order screen or Xero and the quote builder, so check you are not ordering the same materials twice.",
  );
  const json = JSON.stringify(answer);
  assert(!/"(subtotal|total|amount_ex)"|812|893/.test(json));
});

Deno.test("screen: only Dispatch orders, or none, says nothing", () => {
  assertEquals(otherOpenSupplierOrders([dispatch()]).note, null);
  assertEquals(otherOpenSupplierOrders([]).orders, []);
});

Deno.test("Job Profit: both kinds with the same supplier id are flagged, and the two sides are never added", () => {
  const d = dispatch({ status: "submitted" });
  const result = jobOrderOverlap({
    job_id: JOB,
    orders: [d, office({ status: "authorised" })],
    bill_facts: [{ matched_po_id: d.id, amount_ex: 790.1 }],
  });
  assertEquals(result.flag, "two_orders_same_supplier");
  assertEquals(result.shared_supplier_ids, [STEEL]);
  assertEquals(result.other_committed_ex, 812.5);
  assertEquals(result.dispatch_billed_ex, 790.1);
  assertEquals(result.dispatch_orders[0].billed_ex, 790.1);
  assert(!("total" in result) && !("committed_ex" in result));
});

Deno.test("Job Profit: a different supplier id, or none, is still two orders to check; names are never compared", () => {
  const sameNameNoId = jobOrderOverlap({
    job_id: JOB,
    orders: [
      dispatch({ supplier_id: null, supplier_name: "Example Steel" }),
      office({ supplier_id: null }),
    ],
  });
  assertEquals(
    [sameNameNoId.flag, sameNameNoId.shared_supplier_ids],
    ["two_orders_check_one", []],
  );
  const other = jobOrderOverlap({
    job_id: JOB,
    orders: [dispatch(), office({ supplier_id: SHEETS })],
  });
  assertEquals(other.flag, "two_orders_check_one");
});

Deno.test("Job Profit: no flag without both kinds, for an unpriced or billed other order, or a cancelled Dispatch order", () => {
  const cases: any[][] = [
    [dispatch()],
    [office()],
    [dispatch(), office({ subtotal: 0, total: 0 })],
    [dispatch(), office({ xero_bill_id: "b" })],
    [dispatch({ status: "cancelled" }), office()],
  ];
  for (const orders of cases) {
    assertEquals(jobOrderOverlap({ job_id: JOB, orders }).flag, "none");
  }
});

Deno.test("Job Profit: an other order already matched by a bill fact is not open, so not flagged", () => {
  const o = office();
  const result = jobOrderOverlap({
    job_id: JOB,
    orders: [dispatch(), o],
    bill_facts: [{ matched_po_id: o.id, amount_ex: 812.5 }],
  });
  assertEquals(result.flag, "none");
});

Deno.test("Job Profit: a priced draft from another source is flagged but not in its committed figure", () => {
  const result = jobOrderOverlap({
    job_id: JOB,
    orders: [dispatch(), office({ status: "draft" })],
  });
  assertEquals(result.flag, "two_orders_same_supplier");
  assertEquals(result.other_committed_ex, 0);
  assertEquals(result.other_priced_orders[0].in_committed, false);
});

Deno.test("amount follows the engine: subtotal, else total / 1.1", () => {
  const result = jobOrderOverlap({
    job_id: JOB,
    orders: [dispatch(), office({ subtotal: null, total: 110 })],
  });
  assertEquals(result.other_priced_orders[0].amount_ex, 100);
  assertEquals(result.other_committed_ex, 100);
});
