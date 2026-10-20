// The sealed margin and cost estimates, one rule shared by every adapter.
//
// Units: every scoping tool saves `pricing_json.margin_pct` as a PERCENT
// (fence 49.5 means 49.5%; the Ops Dash prints it with a % sign). The sealed
// `internal_cost.margin.pct` is a FRACTION (0.495), and the floor is 20%
// (0.2). The fence tool's `pricing.internal.margin` is a DOLLAR figure, so it
// is never read as a margin.
//
// A margin is sealed only when the costs are complete and it can be stated
// or worked out. Otherwise pct is null and floor_check says why, so the floor
// check never reads as passed (Sales, CFO note 1118-A; money-gate check of #1123).

import type { InternalCostEstimates, InternalMargin } from '../internal_cost_types.ts'
import { asNumberOrNull } from './_extract.ts'

export const MARGIN_FLOOR_FRACTION = 0.2

// Margin sources:
// - marginPercent: the tool's stated margin (a percent), used when no quoted
//   figures are given (fence, older patio).
// - quoted: the sell price ex GST and the cost it is worked against. When
//   given, pct is worked out from these sealed figures, not taken from the
//   tool (patio v2, Quick Quote).
// - targetPercent: a margin the scoper selected as a plan (patio slider). It
//   is sealed as target_pct beside pct and never decides the floor or reads
//   as profit, so a selected target never stands in for a margin nobody can
//   verify while a cost (commission included) is still to confirm.
export function sealedMargin(opts: {
  marginPercent?: unknown
  costsComplete: boolean
  quoted?: { sellEx: unknown; costEx: number | null }
  targetPercent?: unknown
}): InternalMargin {
  const target = asNumberOrNull(opts.targetPercent)
  const withTarget = (m: InternalMargin): InternalMargin =>
    target == null ? m : { ...m, target_pct: percentToFraction(target) }
  if (!opts.costsComplete) {
    return withTarget({ pct: null, floor_breached: false, floor_check: 'costs_to_confirm', override_reason: null, override_approver_user_id: null })
  }
  let pct: number | null
  if (opts.quoted) {
    const sell = asNumberOrNull(opts.quoted.sellEx)
    const cost = opts.quoted.costEx
    pct = sell != null && sell > 0 && cost != null ? Math.round(((sell - cost) / sell) * 10000) / 10000 : null
  } else {
    const percent = asNumberOrNull(opts.marginPercent)
    pct = percent == null ? null : percentToFraction(percent)
  }
  if (pct == null) {
    return withTarget({ pct: null, floor_breached: false, floor_check: 'margin_not_given', override_reason: null, override_approver_user_id: null })
  }
  return withTarget({ pct, floor_breached: pct < MARGIN_FLOOR_FRACTION, override_reason: null, override_approver_user_id: null })
}

const percentToFraction = (percent: number): number => Math.round(percent * 100) / 10000

// The Quick Quote margin, one rule for the screen's save (ops-api
// createMiscJob) and the release adapter: (sell - cost) / sell over the
// lines, as a percent to 2 dp. Known only when every line has a cost price
// above 0 and the sell is above 0; a line at 0 or with no cost is a cost to
// confirm (the screen saves 0 when no cost was typed), never a real zero.
export function quickQuoteLineMargin(lines: unknown[]): { percent: number | null; sellEx: number; costEx: number | null; unpriced: number[] } {
  let sellEx = 0
  let costEx = 0
  const unpriced: number[] = []
  lines.forEach((raw, i) => {
    const li = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const qty = asNumberOrNull(li.quantity) ?? 1
    const unitSell = asNumberOrNull(li.unit_price) ?? 0
    sellEx += asNumberOrNull(li.total) ?? qty * unitSell
    const unitCost = asNumberOrNull(li.cost_price)
    if (!unitCost) unpriced.push(i)
    else costEx += Math.round(unitCost * qty * 100) / 100
  })
  sellEx = Math.round(sellEx * 100) / 100
  costEx = Math.round(costEx * 100) / 100
  const known = unpriced.length === 0 && lines.length > 0 && sellEx > 0
  return {
    percent: known ? Math.round(((sellEx - costEx) / sellEx) * 10000) / 100 : null,
    sellEx,
    costEx: unpriced.length === 0 ? costEx : null,
    unpriced,
  }
}

// Cost estimates for adapters whose tool may leave a cost unknown (patio,
// quick quote). A cost the tool did not give is never sealed as 0: the
// estimates are sealed as not known with the missing names listed, the same
// shape the fence adapter seals for costs_complete false.
export function sealedCostEstimates(opts: {
  material: number | null
  labour: number | null
  commission: number | null
  toolSaysIncomplete: boolean
  toolToConfirm: string[]
  // The tool names an unset commission separately from its cost lines (patio
  // v2: commission_basis not_set). Then 'commission' is always on the
  // to-confirm list while it is missing, even when other lines are listed.
  nameCommission?: boolean
}): { estimates: InternalCostEstimates; complete: boolean } {
  const missing = [
    ...(opts.material == null ? ['materials'] : []),
    ...(opts.labour == null ? ['labour'] : []),
    ...(opts.commission == null ? ['commission'] : []),
  ]
  if (!opts.toolSaysIncomplete && missing.length === 0) {
    return {
      complete: true,
      estimates: {
        material_total: opts.material,
        labour_total: opts.labour,
        subcontract_commission_total: opts.commission,
      },
    }
  }
  const listed = opts.toolToConfirm.length > 0 ? opts.toolToConfirm : missing
  const toConfirm = opts.nameCommission && opts.commission == null && !listed.includes('commission')
    ? [...listed, 'commission']
    : listed
  return {
    complete: false,
    estimates: {
      material_total: null,
      labour_total: null,
      subcontract_commission_total: null,
      costs_complete: false,
      costs_to_confirm: toConfirm,
    },
  }
}
