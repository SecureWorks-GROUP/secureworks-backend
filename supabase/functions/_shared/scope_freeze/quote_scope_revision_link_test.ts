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
  quoteScopeRevisionIdForSend,
  resolveQuoteScopeRevisionLink,
} from './quote_scope_revision_link.ts'

type Row = Record<string, unknown>
type Tables = Record<string, Row[]>
type Read = { table: string; cols: string | null; filters: Array<[string, unknown]>; limit: number | null }

const JOB = 'a1b2c3d4-0000-4000-8000-000000000001'

// A fence scope with line ids (INT-23 / D21) and a patio-style revision block.
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

Deno.test('JP24-L1 both hashes match the one frozen row: its id is the link', async () => {
  const c = makeClient({ jobs: [jobRow()], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
  assertEquals(await resolveQuoteScopeRevisionLink(c, JOB), { scope_revision_id: 'rev-frozen', reason: 'matched' })
  assertEquals(await quoteScopeRevisionIdForSend(c, JOB, { handler: 'test' }), 'rev-frozen')
})

Deno.test('JP24-L2 key order inside the stored blobs does not matter (same canonical form freeze_scope hashes)', async () => {
  const reordered = { job: SCOPE.job, revision: SCOPE.revision, lines: SCOPE.lines, tool: SCOPE.tool }
  const c = makeClient({ jobs: [jobRow(reordered)], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
  assertEquals(await quoteScopeRevisionIdForSend(c, JOB, { handler: 'test' }), 'rev-frozen')
})

Deno.test('JP24-L3 a scope saved after the freeze: null, scope_hash_mismatch', async () => {
  const edited = { ...SCOPE, lines: [...SCOPE.lines, { id: 'line-lhs-3', label: 'LHS', metres: 4, height: 1.8 }] }
  const c = makeClient({ jobs: [jobRow(edited)], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
  const link = await resolveQuoteScopeRevisionLink(c, JOB)
  assertEquals(link, { scope_revision_id: null, reason: 'scope_hash_mismatch', read_revision_id: 'rev-frozen' })
  assertEquals(await quoteScopeRevisionIdForSend(c, JOB, { handler: 'test' }), null)
})

Deno.test('JP24-L4 pricing changed after the freeze: null, pricing_hash_mismatch (no price search)', async () => {
  const c = makeClient({ jobs: [jobRow(SCOPE, { ...PRICING, totalIncGST: 5501 })], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
  assertEquals((await resolveQuoteScopeRevisionLink(c, JOB)).reason, 'pricing_hash_mismatch')
  assertEquals(await quoteScopeRevisionIdForSend(c, JOB, { handler: 'test' }), null)
})

Deno.test('JP24-L5 both changed: null, scope_and_pricing_hash_mismatch', async () => {
  const c = makeClient({ jobs: [jobRow({ ...SCOPE, tool: 'x' }, { ...PRICING, gst: 1 })], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
  assertEquals((await resolveQuoteScopeRevisionLink(c, JOB)).reason, 'scope_and_pricing_hash_mismatch')
})

Deno.test('JP24-L6 no frozen row (drafts and superseded rows never count): null', async () => {
  const c = makeClient({
    jobs: [jobRow()],
    scope_revisions: [
      await frozenRow('rev-draft', SCOPE, PRICING, { status: 'draft', revision_number: 2 }),
      await frozenRow('rev-old', SCOPE, PRICING, { status: 'superseded' }),
    ],
  })
  assertEquals((await resolveQuoteScopeRevisionLink(c, JOB)).reason, 'no_frozen_revision')
  assertEquals(await quoteScopeRevisionIdForSend(c, JOB, { handler: 'test' }), null)
})

Deno.test('JP24-L7 several frozen rows: null even when one of them matches', async () => {
  const c = makeClient({
    jobs: [jobRow()],
    scope_revisions: [
      await frozenRow('rev-a', SCOPE, PRICING, { revision_number: 1 }),
      await frozenRow('rev-b', SCOPE, PRICING, { revision_number: 2 }),
    ],
  })
  assertEquals((await resolveQuoteScopeRevisionLink(c, JOB)).reason, 'several_frozen_revisions')
  assertEquals(await quoteScopeRevisionIdForSend(c, JOB, { handler: 'test' }), null)
})

Deno.test('JP24-L8 another job\'s frozen row is never read as this job\'s', async () => {
  const other = await frozenRow('rev-other', SCOPE, PRICING, { job_id: 'other-job' })
  const c = makeClient({ jobs: [jobRow()], scope_revisions: [other] })
  assertEquals((await resolveQuoteScopeRevisionLink(c, JOB)).reason, 'no_frozen_revision')
})

Deno.test('JP24-L9 a failed jobs read or scope_revisions read: null, never a throw', async () => {
  const rev = await frozenRow('rev-frozen', SCOPE, PRICING)
  const jobsErr = makeClient({ jobs: [jobRow()], scope_revisions: [rev] }, { jobsError: true })
  assertEquals((await resolveQuoteScopeRevisionLink(jobsErr, JOB)).reason, 'job_read_failed')
  const revErr = makeClient({ jobs: [jobRow()], scope_revisions: [rev] }, { revisionsError: true })
  assertEquals((await resolveQuoteScopeRevisionLink(revErr, JOB)).reason, 'revision_read_failed')
  assertEquals(await quoteScopeRevisionIdForSend(revErr, JOB, { handler: 'test' }), null)
  const throws = makeClient({ jobs: [jobRow()], scope_revisions: [rev] }, { throwOn: 'scope_revisions' })
  assertEquals((await resolveQuoteScopeRevisionLink(throws, JOB)).reason, 'lookup_threw')
  assertEquals(await quoteScopeRevisionIdForSend(throws, JOB, { handler: 'test' }), null)
})

Deno.test('JP24-L10 a missing job, a non-object or empty blob: null', async () => {
  const rev = await frozenRow('rev-frozen', SCOPE, PRICING)
  assertEquals((await resolveQuoteScopeRevisionLink(makeClient({ jobs: [], scope_revisions: [rev] }), JOB)).reason, 'job_not_found')
  assertEquals((await resolveQuoteScopeRevisionLink(makeClient({ jobs: [{ id: JOB, scope_json: JSON.stringify(SCOPE), pricing_json: PRICING }], scope_revisions: [rev] }), JOB)).reason, 'job_scope_not_object')
  assertEquals((await resolveQuoteScopeRevisionLink(makeClient({ jobs: [{ id: JOB, scope_json: SCOPE, pricing_json: {} }], scope_revisions: [rev] }), JOB)).reason, 'job_pricing_not_object')
})

Deno.test('JP24-L11 a malformed frozen row (bad hash shape): null', async () => {
  const c = makeClient({ jobs: [jobRow()], scope_revisions: [await frozenRow('rev-bad', SCOPE, PRICING, { scope_hash: 'nothex' })] })
  assertEquals(await resolveQuoteScopeRevisionLink(c, JOB), { scope_revision_id: null, reason: 'revision_row_malformed', read_revision_id: 'rev-bad' })
})

Deno.test('JP24-L12 a read that never answers is cut off at the bound: null, the send is not held', async () => {
  const c = makeClient({ jobs: [jobRow()], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] }, { hangOn: 'jobs' })
  const started = Date.now()
  assertEquals(await quoteScopeRevisionIdForSend(c, JOB, { handler: 'test' }, { timeoutMs: 30 }), null)
  assert(Date.now() - started < 2000, 'the bound cut the lookup off')
})

Deno.test('JP24-L13 reads only what the rule needs: one job by id, frozen rows of that job, at most two, ids and hashes only', async () => {
  const c = makeClient({ jobs: [jobRow()], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
  await resolveQuoteScopeRevisionLink(c, JOB)
  assertEquals(c.reads.length, 2)
  assertEquals(c.reads[0], { table: 'jobs', cols: 'scope_json, pricing_json', filters: [['id', JOB]], limit: null })
  assertEquals(c.reads[1], { table: 'scope_revisions', cols: 'id, scope_hash, pricing_hash', filters: [['job_id', JOB], ['status', 'frozen']], limit: 2 })
})

Deno.test('JP24-L14 the log line on a null carries ids and a reason only, no customer data', async () => {
  const lines: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
  try {
    const c = makeClient({ jobs: [jobRow(SCOPE, { ...PRICING, totalIncGST: 1 })], scope_revisions: [await frozenRow('rev-frozen', SCOPE, PRICING)] })
    assertEquals(await quoteScopeRevisionIdForSend(c, JOB, { handler: 'send-quote/send' }), null)
  } finally {
    console.log = orig
  }
  assertEquals(lines.length, 1)
  const [tag, body] = [lines[0].slice(0, lines[0].indexOf(' ')), JSON.parse(lines[0].slice(lines[0].indexOf(' ') + 1))]
  assertEquals(tag, '[quote-scope-revision-link]')
  assertEquals(body, { job_id: JOB, handler: 'send-quote/send', reason: 'pricing_hash_mismatch', read_revision_id: 'rev-frozen', stored: null })
  assert(!lines[0].includes('Test St') && !lines[0].includes('5500'), 'no scope or price text in the log')
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

  // And the send-time link recognises the revision freeze_scope just wrote.
  assertEquals(await quoteScopeRevisionIdForSend(c, JOB, { handler: 'test' }), row.id)
})
