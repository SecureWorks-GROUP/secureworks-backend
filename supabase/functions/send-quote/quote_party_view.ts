// Party scoping for customer quote links.
//
// A quote document belongs to exactly one party on a job: the pair
// (job_contact_id, run_label), with null meaning "no contact" / "whole job".
// The client and each neighbour are different parties, and so is a
// whole-job quote that predates a neighbour split. A customer link must only
// ever show, forward to, or accept documents of its own party.
//
// Before this module the /view page listed every live sent quote on the job
// as "options", so a neighbour saw the client's quote, the whole-job quote
// and every unretired revision, each with an Accept button carrying that
// other document's token (live on SWF-26646, SWF-26333, SWF-261276,
// SWF-26670, SWF-26760, 2026-09-24).

import { compareQuoteDocumentsNewestFirst } from '../_shared/trade_quote_pack/quote_send_publication.ts'
import {
  quoteDocumentHasClientSend,
  quoteDocumentIsSuperseded,
} from '../_shared/trade_quote_pack/pack_trade_quote.ts'

export type QuotePartyDocument = {
  id: string
  data_snapshot_json?: { run?: { run_label?: string | null } } | null
  job_contact_id?: string | null
  run_label?: string | null
  share_token?: string | null
  sent_to_client?: boolean | null
  sent_at?: string | null
  send_claimed_at?: string | null
  accepted_at?: string | null
  declined_at?: string | null
  superseded_at?: string | null
  created_at?: string | null
  version?: number | null
}

export const QUOTE_PARTY_DOCUMENT_COLUMNS = 'id, job_contact_id, run_label, sent_to_client, sent_at, send_claimed_at, accepted_at, declined_at, superseded_at, created_at, version, data_snapshot_json'

export function quoteDocumentRunLabel(doc: {
  run_label?: string | null
  data_snapshot_json?: { run?: { run_label?: string | null } } | null
}): string | null {
  const sourceLabel = doc.data_snapshot_json?.run?.run_label
  if (typeof sourceLabel === 'string') return sourceLabel
  return normaliseQuoteRunLabel(doc.run_label)
}

export type QuoteRunAcceptance = {
  job_document_id: string | null
  job_contact_id: string | null
  run_label: string | null
  status: string
  accepted_at?: string | null
}

export function quoteRunAcceptanceDecision(
  docs: QuotePartyDocument[],
  acceptances: QuoteRunAcceptance[],
  runLabel: string,
  neighbourId: string | null,
): { jobStatus: 'accepted' | 'partially_accepted' | 'quoted'; depositAcceptances: QuoteRunAcceptance[] } {
  const currentAcceptances = acceptances.filter((acceptance) =>
    currentQuoteForParty(docs, acceptance)?.id === acceptance.job_document_id
  )
  const qualifiedDocs = docs.map((document) => {
    if (quoteDocumentRunLabel(document) === null) return document
    const acceptance = currentAcceptances.find((row) => row.job_document_id === document.id)
    return {
      ...document,
      accepted_at: acceptance?.status === 'accepted' ? acceptance.accepted_at || document.accepted_at : null,
      declined_at: acceptance?.status === 'declined' ? document.declined_at || 'declined' : null,
    }
  })
  const runDocs = qualifiedDocs.filter((document) =>
    quotePartyKey(document).runLabel === normaliseQuoteRunLabel(runLabel)
  )
  const runParties = new Set(runDocs.map((document) => JSON.stringify(quotePartyKey(document))))
  const hasRequiredParties = neighbourId
    ? runParties.size >= 2 && runDocs.some((document) => document.job_contact_id === neighbourId)
    : runParties.size >= 1
  const runAccepted = hasRequiredParties && everyQuotePartyAccepted(runDocs)
  const jobAccepted = runAccepted && everyQuotePartyAccepted(qualifiedDocs, acceptances)
  const anyDecision = qualifiedDocs.some((document) =>
    isLiveSent(document) && (document.accepted_at || document.declined_at)
  )
  return {
    jobStatus: jobAccepted ? 'accepted' : anyDecision ? 'partially_accepted' : 'quoted',
    depositAcceptances: runAccepted
      ? currentAcceptances.filter((row) =>
        normaliseQuoteRunLabel(row.run_label) === normaliseQuoteRunLabel(runLabel) && row.status === 'accepted'
      )
      : [],
  }
}

export type QuotePartyKey = {
  jobContactId: string | null
  runLabel: string | null
}

function normalised(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

export function normaliseQuoteRunLabel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  return value.trim().length ? value : null
}

export function quotePartyKey(
  doc: { job_contact_id?: string | null; run_label?: string | null },
): QuotePartyKey {
  return {
    jobContactId: normalised(doc?.job_contact_id),
    runLabel: normaliseQuoteRunLabel(doc?.run_label),
  }
}

export function sameQuoteParty(
  a: { job_contact_id?: string | null; run_label?: string | null },
  b: { job_contact_id?: string | null; run_label?: string | null },
): boolean {
  const left = quotePartyKey(a)
  const right = quotePartyKey(b)
  return left.jobContactId === right.jobContactId && left.runLabel === right.runLabel
}

function isLiveSent(doc: QuotePartyDocument): boolean {
  return quoteDocumentHasClientSend(doc) && !quoteDocumentIsSuperseded(doc)
}

/**
 * The party's current document: its newest live sent document.
 */
export function currentQuoteForParty(
  docs: QuotePartyDocument[],
  party: { job_contact_id?: string | null; run_label?: string | null },
): QuotePartyDocument | null {
  const own = (docs || []).filter((d) => d && typeof d.id === 'string' && sameQuoteParty(d, party) && isLiveSent(d))
  if (!own.length) return null
  return own.sort(compareQuoteDocumentsNewestFirst)[0]
}

export type QuoteViewDecision =
  | { kind: 'forward'; current: QuotePartyDocument }
  | { kind: 'options'; documents: QuotePartyDocument[] }
  | { kind: 'single' }

/**
 * What a live sent document's link may show, given the job's live sent quote
 * documents (any party). Other parties' documents are ignored entirely.
 *
 * - A fence-run document (run_label set) is never an option: runs have one
 *   document per party. If it is not the party's current document it forwards
 *   to that party's current one.
 * - A whole-quote document (run_label null) may show same-party options
 *   (A/B alternatives sent to the same person), never another party's.
 */
export function quoteViewDecision(
  doc: QuotePartyDocument,
  jobLiveDocs: QuotePartyDocument[],
): QuoteViewDecision {
  const partyDocs = [doc, ...(jobLiveDocs || []).filter((d) => d && d.id !== doc.id)]
    .filter((d) => sameQuoteParty(d, doc) && isLiveSent(d))
  if (quoteDocumentRunLabel(doc) !== null) {
    const current = currentQuoteForParty(partyDocs, doc)
    if (current && current.id !== doc.id) return { kind: 'forward', current }
    return { kind: 'single' }
  }
  if (partyDocs.length > 1) {
    const [self, ...rest] = partyDocs
    return { kind: 'options', documents: [self, ...rest] }
  }
  return { kind: 'single' }
}

/**
 * Whether a document may be accepted: it must be live, and a fence-run
 * document must be its party's current document (older duplicates of the
 * same run for the same person are not separately acceptable).
 */
export function quoteDocumentAcceptable(
  doc: QuotePartyDocument,
  jobLiveDocs: QuotePartyDocument[],
): boolean {
  if (quoteDocumentIsSuperseded(doc)) return false
  if (quoteDocumentRunLabel(doc) === null) {
    return !(jobLiveDocs || []).some((other) =>
      other.id !== doc.id && sameQuoteParty(other, doc) && isLiveSent(other) && !!other.accepted_at
    )
  }
  const current = currentQuoteForParty([doc, ...(jobLiveDocs || [])], doc)
  return !current || current.id === doc.id
}

export function everyQuotePartyAccepted(
  docs: QuotePartyDocument[],
  requiredParties: Array<{ job_contact_id?: string | null; run_label?: string | null }> = [],
): boolean {
  const byParty = new Map<string, QuotePartyDocument[]>()
  for (const party of requiredParties) {
    byParty.set(JSON.stringify(quotePartyKey(party)), [])
  }
  for (const d of docs || []) {
    if (quoteDocumentIsSuperseded(d)) continue
    const party = JSON.stringify(quotePartyKey(d))
    const partyDocs = byParty.get(party) || []
    partyDocs.push(d)
    byParty.set(party, partyDocs)
  }
  if (byParty.size === 0) return false
  for (const partyDocs of byParty.values()) {
    if (!partyDocs.length) return false
    if (partyDocs.some((document) => quoteDocumentRunLabel(document) !== null)) {
      const current = currentQuoteForParty(partyDocs, partyDocs[0])
      if (!current?.accepted_at) return false
    } else if (!partyDocs.some((d) => isLiveSent(d) && d.accepted_at)) {
      return false
    }
  }
  return true
}

export function quoteViewRetryPage(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Quote temporarily unavailable</title></head><body><main><h1>We could not load this quote right now.</h1><p>Please try again shortly.</p></main></body></html>`
}

export function otherPartyRunDocumentIdsToRetire(
  keep: Array<{ id: string; job_contact_id?: string | null; run_label?: string | null }>,
  jobDocs: QuotePartyDocument[],
): string[] {
  const keepIds = new Set((keep || []).map((d) => d.id))
  const keptParties = new Map<string, { party: { job_contact_id?: string | null; run_label?: string | null } }>()
  for (const kept of keep || []) {
    if (quotePartyKey(kept).runLabel === null) continue
    keptParties.set(JSON.stringify(quotePartyKey(kept)), { party: kept })
  }
  const out = new Set<string>()
  for (const { party } of keptParties.values()) {
    const livePartyDocs = (jobDocs || []).filter((d) =>
      d && sameQuoteParty(d, party) && isLiveSent(d)
    )
    const newest = currentQuoteForParty(livePartyDocs, party)
    if (!newest || !keepIds.has(newest.id)) continue
    for (const d of livePartyDocs) {
      if (d.id !== newest.id) out.add(d.id)
    }
  }
  return [...out].sort()
}

/**
 * Name to greet a link's reader by: the party's own contact name, never the
 * job client's name on a neighbour's link.
 */
export function quotePartyGreetingName(doc: {
  job_contact_id?: string | null
  job_contacts?: { client_name?: string | null } | null
  jobs?: { client_name?: string | null } | null
}): string {
  if (normalised(doc?.job_contact_id)) return normalised(doc?.job_contacts?.client_name) ?? ''
  return normalised(doc?.jobs?.client_name) ?? ''
}

/**
 * /send retires the same party's earlier published versions by default. One
 * /send call publishes one document, so an older live document for the same
 * (job_contact_id, run_label) is a superseded revision, not an option. A
 * caller that genuinely sends separate A/B options one call at a time must
 * pass supersede_prior:false explicitly.
 */
export function sendRetiresPriorPartyQuotes(supersedePrior: unknown): boolean {
  return supersedePrior !== false
}

// deno-lint-ignore no-explicit-any
type QuotePartyClient = { from: (table: string) => any }

/**
 * After a successful send-runs, retire every other live published run
 * document of each kept party (same job, job_contact_id and run_label).
 * `keepIds` must be only documents that are published now: this request's
 * successfully emailed documents plus reused already-published ones, so a
 * failed new email never retires the party's last live quote.
 */
export async function retireOtherPublishedPartyRunDocuments(
  sb: QuotePartyClient,
  input: { jobId: string; keepIds: string[]; now?: Date },
): Promise<{ ok: true; retiredIds: string[] } | { ok: false; error: string }> {
  const keepIds = [...new Set((input.keepIds || []).filter((id) => typeof id === 'string' && id))]
  if (!keepIds.length) return { ok: true, retiredIds: [] }
  const { data, error } = await sb.from('job_documents')
    .select(QUOTE_PARTY_DOCUMENT_COLUMNS)
    .eq('job_id', input.jobId)
    .eq('type', 'quote')
    .is('superseded_at', null)
  if (error) return { ok: false, error: String(error?.message || error) }
  const rows: QuotePartyDocument[] = Array.isArray(data) ? data : []
  const keep = rows.filter((row) => keepIds.includes(row.id))
  const ids = otherPartyRunDocumentIdsToRetire(keep, rows)
  if (!ids.length) return { ok: true, retiredIds: [] }
  const { data: updated, error: updateError } = await sb.from('job_documents')
    .update({ superseded_at: (input.now || new Date()).toISOString() })
    .in('id', ids)
    .is('superseded_at', null)
    .select('id')
  if (updateError) return { ok: false, error: String(updateError?.message || updateError) }
  const retiredIds = (Array.isArray(updated) ? updated : [])
    .map((row: { id?: string | null }) => row?.id)
    .filter((id: unknown): id is string => typeof id === 'string')
  return { ok: true, retiredIds }
}
