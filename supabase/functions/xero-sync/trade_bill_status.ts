// Trade bill (ACCPAY) status projection onto trade_invoices. Pure: the sync
// loop looks the row up by xero_bill_id and applies whatever this returns.
//
// History: the old detector gated on Reference text ("TRADE-..." or "... WE
// date") and queried a column trade_invoices never had, so no trade invoice was
// ever marked paid. The bill id we stored at push time is the only key.
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
