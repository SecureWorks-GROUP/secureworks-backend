// deno-lint-ignore-file no-explicit-any no-import-prefix
// B4: what job_profit shows staff for a job's Dispatch orders: ordered, billed, not billed, and the bill that
// linked each one by rule. The link rule itself is proven in SQL
// (supabase/tests/migration-contracts/20261104010000_dispatch_order_bill_links); here the views answer as they
// would for the live shapes of 3 Nov 2026 (SWP-261309: a CMI order and a Metroll order).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { jobProfitAction } from "./job_profit.ts";

function fakeClient(tables: Record<string, any[]>, errors: Record<string, string> = {}) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const builder: any = {};
      for (const op of ["select", "order", "limit", "gte", "lte", "range"]) builder[op] = () => builder;
      builder.eq = (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val);
        return builder;
      };
      builder.in = (col: string, vals: unknown[]) => {
        rows = rows.filter((r) => vals.includes(r[col]));
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve(errors[table] ? { data: null, error: { message: errors[table] } } : { data: rows, error: null });
      return builder;
    },
  };
}

const JOB = "b4000000-0000-4000-8000-000000000001";
const OTHER_JOB = "b4000000-0000-4000-8000-000000000003";
const CMI_ORDER = "b4000000-0000-4000-8000-000000000021";
const METROLL_ORDER = "b4000000-0000-4000-8000-000000000022";

const ORDERS = [
  {
    order_kind: "dispatch_v2_email", order_id: CMI_ORDER, job_id: JOB, supplier_name: "CMI", order_status: "sent",
    ordered_at: "2026-10-30T03:44:39Z", order_label: "Material Order Ref SWP-261309",
  },
  {
    order_kind: "dispatch_v2_email", order_id: METROLL_ORDER, job_id: JOB, supplier_name: "Metroll",
    order_status: "sent", ordered_at: "2026-10-30T03:44:53Z", order_label: "Material Order Ref SWP-261309",
  },
];

function cmiBill(extra: Record<string, unknown> = {}) {
  return {
    order_id: CMI_ORDER, job_id: JOB, xero_invoice_id: "bill-cmi", invoice_number: "240272",
    bill_contact_name: "CMI (Combined Metal Industries / CMI WA)", bill_status: "AUTHORISED",
    bill_date: "2026-11-02", bill_sub_total: 1830, supplier_match: "supplier_name", rule: "supplier_ref",
    matched_ref: "240272", matched_job_number: null, linked: true, not_linked_reason: null, ...extra,
  };
}

function job(tables: Record<string, any[]>, errors: Record<string, string> = {}) {
  return fakeClient({
    jobs: [{ id: JOB, job_number: "SWP-261309" }],
    v_job_profit: [{ job_id: JOB, job_number: "SWP-261309", invoiced_ex: 9000, actual_cost_ex: 4272.73, profit_ex: 4727.27 }],
    v_job_revenue_events: [],
    ...tables,
  }, errors);
}

async function dispatchOrders(c: any) {
  const out = await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
  assertEquals(out.status, 200);
  return out.body as any;
}

Deno.test("a job's Dispatch orders read ordered, billed and not billed, with the bill and the rule that linked it", async () => {
  const body = await dispatchOrders(job({
    v_dispatch_orders: ORDERS,
    v_dispatch_order_bills: [cmiBill()],
    v_job_cost_events: [{ job_id: JOB, source: "supplier_bill", document_id: "bill-cmi", is_actual: true, amount_ex: 1830 }],
  }));
  const d = body.dispatch_orders;
  assertEquals([d.status, d.ordered, d.billed, d.not_billed], ["ok", 2, 1, 1]);
  const [cmi, metroll] = d.orders;
  assertEquals([cmi.supplier, cmi.state, metroll.supplier, metroll.state], ["CMI", "billed", "Metroll", "not_billed"]);
  assertEquals(cmi.bills.map((b: any) => [b.invoice_number, b.rule, b.matched_ref, b.bill_sub_total_ex, b.cost_on_this_job]), [
    ["240272", "supplier_ref", "240272", 1830, true],
  ]);
  assertEquals(metroll.bills, []);
  assertEquals(typeof body.labels.dispatch_orders, "string");
});

Deno.test("a bill linked by our job number that Job Profit counts on another job shows billed, and this job's money is untouched", async () => {
  const body = await dispatchOrders(job({
    v_dispatch_orders: ORDERS,
    v_dispatch_order_bills: [{
      ...cmiBill(), order_id: METROLL_ORDER, xero_invoice_id: "bill-placed", invoice_number: "1059100",
      bill_contact_name: "Metroll Pty Ltd", rule: "job_number", matched_ref: null, matched_job_number: "SWP-261309", bill_sub_total: 120,
    }],
    v_job_cost_events: [
      { job_id: OTHER_JOB, source: "materials_fact", document_id: "bill-placed", is_actual: true, amount_ex: 120 },
    ],
  }));
  const metroll = body.dispatch_orders.orders.find((o: any) => o.order_id === METROLL_ORDER);
  assertEquals(metroll.state, "billed");
  assertEquals(metroll.bills.map((b: any) => [b.invoice_number, b.rule, b.matched_job_number, b.cost_on_this_job]), [
    ["1059100", "job_number", "SWP-261309", false],
  ]);
  assertEquals([body.job.actual_cost_ex, body.job.profit_ex], [4272.73, 4727.27]);
  assertEquals(body.cost_events, []);
});

Deno.test("a bill that names two orders links neither: both read not billed and the bill is listed as unclear", async () => {
  const body = await dispatchOrders(job({
    v_dispatch_orders: ORDERS,
    v_dispatch_order_bills: [
      { ...cmiBill(), order_id: METROLL_ORDER, xero_invoice_id: "bill-two", invoice_number: "1060001", linked: false, not_linked_reason: "several_orders_on_job" },
    ],
    v_job_cost_events: [],
  }));
  const d = body.dispatch_orders;
  assertEquals([d.billed, d.not_billed], [0, 2]);
  const metroll = d.orders.find((o: any) => o.order_id === METROLL_ORDER);
  assertEquals(metroll.bills, []);
  assertEquals(metroll.unclear_bills, [{ xero_invoice_id: "bill-two", invoice_number: "1060001", reason: "several_orders_on_job" }]);
});

Deno.test("links that cannot be read are unknown, never not billed, and the rest of job_profit still answers", async () => {
  for (const failing of ["v_dispatch_order_bills", "v_dispatch_orders"]) {
    const body = await dispatchOrders(job({ v_dispatch_orders: ORDERS, v_dispatch_order_bills: [cmiBill()], v_job_cost_events: [] }, {
      [failing]: "relation does not exist",
    }));
    const d = body.dispatch_orders;
    assertEquals([d.status, d.ordered, d.billed, d.not_billed, d.orders], ["unknown", null, null, null, []], failing);
    assertEquals(body.job.profit_ex, 4727.27);
  }
});

Deno.test("a purchase order billed under our PO number on the supplier's PDF reads billed, with the rule and where it was found", async () => {
  const PO = "b4100000-0000-4000-8000-000000000022";
  const body = await dispatchOrders(job({
    v_dispatch_orders: [{
      order_kind: "purchase_order", order_id: PO, job_id: JOB, supplier_name: "R&R Fencing", order_status: "sent",
      ordered_at: "2026-09-10T01:00:00Z", order_label: "PO-302382",
    }],
    v_dispatch_order_bills: [{
      ...cmiBill(), order_id: PO, xero_invoice_id: "bill-rr", invoice_number: "INV-87293", bill_contact_name: "R&R FENCING",
      bill_sub_total: 1570.73, rule: "po_number", matched_ref: null, matched_po_number: "PO-302382", matched_in: "supplier_pdf",
    }],
    v_job_cost_events: [{ job_id: JOB, source: "supplier_bill", document_id: "bill-rr", is_actual: true, amount_ex: 1570.73 }],
  }));
  const d = body.dispatch_orders;
  assertEquals([d.ordered, d.billed, d.not_billed], [1, 1, 0]);
  const [po] = d.orders;
  assertEquals([po.order_kind, po.order_label, po.state], ["purchase_order", "PO-302382", "billed"]);
  assertEquals(po.bills.map((b: any) => [b.invoice_number, b.rule, b.matched_po_number, b.matched_in, b.cost_on_this_job]), [
    ["INV-87293", "po_number", "PO-302382", "supplier_pdf", true],
  ]);
});

Deno.test("rules (e) and (f): a bill tied by our own records reads billed, with its rule and where it was found", async () => {
  const PO = "b4200000-0000-4000-8000-000000000021";
  const body = await dispatchOrders(job({
    v_dispatch_orders: [ORDERS[1], {
      order_kind: "purchase_order", order_id: PO, job_id: JOB, supplier_name: "R&R Fencing", order_status: "confirmed",
      ordered_at: "2026-09-10T23:34:54Z", order_label: "PO-294460",
    }],
    v_dispatch_order_bills: [
      {
        ...cmiBill(), order_id: PO, xero_invoice_id: "bill-rr", invoice_number: "INV-86846", bill_contact_name: "R&R FENCING",
        bill_sub_total: 1058, rule: "bill_number", matched_ref: null, matched_in: "order",
      },
      {
        ...cmiBill(), order_id: METROLL_ORDER, xero_invoice_id: "bill-met", invoice_number: "1059031",
        bill_contact_name: "Metroll Perth", bill_sub_total: 2442.73, rule: "job_number", matched_ref: null,
        matched_job_number: "SWP-261309", matched_in: "pdf_email",
      },
    ],
    v_job_cost_events: [
      { job_id: JOB, source: "supplier_bill", document_id: "bill-rr", is_actual: true, amount_ex: 1058 },
      { job_id: JOB, source: "supplier_bill", document_id: "bill-met", is_actual: true, amount_ex: 2442.73 },
    ],
  }));
  const d = body.dispatch_orders;
  assertEquals([d.ordered, d.billed, d.not_billed], [2, 2, 0]);
  assertEquals(d.orders.flatMap((o: any) => o.bills.map((b: any) => [o.order_label, b.invoice_number, b.rule, b.matched_job_number, b.matched_in, b.cost_on_this_job])), [
    ["Material Order Ref SWP-261309", "1059031", "job_number", "SWP-261309", "pdf_email", true],
    ["PO-294460", "INV-86846", "bill_number", null, "order", true],
  ]);
});
