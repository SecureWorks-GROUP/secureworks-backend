// One resolver for the Xero supplier contact on a trade invoice.
//
// Every trade ACCPAY push uses this, including a work-order invoice. The
// work-order path used to look the contact up by email and then create,
// so a trade whose login email differs from the existing supplier contact
// (Jean Crous) hit Xero's unique-name check and the bill stayed local.
//
// Order: cached users.xero_contact_id (re-read, and restored if archived),
// exact email, exact name, then create. An email hit that is only a
// customer, or several email hits that do not name this trade, is not a
// guess. A create Xero refuses because the name already exists is looked
// up again instead of failing the invoice.

import { XeroCooldownError } from "../_shared/xero_cooldown.ts";

export type TradeXeroGet = (
  path: string,
  accessToken: string,
  tenantId: string,
) => Promise<unknown>;

export type TradeXeroPost = (
  path: string,
  accessToken: string,
  tenantId: string,
  body: unknown,
  method?: string,
) => Promise<unknown>;

type TradeContactCacheClient = {
  from: (table: string) => {
    update: (values: { xero_contact_id: string }) => {
      eq: (
        column: string,
        value: string,
      ) => Promise<{ error: { message?: string } | null }>;
    };
  };
};

export type TradeXeroSupplierContactArgs = {
  userId?: string | null;
  name?: string | null;
  email?: string | null;
  cachedContactId?: string | null;
  accessToken: string;
  tenantId: string;
};

export type TradeXeroSupplierDeps = {
  xeroGet: TradeXeroGet;
  xeroPost: TradeXeroPost;
};

type XeroContact = {
  ContactID?: string;
  Name?: string;
  ContactStatus?: string;
  IsSupplier?: boolean;
  IsCustomer?: boolean;
};

export function xeroContactWherePath(field: string, value: string): string {
  const escaped = escapeXeroLiteral(value);
  return "/Contacts?where=" + encodeURIComponent(`${field}=="${escaped}"`);
}

function xeroContactNameFoldedWhere(name: string): string {
  const escaped = escapeXeroLiteral(name.toLowerCase());
  // Name is optional. ToLower() is a method, so it needs the null guard
  // Xero requires before a method on an optional field.
  return "/Contacts?where=" +
    encodeURIComponent(`Name!=null AND Name.ToLower()=="${escaped}"`);
}

function escapeXeroLiteral(value: string): string {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function normaliseTradeContactName(
  value: string | null | undefined,
): string {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function contactStatus(contact: XeroContact): string {
  return String(contact.ContactStatus || "").toUpperCase();
}

function asContact(row: unknown): XeroContact | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  if (typeof record.ContactID !== "string" || !record.ContactID) return null;
  return {
    ContactID: record.ContactID,
    Name: typeof record.Name === "string" ? record.Name : undefined,
    ContactStatus: typeof record.ContactStatus === "string"
      ? record.ContactStatus
      : undefined,
    IsSupplier: typeof record.IsSupplier === "boolean"
      ? record.IsSupplier
      : undefined,
    IsCustomer: typeof record.IsCustomer === "boolean"
      ? record.IsCustomer
      : undefined,
  };
}

function contactList(payload: unknown): XeroContact[] {
  if (!payload || typeof payload !== "object") return [];
  const contacts = (payload as { Contacts?: unknown }).Contacts;
  if (!Array.isArray(contacts)) return [];
  return contacts.flatMap((row) => {
    const contact = asContact(row);
    return contact ? [contact] : [];
  });
}

function createdContactId(payload: unknown): string | null {
  return contactList(payload)[0]?.ContactID ?? null;
}

function isCustomerOnly(contact: XeroContact): boolean {
  return contact.IsCustomer === true && contact.IsSupplier !== true;
}

/**
 * Pick the supplier contact out of one Xero lookup page.
 * A single usable contact is that contact. Several contacts are used only
 * when one of them is this trade's name, or exactly one is a supplier.
 * A customer who is not a supplier is never chosen on the email alone.
 */
export function chooseTradeSupplierContact(
  contacts: readonly XeroContact[] | null | undefined,
  tradeName: string,
): XeroContact | null {
  const list = (contacts || []).filter((contact) => contact?.ContactID);
  if (list.length === 0) return null;

  const wanted = normaliseTradeContactName(tradeName);
  const nameMatches = wanted
    ? list.filter((contact) =>
      normaliseTradeContactName(contact.Name) === wanted
    )
    : [];
  let pool = nameMatches.length > 0 ? nameMatches : list;
  if (nameMatches.length === 0) {
    const notCustomers = pool.filter((contact) => !isCustomerOnly(contact));
    if (notCustomers.length === 0) return null;
    pool = notCustomers;
  }

  const active = pool.filter((contact) => contactStatus(contact) === "ACTIVE");
  const ranked = active.length > 0 ? active : pool;
  if (ranked.length === 1) return ranked[0];

  const suppliers = ranked.filter((contact) => contact.IsSupplier === true);
  if (suppliers.length === 1) return suppliers[0];
  if (nameMatches.length > 0) return ranked[0];
  return null;
}

function contactNameAlreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /contact name/i.test(message) &&
    /(unique|already exists)/i.test(message);
}

async function activateArchivedTradeContact(
  contact: XeroContact,
  args: TradeXeroSupplierContactArgs,
  deps: TradeXeroSupplierDeps,
): Promise<string> {
  if (contactStatus(contact) === "ARCHIVED") {
    await deps.xeroPost("/Contacts", args.accessToken, args.tenantId, {
      Contacts: [{ ContactID: contact.ContactID, ContactStatus: "ACTIVE" }],
    }, "POST");
  }
  return String(contact.ContactID);
}

async function lookupTradeSupplierContact(
  path: string,
  tradeName: string,
  args: TradeXeroSupplierContactArgs,
  deps: TradeXeroSupplierDeps,
): Promise<string | null> {
  const found = await deps.xeroGet(path, args.accessToken, args.tenantId);
  const chosen = chooseTradeSupplierContact(contactList(found), tradeName);
  if (!chosen) return null;
  return await activateArchivedTradeContact(chosen, args, deps);
}

async function lookupTradeSupplierByName(
  tradeName: string,
  args: TradeXeroSupplierContactArgs,
  deps: TradeXeroSupplierDeps,
  folded: boolean,
): Promise<string | null> {
  const path = folded
    ? xeroContactNameFoldedWhere(tradeName)
    : xeroContactWherePath("Name", tradeName);
  return await lookupTradeSupplierContact(path, tradeName, args, deps);
}

export async function resolveTradeXeroSupplierContact(
  client: TradeContactCacheClient,
  args: TradeXeroSupplierContactArgs,
  deps: TradeXeroSupplierDeps,
): Promise<string | null> {
  const cachedContactId = (args.cachedContactId || "").trim();
  // A cached id goes stale when the supplier is archived. Returning it
  // blind makes the bill fail with "contact has been archived".
  if (cachedContactId) {
    try {
      const cached = await deps.xeroGet(
        `/Contacts/${encodeURIComponent(cachedContactId)}`,
        args.accessToken,
        args.tenantId,
      );
      const contact = contactList(cached)[0];
      if (contact?.ContactID) {
        return await activateArchivedTradeContact(contact, args, deps);
      }
    } catch (error) {
      if (error instanceof XeroCooldownError) throw error;
    }
  }

  const tradeName = (args.name || "Trade").trim() || "Trade";
  const tradeEmail = (args.email || "").trim();
  let xeroContactId: string | null = null;

  if (tradeEmail) {
    try {
      xeroContactId = await lookupTradeSupplierContact(
        xeroContactWherePath("EmailAddress", tradeEmail),
        tradeName,
        args,
        deps,
      );
    } catch (error) {
      if (error instanceof XeroCooldownError) throw error;
    }
  }

  if (!xeroContactId && tradeName) {
    try {
      xeroContactId = await lookupTradeSupplierByName(
        tradeName,
        args,
        deps,
        false,
      );
    } catch (error) {
      if (error instanceof XeroCooldownError) throw error;
    }
  }

  if (!xeroContactId) {
    try {
      const createRes = await deps.xeroPost(
        "/Contacts",
        args.accessToken,
        args.tenantId,
        {
          Contacts: [{
            Name: tradeName,
            EmailAddress: tradeEmail || undefined,
            IsSupplier: true,
          }],
        },
        "PUT",
      );
      xeroContactId = createdContactId(createRes);
    } catch (error) {
      if (error instanceof XeroCooldownError) throw error;
      if (!contactNameAlreadyExists(error)) throw error;
      // The name is already a contact the exact query missed (a race, or
      // a case difference). Read it again. A second create would only
      // repeat the refusal and leave the invoice local.
      try {
        xeroContactId = await lookupTradeSupplierByName(
          tradeName,
          args,
          deps,
          false,
        );
      } catch (lookupError) {
        if (lookupError instanceof XeroCooldownError) throw lookupError;
      }
      if (!xeroContactId) {
        try {
          xeroContactId = await lookupTradeSupplierByName(
            tradeName,
            args,
            deps,
            true,
          );
        } catch (lookupError) {
          if (lookupError instanceof XeroCooldownError) throw lookupError;
        }
      }
      if (!xeroContactId) throw error;
    }
  }

  if (xeroContactId && args.userId) {
    const { error } = await client.from("users").update({
      xero_contact_id: xeroContactId,
    }).eq("id", args.userId);
    if (error) {
      console.error(
        "[ops-api] trade Xero contact cache write failed:",
        error.message || error,
      );
    }
  }

  return xeroContactId;
}
