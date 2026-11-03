// Customer invoices a credit note, overpayment or prepayment was allocated to
// (finish line A4 V27, 3 Nov 2026).
//
// Why it exists. SW1346's revenue read 7,205.62 instead of 6,696.62: Xero allocated
// credit note CN-1365 (559.90) to INV-1075 on 27 Aug, but our copy's stored Xero
// record (raw_json) is the one read on 6 Aug, with no credit notes, and Job Profit
// takes a customer credit from that record. The 15-minute invoice list re-reads an
// invoice only when Xero's UpdatedDateUTC for it falls inside the window it asks
// for, and the hourly and daily re-reads choose rows by our own status column, so
// once one read is missed an allocation can stay out of our copy for good.
//
// What this does (inside sync_invoices at most once an hour; on demand with
// ?action=sync_customer_allocations):
//   1. Reads Xero's customer credit notes (ACCRECCREDIT), overpayments
//      (RECEIVE-OVERPAYMENT) and prepayments (RECEIVE-PREPAYMENT) changed since the
//      last complete check, and every one of them once a day (3 Nov 2026: 8 credit
//      notes, 2 overpayments, no prepayments; one page each, so a check costs three
//      Xero calls). The whole read completes before anything is written.
//   2. For each allocation to an invoice, compares what Xero allocated from that
//      source with what our copy's stored record lists from it (AppliedAmount).
//   3. Re-reads each invoice that differs from Xero BY ITS OWN ID and writes it
//      through reconcileXeroInvoice, the identity-checked write the hourly re-read
//      uses. Only Xero's answer is copied.
//   4. Moves its cursor only when every differing invoice it found was attempted.
//
// What it never does: write to Xero, insert an invoice our copy has never seen (it
// is counted as not_in_copy), or count money. An invoice re-read after its source
// last changed that still differs waits a day before it is read again, so a
// difference our copy cannot settle costs one Xero call a day, not one an hour.
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import {
  xeroCollection,
  xeroInstant,
  xeroNumber,
  xeroObject,
  type XeroRecord,
  xeroText,
} from "../_shared/xero_settlement_evidence.ts";
import { incrementalModifiedSince } from "./sync_window.ts";
import {
  isolatedReconcileFailure,
  reconcileXeroInvoice,
  recordReconcileFailure,
} from "./xero_invoice_reconciliation.ts";

export const CUSTOMER_ALLOCATION_SOURCES = [
  {
    kind: "credit_note",
    path: "/CreditNotes",
    type: "ACCRECCREDIT",
    idField: "CreditNoteID",
    numberField: "CreditNoteNumber",
    invoiceField: "CreditNotes",
  },
  {
    kind: "overpayment",
    path: "/Overpayments",
    type: "RECEIVE-OVERPAYMENT",
    idField: "OverpaymentID",
    numberField: null,
    invoiceField: "Overpayments",
  },
  {
    kind: "prepayment",
    path: "/Prepayments",
    type: "RECEIVE-PREPAYMENT",
    idField: "PrepaymentID",
    numberField: null,
    invoiceField: "Prepayments",
  },
] as const;
export type AllocationSource = typeof CUSTOMER_ALLOCATION_SOURCES[number];
export type AllocationKind = AllocationSource["kind"];

/** sync_invoices runs every 15 minutes; the check runs at most once an hour. */
export const CUSTOMER_ALLOCATION_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const CUSTOMER_ALLOCATION_FULL_REREAD_MS = 24 * 60 * 60 * 1000;
/** A re-read that left a difference is tried again after this long. */
export const CUSTOMER_ALLOCATION_RETRY_MS = 24 * 60 * 60 * 1000;
export const CUSTOMER_ALLOCATION_PAGE_SIZE = 100;
export const CUSTOMER_ALLOCATION_PAGE_LIMIT = 100;
/** Invoices re-read per run at most (one Xero call each). */
export const CUSTOMER_ALLOCATION_REREAD_LIMIT = 25;
const COPY_CHUNK = 50;

const XERO_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const idKey = (id: string) => id.toLowerCase();
const cents = (n: number) => Math.round(n * 100);

/** One allocation from one source to one invoice, as Xero listed it. */
export interface AllocationLink {
  kind: AllocationKind;
  source_id: string;
  source_number: string | null;
  /** The source's UpdatedDateUTC; null when Xero sent none. */
  source_updated_at: string | null;
  invoice_id: string;
  invoice_number: string | null;
  /** null when Xero sent no readable amount: the invoice is then always re-read. */
  amount: number | null;
  deleted: boolean;
}

/**
 * One credit note, overpayment or prepayment from Xero's list. A missing or invalid
 * identity, a type other than the one asked for, or an unreadable allocation list
 * makes the provider answer untrusted, so the run refuses rather than guessing. An
 * allocation that names no valid invoice cannot be followed and is left out.
 */
export function parseAllocationSource(
  raw: XeroRecord,
  source: AllocationSource,
): AllocationLink[] {
  const id = xeroText(raw[source.idField]);
  if (!id || !XERO_ID.test(id)) {
    throw new Error(`Xero ${source.kind} identity is missing or invalid`);
  }
  if (raw.Type !== source.type) {
    throw new Error(
      `Xero ${source.kind} ${id} is ${String(raw.Type ?? "untyped")}, not ${source.type}`,
    );
  }
  if (raw.Allocations === undefined || raw.Allocations === null) return [];
  if (!Array.isArray(raw.Allocations)) {
    throw new Error(`Xero ${source.kind} ${id} allocations are unreadable`);
  }
  const links: AllocationLink[] = [];
  for (const a of raw.Allocations) {
    const row = xeroObject(a);
    if (!row) {
      throw new Error(`Xero ${source.kind} ${id} has an unreadable allocation`);
    }
    const invoice = xeroObject(row.Invoice);
    const invoiceId = xeroText(invoice?.InvoiceID);
    if (!invoiceId || !XERO_ID.test(invoiceId)) continue;
    links.push({
      kind: source.kind,
      source_id: id,
      source_number: source.numberField
        ? xeroText(raw[source.numberField])
        : null,
      source_updated_at: xeroInstant(raw.UpdatedDateUTC),
      invoice_id: invoiceId,
      invoice_number: xeroText(invoice?.InvoiceNumber),
      amount: xeroNumber(row.Amount),
      deleted: row.IsDeleted === true,
    });
  }
  return links;
}

type Get = (
  path: string,
  params: Record<string, string>,
  headers: Record<string, string>,
) => Promise<unknown>;

/**
 * Every allocation of every customer credit note, overpayment and prepayment Xero
 * lists (changed since `since`, or all of them without it). A traversal bound or a
 * duplicate identity (the list changed under us) refuses the whole read.
 */
export async function readCustomerAllocations(
  get: Get,
  since: string | undefined,
): Promise<{
  links: AllocationLink[];
  pages: number;
  sources: Record<AllocationKind, number>;
}> {
  const headers: Record<string, string> = since
    ? { "If-Modified-Since": since }
    : {};
  const links: AllocationLink[] = [];
  const sources = { credit_note: 0, overpayment: 0, prepayment: 0 };
  let pages = 0;
  for (const source of CUSTOMER_ALLOCATION_SOURCES) {
    const seen = new Set<string>();
    for (let page = 1;; page++) {
      if (page > CUSTOMER_ALLOCATION_PAGE_LIMIT) {
        throw new Error(
          `Customer ${source.kind} traversal limit reached; cursor retained`,
        );
      }
      // An equality on Type needs no null guard (xero_where_clause.ts is for .Contains).
      const data = await get(source.path, {
        where: `Type=="${source.type}"`,
        page: String(page),
        pageSize: String(CUSTOMER_ALLOCATION_PAGE_SIZE),
        order: `${source.idField} ASC`,
      }, headers);
      const rows = xeroCollection(
        data,
        source.path.slice(1),
      );
      if (rows.length > CUSTOMER_ALLOCATION_PAGE_SIZE) {
        throw new Error(`Xero ${source.path.slice(1)} exceeded page size`);
      }
      pages++;
      for (const raw of rows) {
        const found = parseAllocationSource(raw, source);
        const id = idKey(String(raw[source.idField]));
        if (seen.has(id)) {
          throw new Error(
            `Xero ${source.path.slice(1)} changed during traversal; duplicate identity, cursor retained`,
          );
        }
        seen.add(id);
        sources[source.kind]++;
        links.push(...found);
      }
      if (rows.length < CUSTOMER_ALLOCATION_PAGE_SIZE) break;
    }
  }
  return { links, pages, sources };
}

/** What our copy's stored Xero record says was applied to it from one source. */
export function copyAppliedCents(
  stored: unknown,
  source: AllocationSource,
  sourceId: string,
): number {
  if (!Array.isArray(stored)) return 0;
  let total = 0;
  for (const entry of stored) {
    const row = xeroObject(entry);
    if (!row) continue;
    const id = xeroText(row[source.idField]) ?? xeroText(row.ID);
    if (!id || idKey(id) !== idKey(sourceId)) continue;
    const applied = xeroNumber(row.AppliedAmount);
    if (applied !== null) total += cents(applied);
  }
  return total;
}

export interface CopyRow {
  xero_invoice_id: string;
  invoice_number: string | null;
  reconcile_attempted_at: string | null;
  credit_notes: unknown;
  overpayments: unknown;
  prepayments: unknown;
}

export interface DriftedInvoice {
  xero_invoice_id: string;
  invoice_number: string | null;
  /** The newest change time of a source that differs (null: none known). */
  newest_source_at: string | null;
  /** e.g. "credit_note CN-1365: Xero 559.90, copy 0.00". */
  differences: string[];
}

export interface AllocationDrift {
  /** Differing invoices to re-read now, newest source change first. */
  due: DriftedInvoice[];
  /** Differing invoices already re-read after their source last changed; tried again after a day. */
  waiting: DriftedInvoice[];
  /** Invoices Xero allocated to that our copy has no row for. */
  not_in_copy: number;
  invoices_checked: number;
}

const COPY_FIELD: Record<AllocationKind, keyof CopyRow> = {
  credit_note: "credit_notes",
  overpayment: "overpayments",
  prepayment: "prepayments",
};

/**
 * Compare each invoice's allocations in Xero with our copy. Per invoice and source,
 * Xero's figure is the sum of its live (not deleted) allocations; our copy's is the
 * sum of AppliedAmount its stored record lists for that source. A deleted
 * allocation still names its invoice, so a credit removed in Xero is found too.
 */
export function compareAllocations(
  links: AllocationLink[],
  copy: CopyRow[],
  now: Date,
): AllocationDrift {
  const byInvoice = new Map<
    string,
    Map<string, {
      source: AllocationSource;
      source_id: string;
      label: string;
      xero: number | null;
      updated: string | null;
    }>
  >();
  for (const link of links) {
    const source = CUSTOMER_ALLOCATION_SOURCES.find((s) => s.kind === link.kind)!;
    const inv = idKey(link.invoice_id);
    const perInvoice = byInvoice.get(inv) ?? new Map();
    byInvoice.set(inv, perInvoice);
    const key = `${link.kind}:${idKey(link.source_id)}`;
    const entry = perInvoice.get(key) ?? {
      source,
      source_id: link.source_id,
      label: `${link.kind} ${link.source_number ?? link.source_id}`,
      xero: 0 as number | null,
      updated: link.source_updated_at,
    };
    if (!link.deleted) {
      entry.xero = entry.xero === null || link.amount === null
        ? null
        : entry.xero + cents(link.amount);
    }
    if (
      link.source_updated_at &&
      (!entry.updated || link.source_updated_at > entry.updated)
    ) entry.updated = link.source_updated_at;
    perInvoice.set(key, entry);
  }
  const rows = new Map(copy.map((r) => [idKey(r.xero_invoice_id), r]));
  const due: DriftedInvoice[] = [];
  const waiting: DriftedInvoice[] = [];
  let notInCopy = 0;
  for (const [inv, perInvoice] of byInvoice) {
    const row = rows.get(inv);
    if (!row) {
      notInCopy++;
      continue;
    }
    const differences: string[] = [];
    let newest: string | null = null;
    for (const entry of perInvoice.values()) {
      const stored = copyAppliedCents(
        row[COPY_FIELD[entry.source.kind]],
        entry.source,
        entry.source_id,
      );
      if (entry.xero !== null && entry.xero === stored) continue;
      differences.push(
        `${entry.label}: Xero ${
          entry.xero === null ? "unreadable" : (entry.xero / 100).toFixed(2)
        }, copy ${(stored / 100).toFixed(2)}`,
      );
      if (entry.updated && (!newest || entry.updated > newest)) {
        newest = entry.updated;
      }
    }
    if (!differences.length) continue;
    const drifted: DriftedInvoice = {
      xero_invoice_id: row.xero_invoice_id,
      invoice_number: row.invoice_number,
      newest_source_at: newest,
      differences,
    };
    // Already read by id after its source last changed, and still different:
    // our copy holds what Xero answered then, so wait a day before asking again.
    const attempted = Date.parse(row.reconcile_attempted_at ?? "");
    const changed = Date.parse(newest ?? "");
    const readSinceChange = Number.isFinite(attempted) &&
      (!Number.isFinite(changed) || attempted >= changed);
    const recent = Number.isFinite(attempted) &&
      now.getTime() - attempted < CUSTOMER_ALLOCATION_RETRY_MS;
    if (readSinceChange && recent) waiting.push(drifted);
    else due.push(drifted);
  }
  due.sort((a, b) =>
    (b.newest_source_at ?? "").localeCompare(a.newest_source_at ?? "")
  );
  return {
    due,
    waiting,
    not_in_copy: notInCopy,
    invoices_checked: byInvoice.size,
  };
}

// deno-lint-ignore no-explicit-any
type Client = { from: (t: string) => any };

/** Our copy of the invoices Xero allocated to (sales invoices of this org only). */
export async function readCopyRows(
  client: Client,
  orgId: string,
  invoiceIds: string[],
): Promise<CopyRow[]> {
  const out: CopyRow[] = [];
  const unique = [...new Set(invoiceIds)];
  for (let i = 0; i < unique.length; i += COPY_CHUNK) {
    const chunk = unique.slice(i, i + COPY_CHUNK);
    const { data, error } = await client.from("xero_invoices")
      .select(
        "xero_invoice_id,invoice_number,reconcile_attempted_at," +
          "credit_notes:raw_json->CreditNotes,overpayments:raw_json->Overpayments," +
          "prepayments:raw_json->Prepayments",
      )
      .eq("org_id", orgId).eq("invoice_type", "ACCREC")
      .in("xero_invoice_id", chunk);
    if (
      error || !Array.isArray(data) ||
      data.some((r) => !r || typeof r.xero_invoice_id !== "string")
    ) {
      throw new Error(
        `Customer allocation copy read failed: ${error?.message ?? "unreadable rows"}`,
      );
    }
    out.push(...data as CopyRow[]);
  }
  return out;
}

export type CustomerAllocationResult = { ran: false; reason: "not_due"; next_at: string } | {
  ran: true;
  full_reread: boolean;
  modified_since: string | null;
  pages: number;
  sources: Record<AllocationKind, number>;
  allocations: number;
  invoices_checked: number;
  not_in_copy: number;
  differing: number;
  waiting: number;
  attempted: number;
  reread: number;
  failed: number;
  deferred: number;
  cursor_moved: boolean;
  last_error: Record<string, unknown> | null;
  /** The invoices re-read this run and what differed, for the run log. */
  invoices: Array<
    { invoice_number: string | null; xero_invoice_id: string; differences: string[]; result: string }
  >;
  captured_at: string;
};

export async function syncCustomerAllocations(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string,
  tenantId: string,
  get: Get,
  readInvoice: (invoiceId: string) => Promise<unknown>,
  now = () => new Date(),
  // Called for each invoice re-read, with Xero's payload (the deposit stamp).
  onReconciled?: (invoiceId: string, verifiedPayload: unknown) => Promise<void>,
  // On demand: skip the once-an-hour gate.
  force = false,
): Promise<CustomerAllocationResult> {
  const key = `customer_allocations:${orgId}:${tenantId}`;
  const fullKey = `customer_allocations_full:${orgId}:${tenantId}`;
  const { data: cursors, error: cursorError } = await client.from(
    "xero_sync_state",
  ).select("key,cursor_at").in("key", [key, fullKey]);
  if (cursorError || !Array.isArray(cursors)) {
    throw new Error(
      `Customer allocation cursor read failed: ${cursorError?.message ?? "no rows"}`,
    );
  }
  const cursorAt = (k: string) =>
    (cursors as { key: string; cursor_at: string | null }[])
      .find((c) => c.key === k)?.cursor_at;
  const startedAt = now();
  const started = startedAt.toISOString();
  const lastFull = Date.parse(cursorAt(fullKey) ?? "");
  const fullDue = !Number.isFinite(lastFull) ||
    startedAt.getTime() - lastFull >= CUSTOMER_ALLOCATION_FULL_REREAD_MS;
  const lastCheck = Date.parse(cursorAt(key) ?? "");
  if (
    !force && !fullDue && Number.isFinite(lastCheck) &&
    startedAt.getTime() - lastCheck < CUSTOMER_ALLOCATION_CHECK_INTERVAL_MS
  ) {
    return {
      ran: false,
      reason: "not_due",
      next_at: new Date(lastCheck + CUSTOMER_ALLOCATION_CHECK_INTERVAL_MS)
        .toISOString(),
    };
  }
  const since = fullDue
    ? undefined
    : incrementalModifiedSince(cursorAt(key), startedAt.getTime());

  const { links, pages, sources } = await readCustomerAllocations(get, since);
  const copy = await readCopyRows(
    client,
    orgId,
    links.map((l) => l.invoice_id),
  );
  const drift = compareAllocations(links, copy, startedAt);

  const result: Extract<CustomerAllocationResult, { ran: true }> = {
    ran: true,
    full_reread: !since,
    modified_since: since ?? null,
    pages,
    sources,
    allocations: links.length,
    invoices_checked: drift.invoices_checked,
    not_in_copy: drift.not_in_copy,
    differing: drift.due.length + drift.waiting.length,
    waiting: drift.waiting.length,
    attempted: 0,
    reread: 0,
    failed: 0,
    deferred: Math.max(0, drift.due.length - CUSTOMER_ALLOCATION_REREAD_LIMIT),
    cursor_moved: false,
    last_error: null,
    invoices: [],
    captured_at: started,
  };
  let stopped = false;
  for (const target of drift.due.slice(0, CUSTOMER_ALLOCATION_REREAD_LIMIT)) {
    result.attempted++;
    const reported = {
      invoice_number: target.invoice_number,
      xero_invoice_id: target.xero_invoice_id,
      differences: target.differences,
      result: "reread",
    };
    try {
      let payload: unknown = null;
      await reconcileXeroInvoice(
        client,
        orgId,
        target.xero_invoice_id,
        async () => {
          payload = await readInvoice(target.xero_invoice_id);
          return payload;
        },
        now(),
      );
      result.reread++;
      if (onReconciled) {
        try {
          await onReconciled(target.xero_invoice_id, payload);
        } catch (hookError) {
          if (hookError instanceof XeroCooldownError) throw hookError;
          console.error(
            "[xero-sync] after-allocation-reread hook failed:",
            (hookError as Error).message,
          );
        }
      }
      result.invoices.push(reported);
    } catch (error) {
      // A cooldown is transport-wide: stop and raise; the cursor stays put.
      if (error instanceof XeroCooldownError) throw error;
      result.failed++;
      result.last_error = {
        error: (error as Error).message,
        invoice_id: target.xero_invoice_id,
      };
      result.invoices.push({ ...reported, result: "failed" });
      await recordReconcileFailure(
        client,
        orgId,
        target.xero_invoice_id,
        (error as Error).message,
        now(),
      );
      if (isolatedReconcileFailure(error)) continue;
      stopped = true;
      break;
    }
  }

  // The cursor moves only when every differing invoice this read found was
  // attempted; otherwise the next run reads the same window (or all) again.
  if (!stopped && result.deferred === 0) {
    const updatedAt = now().toISOString();
    const note =
      `Customer allocations ${links.length} on ${drift.invoices_checked} invoices; ` +
      `${result.differing} differing, ${result.reread} re-read, ${result.failed} failed; complete provider traversal`;
    const { error } = await client.from("xero_sync_state").upsert([
      { key, cursor_at: started, updated_at: updatedAt, note },
      ...(since
        ? []
        : [{ key: fullKey, cursor_at: started, updated_at: updatedAt, note }]),
    ], { onConflict: "key" });
    if (error) {
      throw new Error(`Customer allocation cursor write failed: ${error.message}`);
    }
    result.cursor_moved = true;
  }
  return result;
}
