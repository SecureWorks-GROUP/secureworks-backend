// Raw provider text that must not be echoed: a sentinel planted in a Graph
// error, a store error or an exception never reaches the reply, the stored
// approval row or the audit. No real provider is ever called.
// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { recordApproval } from '../_shared/approved_send.ts'
import {
  emailApprovalBody,
  makeDeps,
  RECORDER,
} from '../_shared/approved_send_test_fakes.ts'
import { type GraphCall, sendApprovedEmail } from './approved_send_email.ts'
import {
  assertOutlookSesDeliveryAllowed,
  GraphProviderError,
  handleApprovedEmailRequest,
} from './index.ts'

const SENTINEL = 'SENTINEL raw provider text jane@example.com 0412 999 888'
const DOC_ID = '11111111-1111-4111-8111-111111111111'
const JOB_ID = '10000000-0000-4000-8000-000000000001'
const CALLER = { actor: 'seat:rayleigh', credentialClass: 'ops_agent_server_key' }

function assertNoSentinel(value: unknown, label: string) {
  const text = JSON.stringify(value ?? null)
  assert(!text.includes('SENTINEL'), `${label} echoed raw provider text: ${text}`)
}

function failingGraph(match: (path: string, method: string) => boolean, error: Error): GraphCall {
  return (path, init = {}) => {
    const method = String(init.method || 'GET')
    if (match(path, method)) return Promise.reject(error)
    const ok = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { status: 200 }))
    if (path.endsWith('/createReply')) {
      return ok({
        id: 'draft-reply-1',
        internetMessageId: '<reply-1@secureworks>',
        subject: 'RE: Fence at 12 Example St',
        toRecipients: [{ emailAddress: { address: 'ambrose@example.com' } }],
        ccRecipients: [],
        bccRecipients: [],
      })
    }
    if (method === 'PATCH') {
      const body = JSON.parse(String(init.body))
      return ok({
        id: 'draft-reply-1',
        internetMessageId: '<reply-1@secureworks>',
        subject: body.subject,
        toRecipients: body.toRecipients,
        ccRecipients: body.ccRecipients,
        bccRecipients: body.bccRecipients,
      })
    }
    return Promise.resolve(new Response(null, { status: 202 }))
  }
}

function emailDeps(graph: GraphCall, verifyMailbox: () => Promise<void> = () => Promise.resolve()) {
  const deps = makeDeps()
  deps.files.put({ source: 'job_document', id: DOC_ID }, '%PDF-1.7 revised quote', 'Quote-v2.pdf')
  return { ...deps, graph, verifyMailbox }
}

async function recordEmail(deps: ReturnType<typeof makeDeps>): Promise<string> {
  const body = emailApprovalBody()
  const preview = await recordApproval(deps, RECORDER, body)
  const live = await recordApproval(deps, RECORDER, {
    ...body,
    dry_run: false,
    expected_payload_hash: preview.payload_hash,
  })
  return live.approval_id!
}

function assertNothingEchoed(deps: ReturnType<typeof emailDeps>, id: string, reply: unknown) {
  assertNoSentinel(reply, 'email reply')
  assertNoSentinel(deps.store.rows.get(id), 'stored email approval row')
  assertNoSentinel(deps.store.auditRows, 'email audit rows')
}

Deno.test('approved email: a Graph refusal at the draft step echoes no provider text', async () => {
  const deps = emailDeps(failingGraph(
    (path) => path.endsWith('/createReply'),
    new GraphProviderError(404, SENTINEL, false, { provider_code: 'ErrorItemNotFound' }),
  ))
  const id = await recordEmail(deps)
  const result = await sendApprovedEmail(deps, id, CALLER)
  assertEquals(result.body.state, 'failed')
  assertEquals(result.body.code, 'provider_failed_at_draft')
  // The stored row keeps the provider's status and code, never its text.
  const row = JSON.stringify(deps.store.rows.get(id))
  assert(row.includes('"provider_status":404'), row)
  assert(row.includes('"provider_code":"ErrorItemNotFound"'), row)
  assertNothingEchoed(deps, id, result.body)
})

Deno.test('approved email: an uncertain final send echoes no provider text', async () => {
  const deps = emailDeps(failingGraph(
    (path) => path.endsWith('/send'),
    new GraphProviderError(504, SENTINEL, true),
  ))
  const id = await recordEmail(deps)
  const result = await sendApprovedEmail(deps, id, CALLER)
  assertEquals(result.body.state, 'outcome_unknown')
  assertNothingEchoed(deps, id, result.body)
})

Deno.test('approved email: a plain exception mid-send echoes no exception text', async () => {
  const deps = emailDeps(failingGraph(
    (path) => path.endsWith('/attachments'),
    new Error(SENTINEL),
  ))
  const id = await recordEmail(deps)
  const result = await sendApprovedEmail(deps, id, CALLER)
  assertNothingEchoed(deps, id, result.body)
})

Deno.test('email door: an unverifiable mailbox and a throwing store answer fixed wording', async () => {
  const unverified = emailDeps(
    failingGraph(() => false, new Error('unused')),
    () => Promise.reject(new GraphProviderError(403, SENTINEL, false)),
  )
  const id = await recordEmail(unverified)
  const response = await handleApprovedEmailRequest({ approval_id: id }, CALLER, unverified)
  assertEquals(response.status, 502)
  const body = await response.json()
  assertEquals(body.code, 'mailbox_unverified')
  assertNothingEchoed(unverified, id, body)

  const broken = emailDeps(failingGraph(() => false, new Error('unused')))
  const brokenId = await recordEmail(broken)
  broken.store.loadApproval = () => Promise.reject(new Error(SENTINEL))
  // Neither the reply, the row, the audit nor the door's own log line carries
  // the exception text: the log names the error's class only.
  const logged: unknown[] = []
  const savedError = console.error
  console.error = (...line: unknown[]) => { logged.push(line) }
  let stopped: Response
  try {
    stopped = await handleApprovedEmailRequest({ approval_id: brokenId }, CALLER, broken)
  } finally {
    console.error = savedError
  }
  assertEquals(stopped.status, 500)
  const stoppedBody = await stopped.json()
  assertEquals(stoppedBody.code, 'approved_send_error')
  assertNothingEchoed(broken, brokenId, stoppedBody)
  assertNoSentinel(logged, 'door log line')
  assert(JSON.stringify(logged).includes('approved_send_error'), JSON.stringify(logged))
})

// A PostgREST client whose named tables answer an error carrying raw text and
// a code; every other table answers nothing.
function erroringTables(tables: Record<string, Record<string, unknown>>): any {
  return {
    from(table: string) {
      const response = { data: null, error: tables[table] ?? null }
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve(response),
      }
      return builder
    },
  }
}

async function fenceRefusal(client: any, body: Record<string, unknown>): Promise<any> {
  return await assertRejects(() => assertOutlookSesDeliveryAllowed(client, body))
}

Deno.test('Outlook fence: lookup failures carry a store code, never the store text', async () => {
  const storeError = { message: SENTINEL, details: SENTINEL, hint: SENTINEL, code: '57014' }

  const invoice = await fenceRefusal(erroringTables({ xero_invoices: storeError }), { xero_invoice_id: 'xero-1' })
  assertEquals(invoice.status, 503)
  assertEquals(invoice.refusal.code, 'sealed_ses_fence_check_failed')
  assertEquals(invoice.refusal.evidence.store_code, '57014')
  assertNoSentinel(invoice.refusal, 'invoice mirror refusal')

  const job = await fenceRefusal(erroringTables({ jobs: storeError }), { job_id: JOB_ID })
  assertEquals(job.status, 503)
  assertEquals(job.refusal.code, 'sealed_ses_fence_check_failed')
  assertNoSentinel(job.refusal, 'sealed job refusal')

  const source = await fenceRefusal(erroringTables({ inbox_events: storeError }), {
    action: 'forward',
    message_id: 'graph-message-1',
    job_id: JOB_ID,
  })
  assertEquals(source.status, 503)
  assertEquals(source.refusal.evidence.store_code, '57014')
  assertNoSentinel(source.refusal, 'source message refusal')

  const document = await fenceRefusal(erroringTables({ job_documents: storeError }), {
    attachments: [{ name: 'report.pdf', contentType: 'application/pdf', job_document_id: 'document-1' }],
  })
  assertEquals(document.status, 503)
  assertEquals(document.refusal.evidence.store_code, '57014')
  assertNoSentinel(document.refusal, 'job document refusal')

  // A code that is itself free text is dropped, not echoed.
  const unsafe = await fenceRefusal(
    erroringTables({ xero_invoices: { message: SENTINEL, code: SENTINEL } }),
    { xero_invoice_id: 'xero-1' },
  )
  assertEquals(unsafe.refusal.evidence.store_code, null)
  assertNoSentinel(unsafe.refusal, 'invoice mirror refusal')
})
