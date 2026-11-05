// deno-lint-ignore-file no-explicit-any
// Dispatch v2 Tweak 4: a simpler supplier picker (Shaun said Go on 5 Nov 2026).
// Contract: docs/dispatch-v2-emails-contract.md, section "Tweak 4".
//
// Shaun's words: "when I search B&D Metals I see 3 of them. Show me the one we
// use most, and put the other ones under Show more."
//
// The rules, in business words:
//   * The Add supplier search shows Shaun's approved suppliers (the 26 on the
//     approved order email list) as ONE row each, under the approved name
//     ("BD Metals", "RnR Fencing").
//   * Behind each row sits its "main" Xero contact: the linked contact with
//     the most Xero bills (not deleted, not voided) in the last 12 months.
//     A tie goes to the contact with the newest bill. A person can pin a
//     contact instead (the CMI pin, 5 Nov 2026): a pin always wins while that
//     contact is still linked and active.
//   * Picking the row makes the supplier box on that main contact.
//   * Everything else sits under "Show more": the other Xero contacts of the
//     26, then every other Xero supplier. A one-off supplier is still found by
//     typing its name.
//   * An approved supplier with no linked Xero contact still shows, greyed,
//     with "Add to Xero first": it cannot become a box until Xero has it.
//   * Search ignores case, spaces, punctuation, "&" and "and": "bd", "b&d" and
//     "b and d" all find BD Metals; "rnr", "r&r" and "r and r" find RnR
//     Fencing.
//
// Nothing here reads or writes the database: the store
// (dispatch_v2_store.ts searchDispatchV2Suppliers) does the reads and hands
// the rows in, so every rule here is tested on its own
// (dispatch_v2_supplier_picker_test.ts).

// ── Search words ────────────────────────────────────────────────────────────

// A consonant. "rnr" and "bnd" read as "R and R" and "B and D"; a word with a
// vowel either side of the n ("and", "one") is left alone.
const CONSONANT = "b-df-hj-np-tv-z";
const LETTER_N_LETTER = new RegExp(`^([${CONSONANT}])n([${CONSONANT}])$`);

/** The words of a supplier name or a search, as search compares them: lower
 * case, "&" and "+" read as "and", punctuation as a space, and the short
 * forms "R and R", "R & R", "RnR" and "R n R" all read as "rr". */
export function dispatchV2SupplierSearchWords(value: unknown): string[] {
  const words = String(value ?? "")
    .toLowerCase()
    .replace(/[&+]/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    // "r and r" / "r n r": two single letters joined by "and" or "n".
    if (
      word.length === 1 && i + 2 < words.length &&
      (words[i + 1] === "and" || words[i + 1] === "n") &&
      words[i + 2].length === 1
    ) {
      out.push(word + words[i + 2]);
      i += 2;
      continue;
    }
    // "rnr" / "bnd": one word.
    const joined = LETTER_N_LETTER.exec(word);
    out.push(joined ? joined[1] + joined[2] : word);
  }
  return out;
}

/** The search key: the words run together ("B&D Metals Group" ->
 * "bdmetalsgroup", "RnR Fencing" -> "rrfencing"). */
export function dispatchV2SupplierSearchKey(value: unknown): string {
  return dispatchV2SupplierSearchWords(value).join("");
}

/** True when a name matches the search. An empty search matches every name.
 * Both sides go through the same key, so "b and d" finds "B&D", "bd" finds
 * "BD Metals", and "r&r" finds "RnR Fencing". */
export function dispatchV2SupplierNameMatches(
  name: unknown,
  search: unknown,
): boolean {
  const needle = dispatchV2SupplierSearchKey(search);
  if (!needle) return true;
  return dispatchV2SupplierSearchKey(name).includes(needle);
}

// ── The main Xero contact ───────────────────────────────────────────────────

/** One Xero contact linked to an approved supplier, with its bill counts
 * (from the dispatch_approved_supplier_contact_bills view). */
export type DispatchV2LinkedContact = {
  supplier_id: string;
  name: string;
  is_active: boolean;
  // The contact has a Xero contact id (a contact made by hand in our own
  // suppliers table has none, so Xero bills can never land on it).
  has_xero_contact: boolean;
  // Bills (not deleted, not voided) in the last 12 months, and the newest
  // bill's date (any age). Null = the counts could not be read.
  bills_12m: number | null;
  last_bill_date: string | null;
  // A person pinned this contact as the main one.
  is_pinned: boolean;
};

/** Why the contact behind a row is the main one, in plain words for the
 * screen. */
export type DispatchV2MainReason =
  | "pinned"
  | "most_bills"
  | "only_contact"
  | "no_bills";

function billsOf(c: DispatchV2LinkedContact): number {
  return typeof c.bills_12m === "number" && Number.isFinite(c.bills_12m)
    ? c.bills_12m
    : 0;
}

/** The linked contacts that can be picked (active only), main first. The
 * order: a pinned contact; then the most bills in the last 12 months; then
 * the newest bill; then a contact Xero knows before one it does not; then by
 * name, then by id, so the answer never changes from one read to the next. */
export function dispatchV2RankLinkedContacts(
  contacts: DispatchV2LinkedContact[],
): DispatchV2LinkedContact[] {
  return contacts
    .filter((c) => c && c.is_active === true && c.supplier_id)
    .sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
      const bills = billsOf(b) - billsOf(a);
      if (bills !== 0) return bills;
      const newest = String(b.last_bill_date ?? "").localeCompare(
        String(a.last_bill_date ?? ""),
      );
      if (newest !== 0) return newest;
      if (a.has_xero_contact !== b.has_xero_contact) {
        return a.has_xero_contact ? -1 : 1;
      }
      const byName = String(a.name).localeCompare(String(b.name));
      if (byName !== 0) return byName;
      return String(a.supplier_id).localeCompare(String(b.supplier_id));
    });
}

/** Why the first of a ranked list is the main contact. */
export function dispatchV2MainReason(
  ranked: DispatchV2LinkedContact[],
): DispatchV2MainReason | null {
  const main = ranked[0];
  if (!main) return null;
  if (main.is_pinned) return "pinned";
  if (ranked.length === 1) return "only_contact";
  return billsOf(main) > 0 ? "most_bills" : "no_bills";
}

// ── The name a box shows ────────────────────────────────────────────────────

/** The name Dispatch shows for a supplier box: the approved name when the
 * box's Xero contact is linked to an active approved supplier ("BD Metals",
 * not "Jaiama Investments Pty Ltd T/A B&D Metals Group Pty"), else the Xero
 * contact's own name. */
export function dispatchV2SupplierDisplayName(
  approvedEntry: { name?: unknown; active?: unknown } | null | undefined,
  xeroName: unknown,
): string | null {
  const approved = typeof approvedEntry?.name === "string" &&
      approvedEntry.active !== false
    ? approvedEntry.name.trim()
    : "";
  if (approved) return approved;
  const xero = typeof xeroName === "string" ? xeroName.trim() : "";
  return xero || null;
}

// ── The picker's answer ─────────────────────────────────────────────────────

export const DISPATCH_V2_NO_XERO_NOTE =
  "Add to Xero first: this supplier has no Xero contact yet";
export const DISPATCH_V2_NO_APPROVED_EMAIL_NOTE =
  "No approved order email: Dispatch will not send to this supplier";

export type DispatchV2PickerInput = {
  // The active approved entries (id, name, used_for, to_emails, cc_emails,
  // on_account), in the order to show them.
  entries: any[];
  // The links (supplier_id -> approved_id) to active entries only.
  links: Array<{ supplier_id: string; approved_id: string }>;
  // Every supplier contact read (id, name, is_active, xero_contact_id).
  contacts: Map<string, any>;
  // supplier_id -> its bill counts and pin; null = the view could not be
  // read (every main contact then falls back to the name order).
  bills: Map<
    string,
    { bills_12m: number; last_bill_date: string | null; is_pinned: boolean }
  > | null;
  // The other active suppliers (not linked to an active entry), by name.
  others: any[];
  // The search as typed; empty = list everything.
  q: string;
  // How many other suppliers to return at most.
  limit: number;
};

function linkedContactOf(
  contact: any,
  bills: DispatchV2PickerInput["bills"],
): DispatchV2LinkedContact {
  const id = String(contact.id);
  const b = bills?.get(id) ?? null;
  return {
    supplier_id: id,
    name: String(contact.name ?? ""),
    is_active: contact.is_active === true,
    has_xero_contact: typeof contact.xero_contact_id === "string" &&
      contact.xero_contact_id.trim() !== "",
    bills_12m: bills ? (b ? Number(b.bills_12m) || 0 : 0) : null,
    last_bill_date: b?.last_bill_date ?? null,
    is_pinned: b?.is_pinned === true,
  };
}

/** The picker's three lists from the rows read:
 *   approved       one row per approved supplier, under its approved name,
 *                  with its main Xero contact (supplier_id) behind it.
 *   more_approved  the other Xero contacts of those suppliers (Show more).
 *   others         every other active Xero supplier (Show more).
 * A search keeps an approved supplier when its approved name or any of its
 * Xero contacts' names match, and then lists all its other contacts under
 * more_approved. */
export function dispatchV2BuildSupplierPicker(input: DispatchV2PickerInput) {
  const q = String(input.q ?? "");
  const approved: any[] = [];
  const moreApproved: any[] = [];
  for (const entry of input.entries || []) {
    const entryId = String(entry.id);
    const linked = (input.links || [])
      .filter((l) => String(l.approved_id) === entryId)
      .map((l) => input.contacts.get(String(l.supplier_id)))
      .filter((c) => c)
      .map((c) => linkedContactOf(c, input.bills));
    const ranked = dispatchV2RankLinkedContacts(linked);
    const hit = dispatchV2SupplierNameMatches(entry.name, q) ||
      ranked.some((c) => dispatchV2SupplierNameMatches(c.name, q));
    if (!hit) continue;
    const base = {
      approved_id: entry.id,
      approved_name: entry.name,
      used_for: entry.used_for,
      to: entry.to_emails || [],
      cc: entry.cc_emails || [],
      on_account: entry.on_account === true,
      has_approved_email: true,
    };
    const main = ranked[0] ?? null;
    approved.push({
      ...base,
      // The row shows the approved name; the Xero contact behind it is
      // xero_name.
      name: entry.name,
      supplier_id: main ? main.supplier_id : null,
      xero_name: main ? main.name : null,
      main_reason: dispatchV2MainReason(ranked),
      bills_12m: main ? main.bills_12m : null,
      last_bill_date: main ? main.last_bill_date : null,
      other_contacts: Math.max(0, ranked.length - 1),
      can_add: !!main,
      note: main ? null : DISPATCH_V2_NO_XERO_NOTE,
    });
    for (const contact of ranked.slice(1)) {
      moreApproved.push({
        ...base,
        name: contact.name,
        supplier_id: contact.supplier_id,
        xero_name: contact.name,
        bills_12m: contact.bills_12m,
        last_bill_date: contact.last_bill_date,
        can_add: true,
        note: null,
      });
    }
  }
  const others = (input.others || [])
    .filter((row) => dispatchV2SupplierNameMatches(row.name, q))
    .slice(0, Math.max(0, input.limit))
    .map((row) => ({
      supplier_id: row.id,
      name: row.name,
      approved_id: null,
      approved_name: null,
      used_for: null,
      to: [],
      cc: [],
      has_approved_email: false,
      can_add: true,
      note: DISPATCH_V2_NO_APPROVED_EMAIL_NOTE,
    }));
  return { approved, more_approved: moreApproved, others };
}
