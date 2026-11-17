import {
  REIMBURSEMENT_FLAG,
  reimbursementReceiptRefusal,
} from "./trade_invoice_reimbursement.ts";

// Crew Expenses, receipt upload recovery and weekly review use these fields.
// Office readers retain their existing full response below.
const CREW_COLUMNS =
  "id, submitted_by, job_id, created_at, vendor_name, receipt_date, total_amount, gst_amount, line_items, payment_method, receipt_storage_path, receipt_photo_url, no_receipt_reason, status, query_reason, rejection_reason, xero_bill_id, jobs:job_id(client_name, job_number)";

export async function listExpenseReceipts(
  client: any,
  params: URLSearchParams,
  caller: { id: string; role?: string } | undefined,
  readPayBasis: () => Promise<unknown>,
) {
  const tradeCaller = caller &&
    !["admin", "owner", "ops_manager"].includes(
      String(caller.role || "").toLowerCase(),
    );
  const requestedLimit = Number(params.get("limit") || 50);
  const limit = tradeCaller
    ? Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(100, Math.floor(requestedLimit))
      : 50
    : requestedLimit;
  // Existing idx_expense_receipts_submitted bounds the crew's ownership filter;
  // idx_expense_receipts_job/status serve the optional existing filters.
  let query = client.from("expense_receipts")
    .select(
      tradeCaller ? CREW_COLUMNS : "*, jobs:job_id(client_name, job_number)",
    )
    .order("created_at", { ascending: false }).limit(limit);
  if (tradeCaller) query = query.eq("submitted_by", caller.id);
  if (params.get("job_id")) query = query.eq("job_id", params.get("job_id"));
  if (params.get("status")) query = query.eq("status", params.get("status"));
  const { data, error } = await query;
  if (error) throw error;
  const rows = data || [];
  if (!tradeCaller) return { expenses: rows };
  const { data: flag } = await client.from("feature_flags").select("enabled")
    .eq("flag_name", REIMBURSEMENT_FLAG).maybeSingle();
  if (flag?.enabled !== true || !rows.length) return { expenses: rows };
  const basis = await readPayBasis();
  const claimed = new Set<string>();
  if (basis === "inclusive_12_112_v1") {
    // trade_invoice_lines_one_receipt (also expense_receipt_idx) bounds this
    // single lookup to at most 100 receipts, with no invoice or receipt rereads.
    const { data: claims, error: claimsError } = await client.from(
      "trade_invoice_lines",
    )
      .select("expense_receipt_id").in(
        "expense_receipt_id",
        rows.map((row: any) => row.id),
      );
    if (claimsError) {
      throw new Error("Could not read the receipt's invoice claims");
    }
    for (const claim of claims || []) claimed.add(claim.expense_receipt_id);
  }
  return {
    expenses: rows.map((row: any) => {
      const reason = basis !== "inclusive_12_112_v1"
        ? "reimbursement_switch_off"
        : reimbursementReceiptRefusal(row, caller.id, claimed.has(row.id));
      if (
        !reason &&
        (!Number.isFinite(Number(row.total_amount)) ||
          Number(row.total_amount) <= 0)
      ) {
        throw new Error("The receipt amount must be positive");
      }
      return { ...row, reimbursement: { claimable: reason === null, reason } };
    }),
  };
}
