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

Deno.test('the accept-stage arrival bounds the Execution twin; otherwise the Sales creation does', () => {
  assertEquals(executionCreatedNotBefore(sales(), 'fencing'), Date.parse('2026-11-02T01:12:59Z'))
  assertEquals(executionCreatedNotBefore(sales({ pipelineStageId: 'other' }), 'fencing'), Date.parse('2026-10-01T00:00:00Z'))
  assertEquals(executionCreatedNotBefore(sales({ lastStageChangeAt: null }), 'fencing'), Date.parse('2026-10-01T00:00:00Z'))
})

Deno.test('an opportunity already in Execution is moved itself', () => {
  assertEquals(decide({ id: 'e-0', pipelineId: EXEC }, []), { kind: 'move', opportunityId: 'e-0', salesOpportunityId: null })
})

Deno.test('the one live twin created after the accept is the target', () => {
  assertEquals(decide(sales(), [exec('e-1', '2026-11-02T01:13:04Z')]), { kind: 'move', opportunityId: 'e-1', salesOpportunityId: 'sales-1' })
})

Deno.test('rows for another contact (filter ignored) or another pipeline never count', () => {
  const r = decide(sales(), [exec('e-1', '2026-11-03T00:00:00Z', { contactId: 'c-2' }), exec('e-2', '2026-11-03T00:00:00Z', { pipelineId: SALES })])
  assertEquals(r.kind === 'not_moved' && r.reason, 'execution_opportunity_not_created')
})

Deno.test('a twin without a readable creation time is not trusted', () => {
  const r = decide(sales(), [exec('e-1', 'not a date')])
  assertEquals(r.kind === 'not_moved' && r.reason, 'execution_opportunity_not_created')
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
    readOpportunity: () => Promise.resolve({ opportunity: { id: 'e-0', pipelineId: EXEC } }),
    searchExecution: () => { throw Error('must not search') },
  })
  assertEquals(own, { kind: 'move', opportunityId: 'e-0', salesOpportunityId: null })
})
