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
import { businessEventTimelineMessage } from "./job_conversation_timeline.ts";

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

/**
 * One business_events row as a conversation message, through the job read's
 * one mapper (job_conversation_timeline.ts), which carries these role fields.
 * Without the customer's addresses an email's customer_party is unknown.
 */
// deno-lint-ignore no-explicit-any
export function businessEventConversationMessage(r: any, jobId: string) {
  return businessEventTimelineMessage(r, jobId, new Set());
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
