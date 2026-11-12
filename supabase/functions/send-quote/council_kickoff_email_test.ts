// The "Next Steps & House Plans" email on a patio accept (council_kickoff_email.ts).
// Run: deno test --allow-read supabase/functions/send-quote/council_kickoff_email_test.ts
import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  buildCouncilKickoffEmail,
  COUNCIL_KICKOFF_SUBJECT,
  councilKickoffApplies,
  readQuoteRecipientEmail,
  sendCouncilKickoffEmail,
} from './council_kickoff_email.ts'

const CUSTOMER = 'customer@example.com'

// quote_revisions reads return `revisions`; po_communications inserts are recorded.
function fakeSb(revisions: any[] | null, opts: { readError?: unknown } = {}) {
  const calls: string[] = []
  const inserts: any[] = []
  const q: any = {
    select: (c: string) => { calls.push(`select:${c}`); return q },
    eq: (c: string, v: unknown) => { calls.push(`eq:${c}=${v}`); return q },
    not: (c: string, op: string, v: unknown) => { calls.push(`not:${c} ${op} ${v}`); return q },
    order: (c: string, o: any) => { calls.push(`order:${c}:${o?.ascending}`); return q },
    limit: (n: number) => {
      calls.push(`limit:${n}`)
      return Promise.resolve({ data: revisions, error: opts.readError ?? null })
    },
  }
  const sb = {
    from: (t: string) => {
      calls.push(`from:${t}`)
      if (t === 'po_communications') {
        return { insert: (row: any) => { inserts.push(row); return Promise.resolve({ error: null }) } }
      }
      return q
    },
  }
  return { sb, calls, inserts }
}

function fakeFetch(respond: () => Response | Promise<Response>) {
  const requests: any[] = []
  const f = ((url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) })
    return Promise.resolve(respond())
  }) as unknown as typeof fetch
  return { f, requests }
}

const input = {
  jobId: 'job-1',
  jobNumber: 'SWP-TEST',
  documentId: 'doc-1',
  councilSubmissionId: 'cs-1',
  replyTo: 'patios@example.com',
  html: '<p>plans</p>',
}

function deps(sb: any, f: typeof fetch, ghl: any[]) {
  return { sb, fetch: f, resendApiKey: 'test', logGhl: (s: string, r: string) => { ghl.push({ s, r }) }, now: () => new Date('2026-11-12T11:00:00Z') }
}

Deno.test('recipient: the address the quote send used for this document (newest released revision)', async () => {
  const { sb, calls } = fakeSb([{ recipient_email: ` ${CUSTOMER} `, sent_at: '2026-11-12T01:00:00Z' }])
  assertEquals(await readQuoteRecipientEmail(sb, 'doc-1'), { ok: true, email: CUSTOMER })
  assert(calls.includes('from:quote_revisions'))
  assert(calls.includes('eq:job_document_id=doc-1'))
  assert(calls.includes('not:sent_at is null'))
  assert(calls.includes('order:sent_at:false'))
})

Deno.test('regression: the house-plans email goes to the customer, never to an empty address', async () => {
  const { sb, inserts } = fakeSb([{ recipient_email: CUSTOMER, sent_at: '2026-11-12T01:00:00Z' }])
  const { f, requests } = fakeFetch(() => Response.json({ id: 'msg-1' }))
  const ghl: any[] = []
  const out = await sendCouncilKickoffEmail(deps(sb, f, ghl), input)
  assertEquals(out, { outcome: 'sent', recipient: CUSTOMER, messageId: 'msg-1' })
  assertEquals(requests.length, 1)
  assertEquals(requests[0].body.to, [CUSTOMER])
  assertEquals(requests[0].body.cc, undefined)
  assertEquals(requests[0].body.subject, COUNCIL_KICKOFF_SUBJECT)
  assertEquals(inserts.length, 1)
  assertEquals(inserts[0].to_email, CUSTOMER)
  assertEquals(inserts[0].delivery_status, 'sent')
  assertEquals(inserts[0].message_id, 'msg-1')
  assertEquals(ghl, [{ s: 'Council Kickoff - Next Steps & House Plans', r: CUSTOMER }])
})

for (const [label, rows, readError] of [
  ['no released revision', [], null],
  ['revision with a blank address', [{ recipient_email: '  ', sent_at: '2026-11-12T01:00:00Z' }], null],
  ['revision read failed', null, { message: 'boom' }],
] as const) {
  Deno.test(`no address (${label}): nothing sent, nothing recorded`, async () => {
    const { sb, inserts } = fakeSb(rows as any, { readError })
    const { f, requests } = fakeFetch(() => Response.json({ id: 'msg-x' }))
    const ghl: any[] = []
    const out = await sendCouncilKickoffEmail(deps(sb, f, ghl), input)
    assertEquals(out.outcome, 'no_recipient')
    assertEquals(requests.length, 0)
    assertEquals(inserts.length, 0)
    assertEquals(ghl.length, 0)
  })
}

for (const [label, respond, reason] of [
  ['Resend refuses (422)', () => Response.json({ message: 'invalid to' }, { status: 422 }), 'resend_http_422'],
  ['Resend answers ok with no id', () => Response.json({}), 'resend_no_id'],
  ['network throws', () => { throw new Error('offline') }, 'resend_network: offline'],
] as const) {
  Deno.test(`${label}: recorded failed, never sent, no GHL note`, async () => {
    const { sb, inserts } = fakeSb([{ recipient_email: CUSTOMER, sent_at: '2026-11-12T01:00:00Z' }])
    const { f } = fakeFetch(respond as any)
    const ghl: any[] = []
    const out = await sendCouncilKickoffEmail(deps(sb, f, ghl), input)
    assertEquals(out, { outcome: 'failed', recipient: CUSTOMER, reason })
    assertEquals(inserts.length, 1)
    assertEquals(inserts[0].delivery_status, 'failed')
    assertEquals(inserts[0].to_email, CUSTOMER)
    assertEquals(inserts[0].message_id, undefined)
    assertEquals(ghl.length, 0)
  })
}

Deno.test('no council submission: email still sent, no council-thread row (as before)', async () => {
  const { sb, inserts } = fakeSb([{ recipient_email: CUSTOMER, sent_at: '2026-11-12T01:00:00Z' }])
  const { f, requests } = fakeFetch(() => Response.json({ id: 'msg-2' }))
  const out = await sendCouncilKickoffEmail(deps(sb, f, []), { ...input, councilSubmissionId: null })
  assertEquals(out.outcome, 'sent')
  assertEquals(requests[0].body.to, [CUSTOMER])
  assertEquals(inserts.length, 0)
})

// The accept handler reads no email on its document or job rows, so the send
// must go through the helper above, never the old empty fallback.
Deno.test('regression: the accept handler sends the house-plans email through sendCouncilKickoffEmail', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url))
  assert(!src.includes("doc.job_contacts?.client_email || ''"), 'accept still sends to an empty fallback address')
  assert(!src.includes('councilJobEmail'), 'accept still addresses the email from a field it never reads')
  const call = src.indexOf('sendCouncilKickoffEmail({')
  assert(call > 0, 'accept does not call sendCouncilKickoffEmail')
  assert(src.slice(call, call + 600).includes('documentId: doc.id'), 'the helper is not given the accepted document')
})

// ── Words: director's ruling 5 ──

function bodyText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
}

Deno.test('words: subject unchanged', () => {
  assertEquals(COUNCIL_KICKOFF_SUBJECT, 'Your Patio Project - Next Steps & What We Need From You')
})

Deno.test('words: no invoice, no Upload, no CDC, no durations, no em dash, no link to the upload page', () => {
  const html = buildCouncilKickoffEmail('Sam', '1 Example St', 'Exampleton')
  const text = bodyText(html)
  assert(!/invoice/i.test(html), 'mentions an invoice')
  assert(!/upload/i.test(html), 'mentions Upload')
  assert(!/CDC/.test(html), 'mentions CDC')
  assert(!/\d\s*(?:-|–)?\s*\d*\s*weeks?/i.test(text), 'states a duration in weeks')
  assert(!html.includes('—'), 'em dash')
  assert(!html.includes('upload-plans'), 'links the upload page')
  assert(!/Or simply/.test(html), 'keeps the "Or simply" line')
})

Deno.test('words: the ruling-5 lines, word for word', () => {
  const text = bodyText(buildCouncilKickoffEmail('Sam', '1 Example St', 'Exampleton'))
  for (const line of [
    'Hi Sam,',
    'There is one thing we need from you to get started:',
    'Please reply to this email with your house plans attached (PDF or photos are fine).',
    'Not sure where to find them? Check your original build pack, request a copy from your local council (Exampleton), or ask your builder.',
    'Our engineer prepares the structural drawings.',
    'We lodge the building permit application with your council.',
    'Once the permit is issued, we order materials and schedule your build.',
    'We handle the entire council process for you - no need for you to contact council directly.',
    'Questions? Call 0489 267 771 or reply to this email.',
    'SecureWorks Group Pty Ltd | ABN 64 689 223 416',
  ]) assert(text.includes(line), `missing: ${line}`)
  assertEquals((text.match(/<li>|Our engineer|We lodge|Once the permit/g) || []).length, 3)
})

Deno.test('words: the body does not depend on the deposit invoice (held, failed or sent give the same body)', async () => {
  // The builder takes no invoice input at all, and the accept handler passes it only the name and site.
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url))
  const calls = src.match(/buildCouncilKickoffEmail\(([^)]*)\)/g) || []
  assertEquals(calls, ["buildCouncilKickoffEmail(clientFirst, job.site_address || '', job.site_suburb || '')"])
  assertEquals(buildCouncilKickoffEmail.length, 3)
  const a = buildCouncilKickoffEmail('Sam', '1 Example St', 'Exampleton')
  const b = buildCouncilKickoffEmail('Sam', '1 Example St', 'Exampleton')
  assertEquals(a, b)
})

Deno.test('fence accept sends nothing: only a patio accept starts the council email', async () => {
  assertEquals(councilKickoffApplies({ type: 'fencing', job_number: 'SWF-1' }), false)
  assertEquals(councilKickoffApplies({ type: 'general', job_number: 'SWG-1' }), false)
  assertEquals(councilKickoffApplies(null), false)
  assertEquals(councilKickoffApplies({ type: 'patio', job_number: 'SWP-1' }), true)
  assertEquals(councilKickoffApplies({ type: null, job_number: 'SWP-1' }), true)
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url))
  assert(src.includes('const isPatio = councilKickoffApplies(job)'))
  const guard = src.indexOf('if (isPatio && job) {')
  const send = src.indexOf('sendCouncilKickoffEmail({')
  assert(guard > 0 && send > guard, 'the send is not inside the patio guard')
  assertEquals((src.match(/sendCouncilKickoffEmail\(\{/g) || []).length, 1)
})
