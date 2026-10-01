import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { handleOutlookRequest } from './index.ts'
import { _setDefaultLegacyKeyProbeForTest } from '../_shared/service_credential.ts'

Deno.test('actual capability and new-action routes require the distinct privileged key without provider calls', async () => {
  const fixture = { SW_API_KEY: 'public-fixture', OPS_AGENT_SERVER_KEY: 'ops-fixture', SUPABASE_SERVICE_ROLE_KEY: 'service-fixture' }
  const previous = Object.fromEntries(Object.keys(fixture).map(key => [key, Deno.env.get(key)]))
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (() => { calls++; throw new Error('Provider must not be called') }) as typeof fetch
  try {
    for (const [key, value] of Object.entries(fixture)) Deno.env.set(key, value)
    const url = 'https://example.invalid/send-outlook-email?action=outlook_capabilities'
    for (const key of ['ops-fixture', 'service-fixture']) {
      const response = await handleOutlookRequest(new Request(url, { headers: { 'x-api-key': key } }))
      assertEquals(response.status, 200)
      assertEquals(await response.json(), { contract_version: '2026-09-09.1', actions: ['send', 'forward', 'reply', 'draft'], new_group_send: false })
    }
    for (const key of ['', 'public-fixture', 'wrong-fixture']) {
      const response = await handleOutlookRequest(new Request(url, { headers: key ? { 'x-api-key': key } : {} }))
      assertEquals(response.status, 401)
    }
    for (const action of ['reply', 'draft']) {
      const response = await handleOutlookRequest(new Request(url, { method: 'POST', headers: { 'x-api-key': 'public-fixture' }, body: JSON.stringify({ action }) }))
      assertEquals(response.status, 401)
    }
    const ambiguous = await handleOutlookRequest(new Request(url, { headers: { 'x-api-key': 'public-fixture', authorization: 'Bearer service-fixture' } }))
    assertEquals(ambiguous.status, 401)
    Deno.env.set('OPS_AGENT_SERVER_KEY', 'public-fixture')
    Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'public-fixture')
    const collision = await handleOutlookRequest(new Request(url, { headers: { 'x-api-key': 'public-fixture' } }))
    assertEquals(collision.status, 401)
    assertEquals(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(previous)) value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value)
  }
})

Deno.test('an agent key equal to a switched-off service-role key is refused as the agent pass', async () => {
  const fixture = { SW_API_KEY: 'public-fixture', OPS_AGENT_SERVER_KEY: 'shared-fixture', SUPABASE_SERVICE_ROLE_KEY: 'shared-fixture' }
  const previous = Object.fromEntries(Object.keys(fixture).map(key => [key, Deno.env.get(key)]))
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (() => { calls++; throw new Error('Provider must not be called') }) as typeof fetch
  _setDefaultLegacyKeyProbeForTest(() => Promise.resolve('rejected'))
  try {
    for (const [key, value] of Object.entries(fixture)) Deno.env.set(key, value)
    const url = 'https://example.invalid/send-outlook-email?action=outlook_capabilities'
    const presentations: Record<string, string>[] = [{ 'x-api-key': 'shared-fixture' }, { authorization: 'Bearer shared-fixture' }]
    for (const headers of presentations) {
      const response = await handleOutlookRequest(new Request(url, { headers }))
      assertEquals(response.status, 401)
    }
    Deno.env.set('OPS_AGENT_SERVER_KEY', 'ops-fixture')
    const distinct = await handleOutlookRequest(new Request(url, { headers: { 'x-api-key': 'ops-fixture' } }))
    assertEquals(distinct.status, 200)
    assertEquals(calls, 0)
  } finally {
    _setDefaultLegacyKeyProbeForTest(null)
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(previous)) value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value)
  }
})
