// ════════════════════════════════════════════════════════════
// GHL Webhook Receiver — canonical inbound-SMS normalization (M0.5 U1b)
//
// Interface: coding/work/campaigns/sales-next-evolution/
//            INTERFACE-thread-state-and-send-gate.md §3
//
// `client.sms_in` is the ONE canonical inbound-SMS event type across
// history, the JARVIS extraction-enqueuer allow-list, and every M1/M2
// consumer predicate. The receiver's InboundMessage mapping previously wrote
// `client.reply` for every channel — a type the enqueuer never reads (indie
// review F1) — so restored client texts would never be mined. This module
// normalizes SMS → client.sms_in while leaving non-SMS (email/chat)
// InboundMessage on `client.reply` (negligible volume, noted in the interface).
//
// It also owns the cross-path dedup guard: the always-on receiver and the
// on-demand ops-api backfill (backfill_ghl_conversations) can both observe the
// same GHL message. We dedup on the GHL message id where present. Pure module
// (no network) so the mapping + dedup filter are unit-testable.
// ════════════════════════════════════════════════════════════

import { attributeInboundLine } from "./telephony_lines.ts";

export const INBOUND_SMS_EVENT_TYPE = "client.sms_in";
export const INBOUND_NONSMS_EVENT_TYPE = "client.reply";

export type InboundChannel = "sms" | "email" | "chat";

/** Same rule the receiver has always used: phone → sms, else email → email, else chat. */
export function inboundChannel(body: { phone?: unknown; email?: unknown }): InboundChannel {
  if (body.phone) return "sms";
  if (body.email) return "email";
  return "chat";
}

/** SMS → client.sms_in (canonical, interface §3); every other channel keeps client.reply. */
export function inboundEventType(channel: InboundChannel): string {
  return channel === "sms" ? INBOUND_SMS_EVENT_TYPE : INBOUND_NONSMS_EVENT_TYPE;
}

// GHL renders missing template variables as the literal string "null".
function str(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "" || s === "null" || s === "undefined") return null;
  return s;
}

/**
 * The GHL message id, where the webhook carries one. GHL message webhooks
 * expose it as `messageId` (v2) or `id`; some workflow payloads use `eventId`.
 * This is the SAME id the ops-api backfill stores from the conversations API
 * (`m.id` → entity_id + payload.ghl_message_id), so it is the cross-path key.
 */
export function extractGhlMessageId(body: Record<string, unknown>): string | null {
  return str(body.messageId) ?? str(body.id) ?? str(body.eventId);
}

export interface InboundMapping {
  eventType: string;
  channel: InboundChannel;
  eventPayload: Record<string, unknown>;
}

/**
 * The full InboundMessage → business_event envelope. Single source of truth for
 * both the canonical event type and the payload shape, so the mapping is
 * exact-testable without a live receiver. Job context is attached by the
 * receiver afterwards; this is the intrinsic message envelope only.
 */
export function mapInboundMessage(body: Record<string, unknown>): InboundMapping {
  const channel = inboundChannel(body);
  // U1b-a: attribute the destination line from the GHL `to`/`toNumber` field,
  // or a static per-workflow `line` label, via the shared telephony canon —
  // exactly as CallCompleted attributes a call. Never guessed from the
  // contact's own number; absent any destination signal → unknown.
  const destinationNumber = str(body.to) ?? str(body.toNumber);
  const staticLine = str(body.line);
  const { line_label, department } = attributeInboundLine(destinationNumber, staticLine);
  return {
    eventType: inboundEventType(channel),
    channel,
    eventPayload: {
      message_text: (((body.message as string) || "").slice(0, 500)),
      phone: (body.phone as string) || null,
      email: (body.email as string) || null,
      conversation_id: (body.conversationId as string) || null,
      channel,
      line_label,
      department,
      ghl_message_id: extractGhlMessageId(body),
      source: "ghl_webhook",
    },
  };
}

/** GHL ids are opaque alphanumerics; refuse anything else so it cannot break a PostgREST or() filter. */
export const SAFE_GHL_ID = /^[A-Za-z0-9_-]+$/;

/**
 * PostgREST `.or()` filter that matches a prior business_event carrying this
 * GHL message id — via the receiver's own source_id (a GHL webhook
 * re-delivery), the ops-api backfill's entity_id, or either path's
 * payload.ghl_message_id. Returns null when the id is absent or not safe to
 * interpolate (no id ⇒ no dedup, per interface §3 "where present").
 */
export function buildInboundDedupOr(ghlMessageId: string | null): string | null {
  if (!ghlMessageId || !SAFE_GHL_ID.test(ghlMessageId)) return null;
  return `source_id.eq.${ghlMessageId},entity_id.eq.${ghlMessageId},payload->>ghl_message_id.eq.${ghlMessageId}`;
}

// Minimal shape of the supabase query chain this guard needs — lets tests
// pass a fake client with no network.
export interface InboundDedupClient {
  from(table: string): {
    select(cols: string): {
      or(filter: string): {
        limit(n: number): PromiseLike<{ data: Array<{ id: string }> | null; error?: unknown }>;
      };
    };
  };
}

export interface InboundDedupResult {
  deduped: boolean;
  matchedId?: string;
  filter?: string;
}

/**
 * True-dedup lookup: does a business_event already carry this GHL message id?
 * "Where present" — no id means no safe key, so we never dedup (insert).
 */
export async function findInboundDuplicate(
  client: InboundDedupClient,
  ghlMessageId: string | null,
): Promise<InboundDedupResult> {
  const filter = buildInboundDedupOr(ghlMessageId);
  if (!filter) return { deduped: false };
  const { data } = await client.from("business_events").select("id").or(filter).limit(1);
  if (data && data.length > 0) return { deduped: true, matchedId: data[0].id, filter };
  return { deduped: false, filter };
}
