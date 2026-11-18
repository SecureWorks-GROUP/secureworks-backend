type Cell = {
  Value?: string | number
  Attributes?: { Id: string; Value: string }[]
}

type ReportRow = {
  RowType: string
  Title?: string
  Cells?: Cell[]
  Rows?: ReportRow[]
}

type Section = 'income' | 'cost_of_sales' | 'expenses'
type AccountRow = {
  org_id: string
  month: string
  tracking_option: string
  section: Section
  account_id: string
  account_name: string
  amount: number
  report_synced_at: string
}

function accountSection(title: string): Section | undefined {
  const name = title.toLowerCase()
  if (name.includes('cost of sales')) return 'cost_of_sales'
  if (name.includes('income') || name.includes('revenue')) return 'income'
  if (name.includes('expense')) return 'expenses'
}

export function plByDivisionRows(report: { Rows?: ReportRow[] }, orgId: string, monthFirstDay: string, nowIso: string): AccountRow[] {
  const header = report?.Rows?.find(row => row.RowType === 'Header')?.Cells
  if (!header || header.length < 2) throw new Error('division_report_header_missing')
  const columns = header.slice(1).map((cell, i) => ({
    name: String(cell.Value ?? '').trim() || 'Unassigned',
    index: i + 1,
  })).filter(column => column.name.toLowerCase() !== 'total')
  if (!columns.length) throw new Error('division_report_columns_missing')

  const rows: AccountRow[] = []
  let hasSection = false
  for (const group of report.Rows!) {
    if (group.RowType !== 'Section' || !group.Title) continue
    const section = accountSection(group.Title)
    if (!section) continue
    if (!Array.isArray(group.Rows)) throw new Error('division_report_rows_missing')
    hasSection = true
    for (const line of group.Rows) {
      if (line.RowType !== 'Row') continue
      const cells = line.Cells
      if (!cells?.length) throw new Error('division_report_cells_missing')
      const accountId = cells[0].Attributes?.find(attr => attr.Id === 'account')?.Value
      if (!accountId) continue
      for (const { name, index } of columns) {
        if (!cells[index]) throw new Error('division_report_cells_missing')
        const amount = Number(cells[index].Value)
        if (!Number.isFinite(amount) || amount === 0) continue
        rows.push({
          org_id: orgId, month: monthFirstDay, tracking_option: name, section,
          account_id: accountId, account_name: String(cells[0].Value ?? ''),
          amount, report_synced_at: nowIso,
        })
      }
    }
  }
  // An unrecognisable report cannot establish that a previously stored month is empty.
  if (!hasSection) throw new Error('division_report_sections_missing')
  return rows
}

export function divisionSyncOfficeHours(now: Date): boolean {
  const perth = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const weekday = perth.getUTCDay()
  const hour = perth.getUTCHours()
  return weekday >= 1 && weekday <= 5 && hour >= 7 && hour < 17
}

export async function storeDivisionMonth(sb: any, report: { Rows?: ReportRow[] }, orgId: string, month: string, nowIso: string) {
  const rows = plByDivisionRows(report, orgId, month, nowIso)
  const table = 'xero_division_month_accounts'
  if (rows.length) {
    const { error } = await sb.from(table).upsert(rows, { onConflict: 'org_id,month,tracking_option,account_id' })
    if (error) throw new Error('division_accounts_upsert_failed')
  }
  const { error } = await sb.from(table).delete()
    .eq('org_id', orgId).eq('month', month).lt('report_synced_at', nowIso)
  if (error) throw new Error('division_accounts_trim_failed')
  return rows.length
}
