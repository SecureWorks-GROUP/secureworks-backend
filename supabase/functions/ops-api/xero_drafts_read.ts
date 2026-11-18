import { chunkByUrlBudget } from './makesafe_compact_reads.ts'

export class XeroDraftsError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

const dayMs = 86_400_000
const flags = ['has_account_codes', 'has_division_tags', 'has_job_reference', 'has_source_document'] as const
const columns = ['drafted_at', 'document_type', 'job_ids', ...flags, 'problems', 'edited_before_approval', 'xero_document_id'].join(',')
const problemWords = {
  account_code_missing: 'Missing account code',
  division_not_known: 'Missing division tag',
  division_option_not_active: 'Division option is inactive',
  options_not_loaded: 'Division options could not be checked',
  job_reference_missing: 'Missing job reference',
  source_document_missing: 'Missing source document',
}

function unavailable(): never { throw new XeroDraftsError('Draft register could not be read', 503) }

function dateMs(day: string) {
  const ms = Date.parse(day + 'T00:00:00Z')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) {
    throw new XeroDraftsError('Expected a calendar date in YYYY-MM-DD format', 400)
  }
  return ms
}

function records(result: { data: any[] | null; error: unknown }): any[] {
  if (result.error || !Array.isArray(result.data)) unavailable()
  return result.data
}

function publicProblem(problem: { code: string; line: number | null }) {
  if (!problem || !Object.hasOwn(problemWords, problem.code) ||
      !(problem.line === null || (Number.isSafeInteger(problem.line) && problem.line > 0))) unavailable()
  const { code, line } = problem
  // Stored text can quote an office-entered tracking option.
  const words = problemWords[code as keyof typeof problemWords]
  return { code, line, text: line === null ? words : 'Line ' + line + ': ' + words }
}

type Options = { orgId: string; from?: string | null; to?: string | null; filter?: string | null }

export async function readXeroDrafts(client: any, { orgId, from, to, filter }: Options) {
  if (!orgId?.trim()) throw new XeroDraftsError('Organisation required', 403)
  if (filter != null && !['all', 'incomplete', 'changed'].includes(filter)) {
    throw new XeroDraftsError('Unknown draft filter', 400)
  }
  const perthOffset = 8 * 3_600_000
  const last = dateMs(to ?? new Date(Date.now() + perthOffset).toISOString().slice(0, 10))
  const first = from == null ? last - 29 * dayMs : dateMs(from)
  if (first > last) throw new XeroDraftsError('From must be on or before to', 400)

  try {
    const register = (fields: string) => client.from('xero_draft_register').select(fields).eq('org_id', orgId)
    let period = register(columns).gte('drafted_at', new Date(first - perthOffset).toISOString())
      .lt('drafted_at', new Date(last + dayMs - perthOffset).toISOString())
    if (filter === 'incomplete') period = period.or(flags.map(key => key + '.eq.false').join(','))
    if (filter === 'changed') period = period.eq('edited_before_approval', true)
    const [page, oldest] = await Promise.all([
      period.order('drafted_at', { ascending: false }).order('id').limit(500),
      register('drafted_at').order('drafted_at', { ascending: true }).limit(1),
    ])
    const drafts = records(page)
    const countingFrom = records(oldest)[0]?.drafted_at ?? null
    if (drafts.length && countingFrom === null) unavailable()

    const ids = [...new Set<string>(drafts.flatMap(row => row.job_ids))]
    const numbers = new Map<string, string>()
    for (const batch of chunkByUrlBudget(ids)) {
      const jobs = records(await client.from('jobs').select('id,job_number').eq('org_id', orgId).in('id', batch))
      for (const job of jobs) {
        if (!job.job_number) unavailable()
        numbers.set(job.id, job.job_number)
      }
    }
    if (numbers.size !== ids.length) unavailable()
    const totals = { drafts: drafts.length, incomplete: 0, approved: 0, changed_before_approval: 0 }
    const rows = drafts.map(row => {
      if (!flags.every(key => typeof row[key] === 'boolean') ||
          ![true, false, null].includes(row.edited_before_approval)) unavailable()
      if (flags.some(key => !row[key])) totals.incomplete++
      if (row.edited_before_approval !== null) totals.approved++
      if (row.edited_before_approval) totals.changed_before_approval++
      return {
        drafted_at: row.drafted_at, kind: row.document_type, job_numbers: row.job_ids.map((id: string) => numbers.get(id)),
        has_account_codes: row.has_account_codes, has_division_tags: row.has_division_tags,
        has_job_reference: row.has_job_reference, has_source_document: row.has_source_document,
        problems: row.problems.map(publicProblem),
        changed: row.edited_before_approval === null ? 'not_approved_yet' : row.edited_before_approval ? 'yes' : 'no',
        xero_document_id: row.xero_document_id,
      }
    })
    return { ok: true, counting_from: countingFrom, rows, totals }
  } catch {
    unavailable()
  }
}
