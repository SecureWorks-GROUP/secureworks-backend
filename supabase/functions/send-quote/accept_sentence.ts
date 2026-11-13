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
// Only a whole-quote document carries it. A fence run document (run_label set)
// is one party's share of a design the sentence describes whole, so its page
// and acceptance stay as they are.
import { readAcceptedRelease } from './accepted_deposit.ts'

export const ACCEPT_SENTENCE_PREFIX = 'You are accepting: '
export const ACCEPT_SENTENCE_MAX_LENGTH = 400

// Control characters, line and paragraph separators: the sentence is one line.
// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F\u2028\u2029]/
// Markup, or a price: the sentence names the design's facts only (ruling 11
// item 9), so a sealed value carrying either is refused, never cleaned.
const REFUSED_CHARS = /[<>$]/

/**
 * The sealed sentence from the released pricing, without its prefix, or null
 * when there is none or it is not a plain one-line sentence of facts.
 */
export function sealedAcceptSentence(pricing: unknown): string | null {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return null
  const raw = (pricing as Record<string, unknown>).accept_sentence
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (s.startsWith(ACCEPT_SENTENCE_PREFIX)) s = s.slice(ACCEPT_SENTENCE_PREFIX.length).trim()
  if (!s || s.length > ACCEPT_SENTENCE_MAX_LENGTH) return null
  if (CONTROL_CHARS.test(s) || REFUSED_CHARS.test(s)) return null
  if (!s.endsWith('.')) return null
  return s
}

export type AcceptSentenceRead =
  | { state: 'present'; words: string; revisionId: string }
  | { state: 'none' }
  | { state: 'unread'; reason: string }

/**
 * The words the customer accepts for this document, read from its released
 * revision. 'none' covers every quote that carries no sealed sentence (old
 * quotes, run documents, unreadable old pricing); 'unread' is only a failed read.
 */
export async function readAcceptSentence(
  // deno-lint-ignore no-explicit-any
  sb: { from: (table: string) => any },
  doc: { id?: string | null; run_label?: string | null } | null | undefined,
): Promise<AcceptSentenceRead> {
  if (!doc?.id || doc.run_label != null) return { state: 'none' }
  const release = await readAcceptedRelease(sb, doc.id)
  if (!release.ok) {
    return release.reason === 'release_read_failed'
      ? { state: 'unread', reason: release.reason }
      : { state: 'none' }
  }
  const sentence = sealedAcceptSentence(release.pricing)
  if (!sentence) return { state: 'none' }
  return { state: 'present', words: ACCEPT_SENTENCE_PREFIX + sentence, revisionId: release.revisionId }
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
  if (read?.state === 'unread') return { accepted_words_unread: read.reason }
  return {}
}
