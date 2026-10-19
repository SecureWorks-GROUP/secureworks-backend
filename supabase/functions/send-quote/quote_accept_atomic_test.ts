import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts"
import {
  acceptQuoteDocumentAtomically,
  type AtomicAcceptInput,
  finishAtomicAcceptance,
  quoteAcceptAtomicOn,
  quoteDocumentMatchesSnapshot,
  quoteGuardsPassOnSnapshot,
  type QuoteAcceptanceSnapshotRead,
  readQuoteAcceptanceSnapshot,
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

Deno.test('a failed or malformed snapshot read is null, so the caller writes nothing', async () => {
  const good = { fingerprint: 'fp', documents: [], acceptances: [], run_line_items: [], run_neighbour: 'n1' }
  const read = await readQuoteAcceptanceSnapshot(fakeClient({}, { quote_acceptance_snapshot: { data: good } }), 'j', 'A')
  assertEquals([read?.fingerprint, read?.runNeighbour], ['fp', 'n1'])
  const sb = fakeClient({}, { quote_acceptance_snapshot: { data: { ...good, run_neighbour: null } } })
  assertEquals((await readQuoteAcceptanceSnapshot(sb, 'j', null))?.runNeighbour, null)
  assertEquals(sb.calls[0].args, { p_job_id: 'j', p_run_label: null })
  for (const bad of [{ error: { code: '57014' } }, { data: null }, { data: { ...good, fingerprint: null } },
    { data: { ...good, documents: null } }, boom as () => never]) {
    assertEquals(await readQuoteAcceptanceSnapshot(fakeClient({}, { quote_acceptance_snapshot: bad as Result }), 'j', null), null)
  }
})

const docRow = {
  id: 'd-1', job_contact_id: null, run_label: null, sent_to_client: true, share_token: 'tok',
  sent_at: '2026-10-18T00:00:00+00:00', send_claimed_at: null, accepted_at: null, declined_at: null,
  superseded_at: null, created_at: '2026-10-17T00:00:00+00:00', version: 1, data_snapshot_json: null,
}
const snap = (documents: unknown[], extra: Partial<QuoteAcceptanceSnapshotRead> = {}) =>
  ({ fingerprint: 'fp', documents, acceptances: [], runLineItems: [], runNeighbour: null, ...extra }) as QuoteAcceptanceSnapshotRead

Deno.test('the handler document must be exactly its snapshot row and current token', () => {
  const doc = { ...docRow, sent_at: '2026-10-18T00:00:00.000Z', job_id: 'j', job_contacts: null }
  assertEquals(quoteDocumentMatchesSnapshot(doc, snap([docRow]), 'tok'), true, 'same instant in another format')
  assertEquals(quoteDocumentMatchesSnapshot(doc, snap([docRow]), 'old-token'), false, 'rotated token')
  for (const [field, value] of [['run_label', 'A'], ['version', 2], ['job_contact_id', 'c'], ['sent_to_client', false],
    ['send_claimed_at', '2026-10-18T01:00:00Z'], ['declined_at', '2026-10-18T01:00:00Z'],
    ['data_snapshot_json', { run: { run_label: 'A' } }]] as const) {
    assertEquals(quoteDocumentMatchesSnapshot(doc, snap([{ ...docRow, [field]: value }]), 'tok'), false, field)
  }
  assertEquals(quoteDocumentMatchesSnapshot(doc, snap([]), 'tok'), false, 'missing row')
})

Deno.test('the guards run on the snapshot with the legacy query filters', () => {
  const doc = { ...docRow }
  assertEquals(quoteGuardsPassOnSnapshot(doc, snap([docRow]), null), 'ok')
  assertEquals(quoteGuardsPassOnSnapshot(doc, snap([{ ...docRow, superseded_at: '2026-10-18T00:00:00Z' }]), null), 'superseded')
  const sibling = { ...docRow, id: 'd-2', accepted_at: '2026-10-18T00:00:00Z' }
  assertEquals(quoteGuardsPassOnSnapshot(doc, snap([docRow, sibling]), null), 'sibling_accepted')
  assertEquals(quoteGuardsPassOnSnapshot(doc, snap([docRow, { ...sibling, job_contact_id: 'other' }]), null), 'ok',
    'another party\'s acceptance is not a sibling')
  assertEquals(quoteGuardsPassOnSnapshot(doc, snap([docRow, { ...sibling, superseded_at: '2026-10-18T00:00:00Z' }]), null), 'ok')
})

const input: AtomicAcceptInput = {
  documentId: 'd-1',
  shareToken: 'tok',
  requestId: 'r-1',
  acceptedAt: '2026-10-19T12:00:00.000Z',
  jobStatus: 'accepted',
  fingerprint: 'fp',
  runLabel: null,
  runNeighbour: null,
  acceptEvent: { document_id: 'd-1' },
}

Deno.test('the RPC outcomes map one to one, with the inputs passed through', async () => {
  const outcomes: Array<[unknown, unknown]> = [
    [{ outcome: 'accepted', job_status: 'accepted', request_id: 'r-1' }, { kind: 'accepted', recovered: false, jobStatus: 'accepted' }],
    [{ outcome: 'replay', request_id: 'r-0' }, { kind: 'replay' }],
    [{ outcome: 'stale', reason: 'snapshot_changed' }, { kind: 'stale' }],
    [{ outcome: 'refused', reason: 'superseded' }, { kind: 'refused', reason: 'superseded' }],
  ]
  for (const [data, expected] of outcomes) {
    const sb = fakeClient({}, { accept_quote_document_atomic: { data } })
    assertEquals(await acceptQuoteDocumentAtomically(sb, input, 0), expected)
    assertEquals(sb.calls[0].args, {
      p_document_id: 'd-1', p_share_token: 'tok', p_request_id: 'r-1', p_accepted_at: input.acceptedAt,
      p_job_status: 'accepted', p_fingerprint: 'fp', p_run_label: null, p_run_neighbour: null, p_accept_event: { document_id: 'd-1' },
    })
  }
})

Deno.test('a run acceptance passes its run label and neighbour through', async () => {
  const sb = fakeClient({}, { accept_quote_document_atomic: { data: { outcome: 'accepted', request_id: 'r-1', job_status: 'quoted' } } })
  await acceptQuoteDocumentAtomically(sb, { ...input, runLabel: 'A', runNeighbour: 'n1', jobStatus: 'quoted', acceptEvent: null }, 0)
  const args = sb.calls[0].args as Record<string, unknown>
  assertEquals([args.p_run_label, args.p_run_neighbour, args.p_job_status, args.p_accept_event], ['A', 'n1', 'quoted', null])
})

Deno.test('a database error (SQLSTATE) is a confirmed rollback: failed, never accepted', async () => {
  const sb = fakeClient({ quote_acceptance_attempts: { data: [{ request_id: 'r-1', job_status: 'accepted' }] } },
    { accept_quote_document_atomic: { error: { code: 'P0001', message: 'quote_option_unrecorded' } } })
  assertEquals(await acceptQuoteDocumentAtomically(sb, input, 0), { kind: 'failed' })
  assertEquals(sb.calls.some((c) => c.name === 'quote_acceptance_attempts'), false, 'no recovery read after a refusal')
})

Deno.test('a lost response is recovered by request id, never by instant', async () => {
  const lost = [{ error: { message: 'TypeError: fetch failed', code: '' } }, boom as () => never]
  for (const failure of lost) {
    const mine = fakeClient({ quote_acceptance_attempts: { data: [{ request_id: 'r-1', job_status: 'partially_accepted' }] } },
      { accept_quote_document_atomic: failure as Result })
    assertEquals(await acceptQuoteDocumentAtomically(mine, input, 0), { kind: 'accepted', recovered: true, jobStatus: 'partially_accepted' })
    const theirs = fakeClient({ quote_acceptance_attempts: { data: [{ request_id: 'r-other', job_status: 'accepted' }] } },
      { accept_quote_document_atomic: failure as Result })
    assertEquals(await acceptQuoteDocumentAtomically(theirs, input, 0), { kind: 'replay' }, 'same instant, other request')
    const none = fakeClient({ quote_acceptance_attempts: { data: [] } }, { accept_quote_document_atomic: failure as Result })
    assertEquals(await acceptQuoteDocumentAtomically(none, input, 0), { kind: 'unknown' })
    assertEquals(none.calls.filter((c) => c.name === 'quote_acceptance_attempts').length, 2, 'one re-read after a wait')
    const unreadable = fakeClient({ quote_acceptance_attempts: { error: { code: '57014' } } },
      { accept_quote_document_atomic: failure as Result })
    assertEquals(await acceptQuoteDocumentAtomically(unreadable, input, 0), { kind: 'unknown' })
  }
  const odd = fakeClient({ quote_acceptance_attempts: { data: [] } }, { accept_quote_document_atomic: { data: { outcome: 'surprise' } } })
  assertEquals(await acceptQuoteDocumentAtomically(odd, input, 0), { kind: 'unknown' })
  const wrongOwner = fakeClient({ quote_acceptance_attempts: { data: [{ request_id: 'r-other', job_status: 'accepted' }] } },
    { accept_quote_document_atomic: { data: { outcome: 'accepted', request_id: 'r-other' } } })
  assertEquals(await acceptQuoteDocumentAtomically(wrongOwner, input, 0), { kind: 'replay' })
})

Deno.test('finishing is a no-op on the legacy path, sends the request id, and never throws', async () => {
  const legacy = fakeClient({}, {})
  await finishAtomicAcceptance(legacy, null, 'r-1')
  assertEquals(legacy.calls.length, 0)
  const atomic = fakeClient({}, { quote_acceptance_handler_finished: boom as () => never })
  await finishAtomicAcceptance(atomic, 'd-1', 'r-1')
  assertEquals(atomic.calls.map((c) => [c.name, c.args]), [['quote_acceptance_handler_finished', { p_document_id: 'd-1', p_request_id: 'r-1' }]])
})
