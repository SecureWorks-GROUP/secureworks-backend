// The deposit invoice on an online accept: what the customer and the office are told
// when it does not go out (acceptance_invoice_outcome.ts).
// Run: deno test --allow-read --allow-env supabase/functions/send-quote/acceptance_invoice_outcome_test.ts
import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  ACCEPT_INVOICE_PENDING_WORDS,
  ACCEPTANCE_INVOICE_ALERT_TYPE,
  acceptanceInvoiceAlertRow,
  acceptanceInvoiceOutcome,
  alertAcceptanceInvoiceFailed,
  depositPaymentLine,
  heldDepositFailure,
  noDepositAmountLine,
  requestAcceptanceInvoice,
  runDepositLines,
  uncertainFailure,
  type AcceptanceInvoiceFailure,
} from './acceptance_invoice_outcome.ts'

// ops-api's createInvoice refusal, word for word (ops-api/index.ts, createInvoice).
const PREFLIGHT_REFUSAL = {
  error: 'Invoice preflight failed: suburb. Set the missing fields on the job, or re-call with bypass_preflight=true to override.',
}
// ops-api's send_acceptance_invoice after it created the invoice (not authorised / no pay link).
const CREATED_NOT_CHARGEABLE = {
  success: false,
  error: 'Acceptance invoice was not authorised or has no payable link — client was NOT emailed. Needs manual review in Xero.',
  reason: 'online_invoice_url_unavailable',
  job_id: 'job-uuid',
  invoice_number: 'INV-TEST',
  xero_invoice_id: 'xero-uuid',
  xero_status: 'AUTHORISED',
  payment_url: '',
}

function failure(o: ReturnType<typeof acceptanceInvoiceOutcome>): AcceptanceInvoiceFailure {
  assert(!o.ok)
  return o
}

function fakeSb(opts: { insertError?: { message: string }; throws?: boolean } = {}) {
  const inserts: { table: string; row: any }[] = []
  return {
    inserts,
    from: (table: string) => ({
      insert: (row: any) => {
        if (opts.throws) throw new Error('network down')
        inserts.push({ table, row })
        return Promise.resolve({ data: null, error: opts.insertError ?? null })
      },
    }),
  }
}

Deno.test('the preflight suburb refusal: nothing created, reason kept, bypass advice dropped', () => {
  const f = failure(acceptanceInvoiceOutcome(PREFLIGHT_REFUSAL, 500))
  assertEquals(f.reason, 'Invoice preflight failed: suburb')
  assertEquals(f.created, 'no')
  assertEquals(f.invoiceNumber, null)
})

Deno.test('an invoice created and then not authorised or without a pay link keeps its identity', () => {
  const f = failure(acceptanceInvoiceOutcome(CREATED_NOT_CHARGEABLE, 200))
  assertEquals(f.created, 'yes')
  assertEquals(f.invoiceNumber, 'INV-TEST')
  assertEquals(f.xeroInvoiceId, 'xero-uuid')
  assertEquals(f.xeroStatus, 'AUTHORISED')
  assertEquals(f.reason, 'online_invoice_url_unavailable')
})

Deno.test('only success true is an invoice that went out; anything else without identity is unknown', () => {
  assert(acceptanceInvoiceOutcome({ success: true, invoice_number: 'INV-1', payment_url: 'https://pay' }, 200).ok)
  assertEquals(failure(acceptanceInvoiceOutcome({ success: false }, 200)).created, 'unknown')
  assertEquals(failure(acceptanceInvoiceOutcome({ success: 'true' }, 200)).created, 'unknown')
  assertEquals(failure(acceptanceInvoiceOutcome({ error: 'Job not found' }, 500)).created, 'unknown')
  assertEquals(failure(acceptanceInvoiceOutcome(null, 502)).created, 'unknown')
  assertEquals(heldDepositFailure('no_released_quote').created, 'no')
  assertEquals(uncertainFailure('timeout').created, 'unknown')
})

Deno.test('requestAcceptanceInvoice: a thrown call or unreadable reply is unknown, never a throw', async () => {
  const thrown = await requestAcceptanceInvoice(() => Promise.reject(new Error('connection reset')), 'u', {})
  assertEquals(failure(thrown).created, 'unknown')
  assertEquals(failure(thrown).reason, 'connection reset')
  const unreadable = await requestAcceptanceInvoice(() => Promise.resolve(new Response('<html>', { status: 502 })), 'u', {})
  assertEquals(failure(unreadable).created, 'unknown')
  let calls = 0
  const refused = await requestAcceptanceInvoice(() => {
    calls++
    return Promise.resolve(Response.json(PREFLIGHT_REFUSAL, { status: 500 }))
  }, 'u', {})
  assertEquals(calls, 1)
  assertEquals(failure(refused).created, 'no')
  const ok = await requestAcceptanceInvoice(() => Promise.resolve(Response.json({ success: true, invoice_number: 'INV-1' })), 'u', {})
  assert(ok.ok)
})

Deno.test('a failed invoice writes one office alert naming the job and the reason', async () => {
  const sb = fakeSb()
  const written = await alertAcceptanceInvoiceFailed(sb, {
    jobId: 'job-uuid',
    jobNumber: 'SWG-TEST',
    failure: failure(acceptanceInvoiceOutcome(PREFLIGHT_REFUSAL, 500)),
    jobDocumentId: 'doc-uuid',
  })
  assertEquals(written, true)
  assertEquals(sb.inserts.length, 1)
  const { table, row } = sb.inserts[0]
  assertEquals(table, 'ai_alerts')
  assertEquals(row.job_id, 'job-uuid')
  assertEquals(row.alert_type, ACCEPTANCE_INVOICE_ALERT_TYPE)
  assertEquals(row.severity, 'red')
  assertStringIncludes(row.message, 'SWG-TEST')
  assertStringIncludes(row.message, 'Invoice preflight failed: suburb')
  assertStringIncludes(row.message, 'no deposit invoice was made')
  assertStringIncludes(row.recommended_action, 'raise and email the deposit invoice')
  assertEquals(row.detail_json.invoice_created, 'no')
  assertEquals(row.detail_json.job_document_id, 'doc-uuid')
  // The alert never asks anyone to bypass the preflight.
  assert(!JSON.stringify(row).toLowerCase().includes('bypass'))
})

Deno.test('a created invoice: the alert names it and says repair it, never raise a new one', () => {
  const row: any = acceptanceInvoiceAlertRow({
    jobId: 'job-uuid',
    jobNumber: 'SWP-TEST',
    failure: failure(acceptanceInvoiceOutcome(CREATED_NOT_CHARGEABLE, 200)),
  })
  assertStringIncludes(row.message, 'Deposit invoice INV-TEST exists in Xero but it has no payment link')
  assert(!row.message.includes('no deposit invoice was made'))
  assertStringIncludes(row.recommended_action, 'Open invoice INV-TEST in Xero and repair it')
  assertStringIncludes(row.recommended_action, 'Do not raise another invoice')
  assert(!/raise and email/.test(row.recommended_action))
  assertEquals(row.detail_json.invoice_created, 'yes')
  assertEquals(row.detail_json.invoice_number, 'INV-TEST')
  assertEquals(row.detail_json.xero_invoice_id, 'xero-uuid')
})

Deno.test('a created invoice that is not authorised says so', () => {
  const row: any = acceptanceInvoiceAlertRow({
    jobId: 'job-uuid',
    jobNumber: 'SWP-TEST',
    failure: failure(acceptanceInvoiceOutcome({ ...CREATED_NOT_CHARGEABLE, reason: 'invoice_not_authorised', xero_status: 'DRAFT' }, 200)),
  })
  assertStringIncludes(row.message, 'Deposit invoice INV-TEST exists in Xero but it is not authorised')
  assertStringIncludes(row.message, 'Xero status DRAFT')
})

Deno.test('an uncertain outcome: the alert says check Xero first, never raise blind', () => {
  const row: any = acceptanceInvoiceAlertRow({
    jobId: 'job-uuid',
    jobNumber: 'SWF-TEST',
    failure: uncertainFailure('connection reset'),
    runLabel: 'LHS',
  })
  assertStringIncludes(row.message, 'no deposit invoice came back')
  assertStringIncludes(row.recommended_action, 'Check Xero for a deposit invoice on this job before raising one')
  assertEquals(row.detail_json.invoice_created, 'unknown')
  assertEquals(row.detail_json.run_label, 'LHS')
})

Deno.test('an alert that cannot be written never throws', async () => {
  const f = uncertainFailure('r')
  assertEquals(await alertAcceptanceInvoiceFailed(fakeSb({ insertError: { message: 'denied' } }), { jobId: 'j', jobNumber: null, failure: f }), false)
  assertEquals(await alertAcceptanceInvoiceFailed(fakeSb({ throws: true }), { jobId: 'j', jobNumber: null, failure: f }), false)
})

Deno.test('a failed invoice: the page lines say it will be emailed, never that it was or to check email', () => {
  const run = runDepositLines({ invoiceFailed: true })
  for (const line of [depositPaymentLine({ paymentUrl: '', invoiceFailed: true }), noDepositAmountLine({ invoiceFailed: true }), run.note]) {
    assertStringIncludes(line, ACCEPT_INVOICE_PENDING_WORDS)
    assert(!line.includes('has been emailed'))
    assert(!line.includes('Pay Now'))
  }
  assertEquals(run.note, ACCEPT_INVOICE_PENDING_WORDS)
  assert(!/check your email/i.test(run.firstStep))
  assertEquals(ACCEPT_INVOICE_PENDING_WORDS, 'We will email your deposit invoice shortly.')
})

Deno.test('the success path lines are unchanged', () => {
  assertEquals(
    depositPaymentLine({ paymentUrl: 'https://pay.example/x' }),
    '<a href="https://pay.example/x" class="btn btn-pay" target="_blank">Pay Now - Card or Bank Transfer</a>',
  )
  assertEquals(
    depositPaymentLine({ paymentUrl: '' }),
    '<p style="color:#4C6A7C;font-size:14px;">Your deposit invoice has been emailed to you. You can pay by card or bank transfer.</p>',
  )
  assertEquals(
    noDepositAmountLine({}),
    '<p style="color:#4C6A7C;font-size:14px;">Your deposit invoice will be sent to you shortly. You can pay by card or bank transfer.</p>',
  )
  assertEquals(runDepositLines({}), {
    note: "Deposit invoices are being created now. You'll receive yours by email shortly with a payment link.",
    firstStep: 'Pay your deposit via the invoice link (check your email)',
  })
})

Deno.test('an alert reason never carries an em dash', () => {
  const f = failure(acceptanceInvoiceOutcome({ error: 'Something failed — client was NOT emailed' }, 500))
  assertEquals(f.reason, 'Something failed, client was NOT emailed')
  const row: any = acceptanceInvoiceAlertRow({ jobId: 'j', jobNumber: 'J', failure: failure(acceptanceInvoiceOutcome(CREATED_NOT_CHARGEABLE, 200)) })
  assert(!JSON.stringify(row).includes('—'))
})
