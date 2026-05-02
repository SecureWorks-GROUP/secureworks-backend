// Quick Quote adapter — folds an ops-api/createMiscJob shape into the V2
// envelope's scope/pricing blocks.
//
// Quick Quote is the simplest path. The ops-api `createMiscJob` action stores
// caller-supplied line_items + description directly in `jobs.pricing_json`.
// There's no scope_json (it's a free-form quote, not a scoped patio/fence).
//
// Real production keys (sampled 2026-05-01 from `jobs.pricing_json` rows
// where jobs.type='general'):
//   source='quick_quote', line_items[], totalIncGST, totalExGST, gst,
//   job_description, job_type_label, payment_terms, valid_days, deposit,
//   client_notes, internal_notes, reference, version

import type { AdapterInputs, AdapterOutput, BuildScopeBlock } from '../adapter_interface.ts'
import type {
  QuickQuoteScopeBlock,
  PricingPublic,
  PricingLineItem,
  LineCategory,
} from '../manifest_v2_types.ts'
import type { InternalCostSnapshot, CommissionRule } from '../internal_cost_types.ts'
import {
  asArray,
  asNumber,
  asNumberOrNull,
  asObject,
  asString,
  deriveLineId,
} from './_extract.ts'

export const buildQuickQuoteScopeBlock: BuildScopeBlock = (inputs: AdapterInputs): AdapterOutput => {
  // Synchronous interface for the BuildScopeBlock type. This adapter calls
  // an async helper internally — wrapped via Promise.all in the dispatcher
  // since deriveLineId() needs crypto.subtle.digest. We return a syntactic
  // stub here and the dispatcher resolves the real output. See dispatch.ts.
  // For test simplicity in P1, we synchronously assemble with deterministic
  // pseudo line ids derived from index alone (no hash dependency).
  const pricing = asObject(inputs.job.pricing_json)
  const rawLines = asArray(pricing.line_items)

  const lineItems: PricingLineItem[] = rawLines.map((raw, idx) => {
    const li = asObject(raw)
    const category = (asString(li.category) || 'extra') as LineCategory
    const qty = asNumber(li.quantity, 1)
    const unitSell = asNumber(li.unit_price, 0)
    const lineTotal = asNumber(li.total, qty * unitSell)
    return {
      // Synchronous fallback id derivation: index + description hash-prefix
      // computed via the async path is preferred but this works for P1
      // adapter shape parity. Real adapters get hashed ids via the
      // dispatch-side wrapper that awaits deriveLineId().
      line_id: `qq-L-${idx}`,
      category,
      description: asString(li.description),
      qty,
      unit: asString(li.unit, 'ea'),
      unit_sell: unitSell,
      line_total_ex: lineTotal,
      allocation: 'client',
      split_pct: 100,
      per_contact: [],
    }
  })

  const subtotal = asNumber(pricing.totalExGST, lineItems.reduce((a, x) => a + x.line_total_ex, 0))
  const gst = asNumber(pricing.gst, Math.round(subtotal * 0.1 * 100) / 100)
  const totalInc = asNumber(pricing.totalIncGST, Math.round((subtotal + gst) * 100) / 100)
  // Pull the primary contact id from supplemental.contacts[0] when present —
  // Quick Quote runs to a single primary recipient, so per_contact_totals is
  // a single-row array if at all.
  const contacts = asArray(inputs.supplemental.contacts)
  const primaryContactId = contacts.length > 0 ? asString(asObject(contacts[0]).id) : ''

  const pricingPublic: PricingPublic = {
    line_items: lineItems,
    totals: {
      subtotal_ex_gst: subtotal,
      gst,
      total_ex_gst: subtotal,
      total_inc_gst: totalInc,
    },
    per_contact_totals: primaryContactId
      ? [{ contact_id: primaryContactId, total_ex_gst: subtotal, total_inc_gst: totalInc }]
      : [],
  }

  const scope: QuickQuoteScopeBlock = {
    kind: 'quick_quote',
    schema_version: '2.0',
    label: asString(pricing.job_type_label, 'Quick Quote'),
    description: asString(pricing.job_description),
  }

  // Internal cost snapshot. Quick Quote captures unit_cost per line if the
  // caller provided it (createMiscJob accepts cost_price). Supplier name is
  // typically blank for Quick Quote — the validator will hard-fail on missing
  // supplier_name for material lines unless overridden.
  const lineCosts = lineItems.map((li, idx) => {
    const raw = asObject(rawLines[idx])
    const unitCost = asNumber(raw.cost_price, 0)
    return {
      line_id: li.line_id,
      unit_cost: unitCost,
      line_cost_total_ex: Math.round(unitCost * li.qty * 100) / 100,
      supplier_name: null,
    }
  })

  const materialTotal = asNumber(
    pricing.materialCostEstimate,
    lineCosts
      .filter((_, i) => lineItems[i].category === 'material')
      .reduce((a, x) => a + x.line_cost_total_ex, 0),
  )
  const labourTotal = asNumber(
    pricing.labourCostEstimate,
    lineCosts
      .filter((_, i) => lineItems[i].category === 'labour')
      .reduce((a, x) => a + x.line_cost_total_ex, 0),
  )
  const commissionTotal = asNumber(pricing.commissionCostEstimate, 0)
  const marginPct = asNumber(pricing.margin_pct, 0)

  const commissionRule: CommissionRule = 'other' // Quick Quote default

  const internal_cost: InternalCostSnapshot = {
    schema_version: '2.0',
    release_id: '',
    job_id: inputs.job.id,
    version: 1,
    captured_at: '',
    line_costs: lineCosts,
    cost_estimates: {
      material_total: materialTotal,
      labour_total: labourTotal,
      subcontract_commission_total: commissionTotal,
    },
    margin: {
      pct: marginPct,
      floor_breached: marginPct > 0 && marginPct < 0.2,
      override_reason: null,
      override_approver_user_id: null,
    },
    commission: {
      rule: commissionRule,
      amount: commissionTotal,
      salesperson_user_id: null,
    },
  }

  // Quick Quote QA facts: pull customer-facing summary from job_description
  // when available. Council status defaults to 'not_required' for Quick Quote
  // (most common: gutter repair, small fence panel, etc.). Scoping tools
  // would override this when council approval is genuinely needed.
  const description = asString(pricing.job_description)
  const facingSummary = description.length >= 40 ? description : `Quick Quote: ${asString(pricing.job_type_label)}. ${description}`

  return {
    scope,
    pricing_public: pricingPublic,
    internal_cost,
    qa_facts: {
      customer_facing_summary: facingSummary,
      council_status: 'not_required',
      qa_passed_by: null,
    },
  }
}

export function _quickQuotePresenceReport(inputs: AdapterInputs): {
  captured: string[]
  missing: string[]
  partial: string[]
} {
  // Soft-warn presence audit. Used by the dry-run tool to count what's
  // captured today vs what's GAP. Each adapter exports its own presence
  // helper so the dry-run tool can aggregate without re-walking the shape.
  const pricing = asObject(inputs.job.pricing_json)
  const captured: string[] = []
  const missing: string[] = []
  const partial: string[] = []

  ;(asArray(pricing.line_items).length > 0 ? captured : missing).push('pricing.line_items')
  ;(asNumberOrNull(pricing.totalIncGST) !== null ? captured : missing).push('pricing.totals')
  ;(asString(pricing.job_description).length > 0 ? captured : missing).push('scope.description')
  ;(asString(pricing.job_type_label).length > 0 ? captured : missing).push('scope.label')

  // Always-GAP fields for Quick Quote today:
  partial.push('internal_cost.line_costs[].supplier_name (typically blank)')
  partial.push('site.lat/lng (createMiscJob captures address but not geocode)')
  missing.push('media[] (Quick Quote has no scoping-tool media flow today)')
  missing.push('provenance.tool_name + tool_version (createMiscJob does not record tool)')
  missing.push('terms.terms_version (legacy_unknown by default per §9)')

  return { captured, missing, partial }
}
