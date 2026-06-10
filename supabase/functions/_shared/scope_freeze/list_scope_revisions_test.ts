// Scope-Memory-Saving M1 — fixture tests for listScopeRevisionsForJob.
//
// Mirrors the record_scope_artifact_test.ts approach: in-memory mock client
// reproducing only the query shapes the helper actually calls (select / eq /
// in / order / maybeSingle), so ordering, grouping, and error paths are
// provable without any network or live Supabase.

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { listScopeRevisionsForJob } from './list_scope_revisions.ts'

// ── In-memory mock ─────────────────────────────────────────────────────────

type Row = Record<string, unknown>

type DbTable = 'jobs' | 'scope_revisions' | 'scope_artifacts'
type State = {
  jobs: Row[]
  scope_revisions: Row[]
  scope_artifacts: Row[]
}

class MockChain {
  table: DbTable
  state: State
  filters: Array<[string, unknown]> = []
  inFilters: Array<[string, unknown[]]> = []
  orderings: Array<[string, boolean]> = []
  failOn: DbTable | null

  constructor(table: DbTable, state: State, failOn: DbTable | null) {
    this.table = table
    this.state = state
    this.failOn = failOn
  }

  select(_cols: string) { return this }
  eq(col: string, v: unknown) { this.filters.push([col, v]); return this }
  in(col: string, vs: unknown[]) { this.inFilters.push([col, vs]); return this }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderings.push([col, opts?.ascending !== false])
    return this
  }

  private _rows(): Row[] {
    let rows = this.state[this.table].filter(
      (r) => this.filters.every(([c, v]) => r[c] === v),
    )
    rows = rows.filter(
      (r) => this.inFilters.every(([c, vs]) => vs.includes(r[c])),
    )
    for (const [col, asc] of this.orderings) {
      rows = [...rows].sort((a, b) => {
        const av = a[col] as number | string
        const bv = b[col] as number | string
        if (av === bv) return 0
        return (av < bv ? -1 : 1) * (asc ? 1 : -1)
      })
    }
    return rows
  }

  async maybeSingle(): Promise<{ data: Row | null; error: unknown }> {
    if (this.failOn === this.table) return { data: null, error: { message: `boom:${this.table}` } }
    return { data: this._rows()[0] ?? null, error: null }
  }

  // PostgREST builders are thenable — the helper awaits the chain directly
  // for the list queries.
  then(
    resolve: (v: { data: Row[] | null; error: unknown }) => unknown,
    reject?: (e: unknown) => unknown,
  ) {
    if (this.failOn === this.table) {
      return Promise.resolve({ data: null, error: { message: `boom:${this.table}` } }).then(resolve, reject)
    }
    return Promise.resolve({ data: this._rows(), error: null }).then(resolve, reject)
  }
}

function makeMock(seed: Partial<State> = {}, opts: { failOn?: DbTable } = {}) {
  const state: State = {
    jobs: seed.jobs ?? [],
    scope_revisions: seed.scope_revisions ?? [],
    scope_artifacts: seed.scope_artifacts ?? [],
  }
  return {
    from(table: string) { return new MockChain(table as DbTable, state, opts.failOn ?? null) },
  }
}

const JOB = 'job-1111'

function seedTwoRevisionsWithArtifacts(): Partial<State> {
  return {
    jobs: [{ id: JOB }],
    scope_revisions: [
      {
        id: 'rev-1', job_id: JOB, revision_number: 1, status: 'superseded',
        tool_kind: 'patio', scope_hash: 'a'.repeat(64), pricing_hash: 'b'.repeat(64),
        renderer_version: 'three.js@r128', tool_version: 'PatioDesignerPro_V18',
        model_manifest_json: null, model_manifest_hash: null,
        frozen_at: '2026-06-01T00:00:00Z', frozen_by_user_id: null,
        superseded_by_scope_revision_id: 'rev-2', superseded_at: '2026-06-02T00:00:00Z',
        created_at: '2026-06-01T00:00:00Z',
      },
      {
        id: 'rev-2', job_id: JOB, revision_number: 2, status: 'frozen',
        tool_kind: 'patio', scope_hash: 'c'.repeat(64), pricing_hash: 'd'.repeat(64),
        renderer_version: 'three.js@r128', tool_version: 'PatioDesignerPro_V18',
        model_manifest_json: null, model_manifest_hash: null,
        frozen_at: '2026-06-02T00:00:00Z', frozen_by_user_id: 'user-9',
        superseded_by_scope_revision_id: null, superseded_at: null,
        created_at: '2026-06-02T00:00:00Z',
      },
      // Different job — must never leak into JOB's listing.
      {
        id: 'rev-x', job_id: 'job-other', revision_number: 1, status: 'frozen',
        tool_kind: 'fencing', scope_hash: 'e'.repeat(64), pricing_hash: 'f'.repeat(64),
        renderer_version: 'fence-designer@unknown', tool_version: 'fence-designer@unknown',
        model_manifest_json: null, model_manifest_hash: null,
        frozen_at: '2026-06-03T00:00:00Z', frozen_by_user_id: null,
        superseded_by_scope_revision_id: null, superseded_at: null,
        created_at: '2026-06-03T00:00:00Z',
      },
    ],
    scope_artifacts: [
      {
        id: 'art-2b', scope_revision_id: 'rev-2', artifact_type: 'render_front',
        storage_path: `rev-2/${'2'.repeat(64)}.png`, bucket_id: 'scope-artifacts',
        sha256: '2'.repeat(64), size_bytes: 2048, content_type: 'image/png',
        label: null, created_at: '2026-06-02T00:02:00Z',
      },
      {
        id: 'art-2a', scope_revision_id: 'rev-2', artifact_type: 'render_hero',
        storage_path: `rev-2/${'1'.repeat(64)}.png`, bucket_id: 'scope-artifacts',
        sha256: '1'.repeat(64), size_bytes: 1024, content_type: 'image/png',
        label: 'hero', created_at: '2026-06-02T00:01:00Z',
      },
      {
        id: 'art-1a', scope_revision_id: 'rev-1', artifact_type: 'work_order_pdf',
        storage_path: `rev-1/${'3'.repeat(64)}.pdf`, bucket_id: 'scope-artifacts',
        sha256: '3'.repeat(64), size_bytes: 4096, content_type: 'application/pdf',
        label: null, created_at: '2026-06-01T00:01:00Z',
      },
      // Artefact of the other job's revision — must not leak.
      {
        id: 'art-x', scope_revision_id: 'rev-x', artifact_type: 'render_profile',
        storage_path: `rev-x/${'4'.repeat(64)}.png`, bucket_id: 'scope-artifacts',
        sha256: '4'.repeat(64), size_bytes: 512, content_type: 'image/png',
        label: null, created_at: '2026-06-03T00:01:00Z',
      },
    ],
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

Deno.test('returns revisions newest-first with grouped artifacts', async () => {
  const client = makeMock(seedTwoRevisionsWithArtifacts())
  const res = await listScopeRevisionsForJob(client, { job_id: JOB })
  assert(res.ok)
  assertEquals(res.job_id, JOB)
  assertEquals(res.revisions.length, 2)
  // revision_number DESC
  assertEquals(res.revisions[0].id, 'rev-2')
  assertEquals(res.revisions[0].revision_number, 2)
  assertEquals(res.revisions[0].status, 'frozen')
  assertEquals(res.revisions[1].id, 'rev-1')
  assertEquals(res.revisions[1].status, 'superseded')
  // artifacts grouped per revision, created_at ASC
  assertEquals(res.revisions[0].artifacts.map((a) => a.id), ['art-2a', 'art-2b'])
  assertEquals(res.revisions[1].artifacts.map((a) => a.id), ['art-1a'])
  // hash + tool fields survive
  assertEquals(res.revisions[0].scope_hash, 'c'.repeat(64))
  assertEquals(res.revisions[0].tool_version, 'PatioDesignerPro_V18')
  // canonical text never returned
  assert(!('scope_canonical_text' in res.revisions[0]))
  assert(!('pricing_canonical_text' in res.revisions[0]))
})

Deno.test('does not leak other jobs revisions or artifacts', async () => {
  const client = makeMock(seedTwoRevisionsWithArtifacts())
  const res = await listScopeRevisionsForJob(client, { job_id: JOB })
  assert(res.ok)
  assert(res.revisions.every((r) => r.job_id === JOB))
  const artIds = res.revisions.flatMap((r) => r.artifacts.map((a) => a.id))
  assert(!artIds.includes('art-x'))
})

Deno.test('empty list for an existing job with no revisions', async () => {
  const client = makeMock({ jobs: [{ id: JOB }] })
  const res = await listScopeRevisionsForJob(client, { job_id: JOB })
  assert(res.ok)
  assertEquals(res.revisions, [])
})

Deno.test('job_not_found for unknown job_id', async () => {
  const client = makeMock(seedTwoRevisionsWithArtifacts())
  const res = await listScopeRevisionsForJob(client, { job_id: 'job-nope' })
  assert(!res.ok)
  assertEquals(res.error.code, 'job_not_found')
})

Deno.test('db_error surfaces when the revisions query fails', async () => {
  const client = makeMock(seedTwoRevisionsWithArtifacts(), { failOn: 'scope_revisions' })
  const res = await listScopeRevisionsForJob(client, { job_id: JOB })
  assert(!res.ok)
  assertEquals(res.error.code, 'db_error')
})

Deno.test('db_error surfaces when the artifacts query fails', async () => {
  const client = makeMock(seedTwoRevisionsWithArtifacts(), { failOn: 'scope_artifacts' })
  const res = await listScopeRevisionsForJob(client, { job_id: JOB })
  assert(!res.ok)
  assertEquals(res.error.code, 'db_error')
})

Deno.test('rejects missing job_id without touching the db', async () => {
  const client = makeMock({}, { failOn: 'jobs' })
  const res = await listScopeRevisionsForJob(client, { job_id: '' })
  assert(!res.ok)
  assertEquals(res.error.code, 'db_error')
})
