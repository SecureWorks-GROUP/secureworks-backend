// deno-lint-ignore-file no-explicit-any
// Dispatch purchase orders never go to Xero and never go out through the old
// order email paths.
//
// An order made in the Dispatch tab (purchase_orders.source = 'dispatch') is
// sent from Dispatch itself, once, on a person's press. If the old PO board or
// an agent could also push it to Xero or email it, the supplier would get the
// same order twice and Xero would hold an order nobody meant to put there.
// So three paths refuse a Dispatch order before they do anything:
//   - ops-api push_po_to_xero (and the auto-push when a job is accepted, which
//     already skips Dispatch orders by its own read)
//   - ops-api email_po (Xero's own order email)
//   - the send-po-email function (the Resend order email)
//
// The refusal is a 409 with code `dispatch_po_refused`, raised before any
// Xero token is read, any job is read or any email is built.

export const DISPATCH_PO_REFUSED_CODE = "dispatch_po_refused";

export type DispatchPoGuardedAction =
  | "push_po_to_xero"
  | "email_po"
  | "send_po_email";

// True when the order was made in the Dispatch tab.
export function isDispatchPurchaseOrder(po: any): boolean {
  return String(po?.source ?? "").trim().toLowerCase() === "dispatch";
}

const ACTION_WORDS: Record<DispatchPoGuardedAction, string> = {
  push_po_to_xero: "pushed to Xero",
  email_po: "emailed from Xero",
  send_po_email: "emailed from here",
};

// The plain message and body for the refusal. No em dash, no emoji.
export function dispatchPoRefusal(
  action: DispatchPoGuardedAction,
  po: { id?: unknown; po_number?: unknown } | null | undefined,
) {
  const ref = String(po?.po_number ?? "").trim() || "This order";
  const message =
    `${ref} was made in the Dispatch tab, so it cannot be ${
      ACTION_WORDS[action]
    }. Send it from the job's Dispatch tab instead.`;
  return {
    status: 409 as const,
    message,
    body: {
      error: message,
      code: DISPATCH_PO_REFUSED_CODE,
      action,
      po_id: po?.id ?? null,
    },
  };
}
