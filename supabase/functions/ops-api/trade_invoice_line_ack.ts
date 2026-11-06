// Acknowledging a trade invoice line (B12, 6 Nov 2026).
//
// Before this, `acknowledge_invoice_line` updated any line by id for any
// caller, so a trade could acknowledge someone else's line and turn a rejected
// or released invoice back into a live one. Now:
// - a trade may acknowledge only a line on their own invoice;
// - the invoice must still be waiting for acknowledgement (pending or
//   queried) and must have no Xero bill;
// - a group share line or a line the office rejected cannot be acknowledged
//   here (the office reviews those);
// - the invoice moves to acknowledged only by compare-and-set from a waiting
//   state, only when every line is acknowledged and no line is held for the
//   office.
import { xeroSyncRefusal } from "./crew_invoice_job_work_order.ts";
import { isGroupShareLine } from "./group_work_order.ts";

type Row = Record<string, any>;

export class TradeInvoiceLineAckError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const ACKNOWLEDGEABLE_INVOICE_STATUSES = [
  "pending_acknowledgment",
  "queried",
] as const;

export interface LineAckCaller {
  /** Office staff session or the privileged ops key. */
  staff: boolean;
  /** The signed-in person, when there is one. */
  userId: string | null;
}

function fail(status: number, code: string, message: string): never {
  throw new TradeInvoiceLineAckError(status, code, message);
}

export async function acknowledgeTradeInvoiceLine(
  client: any,
  body: Row,
  caller: LineAckCaller,
): Promise<Row> {
  const lineId = String(body?.line_id || "").trim();
  if (!lineId) fail(400, "line_id_required", "line_id required");
  if (!caller.staff && !caller.userId) {
    fail(403, "not_your_invoice_line", "Sign in to acknowledge your invoice lines.");
  }
  const queried = body?.acknowledged === false;
  const note = typeof body?.query_note === "string"
    ? body.query_note.trim().slice(0, 2000)
    : "";

  const { data: line, error: lineErr } = await client.from("trade_invoice_lines")
    .select(
      "id, trade_invoice_id, line_type, group_share_id, office_review_status, trade_invoices:trade_invoice_id(id, user_id, status, xero_bill_id)",
    )
    .eq("id", lineId)
    .maybeSingle();
  if (lineErr) fail(503, "line_unreadable", "The invoice line could not be read.");
  if (!line) fail(404, "line_not_found", "Invoice line not found.");
  const embed = line.trade_invoices;
  const invoice: Row = (Array.isArray(embed) ? embed[0] : embed) || {};
  if (!invoice.id) fail(404, "line_not_found", "Invoice line not found.");

  if (!caller.staff && String(invoice.user_id || "") !== String(caller.userId)) {
    // Same answer as a missing line: never confirm someone else's line exists.
    fail(404, "line_not_found", "Invoice line not found.");
  }
  if (!(ACKNOWLEDGEABLE_INVOICE_STATUSES as readonly string[]).includes(invoice.status)) {
    fail(
      409,
      "invoice_not_awaiting_acknowledgment",
      "This invoice is not waiting for acknowledgement, so its lines cannot be changed here.",
    );
  }
  if (invoice.xero_bill_id) {
    fail(409, "invoice_already_in_xero", "This invoice is already in Xero.");
  }
  if (isGroupShareLine(line)) {
    fail(409, "group_share_line", "A group share line is checked by the office, not acknowledged here.");
  }
  if (line.office_review_status === "rejected") {
    fail(409, "line_rejected", "The office rejected this line. Fix it and send the invoice again.");
  }

  const patch: Row = {
    acknowledged_at: new Date().toISOString(),
    acknowledgment_status: queried ? "queried" : "acknowledged",
  };
  if (caller.userId) patch.acknowledged_by = caller.userId;
  if (note) patch.query_note = note;
  const { data: updated, error: updErr } = await client.from("trade_invoice_lines")
    .update(patch)
    .eq("id", lineId)
    .eq("trade_invoice_id", invoice.id)
    .select("id")
    .maybeSingle();
  if (updErr) fail(503, "line_ack_failed", "The acknowledgement was not saved.");
  if (!updated) fail(409, "line_changed", "The line changed. Read the invoice again.");

  let invoiceStatus = invoice.status;
  if (!queried) {
    const { data: lines, error: linesErr } = await client.from("trade_invoice_lines")
      .select("id, line_type, group_share_id, acknowledgment_status, office_review_status")
      .eq("trade_invoice_id", invoice.id);
    if (linesErr) {
      // The line is saved. The invoice stays waiting; nothing moves on a guess.
      return { success: true, line_id: lineId, acknowledgment_status: patch.acknowledgment_status, invoice_status: invoiceStatus, invoice_promoted: false };
    }
    const rows: Row[] = lines || [];
    const ready = rows.length > 0 &&
      rows.every((row) => row.acknowledgment_status === "acknowledged") &&
      !rows.some((row) => isGroupShareLine(row)) &&
      xeroSyncRefusal(rows) === null;
    if (ready) {
      const { data: moved, error: moveErr } = await client.from("trade_invoices")
        .update({ status: "acknowledged", acknowledged_at: new Date().toISOString() })
        .eq("id", invoice.id)
        .in("status", [...ACKNOWLEDGEABLE_INVOICE_STATUSES])
        .is("xero_bill_id", null)
        .select("id, status")
        .maybeSingle();
      if (!moveErr && moved?.status) invoiceStatus = moved.status;
    }
  }
  return {
    success: true,
    line_id: lineId,
    acknowledgment_status: patch.acknowledgment_status,
    invoice_status: invoiceStatus,
    invoice_promoted: invoiceStatus === "acknowledged",
  };
}
