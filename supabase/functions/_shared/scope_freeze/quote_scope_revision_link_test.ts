// JP-24 slice 1: the send-time link from a quote_revisions row to the frozen
// scope revision it was sent from (quote_scope_revision_link.ts), plus the D21
// regression pin (a frozen revision's canonical text keeps scope line ids).
//
// No network, no live Supabase: an in-memory client that answers only the
// query shapes the helpers call and throws on anything else.

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { canonicalJsonAndHash } from '../release_packet/canonicalize.ts'
import { freezeScope } from './scope_freeze.ts'
import {
  quoteScopeRevisionIdForRelease,
  quoteScopeRevisionIdForSend,
  resolveQuoteScopeRevisionLink,
  sentQuoteSourceHashes,
  startNamedScopeRevisionRead,
} from './quote_scope_revision_link.ts'

type Row = Record<string, unknown>
type Tables = Record<string, Row[]>
type Read = { table: string; cols: string | null; filters: Array<[string, unknown]>; limit: number | null }

const JOB = 'a1b2c3d4-0000-4000-8000-000000000001'

// A SYNTHETIC fence scope with line ids. Real fence scopes carry no
// lines[].id until Sales' INT-23 half lands; the ids here prove what
// freeze_scope keeps once they exist (D21), plus a patio-style revision block.
const SCOPE = {
  tool: 'fence',
  lines: [
    { id: 'line-rhs-1', label: 'RHS', metres: 12.4, height: 1.8 },
    { id: 'line-rear-2', label: 'Rear', metres: 20, height: 1.8 },
  ],
  revision: { scopeRevisionId: 'sr-7', parentRevisionId: 'sr-6', frozenId: 'fz-1', catalogueRevisionId: 'cat-3' },
  job: { siteAddress: '1 Test St' },
}
const PRICING = { totalIncGST: 5500, totalExGST: 5000, gst: 500, lines: [{ id: 'line-rhs-1', ex: 2000 }] }

function makeClient(tables: Tables, opts: {
  jobsError?: boolean
  revisionsError?: boolean
  throwOn?: 'jobs' | 'scope_revisions'
  hangOn?: 'jobs' | 'scope_revisions'
} = {}) {
  const reads: Read[] = []
  let seq = 0
  const client = {
    reads,
    tables,
    from(table: string) {
      if (opts.throwOn === table) throw new Error(`client threw on ${table}`)
      const q = {
        method: 'select' as 'select' | 'insert' | 'update',
        cols: null as string | null,
        filters: [] as Array<[string, unknown]>,
        orderBy: null as { col: string; asc: boolean } | null,
        limitN: null as number | null,
        payload: null as Row | null,
        select(cols: string) { if (this.method === 'select') this.cols = cols; return this },
        insert(p: Row) { this.method = 'insert'; this.payload = p; return this },
        update(p: Row) { this.method = 'update'; this.payload = p; return this },
        eq(c: string, v: unknown) { this.filters.push([c, v]); return this },
        order(c: string, o: { ascending?: boolean } = {}) { this.orderBy = { col: c, asc: o.ascending !== false }; return this },
        limit(n: number) { this.limitN = n; return this },
        run(): { data: any; error: any } {
          if (this.method === 'insert') {
            const row = { id: `rev-${++seq}`, ...this.payload } as Row
            ;(tables[table] ??= []).push(row)
            return { data: [row], error: null }
          }
          const hit = (tables[table] ?? []).filter((r) => this.filters.every(([c, v]) => r[c] === v))
          if (this.method === 'update') {
            for (const r of hit) Object.assign(r, this.payload)
            return { data: hit, error: null }
          }
          reads.push({ table, cols: this.cols, filters: [...this.filters], limit: this.limitN })
          if (table === 'jobs' && opts.jobsError) return { data: null, error: { code: '57014', message: 'timeout' } }
          if (table === 'scope_revisions' && opts.revisionsError) return { data: null, error: { code: '42P01', message: 'missing' } }
          let rows = [...hit]
          if (this.orderBy) {
            const { col, asc } = this.orderBy
            rows.sort((a, b) => (Number(a[col]) - Number(b[col])) * (asc ? 1 : -1))
          }
          if (this.limitN != null) rows = rows.slice(0, this.limitN)
          return { data: rows, error: null }
        },
        async single() {
          if (opts.hangOn === table) return await new Promise(() => {})
          const r = this.run(); return { data: r.data?.[0] ?? null, error: r.error }
        },
        async maybeSingle() {
          if (opts.hangOn === table) return await new Promise(() => {})
          const r = this.run(); return { data: r.error ? null : (r.data?.[0] ?? null), error: r.error }
        },
        then(onF: any, onR: any) {
          if (opts.hangOn === table) return new Promise(() => {}).then(onF, onR)
          return Promise.resolve(this.run()).then(onF, onR)
        },
      }
      return q
    },
  }
  return client
}

async function frozenRow(id: string, scope: unknown, pricing: unknown, extra: Row = {}): Promise<Row> {
  const s = await canonicalJsonAndHash(scope)
  const p = await canonicalJsonAndHash(pricing)
  return {
    id, job_id: JOB, revision_number: 1, status: 'frozen',
    scope_canonical_text: s.canonical, scope_hash: s.hash,
    pricing_canonical_text: p.canonical, pricing_hash: p.hash,
    ...extra,
  }
}

function jobRow(scope: unknown = SCOPE, pricing: unknown = PRICING): Row {
  return { id: JOB, scope_json: structuredClone(scope), pricing_json: structuredClone(pricing) }
}

const sent = (scope: unknown = SCOPE, pricing: unknown = PRICING) => sentQuoteSourceHashes(scope, pricing)

Deno.test('JP24-L1 the sent document\'s hashes match the one frozen row: its id is the link', async () => {
  const c = makeClient({ jobs: [jobRow()], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
  assertEquals(await resolveQuoteScopeRevisionLink(c, JOB, await sent()), { scope_revision_id: 'rev-frozen', reason: 'matched' })
  assertEquals(await quoteScopeRevisionIdForSend(c, JOB, await sent(), { handler: 'test' }), 'rev-frozen')
})

Deno.test('JP24-L2 key order inside the blobs does not matter (same canonical form freeze_scope hashes)', async () => {
  const reordered = { job: SCOPE.job, revision: SCOPE.revision, lines: SCOPE.lines, tool: SCOPE.tool }
  const c = makeClient({ jobs: [], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
  assertEquals(await quoteScopeRevisionIdForSend(c, JOB, await sent(reordered), { handler: 'test' }), 'rev-frozen')
})

Deno.test('JP24-L3 no provenance on the sent document: null, and nothing is read', async () => {
  const c = makeClient({ jobs: [jobRow()], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
  assertEquals(await resolveQuoteScopeRevisionLink(c, JOB, null), { scope_revision_id: null, reason: 'sent_document_provenance_unavailable' })
  assertEquals(await quoteScopeRevisionIdForSend(c, JOB, undefined, { handler: 'test' }), null)
  assertEquals(c.reads.length, 0)
})

Deno.test('JP24-L4 the job matching the frozen row proves nothing: a quote built from A against job and freeze at B is null', async () => {
  const B = { ...SCOPE, lines: [...SCOPE.lines, { id: 'line-lhs-3', label: 'LHS', metres: 4, height: 1.8 }] }
  const c = makeClient({ jobs: [jobRow(B)], scope_revisions: [await frozenRow('rev-B', B, PRICING)] })
  assertEquals(await resolveQuoteScopeRevisionLink(c, JOB, await sent()), { scope_revision_id: null, reason: 'scope_hash_mismatch', read_revision_id: 'rev-B' })
  assert(!c.reads.some((r) => r.table === 'jobs'), 'jobs is never read')
})

Deno.test('JP24-L5 pricing mismatch, and both: null (no price search)', async () => {
  const c = makeClient({ jobs: [], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
  assertEquals((await resolveQuoteScopeRevisionLink(c, JOB, await sent(SCOPE, { ...PRICING, totalIncGST: 5501 }))).reason, 'pricing_hash_mismatch')
  assertEquals((await resolveQuoteScopeRevisionLink(c, JOB, await sent({ ...SCOPE, tool: 'x' }, { ...PRICING, gst: 1 }))).reason, 'scope_and_pricing_hash_mismatch')
})

Deno.test('JP24-L6 no frozen row (drafts and superseded rows never count): null', async () => {
  const c = makeClient({
    jobs: [],
    scope_revisions: [
      await frozenRow('rev-draft', SCOPE, PRICING, { status: 'draft', revision_number: 2 }),
      await frozenRow('rev-old', SCOPE, PRICING, { status: 'superseded' }),
    ],
  })
  assertEquals((await resolveQuoteScopeRevisionLink(c, JOB, await sent())).reason, 'no_frozen_revision')
})

Deno.test('JP24-L7 several frozen rows: null even when one of them matches', async () => {
  const c = makeClient({
    jobs: [],
    scope_revisions: [
      await frozenRow('rev-a', SCOPE, PRICING, { revision_number: 1 }),
      await frozenRow('rev-b', SCOPE, PRICING, { revision_number: 2 }),
    ],
  })
  assertEquals((await resolveQuoteScopeRevisionLink(c, JOB, await sent())).reason, 'several_frozen_revisions')
})

Deno.test('JP24-L8 another job\'s frozen row is never read as this job\'s', async () => {
  const c = makeClient({ jobs: [], scope_revisions: [await frozenRow('rev-other', SCOPE, PRICING, { job_id: 'other-job' })] })
  assertEquals((await resolveQuoteScopeRevisionLink(c, JOB, await sent())).reason, 'no_frozen_revision')
})

Deno.test('JP24-L9 a failed or thrown scope_revisions read: null, never a throw', async () => {
  const rev = await frozenRow('rev-frozen', SCOPE, PRICING)
  const revErr = makeClient({ jobs: [], scope_revisions: [rev] }, { revisionsError: true })
  assertEquals((await resolveQuoteScopeRevisionLink(revErr, JOB, await sent())).reason, 'revision_read_failed')
  const throws = makeClient({ jobs: [], scope_revisions: [rev] }, { throwOn: 'scope_revisions' })
  assertEquals((await resolveQuoteScopeRevisionLink(throws, JOB, await sent())).reason, 'lookup_threw')
  assertEquals(await quoteScopeRevisionIdForSend(throws, JOB, await sent(), { handler: 'test' }), null)
})

Deno.test('JP24-L10 provenance: blobs freeze_scope would refuse give none; malformed hashes are refused', async () => {
  assertEquals(await sentQuoteSourceHashes(JSON.stringify(SCOPE), PRICING), null)
  assertEquals(await sentQuoteSourceHashes(SCOPE, {}), null)
  const c = makeClient({ jobs: [], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
  assertEquals((await resolveQuoteScopeRevisionLink(c, JOB, { scope_hash: 'x', pricing_hash: 'y' })).reason, 'sent_document_provenance_malformed')
  assertEquals(c.reads.length, 0)
})

Deno.test('JP24-L11 a malformed frozen row (bad hash shape): null', async () => {
  const c = makeClient({ jobs: [], scope_revisions: [await frozenRow('rev-bad', SCOPE, PRICING, { scope_hash: 'nothex' })] })
  assertEquals(await resolveQuoteScopeRevisionLink(c, JOB, await sent()), { scope_revision_id: null, reason: 'revision_row_malformed', read_revision_id: 'rev-bad' })
})

Deno.test('JP24-L12 a read that never answers is cut off at the bound: null, the send is not held', async () => {
  const c = makeClient({ jobs: [], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] }, { hangOn: 'scope_revisions' })
  const started = Date.now()
  assertEquals(await quoteScopeRevisionIdForSend(c, JOB, await sent(), { handler: 'test' }, { timeoutMs: 30 }), null)
  assert(Date.now() - started < 2000, 'the bound cut the lookup off')
})

Deno.test('JP24-L13 reads only what the rule needs: frozen rows of that job, at most two, ids and hashes; never jobs', async () => {
  const c = makeClient({ jobs: [jobRow()], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
  await resolveQuoteScopeRevisionLink(c, JOB, await sent())
  assertEquals(c.reads, [{ table: 'scope_revisions', cols: 'id, scope_hash, pricing_hash', filters: [['job_id', JOB], ['status', 'frozen']], limit: 2 }])
})

Deno.test('JP24-L14 the log line on a null carries ids and a reason only, no customer data', async () => {
  const lines: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
  try {
    const c = makeClient({ jobs: [], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
    assertEquals(await quoteScopeRevisionIdForSend(c, JOB, await sent(SCOPE, { ...PRICING, totalIncGST: 1 }), { handler: 'send-quote/send' }), null)
  } finally {
    console.log = orig
  }
  assertEquals(lines.length, 1)
  const [tag, body] = [lines[0].slice(0, lines[0].indexOf(' ')), JSON.parse(lines[0].slice(lines[0].indexOf(' ') + 1))]
  assertEquals(tag, '[quote-scope-revision-link]')
  assertEquals(body, { job_id: JOB, handler: 'send-quote/send', reason: 'pricing_hash_mismatch', read_revision_id: 'rev-frozen', stored: null })
  assert(!lines[0].includes('Test St') && !lines[0].includes('5500'), 'no scope or price text in the log')
})

// ── JP-24 slice 1b: the revision the producer names (source_scope_revision_id) ──

const REV_A = '0b6f5a3e-2c1d-4e8f-9a7b-1c2d3e4f5a6b'
const OTHER_JOB = 'a1b2c3d4-0000-4000-8000-000000000002'

async function namedLink(c: any, raw: unknown, sentHashes: unknown = null, timeoutMs?: number) {
  const named = startNamedScopeRevisionRead(c, raw, timeoutMs ? { timeoutMs } : {})
  return quoteScopeRevisionIdForRelease(c, JOB, { named, sent: sentHashes as any }, { handler: 'test' })
}

Deno.test('JP24-L15 a named frozen revision of this job: its id, from one read of that row (id, job, status, hashes)', async () => {
  const c = makeClient({ jobs: [jobRow()], scope_revisions: [await frozenRow(REV_A, SCOPE, PRICING)] })
  assertEquals(await namedLink(c, REV_A), REV_A)
  assertEquals(await namedLink(c, REV_A.toUpperCase()), REV_A, 'an upper-case uuid names the same row')
  assertEquals(c.reads[0], { table: 'scope_revisions', cols: 'id, job_id, status, scope_hash, pricing_hash', filters: [['id', REV_A]], limit: null })
  assertEquals(c.reads.some((r) => r.table === 'jobs'), false, 'jobs is never read')
})

Deno.test('JP24-L16 named: another job\'s row, a draft row, a missing row: null', async () => {
  for (const [label, rows] of [
    ['another job', [await frozenRow(REV_A, SCOPE, PRICING, { job_id: OTHER_JOB })]],
    ['draft', [await frozenRow(REV_A, SCOPE, PRICING, { status: 'draft' })]],
    ['missing', []],
    ['malformed row', [await frozenRow(REV_A, SCOPE, PRICING, { scope_hash: 'not-hex' })]],
  ] as Array<[string, Row[]]>) {
    const c = makeClient({ jobs: [jobRow()], scope_revisions: rows })
    assertEquals(await namedLink(c, REV_A), null, label)
  }
})

Deno.test('JP24-L16b named: a row a refreeze superseded before the read is still that sealed row: its id', async () => {
  // Render from A, refreeze to B, then the send arrives naming A (isolated JP-24 proof, 29 Oct).
  const rowA = await frozenRow(REV_A, SCOPE, PRICING, { status: 'superseded' })
  const rowB = await frozenRow('rev-B', SCOPE, PRICING, { revision_number: 2 })
  const c = makeClient({ jobs: [jobRow()], scope_revisions: [rowA, rowB] })
  assertEquals(await namedLink(c, REV_A), REV_A, 'A, never B, even with the same hashes')
  assertEquals(c.reads.length, 1, 'one read of the named row only')
})

Deno.test('JP24-L17 named: a malformed id is refused without a read, and never falls back to the provenance rule', async () => {
  for (const raw of ['scope-rev-A', '', 42, {}, [REV_A], `${REV_A} `]) {
    const c = makeClient({ jobs: [jobRow()], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
    assertEquals(await namedLink(c, raw, await sent()), null, `raw=${JSON.stringify(raw)}`)
    assertEquals(c.reads.length, 0, 'nothing is read for a malformed id')
  }
})

Deno.test('JP24-L18 named: a failed, thrown or hung read is null, never a throw, cut off at the bound', async () => {
  const rows = [await frozenRow(REV_A, SCOPE, PRICING)]
  assertEquals(await namedLink(makeClient({ scope_revisions: rows }, { revisionsError: true }), REV_A), null)
  assertEquals(await namedLink(makeClient({ scope_revisions: rows }, { throwOn: 'scope_revisions' }), REV_A), null)
  const started = Date.now()
  assertEquals(await namedLink(makeClient({ scope_revisions: rows }, { hangOn: 'scope_revisions' }), REV_A, null, 30), null)
  assert(Date.now() - started < 2000, 'the bound cut the read off')
})

Deno.test('JP24-L19 named: the row is judged at the read; a later refreeze cannot move the link to another row', async () => {
  const rowA = await frozenRow(REV_A, SCOPE, PRICING)
  const c = makeClient({ jobs: [jobRow()], scope_revisions: [rowA] })
  const named = startNamedScopeRevisionRead(c, REV_A)
  await named
  // Refreeze to B after the read: A superseded, B frozen with the same hashes.
  rowA.status = 'superseded'
  c.tables.scope_revisions.push({ ...rowA, id: 'rev-B', revision_number: 2, status: 'frozen' })
  assertEquals(await quoteScopeRevisionIdForRelease(c, JOB, { named }, { handler: 'test' }), REV_A)
  assertEquals(c.reads.length, 1, 'the frozen-row list is never read on the named path')
})

Deno.test('JP24-L20 no id named: the slice 1 provenance rule answers, unchanged', async () => {
  for (const raw of [undefined, null]) {
    const c = makeClient({ jobs: [jobRow()], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
    assertEquals(await namedLink(c, raw), null, 'no provenance: null, nothing read')
    assertEquals(c.reads.length, 0)
    assertEquals(await namedLink(c, raw, await sent()), 'rev-frozen', 'provenance still links through the slice 1 rule')
  }
})

Deno.test('JP24-L21 named: the null log line carries ids and a reason only, and never echoes a malformed id', async () => {
  const lines: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
  try {
    const c = makeClient({ scope_revisions: [await frozenRow(REV_A, SCOPE, PRICING, { job_id: OTHER_JOB })] })
    assertEquals(await namedLink(c, REV_A), null)
    assertEquals(await namedLink(c, 'Jane Citizen 0400 000 000'), null)
  } finally {
    console.log = orig
  }
  assertEquals(lines.length, 2)
  const body = (l: string) => JSON.parse(l.slice(l.indexOf(' ') + 1))
  assertEquals(body(lines[0]), { job_id: JOB, handler: 'test', reason: 'named_revision_other_job', named_revision_id: REV_A, stored: null })
  assertEquals(body(lines[1]), { job_id: JOB, handler: 'test', reason: 'named_id_malformed', stored: null })
  assert(!lines.join(' ').includes('Jane'), 'a malformed id is never logged')
})

// ── D21 regression pin ──────────────────────────────────────────────────────
// freeze_scope stores canonicalJsonAndHash(jobs.scope_json) verbatim, so a
// frozen revision's scope_canonical_text keeps every scope_json.lines[].id (and
// the patio revision ids). Dispatch #1111 and the #1122 reader parse those ids
// out of this text. If a future freeze strips or rewrites them, this fails.
Deno.test('JP24-D21 a frozen revision\'s scope_canonical_text still holds scope_json.lines[].id', async () => {
  const c = makeClient({ jobs: [jobRow()], scope_revisions: [] })
  const frozen = await freezeScope(c, { job_id: JOB, tool_kind: 'fencing' } as any)
  assert(frozen.ok, `freezeScope refused: ${JSON.stringify(frozen)}`)
  const row = c.tables.scope_revisions.find((r) => r.status === 'frozen')!
  const parsed = JSON.parse(String(row.scope_canonical_text))
  assertEquals(parsed.lines.map((l: { id: string }) => l.id), ['line-rhs-1', 'line-rear-2'])
  assertEquals(parsed.revision, SCOPE.revision)

  // And a quote built from the same blobs, carrying their hashes, links to the
  // revision freeze_scope just wrote.
  assertEquals(await quoteScopeRevisionIdForSend(c, JOB, await sentQuoteSourceHashes(SCOPE, PRICING), { handler: 'test' }), row.id)
})
