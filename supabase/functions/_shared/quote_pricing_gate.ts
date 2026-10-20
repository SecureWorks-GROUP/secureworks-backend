// Server-side quote pricing gate, shared by every quote send route:
// send-quote `/send` and `/send-runs`, and ops-api `send_quick_quote_email`.
//
// Returns the reason a quote must NOT be sent, or null when it may.
//
// Every check is strict (`=== false`, a non-empty list) so a quote that never
// carried a flag (legacy quotes, older tool copies) is judged on its total
// alone, exactly as before. Only a flag the scoping tool set refuses.
//
// The scoping tools write these flags into pricing_json (CFO pricing receipt,
// 20 Oct 2026, rule A: no quote is sent while pricing is incomplete):
// - pricing_validation_passed: false   the tool's own validation failed
// - pricing_complete: false            a sell price or a cost line is unknown
// - sell_to_confirm: [names]           sell prices still to confirm
// - internal.costs_complete: false     cost lines with no price
// - revision.sealed: false             the quote was changed after its last seal
export function quotePricingGateError(pricingJsonRaw: unknown): string | null {
  // deno-lint-ignore no-explicit-any
  let pj: any = {}
  try {
    pj = typeof pricingJsonRaw === 'string' ? JSON.parse(pricingJsonRaw || '{}') : (pricingJsonRaw || {})
  } catch {
    return 'Quote pricing is missing or invalid. Re-open the job in the scoping tool and re-save before sending.'
  }
  if (!pj || typeof pj !== 'object') {
    return 'Quote pricing is missing or invalid. Re-open the job in the scoping tool and re-save before sending.'
  }
  if (pj.pricing_validation_passed === false) {
    return 'Quote failed pricing validation in the scoping tool and cannot be sent. Fix the flagged pricing issues, re-save, and try again.'
  }
  const sellToConfirm = Array.isArray(pj.sell_to_confirm)
    ? pj.sell_to_confirm.filter((s: unknown) => typeof s === 'string' && s.trim() !== '')
    : []
  if (sellToConfirm.length) {
    return `Quote has sell prices still to confirm (${sellToConfirm.join(', ')}). Confirm them in the scoping tool, re-save, and try again.`
  }
  const internal = pj.internal && typeof pj.internal === 'object' ? pj.internal : null
  if (internal && internal.costs_complete === false) {
    const n = Array.isArray(internal.costs_to_confirm) ? internal.costs_to_confirm.length : 0
    return `Quote has ${n > 0 ? n + ' ' : ''}cost line${n === 1 ? '' : 's'} with no price yet. Price them in the scoping tool, re-save, and try again.`
  }
  if (pj.pricing_complete === false) {
    return 'Quote pricing is not complete in the scoping tool. Finish the pricing, re-save, and try again.'
  }
  const revision = pj.revision && typeof pj.revision === 'object' ? pj.revision : null
  if (revision && revision.sealed === false) {
    return 'Quote was changed after its last sealed revision. Seal the new revision in the scoping tool, re-save, and try again.'
  }
  const total = Number(pj.totalIncGST ?? pj.total ?? pj.grandTotal ?? 0)
  if (!(total > 0)) {
    return 'Quote total is zero or missing. Set pricing on the job in the scoping tool before sending.'
  }
  return null
}
