// Executable job_profitability boundary test. A controlled data client,
// not a source grep. If loadJobProfitability is unwired, this fails.

import {
  assertEquals,
  assertRejects,
} from 'https://deno.land/std@0.224.0/assert/mod.ts'

import {
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
        rows = rows.filter((row) => row[filter.col] === filter.val)
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

function mockClient(
  state: Record<string, Row[]>,
  errorFor: Record<string, { message: string }> = {},
) {
  const selects: { table: string; select: string; type?: unknown; from?: unknown }[] =
    []
  return {
    selects,
    from(table: string) {
      const chain = new MockChain(table, state, errorFor)
      const originalSelect = chain.select.bind(chain)
      chain.select = (cols: string) => {
        selects.push({ table, select: cols })
        return originalSelect(cols)
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

Deno.test('list select projects pricing paths and never the full blob', () => {
  assertEquals(
    JOB_PROFIT_LIST_SELECT.includes('pricing_json->totalExGST'),
    true,
  )
  assertEquals(
    /\bpricing_json\b(?!->)/.test(JOB_PROFIT_LIST_SELECT),
    false,
  )
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
