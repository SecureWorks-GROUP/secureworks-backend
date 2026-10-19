// deno test --allow-env --allow-read supabase/functions/send-outlook-email/shared_key_containment_test.ts
//
// Behaviour of SW_SHARED_KEY_CONTAINMENT on send-outlook-email. A GET with no
// action is answered 400 after authentication and 401 before it, without any
// provider call, so it shows exactly who gets past the auth gate.
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { handleOutlookRequest } from './index.ts'
import { _setDefaultLegacyKeyProbeForTest } from '../_shared/service_credential.ts'

// Placeholders only. None of these is, or is shaped from, a real key.
const FIXTURE = {
  SW_API_KEY: 'public-fixture',
  OPS_AGENT_SERVER_KEY: 'ops-fixture',
  SUPABASE_SERVICE_ROLE_KEY: 'service-fixture',
}
const URL_NO_ACTION = 'https://example.invalid/send-outlook-email'

async function withEnv(containment: string | undefined, run: () => Promise<void>) {
  const keys = [...Object.keys(FIXTURE), 'SW_SHARED_KEY_CONTAINMENT']
  const previous = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]))
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (() => {
    calls++
    throw new Error('Provider must not be called')
  }) as typeof fetch
  _setDefaultLegacyKeyProbeForTest(() => Promise.resolve('accepted'))
  try {
    for (const [k, v] of Object.entries(FIXTURE)) Deno.env.set(k, v)
    if (containment === undefined) Deno.env.delete('SW_SHARED_KEY_CONTAINMENT')
    else Deno.env.set('SW_SHARED_KEY_CONTAINMENT', containment)
    await run()
    assertEquals(calls, 0)
  } finally {
    _setDefaultLegacyKeyProbeForTest(null)
    globalThis.fetch = originalFetch
    for (const [k, v] of Object.entries(previous)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v)
  }
}

const status = async (headers: Record<string, string>) =>
  (await handleOutlookRequest(new Request(URL_NO_ACTION, { headers }))).status

Deno.test('containment off: the shared key still passes the auth gate (unchanged)', async () => {
  await withEnv(undefined, async () => {
    assertEquals(await status({ 'x-api-key': 'public-fixture' }), 400)
    assertEquals(await status({ authorization: 'Bearer public-fixture' }), 400)
  })
})

Deno.test('containment on: the shared key is refused from x-api-key and Bearer', async () => {
  await withEnv('on', async () => {
    assertEquals(await status({ 'x-api-key': 'public-fixture' }), 401)
    assertEquals(await status({ authorization: 'Bearer public-fixture' }), 401)
    assertEquals(await status({ 'x-api-key': 'public-fixture', authorization: 'Bearer public-fixture' }), 401)
  })
})

Deno.test('containment on: server credentials still pass (ops-api service headers, agent key)', async () => {
  await withEnv('on', async () => {
    // What ops-api now sends: Bearer + apikey with the service credential.
    assertEquals(await status({ authorization: 'Bearer service-fixture', apikey: 'service-fixture' }), 400)
    assertEquals(await status({ 'x-api-key': 'service-fixture' }), 400)
    assertEquals(await status({ 'x-api-key': 'ops-fixture' }), 400)
  })
})

Deno.test('containment on: shared key alongside a service credential is still a conflict', async () => {
  await withEnv('on', async () => {
    assertEquals(await status({ 'x-api-key': 'public-fixture', authorization: 'Bearer service-fixture' }), 401)
  })
})

Deno.test('containment on or off: wrong and missing credentials are refused', async () => {
  for (const c of [undefined, 'on']) {
    await withEnv(c, async () => {
      assertEquals(await status({}), 401)
      assertEquals(await status({ 'x-api-key': 'wrong-fixture' }), 401)
      assertEquals(await status({ apikey: 'public-fixture' }), 401)
    })
  }
})
