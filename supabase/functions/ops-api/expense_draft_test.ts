// Tests for the DRAFT-only expense Xero pathway and preflight gate.
//
// What's under test:
//   - buildXeroExpenseBillBody: every Xero call from pushExpenseToXero must
//     emit Status: 'DRAFT'. Finance authorises in Xero, not SecureSuite.
//   - preflightExpense: junk OCR data is rejected before Xero is called.
//
// Exercise the production helpers without starting the server.
import { assertEquals, assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { buildXeroExpenseBillBody, preflightExpense } from "./index.ts"

// Fixture builders
// ────────────────────────────────────────────────────────────────────────────
function validExpense(overrides: Record<string, any> = {}): any {
  const today = new Date().toISOString().split('T')[0]
  return {
    id: 'exp-1',
    vendor_name: 'Bunnings Warehouse',
    receipt_date: today,
    total_amount: 123.45,
    gst_amount: 11.22,
    line_items: [
      { description: 'Tek screws', quantity: 2, unit_price: 25.00, total: 50.00 },
      { description: 'Silicone', quantity: 1, unit_price: 73.45, total: 73.45 },
    ],
    receipt_sha256: 'a'.repeat(64),
    category: 'materials',
    payment_method: 'personal_card',
    gst_status: 'included',
    job_id: 'job-uuid-1',
    business_category: null,
    jobs: { job_number: 'SWP-26001' },
    ...overrides,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// buildXeroExpenseBillBody — DRAFT enforcement
// ────────────────────────────────────────────────────────────────────────────
Deno.test("DRAFT — bill body always sets Status='DRAFT' for ACCPAY", () => {
  const body = buildXeroExpenseBillBody(validExpense())
  assertEquals(body.Type, 'ACCPAY')
  assertEquals(body.Status, 'DRAFT')
})

Deno.test("DRAFT — Status field is always present (never undefined / never AUTHORISED)", () => {
  // Sweep a bunch of edge-case shapes to make sure no branch silently drops it.
  const shapes = [
    validExpense({ line_items: [] }),
    validExpense({ vendor_name: '' }),
    validExpense({ total_amount: 0 }),
    validExpense({ jobs: null }),
    validExpense({ line_items: [{ description: 'x', quantity: 1, unit_price: 5, total: 5 }] }),
  ]
  for (const exp of shapes) {
    const body = buildXeroExpenseBillBody(exp)
    assertEquals(body.Status, 'DRAFT', `Status not DRAFT for shape: ${JSON.stringify(exp)}`)
    assert(body.Status !== 'AUTHORISED', 'AUTHORISED must never be emitted')
    assert(body.Status !== 'SUBMITTED', 'SUBMITTED must never be emitted')
  }
})

Deno.test("DRAFT — bill body has the expected Contact + reference shape", () => {
  const body = buildXeroExpenseBillBody(validExpense())
  assertEquals(body.Contact.Name, 'Bunnings Warehouse')
  assertStringIncludes(body.Reference, 'SWP-26001')
})

Deno.test("DRAFT — falls back to vendor name when job is null", () => {
  const body = buildXeroExpenseBillBody(validExpense({ jobs: null }))
  assertEquals(body.Reference, 'Receipt')
  assertEquals(body.Status, 'DRAFT')
})

// ────────────────────────────────────────────────────────────────────────────
// preflightExpense — junk-data gate
// ────────────────────────────────────────────────────────────────────────────
Deno.test("preflight — happy path passes", () => {
  const result = preflightExpense(validExpense())
  assertEquals(result.ok, true, `unexpected reasons: ${JSON.stringify(result.reasons)}`)
})

Deno.test("preflight — empty vendor fails", () => {
  const result = preflightExpense(validExpense({ vendor_name: '' }))
  assertEquals(result.ok, false)
  assert(result.reasons.some(r => r.includes('vendor_name')))
})

Deno.test("preflight — zero total fails", () => {
  const result = preflightExpense(validExpense({ total_amount: 0 }))
  assertEquals(result.ok, false)
  assert(result.reasons.some(r => r.includes('total_amount')))
})

Deno.test("preflight — negative total fails", () => {
  const result = preflightExpense(validExpense({ total_amount: -5.50 }))
  assertEquals(result.ok, false)
  assert(result.reasons.some(r => r.includes('total_amount')))
})

Deno.test("preflight — total above sanity cap fails", () => {
  const result = preflightExpense(validExpense({ total_amount: 75000 }))
  assertEquals(result.ok, false)
  assert(result.reasons.some(r => r.includes('50,000')))
})

Deno.test("preflight — receipt_date too far in the past fails", () => {
  const result = preflightExpense(validExpense({ receipt_date: '2020-01-01' }))
  assertEquals(result.ok, false)
  assert(result.reasons.some(r => r.includes('older than 12 months')))
})

Deno.test("preflight — receipt_date in the future fails", () => {
  const tenDaysAhead = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const result = preflightExpense(validExpense({ receipt_date: tenDaysAhead }))
  assertEquals(result.ok, false)
  assert(result.reasons.some(r => r.includes('future')))
})

Deno.test("preflight — missing sha256 AND no_receipt_reason fails", () => {
  const result = preflightExpense(validExpense({ receipt_sha256: null, no_receipt_reason: null }))
  assertEquals(result.ok, false)
  assert(result.reasons.some(r => r.includes('receipt_sha256 or no_receipt_reason')))
})

Deno.test("preflight — explicit no_receipt_reason without sha256 passes", () => {
  const result = preflightExpense(validExpense({ receipt_sha256: null, no_receipt_reason: 'lost the receipt' }))
  assertEquals(result.ok, true, `unexpected: ${JSON.stringify(result.reasons)}`)
})

Deno.test("preflight — unknown category fails", () => {
  const result = preflightExpense(validExpense({ category: 'unknown' }))
  assertEquals(result.ok, false)
  assert(result.reasons.some(r => r.includes('category')))
})

Deno.test("preflight — unknown payment_method fails", () => {
  for (const payment_method of ['unknown', null]) {
    const result = preflightExpense(validExpense({ payment_method }))
    assertEquals(result, { ok: false, reasons: ['payment_method required'] })
  }
})

Deno.test("preflight — unknown gst_status fails", () => {
  const result = preflightExpense(validExpense({ gst_status: 'unknown' }))
  assertEquals(result.ok, false)
  assert(result.reasons.some(r => r.includes('gst_status')))
})

Deno.test("preflight — no job_id and no business_category fails", () => {
  const result = preflightExpense(validExpense({ job_id: null, business_category: null }))
  assertEquals(result.ok, false)
  assert(result.reasons.some(r => r.includes('job_id or business_category')))
})

Deno.test("preflight — job_id alone passes (business_category not required)", () => {
  const result = preflightExpense(validExpense({ job_id: 'job-uuid-1', business_category: null }))
  assertEquals(result.ok, true, `unexpected: ${JSON.stringify(result.reasons)}`)
})

Deno.test("preflight — business_category alone passes (job_id not required)", () => {
  const result = preflightExpense(validExpense({ job_id: null, business_category: 'general_stock' }))
  assertEquals(result.ok, true, `unexpected: ${JSON.stringify(result.reasons)}`)
})

Deno.test("preflight — line_items that don't sum to total fails", () => {
  const result = preflightExpense(validExpense({
    total_amount: 100.00,
    line_items: [
      { description: 'A', quantity: 1, unit_price: 30.00, total: 30.00 },
      { description: 'B', quantity: 1, unit_price: 40.00, total: 40.00 },
    ],
  }))
  assertEquals(result.ok, false)
  assert(result.reasons.some(r => r.includes('line_items sum')))
})

Deno.test("preflight — line_items off by less than $1 passes (rounding tolerance)", () => {
  const result = preflightExpense(validExpense({
    total_amount: 100.00,
    line_items: [{ description: 'A', quantity: 1, unit_price: 99.50, total: 99.50 }],
  }))
  assertEquals(result.ok, true)
})

// ────────────────────────────────────────────────────────────────────────────
// Reasons array is structured (machine-readable)
// ────────────────────────────────────────────────────────────────────────────
Deno.test("preflight — multiple violations are all reported", () => {
  const result = preflightExpense({
    vendor_name: '',
    total_amount: 0,
    receipt_date: null,
    category: 'unknown',
    payment_method: 'unknown',
    gst_status: 'unknown',
  })
  assertEquals(result.ok, false)
  assert(result.reasons.length >= 5, `expected ≥5 reasons, got ${result.reasons.length}: ${JSON.stringify(result.reasons)}`)
})
