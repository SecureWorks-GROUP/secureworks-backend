// deno-lint-ignore-file no-explicit-any no-import-prefix
// Ruling 14 step 1: the reader of taken quote options, and the scope draft
// release it holds.
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { readTakenQuoteOptions } from './taken_options.ts'
import { releaseScopeJobDraftsOnAcceptance } from '../scope_freeze/release_scope_job_drafts.ts'

type Result = { data?: unknown; error?: unknown }
function fakeClient(
  tables: Record<string, Result>,
  log: { inserts: Array<[string, any]>; rpc: number; calls?: Array<[string, any]> },
  rpcs: Record<string, Result> = {},
) {
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
    rpc(fn: string, args: any) {
      log.rpc++
      log.calls?.push([fn, args])
      return Promise.resolve(rpcs[fn] ?? { data: { released: true }, error: null })
    },
  }
}

const GUTTER = { id: 'gutter', name: 'Extra gutter', goes: 'crew', labour_line: { line_key: 'g', description: 'Fit gutter', total: 250 } }
const RECORD = {
  offered: [{ id: 'lights', name: 'Two downlights', goes: 'supplier' }, { id: 'gutter', name: 'Extra gutter', goes: 'crew' }],
  taken_option_ids: ['gutter'],
  taken_options: [GUTTER],
}

Deno.test('R14 reader: taken, none, unreadable, and a table not yet created', async () => {
  const log = { inserts: [], rpc: 0 }
  assertEquals(await readTakenQuoteOptions(fakeClient({ quote_option_acceptances: { data: [RECORD], error: null } }, log), 'j'),
    { state: 'taken', options: [{ id: 'gutter', name: 'Extra gutter', goes: 'crew', sealed: GUTTER }] })
  // A taken id with no sealed entry is unreadable, never "none".
  assertEquals(await readTakenQuoteOptions(fakeClient({ quote_option_acceptances: { data: [{ ...RECORD, taken_options: [] }], error: null } }, log), 'j'),
    { state: 'unreadable' })
  assertEquals(await readTakenQuoteOptions(fakeClient({ quote_option_acceptances: { data: [{ ...RECORD, taken_option_ids: [], taken_options: [] }], error: null } }, log), 'j'),
    { state: 'none' })
  assertEquals(await readTakenQuoteOptions(fakeClient({ quote_option_acceptances: { data: [], error: null } }, log), 'j'), { state: 'none' })
  assertEquals(await readTakenQuoteOptions(fakeClient({ quote_option_acceptances: { data: null, error: { code: '57014' } } }, log), 'j'),
    { state: 'unreadable' })
  assertEquals(await readTakenQuoteOptions(fakeClient({ quote_option_acceptances: { data: null, error: { code: 'PGRST205' } } }, log), 'j'),
    { state: 'none' })
})

const DRAFT = { scope_job_draft_sets: { data: { scope_revision_id: 'rev-1', released_at: null }, error: null } }

const RELEASE_TABLES = {
  ...DRAFT,
  job_documents: { data: [], error: null, count: 0 } as Result,
  run_acceptances: { data: [], error: null, count: 0 } as Result,
  job_variations: { data: [], error: null, count: 0 } as Result,
  jobs: { data: { expected_costs: null }, error: null },
}

Deno.test('R14 release: a taken option is applied to the drafts first, then they are released', async () => {
  const log = { inserts: [] as Array<[string, any]>, rpc: 0, calls: [] as Array<[string, any]> }
  const out = await releaseScopeJobDraftsOnAcceptance(
    fakeClient({ ...RELEASE_TABLES, quote_option_acceptances: { data: [RECORD], error: null } }, log), 'j')
  assertEquals(out, { state: 'released' })
  assertEquals(log.calls.map(([fn]) => fn), ['apply_quote_options_to_scope_drafts', 'release_scope_job_drafts'])
  assertEquals(log.calls[0][1], { p_job_id: 'j', p_scope_revision_id: 'rev-1' })
})

Deno.test('R14 release: an overlay the database refuses releases nothing and names its code', async () => {
  const log = { inserts: [] as Array<[string, any]>, rpc: 0, calls: [] as Array<[string, any]> }
  const out = await releaseScopeJobDraftsOnAcceptance(
    fakeClient({ ...RELEASE_TABLES, quote_option_acceptances: { data: [RECORD], error: null } }, log,
      { apply_quote_options_to_scope_drafts: { data: null, error: { message: 'scope_options_not_sealed' } } }), 'j')
  assertEquals(out, { state: 'release_unavailable' })
  assertEquals(log.calls.map(([fn]) => fn), ['apply_quote_options_to_scope_drafts'], 'nothing released')
  assertEquals(log.inserts, [['job_events', {
    job_id: 'j', event_type: 'scope_job_draft_release_held', detail_json: { reason: 'scope_options_not_sealed' },
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
    taken_option_ids: ['gutter', 'skip'], base_total_inc_gst: '11000.00', accepted_total_inc_gst: '12100.00', accepted_deposit_inc_gst: '6050.00',
    taken_options: [GUTTER, { id: 'skip', name: 'Skip bin', goes: 'office', office_line: { description: 'Order a skip bin', quantity: 1, unit: 'each', cost_ex_gst: 120 } }],
    created_at: '2026-11-13T00:00:00Z',
  }], error: null } }, log), 'j')
  assertEquals(rows?.[0].options.map((o) => [o.id, o.label]), [['lights', 'offered, not taken'], ['gutter', 'taken']])
  assertEquals(rows?.[0].accepted_total_inc_gst, 12100)
  assertEquals(rows?.[0].office_list, [{ option_id: 'skip', name: 'Skip bin', description: 'Order a skip bin', quantity: 1, unit: 'each', cost_ex_gst: 120 }],
    'a taken office option is on the office list; a crew option is not')
  assertEquals(await readJobQuoteOptionRecords(fakeClient({ quote_option_acceptances: { data: null, error: { code: 'x' } } }, log), 'j'), null)
  assertEquals(await readJobQuoteOptionRecords(fakeClient({ quote_option_acceptances: { data: null, error: { code: '42P01' } } }, log), 'j'), [])
})
