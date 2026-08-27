// Job profitability read path. Injected Supabase client so the honesty
// rule can be exercised with a controlled data client — never by grepping
// index.ts. Xero Projects remains a low-confidence lump, not job-cost
// authority.

import {
  PROFIT_SOURCE_IN_CHUNK,
  PROFIT_SOURCE_PAGE_SIZE,
  buildJobProfitabilityReport,
  expectedLanesFromSnapshot,
  fromCents,
  normalizeMoney,
  perthMonthWindow,
  perthQuarterWindow,
  sumMoneyCents,
  tradeLineBelongsToJob,
  type JobProfitInput,
  type JobProfitabilityReport,
  type MaterialsFact,
  type TradeLineFact,
} from './profit_completeness.ts'

const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

// List/cohort projection: two pricing totals, never the full quote blob.
export const JOB_PROFIT_LIST_SELECT =
  'id, type, status, client_name, site_suburb, quote_ex:pricing_json->totalExGST, quote_inc:pricing_json->totalIncGST, expected_costs, created_at, job_number'

export const TRADE_LINE_PROFIT_SELECT =
  'id, job_id, job_number, line_type, line_total_ex, override_amount, trade_invoices!inner(status, org_id)'

export class JobProfitabilityReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JobProfitabilityReadError'
  }
}

export async function fetchProfitSourceRows(
  sb: any,
  table: string,
  select: string,
  column: string,
  ids: string[],
  opts: { orgColumn?: string; orderBy?: string } = {},
): Promise<{ rows: any[]; readFault: boolean }> {
  if (ids.length === 0) return { rows: [], readFault: false }
  const orgColumn = opts.orgColumn ?? 'org_id'
  const orderBy = opts.orderBy ?? 'id'
  const rows: any[] = []
  for (let i = 0; i < ids.length; i += PROFIT_SOURCE_IN_CHUNK) {
    const chunk = ids.slice(i, i + PROFIT_SOURCE_IN_CHUNK)
    for (let offset = 0; ; offset += PROFIT_SOURCE_PAGE_SIZE) {
      const { data, error } = await sb
        .from(table)
        .select(select)
        .eq(orgColumn, DEFAULT_ORG_ID)
        .in(column, chunk)
        .order(orderBy, { ascending: true })
        .range(offset, offset + PROFIT_SOURCE_PAGE_SIZE - 1)
      if (error) {
        console.error(`job_profitability ${table}.${column} read failed`, error)
        return { rows: [], readFault: true }
      }
      rows.push(...(data || []))
      if (!data || data.length < PROFIT_SOURCE_PAGE_SIZE) break
    }
  }
  return { rows, readFault: false }
}

async function fetchJobsInWindow(
  sb: any,
  window: { from: string; to: string },
  type?: string,
): Promise<any[]> {
  const PAGE_SIZE = 1000
  const rows: any[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = sb
      .from('jobs')
      .select(JOB_PROFIT_LIST_SELECT)
      .eq('org_id', DEFAULT_ORG_ID)
      .eq('legacy', false)
      .gte('created_at', window.from)
      .lt('created_at', window.to)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
    if (type) query = query.eq('type', type)
    const { data, error } = await query
    if (error) {
      throw new JobProfitabilityReadError(
        `job_profitability cohort jobs read failed: ${error.message || error}`,
      )
    }
    rows.push(...(data || []))
    if ((data || []).length < PAGE_SIZE) return rows
  }
}

function quoteValueFromJob(job: any): number {
  const ex = Number(job.quote_ex ?? job.pricing_json?.totalExGST)
  if (Number.isFinite(ex) && ex) return normalizeMoney(ex)
  const inc = Number(job.quote_inc ?? job.pricing_json?.totalIncGST)
  return Number.isFinite(inc) ? normalizeMoney(inc) : 0
}

function invoiceStatusFromLine(row: any): string | null {
  const nested = row.trade_invoices
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested.status ?? null
  }
  if (Array.isArray(nested) && nested[0]) return nested[0].status ?? null
  return row.invoice_status ?? null
}

function asTradeLine(row: any): TradeLineFact {
  return {
    id: row.id ?? null,
    job_id: row.job_id ?? null,
    job_number: row.job_number ?? null,
    line_type: row.line_type ?? null,
    line_total_ex: row.line_total_ex ?? null,
    override_amount: row.override_amount ?? null,
    invoice_status: invoiceStatusFromLine(row),
  }
}

function toJobInput(
  job: any,
  invoicesByJob: Record<string, any[]>,
  projectByJob: Record<string, any>,
  tradeLines: TradeLineFact[],
  materialsFacts: MaterialsFact[],
  tradeLinesUnreadable: boolean,
  materialsUnreadable: boolean,
): JobProfitInput {
  const jobInvoices = invoicesByJob[job.id] || []
  const xeroProject = projectByJob[job.id] || null
  const invoiced = xeroProject
    ? fromCents(xeroProject.total_invoiced_cents)
    : fromCents(
      sumMoneyCents(jobInvoices
        .filter((i: any) => i.invoice_type === 'ACCREC')
        .map((i: any) => i.sub_total)),
    )
  const accpayBills = fromCents(
    sumMoneyCents(jobInvoices
      .filter((i: any) => i.invoice_type === 'ACCPAY')
      .map((i: any) => i.sub_total)),
  )
  const legacyBills = xeroProject ? fromCents(xeroProject.total_expenses_cents) : accpayBills
  const input: JobProfitInput = {
    id: job.id,
    job_number: job.job_number || xeroProject?.job_number || null,
    client_name: job.client_name,
    type: job.type,
    status: job.status,
    created_at: job.created_at,
    quote_value: quoteValueFromJob(job),
    invoiced,
    legacy_bills: legacyBills,
    xero_projects_expenses: xeroProject
      ? fromCents(xeroProject.total_expenses_cents)
      : null,
    accpay_bills: accpayBills,
    trade_lines: [],
    materials_facts: [],
    expected_lanes: expectedLanesFromSnapshot(job.expected_costs),
    trade_lines_unreadable: tradeLinesUnreadable,
    materials_facts_unreadable: materialsUnreadable,
    legacy_data_source: xeroProject
      ? 'xero_projects'
      : (jobInvoices.length > 0 ? 'invoice_match' : 'none'),
  }
  input.trade_lines = tradeLines.filter((line) => tradeLineBelongsToJob(line, input))
  input.materials_facts = materialsFacts.filter((fact) => fact.job_id === job.id)
  return input
}

export async function loadJobProfitability(
  sb: any,
  params: URLSearchParams,
  now: Date = new Date(),
): Promise<JobProfitabilityReport> {
  const dateFrom = params.get('from') || null
  const dateTo = params.get('to') || null
  const jobType = params.get('type') || null
  const status = params.get('status') || null
  const limit = Math.min(parseInt(params.get('limit') || '50', 10) || 50, 5000)

  let query = sb
    .from('jobs')
    .select(JOB_PROFIT_LIST_SELECT)
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('legacy', false)
    .order('created_at', { ascending: false })

  if (jobType) query = query.eq('type', jobType)
  if (status) query = query.eq('status', status)
  if (dateFrom) query = query.gte('created_at', dateFrom)
  if (dateTo) query = query.lte('created_at', dateTo)
  query = query.limit(limit)

  const { data: jobs, error: jobErr } = await query
  if (jobErr) {
    throw new JobProfitabilityReadError(
      `job_profitability jobs read failed: ${jobErr.message || jobErr}`,
    )
  }

  const monthWindow = perthMonthWindow(now)
  const quarterWindow = perthQuarterWindow(now)
  const [fencingThisMonthJobs, allFamiliesThisQuarterJobs] = await Promise.all([
    fetchJobsInWindow(sb, monthWindow, 'fencing'),
    fetchJobsInWindow(sb, quarterWindow),
  ])

  const sourceJobsById = new Map<string, any>()
  for (const job of [
    ...(jobs || []),
    ...fencingThisMonthJobs,
    ...allFamiliesThisQuarterJobs,
  ]) {
    sourceJobsById.set(job.id, job)
  }
  const sourceJobs = [...sourceJobsById.values()]
  const pageJobIds = (jobs || []).map((j: any) => j.id)
  const fencingMonthIds = fencingThisMonthJobs.map((j: any) => j.id)
  const quarterIds = allFamiliesThisQuarterJobs.map((j: any) => j.id)
  const jobIds = sourceJobs.map((j: any) => j.id)
  const jobNumbers = [...new Set(
    sourceJobs.map((j: any) => j.job_number).filter((n: unknown) =>
      typeof n === 'string' && n.length > 0
    ),
  )] as string[]

  const invoicesByJob: Record<string, any[]> = {}
  const invoiceRead = await fetchProfitSourceRows(
    sb,
    'xero_invoices',
    'job_id, invoice_type, sub_total, total, amount_paid',
    'job_id',
    jobIds,
  )
  if (invoiceRead.readFault) {
    throw new JobProfitabilityReadError('job_profitability xero_invoices read failed')
  }
  for (const inv of invoiceRead.rows) {
    if (!invoicesByJob[inv.job_id]) invoicesByJob[inv.job_id] = []
    invoicesByJob[inv.job_id].push(inv)
  }

  const projectRead = await fetchProfitSourceRows(
    sb,
    'xero_projects',
    'job_id, project_name, job_number, total_invoiced, total_expenses, total_to_be_invoiced, status',
    'job_id',
    jobIds,
  )
  if (projectRead.readFault) {
    throw new JobProfitabilityReadError('job_profitability xero_projects read failed')
  }

  const projectsByJob: Record<string, any[]> = {}
  for (const project of projectRead.rows) {
    if (!project.job_id) continue
    if (!projectsByJob[project.job_id]) projectsByJob[project.job_id] = []
    projectsByJob[project.job_id].push(project)
  }
  const projectByJob: Record<string, any> = {}
  for (const [jobId, projects] of Object.entries(projectsByJob)) {
    const first = projects[0]
    projectByJob[jobId] = {
      project_name: first.project_name,
      job_number: first.job_number,
      total_invoiced_cents: sumMoneyCents(projects.map((p) => p.total_invoiced)),
      total_expenses_cents: sumMoneyCents(projects.map((p) => p.total_expenses)),
      to_be_invoiced_cents: sumMoneyCents(projects.map((p) => p.total_to_be_invoiced)),
      project_status: first.status,
    }
  }

  const [tradeByJobId, tradeByJobNumber, materialsRead] = await Promise.all([
    fetchProfitSourceRows(
      sb,
      'trade_invoice_lines',
      TRADE_LINE_PROFIT_SELECT,
      'job_id',
      jobIds,
      { orgColumn: 'trade_invoices.org_id' },
    ),
    jobNumbers.length > 0
      ? fetchProfitSourceRows(
        sb,
        'trade_invoice_lines',
        TRADE_LINE_PROFIT_SELECT,
        'job_number',
        jobNumbers,
        { orgColumn: 'trade_invoices.org_id' },
      )
      : Promise.resolve({ rows: [] as any[], readFault: false }),
    fetchProfitSourceRows(
      sb,
      'job_materials_facts',
      'job_id, amount_ex_gst, lane',
      'job_id',
      jobIds,
    ),
  ])

  const tradeById = new Map<string, TradeLineFact>()
  for (const row of [...tradeByJobId.rows, ...tradeByJobNumber.rows]) {
    const line = asTradeLine(row)
    const key = line.id != null ? String(line.id) : JSON.stringify(line)
    if (!tradeById.has(key)) tradeById.set(key, line)
  }
  const tradeLines = [...tradeById.values()]
  const tradeLinesUnreadable = tradeByJobId.readFault || tradeByJobNumber.readFault
  const materialsFacts: MaterialsFact[] = materialsRead.rows

  const inputs: JobProfitInput[] = sourceJobs.map((job: any) =>
    toJobInput(
      job,
      invoicesByJob,
      projectByJob,
      tradeLines,
      materialsFacts,
      tradeLinesUnreadable,
      materialsRead.readFault,
    )
  )

  const inputsById = new Map(inputs.map((input) => [input.id, input]))
  const pageInputs = pageJobIds.flatMap((id: string) => {
    const input = inputsById.get(id)
    return input ? [input] : []
  })
  const rollupIds = [...new Set([...fencingMonthIds, ...quarterIds])]
  const rollupInputs = rollupIds.flatMap((id: string) => {
    const input = inputsById.get(id)
    return input ? [input] : []
  })

  return buildJobProfitabilityReport(pageInputs, {
    now,
    xeroProjectsMatched: projectRead.rows.length,
    rollupJobs: rollupInputs,
  })
}
