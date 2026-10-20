// The mirror check: does our Xero copy (xero_invoices) say we are owed the same as Xero?
//
// Why it exists (20 Oct 2026). Five invoices that are still open in Xero (INV-0034,
// INV-0177, INV-0352, INV-0704, INV-0938, $3,352.48) sat in our copy as DELETED with
// nothing owing. Until 10 Sep 2026 (#797) the hourly stale-invoice check in xero-sync
// marked an invoice DELETED with amount_due 0 whenever its read from Xero failed for ANY
// reason (a rate limit, a timeout, a Xero outage), not only a real "not found". Xero never
// changed those invoices again, so the incremental sync (by modified date) never
// re-read them, and the stale check only looks at rows our copy still calls open. Every
// screen that reads the copy (the Financial tab, the Debt tab, the debt report) was short.
//
// What this does, at most once an hour (inside sync_invoices) or on demand
// (?action=check_invoice_mirror):
//   1. Reads Xero's own list of open sales invoices (ACCREC, AUTHORISED, amount due above
//      zero) and Xero's list of drafts (DRAFT ACCREC, for the "drafts not sent" line).
//   2. Reads our copy's open invoices and compares the two, invoice for invoice.
//   3. Heals the copy where Xero says money is owed and our copy disagrees (missing, or a
//      different amount): each one is re-read from Xero BY ITS OWN ID and written through
//      reconcileXeroInvoice, the same identity-checked write the hourly check uses. Only
//      Xero's answer is ever copied. Nothing is ever written to Xero.
//   4. Records the result in xero_mirror_checks (both totals, both counts, and the
//      invoices that still differ), which the Debt tab and the debt report read.
//
// What it never does:
//   - It never marks an invoice deleted, voided or paid on its own say-so. An invoice our
//     copy counts as owed that Xero's list does not include is only REPORTED here; the
//     existing hourly stale check re-reads it by id and copies whatever Xero says.
//   - It never sets an amount due to zero, so it can never fire the "invoice.paid"
//     trigger (fn_payment_detected) that stops chasing and thanks the client.
//   - It never inserts an invoice our copy has never seen; that is reported for a person.

import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import {
  isolatedReconcileFailure,
  reconcileXeroInvoice,
} from "./xero_invoice_reconciliation.ts";

/** xero_sync_state key: when the last complete mirror check ran. */
export const MIRROR_CHECK_KEY = "invoice_mirror_check_last_run_at";
/** sync_invoices runs every 15 minutes; the check runs at most once an hour. */
export const MIRROR_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Invoices re-read and healed per check at most (one Xero call each). */
export const MIRROR_HEAL_LIMIT = 25;
/** Xero list pages read per status at most (100 a page: 2,000 invoices). */
export const MIRROR_LIST_MAX_PAGES = 20;
/** Check rows older than this are removed after each check. */
export const MIRROR_CHECK_KEEP_DAYS = 60;
const XERO_PAGE_SIZE = 100;
const PAGE = 1000;
const IN_CHUNK = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One invoice from Xero's list. */
export interface ListedInvoice {
  xero_invoice_id: string;
  invoice_number: string | null;
  contact_name: string | null;
  amount_due: number;
}

/** One row of our copy. */
export interface MirrorRow {
  xero_invoice_id: string;
  invoice_number: string | null;
  contact_name: string | null;
  status: string | null;
  amount_due: number;
}

export type DifferenceReason =
  // Xero says it is owed; our copy does not count it (any other status, or no row at all).
  | "missing_from_copy"
  // Our copy counts it as owed; Xero's open list does not include it.
  | "not_owed_in_xero"
  // Both count it as owed, with different amounts.
  | "amount_differs";

export interface MirrorDifference {
  xero_invoice_id: string;
  invoice_number: string | null;
  contact_name: string | null;
  reason: DifferenceReason;
  /** What Xero says is owed; null when Xero's open list does not include it. */
  xero_amount_due: number | null;
  /** What our copy says is owed; null when our copy does not count it as owed. */
  copy_amount_due: number | null;
  /** Our copy's status for it; null when our copy has no row for it at all. */
  copy_status: string | null;
}

export interface MirrorHealed {
  xero_invoice_id: string;
  invoice_number: string | null;
  before: { status: string | null; amount_due: number | null };
  after: { status: string | null; amount_due: number | null };
}

/** The row written to xero_mirror_checks (20261020150000_xero_mirror_checks.sql). */
export interface MirrorCheckRecord {
  org_id: string;
  checked_at: string;
  complete: boolean;
  matches: boolean | null;
  xero_count: number | null;
  xero_total: number | null;
  copy_count: number | null;
  copy_total: number | null;
  differ_count: number;
  differences: MirrorDifference[];
  healed: MirrorHealed[];
  heal_failed: Array<
    { xero_invoice_id: string; invoice_number: string | null; error: string }
  >;
  drafts_count: number | null;
  drafts_total: number | null;
  error: string | null;
}

export interface MirrorCheckDeps {
  /** One page of Xero's invoice list for one status (GET /Invoices, ACCREC only). */
  listPage: (status: "AUTHORISED" | "DRAFT", page: number) => Promise<unknown>;
  /** One invoice from Xero by its id (GET /Invoices/{id}). */
  readInvoice: (invoiceId: string) => Promise<unknown>;
}

export interface MirrorCheckSummary {
  ran: boolean;
  reason?: string;
  complete?: boolean;
  matches?: boolean | null;
  xero?: { count: number | null; total: number | null };
  copy?: { count: number | null; total: number | null };
  differ_count?: number;
  healed?: number;
  heal_failed?: number;
  error?: string | null;
}

const cents = (n: number) => Math.round(n * 100);
const sumCents = (xs: number[]) =>
  xs.reduce((s, x) => s + cents(x), 0) / 100;
const idKey = (id: string) => id.trim().toLowerCase();

function incomplete(what: string): Error {
  return new Error(`Mirror check is incomplete: ${what}`);
}

/**
 * Every ACCREC invoice Xero lists with this status, page by page. Each record must name
 * itself (an InvoiceID), be a sales invoice with exactly the status asked for, and carry a
 * real amount due; anything else makes the whole list unverified, so nothing is healed
 * from it. A list longer than MIRROR_LIST_MAX_PAGES pages is unverified too.
 */
export async function listXeroInvoices(
  listPage: MirrorCheckDeps["listPage"],
  status: "AUTHORISED" | "DRAFT",
): Promise<ListedInvoice[]> {
  const out: ListedInvoice[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MIRROR_LIST_MAX_PAGES; page++) {
    const data = await listPage(status, page) as { Invoices?: unknown };
    const rows = data?.Invoices;
    if (!Array.isArray(rows)) {
      throw incomplete(`Xero's ${status} invoice list could not be read`);
    }
    for (const raw of rows) {
      const inv = raw as Record<string, unknown>;
      if (
        !inv || typeof inv.InvoiceID !== "string" || !UUID.test(inv.InvoiceID) ||
        inv.Type !== "ACCREC" || inv.Status !== status ||
        typeof inv.AmountDue !== "number" || !Number.isFinite(inv.AmountDue)
      ) {
        throw incomplete(`an invoice in Xero's ${status} list is unverified`);
      }
      // Pages can shift while they are read; an invoice seen twice counts once.
      const key = idKey(inv.InvoiceID);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        xero_invoice_id: inv.InvoiceID,
        invoice_number: typeof inv.InvoiceNumber === "string"
          ? inv.InvoiceNumber
          : null,
        contact_name: typeof (inv.Contact as Record<string, unknown>)?.Name ===
            "string"
          ? String((inv.Contact as Record<string, unknown>).Name)
          : null,
        amount_due: inv.AmountDue,
      });
    }
    if (rows.length < XERO_PAGE_SIZE) return out;
  }
  throw incomplete(
    `Xero's ${status} list ran past ${MIRROR_LIST_MAX_PAGES} pages`,
  );
}

/** Our copy's open sales invoices: ACCREC, AUTHORISED, amount due above zero. */
export async function readCopyOpen(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string,
): Promise<MirrorRow[]> {
  const out: MirrorRow[] = [];
  for (let offset = 0;; offset += PAGE) {
    const { data, error } = await client.from("xero_invoices")
      .select("xero_invoice_id, invoice_number, contact_name, status, amount_due")
      .eq("org_id", orgId).eq("invoice_type", "ACCREC")
      .eq("status", "AUTHORISED").gt("amount_due", 0)
      .order("xero_invoice_id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error || !Array.isArray(data)) {
      throw incomplete("our copy of open invoices could not be read");
    }
    out.push(...data.map(toMirrorRow));
    if (data.length < PAGE) return out;
  }
}

/** Our copy's rows for these invoice ids, whatever their status. */
async function readCopyByIds(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string,
  ids: string[],
): Promise<MirrorRow[]> {
  const out: MirrorRow[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await client.from("xero_invoices")
      .select("xero_invoice_id, invoice_number, contact_name, status, amount_due")
      .eq("org_id", orgId).eq("invoice_type", "ACCREC")
      .in("xero_invoice_id", ids.slice(i, i + IN_CHUNK));
    if (error || !Array.isArray(data)) {
      throw incomplete("our copy of the differing invoices could not be read");
    }
    out.push(...data.map(toMirrorRow));
  }
  return out;
}

function toMirrorRow(r: Record<string, unknown>): MirrorRow {
  return {
    xero_invoice_id: String(r.xero_invoice_id),
    invoice_number: r.invoice_number ? String(r.invoice_number) : null,
    contact_name: r.contact_name ? String(r.contact_name) : null,
    status: r.status ? String(r.status) : null,
    amount_due: Number(r.amount_due ?? 0),
  };
}

/**
 * Xero's open list against our copy's open rows, invoice for invoice. `others` holds our
 * copy's rows (any status) for invoices Xero lists that our copy does not count as owed,
 * so a difference can say what our copy holds instead. Sorted by invoice number.
 */
export function compareMirror(
  xeroOpen: ListedInvoice[],
  copyOpen: MirrorRow[],
  others: MirrorRow[] = [],
): MirrorDifference[] {
  const copyBy = new Map(copyOpen.map((r) => [idKey(r.xero_invoice_id), r]));
  const otherBy = new Map(others.map((r) => [idKey(r.xero_invoice_id), r]));
  const xeroBy = new Map(xeroOpen.map((x) => [idKey(x.xero_invoice_id), x]));
  const out: MirrorDifference[] = [];
  for (const x of xeroOpen.filter((x) => x.amount_due > 0)) {
    const mine = copyBy.get(idKey(x.xero_invoice_id));
    if (!mine) {
      const other = otherBy.get(idKey(x.xero_invoice_id));
      out.push({
        xero_invoice_id: other?.xero_invoice_id ?? x.xero_invoice_id,
        invoice_number: x.invoice_number ?? other?.invoice_number ?? null,
        contact_name: x.contact_name ?? other?.contact_name ?? null,
        reason: "missing_from_copy",
        xero_amount_due: x.amount_due,
        copy_amount_due: null,
        copy_status: other?.status ?? null,
      });
    } else if (cents(mine.amount_due) !== cents(x.amount_due)) {
      out.push({
        xero_invoice_id: mine.xero_invoice_id,
        invoice_number: x.invoice_number ?? mine.invoice_number,
        contact_name: x.contact_name ?? mine.contact_name,
        reason: "amount_differs",
        xero_amount_due: x.amount_due,
        copy_amount_due: mine.amount_due,
        copy_status: mine.status,
      });
    }
  }
  for (const mine of copyOpen) {
    const x = xeroBy.get(idKey(mine.xero_invoice_id));
    if (x && x.amount_due > 0) continue;
    out.push({
      xero_invoice_id: mine.xero_invoice_id,
      invoice_number: mine.invoice_number,
      contact_name: mine.contact_name,
      reason: "not_owed_in_xero",
      xero_amount_due: null,
      copy_amount_due: mine.amount_due,
      copy_status: mine.status,
    });
  }
  return out.sort((a, b) =>
    String(a.invoice_number ?? a.xero_invoice_id).localeCompare(
      String(b.invoice_number ?? b.xero_invoice_id),
    )
  );
}

/** A difference this check may heal: Xero says money is owed and our copy has the row. */
export function healable(d: MirrorDifference): boolean {
  return d.reason === "amount_differs" ||
    (d.reason === "missing_from_copy" && d.copy_status !== null);
}

/**
 * Whether a check is due: the last complete check is more than an hour old, or there has
 * never been one. A cursor that cannot be read skips the check rather than guessing.
 */
export async function mirrorCheckDue(
  // deno-lint-ignore no-explicit-any
  client: any,
  now: Date,
): Promise<{ due: boolean; skipped: string | null }> {
  const { data, error } = await client.from("xero_sync_state")
    .select("cursor_at").eq("key", MIRROR_CHECK_KEY).maybeSingle();
  if (error) return { due: false, skipped: "mirror check cursor is unreadable" };
  const last = data?.cursor_at;
  if (last === null || last === undefined) return { due: true, skipped: null };
  const at = Date.parse(String(last));
  if (!Number.isFinite(at)) {
    return { due: false, skipped: "mirror check cursor is unreadable" };
  }
  return { due: now.getTime() - at >= MIRROR_CHECK_INTERVAL_MS, skipped: null };
}

/**
 * Runs one mirror check and records it. `force` skips the once-an-hour gate (the manual
 * ?action=check_invoice_mirror). Never throws: a failure is recorded as an incomplete
 * check (complete = false, with the reason) and returned in the summary, so it can never
 * break the invoice sync around it.
 */
export async function runInvoiceMirrorCheck(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string,
  deps: MirrorCheckDeps,
  options: { now?: Date; force?: boolean } = {},
): Promise<MirrorCheckSummary> {
  const now = options.now ?? new Date();
  if (!options.force) {
    let gate: { due: boolean; skipped: string | null };
    try {
      gate = await mirrorCheckDue(client, now);
    } catch (_) {
      gate = { due: false, skipped: "mirror check cursor is unreadable" };
    }
    if (!gate.due) {
      return { ran: false, reason: gate.skipped ?? "not_due" };
    }
  }
  const record: MirrorCheckRecord = {
    org_id: orgId,
    checked_at: now.toISOString(),
    complete: false,
    matches: null,
    xero_count: null,
    xero_total: null,
    copy_count: null,
    copy_total: null,
    differ_count: 0,
    differences: [],
    healed: [],
    heal_failed: [],
    drafts_count: null,
    drafts_total: null,
    error: null,
  };
  try {
    const listed = await listXeroInvoices(deps.listPage, "AUTHORISED");
    const xeroOpen = listed.filter((x) => x.amount_due > 0);
    let copyOpen = await readCopyOpen(client, orgId);
    const copyIds = new Set(copyOpen.map((r) => idKey(r.xero_invoice_id)));
    const missingIds = xeroOpen.filter((x) =>
      !copyIds.has(idKey(x.xero_invoice_id))
    ).map((x) => x.xero_invoice_id);
    const others = missingIds.length
      ? await readCopyByIds(client, orgId, missingIds)
      : [];
    const before = compareMirror(xeroOpen, copyOpen, others);

    // Heal: re-read each one from Xero by id and copy Xero's answer.
    const toHeal = before.filter(healable).slice(0, MIRROR_HEAL_LIMIT);
    const healedIds: string[] = [];
    for (const d of toHeal) {
      try {
        await reconcileXeroInvoice(
          client,
          orgId,
          d.xero_invoice_id,
          () => deps.readInvoice(d.xero_invoice_id),
          now,
        );
        healedIds.push(d.xero_invoice_id);
      } catch (e) {
        record.heal_failed.push({
          xero_invoice_id: d.xero_invoice_id,
          invoice_number: d.invoice_number,
          error: String((e as Error)?.message ?? e).slice(0, 300),
        });
        // A cooldown or a failed save stops healing; one unverifiable invoice does not.
        if (e instanceof XeroCooldownError || !isolatedReconcileFailure(e)) {
          break;
        }
      }
    }

    // What is recorded is the copy AFTER healing.
    if (healedIds.length) {
      const otherBy = new Map(others.map((r) => [idKey(r.xero_invoice_id), r]));
      copyOpen = await readCopyOpen(client, orgId);
      const after = await readCopyByIds(client, orgId, healedIds);
      const afterBy = new Map(after.map((r) => [idKey(r.xero_invoice_id), r]));
      for (const id of healedIds) {
        const d = before.find((x) => x.xero_invoice_id === id)!;
        const afterRow = afterBy.get(idKey(id));
        record.healed.push({
          xero_invoice_id: id,
          invoice_number: d.invoice_number,
          before: {
            status: d.copy_status,
            amount_due: d.copy_amount_due ??
              otherBy.get(idKey(id))?.amount_due ?? null,
          },
          after: {
            status: afterRow?.status ?? null,
            amount_due: afterRow ? afterRow.amount_due : null,
          },
        });
      }
    }
    const stillIds = new Set(copyOpen.map((r) => idKey(r.xero_invoice_id)));
    const stillMissing = xeroOpen.filter((x) =>
      !stillIds.has(idKey(x.xero_invoice_id))
    ).map((x) => x.xero_invoice_id);
    const othersAfter = stillMissing.length
      ? await readCopyByIds(client, orgId, stillMissing)
      : [];
    const differences = compareMirror(xeroOpen, copyOpen, othersAfter);

    record.xero_count = xeroOpen.length;
    record.xero_total = sumCents(xeroOpen.map((x) => x.amount_due));
    record.copy_count = copyOpen.length;
    record.copy_total = sumCents(copyOpen.map((r) => r.amount_due));
    record.differences = differences;
    record.differ_count = differences.length;
    record.matches = differences.length === 0 &&
      record.xero_count === record.copy_count &&
      cents(record.xero_total) === cents(record.copy_total);
    record.complete = true;

    // Drafts are a separate line on the Debt tab and never part of the total, so a
    // failed draft read leaves them unknown without failing the check.
    try {
      const drafts = await listXeroInvoices(deps.listPage, "DRAFT");
      record.drafts_count = drafts.length;
      record.drafts_total = sumCents(drafts.map((x) => x.amount_due));
    } catch (e) {
      if (e instanceof XeroCooldownError) {
        record.error = "Xero drafts not read: Xero asked us to wait";
      } else {
        record.error = `Xero drafts not read: ${(e as Error).message}`.slice(
          0,
          300,
        );
      }
    }
  } catch (e) {
    record.complete = false;
    record.error = e instanceof XeroCooldownError
      ? "Xero asked us to wait (rate limit), so the check did not finish"
      : String((e as Error)?.message ?? e).slice(0, 300);
  }

  const saved = await saveMirrorCheck(client, record, now);
  return {
    ran: true,
    complete: record.complete,
    matches: record.matches,
    xero: { count: record.xero_count, total: record.xero_total },
    copy: { count: record.copy_count, total: record.copy_total },
    differ_count: record.differ_count,
    healed: record.healed.length,
    heal_failed: record.heal_failed.length,
    error: saved ? record.error : `${record.error ?? ""} (result not saved)`.trim(),
  };
}

/**
 * Writes the check row, then (for a complete check) moves the hourly cursor and removes
 * rows older than MIRROR_CHECK_KEEP_DAYS. An incomplete check leaves the cursor alone, so
 * the next sync (15 minutes) tries again. False when the row could not be written.
 */
async function saveMirrorCheck(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: MirrorCheckRecord,
  now: Date,
): Promise<boolean> {
  try {
    const { error } = await client.from("xero_mirror_checks").insert(record);
    if (error) {
      console.error("[xero-sync] mirror check not saved:", error.message);
      return false;
    }
    if (record.complete) {
      await client.from("xero_sync_state").upsert(
        {
          key: MIRROR_CHECK_KEY,
          cursor_at: now.toISOString(),
          note: record.matches
            ? `matches Xero: ${record.xero_count} invoices`
            : `${record.differ_count} invoice(s) differ from Xero`,
          updated_at: now.toISOString(),
        },
        { onConflict: "key" },
      );
      await client.from("xero_mirror_checks").delete()
        .eq("org_id", record.org_id)
        .lt(
          "checked_at",
          new Date(now.getTime() - MIRROR_CHECK_KEEP_DAYS * 86_400_000)
            .toISOString(),
        );
    }
    return true;
  } catch (e) {
    console.error("[xero-sync] mirror check not saved:", (e as Error).message);
    return false;
  }
}
