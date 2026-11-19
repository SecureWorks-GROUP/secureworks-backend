import { REIMBURSEMENT_FLAG } from "./trade_invoice_reimbursement.ts";

/**
 * Store the rejection and, when enabled, release its receipt claims atomically.
 * `via` names the path taken: "rpc" (reject_trade_invoice_v1) or "update"
 * (main's plain update, kept while the reimbursement switch is off).
 */
export async function rejectTradeInvoiceStorage(
  client: any,
  invoiceId: string,
  note: string,
  actor: string,
): Promise<{ data: { id: string } | null; error?: { message: string } | null; via?: "rpc" | "update" }> {
  // feature_flags_pkey. Missing/unreadable keeps the original update verbatim.
  const { data: flag, error: flagError } = await client.from("feature_flags")
    .select("enabled").eq("flag_name", REIMBURSEMENT_FLAG).maybeSingle();
  if (!flagError && flag?.enabled === true) {
    const { data, error } = await client.rpc("reject_trade_invoice_v1", {
      p_invoice_id: invoiceId,
      p_note: note,
      p_actor: actor,
    });
    return { data: typeof data === "string" ? { id: data } : null, error, via: "rpc" };
  }
  return await client.from("trade_invoices")
    .update({ status: "ops-reject", query_note: note, office_sent_back_at: new Date().toISOString() })
    .eq("id", invoiceId)
    .is("xero_bill_id", null)
    .is("xero_pushed_at", null)
    .is("pay_run_id", null)
    .select("id")
    .maybeSingle();
}
