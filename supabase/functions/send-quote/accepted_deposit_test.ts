import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  contactDepositFromRelease,
  depositHeldMessage,
  namedPartyDeposit,
  readAcceptedRelease,
  runDepositFromRelease,
} from './accepted_deposit.ts'

// A query builder that records the filters and returns fixed rows.
function fakeSb(rows: any[] | null, error: unknown = null, opts: { throws?: boolean } = {}) {
  const calls: string[] = []
  const q: any = {
    select: (c: string) => { calls.push(`select:${c}`); return q },
    eq: (c: string, v: unknown) => { calls.push(`eq:${c}=${v}`); return q },
    not: (c: string, op: string, v: unknown) => { calls.push(`not:${c} ${op} ${v}`); return q },
    order: (c: string, o: any) => { calls.push(`order:${c}:${o?.ascending}`); return q },
    limit: (n: number) => {
      calls.push(`limit:${n}`)
      if (opts.throws) return Promise.reject(new Error('network'))
      return Promise.resolve({ data: rows, error })
    },
  }
  return { sb: { from: (t: string) => { calls.push(`from:${t}`); return q } }, calls }
}

// Fence run: accepted version A had a $4,000 client share; the live job was
// re-scoped to $4,400 afterwards. The deposit must come from A.
const releasedA = {
  id: 'rev-A',
  sent_at: '2026-10-30T01:00:00Z',
  pricing_snapshot_json: {
    raw: {
      deposit: { percent: 50 },
      totalIncGST: 8000,
      runs: [{ run_label: 'R1', totals: { client_share_inc: 4000, neighbour_share_inc: 4000 } }],
    },
  },
}
const pricingA = releasedA.pricing_snapshot_json.raw

Deno.test('reads the accepted document\'s newest sent version', async () => {
  const { sb, calls } = fakeSb([releasedA])
  const rel = await readAcceptedRelease(sb, 'doc-1')
  assertEquals(rel.ok, true)
  assertEquals(calls.includes('from:quote_revisions'), true)
  assertEquals(calls.includes('eq:job_document_id=doc-1'), true)
  assertEquals(calls.includes('not:sent_at is null'), true)
  // The column that exists on quote_revisions (a wrong name fails the whole read live).
  assertEquals(calls.includes('select:id, pricing_snapshot_json, contacts_snapshot_json, sent_at'), true)
})

Deno.test('fence run deposit is priced from the accepted version, not the live job', async () => {
  const { sb } = fakeSb([releasedA])
  const d = runDepositFromRelease(await readAcceptedRelease(sb, 'doc-1'), 'R1', true)
  assertEquals(d, { ok: true, amount: 2000, percent: 50, revisionId: 'rev-A' })
  const n = runDepositFromRelease(await readAcceptedRelease(sb, 'doc-1'), 'R1', false)
  assertEquals(n.ok && n.amount, 2000)
})

Deno.test('a string snapshot, or a string raw inside it, is read the same', async () => {
  const asString = fakeSb([{ ...releasedA, pricing_snapshot_json: JSON.stringify(releasedA.pricing_snapshot_json) }])
  assertEquals(runDepositFromRelease(await readAcceptedRelease(asString.sb, 'doc-1'), 'R1', true).ok, true)
  const rawString = fakeSb([{ ...releasedA, pricing_snapshot_json: { raw: JSON.stringify(pricingA) } }])
  const d = runDepositFromRelease(await readAcceptedRelease(rawString.sb, 'doc-1'), 'R1', true)
  assertEquals(d.ok && d.amount, 2000)
})

Deno.test('no sent version, a failed read or bad pricing holds the deposit', async () => {
  assertEquals(await readAcceptedRelease(fakeSb([]).sb, 'doc-1'), { ok: false, reason: 'no_released_quote' })
  assertEquals(await readAcceptedRelease(fakeSb(null, { message: 'x' }).sb, 'doc-1'), { ok: false, reason: 'release_read_failed' })
  assertEquals(await readAcceptedRelease(fakeSb(null, null, { throws: true }).sb, 'doc-1'), { ok: false, reason: 'release_read_failed' })
  assertEquals(await readAcceptedRelease(fakeSb([{ id: 'r', pricing_snapshot_json: '{bad' }]).sb, 'doc-1'), { ok: false, reason: 'released_pricing_unreadable' })
  assertEquals(await readAcceptedRelease(fakeSb([{ id: 'r', pricing_snapshot_json: {} }]).sb, 'doc-1'), { ok: false, reason: 'released_pricing_unreadable' })
  assertEquals(await readAcceptedRelease(fakeSb([releasedA]).sb, null), { ok: false, reason: 'no_accepted_document' })
  const held = runDepositFromRelease({ ok: false, reason: 'no_released_quote' }, 'R1', true)
  assertEquals(held, { ok: false, reason: 'no_released_quote' })
})

Deno.test('a run missing from the accepted version holds the deposit', async () => {
  const { sb } = fakeSb([releasedA])
  const rel = await readAcceptedRelease(sb, 'doc-1')
  assertEquals(runDepositFromRelease(rel, 'R9', true), { ok: false, reason: 'run_not_in_released_quote' })
  const noShare = { ok: true as const, revisionId: 'r', pricing: { runs: [{ run_label: 'R1', totals: {} }] } }
  assertEquals(runDepositFromRelease(noShare, 'R1', true), { ok: false, reason: 'run_share_not_in_released_quote' })
})

Deno.test('a named party pays from their exact quote value, else their share of the accepted total', () => {
  const rel = { ok: true as const, revisionId: 'rev-A', pricing: pricingA }
  assertEquals(contactDepositFromRelease(rel, { quote_value_ex_gst: 2000 }), { ok: true, amount: 1100, percent: 50, revisionId: 'rev-A' })
  assertEquals(contactDepositFromRelease(rel, { quote_value_ex_gst: null, share_percentage: 25 }), { ok: true, amount: 1000, percent: 50, revisionId: 'rev-A' })
  const noTotal = { ok: true as const, revisionId: 'r', pricing: { deposit: { percent: 40 } } }
  assertEquals(contactDepositFromRelease(noTotal, { quote_value_ex_gst: null }), { ok: false, reason: 'total_not_in_released_quote' })
})

Deno.test('the held message names the job, the party and the reason in plain words', () => {
  assertEquals(
    depositHeldMessage('SWF-261507', 'Jo Smith', 'no_released_quote'),
    'SWF-261507 deposit invoice for Jo Smith not created: no sent version of the accepted quote was found. Raise it from the accepted quote by hand.',
  )
})

// D1F-2. A read-only database of fixed rows: eq / is / not filters, newest first.
function rowsDb(tables: Record<string, any[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] || [])]
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q },
        is: (c: string, v: unknown) => { rows = rows.filter((r) => (r[c] ?? null) === v); return q },
        not: (c: string, _op: string, v: unknown) => { rows = rows.filter((r) => (r[c] ?? null) !== v); return q },
        order: (c: string, o: any) => {
          rows.sort((a, b) => (a[c] < b[c] ? -1 : 1) * (o?.ascending ? 1 : -1))
          return q
        },
        limit: (n: number) => { rows = rows.slice(0, n); return q },
        then: (ok: any, bad: any) => Promise.resolve({ data: rows, error: null }).then(ok, bad),
      }
      return q
    },
  }
}

// The quote sent on 14 Jul for one shared fence: owner A (quote value $2,340.00
// ex GST) and neighbours B and C, prepared together as documents 1, 2 and 3; the
// owner's send recorded the release. Shares inc GST: B $2,574.00, C $1,914.58.
// Deposit 50%. So C owes $957.29 and the owner $1,287.00.
const sentQuote = {
  job_documents: [
    { id: 'doc-A', job_id: 'job-1', type: 'quote', version: 1, run_label: null, job_contacts: { contact_label: 'A' } },
    { id: 'doc-B', job_id: 'job-1', type: 'quote', version: 2, run_label: null, job_contacts: { contact_label: 'B' } },
    { id: 'doc-C', job_id: 'job-1', type: 'quote', version: 3, run_label: null, job_contacts: { contact_label: 'C' } },
  ],
  quote_revisions: [{
    id: 'rev-1',
    job_document_id: 'doc-A',
    sent_at: '2026-07-14T02:11:03Z',
    pricing_snapshot_json: {
      raw: {
        totalIncGST: 7062.58,
        deposit: { percent: 50 },
        neighbour_splits: {
          method: 'flat_percent',
          neighbours: [
            { id: 'nb-1', name: 'Bea Neighbour', portion_inc_gst: 2574 },
            { id: 'nb-2', name: 'Cal Neighbour', portion_inc_gst: 1914.58 },
          ],
        },
      },
    },
    contacts_snapshot_json: [{ id: 'c-A', label: 'A' }, { id: 'c-B', label: 'B' }, { id: 'c-C', label: 'C' }],
  }],
}

Deno.test('a neighbour whose contact value changed after sending pays from their share of the accepted quote', async () => {
  // C's contact value was edited to $2,000 ex GST after the quote went out.
  const d = await namedPartyDeposit(rowsDb(sentQuote), {
    id: 'doc-C', job_id: 'job-1', version: 3, job_contact_id: 'c-C',
    job_contacts: { contact_label: 'C', quote_value_ex_gst: 2000, share_percentage: 50 },
  })
  assertEquals(d, { ok: true, amount: 957.29, percent: 50, revisionId: 'rev-1' })
})

Deno.test('a neighbour who cannot be matched to a share of the accepted quote is held with the reason', async () => {
  const held = { ok: false as const, reason: 'neighbour_share_unmatched' }
  // Their party key names no share on the accepted quote.
  assertEquals(await namedPartyDeposit(rowsDb(sentQuote), {
    id: 'doc-B', job_id: 'job-1', version: 2, job_contact_id: 'c-B',
    job_contacts: { contact_label: 'B', source_party_key: 'nb-7', quote_value_ex_gst: 2340 },
  }), held)
  // The accepted quote's contacts (A, B, C) and its shares (one) disagree.
  const oneShare = structuredClone(sentQuote)
  oneShare.quote_revisions[0].pricing_snapshot_json.raw.neighbour_splits.neighbours.pop()
  assertEquals(await namedPartyDeposit(rowsDb(oneShare), {
    id: 'doc-B', job_id: 'job-1', version: 2, job_contact_id: 'c-B',
    job_contacts: { contact_label: 'B', quote_value_ex_gst: 2340 },
  }), held)
})

Deno.test("the owner's deposit on a whole-quote document is unchanged", async () => {
  const d = await namedPartyDeposit(rowsDb(sentQuote), {
    id: 'doc-A', job_id: 'job-1', version: 1, job_contact_id: 'c-A',
    job_contacts: { contact_label: 'A', quote_value_ex_gst: 2340, share_percentage: 50 },
  })
  assertEquals(d, { ok: true, amount: 1287, percent: 50, revisionId: 'rev-1' })
})
