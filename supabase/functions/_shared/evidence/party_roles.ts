// Who sent a message and who received it, as the readers show it (gap plan
// B-6, migration 20261005200000_context_party_roles).
//
// The database stamps metadata.party_roles on every message row (texts,
// calls, call transcripts, emails): sender_role, recipient_role,
// counterpart_role, basis and audience, with roles customer, crew, staff,
// supplier, insurer_builder or unknown. The attribution ladder (L1d,
// 20261005090000) separately labels crew and staff texts it keeps on their
// job: metadata.audience internal with metadata.recipient_role crew or staff.
//
// This module is the one place a reader turns those into what it shows. An
// internal row is shown as "internal: crew" or "internal: staff" and is never
// a message in the customer's thread. The ladder's internal label wins over
// anything else, so a row labelled before its party_roles stamp still reads
// internal.
//
// Pure: no I/O.

export type PartyRole =
  | "customer"
  | "crew"
  | "staff"
  | "supplier"
  | "insurer_builder"
  | "unknown";

/** Which thread a message belongs to. Only "customer" is the customer's thread. */
export type MessageAudience =
  | "customer"
  | "internal"
  | "other_party"
  | "unknown";

export interface MessagePartyRoles {
  sender_role: PartyRole;
  recipient_role: PartyRole;
  /** The other side from us (the customer, the crew member, the supplier...). */
  counterpart_role: PartyRole;
  audience: MessageAudience;
  /** True for crew and staff communication: never a customer thread message. */
  internal: boolean;
  /** "internal: crew" / "internal: staff" for internal rows, else "customer to staff" and the like. */
  label: string;
  /** How the roles were decided (party_roles.basis), or "none" when the row carries no roles yet. */
  basis: string;
}

const ROLES: ReadonlySet<string> = new Set([
  "customer",
  "crew",
  "staff",
  "supplier",
  "insurer_builder",
  "unknown",
]);
const AUDIENCES: ReadonlySet<string> = new Set([
  "customer",
  "internal",
  "other_party",
  "unknown",
]);

function role(value: unknown): PartyRole {
  return typeof value === "string" && ROLES.has(value)
    ? value as PartyRole
    : "unknown";
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const ROLE_WORDS: Record<PartyRole, string> = {
  customer: "customer",
  crew: "crew",
  staff: "staff",
  supplier: "supplier",
  insurer_builder: "insurer or builder",
  unknown: "unknown",
};

/** Plain words for a role: "insurer or builder" for insurer_builder. */
export function partyRoleWords(r: PartyRole): string {
  return ROLE_WORDS[r] ?? "unknown";
}

function internalLabel(counterpart: PartyRole): string {
  return `internal: ${counterpart === "crew" ? "crew" : "staff"}`;
}

/**
 * The roles a reader shows for one business_events row, from its metadata.
 * Accepts the whole metadata object, or a select that aliased the three keys
 * (party_roles, audience, recipient_role) onto one object.
 */
export function readMessagePartyRoles(metadata: unknown): MessagePartyRoles {
  const m = obj(metadata);
  const ladderAudience = typeof m.audience === "string" ? m.audience : null;
  const ladderRole = typeof m.recipient_role === "string"
    ? m.recipient_role
    : null;

  // L1d's label: a crew or staff text kept on its job. Copied, never re-decided.
  if (
    ladderAudience === "internal" &&
    (ladderRole === "crew" || ladderRole === "staff")
  ) {
    const r = ladderRole as PartyRole;
    return {
      sender_role: "staff",
      recipient_role: r,
      counterpart_role: r,
      audience: "internal",
      internal: true,
      label: internalLabel(r),
      basis: "ladder_internal",
    };
  }

  const pr = obj(m.party_roles);
  if (
    typeof pr.sender_role === "string" || typeof pr.recipient_role === "string"
  ) {
    const sender = role(pr.sender_role);
    const recipient = role(pr.recipient_role);
    const counterpart = role(pr.counterpart_role);
    const given = typeof pr.audience === "string" && AUDIENCES.has(pr.audience)
      ? pr.audience as MessageAudience
      : "unknown";
    // The ladder's other_party label stands even if a stamp says otherwise.
    const audience: MessageAudience = ladderAudience === "other_party"
      ? "other_party"
      : given;
    const internal = audience === "internal";
    return {
      sender_role: sender,
      recipient_role: recipient,
      counterpart_role: counterpart,
      audience,
      internal,
      label: internal
        ? internalLabel(counterpart)
        : `${partyRoleWords(sender)} to ${partyRoleWords(recipient)}`,
      basis: typeof pr.basis === "string" ? pr.basis : "none",
    };
  }

  return {
    sender_role: "unknown",
    recipient_role: "unknown",
    counterpart_role: "unknown",
    audience: ladderAudience === "other_party" ? "other_party" : "unknown",
    internal: false,
    label: "unknown to unknown",
    basis: "none",
  };
}

/**
 * The roles of a message in the CRM's own thread with the job's customer
 * (the GHL conversation cache is read by the job's customer contact): the
 * customer on one side, us on the other.
 */
export function customerThreadPartyRoles(
  direction: string | null | undefined,
): MessagePartyRoles {
  const out = direction === "outbound";
  const sender: PartyRole = out ? "staff" : "customer";
  const recipient: PartyRole = out ? "customer" : "staff";
  return {
    sender_role: sender,
    recipient_role: recipient,
    counterpart_role: "customer",
    audience: "customer",
    internal: false,
    label: `${sender} to ${recipient}`,
    basis: "customer_crm_thread",
  };
}

/** A staff note on the job: staff writing for staff. */
export function staffNotePartyRoles(): MessagePartyRoles {
  return {
    sender_role: "staff",
    recipient_role: "staff",
    counterpart_role: "staff",
    audience: "internal",
    internal: true,
    label: "internal: staff",
    basis: "staff_note",
  };
}
