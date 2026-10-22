// The untagged reply fallback (supplier email defects, 20 Oct 2026).
//
// A supplier reply that carries no order tag in its address or subject may be
// placed on an order by its sender only when the sender names exactly one
// active supplier AND that supplier has exactly one open order. Anything
// else goes to unmatched_emails for a person to place: a reply on the wrong
// job is worse than a reply waiting to be placed.

export type SupplierRow = { id: string; name: string; email: string | null };
export type OpenOrderRow = {
  id: string;
  job_id: string | null;
  po_number: string;
};

export type SenderMatch =
  | { kind: "matched"; supplier: SupplierRow; order: OpenOrderRow }
  | {
    kind: "unplaced";
    reason:
      | "no_sender"
      | "no_supplier"
      | "several_suppliers"
      | "no_open_order"
      | "several_open_orders";
  };

// Email addresses compare without case and surrounding spaces.
export function normaliseEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// PostgREST `ilike` treats % and _ as wildcards and \ as their escape; the
// pattern must match only the literal address.
export function ilikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// The suppliers whose stored email is exactly the sender, case aside.
export function suppliersForSender(
  rows: SupplierRow[],
  fromEmail: unknown,
): SupplierRow[] {
  const sender = normaliseEmail(fromEmail);
  if (!sender) return [];
  return rows.filter((row) => normaliseEmail(row.email) === sender);
}

// Open orders for a supplier, read twice (by id and by name), are merged by
// order id so one order read both ways counts once.
export function mergeOrders(...lists: OpenOrderRow[][]): OpenOrderRow[] {
  const seen = new Map<string, OpenOrderRow>();
  for (const list of lists) {
    for (const row of list || []) if (row?.id) seen.set(row.id, row);
  }
  return [...seen.values()];
}

export function decideSenderMatch(
  fromEmail: unknown,
  suppliers: SupplierRow[],
  openOrders: OpenOrderRow[] | null,
): SenderMatch {
  if (!normaliseEmail(fromEmail)) return { kind: "unplaced", reason: "no_sender" };
  const matched = suppliersForSender(suppliers, fromEmail);
  if (matched.length === 0) return { kind: "unplaced", reason: "no_supplier" };
  if (matched.length > 1) {
    return { kind: "unplaced", reason: "several_suppliers" };
  }
  const orders = openOrders || [];
  if (orders.length === 0) return { kind: "unplaced", reason: "no_open_order" };
  if (orders.length > 1) {
    return { kind: "unplaced", reason: "several_open_orders" };
  }
  return { kind: "matched", supplier: matched[0], order: orders[0] };
}
