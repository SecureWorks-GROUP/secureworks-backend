import { INSTALLER_ACCOUNT_CODES } from "./materials_ingest.ts";

type Line = {
  line_key: string; line_no: number; kind: string; description: string | null;
  account_code: string | null; xero_tracking_option: string | null;
  lane: string; event_lane_detail: string; amount_ex: number; gst: number;
  is_actual: boolean; paid: boolean; paid_on: string | null;
  event_source: string; event_source_id: string;
};
type Bill = {
  invoice_type?: string; xero_invoice_id: string; status?: string | null;
  invoice_number?: string | null; invoice_date?: string | null;
  xero_contact_id?: string | null; contact_name?: string | null;
  fully_paid_on?: string | null; line_items?: unknown;
  raw_json?: { LineAmountTypes?: string };
};

// Same inclusive/exclusive expression as bill_line in the cost view.
export function billCostDocument(bill: Bill, ctx: { mirrorBillIds: Set<string>; orgId: string }) {
  if (bill.invoice_type !== "ACCPAY" || ctx.mirrorBillIds.has(bill.xero_invoice_id)) return null;
  const lines: Line[] = [];
  const rawLines = Array.isArray(bill.line_items) ? bill.line_items : [];
  for (const [i, raw] of rawLines.entries()) {
    const l = raw as Record<string, unknown>;
    const gst = Number(l.TaxAmount ?? 0);
    const amount = "_header_ex" in l ? Number(l._header_ex)
      : Number(l.LineAmount ?? 0) - (bill.raw_json?.LineAmountTypes === "Inclusive" ? gst : 0);
    if (amount === 0) continue;
    const account = l.AccountCode == null ? null : String(l.AccountCode);
    const description = l.Description == null ? null : String(l.Description);
    const installer = INSTALLER_ACCOUNT_CODES.has(account ?? "");
    const lane = /commission/i.test(description ?? "") ? "commission"
      : installer ? "labour" : /^3[0-9]{2}$/.test(account ?? "") ? "materials" : "other";
    const tracking = Array.isArray(l.Tracking) ? l.Tracking[0]?.Option ?? null : null;
    lines.push({
      line_key: l.LineItemID ? String(l.LineItemID) : `n:${i + 1}`,
      line_no: i + 1, kind: installer ? "installer_bill" : "supplier_bill",
      description, account_code: account, xero_tracking_option: tracking,
      lane, event_lane_detail: lane, amount_ex: amount, gst,
      is_actual: true, paid: bill.status === "PAID", paid_on: bill.fully_paid_on ?? null,
      event_source: "supplier_bill", event_source_id: `${bill.xero_invoice_id}:${i + 1}`,
    });
  }
  return {
    org_id: ctx.orgId, document_kind: "xero_bill", document_id: bill.xero_invoice_id,
    document_number: bill.invoice_number ?? null, document_date: bill.invoice_date?.slice(0,10) ?? null,
    document_status: bill.status ?? null, live: bill.status === "AUTHORISED" || bill.status === "PAID",
    party_kind: "supplier", party_id: bill.xero_contact_id ?? null, party_name: bill.contact_name ?? null,
    lines,
  };
}
