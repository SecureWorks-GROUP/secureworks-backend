// Debt Workshop: the debt report (Shaun approved 15 Oct 2026; docs/debt-workshop/README.md,
// "The debt report"). The Debt tab's "Debt report" button opens this report as its own
// view, and the owner can download it as a PDF or email it to Marnin.
//
// This file is the report itself, worked out with no database, no Xero and no email: it
// takes the Debt tab's own book (debt_ws_book.ts loadBook) plus a few extra reads that
// debt_ws_actions.ts makes (the raw open invoices, this week's statements, payments
// received, the Xero bank balances and the bank feed), and returns:
//   - buildDebtReport: every figure, as plain data (the screen and the PDF both read it);
//   - debtReportHtml: the report as one HTML page (the view, and the copy kept on a send);
//   - debtReportEmail: the short email that carries the PDF.
// The PDF is drawn from the same data by debt_ws_report_pdf.ts.
//
// The rules are the tab's own: every open invoice gets the category the tab gives it, so the
// report always matches the tab. Every open Xero invoice lands in exactly one bucket, and the
// buckets add up to the total owed in our Xero copy to the cent (the "tie" below). Contacts
// on the not-chased list (Emergency Trade Services, Builderwest) are left out of the debt
// total, as the tab's chart leaves them out, and listed under "not counted as debt" instead.
// "Total owed to us" (totalOwedFrom) is every open invoice, broken down from the same
// buckets; whether our copy matches Xero itself comes from the hourly check
// (debt_ws_xero_check.ts), shown under it.
//
// Plain words only: no long dashes and no emoji anywhere in what this file writes.

import {
  addDays,
  type BankTransaction,
  type Category,
  daysBetween,
  escapeHtml,
  inScope,
  longDate,
  looksLikeCompany,
  money,
  parseReference,
  perthDate,
  perthDateOf,
  type PossiblePayment,
  possiblePayments,
  sameName,
  STEP_LABELS,
  type WsInvoice,
  type WsJob,
} from "./debt_ws_rules.ts";
import {
  type Book,
  type BookEntry,
  categoryTotals,
  companiesOf,
  type StatementStatus,
} from "./debt_ws_book.ts";
import type { WsPayment, WsStatementRow } from "./debt_ws_store.ts";
import type { XeroCheckView } from "./debt_ws_xero_check.ts";

export const DEBT_REPORT_VERSION = "debt-report/v1";
/** The day the Debt tab went live: chase history in the tab starts here. */
export const DEBT_TAB_LIVE_DATE = "2026-10-08";

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
  /** This week's company statements (sent or claimed), for the companies table. */
  statements: WsStatementRow[];
  /** Customer payments applied in Xero over the last 30 days; null when unreadable. */
  payments: WsPayment[] | null;
  /** The jobs of the paid invoices, for the fencing and patio split. */
  paymentJobs: Map<string, WsJob>;
  /** Xero bank balances read live; null when Xero could not be read. */
  bank: { accounts: BankAccountBalance[]; read_at: string } | null;
  /** The bank feed; null when it could not be read. */
  feed: ReportBankFeed | null;
  /** When our Xero copy of invoices was last synced. */
  syncedAt: string | null;
  /** Who the report was prepared for or by: "Shaun", or "the Wednesday 12pm auto-send". */
  preparedBy: string;
  /** The newest check of our Xero copy against Xero (debt_ws_xero_check.ts); null: unread. */
  xeroCheck?: XeroCheckView | null;
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
    name: "Not chased",
    sub: "On the tab's not-chased list",
    debt: false,
    title: "Not chased (not counted as debt)",
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
  { key: "not_chased", name: "Not chased", sub: "On the not-chased list", always: true },
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

/** A short explanation printed under some invoice sections. */
const SECTION_NOTES: Partial<Record<BucketKey, string>> = {
  bad_debt:
    "Days are days since the tab's day 0: finals from the invoice date (or the day the job left rectification), progress payments from 7 days after the invoice date, companies from 10 days after it.",
  not_due: "Days below zero are days until due.",
  go_ahead:
    "The first stage payment on a job: work starts when it is paid, so the tab never chases it. Days are days since the invoice date.",
  needs_a_look: "Days are days past Xero's own due date.",
  not_chased:
    "Contacts on the tab's not-chased list. They are never texted or put on a statement, and the tab's chart leaves them out. Days are days past the tab's due date.",
};

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
  /** Xero's printed due date (used only for the aging table). */
  xero_due: string | null;
  /** The tab's due date (null for invoices the tab does not place as debt). */
  due: string | null;
  amount: number;
  days: number;
  next: string;
  chase: string;
  on_jan_list: boolean;
}

export interface Money {
  count: number;
  amount: number;
}

export interface ReceivedWindow {
  from: string;
  to: string;
  count: number;
  amount: number;
  fencing_patio: number;
  other: number;
  deposits: number;
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
  received: {
    status: "ok" | "unavailable";
    d7: ReceivedWindow;
    d30: ReceivedWindow;
  };
  expected: { d7: Money; d30: Money };
  xero_open: Money;
  /** Total owed to us: every open invoice, broken down so the lines add up to it. */
  total_owed: TotalOwed;
  /** Whether our Xero copy matched Xero at the last hourly check; null when unread. */
  xero_check: XeroCheckView | null;
  buckets: Record<BucketKey, Money>;
  debt: Money & { share_of_open: number };
  not_chased_names: string[];
  by_type: Array<{ key: string; debt: number; not_due: number }>;
  by_lane: Array<{ key: string; debt: number; not_due: number }>;
  aging: Array<{ key: string; amount: number }>;
  top_debtors: Array<{
    name: string;
    lane: "homeowner" | "account";
    worst: string;
    count: number;
    oldest: number;
    amount: number;
  }>;
  top_total: number;
  companies: Array<{
    name: string;
    contacts: string[];
    past: Money & { oldest: number };
    grace: Money & { next_due: string | null };
    total: number;
    statement: StatementStatus | "not_chased";
    statement_words: string;
  }>;
  sections: Array<{
    key: BucketKey;
    title: string;
    note: string | null;
    total: number;
    rows: ReportRow[];
  }>;
  tie: {
    sum: number;
    xero: number;
    ok: boolean;
    /** The tab's own category totals equal the debt buckets here, invoice for invoice. */
    tab_match: boolean;
    unplaced: string[];
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
  key_points: string[];
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
  if (e.notChased) return "On the not-chased list: never chased or put on a statement";
  if (e.category === "says_paid") {
    return `Says paid since ${shortDate(row.says_paid_since)}: check Xero and the bank before chasing`;
  }
  if (e.category === "rectification") return "Held while the job is in rectification";
  if (e.kind === "account") {
    return e.category
      ? "Past due: goes on the weekly company statement"
      : `Due ${shortDate(e.dueDate)} (company terms, 10 days)`;
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

function groupSum(rows: ReportRow[], key: (r: ReportRow) => string) {
  const out = new Map<string, Money>();
  for (const r of rows) {
    const k = key(r);
    const g = out.get(k) ?? { count: 0, amount: 0 };
    g.count += 1;
    g.amount = (c(g.amount) + c(r.amount)) / 100;
    out.set(k, g);
  }
  return out;
}
const zero = (): Money => ({ count: 0, amount: 0 });
const get = (m: Map<string, Money>, k: string) => m.get(k) ?? zero();

const STATEMENT_WORDS: Record<StatementStatus | "not_chased", string> = {
  sent: "Sent this week",
  ready: "Not sent yet this week",
  no_email: "No accounts email set",
  nothing_due: "Nothing past due",
  not_chased: "Not chased",
};

// ── Building the report ──

/**
 * Every open invoice in exactly one bucket, by the Debt tab's own book. The report, the
 * Debt tab's "Total owed to us" (totalOwedFrom) and the tie to the total all read this one
 * placement, so they can never disagree.
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
    };
    if (!inScope(inv)) {
      rows.push({
        ...base,
        bucket: "excluded",
        payer: tidy(inv.contact_name) || "Unknown payer",
        lane: null,
        days: xeroDaysOver(inv.due_date),
        next: "Test reference (SAMPLE-): the tab ignores it",
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
      rows.push({
        ...base,
        bucket,
        payer,
        lane: e.cls.lane,
        company_key: e.companyKey,
        stage: e.kind === "progress" ? e.cls.stage ?? "progress" : null,
        due: e.dueDate,
        days: e.day,
        next: nextWords(e),
        chase: lastChase(e),
        on_jan_list: !!row.on_jan_list && !e.notChased,
      });
      continue;
    }
    if (goAhead.has(id)) {
      rows.push({
        ...base,
        bucket: "go_ahead",
        payer: tidy(inv.contact_name) || tidy(job?.client_name) || "Unknown payer",
        lane: "homeowner",
        days: inv.invoice_date ? daysBetween(inv.invoice_date, today) : 0,
        next: "Go-ahead payment: the job starts when it is paid, so it is not debt",
      });
      continue;
    }
    const look = lookBy.get(id);
    if (look) {
      rows.push({
        ...base,
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
      bucket: "unplaced",
      payer: tidy(inv.contact_name) || "Unknown payer",
      lane: null,
      days: xeroDaysOver(inv.due_date),
      next: "Not placed by any rule: check by hand",
    });
  }
  return rows;
}

export function buildDebtReport(input: DebtReportInput): DebtReport {
  const { book } = input;
  const today = book.today;
  const year = today.slice(0, 4);

  // Every open invoice gets exactly one bucket.
  const rows = placeOpenInvoices(book, input.openInvoices);

  const by = (b: BucketKey) => rows.filter((r) => r.bucket === b);
  const buckets = Object.fromEntries(
    REPORT_BUCKETS.map((b) => [b.key, { count: by(b.key).length, amount: sum(by(b.key)) }]),
  ) as Record<BucketKey, Money>;
  const xeroOpen = {
    count: input.openInvoices.length,
    amount: sum(input.openInvoices.map((i) => ({ amount: Number(i.amount_due || 0) }))),
  };
  const reconSum = REPORT_BUCKETS.reduce((s, b) => s + c(buckets[b.key].amount), 0) / 100;
  const debtRows = rows.filter((r) => DEBT_BUCKETS.includes(r.bucket));
  const debt = { count: debtRows.length, amount: sum(debtRows) };

  // The tab's own category totals (not-chased left out, as the tab's chart does) must
  // equal the debt buckets here.
  const tabTotals = categoryTotals(
    book.entries.filter((e) => e.open && !e.notChased),
  );
  const tabMatch = DEBT_BUCKETS.every((k) =>
    c(tabTotals[k as Category].amount) === c(buckets[k].amount) &&
    tabTotals[k as Category].count === buckets[k].count
  );
  const unplaced = by("unplaced").map((r) => r.invoice_number ?? r.xero_invoice_id);
  const tie = {
    sum: reconSum,
    xero: xeroOpen.amount,
    ok: c(reconSum) === c(xeroOpen.amount) && rows.length === xeroOpen.count &&
      unplaced.length === 0,
    tab_match: tabMatch,
    unplaced,
  };

  // Not-chased names: the settings list, without the contact ids.
  const notChasedNames = book.settings.not_chased_contacts.filter((x) =>
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)
  );

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

  // Money received: customer payments applied in Xero, by payment date.
  const window = (days: number): ReceivedWindow => {
    const from = addDays(today, -(days - 1));
    const ps = (input.payments ?? []).filter((p) =>
      p.paid_on >= from && p.paid_on <= today &&
      !String(p.reference ?? "").toUpperCase().includes("SAMPLE-")
    );
    const isHome = (p: WsPayment) => {
      const t = String(
        (p.job_id ? input.paymentJobs.get(String(p.job_id))?.type : null) ?? "",
      ).toLowerCase();
      return t === "fencing" || t === "patio";
    };
    const isDeposit = (p: WsPayment) =>
      /^(DEP\d{0,3}|PLAN)$/.test(parseReference(p.reference).ending ?? "");
    const amt = (xs: WsPayment[]) => sum(xs.map((p) => ({ amount: p.amount })));
    return {
      from,
      to: today,
      count: ps.length,
      amount: amt(ps),
      fencing_patio: amt(ps.filter(isHome)),
      other: amt(ps.filter((p) => !isHome(p))),
      deposits: amt(ps.filter(isDeposit)),
    };
  };
  const received = {
    status: input.payments ? "ok" as const : "unavailable" as const,
    d7: window(7),
    d30: window(30),
  };

  // Coming due: not-due invoices by the tab's due dates.
  const upcoming = (n: number) => {
    const xs = by("not_due").filter((r) => r.due && daysBetween(today, r.due) <= n);
    return { count: xs.length, amount: sum(xs) };
  };

  // Groupings.
  const typeKeys = ["Fencing", "Patio", "Insurance and other"];
  const byTypeDebt = groupSum(debtRows, (r) => r.type_group);
  const byTypeNotDue = groupSum(by("not_due"), (r) => r.type_group);
  const laneKey = (r: ReportRow) => r.lane === "account" ? "Companies" : "Homeowners";
  const byLaneDebt = groupSum(debtRows, laneKey);
  const byLaneNotDue = groupSum(by("not_due"), laneKey);
  const AGING = ["Current", "1 to 30", "31 to 60", "61 to 90", "Over 90"];
  const aging = groupSum(rows, (r) => {
    const d = r.xero_due ? daysBetween(String(r.xero_due).slice(0, 10), today) : 0;
    return d <= 0 ? "Current" : d <= 30 ? "1 to 30" : d <= 60 ? "31 to 60" : d <= 90 ? "61 to 90" : "Over 90";
  });

  // Companies, after the tab's aliases (one builder on several Xero contacts is one company).
  const views = companiesOf(book, input.statements);
  const viewBy = new Map(views.map((v) => [v.company_key, v]));
  const accountRows = rows.filter((r) => r.lane === "account" && r.company_key);
  const nameFor = (key: string, rs: ReportRow[]) =>
    viewBy.get(key)?.name ??
      (book.entries.find((e) =>
        e.companyKey === key && String(e.inv.xero_contact_id ?? "").toLowerCase() === key
      )?.inv.contact_name ?? rs[0]?.contact ?? "Unknown company");
  const companies = [...new Set(accountRows.map((r) => r.company_key!))].map((key) => {
    const rs = accountRows.filter((r) => r.company_key === key);
    const past = rs.filter((r) => r.days >= 1);
    const grace = rs.filter((r) => r.days < 1);
    const notChased = rs.every((r) => r.bucket === "not_chased");
    const status: StatementStatus | "not_chased" = notChased
      ? "not_chased"
      : viewBy.get(key)?.statement.status ?? "nothing_due";
    return {
      name: tidy(nameFor(key, rs)),
      contacts: [...new Set(rs.map((r) => tidy(r.contact)).filter(Boolean))],
      past: {
        count: past.length,
        amount: sum(past),
        oldest: past.reduce((m, r) => Math.max(m, r.days), 0),
      },
      grace: {
        count: grace.length,
        amount: sum(grace),
        next_due: grace.map((r) => r.due).filter((d): d is string => !!d).sort()[0] ?? null,
      },
      total: sum(rs),
      statement: status,
      statement_words: STATEMENT_WORDS[status],
    };
  }).sort((a, b) => b.total - a.total);

  // Top 10 debtors (debt only): the company after aliases, or the homeowner payer.
  const debtorKey = (r: ReportRow) =>
    r.lane === "account" && r.company_key ? `co:${r.company_key}` : `p:${r.payer}`;
  const debtorGroups = new Map<string, ReportRow[]>();
  for (const r of debtRows) {
    debtorGroups.set(debtorKey(r), [...(debtorGroups.get(debtorKey(r)) ?? []), r]);
  }
  const bucketName = (k: BucketKey) => REPORT_BUCKETS.find((b) => b.key === k)?.name ?? k;
  const debtors = [...debtorGroups.entries()].map(([k, rs]) => ({
    name: k.startsWith("co:") ? tidy(nameFor(k.slice(3), rs)) : rs[0].payer,
    lane: (k.startsWith("co:") ? "account" : "homeowner") as "homeowner" | "account",
    worst: bucketName(DEBT_BUCKETS.find((b) => rs.some((r) => r.bucket === b))!),
    count: rs.length,
    oldest: rs.reduce((m, r) => Math.max(m, r.days), 0),
    amount: sum(rs),
  })).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  const top = debtors.slice(0, 10);
  const topTotal = sum(top);

  // Every invoice, by bucket, worst first; within a bucket the oldest, then the biggest.
  const sections = REPORT_BUCKETS.filter((b) => by(b.key).length).map((b) => ({
    key: b.key,
    title: b.title,
    note: SECTION_NOTES[b.key] ?? null,
    total: buckets[b.key].amount,
    rows: [...by(b.key)].sort((x, y) =>
      y.days - x.days || y.amount - x.amount ||
      String(x.invoice_number).localeCompare(String(y.invoice_number))
    ),
  }));

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
    received,
    expected: { d7: upcoming(7), d30: upcoming(30) },
    xero_open: xeroOpen,
    total_owed: totalOwedFrom(rows, notChasedNames),
    xero_check: input.xeroCheck ?? null,
    buckets,
    debt: { ...debt, share_of_open: xeroOpen.amount ? debt.amount / xeroOpen.amount : 0 },
    not_chased_names: notChasedNames,
    by_type: typeKeys.map((k) => ({ key: k, debt: get(byTypeDebt, k).amount, not_due: get(byTypeNotDue, k).amount })),
    by_lane: ["Homeowners", "Companies"].map((k) => ({ key: k, debt: get(byLaneDebt, k).amount, not_due: get(byLaneNotDue, k).amount })),
    aging: AGING.map((k) => ({ key: k, amount: get(aging, k).amount })),
    top_debtors: top,
    top_total: topTotal,
    companies,
    sections,
    tie,
    bank_feed: bankFeed,
    key_points: [],
    notes: [],
  };
  report.key_points = keyPoints(report, rows);
  report.notes = notes(report);
  return report;
}

function keyPoints(r: DebtReport, rows: ReportRow[]): string[] {
  const out: string[] = [];
  const top = r.top_debtors[0];
  if (top) {
    out.push(
      `Biggest exposure: ${top.name}, ${money(top.amount)} past due across ${top.count} invoice${
        top.count === 1 ? "" : "s"
      } (${pct(top.amount, r.debt.amount)} of all debt), oldest ${top.oldest} days.`,
    );
  } else {
    out.push("Nothing is past due by the Debt tab's rules.");
  }
  const bad = r.buckets.bad_debt;
  if (bad.count) {
    const jan = rows.filter((x) => x.bucket === "bad_debt" && x.on_jan_list).length;
    out.push(
      `Bad debt (day 21 or more): ${money(bad.amount)} across ${bad.count} invoice${bad.count === 1 ? "" : "s"}${
        jan ? `, ${jan} of them on Jan's visit list` : ""
      }.`,
    );
  }
  const held = c(r.buckets.says_paid.amount) + c(r.buckets.rectification.amount);
  if (held) {
    out.push(
      `Held and not chased right now: Says paid ${money(r.buckets.says_paid.amount)}, Rectification ${
        money(r.buckets.rectification.amount)
      }.`,
    );
  }
  if (r.buckets.needs_a_look.count) {
    out.push(
      `Needs a look: ${money(r.buckets.needs_a_look.amount)} across ${r.buckets.needs_a_look.count} invoice${
        r.buckets.needs_a_look.count === 1 ? "" : "s"
      } the rules could not place. Each one needs placing by hand (the reason is in the invoice list).`,
    );
  }
  if (r.bank_feed.matches.length) {
    const n = new Set(r.bank_feed.matches.map((m) => m.invoice_number)).size;
    out.push(
      `${n} open invoice${n === 1 ? "" : "s"} may already be paid: an unmatched receipt in the bank feed matches the amount. Match ${
        n === 1 ? "it" : "them"
      } in Xero.`,
    );
  }
  if (r.xero_check && r.xero_check.status === "differs") {
    out.push(
      `${r.xero_check.words}. Every figure here comes from our Xero copy, so it is out by those invoices until the next sync heals them.`,
    );
  }
  if (r.buckets.not_chased.count) {
    out.push(
      `Not chased: ${money(r.buckets.not_chased.amount)} owed by contacts on the not-chased list${
        r.not_chased_names.length ? ` (${r.not_chased_names.join(", ")})` : ""
      }. Not counted as debt and never chased.`,
    );
  }
  return out;
}

function notes(r: DebtReport): string[] {
  const out: string[] = [];
  const synced = r.synced_at
    ? `last synced at ${perthClock(r.synced_at)} on ${shortDate(perthDateOf(r.synced_at))} (it syncs about every 15 minutes)`
    : "sync time unknown";
  out.push(
    `Sources. Invoices: our Xero copy (receivables that are AUTHORISED with an amount due above zero), ${synced}. Jobs, job status and chase history: the Debt tab's own records. Bank balances: Xero's Bank Summary, ${
      r.bank.status === "ok" ? `read live at ${perthClock(r.bank.read_at)}` : "which could not be read from Xero for this report"
    }.`,
  );
  out.push(
    "Same rules as the Debt tab. Every category comes from the tab's own code, read fresh when this report was made, so every figure matches the tab. Like the tab's chart, the debt total leaves out contacts on the not-chased list; they are listed under not counted as debt so the total still ties to Xero.",
  );
  const parts = REPORT_BUCKETS.filter((b) => !b.debt && r.buckets[b.key].count)
    .map((b) => `${b.name.toLowerCase()} ${money(r.buckets[b.key].amount)}`);
  out.push(
    r.tie.ok
      ? `Cross-check. Debt ${money(r.debt.amount)}${parts.length ? ` + ${parts.join(" + ")}` : ""} = ${
        money(r.tie.sum)
      }, equal to the total owed to us in our Xero copy, ${money(r.tie.xero)} (${r.xero_open.count} invoices), to the cent. Every invoice was placed.`
      : `Cross-check FAILED. The buckets add up to ${money(r.tie.sum)} but the total owed to us in our Xero copy is ${money(r.tie.xero)}${
        r.tie.unplaced.length ? `; not placed: ${r.tie.unplaced.join(", ")}` : ""
      }. Check before relying on these figures.`,
  );
  if (!r.tie.tab_match) {
    out.push(
      "Warning: the Debt tab's own category totals did not equal this report's. Check the tab before relying on these figures.",
    );
  }
  out.push(xeroCheckNote(r.xero_check));
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
    r.received.status === "ok"
      ? `Money received is customer payments applied to invoices in Xero, by payment date (last 7 days: ${
        shortDate(r.received.d7.from)
      } to ${shortDate(r.received.d7.to)}; last 30 days: ${shortDate(r.received.d30.from)} to ${
        shortDate(r.received.d30.to)
      }). It includes deposits and planning fees, which are not debt collection.`
      : "Money received could not be read for this report.",
  );
  out.push(
    "Due dates are the Debt tab's: a final is due on its invoice date, a progress payment 7 days later, a company invoice 10 days later. Xero's printed due dates are used only for the aging table.",
  );
  out.push(
    `Chase history. The Debt tab went live on ${longDate(DEBT_TAB_LIVE_DATE)} ${DEBT_TAB_LIVE_DATE.slice(0, 4)}, so the Last chase column shows only what was logged in the tab since then.`,
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

export function debtReportHtml(r: DebtReport): string {
  const DOT: Partial<Record<BucketKey, string>> = {
    bad_debt: "bad",
    escalating: "esc",
    active: "act",
    rectification: "hold",
    says_paid: "hold",
  };
  const bar = REPORT_BUCKETS.filter((b) => b.debt && r.buckets[b.key].amount > 0 && r.debt.amount > 0)
    .map((b) =>
      `<span class="${DOT[b.key]}" style="width:${(r.buckets[b.key].amount / r.debt.amount * 100).toFixed(2)}%"></span>`
    ).join("");
  const bankRows = r.bank.status === "ok"
    ? BANK_GROUPS.filter((g) => r.bank.accounts.some((a) => a.group === g)).map((g) =>
      `<tr class="grp"><td colspan="2">${esc(g)}</td></tr>` +
      r.bank.accounts.filter((a) => a.group === g).map((a) => `<tr><td class="ind">${esc(a.name)}</td>${R(a.closing)}</tr>`).join("")
    ).join("") +
      `<tr class="tot"><td>Total cash at bank</td>${R(r.bank.total)}</tr>` +
      `<tr><td class="mut">Total less provisions</td>${R(r.bank.total - r.bank.provisions)}</tr>`
    : `<tr><td class="warn" colspan="2">Xero could not be read for the bank balances just now. Open the report again to retry.</td></tr>`;
  const rec = r.received;
  const receivedRows = rec.status === "ok"
    ? `<tr><th></th><th class="n">Last 7 days</th><th class="n">Last 30 days</th></tr>
        <tr><td>Total received</td>${R(rec.d7.amount)}${R(rec.d30.amount)}</tr>
        <tr><td class="ind">Fencing and patio jobs</td>${R(rec.d7.fencing_patio)}${R(rec.d30.fencing_patio)}</tr>
        <tr><td class="ind">Insurance and other</td>${R(rec.d7.other)}${R(rec.d30.other)}</tr>
        <tr><td class="ind mut">of which deposits and planning fees</td>${R(rec.d7.deposits)}${R(rec.d30.deposits)}</tr>
        <tr><td class="mut">Payments</td><td class="n">${rec.d7.count}</td><td class="n">${rec.d30.count}</td></tr>`
    : `<tr><td class="warn">The payments received could not be read just now.</td></tr>`;
  const catRows = REPORT_BUCKETS.filter((b) => b.debt).map((b) =>
    `<tr><td><i class="dot ${DOT[b.key]}"></i>${esc(b.name)} <span class="mut">${esc(b.sub)}</span></td><td class="n">${
      r.buckets[b.key].count
    }</td>${R(r.buckets[b.key].amount)}</tr>`
  ).join("");
  const notCounted = REPORT_BUCKETS.filter((b) => !b.debt && (r.buckets[b.key].count || ["not_due", "go_ahead", "needs_a_look", "not_chased"].includes(b.key)))
    .map((b) => {
      const sub = b.key === "not_chased" && r.not_chased_names.length ? r.not_chased_names.join(", ") : b.sub;
      return `<tr><td>${esc(b.name)} <span class="mut">${esc(sub)}</span></td><td class="n">${r.buckets[b.key].count}</td>${
        R(r.buckets[b.key].amount)
      }</tr>`;
    }).join("");
  const tieLine = r.tie.ok
    ? `<tr><td class="ok" colspan="3">Check: ${esc(money(r.tie.sum))} equals the total owed in our Xero copy, ${esc(money(r.tie.xero))}, to the cent. Every invoice was placed.</td></tr>`
    : `<tr><td class="warn" colspan="3">Check failed: the buckets add up to ${esc(money(r.tie.sum))} but the total owed in our Xero copy is ${
      esc(money(r.tie.xero))
    }.${r.tie.unplaced.length ? ` Not placed: ${esc(r.tie.unplaced.join(", "))}.` : ""}</td></tr>`;

  const summary = `
<section class="page first">
  <header class="band">
    <div class="brand">SECUREWORKS GROUP</div>
    <div class="ttl"><h1>Debt position</h1><p>As at ${esc(r.as_at)}</p></div>
  </header>
  <p class="fresh">Invoices from our Xero copy${
    r.synced_at ? `, last synced at ${esc(perthClock(r.synced_at))} Perth time` : ""
  }. ${
    r.bank.status === "ok" ? `Bank balances read live from Xero at ${esc(perthClock(r.bank.read_at))}. ` : ""
  }Debt worked out with the Debt tab's own rules, so every number here matches the tab.</p>
  <div class="kpis">
    <div class="kpi"><div class="l">Cash at bank (all accounts)</div><div class="v">${
    r.bank.status === "ok" ? esc(money(r.bank.total)) : "Not read"
  }</div><div class="s">${r.bank.status === "ok" ? `${esc(money(r.bank.operations))} in Operations` : "Xero could not be read"}</div></div>
    <div class="kpi"><div class="l">Received, last 7 days</div><div class="v">${
    rec.status === "ok" ? esc(money(rec.d7.amount)) : "Not read"
  }</div><div class="s">${rec.status === "ok" ? `${rec.d7.count} payments; last 30 days ${esc(money(rec.d30.amount))}` : ""}</div></div>
    <div class="kpi"><div class="l">Total owed to us</div><div class="v">${esc(money(r.total_owed.amount))}</div><div class="s">${r.total_owed.count} invoices${
    r.xero_check && r.xero_check.status !== "not_checked" ? `; ${esc(r.xero_check.status === "matches" ? "matches Xero" : "does not match Xero")}` : ""
  }</div></div>
    <div class="kpi hot"><div class="l">Debt (past due, tab rules)</div><div class="v">${esc(money(r.debt.amount))}</div><div class="s">${r.debt.count} invoices, ${
    esc(pct(r.debt.amount, r.xero_open.amount) || "0%")
  } of open</div></div>
  </div>
  <div class="cols">
    <div class="col">
      <h3>Where the cash is (Xero, ${esc(shortDate(r.today))})</h3>
      <table class="t">${bankRows}</table>
      <h3>Money in (customer payments applied in Xero)</h3>
      <table class="t">${receivedRows}</table>
      <h3>Debt expected (not yet due, by the tab's due dates)</h3>
      <table class="t">
        <tr><td>Due in the next 7 days</td><td class="n">${r.expected.d7.count}</td>${R(r.expected.d7.amount)}</tr>
        <tr><td>Due in the next 30 days</td><td class="n">${r.expected.d30.count}</td>${R(r.expected.d30.amount)}</tr>
      </table>
    </div>
    <div class="col">
      <h3>Every open Xero invoice, by the Debt tab's rules</h3>
      <div class="bar">${bar}</div>
      <table class="t">
        <tr><th>Category</th><th class="n">No.</th><th class="n">Amount</th></tr>
        ${catRows}
        <tr class="sub"><td>Total debt</td><td class="n">${r.debt.count}</td>${R(r.debt.amount)}</tr>
        <tr class="grp"><td colspan="3">Not counted as debt</td></tr>
        ${notCounted}
        <tr class="tot"><td>Adds up to total owed to us</td><td class="n">${r.xero_open.count}</td>${R(r.tie.sum)}</tr>
        ${tieLine}
        <tr><td class="${r.xero_check?.status === "matches" ? "ok" : "warn"}" colspan="3">${esc(xeroCheckNote(r.xero_check))}</td></tr>
      </table>
      <div class="cols2">
        <div>
          <h3>Debt by job type</h3>
          <table class="t"><tr><th></th><th class="n">Debt</th><th class="n">Not due</th></tr>
          ${r.by_type.map((t) => `<tr><td>${esc(t.key)}</td>${R(t.debt)}${R(t.not_due)}</tr>`).join("")}</table>
        </div>
        <div>
          <h3>Who owes it</h3>
          <table class="t"><tr><th></th><th class="n">Debt</th><th class="n">Not due</th></tr>
          ${r.by_lane.map((t) => `<tr><td>${esc(t.key)}</td>${R(t.debt)}${R(t.not_due)}</tr>`).join("")}</table>
        </div>
      </div>
      <h3>Aging of all open invoices <span class="mut">(Xero due dates)</span></h3>
      <table class="t"><tr>${r.aging.map((a) => `<th class="n">${esc(a.key)}</th>`).join("")}</tr>
      <tr>${r.aging.map((a) => R(a.amount)).join("")}</tr></table>
    </div>
  </div>
  <h3>Top 10 debtors <span class="mut">(past due only)</span></h3>
  <table class="t top">
    <tr><th>#</th><th>Who</th><th>Type</th><th>Worst category</th><th class="n">Invoices</th><th class="n">Oldest (days)</th><th class="n">Amount</th></tr>
    ${
    r.top_debtors.length
      ? r.top_debtors.map((d, i) =>
        `<tr><td>${i + 1}</td><td>${esc(d.name)}</td><td>${d.lane === "account" ? "Company" : "Homeowner"}</td><td>${
          esc(d.worst)
        }</td><td class="n">${d.count}</td><td class="n">${d.oldest}</td>${R(d.amount)}</tr>`
      ).join("") +
        `<tr class="sub"><td></td><td colspan="5">Top 10 share of total debt: ${esc(pct(r.top_total, r.debt.amount))}</td>${R(r.top_total)}</tr>`
      : `<tr><td colspan="7" class="mut">Nothing is past due.</td></tr>`
  }
  </table>
</section>`;

  const coSection = `
<section class="page">
  <h2>Companies (insurance and builders)</h2>
  <p class="lead">Grouped after the Debt tab's company aliases (one builder can sit on several Xero contacts). Company invoices are due 10 days after the invoice date; past due goes on the weekly statement.</p>
  <table class="t list">
    <tr><th>Company</th><th>Xero contacts</th><th class="n">Past due</th><th class="n">No.</th><th class="n">Oldest (days)</th><th class="n">Not yet due</th><th class="n">No.</th><th>Next due</th><th class="n">Total open</th><th>This week's statement</th></tr>
    ${
    r.companies.length
      ? r.companies.map((x) =>
        `<tr><td><b>${esc(x.name)}</b></td><td class="sm">${esc(x.contacts.join("; "))}</td>${R(x.past.amount)}<td class="n">${x.past.count}</td><td class="n">${
          x.past.count ? x.past.oldest : ""
        }</td>${R(x.grace.amount)}<td class="n">${x.grace.count}</td><td>${esc(shortDate(x.grace.next_due))}</td>${R(x.total)}<td class="sm">${
          esc(x.statement_words)
        }</td></tr>`
      ).join("")
      : `<tr><td colspan="10" class="mut">No open company invoices.</td></tr>`
  }
  </table>
  <p class="note">Company invoices with no job card and no company word in the name sit under Needs a look instead (see the invoice list).</p>
</section>`;

  const listTable = (rs: ReportRow[]) => `
  <table class="t list fx">
    <colgroup><col style="width:21%"><col style="width:10%"><col style="width:9%"><col style="width:7.5%"><col style="width:7.5%"><col style="width:8.5%"><col style="width:4.5%"><col style="width:18.5%"><col style="width:13.5%"></colgroup>
    <tr><th>Payer</th><th>Job</th><th>Type</th><th>Invoice</th><th>Inv. date</th><th class="n">Amount due</th><th class="n">Days</th><th>Status and next step</th><th>Last chase</th></tr>
    ${
    rs.map((x) =>
      `<tr><td>${esc(x.payer)}</td><td>${esc(x.job_number ?? "")}</td><td>${esc(x.job_type)}${
        x.stage ? ` <span class="mut">(${esc(x.stage)})</span>` : ""
      }</td><td>${esc(x.invoice_number ?? "")}</td><td>${esc(shortDate(x.invoice_date))}</td>${R(x.amount)}<td class="n">${x.days}</td><td class="sm">${
        esc(x.next)
      }</td><td class="sm">${esc(x.chase)}</td></tr>`
    ).join("")
  }
    <tr class="tot"><td colspan="5">${rs.length} invoice${rs.length === 1 ? "" : "s"}</td>${R(sum(rs))}<td colspan="3"></td></tr>
  </table>`;
  const listSection = `
<section class="page">
  <h2>Every open invoice</h2>
  <p class="lead">Grouped by the Debt tab's categories, worst first, then the open invoices that are not counted as debt, so the sections add up to Xero's ${
    esc(money(r.xero_open.amount))
  }.</p>
  ${
    r.sections.map((s) =>
      `<div class="sec"><h3 class="sh">${esc(s.title)} <span class="amt">${esc(money(s.total))}</span></h3>${
        s.note ? `<p class="note">${esc(s.note)}</p>` : ""
      }${listTable(s.rows)}</div>`
    ).join("")
  }
</section>`;

  const notesSection = `
<section class="notes">
  <h2>Key points</h2>
  <ul>${r.key_points.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>
  <h2>Notes</h2>
  <ul>${r.notes.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>
  <p class="foot">Prepared from the Debt tab for ${esc(r.prepared_by)}, SecureWorks Group, ${esc(r.as_at)}. Read only: nothing was changed while preparing this report.</p>
</section>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Debt position ${esc(r.today)}</title>
<style>${REPORT_CSS}</style></head><body>
${summary}
${coSection}
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
.kpis { display:grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 8px; margin-bottom: 10px; }
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
  return `Debt position ${r.today}.pdf`;
}

export function debtReportSubject(r: DebtReport): string {
  return `Debt position: ${longDate(r.today)} ${r.today.slice(0, 4)}`;
}

/** The headline lines, used for the email body and kept as the send's summary. */
export function debtReportSummaryLines(r: DebtReport): string[] {
  const lines: string[] = [];
  lines.push(
    r.bank.status === "ok"
      ? `Cash at bank: ${money(r.bank.total)} (${money(r.bank.operations)} in Operations, ${money(r.bank.provisions)} set aside in provisions).`
      : "Cash at bank: Xero could not be read for the balances just now.",
  );
  lines.push(
    r.received.status === "ok"
      ? `Received: ${money(r.received.d7.amount)} in the last 7 days, ${money(r.received.d30.amount)} in the last 30 days.`
      : "Received: the payments could not be read just now.",
  );
  lines.push(
    `Debt (past due, by the Debt tab's rules): ${money(r.debt.amount)} across ${r.debt.count} invoices. ${
      REPORT_BUCKETS.filter((b) => b.debt).map((b) => `${b.name} ${money(r.buckets[b.key].amount)}`).join(", ")
    }.`,
  );
  lines.push(
    `Debt expected: ${money(r.expected.d7.amount)} falls due in the next 7 days, ${money(r.expected.d30.amount)} in the next 30 days.`,
  );
  if (r.top_debtors[0]) {
    lines.push(
      `Biggest debtor: ${r.top_debtors[0].name}, ${money(r.top_debtors[0].amount)} past due.`,
    );
  }
  lines.push(
    r.tie.ok
      ? `Total owed to us: ${money(r.total_owed.amount)} across ${r.total_owed.count} invoices. The report ties to it to the cent.`
      : `Total owed to us: ${money(r.total_owed.amount)}. The cross-check did NOT tie: see the notes in the report.`,
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
    `Here's the debt position as at ${r.as_at}. The full report is attached as a PDF.`,
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
    `<p>Here's the debt position as at ${esc(r.as_at)}. The full report is attached as a PDF.</p>`,
    `<ul style="padding-left:18px">${lines.map((l) => `<li style="margin-bottom:4px">${esc(l)}</li>`).join("")}</ul>`,
    `<p style="color:#4C6A7C;font-size:12px">Sent from the Debt tab by ${esc(options.sentBy)}. SecureWorks Group.</p>`,
    `</div>`,
  ].join("\n");
  return { subject: debtReportSubject(r), html, text };
}

/** The headline totals kept with each send (debt_ws_reports.totals). */
export function debtReportTotals(r: DebtReport): Record<string, unknown> {
  return {
    today: r.today,
    read_at: r.read_at,
    xero_open: r.xero_open,
    total_owed: { count: r.total_owed.count, amount: r.total_owed.amount },
    xero_check: r.xero_check
      ? { status: r.xero_check.status, checked_at: r.xero_check.checked_at, differ_count: r.xero_check.differ_count }
      : null,
    debt: { count: r.debt.count, amount: r.debt.amount },
    buckets: r.buckets,
    bank_total: r.bank.status === "ok" ? r.bank.total : null,
    received_7: r.received.status === "ok" ? r.received.d7.amount : null,
    received_30: r.received.status === "ok" ? r.received.d30.amount : null,
    expected_7: r.expected.d7.amount,
    expected_30: r.expected.d30.amount,
    tie_ok: r.tie.ok,
  };
}

/** Today in Perth for a Date (re-exported for the actions). */
export const reportToday = (now: Date) => perthDate(now);
