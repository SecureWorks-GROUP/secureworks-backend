// Scope-Memory-Saving Loop 1, step 6 — fixture tests for the hash-verified
// scope_revision_id citation resolver. Pins the contract Codex flagged in the
// stop-time review: a release packet must NEVER cite a frozen scope_revision
// whose scope_hash / pricing_hash no longer matches the live jobs row.

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertExists,
} from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { canonicalJsonAndHash } from './canonicalize.ts'
import {
  resolveScopeRevisionCitation,
  type ResolveScopeRevisionCitationResult,
} from './resolve_scope_revision_citation.ts'

// ── Mock client ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

class MockChain {
  rows: Row[]
  filters: Array<[string, unknown]> = []
  orderBy: { col: string; ascending: boolean } | null = null
  limitN: number | null = null

  constructor(rows: Row[]) { this.rows = rows }
  select(_cols: string) { return this }
  eq(col: string, v: unknown) { this.filters.push([col, v]); return this }
  order(col: string, opts: { ascending?: boolean } = {}) {
    this.orderBy = { col, ascending: opts.ascending !== false }
    return this
  }
  limit(n: number) {
    this.limitN = n
    return this.then(undefined)
  }
  then<T1 = any, T2 = never>(
    onFulfilled?: ((value: { data: any; error: any }) => T1 | PromiseLike<T1>) | undefined | null,
    onRejected?: ((reason: any) => T2 | PromiseLike<T2>) | undefined | null,
  ): Promise<T1 | T2> {
    let rows = this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v))
    if (this.orderBy) {
      const { col, ascending } = this.orderBy
      rows = rows.slice().sort((a, b) => {
        const av = a[col] as any, bv = b[col] as any
        if (av === bv) return 0
        return (av < bv ? -1 : 1) * (ascending ? 1 : -1)
      })
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN)
    return Promise.resolve({ data: rows, error: null }).then(onFulfilled as any, onRejected as any) as any
  }
}

function makeMock(rows: Row[]) {
  return {
    from(_table: string) { return new MockChain(rows) },
  }
}

function makeFailingMock(message: string) {
  return {
    from(_table: string) {
      return {
        select(_cols: string) { return this },
        eq(_col: string, _v: unknown) { return this },
        order(_col: string, _opts?: any) { return this },
        limit(_n: number) {
          return Promise.resolve({ data: null, error: { message } })
        },
      }
    },
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const SCOPE_A = { kind: 'patio', size: { length_mm: 6000, width_mm: 4000 }, posts: [{ x: 0, y: 0 }] }
const SCOPE_B = { kind: 'patio', size: { length_mm: 7000, width_mm: 4000 }, posts: [{ x: 0, y: 0 }] }
const PRICING_A = { schema: 'patio.v1', totals: { ex_gst: 10000, gst: 1000, inc_gst: 11000 } }
const PRICING_B = { schema: 'patio.v1', totals: { ex_gst: 12000, gst: 1200, inc_gst: 13200 } }

async function frozenRow(opts: {
  id: string
  job_id: string
  revision_number: number
  scope: unknown
  pricing: unknown
}): Promise<Row> {
  const scopeOut = await canonicalJsonAndHash(opts.scope)
  const pricingOut = await canonicalJsonAndHash(opts.pricing)
  return {
    id: opts.id,
    job_id: opts.job_id,
    revision_number: opts.revision_number,
    status: 'frozen',
    scope_hash: scopeOut.hash,
    pricing_hash: pricingOut.hash,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

Deno.test('resolveScopeRevisionCitation — null jobs.scope_json/pricing_json returns no_jobs_input + null id', async () => {
  const sb = makeMock([])
  const r1: ResolveScopeRevisionCitationResult = await resolveScopeRevisionCitation(sb as any, {
    job_id: 'J1', scope_json: null, pricing_json: { x: 1 },
  })
  assertEquals(r1.scope_revision_id, null)
  assertEquals(r1.reason, 'no_jobs_input')
  const r2 = await resolveScopeRevisionCitation(sb as any, {
    job_id: 'J1', scope_json: { x: 1 }, pricing_json: null,
  })
  assertEquals(r2.scope_revision_id, null)
  assertEquals(r2.reason, 'no_jobs_input')
})

Deno.test('resolveScopeRevisionCitation — no frozen revision returns no_frozen_revision + null', async () => {
  const sb = makeMock([])
  const r = await resolveScopeRevisionCitation(sb as any, {
    job_id: 'J-EMPTY', scope_json: SCOPE_A, pricing_json: PRICING_A,
  })
  assertEquals(r.scope_revision_id, null)
  assertEquals(r.reason, 'no_frozen_revision')
})

Deno.test('resolveScopeRevisionCitation — happy path: scope+pricing match the latest frozen row → cite id', async () => {
  const row = await frozenRow({
    id: 'rev-1', job_id: 'J-OK', revision_number: 1, scope: SCOPE_A, pricing: PRICING_A,
  })
  const sb = makeMock([row])
  const r = await resolveScopeRevisionCitation(sb as any, {
    job_id: 'J-OK', scope_json: SCOPE_A, pricing_json: PRICING_A,
  })
  assertEquals(r.scope_revision_id, 'rev-1')
  assertEquals(r.reason, 'verified')
})

Deno.test('resolveScopeRevisionCitation — happy path is insensitive to key order in scope/pricing JSON', async () => {
  // The freeze flow uses recursive canonicalisation, so the live jobs.scope_json
  // serialised with a different key order MUST hash to the same value.
  const row = await frozenRow({
    id: 'rev-1', job_id: 'J-OK', revision_number: 1, scope: SCOPE_A, pricing: PRICING_A,
  })
  const sb = makeMock([row])
  const reorderedScope = { posts: SCOPE_A.posts, size: { width_mm: 4000, length_mm: 6000 }, kind: 'patio' }
  const reorderedPricing = { totals: { inc_gst: 11000, gst: 1000, ex_gst: 10000 }, schema: 'patio.v1' }
  const r = await resolveScopeRevisionCitation(sb as any, {
    job_id: 'J-OK', scope_json: reorderedScope, pricing_json: reorderedPricing,
  })
  assertEquals(r.scope_revision_id, 'rev-1')
  assertEquals(r.reason, 'verified')
})

Deno.test('resolveScopeRevisionCitation — scope drift (live edited after freeze) returns scope_hash_mismatch + null', async () => {
  // This is the exact scenario Codex flagged: operator froze v1 with SCOPE_A,
  // then edited jobs.scope_json to SCOPE_B without re-freezing. The naive
  // "latest frozen id" lookup would cite v1 even though the packet ships
  // SCOPE_B as scope_snapshot. The verifier MUST refuse the citation.
  const row = await frozenRow({
    id: 'rev-1', job_id: 'J-DRIFT', revision_number: 1, scope: SCOPE_A, pricing: PRICING_A,
  })
  const sb = makeMock([row])
  const r = await resolveScopeRevisionCitation(sb as any, {
    job_id: 'J-DRIFT', scope_json: SCOPE_B, pricing_json: PRICING_A,
  })
  assertEquals(r.scope_revision_id, null, 'must NOT cite a frozen row whose scope_hash no longer matches')
  assertEquals(r.reason, 'scope_hash_mismatch')
  assertExists(r.detail)
  assertEquals(r.detail?.latest_frozen_id, 'rev-1')
  assertEquals(r.detail?.latest_frozen_revision_number, 1)
  assertNotEquals(r.detail?.live_scope_hash, r.detail?.frozen_scope_hash)
})

Deno.test('resolveScopeRevisionCitation — pricing drift returns pricing_hash_mismatch + null', async () => {
  // Symmetric to scope drift: scope unchanged but pricing edited.
  const row = await frozenRow({
    id: 'rev-1', job_id: 'J-PDRIFT', revision_number: 1, scope: SCOPE_A, pricing: PRICING_A,
  })
  const sb = makeMock([row])
  const r = await resolveScopeRevisionCitation(sb as any, {
    job_id: 'J-PDRIFT', scope_json: SCOPE_A, pricing_json: PRICING_B,
  })
  assertEquals(r.scope_revision_id, null)
  assertEquals(r.reason, 'pricing_hash_mismatch')
  assertExists(r.detail)
  assertNotEquals(r.detail?.live_pricing_hash, r.detail?.frozen_pricing_hash)
})

Deno.test('resolveScopeRevisionCitation — picks the highest-revision_number frozen row when multiple exist', async () => {
  // Defensive: in a partial-failure incident state where both v1 and v2 are
  // frozen for the same job, the verifier picks v2 (highest revision_number)
  // and verifies against ITS hashes — not v1's. This pairs with the
  // self-healing healFrozenInvariant guarantee: the next freeze cleans up
  // the stale v1, so this is a transient state at worst.
  const v1 = await frozenRow({
    id: 'rev-v1', job_id: 'J-MULTI', revision_number: 1, scope: SCOPE_A, pricing: PRICING_A,
  })
  const v2 = await frozenRow({
    id: 'rev-v2', job_id: 'J-MULTI', revision_number: 2, scope: SCOPE_B, pricing: PRICING_B,
  })
  const sb = makeMock([v1, v2])
  // Live scope+pricing matches v2.
  const r = await resolveScopeRevisionCitation(sb as any, {
    job_id: 'J-MULTI', scope_json: SCOPE_B, pricing_json: PRICING_B,
  })
  assertEquals(r.scope_revision_id, 'rev-v2')
  assertEquals(r.reason, 'verified')
  // And conversely: live matches v1 only — verifier compares against v2 (the
  // latest) and refuses the citation. The operator must re-freeze to align.
  const r2 = await resolveScopeRevisionCitation(sb as any, {
    job_id: 'J-MULTI', scope_json: SCOPE_A, pricing_json: PRICING_A,
  })
  assertEquals(r2.scope_revision_id, null)
  assertEquals(r2.reason, 'scope_hash_mismatch')
  assertEquals(r2.detail?.latest_frozen_id, 'rev-v2')
})

Deno.test('resolveScopeRevisionCitation — DB error returns db_error + null + error_message detail', async () => {
  const sb = makeFailingMock('simulated select failure')
  const r = await resolveScopeRevisionCitation(sb as any, {
    job_id: 'J-DB', scope_json: SCOPE_A, pricing_json: PRICING_A,
  })
  assertEquals(r.scope_revision_id, null)
  assertEquals(r.reason, 'db_error')
  assertEquals(r.detail?.error_message, 'simulated select failure')
})

Deno.test('resolveScopeRevisionCitation — draft-only revisions are not cited (only frozen status counts)', async () => {
  // The mock filter on .eq('status','frozen') already enforces this in the
  // pipeline, but pinning it as a behavioural test. A job that ONLY has a
  // draft revision (no frozen yet) must report no_frozen_revision.
  const draft: Row = {
    id: 'rev-draft', job_id: 'J-DRAFT', revision_number: 1, status: 'draft',
    scope_hash: 'a'.repeat(64), pricing_hash: 'b'.repeat(64),
  }
  const sb = makeMock([draft])
  const r = await resolveScopeRevisionCitation(sb as any, {
    job_id: 'J-DRAFT', scope_json: SCOPE_A, pricing_json: PRICING_A,
  })
  assertEquals(r.scope_revision_id, null)
  assertEquals(r.reason, 'no_frozen_revision')
})
