// A way out of "pending acknowledgment" (B5, 6 Nov 2026).
//
// generate_trade_invoice saves an invoice as pending_acknowledgment and then
// pushes it to Xero. When the push never ran (a timeout between the save and
// the push, or older code), the invoice sat there with no bill, no office
// hold and no action that could move it: approve_trade_invoice takes only
// pending_ops_review or queried, and the push takes only acknowledged or
// approved.
//
// Two changes:
// - markTradeInvoiceReadyForXero: before the push, an invoice with no office
//   hold moves to approved, the state a failed push already lands in, so the
//   office's "push to Xero" can always finish it.
// - resolveStuckTradeInvoice: an office person resolves one stuck invoice with
//   a reason, either releasing it (the week is free to invoice again) or
//   sending it on to Xero. An invoice held for office line review is not
//   stuck: its line review is the way out.
import { xeroSyncRefusal } from "./crew_invoice_job_work_order.ts";
import { isGroupShareLine } from "./group_work_order.ts";
import { recordTradeInvoiceEvent } from "./trade_invoice_events.ts";
import { TradeXeroBillSearchError } from "./trade_invoice_xero_existing_bill.ts";

type Row = Record<string, any>;

export const STUCK_TRADE_INVOICE_STATUS = "pending_acknowledgment";
export type StuckDecision = "release" | "send_to_xero";

export class StuckTradeInvoiceError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function fail(status: number, code: string, message: string): never {
  throw new StuckTradeInvoiceError(status, code, message);
}

/** The invoice is saved and nothing holds it, so it is ready for Xero. A
 * compare-and-set from pending_acknowledgment with no bill; anything else is
 * left alone. Returns whether it moved. */
export async function markTradeInvoiceReadyForXero(
  client: any,
  invoiceId: string,
): Promise<boolean> {
  const { data, error } = await client.from("trade_invoices")
    .update({ status: "approved" })
    .eq("id", invoiceId)
    .eq("status", STUCK_TRADE_INVOICE_STATUS)
    .is("xero_bill_id", null)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error(
      `[trade_invoice_stuck] invoice ${invoiceId} could not be marked ready for Xero: ${error.message}`,
    );
    return false;
  }
  return data?.id === invoiceId;
}

const DECISIONS: Record<string, StuckDecision> = {
  release: "release",
  send_to_xero: "send_to_xero",
  send: "send_to_xero",
};

export interface StuckResolveActor {
  staff: boolean;
  userId: string | null;
  label: string;
}

/** Live Xero bills that may already be this invoice's, found by its number.
 * Throws when Xero cannot be searched. */
export type FindLiveTradeBills = (invoiceNumber: string) => Promise<Row[]>;

export async function resolveStuckTradeInvoice(
  client: any,
  body: Row,
  actor: StuckResolveActor,
  deps: { findLiveBills: FindLiveTradeBills },
): Promise<Row> {
  if (!actor.staff) {
    fail(403, "operator_access_required", "An authorised operator session is required.");
  }
  const invoiceId = String(body?.invoice_id || "").trim();
  const decision = DECISIONS[String(body?.decision || "").trim().toLowerCase()];
  const reason = String(body?.reason || "").trim();
  if (!invoiceId) fail(400, "invoice_id_required", "invoice_id is required.");
  if (!decision) {
    fail(400, "invalid_decision", "decision must be release or send_to_xero.");
  }
  if (reason.length < 3 || reason.length > 500) {
    fail(400, "reason_required", "Give a reason of 3 to 500 characters.");
  }

  const { data: invoice, error: readErr } = await client.from("trade_invoices")
    .select("id, user_id, status, xero_bill_id, query_note, invoice_number")
    .eq("id", invoiceId)
    .maybeSingle();
  if (readErr) fail(503, "invoice_unreadable", "The invoice could not be read.");
  if (!invoice) fail(404, "invoice_not_found", "Invoice not found.");
  if (actor.userId && String(invoice.user_id) === String(actor.userId)) {
    fail(403, "self_resolution_forbidden", "You cannot resolve an invoice you submitted.");
  }
  if (invoice.status !== STUCK_TRADE_INVOICE_STATUS) {
    fail(
      409,
      "invoice_not_stuck",
      "Only an invoice waiting in pending acknowledgment can be resolved here.",
    );
  }
  if (invoice.xero_bill_id) {
    fail(
      409,
      "invoice_already_in_xero",
      "This invoice already has a Xero bill. Check that bill in Xero instead.",
    );
  }

  const { data: lines, error: linesErr } = await client.from("trade_invoice_lines")
    .select("id, line_type, group_share_id, office_review_status")
    .eq("trade_invoice_id", invoiceId);
  if (linesErr) fail(503, "lines_unreadable", "The invoice lines could not be read.");
  const rows: Row[] = lines || [];
  if (rows.some((row) => isGroupShareLine(row))) {
    fail(
      409,
      "group_invoice_uses_group_release",
      "A group share invoice is released through its group, not here.",
    );
  }
  const hold = xeroSyncRefusal(rows);
  if (hold) {
    fail(
      409,
      hold.code,
      "A line on this invoice is held for office review. Review that line instead.",
    );
  }

  // No saved bill id does not prove there is no bill: a create whose reply was
  // lost leaves a bill in Xero and nothing here. Releasing then frees the week,
  // the next submission gets a new number, and a second bill would be paid for
  // the same work. So a release first looks in Xero by this invoice's number,
  // and refuses if a live bill is there or Xero cannot be searched.
  let xeroChecked: { live_bills: number } | null = null;
  if (decision === "release") {
    const number = String(invoice.invoice_number || "").trim();
    if (!number) {
      fail(
        409,
        "xero_bill_number_missing",
        "This invoice has no number to check in Xero, so it was not released. Check Xero by hand.",
      );
    }
    let live: Row[];
    try {
      live = await deps.findLiveBills(number);
    } catch (e) {
      if (e instanceof TradeXeroBillSearchError && e.status !== 503) fail(e.status, e.code, e.message);
      fail(
        503,
        "xero_existing_bill_search_failed",
        "Xero could not be checked for a bill for this invoice, so it was not released. Try again shortly.",
      );
    }
    if (live.length > 0) {
      fail(
        409,
        "xero_bill_exists_for_invoice",
        "Xero already has a live bill for this invoice number, so it was not released. Check that bill in Xero; send it on instead if it is the right bill.",
      );
    }
    xeroChecked = { live_bills: 0 };
  }

  const note = decision === "release"
    ? `Released by the office from pending acknowledgment: ${reason}`
    : `Sent on to Xero by the office from pending acknowledgment: ${reason}`;
  const merged = [invoice.query_note, note].filter(Boolean).join(" | ").slice(0, 2000);
  const { data: moved, error: moveErr } = await client.from("trade_invoices")
    .update({
      status: decision === "release" ? "ops-reject" : "approved",
      query_note: merged,
    })
    .eq("id", invoiceId)
    .eq("status", STUCK_TRADE_INVOICE_STATUS)
    .is("xero_bill_id", null)
    .select("id, status")
    .maybeSingle();
  if (moveErr) fail(503, "resolve_failed", "The decision was not saved.");
  if (!moved) fail(409, "invoice_changed", "The invoice changed. Read it again.");

  const eventRecorded = await recordTradeInvoiceEvent(client, {
    trade_invoice_id: invoiceId,
    event_type: "stuck_invoice_resolved",
    actor: actor.label,
    reason,
    detail: {
      decision,
      prior_status: STUCK_TRADE_INVOICE_STATUS,
      new_status: moved.status,
      invoice_number: invoice.invoice_number ?? null,
      xero_checked: xeroChecked,
    },
  });
  return {
    ok: true,
    invoice_id: invoiceId,
    decision,
    status: moved.status,
    event_recorded: eventRecorded,
  };
}
