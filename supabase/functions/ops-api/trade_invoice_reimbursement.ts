import { TRADE_PAY_PRIOR_INVOICE_COLUMNS, type TradePayPriorInvoice } from "./trade_pay_rule.ts";

export const REIMBURSEMENT_LINE_TYPE = "reimbursement";
export const REIMBURSEMENT_FLAG = "trade_reimbursement_line_v1";
const words = {
  reimbursement_switch_off:
    "Reimbursements on an invoice are not switched on yet. Add the receipt under Expenses.",
  reimbursement_not_yours: "That receipt is not one of yours.",
  reimbursement_not_personal_spend:
    "Only something you paid for yourself can be paid back.",
  reimbursement_receipt_required:
    "Add a photo of the receipt first. A reimbursement needs its receipt.",
  reimbursement_rejected: "The office sent this receipt back.",
  reimbursement_already_claimed: "This receipt is already on an invoice.",
};
export type ReimbursementSkip = {
  expense_receipt_id: string | null;
  code: keyof typeof words;
  words: string;
};
export const isReimbursementItem = (item: any): boolean =>
  String(item?.type ?? item?.line_type ?? "").trim().toLowerCase() ===
    REIMBURSEMENT_LINE_TYPE;
export function reimbursementSkip(
  id: unknown,
  code: keyof typeof words,
): ReimbursementSkip {
  return {
    expense_receipt_id: id ? String(id) : null,
    code,
    words: words[code],
  };
}
// Only the caller's explicit undated draft may release its own receipt claim.
// The atomic persist rechecks these coordinates while holding the draft lock.
export async function loadUndatedReimbursementDraft(
  client: any,
  input: { userId: string; orgId: string; draftId: unknown; flagOn: boolean },
): Promise<({ id: string } & NonNullable<TradePayPriorInvoice>) | null> {
  if (!input.flagOn || !input.draftId) return null;
  // trade_invoices_pkey: one explicit row, never a scan of undated drafts.
  const { data, error } = await client.from("trade_invoices")
    .select(`id, org_id, user_id, status, xero_bill_id, xero_pushed_at, ${TRADE_PAY_PRIOR_INVOICE_COLUMNS}`)
    .eq("id", String(input.draftId)).maybeSingle();
  if (error) throw new Error("Could not read the selected undated draft");
  if (!data || data.org_id !== input.orgId || data.user_id !== input.userId ||
      data.status !== "draft" || data.invoice_source !== "hourly" ||
      data.week_start != null || data.week_end != null ||
      data.xero_bill_id != null || data.xero_pushed_at != null) {
    throw new Error("The selected undated draft is no longer replaceable");
  }
  return data;
}

// Shared receipt eligibility for invoice saves and the batched receipt picker.
export function reimbursementReceiptRefusal(
  receipt: any, userId: string, claimed: boolean,
): ReimbursementSkip["code"] | null {
  if (!receipt || receipt.submitted_by !== userId) return "reimbursement_not_yours";
  if (!["personal_card", "cash"].includes(receipt.payment_method)) return "reimbursement_not_personal_spend";
  if ((!String(receipt.receipt_storage_path || "").trim() &&
      !String(receipt.receipt_photo_url || "").trim()) || receipt.no_receipt_reason) return "reimbursement_receipt_required";
  if (receipt.status === "rejected") return "reimbursement_rejected";
  if (receipt.xero_bill_id || claimed) return "reimbursement_already_claimed";
  return null;
}

export async function receiptHasLiveTradeInvoice(
  client: any,
  receiptId: string,
  replacingDraftId: string | null = null,
  draftsAreClaims = true,
): Promise<boolean> {
  // trade_invoice_lines_one_receipt bounds this read to one claim, in any status.
  const { data, error } = await client.from("trade_invoice_lines")
    .select(draftsAreClaims ? "trade_invoice_id" : "trade_invoice_id, invoice:trade_invoices!inner(status)")
    .eq("expense_receipt_id", receiptId);
  if (error) throw new Error("Could not read the receipt's invoice claims");
  // Only a server-selected prior draft may be ignored for an atomic replacement.
  // The persist RPC rechecks its tenant, owner, week, status and Xero identity.
  return (data || []).some((line: any) => {
    if (replacingDraftId && line.trade_invoice_id === replacingDraftId) return false;
    if (draftsAreClaims) return true;
    // Compatibility for the expense-to-Xero route while the switch is off.
    const invoice = Array.isArray(line.invoice) ? line.invoice[0] : line.invoice;
    return !invoice || !["draft", "ops-reject"].includes(String(invoice.status));
  });
}
export async function resolveReimbursementExtras(client: any, input: {
  userId: string;
  items: any[];
  flagOn: boolean;
  basis: unknown;
  replacingDraftId?: string | null;
}): Promise<{ lines: any[]; skipped_items: ReimbursementSkip[] }> {
  const lines: any[] = [], skipped_items: ReimbursementSkip[] = [];
  const seen = new Set<string>();
  for (const item of input.items) {
    const id = String(item?.expense_receipt_id || "");
    if (seen.has(id)) continue;
    seen.add(id);
    let code: keyof typeof words | null = null;
    let receipt: any = null;
    if (!input.flagOn || input.basis !== "inclusive_12_112_v1") {
      code = "reimbursement_switch_off";
    } else {
      const { data, error } = await client.from("expense_receipts")
        .select(
          "id, submitted_by, payment_method, receipt_storage_path, receipt_photo_url, no_receipt_reason, status, total_amount, vendor_name, receipt_date, job_id, xero_bill_id, jobs:job_id(job_number)",
        )
        .eq("id", id).maybeSingle();
      if (error) throw new Error("Could not read the reimbursement receipt");
      receipt = data;
      code = reimbursementReceiptRefusal(receipt, input.userId, false);
      if (!code && await receiptHasLiveTradeInvoice(client, id, input.replacingDraftId)) {
        code = "reimbursement_already_claimed";
      }
    }
    if (code) {
      skipped_items.push(reimbursementSkip(id, code));
      continue;
    }
    const amount = Number(receipt.total_amount);
    // Never manufacture a positive claim from an unreadable receipt total.
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("The receipt amount must be positive");
    }
    const hold = !receipt.job_id
      ? "no_job"
      : receipt.status === "approved"
      ? null
      : "reimbursement";
    lines.push({
      line_type: REIMBURSEMENT_LINE_TYPE,
      expense_receipt_id: id,
      job_id: receipt.job_id || null,
      job_number: receipt.jobs?.job_number || null,
      description: `Reimbursement - ${receipt.vendor_name || ""}, ${
        receipt.receipt_date || ""
      }`,
      quantity: 1,
      unit: "ea",
      unit_rate: amount,
      line_total_ex: amount,
      hold_reason: hold,
      office_review_status: hold ? "awaiting" : "approved",
      office_review_note: hold,
      query_note: hold ? `Office review: ${hold}` : null,
    });
  }
  return { lines, skipped_items };
}

export function reimbursementDbLine(line: any): Record<string, unknown> {
  const { hold_reason: _reason, ...stored } = line;
  return stored;
}

// The database won a race after the eligibility read. Retry the same save
// without only those receipts now claimed, preserving the rest of the week.
export async function retryReimbursementClaims<T>(
  client: any,
  result: { lines: any[]; skipped_items: ReimbursementSkip[] },
  persist: () => Promise<T>,
  reprice: (removed: any[]) => Promise<void>,
  replacingDraftId: string | null = null,
): Promise<T> {
  const attempts = result.lines.length + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await persist();
    } catch (error) {
      const message = String((error as Error)?.message || error);
      if (!message.includes("reimbursement_already_claimed") &&
          !message.includes('"trade_invoice_lines_one_receipt"')) throw error;
      const removed = [];
      for (const line of result.lines) {
        if (await receiptHasLiveTradeInvoice(client, line.expense_receipt_id, replacingDraftId)) {
          removed.push(line);
        }
      }
      if (!removed.length) throw error;
      for (const line of removed) {
        result.lines.splice(result.lines.indexOf(line), 1);
        result.skipped_items.push(
          reimbursementSkip(
            line.expense_receipt_id,
            "reimbursement_already_claimed",
          ),
        );
      }
      await reprice(removed);
    }
  }
  throw new Error("Could not settle the reimbursement claims");
}
