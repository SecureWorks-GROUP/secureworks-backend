// Debt Workshop: who pays an invoice (the payer), and which messages are theirs.
//
// On a shared fence one job has several payers: the job's client (share A, the primary
// job_contacts row) and each neighbour (share B, C, ...; a non-primary job_contacts row).
// An invoice belongs to ONE of them, and the chase must use that person's own contact,
// phone and conversation, never the job's (which is the primary client's).
//
// How the payer is found, in order (never by name alone: names differ in spacing and
// spelling, and a neighbour can be filed under another name in GoHighLevel):
//   1. the job_contacts row whose xero_contact_id is the invoice's Xero contact;
//   2. the job_contacts row whose contact_label is the reference's share letter
//      (SWF-26624-B-BAL is share B);
//   3. the job's client, when the invoice's Xero contact is the job's Xero contact;
//   4. the job's client, when the reference has no letter (or letter A) and the job has
//      no neighbour rows at all, so nobody else could owe it.
// Otherwise the payer is not resolved: the invoice's Xero name only, nothing to text.
//
// Pure functions only: no reads or writes here.

import {
  parseReference,
  shareLabel,
  type WsInvoice,
  type WsJob,
} from "./debt_ws_rules.ts";

/** One active job_contacts row (a payer on a shared job). */
export interface WsJobContact {
  id: string;
  job_id: string;
  contact_type: string | null;
  contact_label: string | null;
  is_primary: boolean | null;
  status: string | null;
  client_name: string | null;
  client_phone: string | null;
  client_email: string | null;
  xero_contact_id: string | null;
  ghl_contact_id: string | null;
}

export type PayerResolvedBy =
  | "xero_contact"
  | "share_letter"
  | "job_client"
  | "single_payer_job"
  | "account_job"
  | null;

/** The person who owes one invoice, with their own contact details. */
export interface PayerContact {
  name: string;
  phone: string | null;
  email: string | null;
  /** Their own GoHighLevel contact; for the primary it falls back to jobs.ghl_contact_id. */
  ghl_contact_id: string | null;
  /** The job_contacts row, when there is one. */
  contact_row_id: string | null;
  /** The share letter: "A", "B", ... or "main" when the reference has none. */
  label: string;
  /** The job's own client (share A or a single-payer job). */
  is_primary: boolean;
  resolved_by: PayerResolvedBy;
}

/** Collapses runs of spaces ("Peter  Johnson" reads "Peter Johnson"). */
export function tidyName(name: unknown): string {
  return String(name ?? "").replace(/\s+/g, " ").trim();
}

const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** A contact row counts while it is active (an old row with no status counts too). */
export function activeContacts(rows: WsJobContact[]): WsJobContact[] {
  return rows.filter((r) => !r.status || lower(r.status) === "active");
}

function fromRow(
  row: WsJobContact,
  job: WsJob | null,
  label: string,
  resolvedBy: PayerResolvedBy,
): PayerContact {
  const primary = row.is_primary === true;
  return {
    name: tidyName(row.client_name) ||
      (primary ? tidyName(job?.client_name) : "") || "Unknown payer",
    phone: row.client_phone || (primary ? job?.client_phone ?? null : null),
    email: row.client_email || (primary ? job?.client_email ?? null : null),
    ghl_contact_id: row.ghl_contact_id ||
      (primary ? job?.ghl_contact_id ?? null : null),
    contact_row_id: row.id,
    label: row.contact_label ? String(row.contact_label).toUpperCase() : label,
    is_primary: primary,
    resolved_by: resolvedBy,
  };
}

function jobClient(
  job: WsJob,
  primaryRow: WsJobContact | null,
  label: string,
  resolvedBy: PayerResolvedBy,
): PayerContact {
  if (primaryRow) return fromRow(primaryRow, job, label, resolvedBy);
  return {
    name: tidyName(job.client_name) || "Unknown payer",
    phone: job.client_phone ?? null,
    email: job.client_email ?? null,
    ghl_contact_id: job.ghl_contact_id ?? null,
    contact_row_id: null,
    label,
    is_primary: true,
    resolved_by: resolvedBy,
  };
}

/**
 * The payer of one invoice. `lane` "account" (a company invoice) keeps the job's own
 * contact: company invoices are never texted, they go on the Monday statement.
 */
export function resolvePayer(
  inv: Pick<
    WsInvoice,
    "xero_contact_id" | "contact_name" | "reference"
  >,
  job: WsJob | null,
  rows: WsJobContact[],
  lane: "homeowner" | "account" = "homeowner",
): PayerContact {
  const letter = parseReference(inv.reference).letter ?? "main";
  const contacts = activeContacts(rows);
  const primaryRow = contacts.find((r) => r.is_primary === true) ?? null;
  if (lane === "account") {
    return {
      name: tidyName(inv.contact_name) || tidyName(job?.client_name) ||
        "Unknown payer",
      phone: job?.client_phone ?? null,
      email: job?.client_email ?? null,
      ghl_contact_id: job?.ghl_contact_id ?? null,
      contact_row_id: null,
      label: letter,
      is_primary: true,
      resolved_by: job ? "account_job" : null,
    };
  }
  const xero = lower(inv.xero_contact_id);
  // 1. The row on this job that carries the invoice's Xero contact.
  if (xero) {
    const byXero = contacts.filter((r) => lower(r.xero_contact_id) === xero);
    if (byXero.length === 1) {
      return fromRow(byXero[0], job, letter, "xero_contact");
    }
  }
  // 2. The row whose label is the reference's share letter.
  if (letter !== "main") {
    const byLabel = contacts.filter((r) =>
      String(r.contact_label ?? "").toUpperCase() === letter
    );
    if (byLabel.length === 1) {
      return fromRow(byLabel[0], job, letter, "share_letter");
    }
  }
  if (job) {
    // 3. The invoice's Xero contact is the job's own Xero contact: the job's client.
    if (xero && lower(job.xero_contact_id) === xero) {
      return jobClient(job, primaryRow, letter, "job_client");
    }
    // 4. A single-payer job: no neighbour rows and no neighbour letter on the reference.
    const neighbours = contacts.filter((r) => r.is_primary !== true);
    if ((letter === "main" || letter === "A") && !neighbours.length) {
      return jobClient(job, primaryRow, letter, "single_payer_job");
    }
  }
  return {
    name: tidyName(inv.contact_name) || "Unknown payer",
    phone: null,
    email: null,
    ghl_contact_id: null,
    contact_row_id: null,
    label: letter,
    is_primary: false,
    resolved_by: null,
  };
}

// ── The payer's messages ──

const digits9 = (s: unknown) => String(s ?? "").replace(/\D/g, "").slice(-9);

/** The GoHighLevel contact a message is with, when it carries one. */
export function messageContactId(m: Record<string, unknown>): string | null {
  const id = m.contact_id ?? m.ghl_contact_id ?? null;
  return typeof id === "string" && id ? id : null;
}

function messageEmails(m: Record<string, unknown>): string[] {
  const raw = m.email_addresses;
  return Array.isArray(raw) ? raw.map(lower).filter(Boolean) : [];
}

/** One party a message may be with: a payer on the job, or the job's client. */
export interface MessageParty {
  name: string;
  ghl_contact_id: string | null;
  phone: string | null;
  email: string | null;
}

/** True when the message is with this party: its GoHighLevel contact, phone or email. */
export function messageIsWith(
  m: Record<string, unknown>,
  party: Pick<MessageParty, "ghl_contact_id" | "phone" | "email">,
): boolean {
  const cid = messageContactId(m);
  if (cid && party.ghl_contact_id && cid === party.ghl_contact_id) return true;
  const email = lower(party.email);
  if (email && messageEmails(m).includes(email)) return true;
  const phone = digits9(party.phone);
  return phone.length === 9 && digits9(m.phone) === phone;
}

/** The parties on a job: its contact rows, and the job's client when it has no primary row. */
export function partiesOf(
  job: WsJob | null,
  rows: WsJobContact[],
): MessageParty[] {
  const contacts = activeContacts(rows);
  const out: MessageParty[] = contacts.map((r) => ({
    name: tidyName(r.client_name) ||
      (r.is_primary ? tidyName(job?.client_name) : "") || "Unknown",
    ghl_contact_id: r.ghl_contact_id ||
      (r.is_primary ? job?.ghl_contact_id ?? null : null),
    phone: r.client_phone || (r.is_primary ? job?.client_phone ?? null : null),
    email: r.client_email || (r.is_primary ? job?.client_email ?? null : null),
  }));
  if (job && !contacts.some((r) => r.is_primary === true)) {
    out.push({
      name: tidyName(job.client_name) || "Unknown",
      ghl_contact_id: job.ghl_contact_id ?? null,
      phone: job.client_phone ?? null,
      email: job.client_email ?? null,
    });
  }
  return out;
}

/**
 * Splits a job's conversation for one payer. `payer_messages` are the payer's own (empty
 * when the payer has no GoHighLevel contact: reason "payer_not_linked"). Every message in
 * `all_messages` is marked with the party it is with (party_name, is_payer), so the
 * screen can show the whole job's thread and say whose each message is.
 */
export function splitConversation(
  messages: Record<string, unknown>[],
  payer: PayerContact,
  parties: MessageParty[],
): {
  payer_messages: Record<string, unknown>[];
  all_messages: Record<string, unknown>[];
  reason: "payer_not_linked" | null;
} {
  const linked = !!payer.ghl_contact_id;
  const all = messages.map((m) => {
    const isPayer = linked && messageIsWith(m, payer);
    const other = isPayer
      ? null
      : parties.find((p) =>
        (p.ghl_contact_id || p.email || p.phone) && messageIsWith(m, p)
      );
    return {
      ...m,
      is_payer: isPayer,
      party_name: isPayer ? payer.name : other?.name ?? null,
    };
  });
  return {
    payer_messages: linked ? all.filter((m) => m.is_payer) : [],
    all_messages: all,
    reason: linked ? null : "payer_not_linked",
  };
}

// ── The shares on a job ──

export interface ShareView {
  /** "A", "B", ... or "main" when the references carry no letter. */
  label: string;
  payer_name: string;
  is_primary: boolean;
  /** Amount still owing on this share's open invoices. */
  owing: number;
  /** Nothing owing and at least one invoice paid. */
  paid: boolean;
  invoice_count: number;
}

const DEAD = new Set(["VOIDED", "DELETED", "DRAFT", "SUBMITTED"]);

/**
 * Every share on a job from its invoices (voided, deleted and draft ones left out): the
 * payer's name, what is owing and whether it is paid. One entry per share letter.
 */
export function sharesOf(
  job: WsJob | null,
  history: WsInvoice[],
  rows: WsJobContact[],
): ShareView[] {
  const groups = new Map<string, WsInvoice[]>();
  for (const inv of history) {
    if (DEAD.has(String(inv.status ?? "").toUpperCase())) continue;
    const { letter } = shareLabel(job?.job_number, inv.reference);
    groups.set(letter, [...(groups.get(letter) ?? []), inv]);
  }
  const out: ShareView[] = [];
  for (const [label, invs] of groups) {
    // The newest invoice names the payer (a later balance over an older deposit).
    const latest = [...invs].sort((a, b) =>
      String(b.invoice_date ?? "").localeCompare(String(a.invoice_date ?? ""))
    )[0];
    const payer = resolvePayer(latest, job, rows);
    const owing = Math.round(
      invs.filter((i) =>
        String(i.status ?? "").toUpperCase() === "AUTHORISED"
      )
        .reduce((s, i) => s + Math.round(Number(i.amount_due || 0) * 100), 0),
    ) / 100;
    out.push({
      label,
      payer_name: payer.name,
      is_primary: payer.is_primary,
      owing,
      paid: owing <= 0 &&
        invs.some((i) => String(i.status ?? "").toUpperCase() === "PAID"),
      invoice_count: invs.length,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
