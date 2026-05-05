// Scope-Memory-Saving Loop 1, step 4 — frozen-scope helper primitives.
//
// Two pure-ish helpers that own the freeze + clone-to-edit semantics for
// scope_revisions / scope_artifacts (migration 20260504000001). Both helpers
// take an injected Supabase client (PostgREST builder shape) so they unit
// test cleanly against the in-memory mock used elsewhere in supabase/functions
// and run against the real service-role client when wired through ops-api.
//
// The semantics are the contract that every later phase depends on
// (V2 release-packet citation, work-order PDF generation, read-only viewer,
// T7 evidence_refs[]). Once frozen, a revision row is locked by trigger
// (see migrations/_drafts/20260504000001_scope_revisions_and_artifacts.sql,
// trg_scope_revisions_controlled_immutable). These helpers respect that
// surface — they never attempt to mutate a frozen contract column.
//
// Out of scope for this leg:
//   * scope_artifacts uploads (Loop 2 step 5).
//   * V2 release-packet citation (step 6).
//   * Patio/Fence UI wiring (step 5+).
//   * T7 spine_event_id population — the helpers leave the column NULL so
//     the recordEvidence path can teach channel='scope' independently and
//     fill it in via the supersession+spine NULL→NOT NULL transition the
//     trigger explicitly allows.

import { canonicalJsonAndHash } from '../release_packet/canonicalize.ts'

// ── Types ───────────────────────────────────────────────────────────────────

export type ToolKind =
  | 'patio'
  | 'fencing'
  | 'decking'
  | 'quick_quote'
  | 'gate'
  | 'repair'
  | 'general'

export const TOOL_KINDS: ReadonlyArray<ToolKind> = [
  'patio', 'fencing', 'decking', 'quick_quote', 'gate', 'repair', 'general',
]

export function isToolKind(v: unknown): v is ToolKind {
  return typeof v === 'string' && (TOOL_KINDS as readonly string[]).includes(v)
}

// Default renderer/tool versions per kind. The tool itself (patio-tool /
// fence-designer build) should override these via the input when Loop 2 wires
// the freeze button. Defaults exist so ops-api callers can ship without a
// build sha (e.g. quick_quote, general) and so tests have stable values.
const DEFAULT_RENDERER: Record<ToolKind, string> = {
  patio:       'three.js@r128',
  fencing:     'fence-designer@unknown',
  decking:     'none',
  quick_quote: 'none',
  gate:        'none',
  repair:      'none',
  general:     'none',
}
const DEFAULT_TOOL: Record<ToolKind, string> = {
  patio:       'PatioDesignerPro_V18',
  fencing:     'fence-designer@unknown',
  decking:     'decking@unknown',
  quick_quote: 'quick_quote@v1',
  gate:        'gate@unknown',
  repair:      'repair@unknown',
  general:     'general@unknown',
}

export type FreezeScopeInput = {
  job_id: string
  tool_kind: ToolKind
  renderer_version?: string
  tool_version?: string
  frozen_by_user_id?: string | null
}

export type FreezeScopeError =
  | { code: 'job_not_found' }
  | { code: 'invalid_tool_kind'; provided: unknown }
  | { code: 'job_missing_scope' }
  | { code: 'job_missing_pricing' }
  | { code: 'inconsistent_state'; message: string }
  | { code: 'db_error'; message: string }

export type FreezeScopeOk = {
  ok: true
  scope_revision_id: string
  revision_number: number
  scope_hash: string
  pricing_hash: string
  tool_kind: ToolKind
  status: 'frozen'
  // The id of the immediate predecessor (revision_number = N-1) that the
  // freeze + heal step transitioned to 'superseded'. Null when there was no
  // predecessor or it was already superseded before this call.
  superseded_revision_id: string | null
  // Older stray frozen rows that the heal step also superseded — populated
  // when a previous incident had left more than one row in 'frozen' state
  // for this job. Empty in the normal happy path.
  additional_superseded_revision_ids: string[]
}

export type FreezeScopeResult = FreezeScopeOk | { ok: false; error: FreezeScopeError }

export type CloneScopeForEditInput = {
  scope_revision_id: string
  // Default true. When true the helper writes the cloned canonicals back into
  // jobs.scope_json + jobs.pricing_json so the patio-tool / fence-designer
  // working state matches the cloned-from frozen revision. Loop 2 uses this.
  // Tests can pass false to assert the jobs row is left untouched.
  write_jobs_working_state?: boolean
}

export type CloneScopeForEditError =
  | { code: 'source_not_found' }
  | { code: 'source_not_frozen'; current_status: string }
  | { code: 'source_not_latest'; latest_revision_number: number }
  | { code: 'draft_already_exists'; existing_draft_revision_id: string }
  | { code: 'db_error'; message: string }

export type CloneScopeForEditOk = {
  ok: true
  scope_revision_id: string
  revision_number: number
  status: 'draft'
  cloned_from_scope_revision_id: string
  jobs_working_state_written: boolean
}

export type CloneScopeForEditResult =
  | CloneScopeForEditOk
  | { ok: false; error: CloneScopeForEditError }

// ── Internal helpers ────────────────────────────────────────────────────────

function isPlainObjectWithKeys(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0
}

type ScopeRevisionRow = {
  id: string
  job_id: string
  revision_number: number
  status: 'draft' | 'frozen' | 'superseded'
  scope_canonical_text: string
  scope_hash: string
  pricing_canonical_text: string
  pricing_hash: string
  renderer_version: string
  tool_version: string
  tool_kind: ToolKind
}

async function fetchJobScope(
  client: any,
  job_id: string,
): Promise<{ ok: true; row: { id: string; scope_json: unknown; pricing_json: unknown } } | { ok: false; error: FreezeScopeError }> {
  try {
    const { data, error } = await client.from('jobs')
      .select('id, scope_json, pricing_json')
      .eq('id', job_id)
      .maybeSingle()
    if (error) return { ok: false, error: { code: 'db_error', message: String(error?.message ?? error) } }
    if (!data) return { ok: false, error: { code: 'job_not_found' } }
    return { ok: true, row: data }
  } catch (e) {
    return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
  }
}

async function fetchLatestRevision(
  client: any,
  job_id: string,
): Promise<{ ok: true; row: ScopeRevisionRow | null } | { ok: false; error: { code: 'db_error'; message: string } }> {
  try {
    const { data, error } = await client.from('scope_revisions')
      .select('id, job_id, revision_number, status, scope_canonical_text, scope_hash, pricing_canonical_text, pricing_hash, renderer_version, tool_version, tool_kind')
      .eq('job_id', job_id)
      .order('revision_number', { ascending: false })
      .limit(1)
    if (error) return { ok: false, error: { code: 'db_error', message: String(error?.message ?? error) } }
    const arr = (data as ScopeRevisionRow[] | null) ?? []
    return { ok: true, row: arr[0] ?? null }
  } catch (e) {
    return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
  }
}

async function fetchRevisionById(
  client: any,
  scope_revision_id: string,
): Promise<{ ok: true; row: ScopeRevisionRow | null } | { ok: false; error: { code: 'db_error'; message: string } }> {
  try {
    const { data, error } = await client.from('scope_revisions')
      .select('id, job_id, revision_number, status, scope_canonical_text, scope_hash, pricing_canonical_text, pricing_hash, renderer_version, tool_version, tool_kind')
      .eq('id', scope_revision_id)
      .maybeSingle()
    if (error) return { ok: false, error: { code: 'db_error', message: String(error?.message ?? error) } }
    return { ok: true, row: (data as ScopeRevisionRow | null) ?? null }
  } catch (e) {
    return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
  }
}

// ── freezeScope ─────────────────────────────────────────────────────────────

export async function freezeScope(
  client: any,
  input: FreezeScopeInput,
): Promise<FreezeScopeResult> {
  if (!isToolKind(input.tool_kind)) {
    return { ok: false, error: { code: 'invalid_tool_kind', provided: input.tool_kind } }
  }
  const tool_kind = input.tool_kind
  const renderer_version = input.renderer_version ?? DEFAULT_RENDERER[tool_kind]
  const tool_version = input.tool_version ?? DEFAULT_TOOL[tool_kind]
  const frozen_by_user_id = input.frozen_by_user_id ?? null

  const job = await fetchJobScope(client, input.job_id)
  if (!job.ok) return job

  if (!isPlainObjectWithKeys(job.row.scope_json)) {
    return { ok: false, error: { code: 'job_missing_scope' } }
  }
  if (!isPlainObjectWithKeys(job.row.pricing_json)) {
    return { ok: false, error: { code: 'job_missing_pricing' } }
  }

  const { canonical: scope_canonical_text, hash: scope_hash } =
    await canonicalJsonAndHash(job.row.scope_json)
  const { canonical: pricing_canonical_text, hash: pricing_hash } =
    await canonicalJsonAndHash(job.row.pricing_json)

  const latest = await fetchLatestRevision(client, input.job_id)
  if (!latest.ok) return { ok: false, error: latest.error }

  const frozen_at = new Date().toISOString()

  // Case A: no prior revision → INSERT frozen v1.
  // Case B: prior is draft     → UPDATE draft v(N) to frozen, then supersede
  //                              v(N-1) if it exists (the partial WHERE
  //                              status='frozen' index must return exactly
  //                              one row per job).
  // Case C: prior is frozen    → INSERT frozen v(N+1), then supersede prior.
  // Case D: prior is superseded with no higher row → inconsistent (reject).
  const prior = latest.row

  if (prior == null) {
    return await insertFreshFrozenAndHeal(client, {
      job_id: input.job_id,
      revision_number: 1,
      tool_kind,
      scope_canonical_text, scope_hash,
      pricing_canonical_text, pricing_hash,
      renderer_version, tool_version,
      frozen_at, frozen_by_user_id,
    })
  }

  if (prior.status === 'draft') {
    return await promoteDraftToFrozen(client, prior, {
      tool_kind,
      scope_canonical_text, scope_hash,
      pricing_canonical_text, pricing_hash,
      renderer_version, tool_version,
      frozen_at, frozen_by_user_id,
    })
  }

  if (prior.status === 'frozen') {
    return await insertNextFrozen(client, prior, {
      job_id: input.job_id,
      revision_number: prior.revision_number + 1,
      tool_kind,
      scope_canonical_text, scope_hash,
      pricing_canonical_text, pricing_hash,
      renderer_version, tool_version,
      frozen_at, frozen_by_user_id,
    })
  }

  return {
    ok: false,
    error: {
      code: 'inconsistent_state',
      message: `latest scope_revisions row for job_id=${input.job_id} is status='${prior.status}' with revision_number=${prior.revision_number} — no higher revision exists, which violates supersede invariants. Investigate before retrying.`,
    },
  }
}

type FrozenInsertPayload = {
  job_id: string
  revision_number: number
  tool_kind: ToolKind
  scope_canonical_text: string
  scope_hash: string
  pricing_canonical_text: string
  pricing_hash: string
  renderer_version: string
  tool_version: string
  frozen_at: string
  frozen_by_user_id: string | null
}

async function insertFreshFrozenRow(
  client: any,
  p: FrozenInsertPayload,
): Promise<{ ok: true; id: string; revision_number: number } | { ok: false; message: string }> {
  try {
    const { data, error } = await client.from('scope_revisions')
      .insert({
        job_id: p.job_id,
        revision_number: p.revision_number,
        tool_kind: p.tool_kind,
        scope_canonical_text: p.scope_canonical_text,
        scope_hash: p.scope_hash,
        pricing_canonical_text: p.pricing_canonical_text,
        pricing_hash: p.pricing_hash,
        renderer_version: p.renderer_version,
        tool_version: p.tool_version,
        status: 'frozen',
        frozen_at: p.frozen_at,
        frozen_by_user_id: p.frozen_by_user_id,
      })
      .select('id, revision_number')
      .single()
    if (error || !data) {
      return { ok: false, message: String(error?.message ?? 'insert returned no row') }
    }
    return { ok: true, id: data.id, revision_number: data.revision_number ?? p.revision_number }
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message ?? e) }
  }
}

async function promoteDraftToFrozen(
  client: any,
  draft: ScopeRevisionRow,
  p: Omit<FrozenInsertPayload, 'job_id' | 'revision_number'>,
): Promise<FreezeScopeResult> {
  // Step 1: promote the draft row to frozen with refreshed canonicals.
  let promotedId: string
  let promotedRevisionNumber: number
  try {
    const { data, error } = await client.from('scope_revisions')
      .update({
        tool_kind: p.tool_kind,
        scope_canonical_text: p.scope_canonical_text,
        scope_hash: p.scope_hash,
        pricing_canonical_text: p.pricing_canonical_text,
        pricing_hash: p.pricing_hash,
        renderer_version: p.renderer_version,
        tool_version: p.tool_version,
        status: 'frozen',
        frozen_at: p.frozen_at,
        frozen_by_user_id: p.frozen_by_user_id,
      })
      .eq('id', draft.id)
      .eq('status', 'draft')
      .select('id, revision_number')
      .single()
    if (error || !data) {
      return { ok: false, error: { code: 'db_error', message: String(error?.message ?? 'no row updated; possible concurrent freeze') } }
    }
    promotedId = data.id
    promotedRevisionNumber = data.revision_number ?? draft.revision_number
  } catch (e) {
    return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
  }

  // Step 2: heal the "≤1 frozen row per job" invariant. After step 1 there
  // can be 1, 2, or in pathological cases more frozen rows for this job
  // (e.g. a prior incident left v(N-1) frozen alongside the freshly-promoted
  // v(N), or stray older frozen rows from earlier incidents). The heal
  // supersedes every frozen row except the highest-revision one. It is
  // idempotent: if step 1 alone already left exactly one frozen row, the
  // heal is a no-op.
  return finalizeWithHeal(client, draft.job_id, {
    promoted_id: promotedId,
    promoted_revision_number: promotedRevisionNumber,
    p,
  })
}

async function insertFreshFrozenAndHeal(
  client: any,
  p: FrozenInsertPayload,
): Promise<FreezeScopeResult> {
  // Step 1: insert v(N) as frozen.
  const inserted = await insertFreshFrozenRow(client, p)
  if (!inserted.ok) return { ok: false, error: { code: 'db_error', message: inserted.message } }

  // Step 2: heal — supersede every other frozen row for this job. For case A
  // (no prior revision) this is a no-op. For case C (prior was frozen) the
  // heal replaces the explicit single-row supersession the previous version
  // attempted, so a partial-failure window can no longer leave two
  // 'frozen' rows persisted.
  return finalizeWithHeal(client, p.job_id, {
    promoted_id: inserted.id,
    promoted_revision_number: inserted.revision_number,
    p: { frozen_at: p.frozen_at, scope_hash: p.scope_hash, pricing_hash: p.pricing_hash, tool_kind: p.tool_kind },
  })
}

async function insertNextFrozen(
  client: any,
  _prior: ScopeRevisionRow,
  p: FrozenInsertPayload,
): Promise<FreezeScopeResult> {
  // Case C: same shape as case A — INSERT then heal. The heal supersedes
  // both the prior frozen row AND any older stray frozen rows that a
  // previous incident may have left behind.
  return insertFreshFrozenAndHeal(client, p)
}

async function finalizeWithHeal(
  client: any,
  job_id: string,
  ctx: {
    promoted_id: string
    promoted_revision_number: number
    p: { frozen_at: string; scope_hash: string; pricing_hash: string; tool_kind: ToolKind }
  },
): Promise<FreezeScopeResult> {
  const heal = await healFrozenInvariant(client, job_id, ctx.p.frozen_at)
  if (!heal.ok) {
    return {
      ok: false,
      error: {
        code: 'db_error',
        message: `promoted v${ctx.promoted_revision_number} (${ctx.promoted_id}) but heal failed: ${heal.message}. Re-run freezeScope or call heal_scope_revisions for this job_id to recover.`,
      },
    }
  }
  // Sanity: the heal should have left exactly one frozen row, and it should
  // be the one we just promoted. If something else bubbled to the top
  // (concurrent writer), surface it.
  if (heal.current_frozen_id !== ctx.promoted_id) {
    return {
      ok: false,
      error: {
        code: 'inconsistent_state',
        message: `heal completed but the current frozen row is ${heal.current_frozen_id}, not the row this freeze promoted (${ctx.promoted_id}). A concurrent writer may have superseded this freeze. Re-read state before retrying.`,
      },
    }
  }
  // Find the immediate predecessor (revision N-1) among the rows the heal
  // superseded so the response can name it. If the heal also superseded
  // older stray rows, list them too for observability.
  const predecessor_id =
    heal.superseded.find((r) => r.revision_number === ctx.promoted_revision_number - 1)?.id ?? null
  const additional_superseded_revision_ids = heal.superseded
    .filter((r) => r.revision_number !== ctx.promoted_revision_number - 1)
    .map((r) => r.id)
  return {
    ok: true,
    scope_revision_id: ctx.promoted_id,
    revision_number: ctx.promoted_revision_number,
    scope_hash: ctx.p.scope_hash,
    pricing_hash: ctx.p.pricing_hash,
    tool_kind: ctx.p.tool_kind,
    status: 'frozen',
    superseded_revision_id: predecessor_id,
    additional_superseded_revision_ids,
  }
}

// ── healFrozenInvariant ─────────────────────────────────────────────────────
// Idempotent guard for the "at most one frozen scope_revisions row per job"
// invariant. Used as the final step of freezeScope and exposed for admin use
// when an incident must be cleaned up out-of-band.
//
// Algorithm:
//   1. Read all rows for the job with status='frozen', ordered by
//      revision_number DESC.
//   2. If 0 or 1 rows, no-op.
//   3. Otherwise, keep the highest-revision row as the "current frozen" and
//      UPDATE every other frozen row to status='superseded' with
//      superseded_by_scope_revision_id = current_frozen.id and
//      superseded_at = when_iso. Each UPDATE is independent — the trigger
//      enforces the supersession transition rules. Idempotent on retry.
//
// Failure modes:
//   * One of the supersede UPDATEs fails. The function returns
//     { ok: false, ... } with a structured message naming the row that did
//     not heal. The caller can re-run; the next run sees the rows that did
//     get healed and only acts on the remaining ones.

export type HealFrozenInvariantOk = {
  ok: true
  current_frozen_id: string | null
  superseded: { id: string; revision_number: number }[]
}

export type HealFrozenInvariantResult =
  | HealFrozenInvariantOk
  | { ok: false; message: string; superseded_so_far: { id: string; revision_number: number }[] }

export async function healFrozenInvariant(
  client: any,
  job_id: string,
  when_iso: string,
): Promise<HealFrozenInvariantResult> {
  let rows: { id: string; revision_number: number }[]
  try {
    const { data, error } = await client.from('scope_revisions')
      .select('id, revision_number')
      .eq('job_id', job_id)
      .eq('status', 'frozen')
      .order('revision_number', { ascending: false })
    if (error) return { ok: false, message: String(error?.message ?? error), superseded_so_far: [] }
    rows = ((data as any) ?? []) as { id: string; revision_number: number }[]
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message ?? e), superseded_so_far: [] }
  }
  if (rows.length === 0) return { ok: true, current_frozen_id: null, superseded: [] }
  if (rows.length === 1) return { ok: true, current_frozen_id: rows[0].id, superseded: [] }

  const newest = rows[0]
  const olders = rows.slice(1)
  const superseded: { id: string; revision_number: number }[] = []
  for (const older of olders) {
    try {
      const { data, error } = await client.from('scope_revisions')
        .update({
          status: 'superseded',
          superseded_at: when_iso,
          superseded_by_scope_revision_id: newest.id,
        })
        .eq('id', older.id)
        .eq('status', 'frozen')
        .select('id')
        .single()
      if (error || !data) {
        return {
          ok: false,
          message: `failed to supersede ${older.id} (revision_number=${older.revision_number}) under ${newest.id}: ${error?.message ?? 'no row updated'}`,
          superseded_so_far: superseded,
        }
      }
      superseded.push(older)
    } catch (e) {
      return {
        ok: false,
        message: `failed to supersede ${older.id}: ${(e as Error)?.message ?? e}`,
        superseded_so_far: superseded,
      }
    }
  }
  return { ok: true, current_frozen_id: newest.id, superseded }
}

// ── cloneScopeForEdit ──────────────────────────────────────────────────────

export async function cloneScopeForEdit(
  client: any,
  input: CloneScopeForEditInput,
): Promise<CloneScopeForEditResult> {
  const writeWorkingState = input.write_jobs_working_state !== false

  const src = await fetchRevisionById(client, input.scope_revision_id)
  if (!src.ok) return { ok: false, error: src.error }
  if (!src.row) return { ok: false, error: { code: 'source_not_found' } }
  const source = src.row

  if (source.status !== 'frozen') {
    return { ok: false, error: { code: 'source_not_frozen', current_status: source.status } }
  }

  const latest = await fetchLatestRevision(client, source.job_id)
  if (!latest.ok) return { ok: false, error: latest.error }
  const top = latest.row
  if (!top) {
    return {
      ok: false,
      error: { code: 'db_error', message: 'latest revision query returned empty after fetching by id' },
    }
  }
  if (top.id !== source.id) {
    if (top.status === 'draft') {
      return { ok: false, error: { code: 'draft_already_exists', existing_draft_revision_id: top.id } }
    }
    return { ok: false, error: { code: 'source_not_latest', latest_revision_number: top.revision_number } }
  }

  const next_revision_number = source.revision_number + 1

  const draftInsert = await (async (): Promise<
    | { ok: true; row: { id: string; revision_number: number } }
    | { ok: false; message: string }
  > => {
    try {
      const { data, error } = await client.from('scope_revisions')
        .insert({
          job_id: source.job_id,
          revision_number: next_revision_number,
          tool_kind: source.tool_kind,
          scope_canonical_text: source.scope_canonical_text,
          scope_hash: source.scope_hash,
          pricing_canonical_text: source.pricing_canonical_text,
          pricing_hash: source.pricing_hash,
          renderer_version: source.renderer_version,
          tool_version: source.tool_version,
          status: 'draft',
        })
        .select('id, revision_number')
        .single()
      if (error || !data) {
        return { ok: false, message: String(error?.message ?? 'insert returned no row') }
      }
      return { ok: true, row: data }
    } catch (e) {
      return { ok: false, message: String((e as Error)?.message ?? e) }
    }
  })()
  if (!draftInsert.ok) {
    return { ok: false, error: { code: 'db_error', message: draftInsert.message } }
  }
  const inserted = draftInsert.row

  let jobs_working_state_written = false
  if (writeWorkingState) {
    try {
      const scope_json = JSON.parse(source.scope_canonical_text)
      const pricing_json = JSON.parse(source.pricing_canonical_text)
      const { error } = await client.from('jobs')
        .update({ scope_json, pricing_json })
        .eq('id', source.job_id)
      if (error) {
        // Draft row exists but jobs working state could not be refreshed. The
        // operator can manually re-load; surface as a soft failure code.
        return {
          ok: false,
          error: {
            code: 'db_error',
            message: `cloned to draft v${inserted.revision_number} (${inserted.id}) but failed to refresh jobs.scope_json / pricing_json: ${error.message}`,
          },
        }
      }
      jobs_working_state_written = true
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'db_error',
          message: `cloned to draft v${inserted.revision_number} (${inserted.id}) but failed to parse/write working state: ${(e as Error)?.message ?? e}`,
        },
      }
    }
  }

  return {
    ok: true,
    scope_revision_id: inserted.id,
    revision_number: inserted.revision_number ?? next_revision_number,
    status: 'draft',
    cloned_from_scope_revision_id: source.id,
    jobs_working_state_written,
  }
}
