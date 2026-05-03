// T7 Loop 3 — Feature flag reader for evidence_capture_v1
//
// Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 12 Loop 3)
//
// Until evidence_capture_v1 is ON, every recordEvidence call short-circuits
// to dry-run regardless of what the caller passes. This is the structural
// guarantee that a half-migrated writer cannot accidentally start filling
// the spine before the wave is approved.
//
// Cached in-process for 60s so the hundreds of recordEvidence calls per
// minute do not each query feature_flags. The cache invalidates after
// EVIDENCE_FLAG_TTL_MS, so a flag flip propagates within ~1 minute.
//
// Falls back to OFF on any error — fail-closed so a flags table outage
// never enables capture.

const EVIDENCE_FLAG_TTL_MS = 60_000;
const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

interface CacheEntry {
  enabled: boolean;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

export type EvidenceFlagKey =
  | "evidence_capture_v1"
  | "evidence_audio_capture"
  | "evidence_transcript_capture"
  | "evidence_refs_strict_mode";

/**
 * Returns true when the flag is ON. Default OFF on any error.
 *
 * For evidence_refs_strict_mode the boolean (enabled, shadow_mode) maps:
 *   (false,false) -> 'off'        -> isFlagOn returns false
 *   (false,true)  -> 'soft-warn'  -> use getRefsValidatorMode() instead
 *   (true,false)  -> 'strict'     -> isFlagOn returns true
 */
export async function isFlagOn(
  // deno-lint-ignore no-explicit-any
  client: any,
  flagKey: EvidenceFlagKey,
  orgId: string = DEFAULT_ORG_ID,
): Promise<boolean> {
  const cacheKey = `${orgId}:${flagKey}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < EVIDENCE_FLAG_TTL_MS) {
    return cached.enabled;
  }
  try {
    const { data, error } = await client
      .from("feature_flags")
      .select("enabled, shadow_mode")
      .eq("org_id", orgId)
      .eq("flag_key", flagKey)
      .limit(1);
    if (error) {
      cache.set(cacheKey, { enabled: false, fetchedAt: Date.now() });
      return false;
    }
    const row = data?.[0];
    const enabled = Boolean(row?.enabled);
    cache.set(cacheKey, { enabled, fetchedAt: Date.now() });
    return enabled;
  } catch {
    cache.set(cacheKey, { enabled: false, fetchedAt: Date.now() });
    return false;
  }
}

export type RefsValidatorMode = "off" | "soft-warn" | "strict";

/**
 * Tri-state read of evidence_refs_strict_mode:
 *   (false,false) -> 'off'
 *   (false,true)  -> 'soft-warn'
 *   (true,*)      -> 'strict'
 */
export async function getRefsValidatorMode(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string = DEFAULT_ORG_ID,
): Promise<RefsValidatorMode> {
  try {
    const { data, error } = await client
      .from("feature_flags")
      .select("enabled, shadow_mode")
      .eq("org_id", orgId)
      .eq("flag_key", "evidence_refs_strict_mode")
      .limit(1);
    if (error || !data?.[0]) return "off";
    const { enabled, shadow_mode } = data[0];
    if (enabled) return "strict";
    if (shadow_mode) return "soft-warn";
    return "off";
  } catch {
    return "off";
  }
}

/**
 * Test hook: invalidate the cache. Production code never calls this.
 */
export function _resetFlagCache() {
  cache.clear();
}
