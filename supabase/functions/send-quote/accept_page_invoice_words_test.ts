// The accept page and quote email words: a deposit invoice that was not made is never
// called emailed, and a general job's quote email never names its type.
// Run: deno test --allow-read --allow-env supabase/functions/send-quote/accept_page_invoice_words_test.ts
import { assert, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { buildNextStepsPage, buildQuoteEmail } from './index.ts'

const PENDING = 'We will email your deposit invoice shortly.'

function page(over: Record<string, unknown> = {}): string {
  return buildNextStepsPage({
    clientName: 'Test Customer',
    projectType: 'general',
    address: 'ZZTEST',
    // With no invoice, the handler shows the deposit from the accepted quote.
    depositAmount: 170.5,
    depositDescription: '50% deposit',
    paymentUrl: '',
    invoiceNumber: 'SWG-TEST',
    shareToken: 'tok',
    ...over,
  } as any)
}

Deno.test('accept page: a failed deposit invoice says it will be emailed, never that it was', () => {
  for (const projectType of ['general', 'fencing', 'patio']) {
    const html = page({ projectType, invoiceFailed: true })
    assertStringIncludes(html, PENDING)
    assert(!html.includes('has been emailed'), `${projectType}: page claims the invoice was emailed`)
    assert(!html.includes('Pay Now'))
  }
  const noAmount = page({ invoiceFailed: true, depositAmount: 0 })
  assertStringIncludes(noAmount, PENDING)
  assert(!noAmount.includes('has been emailed'))
})

Deno.test('accept page: the success path still says emailed or shows Pay Now', () => {
  const withLink = page({ paymentUrl: 'https://pay.example/inv' })
  assertStringIncludes(withLink, 'Pay Now - Card or Bank Transfer')
  assert(!withLink.includes(PENDING))
  const noLink = page()
  assertStringIncludes(noLink, 'Your deposit invoice has been emailed to you.')
  assert(!noLink.includes(PENDING))
})

function quoteEmail(projectType: string): string {
  return buildQuoteEmail({
    clientName: 'Test',
    viewUrl: 'https://view',
    pdfUrl: '',
    projectType,
    suburb: 'Testville',
    customMessage: '',
    scoperName: 'Scoper',
  })
}

Deno.test('quote email: a general job says "Your quote is ready" and never "general"', () => {
  const html = quoteEmail('general')
  assertStringIncludes(html, 'Your quote is ready')
  assert(!html.includes('general quote'))
  assert(!html.includes('general project'))
  assertStringIncludes(html, 'quote on your project in Testville')
})

Deno.test('quote email: fence and patio words are unchanged', () => {
  assertStringIncludes(quoteEmail('fencing'), 'Your fencing quote is ready')
  assertStringIncludes(quoteEmail('fencing'), 'quote on your fencing project in Testville')
  assertStringIncludes(quoteEmail('patio'), 'Your patio quote is ready')
  assertStringIncludes(quoteEmail('patio'), 'quote on your patio project in Testville')
})
