// deno-lint-ignore-file no-explicit-any no-import-prefix
// Ruling 14 step 1: the reader of taken quote options, and the scope draft
// release it holds.
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { readTakenQuoteOptions } from './taken_options.ts'
import { releaseScopeJobDraftsOnAcceptance } from '../scope_freeze/release_scope_job_drafts.ts'

type Result = { data?: unknown; error?: unknown }
function fakeClient(tables: Record<string, Result>, log: { inserts: Array<[string, any]>; rpc: number }) {
  return {
    from(table: string) {
      const q: any = {}
      for (const m of ['select', 'eq', 'in', 'not', 'is', 'order', 'limit']) q[m] = () => q
      q.maybeSingle = () => Promise.resolve(tables[table] ?? { data: null, error: null })
      q.single = q.maybeSingle
      q.insert = (row: unknown) => { log.inserts.push([table, row]); return Promise.resolve({ error: null }) }
      q.then = (ok: (r: Result) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve(tables[table] ?? { data: [], error: null }).then(ok, bad)
      return q
    },
    rpc() { log.rpc++; return Promise.resolve({ data: { released: true }, error: null }) },
  }
}

const RECORD = {
  offered: [{ id: 'lights', name: 'Two downlights', goes: 'supplier' }, { id: 'gutter', name: 'Extra gutter', goes: 'crew' }],
  taken_option_ids: ['gutter'],
}

Deno.test('R14 reader: taken, none, unreadable, and a table not yet created', async () => {
  const log = { inserts: [], rpc: 0 }
  assertEquals(await readTakenQuoteOptions(fakeClient({ quote_option_acceptances: { data: [RECORD], error: null } }, log), 'j'),
    { state: 'taken', options: [{ id: 'gutter', name: 'Extra gutter', goes: 'crew' }] })
  assertEquals(await readTakenQuoteOptions(fakeClient({ quote_option_acceptances: { data: [{ ...RECORD, taken_option_ids: [] }], error: null } }, log), 'j'),
    { state: 'none' })
  assertEquals(await readTakenQuoteOptions(fakeClient({ quote_option_acceptances: { data: [], error: null } }, log), 'j'), { state: 'none' })
  assertEquals(await readTakenQuoteOptions(fakeClient({ quote_option_acceptances: { data: null, error: { code: '57014' } } }, log), 'j'),
    { state: 'unreadable' })
  assertEquals(await readTakenQuoteOptions(fakeClient({ quote_option_acceptances: { data: null, error: { code: 'PGRST205' } } }, log), 'j'),
    { state: 'none' })
})

const DRAFT = { scope_job_draft_sets: { data: { scope_revision_id: 'rev-1', released_at: null }, error: null } }

Deno.test('R14 release: a job with a taken option holds its base-price drafts for the office', async () => {
  const log = { inserts: [] as Array<[string, any]>, rpc: 0 }
  const out = await releaseScopeJobDraftsOnAcceptance(
    fakeClient({ ...DRAFT, quote_option_acceptances: { data: [RECORD], error: null } }, log), 'j')
  assertEquals(out, { state: 'held_for_quote_options', reason: 'quote_options_taken' })
  assertEquals(log.rpc, 0, 'nothing released')
  assertEquals(log.inserts, [['job_events', {
    job_id: 'j', event_type: 'scope_job_draft_release_held',
    detail_json: { reason: 'quote_options_taken', taken_option_ids: ['gutter'] },
  }]])
})

Deno.test('R14 release: an unreadable option record holds too', async () => {
  const log = { inserts: [] as Array<[string, any]>, rpc: 0 }
  const out = await releaseScopeJobDraftsOnAcceptance(
    fakeClient({ ...DRAFT, quote_option_acceptances: { data: null, error: { code: '57014' } } }, log), 'j')
  assertEquals(out, { state: 'held_for_quote_options', reason: 'quote_options_unreadable' })
  assertEquals(log.rpc, 0)
})

Deno.test('R14 release: no option taken goes on to the release exactly as before', async () => {
  const log = { inserts: [] as Array<[string, any]>, rpc: 0 }
  const out = await releaseScopeJobDraftsOnAcceptance(
    fakeClient({
      ...DRAFT,
      quote_option_acceptances: { data: [], error: null },
      job_documents: { data: [], error: null, count: 0 } as Result,
      run_acceptances: { data: [], error: null, count: 0 } as Result,
      job_variations: { data: [], error: null, count: 0 } as Result,
      jobs: { data: { expected_costs: null }, error: null },
    }, log), 'j')
  assertEquals(out, { state: 'released' })
  assertEquals(log.rpc, 1)
})

import { readJobQuoteOptionRecords } from './taken_options.ts'

Deno.test('R14 the job record lists every offered option, taken or "offered, not taken"', async () => {
  const log = { inserts: [] as Array<[string, any]>, rpc: 0 }
  const rows = await readJobQuoteOptionRecords(fakeClient({ quote_option_acceptances: { data: [{
    job_document_id: 'd1', accepted_via: 'staff_phone', accepted_by: 's1',
    offered: [{ id: 'lights', name: 'Two downlights', line: 'LED', sell_inc_gst: 440 }, { id: 'gutter', name: 'Extra gutter', line: '', sell_inc_gst: 1100 }],
    taken_option_ids: ['gutter'], base_total_inc_gst: '11000.00', accepted_total_inc_gst: '12100.00', accepted_deposit_inc_gst: '6050.00',
    created_at: '2026-11-13T00:00:00Z',
  }], error: null } }, log), 'j')
  assertEquals(rows?.[0].options.map((o) => [o.id, o.label]), [['lights', 'offered, not taken'], ['gutter', 'taken']])
  assertEquals(rows?.[0].accepted_total_inc_gst, 12100)
  assertEquals(await readJobQuoteOptionRecords(fakeClient({ quote_option_acceptances: { data: null, error: { code: 'x' } } }, log), 'j'), null)
  assertEquals(await readJobQuoteOptionRecords(fakeClient({ quote_option_acceptances: { data: null, error: { code: '42P01' } } }, log), 'j'), [])
})
