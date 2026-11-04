// deno-lint-ignore-file no-explicit-any
// B4 (3 Nov 2026): Job Profit's read of a job's Dispatch orders: ordered, billed, not billed.
//
// An order is a Dispatch v2 supplier order email that went out, or a purchase order that is not a draft or
// cancelled (v_dispatch_orders). A supplier bill links to an order by the owner's rule, in SQL
// (v_dispatch_order_bills, migrations 20261104010000, 20261104040000 and 20261104233000): the bill is from the
// order's supplier and carries a supplier ref saved for that order, our job number, our PO number (on the bill or the
// supplier's PDF of it), or the job's site address on the bill or that PDF when it matches one order of that supplier;
// or our records tie it: the bill's own number written on our purchase order, or our job number in the words of the
// emails that carry the supplier's PDF of the bill. This file only reads those two views and sets each
// linked bill beside the job's own cost events, so staff see whether Job Profit counts that bill on this job.
// Read only: no bill is placed, no figure is computed, and nothing here changes a Job Profit total.

const MAX_ROWS = 500;

const ORDER_COLUMNS = "order_kind, order_id, job_id, supplier_name, order_status, ordered_at, order_label";
const BILL_COLUMNS =
  "order_id, job_id, xero_invoice_id, invoice_number, bill_contact_name, bill_status, bill_date, bill_sub_total, " +
  "supplier_match, rule, matched_ref, matched_job_number, linked, not_linked_reason, matched_po_number, " +
  "matched_site_address, matched_in";

export type DispatchOrderState = "billed" | "not_billed";

export interface DispatchOrderBill {
  xero_invoice_id: string;
  invoice_number: string | null;
  supplier: string | null;
  bill_date: string | null;
  bill_status: string | null;
  bill_sub_total_ex: number | null;
  rule: string;
  matched_ref: string | null;
  matched_job_number: string | null;
  matched_po_number: string | null;
  matched_site_address: string | null;
  // Where it was found, joined by "+": "bill" (its number, reference or lines), "supplier_pdf", "pdf_email" (the
  // emails that carry the supplier's PDF), "order" (our purchase order's reference or notes).
  matched_in: string | null;
  cost_on_this_job: boolean;
}

export interface DispatchOrderRow {
  order_kind: string;
  order_id: string;
  supplier: string | null;
  order_label: string | null;
  order_status: string | null;
  ordered_at: string | null;
  state: DispatchOrderState;
  bills: DispatchOrderBill[];
  unclear_bills: Array<{ xero_invoice_id: string; invoice_number: string | null; reason: string | null }>;
}

export interface JobDispatchOrders {
  status: "ok" | "unknown";
  reason: string | null;
  ordered: number | null;
  billed: number | null;
  not_billed: number | null;
  orders: DispatchOrderRow[];
}

function unknown(reason: string): JobDispatchOrders {
  return { status: "unknown", reason, ordered: null, billed: null, not_billed: null, orders: [] };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The job's Dispatch orders, each with the supplier bills linked to it by rule. */
export async function readJobDispatchOrders(
  client: any,
  jobId: string,
  costEvents: any[],
): Promise<JobDispatchOrders> {
  let orders: any, bills: any;
  try {
    orders = await client.from("v_dispatch_orders").select(ORDER_COLUMNS).eq("job_id", jobId)
      .order("ordered_at", { ascending: true }).limit(MAX_ROWS + 1);
  } catch {
    return unknown("orders_unreadable");
  }
  if (!orders || orders.error || !Array.isArray(orders.data)) return unknown("orders_unreadable");
  if (orders.data.length > MAX_ROWS) return unknown("order_coverage_limit");
  // Most jobs have no Dispatch order: the bill links (about 0.15 s on production) are read only when one exists.
  if (orders.data.length === 0) return { status: "ok", reason: null, ordered: 0, billed: 0, not_billed: 0, orders: [] };
  try {
    bills = await client.from("v_dispatch_order_bills").select(BILL_COLUMNS).eq("job_id", jobId).limit(MAX_ROWS + 1);
  } catch {
    return unknown("bills_unreadable");
  }
  if (!bills || bills.error || !Array.isArray(bills.data)) return unknown("bills_unreadable");
  if (bills.data.length > MAX_ROWS) return unknown("order_coverage_limit");

  // Job Profit counts a bill on this job when the job's cost events hold an actual row of that document.
  const countedHere = new Set(
    costEvents.filter((e) => e && e.is_actual && e.document_id).map((e) => String(e.document_id)),
  );
  const rows: DispatchOrderRow[] = orders.data.map((o: any) => {
    const named = bills.data.filter((b: any) => b.order_id === o.order_id && b.job_id === jobId);
    const linked = named.filter((b: any) => b.linked === true);
    return {
      order_kind: String(o.order_kind),
      order_id: String(o.order_id),
      supplier: o.supplier_name ?? null,
      order_label: o.order_label ?? null,
      order_status: o.order_status ?? null,
      ordered_at: o.ordered_at ?? null,
      state: linked.length > 0 ? "billed" : "not_billed",
      bills: linked.map((b: any) => ({
        xero_invoice_id: String(b.xero_invoice_id),
        invoice_number: b.invoice_number ?? null,
        supplier: b.bill_contact_name ?? null,
        bill_date: b.bill_date ?? null,
        bill_status: b.bill_status ?? null,
        bill_sub_total_ex: num(b.bill_sub_total),
        rule: String(b.rule),
        matched_ref: b.matched_ref ?? null,
        matched_job_number: b.matched_job_number ?? null,
        matched_po_number: b.matched_po_number ?? null,
        matched_site_address: b.matched_site_address ?? null,
        matched_in: b.matched_in ?? null,
        cost_on_this_job: countedHere.has(String(b.xero_invoice_id)),
      })),
      unclear_bills: named.filter((b: any) => b.linked !== true).map((b: any) => ({
        xero_invoice_id: String(b.xero_invoice_id),
        invoice_number: b.invoice_number ?? null,
        reason: b.not_linked_reason ?? null,
      })),
    };
  });
  const billed = rows.filter((r) => r.state === "billed").length;
  return { status: "ok", reason: null, ordered: rows.length, billed, not_billed: rows.length - billed, orders: rows };
}
