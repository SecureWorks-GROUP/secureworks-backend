import { automationLaneEnabled, contextActionLane } from './automation_switch.ts'
function equal(actual: unknown, expected: unknown) { if (actual !== expected) throw new Error(`${actual} != ${expected}`) }
Deno.test('lane reads fail closed on errors and nonboolean values, never cache', async () => {
  let calls = 0
  const client = { rpc: () => { calls++; return Promise.resolve({ data: calls === 1, error: null }) } }
  equal(await automationLaneEnabled(client, 'capture'), true)
  equal(await automationLaneEnabled(client, 'capture'), false)
  equal(calls, 2)
  for (const data of [null, undefined, 'true', 1, {}, []]) equal(await automationLaneEnabled({ rpc: () => Promise.resolve({ data, error: null }) }, 'capture'), false)
  equal(await automationLaneEnabled({ rpc: () => Promise.resolve({ data: true, error: {} }) }, 'attribution'), false)
  equal(await automationLaneEnabled({ rpc: () => { throw Error('transport') } }, 'extraction'), false)
})
Deno.test('ops capture action gate is bounded', () => {
 for (const action of ['backfill_ghl_conversations','backfill_call_transcripts','trigger_xero_sync']) equal(contextActionLane(action), 'capture')
 for (const action of ['job_detail','invoice_context','sync_suppliers','send_payment_link']) equal(contextActionLane(action), null)
})
