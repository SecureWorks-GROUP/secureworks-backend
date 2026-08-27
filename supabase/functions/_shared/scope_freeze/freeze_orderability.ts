// Fence-first freeze orderability validator (S4).
//
// Given a frozen scope_revisions row (and optionally the live job blobs),
// report whether the freeze carries what a materials order needs — identity,
// site, and per-line SKU / description / specification / quantity / unit /
// supplier / unit-cost-ex-GST bound to a named price snapshot — plus whether
// live autosave has drifted off the frozen hashes and by how many dollars.
//
// This is a MEASUREMENT. It never writes, never refuses freeze_scope, and
// never mints a PO. Enforcement is a later slice; the recommended seat is
// freeze_scope AFTER this report is orderable, before create_po.
//
// Live fence freezes persist sell lineal metres and kit lumps
// (pricing_json.line_items / pricing.runs[].items[]) with cost_price null.
// The supplier-pickable panel / post / concrete / fixings list is throwaway
// HTML and is not on the freeze. A dedicated materials_list (or bom) on the
// frozen pricing/scope is the future grain; when that key is present it is
// the only line source. When it is absent we fall back to the sell lines so
// today's freezes measure as not_orderable with named missing fields.
//
// Contract: freeze-orderability/v1

import { canonicalJsonAndHash } from '../release_packet/canonicalize.ts'
import { asArray, asObject } from '../release_packet/adapters/_extract.ts'

export const FREEZE_ORDERABILITY_CONTRACT_VERSION = 'freeze-orderability/v1'

export type FreezeOrderabilityVerdict = 'orderable' | 'not_orderable'

export type FreezeMissingItem = {
  field: string
  line_id?: string
}

export type FreezeIdentityPresence = {
  job_id: boolean
  family: boolean
  tool_version: boolean
  content_hash: boolean
  frozen_by: boolean
  frozen_at: boolean
}

export type FreezeSitePresence = {
  address: boolean
  suburb: boolean
}

export type FreezeMaterialsLineSource =
  | 'materials_list'
  | 'pricing_line_items'
  | 'pricing_run_items'

export type FreezeMaterialsLineReport = {
  line_id: string
  source: FreezeMaterialsLineSource
  sku: boolean
  description: boolean
  specification: boolean
  quantity: boolean
  unit: boolean
  supplier: boolean
  unit_cost_ex_gst: boolean
  price_snapshot_id: boolean
  price_snapshot_override: boolean | null
  missing: string[]
}

export type FreezeDriftReport = {
  compared: boolean
  comparison: 'matched' | 'drifted' | 'not_comparable'
  not_comparable_reasons: string[]
  scope_hash_match: boolean | null
  pricing_hash_match: boolean | null
  drifted: boolean
  frozen_cost_ex_gst: number | null
  live_cost_ex_gst: number | null
  dollar_delta: number | null
}

export type FreezeOrderabilityReport = {
  contract_version: typeof FREEZE_ORDERABILITY_CONTRACT_VERSION
  verdict: FreezeOrderabilityVerdict
  revision_id: string | null
  job_id: string | null
  family: string | null
  identity: FreezeIdentityPresence
  site: FreezeSitePresence
  lines: FreezeMaterialsLineReport[]
  missing: FreezeMissingItem[]
  drift: FreezeDriftReport
}

export type FrozenRevisionForOrderability = {
  id?: string | null
  job_id?: string | null
  tool_kind?: string | null
  tool_version?: string | null
  scope_hash?: string | null
  pricing_hash?: string | null
  frozen_at?: string | null
  frozen_by_user_id?: string | null
  scope?: unknown
  pricing?: unknown
  scope_canonical_text?: string | null
  pricing_canonical_text?: string | null
}

export type LiveJobForOrderability = {
  scope_json?: unknown
  pricing_json?: unknown
}

const CONTENT_HASH_RE = /^[0-9a-f]{64}$/

const LINE_FIELD_KEYS = [
  'sku',
  'description',
  'specification',
  'quantity',
  'unit',
  'supplier',
  'unit_cost_ex_gst',
  'price_snapshot_id',
] as const

type LineField = typeof LINE_FIELD_KEYS[number]

function asText(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim()
    return t.length > 0 ? t : null
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

function finiteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100
}

function parseJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function coerceObject(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v === 'string') return parseJsonObject(v)
  return null
}

function pickFirstText(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const t = asText(obj[key])
    if (t) return t
  }
  return null
}

function siteFromScope(scope: Record<string, unknown>): { address: string | null; suburb: string | null } {
  const job = asObject(scope.job)
  const siteDetails = asObject(scope.siteDetails ?? job.siteDetails)
  const address = pickFirstText(job, ['address', 'site_address', 'siteAddress'])
    ?? pickFirstText(scope, ['address', 'site_address', 'siteAddress'])
    ?? pickFirstText(siteDetails, ['address', 'site_address', 'siteAddress'])
  const suburb = pickFirstText(job, ['suburb', 'site_suburb', 'siteSuburb'])
    ?? pickFirstText(scope, ['suburb', 'site_suburb', 'siteSuburb'])
    ?? pickFirstText(siteDetails, ['suburb', 'site_suburb', 'siteSuburb'])
  return { address, suburb }
}

function freezeSnapshotId(
  scope: Record<string, unknown>,
  pricing: Record<string, unknown>,
): string | null {
  return pickFirstText(pricing, [
    'price_snapshot_id',
    'snapshot_id',
    'rate_snapshot_id',
    'priceSnapshotId',
    'snapshotId',
  ]) ?? pickFirstText(scope, [
    'price_snapshot_id',
    'snapshot_id',
    'rate_snapshot_id',
    'priceSnapshotId',
  ]) ?? pickFirstText(asObject(scope.job), [
    'price_snapshot_id',
    'snapshot_id',
    'rate_snapshot_id',
  ])
}

function dedicatedMaterialsList(
  scope: Record<string, unknown>,
  pricing: Record<string, unknown>,
): { present: boolean; lines: unknown[] } {
  const candidates: Array<{ present: boolean; value: unknown }> = [
    { present: Object.prototype.hasOwnProperty.call(pricing, 'materials_list'), value: pricing.materials_list },
    { present: Object.prototype.hasOwnProperty.call(pricing, 'bom'), value: pricing.bom },
    { present: Object.prototype.hasOwnProperty.call(pricing, 'materials'), value: pricing.materials },
    { present: Object.prototype.hasOwnProperty.call(scope, 'materials_list'), value: scope.materials_list },
    { present: Object.prototype.hasOwnProperty.call(scope, 'bom'), value: scope.bom },
    { present: Object.prototype.hasOwnProperty.call(scope, 'materials'), value: scope.materials },
    { present: Object.prototype.hasOwnProperty.call(asObject(scope.job), 'materials_list'), value: asObject(scope.job).materials_list },
  ]
  for (const c of candidates) {
    if (!c.present) continue
    return { present: true, lines: asArray(c.value) }
  }
  return { present: false, lines: [] }
}

function isLabourOrCommissionLine(raw: Record<string, unknown>): boolean {
  const category = (asText(raw.category) ?? '').toLowerCase()
  if (category === 'labour' || category === 'commission') return true
  const description = (asText(raw.description ?? raw.name ?? raw.label) ?? '').toLowerCase()
  const unit = (asText(raw.unit) ?? '').toLowerCase()
  if (/commission/.test(description)) return true
  if (unit === 'lot' && /labour|install/.test(description)) return true
  if (/^(installation\s+)?labour\b/.test(description)) return true
  return false
}

function collectFallbackSellLines(
  pricing: Record<string, unknown>,
): Array<{ raw: Record<string, unknown>; source: FreezeMaterialsLineSource; hintId: string }> {
  const out: Array<{ raw: Record<string, unknown>; source: FreezeMaterialsLineSource; hintId: string }> = []
  const topItems = asArray(pricing.line_items)
  topItems.forEach((item, i) => {
    const raw = asObject(item)
    if (isLabourOrCommissionLine(raw)) return
    out.push({ raw, source: 'pricing_line_items', hintId: `line_items:${i}` })
  })
  asArray(pricing.runs).forEach((run, runIndex) => {
    const runObj = asObject(run)
    const runKey = asText(runObj.run_id ?? runObj.id ?? runObj.run_label ?? runObj.run_name) ?? String(runIndex)
    asArray(runObj.items).forEach((item, i) => {
      const raw = asObject(item)
      if (isLabourOrCommissionLine(raw)) return
      out.push({ raw, source: 'pricing_run_items', hintId: `run:${runKey}:item:${i}` })
    })
  })
  return out
}

function lineIdOf(raw: Record<string, unknown>, fallback: string): string {
  return pickFirstText(raw, ['line_id', 'id', 'lineId']) ?? fallback
}

function skuOf(raw: Record<string, unknown>): string | null {
  return pickFirstText(raw, ['sku', 'merchant_code', 'merchantCode', 'product_code', 'productCode', 'code'])
}

function supplierOf(raw: Record<string, unknown>): string | null {
  return pickFirstText(raw, [
    'supplier',
    'supplier_id',
    'supplierId',
    'supplier_name',
    'supplierName',
    'merchant',
  ])
}

function specificationOf(raw: Record<string, unknown>): string | null {
  return pickFirstText(raw, ['specification', 'spec', 'specs'])
}

function quantityOf(raw: Record<string, unknown>): number | null {
  return finiteNumber(raw.quantity ?? raw.qty ?? raw.net_quantity ?? raw.netQuantity)
}

function unitOf(raw: Record<string, unknown>): string | null {
  return pickFirstText(raw, ['unit', 'uom'])
}

function unitCostOf(raw: Record<string, unknown>): number | null {
  // Sell prices (unit_price / unit_price_ex / unit_sell) are NOT unit cost.
  return finiteNumber(
    raw.unit_cost_ex_gst
    ?? raw.unitCostExGst
    ?? raw.cost_price
    ?? raw.costPrice
    ?? raw.unit_cost
    ?? raw.unitCost,
  )
}

function deliveryCostExGst(pricing: Record<string, unknown>): number | null {
  let found = false
  let total = 0
  for (const item of asArray(pricing.line_items)) {
    const raw = asObject(item)
    if ((asText(raw.category) ?? '').toLowerCase() !== 'delivery') continue
    const lineTotal = finiteNumber(raw.total_cost)
    const unitCost = unitCostOf(raw)
    const quantity = quantityOf(raw)
    const cost = lineTotal ?? (unitCost != null && quantity != null ? unitCost * quantity : null)
    if (cost == null) continue
    found = true
    total += cost
  }
  return found ? roundCents(total) : null
}

function lineSnapshotOf(raw: Record<string, unknown>): string | null {
  return pickFirstText(raw, [
    'price_snapshot_id',
    'snapshot_id',
    'rate_snapshot_id',
    'priceSnapshotId',
    'snapshotId',
  ])
}

function snapshotOverrideOf(raw: Record<string, unknown>): {
  valid: boolean
  missing: string[]
} {
  const override = asObject(raw.price_snapshot_override ?? raw.priceSnapshotOverride)
  const missing: string[] = []
  if (override.approved !== true) missing.push('price_snapshot_override.approved')
  const approvedBy = ['approved_by', 'approvedBy', 'authorised_by', 'authorisedBy']
    .some((key) => typeof override[key] === 'string' && override[key].trim().length > 0)
  if (!approvedBy) {
    missing.push('price_snapshot_override.approved_by')
  }
  if (!asText(override.reason)) missing.push('price_snapshot_override.reason')
  return { valid: missing.length === 0, missing }
}

function costExGst(pricing: Record<string, unknown> | null): number | null {
  if (!pricing) return null
  const total = finiteNumber(pricing.totalCostEstimate)
  if (total != null) return roundCents(total)
  const internal = asObject(pricing.internal)
  const iCost = finiteNumber(internal.cost)
  const iLabour = finiteNumber(internal.labour)
  const iCommission = finiteNumber(internal.commission)
  const iDelivery = finiteNumber(internal.delivery)
    ?? finiteNumber(internal.delivery_cost)
    ?? finiteNumber(internal.deliveryCost)
    ?? deliveryCostExGst(pricing)
  if (iCost != null || iLabour != null || iCommission != null || iDelivery != null) {
    return roundCents((iCost ?? 0) + (iLabour ?? 0) + (iCommission ?? 0) + (iDelivery ?? 0))
  }
  const labour = finiteNumber(pricing.labourCostEstimate)
  const materials = finiteNumber(pricing.materialCostEstimate)
  const commission = finiteNumber(pricing.commissionCostEstimate)
  const delivery = finiteNumber(pricing.deliveryCostEstimate)
    ?? finiteNumber(pricing.delivery_cost)
    ?? finiteNumber(pricing.deliveryCost)
    ?? deliveryCostExGst(pricing)
  if (labour != null || materials != null || commission != null || delivery != null) {
    return roundCents((labour ?? 0) + (materials ?? 0) + (commission ?? 0) + (delivery ?? 0))
  }
  return null
}

function reportLine(
  raw: Record<string, unknown>,
  source: FreezeMaterialsLineSource,
  fallbackId: string,
  freezeSnapshot: string | null,
): FreezeMaterialsLineReport {
  const line_id = lineIdOf(raw, fallbackId)
  const lineSnapshot = lineSnapshotOf(raw)
  const snapshotDiffers = freezeSnapshot != null && lineSnapshot != null && lineSnapshot !== freezeSnapshot
  const snapshotOverride = snapshotDiffers ? snapshotOverrideOf(raw) : null
  const snapshotBindingValid = (lineSnapshot ?? freezeSnapshot) != null &&
    (!snapshotDiffers || snapshotOverride?.valid === true)
  const fields: Record<LineField, boolean> = {
    sku: skuOf(raw) != null,
    description: pickFirstText(raw, ['description', 'name', 'label']) != null,
    specification: specificationOf(raw) != null,
    quantity: (() => {
      const q = quantityOf(raw)
      return q != null && q > 0
    })(),
    unit: unitOf(raw) != null,
    supplier: supplierOf(raw) != null,
    unit_cost_ex_gst: (() => {
      const cost = unitCostOf(raw)
      return cost != null && cost >= 0
    })(),
    price_snapshot_id: snapshotBindingValid,
  }
  const missing: string[] = LINE_FIELD_KEYS.filter((k) => !fields[k])
  if (snapshotOverride && !snapshotOverride.valid) {
    missing.push(...snapshotOverride.missing)
  }
  return {
    line_id,
    source,
    ...fields,
    price_snapshot_override: snapshotOverride?.valid ?? null,
    missing: [...missing],
  }
}

export async function inspectFreezeOrderability(input: {
  revision: FrozenRevisionForOrderability
  live?: LiveJobForOrderability | null
}): Promise<FreezeOrderabilityReport> {
  const revision = input.revision
  const scope = coerceObject(revision.scope) ?? parseJsonObject(revision.scope_canonical_text) ?? {}
  const pricing = coerceObject(revision.pricing) ?? parseJsonObject(revision.pricing_canonical_text) ?? {}

  const job_id = asText(revision.job_id)
  const family = asText(revision.tool_kind)
  const tool_version = asText(revision.tool_version)
  const content_hash = asText(revision.scope_hash)
  const frozen_by = asText(revision.frozen_by_user_id)
  const frozen_at = asText(revision.frozen_at)

  const identity: FreezeIdentityPresence = {
    job_id: job_id != null,
    family: family != null,
    tool_version: tool_version != null,
    content_hash: content_hash != null && CONTENT_HASH_RE.test(content_hash),
    frozen_by: frozen_by != null,
    frozen_at: frozen_at != null,
  }

  const siteFields = siteFromScope(scope)
  const site: FreezeSitePresence = {
    address: siteFields.address != null,
    suburb: siteFields.suburb != null,
  }

  const freezeSnapshot = freezeSnapshotId(scope, pricing)
  const dedicated = dedicatedMaterialsList(scope, pricing)
  const lines: FreezeMaterialsLineReport[] = []
  if (dedicated.present) {
    dedicated.lines.forEach((item, i) => {
      lines.push(reportLine(asObject(item), 'materials_list', `materials_list:${i}`, freezeSnapshot))
    })
  } else {
    collectFallbackSellLines(pricing).forEach((item) => {
      lines.push(reportLine(item.raw, item.source, item.hintId, freezeSnapshot))
    })
  }

  const missing: FreezeMissingItem[] = []
  const identityKeys: Array<keyof FreezeIdentityPresence> = [
    'job_id', 'family', 'tool_version', 'content_hash', 'frozen_by', 'frozen_at',
  ]
  for (const key of identityKeys) {
    if (!identity[key]) missing.push({ field: `identity.${key}` })
  }
  if (!site.address) missing.push({ field: 'site.address' })
  if (!site.suburb) missing.push({ field: 'site.suburb' })
  if (lines.length === 0) missing.push({ field: 'materials_lines' })
  for (const line of lines) {
    for (const field of line.missing) {
      missing.push({ field, line_id: line.line_id })
    }
  }

  let drift: FreezeDriftReport = {
    compared: false,
    comparison: 'not_comparable',
    not_comparable_reasons: [
      input.live === undefined ? 'live_comparison_not_requested' : 'live_job_missing',
    ],
    scope_hash_match: null,
    pricing_hash_match: null,
    drifted: false,
    frozen_cost_ex_gst: costExGst(pricing),
    live_cost_ex_gst: null,
    dollar_delta: null,
  }

  if (input.live) {
    const notComparableReasons: string[] = []
    const liveScope = coerceObject(input.live.scope_json)
    const livePricing = coerceObject(input.live.pricing_json)
    if (input.live.scope_json == null) {
      notComparableReasons.push('live_scope_missing')
    } else if (liveScope == null) {
      notComparableReasons.push('live_scope_malformed')
    }
    if (input.live.pricing_json == null) {
      notComparableReasons.push('live_pricing_missing')
    } else if (livePricing == null) {
      notComparableReasons.push('live_pricing_malformed')
    }
    const liveScopeHash = liveScope ? (await canonicalJsonAndHash(liveScope)).hash : null
    const livePricingHash = livePricing ? (await canonicalJsonAndHash(livePricing)).hash : null
    const storedScopeHash = asText(revision.scope_hash)
    const storedPricingHash = asText(revision.pricing_hash)
    if (storedScopeHash == null) notComparableReasons.push('frozen_scope_hash_missing')
    else if (!CONTENT_HASH_RE.test(storedScopeHash)) notComparableReasons.push('frozen_scope_hash_malformed')
    if (storedPricingHash == null) notComparableReasons.push('frozen_pricing_hash_missing')
    else if (!CONTENT_HASH_RE.test(storedPricingHash)) notComparableReasons.push('frozen_pricing_hash_malformed')
    const scope_hash_match = liveScope == null || liveScopeHash == null || storedScopeHash == null
      || !CONTENT_HASH_RE.test(storedScopeHash)
      ? null
      : storedScopeHash === liveScopeHash
    const pricing_hash_match = livePricing == null || livePricingHash == null || storedPricingHash == null
      || !CONTENT_HASH_RE.test(storedPricingHash)
      ? null
      : storedPricingHash === livePricingHash
    const liveCost = costExGst(livePricing)
    const frozenCost = costExGst(pricing)
    const dollar_delta = liveCost != null && frozenCost != null
      ? roundCents(liveCost - frozenCost)
      : null
    const comparison = notComparableReasons.length > 0
      ? 'not_comparable'
      : scope_hash_match === false || pricing_hash_match === false
      ? 'drifted'
      : 'matched'
    drift = {
      compared: comparison !== 'not_comparable',
      comparison,
      not_comparable_reasons: notComparableReasons,
      scope_hash_match,
      pricing_hash_match,
      drifted: comparison === 'drifted',
      frozen_cost_ex_gst: frozenCost,
      live_cost_ex_gst: liveCost,
      dollar_delta,
    }
  }

  const verdict: FreezeOrderabilityVerdict = missing.length === 0 ? 'orderable' : 'not_orderable'

  return {
    contract_version: FREEZE_ORDERABILITY_CONTRACT_VERSION,
    verdict,
    revision_id: asText(revision.id),
    job_id,
    family,
    identity,
    site,
    lines,
    missing,
    drift,
  }
}

export type FreezeOrderabilitySummary = {
  examined: number
  orderable: number
  not_orderable: number
  most_common_missing_field: string | null
  missing_field_counts: Record<string, number>
}

export function summariseFreezeOrderability(
  reports: FreezeOrderabilityReport[],
): FreezeOrderabilitySummary {
  const missing_field_counts: Record<string, number> = {}
  let orderable = 0
  for (const report of reports) {
    if (report.verdict === 'orderable') orderable += 1
    for (const item of report.missing) {
      missing_field_counts[item.field] = (missing_field_counts[item.field] ?? 0) + 1
    }
  }
  let most_common_missing_field: string | null = null
  let most = 0
  for (const [field, count] of Object.entries(missing_field_counts)) {
    if (count > most || (count === most && most_common_missing_field != null && field < most_common_missing_field)) {
      most = count
      most_common_missing_field = field
    }
  }
  return {
    examined: reports.length,
    orderable,
    not_orderable: reports.length - orderable,
    most_common_missing_field,
    missing_field_counts,
  }
}

const REVISION_COLS =
  'id, job_id, revision_number, status, tool_kind, tool_version, renderer_version, '
  + 'scope_canonical_text, scope_hash, pricing_canonical_text, pricing_hash, '
  + 'frozen_at, frozen_by_user_id'

export type InspectStoredFreezeError =
  | { code: 'revision_not_found' }
  | { code: 'db_error'; message: string }

export async function inspectStoredFreezeOrderability(
  client: any,
  input: { scope_revision_id: string },
): Promise<
  | { ok: true; report: FreezeOrderabilityReport }
  | { ok: false; error: InspectStoredFreezeError }
> {
  let revisionRow: FrozenRevisionForOrderability | null
  try {
    const { data, error } = await client.from('scope_revisions')
      .select(REVISION_COLS)
      .eq('id', input.scope_revision_id)
      .maybeSingle()
    if (error) return { ok: false, error: { code: 'db_error', message: String(error?.message ?? error) } }
    revisionRow = (data as FrozenRevisionForOrderability | null) ?? null
  } catch (e) {
    return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
  }
  if (!revisionRow) return { ok: false, error: { code: 'revision_not_found' } }

  let live: LiveJobForOrderability | null = null
  if (revisionRow.job_id) {
    try {
      const { data, error } = await client.from('jobs')
        .select('id, scope_json, pricing_json')
        .eq('id', revisionRow.job_id)
        .maybeSingle()
      if (error) return { ok: false, error: { code: 'db_error', message: String(error?.message ?? error) } }
      if (data) live = { scope_json: data.scope_json, pricing_json: data.pricing_json }
    } catch (e) {
      return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
    }
  }

  const report = await inspectFreezeOrderability({ revision: revisionRow, live })
  return { ok: true, report }
}
