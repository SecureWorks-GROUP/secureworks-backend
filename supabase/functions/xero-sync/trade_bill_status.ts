// Trade bill (ACCPAY) status projection onto trade_invoices. Pure: the sync
// loop looks the row up by xero_bill_id and applies whatever this returns.
//
// History: the old detector gated on Reference text ("TRADE-..." or "... WE
// date") and queried a column trade_invoices never had, so no trade invoice was
// ever marked paid. The bill id we stored at push time is the only key.
import {
  isTradeInvoiceRecurringDeductionXeroLine,
  isTradeInvoiceSuperXeroLine,
} from '../ops-api/trade_invoice_money.ts'

export const RELEASED_TRADE_INVOICE_STATUSES = new Set(['draft', 'failed', 'ops-reject'])

export interface TradeBillCurrent {
  status?: string | null
  xero_bill_status?: string | null
  amount_paid?: number | string | null
  paid_at?: string | null
}

export interface TradeBillPatch {
  xero_bill_status?: string
  amount_paid?: number
  paid_at?: string | null
  status?: 'paid'
}

// Xero dates arrive as "/Date(1690000000000+0000)/" or an ISO string.
export function xeroDateToIsoDate(value: unknown): string | null {
  if (!value) return null
  const s = String(value)
  const m = s.match(/\/Date\((\d+)([+-]\d+)?\)\//)
  if (m) return new Date(parseInt(m[1], 10)).toISOString().slice(0, 10)
  // A plain date / zoneless timestamp is already the day Xero means.
  const plain = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (plain) return plain[1]
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

export function tradeBillStatusPatch(inv: any, current: TradeBillCurrent): TradeBillPatch | null {
  const status = String(inv?.Status || '').trim().toUpperCase()
  if (!status) return null
  const amountPaid = Math.round(Number(inv?.AmountPaid || 0) * 100) / 100
  const paidAt = status === 'PAID' ? (xeroDateToIsoDate(inv?.FullyPaidOnDate) || xeroDateToIsoDate(inv?.UpdatedDateUTC)) : null
  const patch: TradeBillPatch = {}
  if (String(current?.xero_bill_status || '') !== status) patch.xero_bill_status = status
  if (Math.round(Number(current?.amount_paid || 0) * 100) / 100 !== amountPaid) patch.amount_paid = amountPaid
  if ((current?.paid_at || null) !== paidAt) patch.paid_at = paidAt
  const ours = String(current?.status || '')
  if (status === 'PAID' && ours !== 'paid' && !RELEASED_TRADE_INVOICE_STATUSES.has(ours)) patch.status = 'paid'
  return Object.keys(patch).length ? patch : null
}

// ── PDF backfill decision (2026-09-08, Marnin: "make sure the invoices the
// guys send us on Xero come with their bills in PDF form") ──
// Every push since the 27 Aug super split failed its returned-split check and
// never reached the attach step, so 16 recent bills sat in Xero with no PDF.
// xero-sync now attaches the audit PDF to any trade bill Xero reports without
// attachments. Pure decision here; the sync loop renders and PUTs.
export function shouldBackfillTradeBillPdf(inv: any, current: TradeBillCurrent & { invoice_number?: string | null }): boolean {
  if (!inv || inv.Type !== 'ACCPAY') return false
  if (inv.HasAttachments === true) return false
  const status = String(inv.Status || '').toUpperCase()
  if (status === 'VOIDED' || status === 'DELETED') return false
  if (RELEASED_TRADE_INVOICE_STATUSES.has(String(current?.status || ''))) return false
  return Array.isArray(inv.LineItems) && inv.LineItems.length > 0
}

// ── Changes the office makes to a crew bill in Xero (Group WO field-ready
// check V10, 3 Nov 2026) ──
// The office adds its own lines to a crew bill in Xero after our push: on
// SW-INV-A-261011-029 "Vehicle Loan repayment" -100.00 on account 611 (app
// 1438.20, Xero 1338.20), on SW-INV-A-261015-020 "Back payment on over
// payment" -50.00 on 712 (app 631.68, Xero 581.68). The app, and the crew
// member, saw the pay before them. This reads the bill's lines and records
// what Xero pays and each change, named, on trade_invoices (migration
// 20261103140000).
//
// The total needs no reading of descriptions. The lines our push writes sum to
// net pay less a recurring deduction (tradeInvoiceXeroBillSubtotal; the push
// refuses a returned bill whose lines do not), so whatever else the bill's
// lines add up to now was changed in Xero. A GST bill that Xero holds without
// GST (four of them, 30 Aug to 14 Sep) is therefore not a change: its lines
// still sum to net pay, only Xero's tax differs, and xero_bill_total shows it.
//
// Naming each change: a line is ours when it is the super withhold line, the
// recurring deduction line, or a work line. A work line names the trade on its
// first line (every push since mid September 2026,
// withTradeIdentityOnXeroDescription), or before that named its job number on
// a line of its own ("SWF-26968 | SW - FENCING"); a negative line we push, for
// example a fence lead's work-order deduction, still starts with the trade's
// name. Every other line is the office's, kept with its description, amount
// and account. If the office's lines do not explain the whole change (one of
// our own lines edited in Xero, or SW-INV-I-260828-006's 28 Aug push, whose
// lines are 208.21 short of its net pay), the rest is one 'unexplained' entry:
// never dropped, never guessed at.
export type TradeBillAdjustmentKind = 'office_line' | 'unexplained'

export interface TradeBillAdjustmentLine {
  description: string
  amount: number
  account_code: string | null
  kind: TradeBillAdjustmentKind
}

export interface TradeBillAdjustments {
  xero_bill_total: number
  xero_adjustments_ex: number
  xero_adjustment_lines: TradeBillAdjustmentLine[]
}

export interface TradeBillAdjustmentsCurrent {
  status?: string | null
  net_pay?: number | string | null
  recurring_deduction_amount?: number | string | null
  xero_bill_total?: number | string | null
  xero_adjustments_ex?: number | string | null
  xero_adjustment_lines?: unknown
  // The trade's name, as the push wrote it on each work line (users.name).
  users?: { name?: string | null } | null
}

export const TRADE_BILL_UNEXPLAINED_ADJUSTMENT = 'Difference on the Xero bill with no line of its own'

// A description line that starts with a job number: "SWF-26968 | SW - FENCING",
// "SWMS-261523 | SW - MAKESAFE", "SW1797 | Construction",
// "SWP-261160 Dylan Francis - 10h @ $40/hr".
const JOB_NUMBER_LINE = /(^|\n)\s*[A-Z]{2,5}-?\d{3,}\b/

function moneyCents(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

function lineCents(line: any): number | null {
  const amount = moneyCents(line?.LineAmount)
  if (amount !== null) return amount
  const quantity = Number(line?.Quantity ?? 1)
  const unit = Number(line?.UnitAmount)
  return Number.isFinite(quantity) && Number.isFinite(unit) ? Math.round(quantity * unit * 100) : null
}

/** Did our push write this bill line? (super, recurring deduction or work line) */
export function isOurTradeBillLine(line: any, tradeName: string | null | undefined): boolean {
  if (isTradeInvoiceSuperXeroLine(line) || isTradeInvoiceRecurringDeductionXeroLine(line)) return true
  const description = String(line?.Description || '').replace(/\r\n?/g, '\n')
  // The push writes 'Unknown Trade' when it has no name for the trade.
  const name = String(tradeName || '').trim() || 'Unknown Trade'
  const first = (description.split('\n', 1)[0] || '').trim()
  if (first.toLowerCase() === name.toLowerCase()) return true
  return JOB_NUMBER_LINE.test(description)
}

/**
 * What Xero pays on a crew bill and every change made to it in Xero, from the
 * bill as Xero returned it (or its copy in xero_invoices.raw_json). null when
 * it cannot be read honestly: an invoice before the super split (no net pay to
 * compare with), a released invoice, or a bill without its lines or total.
 */
export function readTradeBillAdjustments(inv: any, current: TradeBillAdjustmentsCurrent): TradeBillAdjustments | null {
  if (RELEASED_TRADE_INVOICE_STATUSES.has(String(current?.status || ''))) return null
  const netPayCents = moneyCents(current?.net_pay)
  if (netPayCents === null) return null
  const deductionCents = moneyCents(current?.recurring_deduction_amount) ?? 0
  const totalCents = moneyCents(inv?.Total)
  const items = inv?.LineItems
  if (totalCents === null || !Array.isArray(items) || items.length === 0) return null
  const tradeName = current?.users?.name ?? null
  let allCents = 0
  let officeCents = 0
  const lines: TradeBillAdjustmentLine[] = []
  for (const item of items) {
    const cents = lineCents(item)
    if (cents === null) return null
    allCents += cents
    // A 0.00 line (a note) changes no pay; ours are matched by their wording.
    if (cents === 0 || isOurTradeBillLine(item, tradeName)) continue
    officeCents += cents
    lines.push({
      description: String(item?.Description || '').replace(/\s+/g, ' ').trim() || 'Line added in Xero',
      amount: cents / 100,
      account_code: String(item?.AccountCode ?? '').trim() || null,
      kind: 'office_line',
    })
  }
  // tradeInvoiceXeroBillSubtotal: what our push put on the bill's lines.
  const changeCents = allCents - (netPayCents - deductionCents)
  const unexplainedCents = changeCents - officeCents
  if (unexplainedCents !== 0) {
    lines.push({ description: TRADE_BILL_UNEXPLAINED_ADJUSTMENT, amount: unexplainedCents / 100, account_code: null, kind: 'unexplained' })
  }
  return { xero_bill_total: totalCents / 100, xero_adjustments_ex: changeCents / 100, xero_adjustment_lines: lines }
}

function adjustmentLinesKey(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  return JSON.stringify(value.map((line: any) => [
    String(line?.description ?? ''),
    moneyCents(line?.amount),
    line?.account_code ?? null,
    String(line?.kind ?? ''),
  ]))
}

/** The three columns to write when the bill says something new, else null. */
export function tradeBillAdjustmentsPatch(inv: any, current: TradeBillAdjustmentsCurrent): TradeBillAdjustments | null {
  const read = readTradeBillAdjustments(inv, current)
  if (!read) return null
  const same = moneyCents(current?.xero_bill_total) === Math.round(read.xero_bill_total * 100) &&
    moneyCents(current?.xero_adjustments_ex) === Math.round(read.xero_adjustments_ex * 100) &&
    adjustmentLinesKey(current?.xero_adjustment_lines) === adjustmentLinesKey(read.xero_adjustment_lines)
  return same ? null : read
}

// ── Catch-up from the Xero copy (Group WO field-ready check V12, 3 Nov 2026) ──
// The status patch above runs only inside the incremental invoice loop, which
// asks Xero for bills changed since the last run. A bill paid before that code
// shipped (8 Sep), or one whose change fell outside the window, was never
// patched: 17 crew bills since 1 Jul were PAID in Xero but not paid here.
// The full backfill refreshes xero_invoices (raw_json) without touching
// trade_invoices. This pass reads that copy, no Xero call, and applies the
// same patch to every pushed trade bill that disagrees with it.
// V10: the same pass records the office's changes on every crew bill with the
// super split that has not been read yet (paid ones included, once), and keeps
// them current on bills still open. Newest first, so a backlog never starves
// this week's bills.
export const TRADE_BILL_CATCHUP_LIMIT = 200

export const TRADE_BILL_CATCHUP_COLUMNS = 'id, status, xero_bill_status, amount_paid, paid_at, xero_bill_id, net_pay, recurring_deduction_amount, xero_bill_total, xero_adjustments_ex, xero_adjustment_lines, users:user_id(name)'

export async function catchUpTradeBillStatusFromMirror(sb: any): Promise<{ checked: number; patched: number; adjusted: number; failed: number }> {
  const out = { checked: 0, patched: 0, adjusted: 0, failed: 0 }
  const { data: rows, error } = await sb.from('trade_invoices')
    .select(TRADE_BILL_CATCHUP_COLUMNS)
    .not('xero_bill_id', 'is', null)
    .not('status', 'in', '("draft","failed","ops-reject")')
    .or('status.neq.paid,and(xero_adjustments_ex.is.null,net_pay.not.is.null)')
    .order('created_at', { ascending: false })
    .limit(TRADE_BILL_CATCHUP_LIMIT)
  if (error || !Array.isArray(rows) || rows.length === 0) return out
  const ids = rows.map((r: any) => String(r.xero_bill_id))
  const { data: mirror, error: mirrorError } = await sb.from('xero_invoices')
    .select('xero_invoice_id, raw_json')
    .in('xero_invoice_id', ids)
  if (mirrorError || !Array.isArray(mirror)) return out
  const byId = new Map(mirror.map((m: any) => [String(m.xero_invoice_id), m.raw_json]))
  for (const row of rows) {
    const raw = byId.get(String(row.xero_bill_id))
    if (!raw || raw.Type !== 'ACCPAY') continue
    out.checked++
    // Its own write, before the status one (both are guarded on the status
    // read here): a refused reading never holds back a paid status.
    const adjustments = tradeBillAdjustmentsPatch(raw, row)
    if (adjustments) {
      const { error: adjustError } = await sb.from('trade_invoices').update(adjustments).eq('id', row.id).eq('status', row.status)
      if (adjustError) out.failed++
      else out.adjusted++
    }
    const patch = tradeBillStatusPatch(raw, row)
    if (!patch) continue
    const { error: writeError } = await sb.from('trade_invoices').update(patch).eq('id', row.id).eq('status', row.status)
    if (writeError) out.failed++
    else out.patched++
  }
  return out
}
