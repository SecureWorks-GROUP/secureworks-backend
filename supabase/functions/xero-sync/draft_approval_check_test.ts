// deno-lint-ignore-file no-import-prefix
// P3-01.10: daily check of drafts approved in Xero, from one stored snapshot.
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { linesFingerprint } from '../_shared/xero_draft_standard.ts'
import { approvedSnapshotLines, checkDraftsApproved, DRAFTS_CHANGED_CHECK, perthMonth } from './draft_approval_check.ts'

const ORG = '00000000-0000-0000-0000-000000000001'
const NOW = '2026-11-18T01:00:00.000Z'

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>

// A small in-memory PostgREST stand-in: eq, is, in, gte, lt, order, limit,
// arrow projections with aliases, head counts, compare-and-set updates and
// upserts. failOn names a table whose reads answer with an error, or
// '<table>:count' for its head counts only.
function fakeClient(tables: Record<string, Row[]>, failOn: Set<string> = new Set()) {
  const calls: { table: string; op: string; payload?: unknown }[] = []
  function from(table: string) {
    const filters: ((r: Row) => boolean)[] = []
    let op = 'select'
    let projection = '*'
    let head = false
    let payload: Row | null = null
    let order: { col: string; asc: boolean } | null = null
    let limit: number | null = null
    let returning = false
    const rows = () => (tables[table] ||= [])
    const project = (r: Row) => {
      if (projection === '*') return { ...r }
      const out: Row = {}
      for (const part of projection.split(',').map((s) => s.trim())) {
        const [alias, path] = part.includes(':') ? part.split(':') : [part, part]
        const segs = path.split('->')
        // deno-lint-ignore no-explicit-any
        let v: any = r[segs[0]]
        for (const s of segs.slice(1)) v = v == null ? null : (v[s] ?? null)
        out[alias] = v === undefined ? null : v
      }
      return out
    }
    const run = () => {
      calls.push({ table, op, payload })
      if (failOn.has(table) && op === 'select') return { data: null, count: null, error: { code: 'XX000' } }
      if (failOn.has(`${table}:${op}`)) return { data: null, count: null, error: { code: 'XX000' } }
      if (head && failOn.has(`${table}:count`)) return { data: null, count: null, error: { code: 'XX000' } }
      if (op === 'upsert') {
        const list = rows()
        const i = list.findIndex((r) => r.check_name === payload!.check_name && r.period_key === payload!.period_key)
        if (i >= 0) list[i] = { ...payload }
        else list.push({ ...payload })
        return { data: null, error: null }
      }
      let hit = rows().filter((r) => filters.every((f) => f(r)))
      if (op === 'update') {
        for (const r of hit) Object.assign(r, payload)
        return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null }
      }
      if (order) {
        const { col, asc } = order
        hit = [...hit].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
      }
      if (limit !== null) hit = hit.slice(0, limit)
      if (head) return { data: null, count: hit.length, error: null }
      return { data: hit.map(project), error: null }
    }
    const q = {
      select(cols: string, opts?: { head?: boolean }) {
        if (op === 'update') returning = true
        else { projection = cols; head = !!opts?.head }
        return q
      },
      update(p: Row) { op = 'update'; payload = p; return q },
      upsert(p: Row) { op = 'upsert'; payload = p; return q },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return q },
      is(c: string, v: null) { filters.push((r) => (r[c] ?? null) === v); return q },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return q },
      gte(c: string, v: string) { filters.push((r) => r[c] != null && r[c] >= v); return q },
      lt(c: string, v: string) { filters.push((r) => r[c] != null && r[c] < v); return q },
      order(c: string, o: { ascending: boolean }) { order = { col: c, asc: o.ascending }; return q },
      limit(n: number) { limit = n; return q },
      // deno-lint-ignore no-explicit-any
      then(res: any, rej: any) { return Promise.resolve().then(run).then(res, rej) },
    }
    return q
  }
  return { client: { from }, calls }
}

// Lines as our own payload sends them, and as Xero hands them back.
const payloadLines = [
  { AccountCode: '310', Tracking: [{ Name: 'Business Unit', Option: 'SW - FENCING' }], Quantity: 2, UnitAmount: 10.5 },
  { AccountCode: '311', Tracking: [{ Name: 'Business Unit', Option: 'SW - FENCING' }], Quantity: 1, UnitAmount: 3 },
]
const xeroLines = [
  { LineItemID: 'l1', AccountCode: '310', Tracking: [{ TrackingCategoryID: 't', Name: 'Business Unit', Option: 'SW - FENCING' }], Quantity: 2.0, UnitAmount: 10.5, LineAmount: 21, TaxType: 'INPUT' },
  { LineItemID: 'l2', AccountCode: '311', Tracking: [{ TrackingCategoryID: 't', Name: 'Business Unit', Option: 'SW - FENCING' }], Quantity: 1.0, UnitAmount: 3.0, LineAmount: 3, TaxType: 'INPUT' },
]

async function draftFingerprint(lines: typeof payloadLines) {
  return await linesFingerprint(lines.map((l) => ({
    accountCode: l.AccountCode, trackingOption: l.Tracking?.[0]?.Option, quantity: l.Quantity, unitAmount: l.UnitAmount,
  })))
}

function reg(id: string, doc: string, type: string, fp: string, draftedAt: string): Row {
  return { id, org_id: ORG, xero_document_id: doc, document_type: type, lines_fingerprint: fp, drafted_at: draftedAt, approved_seen_at: null, approved_fingerprint: null, edited_before_approval: null }
}
function inv(id: string, raw: Row | null, columns: Row = {}): Row {
  return { org_id: ORG, xero_invoice_id: id, raw_json: raw, ...columns }
}

Deno.test('perthMonth: Perth time decides the month either side of month end', () => {
  assertEquals(perthMonth('2026-11-30T15:59:59.000Z').key, '2026-11') // 23:59:59 Perth
  assertEquals(perthMonth('2026-11-30T16:00:00.000Z').key, '2026-12') // 00:00 Perth, 1 Dec
  const m = perthMonth(NOW)
  assertEquals(m, { key: '2026-11', startIso: '2026-10-31T16:00:00.000Z', endIso: '2026-11-30T16:00:00.000Z' })
})

Deno.test('a payload-shaped line and a Xero-shaped line give the same fingerprint', async () => {
  const xeroShaped = approvedSnapshotLines({ status: 'AUTHORISED', lines: [{ ...xeroLines[0], Quantity: '2.0000', UnitAmount: '10.5000' }, xeroLines[1]] })
  assertEquals(await linesFingerprint(xeroShaped!), await draftFingerprint(payloadLines))
})

Deno.test('ticket fixture: unchanged false, changed true, draft and missing untouched, month row 2 and 1', async () => {
  const fp = await draftFingerprint(payloadLines)
  const changedLines = [{ ...xeroLines[0], AccountCode: '320' }, xeroLines[1]]
  const tables: Record<string, Row[]> = {
    xero_draft_register: [
      reg('r1', 'inv-same', 'ACCPAY', fp, '2026-11-01T00:00:00Z'),
      reg('r2', 'inv-changed', 'ACCPAY', fp, '2026-11-02T00:00:00Z'),
      reg('r3', 'inv-draft', 'ACCREC', fp, '2026-11-03T00:00:00Z'),
      reg('r4', 'inv-missing', 'ACCPAY', fp, '2026-11-04T00:00:00Z'),
    ],
    xero_invoices: [
      inv('inv-same', { Status: 'AUTHORISED', LineItems: xeroLines }),
      inv('inv-changed', { Status: 'PAID', LineItems: changedLines }),
      inv('inv-draft', { Status: 'DRAFT', LineItems: xeroLines }),
    ],
    bookkeeping_checks: [],
  }
  const { client } = fakeClient(tables)
  const out = await checkDraftsApproved(client, ORG, NOW)
  assert(out.ok)
  assertEquals([out.pending_read, out.approved_now, out.changed_now, out.left_pending], [4, 2, 1, 2])
  const byId = Object.fromEntries(tables.xero_draft_register.map((r) => [r.id, r]))
  assertEquals(byId.r1.edited_before_approval, false)
  assertEquals(byId.r1.approved_seen_at, NOW)
  assertEquals(byId.r1.approved_fingerprint, fp)
  assertEquals(byId.r2.edited_before_approval, true)
  for (const id of ['r3', 'r4']) {
    assertEquals(byId[id].approved_seen_at, null)
    assertEquals(byId[id].approved_fingerprint, null)
    assertEquals(byId[id].edited_before_approval, null)
  }
  assertEquals(tables.bookkeeping_checks, [{
    check_name: DRAFTS_CHANGED_CHECK, period_key: '2026-11', value: 1, detail: { approved: 2, changed: 1 }, checked_at: NOW,
  }])
  assertEquals(out.month, { period_key: '2026-11', approved: 2, changed: 1 })
})

Deno.test('one snapshot: status column AUTHORISED with stale line_items, raw_json still DRAFT: untouched', async () => {
  const fp = await draftFingerprint(payloadLines)
  const tables: Record<string, Row[]> = {
    xero_draft_register: [reg('r1', 'inv-a', 'ACCPAY', fp, '2026-11-01T00:00:00Z')],
    xero_invoices: [inv('inv-a', { Status: 'DRAFT', LineItems: xeroLines }, { status: 'AUTHORISED', line_items: xeroLines })],
    bookkeeping_checks: [],
  }
  const { client } = fakeClient(tables)
  const out = await checkDraftsApproved(client, ORG, NOW)
  assertEquals(out.approved_now, 0)
  assertEquals(tables.xero_draft_register[0].edited_before_approval, null)
})

Deno.test('one snapshot: approved record with no line list, an empty list or no raw_json: untouched', async () => {
  const fp = await draftFingerprint(payloadLines)
  const tables: Record<string, Row[]> = {
    xero_draft_register: [
      reg('r1', 'inv-nolines', 'ACCPAY', fp, '2026-11-01T00:00:00Z'),
      reg('r2', 'inv-empty', 'ACCPAY', fp, '2026-11-02T00:00:00Z'),
      reg('r3', 'inv-noraw', 'ACCPAY', fp, '2026-11-03T00:00:00Z'),
    ],
    xero_invoices: [
      inv('inv-nolines', { Status: 'AUTHORISED' }, { status: 'AUTHORISED', line_items: xeroLines }),
      inv('inv-empty', { Status: 'AUTHORISED', LineItems: [] }),
      inv('inv-noraw', null, { status: 'AUTHORISED', line_items: xeroLines }),
    ],
    bookkeeping_checks: [],
  }
  const { client } = fakeClient(tables)
  const out = await checkDraftsApproved(client, ORG, NOW)
  assertEquals([out.approved_now, out.left_pending], [0, 3])
  for (const r of tables.xero_draft_register) assertEquals(r.edited_before_approval, null)
})

Deno.test('credit notes are read from xero_supplier_credit_notes raw_json', async () => {
  const fp = await draftFingerprint(payloadLines)
  const tables: Record<string, Row[]> = {
    xero_draft_register: [reg('r1', 'cn-1', 'ACCPAYCREDIT', fp, '2026-11-01T00:00:00Z')],
    xero_invoices: [inv('cn-1', { Status: 'AUTHORISED', LineItems: [] })], // same id elsewhere is never read
    xero_supplier_credit_notes: [{ org_id: ORG, xero_credit_note_id: 'cn-1', status: 'DRAFT', raw_json: { Status: 'AUTHORISED', LineItems: xeroLines } }],
    bookkeeping_checks: [],
  }
  const { client } = fakeClient(tables)
  const out = await checkDraftsApproved(client, ORG, NOW)
  assertEquals(out.approved_now, 1)
  assertEquals(tables.xero_draft_register[0].edited_before_approval, false)
})

Deno.test('a failed register read writes nothing and stores no count', async () => {
  const tables: Record<string, Row[]> = { xero_draft_register: [], bookkeeping_checks: [] }
  const { client, calls } = fakeClient(tables, new Set(['xero_draft_register']))
  const out = await checkDraftsApproved(client, ORG, NOW)
  assertEquals(out.ok, false)
  assertEquals(out.error, 'register_read_failed')
  assertEquals(calls.filter((c) => c.op !== 'select').length, 0)
  assertEquals(tables.bookkeeping_checks.length, 0)
})

Deno.test('a failed snapshot read leaves its rows pending', async () => {
  const fp = await draftFingerprint(payloadLines)
  const tables: Record<string, Row[]> = {
    xero_draft_register: [reg('r1', 'inv-a', 'ACCPAY', fp, '2026-11-01T00:00:00Z')],
    xero_invoices: [inv('inv-a', { Status: 'AUTHORISED', LineItems: xeroLines })],
    bookkeeping_checks: [],
  }
  const { client } = fakeClient(tables, new Set(['xero_invoices']))
  const out = await checkDraftsApproved(client, ORG, NOW)
  assertEquals(out.approved_now, 0)
  assert(out.errors.includes('xero_invoices_read_failed'))
  assertEquals(tables.xero_draft_register[0].approved_seen_at, null)
})

Deno.test('a failed month count is never stored as zero', async () => {
  const fp = await draftFingerprint(payloadLines)
  const tables: Record<string, Row[]> = {
    xero_draft_register: [reg('r1', 'inv-a', 'ACCPAY', fp, '2026-11-01T00:00:00Z')],
    xero_invoices: [inv('inv-a', { Status: 'AUTHORISED', LineItems: xeroLines })],
    bookkeeping_checks: [],
  }
  const { client } = fakeClient(tables, new Set(['xero_draft_register:count']))
  const out = await checkDraftsApproved(client, ORG, NOW)
  assert(out.errors.includes('month_count_read_failed'))
  assertEquals(out.month, null)
  assertEquals(tables.bookkeeping_checks.length, 0)
})

Deno.test('a second run does not re-mark a row and keeps the month row', async () => {
  const fp = await draftFingerprint(payloadLines)
  const tables: Record<string, Row[]> = {
    xero_draft_register: [reg('r1', 'inv-a', 'ACCPAY', fp, '2026-11-01T00:00:00Z')],
    xero_invoices: [inv('inv-a', { Status: 'AUTHORISED', LineItems: xeroLines })],
    bookkeeping_checks: [],
  }
  const { client } = fakeClient(tables)
  await checkDraftsApproved(client, ORG, NOW)
  // Office edits the approved bill later: the earlier verdict stands.
  tables.xero_invoices[0].raw_json = { Status: 'AUTHORISED', LineItems: [{ ...xeroLines[0], AccountCode: '399' }] }
  const later = '2026-11-19T01:00:00.000Z'
  const out = await checkDraftsApproved(client, ORG, later)
  assertEquals([out.pending_read, out.approved_now], [0, 0])
  assertEquals(tables.xero_draft_register[0].approved_seen_at, NOW)
  assertEquals(tables.xero_draft_register[0].edited_before_approval, false)
  assertEquals(tables.bookkeeping_checks.length, 1)
  assertEquals(tables.bookkeeping_checks[0].detail, { approved: 1, changed: 0 })
})

Deno.test('another org and a register row approved last month stay out of this month', async () => {
  const fp = await draftFingerprint(payloadLines)
  const tables: Record<string, Row[]> = {
    xero_draft_register: [
      { ...reg('r1', 'inv-a', 'ACCPAY', fp, '2026-10-01T00:00:00Z'), approved_seen_at: '2026-10-31T15:59:00.000Z', edited_before_approval: true },
      { ...reg('r2', 'inv-b', 'ACCPAY', fp, '2026-11-01T00:00:00Z'), org_id: 'other-org' },
    ],
    xero_invoices: [{ org_id: 'other-org', xero_invoice_id: 'inv-b', raw_json: { Status: 'AUTHORISED', LineItems: xeroLines } }],
    bookkeeping_checks: [],
  }
  const { client } = fakeClient(tables)
  const out = await checkDraftsApproved(client, ORG, NOW)
  assertEquals(out.month, { period_key: '2026-11', approved: 0, changed: 0 })
  assertEquals(tables.xero_draft_register[1].approved_seen_at, null)
})
