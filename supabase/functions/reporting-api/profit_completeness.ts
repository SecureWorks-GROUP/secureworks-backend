// Profitability completeness — honesty rule for the job P&L read path.
//
// The live `job_profitability` action used to prefer xero_projects.total_expenses
// as job cost. When that lump was 0 (receipts not coded to the project) a job
// with real revenue reported 100% margin. Zero cost is a missing measurement,
// not a free job.
//
// This module is the read-side gate only. It does not capture cost, mint a fact
// book, or write to Xero. Xero remains the cash / bill / receivable / tax book.
// Job cost is source-backed lane facts on the job. Xero Projects is a
// low-confidence lump and never resolves a required lane.

export const PROFIT_COMPLETENESS_CONTRACT_VERSION = 'profit-unknown-v1'

export const REQUIRED_COST_LANES = ['labour', 'materials', 'commission', 'other'] as const

export type CostLane = typeof REQUIRED_COST_LANES[number]

export const TRADE_LABOUR_LINE_TYPES = [
  'labour',
  'fencing',
  'patio',
  'make safe',
  'general labour',
] as const

export const TRADE_OTHER_LINE_TYPES = ['travel', 'equipment', 'other'] as const

export const PROFIT_SOURCE_IN_CHUNK = 25

export type ProfitStatus = 'complete' | 'partial' | 'unknown'

export type LaneSource = 'trade_invoice_lines' | 'job_materials_facts'

export type LaneResolution =
  | {
    resolved: true
    amount_ex_gst: number
    source: LaneSource
    confidence: 'job_book'
    line_count: number
  }
  | {
    resolved: false
    amount_ex_gst: null
    source: null
    confidence: null
    reason: 'no_source' | 'source_unreadable'
  }

export type UntrustedCostLump = {
  source: 'xero_projects' | 'accpay_invoices'
  amount_ex_gst: number
  confidence: 'low'
}

export type TradeLineFact = {
  id?: string | null
  job_id?: string | null
  job_number?: string | null
  line_type?: string | null
  line_total_ex?: number | string | null
}

export type MaterialsFact = {
  job_id?: string | null
  amount_ex_gst?: number | string | null
  lane?: string | null
}

export type JobProfitInput = {
  id: string
  job_number?: string | null
  client_name?: string | null
  type: string
  status?: string | null
  created_at: string
  quote_value: number
  invoiced: number
  // Legacy lump the previous report would have used as `bills`. Diagnostic
  // only — never resolves a lane and never becomes reported margin on its own.
  legacy_bills: number
  xero_projects_expenses?: number | null
  accpay_bills?: number | null
  trade_lines: TradeLineFact[]
  materials_facts: MaterialsFact[]
  expected_lanes?: Partial<Record<CostLane, number>>
  trade_lines_unreadable?: boolean
  materials_facts_unreadable?: boolean
  legacy_data_source?: 'xero_projects' | 'invoice_match' | 'none'
}

export type JobProfitabilityRow = {
  id: string
  job_number: string | null
  client_name: string | null
  type: string
  status: string | null
  created_at: string
  quote_value: number
  invoiced: number
  bills: number | null
  margin: number | null
  margin_pct: number | null
  profit_status: ProfitStatus
  missing_lanes: CostLane[]
  amount_at_risk: number
  missing_expected_ex_gst: number | null
  resolved_cost_ex_gst: number | null
  lanes: Record<CostLane, LaneResolution>
  untrusted_cost_lumps: UntrustedCostLump[]
  unclassified_cost_ex_gst: number
  data_source: string
  cost_authority: 'job_book' | 'none'
}

export type ProfitabilityRollup = {
  label: string
  job_count: number
  total_invoiced: number
  complete_count: number
  partial_count: number
  unknown_count: number
  excluded_from_margin_count: number
  excluded_from_margin_dollars: number
  complete_invoiced: number
  complete_cost: number
  complete_margin: number
  avg_margin_pct: number | null
}

export type JobProfitabilityReport = {
  jobs: JobProfitabilityRow[]
  summary: ProfitabilityRollup & {
    total_jobs: number
    total_invoiced: number
    total_bills: number | null
    total_margin: number | null
    data_sources: Record<string, number>
    profit_status_counts: Record<ProfitStatus, number>
    xero_projects_matched: number
    contract_version: string
  }
  rollups: {
    fencing_this_month: ProfitabilityRollup
    all_families_this_quarter: ProfitabilityRollup
  }
}

// Same arithmetic the previous job_profitability path used for a costed job:
// margin = invoiced - bills; integer percent. A complete job-book total is
// fed in as `bills` so a fully costed row stays identical to that formula.
export function computeLegacyJobMargin(
  invoiced: number,
  bills: number,
): { margin: number; margin_pct: number } {
  const margin = (Math.round(invoiced * 100) - Math.round(bills * 100)) / 100
  const margin_pct = invoiced > 0 ? Math.round((margin / invoiced) * 100) : 0
  return { margin, margin_pct }
}

export function classifyTradeCostLane(
  lineType: unknown,
): CostLane | 'unclassified' {
  const t = String(lineType ?? '').trim().toLowerCase()
  if ((TRADE_LABOUR_LINE_TYPES as readonly string[]).includes(t)) return 'labour'
  if (t === 'materials') return 'materials'
  if (t === 'commission') return 'commission'
  if ((TRADE_OTHER_LINE_TYPES as readonly string[]).includes(t)) return 'other'
  return 'unclassified'
}

function money(n: unknown): number {
  const v = typeof n === 'string' ? parseFloat(n) : Number(n)
  return Number.isFinite(v) ? v : 0
}

function validMoney(n: unknown): number | null {
  if (n == null || (typeof n === 'string' && n.trim() === '')) return null
  const v = typeof n === 'string' ? Number(n) : n
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function sumMoney(values: number[]): number {
  return values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100
}

function dollarsAtRisk(invoiced: number, quoteValue: number): number {
  if (invoiced > 0) return invoiced
  if (quoteValue > 0) return quoteValue
  return 0
}

function uniqueTradeLines(lines: TradeLineFact[]): TradeLineFact[] {
  const seen = new Set<string>()
  const out: TradeLineFact[] = []
  for (const line of lines) {
    if (line.id != null && line.id !== '') {
      const key = String(line.id)
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(line)
  }
  return out
}

function tradeLineBelongsToJob(line: TradeLineFact, job: JobProfitInput): boolean {
  if (line.job_id && line.job_id === job.id) return true
  const jobNumber = (job.job_number || '').trim()
  const lineNumber = String(line.job_number || '').trim()
  return jobNumber.length > 0 && lineNumber.length > 0 && jobNumber === lineNumber
}

function resolveFromTradeLines(
  job: JobProfitInput,
  lane: CostLane,
): LaneResolution {
  if (job.trade_lines_unreadable) {
    return {
      resolved: false,
      amount_ex_gst: null,
      source: null,
      confidence: null,
      reason: 'source_unreadable',
    }
  }
  const matching = (job.trade_lines || []).filter((line) =>
    tradeLineBelongsToJob(line, job) && classifyTradeCostLane(line.line_type) === lane
  )
  if (matching.length === 0) {
    return {
      resolved: false,
      amount_ex_gst: null,
      source: null,
      confidence: null,
      reason: 'no_source',
    }
  }
  const amounts = matching.map((line) => validMoney(line.line_total_ex))
  if (amounts.some((amount) => amount == null)) {
    return {
      resolved: false,
      amount_ex_gst: null,
      source: null,
      confidence: null,
      reason: 'source_unreadable',
    }
  }
  const amount = sumMoney(amounts as number[])
  if (amount <= 0) {
    return {
      resolved: false,
      amount_ex_gst: null,
      source: null,
      confidence: null,
      reason: 'no_source',
    }
  }
  return {
    resolved: true,
    amount_ex_gst: amount,
    source: 'trade_invoice_lines',
    confidence: 'job_book',
    line_count: matching.length,
  }
}

function resolveMaterialsLane(job: JobProfitInput): LaneResolution {
  if (job.materials_facts_unreadable) {
    return {
      resolved: false,
      amount_ex_gst: null,
      source: null,
      confidence: null,
      reason: 'source_unreadable',
    }
  }
  const matching = (job.materials_facts || []).filter((fact) => {
    if (fact.job_id !== job.id) return false
    const lane = String(fact.lane || 'materials').trim().toLowerCase()
    return lane === 'materials' || lane === ''
  })
  if (matching.length === 0) {
    // Materials can also land on a trade invoice line. Prefer the materials
    // fact table; fall back to classified trade lines so a source-backed
    // figure is not dropped.
    return resolveFromTradeLines(job, 'materials')
  }
  const amounts = matching.map((fact) => validMoney(fact.amount_ex_gst))
  if (amounts.some((amount) => amount == null)) {
    return {
      resolved: false,
      amount_ex_gst: null,
      source: null,
      confidence: null,
      reason: 'source_unreadable',
    }
  }
  const amount = sumMoney(amounts as number[])
  if (amount <= 0) {
    return {
      resolved: false,
      amount_ex_gst: null,
      source: null,
      confidence: null,
      reason: 'no_source',
    }
  }
  return {
    resolved: true,
    amount_ex_gst: amount,
    source: 'job_materials_facts',
    confidence: 'job_book',
    line_count: matching.length,
  }
}

function unclassifiedAmount(job: JobProfitInput): number {
  if (job.trade_lines_unreadable) return 0
  return (job.trade_lines || [])
    .filter((line) =>
      tradeLineBelongsToJob(line, job) &&
      classifyTradeCostLane(line.line_type) === 'unclassified'
    )
    .reduce((s, line) => s + money(line.line_total_ex), 0)
}

function untrustedLumps(job: JobProfitInput): UntrustedCostLump[] {
  const lumps: UntrustedCostLump[] = []
  const xero = money(job.xero_projects_expenses)
  if (job.xero_projects_expenses != null && Number.isFinite(Number(job.xero_projects_expenses))) {
    lumps.push({
      source: 'xero_projects',
      amount_ex_gst: xero,
      confidence: 'low',
    })
  }
  const accpay = money(job.accpay_bills)
  if (job.accpay_bills != null && accpay !== 0) {
    lumps.push({
      source: 'accpay_invoices',
      amount_ex_gst: accpay,
      confidence: 'low',
    })
  }
  return lumps
}

export function assessJobProfitCompleteness(job: JobProfitInput): JobProfitabilityRow {
  const jobForLanes: JobProfitInput = {
    ...job,
    trade_lines: uniqueTradeLines(job.trade_lines || []),
  }
  const lanes: Record<CostLane, LaneResolution> = {
    labour: resolveFromTradeLines(jobForLanes, 'labour'),
    materials: resolveMaterialsLane(jobForLanes),
    commission: resolveFromTradeLines(jobForLanes, 'commission'),
    other: resolveFromTradeLines(jobForLanes, 'other'),
  }

  const missing_lanes = REQUIRED_COST_LANES.filter((lane) => !lanes[lane].resolved)
  const resolvedLanes = REQUIRED_COST_LANES.filter((lane) => lanes[lane].resolved)
  const resolved_cost_ex_gst = resolvedLanes.length === 0
    ? null
    : sumMoney(resolvedLanes.map((lane) => {
      const r = lanes[lane]
      return r.resolved ? r.amount_ex_gst : 0
    }))

  const unclassified_cost_ex_gst = unclassifiedAmount(jobForLanes)
  const lumps = untrustedLumps(jobForLanes)

  let profit_status: ProfitStatus
  if (resolvedLanes.length === 0) {
    profit_status = 'unknown'
  } else if (missing_lanes.length > 0 || unclassified_cost_ex_gst !== 0) {
    profit_status = 'partial'
  } else {
    profit_status = 'complete'
  }

  const amount_at_risk = profit_status === 'complete'
    ? 0
    : dollarsAtRisk(job.invoiced, job.quote_value)

  let missing_expected_ex_gst: number | null = null
  if (profit_status !== 'complete' && job.expected_lanes) {
    let any = false
    let sum = 0
    for (const lane of missing_lanes) {
      const expected = job.expected_lanes[lane]
      if (typeof expected === 'number' && Number.isFinite(expected)) {
        any = true
        sum += expected
      }
    }
    missing_expected_ex_gst = any ? sum : null
  }

  let margin: number | null = null
  let margin_pct: number | null = null
  let bills: number | null = resolved_cost_ex_gst

  if (profit_status === 'complete' && resolved_cost_ex_gst != null) {
    const computed = computeLegacyJobMargin(job.invoiced, resolved_cost_ex_gst)
    margin = computed.margin
    margin_pct = computed.margin_pct
    bills = resolved_cost_ex_gst
  }

  const data_source = profit_status === 'complete'
    ? 'job_book_lanes'
    : (job.legacy_data_source ??
      (lumps.some((l) => l.source === 'xero_projects')
        ? 'xero_projects'
        : job.legacy_bills !== 0
        ? 'invoice_match'
        : 'none'))

  return {
    id: job.id,
    job_number: job.job_number ?? null,
    client_name: job.client_name ?? null,
    type: job.type,
    status: job.status ?? null,
    created_at: job.created_at,
    quote_value: job.quote_value,
    invoiced: job.invoiced,
    bills,
    margin,
    margin_pct,
    profit_status,
    missing_lanes,
    amount_at_risk,
    missing_expected_ex_gst,
    resolved_cost_ex_gst,
    lanes,
    untrusted_cost_lumps: lumps,
    unclassified_cost_ex_gst,
    data_source,
    cost_authority: profit_status === 'complete' ? 'job_book' : 'none',
  }
}

export function expectedLanesFromSnapshot(
  snapshot: unknown,
): JobProfitInput['expected_lanes'] {
  if (!snapshot || typeof snapshot !== 'object') return undefined
  const lanes = (snapshot as { lanes?: Record<string, { amount_ex_gst?: unknown }> })
    .lanes
  if (!lanes || typeof lanes !== 'object') return undefined
  const out: NonNullable<JobProfitInput['expected_lanes']> = {}
  let any = false
  for (const lane of REQUIRED_COST_LANES) {
    const amount = lanes[lane]?.amount_ex_gst
    const n = typeof amount === 'string' ? parseFloat(amount) : Number(amount)
    if (typeof n === 'number' && Number.isFinite(n)) {
      out[lane] = n
      any = true
    }
  }
  return any ? out : undefined
}

export function rollUpJobProfitability(
  rows: JobProfitabilityRow[],
  label: string,
): ProfitabilityRollup {
  let complete_count = 0
  let partial_count = 0
  let unknown_count = 0
  const completeInvoiced: number[] = []
  const completeCosts: number[] = []
  const completeMargins: number[] = []
  const excludedDollars: number[] = []

  for (const row of rows) {
    if (row.profit_status === 'complete') {
      complete_count += 1
      completeInvoiced.push(row.invoiced)
      completeCosts.push(row.resolved_cost_ex_gst ?? 0)
      completeMargins.push(row.margin ?? 0)
    } else {
      if (row.profit_status === 'partial') partial_count += 1
      else unknown_count += 1
      excludedDollars.push(row.amount_at_risk)
    }
  }

  const complete_invoiced = sumMoney(completeInvoiced)
  const complete_cost = sumMoney(completeCosts)
  const complete_margin = sumMoney(completeMargins)
  const excluded_from_margin_dollars = sumMoney(excludedDollars)
  const total_invoiced = sumMoney(rows.map((row) => row.invoiced))
  const excluded_from_margin_count = partial_count + unknown_count
  const avg_margin_pct = complete_count === 0 || complete_invoiced <= 0
    ? null
    : Math.round((complete_margin / complete_invoiced) * 100)

  return {
    label,
    job_count: rows.length,
    total_invoiced,
    complete_count,
    partial_count,
    unknown_count,
    excluded_from_margin_count,
    excluded_from_margin_dollars,
    complete_invoiced,
    complete_cost,
    complete_margin,
    avg_margin_pct,
  }
}

export function utcMonthWindow(now: Date): { from: string; to: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { from: from.toISOString(), to: to.toISOString() }
}

export function utcQuarterWindow(now: Date): { from: string; to: string } {
  const quarter = Math.floor(now.getUTCMonth() / 3)
  const from = new Date(Date.UTC(now.getUTCFullYear(), quarter * 3, 1))
  const to = new Date(Date.UTC(now.getUTCFullYear(), quarter * 3 + 3, 1))
  return { from: from.toISOString(), to: to.toISOString() }
}

function inWindow(iso: string, from: string, to: string): boolean {
  return iso >= from && iso < to
}

export function buildJobProfitabilityReport(
  jobs: JobProfitInput[],
  opts: {
    now?: Date
    xeroProjectsMatched?: number
    rollupJobs?: JobProfitInput[]
  } = {},
): JobProfitabilityReport {
  const now = opts.now ?? new Date()
  const rows = jobs.map(assessJobProfitCompleteness)
  const rollupRows = (opts.rollupJobs ?? jobs).map(assessJobProfitCompleteness)
  const summaryRollup = rollUpJobProfitability(rows, 'returned_cohort')
  const month = utcMonthWindow(now)
  const quarter = utcQuarterWindow(now)

  const fencingThisMonth = rollupRows.filter((r) =>
    r.type === 'fencing' && inWindow(r.created_at, month.from, month.to)
  )
  const allFamiliesThisQuarter = rollupRows.filter((r) =>
    inWindow(r.created_at, quarter.from, quarter.to)
  )

  const data_sources: Record<string, number> = {}
  const profit_status_counts: Record<ProfitStatus, number> = {
    complete: 0,
    partial: 0,
    unknown: 0,
  }
  for (const row of rows) {
    data_sources[row.data_source] = (data_sources[row.data_source] || 0) + 1
    profit_status_counts[row.profit_status] += 1
  }

  return {
    jobs: rows,
    summary: {
      ...summaryRollup,
      total_jobs: rows.length,
      total_bills: summaryRollup.complete_count === 0 ? null : summaryRollup.complete_cost,
      total_margin: summaryRollup.complete_count === 0 ? null : summaryRollup.complete_margin,
      data_sources,
      profit_status_counts,
      xero_projects_matched: opts.xeroProjectsMatched ?? 0,
      contract_version: PROFIT_COMPLETENESS_CONTRACT_VERSION,
    },
    rollups: {
      fencing_this_month: rollUpJobProfitability(
        fencingThisMonth,
        'fencing_this_month',
      ),
      all_families_this_quarter: rollUpJobProfitability(
        allFamiliesThisQuarter,
        'all_families_this_quarter',
      ),
    },
  }
}

export function emptyLaneFacts(): {
  trade_lines: TradeLineFact[]
  materials_facts: MaterialsFact[]
} {
  return { trade_lines: [], materials_facts: [] }
}
