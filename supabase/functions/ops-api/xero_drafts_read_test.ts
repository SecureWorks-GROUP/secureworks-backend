import { deepStrictEqual as equal, rejects } from 'node:assert/strict'
import { readXeroDrafts, XeroDraftsError } from './xero_drafts_read.ts'

const options = { orgId: 'office', from: '2026-11-01', to: '2026-11-01' }
const base = {
  org_id: 'office', drafted_at: '2026-11-01T00:00:00.000Z', document_type: 'ACCPAY',
  job_ids: ['job'], has_account_codes: true, has_division_tags: true, has_job_reference: true,
  has_source_document: true, problems: [] as object[], edited_before_approval: false as boolean | null,
  xero_document_id: 'original',
}
const incomplete = {
  ...base, xero_document_id: 'incomplete', edited_before_approval: null, has_source_document: false,
  problems: [{ code: 'source_document_missing', line: null, text: 'private input', extra: 'private field' }],
}
const changed = { ...base, xero_document_id: 'changed', edited_before_approval: true }
const old = { ...base, drafted_at: '2026-10-31T15:59:59.999Z' }
const fixtures = [base, incomplete, changed, old, { ...base, org_id: 'other' },
  { ...base, drafted_at: '2026-11-01T16:00:00.000Z' }]

function db(drafts = fixtures, fail = '', jobOrg = 'office') {
  return { from(table: string) {
    equal(['jobs', 'xero_draft_register'].includes(table), true)
    let rows: Record<string, any>[] = table === 'jobs'
      ? [{ id: 'job', org_id: jobOrg, job_number: 'SW1234' }] : drafts.slice()
    let fields: string[]
    return {
      select(columns: string) { fields = columns.split(','); return this },
      eq(key: string, val: unknown) { rows = rows.filter(row => row[key] === val); return this },
      in(key: string, vals: unknown[]) { rows = rows.filter(row => vals.includes(row[key])); return this },
      gte(key: string, val: string) { rows = rows.filter(row => row[key] >= val); return this },
      lt(key: string, val: string) { rows = rows.filter(row => row[key] < val); return this },
      or(query: string) {
        const keys = query.split(',').map(term => term.split('.eq.false')[0])
        rows = rows.filter(row => keys.some(key => row[key] === false))
        return this
      },
      order(key: string, opts?: { ascending: boolean }) {
        if (key === 'drafted_at') rows.sort((a, b) => a[key].localeCompare(b[key]) * (opts?.ascending ? 1 : -1))
        return this
      },
      limit(n: number) { rows = rows.slice(0, n); return this },
      then(resolve: (result: unknown) => void) {
        if (fail === table || (fields.length === 1 && fail === 'oldest')) return resolve({ data: null, error: {} })
        resolve({ data: rows.map(row => Object.fromEntries(fields.map(k => [k, row[k]]))), error: null })
      },
    }
  } }
}

Deno.test('Period totals, safe fields and approval states, with whole-org counting date', async () => {
  const answer = await readXeroDrafts(db(), options)
  equal(answer.totals, { drafts: 3, incomplete: 1, approved: 2, changed_before_approval: 1 })
  equal(answer.counting_from, old.drafted_at)
  equal(answer.rows.map(row => row.changed), ['no', 'not_approved_yet', 'yes'])
  equal(answer.rows[1].problems, [{ code: 'source_document_missing', line: null, text: 'Missing source document' }])
  equal(answer.rows[0].job_numbers, ['SW1234'])
})

Deno.test('Filters run before the cap and retain the register start date', async () => {
  for (const filter of ['incomplete', 'changed']) {
    const answer = await readXeroDrafts(db([...Array(500).fill(base), incomplete, changed, old]), { ...options, filter })
    equal(answer.rows.map(row => row.xero_document_id), [filter])
    equal(answer.counting_from, old.drafted_at)
  }
})

Deno.test('Empty register and thirty inclusive Perth days', async () => {
  const empty = await readXeroDrafts(db([]), options)
  equal(empty.counting_from, null)
  equal(empty.rows, [])
  const answer = await readXeroDrafts(db([
    { ...base, drafted_at: '2026-10-02T15:59:59.999Z' },
    { ...base, drafted_at: '2026-10-02T16:00:00.000Z' },
  ]), { orgId: 'office', to: options.to })
  equal(answer.rows.map(row => row.drafted_at), ['2026-10-02T16:00:00.000Z'])
})

Deno.test('Refuse invalid inputs before reading', async () => {
  for (const input of [{ from: '2026-02-30' }, { to: '' }, { from: '2026-11-02' }, { filter: 'bad' }, { orgId: '' }]) {
    await rejects(readXeroDrafts({}, { ...options, ...input }), (e: unknown) =>
      e instanceof XeroDraftsError && e.status === ('orgId' in input ? 403 : 400))
  }
})

Deno.test('Refuse unreadable register, start date, job and missing own-org job; retry reads current facts', async () => {
  for (const client of [db(fixtures, 'xero_draft_register'), db(fixtures, 'oldest'), db(fixtures, 'jobs'), db(fixtures, '', 'other')]) {
    await rejects(readXeroDrafts(client, options), { message: 'Draft register could not be read', status: 503 })
  }
  const rows = [changed]
  const client = db(rows)
  equal((await readXeroDrafts(client, options)).rows[0].changed, 'yes')
  rows[0] = { ...changed, edited_before_approval: false }
  equal((await readXeroDrafts(client, options)).rows[0].changed, 'no')
})
