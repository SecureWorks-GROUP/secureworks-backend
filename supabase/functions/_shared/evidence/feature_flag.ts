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
 * Production schema as of 2026-05-03:
 *   feature_flags(id, flag_name, enabled, description, updated_at)
 *   No org_id column (single-org install). No shadow_mode column.
 *   The orgId param is preserved for the cache key only — the table is
 *   global, so all org_ids share one row per flag_name.
 *
 * For evidence_refs_strict_mode the boolean enabled maps:
 *   false -> 'off' / 'soft-warn' (use getRefsValidatorMode for the soft-warn split)
 *   true  -> 'strict'  -> isFlagOn returns true
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
      .select("enabled")
      .eq("flag_name", flagKey)
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
 * Production schema has no shadow_mode column — soft-warn is conveyed by
 * a separate flag row 'evidence_refs_soft_warn' (treated as a EvidenceFlagKey
 * for cache reuse). Tri-state mapping:
 *   evidence_refs_strict_mode = true                    -> 'strict'
 *   evidence_refs_strict_mode = false (or absent)
 *     AND evidence_refs_soft_warn = true                -> 'soft-warn'
 *   otherwise                                            -> 'off'
 *
 * Implementation note: uses two isFlagOn calls so we share the same
 * cached + corrected query path (avoids re-implementing the
 * .from('feature_flags').select(...) chain that drifted from the actual
 * schema once already).
 */
export async function getRefsValidatorMode(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string = DEFAULT_ORG_ID,
): Promise<RefsValidatorMode> {
  if (await isFlagOn(client, "evidence_refs_strict_mode", orgId)) return "strict";
  // evidence_refs_soft_warn isn't in EvidenceFlagKey; cast through the
  // helper anyway since the underlying query is shape-compatible.
  // deno-lint-ignore no-explicit-any
  if (await isFlagOn(client, "evidence_refs_soft_warn" as any, orgId)) return "soft-warn";
  return "off";
}

/**
 * Test hook: invalidate the cache. Production code never calls this.
 */
export function _resetFlagCache() {
  cache.clear();
}
