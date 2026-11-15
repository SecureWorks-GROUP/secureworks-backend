// Bank transactions (spend money, receive money, transfers) copied from Xero,
// and now their LINES. Read only against Xero: GET only, no write to Xero.
//
// Why (15 Nov 2026): the sync asks Xero for the list with no page number. Xero
// answers an unpaged list without LineItems, so card and bank spend could not
// be sorted by account, tracking or job. A paged read (page=N) carries them.
//
// Two stores, on purpose:
//   xero_bank_transactions       one row per transaction, exactly the fields it
//                                always had. Written by the same unpaged read
//                                on every run, so it is as fresh as it ever was.
//                                That table is readable well beyond the service
//                                role, so no line text is ever written to it.
//   xero_bank_transaction_lines  the lines as Xero sent them, service role only
//                                (20261115110000). Written only from an answer
//                                that carried lines.
//
// Two kinds of run:
//   every sync      the unpaged read as before, then one paged read of what
//                   Xero changed since the last complete read (If-Modified-Since).
//   the daily job   the same, then a WHOLE paged read: the last 90 days, or on
//   (whole: true)   the first run back to 1 July of the financial year. A whole
//                   read is checked: every transaction the unpaged list named
//                   must have arrived with lines. One the pages missed (Xero's
//                   order is by date, and many share a date) is fetched by its
//                   id. The whole-read cursor moves only when none is left.
//
// A failure of the lines read never fails the transaction copy: it is reported
// in the result (lines.ok false) and tried again next run. A rate limit always
// stops the run.
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import {
  xeroCollection,
  xeroInstant,
  xeroObject,
  type XeroRecord,
  xeroText,
} from "../_shared/xero_settlement_evidence.ts";
import { xeroDay } from "./supplier_credit_notes.ts";
import { incrementalModifiedSince } from "./sync_window.ts";

export const BANK_TXN_PAGE_SIZE = 100;
export const BANK_TXN_PAGE_LIMIT = 80;
export const BANK_TXN_WINDOW_DAYS = 90;
export const BANK_TXN_HEAL_LIMIT = 25;
const WRITE_CHUNK = 100;
const PERTH_OFFSET_MS = 8 * 60 * 60 * 1000;

export type BankTransactionRow = {
  org_id: string;
  xero_txn_id: string;
  account_id: string;
  account_name: string | null;
  txn_date: string;
  txn_type: "SPEND" | "RECEIVE" | "TRANSFER";
  contact_name: string | null;
  contact_id: string | null;
  reference: string | null;
  amount: number;
  sub_total: number | null;
  total_tax: number | null;
  status: string | null;
  is_reconciled: boolean;
  synced_at: string;
};

export type BankTransactionLinesRow = {
  org_id: string;
  xero_txn_id: string;
  line_amount_types: string | null;
  line_items: XeroRecord[];
  xero_updated_at: string | null;
  synced_at: string;
};

/** SPEND, RECEIVE or TRANSFER, exactly as the copy has always grouped Xero's types. */
export function bankTransactionType(xeroType: unknown): BankTransactionRow["txn_type"] {
  if (xeroType === "RECEIVE" || xeroType === "RECEIVE-OVERPAYMENT" || xeroType === "RECEIVE-PREPAYMENT") {
    return "RECEIVE";
  }
  if (xeroType === "RECEIVE-TRANSFER" || xeroType === "SPEND-TRANSFER") return "TRANSFER";
  return "SPEND";
}

// Xero sends numbers; a numeric string is read as the earlier code read it.
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/**
 * The transaction row, or null when Xero sent no BankTransactionID. Every field
 * keeps the meaning it had; contact_id is Xero's own id. No line text.
 */
export function bankTransactionRow(txn: XeroRecord, orgId: string, now: Date): BankTransactionRow | null {
  const id = xeroText(txn.BankTransactionID);
  if (!id) return null;
  const type = bankTransactionType(txn.Type);
  const account = xeroObject(txn.BankAccount);
  const contact = xeroObject(txn.Contact);
  const amount = num(txn.Total) || num(txn.SubTotal) || 0;
  const rawDate = typeof txn.Date === "string" && /^\d{4}-\d{2}-\d{2}T/.test(txn.Date) ? txn.Date.slice(0, 10) : null;
  return {
    org_id: orgId,
    xero_txn_id: id,
    account_id: xeroText(account?.AccountID) ?? "",
    account_name: xeroText(account?.Name),
    txn_date: xeroDay(txn.DateString) ?? xeroDay(txn.Date) ?? rawDate ?? now.toISOString().slice(0, 10),
    txn_type: type,
    contact_name: xeroText(contact?.Name),
    contact_id: xeroText(contact?.ContactID),
    reference: xeroText(txn.Reference),
    amount: type === "SPEND" ? -Math.abs(amount) : Math.abs(amount),
    sub_total: num(txn.SubTotal) || null,
    total_tax: num(txn.TotalTax) || null,
    status: xeroText(txn.Status),
    is_reconciled: typeof txn.IsReconciled === "boolean" ? txn.IsReconciled : true,
    synced_at: now.toISOString(),
  };
}

/** The lines row, or null when Xero sent no id or no line. Lines are stored as sent. */
export function bankTransactionLinesRow(txn: XeroRecord, orgId: string, now: Date): BankTransactionLinesRow | null {
  const id = xeroText(txn.BankTransactionID);
  if (!id || !Array.isArray(txn.LineItems)) return null;
  const lines = txn.LineItems.map(xeroObject).filter((l): l is XeroRecord => l !== null);
  if (lines.length === 0) return null;
  return {
    org_id: orgId,
    xero_txn_id: id,
    line_amount_types: xeroText(txn.LineAmountTypes),
    line_items: lines,
    xero_updated_at: xeroInstant(txn.UpdatedDateUTC),
    synced_at: now.toISOString(),
  };
}

/** The day before 1 July of the financial year `now` falls in, in Perth. */
export function dayBeforeFinancialYear(now: Date): string {
  const perth = new Date(now.getTime() + PERTH_OFFSET_MS);
  const year = perth.getUTCMonth() >= 6 ? perth.getUTCFullYear() : perth.getUTCFullYear() - 1;
  return `${year}-06-30`;
}

/** `days` before now, as a UTC day: the window start the copy has always used. */
export function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
}

/** Reconciled transactions dated after `day` (YYYY-MM-DD). */
export function bankTransactionsWhere(day: string): string {
  return `Date>DateTime(${day.replace(/-/g, ",")})&&IsReconciled==true`;
}

type Get = (
  path: string,
  params: Record<string, string>,
  headers: Record<string, string>,
) => Promise<unknown>;

// deno-lint-ignore no-explicit-any
type Client = { from: (t: string) => any };

export type BankLinesOutcome =
  | { ok: true; mode: "incremental" | "whole" | "first_whole"; pages: number; written: number; modified_since: string | null; healed: number }
  | { ok: false; mode: "incremental" | "whole" | "first_whole"; reason: string; pages: number; written: number; missed?: number }
  | { ok: null; mode: "waiting"; reason: "awaiting_first_whole_read" };

export type BankTransactionSyncResult = {
  success: true;
  transactions_synced: number;
  skipped: number;
  first_error: string | null;
  lines: BankLinesOutcome;
};

type Tally = { synced: number; skipped: number; firstError: string | null };

async function upsertAll(
  sb: Client,
  table: string,
  rows: Record<string, unknown>[],
  tally: Tally,
): Promise<void> {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    const { error } = await sb.from(table).upsert(chunk, { onConflict: "org_id,xero_txn_id" });
    if (!error) {
      tally.synced += chunk.length;
      continue;
    }
    // One bad row must not lose the rest: write them one at a time and count it.
    for (const row of chunk) {
      const one = await sb.from(table).upsert(row, { onConflict: "org_id,xero_txn_id" });
      if (one.error) {
        tally.skipped++;
        tally.firstError ??= String(one.error.message ?? one.error);
      } else {
        tally.synced++;
      }
    }
  }
}

/** Unique by transaction id, first one kept. */
function unique<T extends { xero_txn_id: string }>(rows: (T | null)[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (!r || seen.has(r.xero_txn_id)) continue;
    seen.add(r.xero_txn_id);
    out.push(r);
  }
  return out;
}

/** Xero may answer "nothing changed" to If-Modified-Since with 304; the transport throws it. */
function notModified(e: unknown): boolean {
  return (e as { status?: unknown } | null)?.status === 304;
}

type PagedRead = { ids: Set<string>; pages: number; written: number; skipped: number; firstError: string | null };

/** One paged traversal, written page by page. Throws on anything but a clean end. */
async function readPages(
  sb: Client,
  orgId: string,
  get: Get,
  where: string,
  headers: Record<string, string>,
  at: Date,
): Promise<PagedRead> {
  const ids = new Set<string>();
  const head: Tally = { synced: 0, skipped: 0, firstError: null };
  const lines: Tally = { synced: 0, skipped: 0, firstError: null };
  let pages = 0;
  for (let page = 1;; page++) {
    if (page > BANK_TXN_PAGE_LIMIT) throw new Error("Bank transaction traversal limit reached; cursor retained");
    let rows: XeroRecord[];
    try {
      rows = xeroCollection(
        await get("/BankTransactions", {
          where,
          order: "Date DESC",
          page: String(page),
          pageSize: String(BANK_TXN_PAGE_SIZE),
        }, headers),
        "BankTransactions",
      );
    } catch (e) {
      if (!notModified(e)) throw e;
      rows = [];
    }
    if (rows.length > BANK_TXN_PAGE_SIZE) throw new Error("Xero BankTransactions exceeded page size");
    pages++;
    const fresh = rows.filter((r) => {
      const id = xeroText(r.BankTransactionID);
      if (!id || ids.has(id)) return false;
      ids.add(id);
      return true;
    });
    await upsertAll(sb, "xero_bank_transactions", unique(fresh.map((r) => bankTransactionRow(r, orgId, at))), head);
    await upsertAll(
      sb,
      "xero_bank_transaction_lines",
      unique(fresh.map((r) => bankTransactionLinesRow(r, orgId, at))),
      lines,
    );
    if (rows.length < BANK_TXN_PAGE_SIZE) break;
  }
  return {
    ids,
    pages,
    written: lines.synced,
    skipped: head.skipped + lines.skipped,
    firstError: head.firstError ?? lines.firstError,
  };
}

export async function syncBankTransactionLines(
  sb: Client,
  orgId: string,
  tenantId: string,
  get: Get,
  opts: { whole: boolean },
  now = () => new Date(),
): Promise<BankTransactionSyncResult> {
  const startedAt = now();
  const started = startedAt.toISOString();
  const ninety = daysAgo(startedAt, BANK_TXN_WINDOW_DAYS);
  const fyEve = dayBeforeFinancialYear(startedAt);
  const wide = fyEve < ninety ? fyEve : ninety;

  // 1. The transaction copy, by the read it has always used.
  const listed = xeroCollection(
    await get("/BankTransactions", { where: bankTransactionsWhere(ninety), order: "Date DESC" }, {}),
    "BankTransactions",
  );
  const head: Tally = { synced: 0, skipped: 0, firstError: null };
  const headRows = unique(listed.map((r) => bankTransactionRow(r, orgId, startedAt)));
  await upsertAll(sb, "xero_bank_transactions", headRows, head);
  const result = (lines: BankLinesOutcome): BankTransactionSyncResult => ({
    success: true,
    transactions_synced: head.synced,
    skipped: head.skipped,
    first_error: head.firstError,
    lines,
  });

  // 2. The lines.
  const key = `bank_transactions:${orgId}:${tenantId}`;
  const fullKey = `bank_transactions_full:${orgId}:${tenantId}`;
  let mode: "incremental" | "whole" | "first_whole" = "incremental";
  let pages = 0;
  let written = 0;
  try {
    const { data: cursors, error: cursorError } = await sb.from("xero_sync_state")
      .select("key,cursor_at").in("key", [key, fullKey]);
    if (cursorError || !Array.isArray(cursors)) {
      throw new Error(`cursor read failed: ${cursorError?.message ?? "no rows"}`);
    }
    const cursorAt = (k: string) =>
      (cursors as { key: string; cursor_at: string | null }[]).find((c) => c.key === k)?.cursor_at;
    const hasFull = Number.isFinite(Date.parse(cursorAt(fullKey) ?? ""));
    const since = incrementalModifiedSince(cursorAt(key), startedAt.getTime());
    const stamp = (keys: string[], note: string) =>
      sb.from("xero_sync_state").upsert(
        keys.map((k) => ({ key: k, cursor_at: started, updated_at: now().toISOString(), note })),
        { onConflict: "key" },
      );

    // What changed since the last complete read, over the wide window.
    let healed = 0;
    if (since) {
      const read = await readPages(sb, orgId, get, bankTransactionsWhere(wide), { "If-Modified-Since": since }, startedAt);
      pages += read.pages;
      written += read.written;
      const { error } = await stamp([key], `Bank transaction lines ${read.written}; incremental`);
      if (error) throw new Error(`cursor write failed: ${error.message}`);
    }
    if (!opts.whole) {
      if (!since) return result({ ok: null, mode: "waiting", reason: "awaiting_first_whole_read" });
      return result({ ok: true, mode, pages, written, modified_since: since, healed });
    }

    // The whole read, checked against the unpaged list of the same window.
    mode = hasFull ? "whole" : "first_whole";
    const from = hasFull ? ninety : wide;
    const expected = new Set<string>(headRows.map((r) => r.xero_txn_id));
    if (from !== ninety) {
      const wideList = xeroCollection(
        await get("/BankTransactions", { where: bankTransactionsWhere(from), order: "Date DESC" }, {}),
        "BankTransactions",
      );
      for (const r of wideList) {
        const id = xeroText(r.BankTransactionID);
        if (id) expected.add(id);
      }
    }
    const read = await readPages(sb, orgId, get, bankTransactionsWhere(from), {}, startedAt);
    pages += read.pages;
    written += read.written;
    const missed = [...expected].filter((id) => !read.ids.has(id));
    // A transaction the pages skipped is fetched by its own id, a bounded number a run.
    let left = missed.length;
    for (const id of missed.slice(0, BANK_TXN_HEAL_LIMIT)) {
      const one = xeroCollection(await get(`/BankTransactions/${id}`, {}, {}), "BankTransactions");
      const tally: Tally = { synced: 0, skipped: 0, firstError: null };
      await upsertAll(sb, "xero_bank_transactions", unique(one.map((r) => bankTransactionRow(r, orgId, startedAt))), tally);
      await upsertAll(
        sb,
        "xero_bank_transaction_lines",
        unique(one.map((r) => bankTransactionLinesRow(r, orgId, startedAt))),
        tally,
      );
      if (tally.skipped === 0 && one.some((r) => xeroText(r.BankTransactionID) === id)) {
        healed++;
        left--;
        written++;
      }
    }
    if (left > 0 || read.skipped > 0) {
      return result({
        ok: false,
        mode,
        reason: left > 0
          ? `${left} transactions in the list did not arrive with lines; whole-read cursor retained`
          : `${read.skipped} rows would not write (${read.firstError}); whole-read cursor retained`,
        pages,
        written,
        missed: left,
      });
    }
    // The first whole read also starts the incremental chain; later ones leave it alone.
    const { error } = await stamp(since ? [fullKey] : [key, fullKey], `Bank transaction lines ${read.written}; ${mode}; healed ${healed}`);
    if (error) throw new Error(`cursor write failed: ${error.message}`);
    return result({ ok: true, mode, pages, written, modified_since: since ?? null, healed });
  } catch (e) {
    if (e instanceof XeroCooldownError) throw e;
    return result({ ok: false, mode, reason: (e as Error).message, pages, written });
  }
}
