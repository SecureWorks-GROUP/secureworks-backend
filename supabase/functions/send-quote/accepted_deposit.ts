// D1F-1 (2 Nov 2026): a deposit invoice is priced from what the customer
// accepted, never from the live job.
//
// The accepted document's released quote_revisions row carries the pricing that
// was sent, frozen verbatim as pricing_snapshot_json.raw (build_minimal_manifest;
// the same source send_acceptance_invoice reads for the deposit config). Reading jobs.pricing_json
// instead meant a re-scope after sending (B) could price the deposit for a
// customer who accepted A. When the released pricing cannot be read, the
// deposit is held with a reason rather than guessed.
import { findQuoteRun, quoteRunDepositAmount } from './quote_run.ts'

export type AcceptedRelease =
  | { ok: true; pricing: Record<string, any>; revisionId: string }
  | { ok: false; reason: string }

export type DepositDecision =
  | { ok: true; amount: number; percent: number; revisionId: string }
  | { ok: false; reason: string }

type QueryResult = { data: any[] | null; error: unknown }

/** The newest released (sent) quote_revisions row for the accepted document. */
export async function readAcceptedRelease(
  sb: { from: (table: string) => any },
  documentId: string | null | undefined,
): Promise<AcceptedRelease> {
  if (!documentId) return { ok: false, reason: 'no_accepted_document' }
  let res: QueryResult
  try {
    res = await sb.from('quote_revisions')
      .select('id, pricing_snapshot_json, sent_at')
      .eq('job_document_id', documentId)
      .not('sent_at', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(1)
  } catch {
    return { ok: false, reason: 'release_read_failed' }
  }
  if (res?.error) return { ok: false, reason: 'release_read_failed' }
  const row = res?.data?.[0]
  if (!row) return { ok: false, reason: 'no_released_quote' }
  let snap = row.pricing_snapshot_json
  let pricing: any
  try {
    if (typeof snap === 'string') snap = JSON.parse(snap)
    pricing = snap?.raw
    if (typeof pricing === 'string') pricing = JSON.parse(pricing)
  } catch {
    return { ok: false, reason: 'released_pricing_unreadable' }
  }
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
    return { ok: false, reason: 'released_pricing_unreadable' }
  }
  return { ok: true, pricing, revisionId: String(row.id) }
}

function depositPercentOf(pricing: Record<string, any>): number {
  const pct = Number(pricing?.deposit?.percent)
  return Number.isFinite(pct) && pct > 0 ? pct : 50
}

/** A fence run party's deposit, from the released pricing's run totals. */
export function runDepositFromRelease(
  release: AcceptedRelease,
  runLabel: string,
  isClient: boolean,
): DepositDecision {
  if (!release.ok) return release
  const run = findQuoteRun(release.pricing, runLabel)
  if (!run) return { ok: false, reason: 'run_not_in_released_quote' }
  const share = isClient ? run?.totals?.client_share_inc : run?.totals?.neighbour_share_inc
  if (share == null || !Number.isFinite(Number(share))) return { ok: false, reason: 'run_share_not_in_released_quote' }
  const percent = depositPercentOf(release.pricing)
  return { ok: true, amount: quoteRunDepositAmount(run, isClient, percent), percent, revisionId: release.revisionId }
}

/** A named party's deposit on a whole-quote document, from the released pricing. */
export function contactDepositFromRelease(
  release: AcceptedRelease,
  contact: { quote_value_ex_gst?: unknown; share_percentage?: unknown },
): DepositDecision {
  if (!release.ok) return release
  const percent = depositPercentOf(release.pricing)
  let portionInc: number
  if (contact.quote_value_ex_gst != null && Number.isFinite(Number(contact.quote_value_ex_gst))) {
    portionInc = Number(contact.quote_value_ex_gst) * 1.10
  } else {
    const total = Number(release.pricing.totalIncGST)
    if (!Number.isFinite(total) || total <= 0) return { ok: false, reason: 'total_not_in_released_quote' }
    const sharePct = contact.share_percentage == null ? 50 : Number(contact.share_percentage)
    if (!Number.isFinite(sharePct)) return { ok: false, reason: 'share_unreadable' }
    portionInc = total * (sharePct / 100)
  }
  return { ok: true, amount: Math.round(portionInc * (percent / 100) * 100) / 100, percent, revisionId: release.revisionId }
}

/** Plain words for the office when a deposit is held. */
export function depositHeldMessage(jobNumber: string, party: string, reason: string): string {
  const why: Record<string, string> = {
    no_accepted_document: 'the acceptance names no quote document',
    release_read_failed: 'the accepted quote could not be read',
    no_released_quote: 'no sent version of the accepted quote was found',
    released_pricing_unreadable: 'the accepted quote has no readable pricing',
    run_not_in_released_quote: 'the accepted quote does not contain this fence run',
    run_share_not_in_released_quote: "the accepted quote has no share for this party",
    total_not_in_released_quote: 'the accepted quote has no total',
    share_unreadable: "this party's share could not be read",
  }
  return `${jobNumber} deposit invoice for ${party} not created: ${why[reason] || reason}. Raise it from the accepted quote by hand.`
}
