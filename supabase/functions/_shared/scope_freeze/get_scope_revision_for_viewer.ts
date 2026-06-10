// Scope-Memory-Saving M1 (mission scope-freeze-live-2026-06-10, issue #127) —
// read-only single-revision reader backing the ops-api
// `get_scope_revision_for_viewer` action.
//
// The frozen-revision viewer links rendered by ops.html (toggleFrozenRevisions)
// open patio-tool / fence-designer with ?scope_revision_id=<uuid>; both tools'
// integration.js (_autoLoadFrozenRevision) have been POSTing this action since
// step 8 Option B, but the handler never existed — the frozen viewer could
// never hydrate. This helper closes that gap with a pure read.
//
// Contract (matches the live tool callers in patio-tool/tools/shared/
// integration.js and fence-designer/integration.js):
//   * Input  { scope_revision_id }.
//   * Output on success:
//       {
//         ok: true,
//         job_id,
//         // tool-hydration conveniences read directly by integration.js:
//         scope_json,           // JSON.parse(scope_canonical_text)
//         pricing_json_public,  // JSON.parse(pricing_canonical_text)
//         revision_number, status, frozen_at,
//         // full row including the canonical byte contracts, plus its
//         // scope_artifacts rows each carrying a short-lived signed URL:
//         revision: { ...row, artifacts: [{ ...artifactRow, signed_url, signed_url_error? }] },
//         hash_verified: true,
//         signed_url_ttl_seconds: 300,
//       }
//   * Canonical text is HASH-VERIFIED before anything is returned or signed:
//     sha256 over the stored byte contract must equal scope_hash /
//     pricing_hash (same posture as evidence get_evidence_body — a tampered
//     or corrupted frozen record is surfaced, never served silently).
//   * Artefact signed URLs target the PRIVATE scope-artifacts bucket with a
//     short TTL (300 s). One failed signing degrades that single artefact
//     (signed_url: null + signed_url_error) instead of failing the whole
//     viewer load — renders are progressive enhancement over the scope data.
//   * Unknown scope_revision_id → { code: 'revision_not_found' } so the
//     ops-api layer can return 404 (bad link) vs 500 (real failure).
//   * No status restriction: drafts, frozen, and superseded rows are all
//     readable — the row's status travels with the response and the tools
//     render it in the frozen banner.

import type { ScopeArtifactListItem } from './list_scope_revisions.ts'

// ── Types ───────────────────────────────────────────────────────────────────

export type ScopeArtifactViewerItem = ScopeArtifactListItem & {
  // Short-lived signed URL into the private scope-artifacts bucket, or null
  // when signing failed for this artefact (see signed_url_error).
  signed_url: string | null
  signed_url_error?: string
}

export type ScopeRevisionViewerRow = {
  id: string
  job_id: string
  revision_number: number
  status: 'draft' | 'frozen' | 'superseded'
  tool_kind: string
  scope_canonical_text: string
  scope_hash: string
  pricing_canonical_text: string
  pricing_hash: string
  renderer_version: string
  tool_version: string
  model_manifest_json: unknown | null
  model_manifest_hash: string | null
  frozen_at: string | null
  frozen_by_user_id: string | null
  superseded_by_scope_revision_id: string | null
  superseded_at: string | null
  created_at: string
  artifacts: ScopeArtifactViewerItem[]
}

export type GetScopeRevisionForViewerError =
  | { code: 'revision_not_found' }
  | { code: 'hash_mismatch'; field: 'scope' | 'pricing'; expected: string; actual: string }
  | { code: 'canonical_parse_failed'; field: 'scope' | 'pricing'; message: string }
  | { code: 'db_error'; message: string }

export type GetScopeRevisionForViewerResult =
  | {
    ok: true
    job_id: string
    scope_json: unknown
    pricing_json_public: unknown
    revision_number: number
    status: 'draft' | 'frozen' | 'superseded'
    frozen_at: string | null
    revision: ScopeRevisionViewerRow
    hash_verified: true
    signed_url_ttl_seconds: number
  }
  | { ok: false; error: GetScopeRevisionForViewerError }

// Short TTL for the private scope-artifacts bucket. Fixed server-side — the
// caller cannot extend it. 300 s matches signBodyUrl's default in
// _shared/evidence/storage.ts.
export const SIGNED_URL_TTL_SECONDS = 300

// Same column set as list_scope_revisions.ts REVISION_COLS PLUS the two
// canonical byte contracts — this action is the designated full-content read.
const REVISION_COLS =
  'id, job_id, revision_number, status, tool_kind, '
  + 'scope_canonical_text, scope_hash, pricing_canonical_text, pricing_hash, '
  + 'renderer_version, tool_version, model_manifest_json, model_manifest_hash, '
  + 'frozen_at, frozen_by_user_id, superseded_by_scope_revision_id, superseded_at, created_at'

const ARTIFACT_COLS =
  'id, scope_revision_id, artifact_type, storage_path, bucket_id, sha256, '
  + 'size_bytes, content_type, label, created_at'

// sha256 over the EXACT stored bytes (UTF-8). Deliberately not
// canonicalJsonAndHash — the stored text already IS the canonical byte
// contract; re-canonicalizing would mask byte-level corruption.
export async function sha256HexOfText(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const hashBuf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ── Public entry point ──────────────────────────────────────────────────────

export async function getScopeRevisionForViewer(
  // deno-lint-ignore no-explicit-any
  client: any,
  // Storage facade with .from(bucket).createSignedUrl(path, ttl) — ops-api
  // passes client.storage (same wiring as get_evidence_body).
  // deno-lint-ignore no-explicit-any
  storage_client: any,
  input: { scope_revision_id: string },
): Promise<GetScopeRevisionForViewerResult> {
  if (!input || typeof input.scope_revision_id !== 'string' || !input.scope_revision_id) {
    return { ok: false, error: { code: 'db_error', message: 'scope_revision_id required' } }
  }

  // 1. The revision row, canonical text included.
  let row: Record<string, unknown> | null
  try {
    const { data, error } = await client.from('scope_revisions')
      .select(REVISION_COLS)
      .eq('id', input.scope_revision_id)
      .maybeSingle()
    if (error) return { ok: false, error: { code: 'db_error', message: String(error?.message ?? error) } }
    row = data as Record<string, unknown> | null
  } catch (e) {
    return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
  }
  if (!row) return { ok: false, error: { code: 'revision_not_found' } }

  // 2. Hash-verify both byte contracts BEFORE returning content or signing
  // anything. Mismatch means the frozen record no longer matches its seal.
  const scopeText = String(row.scope_canonical_text ?? '')
  const pricingText = String(row.pricing_canonical_text ?? '')
  const scopeActual = await sha256HexOfText(scopeText)
  if (scopeActual !== row.scope_hash) {
    return {
      ok: false,
      error: { code: 'hash_mismatch', field: 'scope', expected: String(row.scope_hash), actual: scopeActual },
    }
  }
  const pricingActual = await sha256HexOfText(pricingText)
  if (pricingActual !== row.pricing_hash) {
    return {
      ok: false,
      error: { code: 'hash_mismatch', field: 'pricing', expected: String(row.pricing_hash), actual: pricingActual },
    }
  }

  // 3. Parse the verified canonical text for the tool-hydration fields.
  // canonicalJsonAndHash always emits valid JSON, so failure here is
  // defensive only.
  let scope_json: unknown
  try {
    scope_json = JSON.parse(scopeText)
  } catch (e) {
    return { ok: false, error: { code: 'canonical_parse_failed', field: 'scope', message: String((e as Error)?.message ?? e) } }
  }
  let pricing_json_public: unknown
  try {
    pricing_json_public = JSON.parse(pricingText)
  } catch (e) {
    return { ok: false, error: { code: 'canonical_parse_failed', field: 'pricing', message: String((e as Error)?.message ?? e) } }
  }

  // 4. Artefact rows, oldest first (same ordering as the list action).
  let artifactRows: Array<Record<string, unknown>>
  try {
    const { data, error } = await client.from('scope_artifacts')
      .select(ARTIFACT_COLS)
      .eq('scope_revision_id', input.scope_revision_id)
      .order('created_at', { ascending: true })
    if (error) return { ok: false, error: { code: 'db_error', message: String(error?.message ?? error) } }
    artifactRows = (data as Array<Record<string, unknown>> | null) ?? []
  } catch (e) {
    return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
  }

  // 5. Short-lived signed URL per artefact. Per-artefact degradation: a
  // failed signing nulls that artefact's URL but never blocks the scope data.
  const artifacts: ScopeArtifactViewerItem[] = []
  for (const a of artifactRows) {
    const base = a as unknown as ScopeArtifactListItem
    try {
      const { data, error } = await storage_client
        .from(String(a.bucket_id))
        .createSignedUrl(String(a.storage_path), SIGNED_URL_TTL_SECONDS)
      if (error || !data?.signedUrl) {
        artifacts.push({ ...base, signed_url: null, signed_url_error: String(error?.message ?? 'no url') })
      } else {
        artifacts.push({ ...base, signed_url: String(data.signedUrl) })
      }
    } catch (e) {
      artifacts.push({ ...base, signed_url: null, signed_url_error: String((e as Error)?.message ?? e) })
    }
  }

  const revision: ScopeRevisionViewerRow = {
    ...(row as unknown as Omit<ScopeRevisionViewerRow, 'artifacts'>),
    artifacts,
  }

  return {
    ok: true,
    job_id: revision.job_id,
    scope_json,
    pricing_json_public,
    revision_number: revision.revision_number,
    status: revision.status,
    frozen_at: revision.frozen_at,
    revision,
    hash_verified: true,
    signed_url_ttl_seconds: SIGNED_URL_TTL_SECONDS,
  }
}
