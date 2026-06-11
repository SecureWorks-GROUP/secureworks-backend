// Tests for the scope_ref_mismatch guard in ghl-proxy (action=save_scope).
//
// What's under test:
//   - isRealJobRef(value): decides whether a scope's embedded ref is a REAL,
//     assigned job number (SWP-25001 / SWF-26002 …) versus a draft/local/blank
//     ref the tool uses before a job number is assigned.
//   - shouldRejectSave(incomingRef, targetJobNumber): the exact boolean the
//     save_scope handler uses to decide whether to return 409 scope_ref_mismatch.
//
// Why: the previous guard rejected ANY non-empty incoming ref that differed from
// the target job_number, which fired on the NORMAL first-save flow (scoper builds
// under a draft/local ref, system assigns SWP, refs differ) and wrongly blocked
// legitimate sign-offs (Marnin hit this 2026-06-11). Genuine cross-job saves
// (real SWP-A scope -> different real SWP-B) must still be rejected.
//
// Mission: secureworks-wiki scope-save-login-fixes-2026-06-11.
//
// Convention: helpers are mirrored inline rather than imported (matches
// salesperson_assign_test.ts / expense_draft_test.ts). Drift between the mirror
// and the real definition in index.ts is caught at PR review.
//
// No network. No live Supabase.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"

// ────────────────────────────────────────────────────────────────────────────
// Mirror of normalizeIdentity + isRealJobRef from ghl-proxy/index.ts, plus the
// guard's reject condition expressed as a pure helper.
// ────────────────────────────────────────────────────────────────────────────
function normalizeIdentity(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function isRealJobRef(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /^SW[PF]?-?\d/i.test(value.trim())
}

// Mirror of the save_scope guard's reject condition (index.ts ~line 1604).
function shouldRejectSave(incomingRef: unknown, targetJobNumber: unknown): boolean {
  return (
    isRealJobRef(incomingRef) &&
    isRealJobRef(targetJobNumber) &&
    normalizeIdentity(incomingRef) !== normalizeIdentity(targetJobNumber)
  )
}

// ── isRealJobRef ────────────────────────────────────────────────────────────

Deno.test('isRealJobRef: real SWP/SWF numbers → true', () => {
  assertEquals(isRealJobRef('SWP-25001'), true)
  assertEquals(isRealJobRef('SWF-26002'), true)
  assertEquals(isRealJobRef('swp-25001'), true) // case-insensitive
  assertEquals(isRealJobRef('SWP25001'), true)  // no dash (tolerant)
  assertEquals(isRealJobRef('SW-3100'), true)   // no type prefix (tolerant)
  assertEquals(isRealJobRef(' SWP-25001 '), true) // surrounding whitespace
})

Deno.test('isRealJobRef: draft / local / blank / non-SWP refs → false', () => {
  assertEquals(isRealJobRef('draft-abc123'), false)
  assertEquals(isRealJobRef('local'), false)
  assertEquals(isRealJobRef(''), false)
  assertEquals(isRealJobRef('   '), false)
  assertEquals(isRealJobRef(null), false)
  assertEquals(isRealJobRef(undefined), false)
  assertEquals(isRealJobRef('SWP-'), false)        // prefix only, no digit
  assertEquals(isRealJobRef('opp_7f3a9'), false)   // bare contact/opportunity id
  assertEquals(isRealJobRef('John Smith Patio'), false)
})

// ── shouldRejectSave (the guard) ────────────────────────────────────────────

Deno.test('guard: draft ref → assigned SWP is ALLOWED (the bug that blocked Marnin)', () => {
  // Normal first-save flow: scope built under a draft ref, job just got SWP.
  assertEquals(shouldRejectSave('draft-xyz', 'SWP-26133'), false)
  assertEquals(shouldRejectSave('local-7f3a', 'SWF-26002'), false)
})

Deno.test('guard: blank / missing incoming ref is ALLOWED', () => {
  assertEquals(shouldRejectSave('', 'SWP-26133'), false)
  assertEquals(shouldRejectSave(null, 'SWP-26133'), false)
  assertEquals(shouldRejectSave(undefined, 'SWP-26133'), false)
})

Deno.test('guard: genuine cross-job save (real SWP-A → real SWP-B) is REJECTED', () => {
  assertEquals(shouldRejectSave('SWP-25001', 'SWP-26133'), true)
  assertEquals(shouldRejectSave('SWF-25010', 'SWF-26002'), true)
  assertEquals(shouldRejectSave('SWP-25001', 'SWF-26002'), true) // cross-type too
})

Deno.test('guard: same real SWP (re-save) is ALLOWED', () => {
  assertEquals(shouldRejectSave('SWP-26133', 'SWP-26133'), false)
  assertEquals(shouldRejectSave('swp-26133', 'SWP-26133'), false) // normalize matches
  assertEquals(shouldRejectSave('SWP26133', 'SWP-26133'), false)  // dash-insensitive match
})

Deno.test('guard: real incoming SWP but target has no real number yet is ALLOWED', () => {
  // Defensive: if the target job_number is somehow draft/blank, do not reject.
  assertEquals(shouldRejectSave('SWP-25001', ''), false)
  assertEquals(shouldRejectSave('SWP-25001', 'draft-target'), false)
})
