// deno-lint-ignore-file no-explicit-any
// Other supplier orders on a Dispatch job (W3 cost check, 19 Oct 2026).
//
// A Dispatch order is one of several ways a `purchase_orders` row reaches a
// job. The office "Create PO" press (`create_po`, source null) makes a PRICED
// order on any job, and the quote builder press (`quote_builder_version_id`,
// behind `quote_builder_orders_v1`) makes priced drafts. If the same materials
// are also ordered through Dispatch, Job Profit counts them twice: the bill
// quotes our Dispatch PO number and lands on the Dispatch order as actual,
// while the other order is never consumed and stays in committed
// (`job_profit_engine.sql`, the `po` lane).
//
// Two pure reads, no write and no refusal:
//   - `otherOpenSupplierOrders`: the job's open non-Dispatch orders, for the
//     Dispatch screen before an order is sent. It never carries a dollar
//     figure, because Dispatch shows no prices by design; `priced` says only
//     whether the other order holds one.
//   - `jobOrderOverlap`: the Job Profit flag. A job holding both a Dispatch
//     order and an open priced order from another source is flagged "two
//     orders, check one", with each side listed and NEVER summed. A shared
//     supplier is matched by `supplier_id` only, never by name (a supplier
//     name is no key).
//
// "Committed" mirrors the engine's `po` lane exactly, so the flag names the
// orders the engine is counting today. Changing that lane is a migration to
// the engine view, held for review; this module only reads.

export const DISPATCH_OTHER_ORDERS_SCHEMA = "dispatch-other-supplier-orders.v1";

// What the read must select. No money columns leave this module on the
// Dispatch side; they are read only to decide `priced`.
export const OTHER_SUPPLIER_ORDER_SELECT =
  "id, job_id, po_number, supplier_name, supplier_id, source, status, subtotal, total, xero_po_id, xero_bill_id, invoice_received_at, quote_builder_version_id, created_at";

export type OrderOrigin = "dispatch" | "quote_builder" | "office_or_xero";

// Statuses the engine treats as no longer an order at all.
const CLOSED_STATUSES = new Set([
  "billed",
  "cancelled",
  "canceled",
  "void",
  "voided",
  "deleted",
]);

function text(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return s === "" ? null : s;
}

// The engine's ex-GST amount: subtotal, else total / 1.1
// (job_profit_engine.sql, po lane).
function amountOf(order: any): number | null {
  const num = (raw: unknown) => {
    if (raw === null || raw === undefined || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const subtotal = num(order?.subtotal);
  if (subtotal !== null) return subtotal;
  const total = num(order?.total);
  return total === null ? null : Math.round((total / 1.1) * 100) / 100;
}

export function orderOrigin(order: any): OrderOrigin {
  if (text(order?.source) === "dispatch") return "dispatch";
  if (text(order?.quote_builder_version_id)) return "quote_builder";
  return "office_or_xero";
}

// Still an order nobody has billed: not closed, no bill linked, no invoice
// received, and (when bill facts are supplied) no actual bill matched to it.
export function isOpenOrder(
  order: any,
  billedOrderIds: ReadonlySet<string> = new Set(),
): boolean {
  const status = String(order?.status ?? "").trim().toLowerCase();
  if (CLOSED_STATUSES.has(status)) return false;
  if (text(order?.xero_bill_id)) return false;
  if (text(order?.invoice_received_at)) return false;
  if (billedOrderIds.has(String(order?.id ?? ""))) return false;
  return true;
}

// The engine's `po` lane: open, not a draft, and an amount present (0
// included; a Dispatch order is committed at $0).
export function countsInCommitted(
  order: any,
  billedOrderIds: ReadonlySet<string> = new Set(),
): boolean {
  if (!text(order?.job_id)) return false;
  if (!isOpenOrder(order, billedOrderIds)) return false;
  if (String(order?.status ?? "").trim().toLowerCase() === "draft") {
    return false;
  }
  return amountOf(order) !== null;
}

export function isPriced(order: any): boolean {
  const amount = amountOf(order);
  return amount !== null && amount > 0;
}

export interface OtherSupplierOrder {
  id: string;
  po_number: string | null;
  supplier_name: string | null;
  supplier_id: string | null;
  origin: Exclude<OrderOrigin, "dispatch">;
  status: string | null;
  priced: boolean;
  in_committed: boolean;
}

export interface OtherSupplierOrdersAnswer {
  schema: typeof DISPATCH_OTHER_ORDERS_SCHEMA;
  orders: OtherSupplierOrder[];
  // One plain sentence for the screen, shown verbatim (no prices, no em
  // dash), null when there is nothing to say.
  note: string | null;
}

const ORIGIN_WORDS: Record<Exclude<OrderOrigin, "dispatch">, string> = {
  office_or_xero: "the old order screen or Xero",
  quote_builder: "the quote builder",
};

function describe(order: OtherSupplierOrder): string {
  const name = order.po_number ?? "an order with no number";
  return order.supplier_name ? `${name} (${order.supplier_name})` : name;
}

export function otherOpenSupplierOrders(
  orders: any[],
): OtherSupplierOrdersAnswer {
  const others: OtherSupplierOrder[] = [];
  for (const order of orders ?? []) {
    const origin = orderOrigin(order);
    if (origin === "dispatch" || !isOpenOrder(order)) continue;
    others.push({
      id: String(order.id),
      po_number: text(order.po_number),
      supplier_name: text(order.supplier_name),
      supplier_id: text(order.supplier_id),
      origin,
      status: text(order.status),
      priced: isPriced(order),
      in_committed: countsInCommitted(order),
    });
  }
  others.sort((a, b) =>
    String(a.po_number ?? "").localeCompare(String(b.po_number ?? ""), "en") ||
    a.id.localeCompare(b.id, "en")
  );
  let note: string | null = null;
  if (others.length > 0) {
    const origins = [...new Set(others.map((o) => ORIGIN_WORDS[o.origin]))];
    note = `This job already has ${others.map(describe).join(", ")} from ${
      origins.join(" and ")
    }, so check you are not ordering the same materials twice.`;
  }
  return { schema: DISPATCH_OTHER_ORDERS_SCHEMA, orders: others, note };
}

// ── Job Profit flag ──────────────────────────────────────────────────────────

export type JobOrderOverlapFlag =
  | "none"
  // Both kinds, and at least one shared supplier_id.
  | "two_orders_same_supplier"
  // Both kinds, no shared supplier we can prove (names are never compared).
  | "two_orders_check_one";

export interface OverlapSide {
  id: string;
  po_number: string | null;
  supplier_id: string | null;
  origin: OrderOrigin;
  status: string | null;
  amount_ex: number | null;
  in_committed: boolean;
  billed_ex: number | null;
}

export interface JobOrderOverlap {
  schema: typeof DISPATCH_OTHER_ORDERS_SCHEMA;
  job_id: string;
  flag: JobOrderOverlapFlag;
  shared_supplier_ids: string[];
  dispatch_orders: OverlapSide[];
  // Open priced orders from any other source.
  other_priced_orders: OverlapSide[];
  // Each side's own committed figure. Deliberately no combined total: the
  // point of the flag is that adding these may count one delivery twice.
  other_committed_ex: number;
  dispatch_billed_ex: number;
}

// Actual bill facts (`job_materials_facts` kind `actual`) matched to ANY of
// the job's orders: read by `matched_po_id` in the job's order ids, from any
// job, as the engine does. The amounts are what was billed against these
// orders, not the engine's actual lane (which drops a fact whose bill has
// bill lines on the job).
export interface BillFact {
  matched_po_id: string | null;
  amount_ex: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function jobOrderOverlap(input: {
  job_id: string;
  orders: any[];
  bill_facts?: BillFact[] | null;
}): JobOrderOverlap {
  const billedOn = new Map<string, number>();
  for (const fact of input.bill_facts ?? []) {
    const id = text(fact?.matched_po_id);
    if (!id) continue;
    const n = Number(fact?.amount_ex);
    billedOn.set(id, (billedOn.get(id) ?? 0) + (Number.isFinite(n) ? n : 0));
  }
  const billedIds = new Set(billedOn.keys());
  const side = (order: any): OverlapSide => ({
    id: String(order.id),
    po_number: text(order.po_number),
    supplier_id: text(order.supplier_id),
    origin: orderOrigin(order),
    status: text(order.status),
    amount_ex: amountOf(order),
    in_committed: countsInCommitted(order, billedIds),
    billed_ex: billedOn.has(String(order.id))
      ? round2(billedOn.get(String(order.id))!)
      : null,
  });

  const dispatch = (input.orders ?? [])
    .filter((o) => orderOrigin(o) === "dispatch")
    .filter((o) => !CLOSED_STATUSES.has(String(o?.status ?? "").toLowerCase()))
    .map(side);
  const others = (input.orders ?? [])
    .filter((o) => orderOrigin(o) !== "dispatch")
    .filter((o) => isOpenOrder(o, billedIds) && isPriced(o))
    .map(side);

  const dispatchSuppliers = new Set(
    dispatch.map((d) => d.supplier_id).filter(Boolean) as string[],
  );
  const shared = [
    ...new Set(
      others.map((o) => o.supplier_id).filter((id): id is string =>
        !!id && dispatchSuppliers.has(id)
      ),
    ),
  ].sort();

  let flag: JobOrderOverlapFlag = "none";
  if (dispatch.length > 0 && others.length > 0) {
    flag = shared.length > 0
      ? "two_orders_same_supplier"
      : "two_orders_check_one";
  }
  return {
    schema: DISPATCH_OTHER_ORDERS_SCHEMA,
    job_id: input.job_id,
    flag,
    shared_supplier_ids: shared,
    dispatch_orders: dispatch,
    other_priced_orders: others,
    other_committed_ex: round2(
      others.filter((o) => o.in_committed).reduce(
        (sum, o) => sum + (o.amount_ex ?? 0),
        0,
      ),
    ),
    dispatch_billed_ex: round2(
      dispatch.reduce((sum, d) => sum + (d.billed_ex ?? 0), 0),
    ),
  };
}
