// Scope-Memory-Saving M1 — fixture tests for getScopeRevisionForViewer.
//
// Mirrors list_scope_revisions_test.ts: in-memory mock client reproducing
// only the query shapes the helper actually calls (select / eq / order /
// maybeSingle) plus a mock storage facade for createSignedUrl, so content
// return, hash verification, signed-URL issuance, and error paths are all
// provable without any network or live Supabase.

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts'

import {
  getScopeRevisionForViewer,
  sha256HexOfText,
  SIGNED_URL_TTL_SECONDS,
} from './get_scope_revision_for_viewer.ts'

// ── In-memory db mock ──────────────────────────────────────────────────────

type Row = Record<string, unknown>

type DbTable = 'scope_revisions' | 'scope_artifacts'
type State = {
  scope_revisions: Row[]
  scope_artifacts: Row[]
}

class MockChain {
  table: DbTable
  state: State
  filters: Array<[string, unknown]> = []
  orderings: Array<[string, boolean]> = []
  failOn: DbTable | null

  constructor(table: DbTable, state: State, failOn: DbTable | null) {
    this.table = table
    this.state = state
    this.failOn = failOn
  }

  select(_cols: string) { return this }
  eq(col: string, v: unknown) { this.filters.push([col, v]); return this }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderings.push([col, opts?.ascending !== false])
    return this
  }

  private _rows(): Row[] {
    let rows = this.state[this.table].filter(
      (r) => this.filters.every(([c, v]) => r[c] === v),
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
  // for the artifacts list query.
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
    scope_revisions: seed.scope_revisions ?? [],
    scope_artifacts: seed.scope_artifacts ?? [],
  }
  return {
    from(table: string) { return new MockChain(table as DbTable, state, opts.failOn ?? null) },
  }
}

// ── Storage mock ───────────────────────────────────────────────────────────
//
// Reproduces the only surface the helper touches:
//   storage_client.from(bucket).createSignedUrl(path, ttl)
// Records every call so tests can assert bucket, path, and TTL.

function makeStorageMock(opts: { failPaths?: string[] } = {}) {
  const calls: Array<{ bucket: string; path: string; ttl: number }> = []
  return {
    calls,
    from(bucket: string) {
      return {
        async createSignedUrl(path: string, ttl: number) {
          calls.push({ bucket, path, ttl })
          if (opts.failPaths?.includes(path)) {
            return { data: null, error: { message: `sign-boom:${path}` } }
          }
          return {
            data: { signedUrl: `https://signed.example/${bucket}/${path}?ttl=${ttl}` },
            error: null,
          }
        },
      }
    },
  }
}

// ── Seed data ──────────────────────────────────────────────────────────────

const JOB = 'job-1111'
const REV = 'rev-2'

const SCOPE_OBJ = { posts: 6, sheets: ['c-deck', 'c-deck'], spanMm: 4200 }
const PRICING_OBJ = { lineItems: [{ desc: 'Patio kit', amount: 9000 }], totalIncGST: 9900 }

// Canonical text = the exact stored byte contract. Tests use plain
// JSON.stringify output as the frozen bytes and seal hashes computed over
// those same bytes — byte-stability is what the helper verifies.
const SCOPE_TEXT = JSON.stringify(SCOPE_OBJ)
const PRICING_TEXT = JSON.stringify(PRICING_OBJ)

async function seedRevisionWithArtifacts(): Promise<Partial<State>> {
  const scope_hash = await sha256HexOfText(SCOPE_TEXT)
  const pricing_hash = await sha256HexOfText(PRICING_TEXT)
  return {
    scope_revisions: [
      {
        id: REV, job_id: JOB, revision_number: 2, status: 'frozen',
        tool_kind: 'patio',
        scope_canonical_text: SCOPE_TEXT, scope_hash,
        pricing_canonical_text: PRICING_TEXT, pricing_hash,
        renderer_version: 'three.js@r128', tool_version: 'PatioDesignerPro_V18',
        model_manifest_json: null, model_manifest_hash: null,
        frozen_at: '2026-06-02T00:00:00Z', frozen_by_user_id: 'user-9',
        superseded_by_scope_revision_id: null, superseded_at: null,
        created_at: '2026-06-02T00:00:00Z',
      },
      // Different revision — must never leak into REV's artefact list.
      {
        id: 'rev-x', job_id: 'job-other', revision_number: 1, status: 'frozen',
        tool_kind: 'fencing',
        scope_canonical_text: '{"x":1}', scope_hash: 'e'.repeat(64),
        pricing_canonical_text: '{"y":2}', pricing_hash: 'f'.repeat(64),
        renderer_version: 'fence-designer@unknown', tool_version: 'fence-designer@unknown',
        model_manifest_json: null, model_manifest_hash: null,
        frozen_at: '2026-06-03T00:00:00Z', frozen_by_user_id: null,
        superseded_by_scope_revision_id: null, superseded_at: null,
        created_at: '2026-06-03T00:00:00Z',
      },
    ],
    scope_artifacts: [
      // Deliberately seeded out of created_at order to prove ASC ordering.
      {
        id: 'art-2b', scope_revision_id: REV, artifact_type: 'render_front',
        storage_path: `${REV}/${'2'.repeat(64)}.png`, bucket_id: 'scope-artifacts',
        sha256: '2'.repeat(64), size_bytes: 2048, content_type: 'image/png',
        label: null, created_at: '2026-06-02T00:02:00Z',
      },
      {
        id: 'art-2a', scope_revision_id: REV, artifact_type: 'render_hero',
        storage_path: `${REV}/${'1'.repeat(64)}.png`, bucket_id: 'scope-artifacts',
        sha256: '1'.repeat(64), size_bytes: 1024, content_type: 'image/png',
        label: 'hero', created_at: '2026-06-02T00:01:00Z',
      },
      // Artefact of another revision — must not leak.
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

Deno.test('returns full content, parsed tool fields, and signed artefact urls', async () => {
  const client = makeMock(await seedRevisionWithArtifacts())
  const storage = makeStorageMock()
  const res = await getScopeRevisionForViewer(client, storage, { scope_revision_id: REV })
  assert(res.ok)

  // Tool-hydration contract (patio-tool / fence-designer integration.js).
  assertEquals(res.job_id, JOB)
  assertEquals(res.scope_json, SCOPE_OBJ)
  assertEquals(res.pricing_json_public, PRICING_OBJ)
  assertEquals(res.revision_number, 2)
  assertEquals(res.status, 'frozen')
  assertEquals(res.frozen_at, '2026-06-02T00:00:00Z')
  assertEquals(res.hash_verified, true)
  assertEquals(res.signed_url_ttl_seconds, SIGNED_URL_TTL_SECONDS)

  // Full revision row including canonical byte contracts.
  assertEquals(res.revision.id, REV)
  assertEquals(res.revision.scope_canonical_text, SCOPE_TEXT)
  assertEquals(res.revision.pricing_canonical_text, PRICING_TEXT)
  assertEquals(res.revision.tool_version, 'PatioDesignerPro_V18')

  // Artefacts grouped under the revision, created_at ASC, each signed.
  assertEquals(res.revision.artifacts.map((a) => a.id), ['art-2a', 'art-2b'])
  for (const a of res.revision.artifacts) {
    assertEquals(
      a.signed_url,
      `https://signed.example/scope-artifacts/${a.storage_path}?ttl=${SIGNED_URL_TTL_SECONDS}`,
    )
    assertEquals(a.signed_url_error, undefined)
  }

  // Signing went to the private bucket with the short fixed TTL.
  assertEquals(storage.calls.length, 2)
  for (const call of storage.calls) {
    assertEquals(call.bucket, 'scope-artifacts')
    assertEquals(call.ttl, SIGNED_URL_TTL_SECONDS)
  }
})

Deno.test('does not leak other revisions artifacts', async () => {
  const client = makeMock(await seedRevisionWithArtifacts())
  const res = await getScopeRevisionForViewer(client, makeStorageMock(), { scope_revision_id: REV })
  assert(res.ok)
  assert(!res.revision.artifacts.map((a) => a.id).includes('art-x'))
})

Deno.test('revision with no artifacts returns an empty artifacts list', async () => {
  const seed = await seedRevisionWithArtifacts()
  seed.scope_artifacts = []
  const storage = makeStorageMock()
  const res = await getScopeRevisionForViewer(makeMock(seed), storage, { scope_revision_id: REV })
  assert(res.ok)
  assertEquals(res.revision.artifacts, [])
  assertEquals(storage.calls.length, 0)
})

Deno.test('revision_not_found for unknown scope_revision_id', async () => {
  const client = makeMock(await seedRevisionWithArtifacts())
  const res = await getScopeRevisionForViewer(client, makeStorageMock(), { scope_revision_id: 'rev-nope' })
  assert(!res.ok)
  assertEquals(res.error.code, 'revision_not_found')
})

Deno.test('rejects missing scope_revision_id without touching the db', async () => {
  const client = makeMock({}, { failOn: 'scope_revisions' })
  const res = await getScopeRevisionForViewer(client, makeStorageMock(), { scope_revision_id: '' })
  assert(!res.ok)
  assertEquals(res.error.code, 'db_error')
})

Deno.test('hash_mismatch when scope canonical text does not match its seal', async () => {
  const seed = await seedRevisionWithArtifacts()
  ;(seed.scope_revisions![0] as Row).scope_canonical_text = '{"tampered":true}'
  const storage = makeStorageMock()
  const res = await getScopeRevisionForViewer(makeMock(seed), storage, { scope_revision_id: REV })
  assert(!res.ok)
  assertEquals(res.error.code, 'hash_mismatch')
  assert(res.error.code === 'hash_mismatch' && res.error.field === 'scope')
  // Nothing was signed for a tampered record.
  assertEquals(storage.calls.length, 0)
})

Deno.test('hash_mismatch when pricing canonical text does not match its seal', async () => {
  const seed = await seedRevisionWithArtifacts()
  ;(seed.scope_revisions![0] as Row).pricing_canonical_text = '{"tampered":true}'
  const storage = makeStorageMock()
  const res = await getScopeRevisionForViewer(makeMock(seed), storage, { scope_revision_id: REV })
  assert(!res.ok)
  assertEquals(res.error.code, 'hash_mismatch')
  assert(res.error.code === 'hash_mismatch' && res.error.field === 'pricing')
  assertEquals(storage.calls.length, 0)
})

Deno.test('db_error surfaces when the revision query fails', async () => {
  const client = makeMock(await seedRevisionWithArtifacts(), { failOn: 'scope_revisions' })
  const res = await getScopeRevisionForViewer(client, makeStorageMock(), { scope_revision_id: REV })
  assert(!res.ok)
  assertEquals(res.error.code, 'db_error')
})

Deno.test('db_error surfaces when the artifacts query fails', async () => {
  const client = makeMock(await seedRevisionWithArtifacts(), { failOn: 'scope_artifacts' })
  const res = await getScopeRevisionForViewer(client, makeStorageMock(), { scope_revision_id: REV })
  assert(!res.ok)
  assertEquals(res.error.code, 'db_error')
})

Deno.test('a single failed signing degrades that artefact only', async () => {
  const seed = await seedRevisionWithArtifacts()
  const failingPath = `${REV}/${'1'.repeat(64)}.png` // art-2a
  const storage = makeStorageMock({ failPaths: [failingPath] })
  const res = await getScopeRevisionForViewer(makeMock(seed), storage, { scope_revision_id: REV })
  assert(res.ok)
  const [a2a, a2b] = res.revision.artifacts
  assertEquals(a2a.id, 'art-2a')
  assertEquals(a2a.signed_url, null)
  assert(String(a2a.signed_url_error).includes('sign-boom'))
  assertEquals(a2b.id, 'art-2b')
  assert(a2b.signed_url !== null)
  assertEquals(a2b.signed_url_error, undefined)
})
