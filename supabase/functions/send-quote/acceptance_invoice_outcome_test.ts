// The deposit invoice on an online accept: what the customer and the office are told
// when it is not made (acceptance_invoice_outcome.ts).
// Run: deno test --allow-read --allow-env supabase/functions/send-quote/acceptance_invoice_outcome_test.ts
import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  ACCEPT_INVOICE_PENDING_WORDS,
  ACCEPTANCE_INVOICE_ALERT_TYPE,
  acceptanceInvoiceOutcome,
  alertAcceptanceInvoiceFailed,
  depositPaymentLine,
  noDepositAmountLine,
} from './acceptance_invoice_outcome.ts'

const PREFLIGHT_REFUSAL = { error: 'Invoice preflight failed: suburb' }

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

Deno.test('the preflight suburb refusal is a failure with its reason', () => {
  const outcome = acceptanceInvoiceOutcome(PREFLIGHT_REFUSAL, 500)
  assertEquals(outcome, { ok: false, reason: 'Invoice preflight failed: suburb' })
})

Deno.test('only success true is an invoice', () => {
  const ok = acceptanceInvoiceOutcome({ success: true, invoice_number: 'INV-1', payment_url: 'https://pay' }, 200)
  assert(ok.ok)
  assertEquals(acceptanceInvoiceOutcome({ success: false }, 200), { ok: false, reason: 'HTTP 200' })
  assertEquals(acceptanceInvoiceOutcome({ success: 'true' }, 200).ok, false)
  assertEquals(acceptanceInvoiceOutcome(null), { ok: false, reason: 'no invoice in the reply' })
  assertEquals(acceptanceInvoiceOutcome('not json'), { ok: false, reason: 'no invoice in the reply' })
})

Deno.test('a failed invoice writes one office alert naming the job and the reason', async () => {
  const sb = fakeSb()
  const outcome = acceptanceInvoiceOutcome(PREFLIGHT_REFUSAL, 500)
  assert(!outcome.ok)
  const written = await alertAcceptanceInvoiceFailed(sb, {
    jobId: 'job-uuid',
    jobNumber: 'SWG-TEST',
    reason: outcome.reason,
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
  assertEquals(row.detail_json.reason, 'Invoice preflight failed: suburb')
  assertEquals(row.detail_json.job_document_id, 'doc-uuid')
  // The alert never asks anyone to bypass the preflight.
  assert(!JSON.stringify(row).toLowerCase().includes('bypass'))
})

Deno.test('an alert that cannot be written never throws', async () => {
  assertEquals(await alertAcceptanceInvoiceFailed(fakeSb({ insertError: { message: 'denied' } }), { jobId: 'j', jobNumber: null, reason: 'r' }), false)
  assertEquals(await alertAcceptanceInvoiceFailed(fakeSb({ throws: true }), { jobId: 'j', jobNumber: null, reason: 'r' }), false)
})

Deno.test('a failed invoice: the page line says it will be emailed, never that it was', () => {
  for (const line of [depositPaymentLine({ paymentUrl: '', invoiceFailed: true }), noDepositAmountLine({ invoiceFailed: true })]) {
    assertStringIncludes(line, ACCEPT_INVOICE_PENDING_WORDS)
    assert(!line.includes('has been emailed'))
    assert(!line.includes('Pay Now'))
  }
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
})
