// Hash-determinism regression tests for the recursive canonicalize + SHA-256
// pattern. These tests pin down the broken-pattern guard: any patch that
// silently drops back to JSON.stringify(obj, Object.keys(obj).sort()) will
// fail at least one of the deep-sort cases below.

import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts"
import { canonicalize, jsonHash } from "./canonicalize.ts"

Deno.test("canonicalize — empty object returns empty object", () => {
  assertEquals(JSON.stringify(canonicalize({})), '{}')
})

Deno.test("canonicalize — shallow object: reordered keys hash identically", async () => {
  const a = { b: 2, a: 1, c: 3 }
  const b = { c: 3, a: 1, b: 2 }
  assertEquals(await jsonHash(a), await jsonHash(b))
})

Deno.test("canonicalize — deeply nested object: reordered keys at every depth hash identically (regression case)", async () => {
  const a = {
    pricing: { totals: { gst: 100, total_inc_gst: 1100, total_ex_gst: 1000 }, lines: [{ qty: 1, desc: 'x' }] },
    customer: { mobile: '0411', email: 'a@b', name: 'X' },
    site: { suburb: 'Perth', address: '1 Test St' },
  }
  const b = {
    site: { address: '1 Test St', suburb: 'Perth' },
    customer: { name: 'X', email: 'a@b', mobile: '0411' },
    pricing: { lines: [{ desc: 'x', qty: 1 }], totals: { total_ex_gst: 1000, total_inc_gst: 1100, gst: 100 } },
  }
  // Top-level naive sort would tie a.pricing == b.pricing as strings, but the nested
  // totals reorder would give different shallow-stringify output. Recursive form must agree.
  assertEquals(await jsonHash(a), await jsonHash(b))
})

Deno.test("canonicalize — arrays preserve order (different orders hash differently)", async () => {
  const a = { runs: [{ label: 'A' }, { label: 'B' }] }
  const b = { runs: [{ label: 'B' }, { label: 'A' }] }
  assertNotEquals(await jsonHash(a), await jsonHash(b))
})

Deno.test("canonicalize — primitives, null, mixed types pass through unchanged", async () => {
  assertEquals(canonicalize(null), null)
  assertEquals(canonicalize(42), 42)
  assertEquals(canonicalize('hello'), 'hello')
  assertEquals(canonicalize(true), true)
  // Mixed nested
  const mixed = { x: null, y: [1, 'two', null, true], z: { inner: 0 } }
  const repacked = canonicalize(mixed) as Record<string, unknown>
  assertEquals(repacked.x, null)
  assertEquals((repacked.y as unknown[])[0], 1)
  assertEquals((repacked.y as unknown[])[2], null)
})

Deno.test("jsonHash — output is 64-char lowercase hex (SHA-256 contract)", async () => {
  const h = await jsonHash({ a: 1 })
  assertEquals(h.length, 64)
  assert(/^[0-9a-f]{64}$/.test(h), `expected 64-char lowercase hex, got ${h}`)
})

Deno.test("jsonHash — broken-pattern guard: shallow JSON.stringify(obj, keys.sort()) DROPS nested keys not in top-level allowlist", () => {
  // Demonstrates the actual catastrophic failure mode of the broken pattern.
  // When the replacer is an array, it acts as a property-NAME allowlist that
  // applies to EVERY level of the object. Keys at deeper levels that are not
  // in the top-level allowlist are silently dropped — including the entire
  // contents of nested objects whose own keys differ from the top level.
  // Manifest content is essentially lost; hash determinism becomes irrelevant
  // because the inputs collapse to almost nothing.
  const obj = { customer: { name: 'X', email: 'a@b' }, pricing: { totalIncGST: 5500 } }
  const naive = JSON.stringify(obj, Object.keys(obj).sort())
  // 'name', 'email', 'totalIncGST' are not in the top-level allowlist
  // ['customer','pricing'], so they're dropped. The output collapses to:
  assertEquals(naive, '{"customer":{},"pricing":{}}')
  // Recursive canonicalize, by contrast, preserves all data:
  const correct = JSON.stringify(canonicalize(obj))
  assertEquals(correct, '{"customer":{"email":"a@b","name":"X"},"pricing":{"totalIncGST":5500}}')
  assertNotEquals(naive, correct)
})
