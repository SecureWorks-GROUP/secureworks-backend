// deno-lint-ignore-file no-explicit-any
//
// The job read's message timeline (context job-read fix, 5 Oct 2026; gap plan
// row 9, agent use). getJobConversation and assembleJobDossier (index.ts) and
// the state card (job_state_card.ts) read messages through this module so
// that:
//
//   1. Messages are ordered by when they happened, coalesce(event_at,
//      occurred_at), never by when they were loaded. business_events.occurred_at
//      is ingestion time (capture_business_event stamps it); a history load
//      stamps months of old messages with the day it ran, and ordering by it
//      pushed the real latest messages out of the bounded read.
//      readBusinessEventsBySourceTime gets the exact newest N by source time
//      with two indexed reads (rows with event_at, ordered by it; rows
//      without, ordered by occurred_at), because PostgREST cannot order by an
//      expression. A message's occurred_at is that source time; the load time
//      is kept on loaded_at.
//   2. Each message's channel comes from the row's channel column (a text is
//      never labelled email); the event type is only a fallback for rows
//      written before the column was filled. Calls and call transcripts are
//      message rows too.
//   3. Each message says who it went between (who), and whether the other
//      side is the customer (customer_party). Crew and staff texts
//      (metadata.recipient_role crew or staff, or audience internal) and
//      email not to or from a customer address stay in the conversation as
//      internal or other-party job communication, but never count as contact
//      with the customer (countsAsCustomerContact).
//   4. Emails our system sent to the customer (email_events) are messages too
//      (sentCustomerEmailMessages).
//
// Pure except readBusinessEventsBySourceTime and readCustomerAddresses, which
// only SELECT.

import {
  emailAddress,
  isOurAddress,
} from "../_shared/evidence/outlook_mail.ts";
import {
  type MessagePartyRoles,
  type PartyRole,
  readMessagePartyRoles,
} from "../_shared/evidence/party_roles.ts";

/** Channels whose rows are messages. */
export const MESSAGE_CHANNELS = [
  "sms",
  "email",
  "call",
  "note",
  "whatsapp",
  "chat",
] as const;

/** Message event types, for rows written before the channel column was filled. */
export const MESSAGE_EVENT_TYPES = [
  "client.reply",
  "client.email_in",
  "client.email_out",
  "client.sms_in",
  "client.sms_out",
  "client.call_complete",
  "client.call_logged",
  "call.transcript_completed",
  "client.message_in",
  "supplier.email_in",
  "ghl.note_added",
  "note.added",
] as const;

/** PostgREST .or() filter: a message row by channel, or by its event type. */
export const MESSAGE_ROW_FILTER = `channel.in.(${
  MESSAGE_CHANNELS.join(",")
}),event_type.in.(${MESSAGE_EVENT_TYPES.map((t) => `"${t}"`).join(",")})`;

/** The business_events columns a conversation message is built from. */
export const TIMELINE_MESSAGE_COLUMNS =
  "id, event_type, source, occurred_at, event_at, channel, direction, body_preview, provider_message_id, payload, correlation_id, attribution_status, attribution_step, placement_rule:metadata->>placement_rule, party_roles:metadata->party_roles, audience:metadata->>audience, recipient_role:metadata->>recipient_role";

/** When the row happened: coalesce(event_at, occurred_at), as an ISO string. */
export function eventSourceTime(row: any): string | null {
  const at = row?.event_at ?? row?.occurred_at ?? null;
  return typeof at === "string" && at ? at : null;
}

function timeMs(value: unknown): number {
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

/** Newest first by source time, then id (stable across the two reads). */
export function bySourceTimeDesc(a: any, b: any): number {
  const d = timeMs(eventSourceTime(b)) - timeMs(eventSourceTime(a));
  if (d !== 0) return d;
  const ai = String(a?.id ?? "");
  const bi = String(b?.id ?? "");
  return ai < bi ? 1 : ai > bi ? -1 : 0;
}

/**
 * A conversation window asked for by a caller (ask the story, 6 Oct 2026):
 * since and until, each an ISO date-time or absent. since stays exclusive and
 * until inclusive, on when each message happened. A value that is not a
 * date-time, or an until before since, is an error to say back: read as no
 * window it would answer a period question with the wrong messages.
 */
export function conversationWindow(
  body: any,
): { since: string | null; until: string | null; error: string | null } {
  const read = (name: "since" | "until") => {
    const v = body?.[name];
    if (v === undefined || v === null || v === "") return { at: null, bad: false };
    if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) {
      return { at: null, bad: true };
    }
    return { at: v, bad: false };
  };
  const since = read("since");
  const until = read("until");
  if (since.bad) {
    return { since: null, until: null, error: "since must be an ISO date-time" };
  }
  if (until.bad) {
    return { since: null, until: null, error: "until must be an ISO date-time" };
  }
  if (
    since.at && until.at && Date.parse(until.at) < Date.parse(since.at)
  ) {
    return { since: null, until: null, error: "until is before since" };
  }
  return { since: since.at, until: until.at, error: null };
}

/** Whether a message happened by `until` (inclusive). No until, or no readable time, keeps it. */
export function happenedBy(at: unknown, until: string | null): boolean {
  if (!until) return true;
  const t = typeof at === "string" ? Date.parse(at) : NaN;
  return !Number.isFinite(t) || t <= Date.parse(until);
}

/**
 * The newest `limit` business_events rows on a job by source time
 * (coalesce(event_at, occurred_at)), exactly: the newest N of the rows that
 * carry event_at (ordered by it) merged with the newest N of the rows that do
 * not (ordered by occurred_at, their source time), then cut to N. `since`
 * (exclusive) and `until` (inclusive) apply to the source time. `select` must
 * name event_at and occurred_at.
 */
export async function readBusinessEventsBySourceTime(
  client: any,
  opts: {
    jobId: string;
    select: string;
    limit: number;
    since?: string | null;
    until?: string | null;
    messagesOnly?: boolean;
  },
): Promise<{ rows: any[]; error: string | null }> {
  const build = (stamped: boolean) => {
    let q = client.from("business_events").select(opts.select).eq(
      "job_id",
      opts.jobId,
    );
    if (opts.messagesOnly) q = q.or(MESSAGE_ROW_FILTER);
    if (stamped) {
      q = q.not("event_at", "is", null);
      if (opts.since) q = q.gt("event_at", opts.since);
      if (opts.until) q = q.lte("event_at", opts.until);
      q = q.order("event_at", { ascending: false });
    } else {
      q = q.is("event_at", null);
      if (opts.since) q = q.gt("occurred_at", opts.since);
      if (opts.until) q = q.lte("occurred_at", opts.until);
      q = q.order("occurred_at", { ascending: false });
    }
    return q.order("id", { ascending: false }).limit(opts.limit);
  };
  const [stamped, unstamped] = await Promise.all([build(true), build(false)]);
  const errors = [stamped?.error, unstamped?.error].filter(Boolean).map((
    e: any,
  ) => String(e?.message ?? e));
  const seen = new Set<string>();
  const rows = [...(stamped?.data ?? []), ...(unstamped?.data ?? [])]
    .filter((r: any) => {
      const id = String(r?.id ?? "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort(bySourceTimeDesc)
    .slice(0, opts.limit);
  return { rows, error: errors.length ? errors.join("; ") : null };
}

/** The message channel: the row's channel column, else from its event type. */
export function messageChannel(row: any): string {
  const given = typeof row?.channel === "string"
    ? row.channel.trim().toLowerCase()
    : "";
  if (given) return given;
  const t = String(row?.event_type ?? "");
  if (t.includes("sms") || t === "client.reply") return "sms";
  if (t.includes("call")) return "call";
  if (t.includes("note") || t.includes("comment")) return "note";
  if (t.includes("email")) return "email";
  return "message";
}

/** inbound, outbound or internal: the row's direction column, else from its event type. */
export function messageDirection(row: any): string {
  const given = typeof row?.direction === "string"
    ? row.direction.trim().toLowerCase()
    : "";
  if (given === "inbound" || given === "outbound" || given === "internal") {
    return given;
  }
  const t = String(row?.event_type ?? "");
  if (t.includes("note") || t.includes("comment")) return "internal";
  return t.endsWith("_in") || t === "client.reply" ||
      t === "supplier.email_in"
    ? "inbound"
    : "outbound";
}

/** Every address in a from/to/cc value (string, "Name <a@b>", list, or list of objects). */
export function emailAddresses(value: unknown): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      for (const x of v) add(x);
      return;
    }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      add(o.address ?? o.email ?? (o.emailAddress as any)?.address ?? null);
      return;
    }
    for (const part of String(v).split(/[,;]/)) {
      const a = emailAddress(part);
      if (a && !out.includes(a)) out.push(a);
    }
  };
  add(value);
  return out;
}

/** The customer's addresses on this job: jobs.client_email and active parties' emails. */
export async function readCustomerAddresses(
  client: any,
  jobId: string,
  jobClientEmail: string | null | undefined,
): Promise<Set<string>> {
  const out = new Set<string>(emailAddresses(jobClientEmail));
  try {
    const { data, error } = await client.from("job_contacts")
      .select("client_email, status")
      .eq("job_id", jobId)
      .limit(50);
    if (error) {
      console.error(
        "[ops-api] job conversation party email read failed:",
        error.message,
      );
    }
    for (const r of data ?? []) {
      if (r?.status && String(r.status).toLowerCase() !== "active") continue;
      for (const a of emailAddresses(r?.client_email)) out.add(a);
    }
  } catch (e) {
    console.error(
      "[ops-api] job conversation party email read failed:",
      (e as Error).message,
    );
  }
  return out;
}

/**
 * Whether an email's other side is the customer: inbound from a customer
 * address, or outbound to one. null when the customer has no address on
 * record or the row names no address on that side.
 */
export function emailCustomerParty(
  direction: string,
  from: unknown,
  to: unknown,
  customer: Set<string>,
): boolean | null {
  if (!customer.size) return null;
  const side = direction === "inbound"
    ? emailAddresses(from)
    : emailAddresses(to);
  if (!side.length) return null;
  return side.some((a) => customer.has(a));
}

const INTERNAL_ROLES = new Set(["crew", "staff"]);

/** True for crew and staff communication: the ladder's label or a writer's recipient role. */
export function isInternalMessage(m: any): boolean {
  return m?.direction === "internal" || m?.audience === "internal" ||
    m?.internal === true ||
    (INTERNAL_ROLES.has(String(m?.recipient_role ?? "")) &&
      m?.direction !== "inbound");
}

/**
 * Who a message went between, in plain words. Uses the party roles stamp when
 * the row carries one (sender_role / recipient_role), else what this read
 * knows: the channel, the direction, the ladder's labels and the customer's
 * addresses.
 */
export function whoToWhom(m: any): string {
  const roleWords: Record<string, string> = {
    customer: "the customer",
    crew: "crew",
    staff: "us",
    supplier: "a supplier",
    insurer_builder: "the insurer or builder",
  };
  const s = roleWords[String(m?.sender_role ?? "")];
  const r = roleWords[String(m?.recipient_role ?? "")];
  if (m?.channel === "note") return "staff note (internal)";
  if (m?.own_copy === true) return "us (a stored copy of our own email)";
  if (isInternalMessage(m)) {
    const to = INTERNAL_ROLES.has(String(m?.recipient_role ?? ""))
      ? (m.recipient_role === "crew" ? "crew" : "staff")
      : "staff";
    return `us to ${to} (internal)`;
  }
  if (
    s && r && m?.sender_role !== "unknown" && m?.recipient_role !== "unknown"
  ) {
    return `${s} to ${r}`;
  }
  const other = m?.audience === "other_party"
    ? "someone other than the customer"
    : m?.customer_party === true
    ? "the customer"
    : m?.customer_party === false
    ? "someone other than the customer"
    : m?.channel === "email"
    ? "an address not on this job"
    : "the customer";
  return m?.direction === "inbound" ? `${other} to us` : `us to ${other}`;
}

/**
 * Whether a message is contact with the customer (newest contact, what we last
 * told the customer). Notes, internal crew and staff communication, and other
 * parties never are. An email counts only when its other side is a customer
 * address (or the party roles stamp says the customer); a text or call on the
 * job's customer thread counts unless it is labelled otherwise.
 */
export function countsAsCustomerContact(m: any): boolean {
  if (!m) return false;
  const channel = String(m.channel ?? "");
  if (!["sms", "call", "email", "whatsapp", "chat"].includes(channel)) {
    return false;
  }
  if (m.direction !== "inbound" && m.direction !== "outbound") return false;
  if (isInternalMessage(m) || m.audience === "other_party") return false;
  const counterpart = String(m.counterpart_role ?? "unknown");
  if (counterpart !== "unknown" && counterpart !== "") {
    return counterpart === "customer";
  }
  if (channel === "email") return m.customer_party === true;
  return m.customer_party !== false;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Who sent a row and who received it (party roles, B-6): the database stamp,
 * the ladder's internal label, and (for a hand-labelled row with no audience
 * yet) a writer's metadata.recipient_role crew or staff on a text we sent.
 */
function rowPartyRoles(r: any, providerDirection: string): MessagePartyRoles {
  const roles = readMessagePartyRoles({
    party_roles: r?.party_roles ?? null,
    audience: r?.audience ?? null,
    recipient_role: r?.recipient_role ?? null,
  });
  const marked = String(r?.recipient_role ?? "");
  if (
    !roles.internal && INTERNAL_ROLES.has(marked) &&
    providerDirection !== "inbound"
  ) {
    const role = marked as PartyRole;
    return {
      sender_role: "staff",
      recipient_role: role,
      counterpart_role: role,
      audience: "internal",
      internal: true,
      label: `internal: ${role}`,
      basis: "writer_recipient_role",
    };
  }
  return roles;
}

/** One business_events row as a conversation message. */
export function businessEventTimelineMessage(
  r: any,
  jobId: string,
  customer: Set<string>,
) {
  const p: any = r?.payload || {};
  const channel = messageChannel(r);
  const providerDirection = messageDirection(r);
  const roles = rowPartyRoles(r, providerDirection);
  // An internal row is never inbound or outbound customer traffic.
  const direction = roles.internal ? "internal" : providerDirection;
  const transcript = str(p.transcript);
  const body = transcript ||
    str(p.body) || str(p.text) || str(p.message) || str(p.note_preview) ||
    str(p.note_text) || str(p.body_preview) || str(r?.body_preview);
  const from = p.from ?? p.from_email ?? p.sender ?? null;
  // Our own email stored as an inbound row (an invoice we sent, read back
  // from a shared mailbox) is never the customer writing to us.
  const ownCopy = channel === "email" && direction === "inbound" &&
    emailAddresses(from).some((a) => isOurAddress(a));
  const customerParty = channel === "email"
    ? (ownCopy ? false : emailCustomerParty(direction, from, [
      p.to,
      p.to_email,
      p.recipients,
      p.to_recipients,
      p.cc,
    ], customer))
    : null;
  const m: any = {
    id: `bev:${r.id}`,
    job_id: jobId,
    channel,
    direction,
    provider_direction: providerDirection,
    // When it happened (event_at, else occurred_at); loaded_at is load time.
    occurred_at: eventSourceTime(r),
    loaded_at: r?.occurred_at ?? null,
    author: p.from || p.sender_name || p.added_by || null,
    body,
    preview: body.slice(0, 500),
    subject: p.subject || null,
    source_system: "business_events",
    source_ref: r.id,
    provider_message_id: r?.provider_message_id ?? null,
    attribution_status: r.attribution_status ?? null,
    attribution_step: r.attribution_step ?? null,
    placement_rule: r.placement_rule ?? null,
    sender_role: roles.sender_role,
    recipient_role: roles.recipient_role,
    counterpart_role: roles.counterpart_role,
    audience: roles.audience,
    internal: roles.internal,
    party_label: roles.label,
    party_roles_basis: roles.basis,
    ...(roles.internal ? { label: roles.label } : {}),
    customer_party: customerParty,
    ...(ownCopy ? { own_copy: true } : {}),
    ...(r?.event_type === "call.transcript_completed"
      ? { call_transcript: true }
      : {}),
  };
  m.who = whoToWhom(m);
  return m;
}

/** Statuses of an email_events row that mean the email did not go. */
const NOT_SENT_STATUSES = new Set(["failed", "bounced", "rejected", "dropped"]);

/**
 * Emails our system sent to the customer (email_events), as conversation
 * messages. Only rows that went (sent_at set, status not a failure) to a
 * customer address. A copy of the same email already among the job's
 * business_events messages (same subject, outbound, within 15 minutes) is
 * left out so one email shows once.
 */
export function sentCustomerEmailMessages(
  rows: any[],
  jobId: string,
  customer: Set<string>,
  existing: any[],
): any[] {
  const out: any[] = [];
  for (const r of rows ?? []) {
    if (!r?.sent_at) continue;
    if (NOT_SENT_STATUSES.has(String(r.status ?? "").toLowerCase())) continue;
    const to = emailAddresses(r.recipient);
    if (!to.some((a) => customer.has(a))) continue;
    const subject = r.subject ? String(r.subject) : null;
    const at = timeMs(r.sent_at);
    const duplicate = existing.some((m) =>
      m?.channel === "email" && m?.direction === "outbound" &&
      subject && String(m.subject ?? "").trim() === subject.trim() &&
      Math.abs(timeMs(m.occurred_at) - at) <= 15 * 60_000
    );
    if (duplicate) continue;
    const kind = r.email_type ? String(r.email_type).replace(/_/g, " ") : null;
    const body = [
      subject ? `Subject: ${subject}` : "",
      kind ? `Sent by our system, email type: ${kind}.` : "Sent by our system.",
    ].filter(Boolean).join("\n");
    const m: any = {
      id: `email_event:${r.id}`,
      job_id: jobId,
      channel: "email",
      direction: "outbound",
      occurred_at: r.sent_at,
      loaded_at: r.created_at ?? null,
      author: r.sender || null,
      body,
      preview: body.slice(0, 500),
      subject,
      source_system: "email_events",
      source_ref: r.id,
      email_type: r.email_type ?? null,
      delivery_status: r.status ?? null,
      customer_party: true,
    };
    m.who = whoToWhom(m);
    out.push(m);
  }
  return out;
}
