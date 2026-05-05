// Scope-Memory-Saving Loop 1, step 7 — load frozen WO inputs.
//
// Server-side helper used by ops-api create_work_order when the caller
// supplies a scope_revision_id. Returns the frozen scope/pricing/tool
// versions + the scope_artifacts rows that materialise that revision.
// Refuses to fall back to mutable jobs.scope_json when a frozen revision
// is requested — the strategy doc § 6 step 6 hard rule is "no work-order
// PDF generated from mutable state."
//
// The helper is structured so callers (ops-api today, the read-only
// viewer in step 8) get the same answer for the same input — same order,
// same shape, same canonical bytes. That means a downstream sha256 of any
// rendered artifact is reproducible from this helper's output.

import { canonicalJsonAndHash } from '../release_packet/canonicalize.ts'

// ── Types ──────────────────────────────────────────────────────────────────

export type LoadFrozenWorkOrderInputsRequest = {
  scope_revision_id: string
  // Optional cross-job guard. When supplied, the helper rejects the load if
  // the frozen revision's stored job_id does not match this value. Used by
  // ops-api create_work_order to refuse cross-job citations like passing
  // job_id=JOB-A together with scope_revision_id=rev-from-JOB-B (which
  // would otherwise produce a WO whose scope_items describe a different
  // customer's project). Omitted by the future read-only viewer in step 8
  // which legitimately loads any frozen revision by id alone for replay.
  job_id?: string
}

export type FrozenScopeArtifact = {
  id: string
  artifact_type: string
  storage_path: string
  bucket_id: string
  sha256: string
  size_bytes: number
  content_type: string
  label: string | null
  created_at: string
}

export type LoadFrozenWorkOrderInputsOk = {
  ok: true
  scope_revision_id: string
  job_id: string
  revision_number: number
  tool_kind: string
  scope_canonical_text: string
  scope_hash: string
  scope_json: Record<string, unknown>
  pricing_canonical_text: string
  pricing_hash: string
  pricing_json: Record<string, unknown>
  renderer_version: string
  tool_version: string
  frozen_at: string | null
  frozen_by_user_id: string | null
  status: 'frozen' | 'superseded'
  artifacts: FrozenScopeArtifact[]
}

export type LoadFrozenWorkOrderInputsError =
  | { code: 'invalid_input'; field: string; message: string }
  | { code: 'scope_revision_not_found' }
  | { code: 'scope_revision_not_frozen'; current_status: string }
  | { code: 'cross_job_mismatch'; expected_job_id: string; actual_job_id: string }
  | { code: 'integrity_error'; message: string }
  | { code: 'db_error'; message: string }

export type LoadFrozenWorkOrderInputsResult =
  | LoadFrozenWorkOrderInputsOk
  | { ok: false; error: LoadFrozenWorkOrderInputsError }

// ── Public entry point ─────────────────────────────────────────────────────

export async function loadFrozenWorkOrderInputs(
  client: any,
  input: LoadFrozenWorkOrderInputsRequest,
): Promise<LoadFrozenWorkOrderInputsResult> {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: { code: 'invalid_input', field: 'body', message: 'request body required' } }
  }
  if (!input.scope_revision_id || typeof input.scope_revision_id !== 'string') {
    return { ok: false, error: { code: 'invalid_input', field: 'scope_revision_id', message: 'scope_revision_id required' } }
  }

  // 1. Fetch the revision row.
  type RevRow = {
    id: string
    job_id: string
    revision_number: number
    tool_kind: string
    scope_canonical_text: string
    scope_hash: string
    pricing_canonical_text: string
    pricing_hash: string
    renderer_version: string
    tool_version: string
    frozen_at: string | null
    frozen_by_user_id: string | null
    status: 'draft' | 'frozen' | 'superseded'
  }
  let revision: RevRow | null = null
  try {
    const { data, error } = await client.from('scope_revisions')
      .select('id, job_id, revision_number, tool_kind, scope_canonical_text, scope_hash, pricing_canonical_text, pricing_hash, renderer_version, tool_version, frozen_at, frozen_by_user_id, status')
      .eq('id', input.scope_revision_id)
      .maybeSingle()
    if (error) {
      return { ok: false, error: { code: 'db_error', message: String(error?.message ?? error) } }
    }
    revision = (data as RevRow | null) ?? null
  } catch (e: any) {
    return { ok: false, error: { code: 'db_error', message: String(e?.message ?? e) } }
  }
  if (!revision) {
    return { ok: false, error: { code: 'scope_revision_not_found' } }
  }
  // 2. Cross-job guard. When the caller supplies a job_id, the loaded
  //    revision's job_id must match. This prevents a caller from citing
  //    a frozen revision that belongs to a different job — which would
  //    silently bind a work order to the wrong customer's scope content.
  //    The viewer in step 8 omits job_id and skips this check.
  if (input.job_id !== undefined && input.job_id !== null) {
    if (revision.job_id !== input.job_id) {
      return {
        ok: false,
        error: {
          code: 'cross_job_mismatch',
          expected_job_id: input.job_id,
          actual_job_id: revision.job_id,
        },
      }
    }
  }
  // 3. Refuse non-frozen revisions. Drafts (still being edited) and
  //    superseded rows (replaced by a higher revision) are not valid sources
  //    for a NEW work order. Superseded rows remain readable for the viewer
  //    in step 8 but a work order cited at a superseded revision should
  //    have already been generated when that revision was the latest frozen.
  if (revision.status !== 'frozen' && revision.status !== 'superseded') {
    return {
      ok: false,
      error: { code: 'scope_revision_not_frozen', current_status: revision.status },
    }
  }
  // ops-api refuses superseded sources for create_work_order; the viewer
  // can still call this helper for read-only display. The discriminator is
  // up to the caller — we surface status truthfully.

  // 3. Parse the canonical bytes back into JSON. Guarantee:
  //    canonicalJsonAndHash(parsed_scope_json).hash === revision.scope_hash
  //    is the integrity contract between the freeze flow and this read.
  let scope_json: Record<string, unknown>
  let pricing_json: Record<string, unknown>
  try {
    scope_json = JSON.parse(revision.scope_canonical_text) as Record<string, unknown>
    pricing_json = JSON.parse(revision.pricing_canonical_text) as Record<string, unknown>
  } catch (e: any) {
    return {
      ok: false,
      error: {
        code: 'integrity_error',
        message: `failed to parse canonical bytes for revision ${revision.id}: ${e?.message ?? e}`,
      },
    }
  }

  // 4. Verify the bytes still hash to the recorded hashes. This is a
  //    defense-in-depth check — the immutability trigger should make
  //    drift impossible, but the helper's output is what downstream
  //    artifact persistence depends on, so we re-validate before
  //    returning. A failure here means the row was tampered or the
  //    canonicalize implementation drifted.
  try {
    const reScope = await canonicalJsonAndHash(scope_json)
    if (reScope.hash !== revision.scope_hash) {
      return {
        ok: false,
        error: {
          code: 'integrity_error',
          message: `scope_hash mismatch on revision ${revision.id}: stored=${revision.scope_hash} recomputed=${reScope.hash}`,
        },
      }
    }
    const rePricing = await canonicalJsonAndHash(pricing_json)
    if (rePricing.hash !== revision.pricing_hash) {
      return {
        ok: false,
        error: {
          code: 'integrity_error',
          message: `pricing_hash mismatch on revision ${revision.id}: stored=${revision.pricing_hash} recomputed=${rePricing.hash}`,
        },
      }
    }
  } catch (e: any) {
    return {
      ok: false,
      error: { code: 'integrity_error', message: `hash recompute threw: ${e?.message ?? e}` },
    }
  }

  // 5. Fetch the artifacts associated with the revision. Ordered by
  //    artifact_type for deterministic output (so a downstream sha256
  //    of a JSON dump of this output is reproducible). Empty list is
  //    fine — early Loop 1 freezes have no artifacts yet.
  let artifacts: FrozenScopeArtifact[] = []
  try {
    const { data, error } = await client.from('scope_artifacts')
      .select('id, artifact_type, storage_path, bucket_id, sha256, size_bytes, content_type, label, created_at')
      .eq('scope_revision_id', revision.id)
      .order('artifact_type', { ascending: true })
    if (error) {
      return { ok: false, error: { code: 'db_error', message: String(error?.message ?? error) } }
    }
    artifacts = ((data as FrozenScopeArtifact[] | null) ?? []).slice()
  } catch (e: any) {
    return { ok: false, error: { code: 'db_error', message: String(e?.message ?? e) } }
  }

  return {
    ok: true,
    scope_revision_id: revision.id,
    job_id: revision.job_id,
    revision_number: revision.revision_number,
    tool_kind: revision.tool_kind,
    scope_canonical_text: revision.scope_canonical_text,
    scope_hash: revision.scope_hash,
    scope_json,
    pricing_canonical_text: revision.pricing_canonical_text,
    pricing_hash: revision.pricing_hash,
    pricing_json,
    renderer_version: revision.renderer_version,
    tool_version: revision.tool_version,
    frozen_at: revision.frozen_at,
    frozen_by_user_id: revision.frozen_by_user_id,
    status: revision.status,
    artifacts,
  }
}
