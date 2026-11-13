// deno-lint-ignore-file no-explicit-any no-import-prefix
import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  ACCEPT_SENTENCE_MAX_LENGTH,
  ACCEPT_SENTENCE_PREFIX,
  acceptSentenceHtml,
  checkSealedSentence,
  acceptSentenceRecord,
  readAcceptSentence,
  sealedAcceptSentence,
} from './accept_sentence.ts'

const SENTENCE = '18.6 m of Sameside in Monument, 1,800 mm high, with one 900 mm gate, as drawn on page 2.'

function fakeSb(rows: any[] | null, error: unknown = null, opts: { throws?: boolean; contacts?: any[] | null } = {}) {
  const calls: string[] = []
  const table = (t: string) => {
    const q: any = {
      select: (c: string) => { calls.push(`select:${c}`); return q },
      eq: (c: string, v: unknown) => { calls.push(`eq:${c}=${v}`); return q },
      not: () => q,
      order: () => q,
      limit: () => {
        if (t === 'job_contacts') {
          return opts.contacts === null
            ? Promise.resolve({ data: null, error: { message: 'boom' } })
            : Promise.resolve({ data: opts.contacts ?? [], error: null })
        }
        return opts.throws ? Promise.reject(new Error('network')) : Promise.resolve({ data: rows, error })
      },
    }
    return q
  }
  return { sb: { from: (t: string) => { calls.push(`from:${t}`); return table(t) } }, calls }
}

// The tool's real output for a fence with nine length, colour and height groups
// (scope-engine-v2 SWQuoteLayout.acceptSentence): 445 characters, no price.
const PRODUCER_LONG = '12.0 m of Trimclad in Monument, 1,500 mm high, 12.0 m of Trimclad in Monument, 1,550 mm high, ' +
  '12.0 m of Trimclad in Monument, 1,600 mm high, 12.0 m of Trimclad in Monument, 1,650 mm high, ' +
  '12.0 m of Trimclad in Monument, 1,700 mm high, 12.0 m of Trimclad in Monument, 1,750 mm high, ' +
  '12.0 m of Trimclad in Monument, 1,800 mm high, 12.0 m of Trimclad in Monument, 1,850 mm high and ' +
  '12.0 m of Trimclad in Monument, 1,900 mm high, as drawn on page 2.'

function producerSentence(groups: number): string {
  const parts = Array.from({ length: groups }, (_, i) => `12.0 m of Trimclad in Monument, ${(1500 + i * 50).toLocaleString('en-AU')} mm high`)
  const and = parts.length <= 1 ? parts.join('') : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]
  return and + ', as drawn on page 2.'
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
    { accept_sentence: 'a'.repeat(ACCEPT_SENTENCE_MAX_LENGTH) + '.' }, // past the bound
  ]) {
    assertEquals(sealedAcceptSentence(pricing), null, JSON.stringify(pricing))
  }
})

Deno.test('sealed sentence: the tool\'s real long output is read whole, never cut', () => {
  assertEquals(PRODUCER_LONG.length, 445)
  assertEquals(PRODUCER_LONG, producerSentence(9))
  assertEquals(sealedAcceptSentence({ accept_sentence: PRODUCER_LONG }), PRODUCER_LONG)
  // Far past any real design: 40 groups is still read whole.
  const forty = producerSentence(40)
  assert(forty.length > 1800)
  assertEquals(sealedAcceptSentence({ accept_sentence: forty }), forty)
})

Deno.test('sealed sentence: a present value that cannot be shown is refused by name, not taken as an old quote', () => {
  assertEquals(checkSealedSentence(undefined), { state: 'absent' })
  assertEquals(checkSealedSentence(null), { state: 'absent' })
  assertEquals(checkSealedSentence(42), { state: 'refused', reason: 'accept_sentence_not_text' })
  assertEquals(checkSealedSentence('  '), { state: 'refused', reason: 'accept_sentence_empty' })
  assertEquals(checkSealedSentence('a'.repeat(ACCEPT_SENTENCE_MAX_LENGTH) + '.'), { state: 'refused', reason: 'accept_sentence_too_long' })
  assertEquals(checkSealedSentence('A $5 fence.'), { state: 'refused', reason: 'accept_sentence_markup_or_price' })
})

Deno.test('long producer sentence: through the read, the page line and the acceptance record whole', async () => {
  const read = await readAcceptSentence(fakeSb(released({ accept_sentence: PRODUCER_LONG })).sb, { id: 'doc-1' })
  assertEquals(read, { state: 'present', words: ACCEPT_SENTENCE_PREFIX + PRODUCER_LONG, revisionId: 'rev-1' })
  assert(acceptSentenceHtml(read).includes(PRODUCER_LONG))
  assertEquals(acceptSentenceRecord(read).accepted_words, ACCEPT_SENTENCE_PREFIX + PRODUCER_LONG)
})

Deno.test('read: a sealed value that is refused is recorded with its revision, not dropped', async () => {
  const read = await readAcceptSentence(fakeSb(released({ accept_sentence: 'A <b>fence</b>.' })).sb, { id: 'doc-1' })
  assertEquals(read, { state: 'refused', reason: 'accept_sentence_markup_or_price', revisionId: 'rev-1' })
  assertEquals(acceptSentenceHtml(read), '')
  assertEquals(acceptSentenceRecord(read), { accepted_words_refused: 'accept_sentence_markup_or_price', accepted_words_revision_id: 'rev-1' })
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

const RUN_SENTENCE = '12.0 m of Trimclad in Monument, 1,800 mm high, along the right side, as drawn on page 2.'
const runPricing = (run: Record<string, unknown> = {}) => ({
  accept_sentence: SENTENCE,
  runs: [{ run_label: 'RHS', totals: {}, ...run }, { run_label: 'LHS', totals: {} }],
})

Deno.test('run document: its own sealed run sentence, from the released revision, for client and neighbour', async () => {
  for (const contacts of [[], [{ id: 'c-n', is_primary: false }]]) {
    const { sb, calls } = fakeSb(released(runPricing({ accept_sentence: RUN_SENTENCE })), null, { contacts })
    const read = await readAcceptSentence(sb, { id: 'doc-1', run_label: 'RHS', job_contact_id: contacts.length ? 'c-n' : null })
    assertEquals(read, { state: 'present', words: ACCEPT_SENTENCE_PREFIX + RUN_SENTENCE, revisionId: 'rev-1' })
    assert(calls.includes('eq:job_document_id=doc-1'))
  }
})

Deno.test('run document: the client\'s own (no contact, or the primary) carries the whole quote\'s words', async () => {
  const noContact = await readAcceptSentence(fakeSb(released(runPricing())).sb, { id: 'doc-1', run_label: 'RHS' })
  assertEquals(noContact, { state: 'present', words: ACCEPT_SENTENCE_PREFIX + SENTENCE, revisionId: 'rev-1' })
  const primary = await readAcceptSentence(
    fakeSb(released(runPricing()), null, { contacts: [{ id: 'c-1', is_primary: true }] }).sb,
    { id: 'doc-1', run_label: 'RHS', job_contact_id: 'c-1' },
  )
  assertEquals(primary, { state: 'present', words: ACCEPT_SENTENCE_PREFIX + SENTENCE, revisionId: 'rev-1' })
})

Deno.test('run document: a neighbour is never shown the whole design as theirs; the record names the gap', async () => {
  const read = await readAcceptSentence(
    fakeSb(released(runPricing()), null, { contacts: [{ id: 'c-n', is_primary: false }] }).sb,
    { id: 'doc-1', run_label: 'RHS', job_contact_id: 'c-n' },
  )
  assertEquals(read, { state: 'refused', reason: 'run_sentence_not_sealed', revisionId: 'rev-1' })
  assertEquals(acceptSentenceHtml(read), '')
  assertEquals(acceptSentenceRecord(read), { accepted_words_refused: 'run_sentence_not_sealed', accepted_words_revision_id: 'rev-1' })
  const unread = await readAcceptSentence(fakeSb(released(runPricing()), null, { contacts: null }).sb, { id: 'doc-1', run_label: 'RHS', job_contact_id: 'c-n' })
  assertEquals(unread, { state: 'unread', reason: 'run_party_read_failed' })
})

Deno.test('run document: an old quote with no sealed sentence is unchanged (none)', async () => {
  const old = { runs: [{ run_label: 'RHS', totals: {} }] }
  assertEquals(await readAcceptSentence(fakeSb(released(old)).sb, { id: 'doc-1', run_label: 'RHS', job_contact_id: 'c-n' }), { state: 'none' })
  assertEquals(await readAcceptSentence(fakeSb(released(old)).sb, null), { state: 'none' })
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
  assertEquals(src.match(/readAcceptSentence\(sb, \{ id: doc\.id, run_label: doc\.run_label \?\? sourceRunLabel, job_contact_id: doc\.job_contact_id \?\? null \}\)/g)?.length, 3)
  assertEquals(src.match(/\.\.\.acceptSentenceRecord\(acceptWords\),/g)?.length, 2)
  const page = src.slice(src.indexOf('function buildClientPage('), src.indexOf('function buildRunQuotePage('))
  assertEquals(page.match(/\$\{acceptingLine\}\n\s*<button class="btn btn-accept"/g)?.length, 2)
  // The run page shows the run's sentence above its Accept Quote.
  assert(src.includes("buildRunQuotePage(doc, token, run, fullJob, isNeighbour ? 'neighbour' : 'client', runAcceptWords)"))
  const runPage = src.slice(src.indexOf('function buildRunQuotePage('))
  assertEquals(runPage.slice(0, 20000).match(/\$\{acceptingLine\}\n\s*<button class="btn btn-accept"/g)?.length, 1)
  // Accept reads the sentence before the acceptance is written.
  assert(src.indexOf('const acceptWords = await readAcceptSentence') < src.indexOf(".update({ accepted_at: acceptedAt })"))
})
