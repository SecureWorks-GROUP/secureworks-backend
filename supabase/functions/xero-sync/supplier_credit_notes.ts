// Supplier credit notes (ACCPAYCREDIT) and their allocations, copied from Xero
// (TP-07 slice 1, migration 20261030010000). Read only against Xero: one GET
// lane, no write to Xero. Off until feature_flags.xero_supplier_credit_notes_v1.
//
// Our copy says only what Xero returned for that exact CreditNoteID: a field
// Xero did not send is null, never 0 or a guessed status, and a note missing
// from a page is never marked deleted or voided. Nothing here counts money:
// the copy is read only by v_supplier_credit_placement.
//
// Same traversal rules as settlement_evidence.ts: the whole provider read
// completes before any write, a bound refuses completion (it never drops the
// rest or moves the cursor), a duplicate identity means the list changed under
// us and refuses too, and a full re-read runs once a day because a cursor on
// UpdatedDateUTC is only as good as Xero's promise to move it.
import {
  xeroCollection,
  xeroInstant,
  xeroNumber,
  xeroObject,
  type XeroRecord,
  xeroText,
} from "../_shared/xero_settlement_evidence.ts";
import { incrementalModifiedSince } from "./sync_window.ts";

export const SUPPLIER_CREDIT_NOTES_FLAG = "xero_supplier_credit_notes_v1";
export const SUPPLIER_CREDIT_NOTE_TYPE = "ACCPAYCREDIT";
export const SUPPLIER_CREDIT_FULL_REREAD_MS = 24 * 60 * 60 * 1000;
export const SUPPLIER_CREDIT_PAGE_SIZE = 100;
export const SUPPLIER_CREDIT_PAGE_LIMIT = 100;

const XERO_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export type SupplierCreditNoteCopy = {
  xero_credit_note_id: string;
  credit_note_type: "ACCPAYCREDIT";
  credit_note_number: string | null;
  xero_contact_id: string | null;
  contact_name: string | null;
  reference: string | null;
  credit_note_date: string | null;
  status: string | null;
  line_amount_types: string | null;
  currency_code: string | null;
  sub_total: number | null;
  total_tax: number | null;
  total: number | null;
  remaining_credit: number | null;
  fully_paid_on: string | null;
  xero_updated_at: string | null;
  raw_json: XeroRecord;
};

export type SupplierCreditAllocationCopy = {
  allocation_id: string | null;
  xero_invoice_id: string | null;
  invoice_number: string | null;
  amount: number | null;
  allocation_date: string | null;
  is_deleted: boolean;
  raw_json: XeroRecord;
};

export type ParsedSupplierCreditNote = {
  note: SupplierCreditNoteCopy;
  /** null: the record carried no Allocations list, so nothing is known about them. */
  allocations: SupplierCreditAllocationCopy[] | null;
};

/**
 * A Xero day: "2026-10-01T00:00:00" (DateString) or "/Date(1759276800000+0000)/".
 * Xero's DateString is the organisation's own calendar day, so its first ten
 * characters are the day; the /Date()/ form is read as UTC. Anything else is null.
 */
export function xeroDay(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const day = /^(\d{4}-\d{2}-\d{2})(?:T[\d:.]+)?$/.exec(v);
  if (day) return Number.isFinite(Date.parse(`${day[1]}T00:00:00Z`)) ? day[1] : null;
  if (/^\/Date\(/.test(v)) return xeroInstant(v)?.slice(0, 10) ?? null;
  return null;
}

/**
 * One allocation as Xero listed it. An amount Xero did not send stays null; only
 * IsDeleted === true marks it deleted.
 */
export function parseSupplierCreditAllocation(raw: XeroRecord): SupplierCreditAllocationCopy {
  const invoice = xeroObject(raw.Invoice);
  const invoiceId = xeroText(invoice?.InvoiceID);
  return {
    allocation_id: xeroText(raw.AllocationID),
    xero_invoice_id: invoiceId && XERO_ID.test(invoiceId) ? invoiceId : null,
    invoice_number: xeroText(invoice?.InvoiceNumber),
    amount: xeroNumber(raw.Amount),
    allocation_date: xeroDay(raw.DateString) ?? xeroDay(raw.Date),
    is_deleted: raw.IsDeleted === true,
    raw_json: raw,
  };
}

/**
 * One credit note from Xero's /CreditNotes list. Throws when the record has no
 * valid CreditNoteID or is not ACCPAYCREDIT: the request asked for that type
 * only, so either means the provider answer cannot be trusted, and the run
 * refuses rather than copying a guess.
 */
export function parseSupplierCreditNote(raw: XeroRecord): ParsedSupplierCreditNote {
  const id = xeroText(raw.CreditNoteID);
  if (!id || !XERO_ID.test(id)) {
    throw new Error("Xero credit note identity is missing or invalid");
  }
  if (raw.Type !== SUPPLIER_CREDIT_NOTE_TYPE) {
    throw new Error(`Xero credit note ${id} is ${String(raw.Type ?? "untyped")}, not ACCPAYCREDIT`);
  }
  const contact = xeroObject(raw.Contact);
  let allocations: SupplierCreditAllocationCopy[] | null = null;
  if (Array.isArray(raw.Allocations)) {
    allocations = raw.Allocations.map((a) => {
      const row = xeroObject(a);
      if (!row) throw new Error(`Xero credit note ${id} has an unreadable allocation`);
      return parseSupplierCreditAllocation(row);
    });
  } else if (raw.Allocations !== undefined && raw.Allocations !== null) {
    throw new Error(`Xero credit note ${id} allocations are unreadable`);
  }
  return {
    note: {
      xero_credit_note_id: id,
      credit_note_type: SUPPLIER_CREDIT_NOTE_TYPE,
      credit_note_number: xeroText(raw.CreditNoteNumber),
      xero_contact_id: xeroText(contact?.ContactID),
      contact_name: xeroText(contact?.Name),
      reference: xeroText(raw.Reference),
      credit_note_date: xeroDay(raw.DateString) ?? xeroDay(raw.Date),
      status: xeroText(raw.Status),
      line_amount_types: xeroText(raw.LineAmountTypes),
      currency_code: xeroText(raw.CurrencyCode),
      sub_total: xeroNumber(raw.SubTotal),
      total_tax: xeroNumber(raw.TotalTax),
      total: xeroNumber(raw.Total),
      remaining_credit: xeroNumber(raw.RemainingCredit),
      fully_paid_on: xeroDay(raw.FullyPaidOnDate),
      xero_updated_at: xeroInstant(raw.UpdatedDateUTC),
      raw_json: raw,
    },
    allocations,
  };
}

type Get = (
  path: string,
  params: Record<string, string>,
  headers: Record<string, string>,
) => Promise<unknown>;

// deno-lint-ignore no-explicit-any
type Client = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

/** The switch; missing or unreadable is off. */
export async function supplierCreditNotesOn(sb: Pick<Client, "from">): Promise<boolean> {
  try {
    const { data, error } = await sb.from("feature_flags").select("enabled")
      .eq("flag_name", SUPPLIER_CREDIT_NOTES_FLAG).limit(1);
    if (error) return false;
    return Array.isArray(data) && data[0]?.enabled === true;
  } catch {
    return false;
  }
}

export type SupplierCreditSyncResult =
  | { ran: false; reason: "flag_off" }
  | {
    ran: true;
    notes: number;
    allocations: number;
    written: number;
    stale: number;
    pages: number;
    modified_since: string | null;
    full_reread: boolean;
    captured_at: string;
  };

export async function syncSupplierCreditNotes(
  sb: Client,
  orgId: string,
  tenantId: string,
  get: Get,
  now = () => new Date(),
): Promise<SupplierCreditSyncResult> {
  if (!(await supplierCreditNotesOn(sb))) return { ran: false, reason: "flag_off" };
  const key = `supplier_credit_notes:${orgId}:${tenantId}`;
  const fullKey = `supplier_credit_notes_full:${orgId}:${tenantId}`;
  const { data: cursors, error: cursorError } = await sb.from("xero_sync_state")
    .select("key,cursor_at").in("key", [key, fullKey]);
  if (cursorError || !Array.isArray(cursors)) {
    throw new Error(`Supplier credit note cursor read failed: ${cursorError?.message ?? "no rows"}`);
  }
  const cursorAt = (k: string) =>
    (cursors as { key: string; cursor_at: string | null }[]).find((c) => c.key === k)?.cursor_at;
  const startedAt = now();
  const started = startedAt.toISOString();
  const lastFull = Date.parse(cursorAt(fullKey) ?? "");
  const fullDue = !Number.isFinite(lastFull) ||
    startedAt.getTime() - lastFull >= SUPPLIER_CREDIT_FULL_REREAD_MS;
  const since = fullDue ? undefined : incrementalModifiedSince(cursorAt(key), startedAt.getTime());
  const headers: Record<string, string> = since ? { "If-Modified-Since": since } : {};

  const parsed: ParsedSupplierCreditNote[] = [];
  const seen = new Set<string>();
  let pages = 0;
  for (let page = 1;; page++) {
    if (page > SUPPLIER_CREDIT_PAGE_LIMIT) {
      throw new Error("Supplier credit note traversal limit reached; cursor retained");
    }
    // An equality on Type needs no null guard (xero_where_clause.ts is for .Contains).
    const data = await get("/CreditNotes", {
      where: `Type=="${SUPPLIER_CREDIT_NOTE_TYPE}"`,
      page: String(page),
      pageSize: String(SUPPLIER_CREDIT_PAGE_SIZE),
      order: "CreditNoteID ASC",
    }, headers);
    const rows = xeroCollection(data, "CreditNotes");
    if (rows.length > SUPPLIER_CREDIT_PAGE_SIZE) {
      throw new Error("Xero CreditNotes exceeded page size");
    }
    pages++;
    for (const raw of rows) {
      const one = parseSupplierCreditNote(raw);
      if (seen.has(one.note.xero_credit_note_id)) {
        throw new Error("Xero CreditNotes changed during traversal; duplicate identity, cursor retained");
      }
      seen.add(one.note.xero_credit_note_id);
      parsed.push(one);
    }
    if (rows.length < SUPPLIER_CREDIT_PAGE_SIZE) break;
  }

  // Only after the whole read: each note and its list in one transaction.
  let written = 0;
  let stale = 0;
  let allocations = 0;
  for (const one of parsed) {
    const { data, error } = await sb.rpc("xero_supplier_credit_note_copy", {
      p_org_id: orgId,
      p_note: one.note,
      p_allocations: one.allocations,
    });
    if (error) {
      throw new Error(`Supplier credit note write failed for ${one.note.xero_credit_note_id}: ${error.message}`);
    }
    if (data === "written") written++;
    else if (data === "stale") stale++;
    else throw new Error(`Supplier credit note write for ${one.note.xero_credit_note_id} answered ${String(data)}`);
    allocations += one.allocations?.length ?? 0;
  }

  const updatedAt = now().toISOString();
  const note = `Supplier credit notes ${parsed.length}; allocations ${allocations}; complete provider traversal`;
  const { error } = await sb.from("xero_sync_state").upsert([
    { key, cursor_at: started, updated_at: updatedAt, note },
    ...(since ? [] : [{ key: fullKey, cursor_at: started, updated_at: updatedAt, note }]),
  ], { onConflict: "key" });
  if (error) throw new Error(`Supplier credit note cursor write failed: ${error.message}`);
  return {
    ran: true,
    notes: parsed.length,
    allocations,
    written,
    stale,
    pages,
    modified_since: since ?? null,
    full_reread: !since,
    captured_at: started,
  };
}
