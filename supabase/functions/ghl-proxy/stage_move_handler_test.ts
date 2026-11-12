// deno-lint-ignore-file no-import-prefix no-explicit-any
// The actual move_stage / move_to_complete handlers against a fake GoHighLevel
// that refuses an Execution stage on a Sales opportunity exactly as production
// does (400 OPPORTUNITY_STAGE_ID_INVALID). One case per refused shape from
// 11-12 Nov 2026 (fencing and patio office status moves). Synthetic ids only;
// nothing reaches a real provider.
import { createClient as lockedCreateClient } from 'https://esm.sh/@supabase/supabase-js@2'
void lockedCreateClient

const eq = (a: unknown, b: unknown, label = '') => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(`${label} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

function server() {
  const waiters: Array<(v: any) => void> = [], queued: any[] = []
  const listener = {
    addr: { transport: 'tcp', hostname: '127.0.0.1', port: 8123 }, close() {},
    accept: () => queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve) => waiters.push(resolve)),
  }
  return {
    listener,
    serveHttp(connection: any) {
      let served = false
      return { close() {}, nextRequest() {
        if (served) return Promise.resolve(null)
        served = true
        return Promise.resolve({ request: connection.request, respondWith: connection.respond })
      } }
    },
    request(request: Request): Promise<Response> {
      return new Promise((respond) => {
        const connection = { request, respond, localAddr: listener.addr, remoteAddr: { ...listener.addr, port: 8124 } }
        const waiter = waiters.shift()
        if (waiter) waiter(connection)
        else queued.push(connection)
      })
    },
  }
}

const SALES = { fencing: 'I9t8njpuR0Dm7B2NDcvI', patio: 'OGZLpPPVWVarN94HL6af' } as const
const EXEC = { fencing: 'fgV2mkFh6BD4gOZZx94y', patio: 'SxayUz0KRDlCUk58apCC' } as const
const SALES_ACCEPTED = { fencing: '338b7dd7-7220-4abc-bc0b-b8d9ea44f40e', patio: 'a0f3002f-db71-4b69-842a-12930bdd7591' } as const
const SALES_MID = { fencing: '7ef6fca1-9645-4323-b6d5-a58bd9e3db81', patio: 'cbd0a3b5-0000-4000-8000-000000000001' } as const
// Every stage each pipeline accepts in this fake: the Execution stages the
// office statuses map to (ghl-proxy OPS_TO_GHL_STAGES), and Sales stages.
const EXEC_STAGES: Record<string, Set<string>> = {
  [EXEC.fencing]: new Set([
    'c1615373-9140-4e49-92aa-aa0cfa8e9793', 'c0e34aa5-c113-4485-a962-33eadd7be4de',
    '6d57806c-314c-47e5-a681-d163c10ed27e', 'f622844c-2fac-4627-81d4-978a6a864c72',
    'c065222d-7364-412d-9a7b-42e699764d1f',
  ]),
  [EXEC.patio]: new Set([
    '66742bf8-4917-406c-a1c1-33ac271cfe09', '48f6871b-2d6c-4679-86a6-5b7bd602a6a8',
    '4dfa654d-4d7c-491b-89dc-39717fc8e911', '54d52061-6fca-4dfe-a421-f35a3b88d434',
    '0276706b-faeb-44ff-b049-efce11a96a7f',
  ]),
}

// The refused shapes from the 11-12 Nov 2026 function logs, with the stage
// each status maps to.
const REFUSED_SHAPES: Array<{ type: 'fencing' | 'patio'; status: string; stage: string }> = [
  { type: 'patio', status: 'invoiced', stage: '0276706b-faeb-44ff-b049-efce11a96a7f' },
  { type: 'fencing', status: 'invoiced', stage: 'c065222d-7364-412d-9a7b-42e699764d1f' },
  { type: 'fencing', status: 'scheduled', stage: 'c0e34aa5-c113-4485-a962-33eadd7be4de' },
  { type: 'fencing', status: 'in_progress', stage: '6d57806c-314c-47e5-a681-d163c10ed27e' },
  { type: 'patio', status: 'approvals', stage: '66742bf8-4917-406c-a1c1-33ac271cfe09' },
  { type: 'patio', status: 'scheduled', stage: '48f6871b-2d6c-4679-86a6-5b7bd602a6a8' },
  { type: 'patio', status: 'in_progress', stage: '4dfa654d-4d7c-491b-89dc-39717fc8e911' },
  { type: 'fencing', status: 'complete', stage: 'f622844c-2fac-4627-81d4-978a6a864c72' },
]

type Opp = { id: string; pipelineId: string; pipelineStageId: string; contactId: string; status: string; createdAt: string; lastStageChangeAt: string }

Deno.test('move_stage and move_to_complete send Execution stages only to an Execution opportunity', async (t) => {
  const env = {
    SUPABASE_URL: 'https://stage-move.test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service',
    SW_API_KEY: 'synthetic-shared', GHL_API_TOKEN: 'synthetic-ghl', GHL_LOCATION_ID: 'synthetic-location',
  }
  const names = [...Object.keys(env), 'GHL_TEST_PIPELINE_ID', 'GHL_TEST_LOCATION_ID', 'SUPABASE_TEST_ORG_ID', 'GHL_PROXY_REQUIRE_USER_JWT_FOR_BROWSER_ACTIONS']
  const before = new Map(names.map((k) => [k, Deno.env.get(k)]))
  for (const k of names) Deno.env.delete(k)
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v)
  const h = server()
  const listen = Object.getOwnPropertyDescriptor(Deno, 'listen')
  const serve = Object.getOwnPropertyDescriptor(Deno, 'serveHttp')
  const realFetch = globalThis.fetch
  Object.defineProperty(Deno, 'listen', { configurable: true, value: () => h.listener })
  Object.defineProperty(Deno, 'serveHttp', { configurable: true, value: h.serveHttp })

  let opps = new Map<string, Opp>()
  let puts: Array<{ id: string; stage: string; ok: boolean }> = []
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init), u = new URL(req.url)
    if (u.origin !== 'https://services.leadconnectorhq.com') throw Error('Unexpected request: ' + req.method + ' ' + u.href)
    if (u.pathname === '/opportunities/search' && req.method === 'GET') {
      const pipelineId = u.searchParams.get('pipelineId'), contactId = u.searchParams.get('contactId')
      const rows = [...opps.values()].filter((o) => (!pipelineId || o.pipelineId === pipelineId) && (!contactId || o.contactId === contactId))
      return Response.json({ opportunities: rows, meta: { total: rows.length } })
    }
    const m = u.pathname.match(/^\/opportunities\/([^/]+)$/)
    if (m && req.method === 'GET') {
      const opp = opps.get(m[1])
      return opp ? Response.json({ opportunity: opp }) : Response.json({ statusCode: 404, code: 'OPPORTUNITY_NOT_FOUND' }, { status: 404 })
    }
    if (m && req.method === 'PUT') {
      const stage = (await req.json()).pipelineStageId
      const opp = opps.get(m[1])
      const ok = !!opp && !!EXEC_STAGES[opp.pipelineId]?.has(stage)
      puts.push({ id: m[1], stage, ok })
      if (!ok) {
        return Response.json({ statusCode: 400, error: 'Bad Request', message: 'stageId must be one of the following values: ...', code: 'OPPORTUNITY_STAGE_ID_INVALID' }, { status: 400 })
      }
      opp!.pipelineStageId = stage
      return Response.json({ opportunity: opp })
    }
    throw Error('Unexpected GoHighLevel call: ' + req.method + ' ' + u.pathname)
  }

  const post = async (action: string, body: unknown) => {
    const res = await h.request(new Request(`https://proxy.test.invalid/?action=${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.SW_API_KEY }, body: JSON.stringify(body),
    }))
    return { status: res.status, body: await res.json() }
  }
  const reset = (rows: Opp[]) => { opps = new Map(rows.map((o) => [o.id, { ...o }])); puts = [] }
  const salesOpp = (type: 'fencing' | 'patio', atAccepted: boolean): Opp => ({
    id: 'sales-opp', pipelineId: SALES[type], pipelineStageId: atAccepted ? SALES_ACCEPTED[type] : SALES_MID[type],
    contactId: 'contact-a', status: atAccepted ? 'won' : 'open',
    createdAt: '2026-10-01T00:00:00.000Z', lastStageChangeAt: '2026-11-02T01:12:59.000Z',
  })
  const execOpp = (type: 'fencing' | 'patio', id: string, createdAt: string, status = 'won'): Opp => ({
    id, pipelineId: EXEC[type], pipelineStageId: EXEC_STAGES[EXEC[type]].values().next().value!,
    contactId: 'contact-a', status, createdAt, lastStageChangeAt: createdAt,
  })

  try {
    const entrypoint = './index' + '.ts'
    await import(entrypoint)

    for (const shape of REFUSED_SHAPES) {
      const label = `${shape.type} ${shape.status}`
      await t.step(`${label}: Sales opportunity with no Execution opportunity yet is not moved and says so`, async () => {
        reset([salesOpp(shape.type, false)])
        const r = await post('move_stage', { opportunityId: 'sales-opp', status: shape.status, jobType: shape.type })
        eq(puts, [], `${label} PUTs`)
        eq([r.status, r.body.success, r.body.moved, r.body.reason], [200, false, false, 'execution_opportunity_not_created'], label)
      })
      await t.step(`${label}: Sales opportunity whose Execution opportunity exists moves the Execution one`, async () => {
        reset([salesOpp(shape.type, true), execOpp(shape.type, 'exec-opp', '2026-11-02T01:13:04.889Z')])
        const r = await post('move_stage', { opportunityId: 'sales-opp', status: shape.status, jobType: shape.type })
        eq(puts, [{ id: 'exec-opp', stage: shape.stage, ok: true }], `${label} PUTs`)
        eq([r.body.success, r.body.moved, r.body.opportunityId, r.body.salesOpportunityId, r.body.stageId], [true, true, 'exec-opp', 'sales-opp', shape.stage], label)
        eq(opps.get('sales-opp')!.pipelineStageId, SALES_ACCEPTED[shape.type], `${label} Sales stage untouched`)
      })
    }

    await t.step('an Execution opportunity from an earlier job (created before this Sales accept) is never the target', async () => {
      reset([salesOpp('fencing', true), execOpp('fencing', 'old-exec', '2026-03-01T00:00:00.000Z')])
      const r = await post('move_stage', { opportunityId: 'sales-opp', status: 'scheduled', jobType: 'fencing' })
      eq(puts, [])
      eq(r.body.reason, 'execution_opportunity_not_created')
    })
    await t.step('two matching Execution opportunities are ambiguous and nothing moves', async () => {
      reset([salesOpp('patio', true), execOpp('patio', 'exec-1', '2026-11-02T01:13:04.000Z'), execOpp('patio', 'exec-2', '2026-11-03T00:00:00.000Z')])
      const r = await post('move_stage', { opportunityId: 'sales-opp', status: 'scheduled', jobType: 'patio' })
      eq(puts, [])
      eq(r.body.reason, 'execution_opportunity_ambiguous')
    })
    await t.step('a lost Execution opportunity is not a target', async () => {
      reset([salesOpp('fencing', true), execOpp('fencing', 'lost-exec', '2026-11-02T01:13:04.000Z', 'lost')])
      const r = await post('move_stage', { opportunityId: 'sales-opp', status: 'invoiced', jobType: 'fencing' })
      eq(puts, [])
      eq(r.body.reason, 'execution_opportunity_not_created')
    })
    await t.step('control: a job already pointing at its Execution opportunity moves it as before', async () => {
      reset([execOpp('patio', 'exec-own', '2026-11-02T01:13:04.000Z')])
      const r = await post('move_stage', { opportunityId: 'exec-own', status: 'in_progress', jobType: 'patio' })
      eq(puts, [{ id: 'exec-own', stage: '4dfa654d-4d7c-491b-89dc-39717fc8e911', ok: true }])
      eq(r.body.success, true)
    })
    await t.step('control: a caller-chosen Sales stageId still goes to the named opportunity', async () => {
      reset([salesOpp('fencing', false)])
      opps.get('sales-opp')!.pipelineId = 'sales-any'
      EXEC_STAGES['sales-any'] = new Set([SALES_ACCEPTED.fencing])
      const r = await post('move_stage', { opportunityId: 'sales-opp', stageId: SALES_ACCEPTED.fencing, jobType: 'fencing' })
      eq(puts, [{ id: 'sales-opp', stage: SALES_ACCEPTED.fencing, ok: true }])
      eq(r.body.success, true)
      delete EXEC_STAGES['sales-any']
    })
    await t.step('move_to_complete: Sales opportunity with no Execution opportunity sends nothing and says why', async () => {
      reset([salesOpp('patio', false)])
      const r = await post('move_to_complete', { opportunityId: 'sales-opp', jobType: 'patio' })
      eq(puts, [])
      eq([r.body.stageMoved, r.body.reason], [false, 'execution_opportunity_not_created'])
    })
    await t.step('move_to_complete: moves the Execution opportunity when it exists', async () => {
      reset([salesOpp('fencing', true), execOpp('fencing', 'exec-opp', '2026-11-02T01:13:04.889Z')])
      const r = await post('move_to_complete', { opportunityId: 'sales-opp', jobType: 'fencing' })
      eq(puts, [{ id: 'exec-opp', stage: 'f622844c-2fac-4627-81d4-978a6a864c72', ok: true }])
      eq([r.body.stageMoved, r.body.opportunityId], [true, 'exec-opp'])
    })
  } finally {
    globalThis.fetch = realFetch
    if (listen) Object.defineProperty(Deno, 'listen', listen)
    if (serve) Object.defineProperty(Deno, 'serveHttp', serve)
    for (const [k, v] of before) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v) }
  }
})
