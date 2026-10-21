// deno-lint-ignore-file no-import-prefix

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { marginHoldOf, quotedCostsGpOf } from './margin_hold.ts'

Deno.test('marginHoldOf — older quotes with a stated margin are not held (live reports unchanged)', () => {
  assertEquals(marginHoldOf({ margin_pct: 39, totalIncGST: 11000 }), null)
  assertEquals(marginHoldOf({ margin_pct: 30, internal: { costs_complete: true, commission: 600 } }), null)
  assertEquals(marginHoldOf(null), null)
  assertEquals(marginHoldOf('{"margin_pct":30}'), null)
})

Deno.test('marginHoldOf — a selected target is held, with or without its basis marker', () => {
  assertEquals(marginHoldOf({ margin_pct: 39, margin_basis: 'selected_target' }), 'selected_target')
  assertEquals(marginHoldOf({ tool: 'patio-scoper', version: '2.0', margin_pct: 39 }), 'selected_target')
})

Deno.test('marginHoldOf — an unset commission is held', () => {
  assertEquals(marginHoldOf({ margin_pct: null, internal: { commission: null, commission_basis: 'not_set' } }), 'commission_not_set')
})

Deno.test('quotedCostsGpOf — gross profit from the quote\'s own costs, only when every cost is known', () => {
  assertEquals(quotedCostsGpOf({ totalExGST: 1000, internal: { costs_complete: true, cost: 600 } }), 0.4)
  assertEquals(quotedCostsGpOf({ totalExGST: 1000, margin_pct: 39, internal: { costs_complete: false, cost: 600 } }), null)
  assertEquals(quotedCostsGpOf({ totalExGST: 1000, internal: { costs_complete: true, cost: null } }), null)
  assertEquals(quotedCostsGpOf({ totalExGST: 0, internal: { costs_complete: true, cost: 0 } }), null)
  assertEquals(quotedCostsGpOf({ totalExGST: 1000, internal: { costs_complete: true, cost: 1200 } }), null)
  assertEquals(quotedCostsGpOf({ margin_pct: 39 }), null)
})
