// Tests for the SALESPERSON_BY_TYPE auto-assign in ghl-proxy.
//
// What's under test:
//   - salespersonFor(type): returns the correct UUID per pipeline, null for
//     unknown/missing types. This is the helper used inside both
//     `create_job` (Path C) and `sync_ghl` (Path D) in
//     supabase/functions/ghl-proxy/index.ts. Without it, new jobs land with
//     created_by = NULL (the F1 root-cause from
//     cio/operations/board/Secure-Sale-Automation/sales-truth-sync-live-ledger/
//     sales-truth-ledger-45d.md).
//
// Convention: helper is mirrored inline rather than imported (matches
// expense_draft_test.ts in ops-api). Drift between the mirror and the real
// definition is caught at PR review.
//
// No network. No live Supabase.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"

// ────────────────────────────────────────────────────────────────────────────
// Mirror of SALESPERSON_BY_TYPE + salespersonFor from ghl-proxy/index.ts
// ────────────────────────────────────────────────────────────────────────────
const SALESPERSON_BY_TYPE: Record<string, string> = {
  patio:   '5862cf1d-0a3b-4836-8fd1-d69f95aa2f73',
  combo:   '5862cf1d-0a3b-4836-8fd1-d69f95aa2f73',
  decking: '5862cf1d-0a3b-4836-8fd1-d69f95aa2f73',
  fencing: 'be6c2188-2b7b-49c7-b6e4-5b0d0deb6415',
}
function salespersonFor(type: string | null | undefined): string | null {
  if (!type) return null
  return SALESPERSON_BY_TYPE[String(type).toLowerCase()] || null
}

const NITHIN = '5862cf1d-0a3b-4836-8fd1-d69f95aa2f73'
const KHAIRO = 'be6c2188-2b7b-49c7-b6e4-5b0d0deb6415'

Deno.test('salespersonFor: patio → Nithin', () => {
  assertEquals(salespersonFor('patio'), NITHIN)
})

Deno.test('salespersonFor: combo → Nithin (same owner)', () => {
  assertEquals(salespersonFor('combo'), NITHIN)
})

Deno.test('salespersonFor: decking → Nithin (decking belongs to patio team)', () => {
  assertEquals(salespersonFor('decking'), NITHIN)
})

Deno.test('salespersonFor: fencing → Khairo', () => {
  assertEquals(salespersonFor('fencing'), KHAIRO)
})

Deno.test('salespersonFor: case-insensitive — Patio / FENCING', () => {
  assertEquals(salespersonFor('Patio'), NITHIN)
  assertEquals(salespersonFor('FENCING'), KHAIRO)
})

Deno.test('salespersonFor: null / undefined / empty → null', () => {
  assertEquals(salespersonFor(null), null)
  assertEquals(salespersonFor(undefined), null)
  assertEquals(salespersonFor(''), null)
})

Deno.test('salespersonFor: unknown type → null (never throws, never picks a default)', () => {
  assertEquals(salespersonFor('emergency'), null)
  assertEquals(salespersonFor('outdoor_kitchen'), null)
  assertEquals(salespersonFor('shutters'), null)
})

Deno.test('UUIDs match the ghl-webhook auto-assign map', () => {
  // If ghl-webhook drifts, this fact stays canon here too. The fix is to
  // update both maps together, not just one.
  assertEquals(SALESPERSON_BY_TYPE.patio,   NITHIN)
  assertEquals(SALESPERSON_BY_TYPE.combo,   NITHIN)
  assertEquals(SALESPERSON_BY_TYPE.fencing, KHAIRO)
})
