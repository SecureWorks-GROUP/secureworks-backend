// Bank transactions (spend money, receive money, transfers) copied from Xero
// WITH their lines. Read only against Xero: one GET lane, no write to Xero.
//
// Why this file exists (15 Nov 2026): the earlier sync asked Xero for the list
// with no page number. Xero answers an unpaged list without LineItems, so every
// row in xero_bank_transactions had an empty line_items and no description, and
// card and bank spend could not be sorted by account, tracking or job. A paged
// read (page=N) carries the lines. Nothing else about a row changed meaning.
//
// Rules:
// - A row says only what Xero sent. line_items and description are written only
//   when Xero sent lines, so an answer without them never blanks what we hold.
// - Each stored line is Xero's own line plus the transaction's LineAmountTypes,
//   so a reader can tell an amount that includes GST from one that does not
//   (Inclusive: LineAmount less TaxAmount is the ex GST figure).
// - Runs every sync. Most runs ask only for what Xero changed since the last
//   complete read (If-Modified-Since); once a day the last 90 days are read
//   whole; the first run reads back to 1 July of the financial year so those
//   months get their lines. Cursors move only after a complete read.
// - If the paged read itself is refused, the old unpaged read runs instead, so
//   the copy is never staler than it was before this file. It says so.
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import {
  xeroCollection,
  xeroObject,
  type XeroRecord,
  xeroText,
} from "../_shared/xero_settlement_evidence.ts";
import { xeroDay } from "./supplier_credit_notes.ts";
import { incrementalModifiedSince } from "./sync_window.ts";

export const BANK_TXN_PAGE_SIZE = 100;
export const BANK_TXN_PAGE_LIMIT = 80;
export const BANK_TXN_WINDOW_DAYS = 90;
export const BANK_TXN_FULL_REREAD_MS = 24 * 60 * 60 * 1000;
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
  line_items?: XeroRecord[];
  description?: string | null;
};

/** SPEND, RECEIVE or TRANSFER, exactly as the copy has always grouped Xero's types. */
export function bankTransactionType(xeroType: unknown): BankTransactionRow["txn_type"] {
  if (xeroType === "RECEIVE" || xeroType === "RECEIVE-OVERPAYMENT" || xeroType === "RECEIVE-PREPAYMENT") {
    return "RECEIVE";
  }
  if (xeroType === "RECEIVE-TRANSFER" || xeroType === "SPEND-TRANSFER") return "TRANSFER";
  return "SPEND";
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * One row for our copy, or null when Xero sent no BankTransactionID. Every field
 * the copy already had keeps its meaning. line_items and description are present
 * only when Xero sent at least one line.
 */
export function bankTransactionRow(txn: XeroRecord, orgId: string, now: Date): BankTransactionRow | null {
  const id = xeroText(txn.BankTransactionID);
  if (!id) return null;
  const type = bankTransactionType(txn.Type);
  const account = xeroObject(txn.BankAccount);
  const contact = xeroObject(txn.Contact);
  const amount = num(txn.Total) || num(txn.SubTotal) || 0;
  const row: BankTransactionRow = {
    org_id: orgId,
    xero_txn_id: id,
    account_id: xeroText(account?.AccountID) ?? "",
    account_name: xeroText(account?.Name),
    txn_date: xeroDay(txn.DateString) ?? xeroDay(txn.Date) ?? now.toISOString().slice(0, 10),
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
  const lines = Array.isArray(txn.LineItems)
    ? txn.LineItems.map(xeroObject).filter((l): l is XeroRecord => l !== null)
    : [];
  if (lines.length > 0) {
    const amountTypes = xeroText(txn.LineAmountTypes);
    row.line_items = lines.map((l) => ({ ...l, LineAmountTypes: amountTypes }));
    row.description = lines.map((l) => xeroText(l.Description)).filter(Boolean).join("; ") || null;
  }
  return row;
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

export type BankTransactionSyncResult = {
  success: true;
  transactions_synced: number;
  skipped: number;
  first_error: string | null;
  /** backfill: back to 1 July. full: the last 90 days. incremental: changes only. unpaged_fallback: no lines. */
  mode: "backfill" | "full" | "incremental" | "unpaged_fallback";
  pages: number;
  with_lines: number;
  modified_since: string | null;
  fallback_reason?: string;
};

type Tally = { synced: number; skipped: number; withLines: number; firstError: string | null };

async function writeRows(sb: Client, rows: BankTransactionRow[], tally: Tally): Promise<void> {
  // Two shapes, written apart: one upsert sends one column list, and a row with
  // no lines must not carry a line_items column that would blank the stored one.
  const groups = [rows.filter((r) => r.line_items !== undefined), rows.filter((r) => r.line_items === undefined)];
  for (const group of groups) {
    if (group.length === 0) continue;
    const { error } = await sb.from("xero_bank_transactions").upsert(group, { onConflict: "org_id,xero_txn_id" });
    if (!error) {
      tally.synced += group.length;
      continue;
    }
    // One bad row must not lose the rest: write them one at a time and count it.
    for (const row of group) {
      const one = await sb.from("xero_bank_transactions").upsert(row, { onConflict: "org_id,xero_txn_id" });
      if (one.error) {
        tally.skipped++;
        tally.firstError ??= String(one.error.message ?? one.error);
      } else {
        tally.synced++;
      }
    }
  }
  tally.withLines += groups[0].length;
}

/** Xero may answer "nothing changed" to If-Modified-Since with 304; the transport throws it. */
function notModified(e: unknown): boolean {
  return (e as { status?: unknown } | null)?.status === 304;
}

export async function syncBankTransactionLines(
  sb: Client,
  orgId: string,
  tenantId: string,
  get: Get,
  now = () => new Date(),
): Promise<BankTransactionSyncResult> {
  const key = `bank_transactions:${orgId}:${tenantId}`;
  const fullKey = `bank_transactions_full:${orgId}:${tenantId}`;
  const { data: cursors, error: cursorError } = await sb.from("xero_sync_state")
    .select("key,cursor_at").in("key", [key, fullKey]);
  if (cursorError || !Array.isArray(cursors)) {
    throw new Error(`Bank transaction cursor read failed: ${cursorError?.message ?? "no rows"}`);
  }
  const cursorAt = (k: string) =>
    (cursors as { key: string; cursor_at: string | null }[]).find((c) => c.key === k)?.cursor_at;
  const startedAt = now();
  const started = startedAt.toISOString();
  const ninety = daysAgo(startedAt, BANK_TXN_WINDOW_DAYS);
  const fyEve = dayBeforeFinancialYear(startedAt);
  const wide = fyEve < ninety ? fyEve : ninety;

  const lastFull = Date.parse(cursorAt(fullKey) ?? "");
  const mode: "backfill" | "full" | "incremental" = !Number.isFinite(lastFull)
    ? "backfill"
    : startedAt.getTime() - lastFull >= BANK_TXN_FULL_REREAD_MS
    ? "full"
    : "incremental";
  const since = mode === "incremental" ? incrementalModifiedSince(cursorAt(key), startedAt.getTime()) : undefined;
  // An incremental run with no usable cursor has nothing to bound it: read the 90 days whole.
  const effective = mode === "incremental" && !since ? "full" : mode;
  const headers: Record<string, string> = since ? { "If-Modified-Since": since } : {};
  const where = bankTransactionsWhere(effective === "full" ? ninety : wide);

  const tally: Tally = { synced: 0, skipped: 0, withLines: 0, firstError: null };
  const seen = new Set<string>();
  let pages = 0;
  for (let page = 1;; page++) {
    if (page > BANK_TXN_PAGE_LIMIT) {
      throw new Error("Bank transaction traversal limit reached; cursor retained");
    }
    let rows: XeroRecord[];
    try {
      const data = await get("/BankTransactions", {
        where,
        order: "Date DESC",
        page: String(page),
        pageSize: String(BANK_TXN_PAGE_SIZE),
      }, headers);
      rows = xeroCollection(data, "BankTransactions");
    } catch (e) {
      if (e instanceof XeroCooldownError) throw e;
      if (notModified(e)) {
        rows = [];
      } else if (page === 1) {
        return await unpagedFallback(sb, orgId, get, startedAt, ninety, (e as Error).message);
      } else {
        throw e;
      }
    }
    pages++;
    const built: BankTransactionRow[] = [];
    for (const raw of rows) {
      const row = bankTransactionRow(raw, orgId, startedAt);
      // Newest first, so a transaction entered mid-read pushes one onto the next
      // page: the same id twice is expected and written once.
      if (!row || seen.has(row.xero_txn_id)) continue;
      seen.add(row.xero_txn_id);
      built.push(row);
    }
    await writeRows(sb, built, tally);
    if (rows.length < BANK_TXN_PAGE_SIZE) break;
  }

  // A complete read. Rows that would not write are counted and reported; the
  // daily whole read tries them again, so they do not hold the cursor.
  const updatedAt = now().toISOString();
  const note = `Bank transactions ${tally.synced}; with lines ${tally.withLines}; skipped ${tally.skipped}; ${effective}`;
  const { error } = await sb.from("xero_sync_state").upsert([
    { key, cursor_at: started, updated_at: updatedAt, note },
    ...(effective === "incremental" ? [] : [{ key: fullKey, cursor_at: started, updated_at: updatedAt, note }]),
  ], { onConflict: "key" });
  if (error) throw new Error(`Bank transaction cursor write failed: ${error.message}`);
  return {
    success: true,
    transactions_synced: tally.synced,
    skipped: tally.skipped,
    first_error: tally.firstError,
    mode: effective,
    pages,
    with_lines: tally.withLines,
    modified_since: since ?? null,
  };
}

/** The read this file replaced: the last 90 days in one unpaged call, which carries no lines. */
async function unpagedFallback(
  sb: Client,
  orgId: string,
  get: Get,
  startedAt: Date,
  ninety: string,
  reason: string,
): Promise<BankTransactionSyncResult> {
  const data = await get("/BankTransactions", { where: bankTransactionsWhere(ninety), order: "Date DESC" }, {});
  const tally: Tally = { synced: 0, skipped: 0, withLines: 0, firstError: null };
  const seen = new Set<string>();
  const built: BankTransactionRow[] = [];
  for (const raw of xeroCollection(data, "BankTransactions")) {
    const row = bankTransactionRow(raw, orgId, startedAt);
    if (!row || seen.has(row.xero_txn_id)) continue;
    seen.add(row.xero_txn_id);
    built.push(row);
  }
  for (let i = 0; i < built.length; i += BANK_TXN_PAGE_SIZE) {
    await writeRows(sb, built.slice(i, i + BANK_TXN_PAGE_SIZE), tally);
  }
  return {
    success: true,
    transactions_synced: tally.synced,
    skipped: tally.skipped,
    first_error: tally.firstError,
    mode: "unpaged_fallback",
    pages: 1,
    with_lines: tally.withLines,
    modified_since: null,
    fallback_reason: reason,
  };
}
