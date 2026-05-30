// Cap 0 Full Release Packet V2 — TypeScript types for the standard envelope.
//
// V2 is the "full release packet" shape. It supersedes MinimalReleaseManifest
// (manifest_types.ts) as the canonical at-release snapshot. The minimal shape
// stays for back-compat with rows already in production; new sends post-V2
// adoption use the V2 envelope.
//
// Architectural principles (from cap0-full-release-packet-v2 plan rev 2):
//   - Custom capture, standard release: each scoping tool keeps its own
//     capture schema; adapters fold into this invariant envelope.
//   - QuoteReleasePacket sealed at quote send, never mutated.
//   - Three field classes: §R sealed-at-release (this file), §C lifecycle
//     checkpoint (separate types, P4), §L live-joined (T5 dossier).
//   - Two parallel hashes: manifest_hash covers the client-facing manifest
//     (everything in this file). internal_cost_hash covers the parallel
//     InternalCostSnapshot (internal_cost_types.ts).
//
// IMPORTANT: this type defines the shape that gets canonicalized + hashed for
// `manifest_hash`. Internal cost data is NEVER in this envelope — it lives in
// the parallel InternalCostSnapshot. External/client/legal audit can verify
// the manifest hash without ever seeing internal commercials.

import type { CouncilStatus } from './manifest_types.ts'

// ── Sentinel values that indicate adapter-side data integrity failures ─────
//
// Adapters MUST NEVER fabricate a contact_id. When the primary contact
// cannot be resolved from `supplemental.contacts` for a shared/neighbour
// fence line, the adapter writes the client share with this sentinel id
// rather than (a) dropping the share entirely (silent loss of customer
// liability) or (b) writing a literal like 'primary' (looks like data,
// doesn't dereference).
//
// The envelope-level validator rule `pricing.per_contact_ids_resolved`
// hard-fails any release packet that contains this sentinel anywhere in
// `pricing_public.line_items[].per_contact[].contact_id` or
// `pricing_public.per_contact_totals[].contact_id`. The rule is
// non-overridable. Releases with unresolved primary contacts therefore
// CANNOT ship — the bug surfaces as a structured error at send time
// instead of escaping into the sealed manifest.
//
// The sentinel intentionally uses double-underscore prefix + double-
// underscore suffix to be obviously not-a-real-uuid to a reviewer.
export const UNRESOLVED_PRIMARY_CONTACT_ID = '__unresolved_primary_contact__'

// Reserved synthetic-id values that adapters must never write. Validator
// rejects any contact_id matching one of these. New synthetic-ids should
// be added here as bugs are caught.
export const RESERVED_SYNTHETIC_CONTACT_IDS: ReadonlySet<string> = new Set([
  UNRESOLVED_PRIMARY_CONTACT_ID,
  'primary',          // historical bug — see commit 4efe23c
  'neighbour',        // defensive: never let bare role-words land as ids
  'client',
  'unknown',
  '',                 // empty string is not an id
])

// ── Core identity + provenance ───────────────────────────────────────────────

export type ReleasedVia =
  | 'send-quote/send'
  | 'send-quote/send-runs'
  | 'ops-api/send_quick_quote_email'

export type Customer = {
  name: string
  mobile: string | null
  email: string
  ghl_contact_id: string | null
  // Often null at quote send because Xero contact is created at acceptance.
  // Kept here so a later read knows what was tied at-release; live-joined
  // updates surface via T5 dossier, not through manifest mutation.
  xero_contact_id_at_release: string | null
}

export type ContactAuthority = {
  // Per §9 default: scoper-designated. The scoper sets these on each contact
  // at scope time. The accept endpoint enforces can_accept; the recall surface
  // enforces can_view. `pays=true` contacts are required-acceptors before
  // operational proceed.
  can_view: boolean
  can_accept: boolean
  pays: boolean
}

export type Contact = {
  id: string
  // 'primary' | 'neighbour' | 'joint' — kept open as string at type level so
  // current job_contacts.contact_type values flow through unmodified.
  role: string
  label: string | null
  email: string | null
  phone: string | null
  assigned_runs: string[] | null
  share_pct: number | null
  authority: ContactAuthority
}

export type SiteAccess = {
  chips: string[]
  notes: string
}

export type SiteConstraints = {
  chips: string[]
  notes: string
}

export type Site = {
  address: string | null
  suburb: string | null
  lat: number | null
  lng: number | null
  // GAP today — capture in scoping tool. Free-text council jurisdiction
  // (e.g. 'City of Joondalup'). Distinct from council_status enum in qa block.
  council: string | null
  access: SiteAccess
  constraints: SiteConstraints
  handover_instructions: string
}

// ── Service-specific scope blocks (adapter outputs) ──────────────────────────

export type PatioDimensions = {
  width_m: number
  depth_m: number
  height_m: number | null
}

export type PatioPackageLine = {
  line_id: string
  description: string
  qty: number
  unit: string
}

export type PatioScopeBlock = {
  kind: 'patio'
  schema_version: '2.0'
  structure_type: string
  dimensions: PatioDimensions
  roof_sheet_colour: string | null
  post_type: string | null
  footings: string | null
  gutter: string | null
  fascia: string | null
  electrical_yes_no: boolean
  demo_yes_no: boolean
  package_lines: PatioPackageLine[]
}

export type FenceGate = {
  type: string
  width_mm: number
  height_mm: number
  hardware: string | null
}

export type FenceRun = {
  run_label: string
  type: string
  height_mm: number
  lineal_m: number
  panels: number | null
  posts: number | null
  infill: string | null
  finish: string | null
  demo: boolean
  gates: FenceGate[]
}

export type FenceScopeBlock = {
  kind: 'fence'
  schema_version: '2.0'
  runs: FenceRun[]
  // boundary_plan_media_id is captured in `media[]` by id; this flag is the
  // adapter's hint that the run actually had a boundary plan attached.
  boundary_plan_attached: boolean
}

export type QuickQuoteScopeBlock = {
  kind: 'quick_quote'
  schema_version: '2.0'
  label: string
  description: string
}

// Future-service templates: structurally allowed, not implemented in P0.
export type DeckingScopeBlock = {
  kind: 'decking'
  schema_version: '2.0'
  // Stub: real shape in P4
  raw: unknown
}

export type GateScopeBlock = {
  kind: 'gate'
  schema_version: '2.0'
  raw: unknown
}

export type RepairScopeBlock = {
  kind: 'repair'
  schema_version: '2.0'
  raw: unknown
}

export type ScopeBlock =
  | PatioScopeBlock
  | FenceScopeBlock
  | QuickQuoteScopeBlock
  | DeckingScopeBlock
  | GateScopeBlock
  | RepairScopeBlock

export type ScopeKind = ScopeBlock['kind']

// ── Pricing — client-facing (in manifest_hash) ───────────────────────────────

export type LineCategory = 'material' | 'labour' | 'subcontract' | 'extra' | 'demo'

export type LineAllocation = 'client' | 'shared' | 'neighbour'

export type PerContactSplit = {
  contact_id: string
  amount_ex: number
}

export type PricingLineItem = {
  // Stable line id — per the V1 spec, content-derived so reorders don't
  // change the hash. Adapter is responsible for picking a stable scheme.
  line_id: string
  category: LineCategory
  description: string
  qty: number
  unit: string
  unit_sell: number
  line_total_ex: number
  // Allocation only meaningful for fence; 'client' for non-fence releases.
  allocation: LineAllocation
  split_pct: number
  // Per-contact breakdown for shared/neighbour lines; empty for pure client lines.
  per_contact: PerContactSplit[]
}

export type PricingTotals = {
  subtotal_ex_gst: number
  gst: number
  total_ex_gst: number
  total_inc_gst: number
}

export type PerContactTotal = {
  contact_id: string
  total_ex_gst: number
  total_inc_gst: number
}

export type PricingPublic = {
  line_items: PricingLineItem[]
  totals: PricingTotals
  per_contact_totals: PerContactTotal[]
}

// ── Documents (PDFs, attachments) — content-hashed ──────────────────────────

export type DocumentRef = {
  storage_path: string
  sha256: string
  size_bytes: number | null
}

export type PerContactPdf = {
  contact_id: string
  storage_path: string
  sha256: string
  share_token: string
}

export type EmailDocument = {
  subject: string
  custom_message: string
  scoper_name: string
  template_version: string
  // SHA-256 of the rendered HTML the client received. Hash only — body itself
  // is not stored (too large; reproducible from inputs).
  html_sha256: string
}

export type AttachmentRef = {
  storage_path: string
  sha256: string
  filename: string
}

export type Documents = {
  quote_pdf: DocumentRef
  per_contact_pdfs: PerContactPdf[]
  email: EmailDocument
  attachments: AttachmentRef[]
  council_plans: DocumentRef | null
}

// ── Media (photos, videos, 3D model, drawings) ──────────────────────────────

export type MediaItem = {
  id: string
  // 'site_photo' | 'walkthrough_video' | 'drawing' | 'model' | 'pre_install_photo'
  // Open at type level to allow new media types without contract churn.
  type: string
  phase: string | null
  storage_path: string
  sha256: string
  label: string | null
  taken_at: string | null
  lat: number | null
  lng: number | null
}

// ── QA snapshot ─────────────────────────────────────────────────────────────

export type QaOverride = {
  rule_name: string
  category: string
  reason: string
  operator_user_id: string
  // Per §9 default: 'Marnin' or 'Shaun'. Free-text role label.
  operator_role: string
  timestamp: string
}

export type QaSnapshot = {
  // Names of every gate that the validator confirmed passed. Sealed in the
  // manifest so future audits can verify which gates were live at-release.
  hard_blockers_passed: string[]
  // Soft gates that fired warnings but didn't block.
  soft_warnings: string[]
  council_status: CouncilStatus
  // Hard-blocker: must be ≥40 chars (validator enforces).
  customer_facing_summary: string
  // When non-empty, each entry justifies a specific hard-blocker bypass.
  overrides: QaOverride[]
  qa_passed_by: string | null
}

// ── Send confirmations (at-release subset; live status via T5 dossier) ──────

export type SendRecipient = {
  contact_id: string
  email: string
  resend_message_id: string | null
  sent_at: string
}

export type Send = {
  recipients: SendRecipient[]
}

// ── Terms ───────────────────────────────────────────────────────────────────

export type Terms = {
  valid_days: number
  expires_at: string
  payment_terms: string
  deposit_pct: number
  // Per §9 default: 'legacy_unknown' until canonical T&C documents exist with
  // versions; once they do, this becomes the actual version string.
  terms_version: string
  terms_document_ref: string | null
}

// ── Provenance ──────────────────────────────────────────────────────────────

export type Provenance = {
  tool_name: string
  tool_version: string
  pricing_engine_version: string
  scoper_user_id: string | null
  scoper_name: string | null
  scoped_at: string | null
}

// ── The standard envelope ───────────────────────────────────────────────────

export type QuoteReleasePacketV2 = {
  schema_version: '2.0'
  release_id: string
  job_id: string
  version: number
  released_via: ReleasedVia
  released_at: string
  released_by_user_id: string | null

  customer: Customer
  contacts: Contact[]
  site: Site

  scope: ScopeBlock

  pricing_public: PricingPublic

  documents: Documents

  media: MediaItem[]

  qa: QaSnapshot

  send: Send

  terms: Terms

  provenance: Provenance

  // Per §9 default: structural support for option_label only. End-to-end
  // option-comparison UI is deferred to a later loop. Most releases pass null.
  option_label: string | null

  // Populated by the supersession trigger when a higher-version row INSERTs
  // for the same job. Lifecycle implementation in P4 (Loop 5).
  superseded_by_revision_id: string | null

  // Scope-Memory-Saving Loop 1, step 6 — citation of the frozen
  // scope_revisions row this packet describes. Non-Quick-Quote callers
  // (send-quote/send, send-quote/send-runs) look up the latest frozen
  // revision for the job and pass it through; Quick Quote remains a
  // documented shortcut path and writes null. Backward compatible:
  // packets sealed before Loop 1 ship with null and validate fine. The
  // Cap 0 V2 enforce-mode flip (Loop 6 of the substrate roadmap) is the
  // gate that will refuse non-Quick-Quote releases without this id.
  scope_revision_id: string | null
}
