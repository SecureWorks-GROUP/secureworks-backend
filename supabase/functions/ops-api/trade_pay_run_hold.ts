/**
 * A weekly pay run owns the invoices it approved (option A, cl-1622-fix).
 *
 * "Run approved, waiting for its push" is its own state: the invoice keeps the
 * status it had at the press (pending_ops_review or queried) and carries the
 * run's id in trade_invoices.pay_run_id. No other door may act on it. Every
 * old door asks this module, and only the run's own push passes.
 *
 * The rule lives here only (`invoiceIsRunHeld`), so moving the state to a
 * status of its own (option B) changes this file and the stamp, not the doors.
 */
export type PayRunHoldRefusal = {
  code: string;
  status: number;
  message: string;
};

export const PAY_RUN_HELD_CODE = "invoice_in_pay_run";
export const PAY_RUN_HELD_WORDS =
  "This invoice is in an approved pay run. Only the pay run can push it to Xero.";
export const PAY_RUN_HOLD_UNREADABLE_CODE = "pay_run_hold_unreadable";
export const PAY_RUN_HOLD_UNREADABLE_WORDS =
  "Whether this invoice is in a pay run could not be read. Nothing was changed.";
/** Option A: an invoice belongs to a run once the run stamped its id. */
export function invoiceIsRunHeld(row: { pay_run_id?: unknown }): boolean {
  return String(row?.pay_run_id ?? "").trim() !== "";
}

/**
 * The one door rule, on the row the door already read (no read of its own,
 * so a door with the switch off reads exactly what it read on main). The
 * door's select must name pay_run_id ("*" does); a row without the key is
 * refused 503, never read as free. A missing invoice (null) is left to the
 * door's own not-found answer. `runPushFor` is passed only by the run's own
 * push, as a function argument.
 */
export function payRunHeldRefusalFor(
  row: Record<string, unknown> | null | undefined,
  opts: { runPushFor?: string } = {},
): PayRunHoldRefusal | null {
  if (!row) return null;
  if (!("pay_run_id" in row)) {
    return {
      code: PAY_RUN_HOLD_UNREADABLE_CODE,
      status: 503,
      message: PAY_RUN_HOLD_UNREADABLE_WORDS,
    };
  }
  if (!invoiceIsRunHeld(row)) return null;
  if (opts.runPushFor && String(row.pay_run_id) === opts.runPushFor) {
    return null;
  }
  return { code: PAY_RUN_HELD_CODE, status: 409, message: PAY_RUN_HELD_WORDS };
}
