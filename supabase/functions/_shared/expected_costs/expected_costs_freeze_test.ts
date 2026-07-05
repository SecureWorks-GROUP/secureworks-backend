// profitability-job-costing M1 (profit-baseline-freeze) U2 — fixture tests for
// freezeExpectedCostsOnAcceptance.
//
// Runs entirely against an in-memory mock Supabase client — no network, no live
// Supabase. The mock reproduces only the query shapes the helper calls
// (select/eq/eq/order/limit, select/eq/maybeSingle, update/eq/is/select) and,
// crucially, emulates the production write-once trigger from the migration
// 20260705000001_job_expected_cost_baseline.sql:
//   * UPDATE that CHANGES a non-null jobs.expected_costs / expected_frozen_at throws.
//   * UPDATE that touches other jobs columns while expected_costs stays put is fine.
// so a helper regression that tries to overwrite a frozen baseline fails here
// exactly as it would in Postgres.
//
// The frozen-revision fixtures use the REAL canonicalize + jsonHash so the
// helper's hash verification is exercised end-to-end (and the tamper test uses a
// deliberately wrong hash).

import {
  assert,
  assertEquals,
  assertExists,
} from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { canonicalize, jsonHash } from '../release_packet/canonicalize.ts'
import {
  freezeExpectedCostsOnAcceptance,
  EXPECTED_LANES,
} from './expected_costs_freeze.ts'

// ── In-memory mock Supabase client ──────────────────────────────────────────

type Row = Record<string, unknown>
type Tables = { jobs: Row[]; scope_revisions: Row[] }

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}
function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

type Filter = { col: string; val: unknown; op: 'eq' | 'is' | 'in' | 'lte' }

class MockChain {
  table: string
  state: Tables
  filters: Filter[] = []
  insertPayload: Row | null = null
  updatePayload: Row | null = null
  orderBy: { col: string; ascending: boolean } | null = null
  limitN: number | null = null
  method: 'select' | 'insert' | 'update' | null = null

  constructor(table: string, state: Tables) {
    this.table = table
    this.state = state
  }

  select(_cols: string) {
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
    this.filters.push({ col, val, op: 'eq' })
    return this
  }
  is(col: string, val: unknown) {
    this.filters.push({ col, val, op: 'is' })
    return this
  }
  in(col: string, val: unknown[]) {
    this.filters.push({ col, val, op: 'in' })
    return this
  }
  lte(col: string, val: unknown) {
    this.filters.push({ col, val, op: 'lte' })
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

  then<TResult1 = any, TResult2 = never>(
    onFulfilled?: ((value: { data: any; error: any }) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this._resolve('array')).then(onFulfilled as any, onRejected as any) as any
  }

  async single() {
    return this._resolve('single')
  }
  async maybeSingle() {
    return this._resolve('maybeSingle')
  }

  private _resolve(kind: 'array' | 'single' | 'maybeSingle'): { data: any; error: any } {
    try {
      if (this.method === 'insert') return this._doInsert(kind)
      if (this.method === 'update') return this._doUpdate(kind)
      return this._doSelect(kind)
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } }
    }
  }

  private _match(r: Row): boolean {
    return this.filters.every((f) => {
      if (f.op === 'is' && f.val === null) return r[f.col] == null
      if (f.op === 'in') return Array.isArray(f.val) && (f.val as unknown[]).includes(r[f.col])
      if (f.op === 'lte') {
        const v = r[f.col]
        // PostgREST semantics: NULL never satisfies <=.
        return v != null && (v as any) <= (f.val as any)
      }
      return r[f.col] === f.val
    })
  }
  private _filterRows(rows: Row[]): Row[] {
    return rows.filter((r) => this._match(r))
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
    const id = (payload.id as string) ?? newId(this.table.slice(0, 3))
    const row: Row = { id, ...payload }
    this.state[this.table as keyof Tables].push(row)
    if (kind === 'single' || kind === 'maybeSingle') return { data: deepCopy(row), error: null }
    return { data: [deepCopy(row)], error: null }
  }

  private _doUpdate(kind: 'array' | 'single' | 'maybeSingle'): { data: any; error: any } {
    const payload = this.updatePayload as Row
    const rows = this._filterRows(this.state[this.table as keyof Tables])
    const updated: Row[] = []
    for (const r of rows) {
      // Emulate trg_jobs_expected_costs_write_once.
      if (this.table === 'jobs') {
        if (r.expected_costs != null
          && 'expected_costs' in payload
          && JSON.stringify(payload.expected_costs) !== JSON.stringify(r.expected_costs)) {
          throw new Error('jobs.expected_costs is write-once')
        }
        if (r.expected_frozen_at != null
          && 'expected_frozen_at' in payload
          && payload.expected_frozen_at !== r.expected_frozen_at) {
          throw new Error('jobs.expected_frozen_at is write-once')
        }
      }
      Object.assign(r, payload)
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
  }
  return {
    from(table: string) {
      if (!(table in state)) throw new Error(`mock client: unknown table ${table}`)
      return new MockChain(table, state)
    },
    _state: state,
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

// Live pricing (drifted numbers).
const LIVE_PRICING = {
  schema: 'fencing.v1',
  labourCostEstimate: 245,
  materialCostEstimate: 544.5,
  commissionCostEstimate: 168.825,
  totalCostEstimate: 958.325,
  margin_pct: 50,
  totalExGST: 1915,
  totalIncGST: 2106.5,
}

// Frozen pricing — deliberately DIFFERENT from live, to prove the baseline pins
// the frozen figures, not the drifted live ones.
const FROZEN_PRICING = {
  schema: 'fencing.v1',
  labourCostEstimate: 200,
  materialCostEstimate: 500,
  commissionCostEstimate: 150,
  totalCostEstimate: 850,
  margin_pct: 48,
  totalExGST: 1800,
  totalIncGST: 1980,
}

const ACCEPTED_AT = '2026-07-05T02:00:00.000Z'
const FROZE_AT = '2026-07-05T02:00:01.000Z'
const BEFORE_ACCEPT = '2026-07-05T01:00:00.000Z' // a freeze that happened pre-acceptance
const AFTER_ACCEPT = '2026-07-05T03:00:00.000Z' // a post-accept edit's freeze

function seedJob(opts: { id?: string; pricing_json?: unknown; accepted_at?: string | null; expected_costs?: unknown; expected_frozen_at?: string | null }): Row {
  return {
    id: opts.id ?? newId('job'),
    pricing_json: opts.pricing_json ?? null,
    accepted_at: opts.accepted_at ?? ACCEPTED_AT,
    expected_costs: opts.expected_costs ?? null,
    expected_frozen_at: opts.expected_frozen_at ?? null,
  }
}

async function seedFrozenRevision(
  job_id: string,
  pricing: unknown,
  opts?: { revision_number?: number; badHash?: boolean; frozen_at?: string; status?: 'frozen' | 'superseded' },
): Promise<Row> {
  const canonical = JSON.stringify(canonicalize(pricing))
  const hash = opts?.badHash
    ? 'deadbeef'.repeat(8) // 64 hex chars but wrong
    : await jsonHash(pricing)
  return {
    id: newId('rev'),
    job_id,
    revision_number: opts?.revision_number ?? 1,
    status: opts?.status ?? 'frozen',
    frozen_at: opts?.frozen_at ?? BEFORE_ACCEPT, // default: frozen before acceptance
    pricing_canonical_text: canonical,
    pricing_hash: hash,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

Deno.test('live_fallback — priced job, no frozen revision → snapshot from pricing_json', async () => {
  const client = makeMockClient({ jobs: [seedJob({ id: 'J1', pricing_json: LIVE_PRICING })] })
  const r = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'J1', now_iso: FROZE_AT })
  assertEquals(r.ok, true)
  if (!r.ok || r.snapshot !== true) throw new Error('expected a snapshot')
  assertEquals(r.confidence, 'live_fallback')
  assertEquals(r.source_ref, 'J1')
  assertEquals(r.scope_revision_id, null)
  assertEquals(r.expected_frozen_at, FROZE_AT)
  assertEquals(r.lanes_written.sort(), ['commission', 'labour', 'materials'])

  const stored = client._state.jobs[0] as any
  assertEquals(stored.expected_frozen_at, FROZE_AT)
  const ec = stored.expected_costs
  assertEquals(ec.version, 1)
  assertEquals(ec.confidence, 'live_fallback')
  assertEquals(ec.source_ref, 'J1')
  assertEquals(ec.scope_revision_id, null)
  assertEquals(ec.pricing_hash, null)
  assertEquals(ec.accepted_at, ACCEPTED_AT)
  // Lanes carry the live figures.
  assertEquals(ec.lanes.labour.amount_ex_gst, 245)
  assertEquals(ec.lanes.materials.amount_ex_gst, 544.5)
  assertEquals(ec.lanes.commission.amount_ex_gst, 168.825)
  assertEquals(ec.totals.total_cost_ex_gst, 958.325)
  assertEquals(ec.totals.margin_pct, 50)
})

Deno.test('frozen_revision preferred over live — baseline pins the frozen figures (drift proof)', async () => {
  const rev = await seedFrozenRevision('J2', FROZEN_PRICING)
  const client = makeMockClient({
    // pricing_json has DRIFTED away from the frozen revision.
    jobs: [seedJob({ id: 'J2', pricing_json: { ...LIVE_PRICING, labourCostEstimate: 999 } })],
    scope_revisions: [rev],
  })
  const r = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'J2', now_iso: FROZE_AT })
  if (!r.ok || r.snapshot !== true) throw new Error('expected a snapshot')
  assertEquals(r.confidence, 'frozen_revision')
  assertEquals(r.source_ref, rev.id)
  assertEquals(r.scope_revision_id, rev.id)

  const ec = (client._state.jobs[0] as any).expected_costs
  assertEquals(ec.confidence, 'frozen_revision')
  assertEquals(ec.pricing_hash, rev.pricing_hash)
  // Frozen figures win — NOT the drifted live labour of 999.
  assertEquals(ec.lanes.labour.amount_ex_gst, 200)
  assertEquals(ec.lanes.materials.amount_ex_gst, 500)
  assertEquals(ec.lanes.commission.amount_ex_gst, 150)
  assertEquals(ec.totals.total_cost_ex_gst, 850)
})

Deno.test('time-correct resolver — a post-accept freeze does NOT re-pin the baseline source (CP2 blocker)', async () => {
  // The revision that was current AT acceptance (frozen before accepted_at).
  // After acceptance the customer edited + re-froze, superseding this one.
  const revAtAccept = await seedFrozenRevision('JT', FROZEN_PRICING, {
    revision_number: 1,
    frozen_at: BEFORE_ACCEPT,
    status: 'superseded', // superseded by the post-accept freeze below
  })
  // The post-accept edit: higher revision_number, frozen AFTER accepted_at, and
  // now the only 'frozen' row. A revision_number-ordered resolver would wrongly
  // pick THIS (labour 777).
  const revPostAccept = await seedFrozenRevision('JT', { ...FROZEN_PRICING, labourCostEstimate: 777 }, {
    revision_number: 2,
    frozen_at: AFTER_ACCEPT,
    status: 'frozen',
  })
  const client = makeMockClient({
    jobs: [seedJob({ id: 'JT', pricing_json: LIVE_PRICING, accepted_at: ACCEPTED_AT })],
    scope_revisions: [revAtAccept, revPostAccept],
  })
  const r = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'JT', now_iso: FROZE_AT })
  if (!r.ok || r.snapshot !== true) throw new Error('expected a snapshot')
  assertEquals(r.confidence, 'frozen_revision')
  // Source is the PRE-accept revision, not the post-accept rev 2.
  assertEquals(r.source_ref, revAtAccept.id)
  assertEquals((client._state.jobs[0] as any).expected_costs.lanes.labour.amount_ex_gst, 200)
})

Deno.test('frozen only AFTER acceptance → live_fallback (no pre-accept frozen scope)', async () => {
  const revPostAccept = await seedFrozenRevision('JT2', FROZEN_PRICING, { frozen_at: AFTER_ACCEPT, status: 'frozen' })
  const client = makeMockClient({
    jobs: [seedJob({ id: 'JT2', pricing_json: LIVE_PRICING, accepted_at: ACCEPTED_AT })],
    scope_revisions: [revPostAccept],
  })
  const r = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'JT2', now_iso: FROZE_AT })
  if (!r.ok || r.snapshot !== true) throw new Error('expected a snapshot')
  // The only frozen revision is post-acceptance, so it can't be the baseline —
  // live pricing is used instead.
  assertEquals(r.confidence, 'live_fallback')
  assertEquals(r.scope_revision_id, null)
})

Deno.test('zero-filled pricing (0/0/0) → suppressed, no fabricated $0 baseline (CP2 major)', async () => {
  const client = makeMockClient({
    jobs: [seedJob({
      id: 'JZ',
      pricing_json: { labourCostEstimate: 0, materialCostEstimate: 0, commissionCostEstimate: 0, totalCostEstimate: 0, margin_pct: 0 },
    })],
  })
  const r = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'JZ', now_iso: FROZE_AT })
  assertEquals(r.ok, true)
  if (!r.ok || r.snapshot !== false) throw new Error('expected suppression')
  assertEquals(r.reason, 'zero_filled_pricing')
  assertEquals((client._state.jobs[0] as any).expected_costs, null)
})

Deno.test('one positive lane among zeros → snapshot still written (not a fabricated placeholder)', async () => {
  const client = makeMockClient({
    jobs: [seedJob({ id: 'JZ2', pricing_json: { labourCostEstimate: 300, materialCostEstimate: 0, commissionCostEstimate: 0 } })],
  })
  const r = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'JZ2', now_iso: FROZE_AT })
  if (!r.ok || r.snapshot !== true) throw new Error('expected a snapshot')
  assertEquals(r.lanes_written.sort(), ['commission', 'labour', 'materials'])
  assertEquals((client._state.jobs[0] as any).expected_costs.lanes.labour.amount_ex_gst, 300)
})

Deno.test('NULL-PRICING RULE — no frozen revision and null pricing → NO snapshot, suppressed', async () => {
  const client = makeMockClient({ jobs: [seedJob({ id: 'J3', pricing_json: null })] })
  const r = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'J3', now_iso: FROZE_AT })
  assertEquals(r.ok, true)
  if (!r.ok || r.snapshot !== false) throw new Error('expected suppression')
  assertEquals(r.reason, 'no_pricing_source')
  // jobs.expected_costs stays null — no fabricated baseline.
  const stored = client._state.jobs[0] as any
  assertEquals(stored.expected_costs, null)
  assertEquals(stored.expected_frozen_at, null)
})

Deno.test('write-once (helper) — second call leaves the baseline intact', async () => {
  const client = makeMockClient({ jobs: [seedJob({ id: 'J4', pricing_json: LIVE_PRICING })] })
  const first = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'J4', now_iso: FROZE_AT })
  if (!first.ok || first.snapshot !== true) throw new Error('first call should snapshot')
  const afterFirst = deepCopy((client._state.jobs[0] as any).expected_costs)

  // Second call — even with a different clock — must not touch the baseline.
  const second = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'J4', now_iso: '2099-01-01T00:00:00.000Z' })
  assertEquals(second.ok, true)
  if (!second.ok || second.snapshot !== false) throw new Error('second call should skip')
  assertEquals(second.reason, 'already_frozen')
  assertEquals((second as any).existing_confidence, 'live_fallback')
  assertEquals((client._state.jobs[0] as any).expected_costs, afterFirst)
  assertEquals((client._state.jobs[0] as any).expected_frozen_at, FROZE_AT)
})

Deno.test('write-once (DB trigger parity) — changing a set baseline throws; other columns still mutate', async () => {
  const client = makeMockClient({ jobs: [seedJob({ id: 'J5', pricing_json: LIVE_PRICING })] })
  await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'J5', now_iso: FROZE_AT })

  // Direct UPDATE that changes the frozen baseline → rejected (trigger parity).
  const bad = await client.from('jobs')
    .update({ expected_costs: { version: 1, tampered: true } })
    .eq('id', 'J5')
    .select('id')
  assertExists(bad.error)
  assert(String(bad.error.message).includes('write-once'))

  // Direct UPDATE that touches only pricing_json (the live mirror) → allowed.
  const ok = await client.from('jobs')
    .update({ pricing_json: { ...LIVE_PRICING, labourCostEstimate: 1 } })
    .eq('id', 'J5')
    .select('id')
  assertEquals(ok.error, null)
  // Baseline labour is still the frozen 245, not the new live 1.
  assertEquals((client._state.jobs[0] as any).expected_costs.lanes.labour.amount_ex_gst, 245)
})

Deno.test('frozen hash mismatch — falls back to live pricing', async () => {
  const rev = await seedFrozenRevision('J6', FROZEN_PRICING, { badHash: true })
  const client = makeMockClient({
    jobs: [seedJob({ id: 'J6', pricing_json: LIVE_PRICING })],
    scope_revisions: [rev],
  })
  const r = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'J6', now_iso: FROZE_AT })
  if (!r.ok || r.snapshot !== true) throw new Error('expected a snapshot')
  // Tampered frozen row is not trusted; live fallback used instead.
  assertEquals(r.confidence, 'live_fallback')
  assertEquals(r.scope_revision_id, null)
  assertEquals((client._state.jobs[0] as any).expected_costs.lanes.labour.amount_ex_gst, 245)
})

Deno.test('frozen hash mismatch AND no live pricing → suppressed', async () => {
  const rev = await seedFrozenRevision('J7', FROZEN_PRICING, { badHash: true })
  const client = makeMockClient({
    jobs: [seedJob({ id: 'J7', pricing_json: null })],
    scope_revisions: [rev],
  })
  const r = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'J7', now_iso: FROZE_AT })
  assertEquals(r.ok, true)
  if (!r.ok || r.snapshot !== false) throw new Error('expected suppression')
  assertEquals(r.reason, 'frozen_hash_mismatch_no_live')
  assertEquals((client._state.jobs[0] as any).expected_costs, null)
})

Deno.test('no cost lanes — pricing object without cost keys → suppressed (no fabricated $0)', async () => {
  const client = makeMockClient({ jobs: [seedJob({ id: 'J8', pricing_json: { schema: 'fencing.v1', totalIncGST: 5000 } })] })
  const r = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'J8', now_iso: FROZE_AT })
  assertEquals(r.ok, true)
  if (!r.ok || r.snapshot !== false) throw new Error('expected suppression')
  assertEquals(r.reason, 'no_cost_lanes')
  assertEquals((client._state.jobs[0] as any).expected_costs, null)
})

Deno.test('partial lanes — missing commission is suppressed, present lanes written', async () => {
  const client = makeMockClient({
    jobs: [seedJob({ id: 'J9', pricing_json: { labourCostEstimate: 300, materialCostEstimate: 700, totalCostEstimate: 1000 } })],
  })
  const r = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'J9', now_iso: FROZE_AT })
  if (!r.ok || r.snapshot !== true) throw new Error('expected a snapshot')
  assertEquals(r.lanes_written.sort(), ['labour', 'materials'])
  const ec = (client._state.jobs[0] as any).expected_costs
  assertEquals(ec.lanes.labour.amount_ex_gst, 300)
  assertEquals(ec.lanes.materials.amount_ex_gst, 700)
  assertEquals(ec.lanes.commission, undefined) // suppressed
  assertEquals(ec.totals.margin_pct, null)
})

Deno.test('job not found → structured error', async () => {
  const client = makeMockClient()
  const r = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'missing', now_iso: FROZE_AT })
  assertEquals(r.ok, false)
  if (r.ok) return
  assertEquals(r.error.code, 'job_not_found')
})

Deno.test('lane enum is exactly the three cost lanes', () => {
  assertEquals([...EXPECTED_LANES].sort(), ['commission', 'labour', 'materials'])
})
