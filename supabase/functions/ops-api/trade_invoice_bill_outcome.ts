// What a trade invoice's Xero bill became, for the trade and office screens.
// A bill voided or deleted in Xero is not a live bill: its row must never read
// as "pushed" or "in Xero". Read only; the status itself is never changed here.

export type TradeInvoiceBillOutcome = "voided" | "deleted";

export interface PresentedTradeInvoiceBillOutcome {
  xero_bill_outcome: TradeInvoiceBillOutcome;
  bill_status_label: string;
  week_released: boolean;
}

export function presentTradeInvoiceBillOutcome(
  invoice: Record<string, unknown>,
): Partial<PresentedTradeInvoiceBillOutcome> {
  if (!invoice.xero_bill_id) return {};
  const status = String(invoice.xero_bill_status ?? "").trim().toUpperCase();
  const outcome: TradeInvoiceBillOutcome | null = status === "VOIDED"
    ? "voided"
    : status === "DELETED"
    ? "deleted"
    : null;
  if (!outcome) return {};
  const details = invoice.override_details;
  const released = invoice.status === "ops-reject" &&
    Boolean(
      details && typeof details === "object" && !Array.isArray(details) &&
        (details as Record<string, unknown>).voided_release,
    );
  const word = outcome === "voided" ? "Voided" : "Deleted";
  return {
    xero_bill_outcome: outcome,
    bill_status_label: released
      ? `${word} in Xero, week released`
      : `${word} in Xero`,
    week_released: released,
  };
}
