// Tests for buildMinimalReleaseManifest + assertNoBase64DataUri.

import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts"
import {
  assertNoBase64DataUri,
  buildMinimalReleaseManifest,
} from "./build_minimal_manifest.ts"
import { jsonHash } from "./canonicalize.ts"

const baseInput = {
  job_id: 'aa1da77f-1951-4d64-be86-a810781d9813',
  job_document_id: '4e33c01b-99a4-4c00-9ee0-6e7385a94f0b',
  version: 1,
  recipient_email: 'marnin@secureworkswa.com.au',
  recipient_label: null,
  build_kind: 'patio' as const,
  scope: {
    client_name: 'CAP0 TEST',
    site_address: '1 Test St',
    site_suburb: 'Perth',
    job_type: 'patio',
    job_number: 'SWP-26133',
  },
  pricing_json: { totalIncGST: 5500, totalExGST: 5000, gst: 500, items: [] },
  pdf_url: 'https://kevgrhcjxspbxgovpmfl.supabase.co/storage/v1/object/public/job-pdfs/x.pdf',
  released_via: 'send-quote/send' as const,
}

Deno.test("buildMinimalReleaseManifest — totals are extracted from pricing_json", () => {
  const m = buildMinimalReleaseManifest(baseInput)
  assertEquals(m.totals_snapshot.total_inc_gst, 5500)
  assertEquals(m.totals_snapshot.total_ex_gst, 5000)
  assertEquals(m.totals_snapshot.gst, 500)
})

Deno.test("buildMinimalReleaseManifest — sent_at is null at staging time", () => {
  const m = buildMinimalReleaseManifest(baseInput)
  assertEquals(m.sent_at, null)
})

Deno.test("buildMinimalReleaseManifest — build_kind/council_status/neighbours_required pass through", () => {
  const m = buildMinimalReleaseManifest({
    ...baseInput,
    build_kind: 'fence',
    council_status: 'required_pending',
    neighbours_required: true,
  })
  assertEquals(m.build_kind, 'fence')
  assertEquals(m.council_status, 'required_pending')
  assertEquals(m.neighbours_required, true)
})

Deno.test("buildMinimalReleaseManifest — fence runs land in scope_snapshot.runs", () => {
  const m = buildMinimalReleaseManifest({
    ...baseInput,
    build_kind: 'fence',
    scope: {
      ...baseInput.scope,
      runs: [
        { run_label: 'REAR', run_name: 'Rear fence', neighbour_id: null, items_count: 1 },
        { run_label: 'LHS',  run_name: 'Side fence', neighbour_id: 'abc', items_count: 2 },
      ],
    },
  })
  assertEquals(m.scope_snapshot.runs?.length, 2)
  assertEquals(m.scope_snapshot.runs?.[0].run_label, 'REAR')
})

Deno.test("buildMinimalReleaseManifest — pricing_json is captured verbatim under pricing_snapshot.raw", () => {
  const oddPricing = { customField: 'x', items: [{ description: 'y', quantity: 2 }] }
  const m = buildMinimalReleaseManifest({ ...baseInput, pricing_json: oddPricing })
  assertEquals(m.pricing_snapshot.raw, oddPricing)
})

Deno.test("assertNoBase64DataUri — refuses base64 data: URIs in any string field, including nested", () => {
  assertThrows(
    () => assertNoBase64DataUri('data:image/png;base64,AAAA'),
    Error,
    'base64 data URI',
  )
  assertThrows(
    () => assertNoBase64DataUri({ inner: { pdf: 'data:application/pdf;base64,JVBERi0xLjQ' } }),
    Error,
    'base64 data URI',
  )
  // Plain URLs and short strings are fine.
  assertNoBase64DataUri('https://example.com/file.pdf')
  assertNoBase64DataUri({ a: 1, b: 'plain', c: { d: ['e'] } })
})

Deno.test("buildMinimalReleaseManifest — refuses to build if any string field is base64", () => {
  assertThrows(
    () =>
      buildMinimalReleaseManifest({
        ...baseInput,
        pdf_url: 'data:application/pdf;base64,JVBERi0xLjQ',
      }),
    Error,
    'base64 data URI',
  )
})

Deno.test("buildMinimalReleaseManifest — manifest hash is deterministic across two builds with same input (modulo captured_at)", async () => {
  // captured_at is set to now() each call; for hash determinism we strip it
  // before hashing in this test. The release-packet integration freezes
  // captured_at via the input timestamp at the call site; this test just
  // pins the recursive canonicalize behaviour for everything else.
  const a = buildMinimalReleaseManifest(baseInput)
  const b = buildMinimalReleaseManifest(baseInput)
  // Replace the volatile captured_at with a fixed value for both
  const aFrozen = { ...a, captured_at: '2026-04-30T00:00:00Z' }
  const bFrozen = { ...b, captured_at: '2026-04-30T00:00:00Z' }
  assertEquals(await jsonHash(aFrozen), await jsonHash(bFrozen))
})

Deno.test("buildMinimalReleaseManifest — different input produces different hash", async () => {
  const a = { ...buildMinimalReleaseManifest(baseInput), captured_at: '2026-04-30T00:00:00Z' }
  const b = {
    ...buildMinimalReleaseManifest({ ...baseInput, recipient_email: 'other@example.com' }),
    captured_at: '2026-04-30T00:00:00Z',
  }
  assert((await jsonHash(a)) !== (await jsonHash(b)), 'hash should differ when recipient changes')
})
