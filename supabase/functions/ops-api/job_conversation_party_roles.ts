// The job conversation's business_events messages, with who sent each one and
// who received it (gap plan B-6, migration 20261005200000_context_party_roles).
//
// getJobConversation (index.ts) reads message-shaped business_events rows on
// the job and maps each through businessEventConversationMessage. Every
// message carries sender_role, recipient_role, audience and a label. A crew
// or staff row (audience internal: L1d's label, or party_roles saying so) is
// shown as "internal: crew" / "internal: staff" with direction internal, so
// no reader takes it for a message in the customer's thread; the provider's
// own direction stays on provider_direction.
//
// Pure: no I/O.

import {
  type MessagePartyRoles,
  readMessagePartyRoles,
} from "../_shared/evidence/party_roles.ts";

/** The business_events columns the conversation reads, the role keys included. */
export const CONVERSATION_EVENT_SELECT =
  "id, event_type, source, occurred_at, payload, correlation_id, attribution_status, attribution_step, " +
  "placement_rule:metadata->>placement_rule, party_roles:metadata->party_roles, audience:metadata->>audience, " +
  "recipient_role:metadata->>recipient_role";

/** The roles fields every conversation message carries. */
export function conversationRoleFields(roles: MessagePartyRoles) {
  return {
    sender_role: roles.sender_role,
    recipient_role: roles.recipient_role,
    audience: roles.audience,
    internal: roles.internal,
    party_label: roles.label,
    party_roles_basis: roles.basis,
  };
}

/** One business_events row as a conversation message. */
// deno-lint-ignore no-explicit-any
export function businessEventConversationMessage(r: any, jobId: string) {
  // deno-lint-ignore no-explicit-any
  const p: any = r?.payload || {};
  const eventType = String(r?.event_type || "");
  const channel: string = eventType.includes("sms")
    ? "sms"
    : eventType.includes("call")
    ? "call"
    : eventType.includes("note")
    ? "note"
    : "email";
  const providerDirection: string = eventType.endsWith("_in") ||
      eventType === "client.reply" || eventType === "ghl.note_added" ||
      eventType === "supplier.email_in"
    ? "inbound"
    : "outbound";
  const roles = readMessagePartyRoles({
    party_roles: r?.party_roles ?? null,
    audience: r?.audience ?? null,
    recipient_role: r?.recipient_role ?? null,
  });
  const body = String(
    p.body || p.text || p.message || p.note_preview || p.note_text ||
      p.body_preview || "",
  );
  return {
    id: `bev:${r.id}`,
    job_id: jobId,
    channel,
    // An internal row is never inbound or outbound customer traffic.
    direction: roles.internal ? "internal" : providerDirection,
    provider_direction: providerDirection,
    occurred_at: r.occurred_at,
    author: p.from || p.sender_name || p.added_by || null,
    body,
    preview: body.slice(0, 500),
    subject: p.subject || null,
    source_system: "business_events",
    source_ref: r.id,
    attribution_status: r.attribution_status ?? null,
    attribution_step: r.attribution_step ?? null,
    placement_rule: r.placement_rule ?? null,
    ...conversationRoleFields(roles),
    ...(roles.internal ? { label: roles.label } : {}),
  };
}

/** The dossier's raw business_events columns, with the role keys aliased in. */
export const DOSSIER_EVENT_SELECT =
  "id, event_type, source, occurred_at, payload, correlation_id, party_roles:metadata->party_roles, " +
  "audience:metadata->>audience, recipient_role:metadata->>recipient_role";

/**
 * One raw business_events row for the dossier: the select's role aliases are
 * folded into the same role fields the conversation carries, on message rows
 * only (rows with a party_roles stamp or the ladder's internal label). Any
 * other row comes back with exactly its original columns.
 */
// deno-lint-ignore no-explicit-any
export function dossierEventWithPartyRoles(r: any) {
  const { party_roles, audience, recipient_role, ...row } = r || {};
  const roles = readMessagePartyRoles({
    party_roles,
    audience,
    recipient_role,
  });
  if (roles.basis === "none") return row;
  return {
    ...row,
    ...conversationRoleFields(roles),
    ...(roles.internal ? { label: roles.label } : {}),
  };
}
