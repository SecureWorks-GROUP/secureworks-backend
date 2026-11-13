// Ruling 14 step 1: the reads and the one write behind quote options.
//
// The offer is read from the RELEASED revision of the document (the pricing
// that was sent, pricing_snapshot_json.raw), never from the live job.
// The acceptance record lives in quote_option_acceptances
// (20261113150000_quote_option_acceptances.sql): one row per accepted
// document, written once and never changed, in the SAME transaction that
// marks the document accepted (accept_quote_document_with_options). A failed
// write leaves the document unaccepted, so the customer's retry completes the
// same selection; there is never an accepted document without its record.
import { neighbourLetter, readAcceptedRelease } from './accepted_deposit.ts'
import { readQuoteOptions, type OptionAcceptanceRecord, type QuoteOptionsOffer } from './quote_options.ts'

// deno-lint-ignore no-explicit-any
type Sb = { from: (table: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => any }

export type DocumentOptions =
  | { kind: 'none' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'invalid'; reason: string }
  | {
    kind: 'offer'
    offer: QuoteOptionsOffer
    pricing: Record<string, unknown>
    revisionId: string
    /** More than one quote party on the job (a shared fence). Options are the client's alone. */
    shared: boolean
    /** This document is a neighbour's (B, C...): it offers no tick boxes. */
    neighbour: boolean
  }

/**
 * The options on a whole-quote document. A fence-run document (runLabel not
 * null) never carries tick boxes: options are the client's only and never
 * split with a neighbour (contract section 6).
 */
export async function loadDocumentOptions(
  sb: Sb,
  doc: { id: string; job_id?: string | null; job_contacts?: { contact_label?: unknown } | null },
  runLabel: string | null,
): Promise<DocumentOptions> {
  if (!doc.job_id || runLabel !== null) return { kind: 'none' }
  const release = await readAcceptedRelease(sb, doc.id)
  if (!release.ok) {
    return release.reason === 'release_read_failed'
      ? { kind: 'unreadable', reason: release.reason }
      : { kind: 'none' }
  }
  const read = readQuoteOptions(release.pricing)
  if (read.kind !== 'offer') return read
  let parties: { data: unknown[] | null; error: unknown }
  try {
    parties = await sb.from('job_contacts').select('id').eq('job_id', doc.job_id)
  } catch {
    return { kind: 'unreadable', reason: 'parties_read_failed' }
  }
  if (parties?.error) return { kind: 'unreadable', reason: 'parties_read_failed' }
  return {
    kind: 'offer',
    offer: read.offer,
    pricing: release.pricing,
    revisionId: release.revisionId,
    shared: (parties?.data?.length ?? 0) > 1,
    neighbour: neighbourLetter(doc.job_contacts?.contact_label) !== null,
  }
}

export type OptionAcceptance =
  | { ok: true; claimed: true }
  | { ok: true; claimed: false }
  | { ok: false; reason: string }

/**
 * Marks the document accepted and writes its option record in one database
 * transaction. claimed false: someone else accepted it first (nothing written).
 * ok false: nothing written at all (the migration not applied included), so
 * the acceptance is NOT made and the customer retries the same selection.
 */
export async function acceptDocumentWithOptions(
  sb: Sb,
  documentId: string,
  acceptedAt: string,
  record: OptionAcceptanceRecord,
): Promise<OptionAcceptance> {
  try {
    if (typeof sb.rpc !== 'function') return { ok: false, reason: 'rpc_unavailable' }
    const { data, error } = await sb.rpc('accept_quote_document_with_options', {
      p_document_id: documentId,
      p_accepted_at: acceptedAt,
      p_record: record,
    })
    if (error) return { ok: false, reason: String(error?.code || error?.message || 'accept_failed') }
    if (data?.claimed === true) return { ok: true, claimed: true }
    if (data?.claimed === false) return { ok: true, claimed: false }
    return { ok: false, reason: 'accept_answer_unreadable' }
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message || 'accept_failed' }
  }
}

export type OptionAcceptanceRow = OptionAcceptanceRecord & { created_at?: string }

/**
 * The records for these documents, keyed by document id. `null` when the read
 * failed (unknown is never "no options").
 */
export async function readOptionAcceptances(
  sb: Sb,
  documentIds: string[],
): Promise<Map<string, OptionAcceptanceRow> | null> {
  const out = new Map<string, OptionAcceptanceRow>()
  if (documentIds.length === 0) return out
  try {
    const { data, error } = await sb.from('quote_option_acceptances')
      .select('job_id, job_document_id, quote_revision_id, accepted_via, accepted_by, offered, taken_option_ids, base_total_inc_gst, accepted_total_ex_gst, accepted_gst, accepted_total_inc_gst, accepted_deposit_inc_gst, created_at')
      .in('job_document_id', documentIds)
    if (error) return null
    for (const row of (data || []) as OptionAcceptanceRow[]) out.set(row.job_document_id, row)
    return out
  } catch {
    return null
  }
}

/** Offered options with their fate, for the job's record: taken, or "offered, not taken" (struck through). */
export function optionFates(row: Pick<OptionAcceptanceRow, 'offered' | 'taken_option_ids'>): Array<{
  id: string
  name: string
  sell_inc_gst: number
  taken: boolean
  label: string
}> {
  const taken = new Set(row.taken_option_ids || [])
  return (row.offered || []).map((o) => ({
    id: o.id,
    name: o.name,
    sell_inc_gst: o.sell_inc_gst,
    taken: taken.has(o.id),
    label: taken.has(o.id) ? 'taken' : 'offered, not taken',
  }))
}
