// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { TRANSCRIPTION_PROMPT_MAX_CHARS, loadTranscriptionPrompt, staffTerms, supplierTerm, transcriptionPrompt } from './vocabulary.ts'

Deno.test('staff first and full names, never an email or a number', () => {
  assertEquals(staffTerms(['Khairo Example', 'Marnin', 'ops@secureworkswa.com.au', 'Crew 2', null]), ['Khairo', 'Khairo Example', 'Marnin'])
})

Deno.test('a supplier is named as it trades', () => {
  assertEquals(supplierTerm('Fielders Pty Ltd'), 'Fielders')
  assertEquals(supplierTerm('The Trustee for Example Family Trust (Perth)'), 'Example Family')
  assertEquals(supplierTerm('  Steeline   Steel  '), 'Steeline Steel')
})

Deno.test('the prompt puts staff first, each term once, and stays under the cap at a whole term', () => {
  const prompt = transcriptionPrompt({ staff: ['Khairo Example', 'Nithin'], suppliers: ['Stratco (WA) Pty Ltd'], suburbs: ['BALDIVIS', 'baldivis', 'ellenbrook'] })
  assert(prompt.startsWith('A phone call for SecureWorks Group'))
  assert(prompt.indexOf('Khairo') < prompt.indexOf('Colorbond'))
  assertEquals(prompt.match(/Stratco/g)?.length, 1)
  assertEquals(prompt.match(/Baldivis/g)?.length, 1)
  assert(prompt.includes('Ellenbrook'))
  const long = transcriptionPrompt({ suburbs: Array.from({ length: 300 }, (_, i) => `Suburb${String.fromCharCode(97 + (i % 26))}${i}`) })
  assert(long.length <= TRANSCRIPTION_PROMPT_MAX_CHARS)
  assert(long.endsWith('.'))
  assert(!/,\s*\.$/.test(long))
})

Deno.test('a failed read shortens the list and never throws', async () => {
  const query = (data: unknown, error: unknown = null) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'limit', 'gte', 'not']) q[m] = () => q
    q.then = (resolve: (v: unknown) => void) => resolve({ data, error })
    return q
  }
  const sb = {
    from: (table: string) => table === 'users' ? query([{ name: 'Marnin Example' }])
      : table === 'suppliers' ? query(null, { message: 'boom' })
      : query([{ site_suburb: 'Baldivis' }, { site_suburb: 'Baldivis' }, { site_suburb: 'Suburb TBC' }, { site_suburb: 'Ellenbrook' }]),
  }
  const { prompt, failed } = await loadTranscriptionPrompt(sb, 'org')
  assertEquals(failed, ['suppliers'])
  assert(prompt.includes('Marnin'))
  assert(prompt.indexOf('Baldivis') < prompt.indexOf('Ellenbrook'))
  assert(!prompt.includes('TBC'))
  const thrown = await loadTranscriptionPrompt({ from: () => { throw new Error('down') } }, 'org')
  assertEquals(thrown.failed, ['users', 'suppliers', 'suburbs'])
  assert(thrown.prompt.includes('Colorbond'))
})
