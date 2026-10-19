// deno-lint-ignore-file no-explicit-any
// CFO-12: read EVERY ACCPAY bill in the materials-ingest window, each run.
//
// Before, the ingest read one unordered select with .limit(500): on 19 Oct
// 2026 the 90-day window held 802 bills, so up to 302 could be skipped in a
// run, and which ones changed from run to run (164 bills in the window had
// never reached a fact or the queue). This pages the same filters in a fixed
// order (newest invoice first, then xero_invoice_id, so every page boundary is
// stable) until a short page. A failed page fails the read: the caller gets
// null and must not treat a partial list as the window.

export const BILLS_WINDOW_PAGE = 500;

export const BILLS_WINDOW_COLUMNS =
  "xero_invoice_id, invoice_number, xero_contact_id, contact_name, reference, sub_total, total, invoice_date, status, invoice_type";

export type BillsWindowRead = { bills: any[]; pages: number } | null;

/**
 * Every non-void ACCPAY bill of `orgId` dated on or after `cutoff`
 * (YYYY-MM-DD), page by page. `cap` (optional, for a manual run only) stops
 * after that many bills; the scheduled run passes none.
 */
export async function readBillsInWindow(
  sb: any,
  opts: {
    orgId: string;
    cutoff: string;
    columns?: string;
    pageSize?: number;
    cap?: number | null;
  },
): Promise<BillsWindowRead> {
  const pageSize = opts.pageSize ?? BILLS_WINDOW_PAGE;
  const cap = opts.cap && opts.cap > 0 ? opts.cap : null;
  const bills: any[] = [];
  let pages = 0;
  for (let from = 0;; from += pageSize) {
    const to = cap ? Math.min(from + pageSize, cap) - 1 : from + pageSize - 1;
    if (to < from) break;
    const { data, error } = await sb
      .from("xero_invoices")
      .select(opts.columns ?? BILLS_WINDOW_COLUMNS)
      .eq("org_id", opts.orgId)
      .eq("invoice_type", "ACCPAY")
      .gte("invoice_date", opts.cutoff)
      .not("status", "in", '("VOIDED","DELETED")')
      .order("invoice_date", { ascending: false })
      .order("xero_invoice_id", { ascending: true })
      .range(from, to);
    pages++;
    if (error || !Array.isArray(data)) return null;
    bills.push(...data);
    if (data.length < to - from + 1) break;
    if (cap && bills.length >= cap) break;
  }
  return { bills, pages };
}
