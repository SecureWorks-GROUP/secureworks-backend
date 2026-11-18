// Read only. The route supplies the identity from authTrade, never from the request parameters.
import { countedHistoryInvoice, historyAmount, historyInvoiceInXero, payHistoryStart, recordedHistorySuper, summariseTradePayHistory } from './trade_money.ts'
import { readTradePaySettings, tradePayTaxPercent } from './trade_pay_rule.ts'

export const invoiceColumns = [
  'id', 'invoice_number', 'week_start', 'week_end', 'created_at', 'status', 'xero_bill_id', 'xero_bill_status',
  'amount_paid', 'gross_earned', 'super_rate', 'super_amount', 'super_basis', 'super_base_ex',
  'net_pay', 'subtotal_ex', 'gst_on', 'gst', 'total_inc', 'recurring_deduction_label', 'recurring_deduction_amount',
  'reimbursements:trade_invoice_lines!trade_invoice_id(line_type,line_total_ex)',
].join(',')

type Row = Record<string, any>
type Page = { data: Row[] | null; error: { code?: string; message?: string } | null }

function checkedRows(result: Page): Row[] {
  if (result.error) throw result.error
  if (!Array.isArray(result.data)) throw new Error('pay_history_unreadable')
  return result.data
}

// A total order and paging keep a long history from silently hitting the API row limit.
async function pages(query: () => any) {
  const all: Row[] = []
  const size = 250
  for (let offset = 0; ; offset += size) {
    const page = checkedRows(await query().order('id').range(offset, offset + size - 1))
    all.push(...page)
    if (page.length < size) return all
  }
}

export async function readTradePayHistory(client: any, userId: string, today: string, rawYears: string | null) {
  if (!userId) return { status: 401, body: { code: 'login_required' } }
  if (rawYears !== null && !/^[1-7]$/.test(rawYears)) return { status: 400, body: { code: 'years_invalid' } }
  const years = Number(rawYears ?? 2)
  // The comparison still needs last year's invoices for a one-year display.
  const floor = payHistoryStart(today, Math.max(years, 2))
  const invoices = (columns: string) => client.from('trade_invoices').select(columns)
    .eq('user_id', userId).not('status', 'in', '(draft,ops-reject,failed)')
  const recent = (withRun: boolean) => pages(() => invoices(invoiceColumns + (withRun ? ',pay_run_id' : ''))
    .or('week_end.gte.' + floor + ',week_end.is.null').eq('reimbursements.line_type', 'reimbursement'))
  try {
    // Before P1-10 the invoice has no pay_run_id. Only that specific missing column is expected.
    const historyRead = recent(true).catch((error) => {
      if (error?.code === '42703' && /\btrade_invoices\.pay_run_id\b/.test(error.message)) return recent(false)
      throw error
    })
    const [rows, older, rates, settings] = await Promise.all([
      historyRead,
      pages(() => invoices('super_amount,super_basis,status,xero_bill_id,xero_bill_status').lt('week_end', floor)),
      pages(() => client.from('trade_rates').select('effective_from,hourly_rate').eq('user_id', userId).order('effective_from')),
      readTradePaySettings(client),
    ])
    const [setting] = checkedRows(settings)
    if (!setting || !('tax_set_aside_percent' in setting)) throw new Error('pay_history_unreadable')
    const taxPercent = tradePayTaxPercent(settings)
    if (taxPercent === null && setting.tax_set_aside_percent !== null) throw new Error('pay_history_unreadable')

    const runIds = [...new Set(rows.filter(row => countedHistoryInvoice(row) && historyInvoiceInXero(row)).map(row => row.pay_run_id).filter(Boolean))]
    const paidRuns = new Map<string, string>()
    for (let i = 0; i < runIds.length; i += 50) {
      const ids = runIds.slice(i, i + 50)
      const runs = checkedRows(await client.from('trade_pay_runs').select('id,super_marked_paid_at').in('id', ids))
      if (runs.length !== ids.length) throw new Error('pay_history_unreadable')
      for (const run of runs) {
        if (!('super_marked_paid_at' in run)) throw new Error('pay_history_unreadable')
        if (run.super_marked_paid_at) paidRuns.set(run.id, String(run.super_marked_paid_at))
      }
    }
    let priorSuperCents = 0
    let priorSuperNotRecorded = 0
    let priorNotInXero = 0
    for (const row of older) {
      if (!countedHistoryInvoice(row)) continue
      if (!historyInvoiceInXero(row)) {
        priorNotInXero++
        continue
      }
      const recorded = recordedHistorySuper(row)
      if (recorded === null) priorSuperNotRecorded++
      else priorSuperCents += Math.round(recorded * 100)
    }
    const rateHistory = rates.map(row => ({ effective_from: row.effective_from, hourly_rate: historyAmount(row.hourly_rate) }))
    const body = summariseTradePayHistory(rows, today, { years, taxPercent, rates: rateHistory, paidRuns,
      priorSuper: priorSuperCents / 100, priorSuperNotRecorded, priorNotInXero })
    return { status: 200, body }
  } catch {
    return { status: 503, body: { code: 'pay_history_unreadable', error: 'Could not read your pay history. Try again.' } }
  }
}
