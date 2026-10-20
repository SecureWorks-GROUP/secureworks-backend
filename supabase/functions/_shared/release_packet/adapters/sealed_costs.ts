// The sealed margin and cost estimates, one rule shared by every adapter.
//
// Units: every scoping tool saves `pricing_json.margin_pct` as a PERCENT
// (fence 49.5 means 49.5%; the Ops Dash prints it with a % sign). The sealed
// `internal_cost.margin.pct` is a FRACTION (0.495), and the floor is 20%
// (0.2). The fence tool's `pricing.internal.margin` is a DOLLAR figure, so it
// is never read as a margin.
//
// A margin is sealed only when the costs are complete and the tool stated
// one. Otherwise pct is null and floor_check says why, so the floor check
// never reads as passed (Sales, CFO note 1118-A; money-gate check of #1123).

import type { InternalCostEstimates, InternalMargin } from '../internal_cost_types.ts'
import { asNumberOrNull } from './_extract.ts'

export const MARGIN_FLOOR_FRACTION = 0.2

export function sealedMargin(opts: { marginPercent: unknown; costsComplete: boolean }): InternalMargin {
  if (!opts.costsComplete) {
    return { pct: null, floor_breached: false, floor_check: 'costs_to_confirm', override_reason: null, override_approver_user_id: null }
  }
  const percent = asNumberOrNull(opts.marginPercent)
  if (percent == null) {
    return { pct: null, floor_breached: false, floor_check: 'margin_not_given', override_reason: null, override_approver_user_id: null }
  }
  const pct = Math.round(percent * 100) / 10000
  return { pct, floor_breached: pct < MARGIN_FLOOR_FRACTION, override_reason: null, override_approver_user_id: null }
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
  const toConfirm = opts.toolToConfirm.length > 0 ? opts.toolToConfirm : missing
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
