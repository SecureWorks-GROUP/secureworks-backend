// Follow-up 49 item 3: the work order cap is checked before the Xero bill.
//
// The work-order door saves its invoice as a draft. A draft is not a billed
// status, so the database's job amount guard (trade_invoices_job_amount_guard)
// does not count it. Before this module the first billed move was draft to
// approved inside the Xero checkpoint, after the bill was made: a guard
// refusal there left a bill in Xero for an invoice the trade was told failed.
//
// This module makes that move first. It takes the saved draft to approved,
// the same state a Xero miss leaves (an approved invoice with no bill, which
// the office pushes). The guard runs on that move. A refusal changes nothing,
// so the invoice stays a draft the next send replaces, and no Xero call is
// made. The later checkpoint moves approved to approved, which the guard does
// not check again.
//
// The move is made only while trade_line_hold_v1 is on, because the guard
// reads that switch and does nothing without it. A switch that cannot be read
// is treated as on: the move is harmless without the guard. With the switch
// off the door runs exactly as before.

import { TRADE_LINE_HOLD_FLAG, jobAmountGuardJob, lineSendLogCode, releaseStandardInvoice } from "./trade_line_send.ts";
import { TradeInvoiceStoreError } from "./trade_invoice_refusal.ts";

/** Left on the invoice by the move. The checkpoint replaces it once the
 * bill is made; if no bill follows, it tells the office what to do. */
export const CAP_CHECKED_NOTE =
  "Checked against the work order amount before Xero. If no Xero bill follows, push it from the office.";

/** Left on the draft when the work order amount refuses it. */
export const CAP_REFUSED_NOTE =
  "The work order amount did not cover this invoice when it was sent to Xero. Nothing reached Xero; the next send replaces this draft.";

/** The error text for a draft that changed under the move (mapped in
 * trade_invoice_refusal.ts). */
export const CAP_INVOICE_CHANGED = "work_order_invoice_changed_before_xero";

// deno-lint-ignore no-explicit-any
async function capSwitchMayBeOn(client: any): Promise<boolean> {
  try {
    const { data, error } = await client.from("feature_flags").select("enabled")
      .eq("flag_name", TRADE_LINE_HOLD_FLAG).limit(1);
    if (error || !Array.isArray(data)) return true;
    return data[0]?.enabled === true;
  } catch {
    return true;
  }
}

/**
 * Moves the saved work-order draft to approved before any Xero call, so the
 * job amount guard checks it first. Returns whether the move was made. Throws
 * the database's own error on a refusal (so the route's refusal mapper sees
 * job_amount_guard), or a store error when the draft changed under it.
 */
export async function checkWorkOrderCapBeforeXero(
  // deno-lint-ignore no-explicit-any
  client: any,
  invoiceId: string,
): Promise<{ moved: boolean }> {
  if (!(await capSwitchMayBeOn(client))) return { moved: false };
  const { data, error } = await client.from("trade_invoices")
    .update({ status: "approved", query_note: CAP_CHECKED_NOTE })
    .eq("id", invoiceId)
    .eq("status", "draft")
    .is("xero_bill_id", null)
    // Never on a pay run's invoice: only the run's own push moves it.
    .is("pay_run_id", null)
    .select("id")
    .maybeSingle();
  if (error) {
    if (jobAmountGuardJob(error) !== undefined) {
      // The move raised, so the invoice is still a draft. The note is for
      // the office; the send itself is refused.
      await releaseStandardInvoice(client, invoiceId, CAP_REFUSED_NOTE);
    } else {
      console.error("[ops-api] work order cap check not written:", lineSendLogCode(error), invoiceId);
    }
    throw error;
  }
  if (data?.id !== invoiceId) {
    console.error("[ops-api] work order cap check found no draft:", invoiceId);
    throw new TradeInvoiceStoreError(CAP_INVOICE_CHANGED, "P0001");
  }
  return { moved: true };
}
