// B1 follow-on (3 Nov 2026): on acceptance the job carries the price the customer accepted.
//
// jobs.pricing_json (and the generated jobs.quoted_value) is whatever a tool last saved. Before this, acceptance
// wrote only the job's status, so a job could hold another quote's price after the customer accepted: an option
// not chosen, a revision saved after the send, or a re-scope (SWF-261620: Q-0889 accepted, the job later read v1's
// figure). The accepted document's released quote_revisions row keeps the pricing that send used, verbatim
// (pricing_snapshot_json.raw, readAcceptedRelease); send-quote records one on every send since #1271. That is the
// accepted quote's own price, so the job is set to it when it differs.
//
// Only a whole quote's acceptance, and only on a job with one quote party: a run (neighbour) acceptance prices a
// share and a per-party quote's total is the whole job's, so neither is the job's price on its own. With no
// released row (a quote sent before #1271), nothing is written and the reason is returned. Never throws.
import { readAcceptedRelease } from './accepted_deposit.ts'

export type AcceptedJobPrice =
  | { updated: true; revisionId: string; pricing: Record<string, unknown> }
  | { updated: false; reason: string }

/** The same JSON value, whatever its key order. */
export function samePricing(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (typeof v === 'string') { try { return norm(JSON.parse(v)) } catch { return v } }
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>).sort().reduce((o, k) => {
        o[k] = norm((v as Record<string, unknown>)[k]); return o
      }, {} as Record<string, unknown>)
    }
    return v ?? null
  }
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

export async function setJobPriceToAcceptedQuote(
  sb: { from: (table: string) => any },
  // `pricing` (ruling 14): the released pricing with the customer's ticked options
  // applied (quote_options.ts acceptedPricing). Written only when the accepted
  // document has a released row, exactly as the plain released pricing is.
  input: { job_id: string; document_id: string; job_pricing: unknown; pricing?: Record<string, unknown> },
): Promise<AcceptedJobPrice> {
  try {
    const release = await readAcceptedRelease(sb, input.document_id)
    if (!release.ok) return { updated: false, reason: release.reason }
    const accepted = input.pricing ?? release.pricing
    if (samePricing(accepted, input.job_pricing)) return { updated: false, reason: 'already_the_accepted_price' }
    const { error } = await sb.from('jobs').update({ pricing_json: accepted }).eq('id', input.job_id)
    if (error) return { updated: false, reason: 'job_price_write_failed' }
    return { updated: true, revisionId: release.revisionId, pricing: accepted }
  } catch {
    return { updated: false, reason: 'job_price_write_failed' }
  }
}
