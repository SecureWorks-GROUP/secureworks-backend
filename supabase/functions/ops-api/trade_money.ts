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
  // else the legacy header total. Weekly work-order invoices carry to_be_paid_ex.
  const legacyPayable = num(presented?.to_be_paid) ?? num(presented?.to_be_paid_ex) ?? totalInc ?? 0
  const payable = r2(tradePayable !== null ? tradePayable : legacyPayable)
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
