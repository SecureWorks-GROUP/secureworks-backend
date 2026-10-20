// When a saved quote margin may not be read as profit (Sales item 7, review F1).
//
// A scoping tool can save a margin it has not verified:
//   - the v2 patio scoper saves the margin the scoper picked on the slider as
//     pricing_json.margin_pct with margin_basis 'selected_target' (a plan, not a
//     result);
//   - a tool whose commission rate is not set saves internal.commission_basis
//     'not_set', so its costs, and any margin after them, are not all known.
// Neither may become trusted profit or earned commission. A reader that would
// use margin_pct as gross profit asks marginHoldOf first and reports the job as
// held instead of using the figure or substituting a baseline. Quotes saved
// without these markers read exactly as before.

export type MarginHold = 'selected_target' | 'commission_not_set'

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function marginHoldOf(pricingJson: unknown): MarginHold | null {
  if (!isObject(pricingJson)) return null
  if (pricingJson.margin_basis === 'selected_target') return 'selected_target'
  // The v2 patio scoper, recognised by its own tool and version as the release
  // adapter does, even if a basis marker is missing.
  if (pricingJson.tool === 'patio-scoper' && pricingJson.version === '2.0') return 'selected_target'
  const internal = pricingJson.internal
  if (isObject(internal) && internal.commission_basis === 'not_set') return 'commission_not_set'
  return null
}

export const MARGIN_HOLD_REASON: Record<MarginHold, string> = {
  selected_target: 'margin is the scoper\'s selected target, not a verified margin',
  commission_not_set: 'commission rate is not set, so the margin after costs is not known',
}
