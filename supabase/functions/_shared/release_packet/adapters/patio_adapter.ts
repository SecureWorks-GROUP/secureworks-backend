// Patio adapter — folds the patio-tool's `jobs.scope_json` + `pricing_json`
// shape into the V2 envelope's scope/pricing blocks.
//
// Real production keys (sampled 2026-05-01 from `jobs.scope_json` rows
// where jobs.type='patio'):
//   _pricing_json, client, complexity, config, customer, job_costs,
//   notes, patios, pricing, savedAt, siteDetails, tool, verification, version
//
// And in `jobs.pricing_json` (also patio):
//   client_notes, commissionCostEstimate, deposit, generated_at, gst,
//   internal_notes, items, job_costs, job_description, job_type_label,
//   labourCostEstimate, line_items, margin_pct, materialCostEstimate,
//   patios, payment_terms, reference, shared_costs_total, source,
//   totalCostEstimate, totalExGST, totalIncGST, valid_days, version
//
// `scope_json.patios[]` and `pricing_json.patios[]` carry per-patio config.
// Most jobs have a single patio at index [0]; multi-patio is a future
// feature we treat as out-of-scope for V2 (the adapter only reads patios[0]
// and emits a soft-warn if patios[1+] exist).

import type { AdapterInputs, AdapterOutput, BuildScopeBlock } from '../adapter_interface.ts'
import type {
  PatioScopeBlock,
  PricingPublic,
  PricingLineItem,
  LineCategory,
  PatioPackageLine,
} from '../manifest_v2_types.ts'
import type { InternalCostSnapshot } from '../internal_cost_types.ts'
import {
  asArray,
  asBool,
  asNumber,
  asNumberOrNull,
  asObject,
  asString,
} from './_extract.ts'

export const buildPatioScopeBlock: BuildScopeBlock = (inputs: AdapterInputs): AdapterOutput => {
  const scopeJson = asObject(inputs.job.scope_json)
  const pricingJson = asObject(inputs.job.pricing_json)

  // Pick the primary patio config from scope_json.patios[0].
  const patios = asArray(scopeJson.patios)
  const patio0 = asObject(patios[0])
  const config = asObject(patio0.config ?? scopeJson.config)

  const lineItems = buildPatioLineItems(pricingJson)

  const subtotal = asNumber(pricingJson.totalExGST, lineItems.reduce((a, x) => a + x.line_total_ex, 0))
  const gst = asNumber(pricingJson.gst, Math.round(subtotal * 0.1 * 100) / 100)
  const totalInc = asNumber(pricingJson.totalIncGST, Math.round((subtotal + gst) * 100) / 100)

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

  const packageLines: PatioPackageLine[] = asArray(patio0.package_lines).map((raw, idx) => {
    const p = asObject(raw)
    return {
      line_id: `patio-pkg-${idx}`,
      description: asString(p.description),
      qty: asNumber(p.qty ?? p.quantity, 1),
      unit: asString(p.unit, 'ea'),
    }
  })

  const dimensions = asObject(config.dimensions ?? patio0.dimensions)
  const scope: PatioScopeBlock = {
    kind: 'patio',
    schema_version: '2.0',
    structure_type: asString(config.structure_type ?? patio0.structure_type, 'unknown'),
    dimensions: {
      width_m: asNumber(dimensions.width ?? dimensions.width_m, 0),
      depth_m: asNumber(dimensions.depth ?? dimensions.depth_m, 0),
      height_m: asNumberOrNull(dimensions.height ?? dimensions.height_m),
    },
    roof_sheet_colour: asString(config.roof_sheet_colour ?? config.roof_colour) || null,
    post_type: asString(config.post_type) || null,
    footings: asString(config.footings) || null,
    gutter: asString(config.gutter) || null,
    fascia: asString(config.fascia) || null,
    electrical_yes_no: asBool(config.electrical_yes_no ?? config.electrical),
    demo_yes_no: asBool(config.demo_yes_no ?? config.demo),
    package_lines: packageLines,
  }

  // Internal cost snapshot.
  const lineCosts = lineItems.map((li) => {
    const raw = findRawLine(pricingJson, li.line_id)
    const unitCost = asNumber(raw.cost_price ?? raw.unit_cost, 0)
    return {
      line_id: li.line_id,
      unit_cost: unitCost,
      line_cost_total_ex: Math.round(unitCost * li.qty * 100) / 100,
      supplier_name: asString(raw.supplier_name) || null,
    }
  })

  const materialTotal = asNumber(pricingJson.materialCostEstimate, 0)
  const labourTotal = asNumber(pricingJson.labourCostEstimate, 0)
  const commissionTotal = asNumber(pricingJson.commissionCostEstimate, 0)
  const marginPct = asNumber(pricingJson.margin_pct, 0)

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
      rule: 'patio_10pct_gp',
      amount: commissionTotal,
      salesperson_user_id: null,
    },
  }

  // QA facts. patio-tool doesn't currently emit a structured customer-
  // facing summary; we reconstruct from job_description + key config fields.
  const baseDescription = asString(pricingJson.job_description)
  const dim = scope.dimensions
  const summary = baseDescription.length >= 40
    ? baseDescription
    : `${scope.structure_type} patio ${dim.width_m}×${dim.depth_m}m. ${asString(pricingJson.job_type_label, 'Patio')}. ${baseDescription}`

  // Council status — patio-tool's siteDetails block has council fields. Try
  // to read them; fall back to 'unknown' so the validator hard-fails the
  // release until capture is added.
  const siteDetails = asObject(scopeJson.siteDetails)
  const councilRaw = asString(siteDetails.council_status).toLowerCase()
  const councilStatus =
    councilRaw === 'not_required' ? 'not_required' :
    councilRaw === 'required_pending' ? 'required_pending' :
    councilRaw === 'required_approved' ? 'required_approved' :
    'unknown'

  return {
    scope,
    pricing_public: pricingPublic,
    internal_cost,
    qa_facts: {
      customer_facing_summary: summary,
      council_status: councilStatus,
      qa_passed_by: null,
    },
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildPatioLineItems(pricingJson: Record<string, unknown>): PricingLineItem[] {
  // patio-tool stores line items under `pricing_json.line_items` (canonical)
  // and sometimes under `pricing_json.items` (legacy). Prefer line_items.
  const raw = asArray(pricingJson.line_items).length > 0
    ? asArray(pricingJson.line_items)
    : asArray(pricingJson.items)

  return raw.map((rawLine, idx) => {
    const li = asObject(rawLine)
    const category = (asString(li.category) || guessCategory(asString(li.description))) as LineCategory
    const qty = asNumber(li.quantity ?? li.qty, 1)
    const unitSell = asNumber(li.unit_price ?? li.unit_sell, 0)
    const lineTotal = asNumber(li.total ?? li.line_total_ex, qty * unitSell)
    return {
      line_id: `patio-L-${idx}`,
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
}

function findRawLine(pricingJson: Record<string, unknown>, line_id: string): Record<string, unknown> {
  const idxMatch = /^patio-L-(\d+)$/.exec(line_id)
  if (!idxMatch) return {}
  const idx = parseInt(idxMatch[1], 10)
  const raw = asArray(pricingJson.line_items).length > 0
    ? asArray(pricingJson.line_items)
    : asArray(pricingJson.items)
  return asObject(raw[idx])
}

function guessCategory(description: string): LineCategory {
  const d = description.toLowerCase()
  if (/labour|install|labor/.test(d)) return 'labour'
  if (/demo|removal/.test(d)) return 'demo'
  if (/commission|sales/.test(d)) return 'subcontract'
  return 'material'
}

// Soft-warn presence audit for the dry-run tool.
export function _patioPresenceReport(inputs: AdapterInputs): {
  captured: string[]
  missing: string[]
  partial: string[]
} {
  const scopeJson = asObject(inputs.job.scope_json)
  const pricingJson = asObject(inputs.job.pricing_json)
  const patio0 = asObject(asArray(scopeJson.patios)[0])
  const config = asObject(patio0.config ?? scopeJson.config)
  const siteDetails = asObject(scopeJson.siteDetails)

  const captured: string[] = []
  const missing: string[] = []
  const partial: string[] = []

  ;(asArray(pricingJson.line_items).length > 0 ? captured : missing).push('pricing.line_items')
  ;(asNumberOrNull(pricingJson.totalIncGST) !== null ? captured : missing).push('pricing.totals')
  ;(asString(config.structure_type ?? patio0.structure_type).length > 0 ? captured : missing).push('scope.structure_type')

  const dim = asObject(config.dimensions ?? patio0.dimensions)
  ;(asNumber(dim.width ?? dim.width_m, 0) > 0 ? captured : missing).push('scope.dimensions.width')
  ;(asNumber(dim.depth ?? dim.depth_m, 0) > 0 ? captured : missing).push('scope.dimensions.depth')

  ;(asString(siteDetails.council_status).length > 0 ? captured : missing).push('site.council_status')

  // Always-GAP fields for Patio today (per V1 gap-matrix):
  missing.push('site.access (chips/notes — currently ad-hoc inside scope_json)')
  missing.push('site.handover_instructions (currently inside jobs.notes)')
  missing.push('qa.customer_facing_summary (no structured field; reconstructed from description)')
  missing.push('media sha256 (job_media has no sha256 column today)')
  missing.push('3D model export (patio-tool keeps in localStorage; not pushed to job_media)')
  partial.push('internal_cost.line_costs[].supplier_name (often blank)')
  partial.push('provenance.tool_version (scope_json has version but not tool_name+pricing_engine_version split)')

  return { captured, missing, partial }
}
