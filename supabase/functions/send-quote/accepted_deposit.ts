// D1F-1 (2 Nov 2026): a deposit invoice is priced from what the customer
// accepted, never from the live job.
//
// The accepted document's released quote_revisions row carries the pricing that
// was sent, frozen verbatim as pricing_snapshot_json.raw (build_minimal_manifest;
// the same source send_acceptance_invoice reads for the deposit config). Reading jobs.pricing_json
// instead meant a re-scope after sending (B) could price the deposit for a
// customer who accepted A. When the released pricing cannot be read, the
// deposit is held with a reason rather than guessed.
//
// D1F-2 (3 Nov 2026): a named neighbour pays from their share of the quote they
// accepted (neighbour_splits in that release), never their live contact value.
import { findQuoteRun, quoteRunDepositAmount } from './quote_run.ts'

export type AcceptedRelease =
  | { ok: true; pricing: Record<string, any>; revisionId: string; contacts?: unknown }
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
      .select('id, pricing_snapshot_json, contacts_snapshot_json, sent_at')
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
  return { ok: true, pricing, revisionId: String(row.id), contacts: row.contacts_snapshot_json }
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

type NamedPartyDoc = {
  id: string
  job_id?: string | null
  version?: number | null
  job_contact_id?: string | null
  job_contacts?: {
    contact_label?: unknown
    source_party_key?: unknown
    quote_value_ex_gst?: unknown
    share_percentage?: unknown
  } | null
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** B, C, D...: a neighbour's letter on a shared fence (A is the owner). */
export function neighbourLetter(label: unknown): string | null {
  const l = typeof label === 'string' ? label.trim().toUpperCase() : ''
  return /^[B-Z]$/.test(l) ? l : null
}

/** A named party's deposit on a whole-quote document, from the quote they accepted. */
export async function namedPartyDeposit(
  sb: { from: (table: string) => any },
  doc: NamedPartyDoc,
): Promise<DepositDecision> {
  const contact = doc.job_contacts || {}
  const letter = neighbourLetter(contact.contact_label)
  if (!letter) return contactDepositFromRelease(await readAcceptedRelease(sb, doc.id), contact)
  const release = await readNeighbourRelease(sb, doc, letter)
  return neighbourDepositFromRelease(release, doc.job_contact_id, letter, contact.source_party_key)
}

// A neighbour's own document has no sent version: one prepare call numbers the
// owner's (A) and the neighbours' documents in letter order (A at v, B at v+1,
// C at v+2) and only the owner's send records the release. So a neighbour's
// release is the owner's whole-quote document at their version less their place.
async function readNeighbourRelease(
  sb: { from: (table: string) => any },
  doc: NamedPartyDoc,
  letter: string,
): Promise<AcceptedRelease> {
  const own = await readAcceptedRelease(sb, doc.id)
  if (own.ok || own.reason !== 'no_released_quote') return own
  const ownerVersion = Number(doc.version) - LETTERS.indexOf(letter)
  if (!doc.job_id || !Number.isInteger(ownerVersion) || ownerVersion < 1) return own
  let res: QueryResult
  try {
    res = await sb.from('job_documents')
      .select('id, job_contacts(contact_label)')
      .eq('job_id', doc.job_id)
      .eq('type', 'quote')
      .eq('version', ownerVersion)
      .is('run_label', null)
  } catch {
    return { ok: false, reason: 'release_read_failed' }
  }
  if (res?.error) return { ok: false, reason: 'release_read_failed' }
  const owners = (res?.data || []).filter((d: any) => d?.job_contacts?.contact_label === 'A')
  return owners.length === 1 ? readAcceptedRelease(sb, String(owners[0].id)) : own
}

// Their share is the entry carrying their party key (the fence tool's neighbour
// id) when their contact has one. A contact written before party keys has only
// its letter, which is their place in the shares (B the first: the fence page
// builds both lists from one neighbour list, in order) only when the release's
// own contact list names them at that letter and holds the owner plus exactly one
// contact per share. Names are never matched.
function neighbourDepositFromRelease(
  release: AcceptedRelease,
  contactId: unknown,
  letter: string,
  partyKey: unknown,
): DepositDecision {
  if (!release.ok) return release
  const shares = release.pricing?.neighbour_splits?.neighbours
  if (!Array.isArray(shares)) return { ok: false, reason: 'neighbour_share_unmatched' }
  const key = typeof partyKey === 'string' ? partyKey.trim() : ''
  let share: any
  if (key) {
    const keyed = shares.filter((s: any) => s?.id === key)
    share = keyed.length === 1 ? keyed[0] : null
  } else {
    const contacts = Array.isArray(release.contacts) ? release.contacts : []
    const labelOf = (c: any) => typeof c?.label === 'string' ? c.label.trim().toUpperCase() : ''
    const lettersAgree = contacts.map(labelOf).sort().join('') === LETTERS.slice(0, shares.length + 1)
    const named = contacts.some((c: any) => contactId != null && c?.id === contactId && labelOf(c) === letter)
    share = lettersAgree && named ? shares[LETTERS.indexOf(letter) - 1] : null
  }
  if (!share) return { ok: false, reason: 'neighbour_share_unmatched' }
  const inc = share.portion_inc_gst
  if (inc == null || !Number.isFinite(Number(inc)) || Number(inc) < 0) {
    return { ok: false, reason: 'neighbour_share_not_in_released_quote' }
  }
  const percent = depositPercentOf(release.pricing)
  return { ok: true, amount: Math.round(Number(inc) * (percent / 100) * 100) / 100, percent, revisionId: release.revisionId }
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
    neighbour_share_unmatched: "the accepted quote's shares could not be matched to this neighbour",
    neighbour_share_not_in_released_quote: "the accepted quote has no amount for this neighbour's share",
  }
  return `${jobNumber} deposit invoice for ${party} not created: ${why[reason] || reason}. Raise it from the accepted quote by hand.`
}
