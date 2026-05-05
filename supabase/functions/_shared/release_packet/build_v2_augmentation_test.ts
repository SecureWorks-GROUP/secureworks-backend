// Cap 0 V2 — Loop 3 augmentation helper persistence tests.
//
// Binding evidence for the T7 compatibility fix: the V2 envelope's
// manifest_canonical_text MUST be uploaded to the private release-manifests
// bucket alongside internal_cost_canonical_text. Without this, the sealed
// event's manifest_hash has no bytes to verify against and T7's
// evidence-spine read path cannot honour citations by V2 hash.

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { buildV2Augmentation, type V2AugmentationInput } from './build_v2_augmentation.ts'

type Upload = { object_path: string; bytes: Uint8Array; contentType: string }

function makeFakeSb() {
  const uploads: Upload[] = []
  const fakeSb = {
    storage: {
      from(_bucket: string) {
        return {
          upload(object_path: string, bytes: Uint8Array, opts: any) {
            uploads.push({ object_path, bytes, contentType: opts?.contentType ?? '' })
            return Promise.resolve({ error: null })
          },
        }
      },
    },
  }
  return { fakeSb, uploads }
}

function fixtureInput(release_id: string): V2AugmentationInput {
  // Minimum viable patio job that the dispatcher will route to the patio adapter.
  // Pricing reconciles to a single shared client line; per_contact splits map
  // to the single primary contact so the adapter does not emit the sentinel.
  return {
    release_id,
    job_id: '11111111-1111-1111-1111-111111111111',
    version: 1,
    released_via: 'send-quote/send',
    released_at: '2026-05-02T00:00:00.000Z',
    released_by_user_id: null,
    job_row: {
      id: '11111111-1111-1111-1111-111111111111',
      type: 'patio',
      org_id: '00000000-0000-0000-0000-000000000001',
      client_name: 'CAP0 V2 augmentation persistence test',
      client_email: 'qa@example.com',
      client_phone: '+61400000000',
      site_address: '123 Test Street',
      site_suburb: 'Perth',
      site_lat: null,
      site_lng: null,
      job_number: 'SWP-99999',
      ghl_contact_id: null,
      xero_contact_id: null,
      scope_json: {
        patio: {
          structure_type: 'flat',
          attached: true,
          dimensions_mm: { length: 6000, width: 3000, height: 2700 },
          posts: { count: 4, spec: '90x90 SHS' },
          beams: { spec: '150x50x2 RHS' },
          panels: { thickness_mm: 75, finish: 'Surfmist' },
          roof_pitch_deg: 2,
          gutter: { type: 'box', colour: 'Surfmist' },
          downpipes: 1,
          footings: { spec: '400x400x500' },
          fixings: { type: 'fascia_bracket' },
          existing_structure_demo: false,
          council_required: false,
          neighbour_required: false,
        },
      },
      pricing_json: {
        currency: 'AUD',
        gst_rate: 0.1,
        line_items: [
          {
            line_id: 'L1',
            description: 'Patio supply + install',
            qty: 1,
            unit: 'job',
            unit_price_ex: 10000,
            line_total_ex: 10000,
            allocation: 'client',
            split_pct: 100,
          },
        ],
        totals: { subtotal_ex_gst: 10000, gst: 1000, total_inc_gst: 11000 },
        per_contact: [
          { contact_id: 'c-primary-uuid-fixture', total_ex_gst: 10000, total_inc_gst: 11000, total_gst: 1000 },
        ],
        internal: {
          line_costs: [
            { line_id: 'L1', material_cost_ex: 4000, supplier_name: 'Bondor' },
          ],
          cost_estimates: { labour_ex: 2000, transport_ex: 500, other_ex: 0 },
          margin: { gross_pct: 25, floor_breached: false, override_reason: null },
          commission: { rule: 'patio_standard', amount: 500 },
        },
      },
      notes: 'fixture',
    },
    contacts: [{
      id: 'c-primary-uuid-fixture',
      contact_type: 'primary',
      is_primary: true,
      contact_label: 'A',
      client_name: 'Primary',
      client_email: 'qa@example.com',
      client_phone: '+61400000000',
      assigned_runs: null,
      share_percentage: 100,
    }],
    media: [],
    quote_pdf_url: 'https://example.com/q.pdf',
    quote_pdf_size_bytes: 1024,
    email_subject: 'Your quote',
    email_custom_message: 'Thanks for your time. Quote attached.',
    email_template_version: 'v1',
    scoper_name: 'CAP0 Verifier',
    resend_message_id: 'resend-fixture',
    primary_recipient_email: 'qa@example.com',
    per_contact_pdfs: [],
    terms_valid_days: 30,
    terms_payment_terms: 'net_7',
    terms_deposit_pct: 30,
    scoper_user_id: null,
    scoper_user_name: 'CAP0 Verifier',
    scoped_at: '2026-05-02T00:00:00.000Z',
    override_operator_allowlist: [],
    pdf_sha256: 'a'.repeat(64),
    email_html_sha256: 'b'.repeat(64),
  }
}

Deno.test('T7-A — buildV2Augmentation uploads BOTH manifest and internal_cost canonical texts', async () => {
  const { fakeSb, uploads } = makeFakeSb()
  const input = fixtureInput('22222222-2222-2222-2222-222222222222')
  const result = await buildV2Augmentation(fakeSb, input)
  assert(result.ok, `expected augmentation ok=true, got: ${JSON.stringify(result)}`)
  if (!result.ok) return

  // Two hash-keyed uploads to the bucket: <manifest_hash>.json and
  // <internal_cost_hash>.json. Order is deterministic (manifest first,
  // internal cost second) — see buildV2Augmentation step 4.
  assertEquals(uploads.length, 2, 'expected exactly 2 uploads')
  assertEquals(uploads[0].object_path, `${result.manifest_hash}.json`)
  assertEquals(uploads[1].object_path, `${result.internal_cost_hash}.json`)
  assertEquals(uploads[0].contentType, 'application/json')
  assertEquals(uploads[1].contentType, 'application/json')

  // The bytes uploaded for the manifest must equal the canonical text the
  // helper exposes — that's the contract T7 relies on.
  const manifestBytes = new TextDecoder().decode(uploads[0].bytes)
  assertEquals(manifestBytes, result.manifest_canonical_text)

  // Hashes are non-empty hex strings of the expected length.
  assertEquals(result.manifest_hash.length, 64)
  assertEquals(result.internal_cost_hash.length, 64)

  // The two hashes must differ (different envelopes).
  assert(result.manifest_hash !== result.internal_cost_hash)
})

Deno.test('T7-B — V2AugmentationResult surfaces manifest_canonical_text for caller verification', async () => {
  const { fakeSb } = makeFakeSb()
  const input = fixtureInput('33333333-3333-3333-3333-333333333333')
  const result = await buildV2Augmentation(fakeSb, input)
  assert(result.ok)
  if (!result.ok) return

  // Caller must be able to read the bytes that were hashed. Used by
  // send-quote/ops-api logging and by future T7 verification tests.
  assert(typeof result.manifest_canonical_text === 'string')
  assert(result.manifest_canonical_text.length > 0)
})

Deno.test('SR-A — buildV2Augmentation echoes scope_revision_id back through the result and into the canonical text', async () => {
  const REV_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const { fakeSb, uploads } = makeFakeSb()
  const input = { ...fixtureInput('55555555-5555-5555-5555-555555555555'), scope_revision_id: REV_ID }
  const result = await buildV2Augmentation(fakeSb, input)
  assert(result.ok)
  if (!result.ok) return
  // Top-level result echoes the value the caller will forward to emitV2SealedEvent.
  assertEquals(result.scope_revision_id, REV_ID)
  // Canonical bytes the bucket received include the citation verbatim.
  const manifestBytes = new TextDecoder().decode(uploads[0].bytes)
  assert(manifestBytes.includes(`"scope_revision_id":"${REV_ID}"`),
    'manifest canonical text must contain the cited scope_revision_id')
})

Deno.test('SR-B — buildV2Augmentation tolerates a missing scope_revision_id (Quick Quote / pre-step-6)', async () => {
  const { fakeSb, uploads } = makeFakeSb()
  // Note: omitting scope_revision_id from the input — the field is optional
  // on V2AugmentationInput so this exercises the default-null path that
  // ops-api Quick Quote and pre-step-6 send-quote callers exercise today.
  const input = fixtureInput('66666666-6666-6666-6666-666666666666')
  const result = await buildV2Augmentation(fakeSb, input)
  assert(result.ok)
  if (!result.ok) return
  assertEquals(result.scope_revision_id, null)
  const manifestBytes = new TextDecoder().decode(uploads[0].bytes)
  assert(manifestBytes.includes('"scope_revision_id":null'),
    'manifest canonical text must serialize scope_revision_id as null when not supplied')
})

Deno.test('T7-C — Storage upload failure does NOT block the augmentation result', async () => {
  // Best-effort upload contract: V2 column values must still come back
  // even if the bucket is unhappy. Loop 3 stays soft-warn — Loop 4 may
  // promote upload failure to a hard-block, out of scope here.
  const failingSb = {
    storage: {
      from(_bucket: string) {
        return {
          upload(_path: string, _bytes: Uint8Array, _opts: any) {
            return Promise.resolve({ error: { message: 'simulated bucket failure' } })
          },
        }
      },
    },
  }
  const input = fixtureInput('44444444-4444-4444-4444-444444444444')
  const result = await buildV2Augmentation(failingSb, input)
  assert(result.ok, 'augmentation must still succeed when uploads fail')
})
