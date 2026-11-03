// customer_model.ts: which model a quote link may read, with the flag passed in (no feature_flags read).

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { customerModelViewerUrl, findCustomerModel, readCustomerModel } from './customer_model.ts'

type Row = Record<string, unknown>
type Tables = { job_documents: Row[]; scope_revisions: Row[]; scope_artifacts: Row[] }

function mock(t: Tables, opts: { failTable?: keyof Tables; bytes?: Uint8Array | null } = {}) {
  const query = (table: keyof Tables) => {
    const f: Array<(r: Row) => boolean> = []
    let order: { col: string; asc: boolean } | null = null
    let lim = Infinity
    const rows = () => {
      let r = t[table].filter((x) => f.every((p) => p(x)))
      if (order) { const { col, asc } = order; r = [...r].sort((a, b) => ((a[col] as number) > (b[col] as number) ? 1 : -1) * (asc ? 1 : -1)) }
      return r.slice(0, lim)
    }
    const err = () => (opts.failTable === table ? { message: 'boom' } : null)
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { f.push((r) => r[c] === v); return q },
      is: (c: string, v: unknown) => { f.push((r) => (r[c] ?? null) === v); return q },
      order: (col: string, o: { ascending: boolean }) => { order = { col, asc: o.ascending }; return q },
      limit: (n: number) => { lim = n; return Promise.resolve(err() ? { data: null, error: err() } : { data: rows(), error: null }) },
      maybeSingle: () => Promise.resolve(err() ? { data: null, error: err() } : { data: rows()[0] ?? null, error: null }),
    }
    return q
  }
  return {
    from: (table: keyof Tables) => query(table),
    storage: { from: () => ({ download: () => Promise.resolve(opts.bytes ? { data: new Blob([opts.bytes as BlobPart]), error: null } : { data: null, error: { message: 'missing' } }) }) },
  }
}

const base = (): Tables => ({
  job_documents: [
    { id: 'd1', job_id: 'j1', share_token: 'tok', sent_to_client: true, superseded_at: null },
    { id: 'd0', job_id: 'j1', share_token: 'old', sent_to_client: true, superseded_at: '2026-10-01' },
  ],
  scope_revisions: [
    { id: 'r1', job_id: 'j1', revision_number: 1, status: 'superseded' },
    { id: 'r2', job_id: 'j1', revision_number: 2, status: 'frozen' },
  ],
  scope_artifacts: [
    { scope_revision_id: 'r1', artifact_type: 'customer_model', storage_path: 'old.json', created_at: '2026-10-01' },
    { scope_revision_id: 'r2', artifact_type: 'render_hero', storage_path: 'hero.png', created_at: '2026-10-02' },
    { scope_revision_id: 'r2', artifact_type: 'customer_model', storage_path: 'cur.json', created_at: '2026-10-02' },
  ],
})

Deno.test('customer model: flag off answers flag_off before any read', async () => {
  assertEquals(await findCustomerModel(mock(base(), { failTable: 'job_documents' }), 'tok', false), { ok: false, reason: 'flag_off' })
})

Deno.test('customer model: the current frozen revision only, never a superseded one', async () => {
  const r = await findCustomerModel(mock(base()), 'tok', true)
  assertEquals(r.ok && r.storagePath, 'cur.json')
  assertEquals(r.ok && r.revisionNumber, 2)
})

Deno.test('customer model: a retired quote link or a missing model is not available', async () => {
  assertEquals(await findCustomerModel(mock(base()), 'old', true), { ok: false, reason: 'quote_not_found' })
  assertEquals(await findCustomerModel(mock(base()), null, true), { ok: false, reason: 'no_token' })
  const t = base(); t.scope_artifacts = t.scope_artifacts.filter((a) => a.storage_path !== 'cur.json')
  assertEquals(await findCustomerModel(mock(t), 'tok', true), { ok: false, reason: 'no_model' })
  const u = base(); u.scope_revisions = u.scope_revisions.filter((x) => x.status !== 'frozen')
  assertEquals(await findCustomerModel(mock(u), 'tok', true), { ok: false, reason: 'no_frozen_revision' })
})

Deno.test('customer model: a failed read is read_failed, never an empty answer', async () => {
  for (const failTable of ['job_documents', 'scope_revisions', 'scope_artifacts'] as const) {
    assertEquals(await findCustomerModel(mock(base(), { failTable }), 'tok', true), { ok: false, reason: 'read_failed' })
  }
})

Deno.test('customer model: the bytes must be one JSON object', async () => {
  const found = { ok: true as const, jobId: 'j1', scopeRevisionId: 'r2', revisionNumber: 2, storagePath: 'cur.json' }
  const enc = (s: string) => new TextEncoder().encode(s)
  assertEquals(await readCustomerModel(mock(base(), { bytes: enc('{"what":"patio"}') }), found), { ok: true, model: { what: 'patio' }, revLabel: 'Rev 2' })
  for (const s of ['[1]', 'nope', '']) assertEquals((await readCustomerModel(mock(base(), { bytes: enc(s) }), found)).ok, false)
  assertEquals((await readCustomerModel(mock(base(), { bytes: null }), found)).ok, false)
})

Deno.test('customer model: the viewer link carries the quote token only', () => {
  assertEquals(customerModelViewerUrl('https://example.test/quote/3d.html', 'a b'), 'https://example.test/quote/3d.html?token=a+b')
})
