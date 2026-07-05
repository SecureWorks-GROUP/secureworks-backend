// M0 · U9 — Comms envelope mapper for the generic log_business_event path.
//
// Mission: sales-m0-data-truth-2026-07-05 (Lane A / U9, CP2 amendment).
//
// The MCP agent's generic `log_business_event` action (ops-api) inserts a
// business_events row from an arbitrary {event_type, payload}. For comms
// event types (client.sms_out, etc.) that generic insert left channel /
// direction / source_table / body_preview NULL — 248 client.sms_out shells in
// ~90 days. This module maps a comms event_type onto its T7 envelope and pulls
// the message body out of the loosely-shaped agent payload, so those events can
// route through recordEvidence and land as complete, readable evidence.
//
// Forward-fix only. Pure + side-effect-free so the send-path replay fixture can
// assert the envelope directly. Non-comms event types return null and keep the
// unchanged generic-logger behaviour.

import { Channel, Direction, EvidenceCapture } from "./types.ts";

export interface CommsEnvelope {
  channel: Channel;
  direction: Direction;
}

/**
 * Map a comms event_type to its channel + direction. Returns null for anything
 * that is not a client comms event (job-memory notes, status rows, etc.) — the
 * caller keeps the generic path for those.
 */
export function commsEnvelopeForEventType(eventType: string): CommsEnvelope | null {
  switch (eventType) {
    case "client.sms_out":
      return { channel: "sms", direction: "outbound" };
    case "client.sms_in":
      return { channel: "sms", direction: "inbound" };
    case "client.email_out":
      return { channel: "email", direction: "outbound" };
    case "client.email_in":
      return { channel: "email", direction: "inbound" };
    default:
      return null;
  }
}

/**
 * Extract the human-readable message body from the agent's loosely-shaped
 * payload. The MCP agent has used several key names over time; take the first
 * non-empty string. Returns null when no body is present.
 */
export function extractCommsBody(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  for (const key of ["message", "message_text", "body", "text", "body_preview", "content"]) {
    const v = p[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

export interface LogBusinessEventInput {
  event_type: string;
  entity_type?: string | null;
  entity_id?: string | null;
  job_id?: string | null;
  payload?: Record<string, unknown> | null;
}

/**
 * Build the EvidenceCapture for a comms `log_business_event` call, or return
 * null when the event is not comms (caller falls back to the generic insert).
 *
 * The returned capture is a COMPLETE T7 envelope: channel + direction from the
 * event type, body_preview from the payload, a stable source_id (the agent's
 * message id when present, else a synthetic uuid), and contact linkage pulled
 * from the payload/entity. This is exactly what the old generic insert failed
 * to set.
 */
export function planCommsCaptureFromLog(
  input: LogBusinessEventInput,
): EvidenceCapture | null {
  const env = commsEnvelopeForEventType(input.event_type);
  if (!env) return null;

  const payload = (input.payload ?? {}) as Record<string, unknown>;
  const bodyText = extractCommsBody(payload);
  const contactId =
    (payload.contact_id as string | undefined) ??
    (payload.contactId as string | undefined) ??
    (input.entity_id ?? undefined) ??
    null;
  const messageId =
    (payload.message_id as string | undefined) ??
    (payload.messageId as string | undefined) ??
    (payload.id as string | undefined) ??
    crypto.randomUUID();

  return {
    event_type: input.event_type,
    source: "mcp_agent",
    channel: env.channel,
    direction: env.direction,
    source_table: "ops_api_log_business_event",
    source_id: String(messageId),
    job_id: input.job_id ?? null,
    contact_id: contactId,
    entity_type: input.entity_type ?? "contact",
    entity_id: input.entity_id ?? contactId ?? undefined,
    match_method: input.job_id ? "direct_job_id" : "none",
    body_preview: bodyText ?? undefined,
    privacy_classification: "staff_only",
    retention_class: "7y_audit",
    payload,
  };
}
