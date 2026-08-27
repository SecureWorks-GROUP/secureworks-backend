// Executable job_profitability boundary test. A controlled data client,
// not a source grep. If loadJobProfitability is unwired, this fails.

import {
  assertEquals,
  assertRejects,
} from 'https://deno.land/std@0.224.0/assert/mod.ts'

import {
  fetchProfitSourceRows,
  JOB_PROFIT_LIST_SELECT,
  JobProfitabilityReadError,
  loadJobProfitability,
} from './job_profitability.ts'

type Row = Record<string, unknown>
type Filter = { op: string; col: string; val: unknown }

class MockChain {
  table: string
  state: Record<string, Row[]>
  selectCols = '*'
  filters: Filter[] = []
  limitN: number | null = null
  rangeFrom: number | null = null
  rangeTo: number | null = null
  errorFor: Record<string, { message: string }>

  constructor(
    table: string,
    state: Record<string, Row[]>,
    errorFor: Record<string, { message: string }>,
  ) {
    this.table = table
    this.state = state
    this.errorFor = errorFor
  }

  select(cols: string) {
    this.selectCols = cols
    return this
  }
  eq(col: string, val: unknown) {
    this.filters.push({ op: 'eq', col, val })
    return this
  }
  gte(col: string, val: unknown) {
    this.filters.push({ op: 'gte', col, val })
    return this
  }
  lt(col: string, val: unknown) {
    this.filters.push({ op: 'lt', col, val })
    return this
  }
  in(col: string, val: unknown) {
    this.filters.push({ op: 'in', col, val })
    return this
  }
  not(col: string, op: string, val: unknown) {
    this.filters.push({ op: `not.${op}`, col, val })
    return this
  }
  order(_col: string, _opts?: unknown) {
    return this
  }
  limit(n: number) {
    this.limitN = n
    return this
  }
  range(from: number, to: number) {
    this.rangeFrom = from
    this.rangeTo = to
    return this
  }

  private execute(): { data: Row[] | null; error: { message: string } | null } {
    if (this.errorFor[this.table]) {
      return { data: null, error: this.errorFor[this.table] }
    }
    let rows = [...(this.state[this.table] || [])]
    for (const filter of this.filters) {
      if (filter.op === 'eq') {
        rows = rows.filter((row) => {
          if (String(filter.col).includes('.')) {
            const [a, b] = String(filter.col).split('.')
            const nested = row[a] as Record<string, unknown> | undefined
            return nested?.[b] === filter.val
          }
          return row[filter.col] === filter.val
        })
      } else if (filter.op === 'gte') {
        rows = rows.filter((row) =>
          String(row[filter.col] ?? '') >= String(filter.val)
        )
      } else if (filter.op === 'lt') {
        rows = rows.filter((row) =>
          String(row[filter.col] ?? '') < String(filter.val)
        )
      } else if (filter.op === 'in') {
        const set = new Set(filter.val as unknown[])
        rows = rows.filter((row) => set.has(row[filter.col]))
      } else if (filter.op === 'not.is') {
        rows = rows.filter((row) => row[filter.col] != null)
      }
    }
    if (this.rangeFrom != null && this.rangeTo != null) {
      rows = rows.slice(this.rangeFrom, this.rangeTo + 1)
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN)
    return { data: rows, error: null }
  }

  then<T>(
    resolve: (v: { data: Row[] | null; error: { message: string } | null }) => T,
    reject?: (e: unknown) => T,
  ) {
    try {
      return Promise.resolve(this.execute()).then(resolve, reject)
    } catch (err) {
      return Promise.reject(err).then(resolve, reject)
    }
  }
}

const ORG_ID = '00000000-0000-0000-0000-000000000001'

function withOrg(state: Record<string, Row[]>): Record<string, Row[]> {
  const stamp = (rows: Row[] | undefined) =>
    (rows || []).map((row) => ({ org_id: ORG_ID, ...row }))
  return {
    ...state,
    xero_invoices: stamp(state.xero_invoices),
    xero_projects: stamp(state.xero_projects),
    job_materials_facts: stamp(state.job_materials_facts),
    trade_invoice_lines: (state.trade_invoice_lines || []).map((row) => ({
      ...row,
      trade_invoices: {
        org_id: ORG_ID,
        ...((row.trade_invoices as Record<string, unknown> | undefined) || {}),
      },
    })),
  }
}

function mockClient(
  state: Record<string, Row[]>,
  errorFor: Record<string, { message: string }> = {},
) {
  state = withOrg(state)
  const selects: { table: string; select: string; type?: unknown; from?: unknown }[] =
    []
  const ranges: { table: string; from: number; to: number }[] = []
  const orders: { table: string; col: string }[] = []
  const inFilters: { table: string; column: string; values: unknown[] }[] = []
  return {
    selects,
    ranges,
    orders,
    inFilters,
    from(table: string) {
      const chain = new MockChain(table, state, errorFor)
      const originalSelect = chain.select.bind(chain)
      chain.select = (cols: string) => {
        selects.push({ table, select: cols })
        return originalSelect(cols)
      }
      const originalRange = chain.range.bind(chain)
      chain.range = (from: number, to: number) => {
        ranges.push({ table, from, to })
        return originalRange(from, to)
      }
      const originalOrder = chain.order.bind(chain)
      chain.order = (col: string, opts?: unknown) => {
        orders.push({ table, col })
        return originalOrder(col, opts)
      }
      const originalIn = chain.in.bind(chain)
      chain.in = (column: string, values: unknown) => {
        inFilters.push({ table, column, values: values as unknown[] })
        return originalIn(column, values)
      }
      const originalEq = chain.eq.bind(chain)
      chain.eq = (col: string, val: unknown) => {
        if (col === 'type') selects[selects.length - 1] &&
          (selects[selects.length - 1].type = val)
        return originalEq(col, val)
      }
      const originalGte = chain.gte.bind(chain)
      chain.gte = (col: string, val: unknown) => {
        if (col === 'created_at' && selects.length) {
          selects[selects.length - 1].from = val
        }
        return originalGte(col, val)
      }
      return chain
    },
  }
}

const FULL_JOB = {
  id: 'job-full',
  org_id: '00000000-0000-0000-0000-000000000001',
  legacy: false,
  type: 'fencing',
  status: 'invoiced',
  client_name: 'Boundary Pty',
  site_suburb: 'Floreat',
  job_number: 'SWF-FULL',
  created_at: '2026-08-15T00:00:00.000Z',
  quote_ex: 10000.57,
  quote_inc: 11000,
  expected_costs: null,
}

Deno.test('loadJobProfitability uses projected quote totals, not a planted pricing blob', async () => {
  const sb = mockClient({
    jobs: [{
      ...FULL_JOB,
      quote_ex: 10000.57,
      pricing_json: { totalExGST: 1, totalIncGST: 1 },
    }],
    xero_invoices: [{
      job_id: 'job-full',
      invoice_type: 'ACCREC',
      sub_total: 10000.57,
      total: 11000.63,
      amount_paid: 0,
    }],
    xero_projects: [],
    trade_invoice_lines: [],
    job_materials_facts: [],
  })
  const report = await loadJobProfitability(
    sb,
    new URLSearchParams(),
    new Date('2026-08-27T00:00:00.000Z'),
  )
  assertEquals(
    sb.selects.every((s) => s.table !== 'jobs' || s.select === JOB_PROFIT_LIST_SELECT),
    true,
  )
  assertEquals(report.jobs[0].quote_value, 10000.57)
})

Deno.test('loadJobProfitability: empty-cost job is unknown, not 100%', async () => {
  const sb = mockClient({
    jobs: [{
      ...FULL_JOB,
      id: 'job-empty',
      job_number: 'SWF-EMPTY',
      created_at: '2026-08-10T00:00:00.000Z',
      quote_ex: 12000,
    }],
    xero_invoices: [{
      job_id: 'job-empty',
      invoice_type: 'ACCREC',
      sub_total: 12000,
      total: 13200,
      amount_paid: 0,
    }],
    xero_projects: [],
    trade_invoice_lines: [],
    job_materials_facts: [],
  })
  const report = await loadJobProfitability(
    sb,
    new URLSearchParams('limit=50'),
    new Date('2026-08-27T00:00:00.000Z'),
  )
  assertEquals(report.jobs.length, 1)
  assertEquals(report.jobs[0].profit_status, 'unknown')
  assertEquals(report.jobs[0].margin, null)
  assertEquals(report.jobs[0].margin_pct, null)
  assertEquals(report.jobs[0].margin_pct === 100, false)
})

Deno.test('loadJobProfitability: accepted trade costs complete a job to the cent', async () => {
  const sb = mockClient({
    jobs: [FULL_JOB],
    xero_invoices: [{
      job_id: 'job-full',
      invoice_type: 'ACCREC',
      sub_total: 10000.57,
      total: 11000.63,
      amount_paid: 0,
    }],
    xero_projects: [],
    trade_invoice_lines: [
      {
        id: 'l-labour',
        job_id: 'job-full',
        job_number: 'SWF-FULL',
        line_type: 'labour',
        line_total_ex: 100,
        override_amount: 3000.11,
        trade_invoices: { status: 'approved' },
      },
      {
        id: 'l-comm',
        job_id: 'job-full',
        job_number: 'SWF-FULL',
        line_type: 'commission',
        line_total_ex: 800.04,
        override_amount: null,
        trade_invoices: { status: 'pushed_to_xero' },
      },
      {
        id: 'l-other',
        job_id: 'job-full',
        job_number: 'SWF-FULL',
        line_type: 'travel',
        line_total_ex: 200.03,
        override_amount: null,
        trade_invoices: { status: 'paid' },
      },
    ],
    job_materials_facts: [{
      job_id: 'job-full',
      amount_ex_gst: 3000.06,
      lane: 'materials',
    }],
  })
  const report = await loadJobProfitability(
    sb,
    new URLSearchParams(),
    new Date('2026-08-27T00:00:00.000Z'),
  )
  assertEquals(report.jobs[0].profit_status, 'complete')
  assertEquals(report.jobs[0].margin, 3000.33)
  assertEquals(report.jobs[0].margin_pct, 30)
  if (report.jobs[0].lanes.labour.resolved) {
    assertEquals(report.jobs[0].lanes.labour.amount_ex_gst, 3000.11)
  }
})

Deno.test('loadJobProfitability: a draft trade invoice does not resolve labour', async () => {
  const sb = mockClient({
    jobs: [FULL_JOB],
    xero_invoices: [{
      job_id: 'job-full',
      invoice_type: 'ACCREC',
      sub_total: 10000.57,
      total: 11000.63,
      amount_paid: 0,
    }],
    xero_projects: [],
    trade_invoice_lines: [
      {
        id: 'l-labour',
        job_id: 'job-full',
        line_type: 'labour',
        line_total_ex: 3000.11,
        trade_invoices: { status: 'draft' },
      },
      {
        id: 'l-comm',
        job_id: 'job-full',
        line_type: 'commission',
        line_total_ex: 800.04,
        trade_invoices: { status: 'paid' },
      },
      {
        id: 'l-other',
        job_id: 'job-full',
        line_type: 'travel',
        line_total_ex: 200.03,
        trade_invoices: { status: 'paid' },
      },
    ],
    job_materials_facts: [{
      job_id: 'job-full',
      amount_ex_gst: 3000.06,
      lane: 'materials',
    }],
  })
  const report = await loadJobProfitability(
    sb,
    new URLSearchParams(),
    new Date('2026-08-27T00:00:00.000Z'),
  )
  assertEquals(report.jobs[0].profit_status, 'partial')
  assertEquals(report.jobs[0].missing_lanes.includes('labour'), true)
  assertEquals(report.jobs[0].margin, null)
})

Deno.test('loadJobProfitability throws when xero_invoices is unreadable', async () => {
  const sb = mockClient(
    {
      jobs: [FULL_JOB],
      xero_invoices: [],
      xero_projects: [],
      trade_invoice_lines: [],
      job_materials_facts: [],
    },
    { xero_invoices: { message: 'boom' } },
  )
  await assertRejects(
    () =>
      loadJobProfitability(
        sb,
        new URLSearchParams(),
        new Date('2026-08-27T00:00:00.000Z'),
      ),
    JobProfitabilityReadError,
    'xero_invoices',
  )
})

Deno.test('loadJobProfitability accumulates invoice revenue in integer cents', async () => {
  const sb = mockClient({
    jobs: [{ ...FULL_JOB, quote_ex: 0.3 }],
    xero_invoices: [
      {
        job_id: 'job-full',
        invoice_type: 'ACCREC',
        sub_total: 0.1,
        total: 0.11,
        amount_paid: 0,
      },
      {
        job_id: 'job-full',
        invoice_type: 'ACCREC',
        sub_total: 0.2,
        total: 0.22,
        amount_paid: 0,
      },
    ],
    xero_projects: [],
    trade_invoice_lines: [],
    job_materials_facts: [],
  })
  const report = await loadJobProfitability(
    sb,
    new URLSearchParams(),
    new Date('2026-08-27T00:00:00.000Z'),
  )
  assertEquals(report.jobs[0].invoiced, 0.3)
  assertEquals(String(report.jobs[0].invoiced), '0.3')
})

Deno.test('loadJobProfitability orders and tenant-scopes every paged source read', async () => {
  const sb = mockClient({
    jobs: [FULL_JOB],
    xero_invoices: [{
      job_id: 'job-full',
      invoice_type: 'ACCREC',
      sub_total: 10000.57,
      total: 11000.63,
      amount_paid: 0,
    }],
    xero_projects: [],
    trade_invoice_lines: [],
    job_materials_facts: [],
  })
  await loadJobProfitability(
    sb,
    new URLSearchParams(),
    new Date('2026-08-27T00:00:00.000Z'),
  )
  const sourced = ['xero_invoices', 'xero_projects', 'trade_invoice_lines', 'job_materials_facts']
  for (const table of sourced) {
    assertEquals(sb.orders.some((o) => o.table === table && o.col === 'id'), true)
  }
})

Deno.test('loadJobProfitability pages source reads past the 1000-row cap', async () => {
  const lines = Array.from({ length: 1001 }, (_, i) => ({
    id: `l-${i}`,
    job_id: 'job-full',
    job_number: 'SWF-FULL',
    line_type: 'labour',
    line_total_ex: 1,
    trade_invoices: { status: 'paid' },
  }))
  const sb = mockClient({
    jobs: [FULL_JOB],
    xero_invoices: [{
      job_id: 'job-full',
      invoice_type: 'ACCREC',
      sub_total: 10000.57,
      total: 11000.63,
      amount_paid: 0,
    }],
    xero_projects: [],
    trade_invoice_lines: lines,
    job_materials_facts: [],
  })
  await loadJobProfitability(
    sb,
    new URLSearchParams(),
    new Date('2026-08-27T00:00:00.000Z'),
  )
  const lineRanges = sb.ranges.filter((r) => r.table === 'trade_invoice_lines')
  assertEquals(lineRanges.some((r) => r.from === 0), true)
  assertEquals(lineRanges.some((r) => r.from === 1000), true)
})

Deno.test('loadJobProfitability finds Xero project revenue beyond the first page', async () => {
  const xeroProjects = Array.from({ length: 1001 }, (_, i) => ({
    job_id: 'job-full',
    project_name: `Project ${i}`,
    job_number: 'SWF-FULL',
    total_invoiced: i === 1000 ? 123.45 : 0,
    total_expenses: 0,
    total_to_be_invoiced: 0,
    status: 'INPROGRESS',
  }))
  const sb = mockClient({
    jobs: [FULL_JOB],
    xero_invoices: [{
      job_id: 'job-full',
      invoice_type: 'ACCREC',
      sub_total: 999,
      total: 1098.9,
      amount_paid: 0,
    }],
    xero_projects: xeroProjects,
    trade_invoice_lines: [],
    job_materials_facts: [],
  })
  const report = await loadJobProfitability(
    sb,
    new URLSearchParams(),
    new Date('2026-08-27T00:00:00.000Z'),
  )
  assertEquals(report.jobs[0].invoiced, 123.45)
  const projectRanges = sb.ranges.filter((r) => r.table === 'xero_projects')
  assertEquals(projectRanges.some((r) => r.from === 0), true)
  assertEquals(projectRanges.some((r) => r.from === 1000), true)
})

Deno.test('profit source boundary chunks ids at 25', async () => {
  const ids = Array.from({ length: 26 }, (_, i) => `job-${i}`)
  const sb = mockClient({
    job_materials_facts: ids.map((job_id) => ({
      job_id,
      amount_ex_gst: 1,
      lane: 'materials',
    })),
  })
  const result = await fetchProfitSourceRows(
    sb,
    'job_materials_facts',
    'job_id, amount_ex_gst, lane',
    'job_id',
    ids,
  )
  assertEquals(result.rows.length, 26)
  assertEquals(sb.inFilters.map((filter) => filter.values.length), [25, 1])
})

Deno.test('loadJobProfitability throws when xero_projects is unreadable', async () => {
  const sb = mockClient(
    {
      jobs: [FULL_JOB],
      xero_invoices: [],
      xero_projects: [],
      trade_invoice_lines: [],
      job_materials_facts: [],
    },
    { xero_projects: { message: 'boom' } },
  )
  await assertRejects(
    () =>
      loadJobProfitability(
        sb,
        new URLSearchParams(),
        new Date('2026-08-27T00:00:00.000Z'),
      ),
    JobProfitabilityReadError,
    'xero_projects',
  )
})

Deno.test('loadJobProfitability loads fencing-month and quarter cohorts independently', async () => {
  const now = new Date('2026-08-31T16:30:00.000Z') // 00:30 1 Sep Perth
  const sb = mockClient({
    jobs: [{
      ...FULL_JOB,
      created_at: '2026-08-31T16:10:00.000Z',
    }],
    xero_invoices: [{
      job_id: 'job-full',
      invoice_type: 'ACCREC',
      sub_total: 10000.57,
      total: 11000.63,
      amount_paid: 0,
    }],
    xero_projects: [],
    trade_invoice_lines: [
      {
        id: 'l-labour',
        job_id: 'job-full',
        line_type: 'labour',
        line_total_ex: 3000.11,
        trade_invoices: { status: 'paid' },
      },
      {
        id: 'l-comm',
        job_id: 'job-full',
        line_type: 'commission',
        line_total_ex: 800.04,
        trade_invoices: { status: 'paid' },
      },
      {
        id: 'l-other',
        job_id: 'job-full',
        line_type: 'travel',
        line_total_ex: 200.03,
        trade_invoices: { status: 'paid' },
      },
    ],
    job_materials_facts: [{
      job_id: 'job-full',
      amount_ex_gst: 3000.06,
      lane: 'materials',
    }],
  })
  const report = await loadJobProfitability(sb, new URLSearchParams(), now)
  const jobWindowReads = sb.selects.filter((s) =>
    s.table === 'jobs' && s.from != null
  )
  assertEquals(jobWindowReads.length >= 2, true)
  assertEquals(jobWindowReads.some((s) => s.type === 'fencing'), true)
  assertEquals(jobWindowReads.some((s) => s.type == null), true)
  assertEquals(
    jobWindowReads.every((s) => s.select === JOB_PROFIT_LIST_SELECT),
    true,
  )
  assertEquals(report.rollups.fencing_this_month.job_count, 1)
  assertEquals(report.rollups.fencing_this_month.complete_count, 1)
})
