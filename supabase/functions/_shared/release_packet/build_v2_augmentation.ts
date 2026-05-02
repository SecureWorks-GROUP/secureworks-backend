// Cap 0 Full Release Packet V2 — Loop 3 / P2 augmentation helper.
//
// Used by send-quote and ops-api inside `recordReleasedQuoteRevision` to
// build the V2 envelope alongside the existing V1 minimal manifest. Runs
// the validator in mode='warn' so the build always succeeds with a
// populated warnings list — V2 never refuses a release in Loop 3. Loop 4
// flips to mode='enforce'.
//
// Output shape: column values that the caller adds to the same INSERT as
// the V1 columns. The two-shape co-residence is the whole architectural
// point of Loop 3 — V1 stays the load-bearing path; V2 ships in parallel
// so we can verify the shape against real production sends without any
// risk to release-truth contract.
//
// Storage uploads happen here too. Two parallel canonical texts go to the
// same private release-manifests bucket, hash-keyed:
//   • `<v2_manifest_hash>.json`     — V2 envelope canonical text. Required
//     for T7 evidence-spine verification: the sealed event's manifest_hash
//     must resolve to recoverable bytes. The V1 helper also uploads a
//     V1-shape manifest under a DIFFERENT hash; both coexist by design.
//   • `<internal_cost_hash>.json`   — internal cost canonical text.
//     Verifiable independently of manifest_hash. Inline column persists
//     a second copy as belt-and-braces.
//
// T7 evidence-spine compatibility: the returned column values include
// stable identifiers (release_id, manifest_hash, internal_cost_hash) and
// the full canonical bytes inline so the future T7 read path can cite
// any V2 row by hash without hitting Storage. The caller also emits a
// canonical `quote.release_packet.v2.sealed` business_event after the
// INSERT; see send-quote/ops-api for that emit.

import { dispatchAdapter } from './adapters/dispatch.ts'
import { buildFullReleasePacket } from './build_full_release_packet.ts'
import type { AdapterInputs } from './adapter_interface.ts'
import type {
  Customer,
  Contact,
  Site,
  Documents,
  MediaItem,
  Send,
  Terms,
  Provenance,
  ReleasedVia,
} from './manifest_v2_types.ts'

// ── Input shape ─────────────────────────────────────────────────────────────

export type V2AugmentationInput = {
  // Identity (matches the V1 helper's release identity).
  release_id: string                 // == quote_revisions.id (caller pre-allocates)
  job_id: string
  version: number
  released_via: ReleasedVia
  released_at: string
  released_by_user_id: string | null

  // Live job row — the adapter reads scope_json + pricing_json here.
  job_row: {
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
    ghl_contact_id: string | null
    xero_contact_id: string | null
    scope_json: Record<string, unknown> | null
    pricing_json: Record<string, unknown> | null
    notes: string | null
  }

  // job_contacts rows for the job. Adapter uses these to map per-contact
  // splits to real UUIDs (sentinel-prevention invariant).
  contacts: Array<{
    id: string
    contact_type: string | null
    is_primary: boolean | null
    contact_label: string | null
    client_name: string | null
    client_email: string | null
    client_phone: string | null
    assigned_runs: string[] | null
    share_percentage: number | null
  }>

  // job_media rows (pinned at-release).
  media: Array<{
    id: string
    type: string
    phase: string | null
    storage_url: string
    label: string | null
    taken_at: string | null
    lat: number | null
    lng: number | null
  }>

  // PDF + email context the V1 helper already had.
  quote_pdf_url: string
  quote_pdf_size_bytes: number | null
  email_subject: string
  email_custom_message: string
  email_template_version: string         // pass 'v1' until template versioning lands
  scoper_name: string

  // Send confirmation (post-Resend).
  resend_message_id: string | null
  primary_recipient_email: string
  per_contact_pdfs?: Array<{
    contact_id: string
    storage_path: string
    share_token: string
  }>

  // Terms (defaults applied if jobs.pricing_json doesn't carry them).
  terms_valid_days: number
  terms_payment_terms: string
  terms_deposit_pct: number

  // Provenance hints.
  scoper_user_id: string | null
  scoper_user_name: string | null
  scoped_at: string | null

  // Override allowlist for the validator. Empty array means no overrides
  // can be applied — fine for soft-warn mode.
  override_operator_allowlist: string[]

  // Internal sha256 helpers — called by the helper to compute file hashes
  // when input doesn't already have them. Kept as a callback so the
  // helper stays pure-data-shaping (no fetches inside this module).
  // Loop 3 callers pass empty placeholders; the validator warns.
  pdf_sha256: string
  email_html_sha256: string
}

// ── Output: column values for the same INSERT as V1 ────────────────────────

export type V2AugmentationResult = {
  ok: true
  // V2 jsonb columns (drop into the INSERT alongside V1 columns).
  contacts_snapshot_json: unknown
  documents_snapshot_json: unknown
  media_snapshot_json: unknown
  qa_snapshot_json: unknown
  send_snapshot_json: unknown
  terms_snapshot_json: unknown
  provenance_snapshot_json: unknown
  option_label: string | null
  internal_cost_snapshot_json: unknown
  internal_cost_canonical_text: string
  internal_cost_hash: string
  // V2 envelope canonical bytes — surfaced so callers can log/audit and so
  // tests can assert sha256(manifest_canonical_text) === manifest_hash. Not
  // persisted inline in a quote_revisions column today (no V2-shape column
  // exists; V1's manifest_canonical_text column belongs to the V1 hash).
  // Stored in the private release-manifests bucket at <manifest_hash>.json
  // by buildV2Augmentation step 4.
  manifest_canonical_text: string
  // Hashes also exposed at the top level so callers can use them
  // for the canonical event without re-deriving.
  manifest_hash: string
  release_id: string
  // Warnings for log/observation.
  hard_blockers_passed: string[]
  soft_warnings: string[]
}

export type V2AugmentationFail = {
  ok: false
  reason: string
}

// ── Helper ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''

/**
 * Builds the V2 envelope using validator mode='warn' and uploads the
 * internal-cost canonical text to release-manifests bucket. Returns
 * column values to the caller for inclusion in the same quote_revisions
 * INSERT as V1 columns.
 *
 * Returns {ok:false} ONLY when the adapter dispatch fails (unknown
 * jobs.type with no V2 adapter). In all other cases (warnings,
 * partial captures, missing sha256s) the build succeeds and the caller
 * gets back the column values.
 */
export async function buildV2Augmentation(
  sb: any,
  input: V2AugmentationInput,
): Promise<V2AugmentationResult | V2AugmentationFail> {
  // 1. Run the V2 adapter.
  const adapterInputs: AdapterInputs = {
    job: {
      id: input.job_row.id,
      type: input.job_row.type,
      org_id: input.job_row.org_id,
      client_name: input.job_row.client_name,
      client_email: input.job_row.client_email,
      client_phone: input.job_row.client_phone,
      site_address: input.job_row.site_address,
      site_suburb: input.job_row.site_suburb,
      site_lat: input.job_row.site_lat,
      site_lng: input.job_row.site_lng,
      job_number: input.job_row.job_number,
      scope_json: input.job_row.scope_json,
      pricing_json: input.job_row.pricing_json,
      notes: input.job_row.notes,
    },
    supplemental: {
      contacts: input.contacts.map((c) => ({
        id: c.id,
        is_primary: c.is_primary,
        contact_type: c.contact_type,
        contact_label: c.contact_label,
        client_email: c.client_email,
      })),
    },
  }

  const dispatched = dispatchAdapter(adapterInputs)
  if (!dispatched.ok) {
    return { ok: false, reason: dispatched.reason }
  }

  // 2. Assemble V2 envelope inputs.
  const customer: Customer = {
    name: input.job_row.client_name ?? '',
    mobile: input.job_row.client_phone,
    email: input.job_row.client_email ?? '',
    ghl_contact_id: input.job_row.ghl_contact_id,
    xero_contact_id_at_release: input.job_row.xero_contact_id,
  }

  const contacts: Contact[] = input.contacts.map((c) => ({
    id: c.id,
    role: c.contact_type ?? (c.is_primary ? 'primary' : 'neighbour'),
    label: c.contact_label,
    email: c.client_email,
    phone: c.client_phone,
    assigned_runs: c.assigned_runs ?? null,
    share_pct: c.share_percentage ?? null,
    // Authority is GAP today; default per § 9: scoper-designated. Soft-
    // warn mode produces a warning that this should be captured at scope
    // time. For Loop 3 we apply pragmatic defaults: primary can-view+
    // can-accept+pays; non-primary contacts can-view, can-accept,
    // pays only when assigned_runs is non-empty (i.e. a paying neighbour).
    authority: {
      can_view: true,
      can_accept: c.is_primary === true || (c.assigned_runs?.length ?? 0) > 0,
      pays: c.is_primary === true || (c.assigned_runs?.length ?? 0) > 0,
    },
  }))

  const site: Site = {
    address: input.job_row.site_address,
    suburb: input.job_row.site_suburb,
    lat: input.job_row.site_lat,
    lng: input.job_row.site_lng,
    council: null, // GAP; warn
    access: { chips: [], notes: '' },
    constraints: { chips: [], notes: '' },
    handover_instructions: input.job_row.notes ?? '',
  }

  const documents: Documents = {
    quote_pdf: {
      storage_path: input.quote_pdf_url,
      sha256: input.pdf_sha256,
      size_bytes: input.quote_pdf_size_bytes,
    },
    per_contact_pdfs: (input.per_contact_pdfs ?? []).map((p) => ({
      contact_id: p.contact_id,
      storage_path: p.storage_path,
      sha256: '',           // GAP; warn
      share_token: p.share_token,
    })),
    email: {
      subject: input.email_subject,
      custom_message: input.email_custom_message,
      scoper_name: input.scoper_name,
      template_version: input.email_template_version,
      html_sha256: input.email_html_sha256,
    },
    attachments: [],
    council_plans: null,
  }

  const media: MediaItem[] = input.media.map((m) => ({
    id: m.id,
    type: m.type,
    phase: m.phase,
    storage_path: m.storage_url,
    sha256: '',              // GAP; warn
    label: m.label,
    taken_at: m.taken_at,
    lat: m.lat,
    lng: m.lng,
  }))

  const send: Send = {
    recipients: [{
      contact_id: contacts.find((c) => c.email === input.primary_recipient_email)?.id
        ?? contacts.find((c) => c.role === 'primary')?.id
        ?? '',
      email: input.primary_recipient_email,
      resend_message_id: input.resend_message_id,
      sent_at: input.released_at,
    }],
  }

  const terms: Terms = {
    valid_days: input.terms_valid_days,
    expires_at: new Date(
      new Date(input.released_at).getTime() + input.terms_valid_days * 86400000,
    ).toISOString(),
    payment_terms: input.terms_payment_terms,
    deposit_pct: input.terms_deposit_pct,
    terms_version: 'legacy_unknown',
    terms_document_ref: null,
  }

  const provenance: Provenance = {
    tool_name:
      input.released_via === 'ops-api/send_quick_quote_email'
        ? 'ops-api'
        : (input.job_row.type === 'fencing' ? 'fence-designer' : 'patio-tool'),
    tool_version: 'v1',
    pricing_engine_version: 'v1',
    scoper_user_id: input.scoper_user_id,
    scoper_name: input.scoper_user_name,
    scoped_at: input.scoped_at,
  }

  // 3. Build the V2 packet in mode='warn'.
  const built = await buildFullReleasePacket({
    release_id: input.release_id,
    job_id: input.job_id,
    version: input.version,
    released_via: input.released_via,
    released_at: input.released_at,
    released_by_user_id: input.released_by_user_id,
    adapter_output: dispatched.output,
    customer,
    contacts,
    site,
    documents,
    media,
    send,
    terms,
    provenance,
    option_label: null,
    superseded_by_revision_id: null,
    overrides: [],
    override_operator_allowlist: input.override_operator_allowlist,
    mode: 'warn',
  })

  if (!built.ok) {
    // Should NEVER happen in mode='warn' (validator demotes hard rules to
    // warnings). Defensive only.
    return {
      ok: false,
      reason: `unexpected V2 build failure in warn mode: ${built.errors.map((e) => e.rule).join(',')}`,
    }
  }

  // 4. Upload V2 manifest_canonical_text + internal_cost_canonical_text to
  //    the private release-manifests bucket. Both keyed by their hash.
  //
  //    The V2 manifest upload is what makes the sealed event's manifest_hash
  //    citeable by T7: without these bytes in the bucket, T7 cannot verify
  //    that the V2 hash in the timeline matches anything. We do NOT
  //    duplicate the bytes inline — there's no V2-shape manifest column
  //    today (the existing manifest_canonical_text column is V1's, hashed
  //    to the V1 manifest_hash). T7 verification is therefore Storage-
  //    dependent for the V2 envelope; it is double-buffered (inline +
  //    Storage) for internal_cost_canonical_text.
  //
  //    Best-effort uploads; on failure the V2 row still INSERTs and we log
  //    a structured error. Loop 4 (enforce mode) can promote upload
  //    failure to a hard-block — out of scope for Loop 3.
  await uploadCanonicalText(sb, {
    object_path: `${built.manifest_hash}.json`,
    canonical_text: built.manifest_canonical_text,
    log_tag: '[v2-manifest-upload-fail]',
    log_extra: {
      job_id: input.job_id,
      version: input.version,
      manifest_hash: built.manifest_hash,
    },
  })

  await uploadCanonicalText(sb, {
    object_path: `${built.internal_cost_hash}.json`,
    canonical_text: built.internal_cost_canonical_text,
    log_tag: '[v2-internal-cost-upload-fail]',
    log_extra: {
      job_id: input.job_id,
      version: input.version,
      internal_cost_hash: built.internal_cost_hash,
      note: 'falling back to inline canonical text only; no Storage object',
    },
  })

  // 5. Return column values + observability.
  return {
    ok: true,
    contacts_snapshot_json: built.manifest.contacts,
    documents_snapshot_json: built.manifest.documents,
    media_snapshot_json: built.manifest.media,
    qa_snapshot_json: built.manifest.qa,
    send_snapshot_json: built.manifest.send,
    terms_snapshot_json: built.manifest.terms,
    provenance_snapshot_json: built.manifest.provenance,
    option_label: built.manifest.option_label,
    internal_cost_snapshot_json: built.internal_cost_snapshot,
    internal_cost_canonical_text: built.internal_cost_canonical_text,
    internal_cost_hash: built.internal_cost_hash,
    manifest_canonical_text: built.manifest_canonical_text,
    manifest_hash: built.manifest_hash,
    release_id: input.release_id,
    hard_blockers_passed: built.hard_blockers_passed,
    soft_warnings: built.soft_warnings,
  }
}

/**
 * Convenience helper: emits the canonical T7-compatible
 * `quote.release_packet.v2.sealed` business_event.
 *
 * The caller (send-quote / ops-api) calls this AFTER the V1+V2 INSERT
 * succeeds, with the released revision id and hashes from the
 * V2AugmentationResult. The event is append-only — the future T7
 * evidence spine reads this event timeline to enumerate all V2-sealed
 * release packets and cite them via evidence_refs.
 */
export type V2SealedEventInput = {
  job_id: string
  quote_revision_id: string
  release_id: string
  version: number
  manifest_hash: string
  internal_cost_hash: string
  released_via: ReleasedVia
}

export async function emitV2SealedEvent(
  sb: any,
  input: V2SealedEventInput,
): Promise<void> {
  try {
    const nowIso = new Date().toISOString()
    const { error } = await sb.from('business_events').insert({
      event_type: 'quote.release_packet.v2.sealed',
      source: input.released_via,
      occurred_at: nowIso,
      recorded_at: nowIso,
      entity_type: 'quote_revision',
      entity_id: input.quote_revision_id,
      correlation_id: input.job_id,
      job_id: input.job_id,
      payload: {
        quote_revision_id: input.quote_revision_id,
        release_id: input.release_id,
        version: input.version,
        manifest_hash: input.manifest_hash,
        internal_cost_hash: input.internal_cost_hash,
        released_via: input.released_via,
        v2_schema_version: '2.0',
      },
      metadata: {
        handler: input.released_via,
        loop: 'cap0-v2-p2-soft-warn',
      },
      schema_version: '1.0',
    })
    if (error) {
      console.error('[v2-sealed-event-fail]', JSON.stringify({
        job_id: input.job_id,
        quote_revision_id: input.quote_revision_id,
        error: error.message ?? String(error),
      }))
    }
  } catch (e: any) {
    console.error('[v2-sealed-event-fail]', JSON.stringify({
      job_id: input.job_id,
      quote_revision_id: input.quote_revision_id,
      error: e?.message ?? String(e),
    }))
  }
}

// ── Internal: Storage upload helper ────────────────────────────────────────

type UploadCanonicalTextArgs = {
  object_path: string
  canonical_text: string
  log_tag: string
  log_extra: Record<string, unknown>
}

/**
 * Best-effort hash-keyed canonical-text upload. Treats 409/duplicate as
 * benign idempotent re-runs (same hash → same bytes). Any other failure
 * is logged structurally and swallowed; the V2 row INSERT must still
 * complete so V1 release-truth stays intact.
 */
async function uploadCanonicalText(
  sb: any,
  args: UploadCanonicalTextArgs,
): Promise<void> {
  try {
    const bytes = new TextEncoder().encode(args.canonical_text)
    const { error: upErr } = await sb.storage
      .from('release-manifests')
      .upload(args.object_path, bytes, {
        contentType: 'application/json',
        upsert: false,
      })
    if (upErr) {
      const dup = (upErr as any)?.statusCode === '409'
        || /duplicate|already exists/i.test(upErr.message ?? '')
      if (!dup) {
        console.error(args.log_tag, JSON.stringify({
          ...args.log_extra,
          object_path: args.object_path,
          error: upErr.message ?? String(upErr),
        }))
      }
    }
  } catch (e: any) {
    console.error(args.log_tag, JSON.stringify({
      ...args.log_extra,
      object_path: args.object_path,
      error: e?.message ?? String(e),
    }))
  }
}

// SUPABASE_URL is read at module load. Keeping the import here is purely
// defensive against lints; the env-var is referenced inside async paths.
void SUPABASE_URL
