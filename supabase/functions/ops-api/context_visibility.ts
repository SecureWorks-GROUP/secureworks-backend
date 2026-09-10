// Current memory visibility. Historical rows remain in their source tables for audit.
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
    Object.hasOwn(row, "expires_at");
  if (!temporary) return true;
  const expiry = typeof row.expires_at === "string"
    ? Date.parse(row.expires_at)
    : NaN;
  return Number.isFinite(expiry) && expiry > now;
}
