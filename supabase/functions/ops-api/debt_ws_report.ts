// Debt Workshop: the debt and receivables report (Shaun approved 15 Oct 2026, rebuilt as
// "Debt and receivables" on 4 Nov 2026; docs/debt-workshop/README.md, "The debt report").
// The Debt tab's "Debt report" button opens this report as its own view, and the owner can
// download it as a PDF or email it to Marnin.
//
// This file is the report itself, worked out with no database, no Xero and no email: it
// takes the Debt tab's own book (debt_ws_book.ts loadBook) plus a few extra reads that
// debt_ws_actions.ts makes (the raw open invoices, the invoices paid in full this week, the
// week's workshop log, the Xero bank balances and the bank feed), and returns:
//   - buildDebtReport: every figure, as plain data (the screen and the PDF both read it);
//   - debtReportHtml: the report as one HTML page (the view, and the copy kept on a send);
//   - debtReportEmail: the short email that carries the PDF.
// The PDF is drawn from the same data by debt_ws_report_pdf.ts.
//
// Receivables are every unpaid invoice, split into Debt and Other receivables by
// debt_ws_receivables.ts (Debt: finals after the job is Complete or Invoiced, and company
// invoices; Other: deposits, materials, progress payments and planning fees). Every open
// Xero invoice lands in exactly one place, and the places add up to the total owed in our
// Xero copy to the cent (the "tie" below). Contacts on the not-chased list (Emergency Trade
// Services, Builderwest) are the Write-off list: "for us to check whether to write off".
// Test invoices (SAMPLE-) are left out of Receivables and named under the tie. Whether our
// copy matches Xero itself comes from the hourly check (debt_ws_xero_check.ts).
//
// Plain words only: no long dashes and no emoji anywhere in what this file writes.

import {
  addDays,
  type BankTransaction,
  type Category,
  companyTermsFor,
  daysBetween,
  escapeHtml,
  inScope,
  invoiceKindOf,
  longDate,
  looksLikeCompany,
  money,
  perthDate,
  perthDateOf,
  type PossiblePayment,
  possiblePayments,
  sameName,
  STEP_LABELS,
  type WsInvoice,
} from "./debt_ws_rules.ts";
import { type Book, type BookEntry, categoryTotals } from "./debt_ws_book.ts";
import {
  OVERDUE_BANDS,
  type OverdueBand,
  overdueBand,
  type ReceivableClass,
  receivableOfGoAhead,
  receivableOfUnplaced,
  type ReceivableView,
} from "./debt_ws_receivables.ts";
import type { WsLogRow } from "./debt_ws_store.ts";
import type { XeroCheckView } from "./debt_ws_xero_check.ts";

export const DEBT_REPORT_VERSION = "debt-report/v2";
/** The day the Debt tab went live: chase history in the tab starts here. */
export const DEBT_TAB_LIVE_DATE = "2026-10-08";
/** The share_key the report's own debt_ws_log rows sit on (not counted as activity). */
const REPORT_LOG_KEY = "debt-report";

// ── Inputs ──

/** One bank account from Xero's Bank Summary. closing is null when Xero gave no figure. */
export interface BankAccountBalance {
  name: string;
  account_id: string | null;
  closing: number | null;
}

/** The cached bank feed (unreconciled RECEIVE transactions) the tab already reads. */
export interface ReportBankFeed {
  txs: BankTransaction[];
  /** The read stopped before Xero ran out of pages: older receipts were not read. */
  truncated: boolean;
}

export interface DebtReportInput {
  now: Date;
  /** The Debt tab's book, loaded from the same open invoices passed below. */
  book: Book;
  /** Every open receivable in our Xero copy (ACCREC, AUTHORISED, amount due above zero). */
  openInvoices: WsInvoice[];
  /**
   * Invoices paid in full over the report's week (reportWeek: the 7 days to today, so since
   * last Wednesday on a Wednesday); null when unreadable.
   */
  paidInFull: WsInvoice[] | null;
  /** Every workshop log line written over the same week; null when unreadable. */
  weekLogs: WsLogRow[] | null;
  /** Xero bank balances read live; null when Xero could not be read. */
  bank: { accounts: BankAccountBalance[]; read_at: string } | null;
  /** The bank feed; null when it could not be read. */
  feed: ReportBankFeed | null;
  /** When our Xero copy of invoices was last synced. */
  syncedAt: string | null;
  /** Who the report was prepared for or by: "Shaun", or "the Wednesday 2pm auto-send". */
  preparedBy: string;
  /** The newest check of our Xero copy against Xero (debt_ws_xero_check.ts); null: unread. */
  xeroCheck?: XeroCheckView | null;
}

/**
 * The report's week: the 7 Perth days ending today. The report goes out on a Wednesday, so
 * this is Thursday to Wednesday: everything since last Wednesday's report.
 */
export function reportWeek(today: string): { from: string; to: string } {
  return { from: addDays(today, -6), to: today };
}

/** The first instant of a Perth calendar day, as an ISO timestamp (Perth is UTC+8). */
export function perthDayStartIso(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00+08:00`)).toISOString();
}

// ── The report, as data ──

export type BucketKey =
  | Category
  | "not_due"
  | "go_ahead"
  | "needs_a_look"
  | "not_chased"
  | "excluded"
  | "unplaced";

/** Every bucket, worst first. The first five are debt; the rest are not counted as debt. */
export const REPORT_BUCKETS: Array<
  { key: BucketKey; name: string; sub: string; debt: boolean; title: string }
> = [
  {
    key: "bad_debt",
    name: "Bad debt",
    sub: "Day 21 or more past due",
    debt: true,
    title: "Bad debt: day 21 or more past due",
  },
  {
    key: "escalating",
    name: "Escalating",
    sub: "Day 8 to 20",
    debt: true,
    title: "Escalating: day 8 to 20",
  },
  {
    key: "active",
    name: "Active",
    sub: "Day 1 to 7",
    debt: true,
    title: "Active: day 1 to 7",
  },
  {
    key: "rectification",
    name: "Rectification",
    sub: "Held: job being fixed",
    debt: true,
    title: "Rectification: held while the job is being fixed",
  },
  {
    key: "says_paid",
    name: "Says paid",
    sub: "Held: client says paid",
    debt: true,
    title: "Says paid: held until the payment shows",
  },
  {
    key: "not_due",
    name: "Not due yet",
    sub: "Before the tab's due date",
    debt: false,
    title: "Not due yet (not debt)",
  },
  {
    key: "go_ahead",
    name: "Go-ahead deposits",
    sub: "The job starts when it is paid",
    debt: false,
    title: "Go-ahead deposits (not debt)",
  },
  {
    key: "needs_a_look",
    name: "Needs a look",
    sub: "The rules could not place it",
    debt: false,
    title: "Needs a look (the rules could not place it as debt)",
  },
  {
    key: "not_chased",
    name: "Write-off list",
    sub: "For us to check whether to write off",
    debt: false,
    title: "Write-off list (for us to check whether to write off)",
  },
  {
    key: "excluded",
    name: "Test invoice",
    sub: "SAMPLE- reference, ignored",
    debt: false,
    title: "Test invoices the tab ignores",
  },
  {
    key: "unplaced",
    name: "Not placed",
    sub: "No rule placed it: check by hand",
    debt: false,
    title: "Not placed by any rule (check by hand)",
  },
];

export const DEBT_BUCKETS: BucketKey[] = REPORT_BUCKETS.filter((b) => b.debt)
  .map((b) => b.key);

// ── Total owed to us (Shaun approved 20 Oct 2026) ──
//
// The Debt tab's chart is the debt being chased (the five categories). "Total owed to us"
// is every open invoice, the same total as Xero's open receivables once our copy matches
// Xero. Its lines are the report's own buckets, with "not due yet" shown in three parts
// by the kind the tab already gives each invoice (a progress payment, a company invoice,
// or anything else), so the lines always add up to the total. No new rule is made here.
//
// Kept on 4 Nov 2026 so a screen that has not reloaded still works: the Debt tab now shows
// Receivables (receivablesFrom, below) in its place.

export type OwedLineKey =
  | "debt"
  | "not_due"
  | "progress"
  | "companies"
  | "deposits"
  | "not_chased"
  | "needs_a_look"
  | "test"
  | "unplaced";

export interface OwedInvoice {
  xero_invoice_id: string;
  invoice_number: string | null;
  payer: string;
  job_number: string | null;
  amount: number;
  /** One short line: the category and day, the due date, or why it is not debt. */
  detail: string;
}

export interface OwedLine {
  key: OwedLineKey;
  name: string;
  sub: string;
  count: number;
  amount: number;
  invoices: OwedInvoice[];
}

export interface TotalOwed {
  count: number;
  amount: number;
  /** Always shown: debt to needs a look. Test invoices and not placed only when there are any. */
  lines: OwedLine[];
  /** The lines add up to the total, invoice for invoice and to the cent. */
  adds_up: boolean;
}

const OWED_LINES: Array<
  { key: OwedLineKey; name: string; sub: string; always: boolean }
> = [
  { key: "debt", name: "Debt", sub: "Past due and followed up: the figure above", always: true },
  { key: "not_due", name: "Not due yet", sub: "Before the tab's due date", always: true },
  { key: "progress", name: "Progress payments", sub: "Not due yet", always: true },
  { key: "companies", name: "Companies on statements", sub: "Not due yet", always: true },
  { key: "deposits", name: "Deposits", sub: "Go-ahead payments: the job starts when paid", always: true },
  { key: "not_chased", name: "Write-off list", sub: "For us to check whether to write off", always: true },
  { key: "needs_a_look", name: "Needs a look", sub: "The rules could not place it", always: true },
  { key: "test", name: "Test invoices", sub: "SAMPLE- reference, ignored", always: false },
  { key: "unplaced", name: "Not placed", sub: "No rule placed it: check by hand", always: false },
];

/** Which line of "Total owed to us" a placed invoice belongs to. */
export function owedLineOf(row: ReportRow): OwedLineKey {
  if (DEBT_BUCKETS.includes(row.bucket)) return "debt";
  switch (row.bucket) {
    case "not_due":
      return row.lane === "account"
        ? "companies"
        : row.stage
        ? "progress"
        : "not_due";
    case "go_ahead":
      return "deposits";
    case "not_chased":
      return "not_chased";
    case "needs_a_look":
      return "needs_a_look";
    case "excluded":
      return "test";
    default:
      return "unplaced";
  }
}

function owedDetail(row: ReportRow): string {
  const bucket = REPORT_BUCKETS.find((b) => b.key === row.bucket);
  if (DEBT_BUCKETS.includes(row.bucket)) {
    return `${bucket?.name ?? "Debt"}, day ${row.days}`;
  }
  if (row.bucket === "not_due" && row.due) return `Due ${shortDate(row.due)}`;
  if (row.bucket === "go_ahead" && row.invoice_date) {
    return `Invoiced ${shortDate(row.invoice_date)}`;
  }
  return row.next;
}

/** "Total owed to us" from the placed invoices (placeOpenInvoices). */
export function totalOwedFrom(
  rows: ReportRow[],
  notChasedNames: string[] = [],
): TotalOwed {
  const lines: OwedLine[] = [];
  for (const def of OWED_LINES) {
    const mine = rows.filter((r) => owedLineOf(r) === def.key)
      .sort((a, b) => c(b.amount) - c(a.amount));
    if (!def.always && !mine.length) continue;
    lines.push({
      key: def.key,
      name: def.name,
      sub: def.key === "not_chased" && notChasedNames.length
        ? notChasedNames.join(", ")
        : def.sub,
      count: mine.length,
      amount: sum(mine),
      invoices: mine.map((r) => ({
        xero_invoice_id: r.xero_invoice_id,
        invoice_number: r.invoice_number,
        payer: r.payer,
        job_number: r.job_number,
        amount: r.amount,
        detail: owedDetail(r),
      })),
    });
  }
  const amount = sum(rows);
  const lineCents = lines.reduce((s, l) => s + c(l.amount), 0);
  const lineCount = lines.reduce((s, l) => s + l.count, 0);
  return {
    count: rows.length,
    amount,
    lines,
    adds_up: lineCents === c(amount) && lineCount === rows.length,
  };
}

export interface ReportRow {
  xero_invoice_id: string;
  bucket: BucketKey;
  payer: string;
  contact: string | null;
  lane: "homeowner" | "account" | null;
  company_key: string | null;
  job_number: string | null;
  job_type: string;
  type_group: "Fencing" | "Patio" | "Insurance and other";
  /** The stage of a progress payment ("materials"), else null. */
  stage: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  /** Xero's printed due date. */
  xero_due: string | null;
  /** The tab's due date (null for invoices the tab does not place as debt). */
  due: string | null;
  amount: number;
  /** The tab's own day (the chase day), unchanged. */
  days: number;
  next: string;
  chase: string;
  on_jan_list: boolean;
  // Receivables (debt_ws_receivables.ts).
  receivable_class: ReceivableClass;
  /** Company, Final, Deposit, Go-ahead deposit, Materials, Progress payment, and so on. */
  type_label: string;
  pay_by: string | null;
  /** Days after pay by; 0 when not due yet. */
  days_overdue: number;
  /** A hold on the chase, shown on the row: "Says paid", "Rectification", a promise. */
  hold: string | null;
}

export interface Money {
  count: number;
  amount: number;
}

// ── Receivables: where every unpaid invoice sits (Shaun, 4 Nov 2026) ──

export type WhereKey =
  | "debt_not_due"
  | "debt_overdue"
  | "other_not_due"
  | "other_overdue"
  | "write_off"
  | "needs_a_look";

export interface ReceivableInvoice {
  xero_invoice_id: string;
  invoice_number: string | null;
  payer: string;
  job_number: string | null;
  lane: "homeowner" | "account" | null;
  amount: number;
  receivable_class: ReceivableClass;
  type_label: string;
  invoice_date: string | null;
  pay_by: string | null;
  days_overdue: number;
  hold: string | null;
  /** One short line: what happens next, or why it sits where it does. */
  detail: string;
}

export interface WhereLine {
  key: WhereKey;
  name: string;
  sub: string;
  count: number;
  amount: number;
  invoices: ReceivableInvoice[];
}

export interface Receivables {
  /** Every unpaid invoice, test invoices left out. */
  count: number;
  amount: number;
  debt: Money;
  /** Debt past its pay-by date: the big number on the desk. */
  debt_overdue: Money;
  /** Debt 21 days or more past its pay-by date. */
  bad_debt: Money;
  other: Money;
  other_overdue: Money;
  write_off: Money;
  needs_a_look: Money;
  /** Where the receivables sit; always the first five, Needs a look only when there is any. */
  lines: WhereLine[];
  /** Test invoices (SAMPLE-), left out of the total and named. */
  test: Money & { invoices: ReceivableInvoice[] };
  /** The lines add up to the total, invoice for invoice and to the cent. */
  adds_up: boolean;
}

const WHERE_LINES: Array<
  { key: WhereKey; name: string; sub: string; always: boolean }
> = [
  {
    key: "debt_not_due",
    name: "Debt not due yet",
    sub: "Final and company invoices before their pay-by date",
    always: true,
  },
  {
    key: "debt_overdue",
    name: "Debt overdue",
    sub: "Final and company invoices past their pay-by date",
    always: true,
  },
  {
    key: "other_not_due",
    name: "Other receivables not due yet",
    sub: "Deposits, materials, progress payments and planning fees",
    always: true,
  },
  {
    key: "other_overdue",
    name: "Other receivables overdue",
    sub: "Past Xero's due date",
    always: true,
  },
  {
    key: "write_off",
    name: "Write-off list",
    sub: "For us to check whether to write off",
    always: true,
  },
  {
    key: "needs_a_look",
    name: "Needs a look",
    sub: "The rules could not place it",
    always: false,
  },
];

/** Where one invoice sits, or null for a test invoice (left out of Receivables). */
export function whereOf(
  row: Pick<ReportRow, "receivable_class" | "days_overdue">,
): WhereKey | null {
  switch (row.receivable_class) {
    case "debt":
      return row.days_overdue >= 1 ? "debt_overdue" : "debt_not_due";
    case "other":
      return row.days_overdue >= 1 ? "other_overdue" : "other_not_due";
    case "write_off":
      return "write_off";
    case "needs_a_look":
      return "needs_a_look";
    default:
      return null;
  }
}

function receivableInvoice(r: ReportRow): ReceivableInvoice {
  return {
    xero_invoice_id: r.xero_invoice_id,
    invoice_number: r.invoice_number,
    payer: r.payer,
    job_number: r.job_number,
    lane: r.lane,
    amount: r.amount,
    receivable_class: r.receivable_class,
    type_label: r.type_label,
    invoice_date: r.invoice_date,
    pay_by: r.pay_by,
    days_overdue: r.days_overdue,
    hold: r.hold,
    detail: r.next,
  };
}

/** Most overdue first, then the biggest, then by invoice number. */
export function byOverdue(a: ReportRow, b: ReportRow): number {
  return b.days_overdue - a.days_overdue || c(b.amount) - c(a.amount) ||
    String(a.invoice_number ?? "").localeCompare(
      String(b.invoice_number ?? ""),
      "en",
      { numeric: true },
    );
}

/** Receivables from the placed invoices (placeOpenInvoices). */
export function receivablesFrom(
  rows: ReportRow[],
  writeOffNames: string[] = [],
): Receivables {
  const tot = (xs: ReportRow[]): Money => ({ count: xs.length, amount: sum(xs) });
  const counted = rows.filter((r) => r.receivable_class !== "test");
  const tests = rows.filter((r) => r.receivable_class === "test");
  const lines: WhereLine[] = [];
  for (const def of WHERE_LINES) {
    const mine = counted.filter((r) => whereOf(r) === def.key).sort(byOverdue);
    if (!def.always && !mine.length) continue;
    lines.push({
      key: def.key,
      name: def.name,
      sub: def.key === "write_off" && writeOffNames.length
        ? `${writeOffNames.join(", ")}: for us to check whether to write off`
        : def.sub,
      count: mine.length,
      amount: sum(mine),
      invoices: mine.map(receivableInvoice),
    });
  }
  const of = (cls: ReceivableClass) =>
    counted.filter((r) => r.receivable_class === cls);
  const debt = of("debt");
  const other = of("other");
  const amount = sum(counted);
  const lineCents = lines.reduce((s, l) => s + c(l.amount), 0);
  const lineCount = lines.reduce((s, l) => s + l.count, 0);
  return {
    count: counted.length,
    amount,
    debt: tot(debt),
    debt_overdue: tot(debt.filter((r) => r.days_overdue >= 1)),
    bad_debt: tot(debt.filter((r) => r.days_overdue >= 21)),
    other: tot(other),
    other_overdue: tot(other.filter((r) => r.days_overdue >= 1)),
    write_off: tot(of("write_off")),
    needs_a_look: tot(of("needs_a_look")),
    lines,
    test: { ...tot(tests), invoices: tests.map(receivableInvoice) },
    adds_up: lineCents === c(amount) && lineCount === counted.length,
  };
}

export interface DebtReport {
  version: string;
  today: string;
  read_at: string;
  /** "2:47pm Perth time, Wednesday the 14th of October 2026". */
  as_at: string;
  synced_at: string | null;
  prepared_by: string;
  bank: {
    status: "ok" | "unavailable";
    read_at: string | null;
    accounts: Array<{ name: string; group: string; closing: number }>;
    total: number;
    operations: number;
    provisions: number;
  };
  /** Every open invoice in our Xero copy, test invoices included. */
  xero_open: Money;
  receivables: Receivables;
  /** Whether our Xero copy matched Xero at the last hourly check; null when unread. */
  xero_check: XeroCheckView | null;
  tie: {
    /** Receivables plus the test invoices. */
    sum: number;
    xero: number;
    ok: boolean;
    /** The tab's own category totals still equal its debt buckets, invoice for invoice. */
    tab_match: boolean;
    unplaced: string[];
  };
  write_off_names: string[];
  /** Debt by how overdue: not due, 1 to 7, 8 to 20, 21 or more; Private and Companies. */
  debt_bands: Array<{
    key: OverdueBand;
    name: string;
    private: Money;
    companies: Money;
    total: Money;
  }>;
  /** Not overdue yet, with a pay-by date from today to 7 days from now. */
  coming_due: { from: string; to: string; debt: Money; other: Money };
  /** What happened this week (the 7 days to today). */
  week: {
    from: string;
    to: string;
    paid_in_full: Money & { status: "ok" | "unavailable" };
    activity: {
      status: "ok" | "unavailable";
      texts_sent: number;
      promises: number;
      notes: number;
      category_changes: number;
      jan_lists: number;
    };
  };
  /** Every invoice in Receivables, most overdue first. */
  rows: ReportRow[];
  /** The company terms used, and the default. */
  terms: {
    status: "ok" | "unavailable";
    default_days: number;
    companies: Array<{ name: string; days: number }>;
  };
  bank_feed: {
    status: "ok" | "partial" | "unavailable";
    receipts: Money;
    transfers: Money;
    oldest: string | null;
    matches: Array<{
      invoice_number: string | null;
      payer: string;
      amount: number;
      date: string | null;
      payer_text: string;
      reason: string;
    }>;
  };
  notes: string[];
}

// ── Small helpers ──

const c = (n: unknown) => Math.round(Number(n || 0) * 100);
const sum = (xs: Array<{ amount: number }>) =>
  xs.reduce((s, x) => s + c(x.amount), 0) / 100;
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const tidy = (x: unknown) => String(x ?? "").replace(/\s+/g, " ").trim();

/** "2:47pm" in Perth (UTC+8, no daylight saving). */
export function perthClock(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms + 8 * 3_600_000);
  const hh = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh % 12 || 12}:${mm}${hh < 12 ? "am" : "pm"}`;
}

/** "14 Oct 26". */
export function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${
    String(d.getUTCFullYear()).slice(2)
  }`;
}

/** "53%" (whole percent), or "" when the whole is zero. */
export function pct(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "";
}

export function typeLabel(type: string | null): string {
  const s = String(type ?? "").toLowerCase();
  if (s === "fencing") return "Fencing";
  if (s === "patio") return "Patio";
  if (s === "makesafe") return "Make-safe";
  if (s === "repair") return "Repair";
  if (s.includes("roof")) return "Roof report";
  if (s === "insurance") return "Insurance";
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "No job linked";
}

export function typeGroup(type: string | null): ReportRow["type_group"] {
  const s = String(type ?? "").toLowerCase();
  return s === "fencing" ? "Fencing" : s === "patio" ? "Patio" : "Insurance and other";
}

/** The group a bank account sits in on the report, by its Xero name. */
export function bankGroup(name: string): string {
  if (/^\s*operations\s*$/i.test(name)) return "Main trading account";
  if (/provision|paygo/i.test(name)) return "Provisions (set aside)";
  return "Other accounts";
}
const BANK_GROUPS = [
  "Main trading account",
  "Provisions (set aside)",
  "Other accounts",
];

const LOG_LABELS: Record<string, string> = {
  note: "Note",
  text_sent: "Texted",
  promise: "Promise to pay",
  category_change: "Category changed",
  skip: "Step skipped",
  call: "Called",
  email_sent: "Emailed",
  statement_sent: "Statement sent",
  jan_list: "On Jan's visit list",
  link_contact: "Contact linked",
  agent_flag: "Agent notice",
  send_refused: "Send refused",
};

/** The newest chase line on the invoice: "13 Oct 26 Texted (d3)". */
function lastChase(e: BookEntry | undefined): string {
  if (!e || !e.logs.length) return "";
  const l = e.logs.find((x) => x.kind !== "category_change") ?? e.logs[0];
  const body = l.kind === "text_sent" ? "" : l.body ? `: ${tidy(l.body)}` : "";
  const line = `${shortDate(perthDateOf(l.created_at))} ${
    LOG_LABELS[l.kind] ?? l.kind
  }${l.step ? ` (${l.step})` : ""}${body}`;
  return line.length > 140 ? `${line.slice(0, 137)}...` : line;
}

/** What happens next on a debt or not-due invoice, in plain words. */
function nextWords(e: BookEntry): string {
  const row = e.row;
  if (e.notChased) {
    return "On the Write-off list: never chased or put on a statement";
  }
  if (e.category === "says_paid") {
    return `Says paid since ${shortDate(row.says_paid_since)}: check Xero and the bank before chasing`;
  }
  if (e.category === "rectification") return "Held while the job is in rectification";
  if (e.kind === "account") {
    return e.category
      ? "Past due: goes on the weekly company statement"
      : `Due ${shortDate(e.dueDate)} (company terms, ${e.row.terms_days ?? 10} days)`;
  }
  if (!e.category) {
    return e.dayZero !== e.dueDate
      ? `Left rectification ${shortDate(e.dayZero)}: chasing starts ${
        shortDate(addDays(e.dayZero, 1))
      }`
      : `Not due until ${shortDate(e.dueDate)}`;
  }
  if (row.on_jan_list) return "Day 21 or more: on Jan's visit list";
  if (row.paused_until) return `Paused until ${shortDate(row.paused_until)} (promise to pay)`;
  if (row.step_due) return `Due now: ${row.step_due.label}`;
  if (row.next_step) {
    const label = STEP_LABELS[row.next_step.step as keyof typeof STEP_LABELS] ??
      row.next_step.step;
    return `Next: ${label} on ${shortDate(row.next_step.date)}`;
  }
  if (e.kind === "progress" && e.day >= 21) {
    return "Progress payment at day 21 or more: held for a call, not Jan's list";
  }
  return "Steps finished: call or visit";
}

// ── Building the report ──

/** A hold on the chase, in plain words, for the row (null when nothing holds it). */
function holdOf(e: BookEntry): string | null {
  if (e.category === "says_paid") return "Says paid";
  if (e.category === "rectification") return "Rectification";
  if (e.row.paused_until) {
    return `Promise to pay, paused until ${shortDate(e.row.paused_until)}`;
  }
  return null;
}

/**
 * Every open invoice in exactly one bucket, by the Debt tab's own book, with its receivable
 * class, type, pay-by date and days overdue (debt_ws_receivables.ts). The report, the Debt
 * tab's Receivables card (receivablesFrom), the older "Total owed to us" lines
 * (totalOwedFrom) and the tie to the total all read this one placement, so they can never
 * disagree.
 */
export function placeOpenInvoices(
  book: Book,
  openInvoices: WsInvoice[],
): ReportRow[] {
  const today = book.today;
  const jobs = book.jobs;
  const entryBy = new Map(book.entries.map((e) => [e.inv.xero_invoice_id, e]));
  const lookBy = new Map(book.needsALook.map((n) => [n.xero_invoice_id, n]));
  const goAhead = new Set(book.goAhead.map((g) => g.xero_invoice_id));
  const xeroDaysOver = (due: string | null | undefined) =>
    due ? Math.max(0, daysBetween(String(due).slice(0, 10), today)) : 0;
  const viewOf = (v: ReceivableView) => ({
    receivable_class: v.receivable_class,
    type_label: v.type_label,
    pay_by: v.pay_by,
    days_overdue: v.days_overdue,
  });

  const rows: ReportRow[] = [];
  for (const inv of openInvoices) {
    const id = String(inv.xero_invoice_id).toLowerCase();
    const job = inv.job_id ? jobs.get(String(inv.job_id)) ?? null : null;
    const base = {
      xero_invoice_id: id,
      contact: inv.contact_name,
      job_number: job?.job_number ?? null,
      job_type: typeLabel(job?.type ?? null),
      type_group: typeGroup(job?.type ?? null),
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      xero_due: inv.due_date ?? null,
      amount: c(inv.amount_due) / 100,
      stage: null,
      due: null,
      chase: "",
      on_jan_list: false,
      company_key: null,
      hold: null,
    };
    const unplaced = (cls: "needs_a_look" | "test", reason: string | null) =>
      viewOf(receivableOfUnplaced({
        cls,
        reason,
        invoiceDate: inv.invoice_date,
        xeroDue: inv.due_date,
        today,
      }));
    if (!inScope(inv)) {
      rows.push({
        ...base,
        ...unplaced("test", null),
        bucket: "excluded",
        payer: tidy(inv.contact_name) || "Unknown payer",
        lane: null,
        days: xeroDaysOver(inv.due_date),
        next: "Test reference (SAMPLE-): left out of Receivables",
      });
      continue;
    }
    const e = entryBy.get(id);
    if (e) {
      const row = e.row;
      // On a shared fence the payer reads "Riley Shaw (neighbour of Taylor Brooks)".
      const payer = row.neighbour_of && sameName(row.payer_name, row.neighbour_of)
        ? tidy(row.payer_name)
        : tidy(row.payer_label);
      const bucket: BucketKey = e.notChased
        ? "not_chased"
        : e.category ?? "not_due";
      const lookReason = row.receivable_class === "needs_a_look"
        ? "final invoice but the job is not marked Complete or Invoiced, so it is not counted as debt yet (still chased as before)"
        : null;
      rows.push({
        ...base,
        bucket,
        payer,
        lane: e.cls.lane,
        company_key: e.companyKey,
        stage: e.kind === "progress" ? e.cls.stage ?? "progress" : null,
        due: e.dueDate,
        days: e.day,
        next: lookReason ? `Needs a look: ${lookReason}` : nextWords(e),
        chase: lastChase(e),
        on_jan_list: !!row.on_jan_list && !e.notChased,
        receivable_class: row.receivable_class,
        type_label: row.type_label,
        pay_by: row.pay_by,
        days_overdue: row.days_overdue,
        hold: e.notChased ? null : holdOf(e),
      });
      continue;
    }
    if (goAhead.has(id)) {
      rows.push({
        ...base,
        ...viewOf(receivableOfGoAhead({
          stage: invoiceKindOf(inv.reference, inv.first_description).stage,
          invoiceDate: inv.invoice_date,
          xeroDue: inv.due_date,
          today,
        })),
        bucket: "go_ahead",
        payer: tidy(inv.contact_name) || tidy(job?.client_name) || "Unknown payer",
        lane: "homeowner",
        days: inv.invoice_date ? daysBetween(inv.invoice_date, today) : 0,
        next: "Go-ahead payment: the job starts when it is paid",
      });
      continue;
    }
    const look = lookBy.get(id);
    if (look) {
      rows.push({
        ...base,
        ...unplaced("needs_a_look", look.reason),
        bucket: "needs_a_look",
        payer: tidy(look.payer_name),
        lane: looksLikeCompany(inv.contact_name) ? "account" : "homeowner",
        days: xeroDaysOver(inv.due_date),
        next: `Needs a look: ${look.reason}`,
      });
      continue;
    }
    rows.push({
      ...base,
      ...unplaced("needs_a_look", "no rule placed it"),
      bucket: "unplaced",
      payer: tidy(inv.contact_name) || "Unknown payer",
      lane: null,
      days: xeroDaysOver(inv.due_date),
      next: "Not placed by any rule: check by hand",
    });
  }
  return rows;
}

/** The not-chased (Write-off list) names from the settings, without the contact ids. */
export function writeOffNamesOf(book: Book): string[] {
  return book.settings.not_chased_contacts.filter((x) =>
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)
  );
}

/** The company terms in use, by name where an open invoice names the company. */
export function termsInUse(book: Book): DebtReport["terms"] {
  const names = new Map<string, string>();
  for (const e of book.entries) {
    if (!e.companyKey) continue;
    const own = String(e.inv.xero_contact_id ?? "").toLowerCase() === e.companyKey;
    if (own || !names.has(e.companyKey)) {
      names.set(e.companyKey, tidy(e.inv.contact_name) || "Unknown company");
    }
  }
  const companies = Object.keys(book.terms.by_company)
    .filter((k) => names.has(k))
    .map((k) => ({
      name: names.get(k)!,
      days: companyTermsFor(k, book.terms.by_company, book.terms.default_days),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    status: book.terms.status,
    default_days: book.terms.default_days,
    companies,
  };
}

export function buildDebtReport(input: DebtReportInput): DebtReport {
  const { book } = input;
  const today = book.today;
  const year = today.slice(0, 4);

  // Every open invoice gets exactly one bucket, class and pay-by date.
  const rows = placeOpenInvoices(book, input.openInvoices);
  const writeOffNames = writeOffNamesOf(book);
  const receivables = receivablesFrom(rows, writeOffNames);

  const xeroOpen = {
    count: input.openInvoices.length,
    amount: sum(input.openInvoices.map((i) => ({ amount: Number(i.amount_due || 0) }))),
  };
  // The tie: Receivables plus the test invoices left out equal every open invoice in our
  // Xero copy, invoice for invoice and to the cent.
  const tieSum = (c(receivables.amount) + c(receivables.test.amount)) / 100;
  const unplaced = rows.filter((r) => r.bucket === "unplaced")
    .map((r) => r.invoice_number ?? r.xero_invoice_id);
  // The tab's own category totals (not-chased left out, as the tab's chart does) still
  // equal its debt buckets here: the chase side did not move.
  const bucketMoney = (k: BucketKey) => {
    const xs = rows.filter((r) => r.bucket === k);
    return { count: xs.length, amount: sum(xs) };
  };
  const tabTotals = categoryTotals(
    book.entries.filter((e) => e.open && !e.notChased),
  );
  const tabMatch = DEBT_BUCKETS.every((k) =>
    c(tabTotals[k as Category].amount) === c(bucketMoney(k).amount) &&
    tabTotals[k as Category].count === bucketMoney(k).count
  );
  const tie = {
    sum: tieSum,
    xero: xeroOpen.amount,
    ok: c(tieSum) === c(xeroOpen.amount) &&
      receivables.count + receivables.test.count === xeroOpen.count &&
      receivables.adds_up,
    tab_match: tabMatch,
    unplaced,
  };

  // Bank balances.
  const accounts = (input.bank?.accounts ?? []).filter((a) => a.closing !== null)
    .map((a) => ({ name: tidy(a.name) || "Unnamed account", group: bankGroup(a.name), closing: c(a.closing) / 100 }))
    .sort((a, b) =>
      BANK_GROUPS.indexOf(a.group) - BANK_GROUPS.indexOf(b.group) || b.closing - a.closing
    );
  const bankSum = (g?: string) =>
    accounts.filter((a) => !g || a.group === g).reduce((s, a) => s + c(a.closing), 0) / 100;
  const bank = {
    status: input.bank ? "ok" as const : "unavailable" as const,
    read_at: input.bank?.read_at ?? null,
    accounts,
    total: bankSum(),
    operations: bankSum("Main trading account"),
    provisions: bankSum("Provisions (set aside)"),
  };

  const counted = rows.filter((r) => r.receivable_class !== "test");
  const tot = (xs: ReportRow[]): Money => ({ count: xs.length, amount: sum(xs) });

  // Debt, by how overdue.
  const debtRows = counted.filter((r) => r.receivable_class === "debt");
  const debtBands = OVERDUE_BANDS.map((b) => {
    const xs = debtRows.filter((r) => overdueBand(r.days_overdue) === b.key);
    return {
      key: b.key,
      name: b.name,
      private: tot(xs.filter((r) => r.lane !== "account")),
      companies: tot(xs.filter((r) => r.lane === "account")),
      total: tot(xs),
    };
  });

  // Coming due: not overdue yet, pay by from today to 7 days from now.
  const dueTo = addDays(today, 7);
  const comingDue = (cls: ReceivableClass) =>
    tot(counted.filter((r) =>
      r.receivable_class === cls && r.days_overdue === 0 && !!r.pay_by &&
      r.pay_by >= today && r.pay_by <= dueTo
    ));

  // What happened this week.
  const week = reportWeek(today);
  const paid = (input.paidInFull ?? []).filter((i) =>
    !String(i.reference ?? "").toUpperCase().includes("SAMPLE-")
  );
  const logs = (input.weekLogs ?? []).filter((l) => l.share_key !== REPORT_LOG_KEY);
  const count = (kind: string) => logs.filter((l) => l.kind === kind).length;
  const janLists = new Set(
    logs.filter((l) =>
      l.kind === "jan_list" && l.meta?.removed !== true && !!l.meta?.visit_date
    ).map((l) => String(l.meta!.visit_date)),
  ).size;

  // The bank feed: unreconciled customer receipts that may already pay an open invoice.
  const receipts = (input.feed?.txs ?? []).filter((t) =>
    String(t.type ?? "").toUpperCase() === "RECEIVE"
  );
  const transfers = (input.feed?.txs ?? []).filter((t) =>
    String(t.type ?? "").toUpperCase() === "RECEIVE-TRANSFER"
  );
  const matches: DebtReport["bank_feed"]["matches"] = [];
  if (input.feed) {
    for (const e of book.entries.filter((x) => x.open && !x.notChased)) {
      const found: PossiblePayment[] = possiblePayments(
        e.inv,
        [e.inv.contact_name, e.payer.name],
        receipts,
      );
      for (const p of found) {
        matches.push({
          invoice_number: e.inv.invoice_number,
          payer: tidy(e.row.payer_label),
          amount: p.amount,
          date: p.date,
          payer_text: tidy(p.payer_text),
          reason: p.reason,
        });
      }
    }
  }
  const bankFeed = {
    status: !input.feed ? "unavailable" as const : input.feed.truncated ? "partial" as const : "ok" as const,
    receipts: { count: receipts.length, amount: sum(receipts.map((t) => ({ amount: Number(t.total || 0) }))) },
    transfers: { count: transfers.length, amount: sum(transfers.map((t) => ({ amount: Number(t.total || 0) }))) },
    oldest: receipts.map((t) => String(t.date ?? "").slice(0, 10)).filter(Boolean).sort()[0] ?? null,
    matches,
  };

  const asAt = `${perthClock(input.now.toISOString())} Perth time, ${longDate(today)} ${year}`;
  const report: DebtReport = {
    version: DEBT_REPORT_VERSION,
    today,
    read_at: input.now.toISOString(),
    as_at: asAt,
    synced_at: input.syncedAt,
    prepared_by: input.preparedBy,
    bank,
    xero_open: xeroOpen,
    receivables,
    xero_check: input.xeroCheck ?? null,
    tie,
    write_off_names: writeOffNames,
    debt_bands: debtBands,
    coming_due: {
      from: today,
      to: dueTo,
      debt: comingDue("debt"),
      other: comingDue("other"),
    },
    week: {
      ...week,
      paid_in_full: {
        status: input.paidInFull ? "ok" : "unavailable",
        count: paid.length,
        amount: sum(paid.map((i) => ({ amount: Number(i.total || 0) }))),
      },
      activity: {
        status: input.weekLogs ? "ok" : "unavailable",
        texts_sent: count("text_sent"),
        promises: count("promise"),
        notes: count("note"),
        category_changes: count("category_change"),
        jan_lists: janLists,
      },
    },
    rows: [...counted].sort(byOverdue),
    terms: termsInUse(book),
    bank_feed: bankFeed,
    notes: [],
  };
  report.notes = notes(report);
  return report;
}

/** The short terms note: who has how long to pay, and where each pay-by date comes from. */
export function termsNote(r: Pick<DebtReport, "terms">): string {
  const set = r.terms.companies.map((t) => `${t.name} ${t.days} days`);
  return `Terms. Companies: ${
    set.length ? `${set.join(", ")}, every other company` : "every company"
  } ${r.terms.default_days} days from the invoice date (set on the Debt tab). Private final invoices are due on the invoice date. Other receivables use Xero's due date. Days overdue count from the pay-by date.${
    r.terms.status === "unavailable"
      ? " The company terms could not be read for this report, so every company was given the default."
      : ""
  }`;
}

function notes(r: DebtReport): string[] {
  const out: string[] = [];
  const synced = r.synced_at
    ? `last synced at ${perthClock(r.synced_at)} on ${shortDate(perthDateOf(r.synced_at))} (it syncs about every 15 minutes)`
    : "sync time unknown";
  out.push(
    `Sources. Invoices: our Xero copy (receivables that are AUTHORISED with an amount due above zero), ${synced}. Jobs, job status and chase history: the Debt tab's own records (the ops dashboard job status; GoHighLevel pipeline stages are not used). Bank balances: Xero's Bank Summary, ${
      r.bank.status === "ok" ? `read live at ${perthClock(r.bank.read_at)}` : "which could not be read from Xero for this report"
    }.`,
  );
  out.push(
    "Debt is final invoices made after the job is Complete or Invoiced, and company invoices (make-safes, repairs and other company work). Everything else unpaid is Other receivables: deposits, go-ahead deposits, materials, progress payments and planning fees. A final invoice on a job not yet marked Complete or Invoiced sits under Needs a look and is still chased as before.",
  );
  const parts = r.receivables.lines.map((l) => `${l.name.toLowerCase()} ${money(l.amount)}`);
  const tests = r.receivables.test;
  out.push(
    r.tie.ok
      ? `Cross-check. ${parts.join(" + ")} = Receivables ${money(r.receivables.amount)}${
        tests.count ? `, plus ${tests.count} test invoice${tests.count === 1 ? "" : "s"} left out (${money(tests.amount)})` : ""
      } = ${money(r.tie.sum)}, equal to the total owed to us in our Xero copy, ${money(r.tie.xero)} (${r.xero_open.count} invoices), to the cent.`
      : `Cross-check FAILED. Receivables and test invoices add up to ${money(r.tie.sum)} but the total owed to us in our Xero copy is ${money(r.tie.xero)}${
        r.tie.unplaced.length ? `; not placed: ${r.tie.unplaced.join(", ")}` : ""
      }. Check before relying on these figures.`,
  );
  if (!r.tie.tab_match) {
    out.push(
      "Warning: the Debt tab's own category totals did not equal this report's. Check the tab before relying on these figures.",
    );
  }
  out.push(xeroCheckNote(r.xero_check));
  out.push(
    "Holds. An invoice the client says is paid, or whose job is back in rectification, is held: the tab does not chase it, and the hold shows on its row. A held invoice that is past its pay-by date still counts as overdue here.",
  );
  const feed = r.bank_feed;
  if (feed.status === "unavailable") {
    out.push(
      "Bank feed. The unmatched transactions in Xero could not be read for this report, so possible payments were not checked. Some debt may already be paid.",
    );
  } else {
    out.push(
      `Bank feed. Bank balances are Xero's ledger balances, not the bank's own statement balance. Customer payments sitting in the bank feed but not yet matched in Xero can mean some debt is already paid. Unmatched right now: ${feed.receipts.count} customer receipt${
        feed.receipts.count === 1 ? "" : "s"
      } totalling ${money(feed.receipts.amount)}${
        feed.oldest ? ` (the oldest from ${shortDate(feed.oldest)})` : ""
      }, and ${feed.transfers.count} transfer${feed.transfers.count === 1 ? "" : "s"} between our own accounts (${
        money(feed.transfers.amount)
      }), which are not customer money. ${
        feed.matches.length
          ? `Possible matches: ${
            feed.matches.slice(0, 12).map((m) =>
              `${m.invoice_number ?? "invoice"} ${money(m.amount)} on ${shortDate(m.date)} (${m.reason})`
            ).join("; ")
          }.`
          : "None of them matches an open invoice."
      }${feed.status === "partial" ? " The feed read stopped early, so older receipts were not checked." : ""}`,
    );
  }
  out.push(
    `This week is ${shortDate(r.week.from)} to ${shortDate(r.week.to)}. Paid in full counts invoices Xero shows fully paid in that time, deposits included, at their invoice total. The activity counts come from the Debt tab's log. The Debt tab went live on ${longDate(DEBT_TAB_LIVE_DATE)} ${DEBT_TAB_LIVE_DATE.slice(0, 4)}.`,
  );
  return out;
}

/** One sentence on the hourly check of our Xero copy against Xero itself. */
export function xeroCheckNote(x: XeroCheckView | null): string {
  if (!x) return "Check against Xero: it could not be read for this report.";
  if (x.status === "not_checked") {
    return "Check against Xero: our Xero copy has not been checked against Xero yet (it is checked every hour).";
  }
  const when = `at ${perthClock(x.checked_at)} on ${shortDate(perthDateOf(x.checked_at!))}`;
  if (x.status === "matches") {
    return `Check against Xero: our Xero copy matched Xero's own open invoices ${when}: ${
      x.xero?.count ?? 0
    } invoices, ${money(x.xero?.amount ?? 0)}.`;
  }
  return `Check against Xero ${when}: ${x.words}. Xero says ${money(x.xero?.amount ?? 0)} across ${
    x.xero?.count ?? 0
  } invoices; our copy says ${money(x.copy?.amount ?? 0)} across ${x.copy?.count ?? 0}.`;
}

// ── The report as an HTML page (the view, and the copy kept on a send) ──

const esc = escapeHtml;
const R = (n: number) => `<td class="n">${esc(money(n))}</td>`;
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** "Debt: Final", "Other: Deposit", "Write-off list", "Needs a look". */
export function typeWords(
  row: Pick<ReportRow, "receivable_class" | "type_label">,
): string {
  switch (row.receivable_class) {
    case "debt":
      return `Debt: ${row.type_label}`;
    case "other":
      return `Other: ${row.type_label}`;
    case "write_off":
      return "Write-off list";
    case "needs_a_look":
      return "Needs a look";
    default:
      return "Test invoice";
  }
}

/** "INV-1234 (SWF-26091)". */
export function invoiceWords(
  row: Pick<ReportRow, "invoice_number" | "job_number">,
): string {
  const inv = row.invoice_number ?? "";
  return row.job_number ? `${inv} (${row.job_number})`.trim() : inv;
}

/** The "Every invoice" sections: by how overdue, most overdue first. */
export function overdueSections(
  r: DebtReport,
): Array<{ key: OverdueBand; title: string; total: number; rows: ReportRow[] }> {
  const titles: Record<OverdueBand, string> = {
    d21: "Overdue 21 days or more",
    d8_20: "Overdue 8 to 20 days",
    d1_7: "Overdue 1 to 7 days",
    not_due: "Not due yet",
  };
  return (["d21", "d8_20", "d1_7", "not_due"] as OverdueBand[]).map((k) => {
    const rows = r.rows.filter((x) => overdueBand(x.days_overdue) === k);
    return { key: k, title: titles[k], total: sum(rows), rows };
  }).filter((s) => s.rows.length);
}

/** The "What happened this week" lines, shared by the page, the PDF and the email. */
export function weekLines(r: DebtReport): Array<[string, string]> {
  const w = r.week;
  const out: Array<[string, string]> = [];
  out.push([
    "Invoices paid in full",
    w.paid_in_full.status === "ok"
      ? `${plural(w.paid_in_full.count, "invoice")}, ${money(w.paid_in_full.amount)}`
      : "Could not be read",
  ]);
  if (w.activity.status === "ok") {
    out.push(["Texts sent", String(w.activity.texts_sent)]);
    out.push(["Promises to pay", String(w.activity.promises)]);
    out.push(["Notes", String(w.activity.notes)]);
    out.push(["Category changes", String(w.activity.category_changes)]);
    out.push(["Jan's visit lists sent", String(w.activity.jan_lists)]);
  } else {
    out.push(["Debt tab activity", "Could not be read"]);
  }
  return out;
}

export function tieWords(r: DebtReport): string {
  const t = r.receivables.test;
  const left = t.count
    ? ` Left out: ${plural(t.count, "test invoice")} (${
      t.invoices.map((i) => i.invoice_number ?? i.xero_invoice_id).join(", ")
    }, ${money(t.amount)}).`
    : "";
  return r.tie.ok
    ? `Matches our Xero copy: Receivables ${money(r.receivables.amount)}${
      t.count ? ` plus test invoices ${money(t.amount)}` : ""
    } equals ${money(r.tie.xero)}, to the cent.${left}`
    : `Does not match our Xero copy: ${money(r.tie.sum)} against ${money(r.tie.xero)}.${
      r.tie.unplaced.length ? ` Not placed: ${r.tie.unplaced.join(", ")}.` : ""
    }${left}`;
}

export function debtReportHtml(r: DebtReport): string {
  const rv = r.receivables;
  const whereRows = rv.lines.map((l) =>
    `<tr${l.key === "debt_overdue" ? ' class="hot"' : ""}><td>${esc(l.name)} <span class="mut">${esc(l.sub)}</span></td><td class="n">${l.count}</td>${R(l.amount)}</tr>`
  ).join("");
  const bandRows = r.debt_bands.map((b) =>
    `<tr${b.key === "d21" ? ' class="hot"' : ""}><td>${esc(b.name)}</td>${R(b.private.amount)}${R(b.companies.amount)}<td class="n">${b.total.count}</td>${R(b.total.amount)}</tr>`
  ).join("");
  const bandTotal = (k: "private" | "companies" | "total") =>
    r.debt_bands.reduce((s, b) => s + c(b[k].amount), 0) / 100;
  const cd = r.coming_due;

  const summary = `
<section class="page first">
  <header class="band">
    <div class="brand">SECUREWORKS GROUP</div>
    <div class="ttl"><h1>Debt and receivables</h1><p>As at ${esc(r.as_at)}</p></div>
  </header>
  <p class="fresh">Invoices from our Xero copy${
    r.synced_at ? `, last synced at ${esc(perthClock(r.synced_at))} Perth time` : ""
  }. ${
    r.bank.status === "ok" ? `Bank balances read live from Xero at ${esc(perthClock(r.bank.read_at))}. ` : ""
  }Worked out with the Debt tab's own rules, so every number here matches the tab.</p>
  <div class="kpis">
    <div class="kpi"><div class="l">Receivables</div><div class="v">${esc(money(rv.amount))}</div><div class="s">${
    plural(rv.count, "unpaid invoice")
  }${r.tie.ok ? "; ties to our Xero copy" : "; does not tie to our Xero copy"}</div></div>
    <div class="kpi hot"><div class="l">Debt overdue</div><div class="v">${esc(money(rv.debt_overdue.amount))}</div><div class="s">${
    plural(rv.debt_overdue.count, "invoice")
  } past the pay-by date</div></div>
    <div class="kpi hot"><div class="l">Bad debt (21 days or more)</div><div class="v">${esc(money(rv.bad_debt.amount))}</div><div class="s">${
    plural(rv.bad_debt.count, "invoice")
  }</div></div>
    <div class="kpi"><div class="l">Other receivables</div><div class="v">${esc(money(rv.other.amount))}</div><div class="s">${
    esc(money(rv.other_overdue.amount))
  } of it overdue</div></div>
    <div class="kpi"><div class="l">Cash at bank</div><div class="v">${
    r.bank.status === "ok" ? esc(money(r.bank.total)) : "Not read"
  }</div><div class="s">${
    r.bank.status === "ok" ? `${esc(money(r.bank.total - r.bank.provisions))} less provisions` : "Xero could not be read for the bank balances"
  }</div></div>
  </div>
  <div class="cols">
    <div class="col">
      <h3>Where the receivables sit</h3>
      <table class="t">
        <tr><th></th><th class="n">No.</th><th class="n">Amount</th></tr>
        ${whereRows}
        <tr class="tot"><td>Receivables</td><td class="n">${rv.count}</td>${R(rv.amount)}</tr>
        <tr><td class="${r.tie.ok ? "ok" : "warn"}" colspan="3">${esc(tieWords(r))}</td></tr>
        <tr><td class="${r.xero_check?.status === "matches" ? "ok" : "warn"}" colspan="3">${esc(xeroCheckNote(r.xero_check))}</td></tr>
      </table>
      <h3>Coming due in the next 7 days</h3>
      <table class="t">
        <tr><th>${esc(shortDate(cd.from))} to ${esc(shortDate(cd.to))}</th><th class="n">No.</th><th class="n">Amount</th></tr>
        <tr><td>Debt</td><td class="n">${cd.debt.count}</td>${R(cd.debt.amount)}</tr>
        <tr><td>Other receivables</td><td class="n">${cd.other.count}</td>${R(cd.other.amount)}</tr>
      </table>
    </div>
    <div class="col">
      <h3>Debt, by how overdue</h3>
      <table class="t">
        <tr><th>Days overdue</th><th class="n">Private</th><th class="n">Companies</th><th class="n">No.</th><th class="n">Total</th></tr>
        ${bandRows}
        <tr class="tot"><td>All debt</td>${R(bandTotal("private"))}${R(bandTotal("companies"))}<td class="n">${rv.debt.count}</td>${R(bandTotal("total"))}</tr>
      </table>
      <h3>What happened this week <span class="mut">(${esc(shortDate(r.week.from))} to ${esc(shortDate(r.week.to))})</span></h3>
      <table class="t">
        ${weekLines(r).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${esc(v)}</td></tr>`).join("")}
      </table>
      <p class="note">${esc(termsNote(r))}</p>
    </div>
  </div>
</section>`;

  const listTable = (rs: ReportRow[]) => `
  <table class="t list fx">
    <colgroup><col style="width:30%"><col style="width:17%"><col style="width:17%"><col style="width:10%"><col style="width:9%"><col style="width:9%"><col style="width:8%"></colgroup>
    <tr><th>Who</th><th>Invoice</th><th>Type</th><th class="n">Amount</th><th>Invoiced</th><th>Pay by</th><th class="n">Days overdue</th></tr>
    ${
    rs.map((x) =>
      `<tr><td>${esc(x.payer)}${x.hold ? `<div class="hold">Held: ${esc(x.hold)}</div>` : ""}</td><td>${
        esc(invoiceWords(x))
      }</td><td>${esc(typeWords(x))}</td>${R(x.amount)}<td>${esc(shortDate(x.invoice_date))}</td><td>${
        esc(shortDate(x.pay_by))
      }</td><td class="n">${x.days_overdue}</td></tr>`
    ).join("")
  }
    <tr class="tot"><td colspan="3">${plural(rs.length, "invoice")}</td>${R(sum(rs))}<td colspan="3"></td></tr>
  </table>`;
  const listSection = `
<section class="page">
  <h2>Every invoice, by how overdue it is</h2>
  <p class="lead">Every unpaid invoice in Receivables, most overdue first. Days overdue count from the pay-by date. The sections add up to Receivables, ${
    esc(money(rv.amount))
  }.</p>
  ${
    overdueSections(r).map((s) =>
      `<div class="sec"><h3 class="sh">${esc(s.title)} <span class="amt">${esc(money(s.total))}</span></h3>${listTable(s.rows)}</div>`
    ).join("")
  }
</section>`;

  const notesSection = `
<section class="notes">
  <h2>Notes</h2>
  <ul>${r.notes.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>
  <p class="foot">Prepared from the Debt tab for ${esc(r.prepared_by)}, SecureWorks Group, ${esc(r.as_at)}. Read only: nothing was changed while preparing this report.</p>
</section>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Debt and receivables ${esc(r.today)}</title>
<style>${REPORT_CSS}</style></head><body>
${summary}
${listSection}
${notesSection}
</body></html>`;
}

// The template's look (debt-collection-fresh/debt-report-template/report.html), A4 when printed.
const REPORT_CSS = `
@page { size: A4; margin: 11mm 10mm 12mm 10mm; }
:root { --dark:#1A272E; --blue:#293C46; --mid:#4C6A7C; --haze:#8FA4B2; --mist:#D4DEE4; --frost:#EDF1F4; --orange:#F15A29; --ember:#C4481F; --text:#323232; }
* { box-sizing: border-box; }
html { background:#fff; }
body { margin:0 auto; max-width: 1100px; padding: 12px; font-family: Helvetica, Arial, sans-serif; color: var(--text); font-size: 12px; line-height: 1.35; background:#fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page + .page, .notes { margin-top: 22px; }
.band { background: var(--dark); color:#fff; display:flex; align-items:center; justify-content:space-between; gap: 12px; padding: 12px 16px; border-bottom: 3px solid var(--orange); flex-wrap: wrap; }
.band .brand { font-weight: 700; letter-spacing: .14em; font-size: 12px; }
.band h1 { margin:0; font-size: 24px; font-weight: 700; text-align:right; }
.band p { margin: 2px 0 0; text-align:right; color: var(--mist); font-size: 12px; }
.fresh { color: var(--mid); margin: 8px 0 10px; font-size: 11.5px; }
.kpis { display:grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap: 8px; margin-bottom: 10px; }
.kpi { border:1px solid var(--mist); border-top: 3px solid var(--blue); padding: 7px 9px; background: #FCFBFA; min-width: 0; }
.kpi.hot { border-top-color: var(--orange); background: #FDF2EE; }
.kpi .l { font-size: 10px; color: var(--mid); text-transform: uppercase; letter-spacing: .4px; }
.kpi .v { font-size: 19px; font-weight: 700; color: var(--blue); margin: 2px 0 1px; }
.kpi.hot .v { color: var(--ember); }
.kpi .s { font-size: 10.5px; color: var(--mid); }
.cols { display:grid; grid-template-columns: minmax(0,.92fr) minmax(0,1.08fr); gap: 16px; }
.cols2 { display:grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 12px; }
h2 { font-size: 17px; color: var(--blue); margin: 4px 0 6px; padding-bottom: 3px; border-bottom: 2px solid var(--orange); }
h3 { font-size: 11.5px; color: var(--blue); margin: 12px 0 4px; text-transform: uppercase; letter-spacing: .4px; }
h3 .mut { text-transform:none; letter-spacing:0; }
.sec { margin-top: 8px; overflow-x: auto; }
h3.sh { display:flex; justify-content:space-between; gap: 10px; background: var(--frost); padding: 5px 8px; border-left: 3px solid var(--orange); text-transform:none; font-size: 12.5px; margin-top: 14px; }
h3.sh .amt { color: var(--ember); white-space: nowrap; }
table.t { width:100%; border-collapse: collapse; }
table.t th { text-align:left; font-weight:700; color: var(--mid); font-size: 10.5px; border-bottom: 1px solid var(--haze); padding: 3px 5px; }
table.t td { padding: 3px 5px; border-bottom: 1px solid var(--frost); vertical-align: top; }
table.t .n { text-align:right; white-space: nowrap; font-variant-numeric: tabular-nums; }
table.t tr.grp td { font-weight:700; color: var(--blue); padding-top: 6px; border-bottom: none; }
table.t td.ind { padding-left: 14px; }
table.t tr.tot td { font-weight:700; border-top: 1.5px solid var(--blue); border-bottom: none; color: var(--blue); }
table.t tr.hot td { color: var(--ember); font-weight: 700; }
.hold { font-size: 10px; color: var(--mid); margin-top: 1px; }
table.t tr.sub td { font-weight:700; border-top: 1px solid var(--haze); background: #FDF2EE; color: var(--ember); }
table.list { font-size: 11px; min-width: 760px; }
table.fx { table-layout: fixed; }
table.list td.sm { font-size: 10.5px; color: #4a4a4a; }
.mut { color: var(--haze); font-weight: normal; }
td.mut { color: var(--mid); }
.ok { color: #2e6b3a; font-weight: 700; font-size: 11px; }
.warn { color: #8E2B1E; font-weight: 700; font-size: 11px; }
.bar { display:flex; height: 10px; margin: 2px 0 6px; border-radius: 2px; overflow:hidden; background: var(--frost); }
.bar span { display:block; height:100%; }
.bad { background: var(--ember); } .esc { background: var(--orange); } .act { background: #F4845F; } .hold { background: var(--haze); }
i.dot { display:inline-block; width:8px; height:8px; border-radius: 1px; margin-right: 5px; }
.lead { color: var(--mid); margin: 2px 0 8px; }
.note { color: var(--mid); font-size: 10.5px; margin: 3px 0 4px; }
.notes ul { padding-left: 18px; margin: 4px 0 10px; }
.notes li { margin-bottom: 6px; }
.foot { margin-top: 12px; color: var(--mid); font-size: 10.5px; border-top: 1px solid var(--mist); padding-top: 6px; }
table.top td:first-child { width: 18px; color: var(--mid); }
@media (max-width: 760px) { .cols, .cols2 { grid-template-columns: minmax(0,1fr); } .kpis { grid-template-columns: repeat(2, minmax(0,1fr)); } .band h1, .band p { text-align: left; } }
@media print { body { max-width: none; padding: 0; font-size: 8.4pt; } .page + .page, .notes { break-before: page; margin-top: 0; } table.list tr { break-inside: avoid; } h3.sh { break-after: avoid; } table.list { min-width: 0; } }
`;

// ── The email that carries the PDF ──

export function debtReportFileName(r: DebtReport): string {
  return `Debt and receivables ${r.today}.pdf`;
}

export function debtReportSubject(r: DebtReport): string {
  return `Debt and receivables: ${longDate(r.today)} ${r.today.slice(0, 4)}`;
}

/** The headline lines, used for the email body and kept as the send's summary. */
export function debtReportSummaryLines(r: DebtReport): string[] {
  const rv = r.receivables;
  const lines: string[] = [];
  lines.push(
    `Receivables (every unpaid invoice): ${money(rv.amount)} across ${rv.count} invoices. ${
      r.tie.ok ? "It matches our Xero copy to the cent." : "It did NOT match our Xero copy: see the notes in the report."
    }`,
  );
  lines.push(
    `Debt overdue: ${money(rv.debt_overdue.amount)} across ${rv.debt_overdue.count} invoices, of which bad debt (21 days or more) ${
      money(rv.bad_debt.amount)
    }.`,
  );
  lines.push(
    `Other receivables (deposits, materials, progress payments, planning fees): ${money(rv.other.amount)}, of which ${
      money(rv.other_overdue.amount)
    } is overdue.`,
  );
  lines.push(
    `Write-off list (for us to check whether to write off): ${money(rv.write_off.amount)}${
      r.write_off_names.length ? ` (${r.write_off_names.join(", ")})` : ""
    }.`,
  );
  lines.push(
    `Coming due in the next 7 days: debt ${money(r.coming_due.debt.amount)}, other receivables ${
      money(r.coming_due.other.amount)
    }.`,
  );
  const w = r.week;
  lines.push(
    w.paid_in_full.status === "ok"
      ? `This week: ${w.paid_in_full.count} invoice${w.paid_in_full.count === 1 ? "" : "s"} paid in full (${
        money(w.paid_in_full.amount)
      })${
        w.activity.status === "ok"
          ? `; ${w.activity.texts_sent} texts sent, ${w.activity.promises} promises to pay, ${w.activity.notes} notes`
          : ""
      }.`
      : "This week: the invoices paid could not be read just now.",
  );
  lines.push(
    r.bank.status === "ok"
      ? `Cash at bank: ${money(r.bank.total)} (${money(r.bank.total - r.bank.provisions)} less provisions).`
      : "Cash at bank: Xero could not be read for the balances just now.",
  );
  lines.push(
    !r.xero_check
      ? "Check against Xero: could not be read."
      : r.xero_check.status === "not_checked"
      ? "Check against Xero: not checked yet."
      : `Check against Xero: ${r.xero_check.words}.`,
  );
  return lines;
}

/** The email: a short plain summary in the body; the full report is the attached PDF. */
export function debtReportEmail(
  r: DebtReport,
  options: { greeting: string; sentBy: string },
): { subject: string; html: string; text: string } {
  const lines = debtReportSummaryLines(r);
  const text = [
    `Hi ${options.greeting},`,
    "",
    `Here's the debt and receivables position as at ${r.as_at}. The full report is attached as a PDF.`,
    "",
    ...lines.map((l) => `- ${l}`),
    "",
    `Sent from the Debt tab by ${options.sentBy}.`,
    "SecureWorks Group",
  ].join("\n");
  const html = [
    // The default signature is not added: this is an internal report, not a client email.
    "<!-- suppress-auto-appended-default-signature -->",
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1A272E">`,
    `<p>Hi ${esc(options.greeting)},</p>`,
    `<p>Here's the debt and receivables position as at ${esc(r.as_at)}. The full report is attached as a PDF.</p>`,
    `<ul style="padding-left:18px">${lines.map((l) => `<li style="margin-bottom:4px">${esc(l)}</li>`).join("")}</ul>`,
    `<p style="color:#4C6A7C;font-size:12px">Sent from the Debt tab by ${esc(options.sentBy)}. SecureWorks Group.</p>`,
    `</div>`,
  ].join("\n");
  return { subject: debtReportSubject(r), html, text };
}

/** The headline totals kept with each send (debt_ws_reports.totals). */
export function debtReportTotals(r: DebtReport): Record<string, unknown> {
  const rv = r.receivables;
  return {
    version: r.version,
    today: r.today,
    read_at: r.read_at,
    xero_open: r.xero_open,
    receivables: { count: rv.count, amount: rv.amount },
    debt: rv.debt,
    debt_overdue: rv.debt_overdue,
    bad_debt: rv.bad_debt,
    other: rv.other,
    other_overdue: rv.other_overdue,
    write_off: rv.write_off,
    needs_a_look: rv.needs_a_look,
    test: { count: rv.test.count, amount: rv.test.amount },
    xero_check: r.xero_check
      ? { status: r.xero_check.status, checked_at: r.xero_check.checked_at, differ_count: r.xero_check.differ_count }
      : null,
    bank_total: r.bank.status === "ok" ? r.bank.total : null,
    paid_in_full_week: r.week.paid_in_full.status === "ok"
      ? { count: r.week.paid_in_full.count, amount: r.week.paid_in_full.amount }
      : null,
    coming_due_7: { debt: r.coming_due.debt.amount, other: r.coming_due.other.amount },
    tie_ok: r.tie.ok,
  };
}

/** Today in Perth for a Date (re-exported for the actions). */
export const reportToday = (now: Date) => perthDate(now);
