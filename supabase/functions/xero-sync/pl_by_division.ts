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

function accountIdFor(row: ReportRow): string | undefined {
  return row.Cells?.[0]?.Attributes?.find(attr => attr.Id === 'account')?.Value
}

export function plByDivisionRows(report: { Rows?: ReportRow[] }, orgId: string, monthFirstDay: string, nowIso: string): AccountRow[] {
  const header = report?.Rows?.find(row => row.RowType === 'Header')?.Cells
  if (!header || header.length < 2) throw new Error('division_report_header_missing')
  const columns = header.slice(1).map((cell, i) => ({
    name: String(cell.Value ?? '').trim() || 'Unassigned',
    index: i + 1,
  })).filter(column => column.name.toLowerCase() !== 'total')

  const rows: AccountRow[] = []
  let hasSection = false
  for (const group of report.Rows!) {
    if (group.RowType !== 'Section') continue
    const section = accountSection(group.Title ?? '')
    if (!section) {
      if (group.Rows?.some(line => line.RowType === 'Row' && accountIdFor(line))) {
        throw new Error('division_report_section_unknown')
      }
      continue
    }
    if (!Array.isArray(group.Rows)) throw new Error('division_report_rows_missing')
    hasSection = true
    for (const line of group.Rows) {
      if (line.RowType !== 'Row') continue
      const cells = line.Cells
      if (!cells?.length) throw new Error('division_report_cells_missing')
      const accountId = accountIdFor(line)
      if (!accountId) continue
      if (cells.length < 2) throw new Error('division_report_cells_missing')
      const amounts = cells.slice(1).map(cell => Number(cell.Value ?? NaN))
      // Xero can omit every tracking column for a month with no activity.
      if (!columns.length && amounts.some(amount => amount !== 0)) {
        throw new Error('division_report_columns_missing')
      }
      if (amounts.some(amount => !Number.isFinite(amount))) throw new Error('division_report_amount_invalid')
      for (const { name, index } of columns) {
        if (!cells[index]) throw new Error('division_report_cells_missing')
        const amount = amounts[index - 1]
        if (amount === 0) continue
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

// One run at a time stores and trims division months. Two runs at once could
// otherwise trim each other's fresh rows: B writes a month, A overwrites it
// with its older stamp, B's trim then removes A's rows and the month is empty.
// The lease is a row in xero_sync_state: a run claims it when free or expired,
// renews it (only while it still holds it) before each month's store, and
// gives it back at the end. A run that cannot claim or renew stores nothing
// more. Times come from the run's own clock.
export const DIVISION_LEASE_KEY = 'division_month_accounts_lease'
/** A claim or renewal holds this long: one month's report read and store fits well inside. */
export const DIVISION_LEASE_MS = 5 * 60 * 1000
const DIVISION_LEASE_FREE = '1970-01-01T00:00:00.000Z'

async function leaseUpdate(q: any): Promise<boolean> {
  const { data, error } = await q.select('key')
  return !error && Array.isArray(data) && data.length === 1
}

/** True when this run now holds the lease; false when another run holds it or anything failed. */
export async function claimDivisionLease(sb: any, runId: string, now: Date): Promise<boolean> {
  try {
    const seed = await sb.from('xero_sync_state').upsert(
      { key: DIVISION_LEASE_KEY, cursor_at: DIVISION_LEASE_FREE, note: null, updated_at: now.toISOString() },
      { onConflict: 'key', ignoreDuplicates: true },
    )
    if (seed?.error) return false
    return await leaseUpdate(sb.from('xero_sync_state').update({
      cursor_at: new Date(now.getTime() + DIVISION_LEASE_MS).toISOString(), note: runId, updated_at: now.toISOString(),
    }).eq('key', DIVISION_LEASE_KEY).lt('cursor_at', now.toISOString()))
  } catch {
    return false
  }
}

/** True when this run still holds the lease, now for another DIVISION_LEASE_MS. */
export async function renewDivisionLease(sb: any, runId: string, now: Date): Promise<boolean> {
  try {
    return await leaseUpdate(sb.from('xero_sync_state').update({
      cursor_at: new Date(now.getTime() + DIVISION_LEASE_MS).toISOString(), updated_at: now.toISOString(),
    }).eq('key', DIVISION_LEASE_KEY).eq('note', runId))
  } catch {
    return false
  }
}

/** Gives the lease back if this run still holds it. Never throws. */
export async function releaseDivisionLease(sb: any, runId: string, now: Date): Promise<void> {
  try {
    await leaseUpdate(sb.from('xero_sync_state').update({
      cursor_at: DIVISION_LEASE_FREE, note: null, updated_at: now.toISOString(),
    }).eq('key', DIVISION_LEASE_KEY).eq('note', runId))
  } catch {
    console.error('[xero-sync] division_accounts_lease_release_failed')
  }
}
