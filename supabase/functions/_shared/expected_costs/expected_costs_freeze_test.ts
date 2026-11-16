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
type Tables = { jobs: Row[]; scope_revisions: Row[]; job_documents: Row[]; run_acceptances: Row[]; quote_revisions: Row[]; job_variations: Row[]; quote_option_acceptances: Row[] }

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}
function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

type Filter = { col: string; val: unknown; op: 'eq' | 'is' | 'in' | 'lte' | 'not_is' }

class MockChain {
  table: string
  state: Tables
  filters: Filter[] = []
  insertPayload: Row | null = null
  updatePayload: Row | null = null
  orderBy: { col: string; ascending: boolean } | null = null
  limitN: number | null = null
  method: 'select' | 'insert' | 'update' | null = null
  wantsCount = false

  constructor(table: string, state: Tables) {
    this.table = table
    this.state = state
  }

  select(_cols: string, options?: { count?: string }) {
    if (this.method == null) this.method = 'select'
    this.wantsCount = options?.count === 'exact'
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
  not(col: string, op: string, val: unknown) {
    if (op !== 'is') throw new Error('unsupported fixture filter')
    this.filters.push({ col, val, op: 'not_is' })
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
      if (f.op === 'not_is' && f.val === null) return r[f.col] != null
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

  private _doSelect(kind: 'array' | 'single' | 'maybeSingle'): { data: any; error: any; count?: number } {
    let rows = this._filterRows(this.state[this.table as keyof Tables])
    const count = rows.length
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
    return { data: rows.map(deepCopy), error: null, ...(this.wantsCount ? { count } : {}) }
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
    job_documents: deepCopy(seed?.job_documents ?? []),
    run_acceptances: deepCopy(seed?.run_acceptances ?? []),
    quote_revisions: deepCopy(seed?.quote_revisions ?? []),
    job_variations: deepCopy(seed?.job_variations ?? []),
    quote_option_acceptances: deepCopy(seed?.quote_option_acceptances ?? []),
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


// D1 / JP-24 source identity: the accepted release names A even when B was
// frozen more recently, or has identical prices but a different scope.
async function acceptedFixture() {
  const a = await seedFrozenRevision('accepted-job', FROZEN_PRICING, { status: 'superseded' })
  const b = await seedFrozenRevision('accepted-job', LIVE_PRICING, { frozen_at: '2026-07-05T01:30:00.000Z' })
  const scope = { lines: [{ id: 'material-1' }, { id: 'labour-1' }] }
  Object.assign(a, { scope_canonical_text: JSON.stringify(scope), scope_hash: await jsonHash(scope) })
  Object.assign(b, { scope_canonical_text: JSON.stringify(scope), scope_hash: await jsonHash(scope) })
  const client = makeMockClient({
    jobs: [seedJob({ id: 'accepted-job', pricing_json: LIVE_PRICING })],
    scope_revisions: [a, b],
    job_documents: [{ id: 'accepted-doc', job_id: 'accepted-job', type: 'quote', accepted_at: ACCEPTED_AT }],
    quote_revisions: [{ job_id: 'accepted-job', job_document_id: 'accepted-doc', scope_revision_id: a.id, sent_at: BEFORE_ACCEPT }],
  })
  return { client, a, b }
}
const quoteInput = { job_id: 'accepted-job', now_iso: FROZE_AT, quote_acceptance: true }

Deno.test('declared accepted A wins over newer B, duplicate releases and retry preserve A', async () => {
  const { client, a } = await acceptedFixture()
  client._state.quote_revisions.push(deepCopy(client._state.quote_revisions[0]))
  const result = await freezeExpectedCostsOnAcceptance(client, quoteInput)
  assert(result.ok && result.snapshot)
  assertEquals(result.scope_revision_id, a.id)
  const baseline = deepCopy(client._state.jobs[0].expected_costs) as any
  assertEquals(baseline.lanes.materials.amount_ex_gst, 500)
  assertEquals(baseline.lanes.labour.amount_ex_gst, 200)
  assertEquals(baseline.lanes.commission.amount_ex_gst, 150)
  assertEquals(await freezeExpectedCostsOnAcceptance(client, quoteInput), {
    ok: true, snapshot: false, reason: 'already_frozen', existing_confidence: 'frozen_revision',
  })
  assertEquals(client._state.jobs[0].expected_costs, baseline)
})

Deno.test('equal-price different-scope revision cannot replace the accepted row identity', async () => {
  const { client, a } = await acceptedFixture()
  const b = client._state.scope_revisions[1]
  b.pricing_canonical_text = a.pricing_canonical_text
  b.pricing_hash = a.pricing_hash
  b.scope_canonical_text = JSON.stringify({ lines: [{ id: 'other-line' }] })
  b.scope_hash = await jsonHash(JSON.parse(b.scope_canonical_text as string))
  const result = await freezeExpectedCostsOnAcceptance(client, quoteInput)
  assert(result.ok && result.snapshot)
  assertEquals(result.scope_revision_id, a.id)
})

Deno.test('all accepted parties bound to A retain the same whole-job baseline, never multiply shares', async () => {
  const { client, a } = await acceptedFixture()
  client._state.job_documents.push({ id: 'neighbour-doc', job_id: 'accepted-job', type: 'quote', accepted_at: ACCEPTED_AT })
  client._state.quote_revisions.push({ job_id: 'accepted-job', job_document_id: 'neighbour-doc', scope_revision_id: a.id, sent_at: BEFORE_ACCEPT })
  client._state.run_acceptances.push({ job_id: 'accepted-job', job_document_id: 'neighbour-doc', status: 'accepted' })
  const result = await freezeExpectedCostsOnAcceptance(client, quoteInput)
  assert(result.ok && result.snapshot)
  assertEquals((client._state.jobs[0].expected_costs as any).lanes.materials.amount_ex_gst, 500)
})

for (const [name, mutate] of Object.entries<(s: Tables) => void>({
  'mixed bound and unbound releases': s => { s.quote_revisions.push({ ...s.quote_revisions[0], scope_revision_id: null }) },
  'different named revisions': s => { s.quote_revisions.push({ ...s.quote_revisions[0], scope_revision_id: s.scope_revisions[1].id }) },
  'accepted party missing its release': s => { s.job_documents.push({ id: 'other-doc', job_id: 'accepted-job', type: 'quote', accepted_at: ACCEPTED_AT }) },
  'run accepted without document identity': s => { s.run_acceptances.push({ job_id: 'accepted-job', status: 'accepted', job_document_id: null }) },
  'party not accepted': s => { s.run_acceptances.push({ job_id: 'accepted-job', status: 'pending', job_document_id: 'pending-doc' }) },
  'accepted variation': s => { s.job_variations.push({ job_id: 'accepted-job', accepted_at: ACCEPTED_AT, status: 'accepted' }) },
  'invoiced variation': s => { s.job_variations.push({ job_id: 'accepted-job', accepted_at: null, status: 'invoiced' }) },
  'wrong job revision': s => { s.scope_revisions[0].job_id = 'another-job' },
  'missing named revision': s => { s.scope_revisions.shift() },
  'post-accept revision': s => { s.scope_revisions[0].frozen_at = AFTER_ACCEPT },
  'draft revision': s => { s.scope_revisions[0].status = 'draft' },
  'tampered scope': s => { s.scope_revisions[0].scope_canonical_text = '{"lines":[]}' },
  'tampered pricing': s => { s.scope_revisions[0].pricing_hash = '0'.repeat(64) },
  'unparseable pricing': s => { s.scope_revisions[0].pricing_canonical_text = 'broken' },
  'no accepted document': s => { s.job_documents[0].accepted_at = null },
  'no job acceptance': s => { s.jobs[0].accepted_at = null },
})) {
  Deno.test(`declared quote source ${name}: no guessed baseline and no live fallback`, async () => {
    const { client } = await acceptedFixture()
    mutate(client._state)
    const result = await freezeExpectedCostsOnAcceptance(client, quoteInput)
    assert(result.ok && !result.snapshot)
    assertEquals(result.reason, 'accepted_quote_source_unproven')
    assertEquals(client._state.jobs[0].expected_costs, null)
    assertEquals(client._state.jobs[0].expected_frozen_at, null)
  })
}

Deno.test('legacy quotes with no declared binding retain CP1 time resolver and do not claim binding', async () => {
  const { client, b } = await acceptedFixture()
  client._state.quote_revisions[0].scope_revision_id = null
  const result = await freezeExpectedCostsOnAcceptance(client, quoteInput)
  assert(result.ok && result.snapshot)
  assertEquals(result.scope_revision_id, b.id)
})

for (const table of ['job_documents', 'run_acceptances', 'job_variations', 'quote_revisions', 'scope_revisions']) {
  for (const fault of ['failed', ...(table === 'scope_revisions' ? [] : ['truncated', 'missing-count'])]) {
    Deno.test(`${table} ${fault}: declared quote read cannot freeze a partial or failed source`, async () => {
      const { client } = await acceptedFixture()
      const from = client.from.bind(client)
      client.from = (name: string) => {
        if (name !== table) return from(name)
        const result = fault === 'failed' ? { data: null, error: { message: 'planted read failure' } }
          : { data: [], error: null, ...(fault === 'truncated' ? { count: 2 } : {}) }
        const q: any = new Proxy({}, { get: (_t, key) => key === 'then'
          ? (resolve: any) => Promise.resolve(result).then(resolve)
          : () => q })
        return q
      }
      const result = await freezeExpectedCostsOnAcceptance(client, quoteInput)
      assert(!result.ok || !result.snapshot)
      assertEquals(client._state.jobs[0].expected_costs, null)
    })
  }
}

// ── Ruling 14 step 1: taken quote options join the baseline ──────────────────

// The job's option record, as accept_quote_document_with_options writes it: the
// taken options exactly as sealed, on the client's current accepted quote.
const sealedOption = (id: string, cost: number | null, kind: string) => ({ id, name: id, goes: 'supplier', cost_ex_gst: cost, cost_kind: kind })
function optionRecord(jobId: string, docId: string, taken: Array<Record<string, unknown>>): Row {
  return { id: newId('qoa'), job_id: jobId, job_document_id: docId, taken_option_ids: taken.map((o) => o.id), taken_options: taken }
}

Deno.test('R14 taken options: each cost joins its lane and the total; margin is withheld', async () => {
  const taken = [sealedOption('lights', 180, 'materials'), sealedOption('gutter', 600, 'labour'),
    sealedOption('permit', 50, 'other'), sealedOption('blank', null, 'materials')]
  const client = makeMockClient({
    jobs: [seedJob({ id: 'JO1', pricing_json: LIVE_PRICING })],
    job_documents: [{ id: 'D1', job_id: 'JO1', type: 'quote', superseded_at: null }],
    quote_option_acceptances: [optionRecord('JO1', 'D1', taken)],
  })
  const r = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'JO1', now_iso: FROZE_AT })
  assert(r.ok && r.snapshot === true)
  const ec = (client._state.jobs[0] as any).expected_costs
  assertEquals(ec.lanes.materials.amount_ex_gst, 724.5)
  assertEquals(ec.lanes.labour.amount_ex_gst, 845)
  assertEquals(ec.lanes.commission.amount_ex_gst, 168.825, 'commission is never moved by an option')
  assertEquals(ec.totals.total_cost_ex_gst, 1788.33, 'other costs only reach the total')
  assertEquals(ec.totals.margin_pct, null, 'the tool margin is for the base price')
  assertEquals(ec.quote_options, {
    taken_option_ids: ['lights', 'gutter', 'permit', 'blank'],
    added_cost_ex_gst: 830,
    cost_unknown_option_ids: ['blank'],
  })
})

Deno.test('R14 no taken options: the baseline is exactly as before', async () => {
  const a = makeMockClient({ jobs: [seedJob({ id: 'JO2', pricing_json: LIVE_PRICING })] })
  const b = makeMockClient({
    jobs: [seedJob({ id: 'JO2', pricing_json: LIVE_PRICING })],
    job_documents: [{ id: 'D2', job_id: 'JO2', type: 'quote', superseded_at: null }],
    quote_option_acceptances: [optionRecord('JO2', 'D2', [])],
  })
  await freezeExpectedCostsOnAcceptance(a as any, { job_id: 'JO2', now_iso: FROZE_AT })
  await freezeExpectedCostsOnAcceptance(b as any, { job_id: 'JO2', now_iso: FROZE_AT })
  assertEquals((a._state.jobs[0] as any).expected_costs, (b._state.jobs[0] as any).expected_costs)
  assertEquals('quote_options' in (a._state.jobs[0] as any).expected_costs, false)
})

// Shared fence: the client takes an option, a neighbour accepts last with
// none. The baseline is read from the record, so the order never matters and a
// retry keeps the same baseline.
Deno.test('R14 shared acceptance: either order freezes the client\'s option, and a retry keeps it', async () => {
  const base = () => makeMockClient({
    jobs: [seedJob({ id: 'JS', pricing_json: LIVE_PRICING })],
    job_documents: [{ id: 'DC', job_id: 'JS', type: 'quote', superseded_at: null }, { id: 'DN', job_id: 'JS', type: 'quote', superseded_at: null }],
    quote_option_acceptances: [optionRecord('JS', 'DC', [sealedOption('lights', 180, 'materials')])],
  })
  // Client last or neighbour last: the request carries no options either way.
  const first = base(), second = base()
  await freezeExpectedCostsOnAcceptance(first as any, { job_id: 'JS', now_iso: FROZE_AT })
  await freezeExpectedCostsOnAcceptance(second as any, { job_id: 'JS', now_iso: FROZE_AT })
  const ec = (first._state.jobs[0] as any).expected_costs
  assertEquals(ec.lanes.materials.amount_ex_gst, 724.5)
  assertEquals(ec, (second._state.jobs[0] as any).expected_costs)
  const retry = await freezeExpectedCostsOnAcceptance(first as any, { job_id: 'JS', now_iso: AFTER_ACCEPT })
  assertEquals(retry, { ok: true, snapshot: false, reason: 'already_frozen', existing_confidence: 'live_fallback' })
  assertEquals((first._state.jobs[0] as any).expected_costs, ec)
})

Deno.test('R14 a record on a superseded quote never reaches the baseline; an unreadable record writes nothing', async () => {
  const superseded = makeMockClient({
    jobs: [seedJob({ id: 'JR', pricing_json: LIVE_PRICING })],
    job_documents: [{ id: 'OLD', job_id: 'JR', type: 'quote', superseded_at: '2026-07-04T00:00:00Z' }],
    quote_option_acceptances: [optionRecord('JR', 'OLD', [sealedOption('lights', 180, 'materials')])],
  })
  await freezeExpectedCostsOnAcceptance(superseded as any, { job_id: 'JR', now_iso: FROZE_AT })
  assertEquals((superseded._state.jobs[0] as any).expected_costs.lanes.materials.amount_ex_gst, 544.5)
  const broken = makeMockClient({ jobs: [seedJob({ id: 'JU', pricing_json: LIVE_PRICING })] })
  const from = broken.from.bind(broken)
  ;(broken as any).from = (t: string) => t === 'quote_option_acceptances'
    ? { select: () => ({ eq: () => Promise.resolve({ data: null, error: { code: '57014' } }) }) }
    : from(t)
  const r = await freezeExpectedCostsOnAcceptance(broken as any, { job_id: 'JU', now_iso: FROZE_AT })
  assertEquals(r, { ok: true, snapshot: false, reason: 'quote_options_unreadable' })
  assertEquals((broken._state.jobs[0] as any).expected_costs, null)
})

Deno.test('R14 options never make a baseline out of pricing with no cost lanes', async () => {
  const client = makeMockClient({ jobs: [seedJob({ id: 'JO3', pricing_json: { totalExGST: 100 } })] })
  const r = await freezeExpectedCostsOnAcceptance(client as any, { job_id: 'JO3', now_iso: FROZE_AT })
  assertEquals(r, { ok: true, snapshot: false, reason: 'no_cost_lanes' })
})
