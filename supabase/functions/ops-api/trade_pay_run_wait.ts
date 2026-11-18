// P1-10.4: with the weekly pay run on, a sent invoice waits for the run.
//
// The two trade send doors (generate_trade_invoice, submit_work_order_invoice)
// read trade_pay_run_v1 once per send. When it is on, the saved invoice is
// moved to pending_ops_review (the one status the run's stamp accepts,
// 20261118115852) and the door makes no Xero call: no token, no contact, no
// bill and no crew release. When it is off, the doors run exactly as before.
//
// A switch that cannot be read is read as off (director hold 15:22): the
// send runs exactly as on main. A hold that fails answers an error (503),
// never success, so the trade knows the send did not finish.

export const PAY_RUN_SWITCH_FLAG = "trade_pay_run_v1";
export const PAY_RUN_WAIT_STATUS = "pending_ops_review";

export const PAY_RUN_WAIT_WORDS =
  "Sent. It will be checked in this week's pay run and paid on Friday.";
export const PAY_RUN_HOLD_FAILED_WORDS =
  "Your invoice was saved, but it could not be marked for the pay run. It was not sent to Xero. The office will check it.";
/** A work order invoice whose hold failed is still the trade's own draft. */
export const PAY_RUN_HOLD_FAILED_DRAFT_WORDS =
  "Your invoice was saved but not sent. It was not sent to Xero. Send it again.";

export type PayRunSwitchRead = "on" | "off";

export type PayRunWait =
  | { waits: false }
  | {
    waits: true;
    /** true when the invoice now holds PAY_RUN_WAIT_STATUS. */
    held: boolean;
    /** The status the door saved; a failed hold leaves the invoice there. */
    savedStatus: "pending_acknowledgment" | "draft";
  };

/**
 * One read of the switch per send. Only a row saying enabled = true is "on".
 * A missing row, an error, a throw or any other answer is "off", main's path.
 * feature_flags is keyed on flag_name.
 */
export async function readPayRunSwitchForSubmit(
  // deno-lint-ignore no-explicit-any
  client: any,
): Promise<PayRunSwitchRead> {
  try {
    const { data, error } = await client.from("feature_flags")
      .select("enabled")
      .eq("flag_name", PAY_RUN_SWITCH_FLAG)
      .limit(1);
    if (error || !Array.isArray(data)) {
      console.error("[ops-api] pay run switch unreadable, read as off:", error?.code ?? "no_rows");
      return "off";
    }
    return data[0]?.enabled === true ? "on" : "off";
  } catch (e) {
    console.error(
      "[ops-api] pay run switch read threw, read as off:",
      (e as { code?: string })?.code ?? "threw",
    );
    return "off";
  }
}

/**
 * Moves the saved invoice to PAY_RUN_WAIT_STATUS, only from the status its
 * door saved it with and only while it has no Xero bill. With the switch off
 * it writes nothing. A failed write still waits (no push): the invoice keeps
 * its saved status. A weekly invoice stays pending_acknowledgment, where the
 * office sees it; a work order invoice stays the trade's draft, and the trade
 * is told to send it again.
 */
export async function holdTradeInvoiceForPayRun(
  // deno-lint-ignore no-explicit-any
  client: any,
  invoiceId: string,
  savedStatus: "pending_acknowledgment" | "draft",
  switchRead: PayRunSwitchRead,
): Promise<PayRunWait> {
  if (switchRead !== "on") return { waits: false };
  try {
    const { data, error } = await client.from("trade_invoices")
      .update({ status: PAY_RUN_WAIT_STATUS })
      .eq("id", invoiceId)
      .eq("status", savedStatus)
      .is("xero_bill_id", null)
      .select("id, status")
      .maybeSingle();
    const held = !error && data?.id === invoiceId &&
      data?.status === PAY_RUN_WAIT_STATUS;
    if (!held) {
      // Codes and ids only.
      console.error(
        "[ops-api] pay run hold not written:",
        invoiceId,
        error?.code ?? "no_row",
      );
    }
    return { waits: true, held, savedStatus };
  } catch (e) {
    console.error(
      "[ops-api] pay run hold threw:",
      invoiceId,
      (e as { code?: string })?.code ?? "threw",
    );
    return { waits: true, held: false, savedStatus };
  }
}

/** The answer's extra fields for a send that waits for the run. */
export function payRunWaitResponse(
  wait: Extract<PayRunWait, { waits: true }>,
): Record<string, unknown> {
  if (!wait.held) {
    const words = wait.savedStatus === "draft"
      ? PAY_RUN_HOLD_FAILED_DRAFT_WORDS
      : PAY_RUN_HOLD_FAILED_WORDS;
    return {
      ok: false,
      success: false,
      code: "pay_run_hold_failed",
      error: words,
      userMessage: words,
      pay_run: { waits: true, held: false, words },
      xero_bill_id: null,
      xero_bill_number: null,
      pdf_attached: false,
    };
  }
  return {
    ok: true,
    success: true,
    code: "pay_run_waits",
    pay_run: { waits: true, held: true, words: PAY_RUN_WAIT_WORDS },
    xero_bill_id: null,
    xero_bill_number: null,
    pdf_attached: false,
  };
}

/** HTTP status for a send that waits: 200 when held, 503 when the hold failed. */
export function payRunWaitHttpStatus(
  wait: Extract<PayRunWait, { waits: true }>,
): number {
  return wait.held ? 200 : 503;
}

/**
 * Stands in for the Xero token on the work order door while the invoice waits
 * for the run: the door saves the invoice and never opens Xero.
 */
export function payRunNoXeroBoundary(): Promise<
  { accessToken: string; tenantId: string }
> {
  return Promise.resolve({ accessToken: "", tenantId: "" });
}
