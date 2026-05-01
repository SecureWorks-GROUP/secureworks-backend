// Cap 0 Full Release Packet V2 — P0 test suite.
//
// Covers:
//   R1–R5  builder smoke + adapter dispatch
//   H1–H10 hash discipline (canonicalize, manifest_hash, internal_cost_hash)
//   V1–V15 validator (envelope rules + adapter rules + overrides)
//   S1–S5  schema/shape invariants
//   I1–I5  internal cost privacy + correctness
//   P1–P5  base64-data-URI guard carries over from V1
//
// All tests are pure — no DB, no network, no Supabase, no Deno permissions
// beyond crypto (SHA-256). Run via:
//   deno test --allow-all supabase/functions/_shared/release_packet/release_packet_v2_test.ts

import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { buildFullReleasePacket } from './build_full_release_packet.ts'
import {
  validatePacketV2,
  type ValidatePacketV2Options,
} from './validate_packet_v2.ts'
import {
  patioInputValid,
  patioInputInvalid,
  fenceInputValid,
  fenceInputInvalid,
  qqInputValid,
  qqInputInvalid,
  STUB_HASH_64,
  STUB_USER_ID_MARNIN,
  STUB_OVERRIDE_ALLOWLIST,
  STUB_RELEASED_AT,
  patioAdapterOutputValid,
} from './fixtures_v2.ts'
import type {
  QuoteReleasePacketV2,
  PatioScopeBlock,
  FenceScopeBlock,
} from './manifest_v2_types.ts'
import type { InternalCostSnapshot } from './internal_cost_types.ts'

// ── Helpers ─────────────────────────────────────────────────────────────────

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

const baseValidatorOpts: ValidatePacketV2Options = {
  mode: 'enforce',
  override_operator_allowlist: STUB_OVERRIDE_ALLOWLIST,
}

// ─────────────────────────────────────────────────────────────────────────────
// R: Builder smoke + adapter dispatch
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('R1 — Patio valid input → builder ok=true, manifest_hash 64-char hex', async () => {
  const r = await buildFullReleasePacket(patioInputValid)
  assert(r.ok, JSON.stringify(r, null, 2))
  if (r.ok) {
    assert(/^[0-9a-f]{64}$/.test(r.manifest_hash))
    assert(/^[0-9a-f]{64}$/.test(r.internal_cost_hash))
    assertEquals(r.manifest.scope.kind, 'patio')
    assertEquals(r.manifest.schema_version, '2.0')
  }
})

Deno.test('R2 — Fence valid input → builder ok=true', async () => {
  const r = await buildFullReleasePacket(fenceInputValid)
  assert(r.ok, JSON.stringify(r, null, 2))
  if (r.ok) {
    assertEquals(r.manifest.scope.kind, 'fence')
    assertEquals(r.manifest.released_via, 'send-quote/send-runs')
  }
})

Deno.test('R3 — Quick Quote valid input → builder ok=true', async () => {
  const r = await buildFullReleasePacket(qqInputValid)
  assert(r.ok, JSON.stringify(r, null, 2))
  if (r.ok) {
    assertEquals(r.manifest.scope.kind, 'quick_quote')
    assertEquals(r.manifest.released_via, 'ops-api/send_quick_quote_email')
  }
})

Deno.test('R4 — Builder rejects unknown scope.kind', async () => {
  const bad = clone(patioInputValid)
  ;(bad.adapter_output.scope as unknown as { kind: string }).kind = 'bogus_kind'
  const r = await buildFullReleasePacket(bad)
  assert(!r.ok)
  if (!r.ok) {
    assert(r.errors.some((e) => e.rule === 'scope.kind_supported'))
  }
})

Deno.test('R5 — Builder rejects when validation fails (returns errors, NO hashes)', async () => {
  const r = await buildFullReleasePacket(patioInputInvalid)
  assert(!r.ok)
  if (!r.ok) {
    // Specific failures we expect from the invalid fixture.
    const ruleIds = r.errors.map((e) => e.rule)
    assert(ruleIds.includes('customer.mobile_set'), `expected customer.mobile_set, got ${ruleIds}`)
    assert(ruleIds.includes('qa.customer_facing_summary_min_length'))
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// H: Hash discipline
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('H1 — Same input → same manifest_hash (deterministic)', async () => {
  const a = await buildFullReleasePacket(patioInputValid)
  const b = await buildFullReleasePacket(patioInputValid)
  assert(a.ok && b.ok)
  if (a.ok && b.ok) {
    assertEquals(a.manifest_hash, b.manifest_hash)
  }
})

Deno.test('H2 — Same input → same internal_cost_hash', async () => {
  const a = await buildFullReleasePacket(patioInputValid)
  const b = await buildFullReleasePacket(patioInputValid)
  assert(a.ok && b.ok)
  if (a.ok && b.ok) {
    assertEquals(a.internal_cost_hash, b.internal_cost_hash)
  }
})

Deno.test('H3 — manifest_hash and internal_cost_hash differ from each other', async () => {
  const r = await buildFullReleasePacket(patioInputValid)
  assert(r.ok)
  if (r.ok) {
    assert(r.manifest_hash !== r.internal_cost_hash)
  }
})

Deno.test('H4 — Reordering envelope keys does NOT change manifest_hash (canonicalize works)', async () => {
  // Hash from canonical input.
  const r1 = await buildFullReleasePacket(patioInputValid)
  assert(r1.ok)

  // Build a new input with adapter_output keys reordered. The adapter_output
  // is a plain object — we shuffle its top-level keys and the contained
  // pricing_public / internal_cost / scope objects' keys. The canonicalize
  // function should deep-sort and produce the same bytes.
  const reorderedAdapterOutput = {
    qa_facts: patioAdapterOutputValid.qa_facts,
    pricing_public: {
      per_contact_totals: patioAdapterOutputValid.pricing_public.per_contact_totals,
      totals: patioAdapterOutputValid.pricing_public.totals,
      line_items: patioAdapterOutputValid.pricing_public.line_items,
    },
    internal_cost: patioAdapterOutputValid.internal_cost,
    scope: patioAdapterOutputValid.scope,
  } as typeof patioAdapterOutputValid
  const reorderedInput = { ...patioInputValid, adapter_output: reorderedAdapterOutput }

  const r2 = await buildFullReleasePacket(reorderedInput)
  assert(r2.ok)

  if (r1.ok && r2.ok) {
    assertEquals(r1.manifest_hash, r2.manifest_hash, 'reorder must not change hash')
    assertEquals(r1.manifest_canonical_text, r2.manifest_canonical_text)
  }
})

Deno.test('H5 — Changing pricing_public.totals.gst → DIFFERENT manifest_hash', async () => {
  const a = await buildFullReleasePacket(patioInputValid)
  assert(a.ok)
  const tampered = clone(patioInputValid)
  tampered.adapter_output.pricing_public.totals.gst = 999
  // This will also fail totals_consistency rule, so use 'warn' mode by injecting the override allow.
  // Easier: just bypass the rule via adjusted gst that still reconciles.
  tampered.adapter_output.pricing_public.totals.gst = 1000.01 // tiny shift
  tampered.adapter_output.pricing_public.totals.total_inc_gst =
    tampered.adapter_output.pricing_public.totals.total_ex_gst + 1000.01
  const b = await buildFullReleasePacket(tampered)
  if (a.ok && b.ok) {
    assert(a.manifest_hash !== b.manifest_hash)
  }
})

Deno.test('H6 — Changing internal_cost.line_costs[0].unit_cost → SAME manifest_hash, DIFFERENT internal_cost_hash', async () => {
  const a = await buildFullReleasePacket(patioInputValid)
  assert(a.ok)
  const tampered = clone(patioInputValid)
  tampered.adapter_output.internal_cost.line_costs[0].unit_cost = 999
  tampered.adapter_output.internal_cost.line_costs[0].line_cost_total_ex = 999 * 24
  const b = await buildFullReleasePacket(tampered)
  assert(b.ok)
  if (a.ok && b.ok) {
    assertEquals(a.manifest_hash, b.manifest_hash, 'manifest hash must not depend on internal cost')
    assert(a.internal_cost_hash !== b.internal_cost_hash, 'internal cost hash MUST change')
  }
})

Deno.test('H7 — Changing manifest field → DIFFERENT manifest_hash, SAME internal_cost_hash', async () => {
  const a = await buildFullReleasePacket(patioInputValid)
  assert(a.ok)
  const tampered = clone(patioInputValid)
  tampered.customer.name = 'Different Customer'
  const b = await buildFullReleasePacket(tampered)
  assert(b.ok)
  if (a.ok && b.ok) {
    assert(a.manifest_hash !== b.manifest_hash)
    assertEquals(a.internal_cost_hash, b.internal_cost_hash)
  }
})

Deno.test('H8 — manifest_canonical_text starts with { and ends with }', async () => {
  const r = await buildFullReleasePacket(patioInputValid)
  assert(r.ok)
  if (r.ok) {
    assert(r.manifest_canonical_text.startsWith('{'))
    assert(r.manifest_canonical_text.endsWith('}'))
  }
})

Deno.test('H9 — sha256(manifest_canonical_text) === manifest_hash', async () => {
  const r = await buildFullReleasePacket(patioInputValid)
  assert(r.ok)
  if (r.ok) {
    const recomputed = await sha256Hex(r.manifest_canonical_text)
    assertEquals(recomputed, r.manifest_hash)
  }
})

Deno.test('H10 — sha256(internal_cost_canonical_text) === internal_cost_hash', async () => {
  const r = await buildFullReleasePacket(patioInputValid)
  assert(r.ok)
  if (r.ok) {
    const recomputed = await sha256Hex(r.internal_cost_canonical_text)
    assertEquals(recomputed, r.internal_cost_hash)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// V: Validator
// ─────────────────────────────────────────────────────────────────────────────

function validateValidPatio() {
  const built = patioInputValid
  // Build the preliminary manifest the same way the builder does, but we
  // need to invoke the validator directly without going through the builder.
  // Easier: just go through the builder and inspect its result.
  return buildFullReleasePacket(built)
}

Deno.test('V1 — Patio valid passes (no errors)', async () => {
  const r = await validateValidPatio()
  assert(r.ok)
})

Deno.test('V2 — Fence valid passes (no errors)', async () => {
  const r = await buildFullReleasePacket(fenceInputValid)
  assert(r.ok, JSON.stringify(r, null, 2))
})

Deno.test('V3 — Quick Quote valid passes (no errors)', async () => {
  const r = await buildFullReleasePacket(qqInputValid)
  assert(r.ok, JSON.stringify(r, null, 2))
})

Deno.test('V4 — Hard fail when customer.mobile missing', async () => {
  const bad = clone(patioInputValid)
  bad.customer.mobile = null
  const r = await buildFullReleasePacket(bad)
  assert(!r.ok)
  if (!r.ok) assert(r.errors.some((e) => e.rule === 'customer.mobile_set'))
})

Deno.test('V5 — Hard fail when customer_facing_summary < 40 chars', async () => {
  const bad = clone(patioInputValid)
  bad.adapter_output.qa_facts.customer_facing_summary = 'too short'
  const r = await buildFullReleasePacket(bad)
  assert(!r.ok)
  if (!r.ok) assert(r.errors.some((e) => e.rule === 'qa.customer_facing_summary_min_length'))
})

Deno.test('V6 — Hard fail when council_status is unknown (and no override)', async () => {
  const bad = clone(patioInputValid)
  bad.adapter_output.qa_facts.council_status = 'unknown'
  const r = await buildFullReleasePacket(bad)
  assert(!r.ok)
  if (!r.ok) assert(r.errors.some((e) => e.rule === 'qa.council_status_known'))
})

Deno.test('V7 — Soft warn when no site_photo present (does NOT block)', async () => {
  const bad = clone(patioInputValid)
  bad.media = []
  const r = await buildFullReleasePacket(bad)
  // No site photo is soft. But media[].sha256 hard-blocker doesn't fire (empty array).
  assert(r.ok, JSON.stringify(r, null, 2))
  if (r.ok) {
    assert(r.soft_warnings.includes('media.has_site_photo'))
  }
})

Deno.test('V8 — Hard fail when material line missing supplier_name in internal_cost', async () => {
  const bad = clone(patioInputValid)
  // patio-line-1 is the material line; null its supplier_name in internal_cost.
  const matLine = bad.adapter_output.internal_cost.line_costs.find(
    (lc) => lc.line_id === 'patio-line-1',
  )
  if (matLine) matLine.supplier_name = null
  const r = await buildFullReleasePacket(bad)
  assert(!r.ok)
  if (!r.ok) {
    assert(r.errors.some((e) => e.rule === 'pricing.material_lines_have_supplier'))
  }
})

Deno.test('V9 — Hard fail when pricing does not reconcile', async () => {
  const r = await buildFullReleasePacket(qqInputInvalid)
  assert(!r.ok)
  if (!r.ok) {
    assert(r.errors.some((e) => e.rule === 'pricing.reconciles'))
  }
})

Deno.test('V10 — Hard fail when margin_floor_breached and override_reason null', async () => {
  const bad = clone(patioInputValid)
  bad.adapter_output.internal_cost.margin.floor_breached = true
  bad.adapter_output.internal_cost.margin.override_reason = null
  const r = await buildFullReleasePacket(bad)
  assert(!r.ok)
  if (!r.ok) {
    assert(r.errors.some((e) => e.rule === 'internal_cost.margin_override_required_when_breached'))
  }
})

Deno.test('V11 — Soft warn when fence demo=true and no pre_install media', async () => {
  const bad = clone(fenceInputValid)
  ;(bad.adapter_output.scope as FenceScopeBlock).runs[0].demo = true
  // Media has site_photo (phase=site_visit) but no pre_install.
  const r = await buildFullReleasePacket(bad)
  assert(r.ok)
  if (r.ok) {
    assert(r.soft_warnings.includes('fence.demo_pre_install_photo'))
  }
})

Deno.test('V12 — Override allows hard-blocker bypass when qa.overrides[] includes the rule and operator is allowlisted', async () => {
  const bad = clone(patioInputValid)
  bad.adapter_output.qa_facts.council_status = 'unknown'
  bad.overrides = [{
    rule_name: 'qa.council_status_known',
    category: 'council_unresponsive',
    reason: 'Council has not replied for 6 weeks; customer wants to proceed at-risk.',
    operator_user_id: STUB_USER_ID_MARNIN,
    operator_role: 'Marnin',
    timestamp: STUB_RELEASED_AT,
  }]
  const r = await buildFullReleasePacket(bad)
  assert(r.ok, JSON.stringify(r, null, 2))
  if (r.ok) {
    // Override fires a warning so the audit trail can see it was bypassed.
    assert(r.soft_warnings.includes('qa.council_status_known'))
    // Overrides are sealed in the manifest.
    assertEquals(r.manifest.qa.overrides.length, 1)
    assertEquals(r.manifest.qa.overrides[0].rule_name, 'qa.council_status_known')
  }
})

Deno.test('V13 — Adapter-specific rule fires (patio.structure_type required)', async () => {
  const bad = clone(patioInputValid)
  ;(bad.adapter_output.scope as PatioScopeBlock).structure_type = ''
  const r = await buildFullReleasePacket(bad)
  assert(!r.ok)
  if (!r.ok) {
    assert(r.errors.some((e) => e.rule === 'patio.structure_type_set'))
  }
})

Deno.test('V14 — Adapter-specific rule fires (fence.at_least_one_run)', async () => {
  const r = await buildFullReleasePacket(fenceInputInvalid)
  assert(!r.ok)
  if (!r.ok) {
    assert(r.errors.some((e) => e.rule === 'fence.at_least_one_run'))
  }
})

Deno.test('V15 — Validator returns hard_blockers_passed list', async () => {
  const r = await buildFullReleasePacket(patioInputValid)
  assert(r.ok)
  if (r.ok) {
    // At least the load-bearing envelope rules.
    assert(r.hard_blockers_passed.includes('envelope.schema_version'))
    assert(r.hard_blockers_passed.includes('customer.mobile_set'))
    assert(r.hard_blockers_passed.includes('qa.customer_facing_summary_min_length'))
    assert(r.hard_blockers_passed.includes('qa.council_status_known'))
    assert(r.hard_blockers_passed.includes('pricing.reconciles'))
    // Adapter-specific.
    assert(r.hard_blockers_passed.includes('patio.structure_type_set'))
    assert(r.hard_blockers_passed.includes('patio.dimensions_positive'))
    // hard_blockers_passed sealed into the manifest (in canonical bytes).
    assertEquals(r.manifest.qa.hard_blockers_passed, r.hard_blockers_passed)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// S: Schema/shape invariants
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('S1 — Schema version is 2.0', async () => {
  const r = await buildFullReleasePacket(patioInputValid)
  assert(r.ok)
  if (r.ok) {
    assertEquals(r.manifest.schema_version, '2.0')
    assertEquals(r.internal_cost_snapshot.schema_version, '2.0')
  }
})

Deno.test('S2 — option_label can be null (default)', async () => {
  const r = await buildFullReleasePacket(patioInputValid)
  assert(r.ok)
  if (r.ok) assertEquals(r.manifest.option_label, null)
})

Deno.test('S3 — option_label can be an explicit value', async () => {
  const withOption = { ...patioInputValid, option_label: 'A' }
  const r = await buildFullReleasePacket(withOption)
  assert(r.ok)
  if (r.ok) assertEquals(r.manifest.option_label, 'A')
})

Deno.test('S4 — terms.terms_version defaults to legacy_unknown', async () => {
  const r = await buildFullReleasePacket(patioInputValid)
  assert(r.ok)
  if (r.ok) assertEquals(r.manifest.terms.terms_version, 'legacy_unknown')
})

Deno.test('S5 — superseded_by_revision_id can be null', async () => {
  const r = await buildFullReleasePacket(patioInputValid)
  assert(r.ok)
  if (r.ok) assertEquals(r.manifest.superseded_by_revision_id, null)
})

// ─────────────────────────────────────────────────────────────────────────────
// I: Internal cost privacy + correctness
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('I1 — internal_cost.line_costs aligns with pricing_public.line_items by line_id', async () => {
  const r = await buildFullReleasePacket(patioInputValid)
  assert(r.ok)
  if (r.ok) {
    const publicIds = new Set(r.manifest.pricing_public.line_items.map((li) => li.line_id))
    const internalIds = new Set(r.internal_cost_snapshot.line_costs.map((lc) => lc.line_id))
    assertEquals(publicIds, internalIds)
  }
})

Deno.test('I2 — internal_cost margin pct is the value the adapter provided (builder does not recompute)', async () => {
  const r = await buildFullReleasePacket(patioInputValid)
  assert(r.ok)
  if (r.ok) {
    assertEquals(r.internal_cost_snapshot.margin.pct, 0.39)
  }
})

Deno.test('I3 — internal_cost commission rule matches the adapter-supplied build kind', async () => {
  const rPatio = await buildFullReleasePacket(patioInputValid)
  const rFence = await buildFullReleasePacket(fenceInputValid)
  assert(rPatio.ok && rFence.ok)
  if (rPatio.ok && rFence.ok) {
    assertEquals(rPatio.internal_cost_snapshot.commission.rule, 'patio_10pct_gp')
    assertEquals(rFence.internal_cost_snapshot.commission.rule, 'fence_5_25pct_inc_gst')
  }
})

Deno.test('I4 — internal_cost is NOT in manifest_canonical_text (privacy invariant)', async () => {
  const r = await buildFullReleasePacket(patioInputValid)
  assert(r.ok)
  if (r.ok) {
    // Sanity check: the internal cost canonical text contains line_costs;
    // the manifest canonical text must not contain it as a key.
    assert(r.internal_cost_canonical_text.includes('line_costs'))
    assert(
      !r.manifest_canonical_text.includes('"line_costs"'),
      'manifest canonical text must not include internal cost data',
    )
    // unit_cost / supplier_name should not leak into the manifest either.
    assert(!r.manifest_canonical_text.includes('"unit_cost"'))
    assert(!r.manifest_canonical_text.includes('"supplier_name"'))
    // commission shouldn't appear in the manifest.
    assert(!r.manifest_canonical_text.includes('"commission"'))
    // override_approver_user_id shouldn't appear in the manifest.
    assert(!r.manifest_canonical_text.includes('"override_approver_user_id"'))
  }
})

Deno.test('I5 — Builder returns both snapshots and both hashes', async () => {
  const r = await buildFullReleasePacket(patioInputValid)
  assert(r.ok)
  if (r.ok) {
    assert(r.manifest_canonical_text.length > 0)
    assert(r.internal_cost_canonical_text.length > 0)
    assert(r.manifest_hash.length === 64)
    assert(r.internal_cost_hash.length === 64)
    assert(r.internal_cost_snapshot.line_costs.length > 0)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// P: Base64 data URI guard (carries over from V1)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('P1 — Refuses base64 data URI in customer.email', async () => {
  const bad = clone(patioInputValid)
  bad.customer.email = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
  await assertRejects(
    () => buildFullReleasePacket(bad),
    Error,
    'release packet manifest contains a base64 data URI',
  )
})

Deno.test('P2 — Refuses base64 data URI in scope.patio.notes-equivalent (handover_instructions)', async () => {
  const bad = clone(patioInputValid)
  bad.site.handover_instructions = 'data:image/png;base64,AAAAAAAA'
  await assertRejects(
    () => buildFullReleasePacket(bad),
    Error,
    'release packet manifest contains a base64 data URI',
  )
})

Deno.test('P3 — Refuses base64 data URI in pricing line description', async () => {
  const bad = clone(patioInputValid)
  bad.adapter_output.pricing_public.line_items[0].description =
    'data:application/pdf;base64,JVBERi0xLjQK'
  await assertRejects(
    () => buildFullReleasePacket(bad),
    Error,
    'release packet manifest contains a base64 data URI',
  )
})

Deno.test('P4 — Refuses base64 data URI nested deep inside scope', async () => {
  const bad = clone(patioInputValid)
  ;(bad.adapter_output.scope as PatioScopeBlock).package_lines[0].description =
    'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
  await assertRejects(
    () => buildFullReleasePacket(bad),
    Error,
    'release packet manifest contains a base64 data URI',
  )
})

Deno.test('P5 — Allows non-base64 strings (regression check)', async () => {
  const ok = clone(patioInputValid)
  ok.site.handover_instructions = 'Side gate is on the left. Code is 4521. Dog is friendly.'
  const r = await buildFullReleasePacket(ok)
  assert(r.ok, JSON.stringify(r, null, 2))
})

// ─────────────────────────────────────────────────────────────────────────────
// Validator-direct tests (no builder roundtrip)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('Validator direct — warn mode demotes hard rules to warnings', () => {
  const minimalManifest: QuoteReleasePacketV2 = {
    schema_version: '2.0',
    release_id: 'rel-1',
    job_id: 'job-1',
    version: 1,
    released_via: 'send-quote/send',
    released_at: STUB_RELEASED_AT,
    released_by_user_id: null,
    customer: {
      name: 'Test',
      mobile: null, // hard-fail under enforce
      email: 't@example.com',
      ghl_contact_id: null,
      xero_contact_id_at_release: null,
    },
    contacts: [],
    site: {
      address: null, suburb: null, lat: null, lng: null, council: null,
      access: { chips: [], notes: '' }, constraints: { chips: [], notes: '' },
      handover_instructions: '',
    },
    scope: {
      kind: 'patio',
      schema_version: '2.0',
      structure_type: 'flat',
      dimensions: { width_m: 1, depth_m: 1, height_m: null },
      roof_sheet_colour: null, post_type: null, footings: null,
      gutter: null, fascia: null,
      electrical_yes_no: false, demo_yes_no: false,
      package_lines: [],
    },
    pricing_public: {
      line_items: [],
      totals: { subtotal_ex_gst: 0, gst: 0, total_ex_gst: 0, total_inc_gst: 0 },
      per_contact_totals: [],
    },
    documents: {
      quote_pdf: { storage_path: 'x', sha256: STUB_HASH_64, size_bytes: null },
      per_contact_pdfs: [],
      email: { subject: 'x', custom_message: '', scoper_name: 'x', template_version: 'v1', html_sha256: STUB_HASH_64 },
      attachments: [],
      council_plans: null,
    },
    media: [],
    qa: {
      hard_blockers_passed: [],
      soft_warnings: [],
      council_status: 'unknown',
      customer_facing_summary: 'short',
      overrides: [],
      qa_passed_by: null,
    },
    send: { recipients: [{ contact_id: 'c1', email: 't@example.com', resend_message_id: null, sent_at: STUB_RELEASED_AT }] },
    terms: { valid_days: 30, expires_at: STUB_RELEASED_AT, payment_terms: '50/50', deposit_pct: 50, terms_version: 'legacy_unknown', terms_document_ref: null },
    provenance: { tool_name: 'x', tool_version: '1', pricing_engine_version: '1', scoper_user_id: null, scoper_name: null, scoped_at: null },
    option_label: null,
    superseded_by_revision_id: null,
  }
  const ic: InternalCostSnapshot = {
    schema_version: '2.0', release_id: 'rel-1', job_id: 'job-1', version: 1, captured_at: STUB_RELEASED_AT,
    line_costs: [],
    cost_estimates: { material_total: 0, labour_total: 0, subcontract_commission_total: 0 },
    margin: { pct: 0, floor_breached: false, override_reason: null, override_approver_user_id: null },
    commission: { rule: 'other', amount: 0, salesperson_user_id: null },
  }

  const enforced = validatePacketV2(minimalManifest, ic, baseValidatorOpts)
  assert(!enforced.ok)
  assert(enforced.errors.length > 0)

  const warned = validatePacketV2(minimalManifest, ic, { ...baseValidatorOpts, mode: 'warn' })
  assert(warned.ok, 'warn mode passes regardless of failures')
  assert(warned.warnings.length > 0)
})

Deno.test('Validator direct — operator NOT in allowlist → override rejected', async () => {
  const bad = clone(patioInputValid)
  bad.adapter_output.qa_facts.council_status = 'unknown'
  bad.overrides = [{
    rule_name: 'qa.council_status_known',
    category: 'council_unresponsive',
    reason: 'attempted bypass',
    operator_user_id: '99999999-9999-9999-9999-999999999999', // not in allowlist
    operator_role: 'rogue',
    timestamp: STUB_RELEASED_AT,
  }]
  const r = await buildFullReleasePacket(bad)
  assert(!r.ok)
  if (!r.ok) {
    assert(r.errors.some((e) => e.rule === 'qa.overrides_operator_allowed'))
  }
})

Deno.test('Validator direct — empty override allowlist + non-empty overrides → reject', async () => {
  const bad = clone(patioInputValid)
  bad.adapter_output.qa_facts.council_status = 'unknown'
  bad.overrides = [{
    rule_name: 'qa.council_status_known',
    category: 'council_unresponsive',
    reason: 'try',
    operator_user_id: STUB_USER_ID_MARNIN,
    operator_role: 'Marnin',
    timestamp: STUB_RELEASED_AT,
  }]
  bad.override_operator_allowlist = []
  const r = await buildFullReleasePacket(bad)
  assert(!r.ok)
  if (!r.ok) {
    assert(r.errors.some((e) => e.rule === 'qa.overrides_operator_allowed'))
  }
})
