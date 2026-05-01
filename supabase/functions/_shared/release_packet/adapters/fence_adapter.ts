// Fence adapter — folds fence-designer's `jobs.scope_json` + `pricing_json`
// shape into the V2 envelope's scope/pricing blocks.
//
// Real production keys (sampled 2026-05-01 from `jobs.scope_json` rows where
// jobs.type='fencing'):
//   job, savedAt, scopeMedia, tool, version
//
// And `jobs.pricing_json`:
//   commissionCostEstimate, deposit, generated_at, gst, internal,
//   job_description, labourCostEstimate, line_items, margin_pct,
//   materialCostEstimate, neighbour_splits, runs, source, subtotal,
//   totalCostEstimate, totalExGST, totalIncGST, version
//
// Critical for fence: the per-run breakdown is in `pricing_json.runs[]`,
// each run's per-line allocation is via `run_line_items` table (live-joined
// for V2), and per-contact splits are in `pricing_json.neighbour_splits`.
// Adapters draw the fence runs from `pricing_json.runs[]` (the canonical
// source) — `scope_json.job` may also carry data but `pricing_json.runs[]`
// is what every release path emits.

import type { AdapterInputs, AdapterOutput, BuildScopeBlock } from '../adapter_interface.ts'
import type {
  FenceScopeBlock,
  FenceRun,
  FenceGate,
  PricingPublic,
  PricingLineItem,
  PerContactTotal,
  PerContactSplit,
  LineCategory,
  LineAllocation,
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

export const buildFenceScopeBlock: BuildScopeBlock = (inputs: AdapterInputs): AdapterOutput => {
  const scopeJson = asObject(inputs.job.scope_json)
  const pricingJson = asObject(inputs.job.pricing_json)

  // Build per-run scope block.
  const runsRaw = asArray(pricingJson.runs)
  const runs: FenceRun[] = runsRaw.map((rawRun) => {
    const run = asObject(rawRun)
    const gates = asArray(run.gates).map((rawGate): FenceGate => {
      const g = asObject(rawGate)
      return {
        type: asString(g.type, 'unknown'),
        width_mm: asNumber(g.width_mm, 0),
        height_mm: asNumber(g.height_mm, 0),
        hardware: asString(g.hardware) || null,
      }
    })
    return {
      run_label: asString(run.run_label, 'UNNAMED'),
      type: asString(run.type, 'colorbond'),
      height_mm: asNumber(run.height_mm, 0),
      lineal_m: asNumber(run.lineal_m ?? run.length_m, 0),
      panels: asNumberOrNull(run.panels),
      posts: asNumberOrNull(run.posts),
      infill: asString(run.infill) || null,
      finish: asString(run.finish) || null,
      demo: asBool(run.demo),
      gates,
    }
  })

  // scope_json.scopeMedia indicates whether boundary plans/photos were
  // uploaded; the actual media flows through job_media (live-joined).
  const scopeMedia = asObject(scopeJson.scopeMedia)
  const boundaryPlanAttached = asArray(scopeMedia.drawings).length > 0 ||
    asArray(scopeMedia.boundary_plans).length > 0

  const scope: FenceScopeBlock = {
    kind: 'fence',
    schema_version: '2.0',
    runs,
    boundary_plan_attached: boundaryPlanAttached,
  }

  // Pricing_public: aggregate across runs. Each line in pricing_json.line_items
  // refers back to a run via run_label. Per-contact split derived from
  // neighbour_splits + supplemental.contacts (V2 expects these joined upstream).
  const lineItems = buildFenceLineItems(pricingJson, asArray(inputs.supplemental.contacts))

  const subtotal = asNumber(
    pricingJson.totalExGST ?? pricingJson.subtotal,
    lineItems.reduce((a, x) => a + x.line_total_ex, 0),
  )
  const gst = asNumber(pricingJson.gst, Math.round(subtotal * 0.1 * 100) / 100)
  const totalInc = asNumber(pricingJson.totalIncGST, Math.round((subtotal + gst) * 100) / 100)

  const perContactTotals = buildPerContactTotals(pricingJson, asArray(inputs.supplemental.contacts))

  const pricingPublic: PricingPublic = {
    line_items: lineItems,
    totals: {
      subtotal_ex_gst: subtotal,
      gst,
      total_ex_gst: subtotal,
      total_inc_gst: totalInc,
    },
    per_contact_totals: perContactTotals,
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
      rule: 'fence_5_25pct_inc_gst',
      amount: commissionTotal,
      salesperson_user_id: null,
    },
  }

  const baseDescription = asString(pricingJson.job_description)
  const totalLineal = runs.reduce((a, r) => a + r.lineal_m, 0)
  const summary = baseDescription.length >= 40
    ? baseDescription
    : `${totalLineal}m of ${asString(runs[0]?.type, 'colorbond')} fencing across ${runs.length} run${runs.length === 1 ? '' : 's'}. ${baseDescription}`

  // Council status: fence-designer's scope_json.job carries council fields
  // when captured. Default 'unknown' (validator hard-fails until captured).
  const jobBlock = asObject(scopeJson.job)
  const councilRaw = asString(jobBlock.council_status).toLowerCase()
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

function buildFenceLineItems(
  pricingJson: Record<string, unknown>,
  contacts: unknown[],
): PricingLineItem[] {
  // Fence pricing has BOTH a top-level `line_items` array (used for totals
  // recon) AND per-run `runs[].items` (the per-run breakdown). The top-level
  // line_items is canonical for totals; the per-run items inform allocation.
  // For V2 we use the top-level line_items and look up per-run allocation
  // via the line's `run_label` field plus `neighbour_splits`.
  const raw = asArray(pricingJson.line_items)
  const splitsByRun = buildSplitsByRunLabel(pricingJson, contacts)

  return raw.map((rawLine, idx) => {
    const li = asObject(rawLine)
    const category = (asString(li.category) || guessCategory(asString(li.description))) as LineCategory
    const qty = asNumber(li.quantity ?? li.qty, 1)
    const unitSell = asNumber(li.unit_price_ex ?? li.unit_price ?? li.unit_sell, 0)
    const lineTotal = asNumber(li.line_total_ex ?? li.total, qty * unitSell)
    const allocation = (asString(li.allocation) || 'client') as LineAllocation
    const splitPct = asNumber(li.split_pct, 100)
    const runLabel = asString(li.run_label)

    // Per-contact split for this line: lookup the per-run splits.
    const runSplits = splitsByRun.get(runLabel) ?? []
    const per_contact: PerContactSplit[] = runSplits.length > 0
      ? runSplits.map((s) => ({
          contact_id: s.contact_id,
          amount_ex: Math.round(lineTotal * s.share * 100) / 100,
        }))
      : []

    return {
      line_id: `fence-L-${idx}`,
      category,
      description: asString(li.description),
      qty,
      unit: asString(li.unit, 'm'),
      unit_sell: unitSell,
      line_total_ex: lineTotal,
      allocation,
      split_pct: splitPct,
      per_contact,
    }
  })
}

function buildSplitsByRunLabel(
  pricingJson: Record<string, unknown>,
  contacts: unknown[],
): Map<string, Array<{ contact_id: string; share: number }>> {
  // neighbour_splits shape varies; we tolerate both:
  //   { 'REAR': [{contact_id, pct}, ...], ... }
  // and:
  //   [{run_label, contact_id, pct}, ...]
  const result = new Map<string, Array<{ contact_id: string; share: number }>>()
  const splits = pricingJson.neighbour_splits

  // Helper to get default contact id (primary).
  const primaryId = contacts.length > 0 ? asString(asObject(contacts[0]).id) : ''

  if (Array.isArray(splits)) {
    for (const rawEntry of splits) {
      const e = asObject(rawEntry)
      const runLabel = asString(e.run_label)
      const contactId = asString(e.contact_id) || primaryId
      const pct = asNumber(e.pct ?? e.split_pct, 100) / 100
      const arr = result.get(runLabel) ?? []
      arr.push({ contact_id: contactId, share: pct })
      result.set(runLabel, arr)
    }
  } else if (splits && typeof splits === 'object') {
    for (const [runLabel, raw] of Object.entries(splits as Record<string, unknown>)) {
      const arr: Array<{ contact_id: string; share: number }> = []
      for (const rawEntry of asArray(raw)) {
        const e = asObject(rawEntry)
        const contactId = asString(e.contact_id) || primaryId
        const pct = asNumber(e.pct ?? e.split_pct, 100) / 100
        arr.push({ contact_id: contactId, share: pct })
      }
      result.set(runLabel, arr)
    }
  }
  return result
}

function buildPerContactTotals(
  pricingJson: Record<string, unknown>,
  contacts: unknown[],
): PerContactTotal[] {
  // Sum line_items per contact via neighbour_splits.
  const splitsByRun = buildSplitsByRunLabel(pricingJson, contacts)
  const totalsExByContact = new Map<string, number>()

  for (const rawLine of asArray(pricingJson.line_items)) {
    const li = asObject(rawLine)
    const lineTotal = asNumber(li.line_total_ex ?? li.total, 0)
    const runLabel = asString(li.run_label)
    const splits = splitsByRun.get(runLabel) ?? []
    if (splits.length === 0) {
      // Whole line goes to primary.
      const primaryId = contacts.length > 0 ? asString(asObject(contacts[0]).id) : ''
      if (primaryId) {
        totalsExByContact.set(primaryId, (totalsExByContact.get(primaryId) ?? 0) + lineTotal)
      }
    } else {
      for (const s of splits) {
        const portion = Math.round(lineTotal * s.share * 100) / 100
        totalsExByContact.set(s.contact_id, (totalsExByContact.get(s.contact_id) ?? 0) + portion)
      }
    }
  }

  return Array.from(totalsExByContact.entries()).map(([contact_id, total_ex_gst]) => ({
    contact_id,
    total_ex_gst: Math.round(total_ex_gst * 100) / 100,
    total_inc_gst: Math.round(total_ex_gst * 1.1 * 100) / 100,
  }))
}

function findRawLine(pricingJson: Record<string, unknown>, line_id: string): Record<string, unknown> {
  const idxMatch = /^fence-L-(\d+)$/.exec(line_id)
  if (!idxMatch) return {}
  const idx = parseInt(idxMatch[1], 10)
  return asObject(asArray(pricingJson.line_items)[idx])
}

function guessCategory(description: string): LineCategory {
  const d = description.toLowerCase()
  if (/labour|install|labor/.test(d)) return 'labour'
  if (/demo|removal/.test(d)) return 'demo'
  if (/commission/.test(d)) return 'subcontract'
  return 'material'
}

// Soft-warn presence audit for the dry-run tool.
export function _fencePresenceReport(inputs: AdapterInputs): {
  captured: string[]
  missing: string[]
  partial: string[]
} {
  const scopeJson = asObject(inputs.job.scope_json)
  const pricingJson = asObject(inputs.job.pricing_json)
  const jobBlock = asObject(scopeJson.job)

  const captured: string[] = []
  const missing: string[] = []
  const partial: string[] = []

  ;(asArray(pricingJson.runs).length > 0 ? captured : missing).push('scope.runs')
  ;(asArray(pricingJson.line_items).length > 0 ? captured : missing).push('pricing.line_items')
  ;(asNumberOrNull(pricingJson.totalIncGST) !== null ? captured : missing).push('pricing.totals')
  ;(pricingJson.neighbour_splits ? captured : missing).push('pricing.neighbour_splits')
  ;(asObject(scopeJson.scopeMedia) ? captured : partial).push('scope.scopeMedia')
  ;(asString(jobBlock.council_status).length > 0 ? captured : missing).push('site.council_status')

  // Always-GAP fields for Fence today:
  missing.push('site.access (chips/notes — currently ad-hoc)')
  missing.push('site.handover_instructions')
  missing.push('qa.customer_facing_summary (reconstructed from description)')
  missing.push('media sha256 (job_media has no sha256 column today)')
  missing.push('per-contact authority {can_view, can_accept, pays} (default-derived from contact role)')
  partial.push('internal_cost.line_costs[].supplier_name (often blank)')
  partial.push('provenance.tool_version')

  return { captured, missing, partial }
}
