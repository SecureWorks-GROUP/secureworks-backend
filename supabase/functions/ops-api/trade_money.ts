import { validatePersistedTradeInvoiceMoney, reimbursementLinesTotalEx, TRADE_INVOICE_SUPER_EFFECTIVE_FROM } from './trade_invoice_money.ts'
import { buildPayView } from './trade_pay_view.ts'

// "My money" for the trade app (2026-09-08, Marnin): what a trade has invoiced,
// what is paid, what is still owed, and how much of it was super and GST, by
// month and for the financial year. Pure aggregation over presented
// trade_invoices rows so it is testable without a client.
//
// Money per invoice comes from the persisted super/GST split (gross_earned,
// super_amount, gst, trade_payable). A legacy row whose split does not
// reconcile is still LISTED and still counts its cash figures (total_inc /
// amount_paid) but is flagged figures_ok:false, so one bad row never blanks
// the whole view (the old list endpoint 500'd on it).

export interface TradeMoneyRow {
  id: string
  invoice_number: string | null
  week_start: string | null
  week_end: string | null
  status: string
  xero_bill_status: string | null
  invoice_source: string | null
  created_at: string | null
  submitted_at: string | null
  paid_at: string | null
  amount_paid: number
  gross_earned: number | null
  super_amount: number | null
  gst: number | null
  gst_on: boolean | null
  trade_payable: number | null
  // The recurring deduction this invoice carries (for example Ute hire), taken
  // off trade_payable already. Absent on an invoice that carries none.
  recurring_deduction?: { label: string; amount: number }
  // Group WO V10: the changes the office made to the bill in Xero, named, once
  // xero-sync has read it, and the bill's total in Xero. `payable` is already
  // after them. Absent while the bill is not read (unknown).
  xero_adjustments?: { total: number; lines: { description: string; amount: number; account_code: string | null; kind: string }[] }
  xero_pays?: number
  total_inc: number | null
  figures_ok: boolean
  figures_note: string | null
  // Derived
  bucket: string // YYYY-MM the invoice belongs to (week_end, else created_at)
  counts: boolean // false for voided / deleted / released rows
  payable: number // cash the trade is due for this invoice
  outstanding: number
  paid: boolean
}

export interface TradeMoneyTotals {
  invoices: number
  gross_earned: number
  super_amount: number
  gst: number
  payable: number
  paid_total: number
  outstanding: number
  figures_incomplete: number
}

export interface TradeMoneyMonth extends TradeMoneyTotals {
  month: string // YYYY-MM
  label: string // "Sep 2026"
}

export interface TradeMoneySummary {
  today: string
  fy_start: string
  fy_label: string
  month: TradeMoneyMonth
  fytd: TradeMoneyTotals
  all_time: TradeMoneyTotals
  months: TradeMoneyMonth[]
  invoices: TradeMoneyRow[]
}

const VOID_BILL = new Set(['VOIDED', 'DELETED'])
const RELEASED = new Set(['draft', 'failed', 'ops-reject'])
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function r2(n: number): number { return Math.round(n * 100) / 100 }
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function monthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(ym)
  if (!m) return ym
  return MONTHS[Number(m[2]) - 1] + ' ' + m[1]
}

// Australian financial year starts 1 July.
export function fyStartFor(today: string): string {
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7))
  return (m >= 7 ? y : y - 1) + '-07-01'
}
export function fyLabelFor(today: string): string {
  const start = Number(fyStartFor(today).slice(0, 4))
  return 'FY ' + start + '/' + String(start + 1).slice(2)
}

function emptyTotals(): TradeMoneyTotals {
  return { invoices: 0, gross_earned: 0, super_amount: 0, gst: 0, payable: 0, paid_total: 0, outstanding: 0, figures_incomplete: 0 }
}
function add(t: TradeMoneyTotals, row: TradeMoneyRow) {
  t.invoices += 1
  t.gross_earned = r2(t.gross_earned + (row.gross_earned || 0))
  t.super_amount = r2(t.super_amount + (row.super_amount || 0))
  t.gst = r2(t.gst + (row.gst || 0))
  t.payable = r2(t.payable + row.payable)
  t.paid_total = r2(t.paid_total + row.amount_paid)
  t.outstanding = r2(t.outstanding + row.outstanding)
  if (!row.figures_ok) t.figures_incomplete += 1
}

// One presented DB row -> a money row. `presented` is the output of
// presentTradeInvoice (trade_payable resolved) or, when that threw, the raw row
// with `figures_error` set by the caller.
export function tradeMoneyRow(presented: any): TradeMoneyRow {
  const status = String(presented?.status || '')
  const bill = presented?.xero_bill_status ? String(presented.xero_bill_status).toUpperCase() : null
  const figuresError = presented?.figures_error ? String(presented.figures_error) : null
  const tradePayable = figuresError ? null : num(presented?.trade_payable)
  const totalInc = num(presented?.total_inc)
  const amountPaid = num(presented?.amount_paid) || 0
  const figuresOk = !figuresError && tradePayable !== null
  // Cash due to the trade: the persisted split's trade_payable when it exists,
  // after the office's changes in Xero once the bill is read (V10), else the
  // legacy header total. Weekly work-order invoices carry to_be_paid_ex.
  const legacyPayable = num(presented?.to_be_paid) ?? num(presented?.to_be_paid_ex) ?? totalInc ?? 0
  const xeroAdjustments = figuresOk && presented?.xero_adjustments && num(presented?.payable_after_xero) !== null
    ? presented.xero_adjustments
    : null
  const payable = r2(tradePayable !== null ? (xeroAdjustments ? num(presented.payable_after_xero)! : tradePayable) : legacyPayable)
  const counts = !RELEASED.has(status) && !(bill && VOID_BILL.has(bill))
  const paid = status === 'paid' || bill === 'PAID'
  const outstanding = counts ? r2(Math.max(0, payable - amountPaid)) : 0
  const anchor = String(presented?.week_end || presented?.created_at || '').slice(0, 7)
  return {
    id: String(presented?.id || ''),
    invoice_number: presented?.invoice_number || null,
    week_start: presented?.week_start || null,
    week_end: presented?.week_end || null,
    status,
    xero_bill_status: bill,
    invoice_source: presented?.invoice_source || null,
    created_at: presented?.created_at || null,
    submitted_at: presented?.submitted_at || null,
    paid_at: presented?.paid_at || null,
    amount_paid: r2(amountPaid),
    gross_earned: figuresOk ? num(presented?.gross_earned) : null,
    super_amount: figuresOk ? num(presented?.super_amount) : null,
    gst: figuresOk ? num(presented?.gst) : null,
    gst_on: typeof presented?.gst_on === 'boolean' ? presented.gst_on : null,
    trade_payable: tradePayable,
    ...(figuresOk && presented?.recurring_deduction
      ? {
        recurring_deduction: {
          label: String(presented.recurring_deduction.label || ''),
          amount: num(presented.recurring_deduction.amount) ?? 0,
        },
      }
      : {}),
    ...(xeroAdjustments
      ? {
        xero_adjustments: {
          total: num(xeroAdjustments.total) ?? 0,
          lines: (Array.isArray(xeroAdjustments.lines) ? xeroAdjustments.lines : []).map((line: any) => ({
            description: String(line?.description || ''),
            amount: num(line?.amount) ?? 0,
            account_code: line?.account_code ? String(line.account_code) : null,
            kind: String(line?.kind || 'office_line'),
          })),
        },
        ...(num(presented?.xero_pays) !== null ? { xero_pays: num(presented.xero_pays)! } : {}),
      }
      : {}),
    total_inc: totalInc,
    figures_ok: figuresOk,
    figures_note: figuresError ? 'Figures unavailable for this invoice. The office has the Xero bill.' : null,
    bucket: /^\d{4}-\d{2}$/.test(anchor) ? anchor : '',
    counts,
    payable,
    outstanding: paid ? 0 : outstanding,
    paid,
  }
}

export function summariseTradeMoney(rows: TradeMoneyRow[], today: string, monthsBack = 12): TradeMoneySummary {
  const fyStart = fyStartFor(today)
  const thisMonth = today.slice(0, 7)
  const month: TradeMoneyMonth = { ...emptyTotals(), month: thisMonth, label: monthLabel(thisMonth) }
  const fytd = emptyTotals()
  const allTime = emptyTotals()
  const byMonth = new Map<string, TradeMoneyMonth>()
  for (const row of rows) {
    if (!row.counts) continue
    add(allTime, row)
    if (row.bucket === thisMonth) add(month, row)
    if (row.bucket && row.bucket + '-01' >= fyStart) add(fytd, row)
    if (row.bucket) {
      let m = byMonth.get(row.bucket)
      if (!m) { m = { ...emptyTotals(), month: row.bucket, label: monthLabel(row.bucket) }; byMonth.set(row.bucket, m) }
      add(m, row)
    }
  }
  const months = [...byMonth.values()]
    .sort((a, b) => b.month.localeCompare(a.month))
    .filter((m) => monthsBack <= 0 || monthsAgo(m.month, thisMonth) < monthsBack)
  return {
    today,
    fy_start: fyStart,
    fy_label: fyLabelFor(today),
    month,
    fytd,
    all_time: allTime,
    months,
    invoices: rows,
  }
}

function monthsAgo(ym: string, now: string): number {
  const a = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7))
  const b = Number(now.slice(0, 4)) * 12 + Number(now.slice(5, 7))
  return b - a
}

export type PayHistoryRate = { effective_from: string; hourly_rate: number }
type HistoryOptions = {
  years: number
  priorSuper: number
  priorSuperNotRecorded?: number
  priorNotInXero?: number
  taxPercent: number | null
  rates: PayHistoryRate[]
  paidRuns: ReadonlySet<string>
}

const emptyHistory = () => ({
  total_inc_super: 0, paid_to_super: 0, paid_to_you: 0,
  reimbursements: 0, paid_into_bank: 0, invoices: 0,
})
type HistoryTotals = ReturnType<typeof emptyHistory>
type HistoryInvoice = Record<string, any>

export function payHistoryStart(today: string, years: number) {
  return (Number(fyStartFor(today).slice(0, 4)) - years + 1) + '-07-01'
}

function addHistory(t: HistoryTotals, invoice: HistoryTotals) {
  for (const k of Object.keys(t) as (keyof HistoryTotals)[]) t[k] = r2(t[k] + invoice[k])
}

function addPeriod(periods: Map<string, HistoryTotals>, key: string, invoice: HistoryTotals) {
  const totals = periods.get(key) ?? emptyHistory()
  addHistory(totals, invoice)
  periods.set(key, totals)
}

export function countedHistoryInvoice(row: HistoryInvoice) {
  return !RELEASED.has(row.status) && !VOID_BILL.has(String(row.xero_bill_status ?? '').toUpperCase())
}

// An invoice with no Xero bill has not been paid and its super has not been
// remitted, so it is listed but kept out of every paid and super total. The
// column must be read: an absent field refuses rather than counting as billed.
export function historyInvoiceInXero(row: HistoryInvoice) {
  if (!('xero_bill_id' in row)) throw new Error('pay_history_unreadable')
  return Boolean(row.xero_bill_id)
}

export function historyAmount(value: unknown) {
  const amount = num(value)
  if (amount === null) throw new Error('pay_history_unreadable')
  return amount
}

// Older invoices can predate the recorded split. A null basis alone is also
// used on invoices that do carry a recorded amount.
export function recordedHistorySuper(row: HistoryInvoice): number | null {
  if (row.super_amount === null && row.super_basis === null) return null
  return historyAmount(row.super_amount)
}

function mondayOf(day: string) {
  const date = new Date(day + 'T00:00:00Z')
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7)
  return date.toISOString().slice(0, 10)
}

export function summariseTradePayHistory(rows: HistoryInvoice[], today: string, opts: HistoryOptions) {
  const start = payHistoryStart(today, opts.years)
  const thisFy = fyStartFor(today)
  const lastFy = payHistoryStart(today, 2)
  const priorYear = Number(today.slice(0, 4)) - 1
  const anniversary = priorYear + today.slice(4)
  const lastCutoff = today.endsWith('-02-29') ? priorYear + '-02-28' : anniversary
  const weeks = new Map<string, HistoryTotals>()
  const months = new Map<string, HistoryTotals>()
  const years = new Map<string, HistoryTotals>()
  const thisYear = emptyHistory()
  const lastYear = emptyHistory()
  const byInvoice: { invoice_id: string; invoice_number: string | null; week_start: string; amount: number; status: string }[] = []
  let sinceStart = opts.priorSuper
  let superNotRecorded = opts.priorSuperNotRecorded ?? 0
  let notInXero = opts.priorNotInXero ?? 0
  let tax = 0

  for (const row of rows) {
    if (!countedHistoryInvoice(row)) continue
    // Match My money's week-ending date, falling back to the creation date on older bills.
    const day = row.week_end || row.created_at?.slice(0, 10)
    if (!day) throw new Error('pay_history_unreadable')
    if (day > today) continue
    if (!historyInvoiceInXero(row)) {
      notInXero++
      if (day >= start) {
        byInvoice.push({ invoice_id: row.id, invoice_number: row.invoice_number,
          week_start: row.week_start || mondayOf(day), amount: 0, status: 'not_in_xero' })
      }
      continue
    }
    const recordedSuper = recordedHistorySuper(row)
    if (recordedSuper === null) superNotRecorded++
    const superAmount = recordedSuper ?? 0
    sinceStart = r2(sinceStart + superAmount)
    const comparable = day >= lastFy && day <= lastCutoff
    if (day < start && !comparable) continue

    // The pricing validator knows statutory rates only from its effective date.
    // For earlier legacy invoices sum their recorded split, without guessing a rate.
    const earlierLegacy = !row.super_basis && day < TRADE_INVOICE_SUPER_EFFECTIVE_FROM
    const money = recordedSuper === null || earlierLegacy ? null : validatePersistedTradeInvoiceMoney(row)
    const view = money && buildPayView(money, {
      reimbursementsEx: r2(money.gross_earned - (money.super_base_ex ?? money.gross_earned)),
      taxSetAsidePercent: opts.taxPercent, repayment: null,
    })
    if (!view && (!Array.isArray(row.reimbursements) ||
        row.reimbursements.some((line: HistoryInvoice) => num(line.line_total_ex) === null))) {
      throw new Error('pay_history_unreadable')
    }
    const paidToYou = view?.paid_to_you ?? historyAmount(recordedSuper === null ? row.total_inc : row.net_pay)
    if (superAmount < 0 || paidToYou < 0) throw new Error('pay_history_unreadable')
    const totals = {
      total_inc_super: view?.total_inc_super ?? r2(paidToYou + superAmount),
      paid_to_super: superAmount, paid_to_you: paidToYou,
      reimbursements: view?.reimbursements ?? reimbursementLinesTotalEx(row.reimbursements),
      // The settled cash on the bill, including a partial payment or an office edit.
      paid_into_bank: historyAmount(row.amount_paid), invoices: 1,
    }
    if (comparable) addHistory(lastYear, totals)
    if (day < start) continue
    if (day >= thisFy) {
      addHistory(thisYear, totals)
      if (opts.taxPercent !== null) tax = r2(tax + (view?.tax_set_aside?.amount ?? r2(paidToYou * opts.taxPercent / 100)))
    }
    const week = row.week_start || mondayOf(day)
    addPeriod(weeks, week, totals)
    addPeriod(months, day.slice(0, 7), totals)
    addPeriod(years, fyLabelFor(day), totals)
    byInvoice.push({ invoice_id: row.id, invoice_number: row.invoice_number, week_start: week,
      amount: superAmount, status: recordedSuper === null ? 'not_recorded' :
        opts.paidRuns.has(row.pay_run_id) ? 'paid_to_fund' : 'to_be_paid' })
  }

  const newest = (map: Map<string, HistoryTotals>) => [...map].sort(([a], [b]) => b.localeCompare(a))
  return {
    weeks: newest(weeks).slice(0, 26).map(([week_start, totals]) => ({ week_start, ...totals })),
    months: newest(months).slice(0, 24).map(([month, totals]) => ({ month, label: monthLabel(month), ...totals })),
    years: newest(years).map(([fy_label, totals]) => ({ fy_label, ...totals })),
    this_year_vs_last: { this_fy: thisYear, last_fy_same_point: lastYear },
    super: { this_fy: thisYear.paid_to_super, since_start: sinceStart, not_recorded_count: superNotRecorded,
      not_in_xero_count: notInXero,
      by_invoice: byInvoice.sort((a, b) => b.week_start.localeCompare(a.week_start) || b.invoice_id.localeCompare(a.invoice_id)) },
    tax_set_aside: opts.taxPercent === null ? null : { percent: opts.taxPercent, this_fy_amount: tax },
    rate_history: opts.rates,
  }
}
