// deno-lint-ignore-file no-explicit-any
// Dispatch v2: the payment step on a supplier order. The rules, pure.
// Contract: docs/dispatch-v2-board-contract.md, section 3c.
//
// Shaun, 29 Oct 2026: when a supplier we have no account with comes back with
// a quote, the order waits on us to pay, and stays there until someone records
// in Dispatch that we paid.
//
// The rules, in business words:
//   * On account or pay first. Five suppliers are on account (Bunnings, Fence
//     Makers, Fencing Warehouse WA, R&R Fencing, Stratco WA). Every other
//     supplier pays first, including a box whose supplier is not linked to the
//     approved supplier list at all, so nothing slips past payment. The list
//     is kept in one place (dispatch_approved_supplier_emails.on_account).
//   * If the account list could not be read, the terms are "unknown" and
//     Dispatch behaves exactly as it did before the payment step (no payment
//     gate, no reply move). The read answer says so (reads.accounts).
//
// Nothing here reads or writes the database: the local preview stand-in
// imports this file as it is.

export type DispatchV2PaymentTerms = "on_account" | "pay_first" | "unknown";

/** A box's payment terms. `linked` = an active approved entry is linked to
 * the box's supplier; `onAccount` = that entry's on_account. */
export function dispatchV2PaymentTerms(input: {
  readOk: boolean;
  linked: boolean;
  onAccount: boolean | null;
}): DispatchV2PaymentTerms {
  if (!input.readOk) return "unknown";
  return input.linked && input.onAccount === true ? "on_account" : "pay_first";
}

// The account list as read: supplier id -> its linked approved entry (active
// or not). `readOk` false = the read failed, every box is "unknown".
export type DispatchV2Accounts = {
  readOk: boolean;
  bySupplier: Map<string, { active: boolean; on_account: boolean }>;
};

/** The account list from its two reads: the links (supplier_id ->
 * approved_id, one per Xero supplier) and the approved entries. Pass null for
 * either when its read failed. */
export function dispatchV2AccountsOf(
  links: any[] | null | undefined,
  entries: any[] | null | undefined,
): DispatchV2Accounts {
  const bySupplier = new Map<string, { active: boolean; on_account: boolean }>();
  if (!Array.isArray(links) || !Array.isArray(entries)) {
    return { readOk: false, bySupplier };
  }
  const byId = new Map<string, any>();
  for (const entry of entries) {
    if (entry?.id) byId.set(String(entry.id), entry);
  }
  for (const link of links) {
    const supplierId = String(link?.supplier_id ?? "");
    const entry = byId.get(String(link?.approved_id ?? ""));
    if (!supplierId || !entry) continue;
    bySupplier.set(supplierId, {
      active: entry.active === true,
      on_account: entry.on_account === true,
    });
  }
  return { readOk: true, bySupplier };
}

/** The terms for one supplier on the account list. A link to a retired
 * (inactive) entry counts as no link: pay first. Accounts left out = the
 * account list was not read: unknown. */
export function dispatchV2TermsFor(
  accounts: DispatchV2Accounts | null | undefined,
  supplierId: unknown,
): DispatchV2PaymentTerms {
  if (!accounts) return "unknown";
  const entry = accounts.bySupplier.get(String(supplierId ?? ""));
  return dispatchV2PaymentTerms({
    readOk: accounts.readOk,
    linked: !!entry && entry.active,
    onAccount: entry ? entry.on_account : null,
  });
}

