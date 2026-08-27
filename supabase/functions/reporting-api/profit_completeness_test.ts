// Fixture-cohort proof for S2: profit unknown, never a false margin.
//
// Reproduces the live failure (zero cost rows reporting 100% margin) and
// asserts the honesty rule. Perturbing a resolved lane MUST flip complete
// to partial; if this file is green after that change, the proof is broken.

import {
  assert,
  assertEquals,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts'

import {
  AUTHORISED_TRADE_INVOICE_STATUSES,
  PROFIT_COMPLETENESS_CONTRACT_VERSION,
  REQUIRED_COST_LANES,
  assessJobProfitCompleteness,
  buildJobProfitabilityReport,
  classifyTradeCostLane,
  computeLegacyJobMargin,
  perthMonthWindow,
  utcMonthWindow,
  type JobProfitInput,
  type JobProfitabilityRow,
} from './profit_completeness.ts'

const NOW = new Date('2026-08-27T00:00:00.000Z')

// Fully costed control: these numbers are the "as today" formula.
const COMPLETE_INVOICED = 10000.57
const COMPLETE_LABOUR = 3000.11
const COMPLETE_MATERIALS = 3000.06
const COMPLETE_COMMISSION = 800.04
const COMPLETE_OTHER = 200.03
const COMPLETE_BILLS = 7000.24
const COMPLETE_MARGIN = 3000.33

function tradeLine(
  jobId: string,
  lineType: string,
  amount: number,
  jobNumber?: string,
  extra: Record<string, unknown> = {},
) {
  return {
    job_id: jobId,
    job_number: jobNumber ?? null,
    line_type: lineType,
    line_total_ex: amount,
    invoice_status: 'paid',
    ...extra,
  }
}

function materialsFact(jobId: string, amount: number) {
  return {
    job_id: jobId,
    amount_ex_gst: amount,
    lane: 'materials',
  }
}

function emptyCostJob(): JobProfitInput {
  return {
    id: 'job-empty-cost',
    job_number: 'SWF-EMPTY',
    client_name: 'Empty Cost Pty',
    type: 'fencing',
    status: 'complete',
    created_at: '2026-08-10T00:00:00.000Z',
    quote_value: 12000,
    invoiced: 12000,
    legacy_bills: 0,
    xero_projects_expenses: 0,
    accpay_bills: 0,
    trade_lines: [],
    materials_facts: [],
  }
}

function materialsOnlyJob(): JobProfitInput {
  return {
    id: 'job-materials-only',
    job_number: 'SWF-MATS',
    client_name: 'Materials Only Pty',
    type: 'fencing',
    status: 'complete',
    created_at: '2026-08-12T00:00:00.000Z',
    quote_value: 8000,
    invoiced: 8000,
    legacy_bills: 2500,
    xero_projects_expenses: 2500,
    trade_lines: [],
    materials_facts: [materialsFact('job-materials-only', 2500)],
  }
}

function fullyCostedJob(): JobProfitInput {
  return {
    id: 'job-fully-costed',
    job_number: 'SWF-FULL',
    client_name: 'Fully Costed Pty',
    type: 'fencing',
    status: 'invoiced',
    created_at: '2026-08-15T00:00:00.000Z',
    quote_value: COMPLETE_INVOICED,
    invoiced: COMPLETE_INVOICED,
    legacy_bills: COMPLETE_BILLS,
    xero_projects_expenses: COMPLETE_BILLS,
    trade_lines: [
      tradeLine('job-fully-costed', 'labour', COMPLETE_LABOUR, 'SWF-FULL'),
      tradeLine('job-fully-costed', 'commission', COMPLETE_COMMISSION, 'SWF-FULL'),
      tradeLine('job-fully-costed', 'travel', COMPLETE_OTHER, 'SWF-FULL'),
    ],
    materials_facts: [materialsFact('job-fully-costed', COMPLETE_MATERIALS)],
  }
}

function xeroLumpOnlyJob(): JobProfitInput {
  return {
    id: 'job-xero-lump',
    job_number: 'SWF-XERO',
    client_name: 'Xero Lump Pty',
    type: 'fencing',
    status: 'complete',
    created_at: '2026-05-04T00:00:00.000Z',
    quote_value: 9000,
    invoiced: 9000,
    legacy_bills: 2000,
    xero_projects_expenses: 2000,
    trade_lines: [],
    materials_facts: [],
  }
}

function patioPartialJob(): JobProfitInput {
  return {
    id: 'job-patio-partial',
    job_number: 'SWP-PARTIAL',
    client_name: 'Patio Partial Pty',
    type: 'patio',
    status: 'complete',
    created_at: '2026-07-20T00:00:00.000Z',
    quote_value: 15000,
    invoiced: 15000,
    legacy_bills: 4000,
    trade_lines: [tradeLine('job-patio-partial', 'patio', 4000, 'SWP-PARTIAL')],
    materials_facts: [],
  }
}

function fixtureCohort(): JobProfitInput[] {
  return [
    emptyCostJob(),
    materialsOnlyJob(),
    fullyCostedJob(),
    xeroLumpOnlyJob(),
    patioPartialJob(),
  ]
}

function byId(rows: JobProfitabilityRow[], id: string): JobProfitabilityRow {
  const row = rows.find((r) => r.id === id)
  if (!row) throw new Error(`missing cohort row ${id}`)
  return row
}

Deno.test('contract version is pinned in one place', () => {
  assertEquals(PROFIT_COMPLETENESS_CONTRACT_VERSION, 'profit-unknown-v1')
  assertEquals([...REQUIRED_COST_LANES], [
    'labour',
    'materials',
    'commission',
    'other',
  ])
})

Deno.test('trade line classification matches the job_financials lane CASE', () => {
  assertEquals(classifyTradeCostLane('labour'), 'labour')
  assertEquals(classifyTradeCostLane('fencing'), 'labour')
  assertEquals(classifyTradeCostLane('patio'), 'labour')
  assertEquals(classifyTradeCostLane('make safe'), 'labour')
  assertEquals(classifyTradeCostLane('general labour'), 'labour')
  assertEquals(classifyTradeCostLane('materials'), 'materials')
  assertEquals(classifyTradeCostLane('commission'), 'commission')
  assertEquals(classifyTradeCostLane('travel'), 'other')
  assertEquals(classifyTradeCostLane('equipment'), 'other')
  assertEquals(classifyTradeCostLane('other'), 'other')
  assertEquals(classifyTradeCostLane('mystery'), 'unclassified')
})

Deno.test('1. zero cost rows report unknown and do NOT report 100% margin', () => {
  const row = assessJobProfitCompleteness(emptyCostJob())
  assertEquals(row.profit_status, 'unknown')
  assertEquals(row.margin, null)
  assertEquals(row.margin_pct, null)
  assertEquals(row.bills, null)
  assertEquals(row.resolved_cost_ex_gst, null)
  assertEquals(row.missing_lanes, ['labour', 'materials', 'commission', 'other'])
  assertEquals(row.amount_at_risk, 12000)
  assert(
    row.margin_pct !== 100,
    'empty cost must never report 100% margin',
  )
  assert(
    row.margin !== 12000,
    'empty cost must never report GP as if costs were free',
  )
  // What the previous path would have emitted: invoiced 12000, bills 0 → 100%.
  const today = computeLegacyJobMargin(12000, 0)
  assertEquals(today.margin_pct, 100)
  assertNotEquals(row.margin_pct, today.margin_pct)
  assertEquals(
    row.untrusted_cost_lumps.some((l) =>
      l.source === 'xero_projects' && l.confidence === 'low'
    ),
    true,
  )
})

Deno.test('2. materials only reports partial and names labour in missing_lanes', () => {
  const row = assessJobProfitCompleteness(materialsOnlyJob())
  assertEquals(row.profit_status, 'partial')
  assertEquals(row.margin, null)
  assertEquals(row.margin_pct, null)
  assert(row.missing_lanes.includes('labour'), 'labour must be missing')
  assert(row.missing_lanes.includes('commission'))
  assert(row.missing_lanes.includes('other'))
  assertEquals(row.missing_lanes.includes('materials'), false)
  assertEquals(row.lanes.materials.resolved, true)
  if (row.lanes.materials.resolved) {
    assertEquals(row.lanes.materials.amount_ex_gst, 2500)
    assertEquals(row.lanes.materials.source, 'job_materials_facts')
    assertEquals(row.lanes.materials.confidence, 'job_book')
  }
  assertEquals(row.amount_at_risk, 8000)
  assert(
    row.margin_pct !== 100,
    'partial cost must never report a complete 100% margin',
  )
})

Deno.test('3. fully costed job computes margin exactly as today, to the cent', () => {
  const row = assessJobProfitCompleteness(fullyCostedJob())
  assertEquals(row.profit_status, 'complete')
  assertEquals(row.missing_lanes, [])
  assertEquals(row.amount_at_risk, 0)
  assertEquals(row.resolved_cost_ex_gst, COMPLETE_BILLS)
  assertEquals(row.cost_authority, 'job_book')

  // Independent copy of today's formula — not a stub of the helper under test.
  const todayMargin =
    (Math.round(COMPLETE_INVOICED * 100) - Math.round(COMPLETE_BILLS * 100)) / 100
  const todayPct = Math.round((todayMargin / COMPLETE_INVOICED) * 100)
  assertEquals(todayMargin, COMPLETE_MARGIN)
  assertEquals(todayPct, 30)
  assertEquals(row.margin, todayMargin)
  assertEquals(row.margin_pct, todayPct)
  assertEquals(row.bills, COMPLETE_BILLS)
  assertEquals(computeLegacyJobMargin(COMPLETE_INVOICED, COMPLETE_BILLS), {
    margin: todayMargin,
    margin_pct: todayPct,
  })
})

Deno.test('xero projects lump never launders into a complete margin', () => {
  const row = assessJobProfitCompleteness(xeroLumpOnlyJob())
  assertEquals(row.profit_status, 'unknown')
  assertEquals(row.margin, null)
  assertEquals(row.margin_pct, null)
  assertEquals(row.cost_authority, 'none')
  assertEquals(
    row.untrusted_cost_lumps.find((l) => l.source === 'xero_projects')?.confidence,
    'low',
  )
  assertEquals(
    row.untrusted_cost_lumps.find((l) => l.source === 'xero_projects')?.amount_ex_gst,
    2000,
  )
  const today = computeLegacyJobMargin(9000, 2000)
  assertEquals(today.margin_pct, 78)
  assertNotEquals(row.margin_pct, today.margin_pct)
})

Deno.test('4. aggregates exclude unknown/partial from margin and report excluded dollars', () => {
  const report = buildJobProfitabilityReport(fixtureCohort(), { now: NOW })

  const fencing = report.rollups.fencing_this_month
  assertEquals(fencing.label, 'fencing_this_month')
  assertEquals(fencing.job_count, 3) // empty, materials-only, fully-costed (August)
  assertEquals(fencing.complete_count, 1)
  assertEquals(fencing.partial_count, 1)
  assertEquals(fencing.unknown_count, 1)
  assertEquals(fencing.excluded_from_margin_count, 2)
  assertEquals(fencing.excluded_from_margin_dollars, 12000 + 8000)
  assertEquals(fencing.total_invoiced, 30000.57)
  assertEquals(fencing.complete_invoiced, COMPLETE_INVOICED)
  assertEquals(fencing.complete_cost, COMPLETE_BILLS)
  assertEquals(fencing.complete_margin, COMPLETE_MARGIN)
  assertEquals(fencing.avg_margin_pct, 30)

  const quarter = report.rollups.all_families_this_quarter
  assertEquals(quarter.job_count, 4) // May xero-lump is Q2, excluded
  assertEquals(quarter.complete_count, 1)
  assertEquals(quarter.partial_count, 2)
  assertEquals(quarter.unknown_count, 1)
  assertEquals(quarter.excluded_from_margin_count, 3)
  assertEquals(quarter.excluded_from_margin_dollars, 12000 + 8000 + 15000)
  assertEquals(quarter.total_invoiced, 45000.57)
  assertEquals(quarter.avg_margin_pct, 30)
  assertEquals(quarter.complete_margin, COMPLETE_MARGIN)
})

Deno.test('5. perturbation: drop a resolved lane and the job flips to partial', () => {
  const complete = fullyCostedJob()
  const before = assessJobProfitCompleteness(complete)
  assertEquals(before.profit_status, 'complete')
  assertEquals(before.margin_pct, 30)

  const perturbed: JobProfitInput = {
    ...complete,
    trade_lines: complete.trade_lines.filter((line) =>
      classifyTradeCostLane(line.line_type) !== 'labour'
    ),
  }
  const after = assessJobProfitCompleteness(perturbed)
  assertEquals(after.profit_status, 'partial')
  assertEquals(after.margin, null)
  assertEquals(after.margin_pct, null)
  assert(
    after.missing_lanes.includes('labour'),
    'perturbed labour lane must be named',
  )
  assertEquals(after.lanes.materials.resolved, true)
  assertEquals(after.lanes.commission.resolved, true)
  assertEquals(after.lanes.other.resolved, true)
})

Deno.test('acceptance: cohort counts and zero empty-cost 100% margins', () => {
  const report = buildJobProfitabilityReport(fixtureCohort(), { now: NOW })
  const rows = report.jobs

  const complete = rows.filter((r) => r.profit_status === 'complete')
  const partial = rows.filter((r) => r.profit_status === 'partial')
  const unknown = rows.filter((r) => r.profit_status === 'unknown')

  assertEquals(complete.length, 1, 'count reporting a margin')
  assertEquals(partial.length, 2, 'count partial')
  assertEquals(unknown.length, 2, 'count unknown')
  assertEquals(report.summary.profit_status_counts, {
    complete: 1,
    partial: 2,
    unknown: 2,
  })

  const empty = byId(rows, 'job-empty-cost')
  assertEquals(empty.profit_status, 'unknown')
  assert(empty.margin_pct !== 100)
  assertEquals(empty.margin, null)

  const hundredOnEmpty = rows.filter((r) =>
    r.resolved_cost_ex_gst == null && r.margin_pct === 100
  )
  assertEquals(
    hundredOnEmpty.length,
    0,
    'zero of the cohort report 100% on empty cost',
  )

  for (const row of rows) {
    if (row.profit_status !== 'complete') {
      assertEquals(row.margin, null)
      assertEquals(row.margin_pct, null)
    }
  }

  // Incomplete jobs must not be averaged into the headline margin.
  assertEquals(report.summary.avg_margin_pct, 30)
  assertEquals(report.summary.total_margin, COMPLETE_MARGIN)
  assertEquals(report.summary.total_invoiced, 54000.57)
  assertEquals(report.summary.excluded_from_margin_count, 4)
})

Deno.test('job book wins over a mismatched xero projects lump', () => {
  const job = fullyCostedJob()
  job.xero_projects_expenses = 0
  job.legacy_bills = 0
  const row = assessJobProfitCompleteness(job)
  assertEquals(row.profit_status, 'complete')
  assertEquals(row.margin, COMPLETE_MARGIN)
  assertEquals(row.margin_pct, 30)
  const todayIfXeroOwned = computeLegacyJobMargin(COMPLETE_INVOICED, 0)
  assertEquals(todayIfXeroOwned.margin_pct, 100)
  assertNotEquals(row.margin_pct, todayIfXeroOwned.margin_pct)
})

Deno.test('unreadable materials source fails closed, never resolves to zero', () => {
  const job = materialsOnlyJob()
  job.materials_facts_unreadable = true
  job.materials_facts = [materialsFact('job-materials-only', 2500)]
  const row = assessJobProfitCompleteness(job)
  assertEquals(row.lanes.materials.resolved, false)
  if (!row.lanes.materials.resolved) {
    assertEquals(row.lanes.materials.reason, 'source_unreadable')
  }
  assertEquals(row.profit_status, 'unknown')
  assertEquals(row.margin_pct, null)
})

Deno.test('zero and invalid lane totals remain unresolved', () => {
  const zero = fullyCostedJob()
  zero.trade_lines = zero.trade_lines.map((line) =>
    line.line_type === 'labour' ? { ...line, line_total_ex: 0 } : line
  )
  const zeroRow = assessJobProfitCompleteness(zero)
  assertEquals(zeroRow.lanes.labour.resolved, false)
  assertEquals(zeroRow.profit_status, 'partial')
  assertEquals(zeroRow.margin, null)

  const invalid = fullyCostedJob()
  invalid.materials_facts = [{
    job_id: invalid.id,
    amount_ex_gst: 'not-money',
    lane: 'materials',
  }]
  const invalidRow = assessJobProfitCompleteness(invalid)
  assertEquals(invalidRow.lanes.materials.resolved, false)
  assertEquals(invalidRow.profit_status, 'partial')
  assertEquals(invalidRow.margin, null)
})

Deno.test('rollups use their full cohort independently of the returned page', () => {
  const report = buildJobProfitabilityReport([fullyCostedJob()], {
    now: NOW,
    rollupJobs: fixtureCohort(),
  })
  assertEquals(report.jobs.length, 1)
  assertEquals(report.summary.total_invoiced, COMPLETE_INVOICED)
  assertEquals(report.rollups.fencing_this_month.job_count, 3)
  assertEquals(report.rollups.all_families_this_quarter.job_count, 4)
  assertEquals(report.rollups.all_families_this_quarter.partial_count, 2)
  assertEquals(report.rollups.all_families_this_quarter.unknown_count, 1)
})

Deno.test('duplicate trade line ids are counted once', () => {
  const job = fullyCostedJob()
  const labour = job.trade_lines.find((l) => l.line_type === 'labour')!
  job.trade_lines = [
    { ...labour, id: 'line-labour' },
    { ...labour, id: 'line-labour' },
    ...job.trade_lines.filter((l) => l.line_type !== 'labour').map((l, i) => ({
      ...l,
      id: `line-${l.line_type}-${i}`,
    })),
  ]
  const row = assessJobProfitCompleteness(job)
  assertEquals(row.profit_status, 'complete')
  if (row.lanes.labour.resolved) {
    assertEquals(row.lanes.labour.amount_ex_gst, COMPLETE_LABOUR)
    assertEquals(row.lanes.labour.line_count, 1)
  }
})

Deno.test('unclassified trade lines block complete even when required lanes resolve', () => {
  const job = fullyCostedJob()
  job.trade_lines = [
    ...job.trade_lines,
    tradeLine('job-fully-costed', 'mystery-kit', 50, 'SWF-FULL'),
  ]
  const row = assessJobProfitCompleteness(job)
  assertEquals(row.profit_status, 'partial')
  assertEquals(row.unclassified_cost_ex_gst, 50)
  assertEquals(row.margin, null)
})

Deno.test('draft, rejected and voided trade invoices leave the lane unresolved', () => {
  assertEquals([...AUTHORISED_TRADE_INVOICE_STATUSES], [
    'approved',
    'pushed_to_xero',
    'paid',
  ])
  for (const status of ['draft', 'ops-reject', 'pending_ops_review', 'queried']) {
    const job = fullyCostedJob()
    job.trade_lines = job.trade_lines.map((line) => ({
      ...line,
      invoice_status: status,
    }))
    const row = assessJobProfitCompleteness(job)
    assertEquals(row.lanes.labour.resolved, false, status)
    assertEquals(row.profit_status, 'partial')
    assertEquals(row.margin, null)
  }
})

Deno.test('override_amount is the authorised trade cost, not line_total_ex', () => {
  const job = fullyCostedJob()
  job.trade_lines = job.trade_lines.map((line) =>
    line.line_type === 'labour'
      ? { ...line, line_total_ex: 100, override_amount: COMPLETE_LABOUR }
      : line
  )
  const row = assessJobProfitCompleteness(job)
  assertEquals(row.profit_status, 'complete')
  if (row.lanes.labour.resolved) {
    assertEquals(row.lanes.labour.amount_ex_gst, COMPLETE_LABOUR)
  }
  assertEquals(row.margin, COMPLETE_MARGIN)
})

Deno.test('a present job_id is authoritative; stale job_number does not steal the line', () => {
  const job = fullyCostedJob()
  job.trade_lines = job.trade_lines.map((line) =>
    line.line_type === 'labour'
      ? { ...line, job_id: 'other-job', job_number: job.job_number }
      : line
  )
  const row = assessJobProfitCompleteness(job)
  assertEquals(row.lanes.labour.resolved, false)
  assertEquals(row.profit_status, 'partial')
  assertEquals(row.margin, null)
})

Deno.test('fencing this month uses Australia/Perth midnight, not UTC', () => {
  const now = new Date('2026-08-31T16:30:00.000Z') // 00:30 1 Sep Perth
  const perth = perthMonthWindow(now)
  const utc = utcMonthWindow(now)
  assertEquals(perth.from, '2026-08-31T16:00:00.000Z')
  assertNotEquals(perth.from, utc.from)
  assertEquals(utc.from, '2026-08-01T00:00:00.000Z')

  const septemberJob: JobProfitInput = {
    ...fullyCostedJob(),
    created_at: '2026-08-31T16:10:00.000Z',
  }
  const augustJob: JobProfitInput = {
    ...emptyCostJob(),
    created_at: '2026-08-31T15:59:00.000Z',
  }
  const report = buildJobProfitabilityReport([septemberJob], {
    now,
    rollupJobs: [septemberJob, augustJob],
  })
  assertEquals(report.rollups.fencing_this_month.job_count, 1)
  assertEquals(report.rollups.fencing_this_month.complete_count, 1)
})
