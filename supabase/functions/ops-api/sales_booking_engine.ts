// Production-shaped assessment entrypoint. Uses the TypeScript engine, not CJS.
import { assess, assessWithReason, VERSION } from "./sales_booking_assess.ts";

export { VERSION };

export type ReasonTransport = (prompt: Record<string, unknown>) => Promise<unknown>;

function deskRules(resourceId: string) {
  if (resourceId === "nithin") return { monday_from: 12, no_wednesday: true, last_start: 15.5 };
  return { monday_from: 8, no_wednesday: false, last_start: 15.5 };
}

export function assembleEnvelope(input: Record<string, unknown>): Record<string, unknown> {
  const c = (input.case || {}) as Record<string, unknown>;
  const raw = (input.input || input) as Record<string, unknown>;
  const resourceId = String(c.resource_id || raw.resource_id || "nithin");
  const resource = (raw.resource as Record<string, unknown>) || {
    name: resourceId,
    lane: resourceId === "nithin" ? "patio" : "fencing",
    desk_rules: deskRules(resourceId),
  };
  return {
    week_start: raw.week_start || input.week_start,
    now: raw.now || new Date().toISOString(),
    resource,
    suburb: raw.suburb || c.suburb,
    tags: raw.tags || c.tags || [],
    messages: raw.messages || [],
    sent_offers: raw.sent_offers || [],
    events: raw.events || [],
    pending_offers: raw.pending_offers || [],
    leave_intervals: raw.leave_intervals,
    previous_visit: raw.previous_visit,
    next_visit: raw.next_visit,
    route_legs: raw.route_legs,
    travel_minutes: raw.travel_minutes,
    calendar_retrieved_at: raw.calendar_retrieved_at,
    leave_retrieved_at: raw.leave_retrieved_at,
    travel_retrieved_at: raw.travel_retrieved_at,
    coverage: raw.coverage,
    case_id: c.id || raw.case_id,
    source_version: c.source_version,
  };
}

export function fingerprint(envelope: Record<string, unknown>): string {
  const msgs = Array.isArray(envelope.messages) ? envelope.messages : [];
  const events = Array.isArray(envelope.events) ? envelope.events : [];
  return JSON.stringify({
    week: envelope.week_start,
    now_day: String(envelope.now || "").slice(0, 10),
    resource: envelope.resource,
    messages: msgs.map((m: Record<string, unknown>) => ({ id: m.id, direction: m.direction, timestamp: m.timestamp, body: m.body || m.text })),
    events: events.map((e: Record<string, unknown>) => ({ id: e.event_id, start: e.start_iso, end: e.end_iso })),
    leave: envelope.leave_retrieved_at,
    travel: envelope.travel_retrieved_at,
    calendar: envelope.calendar_retrieved_at,
    source_version: envelope.source_version,
  });
}

export async function sourceHash(envelope: Record<string, unknown>): Promise<string> {
  const buf = new TextEncoder().encode(fingerprint(envelope));
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export function classify(result: Record<string, unknown>, envelope: Record<string, unknown>): string {
  const msgs = Array.isArray(envelope.messages) ? envelope.messages : [];
  if (!msgs.length) return "unassessed_conversation";
  const cov = (result.evidence as { coverage?: { gaps?: string[] } } | undefined)?.coverage;
  if (result.status !== "ready") return String(result.status || "needs_decision");
  return "assessed";
}

function reasonUrl(): string {
  try {
    return Deno.env.get("BOOKING_REASON_URL") || "";
  } catch {
    return "";
  }
}

export function createReasonTransport(fetchImpl: typeof fetch = fetch): ReasonTransport | undefined {
  const url = reasonUrl();
  if (!url) return undefined;
  return async (prompt) => {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prompt),
    });
    if (!resp.ok) throw new Error("reason_transport_" + resp.status);
    return resp.json();
  };
}

export async function runAssessment(
  input: Record<string, unknown>,
  opts?: { reason?: ReasonTransport; cached_hash?: string; cached_payload?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const envelope = assembleEnvelope(input);
  const hash = await sourceHash(envelope);
  const msgs = Array.isArray(envelope.messages) ? envelope.messages : [];
  if (!msgs.length) {
    return {
      version: VERSION,
      status: "needs_decision",
      classification: "unassessed_conversation",
      source_hash: hash,
      cache: "skip",
      proposal: null,
      reason: "Conversation messages were not supplied. This case is unassessed, not Ready.",
      review_reasons: ["Unassessed: no inbound/outbound messages in the assembled envelope."],
      customer_facts: { date_specified: false },
    };
  }
  if (opts?.cached_hash === hash && opts.cached_payload && opts.cached_payload.version === VERSION) {
    return { ...opts.cached_payload, cache: "hit", source_hash: hash, classification: classify(opts.cached_payload, envelope) };
  }
  const reason = opts?.reason !== undefined ? opts.reason : createReasonTransport();
  const result = reason
    ? await assessWithReason({ ...envelope, reasonAsync: reason })
    : assess(envelope);
  const classification = classify(result as Record<string, unknown>, envelope);
  return { ...result, version: VERSION, source_hash: hash, cache: "miss", classification, reasoning: reason ? "server_reason_transport" : "conservative_only" };
}
