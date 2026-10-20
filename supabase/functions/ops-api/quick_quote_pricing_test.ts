// The Quick Quote save (createMiscJob's pricing_json) run straight into the
// release adapter: the adapter is checked against what the save really
// writes, not only against hand-made fixtures.

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { buildQuickQuotePricingJson } from './quick_quote_pricing.ts'
import { dispatchAdapter } from '../_shared/release_packet/adapters/dispatch.ts'

// What ops-quick-quote.js posts: per-unit unit_price and cost_price, total = qty x price.
const screenBody = (lines: Array<{ q: number; p: number; c: number }>) => ({
  client_name: 'Sample Client',
  job_type_label: 'Repair gutter',
  description: 'Replace damaged 6m section of slimline gutter on the front of the house.',
  line_items: lines.map((l, i) => ({ description: `Line ${i + 1}`, quantity: l.q, unit: 'ea', unit_price: l.p, cost_price: l.c, total: l.q * l.p })),
})

function seal(pricing_json: Record<string, unknown>) {
  const r = dispatchAdapter({
    job: {
      id: 'job-qq-save-1', type: 'general', org_id: '00000000-0000-0000-0000-000000000001',
      client_name: 'Sample Client', client_email: null, client_phone: null, site_address: null, site_suburb: null,
      site_lat: null, site_lng: null, job_number: 'SWG-99003', scope_json: null, pricing_json, notes: '',
    },
    supplemental: { contacts: [] },
  } as never)
  assert(r.ok)
  return r.ok ? r.output.internal_cost : null as never
}

Deno.test('Quick Quote save: every line priced saves the worked-out margin, and the adapter seals the same figure', () => {
  const pj = buildQuickQuotePricingJson(screenBody([{ q: 8, p: 85, c: 60 }, { q: 1, p: 450, c: 350 }]))
  // sell 680 + 450 = 1130, cost 480 + 350 = 830: (1130 - 830) / 1130 = 26.55%
  assertEquals(pj.totalExGST, 1130)
  assertEquals(pj.margin_pct, 26.55)
  assertEquals(pj.margin_basis, 'from_line_costs')
  const ic = seal(pj)
  assertEquals(ic.margin.pct, 0.2655)
  assertEquals(ic.margin.floor_breached, false)
  assertEquals(ic.commission.basis, 'none_declared')
})

Deno.test('Quick Quote save: a line with no cost saves no margin, and the adapter seals no margin', () => {
  const pj = buildQuickQuotePricingJson(screenBody([{ q: 8, p: 85, c: 60 }, { q: 1, p: 900, c: 0 }]))
  assertEquals('margin_pct' in pj, false)
  assertEquals('margin_basis' in pj, false)
  const ic = seal(pj)
  assertEquals(ic.cost_estimates.costs_complete, false)
  assertEquals(ic.margin.pct, null)
  assertEquals(ic.margin.floor_check, 'costs_to_confirm')
})

Deno.test('Quick Quote save: the existing keys and totals are unchanged', () => {
  const pj = buildQuickQuotePricingJson(screenBody([{ q: 2, p: 100, c: 0 }]))
  assertEquals(Object.keys(pj), ['source', 'version', 'totalExGST', 'totalIncGST', 'gst', 'job_description', 'job_type_label', 'payment_terms', 'valid_days', 'client_notes', 'internal_notes', 'reference', 'line_items'])
  assertEquals([pj.totalExGST, pj.gst, pj.totalIncGST], [200, 20, 220])
})
