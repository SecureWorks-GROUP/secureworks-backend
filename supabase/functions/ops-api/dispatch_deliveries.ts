// deno-lint-ignore-file no-explicit-any
// Dispatch slice 6: Deliveries. The rules, pure.
// Contract: docs/dispatch-slice-6-contract.md.
//
// Which orders are rows and in what order, which orders count, the three cells
// (expected, confirmed by supplier, sighted on site) and the row step, whether
// the expected date may be edited, the all-sighted rule, the rail line's text
// and the date check are worked out HERE ONLY. The dispatch_materials read,
// the three dispatch_delivery_* writes and the pipeline&dispatch=1 list all
// call these, so they cannot disagree.

// The order columns the Deliveries rules read, beyond slice 5's
// DISPATCH_ORDER_SELECT. Verified against the live schema on 15 Oct 2026; the
// six *_set_* / *_sighted_* columns are this slice's migration. No price,
// total, account or tax column.
export const DISPATCH_DELIVERY_ORDER_COLUMNS =
  "po_type, delivery_date, confirmed_delivery_date, confirmed_delivery_set_at, confirmed_delivery_set_by, confirmed_delivery_set_by_email, delivery_sighted_at, delivery_sighted_by, delivery_sighted_by_email";

// The list read's purchase order columns under dispatch=1 (plain pipeline
// keeps `job_id` alone).
export const DISPATCH_DELIVERY_LIST_SELECT =
  "job_id, id, status, po_type, delivery_sighted_at";

// An order's status that says the supplier confirmed it, with no date given.
const CONFIRMED_STATUSES = new Set(["confirmed", "delivered", "billed"]);
const GONE_STATUSES = new Set(["cancelled", "deleted"]);

export type DispatchConfirmedState =
  | "date"
  | "status_only"
  | "waiting"
  | "not_confirmed";

export type DispatchDelivery = {
  expected: string | null;
  expected_editable: boolean;
  confirmed: {
    state: DispatchConfirmedState;
    date: string | null;
    set_by: string | null;
    set_at: string | null;
    by_hand: boolean;
  };
  sighted: { at: string; by: string | null } | null;
  step: 0 | 1 | 2 | 3;
  counted: boolean;
};

export type DispatchDeliverySummary = {
  counted: number;
  sighted: number;
  all_sighted: boolean;
};

// user id -> users.name. A failed users read passes an empty map; names then
// fall back to the stored emails.
export type DispatchPersonNames = Map<string, string>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isDispatchOrderGone(order: any): boolean {
  return GONE_STATUSES.has(String(order?.status ?? "").toLowerCase());
}

// Labour and subcontract orders deliver no materials.
export function isDispatchMaterialOrder(order: any): boolean {
  const poType = text(order?.po_type);
  return poType === null || poType === "material";
}

// Counted: not cancelled or deleted, po_type material or none. Drafts and
// orders made outside Dispatch count. The same set is the table's order rows.
export function isDispatchDeliveryCounted(order: any): boolean {
  return !isDispatchOrderGone(order) && isDispatchMaterialOrder(order);
}

export function isDispatchOrderSighted(order: any): boolean {
  return !!order?.delivery_sighted_at;
}

export function isDispatchMadeInDispatch(order: any): boolean {
  return order?.source === "dispatch" && !!order?.supplier_id;
}

function personName(
  id: unknown,
  email: unknown,
  names: DispatchPersonNames,
): string | null {
  const key = typeof id === "string" ? id : "";
  return (key && names.get(key)) || text(email);
}

// Every person id the rows name, for the one users read.
export function dispatchDeliveryPersonIds(orders: any[]): string[] {
  const ids = new Set<string>();
  for (const order of orders || []) {
    for (
      const id of [order?.confirmed_delivery_set_by, order?.delivery_sighted_by]
    ) {
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return [...ids];
}

export function dispatchConfirmedState(order: any): DispatchConfirmedState {
  if (order?.confirmed_delivery_date) return "date";
  if (CONFIRMED_STATUSES.has(String(order?.status ?? "").toLowerCase())) {
    return "status_only";
  }
  return isDispatchOrderSighted(order) ? "not_confirmed" : "waiting";
}

export function dispatchDelivery(
  order: any,
  names: DispatchPersonNames = new Map(),
): DispatchDelivery {
  const state = dispatchConfirmedState(order);
  const byHand = !!order?.confirmed_delivery_set_at;
  const sighted = isDispatchOrderSighted(order)
    ? {
      at: String(order.delivery_sighted_at),
      by: personName(
        order.delivery_sighted_by,
        order.delivery_sighted_by_email,
        names,
      ),
    }
    : null;
  return {
    expected: order?.delivery_date ?? null,
    // The Xero order sync overwrites delivery_date from Xero, so the date is
    // read only on an order in Xero.
    expected_editable: !order?.xero_po_id,
    confirmed: {
      state,
      date: order?.confirmed_delivery_date ?? null,
      set_by: byHand
        ? personName(
          order.confirmed_delivery_set_by,
          order.confirmed_delivery_set_by_email,
          names,
        )
        : null,
      set_at: byHand ? String(order.confirmed_delivery_set_at) : null,
      by_hand: byHand,
    },
    sighted,
    step: sighted ? 3 : (state === "date" || state === "status_only") ? 2 : 1,
    counted: isDispatchDeliveryCounted(order),
  };
}

export function dispatchDeliverySummary(
  orders: any[] | null | undefined,
): DispatchDeliverySummary {
  const counted = (orders || []).filter(isDispatchDeliveryCounted);
  const sighted = counted.filter(isDispatchOrderSighted).length;
  return {
    counted: counted.length,
    sighted,
    all_sighted: counted.length > 0 && sighted === counted.length,
  };
}

function oldestFirst(a: any, b: any): number {
  const at = String(a?.created_at ?? "");
  const bt = String(b?.created_at ?? "");
  if (at !== bt) return at < bt ? -1 : 1;
  const ai = String(a?.id ?? "");
  const bi = String(b?.id ?? "");
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

export type DispatchDeliveryOrderRow = {
  kind: "order";
  purchase_order_id: string;
  po_number: string | null;
  supplier_name: string | null;
  supplier_id: string | null;
  made_in_dispatch: boolean;
  in_xero: boolean;
  status: string | null;
  updated_at: string | null;
  delivery: DispatchDelivery;
  // S5, only when the caller read the receipts.
  on_site?: boolean;
  lines_part_delivered?: number;
};

// S5: which orders are on site and how many of each order's lines read Part
// delivered (dispatchLineDeliveryView in dispatch_line_receipts.ts).
export type DispatchOrderOnSite = {
  onSiteOrderIds: ReadonlySet<string>;
  partByOrder: ReadonlyMap<string, number>;
};

export type DispatchDeliveryRow =
  | DispatchDeliveryOrderRow
  | { kind: "not_ordered"; supplier_id: string; supplier_name: string | null };

function orderRow(
  order: any,
  names: DispatchPersonNames,
  supplierName?: string | null,
  onSite?: DispatchOrderOnSite,
): DispatchDeliveryOrderRow {
  const row: DispatchDeliveryOrderRow = {
    kind: "order",
    purchase_order_id: String(order.id),
    po_number: order.po_number ?? null,
    supplier_name: supplierName ?? order.supplier_name ?? null,
    supplier_id: order.supplier_id ?? null,
    made_in_dispatch: isDispatchMadeInDispatch(order),
    in_xero: !!order.xero_po_id,
    status: order.status ?? null,
    updated_at: order.updated_at ?? null,
    delivery: dispatchDelivery(order, names),
  };
  if (onSite) {
    row.on_site = onSite.onSiteOrderIds.has(String(order.id));
    row.lines_part_delivered = onSite.partByOrder.get(String(order.id)) ?? 0;
  }
  return row;
}

// The table: per chosen supplier (in the order given, slice 4's position
// order), its Dispatch orders oldest first, else one not_ordered row; then
// every other order on the job, oldest first. Cancelled, deleted and
// non-material orders are never rows. An outside order is never put under a
// chosen supplier, even when the names match.
export function dispatchDeliveryRows(
  suppliers: { supplier_id: unknown; name?: unknown }[],
  orders: any[],
  names: DispatchPersonNames = new Map(),
  onSite?: DispatchOrderOnSite,
): DispatchDeliveryRow[] {
  const rows: DispatchDeliveryRow[] = [];
  const live = (orders || []).filter(isDispatchDeliveryCounted).sort(
    oldestFirst,
  );
  const placed = new Set<string>();
  for (const supplier of suppliers || []) {
    const supplierId = String(supplier?.supplier_id ?? "");
    if (!supplierId) continue;
    const supplierName = text(supplier?.name);
    const own = live.filter((o) =>
      o.source === "dispatch" && String(o.supplier_id ?? "") === supplierId
    );
    if (own.length === 0) {
      rows.push({
        kind: "not_ordered",
        supplier_id: supplierId,
        supplier_name: supplierName,
      });
      continue;
    }
    for (const order of own) {
      placed.add(String(order.id));
      rows.push(orderRow(order, names, supplierName, onSite));
    }
  }
  for (const order of live) {
    if (!placed.has(String(order.id))) {
      rows.push(orderRow(order, names, undefined, onSite));
    }
  }
  return rows;
}

// The rail line (slice 3's rail panel), only with a counted order. Stage
// index 1 to 6 is the rail stop; 0 or null is not on the rail yet. It moves
// nothing. S5 (docs/dispatch-partial-deliveries-v1.md): `sighted` is the
// count of orders on site (sighted, or every line received). With any line part
// delivered the line says how many; when `sightedOnly` (orders actually
// sighted) is given and differs, the line says "on site", never "sighted".
// With neither it reads as slice 6 did.
export function dispatchDeliveryRailLine(
  total: number | null | undefined,
  sighted: number | null | undefined,
  stageIndex: number | null | undefined,
  partLines?: number | null,
  sightedOnly?: number | null,
): string | null {
  if (typeof total !== "number" || typeof sighted !== "number") return null;
  if (total <= 0) return null;
  const orders = `order${total === 1 ? "" : "s"}`;
  const atStop = typeof stageIndex === "number" && stageIndex >= 5;
  if (typeof partLines === "number" && partLines > 0) {
    return `${sighted} of ${total} ${orders} on site; ${partLines} line${
      partLines === 1 ? "" : "s"
    } part delivered.`;
  }
  if (typeof sightedOnly === "number" && sightedOnly !== sighted) {
    if (sighted < total) return `${sighted} of ${total} ${orders} on site.`;
    return atStop
      ? "Every order on this job is on site."
      : "Every order on this job is on site. Press Materials on site to move the job.";
  }
  if (sighted < total) return `${sighted} of ${total} orders sighted on site.`;
  return atStop
    ? "Every order on this job is sighted on site."
    : "Every order on this job is sighted on site. Press Materials on site to move the job.";
}

// A real calendar date YYYY-MM-DD (no 30 February).
export function isDispatchDeliveryDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d;
}

// Order ids whose delivery is sighted: lines on these orders read Delivered.
export function dispatchSightedOrderIds(
  orders: any[] | null | undefined,
): Set<string> {
  return new Set(
    (orders || []).filter((o) => isDispatchOrderSighted(o)).map((o) =>
      String(o.id)
    ),
  );
}

// The list's two per-row fields. Only called when the list's order read
// worked: a failed read leaves both off (never 0).
// S5: with the job's lines and receipts read, `onSite` adds the two S5 fields
// (orders on site, lines part delivered); without, the two fields are as
// slice 6 left them.
export function dispatchDeliveryListFields(
  orders: any[] | undefined,
  onSite?: { on_site: number; lines_part_delivered: number },
): {
  deliveries_orders_total: number;
  deliveries_orders_sighted: number;
  deliveries_orders_on_site?: number;
  deliveries_lines_part_delivered?: number;
} {
  const summary = dispatchDeliverySummary(orders || []);
  return {
    deliveries_orders_total: summary.counted,
    deliveries_orders_sighted: summary.sighted,
    ...(onSite
      ? {
        deliveries_orders_on_site: onSite.on_site,
        deliveries_lines_part_delivered: onSite.lines_part_delivered,
      }
      : {}),
  };
}
