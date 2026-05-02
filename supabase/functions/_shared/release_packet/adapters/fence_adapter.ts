// Fence adapter — folds fence-designer's actual production shape into the
// V2 envelope's scope/pricing blocks.
//
// Production reality (sampled 2026-05-01, drilled 2026-05-01 round 2):
//
// `jobs.scope_json` keys: `job, savedAt, scopeMedia, tool, version`
//
// `jobs.scope_json.job` keys (this is where construction details live):
//   _addressComponents, _latlng, _materialOverrides, _placeId, _poApproved,
//   _pricing_json, address, checklist, client, clientFirstName,
//   clientLastName, colour, date, email, gates, gatesRequired, installation,
//   materialVerification, neighbours, neighboursRequired, phone,
//   pricePerMetre, profile, quote, ref, removal, runs, scoper, siteNotes,
//   suburb, supplier, supplierNotes
//
// `jobs.scope_json.job.runs[]` per-run construction keys:
//   extension, id, length, name, neighbourId, panels, sheetHeight, slope
//
// `jobs.pricing_json` top-level keys:
//   commissionCostEstimate, deposit, generated_at, gst, internal,
//   job_description, labourCostEstimate, line_items, margin_pct,
//   materialCostEstimate, neighbour_splits, runs, source, subtotal,
//   totalCostEstimate, totalExGST, totalIncGST, version
//
// `jobs.pricing_json.runs[]` keys:
//   default_split_pct, items, neighbour_address, neighbour_id, neighbour_name,
//   run_label, run_name, totals
//
// `jobs.pricing_json.runs[].items[]` keys (the canonical client-side line shape):
//   allocation, allocation_note, client_amount_ex, description, line_total_ex,
//   neighbour_amount_ex, quantity, sort_order, split_pct, unit, unit_price_ex
//
// `jobs.pricing_json.runs[].totals` keys:
//   client_share_ex, client_share_inc, neighbour_share_ex, neighbour_share_inc,
//   run_total_ex, run_total_inc
//
// `jobs.pricing_json.internal` is a flat object of scalars:
//   commission: number, cost: number, labour: number, margin: number
//
// Adapter strategy:
//   - Read construction details from `scope_json.job.runs[]` (length →
//     lineal_m, sheetHeight → height_mm, name → run_label, panels → panels).
//   - Read fence-job-wide attributes (profile, colour, removal, gates) from
//     `scope_json.job` and apply per-run defaults.
//   - Read line items from `pricing.runs[].items[]` using the V1 minimal
//     manifest's per-run line shape (matches `run_line_items` table).
//   - Use `pricing.runs[].totals` for per-contact totals (client_share_ex
//     + neighbour_share_ex).
//   - Read internal cost estimates from `pricing.internal.{cost, labour,
//     commission, margin}` (scalars), falling back to top-level
//     `pricing.materialCostEstimate / labourCostEstimate / commissionCostEstimate`.

import type { AdapterInputs, AdapterOutput, BuildScopeBlock } from '../adapter_interface.ts'
import {
  UNRESOLVED_PRIMARY_CONTACT_ID,
  type FenceScopeBlock,
  type FenceRun,
  type FenceGate,
  type PricingPublic,
  type PricingLineItem,
  type PerContactTotal,
  type PerContactSplit,
  type LineCategory,
  type LineAllocation,
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
  const jobBlock = asObject(scopeJson.job)

  // ── Build FenceRun[] from scope_json.job.runs[], indexed by name+id ─────
  const scopeRuns = asArray(jobBlock.runs)
  const pricingRuns = asArray(pricingJson.runs)

  // Default fence attributes derived from the job-wide block.
  const fenceProfile = asString(jobBlock.profile, 'colorbond')
  const fenceColour = asString(jobBlock.colour) || null
  const fenceFinish = asString(jobBlock.supplier) || null
  const removalEnabled = asBool(jobBlock.removal)
  const jobGatesRaw = asArray(jobBlock.gates)
  const jobGates = jobGatesRaw.map((g): FenceGate => {
    const o = asObject(g)
    return {
      type: asString(o.type, 'pedestrian'),
      width_mm: asNumber(o.width_mm ?? o.width, 0),
      height_mm: asNumber(o.height_mm ?? o.height, 0),
      hardware: asString(o.hardware) || null,
    }
  })

  const runs: FenceRun[] = scopeRuns.map((rawRun): FenceRun => {
    const r = asObject(rawRun)
    return {
      run_label: asString(r.name, 'UNNAMED'),
      type: fenceProfile,
      // scope_json.job.runs[].sheetHeight is in mm.
      height_mm: asNumber(r.sheetHeight ?? r.height_mm, 0),
      // scope_json.job.runs[].length is in metres.
      lineal_m: asNumber(r.length ?? r.lineal_m, 0),
      panels: asNumberOrNull(r.panels),
      posts: asNumberOrNull(r.posts),
      infill: fenceColour,
      finish: fenceFinish,
      // Per-run demo flag: fence-designer doesn't capture a per-run demo
      // today; fall back to the job-wide `removal` flag.
      demo: removalEnabled,
      // Job-wide gates today; per-run gate assignment is a future capture.
      gates: jobGates,
    }
  })

  // If scope_json.job.runs is empty/absent, fall back to deriving runs from
  // pricing_json.runs[]. This happens for older or partially-scoped rows.
  if (runs.length === 0 && pricingRuns.length > 0) {
    for (const rawRun of pricingRuns) {
      const r = asObject(rawRun)
      runs.push({
        run_label: asString(r.run_label ?? r.run_name, 'UNNAMED'),
        type: fenceProfile,
        height_mm: 0,
        lineal_m: 0,
        panels: null,
        posts: null,
        infill: fenceColour,
        finish: fenceFinish,
        demo: removalEnabled,
        gates: [],
      })
    }
  }

  // Boundary plan attached: scope_json.scopeMedia.drawings or
  // scope_json.scopeMedia.boundary_plans non-empty.
  const scopeMedia = asObject(scopeJson.scopeMedia)
  const boundaryPlanAttached = asArray(scopeMedia.drawings).length > 0 ||
    asArray(scopeMedia.boundary_plans).length > 0

  const scope: FenceScopeBlock = {
    kind: 'fence',
    schema_version: '2.0',
    runs,
    boundary_plan_attached: boundaryPlanAttached,
  }

  // ── Build pricing_public from pricing.runs[].items[] (canonical) ────────
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

  // ── Internal cost snapshot (uses pricing.internal scalars + top-level) ──
  const lineCosts = lineItems.map((li) => {
    const raw = findRawLineForCost(pricingJson, li.line_id)
    const unitCost = asNumber(raw.cost_price ?? raw.unit_cost, 0)
    return {
      line_id: li.line_id,
      unit_cost: unitCost,
      line_cost_total_ex: Math.round(unitCost * li.qty * 100) / 100,
      supplier_name: asString(raw.supplier_name) || asString(jobBlock.supplier) || null,
    }
  })

  const internal = asObject(pricingJson.internal)
  // pricing.internal scalars; fallback to top-level estimates.
  const materialTotal = asNumber(internal.cost ?? pricingJson.materialCostEstimate, 0)
  const labourTotal = asNumber(internal.labour ?? pricingJson.labourCostEstimate, 0)
  const commissionTotal = asNumber(internal.commission ?? pricingJson.commissionCostEstimate, 0)
  const marginPct = asNumber(internal.margin ?? pricingJson.margin_pct, 0)

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
    : `${totalLineal}m of ${fenceProfile} fencing across ${runs.length} run${runs.length === 1 ? '' : 's'}. ${baseDescription}`

  // Council status — fence-designer doesn't currently capture this in
  // scope_json.job; default 'unknown' so the validator hard-fails until
  // capture lands.
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
  // Canonical source: pricing.runs[].items[]. Each item carries
  // unit_price_ex, line_total_ex, allocation, split_pct, client_amount_ex,
  // neighbour_amount_ex — which maps directly to V2's PricingLineItem.
  // Also resolve neighbour_id at the run level so per_contact splits are
  // accurate.
  //
  // PRIMARY CONTACT INVARIANT: per_contact[].contact_id MUST be a real
  // job_contacts.id (UUID) on the happy path.
  //
  // History: an early version wrote the literal 'primary' (Codex flag #1).
  // The next version SKIPPED the client share when no primary was found
  // (Codex flag #2 — silently dropped customer liability).
  //
  // Current behaviour: when the primary contact can't be resolved AND the
  // line has a non-zero client share, write the share with the sentinel
  // UNRESOLVED_PRIMARY_CONTACT_ID and let the envelope-level validator
  // hard-fail the release via `pricing.per_contact_ids_resolved`. The
  // financial information is preserved AND the bug surfaces as a
  // structured error at send time — the sentinel can never escape into
  // a sealed quote_revisions row because the rule is non-overridable.
  const primaryContactId = findPrimaryContactId(contacts)

  const pricingRuns = asArray(pricingJson.runs)
  const items: PricingLineItem[] = []
  let lineCounter = 0
  for (const rawRun of pricingRuns) {
    const run = asObject(rawRun)
    const runLabel = asString(run.run_label ?? run.run_name, 'UNNAMED')
    const neighbourId = asString(run.neighbour_id) || null
    for (const rawItem of asArray(run.items)) {
      const li = asObject(rawItem)
      const category = (asString(li.category) || guessCategory(asString(li.description))) as LineCategory
      const qty = asNumber(li.quantity ?? li.qty, 1)
      const unitSell = asNumber(li.unit_price_ex ?? li.unit_price ?? li.sell_price, 0)
      const lineTotal = asNumber(li.line_total_ex ?? li.total_sell ?? li.total, qty * unitSell)
      const allocation = (asString(li.allocation) || 'client') as LineAllocation
      const splitPct = asNumber(li.split_pct, 100)

      const clientAmountEx = asNumber(li.client_amount_ex, lineTotal)
      const neighbourAmountEx = asNumber(li.neighbour_amount_ex, 0)

      const per_contact: PerContactSplit[] = []
      // Build the per-contact list. Order is [primary, neighbour] for
      // shared lines, [neighbour] for neighbour-only lines, [] for
      // client-only lines.
      //
      // When the primary contact is unresolved AND the line carries a
      // non-zero client share, we write the share with the sentinel id
      // rather than dropping it. The validator hard-fails any release
      // containing the sentinel.
      if (allocation === 'shared') {
        if (clientAmountEx > 0) {
          per_contact.push({
            contact_id: primaryContactId ?? UNRESOLVED_PRIMARY_CONTACT_ID,
            amount_ex: Math.round(clientAmountEx * 100) / 100,
          })
        }
        if (neighbourId) {
          per_contact.push({
            contact_id: neighbourId,
            amount_ex: Math.round(neighbourAmountEx * 100) / 100,
          })
        }
      } else if (allocation === 'neighbour') {
        if (neighbourId) {
          per_contact.push({
            contact_id: neighbourId,
            amount_ex: Math.round(neighbourAmountEx * 100) / 100,
          })
        }
      }
      // allocation === 'client' → per_contact stays empty; whole line goes
      // to the primary via per_contact_totals (which uses the same
      // sentinel rule when primary is unresolved).

      items.push({
        line_id: `fence-L-${lineCounter++}-${runLabel}`,
        category,
        description: asString(li.description),
        qty,
        unit: asString(li.unit, 'm'),
        unit_sell: unitSell,
        line_total_ex: lineTotal,
        allocation,
        split_pct: splitPct,
        per_contact,
      })
    }
  }

  // Fallback: if pricing.runs[].items[] is empty, try the top-level
  // pricing.line_items[] (older fence shape with sell_price/total_sell).
  if (items.length === 0) {
    const flat = asArray(pricingJson.line_items)
    for (let idx = 0; idx < flat.length; idx++) {
      const li = asObject(flat[idx])
      const category = (asString(li.category) || guessCategory(asString(li.description))) as LineCategory
      const qty = asNumber(li.quantity ?? li.qty, 1)
      const unitSell = asNumber(li.unit_price_ex ?? li.sell_price ?? li.unit_price, 0)
      const lineTotal = asNumber(li.line_total_ex ?? li.total_sell ?? li.total, qty * unitSell)
      items.push({
        line_id: `fence-L-flat-${idx}`,
        category,
        description: asString(li.description),
        qty,
        unit: asString(li.unit, 'm'),
        unit_sell: unitSell,
        line_total_ex: lineTotal,
        allocation: 'client',
        split_pct: 100,
        per_contact: [],
      })
    }
  }

  return items
}

function buildPerContactTotals(
  pricingJson: Record<string, unknown>,
  contacts: unknown[],
): PerContactTotal[] {
  // Per-run totals are pre-computed in pricing.runs[].totals. Aggregate
  // across runs grouped by the run's neighbour_id (if any) + the real
  // primary-contact id for the client share.
  //
  // PRIMARY CONTACT INVARIANT (same as buildFenceLineItems): contact_id
  // is a real UUID on the happy path. When the primary contact is
  // unresolved AND there is a non-zero client share to record, we use
  // the sentinel UNRESOLVED_PRIMARY_CONTACT_ID rather than drop the
  // aggregate entirely — the validator hard-blocks any release where
  // the sentinel appears.
  const totalsExByContact = new Map<string, number>()
  const primaryContactId = findPrimaryContactId(contacts)
  const primaryBucketId = primaryContactId ?? UNRESOLVED_PRIMARY_CONTACT_ID

  for (const rawRun of asArray(pricingJson.runs)) {
    const run = asObject(rawRun)
    const totals = asObject(run.totals)
    const neighbourId = asString(run.neighbour_id) || null

    const clientShareEx = asNumber(totals.client_share_ex, 0)
    const neighbourShareEx = asNumber(totals.neighbour_share_ex, 0)

    if (clientShareEx > 0) {
      totalsExByContact.set(primaryBucketId, (totalsExByContact.get(primaryBucketId) ?? 0) + clientShareEx)
    }
    if (neighbourShareEx > 0 && neighbourId) {
      totalsExByContact.set(neighbourId, (totalsExByContact.get(neighbourId) ?? 0) + neighbourShareEx)
    }
  }

  return Array.from(totalsExByContact.entries()).map(([contact_id, total_ex_gst]) => ({
    contact_id,
    total_ex_gst: Math.round(total_ex_gst * 100) / 100,
    total_inc_gst: Math.round(total_ex_gst * 1.1 * 100) / 100,
  }))
}

/**
 * Finds the primary contact's id from `supplemental.contacts`. Returns
 * null if no contact is marked `is_primary=true`.
 *
 * NEVER returns a synthetic literal like 'primary'. Callers must handle
 * null gracefully (typically by skipping the client-share entry).
 */
function findPrimaryContactId(contacts: unknown[]): string | null {
  for (const c of contacts) {
    const o = asObject(c)
    if (asBool(o.is_primary)) {
      const id = asString(o.id)
      if (id.length > 0) return id
    }
  }
  // Fallback: if no contact has `is_primary=true` but contacts[] is
  // non-empty, treat the first one as primary by convention. This matches
  // the existing job_contacts.is_primary discipline (always-set in newly-
  // created rows; legacy rows may have it null where the first row is
  // primary by ordering). Returns null only when contacts[] is empty.
  if (contacts.length > 0) {
    const id = asString(asObject(contacts[0]).id)
    if (id.length > 0) return id
  }
  return null
}

function findRawLineForCost(
  pricingJson: Record<string, unknown>,
  line_id: string,
): Record<string, unknown> {
  // Walk pricing.runs[].items[] then top-level fallback to find the line
  // matching our derived line_id. The id format is 'fence-L-<idx>-<label>'
  // for run-items and 'fence-L-flat-<idx>' for flat fallback.
  const runItemMatch = /^fence-L-(\d+)-/.exec(line_id)
  if (runItemMatch) {
    const idx = parseInt(runItemMatch[1], 10)
    let counter = 0
    for (const rawRun of asArray(pricingJson.runs)) {
      const items = asArray(asObject(rawRun).items)
      for (const it of items) {
        if (counter === idx) return asObject(it)
        counter++
      }
    }
  }
  const flatMatch = /^fence-L-flat-(\d+)$/.exec(line_id)
  if (flatMatch) {
    const idx = parseInt(flatMatch[1], 10)
    return asObject(asArray(pricingJson.line_items)[idx])
  }
  return {}
}

function guessCategory(description: string): LineCategory {
  const d = description.toLowerCase()
  if (/labour|install|labor/.test(d)) return 'labour'
  if (/demo|removal/.test(d)) return 'demo'
  if (/commission/.test(d)) return 'subcontract'
  return 'material'
}

// ── Presence audit (updated to reflect production reality) ─────────────────
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

  // Construction details (scope_json.job.runs[]).
  ;(asArray(jobBlock.runs).length > 0 ? captured : missing)
    .push('scope.runs (from scope_json.job.runs[])')
  ;(asArray(pricingJson.runs).length > 0 ? captured : partial)
    .push('pricing.runs[].items[] (per-run line items)')
  ;(asNumberOrNull(pricingJson.totalIncGST) !== null ? captured : missing).push('pricing.totals')

  ;(asString(jobBlock.profile).length > 0 ? captured : partial).push('scope.runs[].type (from job.profile)')
  ;(asString(jobBlock.colour).length > 0 ? captured : partial).push('scope.runs[].infill (from job.colour)')
  ;(asString(jobBlock.supplier).length > 0 ? captured : partial).push('scope.runs[].finish (from job.supplier)')

  // Per-contact totals from pricing.runs[].totals.
  const hasTotals = asArray(pricingJson.runs).some((r) =>
    Object.keys(asObject(asObject(r).totals)).length > 0
  )
  ;(hasTotals ? captured : partial).push('pricing.per_contact_totals (from runs[].totals)')

  // Internal cost (pricing.internal scalars).
  const internal = asObject(pricingJson.internal)
  ;(typeof internal.cost === 'number' ? captured : partial).push('internal_cost.cost (from pricing.internal.cost)')
  ;(typeof internal.margin === 'number' ? captured : partial).push('internal_cost.margin.pct (from pricing.internal.margin)')

  // Always-GAP fields for Fence today:
  ;(asString(jobBlock.council_status).length > 0 ? captured : missing).push('site.council_status')
  missing.push('site.access (chips/notes — currently ad-hoc)')
  missing.push('site.handover_instructions (jobs.notes free-form)')
  missing.push('qa.customer_facing_summary (reconstructed from description, not curated)')
  missing.push('media[].sha256 (job_media has no sha256 column today)')
  missing.push('per-contact authority {can_view, can_accept, pays} (no structured field)')
  missing.push('per-run demo flag (currently job-wide jobBlock.removal)')
  missing.push('per-run gate assignment (currently job-wide jobBlock.gates)')
  partial.push('internal_cost.line_costs[].supplier_name (per-line if present, else jobBlock.supplier)')
  partial.push('provenance.tool_version (scope_json.tool + version exist but not split)')
  partial.push('scope.runs[].posts (not currently captured per run)')

  return { captured, missing, partial }
}
