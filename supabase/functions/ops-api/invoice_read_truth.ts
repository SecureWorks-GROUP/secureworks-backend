// INT-35 and INT-36: what the invoice reads may claim about money and sending.
//
// A failed or incomplete read of open invoices is never a $0 balance (R-22).
// The summary then carries no figures and names its reason in summary_error;
// a true zero stays 0. Contract: docs/invoice-read-truth.md.

export type OpenInvoiceRow = {
  status?: string | null;
  amount_due?: number | string | null;
  due_date?: string | null;
};

export type OpenInvoiceSummary = {
  outstanding: number | null;
  overdue: number | null;
  summary_error: string | null;
};

// Rows per page of the open-invoice read. PostgREST stops a read at 1,000
// rows, so the loader pages at that size and stops on a short page.
export const OPEN_INVOICE_PAGE_SIZE = 1000;
// A hard stop on pages so a looping read cannot run forever. Reaching it is
// reported as an incomplete read, never summed as if complete.
export const OPEN_INVOICE_MAX_PAGES = 50;

export type OpenInvoiceRead = {
  rows: OpenInvoiceRow[];
  error: string | null;
};

// Reads every open (AUTHORISED or SUBMITTED) invoice of the type, page by
// page. `readPage` returns PostgREST's { data, error } for one range.
export async function readAllOpenInvoices(
  readPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<OpenInvoiceRead> {
  const rows: OpenInvoiceRow[] = [];
  for (let page = 0; page < OPEN_INVOICE_MAX_PAGES; page++) {
    const from = page * OPEN_INVOICE_PAGE_SIZE;
    let res: { data: unknown; error: unknown };
    try {
      res = await readPage(from, from + OPEN_INVOICE_PAGE_SIZE - 1);
    } catch (_err) {
      return { rows, error: "open_invoice_read_failed" };
    }
    if (res?.error) return { rows, error: "open_invoice_read_failed" };
    if (!Array.isArray(res?.data)) {
      return { rows, error: "open_invoice_read_failed" };
    }
    rows.push(...(res.data as OpenInvoiceRow[]));
    if (res.data.length < OPEN_INVOICE_PAGE_SIZE) return { rows, error: null };
  }
  return { rows, error: "open_invoice_read_incomplete" };
}

function moneyOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// Sums the open invoices. Any doubt about the read or any row's amount due
// returns no figures with the reason; it never fills in 0.
export function summarizeOpenInvoices(
  read: OpenInvoiceRead,
  todayStr: string,
): OpenInvoiceSummary {
  if (read.error) {
    return { outstanding: null, overdue: null, summary_error: read.error };
  }
  let outstanding = 0;
  let overdue = 0;
  for (const row of read.rows) {
    const due = moneyOf(row.amount_due);
    if (due === null) {
      return {
        outstanding: null,
        overdue: null,
        summary_error: "open_invoice_amount_due_missing",
      };
    }
    outstanding += due;
    if (row.due_date && row.due_date < todayStr) overdue += due;
  }
  return {
    outstanding: Math.round(outstanding * 100) / 100,
    overdue: Math.round(overdue * 100) / 100,
    summary_error: null,
  };
}

// Xero's own sent flag (Invoice.SentToContact), read from the stored Xero
// record. true or false only when Xero's record says so; anything else is
// null, which the page shows as "Sent: not known". Never inferred from status.
export function sentToContactOf(rawJson: unknown): boolean | null {
  let raw: unknown = rawJson;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (_err) {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return sentToContactFlag((raw as Record<string, unknown>).SentToContact);
}

// The same flag read through a projection (`sent_to_contact:raw_json->SentToContact`):
// a boolean as Xero stored it, anything else null.
export function sentToContactFlag(flag: unknown): boolean | null {
  return typeof flag === "boolean" ? flag : null;
}
