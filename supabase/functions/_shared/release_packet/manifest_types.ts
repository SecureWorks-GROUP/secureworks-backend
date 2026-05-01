// Cap 0 Job Release Packet V1 — TypeScript types for the manifest contract.
//
// Pure types. Mirrors the JSON shapes documented in:
//   secureworks-docs/cio/reports/2026-04-30-job-release-packet-v1/release-packet-contract-v1.md
//
// Ported verbatim from the scaffold:
//   secureworks-docs/cio/reports/2026-04-30-job-release-packet-v1/scaffold/manifest_types.ts
//
// In CAP0-QUOTE-REVISION-MINIMAL these types are exposed for tests and forward
// reference. The full QA hard-blocker validator gate (validateReleasePacketManifest)
// is NOT enforced by send-quote in this slice — that lands in CAP0-QUOTE-REVISION-HARD-BLOCKERS.

export type Customer = {
  name: string
  email: string
  mobile: string
  ghl_contact_id: string | null
}

export type Site = {
  address: string
  suburb: string
  lat: number | null
  lng: number | null
}

export type CouncilStatus =
  | 'not_required'
  | 'required_pending'
  | 'required_approved'
  | 'unknown'

export type SiteAccess = {
  chips: string[]
  notes: string
}

export type InstallConstraints = {
  chips: string[]
  notes: string
}

export type PatioBuild = {
  structure_type: string
  dimensions_m: { width: number; depth: number }
  roof_sheet_colour: string
  post_type: string
  footings: string
  gutter: string
  fascia: string
  electrical_yes_no: boolean
  demo_yes_no: boolean
  package_lines?: unknown
}

export type FenceRun = {
  run_label: string
  type: string
  height_mm: number
  lineal_m: number
  panels: number
  posts: number
  infill: string
  finish: string
  demo: boolean
  gates: Array<{
    type: string
    height_mm: number
    hardware: string
  }>
}

export type FenceBuild = {
  runs: FenceRun[]
}

export type QuickQuoteBuild = {
  label: string
  description: string
}

export type BuildType =
  | { kind: 'patio'; patio: PatioBuild }
  | { kind: 'fence'; fence: FenceBuild }
  | { kind: 'quick_quote'; quick_quote: QuickQuoteBuild }

export type ScopeSnapshot = {
  schema_version: '1.0'
  captured_at: string
  source_tool: 'patio' | 'fence' | 'quick_quote'
  customer: Customer
  site: Site
  council_status: CouncilStatus
  site_access: SiteAccess
  install_constraints: InstallConstraints
  neighbours_required: boolean
  handover_instructions: string
  customer_facing_summary: string
  build_type: BuildType
  media_ids: string[]
  scoper: {
    user_id: string
    name: string
  }
}

export type LineCategory = 'material' | 'labour' | 'subcontract' | 'extra' | 'demo'

export type LineItem = {
  line_id: string
  category: LineCategory
  description: string
  supplier_name: string
  quantity: number
  unit: string
  unit_cost: number
  unit_sell: number
  line_total_ex: number
}

export type CommissionRule =
  | 'patio_10pct_gp'
  | 'fence_5_25pct_inc_gst'
  | 'other'

export type PricingSnapshot = {
  schema_version: '1.0'
  captured_at: string
  totals: {
    subtotal_ex_gst: number
    gst: number
    total_ex_gst: number
    total_inc_gst: number
  }
  line_items: LineItem[]
  cost_estimates: {
    material: number
    labour: number
    subcontract_commission: number
  }
  margin_pct: number
  margin_floor_breached: boolean
  commission: {
    rule: CommissionRule
    amount: number
  }
  override_reason: string | null
}

export type PacketManifest = {
  job_id: string
  job_document_id: string | null
  revision_number: number | null
  recipient_email: string
  sent_at: string | null
  scope_snapshot: ScopeSnapshot
  pricing_snapshot: PricingSnapshot
  scope_hash: string
  pricing_hash: string
  source_tool: 'patio' | 'fence' | 'quick_quote'
  total_inc_gst: number
  total_ex_gst: number
  margin_pct: number | null
}

export type QABlocker = {
  code: string
  field_path: string
  message: string
  fixable_in: 'scope_tool' | 'ops' | 'system'
}

// ── Minimal manifest used by CAP0-QUOTE-REVISION-MINIMAL ─────────────────────
//
// The minimal slice does NOT enforce the full QA hard-blocker gate. Instead,
// send-quote builds a MinimalReleaseManifest at staging time using only the
// data already available from `jobs` + `job_documents` + the scoper's input.
// Hash determinism is the same; the schema is just a strict subset.
//
// CAP0-QUOTE-REVISION-HARD-BLOCKERS will replace this with the full PacketManifest
// once the scoping tools capture the additional fields (customer.mobile, site.lat/lng,
// site_access chips, customer_facing_summary >= 40 chars, media_ids, etc.).
export type MinimalReleaseManifest = {
  schema_version: '1.0-minimal'
  captured_at: string
  job_id: string
  // Nullable since 20260501130000: Quick Quote releases via ops-api don't create
  // a job_documents row. Patio/Fence sends via send-quote always populate it.
  job_document_id: string | null
  version: number
  recipient_email: string
  recipient_label: string | null
  sent_at: string | null
  build_kind: 'patio' | 'fence' | 'misc'
  council_status: CouncilStatus
  neighbours_required: boolean | null
  scope_snapshot: {
    client_name: string | null
    site_address: string | null
    site_suburb: string | null
    job_type: string | null
    job_number: string | null
    runs?: Array<{
      run_label: string
      run_name: string | null
      neighbour_id: string | null
      items_count: number
    }>
  }
  pricing_snapshot: {
    raw: unknown // jobs.pricing_json captured verbatim at staging
  }
  totals_snapshot: {
    total_ex_gst: number | null
    gst: number | null
    total_inc_gst: number | null
  }
  pdf_url: string
  margin_pct: number | null
  margin_floor_breached: boolean
  override_reason: string | null
  released_via: 'send-quote/send' | 'send-quote/send-runs' | 'ops-api/send_quick_quote_email'
}
