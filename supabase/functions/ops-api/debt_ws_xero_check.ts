// Debt Workshop: does our Xero copy match Xero? (Shaun approved 20 Oct 2026.)
//
// Every figure on the Debt tab and in the debt report comes from our Xero copy
// (xero_invoices). xero-sync compares that copy with Xero's own list of open sales
// invoices at most once an hour and records the result in xero_mirror_checks
// (supabase/functions/xero-sync/xero_mirror_check.ts). This file turns the newest result
// into the one plain line the tab and the report show under "Total owed to us":
//   "Matches Xero"
//   "Does not match Xero: 2 invoices differ (INV-0034, INV-0177)"
//   "Not checked against Xero yet"
// No database and no Xero in here; debt_ws_store.ts reads the rows.

import { money } from "./debt_ws_rules.ts";

/** One xero_mirror_checks row, as debt_ws_store.ts reads it. */
export interface MirrorCheckRow {
  checked_at: string;
  complete: boolean;
  matches: boolean | null;
  xero_count: number | null;
  xero_total: number | null;
  copy_count: number | null;
  copy_total: number | null;
  differ_count: number;
  differences: Array<{
    xero_invoice_id?: string;
    invoice_number?: string | null;
    contact_name?: string | null;
    reason?: string;
    xero_amount_due?: number | null;
    copy_amount_due?: number | null;
    copy_status?: string | null;
  }>;
  drafts_count: number | null;
  drafts_total: number | null;
  error: string | null;
}

export interface XeroCheckDifference {
  xero_invoice_id: string | null;
  invoice_number: string | null;
  contact_name: string | null;
  xero_amount_due: number | null;
  copy_amount_due: number | null;
  /** What differs, in plain words. */
  words: string;
}

export interface XeroCheckView {
  /** matches: the newest complete check agreed; differs: it did not; not_checked: none yet. */
  status: "matches" | "differs" | "not_checked";
  /** The line to show, in plain words. */
  words: string;
  checked_at: string | null;
  /** The newest complete check is more than XERO_CHECK_STALE_MS old. */
  stale: boolean;
  xero: { count: number; amount: number } | null;
  copy: { count: number; amount: number } | null;
  differ_count: number;
  differences: XeroCheckDifference[];
  /** Xero's DRAFT sales invoices: never in what is owed. Null when not read. */
  drafts: { count: number; amount: number } | null;
  /** The newest attempt failed after the newest complete check (why, and when). */
  last_failed: { at: string; error: string } | null;
}

/** The check runs hourly; three hours without a complete one is worth saying. */
export const XERO_CHECK_STALE_MS = 3 * 60 * 60 * 1000;
/** Invoice numbers named in the one-line words at most. */
const NAMED = 6;
/** Differences listed at most (the rest are counted). */
const LISTED = 50;

const num = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
};

function differenceWords(d: MirrorCheckRow["differences"][number]): string {
  const xero = d.xero_amount_due;
  const copy = d.copy_amount_due;
  if (d.reason === "missing_from_copy") {
    return d.copy_status
      ? `Xero says ${money(num(xero))} is owed; our copy says ${d.copy_status.toLowerCase()}`
      : `Xero says ${money(num(xero))} is owed; it is not in our copy at all`;
  }
  if (d.reason === "not_owed_in_xero") {
    return `Our copy says ${money(num(copy))} is owed; Xero does not list it as owed`;
  }
  return `Xero says ${money(num(xero))} is owed; our copy says ${money(num(copy))}`;
}

/**
 * The view of the newest check. `latest` is the newest attempt (complete or not) and
 * `latestComplete` the newest complete one; both null when no check has run yet.
 */
export function xeroCheckView(
  latest: MirrorCheckRow | null,
  latestComplete: MirrorCheckRow | null,
  now: Date,
): XeroCheckView {
  const failedSince = latest && !latest.complete &&
      (!latestComplete ||
        Date.parse(latest.checked_at) > Date.parse(latestComplete.checked_at))
    ? { at: latest.checked_at, error: latest.error ?? "The check did not finish" }
    : null;
  const c = latestComplete;
  if (!c) {
    return {
      status: "not_checked",
      words: "Not checked against Xero yet",
      checked_at: null,
      stale: false,
      xero: null,
      copy: null,
      differ_count: 0,
      differences: [],
      drafts: null,
      last_failed: failedSince,
    };
  }
  const differences = (Array.isArray(c.differences) ? c.differences : [])
    .slice(0, LISTED).map((d) => ({
      xero_invoice_id: d.xero_invoice_id ?? null,
      invoice_number: d.invoice_number ?? null,
      contact_name: d.contact_name ?? null,
      xero_amount_due: d.xero_amount_due ?? null,
      copy_amount_due: d.copy_amount_due ?? null,
      words: differenceWords(d),
    }));
  const count = Math.max(num(c.differ_count), differences.length);
  const matches = c.matches === true && count === 0;
  const numbers = differences.map((d) => d.invoice_number).filter(
    (n): n is string => !!n,
  );
  const named = numbers.slice(0, NAMED).join(", ") +
    (count > NAMED ? ` and ${count - NAMED} more` : "");
  const stale = now.getTime() - Date.parse(c.checked_at) > XERO_CHECK_STALE_MS;
  return {
    status: matches ? "matches" : "differs",
    words: matches
      ? "Matches Xero"
      : count
      ? `Does not match Xero: ${count} invoice${count === 1 ? "" : "s"} differ${
        count === 1 ? "s" : ""
      }${named ? ` (${named})` : ""}`
      : `Does not match Xero: Xero says ${money(num(c.xero_total))}, our copy ${
        money(num(c.copy_total))
      }`,
    checked_at: c.checked_at,
    stale,
    xero: { count: num(c.xero_count), amount: num(c.xero_total) },
    copy: { count: num(c.copy_count), amount: num(c.copy_total) },
    differ_count: count,
    differences,
    drafts: c.drafts_count === null || c.drafts_count === undefined
      ? null
      : { count: num(c.drafts_count), amount: num(c.drafts_total) },
    last_failed: failedSince,
  };
}

/** The view when the check could not be read at all (before the migration, say). */
export function xeroCheckUnread(): XeroCheckView {
  return {
    ...xeroCheckView(null, null, new Date(0)),
    words: "Could not read the check against Xero",
  };
}
