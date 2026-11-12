import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { chooseStageMoveTarget, executionCreatedNotBefore, resolveStageMoveTarget } from './stage_move_target.ts'

const SALES = 'sales-pipeline'
const EXEC = 'exec-pipeline'
const ACCEPTED = '338b7dd7-7220-4abc-bc0b-b8d9ea44f40e'

const sales = (over: Record<string, unknown> = {}) => ({
  id: 'sales-1', pipelineId: SALES, pipelineStageId: ACCEPTED, contactId: 'c-1',
  createdAt: '2026-10-01T00:00:00Z', lastStageChangeAt: '2026-11-02T01:12:59Z', ...over,
})
const exec = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({
  id, pipelineId: EXEC, contactId: 'c-1', status: 'won', createdAt, ...over,
})
const decide = (opportunity: unknown, candidates: unknown[], complete = true) => chooseStageMoveTarget({
  // deno-lint-ignore no-explicit-any
  opportunity: opportunity as any, jobType: 'fencing', executionPipelineId: EXEC, salesPipelineId: SALES,
  // deno-lint-ignore no-explicit-any
  executionCandidates: candidates as any, executionSearchComplete: complete,
})

Deno.test('only a proved accept-stage arrival bounds the Execution twin; the Sales creation never does', () => {
  assertEquals(executionCreatedNotBefore(sales(), 'fencing'), Date.parse('2026-11-02T01:12:59Z'))
  assertEquals(executionCreatedNotBefore(sales({ pipelineStageId: 'other' }), 'fencing'), null)
  assertEquals(executionCreatedNotBefore(sales({ lastStageChangeAt: null }), 'fencing'), null)
  assertEquals(executionCreatedNotBefore(sales({ lastStageChangeAt: '2026-09-01T00:00:00Z' }), 'fencing'), null)
  assertEquals(executionCreatedNotBefore(sales(), 'decking'), null)
})

Deno.test('an unproved acceptance moves nothing, even with one same-contact twin after the Sales creation', () => {
  for (const s of [sales({ lastStageChangeAt: null }), sales({ pipelineStageId: 'other' })]) {
    const r = decide(s, [exec('e-old', '2026-10-15T00:00:00Z')])
    assertEquals(r.kind === 'not_moved' && r.reason, 'sales_acceptance_unproven')
  }
})

Deno.test('an opportunity already in Execution is moved itself only while live', () => {
  assertEquals(decide({ id: 'e-0', pipelineId: EXEC, status: 'open' }, []), { kind: 'move', opportunityId: 'e-0', salesOpportunityId: null })
  assertEquals(decide({ id: 'e-0', pipelineId: EXEC, status: 'won' }, []), { kind: 'move', opportunityId: 'e-0', salesOpportunityId: null })
  for (const status of ['lost', 'abandoned', undefined, 'mystery']) {
    const r = decide({ id: 'e-0', pipelineId: EXEC, status }, [])
    assertEquals(r.kind === 'not_moved' && r.reason, 'opportunity_not_live')
  }
})

Deno.test('an in-window candidate with no pipeline or no known status moves nothing', () => {
  for (const over of [{ pipelineId: undefined }, { pipelineId: '' }, { status: undefined }, { status: 'mystery' }]) {
    const r = decide(sales(), [exec('e-1', '2026-11-02T01:13:04Z', over)])
    assertEquals(r.kind === 'not_moved' && r.reason, 'execution_candidate_unreadable')
  }
})

Deno.test('the one live twin created after the accept is the target', () => {
  assertEquals(decide(sales(), [exec('e-1', '2026-11-02T01:13:04Z')]), { kind: 'move', opportunityId: 'e-1', salesOpportunityId: 'sales-1' })
})

Deno.test('rows for another contact (filter ignored) or another pipeline never count', () => {
  const r = decide(sales(), [exec('e-1', '2026-11-03T00:00:00Z', { contactId: 'c-2' }), exec('e-2', '2026-11-03T00:00:00Z', { pipelineId: SALES })])
  assertEquals(r.kind === 'not_moved' && r.reason, 'execution_opportunity_not_created')
})

Deno.test('a live twin without a readable creation time is never skipped: nothing moves', () => {
  for (const createdAt of [undefined, '', 'not a date']) {
    // Alone, and beside a readable later twin it would otherwise leave unique.
    for (const rows of [[exec('e-1', createdAt as string)], [exec('e-ok', '2026-11-03T00:00:00Z'), exec('e-1', createdAt as string)]]) {
      const r = decide(sales(), rows)
      assertEquals(r.kind === 'not_moved' && r.reason, 'execution_candidate_unreadable', String(createdAt))
    }
  }
  // An undated row proved dead, or proved to sit in another pipeline, is no candidate.
  assertEquals(decide(sales(), [exec('e-ok', '2026-11-03T00:00:00Z'), exec('e-1', '', { status: 'lost' })]), { kind: 'move', opportunityId: 'e-ok', salesOpportunityId: 'sales-1' })
  assertEquals(decide(sales(), [exec('e-ok', '2026-11-03T00:00:00Z'), exec('e-1', '', { pipelineId: SALES })]), { kind: 'move', opportunityId: 'e-ok', salesOpportunityId: 'sales-1' })
})

Deno.test('an unfinished search moves nothing, even with one match', () => {
  const r = decide(sales(), [exec('e-1', '2026-11-02T01:13:04Z')], false)
  assertEquals(r.kind === 'not_moved' && r.reason, 'execution_search_incomplete')
})

Deno.test('an unreadable opportunity or one in another pipeline moves nothing', () => {
  const unreadable = decide(null, [])
  assertEquals(unreadable.kind === 'not_moved' && unreadable.reason, 'opportunity_unreadable')
  const other = decide({ id: 'x', pipelineId: 'materials' }, [])
  assertEquals(other.kind === 'not_moved' && other.reason, 'opportunity_in_other_pipeline')
})

Deno.test('the resolver searches only for a Sales opportunity, by its own contact', async () => {
  const searches: unknown[] = []
  const r = await resolveStageMoveTarget({
    opportunityId: 'sales-1', jobType: 'fencing', executionPipelineId: EXEC, salesPipelineId: SALES,
    readOpportunity: () => Promise.resolve({ opportunity: sales() }),
    searchExecution: (a) => { searches.push(a); return Promise.resolve({ opportunities: [exec('e-1', '2026-11-02T01:13:04Z')], exhausted: true }) },
  })
  assertEquals(searches, [{ pipelineId: EXEC, contactId: 'c-1' }])
  assertEquals(r, { kind: 'move', opportunityId: 'e-1', salesOpportunityId: 'sales-1' })
  const own = await resolveStageMoveTarget({
    opportunityId: 'e-0', jobType: 'fencing', executionPipelineId: EXEC, salesPipelineId: SALES,
    readOpportunity: () => Promise.resolve({ opportunity: { id: 'e-0', pipelineId: EXEC, status: 'open' } }),
    searchExecution: () => { throw Error('must not search') },
  })
  assertEquals(own, { kind: 'move', opportunityId: 'e-0', salesOpportunityId: null })
})

Deno.test('the resolver re-reads a search row missing its pipeline or status before it can count', async () => {
  const reads: string[] = []
  const stored: Record<string, unknown> = {
    'sales-1': sales(),
    'e-1': exec('e-1', '2026-11-02T01:13:04Z'),
    's-2': { id: 's-2', pipelineId: SALES, contactId: 'c-1', status: 'open', createdAt: '2026-11-03T00:00:00Z' },
  }
  const run = (rows: unknown[]) => resolveStageMoveTarget({
    opportunityId: 'sales-1', jobType: 'fencing', executionPipelineId: EXEC, salesPipelineId: SALES,
    readOpportunity: (id) => { reads.push(id); return Promise.resolve({ opportunity: stored[id] ?? null }) },
    // deno-lint-ignore no-explicit-any
    searchExecution: () => Promise.resolve({ opportunities: rows as any, exhausted: true }),
  })
  // A twin the search returned without pipeline or status is read and moved.
  assertEquals(await run([{ id: 'e-1', contactId: 'c-1', createdAt: '2026-11-02T01:13:04Z' }]), { kind: 'move', opportunityId: 'e-1', salesOpportunityId: 'sales-1' })
  // A Sales opportunity the search returned without its pipeline is read and dropped.
  const salesRow = await run([{ id: 's-2', contactId: 'c-1', status: 'open', createdAt: '2026-11-03T00:00:00Z' }])
  assertEquals(salesRow.kind === 'not_moved' && salesRow.reason, 'execution_opportunity_not_created')
  // A row that cannot be re-read stays unreadable and moves nothing.
  const gone = await run([{ id: 'x-9', contactId: 'c-1', createdAt: '2026-11-03T00:00:00Z' }])
  assertEquals(gone.kind === 'not_moved' && gone.reason, 'execution_candidate_unreadable')
  assertEquals(reads, ['sales-1', 'e-1', 'sales-1', 's-2', 'sales-1', 'x-9'])
})

Deno.test('the resolver re-reads a search row missing its creation time; still unreadable moves nothing', async () => {
  const reads: string[] = []
  const stored: Record<string, unknown> = {
    'sales-1': sales(),
    'e-ok': exec('e-ok', '2026-11-03T00:00:00Z'),
    'e-old': exec('e-old', '2026-03-01T00:00:00Z'),
    'e-undated': exec('e-undated', ''),
  }
  const run = (rows: unknown[]) => resolveStageMoveTarget({
    opportunityId: 'sales-1', jobType: 'fencing', executionPipelineId: EXEC, salesPipelineId: SALES,
    readOpportunity: (id) => { reads.push(id); return Promise.resolve({ opportunity: stored[id] ?? null }) },
    // deno-lint-ignore no-explicit-any
    searchExecution: () => Promise.resolve({ opportunities: rows as any, exhausted: true }),
  })
  // The by-id read shows the undated row is an earlier job's: the twin moves.
  assertEquals(await run([exec('e-ok', '2026-11-03T00:00:00Z'), exec('e-old', '')]), { kind: 'move', opportunityId: 'e-ok', salesOpportunityId: 'sales-1' })
  // The by-id read still has no creation time: the whole selection holds.
  const held = await run([exec('e-ok', '2026-11-03T00:00:00Z'), exec('e-undated', 'garbage')])
  assertEquals(held.kind === 'not_moved' && held.reason, 'execution_candidate_unreadable')
  assertEquals(reads, ['sales-1', 'e-old', 'sales-1', 'e-undated'])
})
