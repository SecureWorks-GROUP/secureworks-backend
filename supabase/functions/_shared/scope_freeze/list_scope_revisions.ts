// Scope-Memory-Saving M1 (mission scope-freeze-live-2026-06-10, issue #127) —
// read-only lister backing the ops-api `list_scope_revisions_for_job` action.
//
// ops.html's "View Frozen Revisions" picker (toggleFrozenRevisions, ~line
// 4444) has been POSTing this action since step 8 Option B landed, but the
// handler never existed — the panel could never load. This helper closes that
// gap with a pure read: no freeze, no clone, no signed URLs, no storage I/O.
//
// Contract (matches the ops.html caller):
//   * Input  { job_id }.
//   * Output { ok: true, job_id, revisions: [...] } — revisions ordered
//     revision_number DESC (newest first), each row carrying its
//     scope_artifacts rows (created_at ASC) under `artifacts`.
//   * scope_canonical_text / pricing_canonical_text are intentionally
//     EXCLUDED — they are the multi-KB byte contracts; the list view needs
//     hashes + metadata only. The get_scope_revision_for_viewer action
//     (./get_scope_revision_for_viewer.ts) owns full-content reads
//     (hash-verified) and signed artefact URLs.
//   * Unknown job_id → { code: 'job_not_found' } so the UI can distinguish
//     "bad id" from "no revisions yet".

// ── Types ───────────────────────────────────────────────────────────────────

export type ScopeRevisionListItem = {
  id: string
  job_id: string
  revision_number: number
  status: 'draft' | 'frozen' | 'superseded'
  tool_kind: string
  scope_hash: string
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
  artifacts: ScopeArtifactListItem[]
}

export type ScopeArtifactListItem = {
  id: string
  scope_revision_id: string
  artifact_type: string
  storage_path: string
  bucket_id: string
  sha256: string
  size_bytes: number
  content_type: string
  label: string | null
  created_at: string
}

export type ListScopeRevisionsError =
  | { code: 'job_not_found' }
  | { code: 'db_error'; message: string }

export type ListScopeRevisionsResult =
  | { ok: true; job_id: string; revisions: ScopeRevisionListItem[] }
  | { ok: false; error: ListScopeRevisionsError }

const REVISION_COLS =
  'id, job_id, revision_number, status, tool_kind, scope_hash, pricing_hash, '
  + 'renderer_version, tool_version, model_manifest_json, model_manifest_hash, '
  + 'frozen_at, frozen_by_user_id, superseded_by_scope_revision_id, superseded_at, created_at'

const ARTIFACT_COLS =
  'id, scope_revision_id, artifact_type, storage_path, bucket_id, sha256, '
  + 'size_bytes, content_type, label, created_at'

// ── Public entry point ──────────────────────────────────────────────────────

export async function listScopeRevisionsForJob(
  client: any,
  input: { job_id: string },
): Promise<ListScopeRevisionsResult> {
  if (!input || typeof input.job_id !== 'string' || !input.job_id) {
    return { ok: false, error: { code: 'db_error', message: 'job_id required' } }
  }

  // 1. Verify the job exists so the caller can tell a bad id apart from a
  // job that simply has no frozen revisions yet.
  try {
    const { data, error } = await client.from('jobs')
      .select('id')
      .eq('id', input.job_id)
      .maybeSingle()
    if (error) return { ok: false, error: { code: 'db_error', message: String(error?.message ?? error) } }
    if (!data) return { ok: false, error: { code: 'job_not_found' } }
  } catch (e) {
    return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
  }

  // 2. Revisions, newest first. Hashes + metadata only (no canonical text).
  let revisionRows: Array<Record<string, unknown>>
  try {
    const { data, error } = await client.from('scope_revisions')
      .select(REVISION_COLS)
      .eq('job_id', input.job_id)
      .order('revision_number', { ascending: false })
    if (error) return { ok: false, error: { code: 'db_error', message: String(error?.message ?? error) } }
    revisionRows = (data as Array<Record<string, unknown>> | null) ?? []
  } catch (e) {
    return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
  }

  if (revisionRows.length === 0) {
    return { ok: true, job_id: input.job_id, revisions: [] }
  }

  // 3. Artefact rows for all revisions in one query, grouped client-side.
  const revisionIds = revisionRows.map((r) => String(r.id))
  let artifactRows: Array<Record<string, unknown>>
  try {
    const { data, error } = await client.from('scope_artifacts')
      .select(ARTIFACT_COLS)
      .in('scope_revision_id', revisionIds)
      .order('created_at', { ascending: true })
    if (error) return { ok: false, error: { code: 'db_error', message: String(error?.message ?? error) } }
    artifactRows = (data as Array<Record<string, unknown>> | null) ?? []
  } catch (e) {
    return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
  }

  const byRevision = new Map<string, ScopeArtifactListItem[]>()
  for (const a of artifactRows) {
    const key = String(a.scope_revision_id)
    if (!byRevision.has(key)) byRevision.set(key, [])
    byRevision.get(key)!.push(a as unknown as ScopeArtifactListItem)
  }

  const revisions = revisionRows.map((r) => ({
    ...(r as unknown as Omit<ScopeRevisionListItem, 'artifacts'>),
    artifacts: byRevision.get(String(r.id)) ?? [],
  }))

  return { ok: true, job_id: input.job_id, revisions }
}
