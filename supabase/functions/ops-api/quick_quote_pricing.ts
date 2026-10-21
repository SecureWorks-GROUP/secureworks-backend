// The pricing_json a Quick Quote saves (ops-api createMiscJob). Kept apart
// from the handler so the release adapter can be checked against what the
// save really writes, not only against hand-made fixtures.
//
// Margin: worked out from the lines by quickQuoteLineMargin, the same rule
// the release adapter uses, and saved only when every line has a cost price
// above 0. Otherwise no margin_pct is saved, never a margin from a short cost.
// margin_basis 'from_line_costs' says it was worked out, not typed. Nothing
// here sets a commission: Quick Quote has none (owner, 21 Oct 2026).

import { quickQuoteLineMargin } from '../_shared/release_packet/adapters/sealed_costs.ts'

export function buildQuickQuotePricingJson(body: Record<string, any>): Record<string, unknown> {
  const {
    job_type_label, description, reference,
    line_items, payment_terms, valid_days,
    client_notes, internal_notes,
  } = body

  const totalExGST = line_items.reduce((sum: number, li: any) => sum + (Number(li.total) || 0), 0)
  const gst = Math.round(totalExGST * 0.1 * 100) / 100
  const totalIncGST = Math.round((totalExGST + gst) * 100) / 100

  const lines = line_items.map((li: any) => ({
    description: li.description || '',
    quantity: Number(li.quantity) || 1,
    unit: li.unit || 'ea',
    unit_price: Number(li.unit_price) || 0,
    cost_price: Number(li.cost_price) || 0,
    total: Number(li.total) || 0,
  }))
  const margin = quickQuoteLineMargin(lines)

  return {
    source: 'quick_quote',
    version: '1.0',
    totalExGST,
    totalIncGST,
    gst,
    job_description: description || '',
    job_type_label: job_type_label || 'Miscellaneous',
    payment_terms: payment_terms || '50% deposit + 50% on completion',
    valid_days: valid_days || 30,
    client_notes: client_notes || '',
    internal_notes: internal_notes || '',
    reference: reference || '',
    line_items: lines,
    ...(margin.percent != null ? { margin_pct: margin.percent, margin_basis: 'from_line_costs' } : {}),
  }
}
