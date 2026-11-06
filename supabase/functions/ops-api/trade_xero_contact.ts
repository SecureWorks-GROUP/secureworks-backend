// One resolver for the Xero supplier contact on a trade invoice.
//
// A cached users.xero_contact_id is used only when that Xero contact still
// identifies this user. users.name is often only a first name, so each of
// its words must be a whole word in the contact name (or a prefix of one,
// and only when the word is at least four letters). Email match remains
// the other way. Anything else is a stale or wrong link.
// The push is refused. The cache is not overwritten and the contact is not
// unarchived or replaced.
//
// An email hit whose name is not this trade is not chosen and not cached.
// The name lookup still runs. If that finds nothing, the push is refused
// rather than creating a second contact: the email already belongs to
// someone else. Several name matches, with none standing out, are refused
// the same way. Unarchive runs only after that identity check has passed.

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

export type TradeXeroContactEvidence = "email" | "name" | "created";

type CacheAuditRow = {
  event_type: "trade.xero_contact_linked";
  source: string;
  entity_type: "user";
  entity_id: string;
  payload: {
    user_id: string;
    actor: string | null;
    old_xero_contact_id: string | null;
    new_xero_contact_id: string;
    evidence: TradeXeroContactEvidence;
    contact_name: string | null;
  };
  schema_version: "1.0";
};

type TradeContactCacheClient = {
  from: (table: string) => {
    update: (values: { xero_contact_id: string }) => {
      eq: (
        column: string,
        value: string,
      ) => Promise<{ error: { message?: string } | null }>;
    };
    insert: (
      row: CacheAuditRow,
    ) => Promise<{ error: { message?: string } | null }>;
  };
};

export type TradeXeroSupplierContactArgs = {
  userId?: string | null;
  name?: string | null;
  email?: string | null;
  cachedContactId?: string | null;
  /** Which push asked. Recorded on the cache-change audit row. */
  source?: string | null;
  /** Who asked. Defaults to the user whose cache is written. */
  actor?: string | null;
  accessToken: string;
  tenantId: string;
};

export type TradeXeroSupplierDeps = {
  xeroGet: TradeXeroGet;
  xeroPost: TradeXeroPost;
};

export type TradeXeroSupplierContactCode =
  | "stale_xero_contact"
  | "xero_contact_ambiguous"
  | "xero_contact_email_conflict";

export class TradeXeroSupplierContactError extends Error {
  readonly code: TradeXeroSupplierContactCode;

  constructor(code: TradeXeroSupplierContactCode, message: string) {
    super(message);
    this.name = "TradeXeroSupplierContactError";
    this.code = code;
  }
}

type XeroContact = {
  ContactID?: string;
  Name?: string;
  EmailAddress?: string;
  ContactStatus?: string;
  IsSupplier?: boolean;
  IsCustomer?: boolean;
};

export type TradeContactPick =
  | { status: "chosen"; contact: XeroContact }
  | { status: "none" }
  | { status: "conflict"; contacts: XeroContact[] }
  | { status: "ambiguous" };

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

/** Letters and digits only. "t/a" and "B&D" become separate words, not one token. */
export function tradeContactNameWords(
  value: string | null | undefined,
): string[] {
  return normaliseTradeContactName(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * A user's name word matches a contact word when it is that whole word, or
 * the start of a longer word. The prefix form requires four letters, so a
 * short name cannot latch onto a company word ("al" onto "allied", "in"
 * onto "investments") and a fragment in the middle of a word never matches
 * ("ama" inside "jaiama").
 */
export function tradeNameTokenMatchesWord(
  token: string,
  word: string,
): boolean {
  if (word === token) return true;
  return token.length >= 4 && word.startsWith(token);
}

/** Every word of the user's name must match some word of the contact name. */
export function tradeContactNameMatches(
  userName: string | null | undefined,
  contactName: string | null | undefined,
): boolean {
  const tokens = tradeContactNameWords(userName);
  if (tokens.length === 0) return false;
  const words = tradeContactNameWords(contactName);
  return tokens.every((token) =>
    words.some((word) => tradeNameTokenMatchesWord(token, word))
  );
}

function normaliseEmail(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
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
    EmailAddress: typeof record.EmailAddress === "string"
      ? record.EmailAddress
      : undefined,
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

/** Name match wins. Email match is the other way a cached contact is still this user. */
export function tradeContactIdentity(
  contact: XeroContact,
  tradeName: string,
  tradeEmail: string,
): "name" | "email" | null {
  if (tradeContactNameMatches(tradeName, contact.Name)) return "name";
  const wantedEmail = normaliseEmail(tradeEmail);
  if (wantedEmail && normaliseEmail(contact.EmailAddress) === wantedEmail) {
    return "email";
  }
  return null;
}

export type TradeContactLinkVerdict = {
  result: "accept" | "refuse";
  by: "name" | "email" | null;
};

/** Same rule as a cached link. Used by the read-only preflight. */
export function classifyTradeContactLink(input: {
  name?: string | null;
  email?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
}): TradeContactLinkVerdict {
  const by = tradeContactIdentity(
    {
      ContactID: "preflight",
      Name: input.contactName || undefined,
      EmailAddress: input.contactEmail || undefined,
    },
    input.name || "",
    input.email || "",
  );
  return { result: by ? "accept" : "refuse", by };
}

function standout(contacts: readonly XeroContact[]): XeroContact | null {
  const active = contacts.filter((contact) =>
    contactStatus(contact) === "ACTIVE"
  );
  const ranked = active.length > 0 ? active : contacts;
  if (ranked.length === 1) return ranked[0];
  const suppliers = ranked.filter((contact) => contact.IsSupplier === true);
  if (suppliers.length === 1) return suppliers[0];
  return null;
}

/**
 * Email: only a contact whose name is this trade. A hit under another name
 * is a conflict, not a choice. Name: the query is already by name. Several
 * hits with none standing out (one active, or one supplier) are ambiguous.
 */
export function pickTradeSupplierContact(
  contacts: readonly XeroContact[] | null | undefined,
  tradeName: string,
  via: "email" | "name",
): TradeContactPick {
  const list = (contacts || []).filter((contact) => contact?.ContactID);
  if (list.length === 0) return { status: "none" };

  const wanted = normaliseTradeContactName(tradeName);
  const named = wanted
    ? list.filter((contact) => tradeContactNameMatches(tradeName, contact.Name))
    : [];
  if (named.length === 0) {
    return via === "email"
      ? { status: "conflict", contacts: list }
      : { status: "none" };
  }
  const pool = named;
  if (pool.length === 0) return { status: "none" };
  const chosen = standout(pool);
  if (!chosen) return { status: "ambiguous" };
  return { status: "chosen", contact: chosen };
}

function contactNameAlreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /contact name/i.test(message) &&
    /(unique|already exists)/i.test(message);
}

function staleLinkMessage(
  userId: string | null | undefined,
  contactId: string,
  contactName: string | null | undefined,
): string {
  const who = String(userId || "").trim() || "unknown";
  return `stale or wrong Xero link for user ${who}: cached contact ${contactId} '${
    contactName ?? ""
  }'`;
}

function ambiguousMessage(tradeName: string): string {
  const who = tradeName || "this trade";
  return `Several Xero contacts are named '${who}' and none stands out. Not choosing one.`;
}

function emailConflictMessage(
  email: string,
  tradeName: string,
  contacts: readonly XeroContact[],
): string {
  const names = [
    ...new Set(contacts.map((contact) => contact.Name || "unnamed")),
  ].join(", ");
  const who = tradeName || "this trade";
  return `Xero email ${email} belongs to '${names}', not ${who}. Not creating another contact.`;
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

async function lookupContacts(
  path: string,
  args: TradeXeroSupplierContactArgs,
  deps: TradeXeroSupplierDeps,
): Promise<XeroContact[]> {
  const found = await deps.xeroGet(path, args.accessToken, args.tenantId);
  return contactList(found);
}

export async function resolveTradeXeroSupplierContact(
  client: TradeContactCacheClient,
  args: TradeXeroSupplierContactArgs,
  deps: TradeXeroSupplierDeps,
): Promise<string | null> {
  const cachedContactId = (args.cachedContactId || "").trim();
  const tradeName = (args.name || "").trim();
  const tradeEmail = (args.email || "").trim();
  const createName = tradeName || "Trade";

  const remember = async (
    contactId: string,
    evidence: TradeXeroContactEvidence,
    contactName: string | null,
  ): Promise<string> => {
    if (!args.userId || contactId === cachedContactId) return contactId;
    const row: CacheAuditRow = {
      event_type: "trade.xero_contact_linked",
      source: String(args.source || "").trim() ||
        "ops-api/resolveTradeXeroSupplierContact",
      entity_type: "user",
      entity_id: args.userId,
      payload: {
        user_id: args.userId,
        actor: String(args.actor || "").trim() || args.userId,
        old_xero_contact_id: cachedContactId || null,
        new_xero_contact_id: contactId,
        evidence,
        contact_name: contactName,
      },
      schema_version: "1.0",
    };
    // business_events is the operational event row this push already uses
    // (trade.xero_push_failed). capture_business_event is the evidence
    // writer and is keyed on a provider message, so it is the wrong store.
    const { error: auditError } = await client.from("business_events").insert(
      row,
    );
    if (auditError) {
      throw new Error(
        `Could not record the Xero contact link for user ${args.userId}: ${
          auditError.message || auditError
        }`,
      );
    }
    const { error } = await client.from("users").update({
      xero_contact_id: contactId,
    }).eq("id", args.userId);
    if (error) {
      throw new Error(
        `Could not store the Xero contact link for user ${args.userId}: ${
          error.message || error
        }`,
      );
    }
    return contactId;
  };

  const useChosen = async (
    contact: XeroContact,
    evidence: TradeXeroContactEvidence,
  ): Promise<string> => {
    const contactId = await activateArchivedTradeContact(contact, args, deps);
    return await remember(contactId, evidence, contact.Name || null);
  };

  if (cachedContactId) {
    let contact: XeroContact | undefined;
    try {
      const cached = await deps.xeroGet(
        `/Contacts/${encodeURIComponent(cachedContactId)}`,
        args.accessToken,
        args.tenantId,
      );
      contact = contactList(cached)[0];
    } catch (error) {
      if (error instanceof XeroCooldownError) throw error;
      throw error;
    }
    if (!contact?.ContactID) {
      throw new TradeXeroSupplierContactError(
        "stale_xero_contact",
        staleLinkMessage(args.userId, cachedContactId, ""),
      );
    }
    if (!tradeContactIdentity(contact, tradeName, tradeEmail)) {
      throw new TradeXeroSupplierContactError(
        "stale_xero_contact",
        staleLinkMessage(args.userId, contact.ContactID, contact.Name),
      );
    }
    // Same id, already cached. Do not write users again. Unarchive only
    // because the name or email still identifies this user.
    return await activateArchivedTradeContact(contact, args, deps);
  }

  let emailConflict: XeroContact[] = [];
  if (tradeEmail) {
    let contacts: XeroContact[];
    try {
      contacts = await lookupContacts(
        xeroContactWherePath("EmailAddress", tradeEmail),
        args,
        deps,
      );
    } catch (error) {
      if (error instanceof XeroCooldownError) throw error;
      throw error;
    }
    const pick = pickTradeSupplierContact(contacts, tradeName, "email");
    if (pick.status === "ambiguous") {
      throw new TradeXeroSupplierContactError(
        "xero_contact_ambiguous",
        ambiguousMessage(tradeName),
      );
    }
    if (pick.status === "chosen") return await useChosen(pick.contact, "name");
    if (pick.status === "conflict") emailConflict = pick.contacts;
  }

  const byName = async (folded: boolean): Promise<TradeContactPick> => {
    const contacts = await lookupContacts(
      folded
        ? xeroContactNameFoldedWhere(createName)
        : xeroContactWherePath("Name", createName),
      args,
      deps,
    );
    return pickTradeSupplierContact(contacts, createName, "name");
  };

  let named: TradeContactPick;
  try {
    named = await byName(false);
  } catch (error) {
    if (error instanceof XeroCooldownError) throw error;
    throw error;
  }
  if (named.status === "ambiguous") {
    throw new TradeXeroSupplierContactError(
      "xero_contact_ambiguous",
      ambiguousMessage(createName),
    );
  }
  if (named.status === "chosen") return await useChosen(named.contact, "name");

  if (emailConflict.length > 0) {
    throw new TradeXeroSupplierContactError(
      "xero_contact_email_conflict",
      emailConflictMessage(tradeEmail, tradeName, emailConflict),
    );
  }

  let xeroContactId: string | null = null;
  try {
    const createRes = await deps.xeroPost(
      "/Contacts",
      args.accessToken,
      args.tenantId,
      {
        Contacts: [{
          Name: createName,
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
    const recover = async (folded: boolean): Promise<string | null> => {
      const pick = await byName(folded);
      if (pick.status === "ambiguous") {
        throw new TradeXeroSupplierContactError(
          "xero_contact_ambiguous",
          ambiguousMessage(createName),
        );
      }
      if (pick.status === "chosen") {
        return await useChosen(pick.contact, "name");
      }
      return null;
    };
    xeroContactId = await recover(false);
    if (!xeroContactId) xeroContactId = await recover(true);
    if (!xeroContactId) throw error;
    return xeroContactId;
  }

  if (!xeroContactId) return null;
  return await remember(xeroContactId, "created", createName);
}
