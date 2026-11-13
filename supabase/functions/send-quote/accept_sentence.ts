// Director's ruling 11, amendment 3 item 8 (13 Nov 2026): the quote names what
// the customer is accepting, in words built from the sealed design, never typed,
// for example "You are accepting: 18.6 m of Sameside in Monument, 1,800 mm high,
// with one 900 mm gate, as drawn on page 2."
//
// The Scope Engine builds the sentence (SWQuoteLayout.acceptSentence) and seals
// it into the released quote's pricing as `accept_sentence`. This module only
// reads it from the released revision of the document the customer opened
// (readAcceptedRelease, the same row the deposit is priced from), shows it beside
// the Accept Quote button, and keeps it with the acceptance. It never composes,
// edits or guesses a sentence: no sealed sentence, nothing is shown or recorded,
// and the quote accepts exactly as before.
//
// A fence run document (run_label set) reads the same released revision. Its
// words are the run's own sealed sentence (`runs[].accept_sentence`, the shared
// party copy's), else, for the client's own run document only, the whole
// quote's sentence. A neighbour is never shown the whole design as theirs: with
// no run sentence sealed, nothing is shown and the record says so.
import { readAcceptedRelease } from './accepted_deposit.ts'
import { findQuoteRun } from './quote_run.ts'

export const ACCEPT_SENTENCE_PREFIX = 'You are accepting: '
// The tool's sentence has one part per length, colour and height group and no
// cap of its own (nine groups measured at 445 characters). This bound is far
// above any real design; a longer value is refused by name, never cut short.
export const ACCEPT_SENTENCE_MAX_LENGTH = 4000

// Control characters, line and paragraph separators: the sentence is one line.
// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F\u2028\u2029]/
// Markup, or a price: the sentence names the design's facts only (ruling 11
// item 9), so a sealed value carrying either is refused, never cleaned.
const REFUSED_CHARS = /[<>$]/

export type SealedSentence =
  | { state: 'absent' }
  | { state: 'ok'; sentence: string }
  | { state: 'refused'; reason: string }

/** A sealed value: absent (an old quote), a plain one-line sentence of facts, or refused by name. */
export function checkSealedSentence(raw: unknown): SealedSentence {
  if (raw === undefined || raw === null) return { state: 'absent' }
  if (typeof raw !== 'string') return { state: 'refused', reason: 'accept_sentence_not_text' }
  let s = raw.trim()
  if (s.startsWith(ACCEPT_SENTENCE_PREFIX)) s = s.slice(ACCEPT_SENTENCE_PREFIX.length).trim()
  if (!s) return { state: 'refused', reason: 'accept_sentence_empty' }
  if (s.length > ACCEPT_SENTENCE_MAX_LENGTH) return { state: 'refused', reason: 'accept_sentence_too_long' }
  if (CONTROL_CHARS.test(s)) return { state: 'refused', reason: 'accept_sentence_not_one_line' }
  if (REFUSED_CHARS.test(s)) return { state: 'refused', reason: 'accept_sentence_markup_or_price' }
  if (!s.endsWith('.')) return { state: 'refused', reason: 'accept_sentence_not_a_sentence' }
  return { state: 'ok', sentence: s }
}

/**
 * The sealed whole-quote sentence from the released pricing, without its
 * prefix, or null when there is none or it is refused.
 */
export function sealedAcceptSentence(pricing: unknown): string | null {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return null
  const c = checkSealedSentence((pricing as Record<string, unknown>).accept_sentence)
  return c.state === 'ok' ? c.sentence : null
}

export type AcceptSentenceRead =
  | { state: 'present'; words: string; revisionId: string }
  | { state: 'none' }
  /** A sealed value was there but cannot be shown; recorded, never treated as an old quote. */
  | { state: 'refused'; reason: string; revisionId: string }
  | { state: 'unread'; reason: string }

/**
 * The words the customer accepts for this document, read from its released
 * revision. 'none' is only a quote that sealed no sentence (old quotes); a
 * sealed value that cannot be shown is 'refused'; 'unread' is a failed read.
 */
export async function readAcceptSentence(
  // deno-lint-ignore no-explicit-any
  sb: { from: (table: string) => any },
  doc: { id?: string | null; run_label?: string | null; job_contact_id?: string | null } | null | undefined,
): Promise<AcceptSentenceRead> {
  if (!doc?.id) return { state: 'none' }
  const release = await readAcceptedRelease(sb, doc.id)
  if (!release.ok) {
    return release.reason === 'release_read_failed'
      ? { state: 'unread', reason: release.reason }
      : { state: 'none' }
  }
  const pricing = release.pricing as Record<string, unknown>
  const whole = checkSealedSentence(pricing.accept_sentence)
  let chosen = whole
  if (doc.run_label != null) {
    const run = findQuoteRun(pricing, doc.run_label)
    const own = checkSealedSentence(run && typeof run === 'object' ? run.accept_sentence : undefined)
    if (own.state !== 'absent') {
      chosen = own
    } else if (whole.state === 'absent') {
      return { state: 'none' }
    } else {
      // Only the client's own run document may carry the whole quote's words.
      const party = await runDocumentParty(sb, doc.job_contact_id ?? null)
      if (party === 'unread') return { state: 'unread', reason: 'run_party_read_failed' }
      if (party === 'neighbour') return { state: 'refused', reason: 'run_sentence_not_sealed', revisionId: release.revisionId }
    }
  }
  if (chosen.state === 'absent') return { state: 'none' }
  if (chosen.state === 'refused') return { state: 'refused', reason: chosen.reason, revisionId: release.revisionId }
  return { state: 'present', words: ACCEPT_SENTENCE_PREFIX + chosen.sentence, revisionId: release.revisionId }
}

/** A run document's party: no contact, or the primary contact, is the client. */
async function runDocumentParty(
  // deno-lint-ignore no-explicit-any
  sb: { from: (table: string) => any },
  contactId: string | null,
): Promise<'client' | 'neighbour' | 'unread'> {
  if (!contactId) return 'client'
  try {
    const res = await sb.from('job_contacts').select('id, is_primary').eq('id', contactId).limit(1)
    if (res?.error || !Array.isArray(res?.data) || res.data.length !== 1) return 'unread'
    return res.data[0].is_primary === true ? 'client' : 'neighbour'
  } catch {
    return 'unread'
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** The line shown above an Accept Quote button; empty when there is no sentence. */
export function acceptSentenceHtml(read: AcceptSentenceRead | null | undefined): string {
  if (read?.state !== 'present') return ''
  return `<p class="accept-sentence" data-quote-accepting>${escapeHtml(read.words)}</p>`
}

/**
 * Keys added to the acceptance record (business_events quote.accepted payload
 * and the quote_accepted job event). No sentence adds nothing, so an old
 * quote's record is unchanged.
 */
export function acceptSentenceRecord(read: AcceptSentenceRead | null | undefined): Record<string, string> {
  if (read?.state === 'present') {
    return { accepted_words: read.words, accepted_words_revision_id: read.revisionId }
  }
  if (read?.state === 'refused') {
    return { accepted_words_refused: read.reason, accepted_words_revision_id: read.revisionId }
  }
  if (read?.state === 'unread') return { accepted_words_unread: read.reason }
  return {}
}
