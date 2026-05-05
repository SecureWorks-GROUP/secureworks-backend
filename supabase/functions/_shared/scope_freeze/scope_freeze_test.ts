// Scope-Memory-Saving Loop 1, step 4 — fixture tests for freezeScope +
// cloneScopeForEdit.
//
// These tests run entirely against an in-memory mock Supabase client. No
// network. No live Supabase. The mock faithfully reproduces only the query
// shapes the helpers actually call (select / insert / update with eq / order
// / limit / select / single / maybeSingle); anything else throws so a future
// helper change can't silently exercise unmocked behaviour.
//
// The mock also enforces the production trigger semantics in JS:
//   * UPDATE on a 'frozen' row that touches contract columns throws.
//   * UPDATE on a 'superseded' row throws (terminal).
//   * INSERT with status='frozen' must carry frozen_at NOT NULL.
//   * scope_artifacts UPDATE/DELETE always throws (append-only).
//   * scope_hash / pricing_hash regex check ('^[0-9a-f]{64}$').
//   * (job_id, revision_number) UNIQUE.
// Helpers don't currently touch scope_artifacts directly — the trigger checks
// for that table exist for a future leg's tests; we exercise the regex check
// on scope_revisions hashes.

import {
  assert,
  assertEquals,
  assertExists,
  assertObjectMatch,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts'

import {
  freezeScope,
  cloneScopeForEdit,
  healFrozenInvariant,
  isToolKind,
  TOOL_KINDS,
  type ToolKind,
} from './scope_freeze.ts'

// ── In-memory mock Supabase client ──────────────────────────────────────────

type Row = Record<string, unknown>

type Tables = {
  jobs: Row[]
  scope_revisions: Row[]
  scope_artifacts: Row[]
}

const SHA256_RE = /^[0-9a-f]{64}$/
const FROZEN_CONTRACT_COLS = [
  'id', 'job_id', 'revision_number', 'tool_kind',
  'scope_canonical_text', 'scope_hash',
  'pricing_canonical_text', 'pricing_hash',
  'renderer_version', 'tool_version',
  'model_manifest_json', 'model_manifest_hash',
  'frozen_at', 'frozen_by_user_id', 'created_at',
] as const

function newId(prefix: string): string {
  // Stable enough for tests; not a real uuid.
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

class MockChain {
  table: string
  state: Tables
  filters: Array<[string, unknown]> = []
  selectCols: string | null = null
  insertPayload: Row | null = null
  updatePayload: Row | null = null
  orderBy: { col: string; ascending: boolean } | null = null
  limitN: number | null = null
  method: 'select' | 'insert' | 'update' | null = null

  constructor(table: string, state: Tables) {
    this.table = table
    this.state = state
  }

  select(cols: string) {
    this.selectCols = cols
    if (this.method == null) this.method = 'select'
    return this
  }
  insert(payload: Row) {
    this.method = 'insert'
    this.insertPayload = payload
    return this
  }
  update(payload: Row) {
    this.method = 'update'
    this.updatePayload = payload
    return this
  }
  eq(col: string, val: unknown) {
    this.filters.push([col, val])
    return this
  }
  order(col: string, opts: { ascending?: boolean } = {}) {
    this.orderBy = { col, ascending: opts.ascending !== false }
    return this
  }
  limit(n: number) {
    this.limitN = n
    return this.then(undefined)
  }

  // Resolve to a Promise-shaped result. .then makes the chain awaitable as a
  // PromiseLike when callers don't terminate with .single() / .maybeSingle()
  // (the helper's "select/order/limit" pattern lands here).
  then<TResult1 = any, TResult2 = never>(
    onFulfilled?: ((value: { data: any; error: any }) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this._resolveArrayOrSingle('array')).then(onFulfilled as any, onRejected as any) as any
  }

  async single(): Promise<{ data: Row | null; error: { message: string } | null }> {
    return this._resolveArrayOrSingle('single')
  }

  async maybeSingle(): Promise<{ data: Row | null; error: { message: string } | null }> {
    return this._resolveArrayOrSingle('maybeSingle')
  }

  private _resolveArrayOrSingle(
    kind: 'array' | 'single' | 'maybeSingle',
  ): { data: any; error: any } {
    try {
      if (this.method === 'insert') return this._doInsert(kind)
      if (this.method === 'update') return this._doUpdate(kind)
      return this._doSelect(kind)
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } }
    }
  }

  private _filterRows(rows: Row[]): Row[] {
    return rows.filter((r) => this.filters.every(([c, v]) => r[c] === v))
  }

  private _doSelect(kind: 'array' | 'single' | 'maybeSingle'): { data: any; error: any } {
    let rows = this._filterRows(this.state[this.table as keyof Tables])
    if (this.orderBy) {
      const { col, ascending } = this.orderBy
      rows = rows.slice().sort((a, b) => {
        const av = a[col] as any, bv = b[col] as any
        if (av === bv) return 0
        return (av < bv ? -1 : 1) * (ascending ? 1 : -1)
      })
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN)
    if (kind === 'single') {
      if (rows.length === 1) return { data: deepCopy(rows[0]), error: null }
      return { data: null, error: { message: rows.length === 0 ? 'no rows' : 'multiple rows' } }
    }
    if (kind === 'maybeSingle') {
      if (rows.length > 1) return { data: null, error: { message: 'multiple rows' } }
      return { data: rows[0] ? deepCopy(rows[0]) : null, error: null }
    }
    return { data: rows.map(deepCopy), error: null }
  }

  private _doInsert(kind: 'array' | 'single' | 'maybeSingle'): { data: any; error: any } {
    const payload = this.insertPayload as Row
    if (this.table === 'scope_revisions') {
      // Constraint emulation:
      // - hash regex
      if (!SHA256_RE.test(String(payload.scope_hash))) {
        throw new Error('check constraint scope_hash format')
      }
      if (!SHA256_RE.test(String(payload.pricing_hash))) {
        throw new Error('check constraint pricing_hash format')
      }
      // - status='frozen' INSERT must carry frozen_at
      if (payload.status === 'frozen' && payload.frozen_at == null) {
        throw new Error('check constraint: frozen INSERT requires frozen_at')
      }
      // - (job_id, revision_number) unique
      const dup = this.state.scope_revisions.find(
        (r) => r.job_id === payload.job_id && r.revision_number === payload.revision_number,
      )
      if (dup) throw new Error('unique_violation (job_id, revision_number)')
    }
    if (this.table === 'scope_artifacts') {
      if (!SHA256_RE.test(String(payload.sha256))) {
        throw new Error('check constraint sha256 format')
      }
    }
    const id = (payload.id as string) ?? newId(this.table.slice(0, 3))
    const row: Row = {
      id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      superseded_by_scope_revision_id: null,
      superseded_at: null,
      spine_event_id: null,
      ...payload,
    }
    this.state[this.table as keyof Tables].push(row)
    if (kind === 'single' || kind === 'maybeSingle') return { data: deepCopy(row), error: null }
    return { data: [deepCopy(row)], error: null }
  }

  private _doUpdate(kind: 'array' | 'single' | 'maybeSingle'): { data: any; error: any } {
    const payload = this.updatePayload as Row
    let rows = this._filterRows(this.state[this.table as keyof Tables])

    if (this.table === 'scope_artifacts') {
      throw new Error('scope_artifacts is append-only; UPDATE refused')
    }

    const updated: Row[] = []
    for (const r of rows) {
      // Lifecycle + immutability emulation for scope_revisions.
      if (this.table === 'scope_revisions') {
        if (r.status === 'superseded' && payload.status != null && payload.status !== r.status) {
          throw new Error('superseded is terminal')
        }
        if (r.status === 'frozen') {
          // Refuse contract-column changes.
          for (const col of FROZEN_CONTRACT_COLS) {
            if (col in payload && (payload as any)[col] !== (r as any)[col]) {
              throw new Error(`frozen contract column ${col} cannot change`)
            }
          }
          // Refuse status downgrade frozen → draft.
          if (payload.status != null && payload.status !== 'frozen' && payload.status !== 'superseded') {
            throw new Error('frozen may only transition to superseded')
          }
          // Supersession columns: NULL → NOT NULL only.
          for (const col of ['superseded_by_scope_revision_id', 'superseded_at', 'spine_event_id']) {
            if (col in payload) {
              const oldV = (r as any)[col]
              const newV = (payload as any)[col]
              if (oldV != null && newV !== oldV) {
                throw new Error(`${col} may only transition NULL → NOT NULL`)
              }
            }
          }
          // Frozen → superseded must carry both supersession columns.
          if (payload.status === 'superseded') {
            const newRow: any = { ...r, ...payload }
            if (newRow.superseded_by_scope_revision_id == null || newRow.superseded_at == null) {
              throw new Error('supersede requires superseded_by + superseded_at')
            }
          }
        }
        // draft → frozen requires frozen_at.
        if (r.status !== 'frozen' && payload.status === 'frozen') {
          const newRow: any = { ...r, ...payload }
          if (newRow.frozen_at == null) throw new Error('cannot transition to frozen without frozen_at')
        }
      }

      // Apply.
      Object.assign(r, payload, { updated_at: new Date().toISOString() })
      updated.push(r)
    }

    if (kind === 'single') {
      if (updated.length === 1) return { data: deepCopy(updated[0]), error: null }
      return { data: null, error: { message: updated.length === 0 ? 'no row updated' : 'multiple rows updated' } }
    }
    if (kind === 'maybeSingle') {
      if (updated.length > 1) return { data: null, error: { message: 'multiple rows updated' } }
      return { data: updated[0] ? deepCopy(updated[0]) : null, error: null }
    }
    return { data: updated.map(deepCopy), error: null }
  }
}

function makeMockClient(seed?: Partial<Tables>) {
  const state: Tables = {
    jobs: deepCopy(seed?.jobs ?? []),
    scope_revisions: deepCopy(seed?.scope_revisions ?? []),
    scope_artifacts: deepCopy(seed?.scope_artifacts ?? []),
  }
  return {
    from(table: string) {
      if (!(table in state)) throw new Error(`mock client: unknown table ${table}`)
      return new MockChain(table, state)
    },
    _state: state,
  }
}

// ── Common fixtures ─────────────────────────────────────────────────────────

const PATIO_SCOPE = {
  kind: 'patio',
  size: { length_mm: 6000, width_mm: 4000 },
  roof: { style: 'flat', pitch_deg: 2 },
  attach: { method: 'fascia', height_mm: 2700 },
  posts: [{ x: 0, y: 0, size: '90x90' }, { x: 6000, y: 0, size: '90x90' }],
}
const PATIO_PRICING = {
  schema: 'patio.v1',
  line_items: [
    { sku: 'SOLARSPAN_75', qty_m2: 24, unit: 650 },
    { sku: 'POSTS_90x90', qty: 2, unit: 180 },
  ],
  totals: { ex_gst: 16560, gst: 1656, inc_gst: 18216 },
}

const FENCE_SCOPE = {
  kind: 'fencing',
  runs: [
    { id: 'A', length_mm: 12000, height_mm: 1800, colour: 'monument' },
    { id: 'B', length_mm: 6000, height_mm: 1800, colour: 'monument' },
  ],
  gates: [{ id: 'G1', width_mm: 900, type: 'pedestrian' }],
}
const FENCE_PRICING = {
  schema: 'fencing.v1',
  per_run: [{ id: 'A', price_ex_gst: 4800 }, { id: 'B', price_ex_gst: 2400 }],
  totals: { ex_gst: 7200, gst: 720, inc_gst: 7920 },
}

const QUICK_QUOTE_SCOPE = { kind: 'quick_quote', notes: 'verbal scope, simple carport ~30m2' }
const QUICK_QUOTE_PRICING = { schema: 'quick_quote.v1', total_inc_gst: 9500 }

function seedJob(opts: {
  id?: string
  type?: string
  scope_json?: unknown
  pricing_json?: unknown
}): Row {
  return {
    id: opts.id ?? newId('job'),
    type: opts.type ?? 'patio',
    scope_json: opts.scope_json ?? null,
    pricing_json: opts.pricing_json ?? null,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// freezeScope tests
// ───────────────────────────────────────────────────────────────────────────

Deno.test('isToolKind — accepts the seven enum values, rejects others', () => {
  for (const k of TOOL_KINDS) assert(isToolKind(k), `expected ${k} to be valid`)
  for (const k of ['', 'foo', 'PATIO', null, undefined, 42]) {
    assert(!isToolKind(k as any), `expected ${String(k)} to be rejected`)
  }
})

Deno.test('freezeScope — rejects unknown tool_kind', async () => {
  const client = makeMockClient({ jobs: [seedJob({ id: 'J1', scope_json: PATIO_SCOPE, pricing_json: PATIO_PRICING })] })
  const result = await freezeScope(client as any, { job_id: 'J1', tool_kind: 'kayak' as ToolKind })
  assertEquals(result.ok, false)
  if (!result.ok) assertEquals(result.error.code, 'invalid_tool_kind')
})

Deno.test('freezeScope — rejects when job does not exist', async () => {
  const client = makeMockClient()
  const result = await freezeScope(client as any, { job_id: 'missing', tool_kind: 'patio' })
  assertEquals(result.ok, false)
  if (!result.ok) assertEquals(result.error.code, 'job_not_found')
})

Deno.test('freezeScope — rejects job with null scope_json', async () => {
  const client = makeMockClient({ jobs: [seedJob({ id: 'J1', scope_json: null, pricing_json: PATIO_PRICING })] })
  const result = await freezeScope(client as any, { job_id: 'J1', tool_kind: 'patio' })
  assertEquals(result.ok, false)
  if (!result.ok) assertEquals(result.error.code, 'job_missing_scope')
})

Deno.test('freezeScope — rejects job with null pricing_json', async () => {
  const client = makeMockClient({ jobs: [seedJob({ id: 'J1', scope_json: PATIO_SCOPE, pricing_json: null })] })
  const result = await freezeScope(client as any, { job_id: 'J1', tool_kind: 'patio' })
  assertEquals(result.ok, false)
  if (!result.ok) assertEquals(result.error.code, 'job_missing_pricing')
})

Deno.test('freezeScope — rejects job with empty-object scope_json', async () => {
  const client = makeMockClient({ jobs: [seedJob({ id: 'J1', scope_json: {}, pricing_json: PATIO_PRICING })] })
  const result = await freezeScope(client as any, { job_id: 'J1', tool_kind: 'patio' })
  assertEquals(result.ok, false)
  if (!result.ok) assertEquals(result.error.code, 'job_missing_scope')
})

Deno.test('freezeScope — patio fresh freeze writes v1 with deterministic hashes', async () => {
  const client = makeMockClient({
    jobs: [seedJob({ id: 'J-PATIO', scope_json: PATIO_SCOPE, pricing_json: PATIO_PRICING })],
  })
  const result = await freezeScope(client as any, { job_id: 'J-PATIO', tool_kind: 'patio' })
  assertEquals(result.ok, true)
  if (!result.ok) return
  assertEquals(result.revision_number, 1)
  assertEquals(result.tool_kind, 'patio')
  assertEquals(result.status, 'frozen')
  assertEquals(result.superseded_revision_id, null)
  assert(/^[0-9a-f]{64}$/.test(result.scope_hash))
  assert(/^[0-9a-f]{64}$/.test(result.pricing_hash))
  // Stored row matches.
  const stored = client._state.scope_revisions[0] as any
  assertEquals(stored.job_id, 'J-PATIO')
  assertEquals(stored.status, 'frozen')
  assertEquals(stored.tool_kind, 'patio')
  assertEquals(stored.scope_hash, result.scope_hash)
  assertEquals(stored.pricing_hash, result.pricing_hash)
  assertEquals(stored.renderer_version, 'three.js@r128')
  assertEquals(stored.tool_version, 'PatioDesignerPro_V18')
  assertExists(stored.frozen_at)
})

Deno.test('freezeScope — fence fresh freeze writes v1 with provided versions', async () => {
  const client = makeMockClient({
    jobs: [seedJob({ id: 'J-FENCE', type: 'fencing', scope_json: FENCE_SCOPE, pricing_json: FENCE_PRICING })],
  })
  const result = await freezeScope(client as any, {
    job_id: 'J-FENCE',
    tool_kind: 'fencing',
    renderer_version: 'fence-designer@abc1234',
    tool_version: 'fence-designer@abc1234',
    frozen_by_user_id: 'user-shaun',
  })
  assert(result.ok)
  if (!result.ok) return
  assertEquals(result.revision_number, 1)
  assertEquals(result.tool_kind, 'fencing')
  const stored = client._state.scope_revisions[0] as any
  assertEquals(stored.renderer_version, 'fence-designer@abc1234')
  assertEquals(stored.tool_version, 'fence-designer@abc1234')
  assertEquals(stored.frozen_by_user_id, 'user-shaun')
})

Deno.test('freezeScope — quick_quote freeze succeeds (shortcut path is documented; helper still produces a frozen revision)', async () => {
  // Per Loop 0 strategy doc § 6: Quick Quote remains a documented shortcut
  // for V2 release-packet citation (the validator will allow quick_quote
  // releases without scope_revision_id in step 6). The helper itself does
  // NOT skip — it freezes whatever is provided. The "shortcut" is the
  // downstream V2 validator behaviour, not freezeScope.
  const client = makeMockClient({
    jobs: [seedJob({ id: 'J-QQ', type: 'misc', scope_json: QUICK_QUOTE_SCOPE, pricing_json: QUICK_QUOTE_PRICING })],
  })
  const result = await freezeScope(client as any, { job_id: 'J-QQ', tool_kind: 'quick_quote' })
  assert(result.ok)
  if (!result.ok) return
  assertEquals(result.tool_kind, 'quick_quote')
  assertEquals(result.revision_number, 1)
})

Deno.test('freezeScope — same scope_json yields same scope_hash regardless of key order', async () => {
  const reordered = {
    posts: PATIO_SCOPE.posts,
    attach: PATIO_SCOPE.attach,
    roof: { pitch_deg: 2, style: 'flat' },
    size: { width_mm: 4000, length_mm: 6000 },
    kind: 'patio',
  }
  const c1 = makeMockClient({ jobs: [seedJob({ id: 'J1', scope_json: PATIO_SCOPE, pricing_json: PATIO_PRICING })] })
  const c2 = makeMockClient({ jobs: [seedJob({ id: 'J2', scope_json: reordered, pricing_json: PATIO_PRICING })] })
  const r1 = await freezeScope(c1 as any, { job_id: 'J1', tool_kind: 'patio' })
  const r2 = await freezeScope(c2 as any, { job_id: 'J2', tool_kind: 'patio' })
  assert(r1.ok && r2.ok)
  if (!r1.ok || !r2.ok) return
  assertEquals(r1.scope_hash, r2.scope_hash)
})

Deno.test('freezeScope — different scope content yields different scope_hash', async () => {
  const variant = { ...PATIO_SCOPE, size: { ...PATIO_SCOPE.size, length_mm: 7000 } }
  const c1 = makeMockClient({ jobs: [seedJob({ id: 'J1', scope_json: PATIO_SCOPE, pricing_json: PATIO_PRICING })] })
  const c2 = makeMockClient({ jobs: [seedJob({ id: 'J2', scope_json: variant, pricing_json: PATIO_PRICING })] })
  const r1 = await freezeScope(c1 as any, { job_id: 'J1', tool_kind: 'patio' })
  const r2 = await freezeScope(c2 as any, { job_id: 'J2', tool_kind: 'patio' })
  assert(r1.ok && r2.ok)
  if (!r1.ok || !r2.ok) return
  assertNotEquals(r1.scope_hash, r2.scope_hash)
})

Deno.test('freezeScope — clone+refreeze cycle: latest frozen → inserts v2, supersedes v1', async () => {
  const client = makeMockClient({
    jobs: [seedJob({ id: 'J1', scope_json: PATIO_SCOPE, pricing_json: PATIO_PRICING })],
  })
  // v1
  const r1 = await freezeScope(client as any, { job_id: 'J1', tool_kind: 'patio' })
  assert(r1.ok)
  if (!r1.ok) return
  const v1Id = r1.scope_revision_id
  const v1Hash = r1.scope_hash

  // Mutate the live job row to simulate operator edit.
  const job = client._state.jobs.find((j) => j.id === 'J1')! as any
  job.scope_json = { ...PATIO_SCOPE, posts: [...PATIO_SCOPE.posts, { x: 6000, y: 4000, size: '90x90' }] }
  job.pricing_json = { ...PATIO_PRICING, totals: { ex_gst: 16700, gst: 1670, inc_gst: 18370 } }

  // v2
  const r2 = await freezeScope(client as any, { job_id: 'J1', tool_kind: 'patio' })
  assert(r2.ok)
  if (!r2.ok) return
  assertEquals(r2.revision_number, 2)
  assertEquals(r2.superseded_revision_id, v1Id)
  assertNotEquals(r2.scope_hash, v1Hash)

  // v1 is unchanged + superseded.
  const stored = client._state.scope_revisions
  const v1 = stored.find((r) => (r as any).id === v1Id) as any
  assertEquals(v1.status, 'superseded')
  assertEquals(v1.superseded_by_scope_revision_id, r2.scope_revision_id)
  assertEquals(v1.scope_hash, v1Hash, 'frozen v1 hash must not change after v2 is created')
  assertExists(v1.superseded_at)

  // v2 is frozen.
  const v2 = stored.find((r) => (r as any).id === r2.scope_revision_id) as any
  assertEquals(v2.status, 'frozen')
  assertEquals(v2.revision_number, 2)
  assertEquals(v2.superseded_by_scope_revision_id, null)
})

Deno.test('freezeScope — promotes existing draft to frozen with refreshed canonicals AND supersedes v(N-1)', async () => {
  // Setup: pre-existing v1 frozen + v2 draft (as if cloneScopeForEdit ran).
  const v1: Row = {
    id: 'rev-v1', job_id: 'J1', revision_number: 1, status: 'frozen',
    tool_kind: 'patio',
    scope_canonical_text: '{"kind":"patio"}', scope_hash: 'a'.repeat(64),
    pricing_canonical_text: '{"x":1}', pricing_hash: 'b'.repeat(64),
    renderer_version: 'three.js@r128', tool_version: 'PatioDesignerPro_V18',
    frozen_at: '2026-05-04T08:00:00.000Z',
  }
  const v2draft: Row = {
    id: 'rev-v2', job_id: 'J1', revision_number: 2, status: 'draft',
    tool_kind: 'patio',
    scope_canonical_text: '{"kind":"patio"}', scope_hash: 'a'.repeat(64),
    pricing_canonical_text: '{"x":1}', pricing_hash: 'b'.repeat(64),
    renderer_version: 'three.js@r128', tool_version: 'PatioDesignerPro_V18',
  }
  const client = makeMockClient({
    jobs: [seedJob({ id: 'J1', scope_json: PATIO_SCOPE, pricing_json: PATIO_PRICING })],
    scope_revisions: [v1, v2draft],
  })
  const result = await freezeScope(client as any, { job_id: 'J1', tool_kind: 'patio' })
  assert(result.ok)
  if (!result.ok) return
  assertEquals(result.scope_revision_id, 'rev-v2')
  assertEquals(result.revision_number, 2)
  assertEquals(result.status, 'frozen')
  // Promoting a draft to frozen MUST supersede v(N-1) so the partial
  // WHERE status='frozen' index returns exactly one row per job. Strategy
  // doc § 6 step 8: v1.superseded_by_scope_revision_id = v2.id.
  assertEquals(result.superseded_revision_id, 'rev-v1')
  const refreshed = client._state.scope_revisions.find((r) => (r as any).id === 'rev-v2') as any
  assertNotEquals(refreshed.scope_hash, 'a'.repeat(64), 'promoted draft must carry refreshed canonicals from current job state')
  const v1After = client._state.scope_revisions.find((r) => (r as any).id === 'rev-v1') as any
  assertEquals(v1After.status, 'superseded')
  assertEquals(v1After.superseded_by_scope_revision_id, 'rev-v2')
  assertEquals(v1After.scope_hash, 'a'.repeat(64), 'v1 contract columns unchanged after supersession')
})

Deno.test('freezeScope — bad sha256 from a tampered hash function would be rejected at insert (regex guard)', () => {
  // The trigger guards `scope_hash ~ '^[0-9a-f]{64}$'` and the mock mirrors
  // the regex. We simulate a tampered insert by going around the helper and
  // calling .insert with a non-hex hash directly. This proves the guard
  // exists at the database layer (per migration scope_revisions_and_artifacts,
  // file 20260504090757_scope_revisions_and_artifacts.sql) and via the mock
  // representation that future test cases rely on.
  const client = makeMockClient({})
  let threw = false
  try {
    // Use the mock client directly.
    const chain: any = client.from('scope_revisions').insert({
      job_id: 'job-x',
      revision_number: 1,
      tool_kind: 'patio',
      scope_canonical_text: '{}',
      scope_hash: 'NOT-A-HEX-HASH',
      pricing_canonical_text: '{}',
      pricing_hash: 'b'.repeat(64),
      renderer_version: 'three.js@r128',
      tool_version: 'PatioDesignerPro_V18',
      status: 'frozen',
      frozen_at: new Date().toISOString(),
    }).select('id')
    // _resolveArrayOrSingle catches and packs the throw as { error }.
    return chain.single().then((res: any) => {
      assertExists(res.error)
      assert(/scope_hash format/i.test(res.error.message))
      threw = true
    })
  } finally {
    // promise return path; nothing else to do
    void threw
  }
})

Deno.test('freezeScope — append-only scope_artifacts: UPDATE refused at the mock (DB trigger parity)', async () => {
  const client = makeMockClient({})
  // Insert an artifact directly (bypassing helpers — no helper writes
  // scope_artifacts in this leg).
  const ins: any = await client.from('scope_artifacts').insert({
    scope_revision_id: 'rev-x',
    artifact_type: 'render_hero',
    storage_path: 'rev-x/hero.png',
    bucket_id: 'scope-artifacts',
    sha256: 'c'.repeat(64),
    size_bytes: 1024,
    content_type: 'image/png',
  }).select('id').single()
  assertExists(ins.data)
  assertEquals(ins.error, null)
  // UPDATE refused.
  const upd: any = await client.from('scope_artifacts').update({ label: 'try-rename' }).eq('id', ins.data.id).select('id').single()
  assertExists(upd.error)
  assert(/append-only/i.test(upd.error.message))
})

// ───────────────────────────────────────────────────────────────────────────
// cloneScopeForEdit tests
// ───────────────────────────────────────────────────────────────────────────

Deno.test('cloneScopeForEdit — rejects non-existent source revision', async () => {
  const client = makeMockClient()
  const result = await cloneScopeForEdit(client as any, { scope_revision_id: 'missing' })
  assertEquals(result.ok, false)
  if (!result.ok) assertEquals(result.error.code, 'source_not_found')
})

Deno.test('cloneScopeForEdit — rejects draft source (must be frozen)', async () => {
  const draft: Row = {
    id: 'rev-d', job_id: 'J1', revision_number: 1, status: 'draft',
    tool_kind: 'patio',
    scope_canonical_text: '{}', scope_hash: 'a'.repeat(64),
    pricing_canonical_text: '{}', pricing_hash: 'b'.repeat(64),
    renderer_version: 'three.js@r128', tool_version: 'PatioDesignerPro_V18',
  }
  const client = makeMockClient({ scope_revisions: [draft] })
  const result = await cloneScopeForEdit(client as any, { scope_revision_id: 'rev-d' })
  assertEquals(result.ok, false)
  if (!result.ok && result.error.code === 'source_not_frozen') {
    assertEquals(result.error.current_status, 'draft')
  }
})

Deno.test('cloneScopeForEdit — rejects when source is not the latest frozen', async () => {
  const v1: Row = {
    id: 'rev-1', job_id: 'J1', revision_number: 1, status: 'superseded',
    tool_kind: 'patio',
    scope_canonical_text: '{}', scope_hash: 'a'.repeat(64),
    pricing_canonical_text: '{}', pricing_hash: 'b'.repeat(64),
    renderer_version: 'three.js@r128', tool_version: 'PatioDesignerPro_V18',
    frozen_at: '2026-05-04T08:00:00Z',
    superseded_by_scope_revision_id: 'rev-2', superseded_at: '2026-05-04T09:00:00Z',
  }
  const v2: Row = { ...v1, id: 'rev-2', revision_number: 2, status: 'frozen', superseded_by_scope_revision_id: null, superseded_at: null }
  const client = makeMockClient({ scope_revisions: [v1, v2] })
  // Cloning the superseded v1 must be refused: by status check first.
  const result = await cloneScopeForEdit(client as any, { scope_revision_id: 'rev-1' })
  assertEquals(result.ok, false)
  if (!result.ok) assertEquals(result.error.code, 'source_not_frozen')
})

Deno.test('cloneScopeForEdit — rejects when an open draft already exists for this job', async () => {
  const v1: Row = {
    id: 'rev-1', job_id: 'J1', revision_number: 1, status: 'frozen',
    tool_kind: 'patio',
    scope_canonical_text: '{"kind":"patio"}', scope_hash: 'a'.repeat(64),
    pricing_canonical_text: '{"x":1}', pricing_hash: 'b'.repeat(64),
    renderer_version: 'three.js@r128', tool_version: 'PatioDesignerPro_V18',
    frozen_at: '2026-05-04T08:00:00Z',
  }
  const draft: Row = {
    id: 'rev-2-draft', job_id: 'J1', revision_number: 2, status: 'draft',
    tool_kind: 'patio',
    scope_canonical_text: '{"kind":"patio"}', scope_hash: 'a'.repeat(64),
    pricing_canonical_text: '{"x":1}', pricing_hash: 'b'.repeat(64),
    renderer_version: 'three.js@r128', tool_version: 'PatioDesignerPro_V18',
  }
  const client = makeMockClient({
    jobs: [seedJob({ id: 'J1', scope_json: PATIO_SCOPE, pricing_json: PATIO_PRICING })],
    scope_revisions: [v1, draft],
  })
  const result = await cloneScopeForEdit(client as any, { scope_revision_id: 'rev-1' })
  assertEquals(result.ok, false)
  if (!result.ok) {
    // Either we report "draft_already_exists" (preferred) or
    // "source_not_latest". Both are acceptable; assert one of them.
    assert(
      result.error.code === 'draft_already_exists' || result.error.code === 'source_not_latest',
      `unexpected error code: ${result.error.code}`,
    )
  }
})

Deno.test('cloneScopeForEdit — clones latest frozen into a new draft v(N+1) and refreshes jobs working state', async () => {
  // Seed a frozen v1.
  const client = makeMockClient({
    jobs: [seedJob({ id: 'J1', scope_json: { stale: true }, pricing_json: { stale: true } })],
  })
  const r1 = await freezeScope(client as any, { job_id: 'J1', tool_kind: 'patio' })
  // Initial seed had stale scope; force a real freeze with proper data first.
  void r1
  // Reset job to a clean frozen baseline using direct seed.
  client._state.jobs = [seedJob({ id: 'J2', scope_json: PATIO_SCOPE, pricing_json: PATIO_PRICING })]
  client._state.scope_revisions = []
  const fr = await freezeScope(client as any, { job_id: 'J2', tool_kind: 'patio' })
  assert(fr.ok)
  if (!fr.ok) return

  // Mutate jobs to confirm clone refreshes the working state from the
  // frozen canonical bytes (not the live mutation).
  const job = client._state.jobs.find((j) => j.id === 'J2')! as any
  job.scope_json = { tampered: true }
  job.pricing_json = { tampered: true }

  const cl = await cloneScopeForEdit(client as any, { scope_revision_id: fr.scope_revision_id })
  assert(cl.ok)
  if (!cl.ok) return
  assertEquals(cl.revision_number, 2)
  assertEquals(cl.status, 'draft')
  assertEquals(cl.cloned_from_scope_revision_id, fr.scope_revision_id)
  assertEquals(cl.jobs_working_state_written, true)

  // jobs.scope_json now matches the canonical-from-frozen-v1.
  const jobAfter = client._state.jobs.find((j) => j.id === 'J2')! as any
  assertObjectMatch(jobAfter.scope_json, PATIO_SCOPE as any)
  assertObjectMatch(jobAfter.pricing_json, PATIO_PRICING as any)

  // The draft row inherits the frozen v1's hashes (because we haven't edited yet).
  const draft = client._state.scope_revisions.find((r) => (r as any).status === 'draft') as any
  assertEquals(draft.scope_hash, fr.scope_hash)
  assertEquals(draft.pricing_hash, fr.pricing_hash)
})

Deno.test('cloneScopeForEdit — write_jobs_working_state=false leaves jobs row untouched', async () => {
  const client = makeMockClient({
    jobs: [seedJob({ id: 'J3', scope_json: PATIO_SCOPE, pricing_json: PATIO_PRICING })],
  })
  const fr = await freezeScope(client as any, { job_id: 'J3', tool_kind: 'patio' })
  assert(fr.ok)
  if (!fr.ok) return

  // Tamper the live job to a sentinel, confirm clone does NOT overwrite.
  const job = client._state.jobs.find((j) => j.id === 'J3')! as any
  job.scope_json = { sentinel: 'do-not-overwrite' }
  job.pricing_json = { sentinel: 'do-not-overwrite' }

  const cl = await cloneScopeForEdit(client as any, {
    scope_revision_id: fr.scope_revision_id,
    write_jobs_working_state: false,
  })
  assert(cl.ok)
  if (!cl.ok) return
  assertEquals(cl.jobs_working_state_written, false)
  const jobAfter = client._state.jobs.find((j) => j.id === 'J3')! as any
  assertObjectMatch(jobAfter.scope_json, { sentinel: 'do-not-overwrite' })
  assertObjectMatch(jobAfter.pricing_json, { sentinel: 'do-not-overwrite' })
})

Deno.test('clone+refreeze cycle: v1 contract columns immutable, v1 marked superseded, exactly one frozen row per job', async () => {
  const client = makeMockClient({
    jobs: [seedJob({ id: 'J-CYCLE', scope_json: PATIO_SCOPE, pricing_json: PATIO_PRICING })],
  })
  // freeze v1
  const fr1 = await freezeScope(client as any, { job_id: 'J-CYCLE', tool_kind: 'patio' })
  assert(fr1.ok)
  if (!fr1.ok) return
  const v1Hash = fr1.scope_hash
  const v1PricingHash = fr1.pricing_hash
  const v1Id = fr1.scope_revision_id

  // clone v1 → draft v2, working state refreshed
  const cl = await cloneScopeForEdit(client as any, { scope_revision_id: v1Id })
  assert(cl.ok)
  if (!cl.ok) return

  // operator edits live job
  const job = client._state.jobs.find((j) => j.id === 'J-CYCLE')! as any
  job.scope_json = { ...PATIO_SCOPE, gutters: { type: 'box', colour: 'monument' } }

  // freeze v2 (promotes draft AND supersedes v1)
  const fr2 = await freezeScope(client as any, { job_id: 'J-CYCLE', tool_kind: 'patio' })
  assert(fr2.ok)
  if (!fr2.ok) return
  assertEquals(fr2.scope_revision_id, cl.scope_revision_id, 'freeze should promote the existing draft, not create a new row')
  assertEquals(fr2.revision_number, 2)
  assertEquals(fr2.status, 'frozen')
  assertNotEquals(fr2.scope_hash, v1Hash)
  assertEquals(fr2.superseded_revision_id, v1Id, 'v1 must be superseded by v2 so only v2 is current frozen')

  // v1 row contract columns unchanged (immutability invariant).
  const v1Row = client._state.scope_revisions.find((r) => (r as any).id === v1Id) as any
  assertEquals(v1Row.status, 'superseded', 'v1 transitions to superseded when v2 freezes')
  assertEquals(v1Row.scope_hash, v1Hash, 'v1 scope_hash unchanged')
  assertEquals(v1Row.pricing_hash, v1PricingHash, 'v1 pricing_hash unchanged')
  assertEquals(v1Row.superseded_by_scope_revision_id, fr2.scope_revision_id)
  assertExists(v1Row.superseded_at)

  // Exactly one frozen row per job — the partial WHERE status='frozen' invariant.
  const frozenRows = client._state.scope_revisions.filter((r) => (r as any).job_id === 'J-CYCLE' && (r as any).status === 'frozen')
  assertEquals(frozenRows.length, 1, 'exactly one frozen scope_revisions row per job after a clone+refreeze cycle')
  assertEquals((frozenRows[0] as any).id, fr2.scope_revision_id)
})

Deno.test('monotonic revision numbering across mixed cycles, exactly one frozen row at every step', async () => {
  const client = makeMockClient({
    jobs: [seedJob({ id: 'J-MONO', scope_json: PATIO_SCOPE, pricing_json: PATIO_PRICING })],
  })
  const countFrozen = () =>
    client._state.scope_revisions.filter((r) => (r as any).job_id === 'J-MONO' && (r as any).status === 'frozen').length

  // v1
  const a = await freezeScope(client as any, { job_id: 'J-MONO', tool_kind: 'patio' })
  assert(a.ok); if (!a.ok) return
  assertEquals(countFrozen(), 1)
  // v2 via direct refreeze (no clone) → case C: supersede v1
  const b = await freezeScope(client as any, { job_id: 'J-MONO', tool_kind: 'patio' })
  assert(b.ok); if (!b.ok) return
  assertEquals(b.superseded_revision_id, a.scope_revision_id)
  assertEquals(countFrozen(), 1)
  // v3 via clone+freeze → case B: supersede v2
  const c = await cloneScopeForEdit(client as any, { scope_revision_id: b.scope_revision_id })
  assert(c.ok); if (!c.ok) return
  const d = await freezeScope(client as any, { job_id: 'J-MONO', tool_kind: 'patio' })
  assert(d.ok); if (!d.ok) return
  assertEquals(d.superseded_revision_id, b.scope_revision_id)
  assertEquals(countFrozen(), 1)
  assertEquals(a.revision_number, 1)
  assertEquals(b.revision_number, 2)
  assertEquals(c.revision_number, 3)
  assertEquals(d.revision_number, 3) // promote-draft kept the draft's number
})

// ───────────────────────────────────────────────────────────────────────────
// healFrozenInvariant + freezeScope incident-recovery tests
// ───────────────────────────────────────────────────────────────────────────

Deno.test('healFrozenInvariant — no-op when zero or one frozen row', async () => {
  const empty = makeMockClient()
  const r0 = await healFrozenInvariant(empty as any, 'job-x', '2026-05-04T10:00:00Z')
  assert(r0.ok); if (!r0.ok) return
  assertEquals(r0.current_frozen_id, null)
  assertEquals(r0.superseded.length, 0)

  const oneClient = makeMockClient({
    scope_revisions: [{
      id: 'rev-only', job_id: 'J1', revision_number: 1, status: 'frozen',
      tool_kind: 'patio', scope_canonical_text: '{}', scope_hash: 'a'.repeat(64),
      pricing_canonical_text: '{}', pricing_hash: 'b'.repeat(64),
      renderer_version: 'three.js@r128', tool_version: 'PatioDesignerPro_V18',
      frozen_at: '2026-05-04T08:00:00Z',
    }],
  })
  const r1 = await healFrozenInvariant(oneClient as any, 'J1', '2026-05-04T10:00:00Z')
  assert(r1.ok); if (!r1.ok) return
  assertEquals(r1.current_frozen_id, 'rev-only')
  assertEquals(r1.superseded.length, 0)
})

Deno.test('healFrozenInvariant — supersedes all but the highest-revision frozen row', async () => {
  // Stale state: three frozen rows for the same job, simulating multiple
  // partial-failure incidents. The heal must keep v3 and supersede v1+v2.
  const mk = (n: number, id: string) => ({
    id, job_id: 'J1', revision_number: n, status: 'frozen',
    tool_kind: 'patio', scope_canonical_text: `{"v":${n}}`,
    scope_hash: String.fromCharCode(96 + n).repeat(64),
    pricing_canonical_text: `{"v":${n}}`,
    pricing_hash: String.fromCharCode(96 + n).repeat(64),
    renderer_version: 'three.js@r128', tool_version: 'PatioDesignerPro_V18',
    frozen_at: '2026-05-04T08:00:00Z',
  })
  const client = makeMockClient({ scope_revisions: [mk(1, 'rev-1'), mk(2, 'rev-2'), mk(3, 'rev-3')] })
  const r = await healFrozenInvariant(client as any, 'J1', '2026-05-04T10:00:00Z')
  assert(r.ok); if (!r.ok) return
  assertEquals(r.current_frozen_id, 'rev-3')
  assertEquals(r.superseded.length, 2)
  assertEquals(r.superseded.map((s) => s.id).sort(), ['rev-1', 'rev-2'])

  const finalState = client._state.scope_revisions.map((row) => ({ id: (row as any).id, status: (row as any).status }))
  assertEquals(finalState.find((s) => s.id === 'rev-3')!.status, 'frozen')
  assertEquals(finalState.find((s) => s.id === 'rev-2')!.status, 'superseded')
  assertEquals(finalState.find((s) => s.id === 'rev-1')!.status, 'superseded')
  // Both superseded rows point at v3.
  for (const id of ['rev-1', 'rev-2']) {
    const row = client._state.scope_revisions.find((r) => (r as any).id === id) as any
    assertEquals(row.superseded_by_scope_revision_id, 'rev-3')
    assertExists(row.superseded_at)
  }
})

Deno.test('healFrozenInvariant — idempotent on re-run after success', async () => {
  const mk = (n: number, id: string, status: 'frozen' | 'superseded') => ({
    id, job_id: 'J1', revision_number: n, status,
    tool_kind: 'patio', scope_canonical_text: `{"v":${n}}`,
    scope_hash: String.fromCharCode(96 + n).repeat(64),
    pricing_canonical_text: `{"v":${n}}`,
    pricing_hash: String.fromCharCode(96 + n).repeat(64),
    renderer_version: 'three.js@r128', tool_version: 'PatioDesignerPro_V18',
    frozen_at: '2026-05-04T08:00:00Z',
    ...(status === 'superseded'
      ? { superseded_by_scope_revision_id: 'rev-2', superseded_at: '2026-05-04T09:00:00Z' }
      : {}),
  })
  const client = makeMockClient({ scope_revisions: [mk(1, 'rev-1', 'superseded'), mk(2, 'rev-2', 'frozen')] })
  const r1 = await healFrozenInvariant(client as any, 'J1', '2026-05-04T10:00:00Z')
  assert(r1.ok); if (!r1.ok) return
  assertEquals(r1.superseded.length, 0)
  const r2 = await healFrozenInvariant(client as any, 'J1', '2026-05-04T11:00:00Z')
  assert(r2.ok); if (!r2.ok) return
  assertEquals(r2.superseded.length, 0)
  assertEquals(r2.current_frozen_id, 'rev-2')
})

Deno.test('freezeScope — incident recovery via heal: prior partial-failure state with two frozen rows is cleaned up on next freeze', async () => {
  // Simulate the exact bad state Codex flagged: a previous freeze cycle
  // successfully promoted v(N) to frozen but the supersession of v(N-1)
  // failed and persisted. Two rows now sit at status='frozen'.
  const v1: Row = {
    id: 'rev-v1', job_id: 'J-INCIDENT', revision_number: 1, status: 'frozen',
    tool_kind: 'patio',
    scope_canonical_text: '{"v":1}', scope_hash: 'a'.repeat(64),
    pricing_canonical_text: '{"v":1}', pricing_hash: 'b'.repeat(64),
    renderer_version: 'three.js@r128', tool_version: 'PatioDesignerPro_V18',
    frozen_at: '2026-05-04T08:00:00Z',
  }
  const v2: Row = {
    id: 'rev-v2', job_id: 'J-INCIDENT', revision_number: 2, status: 'frozen',
    tool_kind: 'patio',
    scope_canonical_text: '{"v":2}', scope_hash: 'c'.repeat(64),
    pricing_canonical_text: '{"v":2}', pricing_hash: 'd'.repeat(64),
    renderer_version: 'three.js@r128', tool_version: 'PatioDesignerPro_V18',
    frozen_at: '2026-05-04T09:00:00Z',
  }
  const client = makeMockClient({
    jobs: [seedJob({ id: 'J-INCIDENT', scope_json: PATIO_SCOPE, pricing_json: PATIO_PRICING })],
    scope_revisions: [v1, v2],
  })
  // Sanity: we begin in the broken state (two frozen rows).
  const initialFrozen = client._state.scope_revisions.filter((r) => (r as any).status === 'frozen')
  assertEquals(initialFrozen.length, 2)

  // Operator runs freeze again — fetchLatestRevision sees v2 frozen (case C),
  // inserts v3, then heal supersedes BOTH v1 and v2.
  const result = await freezeScope(client as any, { job_id: 'J-INCIDENT', tool_kind: 'patio' })
  assert(result.ok); if (!result.ok) return
  assertEquals(result.revision_number, 3)
  assertEquals(result.superseded_revision_id, 'rev-v2', 'immediate predecessor v2 reported as superseded')
  assertEquals(result.additional_superseded_revision_ids.sort(), ['rev-v1'], 'stray older frozen row v1 also superseded by heal')

  const frozenAfter = client._state.scope_revisions.filter((r) => (r as any).status === 'frozen')
  assertEquals(frozenAfter.length, 1, 'incident-state cleared: exactly one frozen row remains')
  assertEquals((frozenAfter[0] as any).id, result.scope_revision_id)
})

Deno.test('freezeScope — fresh-freeze path returns empty additional_superseded_revision_ids in the happy case', async () => {
  const client = makeMockClient({
    jobs: [seedJob({ id: 'J-FRESH', scope_json: PATIO_SCOPE, pricing_json: PATIO_PRICING })],
  })
  const result = await freezeScope(client as any, { job_id: 'J-FRESH', tool_kind: 'patio' })
  assert(result.ok); if (!result.ok) return
  assertEquals(result.revision_number, 1)
  assertEquals(result.superseded_revision_id, null)
  assertEquals(result.additional_superseded_revision_ids, [])
})

