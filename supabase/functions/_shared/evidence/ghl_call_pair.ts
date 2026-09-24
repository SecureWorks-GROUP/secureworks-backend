// One real call is one call (slice T1, review finding T1-002, firstmate
// ruling option A2).
//
// Before live GHL capture, the receiver's CallCompleted workflow post writes a
// legacy client.call_complete row with no provider key. When a GHL call item
// is later saved as client.call_logged under ghl:<GHL message id>, the key
// cannot see that legacy row. So before a call row is written, the writer
// looks for legacy rows of the same contact around the call:
//   * exactly one: the new row records its id in payload.legacy_event_id;
//   * none or several: the new row is written as normal.
// Existing rows are never edited or deleted. Counting the pair once in the
// conversation, extraction and dossier reads belongs to the reader owners and
// to T4 (legacy supersede); this module only records the pairing.
//
// The window: 120 seconds either side of the call. A legacy row is stamped
// when the workflow post arrives, which is when the call ends, so the window
// runs from 120 s before the call started to 120 s after it ended (start plus
// the provider's duration; the start alone when no duration is given).
//
// A lookup is a read before a write, not a lock: two writers saving two calls
// of one contact at the same moment could both record the same legacy id. That
// race is small (the webhook doorbell and the 15-minute reconciler) and only
// leaves two new rows pointing at one legacy row; nothing is lost or edited.

/** Seconds either side of the call a legacy row may sit and still be its record. */
export const LEGACY_CALL_PAIR_WINDOW_SECONDS = 120;

/** At most this many legacy candidates are read; more than one is already "several". */
const CANDIDATE_READ_LIMIT = 5;

export interface LegacyCallCandidate {
  id: string;
  event_at: string | null;
  occurred_at: string | null;
}

export type LegacyCallPairOutcome =
  | "paired"
  | "none"
  | "several"
  | "already_paired"
  | "not_a_call"
  | "unreadable";

function ms(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** The window a legacy client.call_complete row for this call row can sit in, or null when the row has no time. */
export function legacyCallWindow(
  row: Record<string, unknown>,
): { from: string; to: string } | null {
  const start = ms(row.event_at);
  if (start === null) return null;
  const payload = row.payload as Record<string, unknown> | null | undefined;
  const duration = typeof payload?.duration_seconds === "number" &&
      Number.isFinite(payload.duration_seconds) &&
      payload.duration_seconds >= 0
    ? payload.duration_seconds
    : 0;
  const pad = LEGACY_CALL_PAIR_WINDOW_SECONDS * 1000;
  return {
    from: new Date(start - pad).toISOString(),
    to: new Date(start + duration * 1000 + pad).toISOString(),
  };
}

/**
 * Pure: the legacy candidates inside the call's window. A candidate's time is
 * its provider time when it has one, else its ingestion time.
 */
export function legacyCandidatesInWindow(
  row: Record<string, unknown>,
  candidates: readonly LegacyCallCandidate[],
): LegacyCallCandidate[] {
  const window = legacyCallWindow(row);
  if (!window) return [];
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  return candidates.filter((c) => {
    const at = ms(c.event_at) ?? ms(c.occurred_at);
    return at !== null && at >= from && at <= to;
  });
}

/** The row with payload.legacy_event_id set. A new object; the input is not changed. */
export function withLegacyEventId(
  row: Record<string, unknown>,
  legacyId: string,
): Record<string, unknown> {
  const payload = (row.payload && typeof row.payload === "object" &&
      !Array.isArray(row.payload))
    ? row.payload as Record<string, unknown>
    : {};
  return { ...row, payload: { ...payload, legacy_event_id: legacyId } };
}

// deno-lint-ignore no-explicit-any
type Db = any;

/**
 * Look for the one legacy call row this call row stands for, and return the
 * row to write (with payload.legacy_event_id when exactly one matches). Never
 * throws: an unreadable lookup writes the row as normal.
 */
export async function pairLegacyCall(
  client: Db,
  row: Record<string, unknown>,
): Promise<{ row: Record<string, unknown>; outcome: LegacyCallPairOutcome }> {
  if (row.event_type !== "client.call_logged") {
    return { row, outcome: "not_a_call" };
  }
  const contactId = typeof row.contact_id === "string" && row.contact_id
    ? row.contact_id
    : null;
  const window = legacyCallWindow(row);
  if (!contactId || !window) return { row, outcome: "none" };
  try {
    const { data, error } = await client.from("business_events")
      .select("id, event_at, occurred_at")
      .eq("event_type", "client.call_complete")
      .eq("contact_id", contactId)
      // Times are quoted so PostgREST reads each as one value.
      .or(
        `and(event_at.gte."${window.from}",event_at.lte."${window.to}"),` +
          `and(event_at.is.null,occurred_at.gte."${window.from}",occurred_at.lte."${window.to}")`,
      )
      .limit(CANDIDATE_READ_LIMIT);
    if (error) return { row, outcome: "unreadable" };
    const matches = legacyCandidatesInWindow(
      row,
      (data ?? []) as LegacyCallCandidate[],
    );
    if (matches.length === 0) return { row, outcome: "none" };
    if (matches.length > 1) return { row, outcome: "several" };
    const legacyId = matches[0].id;

    // A legacy row another call already records is not this call's.
    const claimed = await client.from("business_events")
      .select("provider_message_id")
      .eq("event_type", "client.call_logged")
      .eq("payload->>legacy_event_id", legacyId)
      .limit(2);
    if (claimed.error) return { row, outcome: "unreadable" };
    const others = ((claimed.data ?? []) as { provider_message_id?: unknown }[])
      .filter((r) => r.provider_message_id !== row.provider_message_id);
    if (others.length) return { row, outcome: "already_paired" };
    return { row: withLegacyEventId(row, legacyId), outcome: "paired" };
  } catch {
    return { row, outcome: "unreadable" };
  }
}
