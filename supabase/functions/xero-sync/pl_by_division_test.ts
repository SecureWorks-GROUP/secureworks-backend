import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { syncTrackingPL } from './index.ts'
import { divisionSyncOfficeHours, plByDivisionRows, storeDivisionMonth } from './pl_by_division.ts'

type AccountRow = ReturnType<typeof plByDivisionRows>[number]

const org = '00000000-0000-0000-0000-000000000001'
const now = new Date('2026-11-17T22:30:00Z') // 06:30 Wednesday, Perth
const month = '2026-11-01'
const divisions = ['', 'SW - FENCING', 'SW - PATIOS', 'Unassigned', 'Total']

function account(id: string, values: string[]) {
  return { RowType: 'Row', Cells: [
    { Value: 'Account ' + id, Attributes: [{ Id: 'other', Value: 'unused' }, { Id: 'account', Value: id }] },
    ...values.map(Value => ({ Value })),
  ] }
}
const summary = { RowType: 'SummaryRow', Cells: [{ Value: 'Total Income' }, { Value: '3' }] }
function report(header = divisions) {
  return { Rows: [
    { RowType: 'Header', Cells: header.map(Value => ({ Value })) },
    { RowType: 'Section', Title: 'Income', Rows: [
      account('a', ['3', '0', '-1.25', '1.75']), account('b', ['0', '4', '', '4']),
      { RowType: 'Row', Cells: [{ Value: 'No account attribute' }] }, summary,
    ] },
    { RowType: 'Section', Title: 'LESS COST OF SALES', Rows: [account('c', ['0', '', '2', '2'])] },
    { RowType: 'Section', Title: 'Gross Profit', Rows: [summary] },
  ] }
}

Deno.test('division rows retain column positions, account identity, signs and cents', () => {
  const rows = plByDivisionRows(report(), org, month, now.toISOString())
  assertEquals(rows.map(r => [r.account_id, r.tracking_option, r.section, r.amount]), [
    ['a', 'SW - FENCING', 'income', 3], ['a', 'Unassigned', 'income', -1.25],
    ['b', 'SW - PATIOS', 'income', 4], ['c', 'Unassigned', 'cost_of_sales', 2],
  ])
  assertEquals(rows[0], {
    org_id: org, month, report_synced_at: now.toISOString(), account_id: 'a', account_name: 'Account a',
    section: 'income', tracking_option: 'SW - FENCING', amount: 3,
  })
  const renamed = report(['', '', 'SW - PATIOS', 'Other', 'Total'])
  renamed.Rows[1].Title = 'Operating Revenue'
  renamed.Rows[2].Title = 'Operating Expenses'
  const alt = plByDivisionRows(renamed, org, month, now.toISOString())
  assertEquals(alt[0].tracking_option, 'Unassigned')
  assertEquals(alt[0].section, 'income')
  assertEquals(alt.at(-1)?.section, 'expenses')
})

Deno.test('office hours follow the Perth weekday and the 07:00 and 17:00 boundaries', () => {
  for (const [instant, office] of [
    ['2026-11-17T22:59:59Z', false], ['2026-11-17T23:00:00Z', true],
    ['2026-11-18T08:59:59Z', true], ['2026-11-18T09:00:00Z', false],
    ['2026-11-20T23:00:00Z', false],
  ] as const) assertEquals(divisionSyncOfficeHours(new Date(instant)), office)
})

function syncFixture() {
  const requests: [string, Record<string, string> | undefined][] = []
  const reports: any[] = []
  const accounts = new Map<string, AccountRow>()
  const state = { enabled: true, fault: '', report: report(), now }
  const trims: string[] = []
  const client = {
    from(table: string) {
      switch (table) {
        case 'xero_tokens': return { select: () => ({ eq: () => ({ single: () => ({ data: { expires_at: '2099-01-01' } }) }) }) }
        case 'feature_flags': return { select: () => ({ eq: (key: string, name: string) => {
          assertEquals([key, name], ['flag_name', 'division_tieout_v1'])
          return { maybeSingle: () => ({ data: { enabled: state.enabled }, error: state.fault === 'switch' }) }
        } }) }
        case 'xero_reports': return { upsert: (row: any) => {
          reports.push(row)
          return { error: state.fault === 'totals' }
        } }
        case 'webhook_log': return { insert: () => ({ error: null }) }
        case 'xero_division_month_accounts': return {
          upsert(rows: AccountRow[], options: { onConflict: string }) {
            assertEquals(options.onConflict, 'org_id,month,tracking_option,account_id')
            if (state.fault === 'upsert') return { error: true }
            for (const r of rows) accounts.set([r.org_id, r.month, r.tracking_option, r.account_id].join('/'), r)
            return { error: null }
          },
          delete: () => ({ eq: (orgKey: string, orgId: string) => ({ eq: (monthKey: string, period: string) => ({
            lt: (timeKey: string, stamp: string) => {
              assertEquals([orgKey, orgId, monthKey, timeKey], ['org_id', org, 'month', 'report_synced_at'])
              if (state.fault === 'trim') return { error: true }
              trims.push(period)
              for (const [key, r] of accounts) {
                if (r.org_id === orgId && r.month === period && r.report_synced_at < stamp) accounts.delete(key)
              }
              return { error: null }
            },
          }) }) }),
        }
        default: throw new Error('unexpected_table')
      }
    },
  }
  const run = () => syncTrackingPL(client, async (path, _auth, _tenant, params) => {
    requests.push([path, params])
    if (path === '/TrackingCategories') return { TrackingCategories: [] }
    if (state.fault === 'missing') return { Reports: [] }
    if (state.fault === 'unreadable') return { Reports: [{ Rows: [] }] }
    return { Reports: [state.report] }
  }, () => state.now)
  return { state, requests, reports, accounts, trims, run, client }
}

Deno.test('off, unreadable switch and office hours keep the existing result, totals and Xero requests', async () => {
  for (const mode of ['off', 'switch', 'office']) {
    const f = syncFixture()
    f.state.enabled = mode !== 'off'
    f.state.fault = mode
    if (mode === 'office') f.state.now = new Date('2026-11-18T02:00:00Z')
    const result = await f.run()
    assertEquals(Object.keys(result), ['success', 'months_synced', 'options_synced', 'months_failed', 'results', 'drafts_checked'])
    assertEquals(result.months_synced, 12)
    assertEquals(f.accounts.size, 0)
    assertEquals(f.trims, [])
    assertEquals(f.requests[0], ['/TrackingCategories', { includeArchived: 'true' }])
    assertEquals(f.requests.length, 13)
    assertEquals(f.reports.length, 12)
    for (const [i, row] of f.reports.entries()) {
      const [path, params] = f.requests[i + 1]
      assertEquals(path, '/Reports/ProfitAndLoss')
      assertEquals(params, {
        fromDate: row.period_start, toDate: row.period_end,
        trackingCategoryID: '68b39e33-e803-4163-af8d-2e8955a1ce2a', standardLayout: 'true',
      })
      assertEquals(row.report_json.raw.Reports, [f.state.report])
      assertEquals(row.report_json.data['SW - FENCING'].revenue, 3)
    }
  }
})

Deno.test('a complete reread replaces edited amounts and removes lines now at zero', async () => {
  const f = syncFixture()
  assertEquals((await f.run()).account_rows, 48)
  f.state.report.Rows[1].Rows!.splice(0, 1, account('a', ['5', '0', '0', '5']))
  f.state.now = new Date(now.getTime() + 1000)
  assertEquals((await f.run()).account_rows, 36)
  assertEquals(f.accounts.size, 36)
  const syncedMonth = f.reports[0].period_start
  assertEquals(f.accounts.get([org, syncedMonth, 'SW - FENCING', 'a'].join('/'))?.amount, 5)
  assertEquals(f.accounts.has([org, syncedMonth, 'Unassigned', 'a'].join('/')), false)
  assertEquals((await f.run()).account_rows, 36)
  assertEquals(f.accounts.size, 36)
})

Deno.test('missing reports and storage failures never report zero, never trim from a failed read or upsert, and retry converges', async () => {
  const f = syncFixture()
  await f.run()
  f.state.now = new Date(now.getTime() + 1000)
  for (const fault of ['missing', 'unreadable', 'totals', 'upsert', 'trim']) {
    f.state.fault = fault
    assertEquals((await f.run()).account_rows, null)
    assertEquals(f.accounts.size, 48)
    assertEquals(f.trims.length, 12)
  }
  f.state.fault = ''
  assertEquals((await f.run()).account_rows, 48)
  assertEquals(f.accounts.size, 48)
})

Deno.test('a recognised all-zero report clears the previous month rows', async () => {
  const f = syncFixture()
  await f.run()
  f.state.now = new Date(now.getTime() + 1000)
  f.state.report = { Rows: [
    report().Rows[0],
    { RowType: 'Section', Title: 'Income', Rows: [account('a', ['0', '0', '0', '0'])] },
  ] }
  assertEquals((await f.run()).account_rows, 0)
  assertEquals(f.accounts.size, 0)
})

const totalOnlyHeader = { RowType: 'Header', Cells: [{ Value: '' }, { Value: 'Total' }] }
const later = new Date(now.getTime() + 1000).toISOString()

Deno.test('a total-only reread trims stale accounts only in the zero-activity month', async () => {
  for (const lines of [[], [account('a', ['0.00'])]]) {
    const f = syncFixture()
    const otherMonth = '2026-10-01'
    for (const period of [month, otherMonth]) {
      assertEquals(await storeDivisionMonth(f.client, report(), org, period, now.toISOString()), 4)
    }
    const otherRows = [...f.accounts.values()].filter(row => row.month === otherMonth)
    const empty = { Rows: [totalOnlyHeader, { RowType: 'Section', Title: 'Income', Rows: lines }] }
    assertEquals(await storeDivisionMonth(f.client, empty, org, month, later), 0)
    assertEquals([...f.accounts.values()], otherRows)
    assertEquals(f.trims, [month, otherMonth, month])
  }
})

async function assertMonthPreserved(badReport: Parameters<typeof storeDivisionMonth>[1], code: string) {
  const f = syncFixture()
  await storeDivisionMonth(f.client, report(), org, month, now.toISOString())
  const before = [...f.accounts.values()]
  const error = await assertRejects(() => storeDivisionMonth(f.client, badReport, org, month, later), Error)
  assertEquals(error.message, code)
  assertEquals([...f.accounts.values()], before)
  assertEquals(f.trims, [month])
}

Deno.test('a total-only account with non-zero or unreadable activity refuses the month', async () => {
  for (const value of ['-1', 'invalid']) {
    await assertMonthPreserved({ Rows: [
      totalOnlyHeader, { RowType: 'Section', Title: 'Income', Rows: [account('a', [value])] },
    ] }, 'division_report_columns_missing')
  }
  await assertMonthPreserved({ Rows: [
    totalOnlyHeader, { RowType: 'Section', Title: 'Income', Rows: [account('a', [])] },
  ] }, 'division_report_cells_missing')
})

Deno.test('a non-finite account cell refuses the whole month', async () => {
  for (const values of [['0', 'invalid', '0', '0'], ['0', '0', '0', 'Infinity']]) {
    const badReport = report()
    badReport.Rows[2].Rows = [account('c', values)]
    await assertMonthPreserved(badReport, 'division_report_amount_invalid')
  }
})

Deno.test('an unknown or untitled section containing an account refuses the whole month', async () => {
  for (const title of ['Unknown', '']) {
    const badReport = report()
    badReport.Rows.push({ RowType: 'Section', Title: title, Rows: [account('d', ['0', '1', '0', '1'])] })
    await assertMonthPreserved(badReport, 'division_report_section_unknown')
  }
})
