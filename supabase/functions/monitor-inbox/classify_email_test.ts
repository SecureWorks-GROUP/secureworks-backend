// Slice EM0: monitor-inbox classifies every email by rules, with no model
// call and no network call, on both of its paths.
//
// Fixtures are the named email rows from the context design note
// (email.md section 10), recorded as the sender or mailbox and the subject
// that note gives. Their bodies are not in the note, so the preview is
// empty; the rules read subject plus preview, so the subject alone decides.
//
// Run: deno test --allow-env supabase/functions/monitor-inbox/classify_email_test.ts

// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { classifyEmail, type EmailClassification } from './classify_email.ts'

type Row = {
  label: string
  path: 'user_mailbox_poll' | 'group_reader'
  from: string
  subject: string
  preview: string
  expected: EmailClassification
}

const NO_ACTION = { priority: 'normal', action_needed: null } as const

const ROWS: Row[] = [
  {
    label: 'E4 SWP-261203 invoice reply',
    path: 'user_mailbox_poll',
    from: 'admin@secureworkswa.com.au',
    subject: 'Re: Invoice #INV-1244',
    preview: '',
    expected: { classification: 'invoice', ...NO_ACTION, job_ref: null },
  },
  {
    label: 'E5 SWP-26701 council permit (Stirling)',
    path: 'user_mailbox_poll',
    from: 'Development@stirling.wa.gov.au',
    subject: 'BC26/1697 - Building Permit',
    preview: '',
    expected: { classification: 'council', priority: 'high', action_needed: 'review', job_ref: null },
  },
  {
    label: 'E5 SWP-26701 council RFI (Stirling)',
    path: 'user_mailbox_poll',
    from: 'Development@stirling.wa.gov.au',
    subject: 'RFI - BC26/1697',
    preview: '',
    expected: { classification: 'client_reply', ...NO_ACTION, job_ref: null },
  },
  {
    label: 'E6 SWP-261222 South Perth acknowledgement',
    path: 'user_mailbox_poll',
    from: 'admin@secureworkswa.com.au',
    subject: 'Acknowledgement BDBPCERT-2026/3018',
    preview: '',
    expected: { classification: 'client_reply', ...NO_ACTION, job_ref: null },
  },
  {
    label: 'E9 SWP-261247 invoice thread in marnin@',
    path: 'user_mailbox_poll',
    from: 'marnin@secureworkswa.com.au',
    subject: 'Re: Invoice: INV-1477',
    preview: '',
    expected: { classification: 'invoice', ...NO_ACTION, job_ref: null },
  },
  {
    label: 'E10 SWP-261248 forwarded site address in nithin@',
    path: 'user_mailbox_poll',
    from: 'nithin@secureworkswa.com.au',
    subject: 'Fw: 34 Montane Tn, Banksia Grove',
    preview: '',
    expected: { classification: 'client_reply', ...NO_ACTION, job_ref: null },
  },
  {
    // The space-joined "SWP 26195" is not a rules job_ref; the shared token
    // rule (B0, used by the ladder) reads it. EM0 does not widen the rules.
    label: 'E11 SWP-26195 material order in admin@',
    path: 'user_mailbox_poll',
    from: 'admin@secureworkswa.com.au',
    subject: 'Material Order Ref SWP 26195',
    preview: '',
    expected: { classification: 'client_reply', ...NO_ACTION, job_ref: null },
  },
  {
    label: 'E18 SWP-261222 patios@ group post approval',
    path: 'group_reader',
    from: 'patios@secureworkswa.com.au',
    subject: 'Approval BDBPCERT-2026/3018 - 20A Beenan',
    preview: '',
    expected: { classification: 'client_reply', ...NO_ACTION, job_ref: null },
  },
  {
    // Fixture, not a named row: proves the rules job_ref still reaches the
    // job matcher (resolveJobId step 1) once the model no longer supplies one.
    label: 'fixture: our PO number in a supplier quote',
    path: 'user_mailbox_poll',
    from: 'orders@supplier.example',
    subject: 'Quote for PO061378',
    preview: '',
    expected: { classification: 'supplier_quote', ...NO_ACTION, job_ref: 'PO-061378' },
  },
  {
    label: 'fixture: our prefixed job number in a group post',
    path: 'group_reader',
    from: 'fencing@secureworkswa.com.au',
    subject: 'Re: SWF-26838 gate',
    preview: 'Can you confirm the gate width',
    expected: { classification: 'client_reply', ...NO_ACTION, job_ref: 'SWF-26838' },
  },
]

// A configured model key must not cause classification to make a request.
const MODEL_KEY = 'ANTHROPIC_API_KEY'

Deno.test('EM0: no outbound call on any named row, even with a model key present', () => {
  const originalFetch = globalThis.fetch
  const hadKey = Deno.env.get(MODEL_KEY)
  const calls: string[] = []
  globalThis.fetch = ((input: Request | URL | string) => {
    calls.push(String(input instanceof Request ? input.url : input))
    return Promise.reject(new Error('EM0: classifier made a network call'))
  }) as typeof fetch
  Deno.env.set(MODEL_KEY, 'sk-test-em0-trap')
  try {
    for (const path of ['user_mailbox_poll', 'group_reader'] as const) {
      const pathRows = ROWS.filter((row) => row.path === path)
      assert(pathRows.length > 0, `recorded rows cover ${path}`)
      for (const row of pathRows) {
        const result = classifyEmail(row.from, row.subject, row.preview)
        assert(!(result instanceof Promise), `${row.label}: classifier must not return a Promise`)
        assertEquals(result, row.expected, row.label)
      }
    }
    assertEquals(calls, [], 'no outbound request from the classifier')
  } finally {
    globalThis.fetch = originalFetch
    if (hadKey === undefined) Deno.env.delete(MODEL_KEY)
    else Deno.env.set(MODEL_KEY, hadKey)
  }
})

Deno.test('EM0: a noreply sender and an urgent word keep their rules classes', () => {
  assertEquals(classifyEmail('noreply@council.example', 'Building Permit issued', ''), {
    classification: 'newsletter',
    priority: 'low',
    action_needed: null,
    job_ref: null,
  })
  assertEquals(classifyEmail('client@example.com', 'Urgent: gate left open', ''), {
    classification: 'complaint',
    priority: 'high',
    action_needed: 'review',
    job_ref: null,
  })
})
