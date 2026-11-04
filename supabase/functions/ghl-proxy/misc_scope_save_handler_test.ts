// Captured real serve handler. Every fetch is intercepted; no live systems.
// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { createClient as lockedCreateClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { scopeJsonHash } from './hardening_helpers.ts'
void lockedCreateClient

type Connection = { request: Request; respond: (response: Response) => void; localAddr: Deno.NetAddr; remoteAddr: Deno.NetAddr }
function capturedServer() {
  const queued: Connection[] = []
  const waiting: Array<(connection: Connection) => void> = []
  return {
    listen: () => ({
      addr: { transport: 'tcp', hostname: '127.0.0.1', port: 8123 },
      accept: () => queued.length ? Promise.resolve(queued.shift()!) : new Promise<Connection>((resolve) => waiting.push(resolve)),
      close() {},
    }),
    serveHttp(connection: Connection) {
      let served = false
      return {
        nextRequest() {
          if (served) return Promise.resolve(null)
          served = true
          return Promise.resolve({ request: connection.request, respondWith: connection.respond })
        },
        close() {},
      }
    },
    request(request: Request): Promise<Response> {
      return new Promise((respond) => {
        const addr: Deno.NetAddr = { transport: 'tcp', hostname: '127.0.0.1', port: 8123 }
        const connection = { request, respond, localAddr: addr, remoteAddr: addr }
        const waiter = waiting.shift()
        if (waiter) waiter(connection)
        else queued.push(connection)
      })
    },
  }
}

Deno.test('actual save_scope keeps Misc drafts isolated across before-read and in-flight job changes', async (t) => {
  const env = {
    SUPABASE_URL: 'https://misc-save.test.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-key',
    SW_API_KEY: 'fixture-shared-key',
    GHL_LOCATION_ID: 'fixture-location',
  }
  const cleared = ['SUPABASE_SECRET_KEYS', 'OPS_AGENT_SERVER_KEY', 'MAKESAFE_ROUTINE_KEY', 'GHL_PROXY_REQUIRE_USER_JWT_FOR_BROWSER_ACTIONS', 'GHL_PROXY_REQUIRE_SCOPE_CURSOR_FOR_SHARED_KEY']
  for (const name of cleared) Deno.env.delete(name)
  for (const [name, value] of Object.entries(env)) Deno.env.set(name, value)
  const harness = capturedServer()
  const oldListen = Object.getOwnPropertyDescriptor(Deno, 'listen')
  const oldServe = Object.getOwnPropertyDescriptor(Deno, 'serveHttp')
  const oldFetch = globalThis.fetch
  Object.defineProperty(Deno, 'listen', { configurable: true, value: harness.listen })
  Object.defineProperty(Deno, 'serveHttp', { configurable: true, value: harness.serveHttp })

  type Row = Record<string, unknown>
  const empty = () => ({ id: 'job', type: 'general', status: 'draft', scope_json: {}, pricing_json: {}, updated_at: 'before' })
  let row: Row = empty()
  let mutateDuringPatch: ((row: Row) => void) | null = null
  let applied: Row[] = []
  const scope = { tool: 'misc-scoper', version: '1.0', draft: { description: 'Custom work' } }
  const pricing = { tool: 'misc-scoper', source: 'quick_quote', pricing_complete: false, totalIncGST: null }
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    assertEquals(url.origin, env.SUPABASE_URL, 'unexpected provider request')
    if (url.pathname === '/rest/v1/job_events' && request.method === 'POST') return new Response(null, { status: 201 })
    assertEquals(url.pathname, '/rest/v1/jobs')
    if (request.method === 'GET') {
      const select = url.searchParams.get('select') || '*'
      return Response.json(select === '*' ? structuredClone(row) : Object.fromEntries(select.split(',').map((key) => [key, row[key]])))
    }
    assertEquals(request.method, 'PATCH')
    if (mutateDuringPatch) mutateDuringPatch(row)
    const expected = url.searchParams.get('updated_at')
    if (expected !== `eq.${row.updated_at}`) return Response.json({
      code: 'PGRST116', details: 'The result contains 0 rows',
      message: 'JSON object requested, multiple (or no) rows returned',
    }, { status: 406 })
    const patch = await request.json() as Row
    row = { ...row, ...patch, updated_at: 'after' }
    applied.push(patch)
    return Response.json(row)
  }
  async function save(meta: Row, incoming: Row = scope) {
    const response = await harness.request(new Request('https://handler.test.invalid/?action=save_scope', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.SW_API_KEY },
      body: JSON.stringify({ jobId: 'job', scopeJson: incoming, meta: { pricing_json: pricing, ...meta } }),
    }))
    return { status: response.status, body: await response.json() }
  }
  const cursor = async () => ({ base_scope_hash: await scopeJsonHash(row.scope_json || {}), base_pricing_hash: await scopeJsonHash(row.pricing_json || {}) })
  async function reset(extra: Row = {}) {
    row = { ...empty(), ...extra }; mutateDuringPatch = null; applied = []
    return await cursor()
  }
  try {
    const entrypoint = './index' + '.ts'
    await import(entrypoint)
    await t.step('own empty draft saves both blobs atomically', async () => {
      const result = await save(await reset())
      assertEquals(result.status, 200)
      assertEquals(applied.length, 1)
      assertEquals(row.scope_json, scope)
      assertEquals(row.pricing_json, pricing)
      assertEquals(result.body.job.scope_json, scope)
      assertEquals(result.body.job.pricing_json, pricing)
    })
    await t.step('own nonempty draft can save again with both current hashes', async () => {
      const result = await save(await cursor())
      assertEquals(result.status, 200)
      assertEquals(applied.length, 2)
    })
    for (const status of ['quoted', 'accepted', 'scheduled', 'in_progress']) {
      await t.step(`${status} before server read refuses without overwriting`, async () => {
        const meta = await reset()
        row.status = status
        const result = await save(meta)
        assertEquals([result.status, result.body.code], [409, 'misc_draft_job_required'])
        assertEquals(applied, [])
        assertEquals(row.status, status)
      })
    }
    await t.step('pricing-only edit before server read is not lost', async () => {
      const meta = await reset({ pricing_json: pricing })
      row.pricing_json = { ...pricing, internal_notes: 'office edit' }
      const result = await save(meta)
      assertEquals([result.status, result.body.code], [409, 'misc_pricing_hash_conflict'])
      assertEquals(applied, [])
    })
    for (const changes of [{ status: 'accepted' }, { pricing_json: { ...pricing, internal_notes: 'newer' } }]) {
      await t.step('in-flight row change refuses even when scope hash equals incoming', async () => {
        const meta = await reset({ scope_json: scope, pricing_json: pricing })
        mutateDuringPatch = (current) => Object.assign(current, changes, { updated_at: 'concurrent' })
        const result = await save(meta)
        assertEquals([result.status, result.body.code], [409, 'misc_scope_save_conflict'])
        assertEquals(applied, [])
      })
    }
    await t.step('legacy pricing with empty scope is preserved', async () => {
      const meta = await reset({ pricing_json: { source: 'quick_quote', job_description: 'Legacy quote' } })
      const result = await save(meta)
      assertEquals([result.status, result.body.code], [409, 'misc_foreign_pricing'])
      assertEquals(applied, [])
    })
    await t.step('both cursors are required even on the shared-key empty-scope route', async () => {
      const meta = await reset()
      let result = await save({})
      assertEquals([result.status, result.body.code], [409, 'misc_scope_cursor_required'])
      result = await save({ base_scope_hash: meta.base_scope_hash })
      assertEquals([result.status, result.body.code], [409, 'misc_pricing_cursor_required'])
      assertEquals(applied, [])
    })
    for (const incomingPricing of [undefined, null, [], { tool: 'patio-scoper' }, { tool: 'misc-scoper' }]) {
      await t.step('omitted or foreign incoming pricing cannot create a mixed one-save snapshot', async () => {
        const meta = await reset()
        const result = await save({ ...meta, pricing_json: incomingPricing })
        assertEquals([result.status, result.body.code], [409, 'misc_pricing_payload_required'])
        assertEquals(applied, [])
      })
    }
    await t.step('foreign type and scope are kept', async () => {
      let result = await save(await reset({ type: 'patio' }))
      assertEquals([result.status, result.body.code], [409, 'misc_draft_job_required'])
      result = await save(await reset({ scope_json: { tool: 'patio-scoper' } }))
      assertEquals([result.status, result.body.code], [409, 'misc_foreign_scope'])
      assertEquals(applied, [])
    })
    await t.step('legacy patio save remains compatible without pricing cursor', async () => {
      await reset({ type: 'patio', status: 'accepted' })
      const result = await save({}, { tool: 'patio-scoper' })
      assertEquals(result.status, 200)
      assertEquals(applied.length, 1)
    })
    for (const legacy of [{ type: 'fencing', scope: { tool: 'fence-designer' } }, { type: 'general', scope: { notes: 'Legacy quick quote' } }]) {
      await t.step('other legacy saves retain their existing no-pricing-cursor behavior', async () => {
        await reset({ type: legacy.type, status: 'quoted' })
        const result = await save({}, legacy.scope)
        assertEquals(result.status, 200)
        assertEquals(applied.length, 1)
      })
    }
    assert(applied.length > 0)
  } finally {
    globalThis.fetch = oldFetch
    if (oldListen) Object.defineProperty(Deno, 'listen', oldListen)
    if (oldServe) Object.defineProperty(Deno, 'serveHttp', oldServe)
    for (const name of [...Object.keys(env), ...cleared]) Deno.env.delete(name)
  }
})
