// Cap 0 Full Release Packet V2 — fixtures + stub adapters.
//
// Loop 1 deliverable: fixtures that can be fed to buildFullReleasePacket and
// validatePacketV2 to verify the contract end-to-end without DB or live
// scoping tools. Each adapter has a `valid` fixture (passes all hard gates)
// and an `invalid` fixture (fails specific gates the test suite asserts).
//
// These are STUB adapters — they don't read from the live job's scope_json
// or pricing_json. Real adapter implementations land in Loop 2 (P1) inside
// patio-tool, fence-designer, and ops-api respectively.

import type {
  QuoteReleasePacketV2,
  Customer,
  Contact,
  Site,
  Documents,
  MediaItem,
  Send,
  Terms,
  Provenance,
  PatioScopeBlock,
  FenceScopeBlock,
  QuickQuoteScopeBlock,
} from './manifest_v2_types.ts'
import type { InternalCostSnapshot } from './internal_cost_types.ts'
import type { AdapterOutput } from './adapter_interface.ts'
import type { BuildFullReleasePacketInput } from './build_full_release_packet.ts'

// ── Constants ───────────────────────────────────────────────────────────────

export const STUB_RELEASE_ID = '11111111-1111-1111-1111-111111111111'
export const STUB_JOB_ID_PATIO = '22222222-2222-2222-2222-222222222222'
export const STUB_JOB_ID_FENCE = '33333333-3333-3333-3333-333333333333'
export const STUB_JOB_ID_QQ = '44444444-4444-4444-4444-444444444444'
export const STUB_RELEASED_AT = '2026-05-01T12:00:00.000Z'
export const STUB_USER_ID_SCOPER = '55555555-5555-5555-5555-555555555555'
export const STUB_USER_ID_MARNIN = '66666666-6666-6666-6666-666666666666'
export const STUB_USER_ID_SHAUN = '77777777-7777-7777-7777-777777777777'
export const STUB_OVERRIDE_ALLOWLIST = [STUB_USER_ID_MARNIN, STUB_USER_ID_SHAUN]
export const STUB_HASH_64 = 'a'.repeat(64)

const stubCustomer: Customer = {
  name: 'CAP0 TEST Customer',
  mobile: '0400000000',
  email: 'marnin@secureworkswa.com.au',
  ghl_contact_id: 'ghl-stub-contact-1',
  xero_contact_id_at_release: null,
}

const stubContacts: Contact[] = [
  {
    id: 'cccccccc-1111-4111-8111-111111111111',
    role: 'primary',
    label: null,
    email: 'marnin@secureworkswa.com.au',
    phone: '0400000000',
    assigned_runs: null,
    share_pct: 100,
    authority: { can_view: true, can_accept: true, pays: true },
  },
]

const stubSite: Site = {
  address: '1 CAP0 Test St',
  suburb: 'Perth',
  lat: -31.9505,
  lng: 115.8605,
  council: 'City of Perth',
  access: { chips: ['side_gate'], notes: '' },
  constraints: { chips: [], notes: '' },
  handover_instructions: 'Standard handover.',
}

const stubDocuments: Documents = {
  quote_pdf: {
    storage_path: 'job-pdfs/00000000-0000-0000-0000-000000000001/22222222/quote_v1.pdf',
    sha256: 'b'.repeat(64),
    size_bytes: 12345,
  },
  per_contact_pdfs: [],
  email: {
    subject: 'Your quote from SecureWorks Group',
    custom_message: '',
    scoper_name: 'CAP0 Verifier',
    template_version: 'v1.0',
    html_sha256: 'c'.repeat(64),
  },
  attachments: [],
  council_plans: null,
}

const stubMedia: MediaItem[] = [
  {
    id: 'mmmmmmmm-1111-4111-8111-111111111111',
    type: 'site_photo',
    phase: 'site_visit',
    storage_path: 'job-media/site-photo-1.jpg',
    sha256: 'd'.repeat(64),
    label: 'Front yard',
    taken_at: '2026-04-30T09:00:00.000Z',
    lat: -31.9505,
    lng: 115.8605,
  },
]

const stubSend: Send = {
  recipients: [
    {
      contact_id: 'cccccccc-1111-4111-8111-111111111111',
      email: 'marnin@secureworkswa.com.au',
      resend_message_id: 'resend-stub-123',
      sent_at: STUB_RELEASED_AT,
    },
  ],
}

const stubTerms: Terms = {
  valid_days: 30,
  expires_at: '2026-05-31T12:00:00.000Z',
  payment_terms: '50% deposit + 50% on completion',
  deposit_pct: 50,
  terms_version: 'legacy_unknown',
  terms_document_ref: null,
}

const stubProvenance: Provenance = {
  tool_name: 'stub-adapter',
  tool_version: '0.0.1',
  pricing_engine_version: '0.0.1',
  scoper_user_id: STUB_USER_ID_SCOPER,
  scoper_name: 'CAP0 Stub Scoper',
  scoped_at: '2026-04-30T09:00:00.000Z',
}

// ── Patio fixture ───────────────────────────────────────────────────────────

const patioScopeValid: PatioScopeBlock = {
  kind: 'patio',
  schema_version: '2.0',
  structure_type: 'flat_skillion',
  dimensions: { width_m: 6, depth_m: 4, height_m: 2.7 },
  roof_sheet_colour: 'Surfmist',
  post_type: '90x90 SHS',
  footings: '400x400x500',
  gutter: 'Slimline',
  fascia: 'Standard',
  electrical_yes_no: false,
  demo_yes_no: false,
  package_lines: [
    { line_id: 'patio-roof', description: 'SolarSpan 75mm', qty: 24, unit: 'm2' },
  ],
}

const patioPricingValid = {
  line_items: [
    {
      line_id: 'patio-line-1',
      category: 'material' as const,
      description: 'SolarSpan 75mm panels',
      qty: 24,
      unit: 'm2',
      unit_sell: 250,
      line_total_ex: 6000,
      allocation: 'client' as const,
      split_pct: 100,
      per_contact: [],
    },
    {
      line_id: 'patio-line-2',
      category: 'labour' as const,
      description: 'Install labour',
      qty: 1,
      unit: 'job',
      unit_sell: 4000,
      line_total_ex: 4000,
      allocation: 'client' as const,
      split_pct: 100,
      per_contact: [],
    },
  ],
  totals: {
    subtotal_ex_gst: 10000,
    gst: 1000,
    total_ex_gst: 10000,
    total_inc_gst: 11000,
  },
  per_contact_totals: [
    {
      contact_id: 'cccccccc-1111-4111-8111-111111111111',
      total_ex_gst: 10000,
      total_inc_gst: 11000,
    },
  ],
}

const patioInternalCostValid: InternalCostSnapshot = {
  schema_version: '2.0',
  release_id: STUB_RELEASE_ID,
  job_id: STUB_JOB_ID_PATIO,
  version: 1,
  captured_at: STUB_RELEASED_AT,
  line_costs: [
    {
      line_id: 'patio-line-1',
      unit_cost: 150,
      line_cost_total_ex: 3600,
      supplier_name: 'Bondor',
    },
    {
      line_id: 'patio-line-2',
      unit_cost: 2500,
      line_cost_total_ex: 2500,
      supplier_name: null,
    },
  ],
  cost_estimates: {
    material_total: 3600,
    labour_total: 2500,
    subcontract_commission_total: 600,
  },
  margin: {
    pct: 0.39,
    floor_breached: false,
    override_reason: null,
    override_approver_user_id: null,
  },
  commission: {
    rule: 'patio_10pct_gp',
    amount: 600,
    salesperson_user_id: null,
  },
}

export const patioAdapterOutputValid: AdapterOutput = {
  scope: patioScopeValid,
  pricing_public: patioPricingValid,
  internal_cost: patioInternalCostValid,
  qa_facts: {
    customer_facing_summary:
      'Flat-skillion patio 6×4m attached to fascia. SolarSpan 75mm Surfmist sheets. Standard install — no demo, no electrical works.',
    council_status: 'not_required',
    qa_passed_by: STUB_USER_ID_SCOPER,
  },
}

export const patioInputValid: BuildFullReleasePacketInput = {
  release_id: STUB_RELEASE_ID,
  job_id: STUB_JOB_ID_PATIO,
  version: 1,
  released_via: 'send-quote/send',
  released_at: STUB_RELEASED_AT,
  released_by_user_id: STUB_USER_ID_SCOPER,
  adapter_output: patioAdapterOutputValid,
  customer: stubCustomer,
  contacts: stubContacts,
  site: stubSite,
  documents: stubDocuments,
  media: stubMedia,
  send: stubSend,
  terms: stubTerms,
  provenance: stubProvenance,
  option_label: null,
  superseded_by_revision_id: null,
  scope_revision_id: null,
  overrides: [],
  override_operator_allowlist: STUB_OVERRIDE_ALLOWLIST,
}

// Patio invalid: customer.mobile blank + customer_facing_summary too short.
export const patioInputInvalid: BuildFullReleasePacketInput = {
  ...patioInputValid,
  customer: { ...stubCustomer, mobile: null },
  adapter_output: {
    ...patioAdapterOutputValid,
    qa_facts: {
      ...patioAdapterOutputValid.qa_facts,
      customer_facing_summary: 'too short',
    },
  },
}

// ── Fence fixture ───────────────────────────────────────────────────────────

const fenceScopeValid: FenceScopeBlock = {
  kind: 'fence',
  schema_version: '2.0',
  runs: [
    {
      run_label: 'REAR',
      type: 'colorbond',
      height_mm: 1800,
      lineal_m: 15,
      panels: 7,
      posts: 8,
      infill: 'Surfmist',
      finish: 'Powdercoat',
      demo: false,
      gates: [],
    },
  ],
  boundary_plan_attached: false,
}

const fencePricingValid = {
  line_items: [
    {
      line_id: 'fence-rear-mat',
      category: 'material' as const,
      description: 'Colorbond panels REAR',
      qty: 15,
      unit: 'm',
      unit_sell: 120,
      line_total_ex: 1800,
      allocation: 'client' as const,
      split_pct: 100,
      per_contact: [],
    },
    {
      line_id: 'fence-rear-lab',
      category: 'labour' as const,
      description: 'Install REAR',
      qty: 1,
      unit: 'job',
      unit_sell: 700,
      line_total_ex: 700,
      allocation: 'client' as const,
      split_pct: 100,
      per_contact: [],
    },
  ],
  totals: {
    subtotal_ex_gst: 2500,
    gst: 250,
    total_ex_gst: 2500,
    total_inc_gst: 2750,
  },
  per_contact_totals: [
    {
      contact_id: 'cccccccc-1111-4111-8111-111111111111',
      total_ex_gst: 2500,
      total_inc_gst: 2750,
    },
  ],
}

const fenceInternalCostValid: InternalCostSnapshot = {
  schema_version: '2.0',
  release_id: STUB_RELEASE_ID,
  job_id: STUB_JOB_ID_FENCE,
  version: 1,
  captured_at: STUB_RELEASED_AT,
  line_costs: [
    {
      line_id: 'fence-rear-mat',
      unit_cost: 80,
      line_cost_total_ex: 1200,
      supplier_name: 'Metroll',
    },
    {
      line_id: 'fence-rear-lab',
      unit_cost: 500,
      line_cost_total_ex: 500,
      supplier_name: null,
    },
  ],
  cost_estimates: {
    material_total: 1200,
    labour_total: 500,
    subcontract_commission_total: 131.25,
  },
  margin: {
    pct: 0.32,
    floor_breached: false,
    override_reason: null,
    override_approver_user_id: null,
  },
  commission: {
    rule: 'fence_5_25pct_inc_gst',
    amount: 131.25,
    salesperson_user_id: null,
  },
}

export const fenceAdapterOutputValid: AdapterOutput = {
  scope: fenceScopeValid,
  pricing_public: fencePricingValid,
  internal_cost: fenceInternalCostValid,
  qa_facts: {
    customer_facing_summary:
      '15m of 1800mm colorbond fencing along the rear boundary. Powdercoated Surfmist. No demo of existing structure required.',
    council_status: 'not_required',
    qa_passed_by: STUB_USER_ID_SCOPER,
  },
}

export const fenceInputValid: BuildFullReleasePacketInput = {
  ...patioInputValid,
  job_id: STUB_JOB_ID_FENCE,
  released_via: 'send-quote/send-runs',
  adapter_output: fenceAdapterOutputValid,
}

// Fence invalid: zero runs.
export const fenceInputInvalid: BuildFullReleasePacketInput = {
  ...fenceInputValid,
  adapter_output: {
    ...fenceAdapterOutputValid,
    scope: { ...fenceScopeValid, runs: [] },
  },
}

// ── Quick Quote fixture ─────────────────────────────────────────────────────

const qqScopeValid: QuickQuoteScopeBlock = {
  kind: 'quick_quote',
  schema_version: '2.0',
  label: 'Repair gutter',
  description: 'Replace damaged gutter section. 6m run.',
}

const qqPricingValid = {
  line_items: [
    {
      line_id: 'qq-line-1',
      category: 'material' as const,
      description: 'Slimline gutter 6m',
      qty: 1,
      unit: 'job',
      unit_sell: 350,
      line_total_ex: 350,
      allocation: 'client' as const,
      split_pct: 100,
      per_contact: [],
    },
    {
      line_id: 'qq-line-2',
      category: 'labour' as const,
      description: 'Install + dispose',
      qty: 1,
      unit: 'job',
      unit_sell: 250,
      line_total_ex: 250,
      allocation: 'client' as const,
      split_pct: 100,
      per_contact: [],
    },
  ],
  totals: {
    subtotal_ex_gst: 600,
    gst: 60,
    total_ex_gst: 600,
    total_inc_gst: 660,
  },
  per_contact_totals: [
    {
      contact_id: 'cccccccc-1111-4111-8111-111111111111',
      total_ex_gst: 600,
      total_inc_gst: 660,
    },
  ],
}

const qqInternalCostValid: InternalCostSnapshot = {
  schema_version: '2.0',
  release_id: STUB_RELEASE_ID,
  job_id: STUB_JOB_ID_QQ,
  version: 1,
  captured_at: STUB_RELEASED_AT,
  line_costs: [
    {
      line_id: 'qq-line-1',
      unit_cost: 200,
      line_cost_total_ex: 200,
      supplier_name: 'Metroll',
    },
    {
      line_id: 'qq-line-2',
      unit_cost: 150,
      line_cost_total_ex: 150,
      supplier_name: null,
    },
  ],
  cost_estimates: {
    material_total: 200,
    labour_total: 150,
    subcontract_commission_total: 0,
  },
  margin: {
    pct: 0.42,
    floor_breached: false,
    override_reason: null,
    override_approver_user_id: null,
  },
  commission: {
    rule: 'other',
    amount: 0,
    salesperson_user_id: null,
  },
}

export const qqAdapterOutputValid: AdapterOutput = {
  scope: qqScopeValid,
  pricing_public: qqPricingValid,
  internal_cost: qqInternalCostValid,
  qa_facts: {
    customer_facing_summary:
      'Replace damaged 6m section of slimline gutter on the front of the house. Includes labour and disposal of old material.',
    council_status: 'not_required',
    qa_passed_by: STUB_USER_ID_SCOPER,
  },
}

export const qqInputValid: BuildFullReleasePacketInput = {
  ...patioInputValid,
  job_id: STUB_JOB_ID_QQ,
  released_via: 'ops-api/send_quick_quote_email',
  adapter_output: qqAdapterOutputValid,
}

// QQ invalid: pricing doesn't reconcile.
export const qqInputInvalid: BuildFullReleasePacketInput = {
  ...qqInputValid,
  adapter_output: {
    ...qqAdapterOutputValid,
    pricing_public: {
      ...qqPricingValid,
      totals: {
        subtotal_ex_gst: 700, // sum of line_total_ex is 600 — mismatch
        gst: 70,
        total_ex_gst: 700,
        total_inc_gst: 770,
      },
    },
  },
}

// Re-export QuoteReleasePacketV2 manifest helper for tests that need to
// inspect a fully-built valid packet without re-deriving each time.
export const _typeRefForTests = (): QuoteReleasePacketV2 | null => null
