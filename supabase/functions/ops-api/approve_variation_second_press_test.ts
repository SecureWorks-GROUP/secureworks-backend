// SQ-24: a second press on a legacy variation event is refused visibly.
// The quote-option event guard (SQ-23) refuses any update that drops or
// changes a frozen detail_json key with 42501 quote_option_event_immutable.
// approve_variation used to ignore that error and answer success.
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { _approveVariationForTest as approveVariation, ApiError } from './index.ts'

const EVENT_ID = 'evt-sq24-1'

// Emulates the guard: an update passes only when the new detail_json still
// contains every key and value of the stored one (NEW @> OLD at top level).
function guardedClient(initial: Record<string, unknown>) {
  const store = { detail_json: structuredClone(initial) as Record<string, unknown> }
  const contains = (next: Record<string, unknown>, prev: Record<string, unknown>) =>
    Object.entries(prev).every(([k, v]) => JSON.stringify(next[k]) === JSON.stringify(v))
  const from = (table: string) => {
    let pendingUpdate: Record<string, unknown> | null = null
    const b: any = {
      select: () => b,
      eq: () => {
        if (pendingUpdate && table === 'job_events') {
          const next = pendingUpdate.detail_json as Record<string, unknown>
          pendingUpdate = null
          if (!contains(next, store.detail_json)) {
            return Promise.resolve({ data: null, error: { code: '42501', message: 'quote_option_event_immutable' } })
          }
          store.detail_json = structuredClone(next)
          return Promise.resolve({ data: null, error: null })
        }
        return b
      },
      is: () => b,
      update: (row: Record<string, unknown>) => { pendingUpdate = row; return b },
      insert: () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single: () => Promise.resolve({
        data: table === 'job_events'
          ? { id: EVENT_ID, job_id: 'job-1', detail_json: structuredClone(store.detail_json) }
          : null,
        error: null,
      }),
      then: (res: any) => Promise.resolve({ data: null, error: null }).then(res),
    }
    return b
  }
  return { client: { from, rpc: () => Promise.resolve({ data: null, error: null }) }, store }
}

Deno.test('SQ-24: second press on a decided variation is refused 409 and the first decision stands', async () => {
  const { client, store } = guardedClient({ quote_option_id: 'opt-a', superseded_by: 'opt-b' })

  const first = await approveVariation(client, { variation_id: EVENT_ID, approved: true, user_id: 'u-first' })
  assertEquals(first.success, true)
  const firstDecision = structuredClone(store.detail_json)
  assertEquals(firstDecision.status, 'approved')
  assertEquals(firstDecision.approved_by, 'u-first')

  await new Promise((r) => setTimeout(r, 5))
  const err = await assertRejects(
    () => approveVariation(client, { variation_id: EVENT_ID, approved: false, user_id: 'u-second' }),
    ApiError,
  )
  assertEquals((err as ApiError).status, 409)
  assertEquals((err as any).body, { error: 'variation_already_decided', code: 'quote_option_event_immutable' })

  // The event keeps its first decision and time.
  assertEquals(store.detail_json, firstDecision)
})

Deno.test('SQ-24: any other update error is unchanged (not turned into 409)', async () => {
  const client = {
    from: (table: string) => {
      const b: any = {
        select: () => b, is: () => b,
        eq: () => b,
        update: () => ({ eq: () => Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied' } }) }),
        insert: () => Promise.resolve({ data: null, error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        single: () => Promise.resolve({ data: table === 'job_events' ? { id: EVENT_ID, job_id: 'j', detail_json: {} } : null, error: null }),
        then: (res: any) => Promise.resolve({ data: null, error: null }).then(res),
      }
      return b
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }
  const res = await approveVariation(client, { variation_id: EVENT_ID, approved: true })
  assertEquals(res.success, true)
})
