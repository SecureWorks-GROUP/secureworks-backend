// Current memory visibility. Historical rows remain in their source tables for audit.

/** Live Luna subscription extractor stamp. Haiku / instruction extractors must not count as Luna. */
export const LUNA_SUBSCRIPTION_EXTRACTOR = "context-luna-subscription:v1";

/** Per-job writer stamp. Accepted in addition to LUNA_SUBSCRIPTION_EXTRACTOR, never instead of it. */
const LUNA_V2_EXTRACTOR = "luna_v2";

export function isLunaSubscriptionFact(row: Record<string, unknown>): boolean {
  const p = row.provenance as Record<string, unknown> | null;
  if (p?.extractor === LUNA_SUBSCRIPTION_EXTRACTOR) return true;
  if (p?.extractor === LUNA_V2_EXTRACTOR) return true;
  return row.extractor_version === LUNA_V2_EXTRACTOR && row.trust === "luna";
}

export function isCurrentContextFact(
  row: Record<string, unknown>,
  now = Date.now(),
): boolean {
  const p = row.provenance as Record<string, unknown> | null;
  const safety = p?.safety as Record<string, unknown> | null;
  const lifecycle = typeof p?.lifecycle === "string"
    ? p.lifecycle
    : (p?.lifecycle as Record<string, unknown> | null)?.state;
  if (
    safety?.memory_trusted === false || p?.superseded_by || p?.retracted_at ||
    lifecycle === "superseded" || lifecycle === "retracted"
  ) return false;
  const temporary = ["current_state", "pending_action", "quote_issue"].includes(
    String(row.kind),
  ) ||
    row._context_store === "job_temporary_context" ||
    (row._context_store !== "job_context" && Object.hasOwn(row, "expires_at"));
  if (!temporary) return true;
  const expiry = typeof row.expires_at === "string"
    ? Date.parse(row.expires_at)
    : NaN;
  return Number.isFinite(expiry) && expiry > now;
}

/** Current + Luna-stamped. Used by the invoice door so Haiku rows never read as Luna coverage. */
export function isCurrentLunaSubscriptionFact(
  row: Record<string, unknown>,
  now = Date.now(),
): boolean {
  return isCurrentContextFact(row, now) && isLunaSubscriptionFact(row);
}
