// Ruling 14 step 1: the reads and the one write behind quote options.
//
// The offer is read from the RELEASED revision of the document (the pricing
// that was sent, pricing_snapshot_json.raw), never from the live job.
// The acceptance record lives in quote_option_acceptances
// (20261113150000_quote_option_acceptances.sql): one row per accepted
// document, written once and never changed.
import { readAcceptedRelease } from './accepted_deposit.ts'
import { readQuoteOptions, type OptionAcceptanceRecord, type QuoteOptionsOffer } from './quote_options.ts'

// deno-lint-ignore no-explicit-any
type Sb = { from: (table: string) => any }

export type DocumentOptions =
  | { kind: 'none' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'invalid'; reason: string }
  | {
    kind: 'offer'
    offer: QuoteOptionsOffer
    pricing: Record<string, unknown>
    revisionId: string
    /** More than one quote party on the job: options are the client's alone and step 1 offers them online only on a one-party job. */
    shared: boolean
  }

/**
 * The options on a whole-quote document. A fence-run document (runLabel not
 * null) never carries tick boxes: options are the client's only and never
 * split with a neighbour (contract section 6).
 */
export async function loadDocumentOptions(
  sb: Sb,
  doc: { id: string; job_id?: string | null },
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
  }
}

export type RecordWrite = { ok: true } | { ok: false; reason: string }

export async function writeOptionAcceptance(sb: Sb, record: OptionAcceptanceRecord): Promise<RecordWrite> {
  try {
    const { error } = await sb.from('quote_option_acceptances').insert(record)
    if (error) return { ok: false, reason: String(error?.code || error?.message || 'insert_failed') }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message || 'insert_failed' }
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
