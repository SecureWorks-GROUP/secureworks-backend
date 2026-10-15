// Two small rules on the existing purchase order paths, fixed by Dispatch
// slice 5 (docs/dispatch-slice-5-contract.md, "Fixes to existing code").
// Pure, so they are tested beside this file.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// create_po: purchase_orders.created_by is a uuid with a foreign key to users,
// so it takes the signed-in user's id or null, never an email. The screen's
// operator_email (or a caller's user_email) goes in created_by_email. Before
// this, every create_po from the signed-in Ops screen wrote an email into the
// uuid column and was refused by the database.
export function purchaseOrderCreatedBy(
  sessionUserId: string | null | undefined,
  body: { operator_email?: unknown; user_email?: unknown } | null | undefined,
): { created_by: string | null; created_by_email: string | null } {
  const id = typeof sessionUserId === "string" && UUID_RE.test(sessionUserId)
    ? sessionUserId
    : null;
  const raw = body?.operator_email ?? body?.user_email;
  const email = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  return { created_by: id, created_by_email: email };
}

// analyse_supplier_quote: a supplier's reply may move an order's status, its
// confirmed delivery date or its invoice-received stamp only when the order
// was NOT made in Dispatch. A Dispatch order's reply is filed and shown and
// moves nothing (ruling O13); the classification on the message and the
// review annotations stay.
export function supplierReplyMayMoveOrder(
  order: { source?: unknown } | null | undefined,
): boolean {
  return order?.source !== "dispatch";
}
