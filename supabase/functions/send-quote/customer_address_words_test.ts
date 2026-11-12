// The deposit invoice email and the accept page: the suburb is named once, and a general job's
// invoice email says "your project", never "your patio project". Fence and patio are unchanged.
// Run: deno test --allow-read --allow-env supabase/functions/send-quote/customer_address_words_test.ts
import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { buildInvoiceEmail, buildNextStepsPage } from './index.ts'
import { nextStepsProjectLabel } from './division_routing.ts'
import { resolveSendInvoiceDelivery } from './quote_send_auth.ts'
import { customerSiteLine } from '../_shared/customer_site_line.ts'

const TYPED = { site_address: 'ZZTEST 3 Test St, Baldivis', site_suburb: 'Baldivis' }

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// The send-invoice handler passes the type name it always passed, plus the label for the words.
function invoiceEmail(jobType: string, address: string): string {
  const typeName = jobType === 'fencing' ? 'fencing' : jobType === 'decking' ? 'decking' : 'patio'
  return buildInvoiceEmail({
    firstName: 'Test',
    jobType: typeName,
    projectLabel: nextStepsProjectLabel(jobType),
    address,
    invoiceNumber: 'INV-TEST',
    depositAmount: '$100.00',
    dueDate: '1/1/2027',
    paymentUrl: 'https://pay.example/x',
    paymentConfirmedUrl: 'https://confirm.example/x',
  })
}

Deno.test('invoice email address: a street typed with its suburb names the suburb once', () => {
  for (const authMode of ['jwt', 'api_key'] as const) {
    const delivery = resolveSendInvoiceDelivery({
      authMode,
      body: {},
      job: { client_email: 'test@example.invalid', client_name: 'Test', type: 'general', ...TYPED },
      invoice: { invoice_number: 'INV-TEST', total: 100, due_date: '' },
    })
    assertEquals(delivery.address, 'ZZTEST 3 Test St, Baldivis', authMode)
  }
  const plain = resolveSendInvoiceDelivery({
    authMode: 'jwt',
    body: {},
    job: { client_email: 'test@example.invalid', type: 'patio', site_address: '3 Test St', site_suburb: 'Baldivis' },
    invoice: null,
  })
  assertEquals(plain.address, '3 Test St, Baldivis')
})

Deno.test('invoice email: a general job says "your project", never "your patio project"', () => {
  const html = invoiceEmail('general', 'ZZTEST 3 Test St, Baldivis')
  assertStringIncludes(html, 'Your deposit invoice for your project at ZZTEST 3 Test St, Baldivis is ready.')
  assert(!html.includes('patio project'))
  assert(!html.includes('Baldivis, Baldivis'))
})

// SHA-256 of origin/main's buildInvoiceEmail output (before this change) for the same inputs.
const MAIN_INVOICE_EMAIL_SHA256: Record<string, string> = {
  fencing: '3fe0a6c7ebd1ea30fc2062adbfe1899010aa314806e67b72516ddece448a66dc',
  patio: 'b464903672b18e56b35c118ba4f02395da41093b5d9722fbbcdd908ed17a27a5',
  decking: '3c8e76a726414e3aa04836e5ec02bfd99454736176e46ef3b31e193ca83082b1',
}

Deno.test('invoice email: fence, patio and decking are byte for byte what main sent', async () => {
  for (const [jobType, expected] of Object.entries(MAIN_INVOICE_EMAIL_SHA256)) {
    assertEquals(await sha256(invoiceEmail(jobType, '3 Test St, Baldivis')), expected, jobType)
  }
  assertStringIncludes(invoiceEmail('fencing', 'x'), 'for your fencing project at x is ready.')
  assertStringIncludes(invoiceEmail('patio', 'x'), 'for your patio project at x is ready.')
})

Deno.test('accept page: the address the handler builds names the suburb once', () => {
  const html = buildNextStepsPage({
    clientName: 'Test Customer',
    projectType: 'general',
    address: customerSiteLine(TYPED.site_address, TYPED.site_suburb),
    depositAmount: 170.5,
    depositDescription: '50% deposit',
    paymentUrl: '',
    invoiceNumber: 'INV-TEST',
    shareToken: 'tok',
  } as any)
  assertStringIncludes(html, 'ZZTEST 3 Test St, Baldivis')
  assert(!html.includes('Baldivis, Baldivis'))
})
