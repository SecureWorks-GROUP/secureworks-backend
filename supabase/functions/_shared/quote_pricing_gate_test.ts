import { assertEquals, assertMatch } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { quotePricingGateError } from './quote_pricing_gate.ts'

Deno.test('legacy quote with a total and no flags still sends', () => {
  assertEquals(quotePricingGateError({ totalIncGST: 1000 }), null)
  assertEquals(quotePricingGateError(JSON.stringify({ total: 5 })), null)
  assertEquals(quotePricingGateError({ grandTotal: 5 }), null)
})

Deno.test('complete, sealed quote sends', () => {
  assertEquals(quotePricingGateError({
    totalIncGST: 1000,
    pricing_complete: true,
    sell_to_confirm: [],
    internal: { costs_complete: true, costs_to_confirm: [] },
    revision: { n: 2, code: 'x', sealed: true },
  }), null)
})

Deno.test('unparseable or non-object pricing refuses', () => {
  assertMatch(quotePricingGateError('{not json') ?? '', /missing or invalid/)
  assertMatch(quotePricingGateError('[]') ?? '', /total is zero/)
  assertMatch(quotePricingGateError('"x"') ?? '', /missing or invalid/)
})

Deno.test('failed validation refuses first', () => {
  assertMatch(quotePricingGateError({ totalIncGST: 1000, pricing_validation_passed: false, pricing_complete: false }) ?? '', /failed pricing validation/)
})

Deno.test('sell prices to confirm refuse and are named', () => {
  const err = quotePricingGateError({ totalIncGST: 1000, pricing_complete: false, sell_to_confirm: ['Sliding gate', 'Ground finish'] })
  assertMatch(err ?? '', /Sliding gate, Ground finish/)
})

Deno.test('blank sell entries alone do not refuse', () => {
  assertEquals(quotePricingGateError({ totalIncGST: 1000, sell_to_confirm: ['', '  '] }), null)
})

Deno.test('cost lines with no price refuse with a count', () => {
  assertMatch(quotePricingGateError({ totalIncGST: 1000, internal: { costs_complete: false, costs_to_confirm: ['a', 'b'] } }) ?? '', /2 cost lines with no price/)
  assertMatch(quotePricingGateError({ totalIncGST: 1000, internal: { costs_complete: false, costs_to_confirm: ['a'] } }) ?? '', /1 cost line with no price/)
  assertMatch(quotePricingGateError({ totalIncGST: 1000, internal: { costs_complete: false } }) ?? '', /cost lines with no price/)
})

Deno.test('pricing_complete false refuses on its own', () => {
  assertMatch(quotePricingGateError({ totalIncGST: 1000, pricing_complete: false }) ?? '', /not complete/)
})

Deno.test('unsealed revision refuses; absent revision does not', () => {
  assertMatch(quotePricingGateError({ totalIncGST: 1000, revision: { n: 1, sealed: false } }) ?? '', /sealed revision/)
  assertEquals(quotePricingGateError({ totalIncGST: 1000, revision: { n: 1, sealed: true } }), null)
})

Deno.test('zero total still refuses', () => {
  assertMatch(quotePricingGateError({ totalIncGST: 0, pricing_complete: true }) ?? '', /total is zero/)
  assertMatch(quotePricingGateError(null) ?? '', /total is zero/)
})
