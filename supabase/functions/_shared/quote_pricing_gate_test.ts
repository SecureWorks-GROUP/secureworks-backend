import { assertEquals, assertMatch } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { canonicalJsonAndHash } from './release_packet/canonicalize.ts'
import {
  FROZEN_REVISION_MISMATCH_ERROR,
  FROZEN_REVISION_REQUIRED_ERROR,
  FROZEN_REVISION_UNREADABLE_ERROR,
  quoteFrozenRevisionGateError,
  quotePricingGateError,
} from './quote_pricing_gate.ts'

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

// ── Frozen revision gate ──

const sealed = { totalIncGST: 1000, pricing_complete: true, revision: { n: 1, code: 'ABC', sealed: true } }

Deno.test('frozen gate: pricing with no sealed revision is not asked for a frozen row', async () => {
  let reads = 0
  const reader = () => { reads++; return Promise.resolve({ rows: [], error: null }) }
  assertEquals(await quoteFrozenRevisionGateError(reader, 'job-1', { totalIncGST: 1000 }), null)
  assertEquals(await quoteFrozenRevisionGateError(reader, 'job-1', { totalIncGST: 1000, revision: { n: 1, sealed: false } }), null)
  assertEquals(reads, 0)
})

Deno.test('frozen gate: a sealed revision with no frozen row refuses', async () => {
  const reader = () => Promise.resolve({ rows: [], error: null })
  assertEquals(await quoteFrozenRevisionGateError(reader, 'job-1', sealed), FROZEN_REVISION_REQUIRED_ERROR)
  assertEquals(await quoteFrozenRevisionGateError(reader, null, sealed), FROZEN_REVISION_REQUIRED_ERROR)
})

Deno.test('frozen gate: a frozen row holding other pricing refuses', async () => {
  const other = await canonicalJsonAndHash({ ...sealed, totalIncGST: 999 })
  const reader = () => Promise.resolve({ rows: [{ pricing_hash: other.hash }], error: null })
  assertEquals(await quoteFrozenRevisionGateError(reader, 'job-1', sealed), FROZEN_REVISION_MISMATCH_ERROR)
})

Deno.test('frozen gate: a read error or throw fails closed', async () => {
  assertEquals(await quoteFrozenRevisionGateError(() => Promise.resolve({ rows: null, error: { message: 'x' } }), 'job-1', sealed), FROZEN_REVISION_UNREADABLE_ERROR)
  assertEquals(await quoteFrozenRevisionGateError(() => Promise.reject(new Error('down')), 'job-1', sealed), FROZEN_REVISION_UNREADABLE_ERROR)
})

Deno.test('frozen gate: the matching frozen row passes, key order does not matter', async () => {
  const frozen = await canonicalJsonAndHash({ revision: { sealed: true, code: 'ABC', n: 1 }, pricing_complete: true, totalIncGST: 1000 })
  const reader = () => Promise.resolve({ rows: [{ pricing_hash: frozen.hash }], error: null })
  assertEquals(await quoteFrozenRevisionGateError(reader, 'job-1', sealed), null)
})
