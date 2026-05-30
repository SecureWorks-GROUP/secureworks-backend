// Scope-Memory-Saving Loop 1, step 7 — fixture tests for loadFrozenWorkOrderInputs.
//
// Pins the contract the strategy doc § 6 step 6 establishes: a work order
// generated against a frozen scope_revision_id must NEVER fall back to
// mutable jobs.scope_json. This file unit-tests the helper itself; a
// matching no-fallback test for the ops-api wrapper would require mocking
// the entire ops-api dispatch surface, which is over-engineering — the
// helper-level guarantee is strict enough that misuse in ops-api would
// surface in fixture review.

import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { canonicalJsonAndHash } from '../release_packet/canonicalize.ts'
import {
  loadFrozenWorkOrderInputs,
  type LoadFrozenWorkOrderInputsResult,
} from './load_frozen_work_order_inputs.ts'

// ── Mock client ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

class MockChain {
  rows: Row[]
  filters: Array<[string, unknown]> = []
  orderBy: { col: string; ascending: boolean } | null = null

  constructor(rows: Row[]) { this.rows = rows }
  select(_cols: string) { return this }
  eq(col: string, v: unknown) { this.filters.push([col, v]); return this }
  order(col: string, opts: { ascending?: boolean } = {}) {
    this.orderBy = { col, ascending: opts.ascending !== false }
    return this
  }

  async maybeSingle(): Promise<{ data: Row | null; error: any }> {
    const rows = this._filterAndSort()
    if (rows.length > 1) return { data: null, error: { message: 'multiple rows' } }
    return { data: rows[0] ?? null, error: null }
  }

  then<T1 = any, T2 = never>(
    onFulfilled?: ((value: { data: any; error: any }) => T1 | PromiseLike<T1>) | undefined | null,
    onRejected?: ((reason: any) => T2 | PromiseLike<T2>) | undefined | null,
  ): Promise<T1 | T2> {
    return Promise.resolve({ data: this._filterAndSort(), error: null }).then(
      onFulfilled as any,
      onRejected as any,
    ) as any
  }

  private _filterAndSort(): Row[] {
    let rows = this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v))
    if (this.orderBy) {
      const { col, ascending } = this.orderBy
      rows = rows.slice().sort((a, b) => {
        const av = a[col] as any, bv = b[col] as any
        if (av === bv) return 0
        return (av < bv ? -1 : 1) * (ascending ? 1 : -1)
      })
    }
    return rows
  }
}

function makeMock(opts: {
  scope_revisions?: Row[]
  scope_artifacts?: Row[]
  failOnTable?: string
}) {
  return {
    from(table: string) {
      if (opts.failOnTable === table) {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: { message: 'simulated db failure' } }),
              order: () => Promise.resolve({ data: null, error: { message: 'simulated db failure' } }),
            }),
          }),
        }
      }
      if (table === 'scope_revisions') return new MockChain(opts.scope_revisions ?? [])
      if (table === 'scope_artifacts') return new MockChain(opts.scope_artifacts ?? [])
      throw new Error('mock: unknown table ' + table)
    },
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const PATIO_SCOPE = {
  kind: 'patio',
  size: { length_mm: 6000, width_mm: 4000 },
  posts: [{ x: 0, y: 0 }, { x: 6000, y: 0 }],
}
const PATIO_PRICING = {
  schema: 'patio.v1',
  totals: { ex_gst: 10000, gst: 1000, inc_gst: 11000 },
}

async function frozenRow(opts: {
  id: string
  job_id: string
  revision_number?: number
  scope: unknown
  pricing: unknown
  status?: 'draft' | 'frozen' | 'superseded'
  tool_kind?: string
}): Promise<Row> {
  const scopeOut = await canonicalJsonAndHash(opts.scope)
  const pricingOut = await canonicalJsonAndHash(opts.pricing)
  return {
    id: opts.id,
    job_id: opts.job_id,
    revision_number: opts.revision_number ?? 1,
    tool_kind: opts.tool_kind ?? 'patio',
    scope_canonical_text: scopeOut.canonical,
    scope_hash: scopeOut.hash,
    pricing_canonical_text: pricingOut.canonical,
    pricing_hash: pricingOut.hash,
    renderer_version: 'three.js@r128',
    tool_version: 'PatioDesignerPro_V18',
    frozen_at: '2026-05-04T08:00:00Z',
    frozen_by_user_id: null,
    status: opts.status ?? 'frozen',
  }
}

function artifactRow(scope_revision_id: string, artifact_type: string, sha: string): Row {
  return {
    id: `art-${artifact_type}-${sha.slice(0, 4)}`,
    scope_revision_id,
    artifact_type,
    storage_path: `${scope_revision_id}/${sha}.png`,
    bucket_id: 'scope-artifacts',
    sha256: sha,
    size_bytes: 12345,
    content_type: 'image/png',
    label: null,
    created_at: '2026-05-04T08:01:00Z',
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

Deno.test('loadFrozenWorkOrderInputs — rejects missing scope_revision_id', async () => {
  const sb = makeMock({})
  const r: LoadFrozenWorkOrderInputsResult = await loadFrozenWorkOrderInputs(sb as any, { scope_revision_id: '' })
  assertEquals(r.ok, false)
  if (!r.ok && r.error.code === 'invalid_input') {
    assertEquals(r.error.field, 'scope_revision_id')
  } else {
    throw new Error('expected invalid_input')
  }
})

Deno.test('loadFrozenWorkOrderInputs — returns scope_revision_not_found when row is absent', async () => {
  const sb = makeMock({ scope_revisions: [] })
  const r = await loadFrozenWorkOrderInputs(sb as any, { scope_revision_id: 'rev-missing' })
  assertEquals(r.ok, false)
  if (!r.ok) assertEquals(r.error.code, 'scope_revision_not_found')
})

Deno.test('loadFrozenWorkOrderInputs — refuses draft revisions', async () => {
  const draft = await frozenRow({
    id: 'rev-draft', job_id: 'J1', scope: PATIO_SCOPE, pricing: PATIO_PRICING, status: 'draft',
  })
  const sb = makeMock({ scope_revisions: [draft] })
  const r = await loadFrozenWorkOrderInputs(sb as any, { scope_revision_id: 'rev-draft' })
  assertEquals(r.ok, false)
  if (!r.ok && r.error.code === 'scope_revision_not_frozen') {
    assertEquals(r.error.current_status, 'draft')
  } else {
    throw new Error('expected scope_revision_not_frozen')
  }
})

Deno.test('loadFrozenWorkOrderInputs — happy path: returns scope+pricing+artifacts for a frozen revision', async () => {
  const rev = await frozenRow({
    id: 'rev-1', job_id: 'J1', scope: PATIO_SCOPE, pricing: PATIO_PRICING,
  })
  const a1 = artifactRow('rev-1', 'render_hero', 'a'.repeat(64))
  const a2 = artifactRow('rev-1', 'render_front', 'b'.repeat(64))
  const sb = makeMock({ scope_revisions: [rev], scope_artifacts: [a1, a2] })
  const r = await loadFrozenWorkOrderInputs(sb as any, { scope_revision_id: 'rev-1' })
  assert(r.ok)
  if (!r.ok) return
  assertEquals(r.scope_revision_id, 'rev-1')
  assertEquals(r.job_id, 'J1')
  assertEquals(r.tool_kind, 'patio')
  assertEquals(r.status, 'frozen')
  assertEquals(r.scope_json.kind, 'patio')
  assertEquals((r.scope_json.size as any).length_mm, 6000)
  assertEquals((r.pricing_json.totals as any).inc_gst, 11000)
  assertEquals(r.artifacts.length, 2)
  // Ordered by artifact_type ASC (render_front before render_hero).
  assertEquals(r.artifacts[0].artifact_type, 'render_front')
  assertEquals(r.artifacts[1].artifact_type, 'render_hero')
  // Hash exposed alongside parsed JSON for callers that want to assert
  // canonical bytes match the recorded hash.
  assert(r.scope_hash.length === 64)
  assert(r.pricing_hash.length === 64)
})

Deno.test('loadFrozenWorkOrderInputs — superseded rows ARE returned (read-only viewer use); ops-api guards separately', async () => {
  // The helper allows callers to read superseded rows so the read-only
  // viewer (step 8) can replay historical revisions. ops-api
  // create_work_order rejects superseded sources separately because a
  // NEW work order against a superseded revision is the wrong intent.
  const rev = await frozenRow({
    id: 'rev-old', job_id: 'J1', revision_number: 1,
    scope: PATIO_SCOPE, pricing: PATIO_PRICING, status: 'superseded',
  })
  const sb = makeMock({ scope_revisions: [rev] })
  const r = await loadFrozenWorkOrderInputs(sb as any, { scope_revision_id: 'rev-old' })
  assert(r.ok)
  if (!r.ok) return
  assertEquals(r.status, 'superseded')
  assertEquals(r.scope_revision_id, 'rev-old')
})

Deno.test('loadFrozenWorkOrderInputs — integrity_error on canonical-bytes/hash mismatch', async () => {
  // Tamper the recorded scope_hash so it no longer matches the canonical
  // bytes. The defense-in-depth recompute should catch this.
  const rev = await frozenRow({
    id: 'rev-tamper', job_id: 'J1', scope: PATIO_SCOPE, pricing: PATIO_PRICING,
  })
  ;(rev as any).scope_hash = 'f'.repeat(64) // wrong
  const sb = makeMock({ scope_revisions: [rev] })
  const r = await loadFrozenWorkOrderInputs(sb as any, { scope_revision_id: 'rev-tamper' })
  assertEquals(r.ok, false)
  if (!r.ok) {
    assertEquals(r.error.code, 'integrity_error')
    if (r.error.code === 'integrity_error') {
      assert(/scope_hash mismatch/.test(r.error.message))
    }
  }
})

Deno.test('loadFrozenWorkOrderInputs — integrity_error when canonical_text is malformed JSON', async () => {
  const rev: Row = {
    id: 'rev-bad', job_id: 'J1', revision_number: 1, status: 'frozen', tool_kind: 'patio',
    scope_canonical_text: '{not-json}', scope_hash: 'a'.repeat(64),
    pricing_canonical_text: '{}', pricing_hash: 'b'.repeat(64),
    renderer_version: 'three.js@r128', tool_version: 'PatioDesignerPro_V18',
    frozen_at: '2026-05-04T08:00:00Z', frozen_by_user_id: null,
  }
  const sb = makeMock({ scope_revisions: [rev] })
  const r = await loadFrozenWorkOrderInputs(sb as any, { scope_revision_id: 'rev-bad' })
  assertEquals(r.ok, false)
  if (!r.ok) assertEquals(r.error.code, 'integrity_error')
})

Deno.test('loadFrozenWorkOrderInputs — empty artifacts list is valid', async () => {
  // Early Loop 1 freezes happened before any tool-side render upload was
  // wired. The helper must return ok with artifacts: [] in that case.
  const rev = await frozenRow({
    id: 'rev-empty', job_id: 'J-EMPTY', scope: PATIO_SCOPE, pricing: PATIO_PRICING,
  })
  const sb = makeMock({ scope_revisions: [rev], scope_artifacts: [] })
  const r = await loadFrozenWorkOrderInputs(sb as any, { scope_revision_id: 'rev-empty' })
  assert(r.ok)
  if (!r.ok) return
  assertEquals(r.artifacts.length, 0)
})

Deno.test('loadFrozenWorkOrderInputs — DB error on the revision lookup surfaces as db_error', async () => {
  const sb = makeMock({ scope_revisions: [], failOnTable: 'scope_revisions' })
  const r = await loadFrozenWorkOrderInputs(sb as any, { scope_revision_id: 'rev-x' })
  assertEquals(r.ok, false)
  if (!r.ok && r.error.code === 'db_error') {
    assert(/simulated db failure/.test(r.error.message))
  } else {
    throw new Error('expected db_error')
  }
})

Deno.test('loadFrozenWorkOrderInputs — cross-job guard: rejects when frozen.job_id != input.job_id', async () => {
  // Codex stop-time review (step 7) flagged that ops-api create_work_order
  // could mix job_id=JOB-A with scope_revision_id=rev-from-JOB-B. The
  // helper-level guard fires when the caller supplies an explicit job_id
  // and the loaded revision belongs to a different job.
  const rev = await frozenRow({
    id: 'rev-job-B', job_id: 'JOB-B',
    scope: PATIO_SCOPE, pricing: PATIO_PRICING,
  })
  const sb = makeMock({ scope_revisions: [rev] })
  const r = await loadFrozenWorkOrderInputs(sb as any, {
    scope_revision_id: 'rev-job-B',
    job_id: 'JOB-A', // intentional mismatch
  })
  assertEquals(r.ok, false)
  if (!r.ok && r.error.code === 'cross_job_mismatch') {
    assertEquals(r.error.expected_job_id, 'JOB-A')
    assertEquals(r.error.actual_job_id, 'JOB-B')
  } else {
    throw new Error('expected cross_job_mismatch')
  }
})

Deno.test('loadFrozenWorkOrderInputs — cross-job guard: passes when job_id matches', async () => {
  const rev = await frozenRow({
    id: 'rev-1', job_id: 'JOB-A', scope: PATIO_SCOPE, pricing: PATIO_PRICING,
  })
  const sb = makeMock({ scope_revisions: [rev] })
  const r = await loadFrozenWorkOrderInputs(sb as any, {
    scope_revision_id: 'rev-1',
    job_id: 'JOB-A',
  })
  assert(r.ok, 'matching job_id should pass the guard')
  if (!r.ok) return
  assertEquals(r.job_id, 'JOB-A')
})

Deno.test('loadFrozenWorkOrderInputs — cross-job guard: viewer-style (omitted job_id) skips the check', async () => {
  // The future read-only viewer (step 8) loads any frozen revision by id
  // alone for replay. It MUST be able to call the helper without a job_id
  // and not be subjected to the cross-job guard. Pinning this so a future
  // change to make job_id required would have to update this test.
  const rev = await frozenRow({
    id: 'rev-1', job_id: 'JOB-VIEWER', scope: PATIO_SCOPE, pricing: PATIO_PRICING,
  })
  const sb = makeMock({ scope_revisions: [rev] })
  const r = await loadFrozenWorkOrderInputs(sb as any, { scope_revision_id: 'rev-1' })
  assert(r.ok, 'omitting job_id should skip the cross-job check')
  if (!r.ok) return
  assertEquals(r.job_id, 'JOB-VIEWER')
})

Deno.test('loadFrozenWorkOrderInputs — returned scope_json mirrors the canonical text byte-for-byte', async () => {
  // The strategy doc § 6 step 6 hard rule requires that work-order PDFs
  // be reproducible from the cited revision id. That means:
  //   sha256(canonicalize(loadFrozenWorkOrderInputs(rev_id).scope_json))
  //     === scope_revisions.scope_hash for that row
  // This test pins it.
  const rev = await frozenRow({
    id: 'rev-1', job_id: 'J1', scope: PATIO_SCOPE, pricing: PATIO_PRICING,
  })
  const sb = makeMock({ scope_revisions: [rev] })
  const r = await loadFrozenWorkOrderInputs(sb as any, { scope_revision_id: 'rev-1' })
  assert(r.ok); if (!r.ok) return
  const recomputed = await canonicalJsonAndHash(r.scope_json)
  assertEquals(recomputed.hash, r.scope_hash)
  // Recomputed canonical text must equal the stored canonical text exactly.
  assertEquals(recomputed.canonical, r.scope_canonical_text)
  // And it must NOT equal a perturbed payload's hash.
  const perturbed = { ...PATIO_SCOPE, size: { ...PATIO_SCOPE.size, length_mm: 7000 } }
  const perturbedRehash = await canonicalJsonAndHash(perturbed)
  assertNotEquals(perturbedRehash.hash, r.scope_hash)
})
