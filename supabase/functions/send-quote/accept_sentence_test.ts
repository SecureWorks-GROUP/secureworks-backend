// deno-lint-ignore-file no-explicit-any no-import-prefix
import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  ACCEPT_SENTENCE_PREFIX,
  acceptSentenceHtml,
  acceptSentenceRecord,
  readAcceptSentence,
  sealedAcceptSentence,
} from './accept_sentence.ts'

const SENTENCE = '18.6 m of Sameside in Monument, 1,800 mm high, with one 900 mm gate, as drawn on page 2.'

function fakeSb(rows: any[] | null, error: unknown = null, opts: { throws?: boolean } = {}) {
  const calls: string[] = []
  const q: any = {
    select: (c: string) => { calls.push(`select:${c}`); return q },
    eq: (c: string, v: unknown) => { calls.push(`eq:${c}=${v}`); return q },
    not: () => q,
    order: () => q,
    limit: () => opts.throws ? Promise.reject(new Error('network')) : Promise.resolve({ data: rows, error }),
  }
  return { sb: { from: (t: string) => { calls.push(`from:${t}`); return q } }, calls }
}

const released = (raw: unknown) => [{ id: 'rev-1', sent_at: '2026-11-13T01:00:00Z', pricing_snapshot_json: { raw } }]

Deno.test('sealed sentence: read as sealed, prefix optional', () => {
  assertEquals(sealedAcceptSentence({ accept_sentence: SENTENCE }), SENTENCE)
  assertEquals(sealedAcceptSentence({ accept_sentence: `  ${ACCEPT_SENTENCE_PREFIX}${SENTENCE} ` }), SENTENCE)
})

Deno.test('sealed sentence: none, or anything not a plain sentence of facts, is refused (never cleaned)', () => {
  for (const pricing of [
    null, [], 'x', {}, { accept_sentence: '' }, { accept_sentence: 42 },
    { accept_sentence: ACCEPT_SENTENCE_PREFIX },
    { accept_sentence: 'A fence, as drawn on page 2' }, // no full stop
    { accept_sentence: 'A fence for $4,000, as drawn on page 2.' }, // a price
    { accept_sentence: 'A <b>fence</b>, as drawn on page 2.' }, // markup
    { accept_sentence: 'A fence,\nas drawn on page 2.' }, // two lines
    { accept_sentence: 'A fence,\u2028as drawn on page 2.' },
    { accept_sentence: 'a'.repeat(400) + '.' }, // too long
  ]) {
    assertEquals(sealedAcceptSentence(pricing), null, JSON.stringify(pricing))
  }
})

Deno.test('read: a whole quote with a sealed sentence gives the words and the revision', async () => {
  const { sb, calls } = fakeSb(released({ totalIncGST: 9000, accept_sentence: SENTENCE }))
  const read = await readAcceptSentence(sb, { id: 'doc-1', run_label: null })
  assertEquals(read, { state: 'present', words: ACCEPT_SENTENCE_PREFIX + SENTENCE, revisionId: 'rev-1' })
  assert(calls.includes('from:quote_revisions'))
  assert(calls.includes('eq:job_document_id=doc-1'))
})

Deno.test('read: an old quote with no sentence, or no release, is none', async () => {
  assertEquals(await readAcceptSentence(fakeSb(released({ totalIncGST: 9000 })).sb, { id: 'doc-1' }), { state: 'none' })
  assertEquals(await readAcceptSentence(fakeSb([]).sb, { id: 'doc-1' }), { state: 'none' })
  assertEquals(await readAcceptSentence(fakeSb(released('not json{')).sb, { id: 'doc-1' }), { state: 'none' })
})

Deno.test('read: a fence run document is one party\'s share, so it is none and nothing is read', async () => {
  const { sb, calls } = fakeSb(released({ accept_sentence: SENTENCE }))
  assertEquals(await readAcceptSentence(sb, { id: 'doc-1', run_label: 'RHS' }), { state: 'none' })
  assertEquals(calls, [])
  assertEquals(await readAcceptSentence(sb, null), { state: 'none' })
})

Deno.test('read: a failed read is unread, never a guess', async () => {
  assertEquals(await readAcceptSentence(fakeSb(null, { message: 'boom' }).sb, { id: 'doc-1' }), { state: 'unread', reason: 'release_read_failed' })
  assertEquals(await readAcceptSentence(fakeSb(null, null, { throws: true }).sb, { id: 'doc-1' }), { state: 'unread', reason: 'release_read_failed' })
})

Deno.test('page line: shown, escaped, only when present', () => {
  const html = acceptSentenceHtml({ state: 'present', words: `${ACCEPT_SENTENCE_PREFIX}Bob's fence & gate.`, revisionId: 'r' })
  assertEquals(html, `<p class="accept-sentence" data-quote-accepting>You are accepting: Bob&#39;s fence &amp; gate.</p>`)
  assertEquals(acceptSentenceHtml({ state: 'none' }), '')
  assertEquals(acceptSentenceHtml({ state: 'unread', reason: 'release_read_failed' }), '')
  assertEquals(acceptSentenceHtml(null), '')
})

Deno.test('record: words and revision when present; nothing for an old quote; the failure when unread', () => {
  assertEquals(acceptSentenceRecord({ state: 'present', words: ACCEPT_SENTENCE_PREFIX + SENTENCE, revisionId: 'rev-1' }), {
    accepted_words: ACCEPT_SENTENCE_PREFIX + SENTENCE,
    accepted_words_revision_id: 'rev-1',
  })
  assertEquals(acceptSentenceRecord({ state: 'none' }), {})
  assertEquals(acceptSentenceRecord(null), {})
  assertEquals(acceptSentenceRecord({ state: 'unread', reason: 'release_read_failed' }), { accepted_words_unread: 'release_read_failed' })
})

// The handler wiring, pinned at source: the page and both acceptance rows use
// the same read, and buildClientPage puts the line above each Accept Quote.
Deno.test('wiring: view page and both acceptance rows carry the sealed sentence', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url))
  assert(src.includes('return await htmlResponse(buildClientPage(doc, token, heroUrl, acceptWords))'))
  assertEquals(src.match(/readAcceptSentence\(sb, \{ id: doc\.id, run_label: doc\.run_label \?\? sourceRunLabel \}\)/g)?.length, 2)
  assertEquals(src.match(/\.\.\.acceptSentenceRecord\(acceptWords\),/g)?.length, 2)
  const page = src.slice(src.indexOf('function buildClientPage('), src.indexOf('function buildRunQuotePage('))
  assertEquals(page.match(/\$\{acceptingLine\}\n\s*<button class="btn btn-accept"/g)?.length, 2)
  // Accept reads the sentence before the acceptance is written.
  assert(src.indexOf('const acceptWords = await readAcceptSentence') < src.indexOf(".update({ accepted_at: acceptedAt })"))
})
