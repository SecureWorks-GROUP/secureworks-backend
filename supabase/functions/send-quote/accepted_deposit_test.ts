import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  contactDepositFromRelease,
  depositHeldMessage,
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
  assertEquals(calls.includes('select:id, pricing_snapshot_json, sent_at'), true)
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
