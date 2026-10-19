import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts"
import {
  acceptQuoteDocumentAtomically,
  type AtomicAcceptInput,
  finishAtomicAcceptance,
  quoteAcceptAtomicOn,
  readQuoteAcceptanceFingerprint,
} from './quote_accept_atomic.ts'

// A fake client: table reads return `reads[table]`; rpc calls return
// `rpcs[name]` (a value, or a function of the args). Every call is logged.
type Result = { data?: unknown; error?: unknown } | (() => never)
function fakeClient(reads: Record<string, Result>, rpcs: Record<string, Result | ((args: unknown) => Result)>) {
  const calls: Array<{ kind: string; name: string; args?: unknown }> = []
  const settle = (r: Result) => {
    if (typeof r === 'function') return r()
    return { data: r.data ?? null, error: r.error ?? null }
  }
  const query = (table: string) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'limit', 'is', 'single']) q[m] = () => q
    q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
      try {
        return Promise.resolve(settle(reads[table] ?? { data: [] })).then(ok, bad)
      } catch (e) {
        return Promise.reject(e).then(ok, bad)
      }
    }
    return q
  }
  return {
    calls,
    from(table: string) {
      calls.push({ kind: 'from', name: table })
      return query(table)
    },
    rpc(name: string, args: unknown) {
      calls.push({ kind: 'rpc', name, args })
      const r = rpcs[name]
      const v = typeof r === 'function' && r.length === 1 ? (r as (a: unknown) => Result)(args) : r as Result
      try {
        return Promise.resolve(settle(v ?? { data: null }))
      } catch (e) {
        return Promise.reject(e)
      }
    },
  }
}
const boom = () => { throw new Error('connection reset') }

Deno.test('the atomic switch is on only for a readable true', async () => {
  const cases: Array<[Result, boolean]> = [
    [{ data: [{ enabled: true }] }, true],
    [{ data: [{ enabled: false }] }, false],
    [{ data: [{ enabled: null }] }, false],
    [{ data: [{ enabled: 'true' }] }, false],
    [{ data: [] }, false],
    [{ data: null }, false],
    [{ error: { message: 'permission denied' } }, false],
    [boom as () => never, false],
  ]
  for (const [read, expected] of cases) {
    const sb = fakeClient({ feature_flags: read }, {})
    assertEquals(await quoteAcceptAtomicOn(sb), expected, JSON.stringify(read))
  }
})

Deno.test('a failed fingerprint read is null, so the caller writes nothing', async () => {
  assertEquals(await readQuoteAcceptanceFingerprint(fakeClient({}, { quote_acceptance_fingerprint: { data: 'abc' } }), 'j'), 'abc')
  assertEquals(await readQuoteAcceptanceFingerprint(fakeClient({}, { quote_acceptance_fingerprint: { error: { code: '57014' } } }), 'j'), null)
  assertEquals(await readQuoteAcceptanceFingerprint(fakeClient({}, { quote_acceptance_fingerprint: boom as () => never }), 'j'), null)
  assertEquals(await readQuoteAcceptanceFingerprint(fakeClient({}, { quote_acceptance_fingerprint: { data: null } }), 'j'), null)
})

const input: AtomicAcceptInput = {
  documentId: 'd-1',
  acceptedAt: '2026-10-19T12:00:00.000Z',
  jobStatus: 'accepted',
  fingerprint: 'fp',
  runLabel: null,
  acceptEvent: { document_id: 'd-1' },
}

Deno.test('the RPC outcomes map one to one, with the inputs passed through', async () => {
  const outcomes: Array<[unknown, unknown]> = [
    [{ outcome: 'accepted', job_status: 'accepted' }, { kind: 'accepted', recovered: false, jobStatus: 'accepted' }],
    [{ outcome: 'replay' }, { kind: 'replay' }],
    [{ outcome: 'stale', reason: 'snapshot_changed' }, { kind: 'stale' }],
    [{ outcome: 'refused', reason: 'superseded' }, { kind: 'refused', reason: 'superseded' }],
  ]
  for (const [data, expected] of outcomes) {
    const sb = fakeClient({}, { accept_quote_document_atomic: { data } })
    assertEquals(await acceptQuoteDocumentAtomically(sb, input), expected)
    assertEquals(sb.calls[0].args, {
      p_document_id: 'd-1', p_accepted_at: input.acceptedAt, p_job_status: 'accepted',
      p_fingerprint: 'fp', p_run_label: null, p_accept_event: { document_id: 'd-1' },
    })
  }
})

Deno.test('a database error with no attempt row is failed (retry page), never accepted', async () => {
  const sb = fakeClient({ quote_acceptance_attempts: { data: [] } },
    { accept_quote_document_atomic: { error: { code: 'P0001', message: 'quote_option_unrecorded' } } })
  assertEquals(await acceptQuoteDocumentAtomically(sb, input), { kind: 'failed' })
})

Deno.test('a lost response whose commit happened is recovered for this request only', async () => {
  const mine = fakeClient({ quote_acceptance_attempts: { data: [{ document_id: 'd-1', job_status: 'partially_accepted', accepted_at: '2026-10-19T12:00:00+00:00' }] } },
    { accept_quote_document_atomic: boom as () => never })
  assertEquals(await acceptQuoteDocumentAtomically(mine, input), { kind: 'accepted', recovered: true, jobStatus: 'partially_accepted' })
  const theirs = fakeClient({ quote_acceptance_attempts: { data: [{ document_id: 'd-1', job_status: 'accepted', accepted_at: '2026-10-19T11:59:59+00:00' }] } },
    { accept_quote_document_atomic: boom as () => never })
  assertEquals(await acceptQuoteDocumentAtomically(theirs, input), { kind: 'failed' })
  const unreadable = fakeClient({ quote_acceptance_attempts: { error: { code: '57014' } } },
    { accept_quote_document_atomic: boom as () => never })
  assertEquals(await acceptQuoteDocumentAtomically(unreadable, input), { kind: 'failed' })
  const odd = fakeClient({ quote_acceptance_attempts: { data: [] } }, { accept_quote_document_atomic: { data: { outcome: 'surprise' } } })
  assertEquals(await acceptQuoteDocumentAtomically(odd, input), { kind: 'failed' })
})

Deno.test('finishing is a no-op on the legacy path and never throws', async () => {
  const legacy = fakeClient({}, {})
  await finishAtomicAcceptance(legacy, null)
  assertEquals(legacy.calls.length, 0)
  const atomic = fakeClient({}, { quote_acceptance_finish_downstream: boom as () => never })
  await finishAtomicAcceptance(atomic, 'd-1')
  assertEquals(atomic.calls.map((c) => c.name), ['quote_acceptance_finish_downstream'])
})
