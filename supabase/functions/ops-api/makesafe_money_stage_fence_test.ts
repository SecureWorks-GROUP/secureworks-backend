// deno-lint-ignore-file no-import-prefix no-explicit-any
// S1 proof for hardening item 03.
//
// The production default is loose: caller observations are logged, the
// existing routine fence remains unchanged, and unidentified callers pass
// through. The strict decision is exercised through the pure policy helper so
// flipping the one production constant is a one-line, test-covered change.

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { _updateMakesafeSubstatus } from './index.ts'
import {
  evaluateMakesafeMoneyStageFence,
  intakeOrigin,
  internalEvidenceOrigin,
  MAKESAFE_AGENT_MONEY_STAGE_FENCE_STRICT,
  makesafeExternalWriteOrigin,
  observeMakesafeMoneyStageFence,
  unidentifiedOrigin,
} from './makesafe_write_origin.ts'

function makeClient() {
  const writes: any[] = []
  const events: any[] = []
  const client = {
    from(table: string) {
      return {
        select() {
          const chain: any = {
            eq: () => chain,
            in: () => chain,
            maybeSingle: () =>
              Promise.resolve(
                table === 'jobs'
                  ? {
                    data: { status: 'processing', metadata: null },
                    error: null,
                  }
                  : {
                    data: {
                      substatus: 'admin_to_send_report',
                      report_type: 'roof',
                      cycle_number: 1,
                      portal_verified_at: '2026-08-10T00:00:00Z',
                      portal_verified_cycle: 1,
                      portal_verified_signal: null,
                      external_links: [],
                      attendance_cycle_id: null,
                      external_ref: null,
                    },
                    error: null,
                  },
              ),
            single: () =>
              Promise.resolve({
                data: { substatus: 'admin_to_send_report' },
                error: null,
              }),
          }
          return chain
        },
        update(payload: any) {
          const record = { table, payload, chain: [] as string[] }
          writes.push(record)
          const chain: any = {
            eq: (key: string) => {
              record.chain.push(`eq(${key})`)
              return chain
            },
            in: () => chain,
            or: () => chain,
            select: () => {
              record.chain.push('select')
              return chain
            },
            single: () =>
              Promise.resolve({
                data: { job_id: 'job-1', substatus: payload.substatus },
                error: null,
              }),
            then: (resolve: any, reject: any) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
          }
          return chain
        },
        insert(row: any) {
          events.push({ table, row })
          return Promise.resolve({ data: null, error: null })
        },
      }
    },
  }
  return { client, writes, events }
}

function legacyMoneyFence(
  authMode: string,
  nextSubstatus: string,
): { status: number; shape: string } {
  const forbidden = ['ready_to_invoice', 'complete']
  if (authMode === 'routine' && forbidden.includes(nextSubstatus)) {
    return { status: 403, shape: 'error' }
  }
  return { status: 200, shape: 'ok' }
}

async function looseWrite(
  authMode: string,
  nextSubstatus: string,
  origin: Parameters<typeof evaluateMakesafeMoneyStageFence>[1],
  external = true,
) {
  const { client, writes } = makeClient()
  try {
    const result: any = await _updateMakesafeSubstatus(
      client,
      { job_id: 'job-1', substatus: nextSubstatus },
      { authMode, origin, external },
    )
    return {
      status: 200,
      shape: result?.ok === true ? 'ok' : 'other',
      writes: writes.filter((write) => write.table === 'makesafe_job_details'),
    }
  } catch (error: any) {
    return { status: error?.status || 500, shape: 'error', writes }
  }
}

Deno.test('production is explicitly loose, and strict is a one-argument policy flip', () => {
  assertEquals(MAKESAFE_AGENT_MONEY_STAGE_FENCE_STRICT, false)
  const agent = { class: 'agent', detail: 'mcp:ses-agent' } as const
  const loose = evaluateMakesafeMoneyStageFence('complete', agent, false)
  assertEquals(loose.refusal, null)
  assertEquals(loose.strict_would_refuse, true)
  const strict = evaluateMakesafeMoneyStageFence('complete', agent, true)
  assertEquals(strict.refusal?.status, 403)
  assert(strict.refusal?.message.includes('agent money-stage fence'))
})

Deno.test('the explicit caller signal is per request; missing or malformed is unidentified', () => {
  assertEquals(
    makesafeExternalWriteOrigin({
      caller: { class: 'agent', detail: 'mcp' },
    }, 'external'),
    { class: 'agent', detail: 'mcp' },
  )
  assertEquals(
    makesafeExternalWriteOrigin({
      caller: { class: 'agent', detail: 'agent:john-doe' },
    }, 'external'),
    { class: 'agent', detail: 'unspecified' },
  )
  for (const detail of ['constructor', '__proto__']) {
    assertEquals(
      makesafeExternalWriteOrigin({ caller: { class: 'agent', detail } }, 'external'),
      { class: 'agent', detail: 'unspecified' },
    )
  }
  assertEquals(
    makesafeExternalWriteOrigin({}, 'external'),
    { class: 'unidentified', detail: 'external' },
  )
  assertEquals(
    makesafeExternalWriteOrigin(
      { caller: { class: 'not-a-class' } },
      'external',
    ),
    { class: 'unidentified', detail: 'external:invalid_signal' },
  )
})

Deno.test('money-stage observation names caller, stage, and the later strict outcome', () => {
  const observation = observeMakesafeMoneyStageFence(
    'ready_to_invoice',
    { class: 'agent', detail: 'mcp:api' },
    'api_key',
  )
  assertEquals(observation, {
    marker: 'makesafe_agent_money_stage_fence',
    fence: 'agent_money_stage',
    caller_class: 'agent',
    caller_detail: 'mcp:api',
    auth_mode: 'api_key',
    next_substatus: 'ready_to_invoice',
    strict_enabled: false,
    strict_would_refuse: true,
    enforcement: 'observe',
  })
  assertEquals(
    observeMakesafeMoneyStageFence(
      'complete',
      unidentifiedOrigin('external'),
      'api_key',
    )?.strict_would_refuse,
    false,
  )
})

Deno.test('zero-behaviour-change: every caller class keeps the old status and response shape in loose mode', async () => {
  const cases = [
    {
      name: 'agent with routine key',
      authMode: 'routine',
      origin: { class: 'agent', detail: 'mcp:routine' } as const,
    },
    {
      name: 'agent with api key',
      authMode: 'api_key',
      origin: { class: 'agent', detail: 'mcp:api' } as const,
    },
    {
      name: 'ops UI with api key',
      authMode: 'api_key',
      origin: { class: 'ops_ui', detail: 'ops-dashboard' } as const,
    },
    {
      name: 'internal evidence event',
      authMode: 'api_key',
      origin: internalEvidenceOrigin('trade_report_submitted'),
      external: false,
    },
    {
      name: 'intake',
      authMode: 'api_key',
      origin: intakeOrigin('settlement'),
      external: false,
    },
    {
      name: 'no caller signal',
      authMode: 'api_key',
      origin: unidentifiedOrigin('external'),
    },
  ]

  for (const caller of cases) {
    const nextSubstatus = 'complete'
    const expected = legacyMoneyFence(caller.authMode, nextSubstatus)
    const actual = await looseWrite(
      caller.authMode,
      nextSubstatus,
      caller.origin,
      caller.external !== false,
    )
    assertEquals(actual.status, expected.status, caller.name)
    assertEquals(actual.shape, expected.shape, caller.name)
    if (expected.status === 200) {
      assertEquals(actual.writes.length, 1, caller.name)
    }
    if (expected.status === 403) {
      assertEquals(actual.writes.length, 0, caller.name)
    }
  }
})

Deno.test('agent api-key writes to both money stages remain allowed while loose', async () => {
  for (const nextSubstatus of ['ready_to_invoice', 'complete']) {
    const actual = await looseWrite(
      'api_key',
      nextSubstatus,
      { class: 'agent', detail: 'mcp:api' },
    )
    assertEquals(actual.status, 200, nextSubstatus)
    assertEquals(actual.shape, 'ok', nextSubstatus)
    assertEquals(actual.writes.length, 1, nextSubstatus)
  }
})

Deno.test('routine callers remain refused on both money stages', async () => {
  for (const nextSubstatus of ['ready_to_invoice', 'complete']) {
    const actual = await looseWrite(
      'routine',
      nextSubstatus,
      { class: 'agent', detail: 'mcp:routine' },
    )
    assertEquals(actual.status, 403, nextSubstatus)
    assertEquals(actual.shape, 'error', nextSubstatus)
    assertEquals(actual.writes.length, 0, nextSubstatus)
  }
})

Deno.test('non-money substatuses are not observed or refused for an agent api-key caller', async () => {
  for (
    const nextSubstatus of ['admin_to_send_report', 'waiting_on_trade_report']
  ) {
    const actual = await looseWrite(
      'api_key',
      nextSubstatus,
      { class: 'agent', detail: 'mcp:api' },
    )
    assertEquals(actual.status, 200, nextSubstatus)
    assertEquals(actual.shape, 'ok', nextSubstatus)
    assertEquals(actual.writes.length, 1, nextSubstatus)
  }
})
