// deno-lint-ignore-file no-explicit-any
// Ruling 18 B2: a 503 'acceptance_read_failed' tells a phone caller (the Scope
// Engine's accept-for-customer) that nothing was saved, so it may try again.
// That is only true before the first write of the accept route. These pin
// every place the code is returned, prove the reads before them write nothing,
// and keep the acceptance call's own failure on its own code
// ('acceptance_outcome_unknown'), because a failed answer there may follow a
// saved acceptance.
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { acceptDocumentWithOptions, loadDocumentOptions } from './quote_options_store.ts'
import { readAcceptSentence } from './accept_sentence.ts'

const SRC = Deno.readTextFileSync(new URL('./index.ts', import.meta.url))
const ROUTE = SRC.indexOf("if ((path === 'accept' && req.method === 'POST') || staffAccept)")
const ROUTE_END = SRC.indexOf('// ── CLIENT DECLINES QUOTE ──', ROUTE)
const ACCEPT_CALL = SRC.indexOf('const accepted = await acceptDocumentWithOptions(', ROUTE)
const RETRY_DEF = SRC.indexOf('const retryAccept = () =>', ROUTE)
const UNKNOWN_DEF = SRC.indexOf('const unknownAccept = () =>', ROUTE)
const WRITES = ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc(']

function indexesOf(needle: string, from: number, to: number): number[] {
  const out: number[] = []
  for (let i = SRC.indexOf(needle, from); i >= 0 && i < to; i = SRC.indexOf(needle, i + 1)) out.push(i)
  return out
}

Deno.test('accept route: the anchors this file reads are where it expects', () => {
  assert(ROUTE > 0 && ROUTE_END > ROUTE, 'accept route found')
  assert(RETRY_DEF > ROUTE && UNKNOWN_DEF > RETRY_DEF && UNKNOWN_DEF < ACCEPT_CALL)
  assert(ACCEPT_CALL > ROUTE && ACCEPT_CALL < ROUTE_END, 'the acceptance call is in the route')
})

Deno.test("'acceptance_read_failed' is returned in one place: retryAccept", () => {
  const all = indexesOf("'acceptance_read_failed'", 0, SRC.length)
  assertEquals(all.length, 1, 'one producer in send-quote')
  assert(all[0] > RETRY_DEF && all[0] < UNKNOWN_DEF, 'inside retryAccept')
  assertEquals(indexesOf('retryAccept', 0, ROUTE).length, 0, 'not used before the route')
  assertEquals(indexesOf('retryAccept', ROUTE_END, SRC.length).length, 0, 'not used after the route')
})

Deno.test('every retryAccept is a failed read before the first write of the route', () => {
  const calls = indexesOf('retryAccept()', ROUTE, ROUTE_END)
  assertEquals(calls.length, 4, 'four call sites; a new one is reviewed here first')
  for (const w of WRITES) {
    assertEquals(indexesOf(w, ROUTE, ACCEPT_CALL), [], `no ${w} before the acceptance call`)
  }
  for (const at of calls) assert(at < ACCEPT_CALL, 'every call is before the acceptance call')
  // Each call is the direct answer to a failed read.
  const sites = [
    'if (staffDocError) return retryAccept()',
    "if (acceptedSiblingsError) {\n          return retryAccept()\n        }",
    "if (loaded.kind === 'unreadable') return retryAccept()",
    "if (quoteAcceptanceReadFailed([acceptancesRead, documentsRead, runItemsRead])) {\n          console.error('[accept] pre-acceptance read failed; nothing written')\n          return retryAccept()\n        }",
  ]
  for (const site of sites) {
    const at = indexesOf(site, ROUTE, ROUTE_END)
    assertEquals(at.length, 1, site)
    assert(at[0] < ACCEPT_CALL)
  }
})

Deno.test('everything awaited before the acceptance call is a read', () => {
  const region = SRC.slice(ROUTE, ACCEPT_CALL)
  const awaited = [...region.matchAll(/await\s+([A-Za-z_][\w.]*)/g)].map((m) => m[1])
  assertEquals(awaited, [
    'req.json',
    'sb', // the staff document read: .from('job_documents').select(...)
    'sb', // the customer link read: .from('job_documents').select(...)
    'partyQuery',
    'siblingQuery',
    'loadDocumentOptions',
    'Promise.all', // run_acceptances, job_documents, run_line_items: selects only
    'readAcceptSentence',
  ])
  for (const q of ['let partyQuery = sb.from(\'job_documents\')\n          .select(', 'let siblingQuery = sb.from(\'job_documents\')\n          .select(']) {
    assertEquals(region.split(q).length, 2, q)
  }
})

Deno.test("the acceptance call's failure is not known, never 'nothing was saved'", () => {
  const block = SRC.slice(ACCEPT_CALL, ACCEPT_CALL + 1400)
  assert(block.includes('if (!accepted.ok) {'))
  const failure = block.slice(block.indexOf('if (!accepted.ok) {'), block.indexOf("if (!accepted.claimed)"))
  assert(failure.includes('return unknownAccept()'), failure)
  assert(!failure.includes('retryAccept'), failure)
  const def = SRC.slice(UNKNOWN_DEF, SRC.indexOf('\n\n', UNKNOWN_DEF))
  assert(def.includes("code: 'acceptance_outcome_unknown' }, 503"), def)
  assert(!def.includes('Nothing was saved'), def)
})

// A database stand-in that records any write and answers every read with
// `answer` (an error, a throw, or rows).
function recordingDb(answer: 'error' | 'throw' | 'empty') {
  const writes: string[] = []
  const chain: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
          answer === 'throw'
            ? Promise.reject(new Error('down')).then(ok, bad)
            : Promise.resolve(answer === 'error' ? { data: null, error: { message: 'down' } } : { data: [], error: null }).then(ok, bad)
      }
      if (['insert', 'update', 'upsert', 'delete'].includes(prop)) {
        return () => {
          writes.push(prop)
          throw new Error(`write ${prop} before the acceptance`)
        }
      }
      return () => chain
    },
  })
  const sb = {
    from: (_table: string) => chain,
    rpc: (fn: string) => {
      writes.push(`rpc:${fn}`)
      throw new Error('rpc before the acceptance')
    },
  }
  return { sb, writes }
}

Deno.test('the reads before retryAccept write nothing, whatever the database answers', async () => {
  const doc = { id: 'zztest-doc', job_id: 'zztest-job', job_contacts: null }
  for (const answer of ['error', 'throw', 'empty'] as const) {
    const { sb, writes } = recordingDb(answer)
    const options = await loadDocumentOptions(sb, doc, null)
    const words = await readAcceptSentence(sb, { id: doc.id, run_label: null, job_contact_id: null })
    assertEquals(writes, [], `no write on ${answer}`)
    if (answer === 'empty') {
      assertEquals(options.kind, 'none')
      assertEquals(words.state, 'none')
    } else {
      // A failed read is what sends the route to retryAccept.
      assertEquals(options.kind, 'unreadable')
      assertEquals(words.state, 'unread')
    }
  }
})

Deno.test('the acceptance call can fail after it saved: that is why its code differs', async () => {
  const rec = {} as any
  let saved = 0
  const after = (reply: () => unknown) => ({
    from: () => {
      throw new Error('no table read')
    },
    rpc: () => {
      saved++
      return reply()
    },
  })
  const replies: Array<() => unknown> = [
    () => ({ data: null, error: { code: '57014' } }),
    () => {
      throw new Error('connection reset')
    },
    () => ({ data: null, error: null }),
  ]
  for (const reply of replies) {
    const r = await acceptDocumentWithOptions(after(reply) as any, 'zztest-doc', 't', rec)
    assertEquals(r.ok, false, 'reads as a failure although the stand-in saved')
  }
  assertEquals(saved, 3)
})
