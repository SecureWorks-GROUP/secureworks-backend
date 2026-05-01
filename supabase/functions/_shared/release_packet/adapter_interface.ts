// Cap 0 Full Release Packet V2 — adapter interface contract.
//
// "Custom capture, standard release." Each scoping tool (patio-tool,
// fence-designer, ops-api Quick Quote, future decking/gates/repairs) keeps
// its own capture schema, UI, and pricing rules. At the moment of release,
// the adapter folds its capture into the standard envelope by implementing
// `buildScopeBlock`.
//
// The envelope is invariant. The validator dispatches on `scope.kind` to run
// adapter-specific hard-blocker rules. Onboarding a new service tool = ship
// an adapter implementation; nothing in the envelope or builder changes.

import type {
  ScopeBlock,
  PricingPublic,
} from './manifest_v2_types.ts'
import type { InternalCostSnapshot } from './internal_cost_types.ts'

// Inputs the adapter sees at release time. The caller (send-quote / ops-api)
// provides these. The adapter is a pure function of the inputs — no DB
// queries, no Resend, no GHL. Pure data shaping for testability.
export type AdapterInputs = {
  // Live job row at release. Adapter reads the fields it needs.
  job: {
    id: string
    type: string
    org_id: string
    client_name: string | null
    client_email: string | null
    client_phone: string | null
    site_address: string | null
    site_suburb: string | null
    site_lat: number | null
    site_lng: number | null
    job_number: string | null
    scope_json: Record<string, unknown> | null
    pricing_json: Record<string, unknown> | null
    notes: string | null
  }

  // Supplemental data the caller has fetched: job_contacts rows, run_line_items,
  // scoping-tool-specific fields the adapter needs. Each adapter narrows this.
  // Open-typed at the interface level so future adapters can extend.
  supplemental: Record<string, unknown>
}

// Output the adapter produces. The builder takes this and wraps it in the
// envelope (customer/contacts/site/documents/send/terms/provenance).
//
// Note: the adapter is responsible for assembling the full PricingPublic and
// InternalCostSnapshot for its service. The builder does not redo pricing
// math — it trusts the adapter's totals and only verifies reconciliation in
// the validator.
export type AdapterOutput = {
  scope: ScopeBlock
  pricing_public: PricingPublic
  internal_cost: InternalCostSnapshot

  // Adapter-provided QA facts. The validator combines these with envelope-
  // level facts (customer.mobile, media[], etc.) to compute the final
  // qa.hard_blockers_passed / qa.soft_warnings.
  qa_facts: {
    customer_facing_summary: string
    council_status:
      | 'not_required'
      | 'required_pending'
      | 'required_approved'
      | 'unknown'
    qa_passed_by: string | null
  }
}

// The function signature every adapter implements. Pure, sync, no side effects.
export type BuildScopeBlock = (inputs: AdapterInputs) => AdapterOutput

// Adapter registry shape. The builder uses `manifest.scope.kind` (or the
// caller hints at) to pick the right one.
export type AdapterRegistry = {
  patio?: BuildScopeBlock
  fence?: BuildScopeBlock
  quick_quote?: BuildScopeBlock
  decking?: BuildScopeBlock
  gate?: BuildScopeBlock
  repair?: BuildScopeBlock
}
