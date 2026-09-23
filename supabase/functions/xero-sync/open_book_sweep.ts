// The open-book sweep (money slice MN1, money.md §2, §6 steps 3 to 8).
//
// Every 15 minutes, inside sync_invoices: read Xero's whole open receivable
// book (ACCREC, AUTHORISED or SUBMITTED) in two or three list calls and
// compare it with our copy. The incremental loop only asks for invoices
// modified since its cursor, and the hourly verify only re-reads rows we
// still hold as open, so a row our copy wrongly holds as closed was never
// read again (INV-0034: our copy DELETED, Xero AUTHORISED $734.48).
//
// Drift classes, per invoice:
//   added_back              open in Xero; not in our copy, or our copy says
//                           DELETED, VOIDED or DRAFT
//   closed_here_open_there  open in Xero; our copy says PAID
//   amount_changed          open in both; total or amount due differs
//   status_changed          open in both; AUTHORISED versus SUBMITTED
//   contact_changed         open in both; Xero contact differs (stale payer)
//   reference_changed       open in both; reference differs
//   open_here_not_in_xero   open in our copy; not in Xero's open book
//
// open_here_not_in_xero ids are settled by one GET /Invoices?IDs= per 40 ids.
// Xero's list reads omit deleted drafts, so an id that read does not return
// falls back to the single-record read (GET /Invoices/{id}, which returns
// DELETED honestly) through reconcileXeroInvoice, at most 10 a run; anything
// still unsettled is counted closure_unverified (review M6).
//
// Mode, from feature flags (context_money_open_book_mode(), one parser for
// SQL and this code):
//   off      nothing runs, nothing is read or written.
//   observe  every read runs and the receipt is written; nothing is written
//            to xero_invoices.
//   apply    every live open invoice goes through applyProviderInvoice (row,
//            reference link, deposit stamp, paid automation); closures too.
// A run closes rows only after every page of the open book succeeded. A page
// failure stops the sweep: rows seen so far are applied, nothing is closed,
// and the receipt says partial.
//
// Receipt: record_capture_run(source xero_open_book), counts per class, calls
// used and Xero's x-daylimit-remaining; the cursor carries the actor, the mode
// and a bounded list of invoice ids per class. Ids, counts and codes only: no
// names, amounts or addresses.

import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import {
  applyProviderInvoice,
  applyProviderInvoiceEffects,
  EXISTING_LINK_COLUMNS,
  type ExistingInvoiceLink,
  type ProviderInvoiceDeps,
} from "./xero_invoice_record.ts";
import { reconcileXeroInvoice } from "./xero_invoice_reconciliation.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type XeroInvoice = any;

export const OPEN_BOOK_RUN_SOURCE = "xero_open_book";
export const OPEN_BOOK_ACTOR = "workflow:xero-sync";
export const OPEN_BOOK_PAGE_SIZE = 100;
// About 101 open invoices today: two pages. The cap only stops a runaway.
export const OPEN_BOOK_MAX_PAGES = 20;
export const CLOSURE_IDS_PER_READ = 40;
export const CLOSURE_SINGLE_READS_PER_RUN = 10;
// context_capture_runs.cursor is at most 4096 bytes: ids per class are capped
// there; the full lists go to the sync's webhook_log summary.
export const CURSOR_IDS_PER_CLASS = 10;
// jsonb::text adds a space after every ":" and ",", so the JSON bound is lower.
const CURSOR_MAX_BYTES = 3600;
const OPEN = new Set(["AUTHORISED", "SUBMITTED"]);
const CENT = 0.005;

export type OpenBookMode = "off" | "observe" | "apply";

export interface OpenBookModeReading {
  mode: OpenBookMode;
  // present | missing | unreadable. Missing or unreadable reads as off.
  state: string;
}

export const DRIFT_CLASSES = [
  "added_back",
  "closed_here_open_there",
  "amount_changed",
  "status_changed",
  "contact_changed",
  "reference_changed",
  "open_here_not_in_xero",
] as const;
export type DriftClass = typeof DRIFT_CLASSES[number];

export const CLOSURE_OUTCOMES = [
  "closed_by_ids_read",
  "still_open_in_xero",
  "closed_by_single_read",
  "closure_unverified",
] as const;
export type ClosureOutcome = typeof CLOSURE_OUTCOMES[number];

/** The cached fields the comparison reads. */
export interface CachedInvoice extends ExistingInvoiceLink {
  xero_invoice_id: string;
  status: string | null;
  total: number | string | null;
  amount_due: number | string | null;
  xero_contact_id: string | null;
  reference: string | null;
}

const CACHED_COLUMNS =
  `xero_invoice_id, status, total, amount_due, xero_contact_id, reference, ${EXISTING_LINK_COLUMNS}`;

export interface OpenBookXero {
  // GET /Invoices?where=Type=="ACCREC"&Statuses=AUTHORISED,SUBMITTED&page=N&pageSize=100
  listOpenPage: (page: number) => Promise<XeroInvoice[]>;
  // GET /Invoices?IDs=a,b,c (at most 40)
  readByIds: (ids: string[]) => Promise<XeroInvoice[]>;
  // GET /Invoices/{id}, the raw payload ({Invoices:[...]})
  readOne: (id: string) => Promise<unknown>;
  // Calls made so far and the last x-daylimit-remaining seen.
  quota: () => { calls: number; day_remaining: number | null };
}

export interface OpenBookDeps extends ProviderInvoiceDeps {
  xero: OpenBookXero;
  readMode: () => Promise<OpenBookModeReading>;
}

export interface OpenBookSummary {
  mode: OpenBookMode;
  flag_state: string;
  ran: boolean;
  status: "skipped" | "succeeded" | "partial" | "failed";
  error_code: string | null;
  run_id: string | null;
  complete: boolean;
  counts: Record<string, number>;
  // Full id lists per class (webhook_log summary). Invoice ids only.
  ids: Record<string, string[]>;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function differs(a: unknown, b: unknown): boolean {
  const x = num(a), y = num(b);
  if (x === null || y === null) return x !== y;
  return Math.abs(x - y) > CENT;
}

function text(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

/** Pure: the drift classes of one invoice that Xero lists as open. */
export function classifyLiveOpen(
  live: XeroInvoice,
  cached: CachedInvoice | null | undefined,
): DriftClass[] {
  if (!cached) return ["added_back"];
  const here = String(cached.status || "").toUpperCase();
  if (!OPEN.has(here)) {
    return here === "PAID" ? ["closed_here_open_there"] : ["added_back"];
  }
  const out: DriftClass[] = [];
  if (
    differs(live.AmountDue, cached.amount_due) ||
    differs(live.Total, cached.total)
  ) out.push("amount_changed");
  if (String(live.Status || "").toUpperCase() !== here) {
    out.push("status_changed");
  }
  if (text(live.Contact?.ContactID) !== text(cached.xero_contact_id)) {
    out.push("contact_changed");
  }
  if (text(live.Reference) !== text(cached.reference)) {
    out.push("reference_changed");
  }
  return out;
}

/** Pure: the receipt cursor, bounded to the column's 4096-byte check. */
export function openBookCursor(
  mode: OpenBookMode,
  flagState: string,
  ids: Record<string, string[]>,
): Record<string, unknown> {
  let perClass = CURSOR_IDS_PER_CLASS;
  for (;;) {
    const bounded: Record<string, string[]> = {};
    let truncated = false;
    for (const [k, v] of Object.entries(ids)) {
      if (!v.length) continue;
      bounded[k] = v.slice(0, perClass);
      if (v.length > perClass) truncated = true;
    }
    const cursor = {
      actor: OPEN_BOOK_ACTOR,
      mode,
      flag_state: flagState,
      ids: bounded,
      ids_truncated: truncated,
    };
    if (JSON.stringify(cursor).length <= CURSOR_MAX_BYTES || perClass === 0) {
      return cursor;
    }
    perClass = Math.max(0, perClass - 2);
  }
}

async function recordRun(
  sb: Db,
  run: Record<string, unknown>,
): Promise<string | null> {
  try {
    const { data, error } = await sb.rpc("record_capture_run", { p_run: run });
    if (error || typeof data?.run_id !== "string") {
      console.error(
        "[xero-sync] open-book receipt not recorded:",
        error?.message?.match(/capture_run_[a-z_]+/)?.[0] ??
          "record_capture_run_failed",
      );
      return null;
    }
    return data.run_id;
  } catch (e) {
    console.error(
      "[xero-sync] open-book receipt not recorded:",
      (e as Error).message,
    );
    return null;
  }
}

async function readCachedOpen(
  sb: Db,
  orgId: string,
): Promise<Map<string, CachedInvoice>> {
  const out = new Map<string, CachedInvoice>();
  for (let from = 0;; from += 1000) {
    const { data, error } = await sb.from("xero_invoices")
      .select(CACHED_COLUMNS)
      .eq("org_id", orgId)
      .eq("invoice_type", "ACCREC")
      .in("status", ["AUTHORISED", "SUBMITTED"])
      .order("xero_invoice_id", { ascending: true })
      .range(from, from + 999);
    if (error || !Array.isArray(data)) {
      throw Object.assign(new Error("cached open book unreadable"), {
        code: "cached_open_unreadable",
      });
    }
    for (const row of data) out.set(row.xero_invoice_id, row);
    if (data.length < 1000) return out;
  }
}

async function readCachedByIds(
  sb: Db,
  orgId: string,
  ids: string[],
): Promise<Map<string, CachedInvoice>> {
  const out = new Map<string, CachedInvoice>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from("xero_invoices")
      .select(CACHED_COLUMNS)
      .eq("org_id", orgId)
      .in("xero_invoice_id", ids.slice(i, i + 100));
    if (error || !Array.isArray(data)) {
      throw Object.assign(new Error("cached rows unreadable"), {
        code: "cached_rows_unreadable",
      });
    }
    for (const row of data) out.set(row.xero_invoice_id, row);
  }
  return out;
}

function errorCode(e: unknown, fallback: string): string {
  if (e instanceof XeroCooldownError) return "xero_cooldown";
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && /^[a-z][a-z0-9_]{0,60}$/.test(code)) {
    return code;
  }
  const status = (e as { status?: unknown })?.status;
  if (typeof status === "number") return `${fallback}_http_${status}`;
  return fallback;
}

/**
 * One sweep. Never throws except for a Xero cooldown, which is recorded on
 * the receipt first and then raised so sync_invoices stops as it does for
 * every other cooldown.
 */
export async function sweepOpenReceivables(
  sb: Db,
  deps: OpenBookDeps,
): Promise<OpenBookSummary> {
  let reading: OpenBookModeReading;
  try {
    reading = await deps.readMode();
  } catch (_) {
    reading = { mode: "off", state: "unreadable" };
  }
  const summary: OpenBookSummary = {
    mode: reading.mode,
    flag_state: reading.state,
    ran: false,
    status: "skipped",
    error_code: null,
    run_id: null,
    complete: false,
    counts: {},
    ids: {},
  };
  if (reading.mode !== "observe" && reading.mode !== "apply") {
    summary.mode = "off";
    return summary;
  }
  const apply = reading.mode === "apply";
  const now = deps.now?.() ?? new Date();
  const counts: Record<string, number> = {
    pages: 0,
    live_open: 0,
    cached_open: 0,
    in_sync: 0,
    applied: 0,
    apply_errors: 0,
    deposit_stamps: 0,
    jobs_completed: 0,
    links_made: 0,
    ses_refusals: 0,
  };
  for (const k of [...DRIFT_CLASSES, ...CLOSURE_OUTCOMES]) counts[k] = 0;
  const ids: Record<string, string[]> = {};
  const note = (k: string, id: string) => {
    (ids[k] ??= []).push(id);
    counts[k] = (counts[k] ?? 0) + 1;
  };
  const tally = (
    e: {
      deposit: { action: string } | null;
      job_completed: string | null;
      linked_job_id: string | null;
      ses_refusals: unknown[];
    },
  ) => {
    if (e.deposit?.action === "stamped") counts.deposit_stamps++;
    if (e.job_completed) counts.jobs_completed++;
    if (e.linked_job_id) counts.links_made++;
    counts.ses_refusals += e.ses_refusals.length;
  };

  summary.ran = true;
  summary.run_id = await recordRun(sb, {
    source: OPEN_BOOK_RUN_SOURCE,
    status: "running",
    window_to: now.toISOString(),
    cursor: openBookCursor(reading.mode, reading.state, {}),
  });

  let failure: string | null = null;
  let cooldown: XeroCooldownError | null = null;
  const live = new Map<string, XeroInvoice>();

  const finish = async (): Promise<OpenBookSummary> => {
    const quota = deps.xero.quota();
    counts.xero_calls = quota.calls;
    if (quota.day_remaining !== null && quota.day_remaining >= 0) {
      counts.day_remaining = Math.trunc(quota.day_remaining);
    }
    summary.counts = counts;
    summary.ids = ids;
    summary.status = counts.pages === 0 && failure
      ? "failed"
      : failure || counts.apply_errors > 0
      ? "partial"
      : "succeeded";
    summary.error_code = failure ??
      (counts.apply_errors > 0 ? "apply_errors" : null);
    if (summary.run_id) {
      const done = await recordRun(sb, {
        run_id: summary.run_id,
        source: OPEN_BOOK_RUN_SOURCE,
        status: summary.status,
        counts,
        cursor: openBookCursor(reading.mode, reading.state, ids),
        error_code: summary.error_code,
      });
      if (!done) summary.run_id = null;
    }
    if (cooldown) throw cooldown;
    return summary;
  };

  // 1. Xero's open book, page by page until a short page.
  try {
    for (let page = 1; page <= OPEN_BOOK_MAX_PAGES; page++) {
      const rows = await deps.xero.listOpenPage(page);
      counts.pages++;
      for (const inv of rows ?? []) {
        if (
          inv?.Type === "ACCREC" && typeof inv.InvoiceID === "string" &&
          OPEN.has(String(inv.Status || "").toUpperCase())
        ) live.set(inv.InvoiceID, inv);
      }
      if (!rows || rows.length < OPEN_BOOK_PAGE_SIZE) {
        summary.complete = true;
        break;
      }
    }
    if (!summary.complete) failure = "page_cap_reached";
  } catch (e) {
    failure = errorCode(e, "open_book_page_failed");
    if (e instanceof XeroCooldownError) cooldown = e;
  }
  counts.live_open = live.size;
  if (cooldown) return await finish();

  // 2. Our copy.
  let cachedOpen: Map<string, CachedInvoice>;
  let cachedLive: Map<string, CachedInvoice>;
  try {
    cachedOpen = await readCachedOpen(sb, deps.orgId);
    const missing = [...live.keys()].filter((id) => !cachedOpen.has(id));
    cachedLive = await readCachedByIds(sb, deps.orgId, missing);
  } catch (e) {
    failure = errorCode(e, "cached_read_failed");
    summary.complete = false;
    return await finish();
  }
  counts.cached_open = cachedOpen.size;

  // 3. Classify, and in apply mode correct every live open invoice.
  for (const [id, inv] of live) {
    const cached = cachedOpen.get(id) ?? cachedLive.get(id) ?? null;
    const classes = classifyLiveOpen(inv, cached);
    if (!classes.length) counts.in_sync++;
    for (const c of classes) note(c, id);
    if (!apply) continue;
    try {
      const result = await applyProviderInvoice(sb, inv, now, deps, cached);
      if (result.written) {
        counts.applied++;
        tally(result);
      } else {
        counts.apply_errors++;
        (ids.apply_errors ??= []).push(id);
      }
    } catch (e) {
      if (e instanceof XeroCooldownError) {
        cooldown = e;
        failure = "xero_cooldown";
        return await finish();
      }
      counts.apply_errors++;
      (ids.apply_errors ??= []).push(id);
    }
  }

  // 4. Closure: only after every page succeeded.
  if (!summary.complete) return await finish();
  const notInXero = [...cachedOpen.keys()].filter((id) => !live.has(id));
  for (const id of notInXero) note("open_here_not_in_xero", id);

  const unreturned: string[] = [];
  for (let i = 0; i < notInXero.length; i += CLOSURE_IDS_PER_READ) {
    const chunk = notInXero.slice(i, i + CLOSURE_IDS_PER_READ);
    let returned: XeroInvoice[];
    try {
      returned = await deps.xero.readByIds(chunk);
    } catch (e) {
      if (e instanceof XeroCooldownError) {
        cooldown = e;
        failure = "xero_cooldown";
        for (const id of chunk) note("closure_unverified", id);
        return await finish();
      }
      failure = errorCode(e, "closure_read_failed");
      for (const id of chunk) note("closure_unverified", id);
      continue;
    }
    const byId = new Map<string, XeroInvoice>();
    for (const inv of returned ?? []) {
      if (
        inv?.Type === "ACCREC" && typeof inv.InvoiceID === "string" &&
        chunk.includes(inv.InvoiceID)
      ) byId.set(inv.InvoiceID, inv);
    }
    for (const id of chunk) {
      const inv = byId.get(id);
      if (!inv) {
        unreturned.push(id);
        continue;
      }
      const stillOpen = OPEN.has(String(inv.Status || "").toUpperCase());
      note(stillOpen ? "still_open_in_xero" : "closed_by_ids_read", id);
      if (!apply) continue;
      try {
        const result = await applyProviderInvoice(
          sb,
          inv,
          now,
          deps,
          cachedOpen.get(id) ?? null,
        );
        if (result.written) {
          counts.applied++;
          tally(result);
        } else {
          counts.apply_errors++;
          (ids.apply_errors ??= []).push(id);
        }
      } catch (e) {
        if (e instanceof XeroCooldownError) {
          cooldown = e;
          failure = "xero_cooldown";
          return await finish();
        }
        counts.apply_errors++;
        (ids.apply_errors ??= []).push(id);
      }
    }
  }

  // 5. Ids the list read omitted (deleted drafts, review M6): the single-record
  // read, at most 10 a run; the rest wait for the next run.
  for (const [n, id] of unreturned.entries()) {
    if (n >= CLOSURE_SINGLE_READS_PER_RUN) {
      note("closure_unverified", id);
      continue;
    }
    try {
      if (apply) {
        let verified: XeroInvoice = null;
        await reconcileXeroInvoice(sb, deps.orgId, id, async () => {
          const payload = await deps.xero.readOne(id) as {
            Invoices?: XeroInvoice[];
          };
          verified = payload?.Invoices?.[0] ?? null;
          return payload;
        }, now);
        note(
          OPEN.has(String(verified?.Status || "").toUpperCase())
            ? "still_open_in_xero"
            : "closed_by_single_read",
          id,
        );
        counts.applied++;
        tally(
          await applyProviderInvoiceEffects(
            sb,
            verified,
            cachedOpen.get(id) ?? null,
            deps,
          ),
        );
      } else {
        const payload = await deps.xero.readOne(id) as {
          Invoices?: XeroInvoice[];
        };
        const inv = payload?.Invoices?.length === 1
          ? payload.Invoices[0]
          : null;
        if (inv?.InvoiceID === id && inv?.Type === "ACCREC" && inv?.Status) {
          note(
            OPEN.has(String(inv.Status).toUpperCase())
              ? "still_open_in_xero"
              : "closed_by_single_read",
            id,
          );
        } else {
          note("closure_unverified", id);
        }
      }
    } catch (e) {
      if (e instanceof XeroCooldownError) {
        cooldown = e;
        failure = "xero_cooldown";
        note("closure_unverified", id);
        return await finish();
      }
      note("closure_unverified", id);
    }
  }
  return await finish();
}
