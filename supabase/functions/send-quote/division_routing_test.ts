// deno test --allow-read supabase/functions/send-quote/division_routing_test.ts
import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { getClientReplyTo, getDivisionInbox, nextStepsProjectLabel, quoteEmailHeading, quoteEmailProjectWords, quoteEmailSubject } from './division_routing.ts'

// The rules as they stood before general jobs were split out, copied verbatim, so every
// non-general type is proved byte-identical.
const before = {
  replyTo(jobType: string | null, jobNumber?: string | null): string {
    const dept = jobType === 'fencing' ? 'fencing' : 'patios'
    const tag = jobNumber ? `+${jobNumber}` : ''
    return `${dept}${tag}@secureworkswa.com.au`
  },
  inbox(jobType: string | null | undefined): string {
    return jobType === 'fencing' ? 'fencing@secureworkswa.com.au' : 'patios@secureworkswa.com.au'
  },
  subject(jobType: string | null | undefined): string {
    return `Your ${jobType || 'project'} quote from SecureWorks Group`
  },
  label(projectType: string): string {
    const typeName = projectType === 'fencing' ? 'fencing' : projectType === 'decking' ? 'decking' : 'patio'
    return `${typeName} project`
  },
}

const UNCHANGED_TYPES = ['fencing', 'patio', 'decking', 'combo', 'repair', 'miscellaneous', 'project', null]

Deno.test('general job: quote subject does not name the type', () => {
  assertEquals(quoteEmailSubject('general'), 'Your quote from SecureWorks Group')
  assert(!quoteEmailSubject('general').includes('general'))
})

Deno.test('general job: accept page says project, never patio', () => {
  assertEquals(nextStepsProjectLabel('general'), 'project')
  assert(!nextStepsProjectLabel('general').includes('patio'))
})

Deno.test('general job: reply-to and fixed copy go to the admin inbox', () => {
  assertEquals(getClientReplyTo('general', 'SWG-1'), 'admin+SWG-1@secureworkswa.com.au')
  assertEquals(getClientReplyTo('general', null), 'admin@secureworkswa.com.au')
  assertEquals(getDivisionInbox('general'), 'admin@secureworkswa.com.au')
  assert(!getClientReplyTo('general', 'SWG-1').startsWith('patios'))
})

Deno.test('fence, patio and every other type are byte-identical to before', () => {
  for (const t of UNCHANGED_TYPES) {
    for (const n of ['SWF-1', 'SWP-1', null, undefined, '']) {
      assertEquals(getClientReplyTo(t, n), before.replyTo(t, n), `replyTo ${t} ${n}`)
    }
    assertEquals(getDivisionInbox(t), before.inbox(t), `inbox ${t}`)
    assertEquals(quoteEmailSubject(t), before.subject(t), `subject ${t}`)
    assertEquals(nextStepsProjectLabel(t ?? 'project'), before.label(t ?? 'project'), `label ${t}`)
  }
  assertEquals(getDivisionInbox(undefined), before.inbox(undefined))
  assertEquals(quoteEmailSubject(undefined), before.subject(undefined))
})

Deno.test('index.ts uses the shared rules, with no local copies left behind', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url))
  assert(src.includes("from './division_routing.ts'"))
  assert(!/function getClientReplyTo\(/.test(src), 'local getClientReplyTo still in index.ts')
  assert(!/function getDivisionInbox\(/.test(src), 'local getDivisionInbox still in index.ts')
  assert(!src.includes("`Your ${doc.jobs?.type || 'project'} quote from SecureWorks Group`"), 'inline subject left in index.ts')
  assertEquals((src.match(/customSubject \|\| quoteEmailSubject\(doc\.jobs\?\.type\)/g) || []).length, 2)
  assert(src.includes('<p>Your ${projectLabel}${opts.address'), 'accept page does not use nextStepsProjectLabel')
})

Deno.test('general job: quote email heading and body never name the type', () => {
  assertEquals(quoteEmailHeading('general'), 'Your quote is ready')
  assertEquals(quoteEmailProjectWords('general'), 'project')
  for (const t of ['fencing', 'patio', 'decking']) {
    assertEquals(quoteEmailHeading(t), `Your ${t} quote is ready`)
    assertEquals(quoteEmailProjectWords(t), `${t} project`)
  }
})
