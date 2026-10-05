// reporting-api job_context: the business_events part of the job timeline,
// with who sent each message and who received it (gap plan B-6, migration
// 20261005200000_context_party_roles).
//
// A crew or staff row (audience internal) is shown as "internal: crew" /
// "internal: staff" and never counts as customer communication, so
// summary.latest_comms_at is never an internal text. Message rows carry
// sender_role, recipient_role, audience and party_label; other rows are
// unchanged.
//
// Pure: no I/O.

import { readMessagePartyRoles } from "../_shared/evidence/party_roles.ts";

/** The business_events columns job_context reads, the role keys included. */
export const JOB_CONTEXT_EVENT_SELECT =
  "event_type, source, payload, occurred_at, party_roles:metadata->party_roles, " +
  "audience:metadata->>audience, recipient_role:metadata->>recipient_role";

// deno-lint-ignore no-explicit-any
function roles(e: any) {
  return readMessagePartyRoles({
    party_roles: e?.party_roles ?? null,
    audience: e?.audience ?? null,
    recipient_role: e?.recipient_role ?? null,
  });
}

/** One business_events row as a job_context timeline item. */
// deno-lint-ignore no-explicit-any
export function businessEventTimelineItem(e: any) {
  const detail = e?.payload?.message || e?.payload?.changes
    ? JSON.stringify(e.payload.changes || e.payload).slice(0, 200)
    : JSON.stringify(e?.payload || {}).slice(0, 200);
  const base = {
    type: e?.event_type,
    who: e?.source || "system",
    when: e?.occurred_at,
    detail,
    source: "business_events",
  };
  const r = roles(e);
  if (r.basis === "none") return base;
  return {
    ...base,
    // An internal row names who it was between, never the customer.
    who: r.internal ? r.label : base.who,
    sender_role: r.sender_role,
    recipient_role: r.recipient_role,
    audience: r.audience,
    internal: r.internal,
    party_label: r.label,
  };
}

/** The customer communication event types summary.latest_comms_at reads. */
const COMMS_EVENT_TYPES: ReadonlySet<string> = new Set([
  "sms_sent",
  "client.email_in",
  "supplier.email_in",
]);

/** When we last communicated on the job, never counting crew or staff rows. */
// deno-lint-ignore no-explicit-any
export function latestCommsAt(events: any[]): string | null {
  const hit = (events || []).find((e) =>
    COMMS_EVENT_TYPES.has(e?.event_type) && !roles(e).internal
  );
  return hit?.occurred_at || null;
}
