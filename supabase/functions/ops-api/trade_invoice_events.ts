// One writer for trade_invoice_events (migration 20261106163712): the
// append-only record of what the system or the office did to a trade invoice
// outside the normal submit flow. Ids, codes and plain reasons only, never a
// rate, an amount or a person's name in `reason`.

export type TradeInvoiceEventType =
  | "voided_bill_released"
  | "stuck_invoice_resolved"
  | "xero_bill_reused"
  | "extra_rate_held";

export interface TradeInvoiceEvent {
  trade_invoice_id: string;
  event_type: TradeInvoiceEventType;
  actor: string;
  reason?: string | null;
  detail?: Record<string, unknown>;
}

/** Record one event. Returns false, and logs, when the write fails: the
 * action it describes has already happened and its proof is on the invoice. */
export async function recordTradeInvoiceEvent(
  client: any,
  event: TradeInvoiceEvent,
): Promise<boolean> {
  try {
    const { error } = await client.from("trade_invoice_events").insert({
      trade_invoice_id: event.trade_invoice_id,
      event_type: event.event_type,
      actor: String(event.actor || "unknown").slice(0, 200),
      reason: event.reason ? String(event.reason).slice(0, 500) : null,
      detail: event.detail ?? {},
    });
    if (error) {
      console.error(
        `[trade_invoice_events] ${event.event_type} for ${event.trade_invoice_id} not recorded: ${error.message}`,
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      `[trade_invoice_events] ${event.event_type} for ${event.trade_invoice_id} not recorded: ${(e as Error).message}`,
    );
    return false;
  }
}
