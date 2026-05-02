// Cap 0 Full Release Packet V2 — internal cost snapshot types.
//
// This type is the parallel sealed snapshot of internal commercial data:
// per-line cost prices, supplier names, margin %, commission, override
// approvers. It is hashed separately from the client-facing manifest
// (`internal_cost_hash`) and stored in a separate canonical-text column
// (`internal_cost_canonical_text`) on the same `quote_revisions` row.
//
// Privacy invariant: nothing in this file ever appears in
// `manifest_canonical_text`. SecureOps, finance, and JARVIS read it via
// service-role auth + caller-role gate. External/client/legal audit reads
// only the client-facing manifest and never receives this snapshot.
//
// One row, two hashes:
//   manifest_hash           = sha256(manifest_canonical_text)         (client-safe)
//   internal_cost_hash      = sha256(internal_cost_canonical_text)    (private)
//
// Both verifiable independently. Tampering with either is detectable.

export type InternalLineCost = {
  // Same line_id as PricingLineItem.line_id in the client-facing manifest.
  // Joins the two snapshots without storing the description twice.
  line_id: string
  unit_cost: number
  line_cost_total_ex: number
  // Hard-blocker (validator enforces): non-empty for every category=material
  // line. Captured in client-facing pricing_public for material lines too,
  // but persisted here for internal supplier-management traceability.
  supplier_name: string | null
}

export type InternalCostEstimates = {
  material_total: number
  labour_total: number
  subcontract_commission_total: number
}

export type InternalMargin = {
  pct: number
  floor_breached: boolean
  // When floor_breached is true, override_reason is required (validator
  // enforces). The approver UUID + role must match the project's configured
  // override-operator allowlist (Marnin or Shaun per §9 default).
  override_reason: string | null
  override_approver_user_id: string | null
}

export type CommissionRule =
  | 'patio_10pct_gp'
  | 'fence_5_25pct_inc_gst'
  | 'other'

export type InternalCommission = {
  rule: CommissionRule
  amount: number
  // GAP today — `jobs.created_by` captures the scoper, not necessarily the
  // salesperson. Captured by scoping tools at scope time once they expose
  // the salesperson selector. Nullable until that capture lands.
  salesperson_user_id: string | null
}

export type InternalCostSnapshot = {
  schema_version: '2.0'
  release_id: string
  job_id: string
  version: number
  // Captured at-release. Distinct from `released_at` on the manifest only
  // because canonical-text discipline preserves byte-equality across builds.
  // Caller passes a single ISO timestamp shared with the manifest.
  captured_at: string

  line_costs: InternalLineCost[]
  cost_estimates: InternalCostEstimates
  margin: InternalMargin
  commission: InternalCommission
}
