// Handler-level test of the public /accept route for a run (partial fence)
// acceptance, with quote_accept_atomic_v1 on and off. Drives the real
// sendQuoteHandler with a fake client that records every call in order.
// External HTTP is stubbed (it only serves the response-page upload).
//
// Proves, on the atomic path: the acceptance goes through one RPC carrying
// the run label, the snapshot's neighbour and an acceptance event; none of
// the legacy split writes run; the after-commit business event uses the
// acceptance instant; the handler-finished mark comes after the commit, for
// the same request. On the legacy path: today's writes run and no RPC does.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts"

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-placeholder')
const realFetch = globalThis.fetch
const fetched: string[] = []
globalThis.fetch = ((input: Request | URL | string) => {
  fetched.push(String(input instanceof Request ? input.url : input))
  return Promise.resolve(new Response(JSON.stringify({ Key: 'quote-views/x' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }))
}) as typeof fetch
const { sendQuoteHandler } = await import('./index.ts')

type Call = { kind: 'from' | 'rpc'; name: string; ops: Array<[string, unknown[]]>; args?: Record<string, unknown> }

const DOC = {
  id: 'd-1', job_id: 'j-1', type: 'quote', share_token: 'tok-1', sent_to_client: true, run_label: 'A',
  job_contact_id: 'c-1', accepted_at: null, declined_at: null, superseded_at: null,
  sent_at: '2026-10-18T00:00:00+00:00', send_claimed_at: null, created_at: '2026-10-17T00:00:00+00:00',
  version: 1, data_snapshot_json: null,
}
const DOC_READ = { ...DOC, job_contacts: { id: 'c-1', contact_label: 'Neighbour', client_name: 'N One', share_percentage: 50, quote_value_ex_gst: 1000 } }
const JOB = { id: 'j-1', job_number: 'SWF-TEST', client_name: 'Client', type: 'fencing', pricing_json: {}, site_address: '1 Test St', site_suburb: 'Testville', ghl_contact_id: null }

function fakeClient(atomicOn: boolean) {
  const calls: Call[] = []
  const resolve = (c: Call): { data: unknown; error: unknown } => {
    const has = (op: string) => c.ops.some(([m]) => m === op)
    const eqArg = (col: string) => c.ops.find(([m, a]) => m === 'eq' && a[0] === col)?.[1][1]
    switch (c.name) {
      case 'feature_flags':
        return { data: [{ enabled: eqArg('flag_name') === 'quote_accept_atomic_v1' ? atomicOn : false }], error: null }
      case 'job_documents':
        if (has('update')) return { data: null, error: null }
        if (eqArg('share_token') !== undefined) return { data: DOC_READ, error: null }
        return { data: [DOC], error: null }
      case 'jobs':
        if (has('update')) return { data: null, error: null }
        return { data: JOB, error: null }
      case 'run_line_items':
        return { data: [{ job_contact_id: 'c-2' }], error: null }
      default:
        return { data: [], error: null }
    }
  }
  const builder = (c: Call) => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'neq', 'not', 'in', 'limit', 'order', 'update', 'upsert', 'insert', 'delete', 'gte', 'lte']) {
      b[m] = (...a: unknown[]) => { c.ops.push([m, a]); return b }
    }
    b.single = () => { c.ops.push(['single', []]); return Promise.resolve(resolve(c)) }
    b.maybeSingle = b.single
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve(c)).then(ok, bad)
    return b
  }
  const sb = {
    calls,
    from(name: string) {
      const c: Call = { kind: 'from', name, ops: [] }
      calls.push(c)
      return builder(c)
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ kind: 'rpc', name, ops: [], args })
      switch (name) {
        case 'quote_acceptance_snapshot':
          return Promise.resolve({ data: {
            fingerprint: 'fp-1', documents: [DOC], acceptances: [],
            run_line_items: [{ run_label: 'A', job_contact_id: 'c-2' }], run_neighbour: 'c-2',
          }, error: null })
        case 'accept_quote_document_atomic':
          return Promise.resolve({ data: { outcome: 'accepted', request_id: args.p_request_id, job_status: args.p_job_status }, error: null })
        case 'automation_lane_enabled':
          return Promise.resolve({ data: true, error: null })
        default:
          return Promise.resolve({ data: true, error: null })
      }
    },
    storage: { from: () => ({ upload: () => Promise.resolve({}), getPublicUrl: () => ({ data: { publicUrl: 'x' } }) }) },
  }
  return sb
}

const acceptRequest = () => new Request('http://local/send-quote/accept?token=tok-1', { method: 'POST' })
const writes = (calls: Call[], table: string, op: string) =>
  calls.filter((c) => c.kind === 'from' && c.name === table && c.ops.some(([m]) => m === op))

Deno.test('atomic run acceptance: one RPC with its event, no split writes, event instant, finish after commit', async () => {
  const sb = fakeClient(true)
  const res = await sendQuoteHandler(acceptRequest(), { sb })
  assertEquals(res.status, 302, 'the waiting page redirect, as today')
  const order = sb.calls.map((c) => c.kind === 'rpc' ? `rpc:${c.name}` : c.name)
  const accepts = sb.calls.filter((c) => c.kind === 'rpc' && c.name === 'accept_quote_document_atomic')
  assertEquals(accepts.length, 1)
  const a = accepts[0].args!
  assertEquals([a.p_document_id, a.p_share_token, a.p_run_label, a.p_run_neighbour, a.p_job_status, a.p_fingerprint],
    ['d-1', 'tok-1', 'A', 'c-2', 'partially_accepted', 'fp-1'])
  assert(a.p_accept_event && typeof a.p_accept_event === 'object', 'a run acceptance carries its acceptance event')
  assertEquals((a.p_accept_event as Record<string, unknown>).contact_id, 'c-1')
  // None of today's split writes ran.
  assertEquals(writes(sb.calls, 'job_documents', 'update').length, 0)
  assertEquals(writes(sb.calls, 'run_acceptances', 'upsert').length, 0)
  assertEquals(writes(sb.calls, 'jobs', 'update').length, 0)
  assertEquals(writes(sb.calls, 'run_line_items', 'select').length, 0, 'the neighbour comes from the snapshot')
  // The after-commit business event carries the acceptance instant (R2).
  const runEvents = writes(sb.calls, 'business_events', 'insert')
    .map((c) => c.ops.find(([m]) => m === 'insert')![1][0] as Record<string, unknown>)
    .filter((row) => row.event_type === 'quote.run_accepted')
  assertEquals(runEvents.length, 1)
  assertEquals(runEvents[0].occurred_at, a.p_accepted_at)
  // Finish comes after the commit, for the same request.
  const iAccept = order.indexOf('rpc:accept_quote_document_atomic')
  const iFinish = order.indexOf('rpc:quote_acceptance_handler_finished')
  assert(iAccept >= 0 && iFinish > iAccept, order.join(' > '))
  const finish = sb.calls.find((c) => c.name === 'quote_acceptance_handler_finished')!
  assertEquals(finish.args, { p_document_id: 'd-1', p_request_id: a.p_request_id })
  assert(order.indexOf('rpc:quote_acceptance_snapshot') < order.findIndex((n, i) => n === 'job_documents' && i > 0),
    'the snapshot is read before the guard reads')
})

Deno.test('legacy run acceptance (switch off): today\'s writes, no RPC, no snapshot', async () => {
  const sb = fakeClient(false)
  const res = await sendQuoteHandler(acceptRequest(), { sb })
  assertEquals(res.status, 302)
  const rpcs = sb.calls.filter((c) => c.kind === 'rpc').map((c) => c.name)
  for (const name of ['quote_acceptance_snapshot', 'accept_quote_document_atomic', 'quote_acceptance_handler_finished']) {
    assert(!rpcs.includes(name), `${name} must not be called with the switch off`)
  }
  assertEquals(writes(sb.calls, 'job_documents', 'update').length, 1, 'accepted_at as today')
  assertEquals(writes(sb.calls, 'run_acceptances', 'upsert').length, 1, 'run acceptance as today')
  assertEquals(writes(sb.calls, 'jobs', 'update').length, 1, 'status as today')
  assertEquals(writes(sb.calls, 'run_line_items', 'select').length, 1, 'neighbour read as today')
})

Deno.test({ name: 'restore fetch', fn: () => { globalThis.fetch = realFetch }, sanitizeOps: false, sanitizeResources: false })
