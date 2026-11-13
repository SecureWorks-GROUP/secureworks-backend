// The acceptance writer of the job budget, against an in-memory client: what it
// reads (only the bound accepted revision, re-hashed), what it stores (the
// options formula applied, matched to the accepted totals), and what it does
// when a budget does not add up (a refusal event carrying no money).

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { canonicalize, jsonHash } from '../release_packet/canonicalize.ts'
import { recordJobBudgetOnAcceptance } from './record_job_budget.ts'
import { EXPECTED, patioBase } from './budget_examples.ts'
import native from './fixtures/native-budgets.json' with { type: 'json' }

type Row = Record<string, unknown>
type State = Record<string, Row[]>
type Filter = { col: string; val: unknown; op: 'eq' | 'in' | 'lte' | 'not_is' }

class Chain {
  filters: Filter[] = []
  wantsCount = false
  payload: Row | null = null
  constructor(private table: string, private state: State) {}
  select(_c: string, o?: { count?: string }) { this.wantsCount = o?.count === 'exact'; return this }
  insert(p: Row) { this.payload = p; return this }
  eq(col: string, val: unknown) { this.filters.push({ col, val, op: 'eq' }); return this }
  in(col: string, val: unknown[]) { this.filters.push({ col, val, op: 'in' }); return this }
  lte(col: string, val: unknown) { this.filters.push({ col, val, op: 'lte' }); return this }
  not(col: string, _op: string, val: unknown) { this.filters.push({ col, val, op: 'not_is' }); return this }
  private rows(): Row[] {
    return (this.state[this.table] ?? []).filter((r) => this.filters.every((f) => {
      if (f.op === 'in') return (f.val as unknown[]).includes(r[f.col])
      if (f.op === 'not_is') return r[f.col] != null
      // deno-lint-ignore no-explicit-any
      if (f.op === 'lte') return r[f.col] != null && (r[f.col] as any) <= (f.val as any)
      return r[f.col] === f.val
    }))
  }
  maybeSingle() {
    const r = this.rows()
    return Promise.resolve(r.length > 1 ? { data: null, error: { message: 'multiple' } } : { data: r[0] ?? null, error: null })
  }
  // deno-lint-ignore no-explicit-any
  then(ok: any, bad: any) {
    if (this.payload) {
      ;(this.state[this.table] ??= []).push(structuredClone(this.payload))
      return Promise.resolve({ data: null, error: null }).then(ok, bad)
    }
    const r = this.rows()
    return Promise.resolve({ data: structuredClone(r), error: null, ...(this.wantsCount ? { count: r.length } : {}) }).then(ok, bad)
  }
}

const J = '33333333-3333-4333-8333-333333333333'
const D = '44444444-4444-4444-8444-444444444444'
const REV = '11111111-1111-4111-8111-111111111111'

async function fixture(pricing: Row, opts: { taken?: string[]; acceptedEx?: number; variation?: boolean; tamper?: boolean } = {}) {
  const scope = { s: 1 }
  const state: State = {
    jobs: [{ id: J, accepted_at: '2026-11-13T10:00:00.000Z' }],
    job_documents: [{ id: D, job_id: J, type: 'quote', accepted_at: '2026-11-13T10:00:00.000Z', superseded_at: null }],
    run_acceptances: [],
    job_variations: opts.variation ? [{ job_id: J, status: 'accepted', accepted_at: '2026-11-13T10:00:00.000Z' }] : [],
    quote_revisions: [{ job_id: J, job_document_id: D, scope_revision_id: REV, sent_at: '2026-11-13T09:30:00.000Z' }],
    scope_revisions: [{
      id: REV, job_id: J, status: 'frozen', frozen_at: '2026-11-13T09:00:00.000Z',
      pricing_canonical_text: JSON.stringify(canonicalize(pricing)),
      pricing_hash: opts.tamper ? 'f'.repeat(64) : await jsonHash(pricing),
      scope_canonical_text: JSON.stringify(canonicalize(scope)), scope_hash: await jsonHash(scope),
    }],
    quote_option_acceptances: opts.taken
      ? [{
        job_id: J, job_document_id: D, taken_option_ids: opts.taken,
        taken_options: opts.taken.map((id) => ({ id, name: id, goes: 'supplier' })),
        accepted_total_ex_gst: opts.acceptedEx ?? 0, accepted_gst: (opts.acceptedEx ?? 0) / 10,
        accepted_total_inc_gst: (opts.acceptedEx ?? 0) * 1.1,
      }]
      : [],
    job_events: [],
  }
  const rpcCalls: Row[] = []
  let rpcAnswer: { data: unknown; error: unknown } = { data: { recorded: true, replayed: false, budget_id: 'b-1', version: 1 }, error: null }
  const client = {
    from: (t: string) => new Chain(t, state),
    rpc: (name: string, args: Row) => { rpcCalls.push({ name, ...args }); return Promise.resolve(rpcAnswer) },
  }
  return { state, client, rpcCalls, setRpc: (a: typeof rpcAnswer) => { rpcAnswer = a } }
}

Deno.test('a bound accepted revision with a budget is stored as given, nothing taken', async () => {
  const f = await fixture({ total: 11000, budget: patioBase() })
  const r = await recordJobBudgetOnAcceptance(f.client, J)
  assertEquals(r.outcome, 'recorded')
  assertEquals(f.rpcCalls.length, 1)
  const call = f.rpcCalls[0]
  assertEquals(call.name, 'record_job_budget')
  assertEquals(call.p_scope_revision_id, REV)
  assertEquals(call.p_taken_option_ids, [])
  const s = call.p_summary as Row
  assertEquals([s.sell_ex_gst, s.gst, s.total_inc_gst, s.commission_ex_gst, s.profit_after_commission_ex_gst], [10000, 1000, 11000, 278.8, 3206.2])
  assertEquals((call.p_lines as Row[]).map((l) => [l.key, l.kind ?? null]), [['m1', 'item'], ['m2', 'item'], ['sup-a:delivery', 'delivery'], ['l1', null], ['x1', null], ['b1', null]])
  assertEquals('taken_option_ids' in (call.p_budget as Row), false, 'nothing taken: the base as sealed')
  assertEquals(f.state.job_events.length, 0)
})

Deno.test('the exact native budgets of both trades are stored, a local seal\'s null revision id included', async () => {
  for (const [name, budget] of Object.entries(native.budgets)) {
    const f = await fixture({ total: 1, budget })
    const r = await recordJobBudgetOnAcceptance(f.client, J)
    assertEquals(r.outcome, 'recorded', `${name}: ${JSON.stringify(r)}`)
    assertEquals(f.rpcCalls.length, 1, name)
    assertEquals(f.state.job_events.length, 0, name)
  }
  // The one-figure aggregate keeps its sealed supplier_key; its riding order lines keep theirs.
  const f = await fixture({ budget: native.budgets.patio_one_figure })
  await recordJobBudgetOnAcceptance(f.client, J)
  const lines = f.rpcCalls[0].p_lines as Row[]
  assertEquals(lines.filter((l) => l.in_total && l.lane === 'materials').map((l) => [l.supplier_key, l.cost_from]), [['one_figure', 'one_figure']])
})

Deno.test('a taken option is added by the formula and must equal the accepted totals', async () => {
  const f = await fixture({ budget: patioBase() }, { taken: ['o1'], acceptedEx: EXPECTED.A.sell })
  const r = await recordJobBudgetOnAcceptance(f.client, J)
  assertEquals(r.outcome, 'recorded')
  const s = f.rpcCalls[0].p_summary as Row
  assertEquals([s.sell_ex_gst, s.cost_before_commission_ex_gst, s.commission_ex_gst], [EXPECTED.A.sell, EXPECTED.A.cost, EXPECTED.A.com])
  assertEquals(f.rpcCalls[0].p_taken_option_ids, ['o1'])
  assertEquals((f.rpcCalls[0].p_budget as Row).taken_option_ids, ['o1'], 'kept on the applied budget too (section 5 step 4)')
  assert((f.rpcCalls[0].p_lines as Row[]).some((l) => l.key === 'option:o1' && l.cost_ex_gst === 180))
})

Deno.test('a budget whose sell is not what the customer accepted is refused, acceptance untouched', async () => {
  const f = await fixture({ budget: patioBase() }, { taken: ['o1'], acceptedEx: 10399 })
  const r = await recordJobBudgetOnAcceptance(f.client, J)
  assertEquals(r.outcome, 'refused')
  assertEquals(f.rpcCalls.length, 0)
  assertEquals(f.state.job_events.length, 1)
  assertEquals(f.state.job_events[0].event_type, 'job_budget_refused')
  assertEquals((f.state.job_events[0].detail_json as Row).code, 'option_sell_mismatch')
  assertEquals(f.state.jobs[0].accepted_at, '2026-11-13T10:00:00.000Z')
})

Deno.test('a budget that does not add up is refused by code; the event carries no money', async () => {
  const bad = patioBase()
  ;(bad.job as Row).gst = 1001
  const f = await fixture({ budget: bad })
  const r = await recordJobBudgetOnAcceptance(f.client, J)
  assertEquals(r.outcome, 'refused')
  assertEquals(f.rpcCalls.length, 0)
  const detail = f.state.job_events[0].detail_json as Row
  assertEquals(detail.code, 'gst_mismatch')
  assertEquals(Object.keys(detail).every((k) => ['code', 'at', 'scope_revision_id'].includes(k)), true)
  const text = JSON.stringify(f.state.job_events)
  for (const money of ['278.8', '10000', '1001', '3165']) assert(!text.includes(money), `event carries ${money}`)
})

Deno.test('no budget key: nothing stored and no event (today\'s path)', async () => {
  const f = await fixture({ total: 11000 })
  const r = await recordJobBudgetOnAcceptance(f.client, J)
  assertEquals(r, { outcome: 'skipped', reason: 'no_budget' })
  assertEquals(f.rpcCalls.length + f.state.job_events.length, 0)
})

Deno.test('an accepted variation means no budget (B11)', async () => {
  const f = await fixture({ budget: patioBase() }, { variation: true })
  const r = await recordJobBudgetOnAcceptance(f.client, J)
  assertEquals(r.outcome, 'skipped')
  assertEquals(f.rpcCalls.length + f.state.job_events.length, 0)
})

Deno.test('a budget on a revision whose pricing does not match its hash is refused', async () => {
  const f = await fixture({ budget: patioBase() }, { tamper: true })
  const r = await recordJobBudgetOnAcceptance(f.client, J)
  assertEquals(r.outcome, 'refused')
  assertEquals((f.state.job_events[0].detail_json as Row).code, 'pricing_hash_mismatch')
  assertEquals(f.rpcCalls.length, 0)
})

Deno.test('a budget naming another revision is refused', async () => {
  const b = patioBase()
  ;(b.job as Row).scope_revision_id = '55555555-5555-4555-8555-555555555555'
  const f = await fixture({ budget: b })
  const r = await recordJobBudgetOnAcceptance(f.client, J)
  assertEquals(r.outcome, 'refused')
  assertEquals((f.state.job_events[0].detail_json as Row).code, 'budget_revision_mismatch')
})

Deno.test('before the migration is applied: nothing stored, no event', async () => {
  const f = await fixture({ budget: patioBase() })
  f.setRpc({ data: null, error: { code: 'PGRST202', message: 'not found' } })
  const r = await recordJobBudgetOnAcceptance(f.client, J)
  assertEquals(r, { outcome: 'skipped', reason: 'store_missing' })
  assertEquals(f.state.job_events.length, 0)
})

Deno.test('a write that fails is a refusal event, a conflict is named', async () => {
  const f = await fixture({ budget: patioBase() })
  f.setRpc({ data: null, error: { code: 'P0001', message: 'job_budget_conflict' } })
  const r = await recordJobBudgetOnAcceptance(f.client, J)
  assertEquals(r.outcome, 'refused')
  assertEquals((f.state.job_events[0].detail_json as Row).code, 'budget_conflict')
})
