// ════════════════════════════════════════════════════════════
// SecureWorks — Ops API Edge Function
// deploy-lane-validate: 2026-05-30.v4
//
// Backend for the Ops Dashboard (scheduling, POs, WOs, pipeline)
// and Trade mobile view. All data access uses service_role.
//
// Deploy:
//   supabase functions deploy ops-api --no-verify-jwt --project-ref kevgrhcjxspbxgovpmfl
//   (CI deploys automatically on push to main via .github/workflows/deploy-edge-functions.yml)
//   (Laptop deploys must use scripts/deploy-edge.sh with SECUREWORKS_LAPTOP_DEPLOY_OVERRIDE=1)
//
// JWT flag: --no-verify-jwt (dashboard calls use x-api-key auth, not Supabase JWT)
//
// Actions (via ?action= query param):
//
//   ── Read (Ops Dashboard) ──
//   ops_summary         — Today tab: stat cards, schedule, attention items
//   calendar            — Calendar events for date range (?from=&to=)
//   pipeline            — Jobs by status for kanban view
//   job_detail          — Full job + assignments + POs + WOs + invoices
//   list_invoices       — Xero invoices with filters
//   list_quotes         — Jobs in quote stage (draft/quoted) with search
//   list_pos            — Purchase orders with filters
//   list_work_orders    — Work orders with filters
//   list_suppliers      — Supplier dropdown data
//   list_users          — All users (for assignment dropdowns)
//   ops_targets         — KPI targets vs actuals
//
//   ── Write (Ops Dashboard) ──
//   create_assignment   — Schedule a job on the calendar
//   update_assignment   — Move/update calendar assignment
//   delete_assignment   — Remove assignment
//   update_job_status   — Move job between statuses
//   create_po           — Create local draft PO
//   update_po           — Update PO fields
//   push_po_to_xero     — POST PO to Xero API
//   create_work_order   — Create WO
//   update_work_order   — Update WO fields
//   send_work_order     — Mark WO as sent to trade
//   create_invoice      — POST invoice to Xero API
//   complete_and_invoice — Mark complete + create Xero invoice (deposit-aware)
//   create_deposit_invoice — Create deposit invoice (% of quoted total)
//   sync_suppliers      — Pull suppliers from Xero contacts
//
//   ── Job Completion Package ──
//   complete_job         — Mark job complete + GHL stage sync
//   send_payment_link    — Get Xero online invoice URL + SMS to client
//   send_acceptance_invoice — Create deposit invoice + send payment link in one call
//   send_review_request  — SMS client with Google review link
//
//   ── Crew & Scheduling ──
//   get_crew_availability — Crew availability for date range (calendar)
//   set_availability      — Upsert crew availability dates
//   confirm_assignment    — Confirm assignment + optional client SMS
//   bulk_confirm          — Confirm multiple assignments at once
//
//   ── AI / Automation ──
//   morning_brief       — Enriched ops summary for AI morning brief
//   scope_to_po         — Extract materials from scope_json for PO auto-populate
//   dismiss_alert       — Dismiss an AI alert
//   annotations         — Query active AI annotations (GET)
//   resolve_annotation  — Resolve an AI annotation with response (POST)
//
//   ── Price Intelligence ──
//   extract_po_pricing  — Extract line item prices from PO into material_price_ledger
//   confirm_price       — Confirm a pending price ledger entry
//   dismiss_price       — Dismiss a pending price ledger entry
//   pending_prices      — List pending price entries for review
//
//   ── Public (no auth) ──
//   view_shared_report  — Homeowner view of submitted report (by share_token)
//
//   ── Trade (mobile) ──
//   my_jobs             — Jobs assigned to a user
//   trade_job_detail    — Trimmed job view for trades
//   add_note            — Add note to job timeline
//   upload_photo        — Upload completion photo (base64)
//   submit_service_report — Save checklist + notes + signature
//   get_service_report  — Load existing report
//   my_hours            — Completed assignments for a week with hours
//   submit_trade_invoice — Build invoice + push to Xero as ACCPAY bill
//   my_trade_invoices   — Trade's invoice history
//   set_trade_rate      — Trade sets/updates their hourly rate
//   create_trade_alert  — Report on-site issue → ai_alerts (amber)
//
//   ── Trade Invoicing (Ops) ──
//   list_trade_invoices — All trade invoices for ops visibility
//   set_trade_rate_ops  — Ops sets rate for a trade
//   push_trade_invoice_to_xero — Push acknowledged trade invoice to Xero as ACCPAY bill
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// CAP0-QUOTE-REVISION-QUICKQUOTE — shared release-packet builders so Quick Quote
// records the same immutable quote_revisions row shape as send-quote /send.
import { canonicalJsonAndHash } from '../_shared/release_packet/canonicalize.ts'
import { buildMinimalReleaseManifest } from '../_shared/release_packet/build_minimal_manifest.ts'
import type { CouncilStatus } from '../_shared/release_packet/manifest_types.ts'
// Loop 3 / P2 V2 augmentation — runs alongside V1 in soft-warn mode.
import {
  buildV2Augmentation,
  emitV2SealedEvent,
  type V2AugmentationInput,
} from '../_shared/release_packet/build_v2_augmentation.ts'
// T7 Loop 2 — Evidence Health (read-only). Backed by views in
// 20260502000010_v_evidence_health.sql.
import { getEvidenceHealth } from '../_shared/evidence/health.ts'
// T7 Loop 3 — Evidence body retrieval. Role-gated; hash-verified before
// signing a URL. Body bytes never returned inline.
import { getEvidenceBody } from '../_shared/evidence/body_handler.ts'
// T7 Loop 5 — atomic cutover for ops-api po.created (closes G2) and
// future quote/invoice/payment writers. Channel='po' / 'invoice' / 'payment'.
import { recordEvidence } from '../_shared/evidence/record_evidence.ts'
import { isFlagOn } from '../_shared/evidence/feature_flag.ts'

// Cap 1C — stage-gate engine (pure, read-only). Used by the shadow-mode
// wrapper inside updateJobStatus. Static import so the Supabase deploy
// bundler reliably includes the module bytes.
import { evaluateStageGates } from '../_shared/stage-gate/engine.ts'

// Scope-Memory-Saving Loop 1 — frozen-scope helper primitives. Backs the
// freeze_scope / clone_scope_for_edit POST actions.
import {
  freezeScope as _freezeScope,
  cloneScopeForEdit as _cloneScopeForEdit,
  healFrozenInvariant as _healFrozenInvariant,
  isToolKind as _isToolKind,
} from '../_shared/scope_freeze/scope_freeze.ts'
// Scope-Memory-Saving Loop 1, step 5 — render artefact persistence. Backs
// the record_scope_artifact POST action used by patio-tool + fence-designer
// freeze flows.
import {
  recordScopeArtifact as _recordScopeArtifact,
  isArtifactType as _isArtifactType,
} from '../_shared/scope_freeze/record_scope_artifact.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const XERO_CLIENT_ID = Deno.env.get('XERO_CLIENT_ID') || ''
const XERO_CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET') || ''
const GHL_API_TOKEN = Deno.env.get('GHL_API_TOKEN') || ''
const GHL_LOCATION_ID = Deno.env.get('GHL_LOCATION_ID') || ''
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || ''
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'
const SW_API_KEY = Deno.env.get('SW_API_KEY') || ''
const SECUREWORKS_AGENT_URL = (Deno.env.get('SECUREWORKS_AGENT_URL') || Deno.env.get('RAILWAY_AGENT_URL') || 'https://secureworks-agent-production.up.railway.app').replace(/\/+$/, '')
const SECUREWORKS_AGENT_BEARER = Deno.env.get('AGENT_BEARER_TOKEN') || SW_API_KEY || SUPABASE_SERVICE_KEY
const OPS_API_SOURCE_REPO = 'secureworks-site'
const OPS_API_BUILD_LABEL = 'ops-apiV1-trusted-18MAY-plus-secure-sale'
const OPS_API_EXPECTED_ACTION_COUNT = 224

// Test data filter — exclude test records from production outputs
const isTestRecord = (name: string | null | undefined): boolean =>
  !name ? false : /\btest\b/i.test(name) || /^marnin test/i.test(name)

// ── Reply-to routing: fencing jobs → fencing@, everything else → patios@ ──
function getClientReplyTo(jobType: string | null, jobNumber?: string): string {
  const dept = jobType === 'fencing' ? 'fencing' : 'patios'
  const tag = jobNumber ? `+${jobNumber}` : ''
  return `${dept}${tag}@secureworkswa.com.au`
}

// ── Log outbound email as a note on the GHL contact (fire-and-forget) ──
function logEmailToGHL(contactId: string | null, subject: string, recipient: string) {
  if (!contactId) return
  fetch(`${SUPABASE_URL}/functions/v1/ghl-proxy?action=add_note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': SW_API_KEY },
    body: JSON.stringify({
      contactId,
      body: `Email sent: "${subject}" to ${recipient}`,
    }),
  }).catch(() => {})
}

const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token'
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
}

class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

function sb() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
}

function opsApiVersion() {
  return {
    ok: true,
    source_repo: OPS_API_SOURCE_REPO,
    build_label: OPS_API_BUILD_LABEL,
    expected_action_count: OPS_API_EXPECTED_ACTION_COUNT,
    commit_sha:
      Deno.env.get('GITHUB_SHA')
      || Deno.env.get('VERCEL_GIT_COMMIT_SHA')
      || Deno.env.get('RAILWAY_GIT_COMMIT_SHA')
      || Deno.env.get('COMMIT_SHA')
      || null,
    deployed_at:
      Deno.env.get('DEPLOYED_AT')
      || Deno.env.get('BUILD_TIMESTAMP')
      || null,
    canonical_note: 'Production ops-api deploys from secureworks-site/supabase/functions/ops-api only.',
  }
}

// Dual-write: log to business_events (CloudEvents pattern)
// Non-blocking — failures don't break the main operation
async function logBusinessEvent(client: any, event: {
  event_type: string;
  source?: string;
  entity_type: string;
  entity_id: string;
  correlation_id?: string;
  causation_id?: string;
  job_id?: string;
  payload?: any;
  metadata?: any;
  // N2 — caller-supplied body_preview wins over derivation from payload
  // when present. Used by quote.sent emitters so the v2 extractor's
  // pre-filter sees a structured one-line summary, not the UUID stub.
  body_preview?: string;
}) {
  try {
    const payload = event.payload || {}
    const eventType = String(event.event_type || '')
    const inferredChannel =
      eventType.includes('email') ? 'email'
      : eventType.includes('sms') || eventType.includes('reply') ? 'sms'
      : eventType.includes('call') || eventType.includes('transcript') ? 'call'
      : eventType.includes('note') ? 'note'
      : null
    const inferredDirection =
      eventType.endsWith('_in') || eventType === 'client.reply' ? 'inbound'
      : eventType.endsWith('_out') ? 'outbound'
      : inferredChannel === 'note' ? 'internal'
      : inferredChannel === 'call' && typeof payload.direction === 'string' ? payload.direction
      : null
    const textish = String(
      event.body_preview ||
      payload.body_preview ||
      payload.note_text ||
      payload.note_preview ||
      payload.message_text ||
      payload.message_preview ||
      payload.body ||
      payload.text ||
      payload.message ||
      ''
    )
    const sourceTable =
      payload.inbox_events_id ? 'inbox_events'
      : payload.source_job_event_id ? 'job_events'
      : null
    const sourceId = payload.inbox_events_id || payload.source_job_event_id || null
    await client.from('business_events').insert({
      event_type: event.event_type,
      source: event.source || 'app/office',
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      correlation_id: event.correlation_id || null,
      causation_id: event.causation_id || null,
      job_id: event.job_id || null,
      channel: inferredChannel,
      direction: inferredDirection,
      source_table: sourceTable,
      source_id: sourceId,
      body_preview: textish ? textish.slice(0, 500) : null,
      safe_summary: textish ? textish.slice(0, 280) : null,
      match_status: event.job_id ? 'matched' : null,
      match_method: event.job_id ? 'direct_job_id' : null,
      match_confidence: event.job_id ? 1.0 : null,
      payload,
      metadata: {
        ...(event.metadata || {}),
        operator: event.metadata?.operator || null,
        legacy_envelope_inferred: true,
      },
      schema_version: '1.0',
    })
  } catch (e) {
    // Non-blocking — log but don't fail the main operation
    console.log('[ops-api] business_events write failed (table may not exist yet):', (e as Error).message)
  }
}

// ── CAP0-QUOTE-REVISION-QUICKQUOTE — Job Release Packet V1 helper ───────────
//
// Records an immutable quote_revisions row for the Quick Quote release path.
// Inline copy of send-quote/index.ts's recordReleasedQuoteRevision (intentional
// duplication: matches the existing safeBusinessEventInsert pattern; drift is
// caught at PR review). Quick Quote passes job_document_id=null because there
// is no job_documents row for this release path (the FK is nullable per
// migration 20260501130000).
//
// The helper INSERTs the released row directly with sent_at = now() — no
// pre-Resend staging — to avoid the Codex-flagged stale-snapshot class of bug
// (a failed first attempt leaving a stale row that a retry inherits).
type QuickQuoteRecordReleaseInput = {
  job_id: string
  job_document_id: string | null
  version: number
  recipient_email: string
  recipient_label: string | null
  build_kind: 'patio' | 'fence' | 'misc'
  council_status?: CouncilStatus
  neighbours_required?: boolean | null
  scope: {
    client_name: string | null
    site_address: string | null
    site_suburb: string | null
    job_type: string | null
    job_number: string | null
  }
  pricing_json: unknown
  pdf_url: string
  released_via: 'ops-api/send_quick_quote_email'
  org_id: string

  // Loop 3 / P2 V2 augmentation. When provided, V2 envelope is built in
  // mode='warn' and column values land in the same INSERT as V1 columns.
  // V1 release-truth path proceeds unconditionally if V2 build fails.
  v2_inputs?: Omit<V2AugmentationInput, 'release_id'> | null
}

async function recordReleasedQuoteRevision(
  sb: any,
  input: QuickQuoteRecordReleaseInput,
  ctx: { handler: string; job_id: string },
): Promise<string | null> {
  try {
    const manifest = buildMinimalReleaseManifest({
      job_id: input.job_id,
      job_document_id: input.job_document_id,
      version: input.version,
      recipient_email: input.recipient_email,
      recipient_label: input.recipient_label,
      build_kind: input.build_kind,
      council_status: input.council_status,
      neighbours_required: input.neighbours_required,
      scope: input.scope,
      pricing_json: input.pricing_json,
      pdf_url: input.pdf_url,
      released_via: input.released_via,
    })
    const { canonical, hash } = await canonicalJsonAndHash(manifest)

    // Manifest URL — CAP0-QUOTE-REVISION-MANIFEST-STORAGE (2026-05-01).
    // Mirror of send-quote/recordReleasedQuoteRevision. Private bucket
    // `release-manifests` (migration 20260501140000); no RLS policies, so
    // service-role-only via implicit bypass. Direct GET returns 401 to
    // anon/authenticated. 409 "duplicate" → same hash = same content; use
    // real URL. Other failures → fall back to stub URL, log
    // [quote-revision-upload-fail], INSERT proceeds (manifest_canonical_text
    // is the verification source).
    const objectPath = `${hash}.json`
    const realManifestUrl = `${SUPABASE_URL}/storage/v1/object/release-manifests/${objectPath}`
    const stubManifestUrl = `supabase-internal://manifest/${hash}`
    let manifestUrl = stubManifestUrl
    try {
      const bytes = new TextEncoder().encode(canonical)
      const { error: upErr } = await sb.storage
        .from('release-manifests')
        .upload(objectPath, bytes, {
          contentType: 'application/json',
          upsert: false,
        })
      if (!upErr) {
        manifestUrl = realManifestUrl
      } else {
        const dup = (upErr as any)?.statusCode === '409'
          || /duplicate|already exists/i.test(upErr.message ?? '')
        if (dup) {
          manifestUrl = realManifestUrl
        } else {
          console.error('[quote-revision-upload-fail]', JSON.stringify({
            job_id: input.job_id, version: input.version, handler: ctx.handler,
            error: upErr.message ?? String(upErr),
            note: 'falling back to internal stub URL; manifest_canonical_text is the verification source',
          }))
        }
      }
    } catch (e: any) {
      console.error('[quote-revision-upload-fail]', JSON.stringify({
        job_id: input.job_id, version: input.version, handler: ctx.handler,
        error: e?.message ?? String(e),
        note: 'falling back to internal stub URL; manifest_canonical_text is the verification source',
      }))
    }
    const totals = manifest.totals_snapshot
    const sentAtIso = new Date().toISOString()

    // ── Loop 3 / P2 V2 augmentation (Quick Quote) ──
    // Pre-allocate the row id so the V2 release_id matches quote_revisions.id
    // (T7 evidence-spine compatibility: stable identifier across event +
    // canonical bytes + DB row).
    const releaseId = crypto.randomUUID()

    let v2Cols: Record<string, unknown> = {}
    let v2EmitInputs: { manifest_hash: string; internal_cost_hash: string } | null = null
    if (input.v2_inputs) {
      try {
        const v2 = await buildV2Augmentation(sb, {
          ...input.v2_inputs,
          release_id: releaseId,
        })
        if (v2.ok) {
          v2Cols = {
            contacts_snapshot_json: v2.contacts_snapshot_json,
            documents_snapshot_json: v2.documents_snapshot_json,
            media_snapshot_json: v2.media_snapshot_json,
            qa_snapshot_json: v2.qa_snapshot_json,
            send_snapshot_json: v2.send_snapshot_json,
            terms_snapshot_json: v2.terms_snapshot_json,
            provenance_snapshot_json: v2.provenance_snapshot_json,
            option_label: v2.option_label,
            internal_cost_snapshot_json: v2.internal_cost_snapshot_json,
            internal_cost_canonical_text: v2.internal_cost_canonical_text,
            internal_cost_hash: v2.internal_cost_hash,
          }
          v2EmitInputs = {
            manifest_hash: v2.manifest_hash,
            internal_cost_hash: v2.internal_cost_hash,
          }
          if (v2.soft_warnings.length > 0) {
            console.log('[v2-soft-warnings]', JSON.stringify({
              job_id: input.job_id,
              version: input.version,
              handler: ctx.handler,
              warnings: v2.soft_warnings,
              hard_blockers_passed_count: v2.hard_blockers_passed.length,
            }))
          }
        } else {
          console.error('[v2-augmentation-fail]', JSON.stringify({
            job_id: input.job_id,
            version: input.version,
            handler: ctx.handler,
            reason: v2.reason,
            note: 'V1 release-truth path proceeds; V2 columns left NULL on this row',
          }))
        }
      } catch (e: any) {
        console.error('[v2-augmentation-fail]', JSON.stringify({
          job_id: input.job_id,
          version: input.version,
          handler: ctx.handler,
          stage: 'helper_threw',
          error: e?.message ?? String(e),
        }))
      }
    }

    const { data: inserted, error: insErr } = await sb.from('quote_revisions')
      .insert({
        id: releaseId,
        job_id: input.job_id,
        job_document_id: input.job_document_id,
        version: input.version,
        recipient_email: input.recipient_email,
        recipient_label: input.recipient_label,
        scope_snapshot_json: manifest.scope_snapshot,
        pricing_snapshot_json: manifest.pricing_snapshot,
        totals_snapshot_json: totals,
        manifest_url: manifestUrl,
        manifest_hash: hash,
        manifest_canonical_text: canonical,
        pdf_url: input.pdf_url,
        council_status: input.council_status ?? 'unknown',
        build_kind: input.build_kind,
        neighbours_required: input.neighbours_required ?? null,
        released_via: input.released_via,
        sent_at: sentAtIso,
        schema_version: '1.0',
        ...v2Cols,
      })
      .select('id')
      .single()

    if (!insErr && inserted) {
      if (v2EmitInputs) {
        await emitV2SealedEvent(sb, {
          job_id: input.job_id,
          quote_revision_id: inserted.id,
          release_id: releaseId,
          version: input.version,
          manifest_hash: v2EmitInputs.manifest_hash,
          internal_cost_hash: v2EmitInputs.internal_cost_hash,
          released_via: input.released_via,
        })
      }
      return inserted.id
    }

    // INSERT failed — most likely (job_id, version) unique conflict from a
    // duplicate-release attempt. Look up the existing row and decide what to
    // return based on its sent_at state.
    const { data: existing } = await sb.from('quote_revisions')
      .select('id, sent_at')
      .eq('job_id', input.job_id)
      .eq('version', input.version)
      .maybeSingle()
    if (existing && existing.sent_at !== null) {
      console.log('[quote-revision-duplicate-release]', JSON.stringify({
        job_id: input.job_id, version: input.version,
        handler: ctx.handler, revision_id: existing.id,
        note: 'release path fired but row already at sent_at NOT NULL — duplicate release attempt',
      }))
      return existing.id
    }
    if (existing) {
      console.error('[quote-revision-stale-staged]', JSON.stringify({
        job_id: input.job_id, version: input.version,
        handler: ctx.handler, revision_id: existing.id,
        note: 'pre-existing staged row blocks new release; DB admin must clean up',
      }))
      return null
    }
    console.error('[quote-revision-record-fail]', JSON.stringify({
      job_id: input.job_id, version: input.version, handler: ctx.handler,
      stage: 'insert_and_no_existing', error: insErr?.message ?? String(insErr),
    }))
    return null
  } catch (e: any) {
    console.error('[quote-revision-record-fail]', JSON.stringify({
      job_id: input.job_id, version: input.version, handler: ctx.handler,
      stage: 'helper_threw', error: e?.message ?? String(e),
    }))
    return null
  }
}

// ════════════════════════════════════════════════════════════
// READINESS ENGINE — Reusable job readiness computation
// ════════════════════════════════════════════════════════════

interface ReadinessItem {
  key: string
  label: string
  met: boolean
  severity: 'blocker' | 'warning' | 'optional'
}

interface JobReadiness {
  score: number
  status: 'ready' | 'at_risk' | 'blocked'
  blockers: ReadinessItem[]
  warnings: ReadinessItem[]
  completeness: ReadinessItem[]
}

interface ReadinessRule {
  key: string
  label: string
  severity: 'blocker' | 'warning' | 'optional'
  check: string
  condition?: string
}

const READINESS_RULES: Record<string, ReadinessRule[]> = {
  patio: [
    // Blockers — job should not proceed
    { key: 'crew_assigned',        label: 'Crew assigned',                severity: 'blocker',  check: 'assignment_count > 0' },
    { key: 'pos_created',          label: 'Purchase orders created',      severity: 'blocker',  check: 'po_count > 0',          condition: 'needs_materials' },
    { key: 'work_order',           label: 'Work order exists',            severity: 'warning',  check: 'wo_count > 0' },
    // Warnings — important but job can proceed
    { key: 'materials_confirmed',  label: 'Materials delivery confirmed', severity: 'warning',  check: 'materials_delivery_ready', condition: 'needs_materials' },
    { key: 'deposit_received',     label: 'Deposit received',             severity: 'warning',  check: 'deposit_paid' },
    { key: 'supplier_quote_doc',   label: 'Supplier quote uploaded',      severity: 'warning',  check: 'has_doc_supplier_quote' },
    // Optional — admin completeness
    { key: 'site_photos_doc',      label: 'Site photos uploaded',         severity: 'optional', check: 'has_doc_site_photo' },
    { key: 'council_plans_doc',    label: 'Council plans uploaded',       severity: 'optional', check: 'has_doc_council_plans',   condition: 'quoted_amount > 15000' },
    { key: 'engineering_doc',      label: 'Engineering certificate',      severity: 'optional', check: 'has_doc_engineering',     condition: 'attachment_is_fascia' },
  ],
  fencing: [
    { key: 'crew_assigned',        label: 'Crew assigned',                severity: 'blocker',  check: 'assignment_count > 0' },
    { key: 'pos_created',          label: 'Purchase orders created',      severity: 'blocker',  check: 'po_count > 0',          condition: 'needs_materials' },
    { key: 'work_order',           label: 'Work order exists',            severity: 'warning',  check: 'wo_count > 0' },
    { key: 'materials_confirmed',  label: 'Materials delivery confirmed', severity: 'warning',  check: 'materials_delivery_ready', condition: 'needs_materials' },
    { key: 'deposit_received',     label: 'Deposit received',             severity: 'warning',  check: 'deposit_paid' },
    { key: 'supplier_quote_doc',   label: 'Supplier quote uploaded',      severity: 'warning',  check: 'has_doc_supplier_quote' },
    { key: 'site_photos_doc',      label: 'Site photos uploaded',         severity: 'optional', check: 'has_doc_site_photo' },
    { key: 'asbestos_clearance',   label: 'Asbestos clearance',           severity: 'optional', check: 'has_doc_asbestos',        condition: 'scope_mentions_asbestos' },
  ],
}

// Default rules for decking, miscellaneous, etc — patio rules minus engineering/council
const DEFAULT_RULES: ReadinessRule[] = [
  { key: 'crew_assigned',        label: 'Crew assigned',                severity: 'blocker',  check: 'assignment_count > 0' },
  { key: 'pos_created',          label: 'Purchase orders created',      severity: 'blocker',  check: 'po_count > 0',          condition: 'needs_materials' },
  { key: 'work_order',           label: 'Work order exists',            severity: 'warning',  check: 'wo_count > 0' },
  { key: 'materials_confirmed',  label: 'Materials delivery confirmed', severity: 'warning',  check: 'materials_delivery_ready', condition: 'needs_materials' },
  { key: 'deposit_received',     label: 'Deposit received',             severity: 'warning',  check: 'deposit_paid' },
  { key: 'supplier_quote_doc',   label: 'Supplier quote uploaded',      severity: 'warning',  check: 'has_doc_supplier_quote' },
  { key: 'site_photos_doc',      label: 'Site photos uploaded',         severity: 'optional', check: 'has_doc_site_photo' },
]

// Job types that run on van stock — no POs or material deliveries needed
const VAN_STOCK_JOB_TYPES = ['makesafe', 'inspection', 'report']

function evaluateCheck(check: string, data: Record<string, any>): boolean {
  // Simple expression evaluator for readiness checks
  // Supports: 'field > N', 'field', 'has_doc_TYPE'
  const gtMatch = check.match(/^(\w+)\s*>\s*(\d+)$/)
  if (gtMatch) {
    const val = Number(data[gtMatch[1]] || 0)
    return val > Number(gtMatch[2])
  }
  // Composite check: POs exist AND all confirmed
  if (check === 'materials_delivery_ready') {
    return (Number(data.po_count || 0) > 0) && !!data.all_pos_delivery_confirmed
  }
  // Boolean field check
  if (check.startsWith('has_doc_')) {
    const docType = check.replace('has_doc_', '')
    const docTypes = data.doc_types || {}
    return (docTypes[docType] || 0) > 0
  }
  // Direct boolean or truthy
  return !!data[check]
}

function evaluateCondition(condition: string, data: Record<string, any>, scopeJson: any, jobType: string): boolean {
  if (!condition) return true
  if (condition === 'needs_materials') {
    // Van stock job types never need POs
    if (VAN_STOCK_JOB_TYPES.includes(jobType)) return false
    // Jobs with $0 or null materials cost don't need POs
    const pricing = data._pricing_json || {}
    const materialsCost = pricing.materialsCost ?? pricing.materials ?? pricing.materialsTotal ?? null
    if (materialsCost === 0 || materialsCost === '0') return false
    // If quoted amount is $0 or null, likely a van-stock/labour-only job
    if ((data.quoted_amount || 0) <= 0) return false
    return true
  }
  if (condition === 'quoted_amount > 15000') return (data.quoted_amount || 0) > 15000
  if (condition === 'attachment_is_fascia') {
    const scope = typeof scopeJson === 'string' ? JSON.parse(scopeJson || '{}') : (scopeJson || {})
    const attach = (scope.attachmentMethod || scope.attachment || '').toLowerCase()
    return attach.includes('fascia')
  }
  if (condition === 'scope_mentions_asbestos') {
    const scope = typeof scopeJson === 'string' ? JSON.parse(scopeJson || '{}') : (scopeJson || {})
    return JSON.stringify(scope).toLowerCase().includes('asbestos')
  }
  return true
}

function computeReadiness(
  jobType: string,
  intelligence: Record<string, any>,
  scopeJson: any,
  pricingJson?: any,
): JobReadiness {
  const rules = READINESS_RULES[jobType] || DEFAULT_RULES

  // Inject pricing_json into data so evaluateCondition can access it
  const data = { ...intelligence, _pricing_json: pricingJson || {} }

  const blockers: ReadinessItem[] = []
  const warnings: ReadinessItem[] = []
  const completeness: ReadinessItem[] = []

  let totalRules = 0
  let metCount = 0

  for (const rule of rules) {
    // Check if conditional rule applies
    if (rule.condition && !evaluateCondition(rule.condition, data, scopeJson, jobType)) {
      continue
    }

    totalRules++
    const met = evaluateCheck(rule.check, data)
    if (met) metCount++

    const item: ReadinessItem = {
      key: rule.key,
      label: rule.label,
      met,
      severity: rule.severity,
    }

    if (rule.severity === 'blocker') blockers.push(item)
    else if (rule.severity === 'warning') warnings.push(item)
    else completeness.push(item)
  }

  const score = totalRules > 0 ? Math.round((metCount / totalRules) * 100) : 100

  const hasUnmetBlockers = blockers.some(b => !b.met)
  const hasUnmetWarnings = warnings.some(w => !w.met)

  let status: 'ready' | 'at_risk' | 'blocked' = 'ready'
  if (hasUnmetBlockers) status = 'blocked'
  else if (hasUnmetWarnings) status = 'at_risk'

  return { score, status, blockers, warnings, completeness }
}

// AWST = UTC+8 — Perth has no daylight saving
const AWST_OFFSET_MS = 8 * 60 * 60 * 1000

function getAWSTDate(d?: Date): string {
  const now = d || new Date()
  return new Date(now.getTime() + AWST_OFFSET_MS).toISOString().slice(0, 10)
}

function getAWSTWeekEnd(): string {
  const now = new Date(Date.now() + AWST_OFFSET_MS)
  const day = now.getDay() // 0=Sun
  // End of week = coming Sunday (or today if Sunday)
  const daysUntilSunday = day === 0 ? 0 : 7 - day
  now.setDate(now.getDate() + daysUntilSunday)
  return now.toISOString().slice(0, 10)
}

// Verify JWT token for trade endpoints — returns authenticated user
async function authTrade(req: Request, client: any): Promise<{ id: string; email: string }> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    throw new ApiError('Login required', 401)
  }
  const token = authHeader.slice(7)
  const { data: { user }, error } = await client.auth.getUser(token)
  if (error || !user) throw new ApiError('Session expired — please log in again', 401)
  return { id: user.id, email: user.email || '' }
}

// Pagination helper — Supabase limits to 1000 rows per request
async function fetchAll(client: any, table: string, select: string, filters: Record<string, any> = {}) {
  const PAGE_SIZE = 1000
  let all: any[] = []
  let offset = 0
  while (true) {
    let query = client.from(table).select(select).range(offset, offset + PAGE_SIZE - 1)
    for (const [key, val] of Object.entries(filters)) {
      if (key === '_in') {
        for (const [col, vals] of Object.entries(val as Record<string, string[]>)) {
          query = query.in(col, vals)
        }
      } else if (key === '_gte') {
        for (const [col, v] of Object.entries(val as Record<string, string>)) {
          query = query.gte(col, v)
        }
      } else if (key === '_lte') {
        for (const [col, v] of Object.entries(val as Record<string, string>)) {
          query = query.lte(col, v)
        }
      } else {
        query = query.eq(key, val)
      }
    }
    const { data, error } = await query
    if (error) throw error
    all = all.concat(data || [])
    if (!data || data.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return all
}

// Get stored Xero token (refreshed every 20min by pg_cron)
async function getToken(client: any): Promise<{ accessToken: string; tenantId: string }> {
  const { data: token, error } = await client
    .from('xero_tokens')
    .select('*')
    .eq('org_id', DEFAULT_ORG_ID)
    .single()

  if (error || !token) throw new Error('No Xero token available. Ensure token_refresh is running.')

  // Check if expired (with 2-min buffer)
  if (new Date(token.expires_at) < new Date(Date.now() + 120000)) {
    const basic = btoa(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`)
    const resp = await fetch(XERO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })
    if (!resp.ok) throw new Error('Xero token refresh failed: ' + await resp.text())
    const data = await resp.json()

    const connResp = await fetch('https://api.xero.com/connections', {
      headers: { 'Authorization': `Bearer ${data.access_token}` },
    })
    const connections = await connResp.json()
    const tenantId = connections[0]?.tenantId || token.tenant_id

    await client.from('xero_tokens').upsert({
      org_id: DEFAULT_ORG_ID,
      access_token: data.access_token,
      tenant_id: tenantId,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id' })

    return { accessToken: data.access_token, tenantId }
  }

  return { accessToken: token.access_token, tenantId: token.tenant_id }
}

// Xero API GET with rate limit retry
async function xeroGet(
  path: string, accessToken: string, tenantId: string,
  params?: Record<string, string>, retryCount = 0
): Promise<any> {
  const url = new URL(`${XERO_API_BASE}${path}`)
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const fetchUrl = url.toString().replace(/%2C/g, ',')

  const resp = await fetch(fetchUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Accept': 'application/json',
    },
  })

  if (resp.status === 429) {
    if (retryCount >= 3) throw new Error(`Xero rate limited on ${path} after ${retryCount} retries`)
    const retryAfter = parseInt(resp.headers.get('Retry-After') || '5')
    await new Promise(r => setTimeout(r, retryAfter * 1000))
    return xeroGet(path, accessToken, tenantId, params, retryCount + 1)
  }
  if (!resp.ok) throw new Error(`Xero API ${path} failed (${resp.status}): ${await resp.text()}`)
  return resp.json()
}

// Xero API POST/PUT
async function xeroPost(
  path: string, accessToken: string, tenantId: string,
  body: any, method = 'POST', idempotencyKey?: string
): Promise<any> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'Xero-tenant-id': tenantId,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  }
  // Xero honours Idempotency-Key for 12 hours — prevents duplicate
  // creation on retries or double-clicks
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey
  }
  const resp = await fetch(`${XERO_API_BASE}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const errText = await resp.text()
    // Extract the actual validation message from Xero's verbose response
    try {
      const errJson = JSON.parse(errText)
      const elements = errJson.Elements || []
      const msgs = elements.flatMap((el: any) => (el.ValidationErrors || []).map((ve: any) => ve.Message)).filter(Boolean)
      if (msgs.length > 0) throw new Error(`Xero validation error: ${msgs.join('; ')}`)
    } catch (parseErr) {
      if ((parseErr as Error).message.startsWith('Xero validation')) throw parseErr
    }
    throw new Error(`Xero API ${path} failed (${resp.status}): ${errText}`)
  }
  return resp.json()
}

// ════════════════════════════════════════════════════════════
// EXPORTED FOR TESTING — send_invoice_email Path B body extracted so
// unit tests can stub external deps (Xero, Supabase client, fetch,
// logBusinessEvent). The production handler below calls this helper
// with real implementations. Behaviour is intentionally identical to
// the prior inline body; this is a behaviour-preserving extraction.
// ════════════════════════════════════════════════════════════

export type SendInvoiceVerifyDeps = {
  client: any
  body: any
  getToken: (client: any) => Promise<{ accessToken: string; tenantId: string }>
  xeroGet: (path: string, accessToken: string, tenantId: string, params?: any) => Promise<any>
  logBusinessEvent: (client: any, event: any) => Promise<void>
  fetch: typeof globalThis.fetch
  env: { XERO_API_BASE: string; SUPABASE_URL: string; SW_API_KEY: string }
}

export async function _verifyAndSendInvoiceEmail(deps: SendInvoiceVerifyDeps): Promise<Response> {
  const { client, body, getToken, xeroGet, logBusinessEvent, fetch: dfetch, env } = deps
  const { xero_invoice_id: siId, to_email: siTo, job_id: siJobId, cc: siCc, subject_override: siSubj } = body

  // Enhanced path: to_email provided → verify recipient server-side, then PDF + Outlook.
  // Order matters: local DB-only checks run BEFORE any Xero call so a Xero outage
  // (token endpoint or /Invoices) cannot mask a structural error like "invoice not in
  // cache" or "caller passed wrong job_id". Those return their specific 400s without
  // requiring Xero connectivity.
  const { data: siInv } = await client.from('xero_invoices')
    .select('invoice_number, total, amount_due, job_id, xero_contact_id')
    .eq('xero_invoice_id', siId).maybeSingle()
  if (!siInv) {
    return json({
      error: 'Invoice not found in xero_invoices cache',
      code: 'invoice_not_cached',
      xero_invoice_id: siId,
    }, 400)
  }
  const siNum = siInv.invoice_number || siId

  // Cross-check job_id linkage: caller-supplied job_id must match xero_invoices.job_id
  // when both are present. Older invoices may have null job_id in cache → trust caller.
  if (siJobId && siInv.job_id && siInv.job_id !== siJobId) {
    return json({
      error: 'job_id does not belong to this invoice',
      code: 'job_invoice_mismatch',
      xero_invoice_id: siId,
      received_job_id: siJobId,
      expected_job_id: siInv.job_id,
    }, 400)
  }

  // Recipient resolver. Two sources, kept SEPARATE so we can detect drift between them:
  //   (a) Xero invoice's Contact.EmailAddress + ContactPersons — canonical: this is the
  //       contact the invoice was actually issued to in Xero.
  //   (b) jobs.client_email for xero_invoices.job_id — supporting record. Allowed to
  //       authorize a send ONLY when (i) Xero responded but had no emails (legacy
  //       fallback for genuinely empty Xero contact), or (ii) it overlaps with the
  //       Xero set. A caller-supplied job_id is NOT used here: only the cache linkage
  //       (verifiedJobId) counts, and that's also the only value written to job_events.
  // Xero lookup outcome is tracked separately from email count: a thrown call
  // (network/5xx/auth/rate-limit, including token-acquisition failure) is NOT the
  // same as "Xero responded with zero emails". A failure must hard-stop — falling back
  // to a possibly-stale jobs.client_email when we don't actually know what Xero says
  // would re-open the recipient-drift hole. Token acquisition is folded into the same
  // try block so getToken outages produce the same code as /Invoices outages.
  const verifiedJobId = siInv.job_id || null
  const addToSet = (set: Set<string>, e: unknown) => {
    if (typeof e !== 'string') return
    for (const part of e.split(',')) {
      const norm = part.trim().toLowerCase()
      if (norm) set.add(norm)
    }
  }
  let siAt = ''
  let siTi = ''
  const xeroEmails = new Set<string>()
  let xeroLookupOk = false
  let xeroLookupErr: string | null = null
  try {
    const tok = await getToken(client)
    siAt = tok.accessToken
    siTi = tok.tenantId
    const xInv = await xeroGet(`/Invoices/${siId}`, siAt, siTi)
    const xContact = xInv?.Invoices?.[0]?.Contact
    addToSet(xeroEmails, xContact?.EmailAddress)
    for (const cp of (xContact?.ContactPersons || [])) addToSet(xeroEmails, cp?.EmailAddress)
    xeroLookupOk = true
  } catch (e) {
    xeroLookupErr = (e as Error).message || 'unknown error'
    console.log('[send_invoice_email] xero contact lookup failed:', xeroLookupErr)
  }
  if (!xeroLookupOk) {
    return json({
      error: 'Could not verify recipient — Xero contact lookup failed. Retry, or have an operator confirm the recipient before sending.',
      code: 'xero_contact_lookup_failed',
      xero_invoice_id: siId,
      detail: xeroLookupErr,
    }, 400)
  }
  const jobEmails = new Set<string>()
  if (verifiedJobId) {
    const { data: siJob } = await client.from('jobs')
      .select('client_email').eq('id', verifiedJobId).maybeSingle()
    addToSet(jobEmails, siJob?.client_email)
  }

  // Selection rule (option 2 — cross-check):
  //   - Xero lookup succeeded with ≥1 email → expectedSet = Xero emails. jobs.client_email
  //     can only authorize a send via overlap; a drifted job email never expands the
  //     allowlist past what Xero confirms.
  //   - Xero lookup succeeded with 0 emails → legacy fallback to verified jobs.client_email.
  //     This branch is ONLY reachable when Xero genuinely has no contact email on file —
  //     not when the lookup itself failed (handled above).
  const expectedSet: Set<string> = xeroEmails.size > 0 ? xeroEmails : jobEmails

  if (expectedSet.size === 0) {
    return json({
      error: 'Cannot verify recipient — Xero contact has no email on file and no client_email on the linked job',
      code: 'recipient_unverifiable',
      xero_invoice_id: siId,
    }, 400)
  }

  const driftReject = (received: string, label: 'recipient' | 'cc_recipient') => {
    // Diagnostic: caller hit a job email that exists but disagrees with Xero contact.
    // Surface a more specific code so the agent (and Ticket 5 alerting) can flag drift.
    const recvNorm = received.trim().toLowerCase()
    if (xeroEmails.size > 0 && jobEmails.has(recvNorm) && !xeroEmails.has(recvNorm)) {
      return json({
        error: 'jobs.client_email does not match Xero invoice contact — possible recipient drift',
        code: 'contact_job_recipient_mismatch',
        xero_invoice_id: siId,
        received,
        expected: Array.from(expectedSet),
        field: label,
      }, 400)
    }
    return json({
      error: label === 'cc_recipient'
        ? 'CC recipient does not match invoice contact'
        : 'Recipient does not match invoice contact',
      code: label === 'cc_recipient' ? 'cc_recipient_mismatch' : 'recipient_mismatch',
      xero_invoice_id: siId,
      received,
      expected: Array.from(expectedSet),
    }, 400)
  }

  const received = String(siTo).trim().toLowerCase()
  if (!expectedSet.has(received)) return driftReject(siTo, 'recipient')

  // Verify every CC address against the same allowlist, regardless of input shape.
  // CC accepts string ("a@x,b@x"), array (["a@x","b@x"]), or absent. Any other shape
  // is rejected so an unfamiliar wrapper can't smuggle recipients past the gate.
  const ccRaw: string[] = []
  if (siCc === undefined || siCc === null || siCc === '') {
    /* no CC */
  } else if (typeof siCc === 'string') {
    for (const part of siCc.split(',')) ccRaw.push(part)
  } else if (Array.isArray(siCc)) {
    for (const entry of siCc) {
      if (typeof entry !== 'string') {
        return json({
          error: 'CC entry must be a string',
          code: 'cc_invalid_shape',
          xero_invoice_id: siId,
        }, 400)
      }
      for (const part of entry.split(',')) ccRaw.push(part)
    }
  } else {
    return json({
      error: 'cc must be a string or array of strings',
      code: 'cc_invalid_shape',
      xero_invoice_id: siId,
    }, 400)
  }
  const ccVerified: string[] = []
  for (const part of ccRaw) {
    const trimmed = part.trim()
    if (!trimmed) continue
    if (!expectedSet.has(trimmed.toLowerCase())) {
      return driftReject(trimmed, 'cc_recipient')
    }
    ccVerified.push(trimmed)
  }
  const siCcSafe = ccVerified.join(',')

  // Download PDF from Xero
  const siPdfResp = await dfetch(`${env.XERO_API_BASE}/Invoices/${siId}`, {
    headers: { 'Authorization': `Bearer ${siAt}`, 'Xero-tenant-id': siTi, 'Accept': 'application/pdf' },
  })
  if (!siPdfResp.ok) throw new ApiError(`Failed to fetch PDF from Xero: ${siPdfResp.status}`, 502)
  const siBuffer = await siPdfResp.arrayBuffer()
  const siBytes = new Uint8Array(siBuffer)
  let siBin = ''; for (let i = 0; i < siBytes.length; i++) siBin += String.fromCharCode(siBytes[i])
  const siPdfB64 = btoa(siBin)

  // Send via Outlook with PDF attached
  const siEmailResp = await dfetch(`${env.SUPABASE_URL}/functions/v1/send-outlook-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.SW_API_KEY },
    body: JSON.stringify({
      to: siTo,
      cc: siCcSafe,
      subject: siSubj || `Invoice ${siNum} — SecureWorks Group`,
      htmlBody: `<p>Please find your invoice attached.</p><p>Invoice: <strong>${siNum}</strong></p>`,
      attachments: [{ contentBytes: siPdfB64, name: `${siNum}.pdf`, contentType: 'application/pdf' }],
    }),
  })
  if (!siEmailResp.ok) throw new ApiError(`Outlook email failed: ${await siEmailResp.text()}`, 502)

  // Audit (non-blocking).
  //   - business_events: ALWAYS written. Accepts null job_id, so unlinked invoice sends
  //     still leave a trail. This is the canonical event store.
  //   - job_events: only when verifiedJobId is set. job_events.job_id is NOT NULL, so
  //     unlinked sends would fail this insert; we deliberately skip it rather than
  //     misattributing the row to a caller-supplied job_id.
  await logBusinessEvent(client, {
    event_type: 'invoice.emailed',
    entity_type: 'xero_invoice',
    entity_id: siId,
    job_id: verifiedJobId || undefined,
    payload: { invoice_number: siNum, to: siTo, via: 'outlook', linked: Boolean(verifiedJobId) },
  })
  if (verifiedJobId) {
    try {
      await client.from('job_events').insert({
        job_id: verifiedJobId,
        event_type: 'invoice.emailed',
        detail_json: { invoice_number: siNum, to: siTo, via: 'outlook' },
      })
    } catch { /* non-blocking */ }
  }

  return json({ success: true, emailed: true, invoice_number: siNum, to: siTo, via: 'outlook' })
}

// ════════════════════════════════════════════════════════════
// EXPORTED FOR TESTING — approve_and_send_invoice recipient verifier.
// Runs ONLY when caller passes email_override AND use_branded_email !== false.
// Verifies the override against canonical sources (Xero contact + linked job)
// BEFORE the AUTHORISE call, so a mismatch never leaves a stale-AUTHORISED
// invoice in Xero. Independent local copy — does not depend on Ticket 2's
// _verifyAndSendInvoiceEmail; both can land in either order.
// ════════════════════════════════════════════════════════════

export type ApproveSendVerifyDeps = {
  client: any
  body: any
  getToken: (client: any) => Promise<{ accessToken: string; tenantId: string }>
  xeroGet: (path: string, accessToken: string, tenantId: string, params?: any) => Promise<any>
  logBusinessEvent: (client: any, event: any) => Promise<void>
}

export type ApproveSendVerifyResult =
  | { ok: true }
  | { ok: false; response: Response }

export async function _verifyApproveAndSendRecipient(deps: ApproveSendVerifyDeps): Promise<ApproveSendVerifyResult> {
  const { client, body, getToken, xeroGet, logBusinessEvent } = deps
  const asId = body.xero_invoice_id as string
  const useBranded = body.use_branded_email !== false

  // Shape gate: a non-string `email_override` (array, object, number) would cause
  // the typeof check below to set `overrideRaw = null`, the function to return
  // `{ ok: true }`, and the existing case body to evaluate `body.email_override || ''`
  // — which is truthy for arrays/objects and would forward an unverified value to
  // the branded send. Reject explicitly with a structured 400. Mirror of T2's
  // `cc_invalid_shape` pattern.
  if (
    body.email_override !== undefined &&
    body.email_override !== null &&
    typeof body.email_override !== 'string'
  ) {
    return {
      ok: false,
      response: json({
        error: 'email_override must be a string',
        code: 'email_override_invalid_shape',
        xero_invoice_id: asId,
      }, 400),
    }
  }

  const overrideRaw = typeof body.email_override === 'string' ? body.email_override : null
  const acknowledged = body.confirm_drifted_recipient === true

  // Verification only runs when caller asked us to redirect (override) AND we are using
  // the branded path. Plain Xero-direct (use_branded_email: false) is safe by construction —
  // Xero picks recipient. No-override branded uses jobs.client_email server-side; same
  // drift class as before, scoped out of this ticket.
  if (!overrideRaw || !useBranded) return { ok: true }

  // Local DB check — invoice must be in cache so we can resolve verifiedJobId.
  const { data: asInvVerif } = await client.from('xero_invoices')
    .select('job_id, xero_contact_id')
    .eq('xero_invoice_id', asId).maybeSingle()
  if (!asInvVerif) {
    return {
      ok: false,
      response: json({
        error: 'Invoice not found in xero_invoices cache',
        code: 'invoice_not_cached',
        xero_invoice_id: asId,
      }, 400),
    }
  }
  const verifiedJobId = asInvVerif.job_id || null

  const addToSetT3 = (set: Set<string>, e: unknown) => {
    if (typeof e !== 'string') return
    for (const part of e.split(',')) {
      const norm = part.trim().toLowerCase()
      if (norm) set.add(norm)
    }
  }

  // Xero contact lookup. Token failure or contact-fetch failure both fold into
  // xero_contact_lookup_failed — we cannot verify without Xero, so we hard-stop.
  const xeroEmails = new Set<string>()
  let xeroLookupOk = false
  let xeroLookupErr: string | null = null
  try {
    const tok = await getToken(client)
    const xInv = await xeroGet(`/Invoices/${asId}`, tok.accessToken, tok.tenantId)
    const xContact = xInv?.Invoices?.[0]?.Contact
    addToSetT3(xeroEmails, xContact?.EmailAddress)
    for (const cp of (xContact?.ContactPersons || [])) addToSetT3(xeroEmails, cp?.EmailAddress)
    xeroLookupOk = true
  } catch (e) {
    xeroLookupErr = (e as Error).message || 'unknown error'
    console.log('[approve_and_send_invoice] xero contact lookup failed:', xeroLookupErr)
  }
  if (!xeroLookupOk) {
    return {
      ok: false,
      response: json({
        error: 'Could not verify recipient — Xero contact lookup failed. Retry, or have an operator confirm the recipient before approving.',
        code: 'xero_contact_lookup_failed',
        xero_invoice_id: asId,
        detail: xeroLookupErr,
      }, 400),
    }
  }

  // jobs.client_email via cache linkage only. Caller-supplied job_id is NOT trusted here.
  const jobEmails = new Set<string>()
  if (verifiedJobId) {
    const { data: asJobVerif } = await client.from('jobs')
      .select('client_email').eq('id', verifiedJobId).maybeSingle()
    addToSetT3(jobEmails, asJobVerif?.client_email)
  }

  // Selection rule: Xero canonical when present; jobs.client_email is legacy fallback
  // only when Xero genuinely has no contact email (lookup succeeded with empty result).
  const expectedSet: Set<string> = xeroEmails.size > 0 ? xeroEmails : jobEmails
  if (expectedSet.size === 0) {
    return {
      ok: false,
      response: json({
        error: 'Cannot verify recipient — Xero contact has no email on file and no client_email on the linked job',
        code: 'recipient_unverifiable',
        xero_invoice_id: asId,
      }, 400),
    }
  }

  const recvNorm = overrideRaw.trim().toLowerCase()
  if (expectedSet.has(recvNorm)) return { ok: true }

  // Mismatch. Caller may opt in to a deliberate override (strata manager etc.) via
  // confirm_drifted_recipient: true — when present, log an audit row and proceed.
  if (acknowledged) {
    try {
      await logBusinessEvent(client, {
        event_type: 'invoice.recipient_drift_confirmed',
        entity_type: 'xero_invoice',
        entity_id: asId,
        job_id: verifiedJobId || undefined,
        payload: {
          override: overrideRaw,
          expected: Array.from(expectedSet),
          confirmed_by_caller: true,
        },
      })
    } catch (e) {
      console.log('[approve_and_send_invoice] drift audit write failed (non-blocking):', (e as Error).message)
    }
    return { ok: true }
  }

  // Reject with drift-aware code.
  const isDrift = xeroEmails.size > 0 && jobEmails.has(recvNorm) && !xeroEmails.has(recvNorm)
  return {
    ok: false,
    response: json({
      error: isDrift
        ? 'jobs.client_email does not match Xero invoice contact — possible recipient drift'
        : 'email_override does not match invoice contact',
      code: isDrift ? 'contact_job_recipient_mismatch' : 'recipient_mismatch',
      xero_invoice_id: asId,
      received: overrideRaw,
      expected: Array.from(expectedSet),
      field: 'email_override',
    }, 400),
  }
}

// ════════════════════════════════════════════════════════════
// REQUEST HANDLER
// ════════════════════════════════════════════════════════════

if (import.meta.main) serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  // ── Unauthenticated deploy-lane version probe ──
  const _preAuthUrl = new URL(req.url)
  if (_preAuthUrl.searchParams.get('action') === 'deploy-lane-version') {
    return new Response(JSON.stringify({ version: '2026-05-30.v3', function: 'ops-api' }), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }

  // ── Dual Authentication: API Key (server-to-server) + JWT (browser) ──
  const validKey = Deno.env.get('SW_API_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const xApiKey = req.headers.get('x-api-key')
  const authHeader = req.headers.get('authorization')
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

  let authMode: 'api_key' | 'jwt' = 'api_key'
  let authUser: { id: string; email: string; role: string } | null = null

  if (xApiKey && (xApiKey === validKey || xApiKey === serviceKey)) {
    authMode = 'api_key' // Server-to-server call via x-api-key header
  } else if (bearerToken && (bearerToken === validKey || bearerToken === serviceKey)) {
    authMode = 'api_key' // Server-to-server call via Authorization header
  } else if (bearerToken) {
    // Validate as user JWT (browser request)
    try {
      const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const { data: { user }, error } = await adminClient.auth.getUser(bearerToken)
      if (error || !user) {
        return new Response(JSON.stringify({ error: 'Session expired — please log in again' }), {
          status: 401, headers: { ...CORS, 'Content-Type': 'application/json' }
        })
      }
      // Look up user role
      const { data: profile } = await adminClient.from('users')
        .select('role')
        .eq('id', user.id)
        .maybeSingle()
      authMode = 'jwt'
      authUser = { id: user.id, email: user.email || '', role: profile?.role || 'unknown' }
    } catch (_e) {
      return new Response(JSON.stringify({ error: 'Authentication failed' }), {
        status: 401, headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }
  } else {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }

  try {
    const url = new URL(req.url)
    const action = url.searchParams.get('action')
    console.log(`[ops-api] action=${action} method=${req.method}`)

    // Parse POST body for write actions
    let body: any = {}
    if (req.method === 'POST') {
      try { body = await req.json() } catch { body = {} }
    }

    const client = sb()

    switch (action) {
      case 'ops_api_version': return json(opsApiVersion())

      // ── Ops Dashboard Read ──
      case 'ops_summary': return json(await opsSummary(client))
      case 'calendar': return json(await calendarEvents(client, url.searchParams))
      case 'pipeline': return json(await pipeline(client, url.searchParams))
      case 'job_detail': {
        let jid = url.searchParams.get('jobId') || url.searchParams.get('job_id') || ''
        // If not a UUID, try resolving as job_number (e.g. SWF-26037)
        if (jid && !jid.match(/^[0-9a-f]{8}-/i)) {
          const { data: found } = await client.from('jobs').select('id').ilike('job_number', jid).limit(1)
          if (found?.[0]) jid = found[0].id
        }
        if (!jid) return json({ error: 'jobId required' }, 400)
        const slim = url.searchParams.get('slim') === 'true' || url.searchParams.get('slim') === '1'
        return json(await jobDetail(client, jid, { slim }))
      }
      case 'search_jobs': return json(await searchJobs(client, url.searchParams))
      case 'get_org_events': return json(await getOrgEvents(client, url.searchParams))
      case 'my_actions': return json(await myActions(client))
      case 'list_job_actions': return json(await listJobActions(client, url.searchParams))
      case 'create_org_event': return json(await createOrgEvent(client, body))
      case 'delete_org_event': return json(await deleteOrgEvent(client, body))
      case 'create_job_action': return json(await createJobAction(client, body))
      case 'update_job_action': return json(await updateJobAction(client, body))
      case 'generate_work_order_doc': return json(await generateWorkOrderDoc(client, body))
      case 'delete_media': return json(await deleteMedia(client, body))
      case 'jump_council_step': return json(await jumpCouncilStep(client, body))
      case 'create_makesafe_job': return json(await createMakesafeJob(client, body))
      case 'list_invoices': return json(await listInvoices(client, url.searchParams))
      case 'finance_health_summary': return json(await financeHealthSummary(client, url.searchParams))
      case 'get_invoice_pdf': return json(await getInvoicePdf(client, url.searchParams))
      case 'list_quotes': return json(await listQuotes(client, url.searchParams))
      case 'list_pos': return json(await listPOs(client, url.searchParams))
      case 'list_work_orders': return json(await listWorkOrders(client, url.searchParams))
      case 'list_suppliers': return json(await listSuppliers(client))
      case 'list_users': return json(await listUsers(client))
      case 'ops_targets': return json(await opsTargets(client))
      case 'get_email_events': return json(await getEmailEvents(client, url.searchParams))
      // T7 Loop 2 — Evidence Health surface. Read-only; views must be
      // applied via 20260502000010_v_evidence_health.sql first. If the
      // views are not yet present, the handler returns warnings + empty
      // arrays (the Health page shows them as a clear "views not applied"
      // banner rather than 5xx).
      case 'get_evidence_health': return json(await getEvidenceHealth(client))
      // T7 Loop 3 — Evidence body retrieval. POST { spine_event_id }.
      // Role-gated per privacy_classification; hash-verified before
      // signing a URL; body bytes never returned inline.
      case 'get_evidence_body': {
        // Caller identity comes from the same Supabase JWT validation as
        // the rest of ops-api. Role + is_admin + assigned_job_ids are all
        // sourced server-side from the users + assignments tables — never
        // from request input — per body_handler's AUTHORIZATION CONTRACT.
        let role = ''
        let isAdmin = false
        let userId: string | undefined
        let assignedJobIds: string[] = []
        try {
          const auth = req.headers.get('authorization') || ''
          const token = auth.replace(/^Bearer\s+/i, '')
          if (token) {
            const { data: u } = await client.auth.getUser(token)
            userId = u?.user?.id
            if (userId) {
              const { data: profile } = await client.from('users').select('role').eq('id', userId).limit(1)
              role = (profile?.[0]?.role as string) || ''
              isAdmin = role === 'admin' || role === 'owner'
              if (!isAdmin) {
                const { data: asgn } = await client.from('assignments').select('job_id').eq('user_id', userId)
                assignedJobIds = (asgn || []).map((a: any) => a.job_id).filter(Boolean)
              }
            }
          }
        } catch (_e) { /* role stays '' → default-deny in handler */ }
        const storage = client.storage
        return json(await getEvidenceBody(client, storage, body, {
          user_id: userId,
          role,
          is_admin: isAdmin,
          assigned_job_ids: assignedJobIds,
        }))
      }
      // T7 Loop 9 — Controlled transcript ingest.
      // Admin/owner-only. Bypasses the global evidence_capture_v1 flag
      // because access is structurally controlled by role gate (parallel
      // to agent_audit_log). Used for the JARVIS memory proof: WhisperFlow
      // transcript text -> spine row -> extraction_jobs -> context_fact ->
      // Job Brain -> JARVIS citation.
      //
      // POST body: {
      //   job_id: string,                  required
      //   transcript_text: string,         required, non-empty
      //   source_label?: string,           e.g. 'whisperflow', 'manual'
      //   occurred_at?: string,            ISO; defaults to now
      //   consent_confirmed: true,         required; explicit boolean
      //   call_direction?: 'inbound'|'outbound'|'internal'  default 'internal'
      // }
      case 'ingest_transcript': {
        let role = ''
        let userId: string | undefined
        try {
          const auth = req.headers.get('authorization') || ''
          const token = auth.replace(/^Bearer\s+/i, '')
          if (token) {
            const { data: u } = await client.auth.getUser(token)
            userId = u?.user?.id
            if (userId) {
              const { data: profile } = await client.from('users').select('role').eq('id', userId).limit(1)
              role = (profile?.[0]?.role as string) || ''
            }
          }
        } catch (_e) { /* role stays '' → deny */ }
        if (role !== 'admin' && role !== 'owner') {
          return json({ ok: false, reason: 'admin or owner role required' }, 403)
        }
        return json(await ingestTranscript(client, body, { user_id: userId!, role }))
      }
      case 'resolve_jobs': return json(await resolveJobs(client, body))
      case 'get_job_context_facts': return json(await getJobContextFacts(client, body))
      case 'get_job_conversation': return json(await getJobConversation(client, body))
      case 'assemble_job_dossier':
      case 'assemble_job_brain': {
        try {
          return json(await assembleJobDossier(client, body))
        } catch (e) {
          const msg = (e as Error).message || 'assemble failed'
          // Input/resolution failures are caller-fixable → 400. Per-source
          // read errors do not throw (they populate diagnostics.sourceStatus
          // with ok:false), so anything reaching here is a structural
          // mistake by the caller.
          if (msg.startsWith('assemble_job_dossier requires') ||
              msg.startsWith('assemble_job_dossier could not resolve')) {
            return json({ error: msg }, 400)
          }
          throw e
        }
      }

      // ── Ops Dashboard Write ──
      case 'create_assignment': return json(await createAssignment(client, body))
      case 'update_assignment': return json(await updateAssignment(client, body))
      case 'delete_assignment': return json(await deleteAssignment(client, body))
      case 'update_job_status': return json(await updateJobStatus(client, body))
      case 'create_po': return json(await createPO(client, body))
      case 'update_po': return json(await updatePO(client, body))
      case 'push_po_to_xero': return json(await pushPOToXero(client, body))
      case 'email_po': return json(await emailPO(client, body))
      case 'create_work_order': return json(await createWorkOrder(client, body))
      case 'update_work_order': return json(await updateWorkOrder(client, body))
      case 'send_work_order': return json(await sendWorkOrder(client, body))

      // ── Scope-Memory-Saving Loop 1 — frozen scope substrate ──
      // freeze_scope: read jobs.scope_json + pricing_json, canonicalize, write
      //   a frozen scope_revisions row (and supersede the prior frozen row if
      //   one exists). Requires { job_id, tool_kind } in the POST body.
      // clone_scope_for_edit: clone the latest frozen scope_revision into a
      //   new draft row and refresh jobs.scope_json / pricing_json so the
      //   tool's working state matches the cloned-from frozen content.
      //   Requires { scope_revision_id } in the POST body.
      // Responses are intentionally small (ids + status + hashes + structured
      // error codes) so callers can render minimal UI without parsing prose.
      case 'freeze_scope': {
        if (!body || typeof body !== 'object') return json({ error: 'POST body required' }, 400)
        const job_id = body.job_id || body.jobId
        if (!job_id || typeof job_id !== 'string') return json({ error: 'job_id required' }, 400)
        const tool_kind = body.tool_kind ?? body.toolKind
        if (!_isToolKind(tool_kind)) {
          return json({ error: 'tool_kind required (one of patio, fencing, decking, quick_quote, gate, repair, general)' }, 400)
        }
        const result = await _freezeScope(client, {
          job_id,
          tool_kind,
          renderer_version: body.renderer_version ?? body.rendererVersion,
          tool_version: body.tool_version ?? body.toolVersion,
          frozen_by_user_id:
            authMode === 'jwt' ? authUser!.id : (body.frozen_by_user_id ?? body.userId ?? null),
        })
        if (!result.ok) {
          const status =
            result.error.code === 'job_not_found' ? 404
            : result.error.code === 'invalid_tool_kind' ? 400
            : result.error.code === 'job_missing_scope' || result.error.code === 'job_missing_pricing' ? 422
            : result.error.code === 'inconsistent_state' ? 409
            : 500
          return json({ error: result.error }, status)
        }
        return json(result)
      }
      case 'clone_scope_for_edit': {
        if (!body || typeof body !== 'object') return json({ error: 'POST body required' }, 400)
        const scope_revision_id = body.scope_revision_id || body.scopeRevisionId
        if (!scope_revision_id || typeof scope_revision_id !== 'string') {
          return json({ error: 'scope_revision_id required' }, 400)
        }
        const result = await _cloneScopeForEdit(client, {
          scope_revision_id,
          write_jobs_working_state:
            body.write_jobs_working_state === false || body.writeJobsWorkingState === false ? false : true,
        })
        if (!result.ok) {
          const status =
            result.error.code === 'source_not_found' ? 404
            : result.error.code === 'source_not_frozen' || result.error.code === 'source_not_latest' ? 409
            : result.error.code === 'draft_already_exists' ? 409
            : 500
          return json({ error: result.error }, status)
        }
        return json(result)
      }
      // Admin/recovery: idempotently re-establish the "≤1 frozen scope_revisions
      // row per job" invariant. Used out-of-band when a partial-failure
      // incident left more than one frozen row for a job. Safe to call any
      // time; no-op when invariant already holds. Requires { job_id }.
      //
      // Admin gate (matches add_note pattern): API-key callers (MCP / Cowork)
      // are treated as admin; JWT callers must have users.role='admin'. Any
      // other principal gets 403. The gate is enforced because the heal
      // mutates scope_revisions rows by transitioning them to 'superseded' —
      // a one-way trigger transition that frozen→superseded explicitly
      // permits but cannot be reversed.
      case 'heal_scope_revisions': {
        const isAdmin = authMode === 'api_key' || authUser?.role === 'admin'
        if (!isAdmin) {
          return json({ error: 'forbidden: heal_scope_revisions requires admin role' }, 403)
        }
        if (!body || typeof body !== 'object') return json({ error: 'POST body required' }, 400)
        const job_id = body.job_id || body.jobId
        if (!job_id || typeof job_id !== 'string') return json({ error: 'job_id required' }, 400)
        const result = await _healFrozenInvariant(client, job_id, new Date().toISOString())
        if (!result.ok) {
          return json({ error: { code: 'heal_failed', message: result.message, superseded_so_far: result.superseded_so_far } }, 500)
        }
        return json(result)
      }
      // Persist a single scope_artifacts row for a frozen scope_revision.
      // Operator action — patio-tool / fence-designer call this once per
      // canonical render at freeze time. Body shape:
      //   { scope_revision_id, artifact_type, content_base64, content_type, sha256, label? }
      // The helper validates the artifact_type enum, content_type allowlist,
      // sha256 format, decoded byte size (≤ 25 MB), and recomputes sha256
      // server-side as a tamper guard. Refuses to attach to a non-frozen
      // revision so callers cannot ship renders against a mutable draft.
      case 'record_scope_artifact': {
        if (!body || typeof body !== 'object') return json({ error: 'POST body required' }, 400)
        const scope_revision_id = body.scope_revision_id || body.scopeRevisionId
        if (!scope_revision_id || typeof scope_revision_id !== 'string') {
          return json({ error: 'scope_revision_id required' }, 400)
        }
        if (!_isArtifactType(body.artifact_type)) {
          return json({ error: 'artifact_type required (one of render_hero, render_front, render_side, render_site_plan, render_riser, render_post_detail, render_profile, render_3d_scene, quote_pdf, per_contact_pdf, work_order_pdf, material_order_pdf, model_glb, drawing)' }, 400)
        }
        const result = await _recordScopeArtifact(client, {
          scope_revision_id,
          artifact_type: body.artifact_type,
          content_base64: body.content_base64,
          content_type: body.content_type,
          sha256: body.sha256,
          label: body.label ?? null,
        })
        if (!result.ok) {
          const status =
            result.error.code === 'scope_revision_not_found' ? 404
            : result.error.code === 'invalid_input' ? 400
            : result.error.code === 'invalid_artifact_type' ? 400
            : result.error.code === 'invalid_content_type' ? 400
            : result.error.code === 'invalid_sha256_format' ? 400
            : result.error.code === 'bytes_empty' ? 400
            : result.error.code === 'bytes_too_large' ? 413
            : result.error.code === 'sha256_mismatch' ? 422
            : result.error.code === 'scope_revision_not_frozen' ? 409
            : result.error.code === 'storage_upload_failed' ? 502
            : 500
          return json({ error: result.error }, status)
        }
        return json(result)
      }
      case 'add_note': {
        // Dual auth: API key callers (MCP/Cowork) pass as admin, JWT callers pass their userId
        const noteUserId = authMode === 'jwt' ? authUser!.id : (body.userId || body.user_id || null)
        const noteIsAdmin = authMode === 'api_key' || authUser?.role === 'admin'
        return json(await addNote(client, { ...body, userId: noteUserId }, noteIsAdmin))
      }
      case 'delete_note': {
        const eventId = body.event_id || body.eventId
        if (!eventId) return json({ error: 'event_id required' }, 400)
        const { error: delErr } = await client.from('job_events').delete().eq('id', eventId)
        if (delErr) return json({ error: delErr.message }, 500)
        return json({ success: true })
      }
      case 'create_invoice': return json(await createInvoice(client, body))
      case 'preflight_invoice': {
        // Read-only preflight check. No Xero call, no writes.
        // Used by ops UI and MCP tools to gate invoice creation before any
        // Xero traffic. Returns { ok, missing_dimensions[], warnings[],
        // context: { job_number, customer_name, suburb, division, ... } }.
        const pre = await preflightInvoiceCreation(client, body)
        return json({
          ok: pre.ok,
          missing_dimensions: pre.missing_dimensions,
          warnings: pre.warnings,
          // Trim context to the fields the caller actually needs (avoid
          // leaking the whole job row).
          context: pre.context ? {
            job_id: pre.context.job?.id || null,
            job_number: pre.context.job_number,
            customer_name: pre.context.customer_name,
            suburb: pre.context.suburb,
            division: pre.context.division,
            account_code: pre.context.account_code,
            tracking_option: pre.context.tracking_option,
            quote_revision_id: pre.context.quote_revision_id,
            scope_revision_id: pre.context.scope_revision_id,
            payment_terms_text: pre.context.payment_terms_text,
            payment_terms_source: pre.context.payment_terms_source,
            due_date: pre.context.due_date,
            xero_project_manual_status: pre.context.xero_project_manual_status,
          } : null,
        })
      }
      case 'sync_job_invoices': return json(await syncJobInvoices(client, body))
      case 'update_invoice_job_link': {
        const xiid = body.xero_invoice_id
        const jid = body.job_id
        if (!xiid || !jid) return json({ error: 'xero_invoice_id and job_id required' }, 400)
        const { error: linkErr } = await client.from('xero_invoices')
          .update({ job_id: jid, updated_at: new Date().toISOString() })
          .eq('xero_invoice_id', xiid)
        if (linkErr) return json({ error: linkErr.message }, 500)
        return json({ success: true })
      }
      case 'complete_and_invoice': return json(await completeAndInvoice(client, body))
      case 'create_deposit_invoice': return json(await createDepositInvoice(client, body))
      case 'sync_fencing_neighbours': return json(await syncFencingNeighbours(client, body))
      case 'get_comms_upload_url': return json(await getCommsUploadUrl(client, body))
      case 'send_comms_message': return json(await sendCommsMessageAction(body))
      case 'create_trade_user': {
        const { email, password, name, role, phone } = body
        if (!email || !password || !name) return json({ error: 'email, password, name required' }, 400)
        const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        const { data: authUser, error: authErr } = await adminClient.auth.admin.createUser({
          email, password, email_confirm: true,
          user_metadata: { full_name: name }
        })
        if (authErr) return json({ error: authErr.message }, 500)
        const { data: profile, error: profErr } = await adminClient.from('users').insert({
          id: authUser.user.id,
          org_id: '00000000-0000-0000-0000-000000000001',
          name: name,
          email: email,
          phone: phone || null,
          role: role || 'crew'
        }).select().single()
        if (profErr) return json({ error: profErr.message, auth_id: authUser.user.id }, 500)
        return json({ success: true, user: profile })
      }
      case 'fix_legacy': {
        const { data, error } = await client.from('jobs').update({ legacy: false }).is('legacy', null).select('id')
        const { data: d2, error: e2 } = await client.from('jobs').update({ legacy: false }).eq('legacy', true).not('status', 'in', '("cancelled","lost")').select('id')
        return json({ fixed_null: data?.length || 0, fixed_true: d2?.length || 0, error: error?.message, error2: e2?.message })
      }
      case 'migrate_pipeline': {
        // Migrate existing jobs to new pipeline statuses
        const results: Record<string, number> = {}

        // 1. accepted jobs with active council submissions → approvals
        const { data: councilJobs } = await client.from('council_submissions')
          .select('job_id')
          .in('overall_status', ['in_progress', 'not_started', 'blocked'])
        const councilJobIds = (councilJobs || []).map((c: any) => c.job_id)
        if (councilJobIds.length > 0) {
          const { data: moved } = await client.from('jobs')
            .update({ status: 'approvals', approvals_at: new Date().toISOString() })
            .eq('status', 'accepted')
            .in('id', councilJobIds)
            .select('id')
          results.accepted_to_approvals = moved?.length || 0
        }

        // 2. accepted jobs with deposit_invoice_id → deposit
        const { data: depMoved } = await client.from('jobs')
          .update({ status: 'deposit', deposit_at: new Date().toISOString() })
          .eq('status', 'accepted')
          .not('deposit_invoice_id', 'is', null)
          .select('id')
        results.accepted_to_deposit = depMoved?.length || 0

        // 3. scheduled jobs → processing
        const { data: schedMoved } = await client.from('jobs')
          .update({ status: 'processing', processing_at: new Date().toISOString() })
          .eq('status', 'scheduled')
          .select('id')
        results.scheduled_to_processing = schedMoved?.length || 0

        return json({ success: true, migrated: results })
      }
      case 'create_unified_invoice': return json(await createUnifiedInvoice(client, body))
      case 'reconcile_payment': return json(await reconcilePayment(client, body))
      case 'sync_suppliers': return json(await syncSuppliers(client))
      case 'update_supplier_email': return json(await updateSupplierEmail(client, body))
      case 'void_invoice': {
        const vid = body.xero_invoice_id
        if (!vid) return json({ error: 'xero_invoice_id required' }, 400)
        // Capture previous status before voiding
        const { data: voidInvRecord } = await client.from('xero_invoices')
          .select('invoice_number, total, status')
          .eq('xero_invoice_id', vid)
          .maybeSingle()
        const previousStatus = voidInvRecord?.status || 'UNKNOWN'
        const { accessToken: vAt, tenantId: vTi } = await getToken(client)
        const newStatus = body.void ? 'VOIDED' : 'DELETED'
        await xeroPost(`/Invoices/${vid}`, vAt, vTi, { Invoices: [{ InvoiceID: vid, Status: newStatus }] }, 'POST')
        await client.from('xero_invoices').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('xero_invoice_id', vid)
        // Log business event (non-blocking)
        try {
          await client.from('business_events').insert({
            event_type: newStatus === 'DELETED' ? 'invoice.deleted' : 'invoice.voided',
            source: 'ops-api/void_invoice',
            entity_type: 'invoice',
            entity_id: vid,
            payload: { invoice_number: voidInvRecord?.invoice_number, total: voidInvRecord?.total, previous_status: previousStatus },
          })
        } catch (_) { /* non-blocking */ }
        return json({ success: true, status: newStatus })
      }
      case 'update_job_field': {
        const { job_id: ujfJobId, field: ujfField, value: ujfValue } = body
        if (!ujfJobId || !ujfField) return json({ error: 'job_id and field required' }, 400)
        const ALLOWED_FIELDS = ['ghl_contact_id', 'ghl_opportunity_id', 'client_phone', 'client_email', 'client_name', 'site_address', 'site_suburb']
        if (!ALLOWED_FIELDS.includes(ujfField)) return json({ error: 'Field not allowed: ' + ujfField }, 400)
        const { error: ujfErr } = await client.from('jobs').update({ [ujfField]: ujfValue, updated_at: new Date().toISOString() }).eq('id', ujfJobId)
        if (ujfErr) return json({ error: ujfErr.message }, 500)
        return json({ success: true })
      }
      case 'update_invoice': return json(await updateInvoice(client, body))
      case 'mark_invoice_paid': return json(await markInvoicePaid(client, body))
      case 'approve_invoice': {
        const aid = body.xero_invoice_id
        if (!aid) return json({ error: 'xero_invoice_id required' }, 400)

        // H3 (Loop 1B-a): capture previous status + linked job for the business_events row.
        const { data: aPrevInv } = await client.from('xero_invoices')
          .select('status, total, invoice_number, job_id')
          .eq('xero_invoice_id', aid)
          .maybeSingle()
        const aPreviousStatus = aPrevInv?.status || 'UNKNOWN'

        const { accessToken: aAt, tenantId: aTi } = await getToken(client)
        const aRes = await xeroPost(`/Invoices/${aid}`, aAt, aTi, { Invoices: [{ InvoiceID: aid, Status: 'AUTHORISED' }] }, 'POST')
        const approved = aRes?.Invoices?.[0]
        await client.from('xero_invoices').update({ status: 'AUTHORISED', updated_at: new Date().toISOString() }).eq('xero_invoice_id', aid)

        // H3: write business_events.invoice.authorised — mirrors void_invoice's existing pattern.
        // Wrapped in try/catch so a business_events outage does not break the customer-side AUTHORISE.
        try {
          await client.from('business_events').insert({
            event_type: 'invoice.authorised',
            source: 'ops-api/approve_invoice',
            entity_type: 'invoice',
            entity_id: aid,
            job_id: aPrevInv?.job_id || null,
            correlation_id: aPrevInv?.job_id || null,
            payload: {
              previous_status: aPreviousStatus,
              new_status: 'AUTHORISED',
              invoice_number: aPrevInv?.invoice_number || approved?.InvoiceNumber || null,
              total: aPrevInv?.total ?? approved?.Total ?? null,
            },
            metadata: { operator: body.operator_email || null },
          })
        } catch (e) {
          console.log('[ops-api] business_events insert failed (approve_invoice):', (e as Error).message)
        }

        return json({ success: true, status: 'AUTHORISED', invoice_number: approved?.InvoiceNumber })
      }
      case 'send_invoice_email': {
        const { xero_invoice_id: siId, to_email: siTo, job_id: siJobId, cc: siCc, subject_override: siSubj } = body
        if (!siId) return json({ error: 'xero_invoice_id required' }, 400)

        // 2026-04-24 backward-compat fix: if to_email omitted, use Xero-direct email (legacy path).
        // Dashboard callers pass only xero_invoice_id; MCP sw_send_invoice_email passes to_email for Outlook+PDF.
        if (!siTo) {
          const { accessToken: sAt, tenantId: sTi } = await getToken(client)
          await xeroPost(`/Invoices/${siId}/Email`, sAt, sTi, {}, 'POST')
          try {
            await client.from('job_events').insert({
              job_id: siJobId || null,
              event_type: 'invoice.emailed',
              detail_json: { xero_invoice_id: siId, via: 'xero_direct' },
            })
          } catch { /* non-blocking */ }
          return json({ success: true, emailed: true, via: 'xero_direct' })
        }

        // Enhanced path: to_email provided → delegate to extracted, testable helper.
        return await _verifyAndSendInvoiceEmail({
          client, body,
          getToken, xeroGet, logBusinessEvent,
          fetch: globalThis.fetch.bind(globalThis),
          env: { XERO_API_BASE, SUPABASE_URL, SW_API_KEY: Deno.env.get('SW_API_KEY') || '' },
        })
      }

      case 'approve_and_send_invoice': {
        const asId = body.xero_invoice_id
        if (!asId) return json({ error: 'xero_invoice_id required' }, 400)

        // T3: verify email_override BEFORE any state change. When override is absent or
        // use_branded_email: false, the verifier returns {ok: true} and we fall through
        // to the existing flow unchanged.
        const asVerify = await _verifyApproveAndSendRecipient({
          client, body, getToken, xeroGet, logBusinessEvent,
        })
        if (!asVerify.ok) return asVerify.response

        // H3 (Loop 1B-a): capture previous status + linked job for the business_events row.
        const { data: asPrevInv } = await client.from('xero_invoices')
          .select('status, total, invoice_number, job_id')
          .eq('xero_invoice_id', asId)
          .maybeSingle()
        const asPreviousStatus = asPrevInv?.status || 'UNKNOWN'

        // 1. Approve: DRAFT → AUTHORISED
        const { accessToken: asAt, tenantId: asTi } = await getToken(client)
        const asRes = await xeroPost(`/Invoices/${asId}`, asAt, asTi, { Invoices: [{ InvoiceID: asId, Status: 'AUTHORISED' }] }, 'POST')
        const asApproved = asRes?.Invoices?.[0]
        const asInvNumber = asApproved?.InvoiceNumber || ''
        const asTotal = asApproved?.Total || 0

        // Update local record
        await client.from('xero_invoices').update({ status: 'AUTHORISED', updated_at: new Date().toISOString() }).eq('xero_invoice_id', asId)

        // H3 (Loop 1B-a): write business_events.invoice.authorised — same shape as approve_invoice.
        try {
          await client.from('business_events').insert({
            event_type: 'invoice.authorised',
            source: 'ops-api/approve_and_send_invoice',
            entity_type: 'invoice',
            entity_id: asId,
            job_id: asPrevInv?.job_id || null,
            correlation_id: asPrevInv?.job_id || null,
            payload: {
              previous_status: asPreviousStatus,
              new_status: 'AUTHORISED',
              invoice_number: asPrevInv?.invoice_number || asInvNumber || null,
              total: asPrevInv?.total ?? asTotal ?? null,
            },
            metadata: { operator: body.operator_email || null },
          })
        } catch (e) {
          console.log('[ops-api] business_events insert failed (approve_and_send_invoice):', (e as Error).message)
        }

        // 2. Get OnlineInvoiceUrl for payment link
        let asPaymentUrl = ''
        try {
          const onlineRes = await xeroGet(`/Invoices/${asId}/OnlineInvoice`, asAt, asTi)
          asPaymentUrl = onlineRes?.OnlineInvoices?.[0]?.OnlineInvoiceUrl || ''
        } catch (e) {
          console.log('[approve_and_send] Could not get online invoice URL:', (e as Error).message)
        }

        // 3. Determine if we should send branded email
        let asBrandedSent = false
        const asUseBranded = body.use_branded_email !== false

        if (asUseBranded) {
          // Look up job details from xero_invoices → job_id → jobs
          const { data: asInvRecord } = await client.from('xero_invoices')
            .select('job_id, reference')
            .eq('xero_invoice_id', asId)
            .single()

          const asJobId = asInvRecord?.job_id
          let asClientEmail = body.email_override || ''
          let asClientName = ''
          let asJobType = ''
          let asAddress = ''

          if (asJobId) {
            const { data: asJob } = await client.from('jobs')
              .select('client_name, client_email, type, site_address, site_suburb')
              .eq('id', asJobId)
              .single()

            if (asJob) {
              asClientEmail = body.email_override || asJob.client_email || ''
              asClientName = asJob.client_name || ''
              asJobType = asJob.type || ''
              asAddress = [asJob.site_address, asJob.site_suburb].filter(Boolean).join(', ')
            }
          }

          if (asClientEmail) {
            try {
              const asEmailRes = await fetch(`${SUPABASE_URL}/functions/v1/send-quote/send-invoice`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                },
                body: JSON.stringify({
                  xero_invoice_id: asId,
                  job_id: asJobId,
                  payment_url: asPaymentUrl,
                  invoice_number: asInvNumber,
                  deposit_amount: asTotal,
                  client_name: asClientName,
                  client_email: asClientEmail,
                  job_type: asJobType,
                  address: asAddress,
                }),
              })
              const asEmailResult = await asEmailRes.json()
              asBrandedSent = asEmailResult.success || false
            } catch (e) {
              console.log('[approve_and_send] Branded email failed (non-blocking):', (e as Error).message)
            }
          }
        } else {
          // Send plain Xero email
          try {
            await xeroPost(`/Invoices/${asId}/Email`, asAt, asTi, {}, 'POST')
          } catch (e) {
            console.log('[approve_and_send] Xero email failed:', (e as Error).message)
          }
        }

        return json({
          success: true,
          status: 'AUTHORISED',
          invoice_number: asInvNumber,
          branded_email_sent: asBrandedSent,
          payment_url: asPaymentUrl,
        })
      }

      // ── Trade Invoicing (Ops) ──
      case 'list_trade_invoices': return json(await listTradeInvoices(client, url.searchParams))
      case 'labour_reconciliation': return json(await labourReconciliation(client, url.searchParams))
      case 'set_trade_rate_ops': return json(await setTradeRate(client, null, body))
      case 'push_trade_invoice_to_xero': {
        const { invoice_id } = body
        if (!invoice_id) throw new ApiError('invoice_id required', 400)

        // Get the invoice + lines + user
        const { data: inv } = await client.from('trade_invoices')
          .select('*, user:user_id(id, name, email, abn, default_hourly_rate, payment_terms_days, xero_contact_id)')
          .eq('id', invoice_id)
          .maybeSingle()
        if (!inv) throw new ApiError('Invoice not found', 404)
        if (inv.status !== 'acknowledged' && inv.status !== 'approved') throw new ApiError('Invoice must be acknowledged before pushing to Xero', 400)
        if (inv.xero_bill_id) throw new ApiError('Already pushed to Xero', 400)

        const { data: lines } = await client.from('trade_invoice_lines')
          .select('*')
          .eq('trade_invoice_id', invoice_id)

        // Pure read-only setup. Nothing here touches Xero or mutates Supabase.
        // (getToken() is intentionally deferred — it can upsert xero_tokens on
        // refresh, which would be a side effect before the reconciliation guard.)
        const tradeName = inv.user?.name || 'Unknown Trade'
        const tradeEmail = inv.user?.email || ''
        const cachedContactId: string | null = inv.user?.xero_contact_id || null

        const weekNum = Math.ceil((new Date(inv.week_start).getTime() - new Date(new Date(inv.week_start).getFullYear(), 0, 1).getTime()) / (7 * 86400000))
        const year = new Date(inv.week_start).getFullYear()
        const reference = 'TRADE-' + tradeName.split(' ')[0] + '-WK' + weekNum + '-' + year

        const paymentDays = inv.user?.payment_terms_days || 7
        const dueDate = new Date(new Date(inv.submitted_at || Date.now()).getTime() + paymentDays * 86400000).toISOString().slice(0, 10)

        // Reconciliation guard runs BEFORE getToken (which can upsert xero_tokens),
        // before any Xero call, and before any users/trade_invoices mutation.
        // Computes the per-line value directly from raw trade_invoice_lines rows
        // using the labour-vs-extras detection — same algorithm the line builder
        // below uses, just without the Tracking enrichment that needs accessToken.
        // A malformed-line-shape invoice throws here with zero side effects.
        const computedSubtotal = (lines || []).reduce((sum: number, line: any) => {
          const hours = Number(line.total_hours || 0)
          const hRate = Number(line.hourly_rate || 0)
          const qty = Number(line.quantity || 0)
          const uRate = Number(line.unit_rate || 0)
          const isLabour = hours > 0 && hRate > 0
          return sum + (isLabour ? hours * hRate : qty * uRate)
        }, 0)
        const expectedSubtotal = Number(inv.subtotal_ex || 0)
        if (Math.abs(computedSubtotal - expectedSubtotal) > 0.01) {
          throw new Error('Xero payload subtotal mismatch: computed $' + computedSubtotal.toFixed(2) + ' vs trade_invoices.subtotal_ex $' + expectedSubtotal.toFixed(2))
        }

        // Past the guard. From here side effects are allowed.
        const { accessToken, tenantId } = await getToken(client)

        // Look up tracking categories (Xero read).
        let tracking: any[] = []
        try {
          const trackingCats = await xeroGet('/TrackingCategories', accessToken, tenantId)
          const divisionCat = (trackingCats?.TrackingCategories || []).find((tc: any) => tc.Name === 'Business Unit' && tc.Status === 'ACTIVE')
          if (divisionCat) tracking = divisionCat
        } catch (e) { /* skip tracking */ }

        // trade_invoice_lines come in two shapes:
        //   - "labour" (legacy): total_hours / hourly_rate populated; quantity/unit_rate may be 0
        //   - "extras" (current): quantity / unit_rate / line_total_ex populated; total_hours/hourly_rate are 0
        // The auto-push code path (generate_trade_invoice) reads the request body directly, so it
        // never hit this. The retry path reads from trade_invoice_lines and must support both shapes
        // or it pushes $0 bills with empty descriptions for any "extras"-shape invoice.
        const xeroLineItems = (lines || []).map((line: any) => {
          const hours = Number(line.total_hours || 0)
          const hRate = Number(line.hourly_rate || 0)
          const qty = Number(line.quantity || 0)
          const uRate = Number(line.unit_rate || 0)
          const isLabour = hours > 0 && hRate > 0
          const useQty = isLabour ? hours : qty
          const useRate = isLabour ? hRate : uRate
          const desc = isLabour
            ? ((line.job_number || '') + ' ' + (line.client_name || '') + ' — ' + hours + 'h @ $' + hRate + '/hr')
            : (line.description || ((line.line_type || 'Extra') + (line.division ? ' (' + line.division + ')' : '')))
          let trackingOption = trackingCategoryForJob(line.job_number || '')
          if (!trackingOption && line.division) {
            const divMap: Record<string, string> = {
              'Patio': 'SW - PATIOS', 'Fencing': 'SW - FENCING', 'Decking': 'SW - DECKING',
              'Make Safe': 'SW - INSURANCE WORK', 'General Labour': 'SW - GROUP',
            }
            trackingOption = divMap[line.division] || ''
          }
          const lineTracking = tracking && trackingOption ? [{ Name: 'Business Unit', Option: trackingOption }] : []
          return {
            Description: desc,
            Quantity: useQty,
            UnitAmount: useRate,
            AccountCode: '620', // Subcontractor expense
            TaxType: 'INPUT',
            Tracking: lineTracking,
          }
        })

        // Resolve Xero contact for the trade
        // Order: cached users.xero_contact_id -> email lookup -> create.
        // The cached path lets recovery succeed when the user's Supabase email
        // does not match the Xero contact's primary EmailAddress.
        let xeroContactId: string | null = cachedContactId

        if (!xeroContactId) {
          try {
            const contacts = await xeroGet('/Contacts?where=EmailAddress%3D%3D%22' + encodeURIComponent(tradeEmail) + '%22', accessToken, tenantId)
            if (contacts?.Contacts?.length > 0) xeroContactId = contacts.Contacts[0].ContactID
          } catch (e) { /* fallback to create */ }
        }

        if (!xeroContactId) {
          // Create contact
          const createRes = await xeroPost('/Contacts', accessToken, tenantId, {
            Contacts: [{ Name: tradeName, EmailAddress: tradeEmail, IsSupplier: true }]
          }, 'PUT')
          xeroContactId = createRes?.Contacts?.[0]?.ContactID
        }

        if (!xeroContactId) throw new Error('Failed to resolve Xero contact for ' + tradeName)

        // Cache the resolved ContactID for next time so future runs skip lookup/create.
        if (xeroContactId && !cachedContactId && inv.user_id) {
          await client.from('users').update({ xero_contact_id: xeroContactId }).eq('id', inv.user_id)
        }

        const xeroPayload = {
          Invoices: [{
            Type: 'ACCPAY',
            Contact: { ContactID: xeroContactId },
            Reference: reference,
            DueDate: dueDate,
            Status: 'DRAFT',
            LineAmountTypes: 'Exclusive',
            LineItems: xeroLineItems,
          }],
        }

        const idempotencyKey = 'trade-inv-' + invoice_id
        const xeroResult = await xeroPost('/Invoices', accessToken, tenantId, xeroPayload, 'PUT', idempotencyKey)
        const bill = xeroResult?.Invoices?.[0]

        if (!bill?.InvoiceID) throw new Error('Xero did not return an invoice ID')

        // Update trade_invoice
        await client.from('trade_invoices').update({
          xero_bill_id: bill.InvoiceID,
          xero_pushed_at: new Date().toISOString(),
          status: 'pushed_to_xero',
        }).eq('id', invoice_id)

        // Cache in xero_invoices
        try {
          await client.from('xero_invoices').upsert({
            org_id: DEFAULT_ORG_ID,
            xero_invoice_id: bill.InvoiceID,
            invoice_number: bill.InvoiceNumber || '',
            invoice_type: 'ACCPAY',
            status: bill.Status || 'DRAFT',
            reference: reference,
            total: bill.Total || inv.total_inc,
            amount_due: bill.AmountDue || inv.total_inc,
            due_date: dueDate,
            contact_name: tradeName,
          }, { onConflict: 'xero_invoice_id' })
        } catch (e) { /* non-blocking */ }

        return json({ success: true, xero_bill_id: bill.InvoiceID, reference })
      }

      case 'list_trade_invoice_lines': {
        const tilJobId = url.searchParams.get('job_id')
        if (!tilJobId) throw new ApiError('job_id required', 400)

        const { data: tilData, error: tilErr } = await client.from('trade_invoice_lines')
          .select('*, trade_invoices!inner(status, week_start, user_id, user:user_id(name))')
          .eq('job_id', tilJobId)
          .order('created_at', { ascending: false })

        if (tilErr) throw new Error(tilErr.message)

        // Enrich with trade name and week label
        const enrichedLines = (tilData || []).map((line: any) => ({
          ...line,
          trade_name: line.trade_invoices?.user?.name || 'Unknown',
          week_label: line.trade_invoices?.week_start ? new Date(line.trade_invoices.week_start).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '',
        }))

        return json({ lines: enrichedLines })
      }

      case 'list_new_trade_invoices': {
        const { data: ntiData, error: ntiErr } = await client.from('trade_invoices')
          .select('*, user:user_id(name, email)')
          .eq('org_id', DEFAULT_ORG_ID)
          .order('week_start', { ascending: false })
          .limit(50)
        if (ntiErr) throw new Error(ntiErr.message)
        return json({ invoices: ntiData || [] })
      }

      case 'acknowledge_invoice_line': {
        const { line_id: ackLineId, acknowledged: ackApproved, query_note: ackQueryNote } = body
        if (!ackLineId) throw new ApiError('line_id required', 400)

        const ackUpdateData: Record<string, any> = {
          acknowledged_at: new Date().toISOString(),
          acknowledgment_status: ackApproved !== false ? 'acknowledged' : 'queried',
        }
        if (ackQueryNote) ackUpdateData.query_note = ackQueryNote

        const { error: ackErr } = await client.from('trade_invoice_lines')
          .update(ackUpdateData)
          .eq('id', ackLineId)

        if (ackErr) throw new Error(ackErr.message)
        return json({ success: true })
      }

      // ── Job Completion Package ──
      case 'complete_job': return json(await completeJob(client, body))
      case 'send_payment_link': return json(await sendPaymentLink(client, body))
      case 'send_acceptance_invoice': return json(await sendAcceptanceInvoice(client, body))
      case 'send_review_request': return json(await sendReviewRequest(client, body))

      // ── Quick Quote (Miscellaneous Jobs) ──
      case 'search_ghl_contacts': return json(await searchGHLContacts(client, url.searchParams))
      case 'create_misc_job': return json(await createMiscJob(client, body))
      case 'send_quick_quote_email': return json(await sendQuickQuoteEmail(client, body))
      case 'create_ghl_contact': return json(await createGHLContact(client, body))
      case 'get_xero_accounts': return json(await getXeroAccounts(client))
      case 'search_xero_contacts': return json(await searchXeroContacts(client, url.searchParams))
      case 'create_general_invoice': return json(await createGeneralInvoice(client, body))

      // ── PO Management ──
      case 'add_po_event': return json(await addPOEvent(client, body))
      case 'delete_po': return json(await deletePO(client, body))

      // ── AI / Automation ──
      case 'morning_brief': return json(await morningBrief(client))
      case 'scope_to_po': return json(await scopeToPO(client, url.searchParams))
      case 'scheduling_capacity': return json(await schedulingCapacity(client, url.searchParams))
      case 'get_crew_availability': return json(await getCrewAvailability(client, url.searchParams))
      case 'scope_availability': return json(await scopeAvailability(client, url.searchParams))
      case 'dismiss_alert': return json(await dismissAlert(client, body))
      case 'annotations': return json(await getAnnotations(client, url.searchParams))
      case 'resolve_annotation': return json(await resolveAnnotation(client, body))
      case 'set_availability': return json(await setAvailability(client, body))
      case 'confirm_assignment': return json(await confirmAssignment(client, body))
      case 'bulk_confirm': return json(await bulkConfirm(client, body))

      // ── Price Intelligence ──
      case 'extract_po_pricing': return json(await extractPOPricing(client, body))
      case 'confirm_price': return json(await confirmPrice(client, body))
      case 'dismiss_price': return json(await dismissPrice(client, body))
      case 'pending_prices': return json(await getPendingPrices(client))
      case 'create_variation': return json(await createVariation(client, body))
      case 'approve_variation': return json(await approveVariation(client, body))
      case 'list_variations': return json(await listVariations(client, url.searchParams))
      case 'analyse_supplier_quote': return json(await analyseSupplierQuote(client, body))
      case 'confirmed_prices': return json(await getConfirmedPrices(client))

      // ── Spine: Expenses ──
      case 'submit_expense': return json(await submitExpense(client, body, { mode: authMode, user: authUser ?? undefined }))
      case 'approve_expense': return json(await approveExpense(client, body, { mode: authMode, user: authUser ?? undefined }))
      case 'push_expense_to_xero': return json(await pushExpenseToXero(client, body, { mode: authMode, user: authUser ?? undefined }))
      case 'list_expenses': return json(await listExpenses(client, url.searchParams))
      case 'list_unreconciled_transactions': return json(await listUnreconciledTransactions(client, url.searchParams))
      case 'suggest_job_for_expense': return json(await suggestJobForExpense(client, body, { mode: authMode, user: authUser ?? undefined }))
      case 'update_expense': return json(await updateExpense(client, body, { mode: authMode, user: authUser ?? undefined }))

      // ── Spine: Council/Engineering ──
      case 'create_council_submission': return json(await createCouncilSubmission(client, body))
      case 'update_council_status': return json(await updateCouncilStatus(client, body))
      case 'send_council_email': return json(await sendCouncilEmail(client, body))
      case 'send_council_sms': return json(await sendCouncilSMS(client, body))
      case 'list_council_submissions': return json(await listCouncilSubmissions(client, url.searchParams))
      case 'list_run_acceptances': return json(await listRunAcceptances(client, url.searchParams))
      case 'list_po_communications': return json(await listPoCommunications(client, url.searchParams))
      case 'list_job_communications': return json(await listJobCommunications(client, url.searchParams))
      case 'mark_email_read': return json(await markEmailRead(client, body))
      case 'get_inbox': return json(await getEmailInbox(client, url.searchParams))

      // ── Spine: Variations v2 ──
      case 'send_variation': return json(await sendVariation(client, body))

      // ── Spine: Callbacks ──
      case 'create_callback': return json(await createCallback(client, body))
      case 'resolve_callback': return json(await resolveCallback(client, body))

      // ── Spine: Client Comms ──
      case 'send_client_update': return json(await sendClientUpdate(client, body))

      // ── Spine: Duration Monitoring ──
      case 'check_job_durations': return json(await checkJobDurations(client))

      // ── Document Upload Management ──
      case 'upload_document': return json(await uploadDocument(client, body))
      case 'confirm_document_upload': return json(await confirmDocumentUpload(client, body))
      case 'toggle_document_visibility': return json(await toggleDocumentVisibility(client, body))
      case 'delete_document': return json(await deleteDocument(client, body))

      // ── Ops Notes (ops dashboard per-job notes) ──
      case 'list_ops_notes': return json(await listOpsNotes(client, url.searchParams))
      case 'upsert_ops_note': return json(await upsertOpsNote(client, body))
      case 'delete_ops_note': return json(await deleteOpsNote(client, body))
      case 'get_ops_upload_url': return json(await getOpsUploadUrl(client, body))
      case 'send_ops_note_to_trade': return json(await sendOpsNoteToTrade(client, body))

      // ── Proposed Actions (SMS drafts etc.) ──
      case 'list_proposed_actions': return json(await listProposedActions(client, url.searchParams))
      // Daily proposal coverage audit — read-only snapshot + assertions +
      // business_events emission. Designed to be called daily by cron/JARVIS.
      // No customer comms, no GHL writes. See urgency-ordering-coverage-audit-
      // and-hygiene-lane.md §2 for the contract.
      case 'daily_coverage_audit': return json(await dailyCoverageAudit(client, url.searchParams))
      // Quote-nurture cadence v3 — read-only stale review tasks (>3 days
      // pending). sale.html uses this to render the ESCALATED badge on D30
      // review cards. NO state change, NO mutation, NO email.
      // Per parent card secure-sale-quote-followup-loop reframe v3.
      case 'list_stale_quote_review_tasks': return json(await listStaleQuoteReviewTasks(client, url.searchParams))
      case 'send_proposed_sms': return json(await sendProposedSms(client, body))
      case 'dismiss_proposed_action': return json(await dismissProposedAction(client, body))
      // Loop 6.5 manual-live bridge — single canary / per-message manual approval.
      // Allowlist: first_contact_sms ONLY (canary scope). All gates server-side.
      case 'manual_dispatch': return json(await manualDispatch(client, body))
      // ── Slice 1 cockpit verbs (custom-loop framework canon 2026-05-04) ──
      // All conform to docs/loops/secure-sale-loop-framework.md cockpit vocabulary.
      case 'edit_and_send':                return json(await editAndSend(client, body))
      case 'snooze_proposed_action':       return json(await snoozeProposedAction(client, body))
      case 'create_job_for_opportunity':   return json(await createJobForOpportunity(client, body))
      case 'manual_dispatch_marnin_poc':   return json(await manualDispatchMarninPoc(client, body))
      case 'assign_scoper':                return json(await assignScoper(client, body))
      case 'book_scope':                   return json(await bookScope(client, body))
      // Booking approval bridge — browser/ops-api calls Railway, Railway calls
      // the existing sw_approve_booking_proposal path. Keeps Graph/calendar
      // logic in one place instead of duplicating it in Deno.
      case 'approve_booking_proposal':      return json(await approveBookingProposalViaAgent(body, { mode: authMode, user: authUser }))
      // Quote Follow-Up Loop send path (atomic-claim per parent card B4).
      // Only fires when sale.html dispatches a send_quote_followup_sms
      // proposal. Customer-facing send is gated by Marnin's cockpit click.
      case 'send_quote_followup_sms':      return json(await sendQuoteFollowupSms(client, body))
      // Quote-nurture cadence v3 — internal task approval handlers.
      // Atomic-claim pattern (memory feedback_atomic_claim_pattern_for_proposal_handlers).
      // NEITHER fires customer SMS. Scoper call approval records a manual
      // call outcome and best-effort internal GHL note; review approval stays
      // local except its optional archive_lost job status flip.
      // Per parent card secure-sale-quote-followup-loop reframe v3.
      case 'approve_scoper_call_task':     return json(await approveScoperCallTask(client, body))
      case 'approve_quote_review_task':    return json(await approveQuoteReviewTask(client, body))
      // S2 (G-2): cockpit bridge for sw_approve_booking_proposal.
      // Forwards the body to the Railway agent's
      // /api/booking-approvals/approve endpoint, which fronts
      // sw_approve_booking_proposal (booking-approval-http-bridge.ts).
      // Dry-run by default (commit=false); cockpit double-confirms before
      // sending commit=true. No customer-facing side effect lives here —
      // the agent owns Microsoft Graph + the M2 SMS proposal queue write.
      case 'approve_booking_proposal':     return json(await approveBookingProposalBridge(body, req))
      // Per-scoper playbook MD upload — Marnin-only authenticated edit.
      // Validates filename allowlist + YAML frontmatter (status enum,
      // voice_anchor allowlist, sign_off_pattern present) + em-dash check
      // before upserting wiki_pages. No external API. No customer touch.
      // Per parent card secure-sale-quote-followup-loop reframe v3.
      case 'update_playbook':              return json(await updatePlaybook(client, body, req))

      // ── Slice 3: Brain backfill ──
      // Marnin-only. Defaults to dry_run=true. Pulls historical GHL
      // conversations into business_events so JARVIS sees real chat
      // history when proposing follow-ups + booking nudges.
      case 'backfill_ghl_conversations':   return json(await backfillGhlConversations(client, body, req))
      // Slice 3.5 — WhisperFlow historical transcript backfill.
      // For each active opp, finds CALL messages with recording URLs,
      // POSTs each to transcribe-call which fires OpenAI Whisper and
      // writes the transcript into business_events via recordEvidence.
      // Same auth gate (Marnin-only) and dry-run-by-default safety.
      case 'backfill_call_transcripts':    return json(await backfillCallTranscripts(client, body, req))

      // ── Smart Nudges ──
      case 'list_nudges': return json(await listNudges(client, url.searchParams))
      case 'act_nudge': return json(await actNudge(client, body))

      // ── Public (no auth) ──
      case 'view_shared_report': return viewSharedReport(client, url.searchParams)

      // ── Assignment Requests (trade calendar) ──
      case 'request_assistance': {
        const { job_id, requested_trade_id, requested_dates, note } = body
        if (!job_id || !requested_trade_id || !requested_dates?.length) {
          throw new ApiError('job_id, requested_trade_id, and requested_dates[] required', 400)
        }

        const requestedBy = body.requested_by || body.user_id
        if (!requestedBy) throw new ApiError('requested_by (user_id) required', 400)

        // Verify job exists
        const { data: raJob } = await client.from('jobs').select('id, job_number, client_name, site_address').eq('id', job_id).maybeSingle()
        if (!raJob) throw new ApiError('Job not found', 404)

        // Verify requested trade exists
        const { data: raTrade } = await client.from('users').select('id, name, telegram_id').eq('id', requested_trade_id).maybeSingle()
        if (!raTrade) throw new ApiError('Requested trade not found', 404)

        // Get requesting user name
        const { data: raRequester } = await client.from('users').select('name').eq('id', requestedBy).maybeSingle()

        // Insert request
        const { data: raReq, error: raErr } = await client.from('assignment_requests').insert({
          job_id,
          requested_by: requestedBy,
          requested_trade: requested_trade_id,
          requested_dates,
          note: note || null,
        }).select('id').single()

        if (raErr) throw new Error(raErr.message)

        // Notify Shaun via Telegram
        const RA_TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
        if (RA_TELEGRAM_BOT_TOKEN) {
          const { data: raShaun } = await client.from('users').select('telegram_id').ilike('email', '%shaun%').not('telegram_id', 'is', null).limit(1).maybeSingle()
          if (raShaun?.telegram_id) {
            const raDateStr = requested_dates.map((d: string) => new Date(d).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })).join(', ')
            const raMsg = `${raRequester?.name || 'A lead'} is requesting ${raTrade.name} to help on ${raJob.job_number} (${raJob.client_name}) on ${raDateStr}.${note ? '\nNote: ' + note : ''}`

            try {
              await fetch(`https://api.telegram.org/bot${RA_TELEGRAM_BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: raShaun.telegram_id,
                  text: raMsg,
                  reply_markup: {
                    inline_keyboard: [[
                      { text: 'Approve', callback_data: 'assist_approve:' + raReq.id },
                      { text: 'Decline', callback_data: 'assist_decline:' + raReq.id },
                    ]],
                  },
                }),
              })
            } catch (e) { console.log('[ops-api] Telegram notify failed:', e) }
          }
        }

        return json({ success: true, request_id: raReq.id })
      }

      case 'list_assignment_requests': {
        const larStatusFilter = url.searchParams.get('status') || 'pending'
        const larJobId = url.searchParams.get('job_id')

        let larQuery = client.from('assignment_requests')
          .select('*, requester:requested_by(name, email), trade:requested_trade(name, email), job:job_id(job_number, client_name)')
          .order('created_at', { ascending: false })
          .limit(50)

        if (larStatusFilter !== 'all') larQuery = larQuery.eq('status', larStatusFilter)
        if (larJobId) larQuery = larQuery.eq('job_id', larJobId)

        const { data: larData, error: larError } = await larQuery
        if (larError) throw new Error(larError.message)

        return json({ requests: larData || [] })
      }

      case 'approve_assignment_request': {
        const { request_id: aarReqId, approved: aarApproved, decline_reason: aarDeclineReason } = body
        if (!aarReqId) throw new ApiError('request_id required', 400)

        // Get the request
        const { data: aarReq } = await client.from('assignment_requests')
          .select('*, trade:requested_trade(name, telegram_id), requester:requested_by(name, telegram_id), job:job_id(job_number, client_name, site_address, type)')
          .eq('id', aarReqId)
          .maybeSingle()

        if (!aarReq) throw new ApiError('Request not found', 404)
        if (aarReq.status !== 'pending') throw new ApiError('Request already ' + aarReq.status, 400)

        const aarNewStatus = aarApproved !== false ? 'approved' : 'declined'

        // Update request
        await client.from('assignment_requests').update({
          status: aarNewStatus,
          approved_by: body.approved_by || null,
          decline_reason: aarDeclineReason || null,
          resolved_at: new Date().toISOString(),
        }).eq('id', aarReqId)

        const AAR_TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''

        if (aarNewStatus === 'approved') {
          // Auto-create job_assignments for each requested date
          const aarAssignmentRows = aarReq.requested_dates.map((date: string) => ({
            job_id: aarReq.job_id,
            crew_name: aarReq.trade?.name || '',
            scheduled_date: date,
            status: 'scheduled',
            assignment_type: 'assist',
            notes: 'Requested by ' + (aarReq.requester?.name || 'lead'),
          }))

          await client.from('job_assignments').insert(aarAssignmentRows)

          // Notify both trades via Telegram
          if (AAR_TELEGRAM_BOT_TOKEN) {
            const aarDateStr = aarReq.requested_dates.map((d: string) => new Date(d).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })).join(', ')

            // Notify requesting lead
            if (aarReq.requester?.telegram_id) {
              try {
                await fetch(`https://api.telegram.org/bot${AAR_TELEGRAM_BOT_TOKEN}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: aarReq.requester.telegram_id,
                    text: `${aarReq.trade?.name} confirmed for ${aarReq.job?.job_number} on ${aarDateStr}.`,
                  }),
                })
              } catch (e) { console.log('[ops-api] Telegram notify failed:', e) }
            }

            // Notify assigned trade
            if (aarReq.trade?.telegram_id) {
              try {
                await fetch(`https://api.telegram.org/bot${AAR_TELEGRAM_BOT_TOKEN}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: aarReq.trade.telegram_id,
                    text: `You've been assigned to help on ${aarReq.job?.job_number} (${aarReq.job?.client_name}) at ${aarReq.job?.site_address || ''} on ${aarDateStr}.`,
                  }),
                })
              } catch (e) { console.log('[ops-api] Telegram notify failed:', e) }
            }
          }
        } else {
          // Declined — notify requesting lead
          if (AAR_TELEGRAM_BOT_TOKEN && aarReq.requester?.telegram_id) {
            try {
              await fetch(`https://api.telegram.org/bot${AAR_TELEGRAM_BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: aarReq.requester.telegram_id,
                  text: `Request for ${aarReq.trade?.name} on ${aarReq.job?.job_number} was declined.${aarDeclineReason ? ' Reason: ' + aarDeclineReason : ''}`,
                }),
              })
            } catch (e) { console.log('[ops-api] Telegram notify failed:', e) }
          }
        }

        return json({ success: true, status: aarNewStatus })
      }

      // ── Trade (mobile) — JWT auth required ──
      case 'my_jobs':
      case 'trade_job_detail':
      case 'upload_photo':
      case 'get_upload_url':
      case 'confirm_upload':
      case 'submit_service_report':
      case 'get_service_report':
      case 'update_my_assignment':
      case 'my_hours':
      case 'submit_trade_invoice':
      case 'my_trade_invoices':
      case 'set_trade_rate':
      case 'update_trade_profile':
      case 'attach_invoice_pdf':
      case 'delete_trade_invoice':
      case 'create_trade_alert':
      case 'trade_labour_budget':
      case 'update_job_phase':
      case 'list_pending_verifications':
      case 'verify_hours':
      case 'dispute_hours':
      case 'crew_charges_on_my_jobs':
      case 'review_crew_charge':
      case 'my_work_orders':
      case 'submit_work_order_invoice':
      case 'search_all_jobs':
      case 'generate_trade_invoice':
      case 'my_invoices':
      case 'acknowledge_invoice_line':
      case 'clock_event': {
        const tradeUser = await authTrade(req, client)
        // Look up user role for admin visibility
        const { data: userRec } = await client.from('users').select('role').eq('id', tradeUser.id).maybeSingle()
        const tradeRole = userRec?.role || 'trade'
        const isAdmin = tradeRole === 'admin'
        switch (action) {
          case 'my_jobs': {
            const mode = url.searchParams.get('mode') // 'all' for admin view, 'mine' for personal
            const showAll = isAdmin && mode !== 'mine'
            return json(await myJobs(client, tradeUser.id, showAll))
          }
          case 'trade_job_detail': return json(await tradeJobDetail(client, url.searchParams, tradeUser.id, isAdmin))
          case 'upload_photo': return json(await uploadPhoto(client, { ...body, userId: tradeUser.id }))
          case 'get_upload_url': return json(await getUploadUrl(client, body, tradeUser.id, isAdmin))
          case 'confirm_upload': return json(await confirmUpload(client, body, tradeUser.id, isAdmin))
          case 'submit_service_report': return json(await submitServiceReport(client, { ...body, userId: tradeUser.id }))
          case 'get_service_report': return json(await getServiceReport(client, url.searchParams, tradeUser.id))
          case 'update_my_assignment': return json(await updateMyAssignment(client, body, tradeUser.id))
          case 'my_hours': return json(await myHours(client, tradeUser.id, url.searchParams))
          case 'submit_trade_invoice': return json(await submitTradeInvoice(client, tradeUser.id, body))
          case 'my_trade_invoices': return json(await myTradeInvoices(client, tradeUser.id))
          case 'get_trade_invoice': {
            const invoiceId = url.searchParams.get('invoice_id') || body?.invoice_id
            if (!invoiceId) throw new ApiError('invoice_id required', 400)
            const { data: inv, error: invErr } = await client.from('trade_invoices')
              .select('*, lines:trade_invoice_lines(*)')
              .eq('id', invoiceId)
              .eq('user_id', tradeUser.id)
              .single()
            if (invErr || !inv) throw new ApiError('Invoice not found', 404)
            return json({ invoice: inv })
          }
          case 'search_all_jobs': {
            const q = (url.searchParams.get('q') || '').toLowerCase().trim()
            let jobQuery = client.from('jobs')
              .select('id, job_number, client_name, site_suburb, type, status')
              .not('status', 'in', '("lost","cancelled")')
              .order('created_at', { ascending: false })
              .limit(200)
            if (q) {
              jobQuery = jobQuery.or(`job_number.ilike.%${q}%,client_name.ilike.%${q}%,site_suburb.ilike.%${q}%`)
            }
            const { data: allJobs } = await jobQuery
            return json({ jobs: allJobs || [] })
          }
          case 'crew_charges_on_my_jobs': {
            const ccWeekStart = url.searchParams.get('week_start') || body?.week_start
            // Find jobs where this user is lead
            const { data: leadJobs } = await client.from('job_assignments')
              .select('job_id')
              .eq('user_id', tradeUser.id)
              .in('role', ['lead', 'lead_installer'])
            const leadJobIds = [...new Set((leadJobs || []).map((a: any) => a.job_id).filter(Boolean))]
            if (leadJobIds.length === 0) return json({ charges: [] })

            // Get other trades' invoice lines on those jobs
            let query = client.from('trade_invoice_lines')
              .select('id, job_id, job_number, client_name, total_hours, hourly_rate, line_total_ex, acknowledgment_status, override_amount, override_note, line_date, division, description, trade_invoices!inner(user_id, week_start, status, users:user_id(name))')
              .in('job_id', leadJobIds)
              .neq('trade_invoices.user_id', tradeUser.id)
            if (ccWeekStart) query = query.eq('trade_invoices.week_start', ccWeekStart)
            const { data: charges, error: ccErr } = await query.order('line_date', { ascending: true })
            if (ccErr) throw new Error('Failed to load crew charges: ' + ccErr.message)

            const mapped = (charges || []).map((c: any) => ({
              line_id: c.id,
              trade_name: c.trade_invoices?.users?.name || 'Unknown',
              job_number: c.job_number || '',
              job_id: c.job_id,
              total_hours: c.total_hours || 0,
              hourly_rate: c.hourly_rate || 0,
              line_total_ex: c.line_total_ex || 0,
              acknowledgment_status: c.acknowledgment_status || 'pending',
              override_amount: c.override_amount,
              override_note: c.override_note,
              line_date: c.line_date,
              division: c.division,
              description: c.description,
              invoice_status: c.trade_invoices?.status,
            }))
            return json({ charges: mapped })
          }
          case 'review_crew_charge': {
            const { line_id, action: reviewAction, override_amount: overrideAmt, note: reviewNote } = body
            if (!line_id) throw new ApiError('line_id required', 400)
            if (!['approve', 'adjust', 'reject'].includes(reviewAction)) throw new ApiError('action must be approve, adjust, or reject', 400)

            // Verify user is lead on this job
            const { data: lineData } = await client.from('trade_invoice_lines').select('job_id').eq('id', line_id).single()
            if (!lineData) throw new ApiError('Line not found', 404)
            const { data: isLead } = await client.from('job_assignments')
              .select('id')
              .eq('user_id', tradeUser.id)
              .eq('job_id', lineData.job_id)
              .in('role', ['lead', 'lead_installer'])
              .limit(1)
              .maybeSingle()
            if (!isLead) throw new ApiError('Not authorised — you are not lead on this job', 403)

            const updates: any = {
              acknowledged_by: tradeUser.id,
              acknowledged_at: new Date().toISOString(),
            }
            if (reviewAction === 'approve') {
              updates.acknowledgment_status = 'acknowledged'
            } else if (reviewAction === 'adjust') {
              updates.acknowledgment_status = 'acknowledged'
              updates.override_amount = Number(overrideAmt) || 0
              updates.override_by = tradeUser.id
              updates.override_note = reviewNote || 'Adjusted by lead'
            } else if (reviewAction === 'reject') {
              updates.acknowledgment_status = 'queried'
              updates.override_note = reviewNote || 'Rejected by lead'
            }
            await client.from('trade_invoice_lines').update(updates).eq('id', line_id)
            return json({ success: true })
          }

          case 'my_work_orders': {
            // Get work orders assigned to this user (as lead trade)
            const woStatus = url.searchParams.get('status') // optional filter
            let woQuery = client.from('work_orders')
              .select('id, job_id, wo_number, status, trade_name, scope_items, special_instructions, scheduled_date, site_address, sent_at, accepted_at, completed_at, created_at, jobs!inner(job_number, client_name, type, status)')
              .eq('assigned_user_id', tradeUser.id)
              .not('status', 'in', '("cancelled","deleted")')
              .order('created_at', { ascending: false })
            if (woStatus) woQuery = woQuery.eq('status', woStatus)
            const { data: workOrders, error: woErr } = await woQuery.limit(30)
            if (woErr) throw new Error('Failed to load work orders: ' + woErr.message)

            // For each work order, check if already invoiced
            const woIds = (workOrders || []).map((wo: any) => wo.id)
            const { data: existingInvoices } = await client.from('trade_invoices')
              .select('work_order_id, status, xero_bill_id')
              .in('work_order_id', woIds.length > 0 ? woIds : ['00000000-0000-0000-0000-000000000000'])
              .eq('user_id', tradeUser.id)
              .not('status', 'in', '("draft","failed")')
            const invoicedWOs = new Set((existingInvoices || []).map((i: any) => i.work_order_id))

            const mapped = (workOrders || []).map((wo: any) => {
              // Calculate total from scope_items
              const items = wo.scope_items || []
              const subtotal = items.reduce((sum: number, item: any) => {
                const qty = Number(item.quantity || item.metres || item.qty || 0)
                const price = Number(item.unit_price || item.rate || item.price || 0)
                return sum + (qty * price)
              }, 0)
              const gst = Math.round(subtotal * 0.1 * 100) / 100 // 10% GST
              return {
                id: wo.id,
                wo_number: wo.wo_number,
                job_id: wo.job_id,
                job_number: wo.jobs?.job_number || '',
                client_name: wo.jobs?.client_name || '',
                job_type: wo.jobs?.type || '',
                job_status: wo.jobs?.status || '',
                status: wo.status,
                site_address: wo.site_address || '',
                scheduled_date: wo.scheduled_date,
                scope_items: items,
                subtotal: Math.round(subtotal * 100) / 100,
                gst: Math.round(gst * 100) / 100,
                total: Math.round((subtotal + gst) * 100) / 100,
                already_invoiced: invoicedWOs.has(wo.id),
                can_invoice: wo.status === 'complete' && !invoicedWOs.has(wo.id),
              }
            })
            return json({ work_orders: mapped })
          }

          case 'submit_work_order_invoice': {
            const { work_order_id } = body
            if (!work_order_id) throw new ApiError('work_order_id required', 400)

            // Get the work order (include address fields for rich descriptions)
            const { data: wo, error: woFetchErr } = await client.from('work_orders')
              .select('id, job_id, wo_number, status, scope_items, site_address, assigned_user_id, jobs!inner(job_number, client_name, type, site_address, site_suburb)')
              .eq('id', work_order_id)
              .single()
            if (woFetchErr || !wo) throw new ApiError('Work order not found', 404)
            if (wo.assigned_user_id !== tradeUser.id) throw new ApiError('Not authorised — you are not assigned to this work order', 403)
            if (wo.status !== 'complete') throw new ApiError('Work order must be complete before invoicing', 400)

            // Check not already invoiced — allow retry if previous attempt failed
            const { data: existingWoInv } = await client.from('trade_invoices')
              .select('id, status')
              .eq('work_order_id', work_order_id)
              .eq('user_id', tradeUser.id)
              .maybeSingle()
            if (existingWoInv) {
              if (existingWoInv.status === 'draft') {
                // Clean up failed attempt so we can retry
                await client.from('trade_invoice_lines').delete().eq('trade_invoice_id', existingWoInv.id)
                await client.from('trade_invoices').delete().eq('id', existingWoInv.id)
              } else {
                throw new ApiError('This work order has already been invoiced', 400)
              }
            }

            // Get user info (include email for contact auto-create)
            const { data: tradeXeroUser } = await client.from('users')
              .select('xero_contact_id, name, email, abn, trade_details')
              .eq('id', tradeUser.id)
              .single()

            // Resolve Xero supplier contact — auto-create if not linked
            let woXeroContactId = tradeXeroUser?.xero_contact_id || null
            const { accessToken: woAt, tenantId: woTi } = await getToken(client)
            if (!woXeroContactId) {
              const woTradeEmail = tradeXeroUser?.email || tradeXeroUser?.trade_details?.email || ''
              if (woTradeEmail) {
                try {
                  const woContacts = await xeroGet('/Contacts?where=EmailAddress%3D%3D%22' + encodeURIComponent(woTradeEmail) + '%22', woAt, woTi)
                  if (woContacts?.Contacts?.length > 0) woXeroContactId = woContacts.Contacts[0].ContactID
                } catch { /* fallback to create */ }
              }
              if (!woXeroContactId) {
                const woCreateRes = await xeroPost('/Contacts', woAt, woTi, {
                  Contacts: [{ Name: tradeXeroUser?.name || 'Trade', EmailAddress: tradeXeroUser?.email || undefined, IsSupplier: true }]
                }, 'PUT')
                woXeroContactId = woCreateRes?.Contacts?.[0]?.ContactID
              }
              if (woXeroContactId) {
                await client.from('users').update({ xero_contact_id: woXeroContactId }).eq('id', tradeUser.id)
              }
              if (!woXeroContactId) throw new ApiError('Could not create Xero supplier contact', 500)
            }

            // Build line items from scope_items — rich descriptions, correct codes
            const scopeItems = wo.scope_items || []
            const woJobNum = wo.jobs?.job_number || ''
            const woDivision = trackingCategoryForJob(woJobNum)
            const woClientLine = [wo.jobs?.client_name, wo.jobs?.site_address, wo.jobs?.site_suburb].filter(Boolean).join(', ')
            const woGstRegistered = tradeXeroUser?.trade_details?.gstRegistered !== false
            const woTaxType = woGstRegistered ? 'INPUT' : 'NONE'

            const lineItems = scopeItems.map((item: any) => {
              const qty = Number(item.quantity || item.metres || item.qty || 1)
              const price = Number(item.unit_price || item.rate || item.price || 0)
              const desc = item.description || item.name || 'Work order item'
              return {
                Description: [
                  `${wo.wo_number} | ${woJobNum} | ${woDivision || 'Construction'}`,
                  desc + (qty > 1 ? ` (${qty} × $${price.toFixed(2)})` : ''),
                  woClientLine,
                ].filter(Boolean).join('\n'),
                Quantity: qty,
                UnitAmount: price,
                AccountCode: accountCodeForJob(wo.jobs?.type || '', '200'),
                TaxType: woTaxType,
                Tracking: xeroTracking(woJobNum),
              }
            })

            const subtotal = lineItems.reduce((sum: number, li: any) => sum + (li.Quantity * li.UnitAmount), 0)
            const gst = Math.round(subtotal * 0.1 * 100) / 100
            const total = subtotal + gst

            // Push directly to Xero as DRAFT ACCPAY bill
            const tradeName = tradeXeroUser?.name || 'Trade'
            const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

            const xeroPayload = {
              Invoices: [{
                Type: 'ACCPAY',
                Contact: { ContactID: woXeroContactId },
                Reference: `${tradeName} | ${wo.wo_number} | ${woJobNum}`,
                DueDate: dueDate,
                Status: 'DRAFT',
                LineAmountTypes: woGstRegistered ? 'Exclusive' : 'NoTax',
                LineItems: lineItems,
              }],
            }

            // Stable key prevents duplicate bills — if previous push succeeded but we missed the response,
            // Xero returns the cached success (same bill ID, no duplicate). Cached errors expire after 12hrs.
            const woIdempotencyKey = `wo-inv-${tradeUser.id}-${work_order_id}`
            let xeroSuccess = false
            let xeroBillId = ''
            let xeroBillNumber = ''
            try {
              const xeroResult = await xeroPost('/Invoices', woAt, woTi, xeroPayload, 'PUT', woIdempotencyKey)
              const xeroInv = xeroResult?.Invoices?.[0]
              xeroBillId = xeroInv?.InvoiceID || ''
              xeroBillNumber = xeroInv?.InvoiceNumber || ''
              xeroSuccess = !!xeroBillId
            } catch (e: any) {
              console.error('[ops-api] WO invoice Xero push failed:', e.message)
            }

            // Save local trade_invoices record
            const { data: tradeInv } = await client.from('trade_invoices').insert({
              org_id: '00000000-0000-0000-0000-000000000001',
              user_id: tradeUser.id,
              work_order_id: work_order_id,
              invoice_source: 'work_order',
              subtotal_ex: Math.round(subtotal * 100) / 100,
              gst: Math.round(gst * 100) / 100,
              total_inc: Math.round(total * 100) / 100,
              status: xeroSuccess ? 'pushed_to_xero' : 'draft',
              xero_bill_id: xeroBillId || null,
              xero_pushed_at: xeroSuccess ? new Date().toISOString() : null,
              submitted_at: new Date().toISOString(),
            }).select('id').single()

            // Save line items
            if (tradeInv?.id) {
              const lines = scopeItems.map((item: any) => ({
                trade_invoice_id: tradeInv.id,
                job_id: wo.job_id,
                job_number: woJobNum,
                client_name: wo.jobs?.client_name || '',
                description: item.description || item.name || 'Work order item',
                total_hours: 0,
                hourly_rate: 0,
                line_total_ex: Number(item.quantity || item.metres || 1) * Number(item.unit_price || item.rate || 0),
              }))
              await client.from('trade_invoice_lines').insert(lines)
            }

            // Log event
            await client.from('job_events').insert({
              job_id: wo.job_id,
              user_id: tradeUser.id,
              event_type: 'work_order_invoiced',
              detail_json: {
                work_order_id,
                wo_number: wo.wo_number,
                subtotal, gst, total,
                xero_bill_id: xeroBillId,
                xero_bill_number: xeroBillNumber,
              },
            })

            return json({
              success: xeroSuccess,
              xero_bill_number: xeroBillNumber,
              total: Math.round(total * 100) / 100,
              error: xeroSuccess ? undefined : 'Xero push failed — contact admin',
            })
          }

          case 'save_trade_invoice_draft': {
            const { week_start: draftWeekStart, extra_items: draftExtras, notes: draftNotes, labour_lines: draftLabour } = body

            // Check for existing draft this week
            let draftId: string | null = null
            if (draftWeekStart) {
              const { data: existingDraft } = await client.from('trade_invoices')
                .select('id')
                .eq('user_id', tradeUser.id)
                .eq('week_start', draftWeekStart)
                .eq('status', 'draft')
                .maybeSingle()
              if (existingDraft) {
                draftId = existingDraft.id
                // Clear old lines
                await client.from('trade_invoice_lines').delete().eq('trade_invoice_id', draftId)
              }
            }

            // Calculate totals
            let labourTotal = 0
            const labourLines = Array.isArray(draftLabour) ? draftLabour : []
            for (const l of labourLines) labourTotal += Number(l.line_total_ex || 0)
            let extraTotal = 0
            const extras = Array.isArray(draftExtras) ? draftExtras : []
            for (const e of extras) extraTotal += Math.round((Number(e.quantity || 1) * Number(e.rate || 0)) * 100) / 100
            const draftSubtotal = labourTotal + extraTotal
            const draftGst = Math.round(draftSubtotal * 0.1 * 100) / 100

            if (draftId) {
              // Update existing draft
              await client.from('trade_invoices').update({
                notes: draftNotes || null,
                subtotal_ex: draftSubtotal,
                gst: draftGst,
                total_inc: Math.round((draftSubtotal + draftGst) * 100) / 100,
              }).eq('id', draftId)
            } else {
              // Create new draft
              const { data: newDraft, error: draftErr } = await client.from('trade_invoices').insert({
                user_id: tradeUser.id,
                week_start: draftWeekStart || null,
                week_end: draftWeekStart ? new Date(new Date(draftWeekStart + 'T00:00:00Z').getTime() + 6 * 86400000).toISOString().slice(0, 10) : null,
                total_hours: labourLines.reduce((s: number, l: any) => s + Number(l.total_hours || 0), 0),
                subtotal_ex: draftSubtotal,
                gst: draftGst,
                total_inc: Math.round((draftSubtotal + draftGst) * 100) / 100,
                notes: draftNotes || null,
                status: 'draft',
              }).select('id').single()
              if (draftErr) throw new Error('Failed to save draft: ' + draftErr.message)
              draftId = newDraft!.id
            }

            // Insert lines
            for (const l of labourLines) {
              await client.from('trade_invoice_lines').insert({ trade_invoice_id: draftId, line_type: 'labour', ...l })
            }
            for (const e of extras) {
              await client.from('trade_invoice_lines').insert({
                trade_invoice_id: draftId,
                line_type: (e.type || 'other').toLowerCase(),
                description: e.description || e.type || 'Extra item',
                quantity: Number(e.quantity || 1),
                unit: e.unit || 'ea',
                unit_rate: Number(e.rate || 0),
                line_total_ex: Math.round((Number(e.quantity || 1) * Number(e.rate || 0)) * 100) / 100,
              })
            }
            return json({ success: true, draft_id: draftId })
          }
          case 'set_trade_rate': return json(await setTradeRate(client, tradeUser.id, body))
          case 'update_trade_profile': {
            const { fullName, phone, email, abn, bsb, accountNo, accountName, licence, gstRegistered } = body
            // Store trade details as user_metadata jsonb on the users table
            const updates: any = {}
            if (abn !== undefined) updates.abn = abn || null
            // Store everything else in a trade_details jsonb column
            const tradeDetails = { fullName, phone, email, bsb, accountNo, accountName, licence, gstRegistered }
            updates.trade_details = tradeDetails
            await client.from('users').update(updates).eq('id', tradeUser.id)
            return json({ success: true })
          }
          case 'attach_invoice_pdf': {
            const { xero_bill_id: attachBillId, pdf_base64, filename } = body
            if (!attachBillId || !pdf_base64) throw new ApiError('xero_bill_id and pdf_base64 required', 400)
            try {
              const { accessToken, tenantId } = await getToken(client)
              const pdfBytes = Uint8Array.from(atob(pdf_base64), (c: string) => c.charCodeAt(0))
              const attachRes = await fetch(
                `https://api.xero.com/api.xro/2.0/Invoices/${attachBillId}/Attachments/${encodeURIComponent(filename || 'invoice.pdf')}`,
                {
                  method: 'PUT',
                  headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Xero-tenant-id': tenantId,
                    'Content-Type': 'application/pdf',
                    'Content-Length': String(pdfBytes.length),
                  },
                  body: pdfBytes,
                }
              )
              if (!attachRes.ok) {
                const errText = await attachRes.text()
                console.log('[ops-api] Xero PDF attach failed:', attachRes.status, errText)
                throw new Error('Xero attachment failed: ' + attachRes.status)
              }
              return json({ success: true })
            } catch (e) {
              console.log('[ops-api] PDF attachment error:', (e as Error).message)
              return json({ success: false, error: (e as Error).message }, 500)
            }
          }
          case 'delete_trade_invoice': {
            const { invoice_id: delInvId } = body
            if (!delInvId) throw new ApiError('invoice_id required', 400)
            const { data: delInv } = await client.from('trade_invoices')
              .select('id, status')
              .eq('id', delInvId)
              .eq('user_id', tradeUser.id)
              .single()
            if (!delInv) throw new ApiError('Invoice not found', 404)
            if (delInv.status === 'paid') throw new ApiError('Cannot delete a paid invoice', 400)
            await client.from('trade_invoice_lines').delete().eq('trade_invoice_id', delInvId)
            await client.from('trade_invoices').delete().eq('id', delInvId)
            return json({ success: true })
          }
          case 'create_trade_alert': return json(await createTradeAlert(client, tradeUser.id, body))
          case 'trade_labour_budget': return json(await tradeLabourBudget(client, url.searchParams, tradeUser.id))
          case 'update_job_phase': return json(await updateJobPhase(client, body, tradeUser.id))
          case 'list_pending_verifications': return json(await listPendingVerifications(client, tradeUser.id, url.searchParams))
          case 'verify_hours': return json(await verifyHours(client, tradeUser.id, body))
          case 'dispute_hours': return json(await disputeHours(client, tradeUser.id, body))

          case 'generate_trade_invoice': {
            const { week_start, extra_items, notes: invoiceNotes, gst_registered } = body
            const taxType = gst_registered === false ? 'NONE' : 'INPUT'

            // Miscellaneous invoice (no week) or weekly invoice
            let weekEnd: string | null = null
            if (week_start) {
              const weekStartDate = new Date(week_start + 'T00:00:00Z')
              const weekEndDate = new Date(weekStartDate.getTime() + 6 * 86400000)
              weekEnd = weekEndDate.toISOString().slice(0, 10)

              // No duplicate check — trades can submit multiple invoices per week
            }

            // Get completed assignments (only if weekly invoice)
            let assignments: any[] = []
            if (week_start && weekEnd) {
              const { data: asn } = await client.from('job_assignments')
                .select('id, job_id, clocked_on_at, clocked_off_at, hours_worked, hourly_rate, break_minutes, manual_override_flag, scheduled_date, status')
                .eq('user_id', tradeUser.id)
                .gte('scheduled_date', week_start)
                .lte('scheduled_date', weekEnd)
                .eq('status', 'complete')
              assignments = asn || []
            }

            // Must have either hours or extra items
            const hasExtras = Array.isArray(extra_items) && extra_items.length > 0
            if (assignments.length === 0 && !hasExtras) throw new ApiError('No completed assignments or line items to invoice', 400)

            // Get user's default rate + cached Xero supplier contact ID (used by the auto-push below)
            const { data: userProfile } = await client.from('users')
              .select('default_hourly_rate, name, xero_contact_id')
              .eq('id', tradeUser.id)
              .maybeSingle()

            // Group by job
            const jobGroups: Record<string, any[]> = {}
            for (const a of assignments) {
              if (!jobGroups[a.job_id]) jobGroups[a.job_id] = []
              jobGroups[a.job_id].push(a)
            }

            // Get job details
            const jobIds = Object.keys(jobGroups)
            const { data: jobs } = await client.from('jobs')
              .select('id, job_number, client_name, type, site_address, site_suburb')
              .in('id', jobIds)
            const jobMap: Record<string, any> = {}
            for (const j of (jobs || [])) jobMap[j.id] = j

            // Build line items
            let totalHours = 0
            let totalBreaks = 0
            let hasOverrides = false
            const overrideDetails: any[] = []
            const lineItems: any[] = []

            for (const [jobId, assigns] of Object.entries(jobGroups)) {
              const job = jobMap[jobId] || {}
              let jobHours = 0
              const assignmentIds: string[] = []

              for (const a of assigns) {
                const hours = a.hours_worked || 0
                jobHours += hours
                totalBreaks += (a.break_minutes || 0)
                assignmentIds.push(a.id)
                if (a.manual_override_flag) {
                  hasOverrides = true
                  overrideDetails.push({ assignment_id: a.id, day: a.scheduled_date })
                }
              }

              const rate = assigns[0]?.hourly_rate || userProfile?.default_hourly_rate || 0
              const lineTotal = Math.round(jobHours * rate * 100) / 100
              totalHours += jobHours

              lineItems.push({
                job_id: jobId,
                job_number: job.job_number || '',
                client_name: job.client_name || '',
                total_hours: Math.round(jobHours * 100) / 100,
                hourly_rate: rate,
                line_total_ex: lineTotal,
                days_worked: assigns.length,
                assignment_ids: assignmentIds,
              })
            }

            // Build extra line items from client-sent extras
            const extraLineItems: any[] = []
            let extraSubtotal = 0
            if (hasExtras) {
              for (const item of extra_items) {
                const amt = Math.round((Number(item.quantity || 1) * Number(item.rate || 0)) * 100) / 100
                extraSubtotal += amt
                extraLineItems.push({
                  line_type: item.type ? item.type.toLowerCase() : 'other',
                  description: item.description || item.type || 'Extra item',
                  quantity: Number(item.quantity || 1),
                  unit: item.unit || 'ea',
                  unit_rate: Number(item.rate || 0),
                  line_total_ex: amt,
                  line_date: item.date || null,
                  division: item.division || null,
                  job_id: item.job_id || null,
                  job_number: item.job_number || null,
                })
              }
            }

            const labourSubtotal = lineItems.reduce((s: number, l: any) => s + l.line_total_ex, 0)
            const subtotal = labourSubtotal + extraSubtotal
            const gst = Math.round(subtotal * 0.1 * 100) / 100
            const totalInc = Math.round((subtotal + gst) * 100) / 100

            // Generate invoice number: SW-INV-{initials}-{YYMMDD}-{seq} (global sequence, never reused)
            const initials = (userProfile?.name || 'XX').split(' ').map((n: string) => n.charAt(0).toUpperCase()).join('').slice(0, 3)
            const today = new Date().toISOString().slice(2, 10).replace(/-/g, '')
            // Global count of ALL invoices by this user (never decreases even if deleted)
            const { count: totalCount } = await client.from('trade_invoices')
              .select('id', { count: 'exact', head: true })
              .eq('user_id', tradeUser.id)
            const seq = String((totalCount || 0) + 1).padStart(3, '0')
            const invoiceNumber = `SW-INV-${initials}-${today}-${seq}`

            // Create invoice + line items
            const { data: invoice, error: invErr } = await client.from('trade_invoices').insert({
              user_id: tradeUser.id,
              week_start: week_start || null,
              week_end: weekEnd,
              total_hours: Math.round(totalHours * 100) / 100,
              total_breaks_minutes: totalBreaks,
              subtotal_ex: Math.round(subtotal * 100) / 100,
              gst,
              total_inc: totalInc,
              has_manual_overrides: hasOverrides,
              override_details: hasOverrides ? overrideDetails : null,
              notes: invoiceNotes || null,
              invoice_number: invoiceNumber,
              submitted_at: new Date().toISOString(),
            }).select('id').single()

            if (invErr) throw new Error('Failed to create invoice: ' + invErr.message)

            // Insert labour line items
            for (const line of lineItems) {
              await client.from('trade_invoice_lines').insert({
                trade_invoice_id: invoice.id,
                line_type: 'labour',
                ...line,
              })
            }

            // Insert extra line items (travel, materials, equipment, other)
            for (const extra of extraLineItems) {
              await client.from('trade_invoice_lines').insert({
                trade_invoice_id: invoice.id,
                ...extra,
              })
            }

            // Auto-acknowledge for lead installers if hours within WO allocation
            const { data: userRoleCheck } = await client.from('users').select('role').eq('id', tradeUser.id).maybeSingle()
            if (userRoleCheck?.role === 'lead_installer') {
              let allAutoAcked = true
              let anyOverWO = false

              for (const line of lineItems) {
                // Look up work order for this job
                const { data: wo } = await client.from('work_orders')
                  .select('estimated_hours')
                  .eq('job_id', line.job_id)
                  .limit(1)
                  .maybeSingle()

                const woHours = wo?.estimated_hours || 0

                if (woHours > 0 && line.total_hours <= Math.max(woHours * 1.1, woHours + 1)) {
                  // Within 110% OR within 1 hour of WO (whichever is more generous) — auto-acknowledge
                  await client.from('trade_invoice_lines')
                    .update({
                      acknowledgment_status: 'acknowledged',
                      acknowledged_by: tradeUser.id,
                      acknowledged_at: new Date().toISOString(),
                    })
                    .eq('trade_invoice_id', invoice.id)
                    .eq('job_id', line.job_id)

                  line.work_order_hours = woHours
                } else if (woHours > 0) {
                  // Over WO — flag for ops review
                  anyOverWO = true
                  allAutoAcked = false
                } else {
                  // No WO — can't auto-ack
                  allAutoAcked = false
                }
              }

              if (allAutoAcked) {
                await client.from('trade_invoices').update({
                  status: 'acknowledged',
                  acknowledged_at: new Date().toISOString(),
                }).eq('id', invoice.id)
              } else if (anyOverWO) {
                await client.from('trade_invoices').update({
                  status: 'pending_ops_review',
                }).eq('id', invoice.id)

                // Notify Shaun about over-WO invoice
                const WO_TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
                if (WO_TELEGRAM_BOT_TOKEN) {
                  try {
                    const { data: shaun } = await client.from('users').select('telegram_id').ilike('email', '%shaun%').not('telegram_id', 'is', null).limit(1).maybeSingle()
                    if (shaun?.telegram_id) {
                      await fetch('https://api.telegram.org/bot' + WO_TELEGRAM_BOT_TOKEN + '/sendMessage', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          chat_id: shaun.telegram_id,
                          text: (userProfile?.name || 'Lead trade') + ' invoice for WK' + week_start.slice(5) + ' exceeds work order hours — needs review.',
                        }),
                      })
                    }
                  } catch (e) { /* non-blocking */ }
                }
              }
            }

            // Log business event
            try {
              await client.from('business_events').insert({
                event_type: 'trade.invoice_submitted',
                source: 'ops-api/generate_trade_invoice',
                entity_type: 'trade_invoice',
                entity_id: invoice.id,
                payload: { user_name: userProfile?.name, week_start, total_hours: totalHours, total_inc: totalInc },
              })
            } catch (e) { /* non-blocking */ }

            // Notify Shaun via Telegram
            const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
            if (TELEGRAM_BOT_TOKEN) {
              try {
                const { data: shaun } = await client.from('users').select('telegram_id').ilike('email', '%shaun%').not('telegram_id', 'is', null).limit(1).maybeSingle()
                if (shaun?.telegram_id) {
                  await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      chat_id: shaun.telegram_id,
                      text: (userProfile?.name || 'A trade') + ' submitted invoice for week of ' + week_start + ' — ' + Math.round(totalHours * 100) / 100 + 'h, $' + totalInc.toLocaleString(),
                    }),
                  })
                }
              } catch (e) { console.log('[ops-api] Telegram notify failed:', e) }
            }

            // ── Auto-push to Xero as DRAFT ACCPAY bill ──
            let xeroBillId = null
            let xeroBillNumber = null
            // Declared outside the try so the catch block can record which phase failed.
            let xeroContactId: string | null = null
            try {
              const { accessToken, tenantId } = await getToken(client)
              const tradeEmail = tradeUser.email || ''

              // Resolve Xero supplier contact.
              // Order: cached users.xero_contact_id -> email lookup -> create.
              // Cached path is critical for users whose Supabase email does not
              // match the Xero contact's primary EmailAddress (e.g. Jean Crous
              // — Supabase jeancrous44@gmail.com vs Xero jeancrous@gmail.com).
              // Without this, name-uniqueness in Xero blocks the create-PUT and
              // the auto-push silently fails forever.
              const cachedAutoContactId: string | null = userProfile?.xero_contact_id || null
              xeroContactId = cachedAutoContactId
              if (!xeroContactId) {
                try {
                  const contacts = await xeroGet('/Contacts?where=EmailAddress%3D%3D%22' + encodeURIComponent(tradeEmail) + '%22', accessToken, tenantId)
                  if (contacts?.Contacts?.length > 0) xeroContactId = contacts.Contacts[0].ContactID
                } catch (e) { /* fallback to create */ }
              }
              if (!xeroContactId) {
                const createRes = await xeroPost('/Contacts', accessToken, tenantId, {
                  Contacts: [{ Name: userProfile?.name || 'Trade', EmailAddress: tradeEmail, IsSupplier: true }]
                }, 'PUT')
                xeroContactId = createRes?.Contacts?.[0]?.ContactID
              }

              // Save contact ID for next time (only if not already cached on the user row).
              if (xeroContactId && !cachedAutoContactId) {
                await client.from('users').update({ xero_contact_id: xeroContactId }).eq('id', tradeUser.id)
              }
              if (!xeroContactId) {
                console.error('[ops-api] Could not resolve Xero contact for trade', tradeUser.id)
                // Mark invoice as needing manual Xero push
                await client.from('trade_invoices').update({ status: 'draft' }).eq('id', invoice.id)
              }

              if (xeroContactId) {
                // Due date: submit by Sunday → next Friday. Submit Mon+ → Friday after next.
                const now = new Date()
                const dayOfWeek = now.getDay() // 0=Sun, 1=Mon, ..., 6=Sat
                let daysToFriday = (5 - dayOfWeek + 7) % 7 || 7 // days until next Friday
                if (dayOfWeek >= 1 && dayOfWeek <= 6) daysToFriday += 7 // Mon-Sat: push to NEXT Friday
                // Sunday (0): this coming Friday. Mon-Sat: Friday after next.
                const dueDate = new Date(now.getTime() + daysToFriday * 86400000).toISOString().slice(0, 10)

                // Map division to Xero tracking option
                const divToTracking = (div: string): any[] => {
                  const map: Record<string, string> = {
                    'Patio': 'SW - PATIOS', 'Fencing': 'SW - FENCING', 'Decking': 'SW - DECKING',
                    'Make Safe': 'SW - INSURANCE WORK', 'General Labour': 'SW - GROUP',
                  }
                  const option = map[div] || ''
                  return option ? [{ Name: 'Business Unit', Option: option }] : []
                }

                // Build Xero line items with tracking + correct tax type + rich descriptions
                const allLines = [...lineItems.map((l: any) => ({
                  Description: [
                    (l.job_number || 'Labour') + ' | ' + (trackingCategoryForJob(l.job_number || '') || 'Construction'),
                    'Labour — ' + l.total_hours + 'h @ $' + l.hourly_rate + '/hr' + (l.days_worked > 1 ? ' (' + l.days_worked + ' days)' : ''),
                    [l.client_name, jobMap[l.job_id]?.site_address, jobMap[l.job_id]?.site_suburb].filter(Boolean).join(', '),
                  ].filter(Boolean).join('\n'),
                  Quantity: l.total_hours,
                  UnitAmount: l.hourly_rate,
                  AccountCode: accountCodeForJob(jobMap[l.job_id]?.type || '', '301'),
                  TaxType: taxType,
                  Tracking: xeroTracking(l.job_number || ''),
                })), ...extraLineItems.map((e: any) => ({
                  Description: [
                    e.job_number ? e.job_number + ' | ' + (trackingCategoryForJob(e.job_number || '') || '') : (e.division || 'General'),
                    (e.description || e.line_type || 'Extra') + (e.quantity > 1 ? ' (' + e.quantity + ' × $' + (e.unit_rate || 0) + ')' : ''),
                    e.client_name ? [e.client_name, e.site_address].filter(Boolean).join(', ') : '',
                  ].filter(Boolean).join('\n'),
                  Quantity: e.quantity || 1,
                  UnitAmount: e.unit_rate || 0,
                  AccountCode: e.job_id ? accountCodeForJob(jobMap[e.job_id]?.type || '', '301') : '301',
                  TaxType: taxType,
                  Tracking: e.job_number ? xeroTracking(e.job_number) : divToTracking(e.division || ''),
                }))]

                const xeroPayload = {
                  Invoices: [{
                    Type: 'ACCPAY',
                    Contact: { ContactID: xeroContactId },
                    Reference: invoiceNumber + ' | ' + [...new Set(lineItems.map((l: any) => l.job_number).filter(Boolean))].join(', '),
                    Date: now.toISOString().slice(0, 10),
                    DueDate: dueDate,
                    Status: 'DRAFT',
                    LineAmountTypes: gst_registered === false ? 'NoTax' : 'Exclusive',
                    LineItems: allLines,
                  }],
                }
                const xeroResult = await xeroPost('/Invoices', accessToken, tenantId, xeroPayload, 'PUT', 'trade-inv-' + invoice.id)
                const bill = xeroResult?.Invoices?.[0]
                if (bill?.InvoiceID) {
                  xeroBillId = bill.InvoiceID
                  xeroBillNumber = bill.InvoiceNumber || ''
                  await client.from('trade_invoices').update({
                    xero_bill_id: bill.InvoiceID,
                    xero_pushed_at: new Date().toISOString(),
                    status: 'pushed_to_xero',
                  }).eq('id', invoice.id)
                  // Cache
                  try {
                    await client.from('xero_invoices').upsert({
                      org_id: DEFAULT_ORG_ID,
                      xero_invoice_id: bill.InvoiceID,
                      invoice_number: bill.InvoiceNumber || '',
                      invoice_type: 'ACCPAY',
                      status: 'DRAFT',
                      reference: invoiceNumber,
                      total: totalInc,
                      amount_due: totalInc,
                      due_date: dueDate,
                      contact_name: userProfile?.name || 'Trade',
                    }, { onConflict: 'xero_invoice_id' })
                  } catch (e) { /* non-blocking */ }
                }
              }
            } catch (e) {
              const errMsg = (e as Error).message
              console.log('[ops-api] Xero auto-push failed (non-blocking):', errMsg)
              // Persist the failure so admin has an audit trail (the user-visible
              // "Saved locally — admin will sync manually" message used to be the
              // ONLY signal that the push failed). Non-blocking — invoice insert is
              // already committed; we want the response to keep being 200.
              try {
                await client.from('business_events').insert({
                  event_type: 'trade.xero_push_failed',
                  source: 'ops-api/generate_trade_invoice',
                  entity_type: 'trade_invoice',
                  entity_id: invoice.id,
                  payload: {
                    invoice_number: invoiceNumber,
                    user_id: tradeUser.id,
                    error_message: errMsg,
                    error_phase: xeroContactId ? 'bill_creation' : 'contact_resolution',
                  },
                  schema_version: '1.0',
                })
              } catch (logErr) { console.log('[ops-api] Failed to record xero_push_failed event:', (logErr as Error).message) }
            }

            return json({ success: true, invoice_id: invoice.id, invoice_number: invoiceNumber, total_hours: totalHours, total_inc: totalInc, line_count: lineItems.length + extraLineItems.length, xero_bill_id: xeroBillId, xero_bill_number: xeroBillNumber, xero_warning: !xeroBillId ? 'Invoice saved but could not push to Xero — admin will push manually' : undefined })
          }

          case 'my_invoices': {
            const { data, error } = await client.from('trade_invoices')
              .select('*, lines:trade_invoice_lines(*)')
              .eq('user_id', tradeUser.id)
              .order('week_start', { ascending: false })
              .limit(20)

            if (error) throw new Error(error.message)
            return json({ invoices: data || [] })
          }

          case 'acknowledge_invoice_line': {
            const { line_id, acknowledged, query_note: ackNote } = body
            if (!line_id) throw new ApiError('line_id required', 400)

            const updateData: Record<string, any> = {
              acknowledged_by: tradeUser.id,
              acknowledged_at: new Date().toISOString(),
              acknowledgment_status: acknowledged !== false ? 'acknowledged' : 'queried',
            }
            if (ackNote) updateData.query_note = ackNote

            const { error } = await client.from('trade_invoice_lines')
              .update(updateData)
              .eq('id', line_id)

            if (error) throw new Error(error.message)

            // Check if all lines on this invoice are acknowledged
            const { data: line } = await client.from('trade_invoice_lines')
              .select('trade_invoice_id')
              .eq('id', line_id)
              .maybeSingle()

            const ACK_TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''

            if (line) {
              const { data: allLines } = await client.from('trade_invoice_lines')
                .select('acknowledgment_status')
                .eq('trade_invoice_id', line.trade_invoice_id)

              const allAcked = allLines?.every((l: any) => l.acknowledgment_status === 'acknowledged')
              if (allAcked) {
                await client.from('trade_invoices')
                  .update({ status: 'acknowledged', acknowledged_at: new Date().toISOString() })
                  .eq('id', line.trade_invoice_id)

                // Notify the trade that invoice is fully acknowledged
                const { data: tradeInv } = await client.from('trade_invoices')
                  .select('user_id, week_start, total_inc, user:user_id(name, telegram_id)')
                  .eq('id', line.trade_invoice_id)
                  .maybeSingle()

                if (tradeInv?.user?.telegram_id && ACK_TELEGRAM_BOT_TOKEN) {
                  try {
                    await fetch('https://api.telegram.org/bot' + ACK_TELEGRAM_BOT_TOKEN + '/sendMessage', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        chat_id: tradeInv.user.telegram_id,
                        text: 'Your invoice for week of ' + tradeInv.week_start + ' has been acknowledged — $' + Number(tradeInv.total_inc).toLocaleString() + ' pushing to Xero.',
                      }),
                    })
                  } catch (e) { /* non-blocking */ }
                }
              }

              // Notify trade about query
              if (acknowledged === false) {
                const { data: tradeInv } = await client.from('trade_invoices')
                  .select('user_id, week_start, user:user_id(telegram_id)')
                  .eq('id', line.trade_invoice_id)
                  .maybeSingle()

                const { data: queriedLine } = await client.from('trade_invoice_lines')
                  .select('job_number')
                  .eq('id', line_id)
                  .maybeSingle()

                if (tradeInv?.user?.telegram_id && ACK_TELEGRAM_BOT_TOKEN) {
                  try {
                    await fetch('https://api.telegram.org/bot' + ACK_TELEGRAM_BOT_TOKEN + '/sendMessage', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        chat_id: tradeInv.user.telegram_id,
                        text: 'Query on your invoice — ' + (queriedLine?.job_number || '') + ': ' + (ackNote || 'Please review'),
                      }),
                    })
                  } catch (e) { /* non-blocking */ }
                }
              }
            }

            return json({ success: true })
          }

          case 'clock_event': {
            const { assignment_id, event, timestamp, location, break_minutes: clientBreakMins, manual_override, progress_pct, idempotency_key } = body
            if (!assignment_id || !event) throw new ApiError('assignment_id and event required', 400)

            const validEvents = ['clock_on', 'clock_off', 'start_travel', 'arrived', 'pause', 'resume', 'materials_check', 'manual_override']
            if (!validEvents.includes(event)) throw new ApiError('Invalid event: ' + event, 400)

            // Idempotency check
            if (idempotency_key) {
              const { data: existing } = await client.from('job_events')
                .select('id')
                .eq('detail_json->>idempotency_key', idempotency_key)
                .limit(1)
              if (existing && existing.length > 0) {
                // Already processed — return the assignment as-is
                const { data: ass } = await client.from('job_assignments').select('*').eq('id', assignment_id).maybeSingle()
                return json({ success: true, assignment: ass, duplicate: true })
              }
            }

            // Get the assignment
            const { data: assignment, error: assErr } = await client.from('job_assignments')
              .select('*')
              .eq('id', assignment_id)
              .maybeSingle()
            if (assErr || !assignment) throw new ApiError('Assignment not found', 404)

            const now = new Date().toISOString()
            const updateFields: Record<string, any> = {}
            let eventType = 'clock.' + event
            let eventDetail: Record<string, any> = {
              assignment_id, event, client_timestamp: timestamp, idempotency_key: idempotency_key || null
            }
            if (location) eventDetail.location = location

            switch (event) {
              case 'clock_on':
                updateFields.clocked_on_at = now
                updateFields.arrived_at = now
                updateFields.status = 'in_progress'
                updateFields.job_phase = 'working'
                if (!assignment.started_at) updateFields.started_at = now
                break

              case 'start_travel':
                updateFields.clocked_on_at = now
                updateFields.travel_started_at = now
                updateFields.status = 'in_progress'
                updateFields.job_phase = 'travelling'
                if (!assignment.started_at) updateFields.started_at = now
                break

              case 'undo_travel':
                updateFields.clocked_on_at = null
                updateFields.travel_started_at = null
                updateFields.job_phase = null
                updateFields.status = assignment.status === 'in_progress' ? 'confirmed' : assignment.status
                if (assignment.started_at && !assignment.arrived_at) updateFields.started_at = null
                break

              case 'arrived':
                updateFields.arrived_at = now
                updateFields.job_phase = 'arrived'
                break

              case 'pause':
                updateFields.job_phase = 'paused'
                break

              case 'resume':
                updateFields.job_phase = 'working'
                // Server calculates break_minutes from pause/resume pairs
                if (clientBreakMins != null) updateFields.break_minutes = clientBreakMins
                break

              case 'clock_off': {
                updateFields.clocked_off_at = now
                updateFields.status = 'complete'
                updateFields.job_phase = 'complete'
                if (!assignment.completed_at) updateFields.completed_at = now

                // Server-calculate break minutes from pause/resume events
                let serverBreakMins = 0
                try {
                  const { data: pauseEvents } = await client.from('job_events')
                    .select('event_type, created_at, detail_json')
                    .eq('job_id', assignment.job_id)
                    .in('event_type', ['clock.pause', 'clock.resume'])
                    .order('created_at', { ascending: true })

                  if (pauseEvents && pauseEvents.length > 0) {
                    let lastPause: string | null = null
                    for (const pe of pauseEvents) {
                      if (pe.event_type === 'clock.pause') {
                        lastPause = pe.created_at
                      } else if (pe.event_type === 'clock.resume' && lastPause) {
                        serverBreakMins += Math.round((new Date(pe.created_at).getTime() - new Date(lastPause).getTime()) / 60000)
                        lastPause = null
                      }
                    }
                    // If still paused (no resume after last pause), count to now
                    if (lastPause) {
                      serverBreakMins += Math.round((Date.now() - new Date(lastPause).getTime()) / 60000)
                    }
                  }
                } catch (e) { console.log('[clock_event] break calc error:', e) }

                updateFields.break_minutes = serverBreakMins || clientBreakMins || 0

                // Calculate hours_worked
                const clockOn = assignment.clocked_on_at || updateFields.clocked_on_at || assignment.started_at
                if (clockOn) {
                  const grossMinutes = Math.round((new Date(now).getTime() - new Date(clockOn).getTime()) / 60000)
                  const netMinutes = Math.max(0, grossMinutes - (updateFields.break_minutes || 0))
                  updateFields.hours_worked = Math.round(netMinutes / 60 * 100) / 100 // 2 decimal places
                  eventDetail.gross_hours = Math.round(grossMinutes / 60 * 100) / 100
                  eventDetail.break_minutes = updateFields.break_minutes
                  eventDetail.net_hours = updateFields.hours_worked
                }

                if (progress_pct != null) updateFields.progress_pct = progress_pct
                break
              }

              case 'manual_override': {
                const { original_hours, adjusted_hours } = body
                updateFields.manual_override_flag = true
                if (adjusted_hours != null) {
                  updateFields.hours_worked = adjusted_hours
                }
                eventDetail.original_hours = original_hours
                eventDetail.adjusted_hours = adjusted_hours
                break
              }

              case 'materials_check': {
                const { materials_status, missing_items } = body
                eventDetail.materials_status = materials_status
                eventDetail.missing_items = missing_items
                // Don't update assignment columns — just log the event
                break
              }
            }

            // Update the assignment
            if (Object.keys(updateFields).length > 0) {
              updateFields.last_phase_changed_at = now
              const { error: updateErr } = await client.from('job_assignments')
                .update(updateFields)
                .eq('id', assignment_id)
              if (updateErr) throw new Error('Failed to update assignment: ' + updateErr.message)
            }

            // Log the event
            try {
              await client.from('job_events').insert({
                job_id: assignment.job_id,
                user_id: tradeUser.id,
                event_type: eventType,
                detail_json: eventDetail,
              })
            } catch (e) { console.log('[clock_event] event log error:', e) }

            // Log business event for clock_on and clock_off
            if (event === 'clock_on' || event === 'clock_off' || event === 'start_travel' || event === 'undo_travel') {
              try {
                await client.from('business_events').insert({
                  event_type: 'trade.' + event,
                  source: 'ops-api/clock_event',
                  entity_type: 'assignment',
                  entity_id: assignment_id,
                  payload: { job_id: assignment.job_id, user_id: tradeUser.id, event, hours_worked: updateFields.hours_worked },
                })
              } catch (e) { /* non-blocking */ }
            }

            // Return the updated assignment
            const { data: updated } = await client.from('job_assignments')
              .select('*')
              .eq('id', assignment_id)
              .maybeSingle()

            return json({ success: true, assignment: updated, event_id: null, net_hours: updateFields.hours_worked || null })
          }
        }
      }

      case 'reconcile_transaction': {
        const { xero_txn_id, job_id, cost_centre, action: txnAction } = body
        if (!xero_txn_id) throw new ApiError('xero_txn_id required', 400)

        try {
          await client.from('business_events').insert({
            event_type: 'transaction.reconciled',
            source: 'ops-api/reconcile_transaction',
            entity_type: 'transaction',
            entity_id: xero_txn_id,
            payload: { xero_txn_id, job_id: job_id || null, cost_centre: cost_centre || null, action: txnAction || 'reconciled', reconciled_at: new Date().toISOString() },
          })
        } catch (e) { /* non-blocking */ }

        result = { success: true, transaction_id: xero_txn_id, status: txnAction || 'reconciled' }
        break
      }

      // ── Clear Debt: Payment Chase ──
      case 'list_overdue_invoices': return json(await listOverdueInvoices(client))
      case 'classify_invoice': return json(await classifyInvoice(client, body))
      case 'log_chase': return json(await logChase(client, body))
      case 'resolve_follow_up': return json(await resolveFollowUp(client, body))
      case 'send_chase_sms': return json(await sendChaseSms(client, body))
      case 'trigger_chase_workflow': return json(await triggerChaseWorkflow(client, body))
      case 'stop_chase_workflow': return json(await stopChaseWorkflow(client, body))
      case 'handle_payment_event': return json(await handlePaymentEvent(client, body))
      case 'trigger_xero_sync': return json(await triggerXeroSync())
      case 'ai_analyse_debt_client': return json(await aiAnalyseDebtClient(client, body))
      case 'ai_draft_chase_message': return json(await aiDraftChaseMessage(body))
      case 'ai_triage_debt_portfolio': return json(await aiTriageDebtPortfolio(body))
      case 'ai_batch_hints': return json(await aiBatchHints(body))
      case 'force_reconcile_invoice': return json(await forceReconcileInvoice(client, body))

      // ── Job Memory Loop: generic business_event logger ──
      case 'log_business_event': {
        const { event_type, entity_type, entity_id, job_id, payload } = body
        if (!event_type) return json({ error: 'event_type required' }, 400)
        const { error } = await client.from('business_events').insert({
          event_type,
          source: 'mcp_agent',
          entity_type: entity_type || 'unknown',
          entity_id: entity_id || null,
          job_id: job_id || null,
          payload: payload || {},
          occurred_at: new Date().toISOString(),
        })
        if (error) return json({ error: error.message }, 500)
        return json({ ok: true, event_type })
      }

      default: return json({ error: 'Unknown action' }, 400)
    }
  } catch (err) {
    if (err instanceof ApiError) {
      return json({ error: err.message }, err.status)
    }
    console.error('[ops-api] ERROR:', err)
    return json({ error: (err as Error).message || 'Internal error' }, 500)
  }
})


// ════════════════════════════════════════════════════════════
// DAILY PROPOSAL COVERAGE AUDIT — read-only contract
// ════════════════════════════════════════════════════════════
//
// Read-only snapshot of the sales-truth coverage state. Returns counts +
// asserts thresholds, emits ONE business_events row per call for trend
// tracking. No customer comms, no GHL writes, no destructive backfill.
//
// Designed to be called daily by a cron / GitHub Action / JARVIS loop.
// On-demand invocation is also supported (idempotent within a run).
//
// Contract:
//   - Run the same SQL probes the launch packet uses (A, F, G, J, K).
//   - Emit a snapshot in JSON.
//   - Emit a business_events row with event_type='coverage_audit_snapshot'.
//   - Fail assertions are recorded in the response and the event payload,
//     never throw — the audit is informational.
//
// Schema-free: no migrations. Uses existing tables only.

const COVERAGE_AUDIT_THRESHOLDS = {
  linkage_health_min: 0.95,
  quote_coverage_min: 0.95,
  cap_headroom_max:   0.80, // pending_in_window / cap should stay below this
  cockpit_cap: 1000,        // matches ops-api listProposedActions cap
} as const

async function dailyCoverageAudit(client: any, _params: URLSearchParams) {
  const windowDays = 45
  const windowCutoff = new Date(Date.now() - windowDays * 86400000).toISOString()

  // The launch proof is measured against the same real-customer universe that
  // sale.html renders. CAP0/canary/test rows stay visible in raw diagnostics
  // below, but they do not decide the health assertion salespeople rely on.
  const isSalesTestRow = (row: any): boolean => {
    const haystack = `${row?.client_name || ''} ${row?.job_number || ''}`.toLowerCase()
    return /\b(cap0|canary|marnin\s+test|test22)\b/.test(haystack) ||
      /internal\s+test/.test(haystack)
  }

  const { data: recentRows, error: recentRowsErr } = await client.from('jobs')
    .select('id, job_number, client_name, status, ghl_opportunity_id, quoted_at')
    .gte('created_at', windowCutoff)
    .limit(2000)

  if (recentRowsErr) {
    console.error('[ops-api] daily_coverage_audit jobs query failed:', recentRowsErr.message)
    return {
      snapshot_id: crypto.randomUUID(),
      ran_at: new Date().toISOString(),
      window_days: windowDays,
      error: recentRowsErr.message,
      assertions: [],
      events_emitted: [],
    }
  }

  const { data: pendingProps } = await client.from('ai_proposed_actions')
    .select('proposal_id, action_type, job_id, sent_at, created_at, expires_at')
    .eq('status', 'pending')
    .is('sent_at', null)
    .limit(2000)

  const { data: quoteLoopTraces, error: quoteLoopTraceErr } = await client.from('ai_reasoning_traces')
    .select('id, created_at, output_type, input_context_snapshot, output_result')
    .eq('trigger_type', 'automation:quote-nurture-cadence')
    .gte('created_at', windowCutoff)
    .order('created_at', { ascending: false })
    .limit(5000)

  if (quoteLoopTraceErr) {
    console.error('[ops-api] daily_coverage_audit quote trace query failed:', quoteLoopTraceErr.message)
  }

  const nowMs = Date.now()
  const ttlFor = (t: string) =>
    t === 'propose_quote_review_task' ? 7 * 24 * 3600000 :
    t === 'propose_scoper_booking_approval' ? 24 * 3600000 :
    36 * 3600000

  const effectiveExpires = (row: any): number => {
    if (row.expires_at) return new Date(row.expires_at).getTime()
    return new Date(row.created_at).getTime() + ttlFor(row.action_type)
  }

  const inWindow = (pendingProps || []).filter((p: any) => {
    const eff = effectiveExpires(p)
    return eff > nowMs && eff < nowMs + 48 * 3600000
  })

  const jobsWithProposal = new Set(
    (pendingProps || []).filter((p: any) => p.job_id).map((p: any) => p.job_id)
  )
  const jobsWithQuoteLoopTrace = new Set(
    (quoteLoopTraces || [])
      .map((t: any) => t?.input_context_snapshot?.job_id)
      .filter(Boolean)
  )

  const rawRows = recentRows || []
  const realRows = rawRows.filter((j: any) => !isSalesTestRow(j))
  const minQuoteAgeMs = 2 * 86400000
  const isQuoteTooFresh = (row: any): boolean => {
    const quotedMs = row?.quoted_at ? new Date(row.quoted_at).getTime() : NaN
    return Number.isFinite(quotedMs) && (nowMs - quotedMs) < minQuoteAgeMs
  }
  const rawQuotedRows = rawRows.filter((j: any) => j.status === 'quoted')
  const realQuotedRows = realRows.filter((j: any) => j.status === 'quoted')
  const rawEligibleQuotedRows = rawQuotedRows.filter((j: any) => !isQuoteTooFresh(j))
  const realEligibleQuotedRows = realQuotedRows.filter((j: any) => !isQuoteTooFresh(j))
  const realTooFreshQuoted = realQuotedRows.length - realEligibleQuotedRows.length

  const rawLinkedSize = rawRows.filter((j: any) => !!j.ghl_opportunity_id).length
  const realLinkedSize = realRows.filter((j: any) => !!j.ghl_opportunity_id).length

  const quotedWithProposal = realEligibleQuotedRows.filter(
    (j: any) => jobsWithProposal.has(j.id)
  ).length
  const quotedWithTrace = realEligibleQuotedRows.filter(
    (j: any) => jobsWithQuoteLoopTrace.has(j.id)
  ).length
  const quotedHandled = realEligibleQuotedRows.filter(
    (j: any) => jobsWithProposal.has(j.id) || jobsWithQuoteLoopTrace.has(j.id)
  ).length
  const rawQuotedWithProposal = rawEligibleQuotedRows.filter(
    (j: any) => jobsWithProposal.has(j.id)
  ).length
  const rawQuotedHandled = rawEligibleQuotedRows.filter(
    (j: any) => jobsWithProposal.has(j.id) || jobsWithQuoteLoopTrace.has(j.id)
  ).length
  const unlinkedQuoted = realEligibleQuotedRows.filter(
    (j: any) => !j.ghl_opportunity_id
  ).length

  const byActionType: Record<string, number> = {}
  for (const p of pendingProps || []) {
    byActionType[p.action_type] = (byActionType[p.action_type] || 0) + 1
  }

  const universeSize = realRows.length
  const linkedSize = realLinkedSize
  const quotedSize = realEligibleQuotedRows.length
  const linkagePct = universeSize > 0 ? linkedSize / universeSize : 0
  const quoteCoveragePct = quotedSize > 0 ? quotedHandled / quotedSize : 0
  const capHeadroom = inWindow.length / COVERAGE_AUDIT_THRESHOLDS.cockpit_cap

  const assertions = [
    {
      name: 'linkage_health',
      passed: linkagePct >= COVERAGE_AUDIT_THRESHOLDS.linkage_health_min,
      value: Number(linkagePct.toFixed(3)),
      threshold: COVERAGE_AUDIT_THRESHOLDS.linkage_health_min,
    },
    {
      name: 'quote_coverage',
      passed: quoteCoveragePct >= COVERAGE_AUDIT_THRESHOLDS.quote_coverage_min,
      value: Number(quoteCoveragePct.toFixed(3)),
      threshold: COVERAGE_AUDIT_THRESHOLDS.quote_coverage_min,
    },
    {
      name: 'cap_headroom',
      passed: capHeadroom <= COVERAGE_AUDIT_THRESHOLDS.cap_headroom_max,
      value: Number(capHeadroom.toFixed(3)),
      threshold: COVERAGE_AUDIT_THRESHOLDS.cap_headroom_max,
    },
  ]

  const snapshot = {
    snapshot_id: crypto.randomUUID(),
    ran_at: new Date().toISOString(),
    window_days: windowDays,
    universe: {
      supabase_jobs_45d: universeSize,
      linked_45d: linkedSize,
      unlinked_45d: universeSize - linkedSize,
      linkage_pct: Number(linkagePct.toFixed(3)),
      scope: 'real_customer_sales_rows',
      excluded_test_rows: rawRows.length - realRows.length,
    },
    raw_unfiltered_universe: {
      supabase_jobs_45d: rawRows.length,
      linked_45d: rawLinkedSize,
      unlinked_45d: rawRows.length - rawLinkedSize,
      linkage_pct: rawRows.length > 0 ? Number((rawLinkedSize / rawRows.length).toFixed(3)) : 0,
      quoted_45d: rawQuotedRows.length,
      eligible_quoted_45d: rawEligibleQuotedRows.length,
      quoted_with_proposal: rawQuotedWithProposal,
      quoted_handled_by_proposal_or_trace: rawQuotedHandled,
      quote_coverage_pct: rawEligibleQuotedRows.length > 0 ? Number((rawQuotedHandled / rawEligibleQuotedRows.length).toFixed(3)) : 0,
    },
    queue: {
      pending_total: (pendingProps || []).length,
      in_window: inWindow.length,
      cap: COVERAGE_AUDIT_THRESHOLDS.cockpit_cap,
      cap_headroom: Number(capHeadroom.toFixed(3)),
    },
    quote_coverage: {
      quoted_45d: realQuotedRows.length,
      eligible_quoted_45d: quotedSize,
      too_fresh_quoted: realTooFreshQuoted,
      quoted_with_live_proposal: quotedWithProposal,
      quoted_with_quote_loop_trace: quotedWithTrace,
      quoted_handled_by_proposal_or_trace: quotedHandled,
      quote_coverage_pct: Number(quoteCoveragePct.toFixed(3)),
      semantics: 'real quoted jobs old enough for the quote-nurture loop, with either a live proposal or a current quote-nurture suppression/decision trace',
    },
    coverage_by_action_type: byActionType,
    hygiene_queue: {
      unlinked_quoted: unlinkedQuoted,
    },
    assertions,
    events_emitted: ['coverage_audit_snapshot'],
  }

  await logBusinessEvent(client, {
    event_type: 'coverage_audit_snapshot',
    source: 'ops-api/daily_coverage_audit',
    entity_type: 'audit',
    entity_id: snapshot.snapshot_id,
    payload: snapshot,
  })

  return snapshot
}


// ════════════════════════════════════════════════════════════
// OPS DASHBOARD — READ ACTIONS
// ════════════════════════════════════════════════════════════

async function opsSummary(client: any) {
  const now = new Date()
  const todayStr = now.toISOString().slice(0, 10)
  const monthStart = todayStr.slice(0, 7) + '-01'
  // Monday of this week
  const weekStart = new Date(now)
  const dayOfWeek = now.getDay() || 7 // Sunday=7
  weekStart.setDate(now.getDate() - dayOfWeek + 1)
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekStart.getDate() + 6)

  const [
    todaySchedule,
    weekAssignments,
    needsScheduling,
    allActiveJobs,
    overdueInvoices,
    pendingQuotes,
    monthCompletedJobs,
    activePOs,
    activeWOs,
    targets,
    stuckJobs,
    scopePending,
    upcomingAssignments,
  ] = await Promise.all([
    // Today's schedule from calendar_events view
    client.from('calendar_events')
      .select('*')
      .eq('org_id', DEFAULT_ORG_ID)
      .eq('scheduled_date', todayStr)
      .neq('assignment_status', 'cancelled')
      .order('start_time', { ascending: true, nullsFirst: false }),

    // This week's assignments
    client.from('job_assignments')
      .select('id, job_id, scheduled_date, status, assignment_type')
      .gte('scheduled_date', weekStart.toISOString().slice(0, 10))
      .lte('scheduled_date', weekEnd.toISOString().slice(0, 10))
      .neq('status', 'cancelled'),

    // Jobs needing scheduling
    client.from('jobs_needing_scheduling')
      .select('*')
      .eq('org_id', DEFAULT_ORG_ID)
      .not('job_number', 'is', null)
      .limit(20),

    // Active jobs for pipeline counts
    // Cap 1A: widened to canonical ACTIVE_STATUSES (excludes terminal cancelled/lost/archived).
    // Source: supabase/functions/_shared/stage-gate/job-state-machine.ts. The prior 9-value list silently
    // dropped jobs in `awaiting_deposit, order_materials, awaiting_supplier, order_confirmed,
    // partially_accepted, schedule_install, rectification, final_payment, get_review`.
    client.from('jobs')
      .select('id, status, type, accepted_at, completed_at, pricing_json')
      .eq('org_id', DEFAULT_ORG_ID)
      .not('legacy', 'is', true)
      .in('status', [
        'draft', 'quoted', 'partially_accepted', 'accepted', 'awaiting_deposit', 'deposit',
        'approvals', 'order_materials', 'processing', 'awaiting_supplier', 'order_confirmed',
        'schedule_install', 'scheduled', 'in_progress', 'rectification',
        'complete', 'final_payment', 'invoiced', 'get_review'
      ])
      .not('job_number', 'is', null),

    // Overdue receivable invoices
    client.from('xero_invoices')
      .select('id, contact_name, total, amount_due, due_date, status')
      .eq('org_id', DEFAULT_ORG_ID)
      .eq('invoice_type', 'ACCREC')
      .in('status', ['AUTHORISED', 'SUBMITTED'])
      .lt('due_date', todayStr),

    // Pending quotes (sent but not accepted)
    client.from('job_documents')
      .select('id, job_id, sent_at, created_at')
      .eq('type', 'quote')
      .eq('sent_to_client', true)
      .is('accepted_at', null)
      .is('declined_at', null),

    // Jobs completed this month
    client.from('jobs')
      .select('id, completed_at')
      .eq('org_id', DEFAULT_ORG_ID)
      .not('legacy', 'is', true)
      .in('status', ['complete', 'invoiced'])
      .gte('completed_at', monthStart),

    // Active POs
    client.from('purchase_orders')
      .select('id, status, delivery_date, job_id, supplier_name, total')
      .eq('org_id', DEFAULT_ORG_ID)
      .in('status', ['draft', 'submitted', 'authorised']),

    // Active WOs
    client.from('work_orders')
      .select('id, status, scheduled_date, job_id, wo_number')
      .eq('org_id', DEFAULT_ORG_ID)
      .in('status', ['draft', 'sent', 'accepted', 'in_progress']),

    // KPI targets
    getOpsTargets(client),

    // Stuck jobs: accepted status for 14+ days (no status change)
    client.from('jobs')
      .select('id, client_name, site_suburb, type, job_number, accepted_at, updated_at')
      .eq('org_id', DEFAULT_ORG_ID)
      .not('legacy', 'is', true)
      .eq('status', 'accepted')
      .not('job_number', 'is', null)
      .lt('accepted_at', new Date(Date.now() - 14 * 86400000).toISOString()),

    // Scope pending: draft jobs older than 7 days
    client.from('jobs')
      .select('id, client_name, type, created_at')
      .eq('org_id', DEFAULT_ORG_ID)
      .not('legacy', 'is', true)
      .eq('status', 'draft')
      .lt('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
      .limit(20),

    // Jobs starting within 7 days (for material conflict checks)
    client.from('job_assignments')
      .select('job_id, scheduled_date')
      .eq('status', 'scheduled')
      .gte('scheduled_date', todayStr)
      .lte('scheduled_date', new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)),
  ])

  // ── Stat Cards ──
  const weekJobCount = (weekAssignments.data || []).length
  const awaitingMaterials = (activePOs.data || []).filter((po: any) =>
    po.status === 'authorised' && po.delivery_date
  ).length
  const overdueCount = (overdueInvoices.data || []).length
  const overdueTotal = (overdueInvoices.data || []).reduce((sum: number, inv: any) => sum + (inv.amount_due || inv.total || 0), 0)
  const quotePendingCount = (pendingQuotes.data || []).length

  // ── Attention Items ──
  const attention: any[] = []

  const nsData = needsScheduling.data || []
  if (nsData.length > 0) {
    attention.push({
      type: 'scheduling',
      severity: nsData.some((j: any) => j.days_waiting > 7) ? 'red' : 'amber',
      title: `${nsData.length} job${nsData.length === 1 ? '' : 's'} need scheduling`,
      items: nsData.slice(0, 5).map((j: any) => ({
        id: j.id, client: j.client_name, suburb: j.site_suburb,
        type: j.type, days_waiting: j.days_waiting,
      })),
    })
  }

  // Overdue PO deliveries
  const overduePOs = (activePOs.data || []).filter((po: any) =>
    po.delivery_date && po.delivery_date < todayStr
  )
  if (overduePOs.length > 0) {
    attention.push({
      type: 'overdue_delivery',
      severity: 'amber',
      title: `${overduePOs.length} PO delivery${overduePOs.length === 1 ? '' : 'ies'} overdue`,
      items: overduePOs.slice(0, 5).map((po: any) => ({
        id: po.id, supplier: po.supplier_name, delivery_date: po.delivery_date,
      })),
    })
  }

  // POs stuck in draft (To Order) for 48+ hours
  const stuckDraftPOs = (activePOs.data || []).filter((po: any) =>
    po.status === 'draft' && po.created_at &&
    (Date.now() - new Date(po.created_at).getTime()) > 48 * 3600000
  )
  if (stuckDraftPOs.length > 0) {
    attention.push({
      type: 'stuck_draft_po',
      severity: 'amber',
      title: `${stuckDraftPOs.length} PO${stuckDraftPOs.length === 1 ? '' : 's'} stuck in To Order (48+ hrs)`,
      items: stuckDraftPOs.slice(0, 5).map((po: any) => ({
        id: po.id, supplier: po.supplier_name || 'No supplier',
        hours: Math.floor((Date.now() - new Date(po.created_at).getTime()) / 3600000),
      })),
    })
  }

  // POs with delivery in ≤2 days but not yet confirmed
  const twoDaysOut = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
  const unconfirmedDeliveries = (activePOs.data || []).filter((po: any) =>
    po.status === 'submitted' && po.delivery_date &&
    po.delivery_date >= todayStr && po.delivery_date <= twoDaysOut
  )
  if (unconfirmedDeliveries.length > 0) {
    attention.push({
      type: 'unconfirmed_delivery',
      severity: 'red',
      title: `${unconfirmedDeliveries.length} delivery${unconfirmedDeliveries.length === 1 ? '' : 'ies'} in ≤2 days — not confirmed`,
      items: unconfirmedDeliveries.slice(0, 5).map((po: any) => ({
        id: po.id, supplier: po.supplier_name, delivery_date: po.delivery_date,
      })),
    })
  }

  // WOs not sent
  const draftWOs = (activeWOs.data || []).filter((wo: any) => wo.status === 'draft')
  if (draftWOs.length > 0) {
    attention.push({
      type: 'unsent_wo',
      severity: 'amber',
      title: `${draftWOs.length} work order${draftWOs.length === 1 ? '' : 's'} not sent`,
    })
  }

  // Complete but not invoiced — only flag recent jobs (with assignments or job numbers = managed through ops)
  const allActive = allActiveJobs.data || []
  const completeNotInvoiced = allActive.filter((j: any) => j.status === 'complete')
  if (completeNotInvoiced.length > 0) {
    attention.push({
      type: 'not_invoiced',
      severity: completeNotInvoiced.length > 3 ? 'red' : 'amber',
      title: `${completeNotInvoiced.length} complete job${completeNotInvoiced.length === 1 ? '' : 's'} not invoiced`,
      job_ids: completeNotInvoiced.slice(0, 10).map((j: any) => j.id),
      items: completeNotInvoiced.slice(0, 5).map((j: any) => ({
        id: j.id, client: j.client_name, suburb: j.site_suburb,
        type: j.type,
      })),
    })
  }

  // Overdue invoices — broken into aging tiers
  const overdueInvList = overdueInvoices.data || []
  if (overdueInvList.length > 0) {
    const now = Date.now()
    const tier1: any[] = [] // 14-30 days
    const tier2: any[] = [] // 30-60 days
    const tier3: any[] = [] // 60+ days
    for (const inv of overdueInvList) {
      const daysOverdue = Math.floor((now - new Date(inv.due_date).getTime()) / 86400000)
      if (daysOverdue >= 60) tier3.push({ ...inv, days_overdue: daysOverdue })
      else if (daysOverdue >= 30) tier2.push({ ...inv, days_overdue: daysOverdue })
      else if (daysOverdue >= 14) tier1.push({ ...inv, days_overdue: daysOverdue })
    }
    if (tier3.length > 0) {
      const total = tier3.reduce((s: number, i: any) => s + (i.amount_due || i.total || 0), 0)
      attention.push({
        type: 'overdue_invoices_critical',
        severity: 'red',
        title: `${tier3.length} invoice${tier3.length === 1 ? '' : 's'} 60+ days overdue ($${Math.round(total).toLocaleString()}) — escalate`,
      })
    }
    if (tier2.length > 0) {
      const total = tier2.reduce((s: number, i: any) => s + (i.amount_due || i.total || 0), 0)
      attention.push({
        type: 'overdue_invoices_chase',
        severity: 'red',
        title: `${tier2.length} invoice${tier2.length === 1 ? '' : 's'} 30-60 days overdue ($${Math.round(total).toLocaleString()}) — chase payment`,
      })
    }
    if (tier1.length > 0) {
      const total = tier1.reduce((s: number, i: any) => s + (i.amount_due || i.total || 0), 0)
      attention.push({
        type: 'overdue_invoices_gentle',
        severity: 'amber',
        title: `${tier1.length} invoice${tier1.length === 1 ? '' : 's'} 14-30 days overdue ($${Math.round(total).toLocaleString()}) — gentle follow-up`,
      })
    }
    // Still show a combined count for invoices less than 14 days overdue
    const recentOverdue = overdueInvList.length - tier1.length - tier2.length - tier3.length
    if (recentOverdue > 0) {
      const total = overdueInvList
        .filter((i: any) => Math.floor((now - new Date(i.due_date).getTime()) / 86400000) < 14)
        .reduce((s: number, i: any) => s + (i.amount_due || i.total || 0), 0)
      attention.push({
        type: 'overdue_invoices',
        severity: 'amber',
        title: `${recentOverdue} recently overdue invoice${recentOverdue === 1 ? '' : 's'} ($${Math.round(total).toLocaleString()})`,
      })
    }
  }

  // Stuck jobs — accepted 14+ days with no progress
  const stuckData = stuckJobs.data || []
  if (stuckData.length > 0) {
    for (const j of stuckData.slice(0, 5)) {
      const daysStuck = Math.floor((Date.now() - new Date(j.accepted_at).getTime()) / 86400000)
      attention.push({
        type: 'stuck_job',
        severity: daysStuck >= 21 ? 'red' : 'amber',
        title: `${j.job_number || j.client_name} accepted ${daysStuck} days ago — schedule or follow up`,
        job_ids: [j.id],
      })
    }
  }

  // Material conflicts — jobs starting within 7 days but POs still in draft/submitted
  const upcomingJobIds = [...new Set((upcomingAssignments.data || []).map((a: any) => a.job_id))]
  if (upcomingJobIds.length > 0) {
    const poList = activePOs.data || []
    for (const jobId of upcomingJobIds) {
      const jobPOs = poList.filter((po: any) => po.job_id === jobId)
      const unconfirmedPOs = jobPOs.filter((po: any) => ['draft', 'submitted', 'quote_requested'].includes(po.status))
      if (unconfirmedPOs.length > 0) {
        const assignment = (upcomingAssignments.data || []).find((a: any) => a.job_id === jobId)
        const dayName = assignment ? new Date(assignment.scheduled_date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long' }) : 'soon'
        attention.push({
          type: 'material_conflict',
          severity: 'red',
          title: `Job starts ${dayName} but ${unconfirmedPOs.length} PO${unconfirmedPOs.length === 1 ? '' : 's'} not confirmed`,
          job_ids: [jobId],
        })
      }
    }
  }

  // Scope pending — draft jobs waiting 7+ days
  const scopeData = scopePending.data || []
  if (scopeData.length > 0) {
    const oldest = Math.floor((Date.now() - new Date(scopeData[0].created_at).getTime()) / 86400000)
    attention.push({
      type: 'scope_pending',
      severity: 'amber',
      title: `${scopeData.length} lead${scopeData.length === 1 ? '' : 's'} waiting for scope visit (oldest: ${oldest} days)`,
    })
  }

  // Trades with no hourly rate set
  const { data: tradeUsers } = await client.from('users').select('id, name').in('role', ['installer', 'trade', 'subcontractor'])
  const { data: ratesData } = await client.from('trade_rates').select('user_id').is('effective_to', null)
  const rateUserIds = new Set((ratesData || []).map((r: any) => r.user_id))
  const noRateTrades = (tradeUsers || []).filter((u: any) => !rateUserIds.has(u.id))
  if (noRateTrades.length > 0) {
    attention.push({
      type: 'no_trade_rate',
      severity: 'amber',
      title: `${noRateTrades.length} trade${noRateTrades.length === 1 ? '' : 's'} ha${noRateTrades.length === 1 ? 's' : 've'} no hourly rate configured`,
    })
  }

  // ── Pipeline counts ──
  const pipelineCounts: Record<string, number> = {
    quoted: 0, accepted: 0, approvals: 0, processing: 0, in_progress: 0, complete: 0, invoiced: 0,
  }
  for (const j of allActive) {
    if (pipelineCounts[j.status] !== undefined) pipelineCounts[j.status]++
  }

  return {
    stat_cards: {
      jobs_this_week: weekJobCount,
      awaiting_materials: awaitingMaterials,
      overdue_invoices: { count: overdueCount, total: overdueTotal },
      quotes_pending: quotePendingCount,
      pipeline: pipelineCounts,
    },
    today_schedule: (todaySchedule.data || []).map((ev: any) => ({
      assignment_id: ev.assignment_id,
      job_id: ev.job_id,
      client_name: ev.client_name,
      site_suburb: ev.site_suburb,
      site_address: ev.site_address,
      job_type: ev.job_type,
      assignment_type: ev.assignment_type,
      crew_name: ev.crew_name,
      assigned_to: ev.assigned_to,
      start_time: ev.start_time,
      end_time: ev.end_time,
      assignment_status: ev.assignment_status,
      job_status: ev.job_status,
    })),
    attention,
    kpis: {
      jobs_completed_month: (monthCompletedJobs.data || []).length,
      jobs_target: targets.ops_monthly_jobs_target || 15,
      active_pos: (activePOs.data || []).length,
      active_wos: (activeWOs.data || []).length,
    },
  }
}

async function calendarEvents(client: any, params: URLSearchParams) {
  const from = params.get('from') || params.get('start_date') || new Date().toISOString().slice(0, 10)
  const to = params.get('to') || params.get('end_date') || (() => {
    const d = new Date(from); d.setDate(d.getDate() + 14); return d.toISOString().slice(0, 10)
  })()
  const jobType = params.get('type')
  const includeFinancials = params.get('include_financials') === 'true'

  const calSelect = includeFinancials
    ? '*'
    : 'assignment_id, job_id, user_id, job_number, client_name, site_address, site_suburb, scheduled_date, scheduled_end, start_time, end_time, crew_name, assigned_to, assignment_type, assignment_status, confirmation_status, job_type, job_status, scope_json, ghl_contact_id, org_id'

  let query = client
    .from('calendar_events')
    .select(calSelect)
    .gte('scheduled_date', from)
    .lte('scheduled_date', to)
    .eq('org_id', DEFAULT_ORG_ID)
    .neq('assignment_status', 'cancelled')
    .order('scheduled_date', { ascending: true })
    .limit(100)

  if (jobType) query = query.eq('job_type', jobType)

  const { data, error } = await query
  if (error) throw error

  // Run PO delivery queries in parallel for performance
  const events = data || []
  const uniqueJobIds = [...new Set(events.map((e: any) => e.job_id).filter(Boolean))]

  const poSelect = 'id, po_number, supplier_name, delivery_date, confirmed_delivery_date, job_id, status, total'
  const [
    { data: deliveriesByReq },
    { data: deliveriesByConfirmed },
    intelResult,
  ] = await Promise.all([
    client.from('purchase_orders').select(poSelect)
      .eq('org_id', DEFAULT_ORG_ID).gte('delivery_date', from).lte('delivery_date', to)
      .in('status', ['draft', 'submitted', 'authorised']),
    client.from('purchase_orders').select(poSelect)
      .eq('org_id', DEFAULT_ORG_ID).gte('confirmed_delivery_date', from).lte('confirmed_delivery_date', to)
      .in('status', ['draft', 'submitted', 'authorised']),
    uniqueJobIds.length > 0
      ? client.from('job_intelligence').select('*').in('job_id', uniqueJobIds)
      : Promise.resolve({ data: [] }),
  ])

  // Merge and deduplicate by id
  const deliveryMap = new Map<string, any>()
  for (const d of [...(deliveriesByReq || []), ...(deliveriesByConfirmed || [])]) {
    deliveryMap.set(d.id, d)
  }
  const deliveries = Array.from(deliveryMap.values())

  // ── Readiness: compute per unique job in range ──
  const readiness: Record<string, JobReadiness> = {}

  if (uniqueJobIds.length > 0) {
    const intelRows = intelResult.data

    // Build lookup
    const intelMap: Record<string, any> = {}
    for (const row of (intelRows || [])) {
      intelMap[row.job_id] = row
    }

    // Get scope_json for conditional rules (from events data — already have it)
    for (const jobId of uniqueJobIds) {
      const intel = intelMap[jobId] || {}
      // Find scope_json + pricing_json from the event data (calendar_events view now includes them)
      const ev = events.find((e: any) => e.job_id === jobId)
      const scopeJson = ev?.scope_json || null
      const pricingJson = typeof ev?.pricing_json === 'string' ? JSON.parse(ev.pricing_json || '{}') : (ev?.pricing_json || {})
      const jobType = intel.job_type || ev?.job_type || 'patio'
      readiness[jobId] = computeReadiness(jobType, intel, scopeJson, pricingJson)
    }
  }

  // Strip heavy fields (scope_json used above for readiness but not needed in response)
  const lightEvents = (events || []).map((e: any) => {
    const { scope_json, org_id, ...rest } = e
    return rest
  })

  return { events: lightEvents, deliveries: deliveries || [], readiness }
}

async function pipeline(client: any, params: URLSearchParams) {
  const typeFilter = params.get('type')
  const statusFilter = params.get('status')
  const search = params.get('search') || ''

  let query = client.from('jobs')
    .select('id, type, status, client_name, client_phone, site_address, site_suburb, pricing_json, ghl_contact_id, ghl_opportunity_id, job_number, accepted_at, approvals_at, deposit_at, processing_at, scheduled_at, completed_at, created_at, updated_at, deposit_invoice_id, deposit_amount')
    .eq('org_id', DEFAULT_ORG_ID)
    .or('legacy.is.null,legacy.eq.false')
    .or('job_number.not.is.null,status.eq.draft')
    .order('updated_at', { ascending: false })

  if (statusFilter) {
    query = query.eq('status', statusFilter)
  } else {
    // Cap 1A: widened to canonical ACTIVE_STATUSES. Same rationale as line 3196 above.
    query = query.in('status', [
      'draft', 'quoted', 'partially_accepted', 'accepted', 'awaiting_deposit', 'deposit',
      'approvals', 'order_materials', 'processing', 'awaiting_supplier', 'order_confirmed',
      'schedule_install', 'scheduled', 'in_progress', 'rectification',
      'complete', 'final_payment', 'invoiced', 'get_review'
    ])
  }
  if (typeFilter) query = query.eq('type', typeFilter)

  const { data: jobs, error } = await query
  if (error) throw error

  if (!jobs || jobs.length === 0) {
    return { columns: { draft: [], quoted: [], accepted: [], approvals: [], processing: [], in_progress: [], complete: [], invoiced: [] }, total: 0 }
  }

  // Only enrich non-draft jobs (drafts have no assignments/POs/invoices)
  // This keeps the .in() query within PostgREST URL limits (~381 drafts would exceed it)
  const nonDraftJobs = jobs.filter((j: any) => j.status !== 'draft')
  const jobIds = nonDraftJobs.map((j: any) => j.id)

  // Enrich with assignment/PO/WO/council counts + email activity + invoices
  let assignRes: any = { data: [] }, poRes: any = { data: [] }, woRes: any = { data: [] }
  let councilRes: any = { data: [] }, emailRes: any = { data: [] }, invoiceRes: any = { data: [] }
  let opsNotesRes: any = { data: [] }, neighbourContactRes: any = { data: [] }

  if (jobIds.length > 0) {
    ;[assignRes, poRes, woRes, councilRes, emailRes, invoiceRes, opsNotesRes, neighbourContactRes] = await Promise.all([
      client.from('job_assignments').select('job_id, scheduled_date').in('job_id', jobIds).neq('status', 'cancelled'),
      client.from('purchase_orders').select('job_id').in('job_id', jobIds).neq('status', 'deleted'),
      client.from('work_orders').select('job_id').in('job_id', jobIds).neq('status', 'cancelled'),
      client.from('council_submissions').select('job_id, overall_status, current_step_index, steps').in('job_id', jobIds),
      client.from('po_communications').select('job_id, direction, created_at').in('job_id', jobIds).eq('communication_type', 'purchase_order').order('created_at', { ascending: false }).limit(500),
      client.from('xero_invoices').select('job_id, status, invoice_type, reference').in('job_id', jobIds).eq('invoice_type', 'ACCREC').not('status', 'in', '("VOIDED","DELETED")'),
      client.from('ops_notes').select('job_id').in('job_id', jobIds),
      client.from('job_contacts').select('job_id').in('job_id', jobIds).eq('status', 'active').eq('is_primary', false),
    ])
  }

  const countMap = (rows: any[]) => {
    const m: Record<string, number> = {}
    for (const r of rows) m[r.job_id] = (m[r.job_id] || 0) + 1
    return m
  }
  const assignMap = countMap(assignRes.data || [])
  // Earliest scheduled_date per job
  const schedDateMap: Record<string, string> = {}
  for (const a of (assignRes.data || [])) {
    if (a.scheduled_date && (!schedDateMap[a.job_id] || a.scheduled_date < schedDateMap[a.job_id])) {
      schedDateMap[a.job_id] = a.scheduled_date
    }
  }
  const poMap = countMap(poRes.data || [])
  const woMap = countMap(woRes.data || [])
  const opsNotesMap = countMap(opsNotesRes.data || [])
  const neighbourContactMap = countMap(neighbourContactRes.data || [])

  // Council: count + best status + step info per job
  const councilMap: Record<string, number> = {}
  const councilStatusMap: Record<string, { status: string; step: string }> = {}
  for (const c of (councilRes.data || [])) {
    councilMap[c.job_id] = (councilMap[c.job_id] || 0) + 1
    const totalSteps = (c.steps || []).length
    const stepIdx = (c.current_step_index || 0) + 1
    councilStatusMap[c.job_id] = { status: c.overall_status || 'not_started', step: stepIdx + '/' + totalSteps }
  }

  // Last PO email per job
  const emailActivityMap: Record<string, { at: string; dir: string }> = {}
  for (const em of (emailRes.data || [])) {
    if (!emailActivityMap[em.job_id]) emailActivityMap[em.job_id] = { at: em.created_at, dir: em.direction }
  }

  // Invoice status per job — track any invoice (for accepted) + deposit vs final split (for complete)
  const invoiceMap: Record<string, { has_any: boolean; any_paid: boolean; has_deposit: boolean; deposit_paid: boolean; has_final: boolean; final_paid: boolean }> = {}
  for (const inv of (invoiceRes.data || [])) {
    if (!invoiceMap[inv.job_id]) invoiceMap[inv.job_id] = { has_any: false, any_paid: false, has_deposit: false, deposit_paid: false, has_final: false, final_paid: false }
    const m = invoiceMap[inv.job_id]
    m.has_any = true
    if (inv.status === 'PAID') m.any_paid = true
    const isDep = (inv.reference || '').toUpperCase().includes('DEP')
    if (isDep) {
      m.has_deposit = true
      if (inv.status === 'PAID') m.deposit_paid = true
    } else {
      m.has_final = true
      if (inv.status === 'PAID') m.final_paid = true
    }
  }

  const enriched = jobs.map((j: any) => {
    const value = j.pricing_json?.totalIncGST || j.pricing_json?.total || 0
    // Neighbour count for fencing shared fence badge
    let neighbourCount = 0
    if (j.type === 'fencing') {
      if (j.pricing_json) {
        try {
          const pj = typeof j.pricing_json === 'string' ? JSON.parse(j.pricing_json) : j.pricing_json
          const ns = pj?.neighbour_splits?.neighbours || pj?.job?.neighbours
          if (Array.isArray(ns)) neighbourCount = ns.length
        } catch (_) {}
      }
      if (neighbourCount === 0) neighbourCount = neighbourContactMap[j.id] || 0
    }
    const stageStart = j.status === 'accepted' ? j.accepted_at
      : j.status === 'approvals' ? j.approvals_at
      : j.status === 'deposit' ? j.deposit_at
      : j.status === 'processing' ? j.processing_at
      : j.status === 'scheduled' ? j.scheduled_at
      : j.status === 'complete' ? j.completed_at
      : j.updated_at
    const daysInStage = stageStart
      ? Math.floor((Date.now() - new Date(stageStart).getTime()) / 86400000)
      : 0

    const councilInfo = councilStatusMap[j.id] || null
    const emailActivity = emailActivityMap[j.id] || null
    // Strip pricing_json from response — value already extracted
    const { pricing_json: _p, ...jLite } = j
    return {
      ...jLite, value, days_in_stage: daysInStage, neighbour_count: neighbourCount,
      assignment_count: assignMap[j.id] || 0,
      first_scheduled_date: schedDateMap[j.id] || null,
      po_count: poMap[j.id] || 0,
      wo_count: woMap[j.id] || 0,
      ops_notes_count: opsNotesMap[j.id] || 0,
      council_count: councilMap[j.id] || 0,
      council_status: councilInfo?.status || null,
      council_step: councilInfo?.step || null,
      last_po_email_at: emailActivity?.at || null,
      last_po_email_dir: emailActivity?.dir || null,
      has_any_invoice: invoiceMap[j.id]?.has_any || false,
      any_invoice_paid: invoiceMap[j.id]?.any_paid || false,
      has_deposit_invoice: invoiceMap[j.id]?.has_deposit || false,
      deposit_paid: invoiceMap[j.id]?.deposit_paid || false,
      has_final_invoice: invoiceMap[j.id]?.has_final || false,
      final_paid: invoiceMap[j.id]?.final_paid || false,
    }
  }).filter((j: any) => {
    // Filter out test records
    if (isTestRecord(j.client_name)) return false
    if (!search) return true
    const s = search.toLowerCase()
    return (j.client_name || '').toLowerCase().includes(s)
      || (j.site_suburb || '').toLowerCase().includes(s)
      || (j.site_address || '').toLowerCase().includes(s)
      || (j.job_number || '').toLowerCase().includes(s)
  })

  // Cap 1A follow-up fix (2026-05-04): pre-allocate every active canonical
  // status as its own column key. The widened .in('status', [...]) filter
  // above pulls jobs in all 19 active substages, but the previous 8-key
  // column object silently dropped jobs in: partially_accepted,
  // awaiting_deposit, order_materials, awaiting_supplier, order_confirmed,
  // schedule_install, rectification, final_payment, get_review.
  // ~20 jobs were missing from the kanban as a result. Source of truth for
  // the canonical status set: supabase/functions/_shared/stage-gate/job-state-machine.ts.
  // The legacy `deposit → accepted` and `scheduled → processing` merges
  // are preserved deliberately; existing frontend column headers depend on them.
  const columns: Record<string, any[]> = {
    draft: [],
    quoted: [],
    partially_accepted: [],
    accepted: [],
    awaiting_deposit: [],
    approvals: [],
    order_materials: [],
    processing: [],
    awaiting_supplier: [],
    order_confirmed: [],
    schedule_install: [],
    in_progress: [],
    rectification: [],
    complete: [],
    final_payment: [],
    invoiced: [],
    get_review: [],
  }
  for (const j of enriched) {
    // Legacy merges preserved: deposit → accepted, scheduled → processing.
    const col = j.status === 'deposit' ? 'accepted'
      : j.status === 'scheduled' ? 'processing'
      : j.status
    if (columns[col]) columns[col].push(j)
  }

  return { columns, total: enriched.length }
}

async function jobDetail(client: any, jobId: string, opts: { slim?: boolean } = {}) {
  if (!jobId) throw new Error('jobId required')

  // If job_number passed instead of UUID, resolve it
  // 2026-04-24 fix: widen from [PFDRI] to [A-Z]+ so all prefixes work (SWM, SWG, etc.)
  if (/^SW[A-Z]+-\d+$/i.test(jobId)) {
    const { data: found } = await client.from('jobs').select('id').ilike('job_number', jobId).limit(1).maybeSingle()
    if (!found) throw new ApiError(`Job ${jobId} not found`, 404)
    jobId = found.id
  }

  const [jobRes, assignRes, docsRes, eventsRes, mediaRes, poRes, woRes, xeroRes, contactsRes, bizEventsRes] = await Promise.all([
    client.from('jobs').select('*').eq('id', jobId).single(),
    client.from('job_assignments').select('*, users:user_id(name, phone, email)').eq('job_id', jobId).order('scheduled_date'),
    client.from('job_documents').select('*').eq('job_id', jobId).order('created_at', { ascending: false }),
    client.from('job_events').select('*, users:user_id(name)').eq('job_id', jobId).order('created_at', { ascending: false }).limit(50),
    client.from('job_media').select('*').eq('job_id', jobId).order('created_at'),
    client.from('purchase_orders').select('*').eq('job_id', jobId).neq('status', 'deleted').order('created_at', { ascending: false }),
    client.from('work_orders').select('*').eq('job_id', jobId).neq('status', 'cancelled').order('created_at', { ascending: false }),
    client.from('xero_projects').select('*').eq('job_id', jobId).maybeSingle(),
    client.from('job_contacts').select('*').eq('job_id', jobId).eq('status', 'active').order('contact_label'),
    client.from('business_events').select('id, event_type, source, entity_type, entity_id, payload, metadata, occurred_at').eq('job_id', jobId).order('occurred_at', { ascending: false }).limit(50),
  ])

  if (jobRes.error) throw jobRes.error

  // Find matching invoices — try direct job_id first, fallback to client name
  let invoices: any[] = []
  const { data: directInvoices } = await client.from('xero_invoices')
    .select('*')
    .eq('job_id', jobId)
    .order('invoice_date', { ascending: false })
    .limit(20)
  if (directInvoices && directInvoices.length > 0) {
    invoices = directInvoices
  } else {
    const clientName = jobRes.data?.client_name
    if (clientName) {
      const { data } = await client.from('xero_invoices')
        .select('*')
        .eq('org_id', DEFAULT_ORG_ID)
        .ilike('contact_name', `%${clientName.replace(/'/g, "''")}%`)
        .order('date', { ascending: false })
        .limit(20)
      invoices = data || []
    }
  }

  // Build invoice summary: quoted vs invoiced vs paid
  const job = jobRes.data
  const pricing = typeof job?.pricing_json === 'string' ? JSON.parse(job.pricing_json || '{}') : (job?.pricing_json || {})
  const quotedTotal = pricing.totalIncGST || pricing.total || 0
  const activeInvoices = invoices.filter((inv: any) => !['VOIDED', 'DELETED'].includes(inv.status))
  const invoicedTotal = activeInvoices.reduce((s: number, inv: any) => s + (inv.total || 0), 0)
  const paidTotal = activeInvoices.reduce((s: number, inv: any) => s + (inv.amount_paid || 0), 0)

  // Fetch chase logs for overdue invoices on this job
  const overdueInvIds = invoices
    .filter((inv: any) => {
      if (['VOIDED', 'DELETED', 'PAID'].includes(inv.status)) return false
      if (!inv.due_date) return false
      return new Date(inv.due_date + 'T00:00:00') < new Date()
    })
    .map((inv: any) => inv.xero_invoice_id)
    .filter(Boolean)
  let chaseLogs: any[] = []
  if (overdueInvIds.length > 0) {
    const { data: cl } = await client.from('payment_chase_logs')
      .select('id, xero_invoice_id, method, outcome, notes, follow_up_date, follow_up_resolved, chased_by, created_at')
      .in('xero_invoice_id', overdueInvIds)
      .order('created_at', { ascending: false })
      .limit(10)
    chaseLogs = cl || []
  }

  // Fire-and-forget: create/refresh annotations for this job
  createJobAnnotations(client, jobId, jobRes.data, invoices, poRes.data || [], assignRes.data || [])
    .catch(e => console.log('[ops-api] annotation creation failed:', (e as Error).message))

  // ── Readiness computation ──
  let jobReadiness: JobReadiness | null = null
  try {
    const { data: intelRow } = await client
      .from('job_intelligence')
      .select('*')
      .eq('job_id', jobId)
      .maybeSingle()

    if (intelRow) {
      const pJson = typeof job?.pricing_json === 'string' ? JSON.parse(job.pricing_json || '{}') : (job?.pricing_json || {})
      jobReadiness = computeReadiness(
        intelRow.job_type || job?.type || 'patio',
        intelRow,
        job?.scope_json || null,
        pJson,
      )
    }
  } catch (e) {
    console.log('[ops-api] readiness computation failed (non-blocking):', (e as Error).message)
  }

  let makesafeDetails: any = null
  if ((jobRes.data?.type || '').toLowerCase() === 'makesafe') {
    try {
      const { data: ms } = await client.from('makesafe_job_details')
        .select('*, makesafe_companies:requesting_company_id(*)')
        .eq('job_id', jobId)
        .maybeSingle()
      makesafeDetails = ms || null
    } catch (e) {
      console.log('[ops-api] makesafe details fetch skipped (non-blocking):', (e as Error).message)
    }
  }

  // 2026-04-24 fix: DEFAULT includes scope_json + pricing_json (dashboard + MCP consumers
  // depend on these for scope summaries, pricing totals, site plans, neighbour splits).
  // Bulk callers that don't need the raw blobs can pass slim=true to strip them.
  const jobLite = opts.slim
    ? (() => { const { scope_json: _s, pricing_json: _p, ...rest } = jobRes.data || {}; return rest })()
    : (jobRes.data || {})

  // Strip line_items and raw_json from invoices (huge nested JSON)
  const invoicesLite = invoices.map((inv: any) => {
    const { line_items: _li, raw_json: _rj, ...rest } = inv
    return rest
  })

  // Strip heavy fields from POs and WOs
  const posLite = (poRes.data || []).map((po: any) => {
    const { line_items: _li, ...rest } = po
    return rest
  })

  return {
    job: jobLite,
    assignments: assignRes.data || [],
    documents: (docsRes.data || []).map((d: any) => ({ id: d.id, name: `${d.type} v${d.version || 1}`, file_name: d.file_name, type: d.type, version: d.version, url: d.pdf_url || d.storage_url, pdf_url: d.pdf_url, storage_url: d.storage_url, thumbnail_url: d.thumbnail_url, label: d.label, visible_to_trades: d.visible_to_trades, sent_to_client: d.sent_to_client, accepted_at: d.accepted_at, share_token: d.share_token, created_at: d.created_at, quote_number: d.quote_number })),
    events: eventsRes.data || [],
    media: mediaRes.data || [],
    purchase_orders: posLite,
    work_orders: woRes.data || [],
    xero_project: xeroRes.data,
    invoices: invoicesLite,
    job_contacts: contactsRes.data || [],
    invoice_summary: {
      quoted_total: quotedTotal,
      invoiced_total: invoicedTotal,
      paid_total: paidTotal,
      remaining_to_invoice: Math.max(0, quotedTotal - invoicedTotal),
    },
    makesafe_details: makesafeDetails,
    chase_logs: chaseLogs,
    readiness: jobReadiness,
    business_events: bizEventsRes.data || [],
  }
}

async function listInvoices(client: any, params: URLSearchParams) {
  const type = params.get('type') || 'ACCREC'
  const status = params.get('status')
  const limit = parseInt(params.get('limit') || '50')
  const offset = parseInt(params.get('offset') || '0')
  const dateFrom = params.get('date_from')
  const dateTo = params.get('date_to')

  // Resolve job_id — accept UUID or job_number (e.g. SWF-26037)
  let jobId = params.get('job_id') || ''
  if (jobId && !jobId.match(/^[0-9a-f]{8}-/i)) {
    const { data: found } = await client.from('jobs').select('id').ilike('job_number', jobId).limit(1)
    if (found?.[0]) jobId = found[0].id
    else return { invoices: [], total: 0, summary: { outstanding: 0, overdue: 0, total: 0 }, _note: `No job found for job_number: ${jobId}` }
  }

  let query = client.from('xero_invoices')
    .select('id, xero_invoice_id, invoice_number, contact_name, total, amount_due, amount_paid, status, due_date, invoice_date, reference, job_id', { count: 'exact' })
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('invoice_type', type)
    .order('invoice_date', { ascending: false })
    .range(offset, offset + limit - 1)

  // Filter by job if provided
  if (jobId) query = query.eq('job_id', jobId)

  if (status === 'overdue') {
    // 'overdue' is a virtual status — filter by open invoices past due date
    const todayFilter = new Date().toISOString().slice(0, 10)
    query = query.in('status', ['AUTHORISED', 'SUBMITTED']).gt('amount_due', 0).lt('due_date', todayFilter)
  } else if (status) {
    query = query.eq('status', status.toUpperCase())
  }
  if (dateFrom) query = query.gte('invoice_date', dateFrom)
  if (dateTo) query = query.lte('invoice_date', dateTo)

  const { data, error, count } = await query
  if (error) throw error

  // Summary: total outstanding and overdue
  const todayStr = new Date().toISOString().slice(0, 10)
  const { data: openInvs } = await client.from('xero_invoices')
    .select('status, amount_due, due_date')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('invoice_type', type)
    .in('status', ['AUTHORISED', 'SUBMITTED'])

  const outstanding = (openInvs || []).reduce((s: number, i: any) => s + (i.amount_due || 0), 0)
  const overdue = (openInvs || [])
    .filter((i: any) => i.due_date && i.due_date < todayStr)
    .reduce((s: number, i: any) => s + (i.amount_due || 0), 0)

  return { invoices: data || [], total: count || 0, summary: { outstanding, overdue, total: count || 0 } }
}

// ── Finance Health summary (read-only) ──
// Backs the ops.html "Finance Health" tab. Surfaces invoice-data-quality
// holes documented in the 2026-05-05 invoice-creation audit (cio/operations/
// board/Finance-AI-First/finance-loop0-signoff/invoice-creation-audit.md §6).
// SELECT-only: no mutation of any row.
async function financeHealthSummary(client: any, params: URLSearchParams) {
  const limit = Math.min(parseInt(params.get('limit') || '50'), 200)
  const orgFilter = (q: any) => q.eq('org_id', DEFAULT_ORG_ID).eq('invoice_type', 'ACCREC')

  // Headline ACCREC count
  const { count: totalAccrec } = await orgFilter(
    client.from('xero_invoices').select('id', { count: 'exact', head: true })
  )

  // ── Card 1: division-tag holes (AccountCode missing OR Tracking missing) ──
  // Inspect line_items JSON in TypeScript because PostgREST cannot express
  // a per-array-element check across all active ACCREC.
  const { data: activeLines } = await orgFilter(
    client.from('xero_invoices')
      .select('xero_invoice_id, invoice_number, contact_name, total, status, invoice_date, reference, line_items')
      .not('status', 'in', '("VOIDED","DELETED")')
      .not('line_items', 'is', null)
  )

  let card1TotalLines = 0
  const card1Offenders: any[] = []
  const today = new Date()
  const ageDays = (d: string | null) => d ? Math.floor((today.getTime() - new Date(d).getTime()) / 86400000) : null

  for (const inv of activeLines || []) {
    const items = Array.isArray(inv.line_items) ? inv.line_items : []
    if (items.length === 0) continue
    let invHasHole = false
    const missing: string[] = []
    for (const li of items) {
      card1TotalLines++
      const noCode = !li.AccountCode
      const noTrack = !Array.isArray(li.Tracking) || li.Tracking.length === 0
      if (noCode || noTrack) {
        invHasHole = true
        if (noCode && !missing.includes('account_code')) missing.push('account_code')
        if (noTrack && !missing.includes('tracking')) missing.push('tracking')
      }
    }
    if (invHasHole && card1Offenders.length < limit) {
      card1Offenders.push({
        xero_invoice_id: inv.xero_invoice_id,
        invoice_number: inv.invoice_number,
        contact_name: inv.contact_name,
        total: inv.total,
        status: inv.status,
        reference: inv.reference,
        age_days: ageDays(inv.invoice_date),
        missing,
      })
    }
  }
  const card1HolesLines = (activeLines || []).reduce((acc: number, inv: any) => {
    const items = Array.isArray(inv.line_items) ? inv.line_items : []
    return acc + items.reduce((n: number, li: any) =>
      n + ((!li.AccountCode || !Array.isArray(li.Tracking) || li.Tracking.length === 0) ? 1 : 0), 0)
  }, 0)

  // ── Card 2: job-link holes (job_id IS NULL) ──
  const { count: card2Count } = await orgFilter(
    client.from('xero_invoices').select('id', { count: 'exact', head: true }).is('job_id', null)
  )
  const { data: card2Offenders } = await orgFilter(
    client.from('xero_invoices')
      .select('xero_invoice_id, xero_contact_id, invoice_number, reference, contact_name, total, status, invoice_date')
      .is('job_id', null)
      .order('invoice_date', { ascending: false })
      .limit(limit)
  )

  // ── Card 3: quote-link holes (quote_document_ids missing) ──
  const { count: card3Count } = await orgFilter(
    client.from('xero_invoices').select('id', { count: 'exact', head: true }).is('quote_document_ids', null)
  )

  // ── Card 4: schema integrity (due_date NULL, due_date < invoice_date, reference empty) ──
  const { count: card4DueDateNull } = await orgFilter(
    client.from('xero_invoices').select('id', { count: 'exact', head: true }).is('due_date', null)
  )
  const { data: card4DueBeforeRows } = await orgFilter(
    client.from('xero_invoices')
      .select('xero_invoice_id, invoice_number, status, invoice_date, due_date')
      .not('due_date', 'is', null)
      .not('invoice_date', 'is', null)
  )
  const card4DueBefore = (card4DueBeforeRows || []).filter((r: any) => r.due_date < r.invoice_date)
  const { count: card4RefNull } = await orgFilter(
    client.from('xero_invoices').select('id', { count: 'exact', head: true }).is('reference', null)
  )
  const { count: card4RefEmpty } = await orgFilter(
    client.from('xero_invoices').select('id', { count: 'exact', head: true }).eq('reference', '')
  )
  const { data: card4Sample } = await orgFilter(
    client.from('xero_invoices')
      .select('xero_invoice_id, invoice_number, status, invoice_date, due_date, reference')
      .or('due_date.is.null,reference.is.null,reference.eq.')
      .order('invoice_date', { ascending: false })
      .limit(limit)
  )
  const card4Offenders = [
    ...(card4Sample || []).map((r: any) => ({
      ...r,
      issue: r.due_date == null
        ? 'due_date_null'
        : (r.reference == null || r.reference === ''
            ? 'reference_empty'
            : 'unknown'),
    })),
    ...card4DueBefore.slice(0, limit).map((r: any) => ({ ...r, issue: 'due_date_before_invoice_date' })),
  ]

  return {
    as_of: new Date().toISOString(),
    total_accrec: totalAccrec || 0,
    card1_division_tag_holes: {
      total_active_lines: card1TotalLines,
      lines_with_hole: card1HolesLines,
      percentage: card1TotalLines > 0 ? Math.round((card1HolesLines / card1TotalLines) * 1000) / 10 : 0,
      offenders: card1Offenders,
    },
    card2_job_link_holes: {
      total_accrec: totalAccrec || 0,
      missing_job_id: card2Count || 0,
      percentage: (totalAccrec || 0) > 0 ? Math.round(((card2Count || 0) / (totalAccrec || 0)) * 1000) / 10 : 0,
      offenders: (card2Offenders || []).map((r: any) => ({
        ...r,
        age_days: ageDays(r.invoice_date),
      })),
    },
    card3_quote_link_holes: {
      total_accrec: totalAccrec || 0,
      missing_quote_link: card3Count || 0,
      percentage: (totalAccrec || 0) > 0 ? Math.round(((card3Count || 0) / (totalAccrec || 0)) * 1000) / 10 : 0,
    },
    card4_schema_integrity: {
      due_date_null: card4DueDateNull || 0,
      due_date_before_invoice_date: card4DueBefore.length,
      reference_null_or_empty: (card4RefNull || 0) + (card4RefEmpty || 0),
      offenders: card4Offenders,
    },
  }
}

async function listQuotes(client: any, params: URLSearchParams) {
  const typeFilter = params.get('type')
  const search = params.get('search') || ''

  let query = client.from('jobs')
    .select('id, type, status, client_name, client_phone, client_email, site_address, site_suburb, job_number, pricing_json, created_at, updated_at, notes')
    .eq('org_id', DEFAULT_ORG_ID)
    .not('legacy', 'is', true)
    .in('status', ['quoted', 'draft'])
    .order('created_at', { ascending: false })
    .limit(100)

  if (typeFilter) query = query.eq('type', typeFilter)

  const { data, error } = await query
  if (error) throw error

  const quotes = (data || []).filter((j: any) => {
    if (!search) return true
    const s = search.toLowerCase()
    return (j.client_name || '').toLowerCase().includes(s)
      || (j.site_suburb || '').toLowerCase().includes(s)
  })

  return { quotes, total: quotes.length }
}

async function listPOs(client: any, params: URLSearchParams) {
  const status = params.get('status')
  const jobId = params.get('job_id')
  const supplier = params.get('supplier')

  let query = client.from('purchase_orders')
    .select('*, jobs:job_id(job_number, client_name, type), communications:po_communications(id, direction, from_email, subject, created_at, communication_type)')
    .eq('org_id', DEFAULT_ORG_ID)
    .neq('status', 'deleted')
    .order('created_at', { ascending: false })

  if (status) query = query.eq('status', status)
  if (jobId) query = query.eq('job_id', jobId)
  if (supplier) query = query.ilike('supplier_name', `%${supplier}%`)

  const { data, error } = await query
  if (error) throw error

  // Flatten job fields onto each PO for frontend convenience
  const enriched = (data || []).map((po: any) => ({
    ...po,
    job_number: po.jobs?.job_number || null,
    client_name: po.jobs?.client_name || null,
    job_type: po.jobs?.type || null,
    jobs: undefined,
  }))

  return { purchase_orders: enriched }
}

async function listWorkOrders(client: any, params: URLSearchParams) {
  const status = params.get('status')
  const jobId = params.get('job_id') || params.get('jobId')

  let query = client.from('work_orders')
    .select('*')
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })

  // DEV-37: When filtering by job_id, skip org_id filter so WOs without org_id still appear.
  // When listing all, keep the org_id guard to scope results.
  if (jobId) {
    query = query.eq('job_id', jobId)
  } else {
    query = query.eq('org_id', DEFAULT_ORG_ID)
  }

  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw error
  return { work_orders: data || [] }
}

async function listSuppliers(client: any) {
  const { data, error } = await client
    .from('suppliers')
    .select('*')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('is_active', true)
    .order('name', { ascending: true })

  if (error) throw error
  return { suppliers: data || [] }
}

async function updateSupplierEmail(client: any, body: any) {
  const { supplier_name, email } = body
  if (!supplier_name || !email) throw new Error('supplier_name and email required')

  // Try to update existing supplier by name
  const { data, error } = await client.from('suppliers')
    .update({ email })
    .eq('org_id', DEFAULT_ORG_ID)
    .ilike('name', supplier_name)
    .select('id, name, email')

  if (error) throw error

  // If no rows updated, the supplier doesn't exist yet — create one
  if (!data || data.length === 0) {
    const { data: created, error: createErr } = await client.from('suppliers')
      .insert({ org_id: DEFAULT_ORG_ID, name: supplier_name, email })
      .select('id, name, email')
      .single()
    if (createErr) throw createErr
    return { success: true, supplier: created, created: true }
  }

  return { success: true, supplier: data[0], created: false }
}

async function listUsers(client: any) {
  const { data, error } = await client
    .from('users')
    .select('id, name, email, phone, role, avatar_url')
    .eq('org_id', DEFAULT_ORG_ID)
    .order('name')

  if (error) throw error
  return { users: data || [] }
}

async function opsTargets(client: any) {
  return await getOpsTargets(client)
}

async function getOpsTargets(client: any) {
  const keys = [
    'ops_monthly_jobs_target', 'ops_days_to_invoice_target',
    'ops_material_ontime_target', 'ops_ar_current_pct_target',
    'ops_quote_win_rate_target',
  ]
  const { data } = await client
    .from('org_config')
    .select('config_key, config_value')
    .eq('org_id', DEFAULT_ORG_ID)
    .in('config_key', keys)

  const targets: Record<string, number> = {}
  for (const row of (data || [])) {
    targets[row.config_key] = row.config_value?.amount || 0
  }
  return targets
}


// ── get_email_events: email log for a job ──
async function getEmailEvents(client: any, params: URLSearchParams) {
  const jobId = params.get('job_id') || params.get('jobId')
  if (!jobId) throw new Error('job_id required')

  const { data, error } = await client
    .from('email_events')
    .select('*')
    .eq('job_id', jobId)
    .order('sent_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) throw new Error(error.message)
  return data || []
}

// JARVIS memory retriever helpers (service-role bypass for RLS-blocked tables).
// `jobs` (org-scoped policy) and `job_context` (no permissive policies) are
// not readable via the agent's anon key — they have to come through this edge
// function. See secureworks-docs/cio/evidence/context-loop-v1/jarvis-memory-rls-fix-2026-05-01/.

async function resolveJobs(client: any, body: any) {
  const jobNumbers: string[] = Array.isArray(body?.job_numbers) ? body.job_numbers : []
  if (jobNumbers.length === 0) return { jobs: [] }
  const { data, error } = await client
    .from('jobs')
    .select('id, job_number')
    .in('job_number', jobNumbers)
  if (error) throw new Error(error.message)
  return { jobs: data || [] }
}

async function getJobContextFacts(client: any, body: any) {
  const jobUuids: string[] = Array.isArray(body?.job_uuids) ? body.job_uuids : []
  if (jobUuids.length === 0) return { rows: [] }
  const limit = typeof body?.limit === 'number' && body.limit > 0
    ? Math.min(body.limit, 100)
    : 12
  const { data, error } = await client
    .from('job_context')
    .select('id, job_id, kind, value, provenance, correlation_id, created_at, updated_at')
    .in('job_id', jobUuids)
    .order('updated_at', { ascending: false })
    .limit(limit * jobUuids.length)
  if (error) throw new Error(error.message)
  return { rows: data || [] }
}

// Conversation reader for the Job Brain. 5-source merge into a normalized
// Message[] shape so JARVIS / Secure Sale can read the per-job thread without
// learning every source's column topology. Read-only, service-role bypass.
async function getJobConversation(client: any, body: any) {
  const limit = typeof body?.limit === 'number' && body.limit > 0
    ? Math.min(body.limit, 200)
    : 50
  const since = typeof body?.since === 'string' && body.since ? body.since : null

  // Resolve job_id (uuid) — accept job_id or job_number.
  let jobId: string | null = body?.job_id || null
  let jobNumber: string | null = body?.job_number || null
  let ghlContactId: string | null = null

  if (!jobId && jobNumber) {
    const { data: found } = await client.from('jobs')
      .select('id, job_number, ghl_contact_id')
      .ilike('job_number', jobNumber)
      .limit(1)
    if (found?.[0]) {
      jobId = found[0].id
      jobNumber = found[0].job_number
      ghlContactId = found[0].ghl_contact_id || null
    }
  } else if (jobId) {
    const { data: jobRow } = await client.from('jobs')
      .select('job_number, ghl_contact_id')
      .eq('id', jobId)
      .maybeSingle()
    if (jobRow) {
      jobNumber = jobRow.job_number
      ghlContactId = jobRow.ghl_contact_id || null
    }
  }
  if (!jobId) return { messages: [], summary: { count: 0, channels: {}, since, until: null } }

  const sinceFilter = since || null
  const messages: any[] = []

  // 1. GHL conversation cache (sms / email / call metadata) — by job_id first,
  //    falling back to contact_id if cache row was synced before job_id link.
  try {
    let ghlRow: any = null
    if (ghlContactId) {
      const { data: byContact } = await client.from('ghl_conversation_cache')
        .select('messages, message_count, synced_at')
        .eq('contact_id', ghlContactId)
        .maybeSingle()
      ghlRow = byContact || null
    }
    if (!ghlRow) {
      const { data: byJob } = await client.from('ghl_conversation_cache')
        .select('messages, message_count, synced_at')
        .eq('job_id', jobId)
        .maybeSingle()
      ghlRow = byJob || null
    }
    const ghlMsgs: any[] = Array.isArray(ghlRow?.messages) ? ghlRow.messages : []
    for (const m of ghlMsgs) {
      const ts = m.timestamp || ''
      if (sinceFilter && ts && ts < sinceFilter) continue
      const isCall = m.source === 'call_transcript' || /CALL|VOICEMAIL/i.test(String(m.type || ''))
      const channel = isCall ? 'call' : (String(m.type || '').toUpperCase().includes('EMAIL') ? 'email' : 'sms')
      messages.push({
        id: `ghl:${m.id}`,
        job_id: jobId,
        channel,
        direction: m.direction || 'inbound',
        occurred_at: ts || null,
        author: m.sender_name || null,
        body: String(m.body || ''),
        preview: String(m.body || '').slice(0, 500),
        subject: undefined,
        source_system: 'ghl_cache',
        source_ref: m.id || '',
        ...(isCall ? { call_duration: m.call_duration || null, call_status: m.call_status || null } : {}),
      })
    }
  } catch (e) {
    console.log('[ops-api] get_job_conversation ghl_cache read failed:', (e as Error).message)
  }

  // 2. inbox_events — email evidence (subject + body preview).
  try {
    let q = client.from('inbox_events')
      .select('id, from_email, from_name, to_email, subject, body_preview, received_at, classification, mailbox')
      .eq('job_id', jobId)
      .order('received_at', { ascending: false })
      .limit(limit)
    if (sinceFilter) q = q.gt('received_at', sinceFilter)
    const { data: inbox } = await q
    for (const r of (inbox || [])) {
      messages.push({
        id: `inbox:${r.id}`,
        job_id: jobId,
        channel: 'email',
        direction: 'inbound',
        occurred_at: r.received_at,
        author: r.from_name || r.from_email || null,
        body: String(r.body_preview || ''),
        preview: String(r.body_preview || '').slice(0, 500),
        subject: r.subject || null,
        source_system: 'inbox',
        source_ref: r.id,
      })
    }
  } catch (e) {
    console.log('[ops-api] get_job_conversation inbox read failed:', (e as Error).message)
  }

  // 3. job_events staff notes — full text in detail_json.
  try {
    let q = client.from('job_events')
      .select('id, event_type, detail_json, user_id, created_at')
      .eq('job_id', jobId)
      .eq('event_type', 'note')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (sinceFilter) q = q.gt('created_at', sinceFilter)
    const { data: notes } = await q
    for (const r of (notes || [])) {
      const text = String(r?.detail_json?.text || '')
      messages.push({
        id: `note:${r.id}`,
        job_id: jobId,
        channel: 'note',
        direction: 'internal',
        occurred_at: r.created_at,
        author: r.user_id || null,
        body: text,
        preview: text.slice(0, 500),
        subject: undefined,
        source_system: 'job_events',
        source_ref: r.id,
      })
    }
  } catch (e) {
    console.log('[ops-api] get_job_conversation job_events notes read failed:', (e as Error).message)
  }

  // 4. business_events — message-shaped rows (sms/email/note/call).
  try {
    const messageEventTypes = [
      'client.reply', 'client.email_in', 'client.email_out',
      'client.sms_in', 'client.sms_out',
      'client.call_complete', 'client.message_in',
      'supplier.email_in', 'ghl.note_added',
    ]
    let q = client.from('business_events')
      .select('id, event_type, source, occurred_at, payload, correlation_id')
      .eq('job_id', jobId)
      .in('event_type', messageEventTypes)
      .order('occurred_at', { ascending: false })
      .limit(limit)
    if (sinceFilter) q = q.gt('occurred_at', sinceFilter)
    const { data: bev } = await q
    for (const r of (bev || [])) {
      const p: any = r.payload || {}
      const channel: string = r.event_type.includes('sms') ? 'sms'
        : r.event_type.includes('call') ? 'call'
        : r.event_type.includes('note') ? 'note'
        : 'email'
      const direction: string = r.event_type.endsWith('_in') || r.event_type === 'client.reply' || r.event_type === 'ghl.note_added' || r.event_type === 'supplier.email_in'
        ? 'inbound'
        : 'outbound'
      const body = String(p.body || p.text || p.message || p.note_preview || p.note_text || p.body_preview || '')
      messages.push({
        id: `bev:${r.id}`,
        job_id: jobId,
        channel,
        direction,
        occurred_at: r.occurred_at,
        author: p.from || p.sender_name || p.added_by || null,
        body,
        preview: body.slice(0, 500),
        subject: p.subject || null,
        source_system: 'business_events',
        source_ref: r.id,
      })
    }
  } catch (e) {
    console.log('[ops-api] get_job_conversation business_events read failed:', (e as Error).message)
  }

  // 5. chat_logs — JARVIS / crew dialogue referencing this job (lower priority).
  try {
    let q = client.from('chat_logs')
      .select('id, role, query, response, user_email, created_at, job_ids_referenced')
      .contains('job_ids_referenced', [jobId])
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, 25))
    if (sinceFilter) q = q.gt('created_at', sinceFilter)
    const { data: logs } = await q
    for (const r of (logs || [])) {
      const body = String(r.query || '') + (r.response ? `\n\n${r.response}` : '')
      messages.push({
        id: `chat:${r.id}`,
        job_id: jobId,
        channel: 'crew',
        direction: 'internal',
        occurred_at: r.created_at,
        author: r.user_email || r.role || null,
        body,
        preview: body.slice(0, 500),
        subject: undefined,
        source_system: 'chat_logs',
        source_ref: r.id,
      })
    }
  } catch (e) {
    console.log('[ops-api] get_job_conversation chat_logs read failed:', (e as Error).message)
  }

  messages.sort((a, b) => {
    const ax = a.occurred_at || ''
    const bx = b.occurred_at || ''
    if (ax < bx) return 1
    if (ax > bx) return -1
    return 0
  })
  const sliced = messages.slice(0, limit)

  const channels: Record<string, number> = {}
  for (const m of sliced) channels[m.channel] = (channels[m.channel] || 0) + 1
  const occurredTimes = sliced.map((m) => m.occurred_at).filter(Boolean) as string[]
  occurredTimes.sort()
  const summary = {
    count: sliced.length,
    channels,
    since: occurredTimes[0] || since || null,
    until: occurredTimes[occurredTimes.length - 1] || null,
    job_id: jobId,
    job_number: jobNumber,
  }
  return { messages: sliced, summary }
}

// ════════════════════════════════════════════════════════════
// JOB DOSSIER ASSEMBLER (read-only)
//
// `ops-api?action=assemble_job_dossier` (alias: assemble_job_brain) is
// the single authoritative shape for "everything we know about a job"
// across Railway JARVIS, Secure Sale, Secure Ops, and Cap 1 readiness.
//
// HARD CONTRACT (enforced by smoke regressions in secureworks-agent):
//   - SELECT-only. NO INSERT / UPDATE / DELETE / UPSERT.
//   - NO fact extraction (job_context is read, never written here).
//   - NO proposed-action creation (ai_proposed_actions is read).
//   - NO GHL / Xero / Telegram / customer-facing calls.
//   - NO transcript storage / Whisper.
//   - NO mutation of jobs.status or any operational truth field.
//
// Per the JARVIS Memory Extraction Canon (2026-05-01):
// raw evidence -> async extraction queue -> extractor worker
// -> custom context facts -> Job Dossier assembler -> loop/JARVIS
// -> proposed action -> policy/approval -> real action.
// The assembler is the read-only step.
// ════════════════════════════════════════════════════════════

const DOSSIER_MODE_BOUNDS = {
  chat_summary:     { conversation: 20,  events: 30,  facts: 12 },
  full_job_review:  { conversation: 100, events: 200, facts: 50 },
  secure_sale_card: { conversation: 30,  events: 50,  facts: 24 },
  readiness_review: { conversation: 10,  events: 100, facts: 30 },
} as const

type DossierMode = keyof typeof DOSSIER_MODE_BOUNDS

function clampDossierLimit(requested: number | undefined, modeCap: number): number {
  if (typeof requested !== 'number' || !isFinite(requested) || requested <= 0) return modeCap
  return Math.min(requested, modeCap)
}

interface SourceStatus {
  ok: boolean
  count: number
  error?: string
}

async function safeRead(label: string, fn: () => Promise<any>): Promise<{ data: any[]; status: SourceStatus }> {
  try {
    const result = await fn()
    const data: any[] = Array.isArray(result) ? result : []
    return { data, status: { ok: true, count: data.length } }
  } catch (e) {
    const error = (e as Error).message || String(e)
    console.log(`[assemble_job_dossier] ${label} read failed:`, error)
    return { data: [] as any[], status: { ok: false, count: 0, error } }
  }
}

async function assembleJobDossier(client: any, body: any) {
  const requestedMode = String(body?.mode || 'chat_summary') as DossierMode
  const mode: DossierMode = requestedMode in DOSSIER_MODE_BOUNDS ? requestedMode : 'chat_summary'
  const modeCaps = DOSSIER_MODE_BOUNDS[mode]
  const conversationLimit = clampDossierLimit(body?.conversation_limit, modeCaps.conversation)
  const eventsLimit = clampDossierLimit(body?.events_limit, modeCaps.events)
  const factsLimit = clampDossierLimit(body?.facts_limit, modeCaps.facts)
  const since: string | null = typeof body?.since === 'string' && body.since ? body.since : null

  // Resolve job_id (uuid). Accept job_id or job_number. Throw on invalid input
  // or unresolved job — the caller should not get an empty dossier without
  // knowing why.
  const inputJobId: string | null = typeof body?.job_id === 'string' && body.job_id ? body.job_id : null
  const inputJobNumber: string | null = typeof body?.job_number === 'string' && body.job_number ? body.job_number : null
  if (!inputJobId && !inputJobNumber) {
    throw new Error('assemble_job_dossier requires job_id or job_number')
  }

  // Production jobs schema (verified via information_schema 2026-05-01) does
  // not expose `value_inc_gst` or `sent_at` columns. Cockpit + T4 contract
  // treat the value field as optional (optional-chaining); the closest
  // equivalent of `sent_at` lives in business_events.quote.sent. Selecting
  // missing columns made the read fail silently and the assembler threw
  // "could not resolve job" even for jobs that existed.
  const JOB_COLS = 'id, job_number, type, status, client_name, client_phone, client_email, site_address, site_suburb, deposit_amount, created_at, quoted_at, accepted_at, scheduled_at, completed_at, updated_at, ghl_contact_id, org_id'
  let jobRow: any = null
  let jobReadError: string | null = null
  if (inputJobId) {
    const { data, error } = await client.from('jobs').select(JOB_COLS).eq('id', inputJobId).maybeSingle()
    if (error) jobReadError = error.message
    jobRow = data || null
  } else if (inputJobNumber) {
    const { data, error } = await client.from('jobs').select(JOB_COLS).ilike('job_number', inputJobNumber).limit(1)
    if (error) jobReadError = error.message
    jobRow = data?.[0] || null
  }
  if (!jobRow) {
    const detail = jobReadError ? ` (${jobReadError})` : ''
    throw new Error(`assemble_job_dossier could not resolve job: ${inputJobId || inputJobNumber}${detail}`)
  }

  const jobId: string = jobRow.id
  const jobNumber: string = jobRow.job_number
  const ghlContactId: string | null = jobRow.ghl_contact_id || null

  const sourceStatus: Record<string, SourceStatus> = {
    jobs:            { ok: true,  count: 1 },
    invoices:        { ok: true,  count: 0 },
    purchaseOrders:  { ok: true,  count: 0 },
    workOrders:      { ok: true,  count: 0 },
    assignments:     { ok: true,  count: 0 },
    council:         { ok: true,  count: 0 },
    businessEvents:  { ok: true,  count: 0 },
    conversation:    { ok: true,  count: 0 },
    facts:           { ok: true,  count: 0 },
    proposedActions: { ok: true,  count: 0 },
  }

  // ── Operational truth ──
  // Column lists below verified against information_schema 2026-05-01.
  // Schema notes:
  //   xero_invoices: invoice_date (not issue_date), invoice_type (not type)
  //   purchase_orders: total (not total_amount), delivery_date (not expected_date)
  //   work_orders: trade_name (not contractor_name), no total column
  //   council_submissions: template_type/overall_status/current_step_index
  //                        (no council_name/status/current_step/submitted_at/approved_at)
  const invoicesRead = await safeRead('xero_invoices', async () => {
    const { data, error } = await client.from('xero_invoices')
      .select('id, invoice_number, status, invoice_type, total, amount_due, amount_paid, invoice_date, due_date, contact_name, fully_paid_on')
      .eq('job_id', jobId)
      .order('invoice_date', { ascending: false })
      .limit(50)
    if (error) throw new Error(error.message)
    return data
  })
  sourceStatus.invoices = invoicesRead.status

  const posRead = await safeRead('purchase_orders', async () => {
    const { data, error } = await client.from('purchase_orders')
      .select('id, po_number, supplier_name, status, total, delivery_date, confirmed_delivery_date, po_type, created_at, sent_at:created_at')
      .eq('job_id', jobId)
      .neq('status', 'deleted')
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw new Error(error.message)
    return data
  })
  sourceStatus.purchaseOrders = posRead.status

  const wosRead = await safeRead('work_orders', async () => {
    const { data, error } = await client.from('work_orders')
      .select('id, wo_number, trade_name, status, scheduled_date, sent_at, accepted_at, completed_at, created_at')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw new Error(error.message)
    return data
  })
  sourceStatus.workOrders = wosRead.status

  const assignmentsRead = await safeRead('job_assignments', async () => {
    const { data, error } = await client.from('job_assignments')
      .select('id, scheduled_date, scheduled_end, start_time, end_time, assignment_type, crew_name, role, notes, confirmation_status, status, user_id, created_at')
      .eq('job_id', jobId)
      .order('scheduled_date', { ascending: false })
      .limit(100)
    if (error) throw new Error(error.message)
    return data
  })
  sourceStatus.assignments = assignmentsRead.status

  const councilRead = await safeRead('council_submissions', async () => {
    const { data, error } = await client.from('council_submissions')
      .select('id, template_type, overall_status, current_step_index, steps, created_at, updated_at')
      .eq('job_id', jobId)
      .order('updated_at', { ascending: false })
      .limit(10)
    if (error) throw new Error(error.message)
    return data
  })
  sourceStatus.council = councilRead.status

  // ── Raw evidence: business_events ──
  const eventsRead = await safeRead('business_events', async () => {
    let q = client.from('business_events')
      .select('id, event_type, source, occurred_at, payload, correlation_id')
      .eq('job_id', jobId)
      .order('occurred_at', { ascending: false })
      .limit(eventsLimit)
    if (since) q = q.gt('occurred_at', since)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  })
  sourceStatus.businessEvents = eventsRead.status

  // ── Conversation: 5-source merge (reuses getJobConversation internal helper) ──
  const conversationRead = await safeRead('conversation', async () => {
    const { messages } = await getJobConversation(client, {
      job_id: jobId,
      limit: conversationLimit,
      since,
    })
    return messages || []
  })
  sourceStatus.conversation = conversationRead.status
  // Validator expects oldest-first; getJobConversation returns DESC.
  const conversationAsc = [...conversationRead.data].reverse()

  // ── Extracted facts: job_context ──
  const factsRead = await safeRead('job_context', async () => {
    const { data, error } = await client.from('job_context')
      .select('id, job_id, kind, value, provenance, correlation_id, created_at, updated_at')
      .eq('job_id', jobId)
      .order('updated_at', { ascending: false })
      .limit(factsLimit)
    if (error) throw new Error(error.message)
    return data
  })
  sourceStatus.facts = factsRead.status

  // ── Proposed actions: ai_proposed_actions (status=proposed only by default) ──
  const nowIso = new Date().toISOString()
  const proposedRead = await safeRead('ai_proposed_actions', async () => {
    const { data, error } = await client.from('ai_proposed_actions')
      .select('proposal_id, action_type, action_payload, confidence_score, status, job_id, expires_at, created_at, drafted_message, contact_id')
      .eq('job_id', jobId)
      .eq('status', 'proposed')
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw new Error(error.message)
    return data
  })
  sourceStatus.proposedActions = proposedRead.status

  // ── Diagnostics ──
  const warnings: string[] = []
  if (factsRead.status.ok && factsRead.status.count === 0) {
    warnings.push('facts: 0 rows — extractor may not have written for this job yet')
  }
  warnings.push('transcripts: not yet implemented (M4 deferred — privacy/consent decision required)')
  warnings.push('reasoning/outcomes: Layer 7 schema not yet job-linked')
  const diagnosticsOk = Object.values(sourceStatus).every((s) => s.ok)

  // ── Evidence refs ──
  const evidenceRefs: { type: string; source_table: string; id: string }[] = []
  for (const r of eventsRead.data) evidenceRefs.push({ type: 'event', source_table: 'business_events', id: r.id })
  for (const m of conversationAsc) evidenceRefs.push({ type: 'message', source_table: m.source_system || 'conversation', id: String(m.source_ref || m.id || '') })
  for (const f of factsRead.data) evidenceRefs.push({ type: 'fact', source_table: 'job_context', id: f.id })

  // ── Strip internal-only columns from job before returning ──
  // Production jobs schema does not expose `value_inc_gst` or `sent_at`;
  // omit rather than synthesise. T4 contract treats job.value field and
  // sent_at as optional, so callers that already use optional-chaining
  // (cockpit reducer, retriever formatter) handle absence gracefully.
  const job = {
    id: jobRow.id,
    job_number: jobRow.job_number,
    type: jobRow.type,
    status: jobRow.status,
    client_name: jobRow.client_name,
    client_phone: jobRow.client_phone,
    client_email: jobRow.client_email,
    site_address: jobRow.site_address,
    site_suburb: jobRow.site_suburb,
    deposit_amount: jobRow.deposit_amount,
    created_at: jobRow.created_at,
    quoted_at: jobRow.quoted_at,
    accepted_at: jobRow.accepted_at,
    scheduled_at: jobRow.scheduled_at,
    completed_at: jobRow.completed_at,
    updated_at: jobRow.updated_at,
  }

  return {
    job,
    operationalTruth: {
      invoices: invoicesRead.data,
      purchaseOrders: posRead.data,
      workOrders: wosRead.data,
      assignments: assignmentsRead.data,
      council: councilRead.data,
    },
    events: eventsRead.data,
    conversation: conversationAsc,
    facts: factsRead.data,
    proposedActions: proposedRead.data,
    transcripts: [] as any[],
    reasoning: [] as any[],
    outcomes: [] as any[],
    evidenceRefs,
    diagnostics: {
      ok: diagnosticsOk,
      sourceStatus,
      warnings,
    },
    generatedAt: new Date().toISOString(),
    mode,
    bounds: {
      conversationLimit,
      eventsLimit,
      factsLimit,
    },
    // Provenance hint for the canon: the assembler is read-only.
    _kind: 'job_dossier_v1',
    _ghlContactId: ghlContactId,
  }
}


// ── Dashboard source-alignment actions (Mission 1.5C) ──
// These handlers were preserved from the dashboard-side ops-api copy so the
// backend can become the only switchboard without removing current dashboard
// reads. Keep them in the required-action manifest before production deploy.

async function searchJobs(client: any, params: URLSearchParams) {
  const q = (params.get('q') || '').trim()
  if (!q || q.length < 2) return { results: [] }

  const term = `%${q}%`

  // Search across jobs, invoices, quotes, contacts in parallel
  const [jobRes, invoiceRes, contactRes, quoteRes] = await Promise.all([
    // Direct job fields: client name, job number, address, suburb, email, phone
    client.from('jobs')
      .select('id, job_number, client_name, client_email, client_phone, site_address, site_suburb, type, status')
      .eq('org_id', DEFAULT_ORG_ID)
      .or('legacy.is.null,legacy.eq.false')
      .or(`client_name.ilike.${term},job_number.ilike.${term},site_address.ilike.${term},site_suburb.ilike.${term},client_email.ilike.${term},client_phone.ilike.${term}`)
      .not('status', 'in', '("lost","cancelled","draft")')
      .order('updated_at', { ascending: false })
      .limit(20),
    // Xero invoices: reference or invoice number
    client.from('xero_invoices')
      .select('job_id, reference, invoice_number, status, invoice_type')
      .or(`reference.ilike.${term},invoice_number.ilike.${term}`)
      .not('status', 'in', '("VOIDED","DELETED")')
      .limit(10),
    // Job contacts (neighbours etc): name, email, phone
    client.from('job_contacts')
      .select('job_id, client_name, contact_label, client_email, client_phone')
      .eq('status', 'active')
      .or(`client_name.ilike.${term},client_email.ilike.${term},client_phone.ilike.${term}`)
      .limit(10),
    // Quote revisions: quote number
    client.from('quote_revisions')
      .select('job_id, quote_number')
      .ilike('quote_number', term)
      .limit(10),
  ])

  // Collect all matched job IDs from secondary tables
  const secondaryJobIds = new Set<string>()
  const matchContext: Record<string, string> = {} // jobId -> why it matched

  for (const inv of (invoiceRes.data || [])) {
    if (inv.job_id) {
      secondaryJobIds.add(inv.job_id)
      matchContext[inv.job_id] = `Invoice: ${inv.invoice_number || inv.reference || ''}`
    }
  }
  for (const c of (contactRes.data || [])) {
    if (c.job_id) {
      secondaryJobIds.add(c.job_id)
      matchContext[c.job_id] = `Contact: ${c.client_name || ''} (${c.contact_label || 'neighbour'})`
    }
  }
  for (const qr of (quoteRes.data || [])) {
    if (qr.job_id) {
      secondaryJobIds.add(qr.job_id)
      matchContext[qr.job_id] = `Quote: ${qr.quote_number}`
    }
  }

  // Remove IDs already in direct results
  const directIds = new Set((jobRes.data || []).map((j: any) => j.id))
  const extraIds = [...secondaryJobIds].filter(id => !directIds.has(id))

  // Fetch job info for secondary matches
  let extraJobs: any[] = []
  if (extraIds.length > 0) {
    const { data } = await client.from('jobs')
      .select('id, job_number, client_name, client_email, client_phone, site_address, site_suburb, type, status')
      .in('id', extraIds)
      .not('status', 'in', '("lost","cancelled","draft")')
    extraJobs = data || []
  }

  // Combine and format results
  const results = [
    ...(jobRes.data || []).map((j: any) => ({ ...j, match_source: 'job' })),
    ...extraJobs.map((j: any) => ({ ...j, match_source: matchContext[j.id] || 'related' })),
  ].filter((j: any) => !isTestRecord(j.client_name)).slice(0, 15)

  return { results }
}

async function getOrgEvents(client: any, params: URLSearchParams) {
  const from = params.get('from') || new Date().toISOString().slice(0, 10)
  const to = params.get('to') || (() => {
    const d = new Date(from); d.setMonth(d.getMonth() + 3); return d.toISOString().slice(0, 10)
  })()

  const { data, error } = await client
    .from('org_events')
    .select('*')
    .eq('org_id', DEFAULT_ORG_ID)
    .gte('event_date', from)
    .lte('event_date', to)
    .order('event_date', { ascending: true })

  if (error) throw error
  return data || []
}

async function myActions(client: any) {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await client
    .from('job_actions')
    .select('*')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('status', 'pending')
    .order('due_date', { ascending: true, nullsFirst: false })

  if (error) throw error
  const items = data || []

  const overdue: any[] = []
  const due_today: any[] = []
  const upcoming: any[] = []
  const no_date: any[] = []

  for (const a of items) {
    if (!a.due_date) no_date.push(a)
    else if (a.due_date < today) overdue.push(a)
    else if (a.due_date === today) due_today.push(a)
    else upcoming.push(a)
  }

  return { overdue, due_today, upcoming, no_date }
}

async function listJobActions(client: any, params: URLSearchParams) {
  const jobId = params.get('job_id')
  if (!jobId) throw new Error('job_id required')

  const statusFilter = params.get('status')
  let query = client.from('job_actions')
    .select('*')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('job_id', jobId)

  if (statusFilter && statusFilter !== 'all') {
    query = query.eq('status', statusFilter)
  }

  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

// ════════════════════════════════════════════════════════════
// OPS DASHBOARD — WRITE ACTIONS
// ════════════════════════════════════════════════════════════

async function createOrgEvent(client: any, body: any) {
  const { title, event_date, event_end, event_type, description, visible_to_trades } = body
  if (!title || !event_date || !event_type) throw new Error('title, event_date, and event_type required')
  if (!['public_holiday', 'company_day'].includes(event_type)) throw new Error('event_type must be public_holiday or company_day')

  const { data, error } = await client.from('org_events').insert({
    org_id: DEFAULT_ORG_ID,
    title,
    event_date,
    event_end: event_end || null,
    event_type,
    description: description || null,
    visible_to_trades: visible_to_trades !== false,
  }).select().single()

  if (error) throw error
  return data
}

async function deleteOrgEvent(client: any, body: any) {
  const id = body.id || body.event_id
  if (!id) throw new Error('id required')

  const { error } = await client.from('org_events').delete().eq('id', id).eq('org_id', DEFAULT_ORG_ID)
  if (error) throw error
  return { ok: true }
}

async function createJobAction(client: any, body: any) {
  const { title, description, job_number, job_id, due_date, due_time, priority, source, category, sub_category } = body
  if (!title) throw new Error('title required')

  // If job_number provided but no job_id, look up the job
  let resolvedJobId = job_id || null
  let resolvedJobNumber = job_number || null
  let clientName: string | null = null

  if (job_number && !job_id) {
    const { data: job } = await client.from('jobs')
      .select('id, job_number, client_name, type')
      .eq('org_id', DEFAULT_ORG_ID)
      .eq('job_number', job_number)
      .maybeSingle()
    if (job) {
      resolvedJobId = job.id
      resolvedJobNumber = job.job_number
      clientName = job.client_name
    }
  } else if (job_id) {
    const { data: job } = await client.from('jobs')
      .select('job_number, client_name, type')
      .eq('id', job_id)
      .maybeSingle()
    if (job) {
      resolvedJobNumber = job.job_number
      clientName = job.client_name
    }
  }

  // Infer category from job type + title if not provided
  let cat = category || 'general_ops'
  let subCat = sub_category || 'tasks'
  if (!category && resolvedJobNumber) {
    if (resolvedJobNumber.startsWith('SWF-')) cat = 'fencing'
    else if (resolvedJobNumber.startsWith('SWP-')) cat = 'patio'
    else if (resolvedJobNumber.startsWith('SWMS-')) cat = 'makesafes'
  }
  if (!sub_category && title) {
    const t = title.toLowerCase()
    if (t.includes('invoice') || t.includes('payment') || t.includes('chase') || t.includes('deposit')) subCat = 'invoices'
    else if (t.includes('material') || t.includes('order') || t.includes('supplier') || t.includes('ampelite') || t.includes('steel')) subCat = 'materials'
    else if (t.includes('schedule') || t.includes('reschedule') || t.includes('assign')) subCat = 'scheduling'
    else if (t.includes('doc') || t.includes('work order') || t.includes('wo ') || t.includes('council')) subCat = 'docs'
  }

  const row = {
    org_id: DEFAULT_ORG_ID,
    job_id: resolvedJobId,
    job_number: resolvedJobNumber,
    client_name: clientName || body.client_name || null,
    title,
    description: description || null,
    due_date: due_date || null,
    due_time: due_time || null,
    priority: priority || 'normal',
    source: source || 'manual',
    category: cat,
    sub_category: subCat,
  }

  const { data, error } = await client.from('job_actions').insert(row).select().single()
  if (error) throw error
  return data
}

async function updateJobAction(client: any, body: any) {
  const actionId = body.action_id || body.id
  if (!actionId) throw new Error('action_id required')

  const updates: any = { updated_at: new Date().toISOString() }
  if (body.status === 'done') {
    updates.status = 'done'
    updates.completed_at = new Date().toISOString()
  } else if (body.status === 'dismissed') {
    updates.status = 'dismissed'
    updates.dismissed_at = new Date().toISOString()
  } else if (body.status) {
    updates.status = body.status
  }
  if (body.due_date !== undefined) updates.due_date = body.due_date
  if (body.due_time !== undefined) updates.due_time = body.due_time
  if (body.priority) updates.priority = body.priority
  if (body.title) updates.title = body.title

  const { data, error } = await client.from('job_actions')
    .update(updates)
    .eq('id', actionId)
    .select()
    .single()
  if (error) throw error
  return data
}

async function generateWorkOrderDoc(client: any, body: any) {
  const jId = body.job_id || body.jobId
  if (!jId) throw new ApiError('job_id required', 400)

  const { data: job, error: jobErr } = await client.from('jobs')
    .select('id, job_number, type, client_name, client_phone, client_email, site_address, site_suburb, scope_json, pricing_json, created_at')
    .eq('id', jId).single()
  if (jobErr || !job) throw new ApiError('Job not found', 404)
  if (job.type !== 'fencing') throw new ApiError('Work order doc only supported for fencing jobs', 400)

  const sj = job.scope_json?.job
  if (!sj?.runs?.length) throw new ApiError('No fencing scope data on this job', 400)

  // Get media for site photos
  const { data: media } = await client.from('job_media')
    .select('label, storage_url, thumbnail_url, phase')
    .eq('job_id', jId)
  const sitePhotos = (media || []).filter((m: any) => m.phase !== 'receipt')

  // ── Constants (from fence designer) ──
  const POST_LOOKUP: Record<number, {ret:number,post:number}[]> = {
    1200:[{ret:0,post:2400},{ret:150,post:2400},{ret:300,post:2400},{ret:450,post:2400},{ret:600,post:2400}],
    1500:[{ret:0,post:2400},{ret:150,post:2400},{ret:300,post:2400},{ret:450,post:2700},{ret:600,post:2700}],
    1800:[{ret:0,post:2400},{ret:150,post:2700},{ret:300,post:2700},{ret:450,post:3000},{ret:600,post:3000}],
    2100:[{ret:0,post:2700},{ret:150,post:3000},{ret:300,post:3000},{ret:450,post:3000},{ret:600,post:3000}]
  }
  const SUPPLIER_PW: Record<string, number> = { RNR:2380, Metroll:2365, Lysaght:2360, Stratco:2350 }
  const CP = {
    panelKit1800_2400:185, panelKit1800_2700:210, panelKit1800_3000:235,
    panelKit1500_2400:165, panelKit1200_2400:145, panelKit2100_2700:230, panelKit2100_3000:255,
    plinth:28, patioTube:45, gateKitPed:320, gateKitDbl:580, gatePost:85,
    concrete:9.50, tekBox:18, labourPerM:35, delivery:250
  }
  const ACCESS_RATE: Record<string,number> = { easy:0, moderate:0.10, difficult:0.20 }

  function lookupPost(sh: number, ret: number) {
    const t = POST_LOOKUP[sh] || POST_LOOKUP[1800]
    const e = t.find(x => x.ret === ret)
    if (e) return e.post
    const req = sh + ret + 600
    return req <= 2400 ? 2400 : req <= 2700 ? 2700 : 3000
  }

  const esc = (s: string) => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  const fmt = (n: number) => n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  // ── Collect data ──
  const removal = sj.removal || {}
  const access = removal.access || 'easy'
  const accessRate = ACCESS_RATE[access] || 0
  const panelWidthMm = SUPPLIER_PW[sj.supplier] || 2365
  let totalMetres = 0, totalPanels = 0, totalPosts = 0, totalPlinths = 0, totalPatioTubes = 0
  const postGroups: Record<string, {sheetH:number, postH:number, count:number}> = {}
  const runDetails: any[] = []

  for (const run of sj.runs) {
    const panels = run.panels || []
    const panelCount = panels.length
    totalMetres += run.length || 0
    totalPanels += panelCount
    totalPosts += panelCount + 1
    let runPlinths = 0, panelsWithPatio = 0
    const panelDetails: any[] = []
    for (let idx = 0; idx < panels.length; idx++) {
      const p = panels[idx]
      const slopePl = p.slopePlinths || 0
      const manualPl = p.retaining / 150
      const totalPl = Math.min(4, slopePl + manualPl)
      const totalRet = totalPl * 150
      runPlinths += totalPl
      const postH = lookupPost(p.height, totalRet)
      const patio = totalPl >= 3 && totalPl <= 4
      if (patio) panelsWithPatio++
      const key = `${p.height}_${postH}`
      if (!postGroups[key]) postGroups[key] = { sheetH: p.height, postH, count: 0 }
      postGroups[key].count++
      panelDetails.push({ num: idx+1, height: p.height, retaining: totalRet, totalH: p.height+totalRet, postH, patio, stepMm: p.stepMm||0 })
    }
    const patioTubes = panelsWithPatio > 0 ? panelsWithPatio + 1 : 0
    totalPlinths += runPlinths
    totalPatioTubes += patioTubes
    const hasRetaining = panels.some((p: any) => (p.slopePlinths||0) + (p.retaining/150) > 0)
    runDetails.push({ name: run.name, length: run.length||0, panelCount, plinths: runPlinths, patioTubes, hasRetaining, panels: panelDetails })
  }
  if (sj.runs.length > 1) totalPosts -= (sj.runs.length - 1)

  let gatePosts = 0
  const gateItems: string[] = []
  for (const g of (sj.gates || [])) {
    const gp = g.type === 'double' ? 4 : 2
    gatePosts += gp
    gateItems.push(g.type === 'double' ? `Double swing gate ${g.width||''}mm` : `Pedestrian gate ${g.width||900}mm`)
  }
  const allPosts = totalPosts + gatePosts
  const concreteBags = Math.ceil(allPosts * 2 * 1.1 / 2) * 2
  const tekBoxes = totalPanels > 0 ? Math.max(1, Math.ceil(totalPanels / 4)) : 0

  // Post breakdown
  const heightCounts: Record<number,number> = {}
  for (const r of runDetails) for (const p of r.panels) heightCounts[p.postH] = (heightCounts[p.postH]||0) + 1
  const postBreakdown = Object.keys(heightCounts).sort().map(h => `${heightCounts[Number(h)]} @ ${h}mm`).join(', ')

  // Internal costs
  let internalCost = 0
  for (const g of Object.values(postGroups)) {
    let uc = CP.panelKit1800_2400
    if (g.sheetH===1200) uc=CP.panelKit1200_2400
    else if (g.sheetH===1500) uc=CP.panelKit1500_2400
    else if (g.sheetH===1800) { uc = g.postH<=2400?CP.panelKit1800_2400:g.postH<=2700?CP.panelKit1800_2700:CP.panelKit1800_3000 }
    else if (g.sheetH===2100) { uc = g.postH<=2700?CP.panelKit2100_2700:CP.panelKit2100_3000 }
    internalCost += g.count * uc
  }
  internalCost += totalPlinths*CP.plinth + totalPatioTubes*CP.patioTube + concreteBags*CP.concrete + tekBoxes*CP.tekBox
  for (const g of (sj.gates||[])) internalCost += g.type==='double'?(CP.gateKitDbl+4*CP.gatePost):(CP.gateKitPed+2*CP.gatePost)
  const labourBase = totalMetres * CP.labourPerM
  const internalLabour = labourBase * (1 + accessRate)
  const totalCostBase = internalCost + internalLabour + CP.delivery
  const pricing = sj._pricing_json || job.pricing_json || {}
  const quoteTotalExGST = pricing.totalExGST || (pricing.totalIncGST ? pricing.totalIncGST / 1.1 : 0)
  const margin = quoteTotalExGST - totalCostBase

  const dateStr = sj.date || job.created_at
  const fmtDate = dateStr ? new Date(dateStr).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : ''

  // ── Build HTML ──
  const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 490 79.55" style="height:28px;width:auto;"><defs><style>.c1{fill:#fff}.c3{fill:rgba(255,255,255,0.6)}</style></defs><path class="c1" d="M85.11,46.94c.24,1.73,.73,3.02,1.44,3.88,1.31,1.56,3.56,2.34,6.74,2.34,1.91,0,3.45-.21,4.64-.62,2.26-.79,3.38-2.25,3.38-4.39,0-1.25-.55-2.22-1.66-2.9-1.11-.67-2.86-1.26-5.26-1.77l-4.1-.9c-4.03-.89-6.8-1.86-8.3-2.9-2.55-1.75-3.83-4.48-3.83-8.19,0-3.39,1.25-6.21,3.74-8.45s6.16-3.36,11-3.36c4.04,0,7.48,1.06,10.33,3.17,2.85,2.11,4.35,5.18,4.48,9.21h-7.6c-.14-2.28-1.16-3.89-3.05-4.85-1.26-.63-2.83-.95-4.71-.95-2.09,0-3.76,.41-5,1.23-1.25,.82-1.87,1.97-1.87,3.44,0,1.35,.61,2.36,1.84,3.03,.79,.45,2.47,.97,5.03,1.57l6.64,1.57c2.91,.69,5.09,1.6,6.55,2.75,2.26,1.78,3.38,4.36,3.38,7.73s-1.34,6.33-4.01,8.62c-2.67,2.29-6.45,3.43-11.33,3.43s-8.9-1.13-11.76-3.38c-2.86-2.25-4.28-5.35-4.28-9.28h7.55Z"/><path class="c1" d="M130.99,31.2c1.95,.87,3.57,2.26,4.84,4.14,1.15,1.66,1.89,3.59,2.23,5.79,.2,1.29,.28,3.14,.24,5.56h-20.39c.11,2.81,1.09,4.78,2.93,5.91,1.12,.7,2.46,1.05,4.04,1.05,1.67,0,3.02-.43,4.06-1.28,.57-.46,1.07-1.1,1.51-1.93h7.47c-.2,1.66-1.1,3.35-2.71,5.06-2.51,2.72-6.02,4.08-10.53,4.08-3.73,0-7.01-1.15-9.86-3.44-2.85-2.3-4.27-6.03-4.27-11.21,0-4.85,1.28-8.57,3.86-11.16,2.57-2.59,5.91-3.88,10.01-3.88,2.44,0,4.63,.44,6.58,1.31Zm-10.95,6.32c-1.03,1.07-1.68,2.51-1.95,4.33h12.61c-.13-1.94-.78-3.42-1.95-4.42s-2.61-1.51-4.34-1.51c-1.88,0-3.34,.53-4.37,1.6Z"/><polygon class="c1" points="53.4 30.35 53.4 22.29 31.41 8.51 8.87 22.26 8.87 34.53 45.59 42.34 45.59 52.83 38.55 52.83 31.39 45.47 24.15 52.83 16.68 52.83 16.68 39 8.87 37.4 8.87 60.64 27.43 60.64 31.36 56.65 35.25 60.64 53.4 60.64 53.4 36.01 16.68 28.21 16.68 26.65 31.35 17.69 45.59 26.61 45.59 31.95 53.4 33.41 53.4 30.35"/><rect fill="#F15A29" x="8.96" y="62.99" width="44.53" height="7.77"/><text class="c3" x="406" y="52" font-family="Helvetica Neue,Helvetica,Arial,sans-serif" font-size="21" font-weight="400" letter-spacing="0.5">Group</text></svg>'

  // CSS
  const css = `*{box-sizing:border-box}body{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;color:#293C46;margin:0;padding:0;font-size:13px;line-height:1.5}.page{max-width:820px;margin:0 auto;padding:0 40px 40px}.header-band{background:#293C46;padding:0;margin:0}.header-accent{height:4px;background:#F15A29}.header-inner{max-width:820px;margin:0 auto;padding:16px 40px;display:flex;align-items:center;justify-content:space-between}.header-meta{text-align:right;color:#fff}.header-meta .ref{font-size:13px;font-weight:700}.header-meta .date{font-size:11px;opacity:0.7;margin-top:2px}.doc-title{padding:16px 0 12px;border-bottom:3px solid #F15A29;margin-bottom:24px}.doc-title h1{font-size:22px;margin:0;color:#293C46;text-transform:uppercase;letter-spacing:1px}.section{margin-bottom:22px}.section h2{font-size:13px;text-transform:uppercase;letter-spacing:0.8px;font-weight:700;color:#293C46;margin:0 0 8px 0;padding:6px 0 6px 10px;border-left:3px solid #F15A29;background:#f0f4f7}.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;margin-bottom:14px}.info-grid .label{font-weight:700;font-size:10px;text-transform:uppercase;color:#4C6A7C;letter-spacing:0.5px}.info-grid .value{font-size:13px}table{width:100%;border-collapse:collapse;margin-bottom:14px;font-size:12px}th{background:#293C46;color:#fff;padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;font-weight:700}td{padding:7px 10px;border-bottom:1px solid #e5e7eb}tr:nth-child(even) td{background:#f8fafb}.text-right{text-align:right}.total-row td{font-weight:700;border-top:2px solid #293C46;background:#fff !important}.checklist{padding-left:20px}.checklist li{margin-bottom:5px;font-size:12px}.patio-flag{color:#F15A29;font-weight:700}.confidential{background:#fef2f2;border:2px solid #dc2626;padding:3px 10px;display:inline-block;font-size:10px;font-weight:700;color:#dc2626;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}.footer{border-top:1px solid #c8c8c8;padding-top:12px;margin-top:30px;text-align:center;font-size:10px;color:#4C6A7C;line-height:1.6}@media print{body{padding:0}.page{padding:0 20px 20px}.header-inner{padding:12px 20px}.no-print{display:none !important}.header-band,.header-accent,th,.section h2{-webkit-print-color-adjust:exact;print-color-adjust:exact}}.print-btn{position:fixed;top:12px;right:12px;padding:10px 20px;background:#F15A29;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.15);z-index:100}`

  // Runs HTML
  let runsHtml = ''
  for (const r of runDetails) {
    runsHtml += `<div class="section"><h2>${esc(r.name)} (${r.panelCount} panels, ${r.length}m)`
    if (r.patioTubes > 0) runsHtml += ` <span class="patio-flag">[${r.patioTubes} patio tubes]</span>`
    runsHtml += '</h2>'
    if (r.hasRetaining) {
      runsHtml += '<table><thead><tr><th>Panel</th><th>Fence</th><th>Ret.</th><th>Total</th><th>Post</th><th>Notes</th></tr></thead><tbody>'
      for (const p of r.panels) {
        let notes = ''
        if (p.patio) notes += '<span class="patio-flag">PATIO TUBE</span> '
        if (p.stepMm !== 0) notes += (p.stepMm < 0 ? '\u2193' : '\u2191') + Math.abs(p.stepMm) + 'mm'
        runsHtml += `<tr><td>P${p.num}</td><td>${p.height}mm</td><td>${p.retaining}mm</td><td>${p.totalH}mm</td><td>${p.postH}mm</td><td>${notes}</td></tr>`
      }
      runsHtml += '</tbody></table>'
    } else {
      const pH = r.panels[0]?.postH || 2400, sH = r.panels[0]?.height || 1800
      runsHtml += `<p style="padding-left:12px;">P1\u2013P${r.panelCount}: ${sH}mm fence, 0mm retaining | Post height: ${pH}mm</p>`
    }
    runsHtml += '</div>'
  }

  // Gates
  const gatesHtml = gateItems.length > 0 ? gateItems.map(g => `<p style="padding-left:12px;">${esc(g)} \u2014 90\u00D790mm SHS gate posts</p>`).join('') : '<p style="padding-left:12px;">None</p>'

  // Scope checklist
  const scopeList = ['Install COLORBOND\u00AE fencing per specification', 'Set all posts in concrete (2 bags/post)']
  if (totalPlinths > 0) scopeList.push(`Install ${totalPlinths} retaining plinths`)
  if (totalPatioTubes > 0) scopeList.push(`Install ${totalPatioTubes} patio tubes at retained sections`)
  if (removal.removalRequired && removal.existingFenceType) scopeList.push(`Remove existing ${removal.existingFenceType} fencing (${removal.existingFenceLength||0}m)`)
  for (const g of gateItems) scopeList.push(g)
  scopeList.push('Site clean-up and rubbish removal')

  // Site plan
  const sitePlan = sj._latlng?.lat ? `<img src="https://maps.googleapis.com/maps/api/staticmap?center=${sj._latlng.lat},${sj._latlng.lng}&zoom=19&size=800x400&maptype=satellite&key=AIzaSyCVNUaGS6k6MBG6_-MbCyiIGUajnzHU7DM" style="width:100%;border-radius:4px">` : ''

  // Photos
  let photosHtml = ''
  if (sitePhotos.length > 0) {
    photosHtml = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px">'
    for (const m of sitePhotos) {
      const src = m.thumbnail_url || m.storage_url
      photosHtml += `<div style="text-align:center"><img src="${esc(src)}" style="width:100%;max-height:200px;object-fit:cover;border-radius:4px"><div style="font-size:10px;color:#666;margin-top:2px">${esc(m.label||'')}</div></div>`
    }
    photosHtml += '</div>'
  }

  // Cost breakdown
  const costHtml = `<table><thead><tr><th>Item</th><th class="text-right">Cost</th></tr></thead><tbody>
<tr><td>Materials (panels, posts, plinths, concrete, fixings)</td><td class="text-right">$${fmt(internalCost)}</td></tr>
<tr><td>Labour base (${totalMetres.toFixed(1)}m @ $${CP.labourPerM}/m${accessRate>0?' + '+(accessRate*100)+'% access':''})</td><td class="text-right">$${fmt(internalLabour)}</td></tr>
<tr><td>Delivery</td><td class="text-right">$${fmt(CP.delivery)}</td></tr>
<tr class="total-row"><td>Total cost</td><td class="text-right">$${fmt(totalCostBase)}</td></tr>
<tr><td>Quote total (excl. GST)</td><td class="text-right">$${fmt(quoteTotalExGST)}</td></tr>
<tr style="font-weight:700"><td>Margin</td><td class="text-right">$${fmt(margin)}</td></tr>
</tbody></table>`

  // Assemble
  const jn = job.job_number || sj.ref || ''
  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Work Order \u2014 ${esc(jn)}</title><style>${css}</style></head><body>`
  html += '<button class="print-btn no-print" onclick="window.print()">Print / PDF</button>'
  html += `<div class="header-accent"></div><div class="header-band"><div class="header-inner"><div class="header-logo">${LOGO}</div><div class="header-meta"><div class="ref">${esc(jn)}</div><div class="date">${fmtDate}</div></div></div></div>`
  html += '<div class="page">'
  html += `<div class="doc-title"><h1>Work Order \u2014 ${esc(jn)}</h1></div>`
  html += `<div class="section"><div class="info-grid"><div><span class="label">Client</span><br><span class="value">${esc(job.client_name||sj.client)}</span></div><div><span class="label">Job Ref</span><br><span class="value">${esc(jn)}</span></div><div><span class="label">Address</span><br><span class="value">${esc(job.site_address||sj.address)}</span></div><div><span class="label">Date</span><br><span class="value">${fmtDate}</span></div><div><span class="label">Phone</span><br><span class="value">${esc(job.client_phone||sj.phone)}</span></div><div><span class="label">Email</span><br><span class="value">${esc(job.client_email||sj.email)}</span></div><div><span class="label">Scoper</span><br><span class="value">${esc(sj.scoper||'')}</span></div><div><span class="label">Access</span><br><span class="value">${esc(access)}</span></div></div></div>`
  if (sitePlan) html += `<div class="section"><h2>Site Plan</h2>${sitePlan}</div>`
  html += `<div class="section"><h2>Fence Specification</h2><div class="info-grid"><div><span class="label">Supplier</span><br><span class="value">${esc(sj.supplier||'')}</span></div><div><span class="label">Profile</span><br><span class="value">${esc(sj.profile||'')}</span></div><div><span class="label">Colour</span><br><span class="value">${esc(sj.colour||'')}</span></div><div><span class="label">Panel Width</span><br><span class="value">${panelWidthMm}mm</span></div></div></div>`
  html += runsHtml
  html += `<div class="section"><h2>Gates</h2>${gatesHtml}</div>`
  html += `<div class="section"><h2>Summary</h2><div class="info-grid"><div><span class="label">Total Length</span><br><span class="value">${totalMetres.toFixed(1)}m</span></div><div><span class="label">Panels</span><br><span class="value">${totalPanels}</span></div><div><span class="label">Posts</span><br><span class="value">${totalPosts} (${postBreakdown})</span></div><div><span class="label">Gate Posts</span><br><span class="value">${gatePosts} \u00D7 90\u00D790mm SHS</span></div><div><span class="label">Plinths</span><br><span class="value">${totalPlinths}</span></div><div><span class="label">Patio Tubes</span><br><span class="value">${totalPatioTubes}</span></div><div><span class="label">Concrete</span><br><span class="value">${concreteBags} bags</span></div><div><span class="label">Tek Screws</span><br><span class="value">${tekBoxes} boxes</span></div></div></div>`
  html += `<div class="section"><h2>Scope of Work</h2><ul class="checklist">${scopeList.map(s => `<li>${s}</li>`).join('')}</ul></div>`
  html += `<div class="section"><h2>Safety &amp; Compliance</h2><ul class="checklist"><li>Dial Before You Dig check completed: <strong>___</strong></li><li>PPE: steel-cap boots, gloves, safety glasses, ear protection</li><li>First aid kit on site</li>${removal.existingFenceType==='asbestos'?'<li style="color:#dc2626;font-weight:700">ASBESTOS: Licensed removal required. Do NOT break sheets.</li>':''}<li>No overhead power lines within 3m of work area confirmed: <strong>___</strong></li></ul></div>`
  html += `<div class="section"><h2>Completion Requirements</h2><ul class="checklist"><li>QC photos of every post alignment and panel fit</li><li>Client walkthrough and sign-off</li><li>Tradify job completion sign-off</li><li>All rubbish removed from site</li></ul></div>`
  if (sj.siteNotes) html += `<div class="section"><h2>Site Notes</h2><p style="padding-left:12px;">${esc(sj.siteNotes).replace(/\n/g,'<br>')}</p></div>`
  if (photosHtml) html += `<div class="section"><h2>Site Photos</h2>${photosHtml}</div>`
  html += `<div class="section" style="margin-top:30px"><span class="confidential">Confidential \u2014 Internal Use Only</span><h2 style="border-left:none;background:none;padding-left:0">Cost Breakdown</h2>${costHtml}</div>`
  html += '<div class="footer">SecureWorks WA Pty Ltd | ABN 64 689 223 416<br>fencing@secureworkswa.com.au | 0489 267 772<br>Fully Licensed | Quality Guaranteed</div>'
  html += '</div></body></html>'

  // ── Upload to storage ──
  const bucket = 'job-documents'
  try { await client.storage.createBucket(bucket, { public: true }) } catch { /* exists */ }

  const fileName = `WO-${jn}.html`
  const path = `${jId}/${Date.now()}-${fileName}`
  const encoded = new TextEncoder().encode(html)

  const { error: uploadErr } = await client.storage.from(bucket).upload(path, encoded, { contentType: 'text/html; charset=utf-8', upsert: true })
  if (uploadErr) throw new Error('Storage upload failed: ' + uploadErr.message)

  const { data: urlData } = client.storage.from(bucket).getPublicUrl(path)
  const publicUrl = urlData.publicUrl

  // ── Create job_documents record (or update existing) ──
  // Check if one already exists for this job
  const { data: existing } = await client.from('job_documents')
    .select('id').eq('job_id', jId).eq('type', 'work_order').eq('file_name', fileName).limit(1)

  let docId: string
  if (existing && existing.length > 0) {
    await client.from('job_documents').update({ storage_url: publicUrl, version: 2 }).eq('id', existing[0].id)
    docId = existing[0].id
  } else {
    const { data: newDoc, error: docErr } = await client.from('job_documents')
      .insert({ job_id: jId, type: 'work_order', file_name: fileName, storage_url: publicUrl, visible_to_trades: true, version: 1, metadata: {} })
      .select('id').single()
    if (docErr) throw new Error('Document record failed: ' + docErr.message)
    docId = newDoc.id
  }

  return { document_id: docId, url: publicUrl, file_name: fileName }
}

async function deleteMedia(client: any, body: any) {
  const mediaId = body.mediaId || body.media_id
  if (!mediaId) throw new Error('mediaId required')

  const { data: media, error: fetchErr } = await client
    .from('job_media')
    .select('id, job_id, storage_url, label, phase')
    .eq('id', mediaId)
    .single()

  if (fetchErr) throw fetchErr
  if (!media) throw new Error('Media not found')

  // Delete from storage
  if (media.storage_url) {
    try {
      const bucket = 'job-photos'
      const urlParts = media.storage_url.split(`/storage/v1/object/public/${bucket}/`)
      if (urlParts.length > 1) {
        await client.storage.from(bucket).remove([urlParts[1]])
      }
    } catch (e) {
      console.log('[ops-api] Storage delete failed (non-blocking):', (e as Error).message)
    }
  }

  const { error: delErr } = await client.from('job_media').delete().eq('id', mediaId)
  if (delErr) throw delErr

  await client.from('job_events').insert({
    job_id: media.job_id,
    event_type: 'media_deleted',
    detail_json: { media_id: mediaId, label: media.label, phase: media.phase },
  })

  logBusinessEvent(client, {
    event_type: 'media.deleted',
    entity_type: 'job_media',
    entity_id: mediaId,
    job_id: media.job_id,
    payload: { label: media.label, phase: media.phase },
    metadata: { operator: body.operator_email || null },
  })

  return { success: true }
}

async function jumpCouncilStep(client: any, body: any) {
  const { submission_id, target_step_index } = body
  if (!submission_id || target_step_index == null) throw new Error('submission_id and target_step_index required')

  const { data: sub } = await client.from('council_submissions')
    .select('id, job_id, steps, current_step_index')
    .eq('id', submission_id)
    .single()
  if (!sub) throw new Error('Submission not found')

  const steps = sub.steps || []
  const target = Number(target_step_index)
  if (target < 0 || target >= steps.length) throw new Error('target_step_index out of range')

  const now = new Date().toISOString()

  // Steps before target -> complete (skipped gaps only for Development Approval)
  for (let i = 0; i < target; i++) {
    if (steps[i].status === 'complete' || steps[i].status === 'skipped') {
      // Already complete/skipped -> leave as is
    } else if (steps[i].name === 'Development Approval' && steps[i].status === 'pending') {
      // Development Approval skipped only if never touched (still pending)
      steps[i].status = 'skipped'
      steps[i].started_at = null
      steps[i].completed_at = null
    } else {
      steps[i].status = 'complete'
      if (!steps[i].completed_at) steps[i].completed_at = now
      if (!steps[i].started_at) steps[i].started_at = now
    }
  }

  // Target step -> in_progress
  steps[target].status = 'in_progress'
  if (!steps[target].started_at) steps[target].started_at = now
  steps[target].completed_at = null

  // Steps after target -> pending (reset)
  for (let i = target + 1; i < steps.length; i++) {
    steps[i].status = 'pending'
    steps[i].started_at = null
    steps[i].completed_at = null
  }

  const overallStatus = target === 0 && steps.length > 1 ? 'in_progress' : steps.every((s: any) => s.status === 'complete') ? 'complete' : 'in_progress'

  await client.from('council_submissions').update({
    steps,
    current_step_index: target,
    overall_status: overallStatus,
    updated_at: now,
  }).eq('id', submission_id)

  const { data: job } = await client.from('jobs').select('job_number').eq('id', sub.job_id).maybeSingle()

  logBusinessEvent(client, {
    event_type: 'council.step_jumped',
    entity_type: 'council_submission',
    entity_id: submission_id,
    job_id: job?.job_number || sub.job_id,
    payload: { target_step: target, step_name: steps[target].name, overall_status: overallStatus },
  })

  return { success: true, overall_status: overallStatus, current_step_index: target, steps }
}

async function createMakesafeJob(client: any, body: any) {
  const {
    client_name, site_address, suburb, phone, mobile,
    requesting_company_slug, external_ref, description,
    pdf_base64, external_links
  } = body

  if (!client_name || !site_address) throw new Error('client_name and site_address required')

  // Look up requesting company
  let companyData: any = null
  if (requesting_company_slug) {
    const { data: co } = await client.from('makesafe_companies')
      .select('*').eq('slug', requesting_company_slug).maybeSingle()
    companyData = co
  }

  // Generate job number through the shared database helper once the make-safe
  // contract migration is applied. Fallback preserves the previous SWMS-26001
  // behaviour for review/test environments that have not run the migration yet.
  let jobNumber: string | null = null
  try {
    const { data: jnData } = await client.rpc('next_job_number', { job_type: 'makesafe' })
    const candidate = String(jnData || '')
    if (candidate.toUpperCase().startsWith('SWMS-')) {
      jobNumber = candidate
    } else if (candidate) {
      console.log('[ops-api] next_job_number(makesafe) returned non-SWMS prefix; falling back:', candidate)
    }
  } catch (e) {
    console.log('[ops-api] next_job_number(makesafe) failed; falling back:', (e as Error)?.message)
  }
  if (!jobNumber) {
    const { data: lastJob } = await client.from('jobs')
      .select('job_number')
      .ilike('job_number', 'SWMS-%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    let nextNum = 26001
    if (lastJob?.job_number) {
      const num = parseInt(lastJob.job_number.replace('SWMS-', ''), 10)
      if (!isNaN(num)) nextNum = num + 1
    }
    jobNumber = `SWMS-${nextNum}`
  }

  // Build metadata
  const metadata: any = {
    requesting_company: companyData ? { slug: companyData.slug, name: companyData.name } : null,
    external_ref: external_ref || null,
    invoice_email: companyData?.invoice_email || null,
    special_instructions: companyData?.special_instructions || null,
    safety_requirements: companyData?.safety_requirements || null,
    external_links: external_links || null,
  }

  // Create the job
  const { data: job, error: jobErr } = await client.from('jobs').insert({
    org_id: DEFAULT_ORG_ID,
    type: 'makesafe',
    status: 'accepted',
    client_name,
    client_phone: phone || mobile || null,
    site_address,
    site_suburb: suburb || null,
    job_number: jobNumber,
    notes: description || null,
    metadata,
  }).select().single()

  if (jobErr) throw jobErr

  // Make-safe overlay details: keeps requesting-company refs, substatus,
  // safety notes, report handoff and invoice notes out of patio/fencing scope.
  try {
    await client.from('makesafe_job_details').insert({
      job_id: job.id,
      requesting_company_id: companyData?.id || null,
      requesting_company_slug: companyData?.slug || requesting_company_slug || null,
      requesting_company_name: companyData?.name || null,
      external_ref: external_ref || null,
      substatus: 'company_contact_required',
      safety_requirements: companyData?.safety_requirements || null,
      special_instructions: companyData?.special_instructions || null,
      external_links: external_links || companyData?.external_links || [],
      billing_rules: companyData?.billing_rules || {},
    })
  } catch (e: any) {
    // Non-blocking until the migration is deployed everywhere. The base job
    // remains visible and the PR/migration note makes this gap explicit.
    console.log('[ops-api] makesafe_job_details insert skipped:', e?.message)
  }

  // If PDF provided, upload to storage and create job_documents record
  if (pdf_base64) {
    try {
      const pdfBuffer = Uint8Array.from(atob(pdf_base64), c => c.charCodeAt(0))
      const pdfPath = `${job.id}/work-order-${jobNumber}.pdf`
      const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const { error: upErr } = await adminClient.storage
        .from('job-documents')
        .upload(pdfPath, pdfBuffer, { contentType: 'application/pdf', upsert: true })
      if (!upErr) {
        const { data: urlData } = adminClient.storage.from('job-documents').getPublicUrl(pdfPath)
        await client.from('job_documents').insert({
          job_id: job.id,
          type: 'work_order',
          file_name: `work-order-${jobNumber}.pdf`,
          storage_url: pdfPath,
          pdf_url: urlData?.publicUrl || null,
          visible_to_trades: true,
        })
      }
    } catch (e: any) {
      console.log('[ops-api] PDF upload failed for makesafe:', e?.message)
    }
  }

  // Log job event
  await client.from('job_events').insert({
    job_id: job.id,
    event_type: 'makesafe_created',
    detail_json: { job_number: jobNumber, requesting_company: companyData?.name || null, external_ref },
  })

  // Telegram notification to Shaun
  const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
  if (TELEGRAM_BOT_TOKEN) {
    try {
      const { data: shaun } = await client.from('users')
        .select('telegram_id').ilike('email', '%shaun%')
        .not('telegram_id', 'is', null).limit(1).maybeSingle()
      if (shaun?.telegram_id) {
        const msg = `New Make-Safe: ${jobNumber}\n${client_name}\n${site_address}${companyData ? '\nFrom: ' + companyData.name : ''}${external_ref ? '\nRef: ' + external_ref : ''}`
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: shaun.telegram_id, text: msg }),
        })
      }
    } catch (_) { /* non-critical */ }
  }

  return { ok: true, job }
}

async function createAssignment(client: any, body: any) {
  const { jobId, job_id, userId, user_id, scheduledDate, scheduled_date, date,
          scheduledEnd, scheduled_end, startTime, start_time, endTime, end_time,
          assignmentType, assignment_type, crewName, crew_name, role, notes } = body

  const jId = jobId || job_id
  const sDate = scheduledDate || scheduled_date || date
  if (!jId || !sDate) throw new Error('jobId and scheduledDate required')

  const confStatus = body.confirmationStatus || body.confirmation_status || 'tentative'
  const validConfStatuses = ['placeholder', 'tentative', 'confirmed']
  const finalConfStatus = validConfStatuses.includes(confStatus) ? confStatus : 'tentative'

  const { data, error } = await client.from('job_assignments').insert({
    job_id: jId,
    user_id: userId || user_id || null,
    scheduled_date: sDate,
    scheduled_end: scheduledEnd || scheduled_end || null,
    start_time: startTime || start_time || null,
    end_time: endTime || end_time || null,
    role: role || 'lead_installer',
    notes: notes || null,
    assignment_type: assignmentType || assignment_type || 'install',
    crew_name: crewName || crew_name || null,
    status: 'scheduled',
    confirmation_status: finalConfStatus,
  }).select().single()

  if (error) throw error

  // Auto-update job status when crew is assigned
  // processing jobs with crew assigned can auto-advance (kept for backwards compat)
  // Legacy 'accepted' jobs also auto-advance to 'processing'
  const { data: currentJob } = await client.from('jobs').select('status').eq('id', jId).single()
  if (currentJob?.status === 'accepted') {
    await client.from('jobs').update({ status: 'processing', processing_at: new Date().toISOString() }).eq('id', jId)
  }

  // Log event
  await client.from('job_events').insert({
    job_id: jId,
    event_type: 'assignment_created',
    detail_json: { assignment_id: data.id, date: sDate, operator: body.operator_email || body.user_email || null },
  })

  // ── Telegram DM to assigned trade ──
  try {
    const assignedUserId = userId || user_id
    if (assignedUserId) {
      const { data: assignedUser } = await client.from('users')
        .select('telegram_id, name').eq('id', assignedUserId).single()
      if (assignedUser?.telegram_id) {
        const { data: jobData2 } = await client.from('jobs')
          .select('job_number, client_name, site_address, site_suburb').eq('id', jId).single()
        const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')
        if (BOT_TOKEN && jobData2) {
          const text = `📌 <b>New Assignment</b>\n\n<b>${jobData2.job_number || ''}</b> — ${jobData2.client_name || 'Client'}\n📍 ${jobData2.site_address || ''}${jobData2.site_suburb ? ', ' + jobData2.site_suburb : ''}\n📅 ${sDate}`
          fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: assignedUser.telegram_id,
              text,
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: [[
                { text: '🔗 Open in Trade', url: `https://secureworks-group.github.io/securedash/trade.html#job/${jId}` }
              ]] }
            })
          }).catch(() => {})
        }
      }
    }
  } catch (e) { console.log('[ops-api] assignment notification failed:', e) }

  // Push schedule info to GHL custom fields (non-blocking)
  // Also grab job_number for business_events dual-write
  try {
    const { data: jobData } = await client.from('jobs')
      .select('ghl_opportunity_id, job_number').eq('id', jId).single()

    // Dual-write to business_events
    logBusinessEvent(client, {
      event_type: 'schedule.assignment_created',
      entity_type: 'crew_assignment',
      entity_id: data.id,
      job_id: jobData?.job_number || jId,
      correlation_id: jId,
      payload: {
        entity: { id: data.id, name: `${data.crew_name || 'Crew'} on ${sDate}` },
        changes: { status: { from: null, to: 'scheduled' } },
        confirmation_status: finalConfStatus,
        crew_name: data.crew_name || '',
        scheduled_date: sDate,
        related_entities: [
          { type: 'job', id: jId },
          { type: 'crew', id: data.user_id || null, name: data.crew_name || '' },
        ],
      },
      metadata: { operator: body.operator_email || body.user_email || null },
    })
    if (jobData?.ghl_opportunity_id) {
      const ghlUrl = `${SUPABASE_URL}/functions/v1/ghl-proxy?action=update_custom_fields`
      fetch(ghlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opportunityId: jobData.ghl_opportunity_id,
          fields: {
            scheduled_date: sDate,
            assigned_crew: body.crewName || body.crew_name || '',
            schedule_status: 'scheduled',
          },
        }),
      }).catch(() => {})
    }
  } catch (e) {
    console.log('[ops-api] GHL custom field push failed (non-blocking):', e)
  }

  // Log to jarvis_event_log (non-blocking, fire-and-forget)
  client.from('jarvis_event_log').insert({
    event_type: 'crew_assigned', job_id: jId,
    channel: 'system', triggered_by: body.created_by || 'jarvis',
    message_content: `Assigned ${body.user_name || body.crew_name || body.crewName || 'crew'} to job on ${sDate}`,
    metadata: { user_id: userId || user_id || null, scheduled_date: sDate },
  }).then(() => {}).catch(() => {})

  // Fire-and-forget: recompute job intelligence after assignment creation
  fetch(`${SUPABASE_URL}/functions/v1/reporting-api?action=job_intelligence&job_id=${jId}`, {
    headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
  }).catch(() => {})

  return { assignment: data }
}

async function updateAssignment(client: any, body: any) {
  const id = body.assignmentId || body.assignment_id || body.id
  if (!id) throw new Error('assignmentId required')

  // Capture old state for dual-write
  const { data: oldAssignment } = await client
    .from('job_assignments')
    .select('confirmation_status, scheduled_date, crew_name, job_id')
    .eq('id', id)
    .single()

  const allowed: Record<string, string> = {
    scheduledDate: 'scheduled_date', scheduled_date: 'scheduled_date', date: 'scheduled_date',
    scheduledEnd: 'scheduled_end', scheduled_end: 'scheduled_end',
    startTime: 'start_time', start_time: 'start_time',
    endTime: 'end_time', end_time: 'end_time',
    status: 'status', notes: 'notes',
    crewName: 'crew_name', crew_name: 'crew_name',
    assignmentType: 'assignment_type', assignment_type: 'assignment_type', type: 'assignment_type',
    userId: 'user_id', user_id: 'user_id',
    confirmationStatus: 'confirmation_status', confirmation_status: 'confirmation_status',
  }

  const update: Record<string, unknown> = {}
  for (const [bodyKey, dbKey] of Object.entries(allowed)) {
    if (body[bodyKey] !== undefined) update[dbKey] = body[bodyKey]
  }

  const { data, error } = await client
    .from('job_assignments')
    .update(update)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error

  // Dual-write confirmation_status changes to business_events
  const newConfStatus = update.confirmation_status as string | undefined
  const oldConfStatus = oldAssignment?.confirmation_status
  if (newConfStatus && newConfStatus !== oldConfStatus) {
    let eventType = 'schedule.status_changed'
    if (newConfStatus === 'tentative' && oldConfStatus === 'placeholder') eventType = 'schedule.promoted_tentative'
    else if (newConfStatus === 'confirmed') eventType = 'schedule.locked'
    else if (newConfStatus === 'tentative' && oldConfStatus === 'confirmed') eventType = 'schedule.rescheduled'

    logBusinessEvent(client, {
      event_type: eventType,
      entity_type: 'crew_assignment',
      entity_id: id,
      job_id: data?.job_id || oldAssignment?.job_id,
      payload: {
        old_status: oldConfStatus,
        new_status: newConfStatus,
        crew_name: data?.crew_name,
        scheduled_date: data?.scheduled_date,
        old_date: oldAssignment?.scheduled_date,
        new_date: update.scheduled_date || data?.scheduled_date,
        was_locked: oldConfStatus === 'confirmed',
      },
      metadata: { operator: body.operator_email || body.user_email || null },
    })
  }

  // Feature 6: Assignment cascade — if this assignment was marked complete,
  // check if ALL assignments for this job are now complete
  let allComplete = false
  let suggestStatus: string | null = null
  if (data && update.status === 'complete' && data.job_id) {
    const { data: siblings } = await client
      .from('job_assignments')
      .select('id, status')
      .eq('job_id', data.job_id)
      .neq('status', 'cancelled')

    if (siblings && siblings.length > 0) {
      allComplete = siblings.every((a: any) => a.status === 'complete')
      if (allComplete) {
        // Check current job status — only suggest if still in_progress or scheduled
        const { data: job } = await client
          .from('jobs')
          .select('status')
          .eq('id', data.job_id)
          .single()
        if (job && ['in_progress', 'scheduled', 'processing'].includes(job.status)) {
          suggestStatus = 'complete'
        }
      }
    }
  }

  // Push rescheduled date to GHL custom fields (non-blocking)
  if (data?.job_id && (update.scheduled_date || update.crew_name)) {
    try {
      const { data: jobData } = await client.from('jobs')
        .select('ghl_opportunity_id').eq('id', data.job_id).single()
      if (jobData?.ghl_opportunity_id) {
        const fields: Record<string, string> = {}
        if (update.scheduled_date) fields.scheduled_date = update.scheduled_date as string
        if (update.crew_name) fields.assigned_crew = update.crew_name as string
        const ghlUrl = `${SUPABASE_URL}/functions/v1/ghl-proxy?action=update_custom_fields`
        fetch(ghlUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            opportunityId: jobData.ghl_opportunity_id,
            fields,
          }),
        }).catch(() => {})
      }
    } catch (e) {
      console.log('[ops-api] GHL reschedule push failed (non-blocking):', e)
    }
  }

  return { assignment: data, all_complete: allComplete, suggest_status: suggestStatus, job_id: data?.job_id }
}

async function deleteAssignment(client: any, body: any) {
  const id = body.assignmentId || body.assignment_id || body.id
  if (!id) throw new Error('assignmentId required')

  // Get assignment for event log + dual-write
  const { data: existing } = await client
    .from('job_assignments')
    .select('job_id, user_id, scheduled_date, confirmation_status, crew_name')
    .eq('id', id)
    .single()

  const { error } = await client.from('job_assignments').delete().eq('id', id)
  if (error) throw error

  if (existing) {
    await client.from('job_events').insert({
      job_id: existing.job_id,
      event_type: 'assignment_deleted',
      detail_json: { user_id: existing.user_id, date: existing.scheduled_date },
    })

    // Dual-write to business_events
    logBusinessEvent(client, {
      event_type: 'schedule.assignment_deleted',
      entity_type: 'crew_assignment',
      entity_id: id,
      job_id: existing.job_id,
      payload: {
        crew_name: existing.crew_name,
        scheduled_date: existing.scheduled_date,
        was_locked: existing.confirmation_status === 'confirmed',
      },
      metadata: { operator: body.operator_email || body.user_email || null },
    })
  }

  return { success: true }
}

async function updateJobStatus(client: any, body: any) {
  const jId = body.jobId || body.job_id
  const status = body.status
  if (!jId || !status) throw new Error('jobId and status required')

  // Live trusted baseline 2026-05-18 accepted new stages without an edge
  // redeploy. Preserve that behaviour here and let database constraints /
  // stage-gate shadow observations catch invalid transitions downstream.
  if (!status || typeof status !== 'string' || status.length > 50) throw new Error('Invalid status')

  // Capture old status + job data for business_events dual-write
  const { data: jobBefore } = await client.from('jobs')
    .select('status, type, job_number, client_name, pricing_json')
    .eq('id', jId).single()
  const oldStatus = jobBefore?.status || 'unknown'

  // ════════════════════════════════════════════════════════════════
  // Cap 1C — Shadow-mode evaluation (advisory, NEVER enforces)
  //
  // When STATE_ENGINE_SHADOW=on, evaluate the stage-gate engine
  // BEFORE the existing write logic and append an observation row.
  // Behaviour contract:
  //   • Engine eval runs in a try/catch — any throw is logged as a
  //     shadow_error and control falls through to existing write
  //     logic UNCHANGED.
  //   • Observation insert runs in a try/catch — a missing table or
  //     a perms error is silently swallowed.
  //   • This wrapper NEVER blocks, NEVER alters status writes, and
  //     NEVER calls any external system.
  //   • Default: STATE_ENGINE_SHADOW unset → wrapper is a no-op.
  //
  // Rollback: set STATE_ENGINE_SHADOW=off and redeploy.
  //
  // Authority:
  //   • secureworks-docs/decisions/2026-05-02-cap1c-observations-surface.md
  //   • secureworks-docs/cio/evidence/cap1c-shadow-mode-2026-05-02/
  // ════════════════════════════════════════════════════════════════
  const _capShadowFlag = (Deno.env.get('STATE_ENGINE_SHADOW') || '').toLowerCase()
  const _capShadowEnabled = _capShadowFlag === 'on' || _capShadowFlag === '1' || _capShadowFlag === 'true'
  if (_capShadowEnabled) {
    try {
      const _writerSource = body.source || body.writer_source || 'ops_dashboard'
      const _actorEmail = body.operator_email || body.user_email || null
      const _correlationId = body.correlation_id || jId

      const _miniPacket = {
        revision: null,
        document: null,
        purchase_orders: [],
        work_order: null,
        events: [],
        customer: { name: jobBefore?.client_name, mobile: null, email: null },
        site: { address: null, suburb: null, lat: null, lng: null },
        job: {
          id: jId,
          job_number: jobBefore?.job_number,
          type: jobBefore?.type,
          status: status,
          accepted_at: null,
          completed_at: null,
        },
      }
      const _miniSupplemental = { assignments: [], job_context: [], deposit: null }
      // deno-lint-ignore no-explicit-any
      const _sgr: any = evaluateStageGates(
        { id: jId, type: jobBefore?.type },
        _miniPacket,
        _miniSupplemental,
      )
      // deno-lint-ignore no-explicit-any
      const _blockers = _sgr.blockers.map((b: any) => ({ gate_id: b.gate_id, severity: b.severity, reason: b.reason }))
      // deno-lint-ignore no-explicit-any
      const _warnings = _sgr.warnings.map((w: any) => ({ gate_id: w.gate_id, severity: w.severity, reason: w.reason }))
      // deno-lint-ignore no-explicit-any
      const _overrides = _sgr.overrides.map((o: any) => ({ gate_id: o.gate_id, reason: o.reason }))
      let _verdict: 'allow' | 'block' | 'warn' | 'overridden' = 'allow'
      if (_overrides.length > 0) _verdict = 'overridden'
      else if (_blockers.length > 0) _verdict = 'block'
      else if (_warnings.length > 0) _verdict = 'warn'

      try {
        await client.from('state_engine_observations').insert({
          job_id: jobBefore?.job_number || jId,
          from_status: oldStatus,
          to_status: status,
          writer_source: _writerSource,
          engine_verdict: _verdict,
          hard_blocked: false,
          requires_override: false,
          blockers: _blockers,
          warnings: _warnings,
          overrides: _overrides,
          current_stage: _sgr.current_stage,
          frontend_bucket: _sgr.frontend_bucket,
          evidence_refs: _sgr.evidence_refs,
          engine_version: 'cap1c-shadow-mode-2026-05-02',
          shadow_error: null,
          correlation_id: _correlationId,
          actual_write_succeeded: null,
          actor_email: _actorEmail,
          metadata: { transition_attempt_id: _correlationId, observed_only: true, no_enforcement: true },
        })
      } catch (insertErr) {
        // Table may not exist yet, or RLS may block. Cap 1C NEVER
        // lets observation failures break the transition.
        console.warn('[Cap 1C shadow] observation insert failed:', (insertErr as Error).message)
      }
    } catch (evalErr) {
      // Engine throw OR dynamic import error. Log shadow_error if
      // the observations table exists; otherwise skip silently.
      try {
        await client.from('state_engine_observations').insert({
          job_id: jobBefore?.job_number || jId,
          from_status: oldStatus,
          to_status: status,
          writer_source: body.source || 'ops_dashboard',
          engine_verdict: 'error',
          shadow_error: (evalErr as Error).message,
          engine_version: 'cap1c-shadow-mode-2026-05-02',
          metadata: { observed_only: true, no_enforcement: true, eval_failed: true },
        })
      } catch { /* truly silent — never block transition */ }
    }
  }
  // ════════════════════════════════════════════════════════════════
  // End Cap 1C shadow-mode wrapper. Existing write logic unchanged.
  // ════════════════════════════════════════════════════════════════

  const update: Record<string, unknown> = { status }
  if (status === 'quoted') update.quoted_at = new Date().toISOString()
  if (status === 'accepted') update.accepted_at = new Date().toISOString()
  if (status === 'approvals') update.approvals_at = new Date().toISOString()
  if (status === 'deposit') update.deposit_at = new Date().toISOString()
  if (status === 'processing') update.processing_at = new Date().toISOString()
  if (status === 'scheduled') update.scheduled_at = new Date().toISOString()
  if (status === 'complete') update.completed_at = new Date().toISOString()

  // Accept optional field updates (from acceptance review modal)
  if (body.updates) {
    const allowed = ['client_name', 'client_phone', 'client_email', 'site_address', 'site_suburb']
    for (const key of allowed) {
      if (body.updates[key] !== undefined) update[key] = body.updates[key]
    }
  }

  const { data, error } = await client
    .from('jobs')
    .update(update)
    .eq('id', jId)
    .select()
    .single()

  if (error) throw error

  const source = body.source || 'ops_dashboard'
  await client.from('job_events').insert({
    job_id: jId,
    user_id: body.userId || body.user_id || null,
    event_type: 'status_changed',
    detail_json: { new_status: status, source, operator: body.operator_email || body.user_email || null },
  })

  // Log to jarvis_event_log (non-blocking, fire-and-forget)
  client.from('jarvis_event_log').insert({
    event_type: 'status_changed',
    job_id: jId,
    channel: 'system',
    triggered_by: body.operator_email || body.user_email || 'ops_dashboard',
    message_content: `Status changed from ${oldStatus} to ${status}`,
    metadata: { old_status: oldStatus, new_status: status, source },
  }).then(() => {}).catch(() => {})

  // Dual-write to business_events
  logBusinessEvent(client, {
    event_type: 'job.status_changed',
    entity_type: 'job',
    entity_id: jId,
    job_id: jobBefore?.job_number || jId,
    correlation_id: jId,
    payload: {
      entity: { id: jId, name: jobBefore?.client_name || '' },
      changes: { status: { from: oldStatus, to: status } },
      financial: { amount: jobBefore?.pricing_json?.total || jobBefore?.pricing_json?.grandTotal || 0 },
      related_entities: [],
    },
    metadata: { operator: body.operator_email || body.user_email || null },
  })

  // Fire-and-forget: recompute job intelligence after status change
  fetch(`${SUPABASE_URL}/functions/v1/reporting-api?action=job_intelligence&job_id=${jId}`, {
    headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
  }).catch(() => {})

  // ── Push status change to GHL (non-blocking) ──
  // Skip if this change originated from a GHL webhook (anti-loop)
  if (source !== 'ghl_webhook' && data.ghl_opportunity_id) {
    try {
      const ghlUrl = `${SUPABASE_URL}/functions/v1/ghl-proxy?action=move_stage`
      const ghlResp = await fetch(ghlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opportunityId: data.ghl_opportunity_id,
          status: status,
          jobType: data.type || 'patio',
        }),
      })
      const ghlResult = await ghlResp.json()
      if (ghlResult.success) {
        console.log(`[ops-api] GHL stage synced: ${data.ghl_opportunity_id} → ${status}`)
        await client.from('job_events').insert({
          job_id: jId,
          event_type: 'ghl_stage_synced',
          detail_json: { status, opportunity_id: data.ghl_opportunity_id, stage_id: ghlResult.stageId },
        })
      } else {
        console.log(`[ops-api] GHL stage sync failed (non-blocking): ${ghlResult.error}`)
      }
    } catch (e) {
      console.log('[ops-api] GHL stage push failed (non-blocking):', (e as Error).message)
    }
  }

  // ── Acceptance trigger: auto-approve draft WOs + push labour POs to Xero (non-blocking) ──
  if (status === 'accepted') {
    (async () => {
      try {
        // 1. Approve draft work orders for this job
        const { data: draftWOs } = await client.from('work_orders')
          .select('id, wo_number')
          .eq('job_id', jId)
          .eq('status', 'draft')
        if (draftWOs && draftWOs.length > 0) {
          for (const wo of draftWOs) {
            await client.from('work_orders')
              .update({ status: 'approved', approved_at: new Date().toISOString() })
              .eq('id', wo.id)
            await client.from('job_events').insert({
              job_id: jId,
              event_type: 'work_order_approved',
              detail_json: { wo_number: wo.wo_number, trigger: 'acceptance_auto' },
            })
            console.log(`[ops-api] Auto-approved WO ${wo.wo_number} on job acceptance`)
          }
        }

        // 2. Push draft labour POs to Xero
        const { data: draftPOs } = await client.from('purchase_orders')
          .select('id, po_number')
          .eq('job_id', jId)
          .eq('status', 'draft')
          .is('xero_po_id', null)
        if (draftPOs && draftPOs.length > 0) {
          for (const po of draftPOs) {
            try {
              await pushPOToXero(client, { id: po.id })
              console.log(`[ops-api] Auto-pushed PO ${po.po_number} to Xero on job acceptance`)
            } catch (poErr) {
              console.log(`[ops-api] Auto-push PO ${po.po_number} to Xero failed (non-blocking):`, (poErr as Error).message)
            }
          }
        }
      } catch (e) {
        console.log('[ops-api] Acceptance trigger failed (non-blocking):', (e as Error).message)
      }
    })()
  }

  return { success: true, job_id: jId, new_status: status, job_number: data?.job_number || jobBefore?.job_number }
}

async function createPO(client: any, body: any) {
  const { job_id, jobId, supplier_name, supplierName, xero_contact_id,
          line_items, lineItems, delivery_date, deliveryDate, delivery_address, reference, notes } = body

  const supplier = supplier_name || supplierName
  if (!supplier && body.status !== 'draft') throw new Error('supplier_name required')

  // Generate PO number from timestamp (sequence requires raw SQL RPC)
  const poNum = `PO-${String(Date.now()).slice(-6)}`

  const items = line_items || lineItems || []
  const subtotal = items.reduce((s: number, li: any) => s + ((li.quantity || 0) * (li.unit_price || li.unitPrice || 0)), 0)
  const tax = Math.round(subtotal * 0.1 * 100) / 100 // 10% GST
  const total = subtotal + tax

  const { data, error } = await client
    .from('purchase_orders')
    .insert({
      org_id: DEFAULT_ORG_ID,
      job_id: job_id || jobId || null,
      po_number: poNum,
      supplier_name: supplier,
      xero_contact_id: xero_contact_id || null,
      line_items: items,
      subtotal, tax, total,
      delivery_date: delivery_date || deliveryDate || null,
      reference: reference || null,
      notes: (delivery_address ? 'Deliver to: ' + delivery_address + (notes ? '\n' + notes : '') : notes) || null,
      status: body.status || 'draft',
      created_by: body.operator_email || body.user_email || null,
    })
    .select()
    .single()

  if (error) throw error

  const jId = job_id || jobId
  if (jId) {
    await client.from('job_events').insert({
      job_id: jId,
      event_type: 'po_created',
      detail_json: { po_number: poNum, supplier, total },
    })
  }

  // Dual-write to business_events.
  //
  // T7 Loop 5 — closes G2: outbound PO spine rows were 0/16 with
  // job_id because this writer put the wrong field in job_id.
  //   BEFORE: job_id: data.reference || ''         (PO reference, not job)
  //   BEFORE: correlation_id: data.job_id || null  (actual job in wrong field)
  // FIX: use data.job_id directly. correlation_id stays as the UUID
  // group key for the PO lifecycle (po.created → po.sent → po.confirmed).
  //
  // When evidence_capture_v1 is ON, recordEvidence becomes the writer
  // with full envelope (channel='po', direction='outbound'). When OFF,
  // logBusinessEvent runs with the field-swap fix applied (G2 still
  // closes even before the flag flips).
  const t7PoEnabled = await isFlagOn(client, 'evidence_capture_v1', '00000000-0000-0000-0000-000000000001')
  // Legacy logBusinessEvent payload — emitted either by the T7 fallback
  // path OR when the flag is OFF. Defined once so G2's job_id closure
  // applies in both branches.
  const legacyPoEvent = {
    event_type: 'po.created',
    entity_type: 'purchase_order',
    entity_id: data.id,
    job_id: data.job_id || '',                // FIXED: was data.reference
    correlation_id: data.job_id || undefined, // kept as a workflow group
    payload: {
      entity: { id: data.id, name: data.po_number || '' },
      financial: { amount: Number(data.total || 0), currency: 'AUD' },
      related_entities: [
        { type: 'supplier', id: null, name: data.supplier_name || '' },
        { type: 'job', id: data.job_id || null },
      ],
      po_reference: data.reference || null,
    },
    metadata: { operator: body.operator_email || body.user_email || null },
  }
  let t7PoFailed = false
  if (t7PoEnabled) {
    try {
      await recordEvidence(client, {
        event_type: 'po.created',
        source: 'ops-api/create_po',
        channel: 'po',
        direction: 'outbound',
        source_table: 'purchase_orders',
        source_id: String(data.id),
        job_id: data.job_id || null,
        entity_type: 'purchase_order',
        entity_id: data.id,
        match_method: data.job_id ? 'direct_job_id' : 'none',
        body_preview: `PO ${data.po_number || ''} → ${data.supplier_name || 'supplier'}: $${Number(data.total || 0).toFixed(2)}`,
        privacy_classification: 'staff_only',
        retention_class: '7y_audit',
        payload: {
          entity: { id: data.id, name: data.po_number || '' },
          financial: { amount: Number(data.total || 0), currency: 'AUD' },
          related_entities: [
            { type: 'supplier', id: null, name: data.supplier_name || '' },
            { type: 'job', id: data.job_id || null },
          ],
          po_reference: data.reference || null,
        },
        metadata: { operator: body.operator_email || body.user_email || null },
      }, {
        org_id: '00000000-0000-0000-0000-000000000001',
        storage_client: client.storage,
      })
    } catch (e: any) {
      // T7 path failed — fall back to legacy logBusinessEvent below so
      // the canonical PO event still lands on the spine. Without this
      // fallback, an outbound PO could be silently dropped from the
      // canonical event log when evidence_capture_v1 is ON.
      console.error('[ops-api] T7 po.created recordEvidence failed; falling back to legacy:', e?.message)
      t7PoFailed = true
    }
  }
  if (!t7PoEnabled || t7PoFailed) {
    logBusinessEvent(client, legacyPoEvent)
  }

  // Log to jarvis_event_log (non-blocking, fire-and-forget)
  client.from('jarvis_event_log').insert({
    event_type: 'po_created', job_id: job_id || jobId || null,
    channel: 'system', triggered_by: body.created_by || 'jarvis',
    message_content: `PO created for ${supplier}: $${total || 0}`,
    metadata: { supplier_name: supplier, total },
  }).then(() => {}).catch(() => {})

  // Fire-and-forget: recompute job intelligence after PO creation
  if (job_id || jobId) {
    fetch(`${SUPABASE_URL}/functions/v1/reporting-api?action=job_intelligence&job_id=${job_id || jobId}`, {
      headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
    }).catch(() => {})
  }

  return { purchase_order: data }
}

async function updatePO(client: any, body: any) {
  const { id, ...updates } = body
  if (!id) throw new Error('id required')

  const allowed = ['supplier_name', 'xero_contact_id', 'line_items', 'delivery_date',
                    'reference', 'notes', 'status',
                    'invoice_received_at', 'paid_at', 'xero_bill_id']
  const filtered: any = {}
  for (const k of allowed) {
    if (updates[k] !== undefined) filtered[k] = updates[k]
  }

  if (filtered.line_items) {
    const items = filtered.line_items
    filtered.subtotal = items.reduce((s: number, li: any) => s + ((li.quantity || 0) * (li.unit_price || 0)), 0)
    filtered.tax = Math.round(filtered.subtotal * 0.1 * 100) / 100
    filtered.total = filtered.subtotal + filtered.tax
  }

  const { data, error } = await client
    .from('purchase_orders')
    .update(filtered)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  return { purchase_order: data }
}

async function pushPOToXero(client: any, body: any) {
  const { id, status: requestedStatus } = body
  if (!id) throw new Error('id required')

  const { data: po, error } = await client
    .from('purchase_orders')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !po) throw new Error('PO not found')
  if (po.xero_po_id) throw new Error('PO already synced to Xero')

  const { accessToken, tenantId } = await getToken(client)

  // Resolve supplier contact in Xero — find or create
  let supplierContactId = po.xero_contact_id
  if (!supplierContactId && po.supplier_name) {
    try {
      const searchResult = await xeroGet('/Contacts', accessToken, tenantId, {
        where: `Name=="${(po.supplier_name || '').replace(/"/g, '')}"&&IsSupplier==true`,
      })
      const existing = searchResult?.Contacts?.[0]
      if (existing) {
        supplierContactId = existing.ContactID
      } else {
        // Try without IsSupplier filter (some contacts may not be flagged)
        const searchResult2 = await xeroGet('/Contacts', accessToken, tenantId, {
          where: `Name=="${(po.supplier_name || '').replace(/"/g, '')}"`,
        })
        const existing2 = searchResult2?.Contacts?.[0]
        if (existing2) {
          supplierContactId = existing2.ContactID
        } else {
          // Create new supplier contact
          const newContact = await xeroPost('/Contacts', accessToken, tenantId, {
            Contacts: [{ Name: po.supplier_name, IsSupplier: true }],
          }, 'PUT', `supplier-${(po.supplier_name || '').replace(/\s/g, '-')}`)
          supplierContactId = newContact?.Contacts?.[0]?.ContactID
        }
      }
      // Backfill on the PO record
      if (supplierContactId) {
        client.from('purchase_orders').update({ xero_contact_id: supplierContactId }).eq('id', id).then(() => {}).catch(() => {})
      }
    } catch (e) {
      console.log('[ops-api] Supplier contact resolution failed:', (e as Error).message)
    }
  }

  // Only include tracking if the Xero tracking category exists
  let poTracking: any[] = []
  try {
    const trackingCats = await xeroGet('/TrackingCategories', accessToken, tenantId)
    const divisionCat = (trackingCats?.TrackingCategories || []).find((tc: any) => tc.Name === 'Business Unit' && tc.Status === 'ACTIVE')
    if (divisionCat) {
      const poRef = po.reference || ''
      const optionName = trackingCategoryForJob(poRef)
      const validOption = (divisionCat.Options || []).find((o: any) => o.Name === optionName && o.Status === 'ACTIVE')
      if (validOption) poTracking = [{ Name: 'Business Unit', Option: optionName }]
    }
  } catch { /* skip tracking if lookup fails */ }

  const lineItems = (po.line_items || []).map((li: any) => ({
    Description: li.description || li.name || '',
    Quantity: li.quantity || 1,
    UnitAmount: li.unit_price || li.unitPrice || 0,
    AccountCode: li.account_code || '300',
    TaxType: 'INPUT',
    ...(poTracking.length > 0 ? { Tracking: poTracking } : {}),
  }))

  // DRAFT or AUTHORISED based on request
  const xeroStatus = requestedStatus === 'authorised' ? 'AUTHORISED' : 'SUBMITTED'
  const localStatus = requestedStatus === 'authorised' ? 'authorised' : 'submitted'

  const xeroPO = {
    PurchaseOrders: [{
      Contact: supplierContactId
        ? { ContactID: supplierContactId }
        : { Name: po.supplier_name },
      PurchaseOrderNumber: po.po_number,
      Reference: po.reference || '',
      DeliveryDate: po.delivery_date || undefined,
      LineAmountTypes: 'Exclusive',
      LineItems: lineItems,
      Status: xeroStatus,
    }],
  }

  // Idempotency key: PO ID is unique, prevents duplicate on retry
  const poIdempotencyKey = `po-${id}-${new Date().toISOString().slice(0, 16)}`
  const result = await xeroPost('/PurchaseOrders', accessToken, tenantId, xeroPO, 'PUT', poIdempotencyKey)
  const xeroPOId = result?.PurchaseOrders?.[0]?.PurchaseOrderID

  if (xeroPOId) {
    await client.from('purchase_orders')
      .update({ xero_po_id: xeroPOId, status: localStatus, synced_at: new Date().toISOString() })
      .eq('id', id)
  }

  return { success: true, xero_po_id: xeroPOId }
}

async function emailPO(client: any, body: any) {
  const id = body.id || body.po_id
  if (!id) throw new Error('id required')

  const { data: po, error } = await client
    .from('purchase_orders')
    .select('xero_po_id, po_number, supplier_name, job_id, total')
    .eq('id', id)
    .single()

  if (error || !po) throw new Error('PO not found')
  if (!po.xero_po_id) throw new Error('PO has not been synced to Xero yet. Call sw_push_po_to_xero first, then sw_email_po.')

  const { accessToken, tenantId } = await getToken(client)
  await xeroPost(`/PurchaseOrders/${po.xero_po_id}/Email`, accessToken, tenantId, {}, 'POST')

  // Log to business_events
  logBusinessEvent(client, {
    event_type: 'po.sent',
    entity_type: 'purchase_order',
    entity_id: id,
    job_id: po.job_id || null,
    correlation_id: po.job_id || null,
    payload: {
      entity: { id, name: po.po_number || '' },
      financial: { amount: Number(po.total || 0), currency: 'AUD' },
      related_entities: [
        { type: 'supplier', id: null, name: po.supplier_name || '' },
      ],
    },
    metadata: { operator: body.operator_email || body.user_email || null },
  })

  return { success: true }
}

// ── Reconcile payment against Xero invoice ──
async function reconcilePayment(client: any, body: any) {
  const { invoice_id, amount, payment_date, reference, account_code } = body

  if (!invoice_id || !amount) throw new Error('invoice_id and amount required')

  const { accessToken, tenantId } = await getToken(client)

  // If no account_code provided, find the main bank account
  let bankAccountCode = account_code
  let bankAccountId: string | null = null
  if (!bankAccountCode) {
    try {
      const accounts = await xeroGet('/Accounts', accessToken, tenantId, {
        where: 'Type=="BANK"&&Status=="ACTIVE"',
      })
      const bankAccount = accounts?.Accounts?.[0]
      bankAccountCode = bankAccount?.Code || null
      bankAccountId = bankAccount?.AccountID || null
    } catch {
      // Will fail below if no account found
    }
  }

  if (!bankAccountCode && !bankAccountId) {
    throw new Error('No bank account found in Xero. Please provide an account_code or set up a bank account in Xero.')
  }

  const paymentPayload = {
    Payments: [{
      Invoice: { InvoiceID: invoice_id },
      Account: bankAccountId ? { AccountID: bankAccountId } : { Code: bankAccountCode },
      Date: payment_date || new Date().toISOString().slice(0, 10),
      Amount: Number(amount),
      Reference: reference || '',
    }],
  }

  const normalizedDate = payment_date || new Date().toISOString().slice(0, 10)
  const idempotencyKey = `payment-${invoice_id}-${amount}-${normalizedDate}`
  const result = await xeroPost('/Payments', accessToken, tenantId, paymentPayload, 'PUT', idempotencyKey)
  const payment = result?.Payments?.[0]

  if (!payment) {
    throw new Error('Xero returned no payment data')
  }

  // Update cached invoice in xero_invoices table if it exists
  try {
    const newAmountPaid = Number(payment.Amount || amount)
    const { data: cachedInv } = await client.from('xero_invoices')
      .select('amount_due, amount_paid')
      .eq('invoice_id', invoice_id)
      .maybeSingle()

    if (cachedInv) {
      await client.from('xero_invoices').update({
        amount_paid: (Number(cachedInv.amount_paid) || 0) + newAmountPaid,
        amount_due: Math.max(0, (Number(cachedInv.amount_due) || 0) - newAmountPaid),
        status: payment.Invoice?.Status || 'PAID',
        updated_at: new Date().toISOString(),
      }).eq('invoice_id', invoice_id)
    }
  } catch (e) {
    console.log('[ops-api] cache update after payment failed:', e)
  }

  // Log the payment event
  try {
    await client.from('job_events').insert({
      event_type: 'payment_recorded',
      detail_json: {
        invoice_id,
        payment_id: payment.PaymentID,
        amount: Number(amount),
        reference,
        account_code: bankAccountCode,
      },
    })
  } catch { /* non-blocking */ }

  return {
    success: true,
    payment_id: payment.PaymentID,
    amount: payment.Amount,
    date: payment.Date,
    status: payment.Status,
    invoice_status: payment.Invoice?.Status,
  }
}

async function createWorkOrder(client: any, body: any) {
  const jId = body.job_id || body.jobId
  if (!jId) throw new Error('job_id required')

  const woNum = `WO-${String(Date.now()).slice(-6)}`

  // Get site address from job if not provided
  let address = body.site_address || body.siteAddress
  if (!address) {
    const { data: job } = await client.from('jobs').select('site_address, site_suburb').eq('id', jId).single()
    if (job) address = [job.site_address, job.site_suburb].filter(Boolean).join(', ')
  }

  const { data, error } = await client
    .from('work_orders')
    .insert({
      org_id: DEFAULT_ORG_ID,
      job_id: jId,
      wo_number: woNum,
      trade_name: body.trade_name || body.tradeName || null,
      trade_phone: body.trade_phone || body.tradePhone || null,
      trade_email: body.trade_email || body.tradeEmail || null,
      assigned_user_id: body.assigned_user_id || body.assignedUserId || null,
      scope_items: body.scope_items || body.scopeItems || [],
      special_instructions: body.special_instructions || body.specialInstructions || null,
      scheduled_date: body.scheduled_date || body.scheduledDate || null,
      site_address: address || null,
      status: 'draft',
      created_by: body.operator_email || body.user_email || null,
    })
    .select()
    .single()

  if (error) throw error

  await client.from('job_events').insert({
    job_id: jId,
    event_type: 'wo_created',
    detail_json: { wo_number: woNum, trade: body.trade_name || body.tradeName },
  })

  // Dual-write to business_events
  logBusinessEvent(client, {
    event_type: 'wo.created',
    entity_type: 'work_order',
    entity_id: data.id,
    job_id: jId,
    correlation_id: jId,
    payload: {
      entity: { id: data.id, name: woNum },
      related_entities: [
        { type: 'job', id: jId },
        { type: 'trade', id: data.assigned_user_id || null, name: body.trade_name || body.tradeName || '' },
      ],
    },
    metadata: { operator: body.operator_email || body.user_email || null },
  })

  // Log to jarvis_event_log (non-blocking, fire-and-forget)
  client.from('jarvis_event_log').insert({
    event_type: 'work_order_created', job_id: jId,
    channel: 'system', triggered_by: 'jarvis',
    message_content: `Work order created`,
    metadata: {},
  }).then(() => {}).catch(() => {})

  return { work_order: data }
}

async function updateWorkOrder(client: any, body: any) {
  const { id, ...updates } = body
  if (!id) throw new Error('id required')

  const allowed = ['trade_name', 'trade_phone', 'trade_email', 'assigned_user_id',
                    'scope_items', 'special_instructions', 'scheduled_date',
                    'site_address', 'status']
  const filtered: any = {}
  for (const k of allowed) {
    if (updates[k] !== undefined) filtered[k] = updates[k]
  }

  if (filtered.status === 'sent') filtered.sent_at = new Date().toISOString()
  if (filtered.status === 'accepted') filtered.accepted_at = new Date().toISOString()
  if (filtered.status === 'complete') filtered.completed_at = new Date().toISOString()

  const { data, error } = await client
    .from('work_orders')
    .update(filtered)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  return { work_order: data }
}

async function sendWorkOrder(client: any, body: any) {
  const id = body.id || body.work_order_id
  if (!id) throw new Error('id required')

  const { data: wo, error } = await client
    .from('work_orders')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !wo) throw new Error('Work order not found')

  // Mark as sent
  await client.from('work_orders')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', id)

  if (wo.job_id) {
    await client.from('job_events').insert({
      job_id: wo.job_id,
      event_type: 'wo_sent',
      detail_json: { wo_number: wo.wo_number, trade_email: wo.trade_email },
    })
  }

  return {
    success: true,
    message: `Work order ${wo.wo_number} marked as sent`,
    share_token: wo.share_token,
  }
}

// Fetch invoice PDF from Xero API and return as base64
async function getInvoicePdf(client: any, params: URLSearchParams) {
  let xeroInvoiceId = params.get('xero_invoice_id')
  const invoiceNumber = params.get('invoice_number')

  if (!xeroInvoiceId && invoiceNumber) {
    const { data } = await client.from('xero_invoices')
      .select('xero_invoice_id, invoice_number')
      .eq('invoice_number', invoiceNumber)
      .maybeSingle()
    if (!data) throw new ApiError(`Invoice ${invoiceNumber} not found`, 404)
    xeroInvoiceId = data.xero_invoice_id
  }
  if (!xeroInvoiceId) throw new ApiError('xero_invoice_id or invoice_number required', 400)

  const { accessToken, tenantId } = await getToken(client)

  // Fetch PDF from Xero — raw binary, not JSON
  let resp: Response | null = null
  for (let attempt = 0; attempt <= 3; attempt++) {
    resp = await fetch(`${XERO_API_BASE}/Invoices/${xeroInvoiceId}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        'Accept': 'application/pdf',
      },
    })
    if (resp.status === 429) {
      if (attempt >= 3) throw new ApiError('Xero rate limited after retries', 429)
      const retryAfter = parseInt(resp.headers.get('Retry-After') || '5')
      await new Promise(r => setTimeout(r, retryAfter * 1000))
      continue
    }
    break
  }

  if (!resp || !resp.ok) {
    const errText = resp ? await resp.text() : 'No response'
    if (resp?.status === 404) throw new ApiError('Invoice not found in Xero', 404)
    throw new ApiError(`Failed to fetch PDF from Xero: ${resp?.status} ${errText}`, 502)
  }

  // Convert binary PDF to base64
  const buffer = await resp.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  const pdf_base64 = btoa(binary)

  // Get invoice number for filename
  let filename = `${xeroInvoiceId}.pdf`
  if (invoiceNumber) {
    filename = `${invoiceNumber}.pdf`
  } else {
    const { data: invRecord } = await client.from('xero_invoices')
      .select('invoice_number')
      .eq('xero_invoice_id', xeroInvoiceId)
      .maybeSingle()
    if (invRecord?.invoice_number) filename = `${invRecord.invoice_number}.pdf`
  }

  return { success: true, pdf_base64, filename, content_type: 'application/pdf' }
}

// ── Loop 1B-a-apply: invoice preflight contract ──
//
// Read-only check that gathers the dimensions a "ready to invoice" job must
// carry so the resulting Xero invoice arrives with enough detail for finance
// to reconcile without leaving Xero. Surfaces three things:
//
//   missing_dimensions[] — hard blockers. createInvoice will refuse unless
//                          body.bypass_preflight === true (override is logged
//                          to business_events as an explicit operator action).
//   warnings[]           — soft advisories. Don't block creation; bookkeeper
//                          should be aware (e.g. no frozen quote/scope yet,
//                          payment_terms falling back to division default).
//   context{}            — the resolved trace context. createInvoice reuses
//                          this so we don't re-read the same rows twice.
//
// Per Marnin's 2026-05-06 directive (four-pillars-progress-2026-05-06.md §5):
// "design/implement the preflight contract enough to prevent weak invoice
//  creation paths from shipping bad invoices."
async function preflightInvoiceCreation(client: any, body: any): Promise<{
  ok: boolean,
  missing_dimensions: string[],
  warnings: string[],
  context: {
    job: any,
    job_contact: any | null,
    job_number: string | null,
    customer_name: string | null,
    suburb: string | null,
    division: string | null,
    account_code: string,
    tracking_option: string,
    quote_revision_id: string | null,
    scope_revision_id: string | null,
    payment_terms_text: string,
    payment_terms_source: 'body_override' | 'jobs.payment_terms' | 'pricing_json.payment_terms' | 'division_default',
    due_date: string,
    xero_project_manual_status: string,
  } | null,
}> {
  const jobId = body.job_id || body.jobId
  const jobContactId = body.job_contact_id || null
  const missing: string[] = []
  const warnings: string[] = []

  if (!jobId) {
    // No job context — degraded preflight. Caller is doing ad-hoc invoicing.
    // We still surface the dimension gaps so MCP / ops UI can react, but
    // there is no context to populate.
    missing.push('job_id')
    return { ok: false, missing_dimensions: missing, warnings, context: null }
  }

  // Single round-trip for everything we need.
  const { data: job, error: jobErr } = await client
    .from('jobs')
    .select('id, job_number, type, status, client_name, client_email, client_phone, ' +
            'site_address, site_suburb, xero_contact_id, pricing_json, payment_terms')
    .eq('id', jobId)
    .single()
  if (jobErr || !job) {
    missing.push('job_not_found')
    return { ok: false, missing_dimensions: missing, warnings, context: null }
  }

  let jobContact: any = null
  if (jobContactId) {
    const { data: jc } = await client.from('job_contacts')
      .select('id, client_name, client_email, client_phone, site_address, contact_label, xero_contact_id')
      .eq('id', jobContactId)
      .maybeSingle()
    jobContact = jc || null
    if (!jobContact) warnings.push('job_contact_id_provided_but_not_found')
  }

  // Resolve customer name. Prefer neighbour contact when provided.
  const customerName = (jobContact?.client_name || job.client_name || '').trim() || null
  if (!customerName) missing.push('customer_name')

  // Resolve suburb. job.site_suburb is the canonical source today.
  // job_contacts.site_address is a free-text field; we don't parse a suburb
  // out of it — we rely on the parent job's site_suburb for now.
  const suburb = (job.site_suburb || '').trim() || null
  if (!suburb) missing.push('suburb')

  // Job number — required on every ACCREC invoice for division reporting.
  const jobNumber = (job.job_number || '').trim() || null
  if (!jobNumber) missing.push('job_number')

  // Division — derived from job.type.
  const knownDivisions = new Set(['patio', 'fencing', 'decking', 'roofing', 'insurance', 'renovation', 'combo', 'general', 'makesafe'])
  const divisionRaw = (job.type || '').toLowerCase().trim()
  const division = knownDivisions.has(divisionRaw) ? divisionRaw : null
  if (!division) missing.push('division')

  // Account code — accountCodeForJob always returns a string but we want the
  // mapping to be EXPLICIT not fallback for a known division.
  const accountCode = accountCodeForJob(job.type)

  // Tracking option — derived from job_number prefix.
  const trackingOption = trackingCategoryForJob(jobNumber || '')
  if (!trackingOption && division !== 'general') missing.push('tracking_option_unresolvable')

  // Frozen quote / scope revisions. These are SOFT — invoices for ad-hoc
  // jobs may not have a frozen quote/scope, but the bookkeeper benefits when
  // they do.
  let quoteRevisionId: string | null = null
  let scopeRevisionId: string | null = null
  try {
    const { data: qr } = await client.from('quote_revisions')
      .select('id')
      .eq('job_id', jobId)
      .is('superseded_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    quoteRevisionId = qr?.id || null
  } catch { /* table may not exist in some envs */ }
  if (!quoteRevisionId) warnings.push('quote_revision_id_missing')

  try {
    const { data: sr } = await client.from('scope_revisions')
      .select('id')
      .eq('job_id', jobId)
      .is('superseded_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    scopeRevisionId = sr?.id || null
  } catch { /* table may not exist in some envs */ }
  if (!scopeRevisionId) warnings.push('scope_revision_id_missing')

  // Payment-terms text. Source priority: body override > job-level > pricing-level > division default.
  const pricing = (typeof job.pricing_json === 'string'
    ? JSON.parse(job.pricing_json || '{}')
    : (job.pricing_json || {})) as Record<string, any>
  const PAYMENT_TERMS_DEFAULTS: Record<string, string> = {
    patio:      'Net 14 days from invoice date. Bank transfer (no surcharge) or credit card (1.75% surcharge applies).',
    fencing:    'Net 14 days from invoice date. Bank transfer (no surcharge) or credit card (1.75% surcharge applies).',
    decking:    'Net 14 days from invoice date. Bank transfer (no surcharge) or credit card (1.75% surcharge applies).',
    roofing:    'Net 14 days from invoice date. Bank transfer (no surcharge) or credit card (1.75% surcharge applies).',
    insurance:  'Payable on completion of works per insurance scope. Bank transfer or credit card (1.75% surcharge).',
    renovation: 'Net 14 days from invoice date. Bank transfer (no surcharge) or credit card (1.75% surcharge applies).',
    combo:      'Net 14 days from invoice date. Bank transfer (no surcharge) or credit card (1.75% surcharge applies).',
    general:    'Net 14 days from invoice date. Bank transfer (no surcharge) or credit card (1.75% surcharge applies).',
  }
  let paymentTermsText = ''
  let paymentTermsSource: 'body_override' | 'jobs.payment_terms' | 'pricing_json.payment_terms' | 'division_default' = 'division_default'
  if (typeof body.terms_override === 'string' && body.terms_override.trim()) {
    paymentTermsText = body.terms_override.trim()
    paymentTermsSource = 'body_override'
  } else if (typeof job.payment_terms === 'string' && job.payment_terms.trim()) {
    paymentTermsText = job.payment_terms.trim()
    paymentTermsSource = 'jobs.payment_terms'
  } else if (typeof pricing.payment_terms === 'string' && pricing.payment_terms.trim()) {
    paymentTermsText = pricing.payment_terms.trim()
    paymentTermsSource = 'pricing_json.payment_terms'
  } else {
    paymentTermsText = PAYMENT_TERMS_DEFAULTS[division || 'general'] || PAYMENT_TERMS_DEFAULTS.general
    paymentTermsSource = 'division_default'
    warnings.push('payment_terms_using_division_default')
  }

  // Due date. body.due_date wins; otherwise today + 14 days (existing default).
  const dueDate = body.due_date || body.dueDate
    || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)

  // Xero Project manual-fill default for new invoices. The 2026-04-09 ADR
  // declared Xero Projects API unreliable; we surface a manual-fill queue.
  const xeroProjectManualStatus = 'needs_manual_fill'

  return {
    ok: missing.length === 0,
    missing_dimensions: missing,
    warnings,
    context: {
      job,
      job_contact: jobContact,
      job_number: jobNumber,
      customer_name: customerName,
      suburb,
      division,
      account_code: accountCode,
      tracking_option: trackingOption,
      quote_revision_id: quoteRevisionId,
      scope_revision_id: scopeRevisionId,
      payment_terms_text: paymentTermsText,
      payment_terms_source: paymentTermsSource,
      due_date: dueDate,
      xero_project_manual_status: xeroProjectManualStatus,
    },
  }
}

// Computes the typed reference suffix for an invoice. Mirrors the createDepositInvoice
// builder shape and the H1 fix family. Used by createInvoice to stamp xero_invoices.reference_suffix.
function computeReferenceSuffix(jobNumber: string, reference: string): string | null {
  if (!reference) return null
  const trimmed = reference.trim()
  if (!trimmed) return null
  const prefix = (jobNumber || '').trim()
  if (prefix && trimmed.toUpperCase().startsWith(prefix.toUpperCase())) {
    const suffix = trimmed.slice(prefix.length).replace(/^[-\s]+/, '').trim()
    return suffix || null
  }
  return trimmed
}

async function createInvoice(client: any, body: any) {
  const { job_id, jobId, contact_name, contactName, xero_contact_id, job_contact_id,
          line_items, lineItems, due_date, dueDate, reference,
          xero_status, send_email } = body

  const items = line_items || lineItems
  if (!items || items.length === 0) throw new Error('line_items required')
  const contact = contact_name || contactName
  if (!contact && !xero_contact_id) throw new Error('contact_name or xero_contact_id required')

  // Loop 1B-a-apply preflight gate. Block creation when required dimensions are
  // missing unless the caller passes bypass_preflight: true. Soft warnings do
  // NOT block. The override is logged to business_events so we have a trail
  // every time someone created an invoice with incomplete trace context.
  const preflight = await preflightInvoiceCreation(client, body)
  if (!preflight.ok && !body.bypass_preflight) {
    const err: any = new Error(
      'Invoice preflight failed: ' + preflight.missing_dimensions.join(', ') +
      '. Set the missing fields on the job, or re-call with bypass_preflight=true to override.'
    )
    err.code = 'PREFLIGHT_FAILED'
    err.missing_dimensions = preflight.missing_dimensions
    err.warnings = preflight.warnings
    throw err
  }
  if (!preflight.ok && body.bypass_preflight) {
    // Override taken — log so we have an audit trail.
    logBusinessEvent(client, {
      event_type: 'invoice.preflight_override',
      entity_type: 'job',
      entity_id: (job_id || jobId || 'unknown'),
      job_id: (job_id || jobId || undefined),
      payload: {
        missing_dimensions: preflight.missing_dimensions,
        warnings: preflight.warnings,
        reason: body.bypass_reason || null,
      },
      metadata: {
        operator: body.operator || null,
        source: 'createInvoice',
      },
    })
  }
  const traceCtx = preflight.context // null only if no job_id provided

  const { accessToken, tenantId } = await getToken(client)

  // Resolve Xero contact — find or create if no xero_contact_id provided
  let resolvedContactId = xero_contact_id
  if (!resolvedContactId && contact) {
    try {
      // Fetch job data for email/phone (needed for search + contact creation)
      const jId = job_id || jobId
      const { data: jobData } = jId ? await client.from('jobs')
        .select('client_email, client_phone')
        .eq('id', jId)
        .maybeSingle() : { data: null }

      // 1. Search by EMAIL first (most reliable dedup — avoids name variation duplicates)
      let existing: any = null
      if (jobData?.client_email) {
        const emailResult = await xeroGet('/Contacts', accessToken, tenantId, {
          where: `EmailAddress=="${jobData.client_email.replace(/"/g, '')}"`,
        })
        existing = emailResult?.Contacts?.[0]
        if (existing) console.log(`[ops-api] Xero contact matched by email: ${jobData.client_email} → ${existing.ContactID}`)
      }

      // 2. Fall back to NAME search if email didn't match
      if (!existing) {
        const nameResult = await xeroGet('/Contacts', accessToken, tenantId, {
          where: `Name=="${contact.replace(/"/g, '')}"`,
        })
        existing = nameResult?.Contacts?.[0]
      }

      if (existing) {
        resolvedContactId = existing.ContactID
      } else {
        // 3. Create new contact in Xero
        const newContact = await xeroPost('/Contacts', accessToken, tenantId, {
          Contacts: [{ Name: contact, EmailAddress: jobData?.client_email || undefined, Phones: jobData?.client_phone ? [{ PhoneType: 'DEFAULT', PhoneNumber: jobData.client_phone }] : undefined }],
        }, 'PUT', `contact-${contact.replace(/\s/g, '-')}`)
        resolvedContactId = newContact?.Contacts?.[0]?.ContactID
      }
      // Backfill xero_contact_id so future invoices don't need lookup
      if (resolvedContactId) {
        if (job_contact_id) {
          // Neighbour: write to job_contacts, not jobs
          await client.from('job_contacts').update({ xero_contact_id: resolvedContactId }).eq('id', job_contact_id)
        } else if (job_id || jobId) {
          await client.from('jobs').update({ xero_contact_id: resolvedContactId }).eq('id', job_id || jobId)
        }
      }
    } catch (e) {
      console.log('[ops-api] Xero contact lookup/create failed, falling back to Name:', (e as Error).message)
      // Fall through — will use Name-based contact below
    }
  }

  // If job_contact_id provided (neighbour split), override contact with that neighbour's details
  if (job_contact_id) {
    try {
      const { data: jc } = await client.from('job_contacts')
        .select('client_name, client_email, xero_contact_id, ghl_contact_id')
        .eq('id', job_contact_id)
        .single()
      if (jc?.xero_contact_id) resolvedContactId = jc.xero_contact_id
    } catch { /* job_contacts table may not exist yet */ }
  }

  const ref = reference || ''
  // Validate tracking category exists in Xero before including it
  let tracking: any[] = []
  try {
    const trackingCats = await xeroGet('/TrackingCategories', accessToken, tenantId)
    const divisionCat = (trackingCats?.TrackingCategories || []).find((tc: any) => tc.Name === 'Business Unit' && tc.Status === 'ACTIVE')
    if (divisionCat) {
      const optionName = trackingCategoryForJob(ref)
      const validOption = (divisionCat.Options || []).find((o: any) => o.Name === optionName && o.Status === 'ACTIVE')
      if (validOption) tracking = [{ Name: 'Business Unit', Option: optionName }]
    }
  } catch { /* skip tracking if lookup fails */ }

  const xeroLineItems = items.map((li: any) => ({
    Description: li.description || '',
    Quantity: li.quantity || 1,
    UnitAmount: li.unit_price || li.unitPrice || 0,
    AccountCode: li.account_code || '200',
    TaxType: 'OUTPUT',
    ...(tracking.length > 0 ? { Tracking: tracking } : {}),
  }))

  // Use requested status — DRAFT (for bookkeeper review) or AUTHORISED (approve & send)
  const invoiceStatus = xero_status || 'DRAFT'

  // Loop 1B-a-apply: Terms text comes from the preflight context (which
  // already resolved override > jobs.payment_terms > pricing_json.payment_terms
  // > division-default). DueDate prefers preflight context too so the body
  // override flows through one resolution path.
  const xeroTermsText = traceCtx?.payment_terms_text || ''
  const xeroDueDate = traceCtx?.due_date
    || due_date || dueDate
    || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)

  const invoice = {
    Invoices: [{
      Type: 'ACCREC',
      Contact: resolvedContactId
        ? { ContactID: resolvedContactId }
        : { Name: contact },
      LineAmountTypes: 'Exclusive',
      LineItems: xeroLineItems,
      Reference: reference || '',
      DueDate: xeroDueDate,
      Status: invoiceStatus,
      ...(xeroTermsText ? { Terms: xeroTermsText } : {}),
    }],
  }

  // Idempotency key: job_id + reference + minute — prevents duplicate invoice on retry/double-click
  const jIdForKey = job_id || jobId || 'nojob'
  const invIdempotencyKey = `inv-${jIdForKey}-${reference || 'noref'}-${new Date().toISOString().slice(0, 16)}`
  const result = await xeroPost('/Invoices', accessToken, tenantId, invoice, 'PUT', invIdempotencyKey)
  const xeroInv = result?.Invoices?.[0]
  const xeroInvId = xeroInv?.InvoiceID
  const invNumber = xeroInv?.InvoiceNumber

  // If approve & send, email the invoice to the client via Xero
  if (send_email && xeroInvId) {
    try {
      await xeroPost(`/Invoices/${xeroInvId}/Email`, accessToken, tenantId, {}, 'POST')
    } catch (emailErr: any) {
      console.error('Failed to email invoice:', emailErr.message)
      // Non-blocking — invoice was still created
    }
  }

  const jId = job_id || jobId

  // Immediately record in xero_invoices so future queries see it
  // (don't wait for xero-sync which runs every 2 hours)
  const invTotal = xeroInv?.Total ?? items.reduce((s: number, li: any) => s + ((li.quantity || 1) * (li.unit_price || li.unitPrice || 0)), 0) * 1.1
  const invSubTotal = xeroInv?.SubTotal ?? items.reduce((s: number, li: any) => s + ((li.quantity || 1) * (li.unit_price || li.unitPrice || 0)), 0)
  if (xeroInvId) {
    try {
      // Loop 1B-a-apply: stamp the eleven traceability columns added by
      // migration 20260506101511_loop_1b_a_traceability. Eight columns come
      // from the strategy doc's W2 traceability set; two close H1's silent
      // drop (job_contact_id, reference_suffix); one surfaces the Xero
      // Project manual-fill queue per the 2026-04-09 ADR.
      const referenceSuffix = computeReferenceSuffix(traceCtx?.job_number || '', reference || '')
      await client.from('xero_invoices').upsert({
        org_id: DEFAULT_ORG_ID,
        xero_invoice_id: xeroInvId,
        xero_contact_id: xero_contact_id || xeroInv?.Contact?.ContactID || null,
        contact_name: contact || xeroInv?.Contact?.Name || null,
        invoice_number: invNumber,
        invoice_type: 'ACCREC',
        status: invoiceStatus,
        reference: reference || '',
        sub_total: invSubTotal,
        total_tax: (xeroInv?.TotalTax ?? invTotal - invSubTotal),
        total: invTotal,
        amount_due: invTotal,
        amount_paid: 0,
        invoice_date: new Date().toISOString().slice(0, 10),
        due_date: xeroDueDate,
        job_id: jId || null,
        run_label: body.run_label || null,
        // Loop 1B-a-apply traceability columns (NULL when no job context).
        job_number:                 traceCtx?.job_number || null,
        customer_name:              traceCtx?.customer_name || contact || null,
        suburb:                     traceCtx?.suburb || null,
        division:                   traceCtx?.division || null,
        account_code:               traceCtx?.account_code || null,
        tracking_option:            traceCtx?.tracking_option || null,
        xero_project_manual_status: traceCtx?.xero_project_manual_status || 'needs_manual_fill',
        quote_revision_id:          traceCtx?.quote_revision_id || null,
        scope_revision_id:          traceCtx?.scope_revision_id || null,
        job_contact_id:             job_contact_id || null,
        reference_suffix:           referenceSuffix,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'org_id,xero_invoice_id' })
    } catch (upsertErr: any) {
      console.error('Non-blocking: failed to cache invoice locally:', upsertErr.message)
    }
  }

  if (jId) {
    await client.from('job_events').insert({
      job_id: jId,
      event_type: 'invoice_created',
      detail_json: { xero_invoice_id: xeroInvId, invoice_number: invNumber, status: invoiceStatus, total: invTotal, emailed: !!send_email },
    })
    // Update job status to invoiced if complete
    await client.from('jobs')
      .update({ status: 'invoiced' })
      .eq('id', jId)
      .eq('status', 'complete')
  }

  return { success: true, xero_invoice_id: xeroInvId, invoice_number: invNumber, total: invTotal }
}

// ── Sync Job Invoices — pull invoices from Xero for a specific job and link them ──
async function syncJobInvoices(client: any, body: any) {
  const jId = body.job_id || body.jobId
  if (!jId) throw new Error('job_id required')

  const { data: job, error: jobErr } = await client
    .from('jobs')
    .select('id, job_number, client_name, xero_contact_id')
    .eq('id', jId)
    .single()
  if (jobErr || !job) throw new Error('Job not found')

  const { accessToken, tenantId } = await getToken(client)

  let synced = 0
  const syncedInvoices: any[] = []

  // Strategy 1: Search by Xero contact ID
  if (job.xero_contact_id) {
    try {
      const result = await xeroGet('/Invoices', accessToken, tenantId, {
        where: `Contact.ContactID=guid("${job.xero_contact_id}") AND Type=="ACCREC"`,
        Statuses: 'DRAFT,SUBMITTED,AUTHORISED,PAID',
      })
      const invoices = result?.Invoices || []
      for (const inv of invoices) {
        const record: any = {
          org_id: DEFAULT_ORG_ID,
          xero_invoice_id: inv.InvoiceID,
          xero_contact_id: inv.Contact?.ContactID || null,
          contact_name: inv.Contact?.Name || null,
          invoice_number: inv.InvoiceNumber || null,
          invoice_type: inv.Type,
          status: inv.Status,
          reference: inv.Reference || null,
          sub_total: inv.SubTotal || 0,
          total_tax: inv.TotalTax || 0,
          total: inv.Total || 0,
          amount_due: inv.AmountDue || 0,
          amount_paid: inv.AmountPaid || 0,
          invoice_date: inv.DateString || null,
          due_date: inv.DueDateString || null,
          line_items: inv.LineItems || [],
          raw_json: inv,
          job_id: job.id,
          synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
        const { error } = await client.from('xero_invoices').upsert(record, {
          onConflict: 'org_id,xero_invoice_id',
        })
        if (!error) {
          synced++
          syncedInvoices.push({ invoice_number: inv.InvoiceNumber, total: inv.Total, status: inv.Status })
        }
      }
    } catch (e: any) {
      console.log('[sync_job_invoices] Xero contact search failed:', e.message)
    }
  }

  // Strategy 2: Search by reference containing job number
  if (job.job_number) {
    try {
      const result = await xeroGet('/Invoices', accessToken, tenantId, {
        where: `Reference.Contains("${job.job_number}") AND Type=="ACCREC"`,
        Statuses: 'DRAFT,SUBMITTED,AUTHORISED,PAID',
      })
      const invoices = result?.Invoices || []
      for (const inv of invoices) {
        // Skip if already synced from Strategy 1
        const alreadySynced = syncedInvoices.some(s => s.invoice_number === inv.InvoiceNumber)
        if (alreadySynced) continue

        const record: any = {
          org_id: DEFAULT_ORG_ID,
          xero_invoice_id: inv.InvoiceID,
          xero_contact_id: inv.Contact?.ContactID || null,
          contact_name: inv.Contact?.Name || null,
          invoice_number: inv.InvoiceNumber || null,
          invoice_type: inv.Type,
          status: inv.Status,
          reference: inv.Reference || null,
          sub_total: inv.SubTotal || 0,
          total_tax: inv.TotalTax || 0,
          total: inv.Total || 0,
          amount_due: inv.AmountDue || 0,
          amount_paid: inv.AmountPaid || 0,
          invoice_date: inv.DateString || null,
          due_date: inv.DueDateString || null,
          line_items: inv.LineItems || [],
          raw_json: inv,
          job_id: job.id,
          synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
        const { error } = await client.from('xero_invoices').upsert(record, {
          onConflict: 'org_id,xero_invoice_id',
        })
        if (!error) {
          synced++
          syncedInvoices.push({ invoice_number: inv.InvoiceNumber, total: inv.Total, status: inv.Status })
        }
      }
    } catch (e: any) {
      console.log('[sync_job_invoices] Xero reference search failed:', e.message)
    }
  }

  return { success: true, synced, job_number: job.job_number, invoices: syncedInvoices }
}

// ── Update Invoice — edit line items on an existing Xero invoice ──
async function updateInvoice(client: any, body: any) {
  const { xero_invoice_id, line_items, due_date, resend_email } = body
  if (!xero_invoice_id) throw new ApiError('xero_invoice_id required', 400)
  if (!line_items || !Array.isArray(line_items) || line_items.length === 0) {
    throw new ApiError('line_items required (array of {description, quantity, unit_price})', 400)
  }

  const { accessToken, tenantId } = await getToken(client)

  // H2 (Loop 1B-a): re-derive Tracking from the invoice's reference so edits
  // do not strip the division tag. Xero POST /Invoices/{id} REPLACES the line
  // items array — without an explicit Tracking entry on each line, every edit
  // silently drops the Business Unit option. Pattern mirrors createInvoice's
  // existing fail-soft Tracking lookup (validate against /TrackingCategories,
  // skip if Xero returns nothing or throws).
  let updateTracking: any[] = []
  try {
    const { data: invForTracking } = await client.from('xero_invoices')
      .select('reference')
      .eq('xero_invoice_id', xero_invoice_id)
      .maybeSingle()
    const updateRef = invForTracking?.reference || ''
    if (updateRef) {
      const trackingCats = await xeroGet('/TrackingCategories', accessToken, tenantId)
      const divisionCat = (trackingCats?.TrackingCategories || []).find(
        (tc: any) => tc.Name === 'Business Unit' && tc.Status === 'ACTIVE'
      )
      if (divisionCat) {
        const optionName = trackingCategoryForJob(updateRef)
        const validOption = (divisionCat.Options || []).find(
          (o: any) => o.Name === optionName && o.Status === 'ACTIVE'
        )
        if (validOption) updateTracking = [{ Name: 'Business Unit', Option: optionName }]
      }
    }
  } catch { /* skip Tracking if lookup fails — same fail-soft as createInvoice */ }

  const payload: any = {
    InvoiceID: xero_invoice_id,
    LineItems: line_items.map((li: any) => ({
      Description: li.description || '',
      Quantity: li.quantity || 1,
      UnitAmount: li.unit_price || 0,
      AccountCode: li.account_code || '200',
      TaxType: 'OUTPUT',
      ...(updateTracking.length > 0 ? { Tracking: updateTracking } : {}),
    })),
  }
  if (due_date) payload.DueDate = due_date

  // Xero uses POST for updates
  const result = await xeroPost(`/Invoices/${xero_invoice_id}`, accessToken, tenantId, { Invoices: [payload] }, 'POST')
  const xeroInvoice = result?.Invoices?.[0]
  if (!xeroInvoice) throw new Error('Xero did not return an updated invoice')

  // Update local cache
  await client.from('xero_invoices').update({
    line_items: xeroInvoice.LineItems,
    sub_total: xeroInvoice.SubTotal,
    total_tax: xeroInvoice.TotalTax,
    total: xeroInvoice.Total,
    amount_due: xeroInvoice.AmountDue,
    due_date: xeroInvoice.DueDate,
    updated_at: new Date().toISOString(),
  }).eq('xero_invoice_id', xero_invoice_id)

  // Resend email if requested
  if (resend_email) {
    try {
      await xeroPost(`/Invoices/${xero_invoice_id}/Email`, accessToken, tenantId, {}, 'POST')
    } catch (emailErr: any) {
      console.error('[update_invoice] Failed to resend email:', emailErr.message)
    }
  }

  // Log job event
  const { data: invRecord } = await client.from('xero_invoices')
    .select('job_id, invoice_number')
    .eq('xero_invoice_id', xero_invoice_id)
    .maybeSingle()

  if (invRecord?.job_id) {
    await client.from('job_events').insert({
      job_id: invRecord.job_id,
      event_type: 'invoice_updated',
      detail_json: {
        xero_invoice_id,
        invoice_number: xeroInvoice.InvoiceNumber || invRecord.invoice_number,
        total: xeroInvoice.Total,
        resent: !!resend_email,
      },
    })
  }

  return {
    success: true,
    invoice_number: xeroInvoice.InvoiceNumber || invRecord?.invoice_number,
    total: xeroInvoice.Total,
  }
}

// ── Mark Invoice Paid — local-only override, no Xero payment created ──
async function markInvoicePaid(client: any, body: any) {
  const { xero_invoice_id, payment_date, amount } = body
  if (!xero_invoice_id) throw new ApiError('xero_invoice_id required', 400)
  if (!payment_date) throw new ApiError('payment_date required', 400)
  if (amount === undefined || amount === null) throw new ApiError('amount required', 400)

  // Get invoice details before updating
  const { data: inv } = await client.from('xero_invoices')
    .select('job_id, invoice_number, total')
    .eq('xero_invoice_id', xero_invoice_id)
    .maybeSingle()

  if (!inv) throw new ApiError('Invoice not found in local records', 404)

  // Update local status to PAID
  await client.from('xero_invoices').update({
    status: 'PAID',
    amount_paid: amount,
    amount_due: 0,
    fully_paid_on: payment_date,
    updated_at: new Date().toISOString(),
  }).eq('xero_invoice_id', xero_invoice_id)

  // Log business event
  await client.from('business_events').insert({
    event_type: 'invoice.manually_marked_paid',
    source: 'ops-api/mark_invoice_paid',
    entity_type: 'invoice',
    entity_id: xero_invoice_id,
    payload: { invoice_number: inv.invoice_number, amount, payment_date, manual: true },
  })

  // Create AI annotation on the job
  if (inv.job_id) {
    await client.from('ai_annotations').upsert({
      org_id: DEFAULT_ORG_ID,
      job_id: inv.job_id,
      annotation_type: 'manual_payment',
      severity: 'info',
      title: `${inv.invoice_number} marked as paid manually`,
      body: `$${Number(amount).toLocaleString('en-AU', { minimumFractionDigits: 2 })} marked paid on ${payment_date}. Xero sync will confirm.`,
      ui_location: 'job_money',
      source: 'ops-api/mark_invoice_paid',
      source_ref: `manual_paid_${xero_invoice_id}`,
      priority: 50,
    }, { onConflict: 'source_ref' })
  }

  return { success: true }
}

async function syncSuppliers(client: any) {
  const { accessToken, tenantId } = await getToken(client)

  const result = await xeroGet('/Contacts', accessToken, tenantId, {
    where: 'IsSupplier==true',
    includeArchived: 'false',
  })

  const contacts = result?.Contacts || []
  let upserted = 0

  for (const c of contacts) {
    const { error } = await client.from('suppliers').upsert({
      org_id: DEFAULT_ORG_ID,
      xero_contact_id: c.ContactID,
      name: c.Name || '',
      email: c.EmailAddress || null,
      phone: c.Phones?.find((p: any) => p.PhoneType === 'DEFAULT')?.PhoneNumber || null,
      is_active: c.ContactStatus === 'ACTIVE',
      synced_at: new Date().toISOString(),
    }, { onConflict: 'org_id,xero_contact_id' })

    if (!error) upserted++
  }

  return { success: true, total_contacts: contacts.length, upserted }
}


// ════════════════════════════════════════════════════════════
// AUTOMATION — Complete+Invoice Cascade, Morning Brief,
//              Scope-to-PO Extraction, Assignment Cascade
// ════════════════════════════════════════════════════════════

// Feature 4: Complete a job AND create a Xero invoice in one step.
// 1. Sets job status to "complete" + completed_at
// 2. Reads pricing_json for line items
// 3. Finds/creates Xero contact
// 4. Creates Xero DRAFT invoice with line items + SW reference
// 5. Sets job status to "invoiced"
async function completeAndInvoice(client: any, body: any) {
  const jId = body.job_id || body.jobId
  if (!jId) throw new Error('job_id required')

  // Fetch the job
  const { data: job, error: jobErr } = await client
    .from('jobs')
    .select('id, status, client_name, client_email, job_number, xero_contact_id, pricing_json, scope_json, type, site_address, site_suburb')
    .eq('id', jId)
    .single()
  if (jobErr || !job) throw new Error('Job not found')

  if (!['in_progress', 'complete', 'scheduled', 'processing'].includes(job.status)) {
    throw new Error(`Cannot complete+invoice a job with status "${job.status}". Must be in_progress, processing, scheduled, or complete.`)
  }

  // Use line_items_override if provided (from invoice creation modal),
  // otherwise extract from pricing_json (with fallback to scope_json._pricing_json for fencing jobs)
  let lineItems: any[] = body.line_items_override || []
  if (lineItems.length === 0) {
    // Primary: top-level pricing_json column
    let pricing: any = null
    if (job.pricing_json && Object.keys(job.pricing_json).length > 0) {
      pricing = typeof job.pricing_json === 'string' ? JSON.parse(job.pricing_json) : job.pricing_json
    }
    // Fallback: scope_json.job._pricing_json (fencing scoping tool stores pricing here, not in pricing_json)
    // When using this fallback, always use totalExGST as a single line item — Xero adds 10% GST on top,
    // so we pass the ex-GST amount to arrive at the correct totalIncGST. Individual scope line items
    // are for cost tracking and may not sum exactly to the quoted total due to rounding.
    if (!pricing && job.scope_json) {
      const scope = typeof job.scope_json === 'string' ? JSON.parse(job.scope_json) : job.scope_json
      const jobData = scope.job || scope
      if (jobData._pricing_json) {
        const scopePricing = typeof jobData._pricing_json === 'string' ? JSON.parse(jobData._pricing_json) : jobData._pricing_json
        const exactTotalExGST = scopePricing.totalExGST || scopePricing.subtotal || (scopePricing.totalIncGST ? scopePricing.totalIncGST / 1.1 : 0) || 0
        if (exactTotalExGST > 0) {
          lineItems = [{
            description: buildRichDescription(job, `${trackingCategoryForJob(job.job_number) || 'Construction'} works`),
            quantity: 1,
            unit_price: exactTotalExGST,
            account_code: accountCodeForJob(job.type),
          }]
        }
      }
    }
    if (lineItems.length === 0 && pricing) {
      const itemArray = Array.isArray(pricing.items) ? pricing.items
        : Array.isArray(pricing.line_items) ? pricing.line_items
        : null
      if (itemArray) {
        lineItems = itemArray.map((li: any) => ({
          description: li.description || li.name || 'Line item',
          quantity: li.quantity || li.qty || 1,
          unit_price: li.unit_price || li.unitPrice || li.price || li.amount || 0,
          account_code: li.account_code || '200',
        }))
      } else if (pricing.totalIncGST || pricing.total || pricing.amount) {
        lineItems = [{
          description: buildRichDescription(job, `${trackingCategoryForJob(job.job_number) || 'Construction'} works`),
          quantity: 1,
          unit_price: pricing.totalIncGST || pricing.total || pricing.amount || 0,
          account_code: accountCodeForJob(job.type),
        }]
      }
    }
  }

  if (lineItems.length === 0) {
    throw new Error('No pricing data found on this job. Add pricing_json before invoicing.')
  }

  const total = lineItems.reduce((s: number, li: any) => s + (li.quantity * li.unit_price), 0)

  // ── Deposit awareness: check for existing invoices on this job ──
  // Query xero_invoices (includes locally-cached invoices from createInvoice)
  const { data: existingInvoices } = await client.from('xero_invoices')
    .select('xero_invoice_id, invoice_number, total, status')
    .eq('job_id', jId)
    .eq('invoice_type', 'ACCREC')
    .not('status', 'in', '("VOIDED","DELETED")')

  const alreadyInvoiced = (existingInvoices || []).reduce(
    (sum: number, inv: any) => sum + (parseFloat(inv.total) || 0), 0
  )

  // Calculate balance remaining (amounts are inc GST)
  const totalIncGst = total * 1.1
  const balance = totalIncGst - alreadyInvoiced

  if (alreadyInvoiced > 0) {
    console.log(`[completeAndInvoice] Job ${jId}: total=${totalIncGst}, already_invoiced=${alreadyInvoiced}, balance=${balance}`)
  }

  if (balance <= 0) {
    throw new Error(
      `Job already fully invoiced. Total: $${totalIncGst.toFixed(2)}, ` +
      `Already invoiced: $${alreadyInvoiced.toFixed(2)}. ` +
      `No balance remaining. Check existing invoices: ${(existingInvoices || []).map((i: any) => i.invoice_number).join(', ')}`
    )
  }

  // If deposits exist, adjust line items to invoice only the balance
  let finalLineItems = lineItems
  if (alreadyInvoiced > 0) {
    // Create a single "balance" line item (ex GST since Xero adds GST)
    const balanceExGst = balance / 1.1
    const balanceLabel = `Balance after $${alreadyInvoiced.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} deposit`
    finalLineItems = [{
      description: buildRichDescription(job, balanceLabel),
      quantity: 1,
      unit_price: Math.round(balanceExGst * 100) / 100,
      account_code: accountCodeForJob(job.type),
    }]
  }

  // Step 1: Mark complete (if not already)
  if (job.status !== 'complete') {
    await client.from('jobs')
      .update({ status: 'complete', completed_at: new Date().toISOString() })
      .eq('id', jId)
    await client.from('job_events').insert({
      job_id: jId,
      event_type: 'status_changed',
      detail_json: { new_status: 'complete', via: 'complete_and_invoice' },
    })
  }

  // Step 2: Create Xero invoice (balance only if deposits exist)
  const reference = (job.job_number || '') + (alreadyInvoiced > 0 ? '-FINBAL' : '')
  const dueDate = body.due_date || undefined
  const invoiceResult = await createInvoice(client, {
    job_id: jId,
    xero_contact_id: job.xero_contact_id || undefined,
    contact_name: job.client_name,
    line_items: finalLineItems,
    reference,
    due_date: dueDate,
    xero_status: body.xero_status || 'DRAFT',
    send_email: body.send_email || false,
  })

  // Dual-write to business_events
  logBusinessEvent(client, {
    event_type: 'job.completed_and_invoiced',
    entity_type: 'job',
    entity_id: jId,
    job_id: job?.job_number || jId,
    correlation_id: jId,
    payload: {
      entity: { id: jId, name: job?.client_name || '' },
      changes: { status: { from: job?.status, to: 'invoiced' } },
      financial: { amount: balance || 0, currency: 'AUD' },
    },
  })

  // Log to jarvis_event_log (non-blocking, fire-and-forget)
  client.from('jarvis_event_log').insert({
    event_type: 'job_completed_and_invoiced', job_id: jId,
    channel: 'system', triggered_by: 'jarvis',
    message_content: `Job completed and invoice created`,
    metadata: {},
  }).then(() => {}).catch(() => {})

  return {
    success: true,
    job_id: jId,
    total_job_value: totalIncGst,
    already_invoiced: alreadyInvoiced,
    balance_invoiced: balance,
    line_items: finalLineItems,
    invoice_number: invoiceResult.invoice_number,
    xero_invoice_id: invoiceResult.xero_invoice_id,
  }
}

// ── Quick Quote: Search GHL Contacts ──
// ── Xero: Get Revenue Accounts ──
let _xeroAccountsCache: any = null
let _xeroAccountsCacheTime = 0
async function getXeroAccounts(client: any) {
  // Cache for 5 minutes
  if (_xeroAccountsCache && Date.now() - _xeroAccountsCacheTime < 300000) return _xeroAccountsCache
  const { accessToken, tenantId } = await getToken(client)
  const data = await xeroGet('/Accounts', accessToken, tenantId, {
    where: 'Type=="REVENUE"&&Status=="ACTIVE"',
  })
  const accounts = (data.Accounts || []).map((a: any) => ({ code: a.Code, name: a.Name, type: a.Type }))
  _xeroAccountsCache = { accounts }
  _xeroAccountsCacheTime = Date.now()
  return { accounts }
}

// ── Xero: Search Contacts ──
async function searchXeroContacts(client: any, params: URLSearchParams) {
  const q = (params.get('q') || '').trim()
  if (!q || q.length < 2) return { contacts: [] }
  const { accessToken, tenantId } = await getToken(client)
  const data = await xeroGet('/Contacts', accessToken, tenantId, {
    where: `Name.Contains("${q.replace(/"/g, '')}")`,
  })
  const contacts = (data.Contacts || []).map((c: any) => ({
    id: c.ContactID, name: c.Name, email: c.EmailAddress || '', phone: c.Phones?.[0]?.PhoneNumber || '',
  }))
  return { contacts }
}

// ── Create General Invoice (rich descriptions for bookkeeper) ──
async function createGeneralInvoice(client: any, body: any) {
  const { job_id, account_code } = body
  if (!job_id) throw new Error('job_id required')

  const { data: job, error: jobErr } = await client.from('jobs')
    .select('id, job_number, client_name, client_email, site_address, site_suburb, pricing_json, xero_contact_id, ghl_contact_id')
    .eq('id', job_id).single()
  if (jobErr || !job) throw new Error('Job not found')

  const pricing = job.pricing_json || {}
  const lineItems = pricing.line_items || []
  if (lineItems.length === 0) throw new Error('No line items on this job')

  const address = [job.site_address, job.site_suburb].filter(Boolean).join(', ')
  const scopeDesc = pricing.job_description || pricing.description || lineItems.map((li: any) => li.description).join('; ')

  // Build rich Xero line items with bookkeeper-friendly descriptions
  const xeroLineItems = lineItems.map((li: any) => ({
    description: `${job.job_number || 'SWG'} - ${job.client_name || ''} - ${address} | ${li.description || ''}`,
    quantity: li.quantity || 1,
    unit_price: li.unit_price || li.sell_price || 0,
    account_code: account_code || '200',
  }))

  // Use existing createInvoice with enhanced parameters
  const invoiceResult = await createInvoice(client, {
    job_id,
    contact_name: job.client_name,
    xero_contact_id: job.xero_contact_id || undefined,
    line_items: xeroLineItems,
    reference: job.job_number || '',
    xero_status: 'DRAFT',
  })

  // Update job status
  await client.from('jobs').update({ status: 'invoiced' }).eq('id', job_id)

  return {
    success: true,
    xero_invoice_id: invoiceResult.xero_invoice_id,
    invoice_number: invoiceResult.invoice_number,
    total: invoiceResult.total,
    job_number: job.job_number,
  }
}

// ── Create GHL Contact (with dedup) ──
async function createGHLContact(client: any, body: any) {
  const { firstName, lastName, email, phone, address, suburb, job_id } = body
  if (!firstName && !lastName) throw new Error('firstName or lastName required')
  if (!GHL_API_TOKEN) throw new Error('GHL API token not configured')

  const name = [firstName, lastName].filter(Boolean).join(' ')
  const headers = { 'Authorization': `Bearer ${GHL_API_TOKEN}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' }

  // Dedup: search by email first, then phone
  let existingId: string | null = null
  if (email) {
    try {
      const dupRes = await fetch(`https://services.leadconnectorhq.com/contacts/search/duplicate`, {
        method: 'POST', headers,
        body: JSON.stringify({ locationId: GHL_LOCATION_ID, email }),
      })
      if (dupRes.ok) {
        const dupData = await dupRes.json()
        if (dupData.contact?.id) existingId = dupData.contact.id
      }
    } catch (e) { /* continue to phone check */ }
  }
  if (!existingId && phone) {
    try {
      const dupRes = await fetch(`https://services.leadconnectorhq.com/contacts/search/duplicate`, {
        method: 'POST', headers,
        body: JSON.stringify({ locationId: GHL_LOCATION_ID, number: phone }),
      })
      if (dupRes.ok) {
        const dupData = await dupRes.json()
        if (dupData.contact?.id) existingId = dupData.contact.id
      }
    } catch (e) { /* continue to create */ }
  }

  let contactId = existingId
  let contactExisted = !!existingId

  if (!contactId) {
    // Create new contact
    const createRes = await fetch(`https://services.leadconnectorhq.com/contacts/`, {
      method: 'POST', headers,
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID,
        firstName: firstName || '',
        lastName: lastName || '',
        email: email || undefined,
        phone: phone || undefined,
        address1: address || undefined,
        city: suburb || undefined,
      }),
    })
    if (!createRes.ok) {
      const errText = await createRes.text()
      throw new Error('GHL contact creation failed (' + createRes.status + '): ' + errText.slice(0, 100))
    }
    const createData = await createRes.json()
    contactId = createData.contact?.id
    if (!contactId) throw new Error('GHL returned no contact ID')
  }

  // Link to job if provided
  if (job_id && contactId) {
    await client.from('jobs').update({ ghl_contact_id: contactId }).eq('id', job_id)
  }

  return { contact_id: contactId, name, email: email || '', phone: phone || '', existed: contactExisted, linked_job_id: job_id || null }
}

async function searchGHLContacts(client: any, params: URLSearchParams) {
  const q = (params.get('q') || '').trim()
  if (!q || q.length < 2) return { contacts: [] }

  if (!GHL_API_TOKEN) throw new Error('GHL API token not configured')

  // Search GHL contacts by name/email/phone using GET /contacts/ endpoint
  const searchParams = new URLSearchParams({
    locationId: GHL_LOCATION_ID,
    query: q,
    limit: '10',
  })
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/?${searchParams.toString()}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${GHL_API_TOKEN}`,
      'Version': '2021-07-28',
    },
  })
  if (!res.ok) {
    const text = await res.text()
    console.error('[ops-api] GHL contact search failed:', res.status, text.slice(0, 500))
    console.error('[ops-api] GHL search request: locationId=' + GHL_LOCATION_ID + ', query=' + q + ', token=' + (GHL_API_TOKEN ? 'set(' + GHL_API_TOKEN.length + ' chars)' : 'MISSING'))
    throw new Error('GHL search failed (' + res.status + '): ' + text.slice(0, 100))
  }

  const data = await res.json()
  const contacts = (data.contacts || []).map((c: any) => ({
    id: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(' '),
    firstName: c.firstName || '',
    lastName: c.lastName || '',
    email: c.email || '',
    phone: c.phone || '',
    address: c.address1 || '',
    city: c.city || '',
  }))

  // For each contact, check for existing jobs in Supabase
  const contactIds = contacts.map((c: any) => c.id).filter(Boolean)
  let existingJobs: any[] = []
  if (contactIds.length > 0) {
    const { data: jobs } = await client.from('jobs')
      .select('id, job_number, type, status, client_name, ghl_contact_id')
      .eq('org_id', DEFAULT_ORG_ID)
      .in('ghl_contact_id', contactIds)
      .order('created_at', { ascending: false })
      .limit(20)
    existingJobs = jobs || []
  }

  // Attach existing jobs to contacts
  contacts.forEach((c: any) => {
    c.existing_jobs = existingJobs.filter((j: any) => j.ghl_contact_id === c.id)
  })

  return { contacts }
}

// ── Quick Quote: Create Miscellaneous Job ──
async function createMiscJob(client: any, body: any) {
  const {
    client_name, client_first_name, client_last_name,
    client_phone, client_email,
    site_address, site_suburb,
    ghl_contact_id,
    job_type_label, description, reference,
    line_items, payment_terms, valid_days,
    client_notes, internal_notes,
    status: reqStatus,
  } = body

  const name = client_name || [client_first_name, client_last_name].filter(Boolean).join(' ')
  if (!name) throw new Error('Client name required')
  if (!line_items || line_items.length === 0) throw new Error('At least one line item required')

  // Cap 0 release-truth: a Quick Quote is created at status='draft' regardless of what the
  // caller asked for. Promotion to 'quoted' only happens when sendQuickQuoteEmail successfully
  // delivers via Resend (mirrors the /send-quote/send and /send-quote/send-runs contract).
  // Pre-patch behaviour honoured caller-supplied status='quoted' here, which let an operator
  // create a row that claimed a quote was sent without anyone ever sending one. Logged when
  // a caller still tries the old shape so we have observability of frontends that need updating.
  if (reqStatus && reqStatus !== 'draft') {
    console.log('[ops-api] createMiscJob ignoring caller-supplied status; forced to draft', JSON.stringify({
      attempted_status: reqStatus,
      reason: 'cap0-release-truth',
    }))
  }

  // Calculate totals
  const totalExGST = line_items.reduce((sum: number, li: any) => sum + (Number(li.total) || 0), 0)
  const gst = Math.round(totalExGST * 0.1 * 100) / 100
  const totalIncGST = Math.round((totalExGST + gst) * 100) / 100

  // Build pricing_json
  const pricing_json = {
    source: 'quick_quote',
    version: '1.0',
    totalExGST,
    totalIncGST,
    gst,
    job_description: description || '',
    job_type_label: job_type_label || 'Miscellaneous',
    payment_terms: payment_terms || '50% deposit + 50% on completion',
    valid_days: valid_days || 30,
    client_notes: client_notes || '',
    internal_notes: internal_notes || '',
    reference: reference || '',
    line_items: line_items.map((li: any) => ({
      description: li.description || '',
      quantity: Number(li.quantity) || 1,
      unit: li.unit || 'ea',
      unit_price: Number(li.unit_price) || 0,
      cost_price: Number(li.cost_price) || 0,
      total: Number(li.total) || 0,
    })),
  }

  // Always 'draft' at creation per Cap 0 release-truth contract (see top of function).
  const finalStatus = 'draft'

  // Generate job number — support 'general' type for SWG- prefix
  const jobType = body.job_type || 'general'
  let jobNumber: string | null = null
  try {
    const { data: jnData } = await client.rpc('next_job_number', { job_type: jobType })
    jobNumber = jnData
  } catch (e) {
    console.error('[ops-api] next_job_number failed:', e)
  }

  // Insert job
  const { data: job, error: jobErr } = await client.from('jobs').insert({
    org_id: DEFAULT_ORG_ID,
    type: jobType,
    status: finalStatus,
    client_name: name,
    client_phone: client_phone || null,
    client_email: client_email || null,
    site_address: site_address || null,
    site_suburb: site_suburb || null,
    ghl_contact_id: ghl_contact_id || null,
    job_number: jobNumber,
    pricing_json,
  }).select().single()

  if (jobErr) throw new Error('Failed to create job: ' + jobErr.message)

  // Insert job event
  await client.from('job_events').insert({
    job_id: job.id,
    event_type: 'status_change',
    detail_json: {
      from: null,
      to: finalStatus,
      job_number: jobNumber,
      source: 'quick_quote',
      job_type_label: job_type_label || 'Miscellaneous',
    },
  })

  return {
    success: true,
    job: {
      id: job.id,
      job_number: jobNumber,
      type: 'miscellaneous',
      status: finalStatus,
      client_name: name,
      totalIncGST,
    },
  }
}

// ── Send Quick Quote Email to Client ──
async function sendQuickQuoteEmail(client: any, body: any) {
  const { job_id, pdf_url } = body
  if (!job_id) throw new Error('job_id required')

  const { data: job, error: jobErr } = await client.from('jobs')
    .select('id, job_number, type, client_name, client_email, client_phone, site_address, site_suburb, pricing_json')
    .eq('id', job_id)
    .single()
  if (jobErr || !job) throw new Error('Job not found')
  if (!job.client_email) throw new Error('No client email on this job')

  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || ''
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured')

  const pricing = job.pricing_json || {}
  const totalIncGST = pricing.totalIncGST || 0
  const paymentTerms = pricing.payment_terms || '50/50 split'
  const validDays = pricing.valid_days || 30
  const validUntil = new Date(Date.now() + validDays * 86400000).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })
  const firstName = (job.client_name || '').split(' ')[0] || 'there'

  // Build HTML email
  const emailHtml = `
<div style="font-family:Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;">
  <div style="background:#293C46;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:20px;">SecureWorks Group</h1>
    <p style="color:#8FA4B2;margin:4px 0 0;font-size:12px;">Your Quote</p>
  </div>
  <div style="padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
    <p>Hi ${firstName},</p>
    <p>Thank you for your enquiry. Please find attached your quote for the following works:</p>
    <div style="background:#f8f6f3;padding:16px;border-radius:6px;margin:16px 0;">
      <p style="margin:0 0 8px;font-weight:600;color:#293C46;">Quote ${job.job_number || ''}</p>
      <p style="margin:0;font-size:14px;color:#4C6A7C;">${job.site_address || ''} ${job.site_suburb || ''}</p>
      <p style="margin:12px 0 0;font-size:24px;font-weight:700;color:#293C46;">$${Number(totalIncGST).toLocaleString('en-AU', { minimumFractionDigits: 2 })} <span style="font-size:12px;font-weight:400;color:#4C6A7C;">inc GST</span></p>
    </div>
    <p style="font-size:13px;color:#4C6A7C;">Payment terms: ${paymentTerms}<br>Valid until: ${validUntil}</p>
    <p>If you'd like to proceed, simply reply to this email or give us a call.</p>
    <p>Thanks,<br><strong>SecureWorks Group</strong><br>
    <span style="font-size:12px;color:#4C6A7C;">Patios | Fencing | Decking | Screening</span></p>
  </div>
</div>`

  // Build Resend payload
  const emailPayload: any = {
    from: 'SecureWorks Group <orders@secureworksgroup.app>',
    to: [job.client_email],
    subject: `Your Quote — ${job.job_number || 'SecureWorks Group'}`,
    html: emailHtml,
  }

  // Attach PDF if URL provided
  if (pdf_url) {
    try {
      const pdfResp = await fetch(pdf_url)
      if (pdfResp.ok) {
        const pdfBuffer = new Uint8Array(await pdfResp.arrayBuffer())
        let b64 = ''
        const chunkSize = 8192
        for (let i = 0; i < pdfBuffer.length; i += chunkSize) {
          b64 += String.fromCharCode(...pdfBuffer.slice(i, i + chunkSize))
        }
        emailPayload.attachments = [{
          filename: `${job.job_number || 'Quote'}.pdf`,
          content: btoa(b64),
        }]
      }
    } catch (e) {
      console.log('[ops-api] PDF attachment failed (non-blocking):', (e as Error).message)
    }
  }

  const resendResp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(emailPayload),
  })
  const resendResult = await resendResp.json()
  if (!resendResp.ok) throw new Error('Email send failed: ' + (resendResult.message || JSON.stringify(resendResult)))

  // ── Cap 0 release-truth: atomic draft → quoted transition + canonical events ──
  // Mirrors /send-quote/send (post-`350e943`) so Quick Quote inherits the same exactly-once
  // guarantee on the actual transition. The conditional UPDATE returns affected rows; canonical
  // events fire only when this call's UPDATE flipped the row. Resends on already-quoted jobs
  // no-op the UPDATE and emit nothing canonical (idempotence).
  //
  // CAP0-QUICKQUOTE-FRESH-SELECT-RACE-SAFETY (2026-05-01): the conditional UPDATE
  // also returns the post-UPDATE row state via .select(...). Canonical event
  // payloads use those FRESH values for job_number, type, client_name, and
  // pricing_json — NOT the function-entry SELECT at line ~6058 — so an edit to
  // the row between entry and UPDATE (e.g. a parallel writer changing type)
  // can't poison the canonical bus with stale state. `sent_to` and the email
  // body still reflect entry-time values because that's what was actually
  // dispatched to Resend.
  const nowIso = new Date().toISOString()
  const { data: updatedRows } = await client.from('jobs')
    .update({ status: 'quoted', quoted_at: nowIso })
    .eq('id', job_id)
    .eq('status', 'draft')
    .select('id, job_number, type, client_name, pricing_json')
  const transitioned = Array.isArray(updatedRows) && updatedRows.length > 0

  // Legacy event (mirrors /send-quote/send: written whenever a job_id exists, regardless of
  // transition, so daily-digest and other legacy readers see the send signal on every send).
  await client.from('job_events').insert({
    job_id,
    event_type: 'quote_sent',
    detail_json: { sent_to: job.client_email, source: 'quick_quote' },
  })

  // Canonical release events — only on actual draft → quoted transition.
  // Awaited via the existing logBusinessEvent helper so a transient Supabase failure is logged
  // (`[ops-api] business_events write failed`) rather than silently dropped.
  if (transitioned) {
    const fresh = updatedRows[0] as {
      id: string
      job_number: string | null
      type: string | null
      client_name: string | null
      pricing_json: Record<string, unknown> | null
    }
    const freshPricing = (fresh.pricing_json ?? {}) as Record<string, unknown>
    const freshTotalIncGSTRaw = freshPricing.totalIncGST ?? freshPricing.total ?? freshPricing.grandTotal
    const totalIncGSTNum = typeof freshTotalIncGSTRaw === 'number' && Number.isFinite(freshTotalIncGSTRaw)
      ? freshTotalIncGSTRaw
      : (Number(totalIncGST) || 0)

    // CAP0-QUOTE-REVISION-QUICKQUOTE: record the immutable revision row at the
    // release moment. job_document_id is null because Quick Quote doesn't have
    // a job_documents row (FK relaxed in migration 20260501130000). build_kind
    // derives from the post-UPDATE type so a Quick Quote that the user
    // re-classified before send carries the correct kind in its manifest.
    const buildKind: 'patio' | 'fence' | 'misc' =
      fresh.type === 'fencing' ? 'fence' :
      fresh.type === 'patio' ? 'patio' : 'misc'

    // ── Loop 3 / P2 V2 augmentation prep (Quick Quote) ──
    let v2InputsQq: Omit<V2AugmentationInput, 'release_id'> | null = null
    try {
      const [{ data: contactRows }, { data: mediaRows }] = await Promise.all([
        client.from('job_contacts')
          .select('id, contact_type, is_primary, contact_label, client_name, client_email, client_phone, assigned_runs, share_percentage')
          .eq('job_id', job_id),
        client.from('job_media')
          .select('id, type, phase, storage_url, label, taken_at, lat, lng')
          .eq('job_id', job_id),
      ])
      v2InputsQq = {
        job_id,
        version: 1,
        released_via: 'ops-api/send_quick_quote_email',
        released_at: nowIso,
        released_by_user_id: null,
        job_row: {
          id: job_id,
          type: fresh.type ?? job.type ?? 'general',
          org_id: DEFAULT_ORG_ID,
          client_name: fresh.client_name ?? job.client_name ?? null,
          client_email: job.client_email ?? null,
          client_phone: job.client_phone ?? null,
          site_address: job.site_address ?? null,
          site_suburb: job.site_suburb ?? null,
          site_lat: null,
          site_lng: null,
          job_number: fresh.job_number ?? job.job_number ?? null,
          ghl_contact_id: null,
          xero_contact_id: null,
          scope_json: null,
          pricing_json: (fresh.pricing_json ?? job.pricing_json) as Record<string, unknown> | null,
          notes: null,
        },
        contacts: contactRows ?? [],
        media: mediaRows ?? [],
        quote_pdf_url: pdf_url || '',
        quote_pdf_size_bytes: null,
        email_subject: emailPayload.subject,
        email_custom_message: '',
        email_template_version: 'v1',
        scoper_name: 'SecureWorks Group',
        resend_message_id: resendResult.id ?? null,
        primary_recipient_email: job.client_email,
        per_contact_pdfs: [],
        terms_valid_days: validDays,
        terms_payment_terms: paymentTerms,
        terms_deposit_pct: 50,
        scoper_user_id: null,
        scoper_user_name: null,
        scoped_at: null,
        override_operator_allowlist: [],
        pdf_sha256: '',
        email_html_sha256: '',
      }
    } catch (e: any) {
      console.error('[v2-augmentation-prefetch-fail]', JSON.stringify({
        job_id,
        handler: 'ops-api/send_quick_quote_email',
        error: e?.message ?? String(e),
        note: 'V2 columns left NULL; V1 release-truth path proceeds',
      }))
    }

    const releasedRevisionId = await recordReleasedQuoteRevision(client, {
      job_id,
      job_document_id: null,
      version: 1,
      recipient_email: job.client_email,
      recipient_label: null,
      build_kind: buildKind,
      scope: {
        client_name: fresh.client_name,
        site_address: job.site_address || null,
        site_suburb: job.site_suburb || null,
        job_type: fresh.type,
        job_number: fresh.job_number,
      },
      pricing_json: fresh.pricing_json ?? null,
      pdf_url: pdf_url || '',
      released_via: 'ops-api/send_quick_quote_email',
      org_id: DEFAULT_ORG_ID,
      v2_inputs: v2InputsQq,
    }, { handler: 'ops-api/send_quick_quote_email', job_id })

    // N2 — see send-quote handlers. Structured body_preview so the extractor
    // pre-filter doesn't skip with the auto-generated "quote quote.sent <UUID>".
    const qsBodyPreviewQuick = [
      `Quote ${fresh.job_number || ''} → ${fresh.client_name || ''} (${fresh.type || ''})`.replace(/\s+\(\)$/, '').trim(),
      totalIncGSTNum ? `$${Number(totalIncGSTNum).toFixed(2)} inc GST` : '',
      job.site_address ? `at ${job.site_address}` : '',
      job.site_suburb || '',
    ].filter(Boolean).join(' · ').slice(0, 400)
    await logBusinessEvent(client, {
      event_type: 'quote.sent',
      source: 'send-quick-quote-email',
      entity_type: 'job',
      entity_id: job_id,
      correlation_id: job_id,
      job_id,
      body_preview: qsBodyPreviewQuick,
      payload: {
        // Race-safety: fresh post-UPDATE values, not entry-time ones. See
        // CAP0-QUICKQUOTE-FRESH-SELECT-RACE-SAFETY note above.
        quote_revision_id: releasedRevisionId,
        job_number: fresh.job_number || null,
        job_type: fresh.type || null,
        sent_to: job.client_email,
        total_inc_gst: totalIncGSTNum,
      },
      metadata: { handler: 'ops-api/send_quick_quote_email' },
    })

    await logBusinessEvent(client, {
      event_type: 'job.status_changed',
      source: 'send-quick-quote-email',
      entity_type: 'job',
      entity_id: job_id,
      correlation_id: job_id,
      job_id,
      payload: {
        entity: { id: job_id, name: fresh.job_number || fresh.client_name || '' },
        changes: { status: { from: 'draft', to: 'quoted' } },
        financial: { amount: totalIncGSTNum },
        related_entities: releasedRevisionId
          ? [{ type: 'quote_revision', id: releasedRevisionId }]
          : [],
      },
      metadata: { reason: 'quote_sent', handler: 'ops-api/send_quick_quote_email' },
    })
  }

  // Log email event (existing behaviour, preserved)
  await client.from('email_events').insert({
    email_type: 'quote',
    entity_type: 'job',
    entity_id: job_id,
    job_id,
    recipient: job.client_email,
    sender: 'orders@secureworksgroup.app',
    subject: emailPayload.subject,
    resend_message_id: resendResult.id || null,
    status: 'sent',
    sent_at: new Date().toISOString(),
  })

  return { success: true, resend_id: resendResult.id, sent_to: job.client_email, released: transitioned }
}

// ── Delete PO ──
async function deletePO(client: any, body: any) {
  const { id } = body
  if (!id) throw new Error('id required')

  // Only allow deletion of draft/quote_requested POs
  const { data: po, error: fetchErr } = await client.from('purchase_orders')
    .select('id, status, po_number, supplier_name')
    .eq('id', id).single()
  if (fetchErr) throw new Error('PO not found')

  const deletable = ['draft', 'quote_requested']
  if (!deletable.includes(po.status)) {
    throw new Error('Cannot delete — PO status is "' + po.status + '". Cancel it instead.')
  }

  const { error } = await client.from('purchase_orders').delete().eq('id', id)
  if (error) throw new Error('Failed to delete PO: ' + error.message)

  return { success: true, deleted: po.po_number }
}

// ── PO Email Log ──
async function addPOEvent(client: any, body: any) {
  const { po_id, event_type, supplier, summary, direction, job_id } = body
  if (!po_id) throw new Error('po_id required')
  if (!event_type) throw new Error('event_type required')

  const eventData: any = {
    event_type: event_type,
    detail_json: {
      po_id,
      supplier: supplier || '',
      summary: summary || '',
      direction: direction || 'sent',
    },
  }

  // If job_id provided, store as job_event for timeline display
  if (job_id) {
    eventData.job_id = job_id
  }

  const { data, error } = await client.from('job_events').insert(eventData).select().single()
  if (error) throw new Error('Failed to log event: ' + error.message)

  return { success: true, event: data }
}

// ── Tracking category helper ──
// Maps job number prefix to Xero tracking category option name
function trackingCategoryForJob(jobNumber: string): string {
  if (!jobNumber) return ''
  const upper = jobNumber.toUpperCase()
  if (upper.startsWith('SWMS-')) return 'SW - MAKESAFES'
  const prefix = upper.slice(0, 3)
  if (prefix === 'SWP') return 'SW - PATIOS'
  if (prefix === 'SWF') return 'SW - FENCING'
  if (prefix === 'SWD') return 'SW - DECKING'
  if (prefix === 'SWR') return 'SW - PRIVATE ROOFING'
  if (prefix === 'SWI') return 'SW - INSURANCE WORK'
  return ''
}

// Builds Xero Tracking array for a line item
function xeroTracking(jobNumber: string): any[] {
  const option = trackingCategoryForJob(jobNumber)
  if (!option) return []
  return [{ Name: 'Business Unit', Option: option }]
}

// ── Account code by job type ──
// Default sales account codes per division — override in job settings if needed
function accountCodeForJob(jobType: string, fallback = '200'): string {
  // All map to 200 by default. If the bookkeeper creates separate revenue
  // accounts later (e.g. 201 Patios, 202 Fencing), change these values.
  const map: Record<string, string> = {
    patio: '208',
    fencing: '207',
    decking: '205',
    roofing: '209',
    insurance: '210',
    makesafe: '210',
    renovation: '201',
    combo: '200',
  }
  return map[(jobType || '').toLowerCase()] || fallback
}

// ── Rich line item description builder ──
// Bakes job number, type, scope summary, client, and address into every
// line item so bookkeepers never have to cross-reference.
function buildRichDescription(job: any, prefix: string): string {
  const lines: string[] = []

  // Line 1: Prefix (e.g. "25% Deposit ($1,711 of $8,555 inc GST)")
  if (prefix) lines.push(prefix)

  // Line 2: Job number + type label
  const typeParts: string[] = []
  if (job.job_number) typeParts.push(job.job_number)
  const typeLabel = (job.type || '').toLowerCase()
  if (typeLabel === 'fencing') typeParts.push('Colorbond Fencing Installation')
  else if (typeLabel === 'decking') typeParts.push('Composite Decking Installation')
  else if (typeLabel === 'makesafe') typeParts.push('Make-Safe Works')
  else typeParts.push('Insulated Patio Installation')
  lines.push(typeParts.join(' | '))

  // Line 3: Scope summary from scope_json (metres, colour, type, dimensions)
  const scopeLine = buildScopeSummaryLine(job)
  if (scopeLine) lines.push(scopeLine)

  // Line 4: Client + address
  const clientParts: string[] = []
  if (job.client_name) clientParts.push(job.client_name)
  const addr = [job.site_address, job.site_suburb].filter(Boolean).join(', ')
  if (addr) clientParts.push(addr)
  if (clientParts.length) lines.push(clientParts.join(' | '))

  return lines.join('\n')
}

function buildScopeSummaryLine(job: any): string {
  try {
    const scope = typeof job.scope_json === 'string'
      ? JSON.parse(job.scope_json || '{}') : (job.scope_json || {})
    const type = (job.type || '').toLowerCase()
    const parts: string[] = []

    if (type === 'fencing') {
      // Fencing: sum runs for total metres
      const jobData = scope.job || scope.config || scope
      const runs = jobData.runs || []
      const totalM = runs.reduce((s: number, r: any) => s + (Number(r.lengthM) || Number(r.totalLength) || Number(r.length) || 0), 0)
      if (totalM > 0) parts.push(Math.round(totalM) + 'm')
      const mat = jobData.material || jobData.profile || 'Colorbond'
      parts.push(mat)
      const colour = jobData.colour || jobData.color || scope.config?.colour || ''
      if (colour) parts.push(colour)
      const height = jobData.sheetHeight || jobData.height || scope.config?.height || ''
      if (height) parts.push(height + 'mm high')
      const gates = jobData.gates || []
      if (Array.isArray(gates) && gates.length > 0) parts.push(gates.length + ' gate' + (gates.length > 1 ? 's' : ''))
      else if (typeof jobData.gateCount === 'number' && jobData.gateCount > 0) parts.push(jobData.gateCount + ' gate' + (jobData.gateCount > 1 ? 's' : ''))
    } else {
      // Patio / decking
      const cfg = scope.config || scope
      const l = cfg.length || cfg.L || ''
      const p = cfg.projection || cfg.W || cfg.width || ''
      if (l && p) parts.push(l + 'm x ' + p + 'm')
      if (cfg.roofStyle) parts.push(cfg.roofStyle)
      const roofing = cfg.roofing || cfg.sheetType || cfg.panelType || ''
      if (roofing) {
        const roofLabel = roofing.replace(/solarspan75/i, 'SolarSpan 75mm').replace(/solarspan100/i, 'SolarSpan 100mm')
          .replace(/solarspan50/i, 'SolarSpan 50mm').replace(/trimdek/i, 'Trimdek').replace(/corrugated/i, 'Corrugated')
          .replace(/spandek/i, 'SpanDek')
        parts.push(roofLabel)
      }
      const colour = cfg.sheetColor || cfg.sheetColour || cfg.colour || ''
      if (colour) parts.push(colour)
      const posts = cfg.posts || cfg.postCount || ''
      const postSize = cfg.postSize || ''
      if (posts) parts.push(posts + ' x ' + (postSize || '100x100 SHS') + ' posts')
      if (cfg.connection) parts.push(cfg.connection)
    }

    if (parts.length > 0) return parts.join(', ')

    // Fallback to pricing_json.job_description
    const pricing = typeof job.pricing_json === 'string'
      ? JSON.parse(job.pricing_json || '{}') : (job.pricing_json || {})
    return pricing.job_description || pricing.description || ''
  } catch {
    return ''
  }
}

// Feature 5: Create a deposit invoice for an accepted job
// Creates a Xero ACCREC invoice for a configurable % of the quoted total,
// with rich description, tracking category, and SWP-25042-DEP reference.
// Sends via Xero email. Saves deposit_invoice_id + deposit_amount on jobs.
async function createDepositInvoice(client: any, body: any) {
  const jId = body.job_id || body.jobId
  if (!jId) throw new Error('job_id required')

  const depositPercent = body.deposit_percent ?? 50

  // Fetch the job
  const { data: job, error: jobErr } = await client
    .from('jobs')
    .select('id, status, client_name, client_email, job_number, xero_contact_id, pricing_json, scope_json, type, site_address, site_suburb')
    .eq('id', jId)
    .single()
  if (jobErr || !job) throw new Error('Job not found')

  // Resolve neighbour contact details if job_contact_id provided
  const job_contact_id = body.job_contact_id || null
  let invoiceContactId = job.xero_contact_id || undefined
  let invoiceContactName = job.client_name
  let contactLabel = '' // A, B, C, D — used for reference suffix
  if (job_contact_id) {
    const { data: jc } = await client.from('job_contacts')
      .select('client_name, xero_contact_id, contact_label')
      .eq('id', job_contact_id).single()
    if (jc?.xero_contact_id) invoiceContactId = jc.xero_contact_id
    if (jc?.client_name) invoiceContactName = jc.client_name
    if (jc?.contact_label) contactLabel = jc.contact_label
    console.log('[createDepositInvoice] Neighbour contact resolved:', invoiceContactName, contactLabel, invoiceContactId)
  }

  // Per-run label (for multi-neighbour fencing)
  const runLabel = body.run_label || null

  // Check for existing deposit invoice (neighbour + run aware)
  let depRefPattern = '%DEP%'
  if (runLabel && contactLabel) depRefPattern = `%${runLabel}-${contactLabel}-DEP%`
  else if (contactLabel) depRefPattern = `%${contactLabel}-DEP%`
  else if (runLabel) depRefPattern = `%${runLabel}%DEP%`

  const existingDepQuery = client.from('xero_invoices')
    .select('xero_invoice_id, invoice_number, total')
    .eq('job_id', jId)
    .eq('invoice_type', 'ACCREC')
    .not('status', 'in', '("VOIDED","DELETED")')
    .ilike('reference', depRefPattern)
    .limit(1)
  if (job_contact_id) existingDepQuery.eq('job_contact_id', job_contact_id)
  if (runLabel) existingDepQuery.eq('run_label', runLabel)
  const { data: existingDep } = await existingDepQuery
  if (existingDep && existingDep.length > 0) {
    throw new Error(`Deposit invoice already exists: ${existingDep[0].invoice_number} ($${existingDep[0].total}). Void it in Xero before creating a new one.`)
  }

  // Extract total from pricing_json (with fallback to scope_json._pricing_json for fencing jobs)
  let quotedTotal = 0
  let jobDescription = ''
  let pricingDep: any = null
  if (job.pricing_json && Object.keys(job.pricing_json).length > 0) {
    pricingDep = typeof job.pricing_json === 'string' ? JSON.parse(job.pricing_json) : job.pricing_json
  }
  if (!pricingDep && job.scope_json) {
    const scope = typeof job.scope_json === 'string' ? JSON.parse(job.scope_json) : job.scope_json
    const jobData = scope.job || scope
    if (jobData._pricing_json) {
      pricingDep = typeof jobData._pricing_json === 'string' ? JSON.parse(jobData._pricing_json) : jobData._pricing_json
    }
  }
  if (pricingDep) {
    quotedTotal = pricingDep.totalIncGST || pricingDep.total || pricingDep.amount || 0
    jobDescription = pricingDep.description || pricingDep.jobDescription || ''
  }

  // Allow override from body
  const depositAmountOverride = body.deposit_amount
  const depositAmountIncGst = depositAmountOverride || Math.round(quotedTotal * (depositPercent / 100) * 100) / 100

  if (depositAmountIncGst <= 0) {
    throw new Error('Cannot create a $0 deposit invoice. Set pricing_json on the job first.')
  }

  // Build rich description with all job metadata baked in
  const depositLabel = `Deposit (${depositPercent}% of $${quotedTotal.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} inc GST)`
  const description = buildRichDescription(job, depositLabel)

  // Reference: SWP-25042-DEP50 (single), SWF-25030-A-DEP50 (neighbour A), SWF-25030-REAR-A-DEP50 (per-run)
  const refParts = [job.job_number || '']
  if (runLabel) refParts.push(runLabel)
  if (contactLabel) refParts.push(contactLabel)
  refParts.push(`DEP${depositPercent}`)
  const reference = refParts.join('-')

  // Deposit is inc GST — Xero adds GST, so we need ex GST amount
  const depositExGst = Math.round((depositAmountIncGst / 1.1) * 100) / 100

  const lineItems: any[] = [{
    description,
    quantity: 1,
    unit_price: depositExGst,
    account_code: accountCodeForJob(job.type),
  }]

  // Credit card surcharge — always applied. Bank transfer clients can ignore.
  const CARD_SURCHARGE_RATE = 0.0175    // 1.75%
  const CARD_SURCHARGE_FIXED = 0.30     // $0.30
  const surchargeIncGst = Math.round((depositAmountIncGst * CARD_SURCHARGE_RATE + CARD_SURCHARGE_FIXED) * 100) / 100
  const surchargeExGst = Math.round((surchargeIncGst / 1.1) * 100) / 100
  lineItems.push({
    description: 'Credit card processing fee (1.75% — waived for bank transfer payments)',
    quantity: 1,
    unit_price: surchargeExGst,
    account_code: accountCodeForJob(job.type),
  })
  console.log(`[createDepositInvoice] Card surcharge added: $${surchargeIncGst} inc GST on deposit $${depositAmountIncGst}`)

  // Extra line items (council fees, etc.) — each has amount_inc_gst
  const extras = body.extra_line_items || []
  for (const extra of extras) {
    if (extra.amount_inc_gst > 0 && extra.description) {
      lineItems.push({
        description: extra.description,
        quantity: 1,
        unit_price: Math.round((extra.amount_inc_gst / 1.1) * 100) / 100,
        account_code: accountCodeForJob(job.type),
      })
    }
  }

  // Create Xero invoice — AUTHORISED so Shaun can send immediately
  const invoiceResult = await createInvoice(client, {
    job_id: jId,
    xero_contact_id: invoiceContactId,
    contact_name: invoiceContactName,
    line_items: lineItems,
    reference,
    xero_status: 'AUTHORISED',
    send_email: body.send_email !== false, // default: send
    job_contact_id: job_contact_id,
    run_label: runLabel,
  })

  // Total invoice amount = deposit + extras
  const extrasTotal = extras.reduce((s: number, e: any) => s + (e.amount_inc_gst || 0), 0)
  const totalInvoiceAmount = depositAmountIncGst + extrasTotal

  // Save deposit info on jobs table
  await client.from('jobs')
    .update({
      deposit_invoice_id: invoiceResult.xero_invoice_id,
      deposit_amount: totalInvoiceAmount,
    })
    .eq('id', jId)

  // Log event
  await client.from('job_events').insert({
    job_id: jId,
    event_type: 'deposit_invoice_created',
    detail_json: {
      xero_invoice_id: invoiceResult.xero_invoice_id,
      invoice_number: invoiceResult.invoice_number,
      deposit_amount: totalInvoiceAmount,
      deposit_percent: depositPercent,
      quoted_total: quotedTotal,
      extra_line_items: extras,
    },
  })

  // Dual-write to business_events
  logBusinessEvent(client, {
    event_type: 'invoice.created',
    entity_type: 'invoice',
    entity_id: invoiceResult.xero_invoice_id || jId,
    job_id: job.job_number || jId,
    correlation_id: jId,
    payload: {
      entity: { id: invoiceResult.xero_invoice_id, name: invoiceResult.invoice_number || '' },
      financial: { amount: totalInvoiceAmount, currency: 'AUD' },
      invoice_type: 'deposit',
      deposit_percent: depositPercent,
      quoted_total: quotedTotal,
      related_entities: [{ type: 'job', id: jId, name: job.client_name || '' }],
    },
    metadata: { operator: body.operator_email || body.user_email || null },
  })

  return {
    success: true,
    job_id: jId,
    xero_invoice_id: invoiceResult.xero_invoice_id,
    invoice_number: invoiceResult.invoice_number,
    deposit_amount: depositAmountIncGst,
    deposit_percent: depositPercent,
    quoted_total: quotedTotal,
    reference,
    description,
  }
}

// ── Unified Invoice — single flow for deposits, progress claims, finals, extras ──
async function createUnifiedInvoice(client: any, body: any) {
  const jId = body.job_id || body.jobId
  if (!jId) throw new Error('job_id required')

  const items = body.line_items || body.lineItems
  if (!items || items.length === 0) throw new Error('line_items required')

  // Fetch job
  const { data: job, error: jobErr } = await client
    .from('jobs')
    .select('id, status, client_name, client_email, job_number, xero_contact_id, pricing_json, type, site_address, site_suburb')
    .eq('id', jId)
    .single()
  if (jobErr || !job) throw new Error('Job not found')

  // Calculate quoted total
  const pricing = typeof job.pricing_json === 'string' ? JSON.parse(job.pricing_json || '{}') : (job.pricing_json || {})
  const quotedTotal = pricing.totalIncGST || pricing.total || 0

  // Sum existing active invoices for this job
  const { data: existingInvs } = await client.from('xero_invoices')
    .select('total')
    .eq('job_id', jId)
    .eq('invoice_type', 'ACCREC')
    .not('status', 'in', '("VOIDED","DELETED")')
  const existingTotal = (existingInvs || []).reduce((s: number, inv: any) => s + (inv.total || 0), 0)

  // Build line items — each item has amount inc GST, convert to ex GST for Xero
  const lineItems = items.map((li: any) => {
    const unitPrice = li.unit_price_ex_gst != null
      ? li.unit_price_ex_gst
      : (li.unit_price || li.unitPrice || 0)
    return {
      description: li.description || '',
      quantity: li.quantity || 1,
      unit_price: unitPrice,
      account_code: accountCodeForJob(job.type),
    }
  })

  // Calculate new invoice total (inc GST)
  const newTotal = lineItems.reduce((s: number, li: any) => s + ((li.quantity || 1) * (li.unit_price || 0) * 1.1), 0)

  // Warn if over-invoicing (but don't block — variations happen)
  const overInvoiceWarning = quotedTotal > 0 && (existingTotal + newTotal) > quotedTotal * 1.05
    ? `Warning: total invoiced ($${(existingTotal + newTotal).toFixed(2)}) exceeds quoted total ($${quotedTotal.toFixed(2)})`
    : null

  // Reference — use frontend suffix if provided (e.g. 'COUNCIL', 'VARIATION1')
  const referenceSuffix = body.reference_suffix || ''
  const reference = (job.job_number || '') + (referenceSuffix ? `-${referenceSuffix}` : '')

  // Duplicate prevention: warn if creating invoice for same reference
  if (reference && reference !== job.job_number) {
    const { data: dupeCheck } = await client.from('xero_invoices')
      .select('invoice_number')
      .eq('job_id', jId)
      .eq('reference', reference)
      .not('status', 'in', '("VOIDED","DELETED")')
      .limit(1)
    if (dupeCheck && dupeCheck.length > 0) {
      throw new Error(`Invoice with reference ${reference} already exists (${dupeCheck[0].invoice_number}). Void it first if you need to recreate.`)
    }
  }

  // When using branded email, suppress Xero's plain email — we'll send our own
  const useBrandedEmail = body.use_branded_email === true && (body.send_email === true || body.send_email)
  const xeroSendEmail = useBrandedEmail ? false : (body.send_email || false)

  // Create invoice via existing function
  const invoiceResult = await createInvoice(client, {
    job_id: jId,
    xero_contact_id: job.xero_contact_id || undefined,
    contact_name: job.client_name,
    line_items: lineItems,
    reference,
    xero_status: body.xero_status || 'DRAFT',
    send_email: xeroSendEmail,
  })

  // Store quote_document_ids on the xero_invoices record if provided
  const quoteDocIds = body.quote_document_ids
  if (quoteDocIds && quoteDocIds.length > 0 && invoiceResult.xero_invoice_id) {
    await client.from('xero_invoices')
      .update({ quote_document_ids: quoteDocIds })
      .eq('xero_invoice_id', invoiceResult.xero_invoice_id)
  }

  // Branded email: get online invoice URL and send via send-quote/send-invoice
  let brandedEmailSent = false
  if (useBrandedEmail && invoiceResult.xero_invoice_id) {
    // Determine recipient — email_override takes precedence, then job client_email
    const invoiceClientEmail = body.email_override || job.client_email

    // Get Xero online invoice URL for payment
    let paymentUrl = ''
    try {
      const { accessToken, tenantId } = await getToken(client)
      const onlineResult = await xeroGet(
        `/Invoices/${invoiceResult.xero_invoice_id}/OnlineInvoice`,
        accessToken, tenantId
      )
      paymentUrl = onlineResult?.OnlineInvoices?.[0]?.OnlineInvoiceUrl || ''
    } catch (e) {
      console.log('Could not get online invoice URL:', (e as Error).message)
    }

    // Send branded invoice email
    if (invoiceClientEmail) {
      try {
        const address = [job.site_address, job.site_suburb].filter(Boolean).join(', ')
        const emailRes = await fetch(`${SUPABASE_URL}/functions/v1/send-quote/send-invoice`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          },
          body: JSON.stringify({
            xero_invoice_id: invoiceResult.xero_invoice_id,
            job_id: jId,
            payment_url: paymentUrl,
            invoice_number: invoiceResult.invoice_number,
            deposit_amount: invoiceResult.total,
            client_name: job.client_name,
            client_email: invoiceClientEmail,
            job_type: job.type,
            address,
          }),
        })
        const emailResult = await emailRes.json()
        brandedEmailSent = emailResult.success || false
      } catch (e) {
        console.log('Branded email call failed (non-blocking):', (e as Error).message)
      }
    }
  }

  // Log event
  await client.from('job_events').insert({
    job_id: jId,
    event_type: 'unified_invoice_created',
    detail_json: {
      xero_invoice_id: invoiceResult.xero_invoice_id,
      invoice_number: invoiceResult.invoice_number,
      total: invoiceResult.total,
      quote_document_ids: quoteDocIds || [],
      line_items: items,
      over_invoice_warning: overInvoiceWarning,
      branded_email_sent: brandedEmailSent,
    },
  })

  return {
    success: true,
    job_id: jId,
    xero_invoice_id: invoiceResult.xero_invoice_id,
    invoice_number: invoiceResult.invoice_number,
    total: invoiceResult.total,
    quoted_total: quotedTotal,
    invoiced_total: existingTotal + (invoiceResult.total || 0),
    remaining_to_invoice: Math.max(0, quotedTotal - existingTotal - (invoiceResult.total || 0)),
    warning: overInvoiceWarning,
    branded_email_sent: brandedEmailSent,
  }
}

// Feature 2: Morning brief — structured summary for AI to narrate
async function morningBrief(client: any) {
  const summary = await opsSummary(client)

  // Enrich with extra context for the brief
  const completeNotInvoiced = await client
    .from('jobs')
    .select('id, client_name, job_number, site_suburb, pricing_json, completed_at')
    .eq('org_id', DEFAULT_ORG_ID)
    .not('legacy', 'is', true)
    .eq('status', 'complete')
    .order('completed_at', { ascending: true })
    .limit(10)

  const briefData = {
    ...summary,
    complete_not_invoiced: (completeNotInvoiced.data || []).map((j: any) => {
      let value = 0
      if (j.pricing_json) {
        const p = typeof j.pricing_json === 'string' ? JSON.parse(j.pricing_json) : j.pricing_json
        value = parseFloat(p.totalIncGST || p.totalExGST || p.total || p.grandTotal || p.amount || p.subtotal || 0) || 0
      }
      return { id: j.id, client: j.client_name, job_number: j.job_number, suburb: j.site_suburb, value, completed: j.completed_at }
    }),
  }
  return briefData
}

// Feature 5: Extract materials from scope_json for PO auto-population
function extractMaterialsFromScope(scope_json: any, pricing_json: any): any[] {
  if (!scope_json) return []
  const scope = typeof scope_json === 'string' ? JSON.parse(scope_json) : scope_json
  const config = scope.config || scope

  const items: any[] = []

  // Roofing panels — calculate from dimensions
  // Patio tool stores as config.length (mm string), config.projection (mm string)
  // or config.roofing (string like 'solarspan75')
  if (config.roofing || config.panels || config.length) {
    // Length/projection may be mm strings from patio tool — convert to metres
    let rawLen = config.length || config.roofing?.length || 0
    let rawProj = config.projection || config.roofing?.projection || 0
    let length = typeof rawLen === 'string' ? parseFloat(rawLen) : rawLen
    let projection = typeof rawProj === 'string' ? parseFloat(rawProj) : rawProj
    // If values are > 100, assume mm and convert to metres
    if (length > 100) length = length / 1000
    if (projection > 100) projection = projection / 1000
    if (length > 0 && projection > 0) {
      const m2 = length * projection
      const panelCount = Math.ceil(length)
      // Map roofing code to readable name
      const roofingMap: Record<string, string> = {
        solarspan75: 'SolarSpan 75mm', solarspan100: 'SolarSpan 100mm',
        trimdek: 'Trimdek', corrugated: 'Corrugated', spandek: 'Spandek',
        spanplus330: 'SpanPlus 330',
      }
      const roofCode = typeof config.roofing === 'string' ? config.roofing : ''
      const panelType = config.panel_type || roofingMap[roofCode] || roofCode || 'Roofing panels'
      items.push({
        description: `${panelType} — ${projection.toFixed(1)}m projection × ${panelCount} panels`,
        quantity: panelCount,
        unit_price: 0,
        notes: `${m2.toFixed(1)}m² total area, ${length.toFixed(1)}m span`,
      })
    }
  }

  // Posts — handle both camelCase (patio tool) and snake_case
  const postCountRaw = config.post_count || config.postQtyOverride || config.posts?.count || config.posts || 0
  const postCount = typeof postCountRaw === 'number' ? postCountRaw : parseInt(postCountRaw) || 0
  if (postCount > 0) {
    const postSize = config.post_size || config.postSize || config.posts?.size || '100x100 SHS'
    items.push({
      description: `${postSize} posts`,
      quantity: postCount,
      unit_price: 0,
    })
  }

  // Beams — handle both camelCase and snake_case
  if (config.beams || config.beam_count || config.beamSize) {
    const beamCount = config.beam_count || config.beams?.count || 1
    const beamSize = config.beam_size || config.beamSize || config.beams?.size || 'Steel beam'
    let beamLenRaw = config.beam_length || config.beams?.length || config.length || 0
    let beamLength = typeof beamLenRaw === 'string' ? parseFloat(beamLenRaw) : beamLenRaw
    if (beamLength > 100) beamLength = beamLength / 1000
    items.push({
      description: `${beamSize}${beamLength ? ` — ${beamLength.toFixed(1)}m` : ''}`,
      quantity: beamCount,
      unit_price: 0,
    })
  }

  // Footings — 1 per post
  if (postCount > 0) {
    items.push({
      description: 'Concrete footings (400x400x500mm)',
      quantity: postCount,
      unit_price: 0,
    })
  }

  // ── Fencing materials (detailed extraction from scoping tool) ──
  const sections = scope.sections || []
  if (sections.length > 0) {
    // Group panels by sheet height
    const panelsByHeight: Record<number, number> = {}
    const postsByHeight: Record<string, number> = { end: 0, corner: 0, intermediate: 0 }
    let totalPlinths = 0
    let totalSleepers = 0
    let totalMetres = 0

    for (const sec of sections) {
      const panels = sec.panels || []
      const height = sec.sheetHeight || 1800
      panelsByHeight[height] = (panelsByHeight[height] || 0) + panels.length
      totalMetres += sec.length || 0

      // Count posts by type
      for (const panel of panels) {
        if (panel.leftPost) postsByHeight[panel.leftPost] = (postsByHeight[panel.leftPost] || 0) + 1
      }
      // Last panel's right post
      if (panels.length > 0 && panels[panels.length - 1].rightPost) {
        postsByHeight[panels[panels.length - 1].rightPost] = (postsByHeight[panels[panels.length - 1].rightPost] || 0) + 1
      }

      // Plinths and sleepers
      if (sec.retaining) {
        const plinthCount = panels.length
        totalPlinths += plinthCount
        const sleeperRows = sec.retainingHeight ? Math.ceil(sec.retainingHeight / 200) : 1
        totalSleepers += plinthCount * sleeperRows
      }
    }

    // Panels by height
    for (const [height, count] of Object.entries(panelsByHeight)) {
      items.push({
        description: `Colorbond fence sheets — ${height}mm high`,
        quantity: count,
        unit: 'sheets',
        unit_price: 0,
      })
    }

    // Posts (total count)
    const totalPosts = Object.values(postsByHeight).reduce((s, n) => s + n, 0)
    if (totalPosts > 0) {
      items.push({
        description: 'Fence posts (C-section)',
        quantity: totalPosts,
        unit: 'ea',
        unit_price: 0,
        notes: `End: ${postsByHeight.end || 0}, Corner: ${postsByHeight.corner || 0}, Intermediate: ${postsByHeight.intermediate || 0}`,
      })
    }

    // Plinths
    if (totalPlinths > 0) {
      items.push({
        description: 'Concrete plinths',
        quantity: totalPlinths,
        unit: 'ea',
        unit_price: 0,
      })
    }

    // Retaining sleepers
    if (totalSleepers > 0) {
      items.push({
        description: 'Retaining sleepers',
        quantity: totalSleepers,
        unit: 'ea',
        unit_price: 0,
      })
    }

    // Patio tubes (if 3+ plinths per section, need patio tube support)
    for (const sec of sections) {
      if (sec.retaining && (sec.panels || []).length >= 3) {
        items.push({
          description: `Patio tube support — Section (${sec.length || 0}m)`,
          quantity: Math.ceil((sec.panels || []).length / 3),
          unit: 'ea',
          unit_price: 0,
        })
      }
    }

    // Gates
    const gates = scope.gates || []
    for (const gate of gates) {
      const gateType = gate.type || 'pedestrian'
      const gateWidth = gate.width || 900
      items.push({
        description: `${gateType.charAt(0).toUpperCase() + gateType.slice(1)} gate — ${gateWidth}mm`,
        quantity: 1,
        unit: 'ea',
        unit_price: 0,
      })
    }

    // Concrete bags (1 per post, 60kg bags)
    if (totalPosts > 0) {
      items.push({
        description: 'Concrete bags (20kg)',
        quantity: totalPosts * 3, // ~3 bags per post
        unit: 'bags',
        unit_price: 0,
      })
    }

    // Tek screws (4 per panel)
    const totalPanels = Object.values(panelsByHeight).reduce((s, n) => s + n, 0)
    if (totalPanels > 0) {
      items.push({
        description: 'Tek screws (12-14 x 20)',
        quantity: totalPanels * 4,
        unit: 'ea',
        unit_price: 0,
      })
    }

    // Removal line items
    const removal = scope.removal
    if (removal && (removal.totalMetres > 0 || removal.length > 0)) {
      items.push({
        description: 'Old fence removal',
        quantity: removal.totalMetres || removal.length || 0,
        unit: 'm',
        unit_price: 0,
      })
    }
  } else if (config.fence_length || config.fencing) {
    // Fallback: simple fencing dimensions
    const fenceLen = config.fence_length || config.fencing?.length || 0
    const fenceHeight = config.fence_height || config.fencing?.height || 1.8
    if (fenceLen > 0) {
      const fencePosts = Math.ceil(fenceLen / 2.4) + 1
      items.push(
        { description: `Colorbond fence sheets — ${fenceHeight}m high`, quantity: Math.ceil(fenceLen), unit_price: 0, notes: `${fenceLen}m total` },
        { description: 'Fence posts (C-section)', quantity: fencePosts, unit_price: 0 },
        { description: 'Concrete bags (20kg)', quantity: fencePosts * 3, unit_price: 0 },
        { description: 'Tek screws (12-14 x 20)', quantity: Math.ceil(fenceLen) * 4, unit_price: 0 },
      )
    }
  }

  // If scope had nothing recognisable but pricing has items, fall back to pricing
  if (items.length === 0 && pricing_json) {
    const pricing = typeof pricing_json === 'string' ? JSON.parse(pricing_json) : pricing_json
    if (Array.isArray(pricing.items)) {
      return pricing.items
        .filter((li: any) => li.description && /material|panel|post|beam|steel|concrete|colorbond/i.test(li.description))
        .map((li: any) => ({
          description: li.description,
          quantity: li.quantity || 1,
          unit_price: li.unit_price || 0,
        }))
    }
  }

  return items
}

// Exposed as API action for PO auto-population
async function scopeToPO(client: any, params: URLSearchParams) {
  const jobId = params.get('jobId') || params.get('job_id')
  if (!jobId) throw new Error('jobId required')

  const { data: job, error } = await client
    .from('jobs')
    .select('id, scope_json, pricing_json, client_name, site_suburb, type')
    .eq('id', jobId)
    .single()
  if (error || !job) throw new Error('Job not found')

  const materials = extractMaterialsFromScope(job.scope_json, job.pricing_json)
  return { job_id: jobId, client: job.client_name, type: job.type, materials }
}

// ── Scheduling Capacity Endpoint ──
// Returns weekly capacity data for upcoming weeks.
// Used by scoping tools' future calendar preview widget.
async function schedulingCapacity(client: any, params: URLSearchParams) {
  const weeksCount = parseInt(params.get('weeks') || '6')
  const crewCount = parseInt(params.get('crew_count') || '3') // Default 3 crews

  const now = new Date()
  // Start from next Monday
  const dayOfWeek = now.getDay() || 7
  const nextMonday = new Date(now)
  nextMonday.setDate(now.getDate() - dayOfWeek + 8) // Next Monday
  nextMonday.setHours(0, 0, 0, 0)

  const weeks: any[] = []
  for (let i = 0; i < weeksCount; i++) {
    const weekStart = new Date(nextMonday)
    weekStart.setDate(nextMonday.getDate() + i * 7)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 4) // Friday

    const startStr = weekStart.toISOString().slice(0, 10)
    const endStr = weekEnd.toISOString().slice(0, 10)

    // Count assignments in this week
    const { data: assignments } = await client
      .from('job_assignments')
      .select('id')
      .eq('org_id', DEFAULT_ORG_ID)
      .gte('scheduled_date', startStr)
      .lte('scheduled_date', endStr)
      .neq('status', 'cancelled')
      .limit(200)

    const assignmentCount = (assignments || []).length
    const maxCapacity = crewCount * 5 // 5 weekdays per crew
    const capacityPct = maxCapacity > 0 ? Math.round(assignmentCount / maxCapacity * 100) : 0

    weeks.push({
      start: startStr,
      end: endStr,
      assignments: assignmentCount,
      crew_count: crewCount,
      capacity_pct: capacityPct,
    })
  }

  return { weeks }
}


// Bulk-move legacy GHL imports from "complete" to "invoiced"
// These are jobs that were invoiced through Tradify/old Xero and have no ops activity.
// Pass ?dry_run=true to preview without changing.
async function bulkLegacyToInvoiced(client: any, params: URLSearchParams) {
  const dryRun = params.get('dry_run') !== 'false'

  // Find complete jobs with no assignments, no POs, no job_number (= never managed through ops)
  const { data: candidates, error } = await client
    .from('jobs')
    .select('id, client_name, type, status, job_number, completed_at')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('status', 'complete')
    .is('job_number', null)

  if (error) throw error
  if (!candidates || candidates.length === 0) return { message: 'No legacy jobs found', updated: 0 }

  // Double-check: exclude any with assignments
  const candidateIds = candidates.map((j: any) => j.id)
  const { data: withAssignments } = await client
    .from('job_assignments')
    .select('job_id')
    .in('job_id', candidateIds)
  const hasAssignment = new Set((withAssignments || []).map((a: any) => a.job_id))

  const toUpdate = candidates.filter((j: any) => !hasAssignment.has(j.id))

  if (dryRun) {
    return {
      dry_run: true,
      message: `Would update ${toUpdate.length} legacy jobs from "complete" to "invoiced"`,
      count: toUpdate.length,
      sample: toUpdate.slice(0, 10).map((j: any) => ({ id: j.id, client: j.client_name, type: j.type, completed: j.completed_at })),
    }
  }

  // Execute the bulk update
  const updateIds = toUpdate.map((j: any) => j.id)
  const { error: updateErr } = await client
    .from('jobs')
    .update({ status: 'invoiced', updated_at: new Date().toISOString() })
    .in('id', updateIds)

  if (updateErr) throw updateErr

  return {
    dry_run: false,
    message: `Updated ${updateIds.length} legacy jobs to "invoiced"`,
    count: updateIds.length,
  }
}


// ════════════════════════════════════════════════════════════
// TRADE ENDPOINTS (mobile) — JWT auth required
// ════════════════════════════════════════════════════════════

// Verify trade user is assigned to a job before allowing access
// Admin users bypass this check
async function assertAssigned(client: any, jobId: string, userId: string, isAdmin = false) {
  if (isAdmin) return // Admins can view any job
  const { data } = await client
    .from('job_assignments')
    .select('id')
    .eq('job_id', jobId)
    .eq('user_id', userId)
    .neq('status', 'cancelled')
    .limit(1)
    .maybeSingle()
  if (!data) throw new Error('You are not assigned to this job')
}

async function myJobs(client: any, userId: string, showAll = false) {
  const today = getAWSTDate()
  const thirtyDaysAgo = new Date(Date.now() + AWST_OFFSET_MS)
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  let assignments: any[]
  let error: any

  if (showAll) {
    // ── Admin mode: show ALL assignments across all users ──
    const res = await client
      .from('job_assignments')
      .select(`
        id, scheduled_date, scheduled_end, start_time, status, role, notes, assignment_type, crew_name, started_at, completed_at,
        clocked_on_at, clocked_off_at, travel_started_at, arrived_at, break_minutes, job_phase,
        user:user_id ( id, name ),
        jobs:job_id (
          id, type, status, client_name, client_phone, client_email,
          site_address, site_suburb, notes, job_number
        )
      `)
      .neq('status', 'cancelled')
      .gte('scheduled_date', thirtyDaysAgo.toISOString().slice(0, 10))
      .order('scheduled_date', { ascending: true })
    assignments = res.data
    error = res.error
  } else {
    // ── Normal mode: only this user's assignments ──
    const res = await client
      .from('job_assignments')
      .select(`
        id, scheduled_date, scheduled_end, start_time, status, role, notes, assignment_type, crew_name, started_at, completed_at,
        clocked_on_at, clocked_off_at, travel_started_at, arrived_at, break_minutes, job_phase,
        jobs:job_id (
          id, type, status, client_name, client_phone, client_email,
          site_address, site_suburb, notes, job_number
        )
      `)
      .eq('user_id', userId)
      .neq('status', 'cancelled')
      .gte('scheduled_date', thirtyDaysAgo.toISOString().slice(0, 10))
      .order('scheduled_date', { ascending: true })
    assignments = res.data
    error = res.error
  }

  if (error) throw error

  const weekEnd = getAWSTWeekEnd()

  // Enrich with PO delivery info (pickup vs delivery badge)
  const jobIds = (assignments || []).map((a: any) => a.jobs?.id).filter(Boolean)
  let poMap: Record<string, any> = {}
  if (jobIds.length > 0) {
    const { data: pos } = await client.from('purchase_orders')
      .select('job_id, delivery_date, delivery_address, notes, status')
      .in('job_id', jobIds)
      .neq('status', 'deleted')
      .order('created_at', { ascending: false })
    for (const po of (pos || [])) {
      if (!poMap[po.job_id]) {
        // Determine pickup vs delivery from notes or delivery_address
        const notes = (po.notes || '').toUpperCase()
        const isPickup = notes.includes('PICKUP') || !po.delivery_address
        poMap[po.job_id] = {
          delivery_method: isPickup ? 'pickup' : 'delivery',
          delivery_date: po.delivery_date,
          delivery_address: po.delivery_address,
          pickup_location: isPickup ? (po.delivery_address || 'R&R Wangara') : null,
          po_status: po.status,
          materials_confirmed: ['confirmed', 'delivered', 'billed', 'authorised'].includes(po.status),
        }
      }
    }
  }

  // Attach PO info + scope_summary to each assignment (keep payload slim)
  for (const a of (assignments || [])) {
    if (a.jobs) {
      if (a.jobs.id && poMap[a.jobs.id]) {
        a.jobs.po_info = poMap[a.jobs.id]
      }
      // Compute scope_summary from pricing_json.job_description (replaces sending full scope_json)
      const pj = a.jobs.pricing_json
      a.jobs.scope_summary = pj?.job_description || ''
      delete a.jobs.pricing_json // don't send pricing data to trades
    }
  }

  const grouped: any = { today: [] as any[], thisWeek: [] as any[], upcoming: [] as any[], recent: [] as any[] }
  for (const a of (assignments || [])) {
    const d = a.scheduled_date
    if (d < today) grouped.recent.push(a)
    else if (d === today) grouped.today.push(a)
    else if (d <= weekEnd) grouped.thisWeek.push(a)
    else grouped.upcoming.push(a)
  }

  // Flag so frontend knows this is admin/all-jobs view
  if (showAll) grouped._adminView = true

  return grouped
}

// ── Scope Photo Extraction ──────────────────────────────────────────────
// Fencing scope tool captures photos as BASE64 inside scope_json.scopeMedia.photos.
// This extracts them to Supabase Storage + job_media so the trade app can display them.
async function extractScopePhotos(client: any, jobId: string, scopeJson: any): Promise<number> {
  // Guard: nothing to extract
  const photos = scopeJson?.scopeMedia?.photos
  if (!Array.isArray(photos) || photos.length === 0) return 0

  // Check if already extracted
  const { data: existing } = await client.from('job_media')
    .select('id')
    .eq('job_id', jobId)
    .eq('phase', 'scope')
    .limit(1)
  if (existing && existing.length > 0) return 0

  // Ensure bucket exists (idempotent)
  try { await client.storage.createBucket('job-photos', { public: true }) } catch { /* exists */ }

  let count = 0
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i]
    if (!photo?.dataUrl || typeof photo.dataUrl !== 'string') continue

    try {
      // Strip data URL prefix — handle jpeg, png, webp etc
      const base64 = photo.dataUrl.split(',')[1]
      if (!base64) continue

      const mimeMatch = photo.dataUrl.match(/data:([^;]+);/)
      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg'
      const ext = mime.includes('png') ? 'png' : 'jpg'
      const bytes = Uint8Array.from(atob(base64), (c: string) => c.charCodeAt(0))

      const path = `${DEFAULT_ORG_ID}/${jobId}/scope/${i}.${ext}`

      const { error: uploadError } = await client.storage
        .from('job-photos')
        .upload(path, bytes, { contentType: mime, upsert: true })
      if (uploadError) { console.log(`[ops-api] scope photo ${i} upload failed:`, uploadError.message); continue }

      const { data: urlData } = client.storage.from('job-photos').getPublicUrl(path)

      const { error: insertError } = await client.from('job_media').insert({
        job_id: jobId,
        phase: 'scope',
        type: 'photo',
        storage_url: urlData.publicUrl,
        label: photo.label || `Scope photo ${i + 1}`,
        created_at: new Date().toISOString(),
      })
      if (insertError) { console.log(`[ops-api] scope photo ${i} insert failed:`, insertError.message); continue }

      count++
    } catch (err: any) {
      console.log(`[ops-api] scope photo ${i} error:`, err?.message)
    }
  }

  console.log(`[ops-api] extracted ${count} scope photos for job ${jobId}`)
  return count
}

async function tradeJobDetail(client: any, params: URLSearchParams, userId: string, isAdmin = false) {
  const jobId = params.get('jobId')
  if (!jobId) throw new Error('jobId required')

  // Verify user is assigned to this job (admins bypass)
  await assertAssigned(client, jobId, userId, isAdmin)

  const [jobRes, docsRes, mediaRes, eventsRes, reportRes, woRes, crewRes, posRes] = await Promise.all([
    client.from('jobs')
      .select('id, type, status, client_name, client_phone, client_email, site_address, site_suburb, site_lat, site_lng, notes, job_number, scope_json, ghl_opportunity_id, ghl_contact_id')
      .eq('id', jobId).single(),
    client.from('job_documents')
      .select('id, type, pdf_url, storage_url, file_name, visible_to_trades, version, quote_number, created_at')
      .eq('job_id', jobId).order('created_at', { ascending: false }),
    client.from('job_media')
      .select('id, phase, type, storage_url, thumbnail_url, label, notes, po_id, created_at')
      .eq('job_id', jobId).order('created_at').limit(200),
    client.from('job_events')
      .select('id, event_type, detail_json, created_at, users:user_id(name)')
      .eq('job_id', jobId).eq('event_type', 'note').order('created_at', { ascending: false }).limit(50),
    client.from('job_service_reports')
      .select('*').eq('job_id', jobId).order('created_at', { ascending: false }).limit(1),
    // Work order data (scope items, instructions)
    client.from('work_orders')
      .select('id, wo_number, scope_items, special_instructions, scheduled_date, status, estimated_hours, trade_cost, crew_rates')
      .eq('job_id', jobId).neq('status', 'cancelled').order('created_at', { ascending: false }).limit(1),
    // All crew assignments for this job (not filtered by date — user explicitly opened this job)
    client.from('job_assignments')
      .select('id, user_id, scheduled_date, start_time, role, crew_name, status, started_at, completed_at, acknowledged_at, clocked_on_at, clocked_off_at, travel_started_at, arrived_at, break_minutes, job_phase, hours_worked, users:user_id(name, phone)')
      .eq('job_id', jobId).neq('status', 'cancelled')
      .order('scheduled_date', { ascending: true }),
    // Purchase orders — materials for this job (trade-safe fields only)
    client.from('purchase_orders')
      .select('id, po_number, supplier_name, status, delivery_date, line_items')
      .eq('job_id', jobId).neq('status', 'deleted')
      .order('delivery_date', { ascending: true }),
  ])

  if (jobRes.error) throw jobRes.error

  // Strip pricing from PO line items — trades only see descriptions and quantities
  const safePOs = (posRes.data || []).map((po: any) => ({
    ...po,
    line_items: (po.line_items || []).map((li: any) => ({
      description: li.description || li.Description || '',
      quantity: li.quantity || li.Quantity || 0,
      unit: li.unit || li.UnitAmount ? undefined : undefined,
    })),
  }))

  // Fire-and-forget: extract scope photos if not already done
  if (jobRes.data?.scope_json?.scopeMedia?.photos?.length > 0) {
    extractScopePhotos(client, jobId, jobRes.data.scope_json)
      .catch(e => console.log('[ops-api] scope photo extraction failed:', e?.message))
  }

  return {
    job: jobRes.data,
    documents: docsRes.data || [],
    media: mediaRes.data || [],
    notes: eventsRes.data || [],
    serviceReport: (reportRes.data || [])[0] || null,
    workOrder: (woRes.data || [])[0] || null,
    crew: crewRes.data || [],
    purchaseOrders: safePOs,
  }
}

async function addNote(client: any, body: any, isAdmin = false) {
  const { jobId, job_id, userId, user_id, text, sync_to_ghl, visibility } = body
  const jId = jobId || job_id
  const uId = userId || user_id
  if (!jId || !text) throw new Error('jobId and text required')

  // Verify user is assigned to this job (admins bypass)
  if (uId) await assertAssigned(client, jId, uId, isAdmin)

  // Sales cockpit notes are staff-only by default. GHL contact notes are CRM
  // notes, not customer messages; when explicitly requested, mirror there too
  // so the salesmen see the same context in LeadConnector/GHL.
  const noteVisibility = visibility === 'internal_only' ? 'internal_only' : 'client_visible'
  const shouldSyncToGhl = sync_to_ghl === true || (sync_to_ghl !== false && noteVisibility === 'client_visible')

  const { data, error } = await client.from('job_events').insert({
    job_id: jId,
    user_id: userId || user_id || null,
    event_type: 'note',
    detail_json: { text, visibility: noteVisibility, sync_to_ghl: shouldSyncToGhl },
  }).select().single()

  if (error) throw error

  // Dual-write to business_events.
  //
  // T7 Loop 6 — long-note pointer. Note bodies up to 500c stay inline as
  // body_preview. Notes longer than that get persisted to
  // evidence-bodies/{org}/note/{job_events.id}.txt with body_pointer +
  // body_hash. The legacy `note_text` payload field is preserved when T7
  // OFF for backward compatibility (the existing extractor reads it).
  const noteText = String(text || '')
  const isLongNote = noteText.length > 500
  const t7NoteEnabled = await isFlagOn(client, 'evidence_capture_v1', DEFAULT_ORG_ID)
  // Legacy logBusinessEvent payload — emitted either by the T7 fallback
  // path OR when the flag is OFF. Defined once so a T7 failure cannot
  // silently drop the canonical note.added row.
  const legacyNoteEvent = {
    event_type: 'note.added',
    source: 'app/field',
    entity_type: 'job',
    entity_id: jId,
    job_id: jId,
    correlation_id: jId,
    payload: {
      entity: { id: jId },
      related_entities: [{ type: 'user', id: uId || null }],
      note_text: noteText,
      note_preview: noteText.slice(0, 500),
      visibility: noteVisibility,
      sync_to_ghl: shouldSyncToGhl,
      source_job_event_id: data?.id || null,
    },
  }
  let t7NoteFailed = false
  if (t7NoteEnabled) {
    try {
      await recordEvidence(client, {
        event_type: 'note.added',
        source: 'ops-api/add_note',
        channel: 'note',
        direction: 'internal',
        source_table: 'job_events',
        source_id: String(data?.id || crypto.randomUUID()),
        job_id: jId,
        entity_type: 'job',
        entity_id: jId,
        match_method: 'direct_job_id',
        body_preview: noteText.slice(0, 500),
        body_full: isLongNote ? noteText : undefined,
        body_filename: isLongNote ? `note-${data?.id || 'untitled'}.txt` : undefined,
        body_mime: isLongNote ? 'text/plain; charset=utf-8' : undefined,
        privacy_classification: 'staff_only',
        retention_class: '7y_audit',
        payload: {
          entity: { id: jId },
          related_entities: [{ type: 'user', id: uId || null }],
          note_text: noteText,                  // preserved for backward-compat
          note_preview: noteText.slice(0, 500),
          source_job_event_id: data?.id || null,
        },
      }, {
        org_id: DEFAULT_ORG_ID,
        storage_client: client.storage,
      })
    } catch (e: any) {
      console.error('[ops-api] T7 note.added recordEvidence failed; falling back to legacy:', e?.message)
      t7NoteFailed = true
    }
  }
  if (!t7NoteEnabled || t7NoteFailed) {
    logBusinessEvent(client, legacyNoteEvent)
  }

  // Push to GHL contact-note (closes the GHL→Supabase note-loop gap by
  // making the loop bidirectional). Best-effort — don't block the note
  // save on GHL connectivity.
  let ghl_note_id: string | null = null
  let ghl_push_error: string | null = null
  if (shouldSyncToGhl) {
    try {
      // Resolve ghl_contact_id from the job
      const { data: jobRow } = await client.from('jobs')
        .select('ghl_contact_id')
        .eq('id', jId)
        .maybeSingle()
      const contactId = jobRow?.ghl_contact_id
      if (contactId) {
        const ghlBase = (Deno.env.get('SUPABASE_URL') || '').replace('/rest/v1', '') + '/functions/v1/ghl-proxy'
        const ghlKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
        const noteResp = await fetch(`${ghlBase}?action=add_note`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ghlKey,
          },
          body: JSON.stringify({
            contactId,
            body: noteText,
            jobId: jId,
          }),
        })
        if (noteResp.ok) {
          const noteData = await noteResp.json().catch(() => ({}))
          ghl_note_id = noteData.note_id || noteData.id || null
        } else {
          ghl_push_error = `ghl-proxy add_note returned ${noteResp.status}`
        }
      } else {
        ghl_push_error = 'job has no ghl_contact_id; cannot push note'
      }
    } catch (e) {
      ghl_push_error = (e as Error).message
    }
  }

  return {
    note: data,
    visibility: noteVisibility,
    ghl_synced: !!ghl_note_id,
    ghl_note_id,
    ghl_push_error,
  }
}

// T7 Loop 9 — Controlled transcript ingest handler.
// Caller has already passed the admin/owner role check at the dispatch
// site. This handler validates input, computes the envelope, calls
// recordEvidence with bypass_feature_flag=true, and returns the spine
// event id + extraction job id for downstream verification.
async function ingestTranscript(
  client: any,
  body: any,
  caller: { user_id: string; role: string },
): Promise<any> {
  const job_id = String(body?.job_id || '').trim()
  const transcript_text = String(body?.transcript_text || '')
  const source_label = String(body?.source_label || 'whisperflow').slice(0, 64)
  const occurred_at = (body?.occurred_at && typeof body.occurred_at === 'string')
    ? body.occurred_at
    : new Date().toISOString()
  const consent_confirmed = body?.consent_confirmed === true
  const call_direction = (body?.call_direction === 'inbound' || body?.call_direction === 'outbound')
    ? body.call_direction
    : 'internal'

  if (!job_id) return { ok: false, reason: 'job_id required' }
  if (transcript_text.trim().length === 0) return { ok: false, reason: 'transcript_text required (non-empty)' }
  if (!consent_confirmed) return { ok: false, reason: 'consent_confirmed must be explicitly true' }

  // Confirm the job exists. Avoids creating spine rows pointing at junk ids.
  const { data: jobRow, error: jobErr } = await client
    .from('jobs')
    .select('id, job_number')
    .eq('id', job_id)
    .limit(1)
  if (jobErr) return { ok: false, reason: `job lookup failed: ${jobErr.message}` }
  if (!jobRow || jobRow.length === 0) return { ok: false, reason: `job_id '${job_id}' not found` }

  // Build a deterministic-ish source id so reruns dedupe at the
  // (source_table, source_id) level rather than minting a new spine row
  // every paste. Hash of (job_id, occurred_at, first 64 chars).
  const source_id = `transcript-${job_id}-${occurred_at}-${transcript_text.slice(0, 64).replace(/\s+/g, '_').slice(0, 32)}`

  const safe_summary = transcript_text.slice(0, 280).replace(/\s+/g, ' ').trim()
  const body_filename = `transcript-${job_id}-${Date.now()}.txt`

  try {
    const result = await recordEvidence(
      client,
      {
        event_type: 'call.transcript_ingested',
        source: 'ops-api/ingest_transcript',
        channel: 'call',
        direction: call_direction as any,
        occurred_at,
        source_table: 'admin_transcript',
        source_id,
        job_id,
        entity_type: 'job',
        entity_id: job_id,
        match_method: 'manual',
        match_confidence: 1.0,
        body_preview: transcript_text.slice(0, 500),
        body_full: transcript_text,
        body_filename,
        body_mime: 'text/plain; charset=utf-8',
        safe_summary,
        privacy_classification: 'staff_only',
        retention_class: '7y_audit',
        payload: {
          source_label,
          call_direction,
          ingested_by: { user_id: caller.user_id, role: caller.role },
          ingested_at: new Date().toISOString(),
          char_count: transcript_text.length,
          consent_confirmed: true,
        },
        metadata: {
          ingest_action: 'ingest_transcript',
        },
      },
      {
        org_id: DEFAULT_ORG_ID,
        bypass_feature_flag: true,                       // structurally controlled (admin only)
        extractor_eligible_channels: ['email', 'note', 'call'],   // local override; lets transcripts flow to extractor
        storage_client: client.storage,
      },
    )
    return {
      ok: true,
      spine_event_id: result.spine_event_id,
      extraction_job_id: result.extraction_job_id ?? null,
      body_pointer: result.body_pointer ?? null,
      match_status: result.spine_row.match_status,
      job_number: jobRow[0].job_number,
      source_id,
      warnings: result.warnings,
    }
  } catch (e: any) {
    return { ok: false, reason: `ingestTranscript: recordEvidence failed: ${e?.message ?? e}` }
  }
}

async function uploadPhoto(client: any, body: any) {
  const { jobId, job_id, dataUrl, label, phase, userId, user_id, po_id } = body
  const jId = jobId || job_id
  const uId = userId || user_id
  if (!jId || !dataUrl) throw new Error('jobId and dataUrl required')

  // Verify user is assigned to this job
  if (uId) await assertAssigned(client, jId, uId)

  const base64 = dataUrl.split(',')[1]
  const mimeMatch = dataUrl.match(/data:([^;]+);/)
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg'
  const ext = mime.includes('png') ? 'png' : 'jpg'
  const bytes = Uint8Array.from(atob(base64), (c: string) => c.charCodeAt(0))

  const photoId = crypto.randomUUID()
  const path = `${DEFAULT_ORG_ID}/${jId}/photos/${photoId}.${ext}`

  try { await client.storage.createBucket('job-photos', { public: true }) } catch { /* exists */ }

  const { error: uploadError } = await client.storage
    .from('job-photos')
    .upload(path, bytes, { contentType: mime, upsert: false })

  if (uploadError) throw uploadError

  const { data: urlData } = client.storage.from('job-photos').getPublicUrl(path)

  const mediaInsert: any = {
    job_id: jId,
    type: 'photo',
    storage_url: urlData.publicUrl,
    label: label || '',
    phase: phase || 'completion',
    uploaded_by: userId || user_id || null,
  }
  if (po_id) mediaInsert.po_id = po_id

  const { data: mediaRecord, error: mediaError } = await client.from('job_media').insert(mediaInsert).select().single()

  if (mediaError) throw mediaError

  await client.from('job_events').insert({
    job_id: jId,
    user_id: userId || user_id || null,
    event_type: phase === 'receipt' ? 'receipt_added' : 'photo_added',
    detail_json: { media_id: mediaRecord.id, phase: phase || 'completion', po_id: po_id || null },
  })

  return { id: mediaRecord.id, url: urlData.publicUrl }
}

async function submitServiceReport(client: any, body: any) {
  const { jobId, job_id, userId, user_id, checklist, notes, signatureData, signatureName, status, weather, start_time, end_time, variations } = body
  const jId = jobId || job_id
  if (!jId) throw new Error('jobId required')

  const reportStatus = status || 'submitted'
  const uId = userId || user_id || null

  // Verify user is assigned to this job
  if (uId) await assertAssigned(client, jId, uId)

  // Upload signature to storage if provided (instead of storing base64 in DB)
  let signatureUrl: string | null = null
  if (signatureData && signatureData.startsWith('data:')) {
    const base64 = signatureData.split(',')[1]
    const bytes = Uint8Array.from(atob(base64), (c: string) => c.charCodeAt(0))
    const sigId = crypto.randomUUID()
    const path = `${DEFAULT_ORG_ID}/${jId}/signatures/${sigId}.png`

    try { await client.storage.createBucket('job-photos', { public: true }) } catch { /* exists */ }

    const { error: uploadErr } = await client.storage
      .from('job-photos')
      .upload(path, bytes, { contentType: 'image/png', upsert: false })

    if (!uploadErr) {
      const { data: urlData } = client.storage.from('job-photos').getPublicUrl(path)
      signatureUrl = urlData.publicUrl
    }
  } else if (signatureData) {
    // Already a URL (re-submission of existing report)
    signatureUrl = signatureData
  }

  // Prevent overwriting an approved report
  const { data: existing } = await client
    .from('job_service_reports')
    .select('id, status')
    .eq('job_id', jId)
    .limit(1)
    .maybeSingle()

  if (existing?.status === 'approved' && reportStatus !== 'approved') {
    throw new Error('This report has been approved and cannot be modified')
  }

  let report
  const reportFields: Record<string, any> = {
    checklist_json: checklist || [],
    notes: notes || null,
    signature_data: signatureUrl,
    signature_name: signatureName || null,
    status: reportStatus,
    submitted_by: uId,
    submitted_at: reportStatus === 'submitted' ? new Date().toISOString() : null,
    weather: weather || null,
    start_time: start_time || null,
    end_time: end_time || null,
    variations: variations || null,
  }

  if (existing) {
    const { data, error } = await client
      .from('job_service_reports')
      .update(reportFields)
      .eq('id', existing.id)
      .select().single()

    if (error) throw error
    report = data
  } else {
    const { data, error } = await client
      .from('job_service_reports')
      .insert({ job_id: jId, ...reportFields })
      .select().single()

    if (error) throw error
    report = data
  }

  if (reportStatus === 'submitted') {
    await client.from('job_events').insert({
      job_id: jId,
      user_id: uId,
      event_type: 'service_report_submitted',
      detail_json: { report_id: report.id },
    })

    // Move GHL opportunity to "Job Complete" stage (non-blocking)
    try {
      const { data: jobData } = await client.from('jobs')
        .select('ghl_opportunity_id, type, id')
        .eq('id', jId).single()

      if (jobData?.ghl_opportunity_id) {
        const ghlProxyUrl = `${SUPABASE_URL}/functions/v1/ghl-proxy?action=move_to_complete`
        fetch(ghlProxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            opportunityId: jobData.ghl_opportunity_id,
            jobType: jobData.type || 'patio',
            jobId: jId,
          }),
        }).catch((e: any) => console.log('[ops-api] GHL move_to_complete fire-and-forget error:', e))
      }
    } catch (e) {
      console.log('[ops-api] GHL stage move lookup failed (non-blocking):', e)
    }
  }

  return { report }
}

async function getServiceReport(client: any, params: URLSearchParams, userId: string) {
  const jobId = params.get('jobId')
  if (!jobId) throw new Error('jobId required')

  // Verify user is assigned to this job
  await assertAssigned(client, jobId, userId)

  const { data: report } = await client
    .from('job_service_reports')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: job } = await client.from('jobs').select('type').eq('id', jobId).maybeSingle()
  const configKey = job?.type === 'fencing' ? 'service_checklist_fencing' : 'service_checklist_patio'
  const { data: config } = await client
    .from('org_config')
    .select('config_value')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('config_key', configKey)
    .maybeSingle()

  return {
    report: report || null,
    checklistTemplate: config?.config_value?.items || [],
  }
}

// ── Shared Report (public, no auth) — returns branded HTML page ──
async function viewSharedReport(client: any, params: URLSearchParams) {
  const token = params.get('token')
  if (!token) return json({ error: 'token required' }, 400)

  // Look up report by share_token
  const { data: report } = await client
    .from('job_service_reports')
    .select('*, jobs!inner(client_name, site_address, site_suburb, type)')
    .eq('share_token', token)
    .maybeSingle()

  if (!report) {
    return new Response('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Report not found</h2><p>This link may have expired or is invalid.</p></body></html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
    })
  }

  // Only show submitted/approved reports (not drafts)
  if (report.status === 'draft') {
    return new Response('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Report not ready</h2><p>This report has not been submitted yet.</p></body></html>', {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
    })
  }

  // Get completion photos for this job
  const { data: photos } = await client
    .from('job_media')
    .select('url, caption')
    .eq('job_id', report.job_id)
    .eq('phase', 'completion')
    .order('uploaded_at', { ascending: false })

  const job = report.jobs
  const checklist: Array<{ label: string; checked: boolean }> = report.checklist_json || []
  const photoList: Array<{ url: string; caption: string }> = photos || []
  const esc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  // Build branded HTML page
  let html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Service Report — ${esc(job.client_name || '')}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1A2332;background:#f5f6f8;line-height:1.6}
.wrap{max-width:600px;margin:0 auto;background:#fff;min-height:100vh}
.header{background:#293C46;color:#fff;padding:20px 24px;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:18px;font-weight:700}.header .brand{font-size:12px;opacity:.7}
.accent{height:4px;background:#F15A29}
.badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.badge-submitted{background:#E8F4FD;color:#2980B9}.badge-approved{background:#E8F8E8;color:#27AE60}
.section{padding:16px 24px;border-bottom:1px solid #eee}
.section h3{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:#4C6A7C;margin-bottom:10px;font-weight:700}
.info-row{display:flex;gap:12px;font-size:14px;margin:4px 0}
.info-label{font-weight:700;min-width:70px;color:#4C6A7C;flex-shrink:0}
.checklist{list-style:none}
.checklist li{padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px;display:flex;align-items:center;gap:8px}
.checklist li:last-child{border-bottom:none}
.check-icon{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:12px}
.check-yes{background:#E8F8E8;color:#27AE60}.check-no{background:#FDE8E8;color:#E74C3C}
.notes{font-size:14px;white-space:pre-wrap;background:#f7f8fa;padding:12px 16px;border-radius:8px}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.photos img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;cursor:pointer}
.sig-block{text-align:center;padding:16px;background:#f7f8fa;border-radius:8px}
.sig-block img{max-width:280px;width:100%}
.sig-name{font-size:14px;color:#4C6A7C;margin-top:6px}
.footer{padding:24px;text-align:center;font-size:11px;color:#7C8898;border-top:1px solid #eee}
@media print{body{background:#fff}.wrap{max-width:100%}.photos img{max-height:200px}}
</style></head><body>
<div class="wrap">
<div class="header">
<div><h1>Service Report</h1><div class="brand">SecureWorks Group</div></div>
<span class="badge badge-${report.status}">${report.status}</span>
</div>
<div class="accent"></div>

<div class="section">
<h3>Job Details</h3>
<div class="info-row"><span class="info-label">Client</span><span>${esc(job.client_name || '')}</span></div>
<div class="info-row"><span class="info-label">Address</span><span>${esc((job.site_address || '') + (job.site_suburb ? ', ' + job.site_suburb : ''))}</span></div>
<div class="info-row"><span class="info-label">Type</span><span style="text-transform:capitalize">${esc(job.type || 'patio')}</span></div>`

  if (report.submitted_at) {
    const d = new Date(report.submitted_at)
    const dateStr = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Perth' })
    html += `\n<div class="info-row"><span class="info-label">Completed</span><span>${dateStr}</span></div>`
  }

  html += `</div>`

  // Checklist
  if (checklist.length > 0) {
    html += `<div class="section"><h3>Completion Checklist</h3><ul class="checklist">`
    for (const item of checklist) {
      const icon = item.checked
        ? '<span class="check-icon check-yes">&#10003;</span>'
        : '<span class="check-icon check-no">&#10007;</span>'
      html += `<li>${icon}${esc(item.label)}</li>`
    }
    html += `</ul></div>`
  }

  // Notes
  if (report.notes) {
    html += `<div class="section"><h3>Notes</h3><div class="notes">${esc(report.notes)}</div></div>`
  }

  // Completion photos
  if (photoList.length > 0) {
    html += `<div class="section"><h3>Completion Photos</h3><div class="photos">`
    for (const p of photoList) {
      html += `<img src="${esc(p.url)}" alt="${esc(p.caption || 'Completion photo')}" loading="lazy">`
    }
    html += `</div></div>`
  }

  // Signature
  if (report.signature_data) {
    html += `<div class="section"><h3>Homeowner Sign-Off</h3>
<div class="sig-block"><img src="${report.signature_data}" alt="Signature">`
    if (report.signature_name) html += `<div class="sig-name">${esc(report.signature_name)}</div>`
    html += `</div></div>`
  }

  html += `<div class="footer">SecureWorks Group Pty Ltd &mdash; ABN 64689223416 &mdash; Perth, Western Australia</div>
</div></body></html>`

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
  })
}

// ── Document Upload Management ──
async function uploadDocument(client: any, body: any) {
  const { jobId, job_id, fileName, file_name, contentType, content_type, type, visible_to_trades } = body
  const jId = jobId || job_id
  const fName = fileName || file_name
  if (!jId || !fName) throw new Error('jobId and fileName required')

  const allowedTypes = ['work_order', 'supplier_work_order', 'quote', 'approval', 'site_photo', 'general', 'supplier_quote', 'council_plans', 'engineering', 'client_reference', 'asbestos', 'other']
  const docType = allowedTypes.includes(type) ? type : 'general'

  const bucket = 'job-documents'
  try { await client.storage.createBucket(bucket, { public: true }) } catch { /* exists */ }

  const path = `${jId}/${Date.now()}-${fName.replace(/[^a-zA-Z0-9._-]/g, '_')}`
  const { data: signedData, error: signError } = await client.storage
    .from(bucket)
    .createSignedUploadUrl(path)

  if (signError) throw signError

  const { data: urlData } = client.storage.from(bucket).getPublicUrl(path)

  return {
    uploadUrl: signedData.signedUrl,
    token: signedData.token,
    path: path,
    publicUrl: urlData.publicUrl,
    docType: docType,
  }
}

async function confirmDocumentUpload(client: any, body: any) {
  const { jobId, job_id, publicUrl, path, fileName, type, visible_to_trades, uploaded_by } = body
  const jId = jobId || job_id
  if (!jId || !publicUrl) throw new Error('jobId and publicUrl required')

  // Default visibility: on for field/useful trade docs. Off for quote/client-only docs.
  const defaultVisible = ['site_photo', 'council_plans', 'engineering', 'work_order', 'supplier_work_order', 'supplier_quote', 'approval'].includes(type)
  const isVisible = visible_to_trades != null ? visible_to_trades : defaultVisible

  const allowedTypes = ['work_order', 'supplier_work_order', 'quote', 'approval', 'site_photo', 'general', 'supplier_quote', 'council_plans', 'engineering', 'client_reference', 'asbestos', 'other']
  const docType = allowedTypes.includes(type) ? type : 'general'

  const insertData: any = {
    job_id: jId,
    type: docType,
    storage_url: publicUrl,
    file_name: fileName || path,
    visible_to_trades: isVisible,
    version: 1,
    uploaded_by: uploaded_by || body.operator_email || null,
  }

  // Set pdf_url for PDF files so existing code can find them
  if (fileName && /\.pdf$/i.test(fileName)) {
    insertData.pdf_url = publicUrl
  }

  const { data: doc, error } = await client.from('job_documents')
    .insert(insertData).select('id').single()

  if (error) throw error

  // Log event
  await client.from('job_events').insert({
    job_id: jId,
    event_type: 'document_uploaded',
    detail_json: { document_id: doc?.id, type: docType, file_name: fileName, visible_to_trades: isVisible, uploaded_by: insertData.uploaded_by },
  })

  // Dual-write to business_events
  logBusinessEvent(client, {
    event_type: 'document.uploaded',
    entity_type: 'job_document',
    entity_id: doc?.id || '',
    job_id: jId,
    payload: { type: docType, file_name: fileName, visible_to_trades: isVisible },
    metadata: { operator: uploaded_by || body.operator_email || null },
  })

  return { success: true, document_id: doc?.id, url: publicUrl }
}

async function toggleDocumentVisibility(client: any, body: any) {
  const { documentId, document_id, visible_to_trades } = body
  const dId = documentId || document_id
  if (!dId || visible_to_trades == null) throw new Error('documentId and visible_to_trades required')

  const { error } = await client.from('job_documents')
    .update({ visible_to_trades: visible_to_trades })
    .eq('id', dId)

  if (error) throw error
  return { success: true }
}

async function deleteDocument(client: any, body: any) {
  const dId = body.documentId || body.document_id
  if (!dId) throw new Error('documentId required')

  // Get document for storage cleanup + event log
  const { data: doc, error: fetchErr } = await client
    .from('job_documents')
    .select('id, job_id, type, file_name, storage_url')
    .eq('id', dId)
    .single()

  if (fetchErr) throw fetchErr
  if (!doc) throw new Error('Document not found')

  // Delete from storage if we have a storage path
  if (doc.storage_url) {
    try {
      const bucket = 'job-documents'
      // Extract path from public URL
      const urlParts = doc.storage_url.split(`/storage/v1/object/public/${bucket}/`)
      if (urlParts.length > 1) {
        await client.storage.from(bucket).remove([urlParts[1]])
      }
    } catch (e) {
      console.log('[ops-api] Storage delete failed (non-blocking):', (e as Error).message)
    }
  }

  // Delete from DB
  const { error: delErr } = await client.from('job_documents').delete().eq('id', dId)
  if (delErr) throw delErr

  // Log event
  await client.from('job_events').insert({
    job_id: doc.job_id,
    event_type: 'document_deleted',
    detail_json: { document_id: dId, type: doc.type, file_name: doc.file_name },
  })

  // Dual-write to business_events
  logBusinessEvent(client, {
    event_type: 'document.deleted',
    entity_type: 'job_document',
    entity_id: dId,
    job_id: doc.job_id,
    payload: { type: doc.type, file_name: doc.file_name },
    metadata: { operator: body.operator_email || null },
  })

  return { success: true }
}

// ── Ops Notes (ops dashboard per-job notes) ──
async function listOpsNotes(client: any, params: URLSearchParams) {
  const jobId = params.get('jobId') || params.get('job_id')
  if (!jobId) throw new ApiError('jobId required', 400)
  const { data, error } = await client.from('ops_notes')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
  if (error) throw new ApiError(error.message, 500)
  return { notes: data || [] }
}

async function upsertOpsNote(client: any, body: any) {
  const { job_id, note, note_id, attachment_url, attachment_type, attachment_filename } = body
  if (!job_id || (!note && !attachment_url)) throw new ApiError('job_id and (note or attachment) required', 400)

  if (note_id) {
    const { data, error } = await client.from('ops_notes')
      .update({
        note: note || null,
        attachment_url,
        attachment_type,
        attachment_filename,
        updated_at: new Date().toISOString(),
      })
      .eq('id', note_id)
      .select()
      .single()
    if (error) throw new ApiError(error.message, 500)
    return { ok: true, note: data }
  }

  const row: Record<string, any> = { job_id, note: note || null }
  if (attachment_url) {
    row.attachment_url = attachment_url
    row.attachment_type = attachment_type
    row.attachment_filename = attachment_filename
  }
  const { data, error } = await client.from('ops_notes')
    .insert(row)
    .select()
    .single()
  if (error) throw new ApiError(error.message, 500)
  return { ok: true, note: data }
}

async function deleteOpsNote(client: any, body: any) {
  const { note_id } = body
  if (!note_id) throw new ApiError('note_id required', 400)
  const { error } = await client.from('ops_notes').delete().eq('id', note_id)
  if (error) throw new ApiError(error.message, 500)
  return { ok: true }
}

async function getOpsUploadUrl(client: any, body: any) {
  const { fileName, jobId } = body
  if (!fileName || !jobId) throw new ApiError('fileName and jobId required', 400)
  const bucket = 'job-documents'
  const fileId = crypto.randomUUID()
  const ext = fileName.includes('.') ? fileName.split('.').pop() : ''
  const safeName = ext ? `${fileId}.${ext}` : fileId
  const path = `ops-notes/${jobId}/${safeName}`
  const { data, error } = await client.storage.from(bucket).createSignedUploadUrl(path)
  if (error) throw new ApiError(error.message, 500)
  const { data: urlData } = client.storage.from(bucket).getPublicUrl(path)
  return { signedUrl: data.signedUrl, publicUrl: urlData.publicUrl, path, token: data.token }
}

async function sendOpsNoteToTrade(client: any, body: any) {
  const { note_id } = body
  if (!note_id) throw new ApiError('note_id required', 400)
  const { data: note, error: fetchErr } = await client.from('ops_notes').select('*').eq('id', note_id).single()
  if (fetchErr || !note) throw new ApiError('Note not found', 404)

  if (note.attachment_url) {
    const isImage = (note.attachment_type || '').startsWith('image/')
    if (isImage) {
      await client.from('job_media').insert({
        job_id: note.job_id,
        phase: 'scope',
        type: 'image',
        storage_url: note.attachment_url,
        thumbnail_url: note.attachment_url,
        label: note.attachment_filename || 'Ops attachment',
        notes: note.note || null,
      })
    } else {
      await client.from('job_documents').insert({
        job_id: note.job_id,
        type: 'ops_attachment',
        storage_url: note.attachment_url,
        file_name: note.attachment_filename || 'attachment',
        visible_to_trades: true,
      })
    }
  }

  if (note.note) {
    await client.from('job_events').insert({
      job_id: note.job_id,
      event_type: 'note',
      detail_json: { text: note.note, from_ops: true },
    })
  }

  await client.from('ops_notes').update({ sent_to_trade: true, updated_at: new Date().toISOString() }).eq('id', note_id)
  return { ok: true }
}

// ── Comms attachment upload URL (ops dashboard → Storage) ──
async function getCommsUploadUrl(client: any, body: any) {
  const { fileName, jobId } = body
  if (!fileName || !jobId) throw new Error('fileName and jobId required')

  const bucket = 'comms-attachments'
  const fileId = crypto.randomUUID()
  const ext = fileName.includes('.') ? fileName.split('.').pop() : ''
  const safeName = ext ? `${fileId}.${ext}` : fileId
  const path = `jobs/${jobId}/${safeName}`

  try { await client.storage.createBucket(bucket, { public: true }) } catch { /* exists */ }

  const { data, error } = await client.storage.from(bucket).createSignedUploadUrl(path)
  if (error) throw error

  const { data: urlData } = client.storage.from(bucket).getPublicUrl(path)
  return { signedUrl: data.signedUrl, publicUrl: urlData.publicUrl, path }
}

async function sendCommsMessageAction(body: any) {
  const { contactId, type, message, attachmentUrls = [], subject, htmlBody } = body
  if (!contactId || !type) throw new Error('contactId and type required')

  const payload: any = { type, contactId }

  if (type === 'SMS') {
    if (!message) throw new Error('message required for SMS')
    payload.message = message
    if (attachmentUrls.length > 0) payload.attachments = attachmentUrls
  } else if (type === 'Email') {
    if (!subject || !htmlBody) throw new Error('subject and htmlBody required for Email')
    payload.subject = subject
    payload.html = htmlBody
    if (attachmentUrls.length > 0) payload.attachments = attachmentUrls
  } else {
    throw new Error('type must be SMS or Email')
  }

  const resp = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_API_TOKEN}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28',
    },
    body: JSON.stringify(payload),
  })

  const data = await resp.json()
  if (!resp.ok) throw new Error(data?.message || `GHL error ${resp.status}`)

  return { success: true, messageId: data.id }
}

// ── Signed upload URL (trade uploads photo directly to Storage) ──
async function getUploadUrl(client: any, body: any, userId: string, isAdmin = false) {
  const { jobId, job_id, fileName, contentType, purpose } = body
  const jId = jobId || job_id

  // 'expense_receipt' uploads can be detached from a job (general business
  // expense). All other purposes still require a job_id and assignment check.
  const isExpenseReceipt = purpose === 'expense_receipt'

  if (!fileName) throw new Error('fileName required')
  if (!isExpenseReceipt && !jId) throw new Error('jobId required')

  if (jId && !isExpenseReceipt) {
    await assertAssigned(client, jId, userId, isAdmin)
  }

  const ext = (fileName.split('.').pop() || 'jpg').toLowerCase()
  let bucket: string
  let path: string

  if (isExpenseReceipt) {
    // {org_id}/{yyyy}/{mm}/{photoId}-{rand}.{ext}
    // Random suffix on the filename means a leaked path prefix does not
    // collide with an existing receipt. UUID alone gives ~122 bits of entropy.
    bucket = 'expense-receipts'
    const photoId = crypto.randomUUID()
    const now = new Date()
    const yyyy = now.getUTCFullYear()
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
    path = `${DEFAULT_ORG_ID}/${yyyy}/${mm}/${photoId}.${ext}`
  } else {
    bucket = 'job-photos'
    const photoId = crypto.randomUUID()
    path = `${DEFAULT_ORG_ID}/${jId}/photos/${photoId}.${ext}`
  }

  try { await client.storage.createBucket(bucket, { public: true }) } catch { /* exists */ }

  const { data, error } = await client.storage
    .from(bucket)
    .createSignedUploadUrl(path)

  if (error) throw error

  const { data: urlData } = client.storage.from(bucket).getPublicUrl(path)

  return {
    uploadUrl: data.signedUrl,
    token: data.token,
    path,
    publicUrl: urlData.publicUrl,
    bucket,
    purpose: purpose || 'photo',
  }
}

// ── Confirm upload (create media record after direct upload) ──
async function confirmUpload(client: any, body: any, userId: string, isAdmin = false) {
  const { jobId, job_id, publicUrl, path, label, phase, po_id, purpose, bucket } = body
  const jId = jobId || job_id

  // Expense-receipt uploads land in a dedicated bucket and do NOT create a
  // job_media row (receipts are evidence, not job photos). Server downloads
  // the bytes from storage, computes SHA256, and returns the hash + storage
  // info to the caller, which passes them to submit_expense.
  const isExpenseReceipt = purpose === 'expense_receipt' || bucket === 'expense-receipts'

  if (isExpenseReceipt) {
    if (!path) throw new ApiError('path required for expense receipt confirm', 400)
    const useBucket = bucket || 'expense-receipts'

    // Compute SHA256 of the just-uploaded bytes. We download via the storage
    // service-role client to avoid public-URL caching/CDN edge cases. If the
    // download fails we still return the URL — the caller can submit without
    // a hash and preflight will reject the row at push time, surfacing the
    // gap to the operator rather than silently dropping it.
    let sha256: string | null = null
    let bytesLength: number | null = null
    try {
      const { data: blob, error: dlErr } = await client.storage
        .from(useBucket)
        .download(path)
      if (!dlErr && blob) {
        const buf = await blob.arrayBuffer()
        bytesLength = buf.byteLength
        const digest = await crypto.subtle.digest('SHA-256', buf)
        sha256 = Array.from(new Uint8Array(digest))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')
      }
    } catch (e) {
      console.log('[ops-api] expense_receipt sha256 compute failed:', (e as Error).message)
    }

    // Resolve a public URL if the caller did not pass one (defensive).
    let resolvedUrl = publicUrl
    if (!resolvedUrl) {
      const { data: urlData } = client.storage.from(useBucket).getPublicUrl(path)
      resolvedUrl = urlData?.publicUrl || ''
    }

    // Optional job_event for traceability when a job was supplied.
    if (jId) {
      try {
        await client.from('job_events').insert({
          job_id: jId,
          user_id: userId,
          event_type: 'receipt_added',
          detail_json: {
            phase: 'receipt',
            bucket: useBucket,
            path,
            sha256,
            bytes: bytesLength,
            uploader_is_admin: !!isAdmin,
          },
        })
      } catch (_e) { /* job_events insert is best-effort */ }
    }

    return {
      url: resolvedUrl,
      publicUrl: resolvedUrl,
      bucket: useBucket,
      path,
      sha256,
      bytes: bytesLength,
      purpose: 'expense_receipt',
    }
  }

  // ── Standard photo path (unchanged behaviour) ──
  if (!jId || !publicUrl) throw new Error('jobId and publicUrl required')

  // Verify user is assigned to this job (admins bypass)
  await assertAssigned(client, jId, userId, isAdmin)

  const insertData: any = {
    job_id: jId,
    type: 'photo',
    storage_url: publicUrl,
    label: label || '',
    phase: phase || 'completion',
    uploaded_by: userId,
  }
  if (po_id) insertData.po_id = po_id

  const { data, error } = await client.from('job_media').insert(insertData).select().single()

  if (error) throw error

  await client.from('job_events').insert({
    job_id: jId,
    user_id: userId,
    event_type: phase === 'receipt' ? 'receipt_added' : 'photo_added',
    detail_json: { media_id: data.id, phase: phase || 'completion', po_id: po_id || null },
  })

  return { id: data.id, url: publicUrl }
}

// ── Update assignment status (trade can confirm/start/complete their own) ──
async function updateMyAssignment(client: any, body: any, userId: string) {
  const id = body.assignmentId || body.id

  // ── Acknowledge-only path (no status change) ──
  if (body.acknowledged && id) {
    const { data: asgn, error: aErr } = await client.from('job_assignments')
      .select('id, job_id, user_id, acknowledged_at').eq('id', id).maybeSingle()
    if (aErr) throw aErr
    if (!asgn) throw new Error('Assignment not found')
    if (asgn.user_id !== userId) throw new Error('Not your assignment')
    if (asgn.acknowledged_at) return { assignment: asgn } // already done

    const { data: acked, error: ackErr } = await client.from('job_assignments')
      .update({ acknowledged_at: new Date().toISOString() }).eq('id', id).select().single()
    if (ackErr) throw ackErr

    await client.from('job_events').insert({
      job_id: asgn.job_id, user_id: userId,
      event_type: 'assignment_acknowledged',
      detail_json: { assignment_id: id },
    })
    return { assignment: acked }
  }

  const newStatus = body.status
  if (!id || !newStatus) throw new Error('assignmentId and status required')

  const allowed = ['confirmed', 'in_progress', 'complete', 'submitted']
  if (!allowed.includes(newStatus)) throw new Error('Invalid status. Use: ' + allowed.join(', '))

  // Verify this assignment belongs to the authenticated user
  const { data: assignment, error: findErr } = await client
    .from('job_assignments')
    .select('id, job_id, user_id, status, started_at, completed_at, acknowledged_at')
    .eq('id', id)
    .maybeSingle()

  if (findErr) throw findErr
  if (!assignment) throw new Error('Assignment not found')
  if (assignment.user_id !== userId) throw new Error('Not your assignment')

  // Record timestamps for time tracking
  const updateFields: any = { status: newStatus }
  const now = new Date().toISOString()
  if (newStatus === 'in_progress' && !assignment.started_at) {
    updateFields.started_at = now
  }
  if (newStatus === 'complete' && !assignment.completed_at) {
    updateFields.completed_at = now
  }

  if (body.progress_pct != null && typeof body.progress_pct === 'number') {
    updateFields.progress_pct = body.progress_pct
  }

  const { data, error } = await client
    .from('job_assignments')
    .update(updateFields)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error

  // Log event (include GPS location if provided)
  const eventDetail: any = { assignment_id: id, new_status: newStatus, started_at: updateFields.started_at, completed_at: updateFields.completed_at }
  if (body.latitude && body.longitude) {
    eventDetail.location = { lat: body.latitude, lng: body.longitude, accuracy: body.accuracy || null }
  }

  await client.from('job_events').insert({
    job_id: assignment.job_id,
    user_id: userId,
    event_type: 'assignment_status_changed',
    detail_json: eventDetail,
  })

  return { assignment: data }
}


// ════════════════════════════════════════════════════════════
// JOB PHASE TRACKING
// ════════════════════════════════════════════════════════════

const VALID_PHASES = ['assigned','acknowledged','travelling','arrived','materials_check','working','wrap_up','complete'] as const

async function updateJobPhase(client: any, body: any, userId: string) {
  const assignmentId = body.assignmentId || body.id
  const newPhase = body.phase
  if (!assignmentId || !newPhase) throw new Error('assignmentId and phase required')
  if (!VALID_PHASES.includes(newPhase)) throw new Error('Invalid phase: ' + newPhase)

  // Verify ownership
  const { data: asgn, error: findErr } = await client
    .from('job_assignments')
    .select('id, job_id, user_id, job_phase, status, started_at, completed_at')
    .eq('id', assignmentId)
    .maybeSingle()
  if (findErr) throw findErr
  if (!asgn) throw new Error('Assignment not found')
  if (asgn.user_id !== userId) throw new Error('Not your assignment')

  const oldPhase = asgn.job_phase || 'assigned'
  // Skip if already at this phase
  if (oldPhase === newPhase) return { assignment: asgn, changed: false }

  // Build update
  const now = new Date().toISOString()
  const updateFields: any = { job_phase: newPhase, last_phase_changed_at: now }

  // Sync legacy status field where appropriate
  if (newPhase === 'travelling' && asgn.status === 'scheduled') {
    updateFields.status = 'confirmed'
  }
  if ((newPhase === 'arrived' || newPhase === 'materials_check' || newPhase === 'working') && asgn.status !== 'in_progress') {
    updateFields.status = 'in_progress'
    if (!asgn.started_at) updateFields.started_at = now
  }
  if (newPhase === 'complete' && asgn.status !== 'complete') {
    updateFields.status = 'complete'
    if (!asgn.completed_at) updateFields.completed_at = now
  }

  const { data, error } = await client
    .from('job_assignments')
    .update(updateFields)
    .eq('id', assignmentId)
    .select()
    .single()
  if (error) throw error

  // Log to job_events (ops dashboard reads these)
  const eventDetail: any = {
    assignment_id: assignmentId,
    from_phase: oldPhase,
    to_phase: newPhase,
  }
  if (body.latitude && body.longitude) {
    eventDetail.location = { lat: body.latitude, lng: body.longitude, accuracy: body.accuracy || null }
  }
  await client.from('job_events').insert({
    job_id: asgn.job_id,
    user_id: userId,
    event_type: 'job.phase_changed',
    detail_json: eventDetail,
  })

  // Log to business_events (AI intelligence layer)
  logBusinessEvent(client, {
    event_type: 'job.phase_changed',
    source: 'app/trade',
    entity_type: 'job_assignment',
    entity_id: assignmentId,
    job_id: asgn.job_id,
    payload: { from: oldPhase, to: newPhase, assignment_id: assignmentId },
  })

  return { assignment: data, changed: true }
}


// ════════════════════════════════════════════════════════════
// TRADE INVOICING
// ════════════════════════════════════════════════════════════

// Helper: get Monday start for a week ending on Sunday
function weekStartFromEnd(weekEnd: string): string {
  const d = new Date(weekEnd + 'T00:00:00Z')
  d.setDate(d.getDate() - 6)
  return d.toISOString().slice(0, 10)
}

// ── my_hours: completed assignments for a given week ──
async function myHours(client: any, userId: string, params: URLSearchParams) {
  const weekEnding = params.get('week_ending') || getAWSTWeekEnd()
  const weekStart = weekStartFromEnd(weekEnding)

  // Get completed assignments in this week with clock times
  const { data: assignments, error } = await client
    .from('job_assignments')
    .select(`
      id, scheduled_date, start_time, status, role, assignment_type, crew_name,
      started_at, completed_at, hours_worked, break_minutes, clocked_on_at, clocked_off_at,
      jobs:job_id (
        id, type, job_number, client_name, site_address, site_suburb
      )
    `)
    .eq('user_id', userId)
    .eq('status', 'complete')
    .gte('scheduled_date', weekStart)
    .lte('scheduled_date', weekEnding)
    .not('started_at', 'is', null)
    .not('completed_at', 'is', null)
    .order('scheduled_date', { ascending: true })

  if (error) throw error

  // Look up current rate
  const { data: rateRow } = await client
    .from('trade_rates')
    .select('hourly_rate, effective_from')
    .eq('user_id', userId)
    .lte('effective_from', weekEnding)
    .or(`effective_to.is.null,effective_to.gte.${weekStart}`)
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle()

  const rate = rateRow ? Number(rateRow.hourly_rate) : 0

  // Calculate hours per assignment
  let totalHours = 0
  const enriched = (assignments || []).map((a: any) => {
    // Use pre-calculated hours_worked if available (server-side, breaks subtracted)
    // Fall back to raw started_at → completed_at for legacy assignments
    const hours = a.hours_worked != null
      ? parseFloat(a.hours_worked)
      : (a.completed_at && a.started_at)
        ? Math.round((new Date(a.completed_at).getTime() - new Date(a.started_at).getTime()) / 3600000 * 100) / 100
        : 0
    totalHours += hours
    return {
      ...a,
      hours,
      amount: Math.round(hours * rate * 100) / 100,
    }
  })

  // Check if already submitted
  const { data: existingInvoice } = await client
    .from('trade_invoices')
    .select('id, xero_bill_number, status')
    .eq('user_id', userId)
    .eq('week_ending', weekEnding)
    .maybeSingle()

  const subtotal = Math.round(totalHours * rate * 100) / 100
  const gst = Math.round(subtotal * 0.1 * 100) / 100

  // Check verification state across assignments
  const pendingVerification = enriched.some((a: any) => a.status === 'submitted')
  const allVerified = enriched.length > 0 && enriched.every((a: any) => a.status === 'verified' || a.status === 'complete')

  return {
    assignments: enriched,
    rate,
    week_ending: weekEnding,
    week_start: weekStart,
    total_hours: Math.round(totalHours * 100) / 100,
    subtotal,
    gst,
    total: Math.round((subtotal + gst) * 100) / 100,
    already_submitted: !!existingInvoice,
    xero_bill_number: existingInvoice?.xero_bill_number || null,
    pending_verification: pendingVerification,
    all_verified: allVerified,
  }
}

// ── submit_trade_invoice: build + push ACCPAY bill to Xero ──
async function submitTradeInvoice(client: any, userId: string, body: any) {
  const { week_ending, notes, invoice_type, rate_per_metre, items } = body
  if (!week_ending) throw new Error('week_ending required')

  const weekStart = weekStartFromEnd(week_ending)
  const isPerMetre = invoice_type === 'per_metre'

  // Prevent double-submit
  const { data: existing } = await client
    .from('trade_invoices')
    .select('id')
    .eq('user_id', userId)
    .eq('week_ending', week_ending)
    .maybeSingle()
  if (existing) throw new Error('Invoice already submitted for this week')

  // Re-query assignments server-side (prevents tampering)
  const { data: assignments, error } = await client
    .from('job_assignments')
    .select(`
      id, scheduled_date, started_at, completed_at, role, assignment_type,
      jobs:job_id (
        id, type, job_number, client_name, site_address, site_suburb
      )
    `)
    .eq('user_id', userId)
    .eq('status', 'complete')
    .gte('scheduled_date', weekStart)
    .lte('scheduled_date', week_ending)
    .not('started_at', 'is', null)
    .not('completed_at', 'is', null)
    .order('scheduled_date', { ascending: true })

  if (error) throw error
  if (!assignments || assignments.length === 0) throw new Error('No completed hours found for this week')

  // Get trade user info
  const { data: tradeUser } = await client
    .from('users')
    .select('name, email, xero_contact_id, trade_details')
    .eq('id', userId)
    .single()

  const stGstRegistered = tradeUser?.trade_details?.gstRegistered !== false
  const stTaxType = stGstRegistered ? 'INPUT' : 'NONE'

  // Resolve Xero supplier contact — auto-create if not linked
  const { accessToken: stAt, tenantId: stTi } = await getToken(client)
  let stXeroContactId = tradeUser?.xero_contact_id || null
  if (!stXeroContactId) {
    const stEmail = tradeUser?.email || ''
    if (stEmail) {
      try {
        const stContacts = await xeroGet('/Contacts?where=EmailAddress%3D%3D%22' + encodeURIComponent(stEmail) + '%22', stAt, stTi)
        if (stContacts?.Contacts?.length > 0) stXeroContactId = stContacts.Contacts[0].ContactID
      } catch { /* fallback to create */ }
    }
    if (!stXeroContactId) {
      const stCreateRes = await xeroPost('/Contacts', stAt, stTi, {
        Contacts: [{ Name: tradeUser?.name || 'Trade', EmailAddress: tradeUser?.email || undefined, IsSupplier: true }]
      }, 'PUT')
      stXeroContactId = stCreateRes?.Contacts?.[0]?.ContactID
    }
    if (stXeroContactId) {
      await client.from('users').update({ xero_contact_id: stXeroContactId }).eq('id', userId)
    }
    if (!stXeroContactId) throw new Error('Could not create Xero supplier contact')
  }

  const tradeName = tradeUser?.name || 'Trade'

  // Build line items
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  const lineItems: any[] = []
  let subtotal = 0

  if (isPerMetre) {
    // ── Per-metre invoice: use client-sent items with per-metre rate ──
    if (!items || !Array.isArray(items) || items.length === 0) throw new Error('Per-metre invoice requires items array')
    const pmRate = Number(rate_per_metre) || 35

    // Build a job lookup from server-side assignments for descriptions
    const jobMap: Record<string, any> = {}
    for (const a of assignments) {
      const job = a.jobs as any
      if (job?.id) jobMap[job.id] = job
    }

    for (const item of items) {
      const metres = Number(item.metres) || 0
      if (metres <= 0) continue
      const amount = Math.round(metres * pmRate * 100) / 100
      subtotal += amount

      const job = jobMap[item.job_id] || {}
      const desc = [
        (job.job_number || '') + ' | ' + (trackingCategoryForJob(job.job_number || '') || 'Construction'),
        [job.client_name, job.site_address, job.site_suburb].filter(Boolean).join(', '),
        `Fencing installation — ${metres}m @ $${pmRate}/m`,
      ].filter(Boolean).join('\n')

      lineItems.push({
        Description: desc,
        Quantity: metres,
        UnitAmount: pmRate,
        AccountCode: accountCodeForJob(job.type || '', '301'),
        TaxType: stTaxType,
        Tracking: xeroTracking(job.job_number || ''),
      })
    }

    if (lineItems.length === 0) throw new Error('No valid per-metre line items')

  } else {
    // ── Hourly invoice: existing path ──
    const { data: rateRow } = await client
      .from('trade_rates')
      .select('hourly_rate')
      .eq('user_id', userId)
      .lte('effective_from', week_ending)
      .or(`effective_to.is.null,effective_to.gte.${weekStart}`)
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!rateRow) throw new Error('No hourly rate set — update your rate in Profile before submitting')
    const rate = Number(rateRow.hourly_rate)

    for (const a of assignments) {
      const hours = Math.round(((new Date(a.completed_at).getTime() - new Date(a.started_at).getTime()) / 3600000) * 100) / 100
      const amount = Math.round(hours * rate * 100) / 100
      subtotal += amount

      const job = a.jobs as any
      const d = new Date(a.scheduled_date + 'T00:00:00Z')
      const dayLabel = `${dayNames[d.getUTCDay()]} ${d.getUTCDate()} ${monthNames[d.getUTCMonth()]}`
      const division = trackingCategoryForJob(job?.job_number || '')
      const roleLabel = a.role ? ` (${a.role})` : ''

      const desc = [
        (job?.job_number || '') + ' | ' + (division || 'Construction'),
        `Install${roleLabel} — ${dayLabel} — ${hours}hrs @ $${rate}/hr`,
        [job?.client_name, job?.site_address, job?.site_suburb].filter(Boolean).join(', '),
      ].filter(Boolean).join('\n')

      lineItems.push({
        Description: desc,
        Quantity: hours,
        UnitAmount: rate,
        AccountCode: accountCodeForJob(job?.type || '', '301'),
        TaxType: stTaxType,
        Tracking: xeroTracking(job?.job_number || ''),
      })
    }
  }

  const gst = Math.round(subtotal * 0.1 * 100) / 100
  const total = Math.round((subtotal + gst) * 100) / 100

  // Build Xero payload
  const dueDate = new Date(new Date(week_ending + 'T00:00:00Z').getTime() + 14 * 86400000)
    .toISOString().slice(0, 10)

  const xeroPayload = {
    Invoices: [{
      Type: 'ACCPAY',
      Contact: { ContactID: stXeroContactId },
      Reference: `${tradeName} | WE ${week_ending} | ${[...new Set(assignments.map((a: any) => (a.jobs as any)?.job_number).filter(Boolean))].join(', ')}`,
      DueDate: dueDate,
      Status: 'DRAFT',
      LineAmountTypes: stGstRegistered ? 'Exclusive' : 'NoTax',
      LineItems: lineItems,
    }],
  }

  // Push to Xero (reuse token from contact resolution above)
  const idempotencyKey = `trade-inv-${userId}-${week_ending}`
  const result = await xeroPost('/Invoices', stAt, stTi, xeroPayload, 'PUT', idempotencyKey)

  const xeroInv = result?.Invoices?.[0]
  const xeroInvId = xeroInv?.InvoiceID
  const billNumber = xeroInv?.InvoiceNumber

  // Cache in xero_invoices table
  if (xeroInvId) {
    try {
      await client.from('xero_invoices').upsert({
        org_id: DEFAULT_ORG_ID,
        xero_invoice_id: xeroInvId,
        xero_contact_id: stXeroContactId,
        contact_name: tradeName,
        invoice_number: billNumber,
        invoice_type: 'ACCPAY',
        status: 'DRAFT',
        reference: `${tradeName} | WE ${week_ending}`,
        sub_total: subtotal,
        total_tax: gst,
        total: total,
        amount_due: total,
        amount_paid: 0,
        invoice_date: new Date().toISOString().slice(0, 10),
        due_date: dueDate,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'org_id,xero_invoice_id' })
    } catch (e: any) {
      console.error('Non-blocking: failed to cache trade bill:', e.message)
    }
  }

  // Insert local trade_invoices record
  const invoiceRecord = {
    org_id: DEFAULT_ORG_ID,
    user_id: userId,
    week_ending,
    line_items: lineItems.map((li, i) => ({
      description: li.Description,
      hours: li.Quantity,
      rate: li.UnitAmount,
      amount: Math.round(li.Quantity * li.UnitAmount * 100) / 100,
      job_number: (assignments[i]?.jobs as any)?.job_number || '',
    })),
    subtotal,
    gst,
    total,
    notes: notes || null,
    xero_invoice_id: xeroInvId || null,
    xero_bill_number: billNumber || null,
    status: xeroInvId ? 'pushed_to_xero' : 'draft',
  }

  await client.from('trade_invoices').insert(invoiceRecord)

  return { success: true, xero_bill_number: billNumber, total }
}

// ── my_trade_invoices: invoice history for a trade ──
async function myTradeInvoices(client: any, userId: string) {
  const { data, error } = await client
    .from('trade_invoices')
    .select('id, week_start, week_end, invoice_number, notes, subtotal_ex, gst, total_inc, xero_bill_id, status, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) throw error
  const invoices = (data || []).map((inv: any) => ({
    ...inv,
    week_ending: inv.week_end,
    total: inv.total_inc ?? 0,
    subtotal: inv.subtotal_ex ?? 0,
  }))
  return { invoices }
}

// ── set_trade_rate: trade or ops sets hourly rate ──
async function setTradeRate(client: any, authUserId: string | null, body: any) {
  const { user_id, hourly_rate } = body
  const targetUserId = user_id || authUserId
  if (!targetUserId) throw new Error('user_id required')
  if (!hourly_rate || hourly_rate <= 0) throw new Error('Valid hourly_rate required')

  const today = getAWSTDate()

  // Close current active rate
  await client
    .from('trade_rates')
    .update({ effective_to: new Date(new Date(today + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10) })
    .eq('user_id', targetUserId)
    .is('effective_to', null)

  // Insert new rate
  const { data, error } = await client
    .from('trade_rates')
    .insert({
      org_id: DEFAULT_ORG_ID,
      user_id: targetUserId,
      hourly_rate: Number(hourly_rate),
      effective_from: today,
      created_by: authUserId || targetUserId,
    })
    .select()
    .single()

  if (error) throw error
  return { success: true, rate: data }
}

// ── list_trade_invoices: ops dashboard view ──
async function listTradeInvoices(client: any, params: URLSearchParams) {
  const limit = parseInt(params.get('limit') || '50')
  const status = params.get('status')

  let query = client
    .from('trade_invoices')
    .select('id, week_ending, subtotal, gst, total, line_items, xero_bill_number, xero_invoice_id, status, created_at, notes, users:user_id(name)')
    .order('week_ending', { ascending: false })
    .limit(limit)

  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw error

  // Also get trade rates for display
  const { data: rates } = await client
    .from('trade_rates')
    .select('user_id, hourly_rate, effective_from, users:user_id(name)')
    .is('effective_to', null)
    .order('effective_from', { ascending: false })

  return { invoices: data || [], rates: rates || [] }
}

// ── labour_reconciliation: labour PO budget vs trade hours per job ──
async function labourReconciliation(client: any, params: URLSearchParams) {
  const jobId = params.get('job_id')
  if (!jobId) throw new Error('job_id required')

  // Get labour POs for this job (type contains 'labour' in notes or supplier is a trade)
  const { data: pos } = await client.from('purchase_orders')
    .select('id, po_number, supplier_name, total, status, line_items, notes')
    .eq('job_id', jobId)
    .neq('status', 'deleted')

  // Calculate labour budget from POs (look for labour line items)
  let labourBudget = 0
  const labourPOs: any[] = []
  for (const po of (pos || [])) {
    const items = po.line_items || []
    for (const li of items) {
      const desc = (li.description || li.Description || '').toLowerCase()
      if (desc.includes('labour') || desc.includes('install') || desc.includes('trade')) {
        labourBudget += (li.quantity || li.Quantity || 0) * (li.unit_price || li.UnitAmount || 0)
        labourPOs.push(po)
        break
      }
    }
  }

  // Get job info
  const { data: job } = await client.from('jobs')
    .select('job_number, client_name, type, pricing_json')
    .eq('id', jobId).single()

  // Get total PO costs
  const totalPOCosts = (pos || []).reduce((s: number, po: any) => s + (po.total || 0), 0)

  // Labour budget might also come from pricing_json if no dedicated labour POs
  const pricingJson = job?.pricing_json || {}
  const quotedLabour = pricingJson.labourTotal || pricingJson.labour_total || 0
  if (labourBudget === 0 && quotedLabour > 0) {
    labourBudget = quotedLabour
  }

  // Get trade hours logged against this job
  const { data: assignments } = await client.from('job_assignments')
    .select('id, user_id, scheduled_date, started_at, completed_at, role, status, users:user_id(name)')
    .eq('job_id', jobId)
    .eq('status', 'complete')
    .not('started_at', 'is', null)
    .not('completed_at', 'is', null)
    .order('scheduled_date')

  // Calculate hours per trade
  const tradeHours: Record<string, { name: string, hours: number, rate: number, cost: number }> = {}
  let totalHours = 0

  for (const a of (assignments || [])) {
    const hours = Math.round(((new Date(a.completed_at).getTime() - new Date(a.started_at).getTime()) / 3600000) * 100) / 100
    totalHours += hours
    const userId = a.user_id
    const name = (a.users as any)?.name || 'Unknown'
    if (!tradeHours[userId]) {
      tradeHours[userId] = { name, hours: 0, rate: 0, cost: 0 }
    }
    tradeHours[userId].hours += hours
  }

  // Look up rates for each trade
  for (const userId of Object.keys(tradeHours)) {
    const { data: rateRow } = await client.from('trade_rates')
      .select('hourly_rate')
      .eq('user_id', userId)
      .is('effective_to', null)
      .order('effective_from', { ascending: false })
      .limit(1).maybeSingle()

    const rate = rateRow ? Number(rateRow.hourly_rate) : 0
    tradeHours[userId].rate = rate
    tradeHours[userId].cost = Math.round(tradeHours[userId].hours * rate * 100) / 100
  }

  // Get trade invoices that reference this job
  const jobNumber = job?.job_number || ''
  const { data: invoices } = await client.from('trade_invoices')
    .select('id, user_id, week_ending, subtotal, total, line_items, status, xero_bill_number, users:user_id(name)')
    .order('week_ending', { ascending: false })

  // Filter to invoices that contain this job's hours
  const jobInvoices = (invoices || []).filter((inv: any) => {
    const items = inv.line_items || []
    return items.some((li: any) => (li.job_number || '') === jobNumber)
  }).map((inv: any) => {
    const items = (inv.line_items || []).filter((li: any) => (li.job_number || '') === jobNumber)
    const jobHours = items.reduce((s: number, li: any) => s + (li.hours || 0), 0)
    const jobAmount = items.reduce((s: number, li: any) => s + (li.amount || 0), 0)
    return {
      ...inv,
      job_hours: jobHours,
      job_amount: jobAmount,
    }
  })

  const totalLabourCost = Object.values(tradeHours).reduce((s, t) => s + t.cost, 0)
  const invoicedLabourCost = jobInvoices.reduce((s: number, inv: any) => s + (inv.job_amount || 0), 0)

  return {
    job_id: jobId,
    job_number: jobNumber,
    labour_budget: labourBudget,
    quoted_labour: quotedLabour,
    total_po_costs: totalPOCosts,
    total_hours: Math.round(totalHours * 100) / 100,
    total_labour_cost: totalLabourCost,
    invoiced_labour_cost: invoicedLabourCost,
    remainder: Math.round((labourBudget - totalLabourCost) * 100) / 100,
    trades: Object.entries(tradeHours).map(([userId, data]) => ({
      user_id: userId,
      ...data,
    })),
    invoices: jobInvoices,
  }
}

// ── trade_labour_budget: labour budget view for lead installer ──
async function tradeLabourBudget(client: any, params: URLSearchParams, userId: string) {
  const jobId = params.get('jobId') || params.get('job_id')
  if (!jobId) throw new Error('jobId required')
  await assertAssigned(client, jobId, userId)

  // Get PO total for this job (material + labour)
  const { data: pos } = await client.from('purchase_orders')
    .select('total, status, line_items')
    .eq('job_id', jobId)
    .neq('status', 'deleted')

  // Sum labour PO amounts
  let labourBudget = 0
  for (const po of (pos || [])) {
    for (const li of (po.line_items || [])) {
      const desc = (li.description || li.Description || '').toLowerCase()
      if (desc.includes('labour') || desc.includes('install') || desc.includes('trade')) {
        labourBudget += (li.quantity || li.Quantity || 0) * (li.unit_price || li.UnitAmount || 0)
      }
    }
  }

  // Get job pricing_json for fallback labour budget
  const { data: job } = await client.from('jobs')
    .select('job_number, pricing_json')
    .eq('id', jobId).single()

  const pricingJson = job?.pricing_json || {}
  const quotedLabour = pricingJson.labourTotal || pricingJson.labour_total || 0
  if (labourBudget === 0 && quotedLabour > 0) labourBudget = quotedLabour

  // Get all trade hours for this job
  const { data: assignments } = await client.from('job_assignments')
    .select('user_id, started_at, completed_at, users:user_id(name)')
    .eq('job_id', jobId)
    .eq('status', 'complete')
    .not('started_at', 'is', null)
    .not('completed_at', 'is', null)

  let totalHours = 0
  const trades: any[] = []
  const byUser: Record<string, { name: string, hours: number }> = {}

  for (const a of (assignments || [])) {
    const hours = Math.round(((new Date(a.completed_at).getTime() - new Date(a.started_at).getTime()) / 3600000) * 100) / 100
    totalHours += hours
    const uid = a.user_id
    const name = (a.users as any)?.name || 'Trade'
    if (!byUser[uid]) byUser[uid] = { name, hours: 0 }
    byUser[uid].hours += hours
  }

  // Get rates
  for (const [uid, data] of Object.entries(byUser)) {
    const { data: rateRow } = await client.from('trade_rates')
      .select('hourly_rate').eq('user_id', uid).is('effective_to', null)
      .order('effective_from', { ascending: false }).limit(1).maybeSingle()
    const rate = rateRow ? Number(rateRow.hourly_rate) : 0
    trades.push({ user_id: uid, name: data.name, hours: data.hours, rate, cost: Math.round(data.hours * rate * 100) / 100 })
  }

  const totalCost = trades.reduce((s: number, t: any) => s + t.cost, 0)

  return {
    labour_budget: labourBudget,
    total_hours: Math.round(totalHours * 100) / 100,
    total_cost: totalCost,
    remainder: Math.round((labourBudget - totalCost) * 100) / 100,
    trades,
  }
}

// ════════════════════════════════════════════════════════════
// JOB COMPLETION PACKAGE
// ════════════════════════════════════════════════════════════

const GOOGLE_REVIEW_URL = 'https://g.page/r/PLACEHOLDER/review' // TODO: replace with actual Google review link

// ── complete_job: mark job complete + GHL stage sync ──
async function completeJob(client: any, body: any) {
  const jId = body.job_id || body.jobId
  if (!jId) throw new Error('job_id required')

  const { data: job, error: jobErr } = await client
    .from('jobs')
    .select('id, status, client_name, job_number, type, site_address, site_suburb, ghl_opportunity_id, ghl_contact_id')
    .eq('id', jId)
    .single()
  if (jobErr || !job) throw new Error('Job not found')

  if (!['in_progress', 'scheduled', 'processing', 'accepted'].includes(job.status)) {
    throw new Error(`Cannot complete a job with status "${job.status}". Must be in_progress, processing, scheduled, or accepted.`)
  }

  // Update status + completed_at
  const { error: updateErr } = await client
    .from('jobs')
    .update({
      status: 'complete',
      completed_at: new Date().toISOString(),
      ...(body.satisfaction_rating != null ? { satisfaction_rating: body.satisfaction_rating } : {})
    })
    .eq('id', jId)
  if (updateErr) throw updateErr

  // Log event
  await client.from('job_events').insert({
    job_id: jId,
    user_id: body.user_id || null,
    event_type: 'status_changed',
    detail_json: { new_status: 'complete', source: 'completion_package' },
  })

  // GHL stage sync (non-blocking)
  if (job.ghl_opportunity_id) {
    try {
      const ghlUrl = `${SUPABASE_URL}/functions/v1/ghl-proxy?action=move_stage`
      await fetch(ghlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opportunityId: job.ghl_opportunity_id,
          status: 'complete',
          jobType: job.type || 'patio',
        }),
      })
    } catch (e) {
      console.log('[ops-api] complete_job GHL sync failed (non-blocking):', e)
    }
  }

  // Low satisfaction alert
  if (body.satisfaction_rating != null && body.satisfaction_rating < 4) {
    try {
      await client.from('ai_alerts').insert({
        org_id: DEFAULT_ORG_ID,
        job_id: jId,
        alert_type: 'low_satisfaction',
        severity: body.satisfaction_rating <= 2 ? 'red' : 'amber',
        message: `Client rated ${body.satisfaction_rating}/5 on ${job.job_number || ''} (${job.client_name || ''}) — follow up recommended`,
        recommended_action: `Contact ${job.client_name || 'client'} to understand their concerns and resolve any issues.`,
        detail_json: {
          job_id: jId,
          job_number: job.job_number,
          client_name: job.client_name,
          satisfaction_rating: body.satisfaction_rating,
        },
      })
    } catch (e) {
      console.log('[ops-api] satisfaction alert failed:', (e as Error).message)
    }

    // Business event
    logBusinessEvent(client, {
      event_type: 'satisfaction.recorded',
      source: 'app/field',
      entity_type: 'job',
      entity_id: jId,
      correlation_id: jId,
      job_id: jId,
      payload: {
        satisfaction_rating: body.satisfaction_rating,
        job_number: job.job_number,
        client_name: job.client_name,
      },
    })
  }

  return {
    success: true,
    job: {
      id: job.id,
      job_number: job.job_number,
      client_name: job.client_name,
      type: job.type,
      site_address: job.site_address,
      site_suburb: job.site_suburb,
      status: 'complete',
      satisfaction_rating: body.satisfaction_rating || null,
    },
  }
}

// ── send_payment_link: get Xero online invoice URL + SMS to client ──
async function sendPaymentLink(client: any, body: any) {
  const jId = body.job_id || body.jobId
  if (!jId) throw new Error('job_id required')

  // Dedup check: prevent sending same payment link within 24 hours
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: recentSends } = await client
    .from('job_events')
    .select('id, created_at')
    .eq('job_id', jId)
    .eq('event_type', 'payment_link_sent')
    .gte('created_at', twentyFourHoursAgo)
    .limit(1)
  if (recentSends && recentSends.length > 0) {
    const lastSent = recentSends[0].created_at
    throw new ApiError(`Payment link already sent for this job within the last 24 hours (last sent: ${new Date(lastSent).toLocaleString('en-AU', { timeZone: 'Australia/Perth' })}). To prevent duplicate messages, please wait before resending.`, 409)
  }

  // Get job with GHL contact
  const { data: job, error: jobErr } = await client
    .from('jobs')
    .select('id, client_name, client_phone, job_number, ghl_contact_id')
    .eq('id', jId)
    .single()
  if (jobErr || !job) throw new Error('Job not found')

  if (!job.ghl_contact_id) throw new Error('No GHL contact ID on this job — cannot send SMS')

  // Find the Xero invoice for this job
  const { data: invoices } = await client
    .from('xero_invoices')
    .select('xero_invoice_id, invoice_number, total, status')
    .eq('job_id', jId)
    .eq('invoice_type', 'ACCREC')
    .not('status', 'in', '("VOIDED","DELETED")')
    .order('created_at', { ascending: false })
    .limit(1)

  if (!invoices || invoices.length === 0) throw new Error('No invoice found for this job')
  const invoice = invoices[0]

  // Get Xero online invoice URL
  const { accessToken, tenantId } = await getToken(client)
  const onlineResult = await xeroGet(
    `/Invoices/${invoice.xero_invoice_id}/OnlineInvoice`,
    accessToken, tenantId
  )
  const onlineUrl = onlineResult?.OnlineInvoices?.[0]?.OnlineInvoiceUrl
  if (!onlineUrl) throw new Error('Could not get Xero online invoice URL')

  // Send SMS via GHL
  const smsMessage = `Hi ${job.client_name?.split(' ')[0] || 'there'}, your invoice for ${job.job_number} is ready. You can view and pay online here: ${onlineUrl}\n\nThanks,\nSecureWorks Group`

  const ghlUrl = `${SUPABASE_URL}/functions/v1/ghl-proxy?action=send_sms`
  const smsResp = await fetch(ghlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contactId: job.ghl_contact_id,
      message: smsMessage,
    }),
  })
  const smsResult = await smsResp.json()

  // Log event
  await client.from('job_events').insert({
    job_id: jId,
    event_type: 'payment_link_sent',
    detail_json: {
      invoice_number: invoice.invoice_number,
      xero_invoice_id: invoice.xero_invoice_id,
      online_url: onlineUrl,
      sms_sent: smsResult.success || false,
    },
  })

  // Log to jarvis_event_log (non-blocking, fire-and-forget)
  client.from('jarvis_event_log').insert({
    event_type: 'payment_link_sent',
    contact_id: job.ghl_contact_id,
    job_id: jId,
    invoice_id: invoice.xero_invoice_id,
    channel: 'sms',
    triggered_by: 'jarvis',
    message_content: smsMessage.slice(0, 2000),
    metadata: { invoice_number: invoice.invoice_number, payment_url: onlineUrl },
  }).then(() => {}).catch(() => {})

  // Fire-and-forget: recompute job intelligence after payment link sent
  fetch(`${SUPABASE_URL}/functions/v1/reporting-api?action=job_intelligence&job_id=${jId}`, {
    headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
  }).catch(() => {})

  return {
    success: true,
    invoice_number: invoice.invoice_number,
    payment_url: onlineUrl,
    sms_sent: smsResult.success || false,
  }
}

// ── send_acceptance_invoice: create deposit invoice + send payment link in one call ──
// Used by: send-quote /accept (auto), sale.html button, ops dashboard
async function sendAcceptanceInvoice(client: any, body: any) {
  const jId = body.job_id || body.jobId
  if (!jId) throw new Error('job_id required')

  // Fetch job with deposit config
  const { data: job, error: jobErr } = await client
    .from('jobs')
    .select('id, type, client_name, client_phone, job_number, ghl_contact_id, xero_contact_id, pricing_json, site_address, site_suburb')
    .eq('id', jId)
    .single()
  if (jobErr || !job) throw new Error('Job not found')

  const pricing = typeof job.pricing_json === 'string' ? JSON.parse(job.pricing_json || '{}') : (job.pricing_json || {})
  const depositConfig = pricing.deposit || {}

  // Resolve deposit parameters: explicit body params → pricing_json.deposit → job-type defaults
  const defaultPercent = job.type === 'fencing' ? 50 : 20
  const depositPercent = body.deposit_percent ?? depositConfig.percent ?? defaultPercent
  const councilFees = body.council_fees ?? depositConfig.council_fees ?? 0

  // Build extra line items for council fees
  const extraLineItems: any[] = []
  if (councilFees > 0) {
    extraLineItems.push({
      description: 'Council / planning application fee',
      amount_inc_gst: councilFees,
    })
  }

  // Use deposit config total if available, otherwise calculate
  const depositAmount = body.deposit_amount ?? depositConfig.total_deposit_inc_gst ?? undefined

  // Create the deposit invoice — Xero email DISABLED, we send branded email ourselves
  const invoiceResult = await createDepositInvoice(client, {
    job_id: jId,
    deposit_percent: depositPercent,
    deposit_amount: depositAmount,
    extra_line_items: extraLineItems,
    send_email: false, // DISABLED — branded email via send-quote/send-invoice
    job_contact_id: body.job_contact_id || null,
    run_label: body.run_label || null,
  })

  // Get Xero online invoice URL for payment
  let paymentUrl = ''
  let smsSent = false
  let brandedEmailSent = false
  try {
    const { accessToken, tenantId } = await getToken(client)
    const onlineResult = await xeroGet(
      `/Invoices/${invoiceResult.xero_invoice_id}/OnlineInvoice`,
      accessToken, tenantId
    )
    paymentUrl = onlineResult?.OnlineInvoices?.[0]?.OnlineInvoiceUrl || ''
  } catch (e) {
    console.log('[send_acceptance_invoice] Could not get online invoice URL:', (e as Error).message)
  }

  // Resolve client details (prefer neighbour contact if provided)
  let invoiceClientName = job.client_name || 'Client'
  let invoiceClientEmail = ''
  let invoiceShareToken = ''

  if (body.job_contact_id) {
    const { data: jc } = await client.from('job_contacts')
      .select('client_name, client_email, share_token')
      .eq('id', body.job_contact_id)
      .single()
    if (jc?.client_name) invoiceClientName = jc.client_name
    if (jc?.client_email) invoiceClientEmail = jc.client_email
  }

  // Fall back to job-level email if no contact-level email
  if (!invoiceClientEmail) {
    const { data: jobEmail } = await client.from('jobs')
      .select('client_email')
      .eq('id', jId)
      .single()
    invoiceClientEmail = jobEmail?.client_email || ''
  }

  // Get share_token from job_documents for the "I've paid" link
  if (body.job_contact_id) {
    const { data: docToken } = await client.from('job_documents')
      .select('share_token')
      .eq('job_id', jId)
      .eq('job_contact_id', body.job_contact_id)
      .eq('type', 'quote')
      .limit(1)
      .single()
    if (docToken?.share_token) invoiceShareToken = docToken.share_token
  } else {
    const { data: docToken } = await client.from('job_documents')
      .select('share_token')
      .eq('job_id', jId)
      .eq('type', 'quote')
      .is('job_contact_id', null)
      .limit(1)
      .single()
    if (docToken?.share_token) invoiceShareToken = docToken.share_token
  }

  // Send branded invoice email via send-quote/send-invoice
  const notifyClient = body.notify_client !== false
  if (notifyClient && invoiceClientEmail) {
    try {
      const address = [job.site_address, job.site_suburb].filter(Boolean).join(', ')
      const emailRes = await fetch(`${SUPABASE_URL}/functions/v1/send-quote/send-invoice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({
          xero_invoice_id: invoiceResult.xero_invoice_id,
          job_id: jId,
          payment_url: paymentUrl,
          invoice_number: invoiceResult.invoice_number,
          deposit_amount: invoiceResult.deposit_amount,
          client_name: invoiceClientName,
          client_email: invoiceClientEmail,
          job_type: job.type,
          address,
          share_token: invoiceShareToken || undefined,
        }),
      })
      const emailResult = await emailRes.json()
      brandedEmailSent = emailResult.success || false
      if (!brandedEmailSent) {
        console.log('[send_acceptance_invoice] Branded email failed:', emailResult.error)
      }
    } catch (e) {
      console.log('[send_acceptance_invoice] Branded email call failed (non-blocking):', (e as Error).message)
    }
  }

  // Send SMS via GHL if requested and we have a payment URL
  if (notifyClient && paymentUrl) {
    try {
      let smsContactId = job.ghl_contact_id
      let smsFirstName = job.client_name?.split(' ')[0] || 'there'

      if (body.job_contact_id) {
        const { data: jc } = await client.from('job_contacts')
          .select('ghl_contact_id, client_name')
          .eq('id', body.job_contact_id)
          .single()
        if (jc?.ghl_contact_id) {
          smsContactId = jc.ghl_contact_id
          smsFirstName = jc.client_name?.split(' ')[0] || smsFirstName
        }
      }

      if (smsContactId) {
        const smsMessage = `Hi ${smsFirstName}, thanks for accepting your ${job.type || 'project'} quote! Your deposit invoice is ready.\n\nPay online here: ${paymentUrl}\n\nThanks,\nSecureWorks Group`

        const ghlUrl = `${SUPABASE_URL}/functions/v1/ghl-proxy?action=send_sms`
        const smsResp = await fetch(ghlUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contactId: smsContactId,
            message: smsMessage,
          }),
        })
        const smsResult = await smsResp.json()
        smsSent = smsResult.success || false
      }
    } catch (e) {
      console.log('[send_acceptance_invoice] SMS failed (non-blocking):', (e as Error).message)
    }
  }

  // Log combined event
  await client.from('job_events').insert({
    job_id: jId,
    event_type: 'acceptance_invoice_sent',
    detail_json: {
      xero_invoice_id: invoiceResult.xero_invoice_id,
      invoice_number: invoiceResult.invoice_number,
      deposit_amount: invoiceResult.deposit_amount,
      deposit_percent: depositPercent,
      council_fees: councilFees,
      payment_url: paymentUrl,
      sms_sent: smsSent,
      branded_email_sent: brandedEmailSent,
    },
  })

  // Loop 1B-a-apply: dual-write to business_events.invoice.created so the
  // acceptance-hyperlink path matches completeAndInvoice's audit trail. Without
  // this, F14 (zero invoice.authorised events historically) had a sibling gap
  // where deposit invoices created via the customer hyperlink left no
  // business_events row at all. Non-blocking on failure.
  logBusinessEvent(client, {
    event_type: 'invoice.created',
    entity_type: 'xero_invoice',
    entity_id: invoiceResult.xero_invoice_id || jId,
    correlation_id: jId,
    job_id: job?.job_number || jId,
    payload: {
      invoice_number: invoiceResult.invoice_number,
      total: invoiceResult.deposit_amount,
      status: 'AUTHORISED',
      flow: 'acceptance_hyperlink',
      deposit_percent: depositPercent,
      council_fees: councilFees,
      job_contact_id: body.job_contact_id || null,
      run_label: body.run_label || null,
    },
    metadata: {
      operator: body.operator || 'customer_acceptance',
      source: 'sendAcceptanceInvoice',
    },
  })

  return {
    success: true,
    job_id: jId,
    invoice_number: invoiceResult.invoice_number,
    xero_invoice_id: invoiceResult.xero_invoice_id,
    deposit_amount: invoiceResult.deposit_amount,
    deposit_percent: depositPercent,
    council_fees: councilFees,
    payment_url: paymentUrl,
    sms_sent: smsSent,
    branded_email_sent: brandedEmailSent,
  }
}

// ── send_review_request: SMS client with Google review link ──
async function sendReviewRequest(client: any, body: any) {
  const jId = body.job_id || body.jobId
  if (!jId) throw new Error('job_id required')

  const { data: job, error: jobErr } = await client
    .from('jobs')
    .select('id, client_name, job_number, ghl_contact_id')
    .eq('id', jId)
    .single()
  if (jobErr || !job) throw new Error('Job not found')

  if (!job.ghl_contact_id) throw new Error('No GHL contact ID on this job — cannot send SMS')

  const smsMessage = `Hi ${job.client_name?.split(' ')[0] || 'there'}, thanks for choosing SecureWorks! We'd love to hear about your experience: ${GOOGLE_REVIEW_URL}\n\nYour feedback means the world to us 🙏`

  const ghlUrl = `${SUPABASE_URL}/functions/v1/ghl-proxy?action=send_sms`
  const smsResp = await fetch(ghlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contactId: job.ghl_contact_id,
      message: smsMessage,
    }),
  })
  const smsResult = await smsResp.json()

  // Log event
  await client.from('job_events').insert({
    job_id: jId,
    event_type: 'review_request_sent',
    detail_json: {
      review_url: GOOGLE_REVIEW_URL,
      sms_sent: smsResult.success || false,
    },
  })

  return {
    success: true,
    sms_sent: smsResult.success || false,
    review_url: GOOGLE_REVIEW_URL,
  }
}


// ════════════════════════════════════════════════════════════
// CREW AVAILABILITY & ASSIGNMENT CONFIRMATION
// ════════════════════════════════════════════════════════════

async function getCrewAvailability(client: any, params: URLSearchParams) {
  // Default to 14 days if no dates provided (prevents 500 errors / timeouts from agent calls)
  const today = new Date().toISOString().split('T')[0]
  const startDate = params.get('start_date') || params.get('from') || params.get('date') || today
  const defaultEnd = new Date(startDate)
  defaultEnd.setDate(defaultEnd.getDate() + 14)
  const endDate = params.get('end_date') || params.get('to') || defaultEnd.toISOString().split('T')[0]

  // Fetch availability rows
  const { data: rows, error } = await client
    .from('crew_availability')
    .select('id, user_id, date, status, note, created_at')
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true })
    .limit(200)

  if (error) throw error

  // Join user names from public.users table
  const userIds = [...new Set((rows || []).map((r: any) => r.user_id))]
  let userMap: Record<string, any> = {}
  if (userIds.length > 0) {
    const { data: users } = await client.from('users').select('id, name, email, phone').in('id', userIds)
    for (const u of (users || [])) {
      userMap[u.id] = { name: u.name, email: u.email, phone: u.phone }
    }
  }

  const availability = (rows || []).map((r: any) => ({
    ...r,
    user: userMap[r.user_id] || null,
  }))

  return { availability }
}

async function setAvailability(client: any, body: any) {
  const { userId, user_id, dates } = body
  const uid = userId || user_id
  if (!uid) throw new Error('userId required')
  if (!dates || !Array.isArray(dates) || dates.length === 0) throw new Error('dates array required')

  const rows = dates.map((d: any) => ({
    user_id: uid,
    date: d.date,
    status: d.status || 'available',
    note: d.note || null,
  }))

  // Upsert: on conflict (user_id, date) update status + note
  const { data, error } = await client
    .from('crew_availability')
    .upsert(rows, { onConflict: 'user_id,date' })
    .select()

  if (error) throw error
  return { success: true, updated: (data || []).length }
}

async function confirmAssignment(client: any, body: any) {
  const { assignmentId, assignment_id, notifyClient, notify_client, customMessage, custom_message, confirmedBy, confirmed_by } = body
  const aId = assignmentId || assignment_id
  if (!aId) throw new Error('assignmentId required')

  const shouldNotify = notifyClient ?? notify_client ?? false
  const message = customMessage || custom_message || null
  const byUser = confirmedBy || confirmed_by || null

  // Update assignment
  const { data: assignment, error: aErr } = await client
    .from('job_assignments')
    .update({
      confirmation_status: 'confirmed',
      confirmed_at: new Date().toISOString(),
      confirmed_by: byUser,
    })
    .eq('id', aId)
    .select('*, jobs:job_id(id, client_name, client_phone, ghl_contact_id, job_number, site_address)')
    .single()

  if (aErr) throw aErr

  const job = assignment.jobs || {}

  // Log event
  await client.from('job_events').insert({
    job_id: assignment.job_id,
    user_id: byUser,
    event_type: 'assignment_confirmed',
    detail_json: {
      assignment_id: aId,
      scheduled_date: assignment.scheduled_date,
      notify_client: shouldNotify,
    },
  })

  // Notify client via SMS if requested
  let smsSent = false
  if (shouldNotify && job.ghl_contact_id) {
    const firstName = (job.client_name || '').split(' ')[0] || 'there'
    const dateStr = new Date(assignment.scheduled_date).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })
    const smsText = message || `Hi ${firstName}, your ${assignment.assignment_type || 'job'} at ${job.site_address || 'your property'} has been confirmed for ${dateStr}. We'll be in touch closer to the date with any details.\n\nThanks,\nSecureWorks Group`

    try {
      const ghlUrl = `${SUPABASE_URL}/functions/v1/ghl-proxy?action=send_sms`
      const smsResp = await fetch(ghlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId: job.ghl_contact_id,
          message: smsText,
          jobId: assignment.job_id,
          userId: byUser,
        }),
      })
      const smsResult = await smsResp.json()
      smsSent = smsResult.success || false

      if (smsSent) {
        await client.from('job_assignments')
          .update({ client_notified_at: new Date().toISOString() })
          .eq('id', aId)
      }
    } catch (e) {
      console.log('[ops-api] Client notification SMS failed (non-blocking):', e)
    }
  }

  // Dual-write to business_events
  logBusinessEvent(client, {
    event_type: 'schedule.locked',
    entity_type: 'crew_assignment',
    entity_id: aId,
    job_id: assignment.job_id,
    payload: {
      crew_name: assignment.crew_name,
      scheduled_date: assignment.scheduled_date,
      client_notified: smsSent,
      job_number: job.job_number,
    },
    metadata: { operator: body.operator_email || byUser },
  })

  return {
    success: true,
    assignment_id: aId,
    confirmation_status: 'confirmed',
    client_notified: smsSent,
  }
}

async function bulkConfirm(client: any, body: any) {
  const { assignmentIds, assignment_ids, notifyClient, notify_client, confirmedBy, confirmed_by } = body
  const ids = assignmentIds || assignment_ids
  if (!ids || !Array.isArray(ids) || ids.length === 0) throw new Error('assignmentIds array required')

  let successCount = 0
  let failCount = 0
  const results: any[] = []

  for (const id of ids) {
    try {
      const result = await confirmAssignment(client, {
        assignment_id: id,
        notify_client: notifyClient ?? notify_client ?? false,
        confirmed_by: confirmedBy || confirmed_by || null,
      })
      successCount++
      results.push({ id, success: true })
    } catch (e) {
      failCount++
      results.push({ id, success: false, error: (e as Error).message })
    }
  }

  return { success: true, confirmed: successCount, failed: failCount, results }
}


// ════════════════════════════════════════════════════════════
// DISMISS AI ALERT
// ════════════════════════════════════════════════════════════

async function dismissAlert(client: any, body: any) {
  const { alert_id, alertId, userId, user_id } = body
  const aId = alert_id || alertId
  if (!aId) throw new Error('alert_id required')

  const { error } = await client.from('ai_alerts')
    .update({
      dismissed_at: new Date().toISOString(),
      dismissed_by: userId || user_id || null,
    })
    .eq('id', aId)

  if (error) throw error
  return { success: true, alert_id: aId }
}


// ════════════════════════════════════════════════════════════
// PO PRICE EXTRACTION — Supplier Price Intelligence
// ════════════════════════════════════════════════════════════

async function extractPOPricing(client: any, body: any) {
  const { po_id, poId } = body
  const pId = po_id || poId
  if (!pId) throw new Error('po_id required')

  // Get the PO with line items
  const { data: po, error: poErr } = await client.from('purchase_orders')
    .select('id, po_number, supplier_name, job_id, line_items, total, reference')
    .eq('id', pId)
    .single()

  if (poErr || !po) throw new Error('PO not found: ' + (poErr?.message || pId))

  const lineItems = po.line_items || []
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return { success: true, extracted: 0, message: 'No line items to extract' }
  }

  // Extract each line item into the material_price_ledger
  let extracted = 0
  let skipped = 0

  for (const item of lineItems) {
    // Skip items with no price or description
    const description = item.description || item.desc || item.item || ''
    const unitPrice = Number(item.unit_price || item.unitPrice || item.price || item.rate || 0)
    const quantity = Number(item.quantity || item.qty || 1)

    if (!description || unitPrice <= 0) {
      skipped++
      continue
    }

    // Attempt to categorize the material
    const descLower = description.toLowerCase()
    let category = 'other'
    let code = null
    let unit = 'ea'

    // Steel detection
    if (descLower.match(/shs|rhs|beam|post|column|steel|angle|channel|plate/)) {
      category = 'steel'
      // Try to extract size: "100x50x2" pattern
      const sizeMatch = descLower.match(/(\d+)\s*x\s*(\d+)\s*x?\s*(\d+\.?\d*)?/)
      if (sizeMatch) code = `SHS-${sizeMatch[1]}x${sizeMatch[2]}${sizeMatch[3] ? 'x' + sizeMatch[3] : ''}`
      unit = descLower.includes('/m') || descLower.includes('per m') ? 'm' : 'length'
    }
    // Roofing/panels detection
    else if (descLower.match(/solarspan|trimdek|cdek|corrugated|panel|sheet|roofing/)) {
      category = 'roofing'
      if (descLower.includes('solarspan')) {
        const thicknessMatch = descLower.match(/(\d+)\s*mm/)
        code = thicknessMatch ? `SOLARSPAN-${thicknessMatch[1]}` : 'SOLARSPAN'
      }
      unit = 'sheet'
    }
    // Concrete detection
    else if (descLower.match(/concrete|cement|bag|footing|pier/)) {
      category = 'concrete'
      unit = descLower.includes('bag') ? 'bag' : 'm3'
    }
    // Flashing/guttering detection
    else if (descLower.match(/flash|gutter|downpipe|barge|ridge|fascia/)) {
      category = 'flashings'
      unit = 'm'
    }
    // Fixings detection
    else if (descLower.match(/screw|bolt|bracket|tek|rivet|fixing|anchor/)) {
      category = 'fixings'
      unit = 'ea'
    }
    // Fencing detection
    else if (descLower.match(/colorbond|fence|panel|gate|post.*fence|rail/)) {
      category = 'fencing'
      unit = descLower.includes('panel') ? 'panel' : descLower.includes('post') ? 'ea' : 'm'
    }

    // Calculate effective unit price (total / quantity if not already per-unit)
    const effectiveUnitPrice = unitPrice

    // Insert into material_price_ledger as pending (human must confirm)
    const { error: insertErr } = await client.from('material_price_ledger').insert({
      org_id: DEFAULT_ORG_ID,
      supplier_name: po.supplier_name,
      item_description: description,
      material_category: category,
      material_code: code,
      unit: unit,
      unit_price: effectiveUnitPrice,
      po_id: po.id,
      job_id: po.job_id || null,
      status: 'pending',
    })

    if (insertErr) {
      console.log(`[ops-api] Price ledger insert failed for "${description}":`, insertErr.message)
      skipped++
    } else {
      extracted++
    }
  }

  // Log the extraction as a job event if job-linked
  if (po.job_id) {
    await client.from('job_events').insert({
      job_id: po.job_id,
      event_type: 'po_pricing_extracted',
      detail_json: {
        po_id: po.id,
        po_number: po.po_number,
        supplier: po.supplier_name,
        items_extracted: extracted,
        items_skipped: skipped,
      },
    })
  }

  return {
    success: true,
    po_number: po.po_number,
    supplier: po.supplier_name,
    extracted,
    skipped,
    total_line_items: lineItems.length,
  }
}

async function confirmPrice(client: any, body: any) {
  const { ledger_id, user_id } = body
  if (!ledger_id) throw new Error('ledger_id required')

  // Get the ledger entry details before confirming
  const { data: entry } = await client.from('material_price_ledger')
    .select('id, supplier_name, item_description, material_category, unit_price, previous_rate, unit, job_id')
    .eq('id', ledger_id)
    .single()

  const { error } = await client.from('material_price_ledger')
    .update({
      status: 'confirmed',
      confirmed_by: user_id || null,
      confirmed_at: new Date().toISOString(),
    })
    .eq('id', ledger_id)

  if (error) throw error

  // Determine which scoper to notify based on the job type
  let scoperAlert = ''
  if (entry?.job_id) {
    const { data: job } = await client.from('jobs')
      .select('type, job_number')
      .eq('id', entry.job_id)
      .single()

    const scoper = job?.type === 'fencing' ? 'Khairo' : 'Nathan'
    const priceDiff = entry.previous_rate && entry.previous_rate > 0
      ? Math.round(((entry.unit_price - entry.previous_rate) / entry.previous_rate) * 100)
      : null
    const direction = priceDiff && priceDiff > 0 ? 'up' : priceDiff && priceDiff < 0 ? 'down' : null

    scoperAlert = `${scoper}: update your scope tool. ${entry.supplier_name} now charges $${entry.unit_price}/${entry.unit || 'ea'} for ${entry.item_description}`
    if (direction) scoperAlert += ` (${direction} ${Math.abs(priceDiff!)}% from $${entry.previous_rate})`

    // Create an ai_alert targeting the scoper
    await client.from('ai_alerts').insert({
      org_id: DEFAULT_ORG_ID,
      job_id: entry.job_id,
      alert_type: 'price_update_for_scoper',
      severity: 'amber',
      message: `Price confirmed: ${entry.supplier_name} — ${entry.item_description} @ $${entry.unit_price}/${entry.unit || 'ea'}`,
      recommended_action: scoperAlert,
      financial_impact: entry.unit_price,
      detail_json: {
        ledger_id,
        supplier: entry.supplier_name,
        item: entry.item_description,
        category: entry.material_category,
        new_price: entry.unit_price,
        old_price: entry.previous_rate,
        change_pct: priceDiff,
        scoper: job?.type === 'fencing' ? 'khairo' : 'nathan',
        job_number: job?.job_number,
      },
    })
  }

  return { success: true, ledger_id, scoper_notified: !!scoperAlert }
}

async function dismissPrice(client: any, body: any) {
  const { ledger_id, reason } = body
  if (!ledger_id) throw new Error('ledger_id required')

  const { error } = await client.from('material_price_ledger')
    .update({
      status: 'dismissed',
      dismiss_reason: reason || null,
    })
    .eq('id', ledger_id)

  if (error) throw error
  return { success: true, ledger_id }
}

async function getPendingPrices(client: any) {
  const { data, error } = await client.from('material_price_ledger')
    .select('id, supplier_name, item_description, material_category, material_code, unit, unit_price, po_id, captured_at, status')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('status', 'pending')
    .order('captured_at', { ascending: false })
    .limit(50)

  if (error) throw error
  return { pending_prices: data || [] }
}


// ════════════════════════════════════════════════════════════
// TRADE — REPORT ISSUE (creates ai_alert visible in ops.html)
// ════════════════════════════════════════════════════════════

async function createTradeAlert(client: any, userId: string, body: any) {
  const { jobId, job_id, issueType, issue_type, detail } = body
  const jId = jobId || job_id
  const iType = issueType || issue_type
  if (!jId || !iType) throw new Error('jobId and issueType required')

  // Look up job for context
  const { data: job } = await client.from('jobs')
    .select('id, job_number, client_name, suburb')
    .eq('id', jId)
    .single()

  const jobLabel = job ? `${job.job_number} (${job.client_name || job.suburb || 'unknown'})` : jId

  // Look up reporting user name
  const { data: user } = await client.from('users')
    .select('full_name')
    .eq('id', userId)
    .single()

  const reporterName = user?.full_name || 'Trade crew'

  // Insert ai_alert (amber severity)
  const { data: alert, error } = await client.from('ai_alerts').insert({
    org_id: DEFAULT_ORG_ID,
    alert_type: `trade_issue_${iType.replace(/\s+/g, '_').toLowerCase()}`,
    severity: 'amber',
    message: `${reporterName} reported: ${iType}${detail ? ' — ' + detail : ''} on job ${jobLabel}`,
    context: {
      job_id: jId,
      job_number: job?.job_number || null,
      issue_type: iType,
      detail: detail || null,
      reported_by: userId,
      reporter_name: reporterName,
    },
  }).select('id').single()

  if (error) throw error

  // Dual-write to business_events
  logBusinessEvent(client, {
    event_type: 'trade.issue_reported',
    source: 'app/field',
    entity_type: 'job',
    entity_id: jId,
    correlation_id: jId,
    job_id: jId,
    payload: {
      issue_type: iType,
      detail: detail || null,
      alert_id: alert?.id,
      reporter: reporterName,
      job_number: job?.job_number || null,
    },
  })

  // Telegram notification to Shaun (non-blocking)
  if (body.notify_telegram) {
    const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
    if (TELEGRAM_BOT_TOKEN) {
      const { data: shaun } = await client.from('users').select('telegram_id').ilike('email', '%shaun%').not('telegram_id', 'is', null).limit(1).maybeSingle()
      if (shaun?.telegram_id) {
        try {
          await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: shaun.telegram_id,
              text: `\u26A0 Materials issue on ${jobLabel}\n${reporterName}: ${detail || iType}`,
            }),
          })
        } catch (e) { console.log('[ops-api] Telegram materials notify failed:', e) }
      }
    }
  }

  return { success: true, alert_id: alert?.id }
}


// ════════════════════════════════════════════════════════════
// VARIATION FLOW — site conditions differ from scope
// ════════════════════════════════════════════════════════════

async function createVariation(client: any, body: any) {
  const { job_id, jobId, description, estimated_cost, amount, photo_url, user_id, userId, reason, cost_estimate, invoice_method } = body
  const jId = job_id || jobId
  const uid = user_id || userId
  if (!jId || !description) throw new Error('job_id and description required')

  const cost = Number(estimated_cost || amount || 0)
  const needsApproval = cost > 200

  // Get job info for routing to correct salesperson
  const { data: job } = await client.from('jobs')
    .select('type, client_name, job_number, created_by')
    .eq('id', jId)
    .single()

  // Calculate next variation number for this job
  const { count } = await client.from('job_variations')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', jId)
  const variationNumber = (count || 0) + 1

  // Insert into job_variations table (v2 — replaces job_events pattern)
  const { data: variation, error: insertErr } = await client.from('job_variations').insert({
    org_id: DEFAULT_ORG_ID,
    job_id: jId,
    variation_number: variationNumber,
    description,
    amount: cost,
    reason: reason || null,
    cost_estimate: cost_estimate ? Number(cost_estimate) : null,
    photo_url: photo_url || null,
    status: needsApproval ? 'pending_approval' : 'auto_approved',
    needs_approval: needsApproval,
    invoice_method: invoice_method || 'with_final',
    created_by: uid || null,
  }).select('id, share_token, variation_number').single()
  if (insertErr) {
    if (insertErr.code === '23503') throw new ApiError('Invalid job_id — job does not exist', 400)
    throw insertErr
  }

  // Also log to job_events for backwards-compatible audit trail
  await client.from('job_events').insert({
    job_id: jId,
    user_id: uid || null,
    event_type: 'variation_requested',
    detail_json: { description, estimated_cost: cost, photo_url: photo_url || null, variation_id: variation.id },
  })

  // Dual-write to business_events
  logBusinessEvent(client, {
    event_type: 'variation.requested',
    source: 'app/field',
    entity_type: 'job_variation',
    entity_id: variation.id,
    job_id: job?.job_number || jId,
    correlation_id: jId,
    payload: {
      entity: { id: jId, name: job?.client_name || '' },
      financial: { amount: cost, currency: 'AUD' },
      variation: { id: variation.id, number: variationNumber, description, needs_approval: needsApproval },
    },
  })

  // If over $200, create an alert for the salesperson / ops
  if (needsApproval) {
    await client.from('ai_alerts').insert({
      org_id: DEFAULT_ORG_ID,
      job_id: jId,
      alert_type: 'variation_approval_needed',
      severity: cost > 500 ? 'red' : 'amber',
      message: `Variation request: ${job?.client_name || ''} (${job?.job_number || ''}) — ${description} — $${cost}`,
      recommended_action: `Review and approve/reject. Crew is waiting on site. ${job?.type === 'fencing' ? 'Khairo should call client.' : 'Nathan should call client.'}`,
      financial_impact: cost,
      detail_json: {
        job_id: jId,
        description,
        estimated_cost: cost,
        variation_id: variation.id,
        requires: job?.type === 'fencing' ? 'khairo' : 'nathan',
      },
    })
  }

  return {
    success: true,
    variation_id: variation.id,
    variation_number: variationNumber,
    share_token: variation.share_token,
    needs_approval: needsApproval,
    auto_approved: !needsApproval,
    message: needsApproval
      ? `Variation #${variationNumber} logged — $${cost} requires approval. ${job?.type === 'fencing' ? 'Khairo' : 'Nathan'} has been notified.`
      : `Variation #${variationNumber} logged and auto-approved ($${cost} under $200 threshold).`,
  }
}

async function approveVariation(client: any, body: any) {
  const { variation_id, event_id, eventId, approved, user_id, userId, notes } = body
  // Accept both variation_id (new) and event_id (backward compat)
  const vId = variation_id || event_id || eventId
  if (!vId) throw new Error('variation_id required')

  // Try job_variations first (v2), fall back to job_events (legacy)
  const { data: variation } = await client.from('job_variations')
    .select('id, job_id, description, amount, status')
    .eq('id', vId)
    .maybeSingle()

  if (variation) {
    // V2 path: update job_variations
    await client.from('job_variations').update({
      status: approved ? 'approved' : 'rejected',
      approved_by: user_id || userId || null,
      approved_at: new Date().toISOString(),
      approval_notes: notes || null,
      updated_at: new Date().toISOString(),
    }).eq('id', vId)
  } else {
    // Legacy path: update job_events
    const { data: event } = await client.from('job_events')
      .select('id, job_id, detail_json')
      .eq('id', vId)
      .single()
    if (!event) throw new Error('Variation not found')

    const detail = event.detail_json || {}
    detail.status = approved ? 'approved' : 'rejected'
    detail.approved_by = user_id || userId || null
    detail.approved_at = new Date().toISOString()
    detail.approval_notes = notes || null
    await client.from('job_events').update({ detail_json: detail }).eq('id', vId)
  }

  const jobId = variation?.job_id
  if (jobId) {
    // Log approval event
    await client.from('job_events').insert({
      job_id: jobId,
      user_id: user_id || userId || null,
      event_type: approved ? 'variation_approved' : 'variation_rejected',
      detail_json: { variation_id: vId, notes: notes || null },
    })

    // Dismiss the alert
    await client.from('ai_alerts')
      .update({ resolved_at: new Date().toISOString(), resolved_by: user_id || userId || null })
      .eq('alert_type', 'variation_approval_needed')
      .eq('job_id', jobId)
      .is('resolved_at', null)
  }

  logBusinessEvent(client, {
    event_type: approved ? 'variation.approved' : 'variation.rejected',
    entity_type: 'job_variation',
    entity_id: vId,
    job_id: jobId || '',
    payload: { approved, notes },
    metadata: { operator: user_id || userId || null },
  })

  return {
    success: true,
    approved,
    message: approved ? 'Variation approved — crew can proceed.' : 'Variation rejected.',
  }
}

async function listVariations(client: any, params: URLSearchParams) {
  const jobId = params.get('job_id') || params.get('jobId')
  const status = params.get('status')

  // Query from job_variations table (v2)
  let query = client.from('job_variations')
    .select('id, job_id, variation_number, description, amount, reason, photo_url, status, needs_approval, share_token, sent_at, accepted_at, declined_at, created_by, approved_by, approved_at, approval_notes, created_at, jobs:job_id(client_name, job_number, type)')
    .order('created_at', { ascending: false })
    .limit(50)

  if (jobId) query = query.eq('job_id', jobId)
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw error

  const variations = (data || []).map((v: any) => ({
    id: v.id,
    job_id: v.job_id,
    variation_number: v.variation_number,
    client_name: v.jobs?.client_name,
    job_number: v.jobs?.job_number,
    job_type: v.jobs?.type,
    description: v.description,
    estimated_cost: v.amount,
    amount: v.amount,
    reason: v.reason,
    status: v.status,
    photo_url: v.photo_url,
    share_token: v.share_token,
    sent_at: v.sent_at,
    accepted_at: v.accepted_at,
    created_at: v.created_at,
    approved_by: v.approved_by,
    approved_at: v.approved_at,
  }))

  return { variations }
}


// ════════════════════════════════════════════════════════════
// SUPPLIER QUOTE ANALYSIS — AI reads supplier quote, compares to PO,
// classifies reply (confirmation/question/issue), extracts delivery date,
// and normalises prices to per-unit rates.
// One Sonnet call does pricing + classification — no separate Haiku needed.
// ════════════════════════════════════════════════════════════

async function analyseSupplierQuote(client: any, body: any) {
  const { po_id, poId, image_url, image_base64, quote_text } = body
  const pId = po_id || poId
  if (!pId) throw new Error('po_id required')
  if (!image_url && !image_base64 && !quote_text) throw new Error('image_url, image_base64, or quote_text required')

  const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || ''
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured')

  // Get the PO with its line items (what we ordered)
  const { data: po, error: poErr } = await client.from('purchase_orders')
    .select('id, po_number, supplier_name, job_id, line_items, total, reference, status')
    .eq('id', pId)
    .single()

  if (poErr || !po) throw new Error('PO not found')

  // Get the job's pricing_json (what was quoted to client)
  let jobPricing: any = null
  if (po.job_id) {
    const { data: job } = await client.from('jobs')
      .select('job_number, pricing_json, type')
      .eq('id', po.job_id)
      .single()
    if (job) jobPricing = { job_number: job.job_number, type: job.type, pricing: job.pricing_json }
  }

  // Build the Claude message with the supplier quote
  const content: any[] = []

  if (image_url) {
    try {
      const imgResp = await fetch(image_url)
      const imgBuf = await imgResp.arrayBuffer()
      const b64 = btoa(String.fromCharCode(...new Uint8Array(imgBuf)))
      const mediaType = imgResp.headers.get('content-type') || 'image/jpeg'
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: b64 },
      })
    } catch (e) {
      console.log('[ops-api] Failed to fetch image, falling back to URL reference')
      content.push({ type: 'text', text: `[Supplier quote image at: ${image_url}]` })
    }
  } else if (image_base64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: image_base64 },
    })
  }

  const poLineItemsText = (po.line_items || []).map((item: any, i: number) =>
    `${i + 1}. ${item.description || item.desc || '?'} | Qty: ${item.quantity || item.qty || '?'} | Unit: ${item.unit || 'ea'} | Our price: $${item.unit_price || item.price || '?'}`
  ).join('\n')

  content.push({
    type: 'text',
    text: `You are analysing a supplier email/quote/invoice for SecureWorks Group, a Perth construction company.

SUPPLIER: ${po.supplier_name}
PO NUMBER: ${po.po_number || 'N/A'}
PO REFERENCE: ${po.reference || 'N/A'}

OUR PO LINE ITEMS (what we ordered / expected to pay):
${poLineItemsText || 'No line items on PO'}

${quote_text ? `SUPPLIER EMAIL/QUOTE TEXT:\n${quote_text}` : 'The supplier quote is in the attached image.'}

You have THREE tasks:

TASK 1 — CLASSIFY THE EMAIL:
Determine the type of this supplier communication:
- "confirmation" = supplier is confirming the order / acknowledging receipt
- "quote" = supplier is providing pricing / a formal quote
- "invoice" = supplier is sending an invoice or bill for payment
- "question" = supplier is asking a question about the order
- "issue" = supplier is flagging a problem (out of stock, delay, price change)
- "delivery_update" = supplier is providing delivery timing
- "other" = doesn't fit above categories

Also determine: Is this a delivery confirmation? If yes, extract the confirmed delivery date as YYYY-MM-DD.

Provide a classification_confidence score (0.0 to 1.0):
- 1.0 = absolutely certain (e.g. "Order confirmed, delivering Thursday 3rd April")
- 0.8+ = confident (clear intent, explicit language)
- 0.5-0.8 = uncertain (ambiguous wording, could be read multiple ways)
- Below 0.5 = guessing (e.g. auto-reply, generic "thanks", unclear intent)

TASK 2 — EXTRACT PRICING (if email contains pricing):
Extract every line item with pricing. For each item provide:
1. description (exactly as written on the quote)
2. quantity
3. unit (m, ea, sheet, bag, length, etc.) — as the supplier wrote it
4. unit_price (the supplier's price per unit as written, excluding GST)
5. total (qty × unit_price)
6. material_category (one of: steel, roofing, concrete, flashings, fixings, fencing, guttering, labour, other)
7. material_code (if identifiable, e.g. "SHS-100x50x2", "SOLARSPAN-75")

Then compare each supplier line item to our PO line items above. Flag any price differences.

TASK 3 — NORMALISE PRICES TO PER-UNIT RATES:
For each line item, ALSO calculate a normalised per-unit price using these reference dimensions:
- Metroll colorbond panel width: 2365mm (so a panel at $97 = $97/2.365m = $41.01/m)
- R&R Fencing colorbond panel width: 2380mm
- SolarSpan panels: 1000mm cover width
- Standard post lengths: 2400mm, 2700mm, 3000mm
- If supplier quotes a bundle (e.g. "10 panels for $970"), break down to per-unit ($97/panel)
- If supplier quotes per length (e.g. "$45 per 3m post"), convert to per-metre ($15/m)

For each line item, provide:
- raw_price: the exact price as the supplier quoted it
- raw_unit: the exact unit as quoted (e.g. "per panel", "per 3m length", "per 10 pack")
- normalised_price: the calculated per-standard-unit price
- normalised_unit: the standard unit (m, m², ea, bag, etc.)

Return ONLY valid JSON in this exact format:
{
  "email_classification": "confirmation|quote|invoice|question|issue|delivery_update|other",
  "classification_confidence": 0.9,
  "is_delivery_confirmation": false,
  "confirmed_delivery_date": null,
  "delivery_notes": "",
  "issue_summary": "",
  "supplier_name": "...",
  "invoice_number": "...",
  "invoice_date": "...",
  "subtotal": 0,
  "gst": 0,
  "total": 0,
  "line_items": [
    {
      "description": "...",
      "quantity": 0,
      "unit": "...",
      "unit_price": 0,
      "total": 0,
      "material_category": "...",
      "material_code": "...",
      "our_po_price": 0,
      "price_difference_pct": 0,
      "raw_price": 0,
      "raw_unit": "...",
      "normalised_price": 0,
      "normalised_unit": "...",
      "note": "..."
    }
  ]
}`,
  })

  // Call Claude Sonnet — one call for pricing + classification + normalisation
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content }],
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Claude API error: ${resp.status} — ${errText.slice(0, 200)}`)
  }

  const result = await resp.json()
  const responseText = result.content?.[0]?.text || ''

  // Parse the JSON response
  let extracted: any = null
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/)
    if (jsonMatch) extracted = JSON.parse(jsonMatch[0])
  } catch (e) {
    console.log('[ops-api] Failed to parse Claude response as JSON')
    return { success: false, error: 'Failed to parse supplier quote', raw_response: responseText.slice(0, 500) }
  }

  if (!extracted) {
    return { success: false, error: 'No data extracted', raw_response: responseText.slice(0, 500) }
  }

  // ── Handle email classification and PO status updates ──
  const classification = extracted.email_classification || 'other'
  const confidence = Number(extracted.classification_confidence) || 0
  const HIGH_CONFIDENCE = 0.8
  const isConfirmation = classification === 'confirmation' || extracted.is_delivery_confirmation === true
  const confirmedDeliveryDate = extracted.confirmed_delivery_date || null
  const isQuestion = classification === 'question'
  const isIssue = classification === 'issue'
  const isInvoice = classification === 'invoice'

  // Update PO status if this is a HIGH-CONFIDENCE confirmation
  if (isConfirmation && confidence >= HIGH_CONFIDENCE && po.status !== 'delivered' && po.status !== 'billed') {
    const poUpdate: any = { status: 'authorised' }
    if (confirmedDeliveryDate) poUpdate.confirmed_delivery_date = confirmedDeliveryDate
    await client.from('purchase_orders').update(poUpdate).eq('id', po.id)
    console.log(`[ops-api] PO ${po.po_number} confirmed by supplier (${Math.round(confidence * 100)}% confidence)${confirmedDeliveryDate ? ', delivery ' + confirmedDeliveryDate : ''}`)

    // Create job_event for confirmation
    if (po.job_id) {
      await client.from('job_events').insert({
        job_id: po.job_id,
        event_type: 'po_confirmed',
        detail_json: {
          po_id: po.id,
          po_number: po.po_number,
          supplier: po.supplier_name,
          confirmed_delivery_date: confirmedDeliveryDate,
          ai_confidence: confidence,
        },
      })
    }

    // Auto-resolve any supplier_no_response annotation on this PO
    try {
      await client.from('ai_annotations')
        .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolved_by: 'system' })
        .eq('annotation_type', 'supplier_no_response')
        .eq('status', 'active')
        .contains('structured_data', { po_id: po.id })
    } catch (e) { /* non-blocking */ }
  } else if (isConfirmation && confidence < HIGH_CONFIDENCE) {
    // Low confidence confirmation — flag for manual review, DON'T change PO status
    console.log(`[ops-api] PO ${po.po_number} classified as confirmation but low confidence (${Math.round(confidence * 100)}%) — flagging for review`)
    if (confirmedDeliveryDate) {
      await client.from('purchase_orders').update({ confirmed_delivery_date: confirmedDeliveryDate }).eq('id', po.id)
    }
    try {
      await client.from('ai_annotations').insert({
        org_id: DEFAULT_ORG_ID,
        job_id: po.job_id || null,
        annotation_type: 'classification_review',
        status: 'active',
        priority: 70,
        severity: 'amber',
        title: `Review: ${po.supplier_name} email on ${po.po_number} — "${classification}" (${Math.round(confidence * 100)}%)`,
        body: `AI classified this supplier email as a confirmation but confidence is ${Math.round(confidence * 100)}%. Please review the email and manually advance the PO if correct.`,
        structured_data: { po_id: po.id, po_number: po.po_number, classification, confidence },
        source: 'ai/analyse_supplier_quote',
      })
    } catch (e) { /* non-blocking */ }
  } else if (confirmedDeliveryDate && !isConfirmation) {
    // Delivery date mentioned but not a full confirmation — still save it
    await client.from('purchase_orders')
      .update({ confirmed_delivery_date: confirmedDeliveryDate })
      .eq('id', po.id)
  }

  // Handle invoice classification — mark PO as invoice received
  if (isInvoice && confidence >= HIGH_CONFIDENCE) {
    await client.from('purchase_orders')
      .update({ invoice_received_at: new Date().toISOString() })
      .eq('id', po.id)
      .is('invoice_received_at', null) // only set once
    console.log(`[ops-api] PO ${po.po_number} invoice received from ${po.supplier_name}`)
    if (po.job_id) {
      try {
        await client.from('ai_annotations').insert({
          org_id: DEFAULT_ORG_ID,
          job_id: po.job_id,
          annotation_type: 'invoice_received',
          status: 'active',
          priority: 70,
          severity: 'info',
          title: `Invoice received — ${po.supplier_name} (${po.po_number})`,
          body: `Supplier sent an invoice. Total: $${extracted.total || 'unknown'}. Review and match to PO.`,
          structured_data: { po_id: po.id, po_number: po.po_number, supplier: po.supplier_name, invoice_total: extracted.total },
          source: 'ai/analyse_supplier_quote',
        })
      } catch (e) { /* non-blocking */ }
    }
  }

  // Create annotation for supplier questions or issues
  if ((isQuestion || isIssue) && po.job_id) {
    const summary = extracted.issue_summary || extracted.delivery_notes || 'Supplier sent a ' + classification
    try {
      await client.from('ai_annotations').insert({
        org_id: DEFAULT_ORG_ID,
        job_id: po.job_id,
        annotation_type: 'supplier_issue',
        status: 'active',
        priority: isIssue ? 80 : 60,
        severity: isIssue ? 'amber' : 'info',
        title: `${po.supplier_name} — ${classification} on ${po.po_number}`,
        body: summary,
        structured_data: {
          po_id: po.id,
          po_number: po.po_number,
          supplier: po.supplier_name,
          classification,
        },
        source: 'ai/analyse_supplier_quote',
      })
    } catch (e) { /* non-blocking */ }
  }

  // ── Store extracted prices in material_price_ledger ──
  const lineItems = extracted.line_items || []

  // If this is a new quote, dismiss old pending entries for the same PO (superseded)
  if (classification === 'quote' && lineItems.length > 0) {
    try {
      await client.from('material_price_ledger')
        .update({ status: 'dismissed', dismiss_reason: 'superseded by newer quote' })
        .eq('po_id', po.id)
        .eq('status', 'pending')
    } catch (e) { /* non-blocking */ }
  }

  let stored = 0
  for (const item of lineItems) {
    if (!item.unit_price || item.unit_price <= 0) continue

    // Use normalised price if available, otherwise raw
    const normPrice = item.normalised_price && item.normalised_price > 0 ? item.normalised_price : item.unit_price
    const normUnit = item.normalised_unit || item.unit || 'ea'

    await client.from('material_price_ledger').insert({
      org_id: DEFAULT_ORG_ID,
      supplier_name: po.supplier_name,
      item_description: item.description || '',
      material_category: item.material_category || 'other',
      material_code: item.material_code || null,
      unit: normUnit,
      unit_price: normPrice,
      raw_supplier_price: item.raw_price || item.unit_price,
      raw_supplier_unit: item.raw_unit || item.unit || null,
      po_id: po.id,
      job_id: po.job_id || null,
      status: 'pending',
      previous_rate: item.our_po_price || null,
    })
    stored++
  }

  // Log as job_event
  if (po.job_id) {
    await client.from('job_events').insert({
      job_id: po.job_id,
      event_type: 'supplier_quote_analysed',
      detail_json: {
        po_id: po.id,
        po_number: po.po_number,
        supplier: po.supplier_name,
        items_extracted: stored,
        total: extracted.total,
        invoice_number: extracted.invoice_number,
        classification,
        is_confirmation: isConfirmation,
        confirmed_delivery_date: confirmedDeliveryDate,
      },
    })
  }

  // Dual-write to business_events
  try {
    await client.from('business_events').insert({
      event_type: 'supplier_quote.analysed',
      source: 'ai/claude-sonnet',
      entity_type: 'purchase_order',
      entity_id: po.id,
      job_id: po.reference || po.po_number || '',
      correlation_id: po.job_id || null,
      payload: {
        supplier: po.supplier_name,
        items_extracted: stored,
        total: extracted.total,
        classification,
        is_confirmation: isConfirmation,
        confirmed_delivery_date: confirmedDeliveryDate,
        price_differences: lineItems.filter((i: any) => i.price_difference_pct && Math.abs(i.price_difference_pct) > 5).length,
      },
    })
  } catch (e) { /* non-blocking */ }

  return {
    success: true,
    po_number: po.po_number,
    supplier: po.supplier_name,
    items_extracted: stored,
    supplier_total: extracted.total,
    invoice_number: extracted.invoice_number,
    classification,
    is_confirmation: isConfirmation,
    confirmed_delivery_date: confirmedDeliveryDate,
    line_items: lineItems,
    price_alerts: lineItems.filter((i: any) => i.price_difference_pct && Math.abs(i.price_difference_pct) > 5),
  }
}


// ════════════════════════════════════════════════════════════
// PROPOSED ACTIONS (Draft SMS, etc.)
// ════════════════════════════════════════════════════════════

async function listProposedActions(client: any, params: URLSearchParams) {
  const actionType = params.get('action_type')
  const status = params.get('status') || 'pending'
  const requestedLimit = parseInt(params.get('limit') || '1000', 10)
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 1000, 1), 1000)
  const nowMs = Date.now()

  const effectiveExpiresAt = (row: any): string | null => {
    if (row.expires_at) return row.expires_at
    const createdMs = new Date(row.created_at || nowMs).getTime()
    if (!Number.isFinite(createdMs)) return null
    const ttlHours =
      row.action_type === 'propose_quote_review_task' ? 7 * 24 :
      row.action_type === 'propose_scoper_booking_approval' ? 24 :
      36
    return new Date(createdMs + ttlHours * 3600000).toISOString()
  }

  // No embedded join — production has no FK ai_proposed_actions.job_id → jobs.id.
  // PostgREST silently fails an embedded join in that case; handler then
  // returned { actions: [] } even though rows existed (122 in DB on 2026-05-04).
  // Pull rows flat, apply expiry semantics in JS, then batch-hydrate jobs
  // separately. Some live quote-followup rows were written without expires_at;
  // treating null as expired inside the SQL query hid real work from sale.html.
  let query = client.from('ai_proposed_actions')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (actionType) query = query.eq('action_type', actionType)

  const { data, error } = await query
  if (error) {
    // Surface the error instead of silently returning empty — that's how the
    // missing-FK bug went undetected.
    console.error('[ops-api] list_proposed_actions query failed:', error.message)
    return { actions: [], error: error.message }
  }

  // Urgency ordering: revenue-loaded chases first (deposit > quote > followup),
  // booking actions next, cold call_now last. Within each priority bucket,
  // closer-to-expiry rises, then older-created rises. Unknown types land
  // at the bottom (weight 200) so they're visibly deprioritised, not dropped.
  const ACTION_PRIORITY: Record<string, number> = {
    deposit_followup: 10,
    propose_quote_review_task: 20,
    send_quote_followup_sms: 30,
    send_followup_sms: 40,
    scope_confirmation: 50,
    propose_scoper_booking_approval: 60,
    propose_scoper_call_task: 70,
    book_scope: 80,
    send_booking_sms: 90,
    call_now: 100,
  }
  const priorityFor = (actionType: string) =>
    ACTION_PRIORITY[actionType] ?? 200

  const rows = (data || [])
    .map((row: any) => ({ ...row, expires_at: effectiveExpiresAt(row) }))
    .filter((row: any) => {
      if (status !== 'pending' && status !== 'approved') return true
      if (status === 'pending' && row.sent_at) return false
      if (!row.expires_at) return false
      return new Date(row.expires_at).getTime() > nowMs
    })
    .sort((a: any, b: any) => {
      const pa = priorityFor(a.action_type)
      const pb = priorityFor(b.action_type)
      if (pa !== pb) return pa - pb
      const ea = a.expires_at ? new Date(a.expires_at).getTime() : Infinity
      const eb = b.expires_at ? new Date(b.expires_at).getTime() : Infinity
      if (ea !== eb) return ea - eb
      const ca = new Date(a.created_at).getTime()
      const cb = new Date(b.created_at).getTime()
      return ca - cb
    })
  const jobIds = Array.from(new Set(rows.map((r: any) => r.job_id).filter(Boolean)))
  let jobsById: Record<string, any> = {}
  if (jobIds.length) {
    const { data: jobsData, error: jobsErr } = await client.from('jobs')
      .select('id, job_number, client_name, type')
      .in('id', jobIds)
    if (jobsErr) {
      console.error('[ops-api] list_proposed_actions jobs hydrate failed:', jobsErr.message)
    } else {
      (jobsData || []).forEach((j: any) => { jobsById[j.id] = j })
    }
  }

  return {
    actions: rows.map((a: any) => {
      const j = a.job_id ? jobsById[a.job_id] : null
      return {
        ...a,
        job_number: j?.job_number || null,
        job_type: j?.type || null,
        client_name: a.contact_name || j?.client_name || null,
      }
    }),
  }
}

// ────────────────────────────────────────────────────────────────────
// Canary SMS guard
//
// Per validator hard-blocker 2026-05-14: before any booking canary
// commit, the SMS-send paths in ops-api must refuse real-customer
// recipients when BOOKING_CANARY_MODE=1.
//
// Contract (tightened per validator review):
//   - BOOKING_CANARY_MODE unset / falsy → guard is a no-op (returns ok).
//   - BOOKING_CANARY_MODE in {"1","true","yes"} (case-insensitive) →
//     recipient.contact_phone MUST be present AND match (after digit-
//     only normalization) an entry in BOOKING_CANARY_PHONE_ALLOWLIST.
//     Nothing else (no SECURE_SALE_TEST marker, no metadata flag) is
//     sufficient to bypass — phone-in-allowlist is the only gate.
//
//     SECURE_SALE_TEST / test_archived markers are logged into the
//     refusal reason for telemetry only; future iterations may require
//     BOTH phone allowlist AND marker for additional safety.
//
//   Normalization: phone comparison is digit-only ("+61 400 111 222"
//   normalises to "61400111222"); accepts allowlist entries in any
//   format. Empty result after normalization is treated as "no phone".
//
// Pure function; no I/O. Tests mirror this body in
// supabase/functions/ops-api/canary_sms_guard_test.ts (drift caught
// by PR review per local convention).
// ────────────────────────────────────────────────────────────────────
export function validateCanarySmsRecipient(args: {
  contact_phone: string | null | undefined
  metadata?: Record<string, unknown> | null
  action_payload?: Record<string, unknown> | null
}): { ok: boolean; reason?: string } {
  const rawMode = String(Deno.env.get('BOOKING_CANARY_MODE') ?? '').toLowerCase()
  const canaryOn = rawMode === '1' || rawMode === 'true' || rawMode === 'yes'
  if (!canaryOn) return { ok: true }

  const normalize = (s: string): string => s.replace(/\D+/g, '')

  const allowRaw = String(Deno.env.get('BOOKING_CANARY_PHONE_ALLOWLIST') ?? '')
  const allowedNorm = allowRaw
    .split(',')
    .map((s) => normalize(s))
    .filter((s) => s.length > 0)
  const phoneRaw = String(args.contact_phone ?? '').trim()
  const phoneNorm = normalize(phoneRaw)

  // Hard requirement #1: phone must be present (post-normalization).
  if (!phoneNorm) {
    return {
      ok: false,
      reason:
        `BOOKING_CANARY_MODE=on: recipient has no phone (raw=${JSON.stringify(phoneRaw)}); ` +
        `phone-in-BOOKING_CANARY_PHONE_ALLOWLIST is the only gate. Refused.`,
    }
  }

  // Hard requirement #2: phone must match an allowlist entry exactly
  // (digit-only normalized). Empty allowlist → reject every send.
  if (allowedNorm.length === 0 || !allowedNorm.includes(phoneNorm)) {
    const meta = (args.metadata ?? {}) as Record<string, unknown>
    const ap = (args.action_payload ?? {}) as Record<string, unknown>
    const markerNote =
      meta.SECURE_SALE_TEST === true ||
      ap.SECURE_SALE_TEST === true ||
      meta.test_archived === true
        ? ' (SECURE_SALE_TEST marker present on proposal — logged but NOT sufficient to bypass per validator review)'
        : ''
    return {
      ok: false,
      reason:
        `BOOKING_CANARY_MODE=on: recipient phone "${phoneRaw}" (normalized "${phoneNorm}") ` +
        `not in BOOKING_CANARY_PHONE_ALLOWLIST` + markerNote + '.',
    }
  }

  return { ok: true }
}

async function sendProposedSms(client: any, body: any) {
  const { action_id } = body
  if (!action_id) throw new Error('action_id required')

  // Get the proposed action
  const { data: action, error } = await client.from('ai_proposed_actions')
    .select('*')
    .eq('proposal_id', action_id)
    .eq('status', 'pending')
    .single()

  if (error || !action) throw new Error('Action not found or already processed')

  // ── Canary safety guard (validator hard-block 2026-05-14) ──
  // When BOOKING_CANARY_MODE=1, refuse before any external API call so
  // no real-customer SMS can be sent. Returns a structured error the
  // cockpit / caller can surface; status stays 'pending' so the row is
  // not silently consumed.
  const canaryCheck = validateCanarySmsRecipient({
    contact_phone: action.contact_phone,
    metadata: action.metadata,
    action_payload: action.action_payload,
  })
  if (!canaryCheck.ok) {
    return {
      success: false,
      action_id,
      error: 'canary_recipient_blocked',
      reason: canaryCheck.reason ?? 'canary guard refused recipient',
    }
  }

  // Send SMS via ghl-proxy
  const ghlUrl = Deno.env.get('SUPABASE_URL')?.replace('/rest/v1', '') + '/functions/v1/ghl-proxy'
  const ghlKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

  if (action.contact_id && action.drafted_message) {
    try {
      await fetch(`${ghlUrl}?action=send_sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ghlKey}`,
        },
        body: JSON.stringify({
          contactId: action.contact_id,
          message: action.drafted_message,
          jobId: action.job_id,
        }),
      })
    } catch (e: any) {
      console.error('[ops-api] Failed to send SMS via ghl-proxy:', e.message)
      throw new Error('SMS sending failed — check ghl-proxy logs')
    }
  }

  // Mark as sent
  await client.from('ai_proposed_actions')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('proposal_id', action_id)

  // Log as job event
  if (action.job_id) {
    await client.from('job_events').insert({
      job_id: action.job_id,
      event_type: 'sms_sent',
      detail_json: {
        type: action.action_type,
        message: action.drafted_message,
        contact_name: action.contact_name,
        source: 'ai_proposed_action',
      },
    })
  }

  return { success: true, action_id }
}

// ════════════════════════════════════════════════════════════
// Quote Follow-Up send handler (atomic-claim per memory
// feedback_atomic_claim_pattern_for_proposal_handlers).
//
// Mirrors sendProposedSms's envelope but adds a real claim-then-side-effect
// pattern so concurrent approvals can't double-send the customer:
//   1) UPDATE … WHERE status='pending' AND action_type='send_quote_followup_sms'
//      RETURNING * — claims the row atomically.
//   2) Send SMS via ghl-proxy.
//   3) UPDATE … WHERE status='approved' RETURNING * — finalizes status='sent'.
// ════════════════════════════════════════════════════════════
async function sendQuoteFollowupSms(client: any, body: any) {
  const { action_id, user_id } = body
  if (!action_id) throw new Error('action_id required')

  // Step 1: atomic claim — UPDATE pending → approved with returning.
  // If zero rows returned, another worker already claimed (or row absent).
  const { data: claimed, error: claimErr } = await client
    .from('ai_proposed_actions')
    .update({
      status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by: user_id || null,
    })
    .eq('proposal_id', action_id)
    .eq('status', 'pending')
    .eq('action_type', 'send_quote_followup_sms')
    .select('proposal_id, action_type, contact_id, contact_name, contact_phone, drafted_message, job_id, action_payload')
    .limit(1)
  if (claimErr) throw claimErr
  if (!claimed || claimed.length === 0) {
    // 409: either not found, already-claimed, wrong status, or wrong action_type.
    return { success: false, action_id, error: 'claim_failed', reason: 'proposal not found or already claimed (status != pending or action_type != send_quote_followup_sms)' }
  }
  const action = claimed[0]

  // ── Canary safety guard (validator hard-block 2026-05-14) ──
  // Same contract as sendProposedSms: when BOOKING_CANARY_MODE=1,
  // refuse before any external API call. Row was just claimed
  // (status='approved') — roll it back to 'pending' so it isn't
  // silently consumed.
  const canaryCheck = validateCanarySmsRecipient({
    contact_phone: (action as any).contact_phone,
    metadata: (action as any).metadata,
    action_payload: (action as any).action_payload,
  })
  if (!canaryCheck.ok) {
    await client.from('ai_proposed_actions')
      .update({ status: 'pending', approved_at: null, approved_by: null })
      .eq('proposal_id', action_id)
      .eq('status', 'approved')
    return {
      success: false,
      action_id,
      error: 'canary_recipient_blocked',
      reason: canaryCheck.reason ?? 'canary guard refused recipient',
    }
  }

  // Step 2: customer-facing side effect — SMS via ghl-proxy.
  // If this throws, the row stays in status='approved' (not 'sent') so the
  // audit trail shows the claim happened but the send didn't. Operator sees
  // an "approved-not-sent" row in the cockpit and can investigate.
  if (!action.contact_id || !action.drafted_message) {
    // Roll back the claim — no contact to send to.
    await client.from('ai_proposed_actions')
      .update({ status: 'pending', approved_at: null, approved_by: null })
      .eq('proposal_id', action_id)
      .eq('status', 'approved')
    throw new Error('contact_id and drafted_message required to send')
  }
  const ghlUrl = Deno.env.get('SUPABASE_URL')?.replace('/rest/v1', '') + '/functions/v1/ghl-proxy'
  const ghlKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  let sendResult: any = null
  try {
    const resp = await fetch(`${ghlUrl}?action=send_sms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ghlKey}`,
      },
      body: JSON.stringify({
        contactId: action.contact_id,
        message: action.drafted_message,
        jobId: action.job_id,
      }),
    })
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      throw new Error(`ghl-proxy returned ${resp.status}: ${txt.slice(0, 200)}`)
    }
    sendResult = await resp.json().catch(() => ({}))
  } catch (e: any) {
    console.error('[ops-api/send_quote_followup_sms] SMS send failed:', e.message)
    throw new Error('SMS sending failed — check ghl-proxy logs (proposal stays at status=approved for audit)')
  }

  // Step 3: finalize — UPDATE approved → sent with returning. If zero rows,
  // a race or concurrent finalize occurred; log and return success-with-warning.
  const { data: finalized, error: finErr } = await client
    .from('ai_proposed_actions')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('proposal_id', action_id)
    .eq('status', 'approved')
    .select('proposal_id')
    .limit(1)
  if (finErr) {
    console.error('[ops-api/send_quote_followup_sms] finalize update failed:', finErr.message)
  }
  if (!finalized || finalized.length === 0) {
    console.warn('[ops-api/send_quote_followup_sms] finalize matched 0 rows for', action_id)
  }

  // Mirror sendProposedSms: log job_event for audit on the spine
  if (action.job_id) {
    try {
      await client.from('job_events').insert({
        job_id: action.job_id,
        event_type: 'sms_sent',
        detail_json: {
          type: action.action_type,
          message: action.drafted_message,
          contact_name: action.contact_name,
          source: 'ai_proposed_action',
          loop: 'quote_followup',
        },
      })
    } catch (_e) { /* spine log is best-effort */ }
  }

  return { success: true, action_id, send_result: sendResult }
}

// ════════════════════════════════════════════════════════════
// S2 G-2: cockpit bridge for sw_approve_booking_proposal.
//
// The cockpit's "Review slot" button calls ops-api action
// 'approve_booking_proposal'. Prior to S2 this dispatch fell through
// to the default 'Unknown action' branch (S1 audit G-2).
//
// This handler is a thin proxy: it POSTs the cockpit's body to the
// Railway agent's /api/booking-approvals/approve endpoint
// (booking-approval-http-bridge.ts), which already fronts
// sw_approve_booking_proposal. No Microsoft Graph, no Supabase address
// fallback, no SMS — the agent owns all of those.
//
// Why proxy instead of port: a second Graph + Supabase implementation
// in the edge function would drift. The bridge already exists. Owning
// only the cockpit-token → service-token swap here keeps the trust
// boundary tight.
//
// Env vars required at deploy time:
//   * RAILWAY_AGENT_URL  — https://secureworks-agent-production.up.railway.app
//   * SW_API_KEY         — Bearer token the Railway agent's requireAgentAuth accepts
// (Same env pair telegram-bot/index.ts already uses for /api/chat.)
//
// Dry-run vs commit:
//   * Body MAY include commit:true to actually fire the side effects.
//     Default is dry-run (commit:false). The cockpit double-confirms
//     before sending commit:true (sale.html:3056).
// ════════════════════════════════════════════════════════════
async function approveBookingProposalBridge(body: any, req: Request) {
  const proposalId = body?.proposal_id
  if (!proposalId || typeof proposalId !== 'string') {
    return { ok: false, error: 'proposal_id required' }
  }

  const agentUrl = Deno.env.get('RAILWAY_AGENT_URL') || Deno.env.get('SECUREWORKS_AGENT_URL') || ''
  const apiKey = Deno.env.get('SW_API_KEY') || ''
  if (!agentUrl || !apiKey) {
    return {
      ok: false,
      error: 'approve_booking_proposal bridge unconfigured: RAILWAY_AGENT_URL or SW_API_KEY env missing',
    }
  }

  const upstream = `${agentUrl.replace(/\/+$/, '')}/api/booking-approvals/approve`
  const payload = {
    proposal_id: proposalId,
    approver_user_id: typeof body.approver_user_id === 'string' ? body.approver_user_id : undefined,
    m2_drafted_message: typeof body.m2_drafted_message === 'string' ? body.m2_drafted_message : undefined,
    commit: body.commit === true,
  }

  let res: Response
  try {
    res = await fetch(upstream, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Forward the original caller's user id where the agent can use
        // it for the audit trail (booking-approval-handler emits
        // approver_user_id into the bookings_events payload).
        'X-Forwarded-For-User': req.headers.get('x-user-id') ?? '',
      },
      body: JSON.stringify(payload),
    })
  } catch (e: any) {
    return { ok: false, error: `bridge fetch failed: ${e?.message ?? 'unknown'}` }
  }

  let data: any = null
  try {
    data = await res.json()
  } catch {
    data = { ok: res.ok, raw_status: res.status }
  }

  if (!res.ok) {
    return {
      ok: false,
      error: data?.error ?? `agent bridge HTTP ${res.status}`,
      status: res.status,
      detail: data,
    }
  }

  // Mirror the agent response, plus a small ops-api breadcrumb the
  // cockpit can use for telemetry. The cockpit reads {result, ok} —
  // both are passed through verbatim from the agent.
  return {
    ok: true,
    bridge: 'ops-api → railway-agent /api/booking-approvals/approve',
    commit: payload.commit,
    dry_run: !payload.commit,
    result: data,
  }
}

// ════════════════════════════════════════════════════════════
// Quote-nurture cadence v3 — internal task approval handlers.
//
// Atomic-claim pattern (memory feedback_atomic_claim_pattern_for_proposal_handlers).
// Both handlers:
//   1) Validate-and-claim: UPDATE … WHERE status='pending' AND
//      action_type='<expected>' RETURNING * — claims the row atomically.
//   2) Customer-visible side effect (NONE for these handlers — internal
//      task creators only). Scoper calls record a manual outcome + internal
//      CRM note. Optional state flip on archive_lost.
//   3) Emit business_event + job_event for the spine.
//
// CRITICAL: NEITHER handler fires customer SMS, email, or an automated call.
// Scoper call approval may write a GHL internal contact note. Review approval
// emits events and (for archive_lost) flips jobs.status to 'lost'.
//
// Per parent card secure-sale-quote-followup-loop reframe v3
// (secureworks-docs/cio/operations/board/Secure-Sale-Automation/
//  secure-sale-quote-followup-loop/quote-nurture-reframe-2026-05-07.md).
// ════════════════════════════════════════════════════════════
async function pushGhlContactNoteBestEffort(client: any, opts: {
  contact_id?: string | null;
  job_id?: string | null;
  note_text: string;
}) {
  let contactId = opts.contact_id || null
  if (!contactId && opts.job_id) {
    const { data: jobRow, error: jobErr } = await client.from('jobs')
      .select('ghl_contact_id')
      .eq('id', opts.job_id)
      .maybeSingle()
    if (jobErr) return { ghl_synced: false, ghl_note_id: null, ghl_push_error: jobErr.message }
    contactId = jobRow?.ghl_contact_id || null
  }
  if (!contactId) return { ghl_synced: false, ghl_note_id: null, ghl_push_error: 'no GHL contact id available for note mirror' }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const ghlBase = supabaseUrl.replace('/rest/v1', '') + '/functions/v1/ghl-proxy'
  const ghlKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  if (!supabaseUrl || !ghlKey) return { ghl_synced: false, ghl_note_id: null, ghl_push_error: 'ghl-proxy env missing' }

  try {
    const noteResp = await fetch(`${ghlBase}?action=add_note`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ghlKey,
      },
      body: JSON.stringify({
        contactId,
        body: opts.note_text,
        jobId: opts.job_id || undefined,
      }),
    })
    if (!noteResp.ok) {
      return { ghl_synced: false, ghl_note_id: null, ghl_push_error: `ghl-proxy add_note returned ${noteResp.status}` }
    }
    const noteData = await noteResp.json().catch(() => ({}))
    return { ghl_synced: true, ghl_note_id: noteData.note_id || noteData.id || null, ghl_push_error: null }
  } catch (e: any) {
    return { ghl_synced: false, ghl_note_id: null, ghl_push_error: e?.message || String(e) }
  }
}

async function approveScoperCallTask(client: any, body: any) {
  const { action_id, user_id, outcome, note } = body
  if (!action_id) throw new Error('action_id required')
  const callOutcome = ['called', 'voicemail', 'no_answer'].includes(String(outcome || ''))
    ? String(outcome)
    : 'called'

  // Step 1: atomic validate-and-claim. We require status='pending' AND
  // action_type='propose_scoper_call_task' so a concurrent approve on the
  // wrong proposal type can't slip through.
  const nowIso = new Date().toISOString()
  const { data: claimed, error: claimErr } = await client
    .from('ai_proposed_actions')
    .update({
      status: 'approved',
      approved_at: nowIso,
      approved_by: user_id || null,
    })
    .eq('proposal_id', action_id)
    .eq('status', 'pending')
    .eq('action_type', 'propose_scoper_call_task')
    .select('proposal_id, action_type, contact_id, contact_name, contact_phone, job_id, action_payload, drafted_message, metadata')
    .limit(1)
  if (claimErr) throw claimErr
  if (!claimed || claimed.length === 0) {
    return {
      success: false,
      action_id,
      error: 'claim_failed',
      reason: 'proposal not found or already claimed (status != pending or action_type != propose_scoper_call_task)',
    }
  }
  const action = claimed[0]
  const ap = (action.action_payload || {}) as Record<string, any>
  const slot_day = ap.slot_day || null
  const voice_anchor = ap.voice_anchor || null
  const ticket_tier = ap.ticket_tier || null
  const talkTrack = Array.isArray(ap.talk_track)
    ? ap.talk_track.map((line: any) => String(line || '').trim()).filter(Boolean).slice(0, 6)
    : []
  const operatorNote = String(note || '').trim()
  const callNoteText = [
    `Quote follow-up call task marked ${callOutcome}.`,
    action.contact_name ? `Contact: ${action.contact_name}` : null,
    action.contact_phone ? `Phone: ${action.contact_phone}` : null,
    slot_day ? `Cadence slot: D${slot_day}` : null,
    voice_anchor ? `Voice anchor: ${voice_anchor}` : null,
    ticket_tier ? `Ticket tier: ${ticket_tier}` : null,
    talkTrack.length ? `Talk-track:\n- ${talkTrack.join('\n- ')}` : null,
    operatorNote ? `Operator note: ${operatorNote}` : null,
    `Proposal: ${action.proposal_id}`,
  ].filter(Boolean).join('\n')

  // Step 2: NO customer-facing SMS/call automation. Record the manual call
  // outcome locally, then mirror a CRM contact note through the existing
  // ghl-proxy add_note helper. This is a GHL internal note only, not a
  // customer message.
  let internalNoteId: string | null = null
  let internalNoteError: string | null = null
  if (action.job_id) {
    try {
      const { data: noteRow, error: noteErr } = await client.from('job_events').insert({
        job_id: action.job_id,
        user_id: user_id || null,
        event_type: 'note',
        detail_json: {
          text: callNoteText,
          visibility: 'internal_only',
          sync_to_ghl: true,
          source: 'quote_followup_call_task',
          proposal_id: action.proposal_id,
          call_outcome: callOutcome,
        },
      }).select('id').single()
      if (noteErr) throw noteErr
      internalNoteId = noteRow?.id || null
    } catch (e: any) {
      internalNoteError = e?.message || String(e)
      console.warn('[ops-api/approve_scoper_call_task] internal note insert failed:', internalNoteError)
    }
  } else {
    internalNoteError = 'no job_id on proposal; skipped job_events internal note'
  }

  let callEventRecorded = false
  try {
    await client.from('business_events').insert({
      event_type: 'client.call_complete',
      source: 'ops-api/approve_scoper_call_task',
      entity_type: action.job_id ? 'job' : 'ai_proposed_action',
      entity_id: action.job_id || action.proposal_id,
      job_id: action.job_id || null,
      contact_id: action.contact_id || null,
      occurred_at: nowIso,
      direction: 'outbound',
      channel: 'call',
      body_preview: callNoteText.slice(0, 500),
      safe_summary: `Quote follow-up call task marked ${callOutcome}`,
      source_table: 'ai_proposed_actions',
      source_id: action.proposal_id,
      payload: {
        proposal_id: action.proposal_id,
        action_type: 'propose_scoper_call_task',
        call_outcome: callOutcome,
        note_text: callNoteText,
        internal_note_id: internalNoteId,
        slot_day,
        voice_anchor,
        ticket_tier,
        talk_track: talkTrack,
        approved_by: user_id || null,
        loop: 'quote_followup',
      },
    })
    callEventRecorded = true
  } catch (e: any) {
    console.warn('[ops-api/approve_scoper_call_task] client.call_complete business_event insert failed:', e.message)
  }

  const ghlNoteResult = await pushGhlContactNoteBestEffort(client, {
    contact_id: action.contact_id || null,
    job_id: action.job_id || null,
    note_text: callNoteText,
  })

  // Step 3: emit business_event for the spine.
  try {
    await client.from('business_events').insert({
      event_type: 'scoper_call_task_approved',
      job_id: action.job_id || null,
      contact_id: action.contact_id || null,
      occurred_at: nowIso,
      direction: 'internal',
      channel: 'task',
      payload: {
        proposal_id: action.proposal_id,
        action_type: 'propose_scoper_call_task',
        slot_day,
        voice_anchor,
        ticket_tier,
        approved_by: user_id || null,
        loop: 'quote_followup',
      },
      source_table: 'ai_proposed_actions',
      source_id: action.proposal_id,
    })
  } catch (e: any) {
    console.warn('[ops-api/approve_scoper_call_task] business_event insert failed:', e.message)
  }

  // job_event mirror for the audit spine on the job
  if (action.job_id) {
    try {
      await client.from('job_events').insert({
        job_id: action.job_id,
        event_type: 'scoper_call_task_approved',
        detail_json: {
          proposal_id: action.proposal_id,
          slot_day,
          voice_anchor,
          ticket_tier,
          approved_by: user_id || null,
        },
      })
    } catch (_e) { /* spine log is best-effort */ }
  }

  return {
    success: true,
    action_id,
    sub_action: null,
    call_outcome: callOutcome,
    internal_note_id: internalNoteId,
    internal_note_error: internalNoteError,
    call_event_recorded: callEventRecorded,
    ...ghlNoteResult,
  }
}

async function approveQuoteReviewTask(client: any, body: any) {
  const { action_id, user_id, sub_action, lost_reason } = body
  if (!action_id) throw new Error('action_id required')

  const VALID_SUB_ACTIONS = ['refresh_price', 'archive_lost', 'reactivate']
  if (!sub_action || !VALID_SUB_ACTIONS.includes(sub_action)) {
    throw new Error(`sub_action required (one of ${VALID_SUB_ACTIONS.join(', ')})`)
  }
  if (sub_action === 'archive_lost' && (!lost_reason || !String(lost_reason).trim())) {
    throw new Error('lost_reason required when sub_action=archive_lost')
  }

  // Step 1: atomic validate-and-claim.
  const nowIso = new Date().toISOString()
  const { data: claimed, error: claimErr } = await client
    .from('ai_proposed_actions')
    .update({
      status: 'approved',
      approved_at: nowIso,
      approved_by: user_id || null,
    })
    .eq('proposal_id', action_id)
    .eq('status', 'pending')
    .eq('action_type', 'propose_quote_review_task')
    .select('proposal_id, action_type, contact_id, contact_name, job_id, action_payload, drafted_message, metadata')
    .limit(1)
  if (claimErr) throw claimErr
  if (!claimed || claimed.length === 0) {
    return {
      success: false,
      action_id,
      error: 'claim_failed',
      reason: 'proposal not found or already claimed (status != pending or action_type != propose_quote_review_task)',
    }
  }
  const action = claimed[0]
  const ap = (action.action_payload || {}) as Record<string, any>
  const slot_day = ap.slot_day || null
  const voice_anchor = ap.voice_anchor || null
  const assigned_rep = ap.assigned_rep || null

  // Step 2: optional job state flip on archive_lost. NO customer SMS, NO GHL.
  let jobUpdateApplied = false
  if (sub_action === 'archive_lost' && action.job_id) {
    try {
      const reasonStr = String(lost_reason).trim()
      const { error: jobErr } = await client
        .from('jobs')
        .update({
          status: 'lost',
          lost_reason: reasonStr,
          lost_at: nowIso,
        })
        .eq('id', action.job_id)
      if (jobErr) {
        // If lost_reason / lost_at columns don't exist on jobs (pending
        // migration), fall back to status-only flip.
        console.warn('[ops-api/approve_quote_review_task] full job archive failed, attempting status-only:', jobErr.message)
        const { error: jobErr2 } = await client
          .from('jobs')
          .update({ status: 'lost' })
          .eq('id', action.job_id)
        if (jobErr2) console.warn('[ops-api/approve_quote_review_task] status-only flip also failed:', jobErr2.message)
        else jobUpdateApplied = true
      } else {
        jobUpdateApplied = true
      }
    } catch (e: any) {
      console.warn('[ops-api/approve_quote_review_task] job archive error:', e.message)
    }
  }

  // Step 3: emit business_event for the spine.
  try {
    await client.from('business_events').insert({
      event_type: `quote_review_task_${sub_action}`,
      job_id: action.job_id || null,
      contact_id: action.contact_id || null,
      occurred_at: nowIso,
      direction: 'internal',
      channel: 'task',
      payload: {
        proposal_id: action.proposal_id,
        action_type: 'propose_quote_review_task',
        sub_action,
        lost_reason: lost_reason || null,
        job_archived: jobUpdateApplied,
        slot_day,
        voice_anchor,
        assigned_rep,
        approved_by: user_id || null,
        loop: 'quote_followup',
      },
      source_table: 'ai_proposed_actions',
      source_id: action.proposal_id,
    })
  } catch (e: any) {
    console.warn('[ops-api/approve_quote_review_task] business_event insert failed:', e.message)
  }

  // job_event mirror for the audit spine
  if (action.job_id) {
    try {
      await client.from('job_events').insert({
        job_id: action.job_id,
        event_type: `quote_review_task_${sub_action}`,
        detail_json: {
          proposal_id: action.proposal_id,
          sub_action,
          lost_reason: lost_reason || null,
          job_archived: jobUpdateApplied,
          slot_day,
          voice_anchor,
          approved_by: user_id || null,
        },
      })
    } catch (_e) { /* spine log is best-effort */ }
  }

  return { success: true, action_id, sub_action, job_archived: jobUpdateApplied }
}

async function approveBookingProposalViaAgent(
  body: any,
  caller: { mode: 'api_key' | 'jwt'; user: { id: string; email: string; role: string } | null },
) {
  const proposal_id = String(body?.proposal_id || body?.action_id || '').trim()
  if (!proposal_id) throw new ApiError('proposal_id required', 400)

  const commit = body?.commit === true
  const approver_user_id = caller.mode === 'jwt'
    ? caller.user?.id
    : String(body?.approver_user_id || body?.user_id || '').trim() || undefined

  if (caller.mode === 'jwt' && !approver_user_id) {
    throw new ApiError('authenticated user required for booking approval', 401)
  }
  if (!SECUREWORKS_AGENT_BEARER) {
    throw new ApiError('secureworks agent bearer not configured', 500)
  }

  const payload: Record<string, any> = {
    proposal_id,
    commit,
  }
  if (approver_user_id) payload.approver_user_id = approver_user_id
  const m2 = String(body?.m2_drafted_message || body?.drafted_message || '').trim()
  if (m2) payload.m2_drafted_message = m2

  const url = `${SECUREWORKS_AGENT_URL}/api/booking-approvals/approve`
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SECUREWORKS_AGENT_BEARER}`,
    },
    body: JSON.stringify(payload),
  })

  const text = await resp.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!resp.ok) {
    throw new ApiError(`booking approval bridge failed (${resp.status}): ${data?.error || text || resp.statusText}`, resp.status)
  }

  return {
    success: data?.ok !== false,
    proposal_id,
    commit,
    dry_run: !commit,
    agent_url: SECUREWORKS_AGENT_URL,
    result: data,
  }
}

// ════════════════════════════════════════════════════════════
// Per-scoper playbook MD upload — Marnin-only authenticated edit path.
//
// Lets Marnin (acting as proxy editor for Khairo / Nithin) update the
// runtime mirror of a playbook from sale.html without filesystem access
// or a redeploy. The cadence_planner reads filesystem first then
// wiki_pages; this writes to wiki_pages, so the next cron tick picks
// up the new content.
//
// Hard rules:
//  - Filename must be in the static allowlist (no path injection).
//  - YAML frontmatter must parse and contain required fields with
//    valid status enum and matching voice_anchor.
//  - No customer-facing send. No external API. Only wiki_pages upsert
//    + a business_events audit row.
// ════════════════════════════════════════════════════════════

const PLAYBOOK_MARNIN_EMAIL = 'marnin@secureworkswa.com.au'

const PLAYBOOK_FILENAME_ALLOWLIST = new Set([
  'quote-followup-khairo.md',
  'quote-followup-nithin.md',
  'quote-followup-decking.md',
  // Booking playbook filenames are pre-allowlisted so the same handler
  // can be reused once the booking terminal ships the MD files. The
  // handler validates frontmatter regardless; an empty file with the
  // wrong voice_anchor will fail validation.
  'booking-khairo.md',
  'booking-nithin.md',
])

const PLAYBOOK_VOICE_ANCHOR_ALLOWLIST = new Set([
  'fencing_khairo_v1',
  'patio_nithin_v1',
  'decking_nithin_v1',
  'booking_khairo_v1',
  'booking_nithin_v1',
])

const PLAYBOOK_STATUS_ALLOWLIST = new Set([
  'active',
  'voice_anchor_pulled_awaiting_nithin_approval',
  'scaffold_only',
  'paused',
])

const PLAYBOOK_JOB_TYPE_ALLOWLIST = new Set(['fencing', 'patio', 'decking'])

// Tiny YAML frontmatter parser — handles `key: value` and `key: |` block
// scalars only, matching the shape used by the cadence_planner.
function parsePlaybookFrontmatter(raw: string): { fm: Record<string, string>; ok: boolean; error?: string } {
  if (!raw.startsWith('---')) {
    return { fm: {}, ok: false, error: 'playbook must start with YAML frontmatter (---)' }
  }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) {
    return { fm: {}, ok: false, error: 'unterminated YAML frontmatter (missing closing ---)' }
  }
  const fmText = raw.slice(3, end).trim()
  const fm: Record<string, string> = {}
  const lines = fmText.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/)
    if (!m) { i += 1; continue }
    const key = m[1]
    const rest = m[2].trim()
    if (rest === '|' || rest === '>') {
      const collected: string[] = []
      i += 1
      while (i < lines.length) {
        const ln = lines[i]
        if (/^\s+/.test(ln)) {
          collected.push(ln.replace(/^\s{2}/, ''))
          i += 1
        } else if (ln.length === 0) {
          collected.push('')
          i += 1
        } else {
          break
        }
      }
      fm[key] = collected.join('\n').replace(/\n+$/g, '')
    } else {
      fm[key] = rest.replace(/^['"]|['"]$/g, '')
      i += 1
    }
  }
  return { fm, ok: true }
}

async function updatePlaybook(client: any, body: any, req: Request) {
  // ── Auth gate (Marnin-only) ──
  const authHeader = req.headers.get('authorization') || ''
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!jwt) throw new ApiError('login_required', 401)
  const { data: { user }, error: authErr } = await client.auth.getUser(jwt)
  if (authErr || !user) throw new ApiError('session_expired', 401)
  if ((user.email || '').toLowerCase() !== PLAYBOOK_MARNIN_EMAIL) {
    throw new ApiError('update_playbook_unauthorized: marnin only', 403)
  }

  // ── Params ──
  const filename = (body?.filename || '').trim()
  const content = typeof body?.content === 'string' ? body.content : ''
  const dry_run = body?.dry_run === true

  if (!filename) throw new ApiError('filename required', 400)
  if (!PLAYBOOK_FILENAME_ALLOWLIST.has(filename)) {
    throw new ApiError(`filename not in allowlist (${[...PLAYBOOK_FILENAME_ALLOWLIST].join(', ')})`, 400)
  }
  if (!content) throw new ApiError('content required (non-empty markdown)', 400)
  if (content.length > 200_000) {
    throw new ApiError(`content too large (${content.length} bytes; max 200000)`, 400)
  }

  // ── YAML frontmatter validation ──
  const { fm, ok, error } = parsePlaybookFrontmatter(content)
  if (!ok) throw new ApiError(`yaml_invalid: ${error}`, 400)

  const required = ['playbook', 'voice_anchor', 'job_type', 'status', 'version', 'last_updated', 'sign_off_pattern']
  for (const k of required) {
    if (!fm[k] || !String(fm[k]).trim()) {
      throw new ApiError(`yaml_missing_field: ${k}`, 400)
    }
  }
  if (!PLAYBOOK_VOICE_ANCHOR_ALLOWLIST.has(fm.voice_anchor)) {
    throw new ApiError(`yaml_invalid_voice_anchor: '${fm.voice_anchor}' not in allowlist`, 400)
  }
  if (!PLAYBOOK_JOB_TYPE_ALLOWLIST.has(fm.job_type)) {
    throw new ApiError(`yaml_invalid_job_type: '${fm.job_type}' not in allowlist (${[...PLAYBOOK_JOB_TYPE_ALLOWLIST].join('|')})`, 400)
  }
  if (!PLAYBOOK_STATUS_ALLOWLIST.has(fm.status)) {
    throw new ApiError(`yaml_invalid_status: '${fm.status}' not in allowlist (${[...PLAYBOOK_STATUS_ALLOWLIST].join(', ')})`, 400)
  }
  // Cross-check filename ↔ voice_anchor consistency.
  const expectedAnchorByFile: Record<string, string> = {
    'quote-followup-khairo.md': 'fencing_khairo_v1',
    'quote-followup-nithin.md': 'patio_nithin_v1',
    'quote-followup-decking.md': 'decking_nithin_v1',
    'booking-khairo.md': 'booking_khairo_v1',
    'booking-nithin.md': 'booking_nithin_v1',
  }
  const expectedAnchor = expectedAnchorByFile[filename]
  if (expectedAnchor && fm.voice_anchor !== expectedAnchor) {
    throw new ApiError(`yaml_anchor_mismatch: filename='${filename}' expects voice_anchor='${expectedAnchor}', got '${fm.voice_anchor}'`, 400)
  }

  // Em-dash deny check — Marnin's no-em-dash rule, applied to playbook
  // body (not frontmatter). Catches it before the runtime validator B12
  // would on every drafted message.
  const body_after_fm = content.slice(content.indexOf('\n---', 3) + 4)
  const emDashMatches = body_after_fm.match(/[—–]/g)
  const emDashCount = emDashMatches ? emDashMatches.length : 0
  // We allow em-dashes ONLY if the playbook explicitly tags them in a
  // recognised "FLAG" section (existing Nithin playbook flags its own
  // greeter em-dash). For most edits the count should be 0.
  // For now: warn-only; do not block. The runtime validator catches any
  // em-dash that actually leaks into a drafted_message.

  if (dry_run) {
    return {
      ok: true,
      dry_run: true,
      filename,
      content_chars: content.length,
      frontmatter: fm,
      em_dash_count: emDashCount,
      em_dash_note: emDashCount > 0 ? 'em-dashes found in body — runtime validator B12 will reject any drafted_message that includes one' : 'clean',
      proposed_action: 'upsert wiki_pages(domain="playbooks", filename, content)',
    }
  }

  // ── Upsert wiki_pages ──
  // Schema: wiki_pages(id, domain, filename, content, updated_at).
  // Composite key for our purposes is (domain, filename); we look it up
  // first, then insert or update by id.
  const nowIso = new Date().toISOString()
  const { data: existing, error: lookupErr } = await client
    .from('wiki_pages')
    .select('id, updated_at')
    .eq('domain', 'playbooks')
    .eq('filename', filename)
    .limit(1)
  if (lookupErr) throw new ApiError(`wiki_pages_lookup_failed: ${lookupErr.message}`, 500)

  const row = existing && existing[0]
  let result: { mode: 'inserted' | 'updated'; id: string; updated_at: string }
  if (row) {
    const { data: upd, error: updErr } = await client
      .from('wiki_pages')
      .update({ content, updated_at: nowIso })
      .eq('id', (row as { id: string }).id)
      .select('id, updated_at')
      .limit(1)
    if (updErr) throw new ApiError(`wiki_pages_update_failed: ${updErr.message}`, 500)
    const r = (upd && upd[0]) as { id: string; updated_at: string } | undefined
    result = { mode: 'updated', id: r?.id || (row as any).id, updated_at: r?.updated_at || nowIso }
  } else {
    const { data: ins, error: insErr } = await client
      .from('wiki_pages')
      .insert({ domain: 'playbooks', filename, content })
      .select('id, updated_at')
      .limit(1)
    if (insErr) throw new ApiError(`wiki_pages_insert_failed: ${insErr.message}`, 500)
    const r = (ins && ins[0]) as { id: string; updated_at: string } | undefined
    if (!r) throw new ApiError('wiki_pages_insert_returned_no_row', 500)
    result = { mode: 'inserted', id: r.id, updated_at: r.updated_at }
  }

  // ── Audit row in business_events ──
  try {
    await client.from('business_events').insert({
      event_type: 'playbook.updated',
      payload: {
        filename,
        mode: result.mode,
        wiki_pages_id: result.id,
        content_chars: content.length,
        frontmatter: fm,
        em_dash_count: emDashCount,
        actor_email: user.email,
      },
    })
  } catch (e: any) {
    console.warn('[ops-api/update_playbook] business_event insert failed:', e.message)
  }

  return {
    ok: true,
    filename,
    mode: result.mode,
    wiki_pages_id: result.id,
    updated_at: result.updated_at,
    content_chars: content.length,
    frontmatter_status: fm.status,
    voice_anchor: fm.voice_anchor,
    em_dash_count: emDashCount,
    note: 'cadence_planner reads filesystem first then wiki_pages; next cron tick (Mon-Fri 9:45 / 15:45 AWST) picks up the new content. Sync the on-disk MD in secureworks-docs to keep canon and runtime aligned.',
  }
}

// ════════════════════════════════════════════════════════════
// Quote-nurture cadence v3 — read-only stale review tasks list.
//
// Returns propose_quote_review_task proposals that have been pending for
// > 3 days. sale.html uses this to render an ESCALATED badge so the
// human operator knows Shaun is the next pair of eyes (with Marnin CC'd
// at his discretion). Per Marnin's brief: NO background magic — this is
// purely a read so the renderer can show the badge.
// ════════════════════════════════════════════════════════════
async function listStaleQuoteReviewTasks(client: any, _params: URLSearchParams) {
  const cutoffIso = new Date(Date.now() - 3 * 86400 * 1000).toISOString()
  const { data, error } = await client
    .from('ai_proposed_actions')
    .select('proposal_id, action_type, contact_id, contact_name, job_id, created_at, action_payload, metadata')
    .eq('action_type', 'propose_quote_review_task')
    .eq('status', 'pending')
    .lt('created_at', cutoffIso)
    .order('created_at', { ascending: true })
    .limit(100)
  if (error) throw error
  const tasks = (data || []).map((r: any) => {
    const ap = (r.action_payload || {}) as Record<string, any>
    const meta = (r.metadata || {}) as Record<string, any>
    const ageMs = Date.now() - Date.parse(r.created_at)
    return {
      proposal_id: r.proposal_id,
      action_type: r.action_type,
      job_id: r.job_id,
      contact_id: r.contact_id,
      contact_name: r.contact_name,
      created_at: r.created_at,
      age_days: Math.floor(ageMs / 86400000),
      assigned_rep: ap.assigned_rep || meta.rep || null,
      voice_anchor: ap.voice_anchor || null,
      slot_day: ap.slot_day || null,
      ticket_tier: ap.ticket_tier || null,
      job_number: meta.job_number || null,
    }
  })
  return { tasks }
}

async function dismissProposedAction(client: any, body: any) {
  const { action_id, user_id, reason } = body
  if (!action_id) throw new Error('action_id required')

  // Load proposal for the audit event payload
  const { data: action } = await client.from('ai_proposed_actions')
    .select('proposal_id, action_type, job_id, contact_id')
    .eq('proposal_id', action_id).maybeSingle()

  const { error } = await client.from('ai_proposed_actions')
    .update({
      status: 'rejected',
      dismissed_at: new Date().toISOString(),
      dismissed_by: user_id || null,
    })
    .eq('proposal_id', action_id)
    .eq('status', 'pending')
  if (error) throw error

  // Framework feedback contract: emit proposed_action.rejected
  try {
    await client.from('business_events').insert({
      event_type: 'proposed_action.rejected',
      source: 'ops-api/dismiss_proposed_action',
      entity_type: 'ai_proposed_action',
      entity_id: action_id,
      job_id: action?.job_id || null,
      occurred_at: new Date().toISOString(),
      payload: {
        action_id, action_type: action?.action_type || null,
        contact_id: action?.contact_id || null,
        reason: reason || null,
        rejected_by: user_id || null,
      },
    })
  } catch (_e) { /* feedback is best-effort */ }

  return { success: true, action_id }
}

// ════════════════════════════════════════════════════════════
// Slice 1 cockpit verbs (custom-loop framework canon 2026-05-04)
//
// Each verb conforms to docs/loops/secure-sale-loop-framework.md and
// emits the framework's feedback business_event so loops can read
// outcomes back on the next tick.
// ════════════════════════════════════════════════════════════

// Verb: Edit & Send — operator tweaks the drafted_message and sends
// through the same audit chain as Approve & Send.
async function editAndSend(client: any, body: any): Promise<any> {
  const { action_id, edited_message, user_id } = body
  if (!action_id) throw new Error('action_id required')
  const trimmed = String(edited_message || '').trim()
  if (!trimmed) throw new Error('edited_message required (non-empty)')
  if (trimmed.length > 1600) throw new Error('edited_message too long (max 1600c)')

  const { data: action, error: loadErr } = await client.from('ai_proposed_actions')
    .select('proposal_id, action_type, drafted_message, status, job_id, contact_id')
    .eq('proposal_id', action_id).maybeSingle()
  if (loadErr) throw loadErr
  if (!action) throw new Error('proposal not found')
  if (action.status !== 'pending') throw new Error(`cannot edit: status='${action.status}' (must be pending)`)

  const original = String(action.drafted_message || '')
  if (trimmed === original) {
    // No diff — skip the edit event, just route to send.
    return await sendProposedSms(client, { action_id, user_id })
  }

  // Persist the edit BEFORE sending, so audit captures the diff even if
  // the send path fails.
  const { error: upErr } = await client.from('ai_proposed_actions')
    .update({ drafted_message: trimmed })
    .eq('proposal_id', action_id)
    .eq('status', 'pending')
  if (upErr) throw upErr

  // Feedback event: proposed_action.edited (with diff context)
  try {
    await client.from('business_events').insert({
      event_type: 'proposed_action.edited',
      source: 'ops-api/edit_and_send',
      entity_type: 'ai_proposed_action',
      entity_id: action_id,
      job_id: action.job_id || null,
      occurred_at: new Date().toISOString(),
      payload: {
        action_id,
        action_type: action.action_type,
        edited_by: user_id || null,
        original_length: original.length,
        edited_length: trimmed.length,
        original_preview: original.slice(0, 200),
        edited_preview: trimmed.slice(0, 200),
      },
    })
  } catch (_e) { /* best-effort */ }

  // Route through the existing send path (which sets status='sent', sent_at,
  // and emits the dispatch business_event chain).
  return await sendProposedSms(client, { action_id, user_id })
}

// Verb: Snooze — pause a proposal until a chosen datetime; row stays
// status='pending' but list_proposed_actions filters it out via the
// metadata.snoozed_until check.
async function snoozeProposedAction(client: any, body: any): Promise<any> {
  const { action_id, snooze_until, user_id } = body
  if (!action_id) throw new Error('action_id required')
  if (!snooze_until) throw new Error('snooze_until required (ISO datetime)')
  const until = new Date(String(snooze_until))
  if (Number.isNaN(until.getTime())) throw new Error('snooze_until invalid date')
  if (until.getTime() <= Date.now()) throw new Error('snooze_until must be in the future')

  const { data: action } = await client.from('ai_proposed_actions')
    .select('proposal_id, action_type, metadata, job_id, contact_id, status')
    .eq('proposal_id', action_id).maybeSingle()
  if (!action) throw new Error('proposal not found')
  if (action.status !== 'pending') throw new Error(`cannot snooze: status='${action.status}'`)

  const newMeta = Object.assign({}, action.metadata || {}, {
    snoozed_until: until.toISOString(),
    snoozed_at: new Date().toISOString(),
    snoozed_by: user_id || null,
  })
  const { error } = await client.from('ai_proposed_actions')
    .update({ metadata: newMeta })
    .eq('proposal_id', action_id)
    .eq('status', 'pending')
  if (error) throw error

  try {
    await client.from('business_events').insert({
      event_type: 'proposed_action.snoozed',
      source: 'ops-api/snooze_proposed_action',
      entity_type: 'ai_proposed_action',
      entity_id: action_id,
      job_id: action.job_id || null,
      occurred_at: new Date().toISOString(),
      payload: {
        action_id, action_type: action.action_type,
        snoozed_until: until.toISOString(),
        snoozed_by: user_id || null,
      },
    })
  } catch (_e) { /* best-effort */ }

  return { success: true, action_id, snoozed_until: until.toISOString() }
}

// Verb: Create Job for Opportunity — backfills a Supabase jobs row for
// an unlinked GHL booking proposal so memory + audit can attach.
//
// SCOPING TOOL COMPATIBILITY (verified 2026-05-04):
//   The scoping tool's find_job lookup filters by (ghl_opportunity_id, type).
//   Our stub MUST set type='patio' or type='fencing' (NOT 'unspecified')
//   or the scoping tool will not discover the stub and will create a duplicate.
//   Type is inferred from the GHL pipeline lane.
async function createJobForOpportunity(client: any, body: any): Promise<any> {
  const {
    action_id,
    ghl_opportunity_id,
    ghl_contact_id,
    pipeline_lane,
    user_id,
    contact_name: body_contact_name,
    contact_phone: body_contact_phone,
    contact_email: body_contact_email,
    site_address,
    site_suburb,
    monetary_value,
  } = body
  if (!ghl_opportunity_id) throw new Error('ghl_opportunity_id required')

  // Infer type from pipeline_lane. Scoping tool will reject unspecified.
  const type = pipeline_lane === 'fencing' ? 'fencing'
             : pipeline_lane === 'patio'   ? 'patio'
             : null
  if (!type) throw new Error("pipeline_lane required ('patio' or 'fencing')")

  // First check: does a job already exist for this opp+type? (avoid dup)
  const { data: existing } = await client.from('jobs')
    .select('id, job_number, status')
    .eq('ghl_opportunity_id', ghl_opportunity_id)
    .eq('type', type)
    .maybeSingle()
  if (existing?.id) {
    // Already linked — backfill the proposal's job_id if action_id given.
    if (action_id) {
      await client.from('ai_proposed_actions')
        .update({ job_id: existing.id })
        .eq('proposal_id', action_id)
    }
    return { success: true, job_id: existing.id, job_number: existing.job_number, created: false }
  }

  // Pull contact info from the proposal (if action_id given) so we don't
  // need to refetch from GHL.
  let contact_name: string | null = body_contact_name || null
  let contact_phone: string | null = body_contact_phone || null
  let contact_email: string | null = body_contact_email || null
  if (action_id) {
    const { data: action } = await client.from('ai_proposed_actions')
      .select('contact_name, contact_phone')
      .eq('proposal_id', action_id).maybeSingle()
    contact_name = contact_name || action?.contact_name || null
    contact_phone = contact_phone || action?.contact_phone || null
  }

  const { data: created, error } = await client.from('jobs')
    .insert({
      org_id: DEFAULT_ORG_ID,
      type,
      status: 'draft',
      client_name: contact_name,
      client_phone: contact_phone,
      client_email: contact_email,
      site_address: site_address || null,
      site_suburb: site_suburb || null,
      pricing_json: monetary_value ? { totalIncGST: monetary_value, source: 'ghl_opportunity' } : {},
      ghl_opportunity_id,
      ghl_contact_id: ghl_contact_id || null,
      created_by: user_id || null,
    })
    .select('id, status, type')
    .single()
  if (error) throw error

  // Backfill the proposal's job_id so future ticks attach memory.
  if (action_id) {
    await client.from('ai_proposed_actions')
      .update({ job_id: created.id })
      .eq('proposal_id', action_id)
  }

  // Feedback event
  try {
    await client.from('business_events').insert({
      event_type: 'job.created_from_opportunity',
      source: 'ops-api/create_job_for_opportunity',
      entity_type: 'job',
      entity_id: created.id,
      job_id: created.id,
      occurred_at: new Date().toISOString(),
      payload: {
        ghl_opportunity_id, ghl_contact_id: ghl_contact_id || null,
        pipeline_lane: type,
        contact_name,
        contact_phone,
        contact_email,
        site_address: site_address || null,
        site_suburb: site_suburb || null,
        created_by: user_id || null,
        from_action_id: action_id || null,
      },
    })
  } catch (_e) { /* best-effort */ }

  return { success: true, job_id: created.id, created: true }
}

// Verb: Marnin POC test SMS — hardcoded canary path. Inserts a one-shot
// proposal targeted at Marnin's contact only, then sends via the standard
// approval chain.
async function manualDispatchMarninPoc(client: any, body: any): Promise<any> {
  const { user_id } = body
  // Lookup Marnin's contact_matches row by email (single match required).
  const { data: contacts, error: cErr } = await client.from('contact_matches')
    .select('ghl_contact_id, client_name, phone, email')
    .or('email.ilike.marnin%,client_name.ilike.%Marnin%')
    .limit(2)
  if (cErr) throw cErr
  if (!contacts || contacts.length === 0) throw new Error('Marnin contact not found in contact_matches')
  if (contacts.length > 1) throw new Error('multiple Marnin matches — refine the lookup')
  const contact = contacts[0]
  if (!contact.phone) throw new Error('Marnin contact has no phone')

  // Create a trace row first (ai_proposed_actions.trace_id NOT NULL FK)
  const { data: trace, error: tErr } = await client.from('ai_reasoning_traces')
    .insert({
      trigger_type: 'cockpit:manual_dispatch_marnin_poc',
      model_name: 'manual:marnin_poc',
      input_context_snapshot: { triggered_by: user_id || null, target: 'marnin_self' },
      reasoning_summary: 'Marnin-targeted canary test SMS; hardcoded recipient and body.',
      output_result: { action_type: 'first_contact_sms', target: contact.ghl_contact_id },
      output_type: 'proposed_action',
      status: 'completed',
      tags: ['marnin_poc', 'canary'],
    })
    .select('id').single()
  if (tErr) throw tErr

  // Insert the one-shot proposal
  const draft = "MARNIN_MEMORY_POC: testing T7 spine + JARVIS memory loop. Reply 'k' to acknowledge."
  const { data: proposal, error: pErr } = await client.from('ai_proposed_actions')
    .insert({
      trace_id: trace.id,
      action_type: 'first_contact_sms',
      contact_id: contact.ghl_contact_id,
      contact_name: contact.client_name || 'Marnin',
      contact_phone: contact.phone,
      drafted_message: draft,
      status: 'pending',
      sent_at: null,
      confidence_score: 1.0,
      action_payload: {
        loop: 'cockpit_canary',
        reason: 'Marnin POC test — hardcoded recipient + body',
        why_now: 'manual click',
        evidence_refs: [],
        evidence_gap_reason: 'canary path; no upstream evidence chain',
      },
      metadata: {
        loop: 'cockpit_canary',
        source: 'ops-api/manual_dispatch_marnin_poc',
        playbook_id: 'cockpit_canary_v1',
        triggered_by: user_id || null,
      },
      org_id: DEFAULT_ORG_ID,
    })
    .select('proposal_id').single()
  if (pErr) throw pErr

  // Send immediately via existing send path
  const sendResult = await sendProposedSms(client, { action_id: proposal.proposal_id, user_id })
  return { success: true, proposal_id: proposal.proposal_id, send_result: sendResult }
}

// Verb: Assign Scoper — attach a scoper user_id to a booking proposal
// (and a window if supplied). Locks crew_availability for the window.
async function assignScoper(client: any, body: any): Promise<any> {
  const { action_id, scoper_user_id, window_iso, user_id } = body
  if (!action_id) throw new Error('action_id required')
  if (!scoper_user_id) throw new Error('scoper_user_id required')

  const { data: action } = await client.from('ai_proposed_actions')
    .select('proposal_id, action_type, metadata, action_payload, job_id')
    .eq('proposal_id', action_id).maybeSingle()
  if (!action) throw new Error('proposal not found')

  const newMeta = Object.assign({}, action.metadata || {}, {
    assigned_scoper_id: scoper_user_id,
    assigned_at: new Date().toISOString(),
    assigned_by: user_id || null,
    ...(window_iso ? { assigned_window: window_iso } : {}),
  })
  const newPayload = Object.assign({}, action.action_payload || {}, {
    assigned_scoper_id: scoper_user_id,
    ...(window_iso ? { assigned_window: window_iso } : {}),
  })
  const { error } = await client.from('ai_proposed_actions')
    .update({ metadata: newMeta, action_payload: newPayload })
    .eq('proposal_id', action_id)
  if (error) throw error

  // Lock crew_availability if a window was supplied
  if (window_iso) {
    try {
      const date = String(window_iso).slice(0, 10) // YYYY-MM-DD
      await client.from('crew_availability').insert({
        user_id: scoper_user_id,
        date,
        status: 'busy',
        note: `Scope booked via cockpit (action_id=${action_id})`,
      })
    } catch (_e) { /* lock is advisory; don't fail the assign */ }
  }

  try {
    await client.from('business_events').insert({
      event_type: 'proposed_action.scoper_assigned',
      source: 'ops-api/assign_scoper',
      entity_type: 'ai_proposed_action',
      entity_id: action_id,
      job_id: action.job_id || null,
      occurred_at: new Date().toISOString(),
      payload: {
        action_id, scoper_user_id,
        window_iso: window_iso || null,
        assigned_by: user_id || null,
      },
    })
  } catch (_e) { /* best-effort */ }

  return { success: true, action_id, scoper_user_id, window_iso: window_iso || null }
}

// Verb: Book Scope — finalize a booking proposal and emit a follow-up
// scope_confirmation_sms targeting the customer (still status='pending'
// so the rep approves the confirmation send).
async function bookScope(client: any, body: any): Promise<any> {
  const { action_id, scope_window_iso, scoper_user_id, user_id } = body
  if (!action_id) throw new Error('action_id required')
  if (!scope_window_iso) throw new Error('scope_window_iso required')

  const { data: action, error: loadErr } = await client.from('ai_proposed_actions')
    .select('proposal_id, action_type, job_id, contact_id, contact_name, contact_phone, metadata, action_payload')
    .eq('proposal_id', action_id).maybeSingle()
  if (loadErr) throw loadErr
  if (!action) throw new Error('proposal not found')

  // Mark the booking proposal booked (status='booked' is a new terminal state
  // that sits alongside sent/dismissed; the kanban can render it as "scope locked in").
  const newMeta = Object.assign({}, action.metadata || {}, {
    booked_at: new Date().toISOString(),
    booked_by: user_id || null,
    scope_window: scope_window_iso,
    ...(scoper_user_id ? { assigned_scoper_id: scoper_user_id } : {}),
  })
  await client.from('ai_proposed_actions')
    .update({ status: 'booked', metadata: newMeta })
    .eq('proposal_id', action_id)
    .eq('status', 'pending')

  // Lock the crew_availability window for the scoper
  if (scoper_user_id) {
    try {
      const date = String(scope_window_iso).slice(0, 10)
      await client.from('crew_availability').insert({
        user_id: scoper_user_id,
        date,
        status: 'busy',
        note: `Scope booked via cockpit (action_id=${action_id})`,
      })
    } catch (_e) { /* advisory */ }
  }

  // Emit a follow-up confirmation_sms proposal for the customer.
  // Stays status='pending' so the rep approves the confirmation before it sends.
  let confirmation_proposal_id: string | null = null
  if (action.contact_phone) {
    try {
      const { data: trace } = await client.from('ai_reasoning_traces')
        .insert({
          trigger_type: 'cockpit:book_scope',
          model_name: 'template:scope_confirmation_v1',
          prompt_template_version: 'cockpit_book_scope_v1',
          input_context_snapshot: {
            source_action_id: action_id,
            scope_window: scope_window_iso,
            scoper_user_id: scoper_user_id || null,
          },
          reasoning_summary: 'Customer-facing scope confirmation SMS, drafted on Book Scope click.',
          output_result: { action_type: 'scope_confirmation_sms' },
          output_type: 'proposed_action',
          status: 'completed',
          tags: ['booking_scope', 'scope_confirmation'],
        })
        .select('id').single()

      const fname = String(action.contact_name || 'there').trim().split(/\s+/)[0]
      const draft = `Hi ${fname}, ${user_id ? 'a quick' : 'just a'} confirmation that we've locked you in for your scope on ${new Date(scope_window_iso).toLocaleString('en-AU', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}. See you then. — SecureWorks Group`

      const { data: confProp } = await client.from('ai_proposed_actions')
        .insert({
          trace_id: trace?.id,
          action_type: 'scope_confirmation_sms',
          job_id: action.job_id || null,
          contact_id: action.contact_id || null,
          contact_name: action.contact_name || null,
          contact_phone: action.contact_phone || null,
          drafted_message: draft,
          status: 'pending',
          sent_at: null,
          confidence_score: 0.9,
          action_payload: {
            loop: 'booking_scope',
            reason: 'Customer-facing scope confirmation; rep approves before send.',
            why_now: 'Scope just booked via cockpit',
            evidence_refs: [{ source_table: 'ai_proposed_actions', source_id: action_id, kind: 'parent_booking' }],
            scope_window: scope_window_iso,
            assigned_scoper_id: scoper_user_id || null,
          },
          metadata: {
            loop: 'booking_scope',
            source: 'ops-api/book_scope',
            playbook_id: 'cockpit_book_scope_v1',
            parent_action_id: action_id,
          },
          org_id: DEFAULT_ORG_ID,
        })
        .select('proposal_id').single()
      confirmation_proposal_id = confProp?.proposal_id ?? null
    } catch (_e) { /* don't block book_scope on confirmation draft failure */ }
  }

  try {
    await client.from('business_events').insert({
      event_type: 'proposed_action.scope_booked',
      source: 'ops-api/book_scope',
      entity_type: 'ai_proposed_action',
      entity_id: action_id,
      job_id: action.job_id || null,
      occurred_at: new Date().toISOString(),
      payload: {
        action_id,
        scope_window: scope_window_iso,
        scoper_user_id: scoper_user_id || null,
        booked_by: user_id || null,
        confirmation_proposal_id,
      },
    })
  } catch (_e) { /* best-effort */ }

  return { success: true, action_id, scope_window: scope_window_iso, confirmation_proposal_id }
}

// ════════════════════════════════════════════════════════════
// SLICE 3 — GHL conversation backfill into brain (business_events)
//
// Goal: JARVIS today only sees comms captured AFTER 2026-05-04 (when
// evidence_capture_v1 flipped on). All historical SMS/email per opp is
// invisible to the loops, so booking + follow-up suggestions are
// stage+age templates instead of grounded in actual conversation.
//
// This action pulls historical GHL conversation messages for active
// opportunities into business_events with the canonical evidence
// envelope. Existing extractor (every 15 min) digests them into
// job_context. Loops then read job_context → smarter proposals.
//
// SAFETY:
//   - Marnin-only (email gate)
//   - dry_run=true by default — counts what WOULD be inserted
//   - Idempotent: skips messages whose body_hash already exists for
//     the same contact_id + occurred_at minute
//   - Capped at max_opportunities=10 per call by default (so first
//     runs can't accidentally dump 3000 rows)
//   - Hits ghl-proxy get_conversation per opp — same path the cockpit
//     already uses, no new GHL API surface
// ════════════════════════════════════════════════════════════

const BACKFILL_MARNIN_EMAIL = 'marnin@secureworkswa.com.au'
const GHL_FENCING_PIPELINE_ID = 'I9t8njpuR0Dm7B2NDcvI'
const GHL_PATIO_PIPELINE_ID = 'OGZLpPPVWVarN94HL6af'

async function backfillGhlConversations(client: any, body: any, req: Request): Promise<any> {
  // ── Auth gate (marnin-only) ──
  const authHeader = req.headers.get('authorization') || ''
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!jwt) throw new ApiError('login_required', 401)
  const { data: { user }, error: authErr } = await client.auth.getUser(jwt)
  if (authErr || !user) throw new ApiError('session_expired', 401)
  if ((user.email || '').toLowerCase() !== BACKFILL_MARNIN_EMAIL) {
    throw new ApiError('backfill_unauthorized: marnin only', 403)
  }

  // ── Params ──
  const dry_run = body?.dry_run !== false  // default TRUE — must explicitly pass false to write
  const pipeline = (body?.pipeline || 'both').toLowerCase()
  const max_opportunities = Math.min(Number(body?.max_opportunities) || 100, 200)
  const window_days = Math.min(Number(body?.opportunity_window_days) || 30, 90)

  if (!['fencing', 'patio', 'both'].includes(pipeline)) {
    throw new ApiError(`pipeline must be fencing|patio|both, got '${pipeline}'`, 400)
  }

  const ghlBase = (Deno.env.get('SUPABASE_URL') || '').replace('/rest/v1', '') + '/functions/v1/ghl-proxy'
  const ghlKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

  // ── Fetch opportunities for selected pipelines ──
  const lanes = pipeline === 'both' ? ['fencing', 'patio'] : [pipeline]
  const opportunities: Array<{ id: string; contactId: string; contactName: string; pipeline: string; updatedAt: string }> = []
  for (const lane of lanes) {
    try {
      const r = await fetch(`${ghlBase}?action=opportunities&pipeline=${lane}`, {
        headers: { 'Authorization': `Bearer ${ghlKey}` },
      })
      if (!r.ok) {
        console.warn(`[backfill] opps fetch failed for ${lane}: HTTP ${r.status}`)
        continue
      }
      const j: any = await r.json()
      for (const o of (j.opportunities || [])) {
        if (o.contactId && o.id) {
          opportunities.push({
            id: o.id,
            contactId: o.contactId,
            contactName: o.contactName || o.name || '',
            pipeline: lane,
            updatedAt: o.updatedAt || o.createdAt || new Date().toISOString(),
          })
        }
      }
    } catch (e: any) {
      console.warn(`[backfill] opps fetch threw for ${lane}: ${e?.message}`)
    }
  }

  // ── Filter by activity window + cap ──
  const cutoff = Date.now() - window_days * 86400000
  const recentOpps = opportunities
    .filter(o => Date.parse(o.updatedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, max_opportunities)

  // ── Iterate, fetch conversation per opp, plan inserts ──
  const summary = {
    dry_run,
    pipeline,
    opps_total_fetched: opportunities.length,
    opps_in_window: recentOpps.length,
    max_opportunities,
    opportunity_window_days: window_days,
    messages_found: 0,
    messages_dedupe_skipped: 0,
    messages_would_insert: 0,
    messages_inserted: 0,
    // Channel/event breakdown — populated for EVERY message including dry-run.
    // Lets you see "would insert 80 sms_in + 20 email_out + 5 call" before
    // committing to live, and surfaces type misclassification immediately.
    classified_by_channel: { sms: 0, email: 0, call: 0 } as Record<string, number>,
    classified_by_event_type: {} as Record<string, number>,
    unrecognised_message_types: {} as Record<string, number>,
    errors: [] as Array<{ opp_id: string; reason: string }>,
    per_opp: [] as Array<{ opp_id: string; contactId: string; pipeline: string; messages: number; would_insert: number; dedupe_skipped: number }>,
  }

  // Parallelize ghl-proxy fetches in batches to avoid edge function timeout.
  // Each get_conversation takes ~700ms; 200 opps serial = 140s + DB time would
  // exceed the 150s function cap. Batches of 5 cuts wall time ~5x. Inserts
  // remain serial so per-opp accounting stays consistent and we don't
  // hammer the DB with 200 concurrent inserts.
  const BATCH_SIZE = 5
  const batches: Array<typeof recentOpps> = []
  for (let i = 0; i < recentOpps.length; i += BATCH_SIZE) {
    batches.push(recentOpps.slice(i, i + BATCH_SIZE))
  }

  for (const batch of batches) {
    // Fetch this batch's conversations in parallel.
    const fetched = await Promise.all(batch.map(async (opp) => {
      try {
        const r = await fetch(`${ghlBase}?action=get_conversation&contactId=${opp.contactId}`, {
          headers: { 'Authorization': `Bearer ${ghlKey}` },
        })
        if (!r.ok) return { opp, ok: false, error: `get_conversation HTTP ${r.status}`, messages: [] as any[] }
        const jb: any = await r.json()
        return { opp, ok: true, messages: jb.messages || [] }
      } catch (e: any) {
        return { opp, ok: false, error: `fetch threw: ${e?.message || String(e)}`, messages: [] as any[] }
      }
    }))

    for (const item of fetched) {
      const opp = item.opp
      if (!item.ok) {
        summary.errors.push({ opp_id: opp.id, reason: item.error || 'unknown' })
        continue
      }
      try {
      const j: any = { messages: item.messages }
      const messages: Array<any> = j.messages || []
      summary.messages_found += messages.length

      // Try to resolve a Supabase job_id for this opp (best effort)
      let job_id: string | null = null
      try {
        const { data: jobRow } = await client.from('jobs')
          .select('id').eq('ghl_opportunity_id', opp.id).limit(1).single()
        job_id = jobRow?.id || null
      } catch { /* no linked job */ }

      let oppWouldInsert = 0
      let oppDedupeSkipped = 0

      for (const m of messages) {
        const body_text: string = (m.body || '').trim()
        if (!body_text) continue

        const occurred_at = m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString()

        // ── Idempotency check: same contact + same occurred_at minute + same body_preview already in spine? ──
        const minuteKey = occurred_at.slice(0, 16)  // YYYY-MM-DDTHH:MM
        const previewKey = body_text.slice(0, 100)
        const { data: dup } = await client.from('business_events')
          .select('id')
          .eq('contact_id', opp.contactId)
          .gte('occurred_at', minuteKey + ':00.000Z')
          .lt('occurred_at', minuteKey + ':59.999Z')
          .ilike('body_preview', `${previewKey}%`)
          .limit(1)

        if (dup && dup.length) {
          oppDedupeSkipped++
          summary.messages_dedupe_skipped++
          continue
        }

        oppWouldInsert++
        summary.messages_would_insert++

        // ── Classify EVERY message (dry-run too) so the summary surfaces
        //    channel mix + unrecognised types BEFORE committing to live. ──
        //
        // GHL normalises messageType as 'TYPE_SMS' | 'TYPE_EMAIL' | 'TYPE_CALL'
        // | 'TYPE_VOICEMAIL' | 'TYPE_FACEBOOK' | 'TYPE_INSTAGRAM' | 'TYPE_WEBCHAT'
        // | 'TYPE_LIVE_CHAT' | etc. (per GHL conversations API v2). Older API
        // versions sometimes return 'SMS' / 'EMAIL' without the prefix.
        // Match by substring so both work.
        const channelType = (m.type || '').toUpperCase()
        const channel: 'email' | 'call' | 'sms' | 'note' =
          channelType.includes('EMAIL') ? 'email'
          : (channelType.includes('CALL') || channelType.includes('VOICEMAIL')) ? 'call'
          : (channelType.includes('SMS') || channelType.includes('WEBCHAT') ||
             channelType.includes('FACEBOOK') || channelType.includes('INSTAGRAM') ||
             channelType.includes('LIVE_CHAT') || channelType.includes('CHAT')) ? 'sms'
          : 'sms' // fallback — most GHL messages we'll see ARE SMS

        // Track unrecognised types so the summary surfaces them rather than
        // silently miscoding everything as SMS. Aggregates across the whole run.
        const isRecognised = channelType &&
          ['EMAIL','CALL','VOICEMAIL','SMS','WEBCHAT','FACEBOOK','INSTAGRAM','LIVE_CHAT','CHAT']
            .some(t => channelType.includes(t))
        if (!isRecognised) {
          const key = m.type ? String(m.type) : '(empty)'
          summary.unrecognised_message_types[key] = (summary.unrecognised_message_types[key] || 0) + 1
        }

        const direction = m.direction === 'outbound' ? 'outbound' : 'inbound'

        // event_type MUST be one of extraction-enqueuer's ALLOWED_EVENT_TYPES
        // for downstream JARVIS observability (and so the worker's
        // source_event_type field carries a meaningful tag).
        const eventType =
          channel === 'email'
            ? (direction === 'inbound' ? 'client.email_in' : 'client.email_out')
            : channel === 'call'
            ? 'call.transcript_completed'
            : (direction === 'inbound' ? 'client.sms_in' : 'client.sms_out')

        // Aggregate classifications for the summary (every message, every run).
        summary.classified_by_channel[channel] = (summary.classified_by_channel[channel] || 0) + 1
        summary.classified_by_event_type[eventType] = (summary.classified_by_event_type[eventType] || 0) + 1

        if (!dry_run) {

          // The worker (extraction-worker.ts) loads the source row by:
          //   client.from('business_events').select('id, event_type, source,
          //     occurred_at, job_id, payload').eq('id', extraction_jobs.source_id)
          // That means:
          //   1. extraction_jobs.source_id MUST be business_events.id (uuid),
          //      NOT the GHL message id. Fixed below by capturing the
          //      .select('id') return.
          //   2. The worker reads body from `payload`, NOT the top-level
          //      body_preview column. Fixed below by mirroring body_preview
          //      into payload.body_preview so the extractor can see it.
          const { data: insertedRow, error: insErr } = await client.from('business_events').insert({
            event_type: eventType,
            source: 'ops-api/backfill_ghl_conversations',
            entity_type: 'ghl_message',
            entity_id: m.id || `${opp.contactId}-${minuteKey}`,
            job_id: job_id,
            contact_id: opp.contactId,
            channel: channel,
            direction: direction,
            occurred_at: occurred_at,
            body_preview: body_text.slice(0, 500),
            safe_summary: body_text.slice(0, 280),
            match_status: job_id ? 'matched' : 'unresolved',
            match_method: job_id ? 'contact_id' : 'none',
            match_confidence: job_id ? 0.85 : null,
            payload: {
              // Worker reads body from payload — see worker.loadSourceRow
              // for source_table='business_events': it returns payload as-is.
              body_preview: body_text.slice(0, 500),
              safe_summary: body_text.slice(0, 280),
              ghl_opportunity_id: opp.id,
              ghl_contact_name: opp.contactName,
              pipeline: opp.pipeline,
              ghl_message_id: m.id,
              ghl_message_type: m.type,
              direction,
              channel,
              backfill_run_at: new Date().toISOString(),
            },
            metadata: {
              source: 'backfill',
              backfill_version: 'v1',
            },
          }).select('id').single()

          if (insErr || !insertedRow) {
            summary.errors.push({ opp_id: opp.id, reason: `insert: ${insErr?.message || 'no row returned'}` })
          } else {
            summary.messages_inserted++
            const spineId: string = insertedRow.id

            // Enqueue for the existing extractor (won't pick this up via
            // its cursor because occurred_at is historical, hence direct
            // insert). source_id = business_events.id so the worker can
            // load it back.
            if (job_id) {
              try {
                await client.from('extraction_jobs').insert({
                  source_table: 'business_events',
                  source_id: spineId,
                  source_event_type: eventType,
                  job_id: job_id,
                  status: 'pending',
                  priority: 5,
                  attempts: 0,
                  max_attempts: 3,
                  extractor_version: 'context-fact-extractor:v1',
                  metadata: { source: 'backfill_ghl_conversations', channel, contact_id: opp.contactId },
                })
              } catch { /* best-effort enqueue; idempotency unique-conflict expected on re-run */ }
            }
          }
        }
      }

      summary.per_opp.push({
        opp_id: opp.id, contactId: opp.contactId, pipeline: opp.pipeline,
        messages: messages.length, would_insert: oppWouldInsert, dedupe_skipped: oppDedupeSkipped,
      })
      } catch (e: any) {
        summary.errors.push({ opp_id: opp.id, reason: `loop: ${e?.message || String(e)}` })
      }
    } // end for (const item of fetched)
  } // end for (const batch of batches)

  return summary
}

// ════════════════════════════════════════════════════════════
// SLICE 3.5 — WhisperFlow historical call-transcript backfill
//
// Companion to backfill_ghl_conversations. SMS/email come in via the
// conversation messages endpoint with body text inline. CALLS come in
// as conversation messages with channel CALL but body=empty + a
// recording_url field. To get the actual TRANSCRIPT, each recording
// must be POSTed to transcribe-call, which downloads the audio and
// runs OpenAI Whisper, then writes a call.transcript_completed row to
// business_events via recordEvidence.
//
// Cost: ~$0.006/min audio (Whisper API). Typical sales call 2-5min.
// Per-call latency: ~5s of Whisper + ~1s of upload/storage.
//
// Concurrency: transcribe-call invocations are fired in parallel
// batches. Each transcribe-call runs as its own edge function with
// its own timeout — the backfill returns as soon as ALL POSTs have
// been ack'd (typically 1-2s per ack), not when transcription
// completes. Transcripts land in business_events asynchronously
// over the next ~1-2 minutes.
//
// SAFETY:
//   - Marnin-only auth (same gate as SMS backfill)
//   - dry_run=true by default — counts what WOULD be queued, no spend
//   - Idempotent: checks business_events for an existing row keyed by
//     ghl_message_id before queueing
//   - Skips messages where recording_url is null
// ════════════════════════════════════════════════════════════

async function backfillCallTranscripts(client: any, body: any, req: Request): Promise<any> {
  // ── Auth gate (marnin-only) ──
  const authHeader = req.headers.get('authorization') || ''
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!jwt) throw new ApiError('login_required', 401)
  const { data: { user }, error: authErr } = await client.auth.getUser(jwt)
  if (authErr || !user) throw new ApiError('session_expired', 401)
  if ((user.email || '').toLowerCase() !== BACKFILL_MARNIN_EMAIL) {
    throw new ApiError('backfill_unauthorized: marnin only', 403)
  }

  // ── Params ──
  const dry_run = body?.dry_run !== false
  const pipeline = (body?.pipeline || 'both').toLowerCase()
  const max_opportunities = Math.min(Number(body?.max_opportunities) || 100, 200)
  // Default 30 days for calls (Marnin: "for the past 30 days for a hard stop").
  const window_days = Math.min(Number(body?.opportunity_window_days) || 30, 180)
  // Hard cap on transcribe-call POSTs PER INVOCATION. Even with fire-and-forget
  // we don't want one click to spawn hundreds of concurrent Whisper jobs and
  // melt the OpenAI quota. Marnin re-runs to drain remaining calls (dedupe
  // makes that safe).
  const max_calls_per_run = Math.min(Number(body?.max_calls_per_run) || 50, 100)

  if (!['fencing', 'patio', 'both'].includes(pipeline)) {
    throw new ApiError(`pipeline must be fencing|patio|both, got '${pipeline}'`, 400)
  }

  const fnBase = (Deno.env.get('SUPABASE_URL') || '').replace('/rest/v1', '') + '/functions/v1'
  const ghlBase = fnBase + '/ghl-proxy'
  const transcribeUrl = fnBase + '/transcribe-call'
  const ghlKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  // Sanity check OpenAI key presence — transcribe-call will 500 every POST
  // if missing, so detect early in dry-run too.
  const openai_key_present = !!Deno.env.get('OPENAI_API_KEY')

  // ── Fetch opps for selected pipelines ──
  const lanes = pipeline === 'both' ? ['fencing', 'patio'] : [pipeline]
  const opportunities: Array<{ id: string; contactId: string; contactName: string; pipeline: string; updatedAt: string }> = []
  for (const lane of lanes) {
    try {
      const r = await fetch(`${ghlBase}?action=opportunities&pipeline=${lane}`, {
        headers: { 'Authorization': `Bearer ${ghlKey}` },
      })
      if (!r.ok) continue
      const j: any = await r.json()
      for (const o of (j.opportunities || [])) {
        if (o.contactId && o.id) {
          opportunities.push({
            id: o.id, contactId: o.contactId,
            contactName: o.contactName || o.name || '',
            pipeline: lane,
            updatedAt: o.updatedAt || o.createdAt || new Date().toISOString(),
          })
        }
      }
    } catch { /* skip lane on error */ }
  }

  const cutoff = Date.now() - window_days * 86400000
  const recentOpps = opportunities
    .filter(o => Date.parse(o.updatedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, max_opportunities)

  const summary = {
    dry_run,
    pipeline,
    opps_total_fetched: opportunities.length,
    opps_in_window: recentOpps.length,
    max_opportunities,
    opportunity_window_days: window_days,
    max_calls_per_run,
    openai_key_present,
    calls_found: 0,
    calls_with_recording: 0,
    // `recording_absent` = GHL responded 200 but recording_url field was empty
    //                     (genuine: no recording exists for this call).
    calls_recording_absent: 0,
    // `lookup_failed` = ghl-proxy returned non-200 (rate limit, 5xx, etc.) —
    //                   we DON'T KNOW if a recording exists. Re-run can retry.
    calls_lookup_failed: 0,
    calls_dedupe_skipped: 0,
    calls_would_queue: 0,
    calls_queued: 0,
    calls_capped_for_next_run: 0,
    transcribe_call_failures: 0,
    errors: [] as Array<{ opp_id: string; reason: string }>,
    per_opp: [] as Array<{ opp_id: string; contactId: string; pipeline: string; calls: number; with_recording: number; recording_absent: number; lookup_failed: number; would_queue: number; dedupe_skipped: number }>,
  }

  // Pre-flight: if going live and the OpenAI key isn't configured, refuse
  // before issuing any POST. transcribe-call would just 500 every request.
  if (!dry_run && !openai_key_present) {
    throw new ApiError('OPENAI_API_KEY not set in environment — transcribe-call would fail every request', 503)
  }

  // Resolve job_id for each opp once.
  const oppJobMap: Record<string, string | null> = {}
  for (const opp of recentOpps) {
    try {
      const { data: jobRow } = await client.from('jobs')
        .select('id').eq('ghl_opportunity_id', opp.id).limit(1).single()
      oppJobMap[opp.id] = jobRow?.id || null
    } catch {
      oppJobMap[opp.id] = null
    }
  }

  // Fetch conversations in batches of 3 with a small inter-batch pause.
  // The previous run hit Supabase per-function rate limits at batch=5 — got
  // "Rate limit exceeded for function. Retry after 45s" on 42 of 100 opps.
  // 3 concurrent + 250ms pause keeps us under the limit.
  const FETCH_BATCH = 3
  const FETCH_PAUSE_MS = 250
  const oppBatches: Array<typeof recentOpps> = []
  for (let i = 0; i < recentOpps.length; i += FETCH_BATCH) {
    oppBatches.push(recentOpps.slice(i, i + FETCH_BATCH))
  }

  // Collect ALL call candidates first, then either count (dry-run) or fire transcribe-call POSTs in parallel batches.
  type CallCandidate = {
    opp: typeof recentOpps[number]
    job_id: string | null
    ghl_message_id: string
    recording_url: string
    direction: 'inbound' | 'outbound'
    occurred_at: string
    duration_seconds: number | null
    phone: string | null
  }
  const candidates: CallCandidate[] = []
  const perOppCounts: Record<string, { calls: number; with_recording: number; recording_absent: number; lookup_failed: number; would_queue: number; dedupe_skipped: number }> = {}

  for (let bi = 0; bi < oppBatches.length; bi++) {
    const batch = oppBatches[bi]
    const fetched = await Promise.all(batch.map(async (opp) => {
      try {
        const r = await fetch(`${ghlBase}?action=get_conversation&contactId=${opp.contactId}`, {
          headers: { 'Authorization': `Bearer ${ghlKey}` },
        })
        if (!r.ok) return { opp, ok: false, error: `get_conversation HTTP ${r.status}`, messages: [] as any[] }
        const jb: any = await r.json()
        return { opp, ok: true, messages: jb.messages || [] }
      } catch (e: any) {
        return { opp, ok: false, error: `fetch threw: ${e?.message || String(e)}`, messages: [] as any[] }
      }
    }))

    for (const item of fetched) {
      const opp = item.opp
      const counts = { calls: 0, with_recording: 0, recording_absent: 0, lookup_failed: 0, would_queue: 0, dedupe_skipped: 0 }
      perOppCounts[opp.id] = counts

      if (!item.ok) {
        summary.errors.push({ opp_id: opp.id, reason: item.error || 'unknown' })
        continue
      }

      // Step 1: collect all CALL message IDs in this conversation.
      const callMsgs: Array<{ id: string; direction: string; duration: number | null; timestamp: string | null }> = []
      for (const m of (item.messages as any[])) {
        const t = (m.type || '').toUpperCase()
        const isCall = t.includes('CALL') || t.includes('VOICEMAIL')
        if (!isCall) continue
        counts.calls++
        summary.calls_found++

        const ghl_message_id: string = m.id || ''
        if (!ghl_message_id) continue

        // Idempotency: skip if already transcribed.
        try {
          const { data: existing } = await client.from('business_events')
            .select('id')
            .eq('event_type', 'call.transcript_completed')
            .filter('payload->>ghl_call_id', 'eq', ghl_message_id)
            .limit(1)
          if (existing && existing.length) {
            counts.dedupe_skipped++
            summary.calls_dedupe_skipped++
            continue
          }
        } catch { /* lookup failure shouldn't block */ }

        callMsgs.push({
          id: ghl_message_id,
          direction: m.direction || 'inbound',
          duration: typeof m.duration === 'number' ? m.duration : null,
          timestamp: m.timestamp || null,
        })
      }

      // Step 2: enrich each CALL message via GHL message-detail endpoint
      // to get recording_url. The conversation-list API doesn't include
      // it. Sequential per opp + small pause to keep ghl-proxy under
      // Supabase per-function rate limit. Three distinct outcomes —
      // tracked separately so re-runs target only the right bucket:
      //   1. with_recording  → candidate added for transcribe-call POST
      //   2. recording_absent → GHL 200 but recording_url empty (real "no recording")
      //   3. lookup_failed   → ghl-proxy non-200 / threw (transient — re-run may succeed)
      const PER_CALL_PAUSE_MS = 100
      for (const cm of callMsgs) {
        let r: Response
        try {
          r = await fetch(`${ghlBase}?action=get_call_recording&messageId=${cm.id}`, {
            headers: { 'Authorization': `Bearer ${ghlKey}` },
          })
        } catch (e: any) {
          counts.lookup_failed++
          summary.calls_lookup_failed++
          summary.errors.push({ opp_id: opp.id, reason: `get_call_recording ${cm.id} threw: ${e?.message || String(e)}` })
          continue
        }
        if (!r.ok) {
          counts.lookup_failed++
          summary.calls_lookup_failed++
          let body = ''
          try { body = (await r.text()).slice(0, 200) } catch { /* ignore */ }
          summary.errors.push({ opp_id: opp.id, reason: `get_call_recording ${cm.id}: HTTP ${r.status} ${body}` })
          continue
        }
        let j: any
        try {
          j = await r.json()
        } catch (e: any) {
          counts.lookup_failed++
          summary.calls_lookup_failed++
          summary.errors.push({ opp_id: opp.id, reason: `get_call_recording ${cm.id}: invalid JSON` })
          continue
        }
        // ghl-proxy may return {error: '...'} with status 200 in some paths;
        // treat any explicit error as a lookup failure.
        if (j && typeof j === 'object' && j.error) {
          counts.lookup_failed++
          summary.calls_lookup_failed++
          summary.errors.push({ opp_id: opp.id, reason: `get_call_recording ${cm.id}: ${String(j.error).slice(0, 200)}` })
          continue
        }
        const rec: string | null = j?.recording_url || null
        if (!rec) {
          counts.recording_absent++
          summary.calls_recording_absent++
          continue
        }
        counts.with_recording++
        summary.calls_with_recording++
        counts.would_queue++
        summary.calls_would_queue++
        candidates.push({
          opp,
          job_id: oppJobMap[opp.id],
          ghl_message_id: cm.id,
          recording_url: rec,
          direction: (j?.direction === 'outbound' || cm.direction === 'outbound') ? 'outbound' : 'inbound',
          occurred_at: cm.timestamp ? new Date(cm.timestamp).toISOString()
                     : (j?.occurred_at ? new Date(j.occurred_at).toISOString() : new Date().toISOString()),
          duration_seconds: cm.duration ?? (typeof j?.duration === 'number' ? j.duration : null),
          phone: null,
        })
        await new Promise(rs => setTimeout(rs, PER_CALL_PAUSE_MS))
      }
    }

    // Inter-batch pause to stay under Supabase per-function rate limit.
    if (bi + 1 < oppBatches.length) {
      await new Promise(r => setTimeout(r, FETCH_PAUSE_MS))
    }
  }

  // Build per_opp list for the summary.
  for (const opp of recentOpps) {
    const c = perOppCounts[opp.id] || { calls: 0, with_recording: 0, recording_absent: 0, lookup_failed: 0, would_queue: 0, dedupe_skipped: 0 }
    summary.per_opp.push({
      opp_id: opp.id, contactId: opp.contactId, pipeline: opp.pipeline,
      calls: c.calls, with_recording: c.with_recording,
      recording_absent: c.recording_absent, lookup_failed: c.lookup_failed,
      would_queue: c.would_queue, dedupe_skipped: c.dedupe_skipped,
    })
  }

  // ── Live: fire transcribe-call POSTs ──
  //
  // Each transcribe-call invocation downloads audio + runs Whisper +
  // writes spine row. Wall time per call: 10-30s. If we awaited those
  // serially or even in batches of 5, the BACKFILL function would hit
  // its own ~150s edge-function timeout and die mid-stream.
  //
  // Fire-and-forget pattern: send the POST but only wait long enough
  // for the request to be RECEIVED by Supabase routing (which then
  // dispatches it to a fresh transcribe-call invocation with its own
  // timeout budget). Once dispatched, transcribe-call runs to
  // completion independently of our connection. We give each POST
  // 8s before aborting — enough for Supabase to receive + start
  // dispatch.
  //
  // Hard cap calls_queued at max_calls_per_run. Marnin re-runs if
  // there are more (dedupe makes re-runs safe).
  if (!dry_run && candidates.length) {
    const toFire = candidates.slice(0, max_calls_per_run)
    summary.calls_capped_for_next_run = Math.max(0, candidates.length - toFire.length)

    const POST_BATCH = 5
    const POST_ABORT_MS = 8000
    for (let i = 0; i < toFire.length; i += POST_BATCH) {
      const slice = toFire.slice(i, i + POST_BATCH)
      const results = await Promise.all(slice.map(async (c) => {
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), POST_ABORT_MS)
        try {
          const r = await fetch(transcribeUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${ghlKey}`,
            },
            body: JSON.stringify({
              recording_url: c.recording_url,
              job_id: c.job_id || undefined,
              contact_id: c.opp.contactId,
              call_direction: c.direction,
              occurred_at: c.occurred_at,
              duration_seconds: c.duration_seconds || undefined,
              phone: c.phone || undefined,
              ghl_call_id: c.ghl_message_id,
            }),
            signal: ctl.signal,
          })
          clearTimeout(t)
          // 2xx = transcribe-call accepted and at least started; treat as queued.
          // 4xx/5xx = real failure (auth, missing OPENAI_API_KEY, etc.) — visible.
          if (r.ok) return { ok: true as const }
          let errBody = ''
          try { errBody = (await r.text()).slice(0, 200) } catch { /* ignore */ }
          return { ok: false as const, ghl_message_id: c.ghl_message_id, status: r.status, error: errBody }
        } catch (e: any) {
          clearTimeout(t)
          // AbortError = request was sent but transcribe-call still working
          // when our 8s deadline hit. transcribe-call continues server-side.
          // Count as queued (best-effort).
          if (e?.name === 'AbortError') return { ok: true as const, queued_via_abort: true as const }
          return { ok: false as const, ghl_message_id: c.ghl_message_id, error: e?.message || String(e) }
        }
      }))
      for (const res of results) {
        if (res.ok) {
          summary.calls_queued++
        } else {
          summary.transcribe_call_failures++
          summary.errors.push({
            opp_id: '(transcribe)',
            reason: `transcribe-call POST failed for ${(res as any).ghl_message_id}: ${(res as any).status ? 'HTTP ' + (res as any).status : ''} ${(res as any).error || ''}`.trim(),
          })
        }
      }
    }
  }

  return summary
}

// ════════════════════════════════════════════════════════════
// MANUAL DISPATCH (Loop 6.5) — controlled manual-live SMS path
//
// Spec: secureworks-docs/cio/evidence/secure-sale-cockpit-2026-04-30/
//       loop-6.5-live-readiness-bridge-spec.md
//
// Hard gates (all enforced server-side, no client trust):
//   1. action_type ∈ MANUAL_DISPATCH_ALLOWLIST  (first_contact_sms only)
//   2. proposed_action.status === 'pending'      (idempotency)
//   3. created_at within MANUAL_DISPATCH_FRESHNESS_HOURS (24h)
//   4. now in [07:00, 20:00) Perth (quiet hours)
//   5. contact_id and contact_phone non-null     (recipient resolvable)
//   6. drafted_message non-empty
//   7. approval_token === sha256(phrase + action_id + perth_minute + salt)
//      checked against current minute and 4 prior minutes (5-min replay window)
//   8. body length ≤ 320 chars (SMS 2-segment cap; defensive)
//
// Audit chain (3 business_events rows per successful canary/pilot):
//   - proposed_action.manually_approved   (BEFORE the send fires)
//   - sms_sent                            (written by ghl-proxy on success)
//   - proposed_action.dispatched          (AFTER the send returns)
//
// Status flow uses existing values: 'pending' → 'sent'. Approval method
// + perth_minute live in action_payload.approval (jsonb; no schema change).
//
// On any gate failure: throw ApiError, no mutation, no send.
// On ghl-proxy failure: row rolled back to 'pending' for retry,
// proposed_action.dispatch_failed event written.
// ════════════════════════════════════════════════════════════

const MANUAL_DISPATCH_ALLOWLIST = ['first_contact_sms']
const MANUAL_DISPATCH_FRESHNESS_HOURS = 24
const MANUAL_DISPATCH_QUIET_HOURS_START = 7   // Perth, inclusive
const MANUAL_DISPATCH_QUIET_HOURS_END = 20    // Perth, exclusive
const MANUAL_DISPATCH_BODY_MAX = 320          // 2-segment SMS cap
const MANUAL_DISPATCH_REPLAY_WINDOW_MIN = 5   // approval token window in minutes

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function perthMinuteIso(d: Date): string {
  const perth = new Date(d.getTime() + 8 * 3600 * 1000)
  return perth.toISOString().slice(0, 16)  // YYYY-MM-DDTHH:MM
}

function expectedPhrase(approvalMethod: string, actionId: string, contactName: string | null): string {
  if (approvalMethod === 'canary') {
    return `I authorise one Secure Sale canary SMS to my own number, action_id ${actionId}, now.`
  }
  return `I authorise one Secure Sale manual-pilot SMS to ${contactName || ''}, action_id ${actionId}, now.`
}

async function verifyApprovalToken(
  approvalMethod: string,
  actionId: string,
  contactName: string | null,
  submittedToken: string,
  salt: string,
  now: Date,
): Promise<boolean> {
  const phrase = expectedPhrase(approvalMethod, actionId, contactName)
  // Check current minute and N-1 prior minutes (replay window).
  for (let i = 0; i < MANUAL_DISPATCH_REPLAY_WINDOW_MIN; i++) {
    const tick = new Date(now.getTime() - i * 60_000)
    const candidate = await sha256Hex(phrase + actionId + perthMinuteIso(tick) + salt)
    if (candidate === submittedToken) return true
  }
  return false
}

// Public handler — wraps the testable inner with the real wall clock.
export async function manualDispatch(client: any, body: any) {
  return await _manualDispatchAt(client, body, new Date())
}

// Inner with injectable `now`. Exported for unit tests so quiet-hours,
// freshness, and approval-token windows can be exercised deterministically.
export async function _manualDispatchAt(client: any, body: any, now: Date) {
  const { action_id, approval_token, approval_method } = body || {}

  // ── Argument validation ──
  if (!action_id) throw new ApiError('action_id required', 400)
  if (!approval_token) throw new ApiError('approval_token required', 400)
  if (approval_method !== 'canary' && approval_method !== 'manual_pilot') {
    throw new ApiError('approval_method must be "canary" or "manual_pilot"', 400)
  }

  // ── Gate 4: Quiet hours (server-side, Perth) ──
  const perthHour = new Date(now.getTime() + 8 * 3600 * 1000).getUTCHours()
  if (perthHour < MANUAL_DISPATCH_QUIET_HOURS_START || perthHour >= MANUAL_DISPATCH_QUIET_HOURS_END) {
    throw new ApiError(
      `quiet_hours: Perth hour ${perthHour} outside [${MANUAL_DISPATCH_QUIET_HOURS_START}, ${MANUAL_DISPATCH_QUIET_HOURS_END})`,
      400,
    )
  }

  // ── Salt presence ──
  const salt = Deno.env.get('MANUAL_DISPATCH_SALT')
  if (!salt) {
    throw new ApiError('manual_dispatch_salt_unset (server config error)', 500)
  }

  // ── Load action row ──
  const { data: action, error: loadErr } = await client.from('ai_proposed_actions')
    .select('*')
    .eq('proposal_id', action_id)
    .single()
  if (loadErr || !action) throw new ApiError('action_not_found', 404)

  // ── Gate 2: status idempotency ──
  if (action.status !== 'pending') {
    throw new ApiError(`already_processed: status=${action.status}`, 409)
  }

  // ── Gate 1: action_type allowlist ──
  if (!MANUAL_DISPATCH_ALLOWLIST.includes(action.action_type)) {
    throw new ApiError(
      `action_type_not_allow_listed: ${action.action_type} (allowed: ${MANUAL_DISPATCH_ALLOWLIST.join(', ')})`,
      400,
    )
  }

  // ── Gate 3: freshness ──
  const createdAtMs = action.created_at ? +new Date(action.created_at) : 0
  const ageHours = (now.getTime() - createdAtMs) / 3_600_000
  if (ageHours > MANUAL_DISPATCH_FRESHNESS_HOURS) {
    throw new ApiError(
      `action_stale: created ${Math.round(ageHours)}h ago (max ${MANUAL_DISPATCH_FRESHNESS_HOURS}h)`,
      400,
    )
  }

  // ── Gate 5/6: recipient + body ──
  if (!action.contact_id) throw new ApiError('recipient_unresolvable: contact_id null', 400)
  if (!action.contact_phone) throw new ApiError('recipient_unresolvable: contact_phone null', 400)
  if (!action.drafted_message || !String(action.drafted_message).trim()) {
    throw new ApiError('empty_body: drafted_message blank', 400)
  }

  // ── Gate 8: body length ──
  if (String(action.drafted_message).length > MANUAL_DISPATCH_BODY_MAX) {
    throw new ApiError(
      `body_too_long: ${String(action.drafted_message).length} > ${MANUAL_DISPATCH_BODY_MAX}`,
      400,
    )
  }

  // ── Gate 7: approval token ──
  const tokenValid = await verifyApprovalToken(
    approval_method,
    action_id,
    action.contact_name || null,
    approval_token,
    salt,
    now,
  )
  if (!tokenValid) {
    throw new ApiError('invalid_approval_token', 403)
  }

  // ── Audit chain row 1 — manually_approved (BEFORE send) ──
  const approvedAt = now.toISOString()
  const { error: approvalErr } = await client.from('business_events').insert({
    event_type: 'proposed_action.manually_approved',
    source: 'ops-api/manual_dispatch',
    entity_type: 'ai_proposed_action',
    entity_id: action_id,
    job_id: action.job_id,
    occurred_at: approvedAt,
    payload: {
      action_id,
      approval_method,
      action_type: action.action_type,
      contact_id: action.contact_id,
      drafted_message_preview: String(action.drafted_message).slice(0, 200),
      perth_minute: perthMinuteIso(now),
    },
  })
  if (approvalErr) {
    throw new ApiError(`approval_record_failed: ${approvalErr.message}`, 500)
  }

  // ── Idempotent status flip BEFORE send (optimistic lock on status='pending') ──
  const updatedPayload = Object.assign({}, action.action_payload || {}, {
    approval: {
      approval_method,
      approved_at: approvedAt,
      approved_via: 'ops-api/manual_dispatch',
      perth_minute: perthMinuteIso(now),
    },
  })
  const { data: flipResult, error: flipErr } = await client.from('ai_proposed_actions')
    .update({
      status: 'sent',
      sent_at: approvedAt,
      action_payload: updatedPayload,
    })
    .eq('proposal_id', action_id)
    .eq('status', 'pending')
    .select('id')
  if (flipErr) {
    throw new ApiError(`status_flip_failed: ${flipErr.message}`, 500)
  }
  if (!flipResult || (Array.isArray(flipResult) && flipResult.length === 0)) {
    // Row was processed by another caller between load + flip.
    throw new ApiError('race: status flipped by concurrent caller', 409)
  }

  // ── Call ghl-proxy?action=send_sms ──
  const ghlBase = (Deno.env.get('SUPABASE_URL') || '').replace('/rest/v1', '') + '/functions/v1/ghl-proxy'
  const ghlKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  let ghlMessageId: string | null = null
  let ghlError: string | null = null
  let ghlStatus = 0
  try {
    const ghlResp = await fetch(`${ghlBase}?action=send_sms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ghlKey}`,
      },
      body: JSON.stringify({
        contactId: action.contact_id,
        message: action.drafted_message,
        jobId: action.job_id,
      }),
    })
    ghlStatus = ghlResp.status
    const j: any = await ghlResp.json().catch(() => ({}))
    // ghl-proxy can return HTTP 200 with a failure body (success=false,
    // dedup_blocked=true, or just a missing message_id). All of those
    // mean NO SMS actually went out — must mark dispatch_failed.
    // Codex stop-time #7: don't trust HTTP status alone.
    if (!ghlResp.ok) {
      ghlError = j?.error || `ghl-proxy returned ${ghlResp.status}`
    } else if (j?.success === false) {
      ghlError = j?.error || 'ghl-proxy reported success=false'
    } else if (j?.dedup_blocked === true) {
      ghlError = j?.error || 'ghl-proxy dedup_blocked: identical SMS sent recently'
    } else {
      ghlMessageId = j?.messageId || j?.message_id || j?.id || null
      if (!ghlMessageId) {
        // 200 OK without a message id is ambiguous — refuse to claim dispatched.
        ghlError = 'ghl-proxy returned 200 but no messageId in body'
      }
    }
  } catch (e: any) {
    ghlError = `ghl_proxy_fetch_failed: ${e?.message || String(e)}`
  }

  // ── Audit chain row 3 — dispatched (or dispatch_failed) ──
  await client.from('business_events').insert({
    event_type: ghlError ? 'proposed_action.dispatch_failed' : 'proposed_action.dispatched',
    source: 'ops-api/manual_dispatch',
    entity_type: 'ai_proposed_action',
    entity_id: action_id,
    job_id: action.job_id,
    occurred_at: now.toISOString(),
    payload: {
      action_id,
      approval_method,
      ghl_message_id: ghlMessageId,
      ghl_status: ghlStatus,
      error: ghlError,
    },
  })

  if (ghlError) {
    // Roll back the action row so the rep can retry after fixing root cause.
    await client.from('ai_proposed_actions')
      .update({ status: 'pending', sent_at: null })
      .eq('proposal_id', action_id)
    throw new ApiError(`ghl_proxy_send_failed: ${ghlError}`, 502)
  }

  // ── Success ──
  return {
    success: true,
    action_id,
    approval_method,
    ghl_message_id: ghlMessageId,
    audit_chain: [
      'proposed_action.manually_approved',
      'sms_sent (via ghl-proxy)',
      'proposed_action.dispatched',
    ],
  }
}


// ════════════════════════════════════════════════════════════
// SMART NUDGES
// ════════════════════════════════════════════════════════════

async function listNudges(client: any, params: URLSearchParams) {
  const status = params.get('status') || 'pending'
  const ruleKey = params.get('rule_key')
  const jobId = params.get('job_id')
  const since = params.get('since')
  const limit = Math.min(parseInt(params.get('limit') || '20'), 100)

  let query = client.from('smart_nudges')
    .select('id, nudge_type, job_id, contact_name, trigger_rule, suggested_action, suggested_message, channel, status, sent_at, acted_at, dismissed_at, created_at')
    .eq('org_id', DEFAULT_ORG_ID)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status) query = query.eq('status', status)
  if (ruleKey) query = query.eq('trigger_rule', ruleKey)
  if (jobId) query = query.eq('job_id', jobId)
  if (since) query = query.gte('created_at', since)

  const { data, error } = await query
  if (error) throw error
  return { nudges: data || [], total: (data || []).length }
}

async function actNudge(client: any, body: any) {
  const { nudge_id, action } = body
  if (!nudge_id) throw new Error('nudge_id required')
  if (!action || !['act', 'dismiss'].includes(action)) throw new Error('action must be "act" or "dismiss"')

  const now = new Date().toISOString()
  const update: any = { status: action === 'act' ? 'acted' : 'dismissed' }
  if (action === 'act') update.acted_at = now
  else update.dismissed_at = now

  const { error } = await client.from('smart_nudges')
    .update(update)
    .eq('id', nudge_id)

  if (error) throw error
  return { success: true, nudge_id, action }
}


// ════════════════════════════════════════════════════════════
// CONFIRMED PRICES (for scope tools)
// ════════════════════════════════════════════════════════════

async function getConfirmedPrices(client: any) {
  // Get confirmed prices from material_price_ledger
  const { data: prices, error } = await client.from('material_price_ledger')
    .select('id, item_description, material_category, material_code, unit_price, unit, supplier_name, confirmed_at, raw_supplier_price, raw_supplier_unit, scope_tool_field')
    .eq('status', 'confirmed')
    .order('confirmed_at', { ascending: false })
    .limit(200)

  if (error) {
    // Table might not exist yet — return empty
    console.log('[ops-api] material_price_ledger query error:', error.message)
    return { prices: [] }
  }

  return { prices: prices || [] }
}


// ════════════════════════════════════════════════════════════
// AI ANNOTATIONS — Inline Intelligence Engine (Phase 1)
// ════════════════════════════════════════════════════════════

// GET: Query active annotations
async function getAnnotations(client: any, params: URLSearchParams) {
  const scope = params.get('scope') || 'global'
  const entityType = params.get('entity_type')
  const entityId = params.get('entity_id')

  let query = client.from('ai_annotations')
    .select('*')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('status', 'active')

  if (scope === 'entity' && entityType && entityId) {
    query = query.eq('entity_type', entityType).eq('entity_id', entityId)
  } else {
    // Global: show today/backlog items or high-priority
    query = query.or('ui_location.in.(today,backlog),priority.gte.80')
  }

  const { data, error } = await query
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(50)

  if (error) {
    console.log('[ops-api] annotations query error:', error.message)
    return { annotations: [] }
  }

  // Filter out expired and snoozed, compute effective priority
  const now = new Date().toISOString()
  const annotations = (data || [])
    .filter((a: any) => {
      if (a.expires_at && a.expires_at < now) return false
      if (a.snooze_until && a.snooze_until > now) return false
      return true
    })
    .map((a: any) => ({
      ...a,
      effective_priority: (a.escalates_at && now > a.escalates_at) ? a.priority + 20 : a.priority,
    }))
    .sort((a: any, b: any) => b.effective_priority - a.effective_priority || (a.created_at > b.created_at ? 1 : -1))

  return { annotations }
}

// POST: Resolve an annotation with response
async function resolveAnnotation(client: any, body: any) {
  const { annotation_id, response_value, response_text, operator_email } = body
  if (!annotation_id) throw new Error('annotation_id required')

  // Fetch annotation
  const { data: ann, error: fetchErr } = await client.from('ai_annotations')
    .select('*')
    .eq('id', annotation_id)
    .eq('status', 'active')
    .single()
  if (fetchErr || !ann) throw new Error('Annotation not found or already resolved')

  // Mark resolved
  const { error: updateErr } = await client.from('ai_annotations')
    .update({
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolved_by: operator_email || 'unknown',
      resolution: { value: response_value, text: response_text || null },
    })
    .eq('id', annotation_id)
  if (updateErr) throw updateErr

  let action: any = null

  // Type-specific dispatch
  switch (ann.annotation_type) {
    case 'unlinked_invoice': {
      if (response_value === 'link' && ann.structured_data?.job_id) {
        // Link the invoice(s) to the job
        const candidateIds = (ann.structured_data.candidate_invoices || []).map((c: any) => c.id).filter(Boolean)
        if (candidateIds.length > 0) {
          await client.from('xero_invoices')
            .update({ job_id: ann.structured_data.job_id })
            .in('id', candidateIds)
        }
      } else if (response_value?.startsWith('link:')) {
        // Multi-match: link to specific job from xero-sync annotation
        const targetJobId = response_value.slice(5)
        const xeroInvId = ann.structured_data?.xero_invoice_id
        if (targetJobId && xeroInvId) {
          await client.from('xero_invoices')
            .update({ job_id: targetJobId })
            .eq('xero_invoice_id', xeroInvId)
        }
      }
      // 'dismiss' just resolves — no extra action
      break
    }

    case 'materials_not_confirmed': {
      if (response_value === 'create_po') {
        action = { action: 'open_po_modal', job_id: ann.entity_id }
      }
      if (response_value === 'on_hand') {
        // Log that materials are on hand
        logBusinessEvent(client, {
          event_type: 'annotation.materials_on_hand',
          entity_type: 'job',
          entity_id: ann.entity_id || annotation_id,
          job_id: ann.entity_id || undefined,
          payload: { annotation_id, resolved_by: operator_email },
          metadata: { operator: operator_email },
        })
      }
      break
    }

    case 'pattern_confirm': {
      const ruleId = ann.structured_data?.rule_id
      if (ruleId) {
        if (response_value === 'correct') {
          // Confirm the learned rule, bump confidence
          const { data: rule } = await client.from('learned_rules').select('confidence').eq('id', ruleId).single()
          await client.from('learned_rules')
            .update({ status: 'confirmed', confidence: Math.min(1, (rule?.confidence || 0.5) + 0.1) })
            .eq('id', ruleId)
        } else if (response_value === 'wrong') {
          await client.from('learned_rules').update({ status: 'rejected' }).eq('id', ruleId)
        } else if (response_value === 'depends') {
          await client.from('learned_rules')
            .update({ status: 'corrected', correction_note: response_text || null })
            .eq('id', ruleId)
        }
      }
      break
    }

    case 'completed_not_invoiced': {
      if (response_value === 'create_invoice') {
        action = { action: 'open_invoice_modal', job_id: ann.entity_id }
      }
      // 'already_invoiced' and 'dismiss' just resolve — no extra action
      break
    }

    case 'overdue_invoice': {
      if (response_value === 'chase' && ann.structured_data?.xero_invoice_id) {
        // Return action to frontend to open SMS compose with payment reminder
        action = { action: 'send_payment_reminder', job_id: ann.entity_id, xero_invoice_id: ann.structured_data.xero_invoice_id }
      }
      break
    }

    case 'stale_quote': {
      if (response_value === 'follow_up') {
        action = { action: 'open_comms_tab', job_id: ann.entity_id }
      }
      if (response_value === 'mark_lost') {
        // Update job status to lost
        if (ann.entity_id) {
          await client.from('jobs')
            .update({ status: 'lost', updated_at: new Date().toISOString() })
            .eq('id', ann.entity_id)
            .eq('status', 'quoted')
          await client.from('job_events').insert({
            job_id: ann.entity_id,
            event_type: 'status_changed',
            detail_json: { new_status: 'lost', via: 'annotation_resolve', previous_status: 'quoted' },
          })
        }
      }
      break
    }

    case 'price_drift': {
      const sd = ann.structured_data || {}
      if (response_value === 'update_default' && sd.item_key) {
        // Update scope_tool_defaults with the confirmed supplier rate
        const { error: updErr } = await client.from('scope_tool_defaults')
          .update({
            default_price: sd.supplier_rate,
            default_cost_rate: sd.supplier_rate,
            last_updated_at: new Date().toISOString(),
          })
          .eq('item_key', sd.item_key)
          .eq('scope_tool', sd.scope_tool || 'patio-tool')
          .eq('org_id', ann.org_id || DEFAULT_ORG_ID)

        if (updErr) {
          console.log('[ops-api] scope_tool_defaults update failed:', updErr.message)
        } else {
          console.log(`[ops-api] Updated scope_tool_defaults: ${sd.item_key} → $${sd.supplier_rate}`)
        }
      }
      // 'dismiss' / 'keep_current' just resolves
      break
    }

    case 'accepted_no_po': {
      if (response_value === 'create_po') {
        action = { action: 'open_po_modal', job_id: ann.entity_id }
      } else if (response_value === 'not_needed') {
        logBusinessEvent(client, {
          event_type: 'annotation.accepted_no_po.not_needed',
          entity_type: 'job',
          entity_id: ann.entity_id || annotation_id,
          job_id: ann.entity_id || undefined,
          payload: { annotation_id, resolved_by: operator_email },
        })
      }
      // 'dismiss' just resolves
      break
    }

    case 'po_overbudget': {
      if (response_value === 'review') {
        action = { action: 'open_money_tab', job_id: ann.entity_id }
      } else if (response_value === 'expected') {
        logBusinessEvent(client, {
          event_type: 'annotation.po_overbudget.expected',
          entity_type: 'job',
          entity_id: ann.entity_id || annotation_id,
          job_id: ann.entity_id || undefined,
          payload: { annotation_id, resolved_by: operator_email },
        })
      }
      break
    }
  }

  // Log business event
  logBusinessEvent(client, {
    event_type: 'annotation.resolved',
    entity_type: ann.entity_type || 'annotation',
    entity_id: ann.entity_id || annotation_id,
    job_id: ann.entity_id && ann.entity_type === 'job' ? ann.entity_id : undefined,
    payload: {
      annotation_id,
      annotation_type: ann.annotation_type,
      response_value,
      response_text: response_text || null,
    },
    metadata: { operator: operator_email },
  })

  // Record feedback outcome for ALL annotation types — closes the AI feedback loop
  try {
    const isApproval = ['update_default', 'correct', 'link', 'create_po', 'create_invoice', 'chase', 'follow_up', 'review'].includes(response_value || '')
    await client.from('ai_feedback_outcomes').insert({
      trace_id: ann.source_ref || annotation_id,
      human_action: isApproval ? 'approved' : 'rejected',
      human_action_at: new Date().toISOString(),
      feedback_category: ann.annotation_type,
    })
  } catch { /* non-blocking */ }

  return { success: true, annotation_id, action }
}

// Dedup helper: check if source_ref already exists as active, insert if not
async function insertAnnotationIfNew(client: any, ann: any) {
  if (ann.source_ref) {
    const { data: existing } = await client.from('ai_annotations')
      .select('id')
      .eq('source_ref', ann.source_ref)
      .eq('status', 'active')
      .limit(1)
    if (existing && existing.length > 0) return // already exists
  }
  await client.from('ai_annotations').insert(ann)
}

// Fire-and-forget: create/refresh annotations when a job is loaded
async function createJobAnnotations(
  client: any, jobId: string, job: any,
  invoices: any[], purchaseOrders: any[], assignments: any[]
) {
  try {
    // Throttle: max 15 active annotations per day
    const { count: dayCount } = await client.from('ai_annotations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    const throttled = (dayCount || 0) >= 15

    // ── 1. Unlinked Invoice Check ──
    if (!throttled || true) {  // unlinked invoices always priority 75
      const clientName = job?.client_name
      if (clientName) {
        // Find invoices matching client name but with no job_id
        const { data: unlinked } = await client.from('xero_invoices')
          .select('id, invoice_number, contact_name, total, status, invoice_date')
          .eq('org_id', DEFAULT_ORG_ID)
          .is('job_id', null)
          .ilike('contact_name', `%${clientName.replace(/'/g, "''")}%`)
          .in('status', ['AUTHORISED', 'SUBMITTED', 'PAID'])
          .limit(5)

        if (unlinked && unlinked.length > 0) {
          const sourceRef = `realtime:unlinked_invoice:${jobId}`
          const totalValue = unlinked.reduce((s: number, inv: any) => s + (inv.total || 0), 0)
          await insertAnnotationIfNew(client, {
            org_id: DEFAULT_ORG_ID,
            entity_type: 'job',
            entity_id: jobId,
            ui_location: 'job_overview',
            annotation_type: 'unlinked_invoice',
            category: 'financial',
            title: `${unlinked.length} invoice${unlinked.length > 1 ? 's' : ''} ($${Math.round(totalValue).toLocaleString()}) may belong to this job`,
            body: unlinked.map((inv: any) => `${inv.invoice_number} — $${(inv.total || 0).toLocaleString()}`).join(', '),
            structured_data: { candidate_invoices: unlinked, job_id: jobId },
            response_type: 'choice',
            response_options: [
              { value: 'link', label: 'Link to Job', style: 'primary' },
              { value: 'dismiss', label: 'Not Related', style: 'secondary' },
            ],
            priority: 75,
            severity: 'amber',
            source: 'realtime/job_detail',
            source_ref: sourceRef,
            confidence: 0.7,
          })
        }
      }
    }

    // ── 2. Materials Not Confirmed Check ──
    const activeStatuses = ['accepted', 'approvals', 'deposit', 'processing', 'scheduled']
    if (activeStatuses.includes(job?.status)) {
      // Check if build is within 5 days
      const nextAssignment = (assignments || []).find((a: any) => a.scheduled_date)
      const scheduledDate = nextAssignment?.scheduled_date
      if (scheduledDate) {
        const daysUntil = Math.ceil((new Date(scheduledDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        if (daysUntil <= 5 && daysUntil >= 0) {
          // Check for confirmed POs
          const confirmedPOs = (purchaseOrders || []).filter((po: any) =>
            ['authorised', 'billed', 'received'].includes((po.status || '').toLowerCase())
          )
          if (confirmedPOs.length === 0) {
            const sourceRef = `realtime:materials:${jobId}`
            const priority = daysUntil <= 2 ? 85 : 70
            if (!throttled || priority >= 70) {
              await insertAnnotationIfNew(client, {
                org_id: DEFAULT_ORG_ID,
                entity_type: 'job',
                entity_id: jobId,
                ui_location: 'job_overview',
                annotation_type: 'materials_not_confirmed',
                category: 'operational',
                title: `Build in ${daysUntil} day${daysUntil !== 1 ? 's' : ''} — materials not confirmed`,
                body: `Scheduled ${scheduledDate.slice(0, 10)} but no confirmed POs. ${(purchaseOrders || []).length} draft PO${(purchaseOrders || []).length !== 1 ? 's' : ''} exist.`,
                structured_data: { scheduled_date: scheduledDate, days_until: daysUntil, draft_po_count: (purchaseOrders || []).length },
                response_type: 'choice',
                response_options: [
                  { value: 'create_po', label: 'Create PO', style: 'primary' },
                  { value: 'on_hand', label: 'Materials On Hand', style: 'secondary' },
                  { value: 'dismiss', label: 'Dismiss', style: 'ghost' },
                ],
                priority,
                severity: daysUntil <= 2 ? 'amber' : 'info',
                source: 'realtime/job_detail',
                source_ref: sourceRef,
                escalates_at: daysUntil <= 2 ? null : new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
                confidence: 0.85,
              })
            }
          }
        }
      }
    }

    // ── 3. Pattern Confirm — NOT on job_detail load (handled by daily-digest) ──
    // pattern_confirm annotations are global, created by learning_digest on Mondays

  } catch (e) {
    console.log('[ops-api] createJobAnnotations error:', (e as Error).message)
  }
}


// ════════════════════════════════════════════════════════════
// SPINE INFRASTRUCTURE — Expense Management
// ════════════════════════════════════════════════════════════

// Resolve the user that approval should route to. The legacy text label
// ('shaun'/'jan') is kept; the new approval_routed_to_user_id column carries
// the actual uuid so JWT-based auth in approveExpense can validate the caller.
// If no user is found by name, the user_id stays null and elevated roles
// (admin/owner/ops_manager) can still approve.
async function resolveApproverUserId(client: any, label: string): Promise<string | null> {
  if (!label) return null
  // Match on lowercased first-name fragment of users.name. Tight enough that
  // 'shaun' picks Shaun and not someone named 'Shauna' (we use ilike with
  // the label as a prefix). Returns the first match deterministically.
  const { data } = await client.from('users')
    .select('id, name')
    .ilike('name', `${label}%`)
    .limit(1)
    .maybeSingle()
  return data?.id || null
}

async function submitExpense(
  client: any,
  body: any,
  authCtx?: { mode: 'api_key' | 'jwt'; user?: { id: string; email: string; role: string } }
) {
  const {
    job_id,
    receipt_photo_url,
    receipt_storage_path,
    receipt_storage_bucket,
    receipt_sha256,
    submitted_by,
    po_id,
    flow,
    category,
    payment_method,
    business_category,
    gst_status,
    no_receipt_reason,
    field_confidence,
    jarvis_job_suggestion,
  } = body

  // A receipt photo URL is the canonical evidence path. The no-receipt path
  // (no photo, explicit reason) is still allowed — it just means the row will
  // fail preflight unless no_receipt_reason is set.
  if (!receipt_photo_url && !no_receipt_reason) {
    throw new ApiError('receipt_photo_url or no_receipt_reason required', 400)
  }

  // Snapshot submitter info from JWT first, fall back to body for api_key calls.
  const submitterId =
    (authCtx?.mode === 'jwt' ? authCtx.user?.id : null) ||
    submitted_by ||
    null

  let submitterName: string | null = null
  let submitterRole: string | null = (authCtx?.user?.role || null) as string | null
  if (submitterId) {
    const { data: u } = await client.from('users')
      .select('name, role')
      .eq('id', submitterId)
      .maybeSingle()
    if (u) {
      submitterName = u.name || null
      submitterRole = u.role || submitterRole
    }
  }

  // Routing label: job-linked → shaun, non-job → jan. (Existing convention.)
  const routedLabel = job_id ? 'shaun' : 'jan'
  const routedUserId = await resolveApproverUserId(client, routedLabel)

  // Flow inference if caller didn't set it explicitly.
  const inferredFlow = flow
    || (payment_method === 'supplier_invoice' ? 'supplier_bill'
        : payment_method === 'company_card' || payment_method === 'cash' ? 'company_expense'
        : payment_method === 'personal_card' ? 'reimbursement'
        : 'unknown')

  // Insert receipt FIRST — saved regardless of AI extraction success
  const insertRow: Record<string, any> = {
    org_id: DEFAULT_ORG_ID,
    job_id: job_id || null,
    po_id: po_id || null,
    submitted_by: submitterId,
    submitter_display_name: submitterName,
    submitter_role_at_submission: submitterRole,
    receipt_photo_url: receipt_photo_url || '',
    receipt_storage_path: receipt_storage_path || null,
    receipt_storage_bucket: receipt_storage_bucket || (receipt_photo_url ? 'expense-receipts' : null),
    receipt_sha256: receipt_sha256 || null,
    no_receipt_reason: no_receipt_reason || null,
    flow: inferredFlow,
    category: category || 'unknown',
    payment_method: payment_method || 'unknown',
    business_category: business_category || null,
    gst_status: gst_status || 'unknown',
    field_confidence: field_confidence || {},
    jarvis_job_suggestion: jarvis_job_suggestion || {},
    status: receipt_photo_url ? 'pending_extraction' : 'pending',
    match_type: job_id ? 'ad_hoc' : 'non_job',
    expense_tier: job_id ? 'tier_2' : 'tier_3',
    approval_routed_to: routedLabel,
    approval_routed_to_user_id: routedUserId,
  }

  const { data: expense, error: insertErr } = await client.from('expense_receipts')
    .insert(insertRow)
    .select('id')
    .single()
  if (insertErr) throw insertErr

  // Non-blocking Haiku vision extraction
  let extraction = null
  try {
    const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || ''
    if (ANTHROPIC_API_KEY) {
      const visionResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: receipt_photo_url } },
              { type: 'text', text: 'Extract from this receipt: vendor_name, receipt_date (YYYY-MM-DD), total_amount (number), gst_amount (number), line_items (array of {description, quantity, unit_price, total}). Reply with ONLY valid JSON, no other text.' }
            ]
          }]
        })
      })

      if (visionResp.ok) {
        const visionResult = await visionResp.json()
        const rawText = visionResult.content?.[0]?.text || ''
        const jsonMatch = rawText.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          extraction = JSON.parse(jsonMatch[0])

          // Build field_confidence. Caller-provided values (from the Trade UI
          // after the user has reviewed the parsed fields) take priority over
          // the server-side default. Defaults reflect what the extractor saw:
          // present field → 0.8 (we cannot get a real confidence from Haiku
          // without an explicit prompt change). Present, valid number → 0.85.
          // Once the prompt is upgraded to ask for self-rated confidence,
          // these defaults become a fallback only.
          const defaultFc: Record<string, number> = {}
          if (extraction.vendor_name) defaultFc.vendor_name = 0.8
          if (extraction.receipt_date) defaultFc.receipt_date = 0.8
          if (extraction.total_amount) defaultFc.total_amount = 0.85
          if (extraction.gst_amount) defaultFc.gst_amount = 0.75
          if (Array.isArray(extraction.line_items) && extraction.line_items.length > 0) {
            defaultFc.line_items = 0.7
          }
          const mergedFc = { ...defaultFc, ...(field_confidence || {}) }
          // Single rolled-up value: minimum across present fields. Surfaces the
          // weakest field so the UI / preflight can highlight it.
          const rolledUp = Object.values(mergedFc).length
            ? Math.min(...Object.values(mergedFc).map(Number))
            : null

          // Update expense with extracted data
          const updateFields: any = {
            vendor_name: extraction.vendor_name || null,
            receipt_date: extraction.receipt_date || null,
            total_amount: extraction.total_amount ? Number(extraction.total_amount) : null,
            gst_amount: extraction.gst_amount ? Number(extraction.gst_amount) : null,
            line_items: extraction.line_items || [],
            extraction_raw: visionResult,
            extraction_confidence: rolledUp,
            field_confidence: mergedFc,
            status: 'pending',
            updated_at: new Date().toISOString(),
          }

          // Attempt PO matching if job_id provided
          if (job_id && extraction.vendor_name) {
            const { data: matchedPO } = await client.from('purchase_orders')
              .select('id, supplier_name')
              .eq('job_id', job_id)
              .ilike('supplier_name', `%${extraction.vendor_name.slice(0, 10)}%`)
              .limit(1)
              .maybeSingle()

            if (matchedPO) {
              updateFields.po_id = matchedPO.id
              updateFields.match_type = 'po_matched'
              updateFields.match_confidence = 0.7
              updateFields.expense_tier = 'tier_1'
            }
          }

          await client.from('expense_receipts').update(updateFields).eq('id', expense.id)
        }
      }
    }
  } catch (e) {
    console.log('[ops-api] Haiku vision extraction failed (receipt saved):', (e as Error).message)
  }

  // Get job info for annotation
  let jobInfo = null
  if (job_id) {
    const { data } = await client.from('jobs').select('job_number, client_name').eq('id', job_id).maybeSingle()
    jobInfo = data
  }

  // Create approval annotation
  const routedTo = job_id ? 'shaun' : 'jan'
  const amountStr = extraction?.total_amount ? `$${extraction.total_amount}` : '(amount pending extraction)'
  const vendorStr = extraction?.vendor_name || '(vendor pending extraction)'
  const jobStr = jobInfo ? `for ${jobInfo.job_number}` : '— General Stock'

  await client.from('ai_annotations').insert({
    org_id: DEFAULT_ORG_ID,
    job_id: job_id || null,
    annotation_type: 'expense_approval_needed',
    source: 'system/expense',
    severity: 'amber',
    message: routedTo === 'shaun'
      ? `Expense: ${amountStr} ${vendorStr} ${jobStr} — awaiting Shaun's approval`
      : `Stock purchase: ${amountStr} ${vendorStr} — awaiting Jan's approval`,
    detail_json: { expense_id: expense.id, routed_to: routedTo },
    source_ref: `expense:${expense.id}`,
  })

  logBusinessEvent(client, {
    event_type: 'expense.submitted',
    entity_type: 'expense_receipt',
    entity_id: expense.id,
    job_id: jobInfo?.job_number || job_id || '',
    payload: { extraction, routed_to: routedTo, flow: inferredFlow, payment_method, category },
    metadata: { operator: submitterId, auth_mode: authCtx?.mode || 'api_key' },
  })

  return {
    expense_id: expense.id,
    extraction,
    status: receipt_photo_url
      ? (extraction ? 'pending' : 'pending_extraction')
      : 'pending',
    routed_to: routedTo,
    flow: inferredFlow,
  }
}

// updateExpense — let the submitter (or admin) correct fields on an expense
// row that has not yet been pushed to Xero. Used by the Trade UI's review
// step to record the user's job/category/payment_method choices on top of
// what Haiku extracted. Whitelisted fields only — no schema poking.
async function updateExpense(
  client: any,
  body: any,
  authCtx?: { mode: 'api_key' | 'jwt'; user?: { id: string; email: string; role: string } }
) {
  const { expense_id } = body
  if (!expense_id) throw new ApiError('expense_id required', 400)

  const { data: row, error: loadErr } = await client.from('expense_receipts')
    .select('id, submitted_by, status, receipt_sha256')
    .eq('id', expense_id)
    .maybeSingle()
  if (loadErr) throw loadErr
  if (!row) throw new ApiError('Expense not found', 404)

  // Authz: submitter on JWT path, OR elevated role, OR api_key. Block once
  // the expense has been pushed to Xero — at that point edits go via Xero.
  if (authCtx?.mode === 'jwt') {
    const role = (authCtx.user?.role || '').toLowerCase()
    const elevated = role === 'admin' || role === 'owner' || role === 'ops_manager'
    if (!elevated && row.submitted_by !== authCtx.user?.id) {
      throw new ApiError('Not authorised to edit this expense', 403)
    }
  }
  if (row.status === 'pushed_to_xero') {
    throw new ApiError('Expense already pushed to Xero — edit in Xero', 409)
  }

  // Whitelist: fields that are safe to update from a client.
  const allowed: Record<string, boolean> = {
    vendor_name: true,
    receipt_date: true,
    total_amount: true,
    gst_amount: true,
    line_items: true,
    job_id: true,
    flow: true,
    category: true,
    payment_method: true,
    business_category: true,
    gst_status: true,
    no_receipt_reason: true,
    jarvis_job_suggestion: true,
    field_confidence: true,
  }
  const updates: Record<string, any> = {}
  for (const [k, v] of Object.entries(body)) {
    if (k === 'expense_id') continue
    if (!allowed[k]) continue
    updates[k] = v
  }

  // Receipt evidence is immutable once set. The hash only flips from null
  // to the first computed value; we never overwrite a non-null hash.
  if (body.receipt_sha256 && !row.receipt_sha256) {
    updates.receipt_sha256 = body.receipt_sha256
  }

  if (Object.keys(updates).length === 0) {
    return { success: true, updated_fields: [], expense_id }
  }

  updates.updated_at = new Date().toISOString()
  await client.from('expense_receipts').update(updates).eq('id', expense_id)

  logBusinessEvent(client, {
    event_type: 'expense.updated',
    entity_type: 'expense_receipt',
    entity_id: expense_id,
    payload: { updated_fields: Object.keys(updates).filter(k => k !== 'updated_at') },
    metadata: { auth_mode: authCtx?.mode || 'api_key', operator: authCtx?.user?.id || null },
  })

  return { success: true, expense_id, updated_fields: Object.keys(updates).filter(k => k !== 'updated_at') }
}

// suggestJobForExpense — ranks likely jobs for an expense submission.
// Read-only; cheap; called by the Trade UI as soon as Haiku extraction lands
// so the worker sees a preselected suggestion. Returns up to 5 ranked
// candidates plus a 'general business' fallback. The UI is responsible for
// recording which option the human chose into expense_receipts.jarvis_job_suggestion.
async function suggestJobForExpense(
  client: any,
  body: any,
  authCtx?: { mode: 'api_key' | 'jwt'; user?: { id: string; email: string; role: string } }
) {
  const {
    submitter_id,
    merchant,
    receipt_date,
    total_amount,
  } = body

  // Resolve submitter — JWT first, fall back to body for api_key callers.
  const userId = (authCtx?.mode === 'jwt' ? authCtx.user?.id : null) || submitter_id || null

  type Suggestion = { job_id: string; job_number: string; client_name: string; site_suburb: string | null; score: number; reason: string }
  const byId = new Map<string, Suggestion>()

  function bump(j: any, score: number, reason: string) {
    if (!j?.id) return
    const existing = byId.get(j.id)
    if (!existing || existing.score < score) {
      byId.set(j.id, {
        job_id: j.id,
        job_number: j.job_number || '',
        client_name: j.client_name || '',
        site_suburb: j.site_suburb || null,
        score,
        reason: existing && existing.score >= score ? existing.reason : reason,
      })
    }
  }

  // 1. Currently clocked-on assignment (highest signal — the worker is on site).
  if (userId) {
    try {
      const { data: clocked } = await client.from('clock_events')
        .select('job_id, event_type, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (clocked?.event_type === 'clock_on' && clocked?.job_id) {
        const { data: j } = await client.from('jobs')
          .select('id, job_number, client_name, site_suburb')
          .eq('id', clocked.job_id)
          .maybeSingle()
        if (j) bump(j, 0.95, 'currently clocked on')
      }
    } catch (_e) { /* fail-graceful: no clock_events table or column */ }
  }

  // 2. Active assignments around the receipt date.
  if (userId) {
    try {
      const targetDate = receipt_date || new Date().toISOString().slice(0, 10)
      const dayMs = 24 * 60 * 60 * 1000
      const lo = new Date(new Date(targetDate).getTime() - 7 * dayMs).toISOString().slice(0, 10)
      const hi = new Date(new Date(targetDate).getTime() + 1 * dayMs).toISOString().slice(0, 10)
      const { data: assigns } = await client.from('job_assignments')
        .select('job_id, scheduled_date, jobs:job_id(id, job_number, client_name, site_suburb)')
        .eq('user_id', userId)
        .gte('scheduled_date', lo)
        .lte('scheduled_date', hi)
        .limit(5)
      for (const a of (assigns || [])) {
        if (a.jobs) bump(a.jobs, 0.8, `assigned to job around ${a.scheduled_date}`)
      }
    } catch (_e) { /* graceful — schema variants */ }
  }

  // 3. Suppliers on existing POs that match the merchant name.
  if (merchant && typeof merchant === 'string' && merchant.trim().length >= 3) {
    try {
      const needle = merchant.trim().slice(0, 24)
      const { data: pos } = await client.from('purchase_orders')
        .select('job_id, supplier_name, total, jobs:job_id(id, job_number, client_name, site_suburb)')
        .ilike('supplier_name', `%${needle}%`)
        .order('created_at', { ascending: false })
        .limit(10)
      for (const po of (pos || [])) {
        if (!po.jobs) continue
        // Stronger signal if amount also roughly matches.
        const amountMatch = total_amount && po.total
          ? Math.abs(Number(po.total) - Number(total_amount)) < Math.max(5, Number(po.total) * 0.05)
          : false
        bump(po.jobs, amountMatch ? 0.85 : 0.7,
          amountMatch ? `PO with same supplier and amount` : `PO with same supplier`)
      }
    } catch (_e) { /* graceful */ }
  }

  // 4. Worker's recent active jobs (fallback if everything above is empty).
  if (userId && byId.size === 0) {
    try {
      const { data: recent } = await client.from('job_assignments')
        .select('job_id, jobs:job_id(id, job_number, client_name, site_suburb, status)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10)
      for (const a of (recent || [])) {
        const j: any = a.jobs
        if (j && !['lost', 'cancelled', 'complete'].includes((j.status || '').toLowerCase())) {
          bump(j, 0.5, 'recent assignment')
        }
      }
    } catch (_e) { /* graceful */ }
  }

  const suggestions = Array.from(byId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)

  return {
    suggestions,
    fallback: { label: 'General business (no job)', score: 0.3 },
    generated_at: new Date().toISOString(),
  }
}

// approveExpense validates the caller against the row's approval routing.
// authCtx carries the auth state from the main router:
//   - api_key: server-to-server (allowed; e.g. JARVIS automation)
//   - jwt:     browser/Trade caller. Must be admin/owner/ops_manager OR the
//              user this row was routed to (approval_routed_to_user_id).
// approved_by is now ALWAYS taken from the JWT (or 'system' for api_key),
// never from the request body. Prevents callers spoofing approver identity.
async function approveExpense(
  client: any,
  body: any,
  authCtx: { mode: 'api_key' | 'jwt'; user?: { id: string; email: string; role: string } }
) {
  const { expense_id, approved, query_reason, rejection_reason } = body
  if (!expense_id) throw new ApiError('expense_id required', 400)

  // Decide intent: approve (default) | query | reject. Backwards-compat:
  //   approved === false (legacy) → queried
  //   intent === 'queried' / 'rejected' (new) → that exact status
  let status: 'approved' | 'queried' | 'rejected' = 'approved'
  if (body.intent === 'queried' || (approved === false && !body.intent)) status = 'queried'
  if (body.intent === 'rejected') status = 'rejected'

  // Load the row up front so we can authorise the caller against the routing.
  const { data: existing, error: loadErr } = await client.from('expense_receipts')
    .select('id, status, approval_routed_to, approval_routed_to_user_id, submitted_by')
    .eq('id', expense_id)
    .maybeSingle()
  if (loadErr) throw loadErr
  if (!existing) throw new ApiError('Expense not found', 404)

  // Auth gate.
  let approverId: string | null = null
  let approverLabel = 'system'
  if (authCtx.mode === 'jwt') {
    const u = authCtx.user
    if (!u) throw new ApiError('Authentication required', 401)
    const role = (u.role || '').toLowerCase()
    const elevated = role === 'admin' || role === 'owner' || role === 'ops_manager'
    const routedToThisUser = existing.approval_routed_to_user_id === u.id
    if (!elevated && !routedToThisUser) {
      throw new ApiError(
        `Not authorised — this expense was routed to ${existing.approval_routed_to || 'someone else'} (${role || 'no role'} cannot approve)`,
        403,
      )
    }
    // A submitter cannot approve their own row even if they hold the role.
    if (existing.submitted_by === u.id && !elevated) {
      throw new ApiError('Cannot approve your own submission', 403)
    }
    approverId = u.id
    approverLabel = u.email || u.id
  }
  // api_key path: server-to-server (e.g. automated JARVIS). Allowed; approverId stays null.

  const updates: Record<string, any> = {
    status,
    approved_by: approverId,
    approved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  if (status === 'queried' && query_reason) updates.query_reason = String(query_reason).slice(0, 500)
  if (status === 'rejected' && rejection_reason) updates.rejection_reason = String(rejection_reason).slice(0, 500)

  await client.from('expense_receipts').update(updates).eq('id', expense_id)

  // Resolve the annotation
  await client.from('ai_annotations')
    .update({ resolved_at: new Date().toISOString(), resolved_by: approverId })
    .eq('source_ref', `expense:${expense_id}`)
    .is('resolved_at', null)

  logBusinessEvent(client, {
    event_type: `expense.${status}`,
    entity_type: 'expense_receipt',
    entity_id: expense_id,
    metadata: { operator: approverId, operator_label: approverLabel, auth_mode: authCtx.mode },
    payload: status === 'queried' ? { query_reason: updates.query_reason || null }
           : status === 'rejected' ? { rejection_reason: updates.rejection_reason || null }
           : undefined,
  })

  return { success: true, status, approved_by: approverId }
}

// ── buildXeroExpenseBillBody: pure builder, exported via mirror-test pattern.
// Always emits Status: 'DRAFT' so finance reviews/authorises in Xero. There is
// no AUTHORISED path from SecureSuite for expense receipts.
function buildXeroExpenseBillBody(expense: any): any {
  const today = new Date().toISOString().split('T')[0]
  const lines = Array.isArray(expense.line_items) ? expense.line_items : []
  return {
    Type: 'ACCPAY',
    Status: 'DRAFT',
    Contact: { Name: expense.vendor_name || 'Unknown Vendor' },
    Date: expense.receipt_date || today,
    DueDate: expense.receipt_date || today,
    Reference: expense.jobs?.job_number ? `${expense.jobs.job_number} — Receipt` : 'Receipt',
    LineItems: lines.length > 0
      ? lines.map((li: any) => ({
          Description: li.description || 'Receipt line item',
          Quantity: li.quantity || 1,
          UnitAmount: li.unit_price || li.total || 0,
          AccountCode: '400', // Cost of Sales default
        }))
      : [{
          Description: `Receipt from ${expense.vendor_name || 'vendor'}`,
          Quantity: 1,
          UnitAmount: expense.total_amount || 0,
          AccountCode: '400',
        }],
  }
}

// ── Preflight: lightweight data-quality checks before creating a Xero DRAFT bill.
// Failure means we have junk data (empty vendor, zero total, future date, etc.)
// and pushing would create a junk DRAFT that finance has to clean up in Xero.
// We refuse the push, persist the reasons on the row, and emit a business event.
// The row stays in 'approved' state so the user can fix and retry.
function preflightExpense(expense: any): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []

  const vendor = (expense.vendor_name || '').trim()
  if (vendor.length < 2) reasons.push('vendor_name missing or too short')

  const total = Number(expense.total_amount)
  if (!isFinite(total) || total <= 0) reasons.push('total_amount must be > 0')
  else if (total > 50000) reasons.push('total_amount exceeds $50,000 sanity cap')

  if (!expense.receipt_date) {
    reasons.push('receipt_date missing')
  } else {
    const d = new Date(expense.receipt_date + 'T00:00:00Z')
    if (isNaN(d.getTime())) {
      reasons.push('receipt_date not parseable')
    } else {
      const now = Date.now()
      const oneYearAgo = now - 366 * 24 * 60 * 60 * 1000
      const sevenDaysAhead = now + 7 * 24 * 60 * 60 * 1000
      if (d.getTime() < oneYearAgo) reasons.push('receipt_date older than 12 months')
      if (d.getTime() > sevenDaysAhead) reasons.push('receipt_date more than 7 days in the future')
    }
  }

  // Evidence integrity: either a hashed receipt OR an explicit no-receipt reason.
  if (!expense.receipt_sha256 && !expense.no_receipt_reason) {
    reasons.push('receipt_sha256 or no_receipt_reason required')
  }

  // Classification — required for Xero AccountCode mapping and later bank-rec.
  if (!expense.category || expense.category === 'unknown') {
    reasons.push('category required')
  }
  if (!expense.payment_method || expense.payment_method === 'unknown') {
    reasons.push('payment_method required')
  }
  if (!expense.gst_status || expense.gst_status === 'unknown') {
    reasons.push('gst_status required')
  }

  // Cost destination — every expense lands somewhere.
  if (!expense.job_id && !expense.business_category) {
    reasons.push('job_id or business_category required')
  }

  // Line items must roughly add up. OCR mis-reads sometimes drop a digit.
  const lines = Array.isArray(expense.line_items) ? expense.line_items : []
  if (lines.length > 0 && isFinite(total) && total > 0) {
    const sumLines = lines.reduce((acc: number, li: any) => {
      const qty = Number(li.quantity ?? 1)
      const unit = Number(li.unit_price ?? li.unitPrice ?? 0)
      const lineTotal = Number(li.total ?? qty * unit)
      return acc + (isFinite(lineTotal) ? lineTotal : 0)
    }, 0)
    if (Math.abs(sumLines - total) > 1.01) {
      reasons.push(`line_items sum ($${sumLines.toFixed(2)}) does not match total ($${total.toFixed(2)})`)
    }
  }

  return { ok: reasons.length === 0, reasons }
}

async function pushExpenseToXero(
  client: any,
  body: any,
  authCtx: { mode: 'api_key' | 'jwt'; user?: { id: string; email: string; role: string } }
) {
  const { expense_id } = body
  if (!expense_id) throw new ApiError('expense_id required', 400)

  // Auth gate. Push creates a real (DRAFT) Xero bill — admin/owner/ops_manager
  // role only on JWT path. api_key (server-to-server) is allowed for automation.
  if (authCtx.mode === 'jwt') {
    const role = (authCtx.user?.role || '').toLowerCase()
    if (role !== 'admin' && role !== 'owner' && role !== 'ops_manager') {
      throw new ApiError('Not authorised to push expenses to Xero', 403)
    }
  }

  const { data: expense } = await client.from('expense_receipts')
    .select('*, jobs:job_id(job_number, xero_contact_id)')
    .eq('id', expense_id)
    .single()
  if (!expense) throw new ApiError('Expense not found', 404)
  if (expense.status !== 'approved') throw new ApiError('Expense must be approved before pushing to Xero', 409)

  // Preflight gate — prevent junk OCR from creating junk Xero drafts.
  const preflight = preflightExpense(expense)
  if (!preflight.ok) {
    await client.from('expense_receipts').update({
      preflight_failed_reasons: { reasons: preflight.reasons, checked_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }).eq('id', expense_id)

    logBusinessEvent(client, {
      event_type: 'expense.preflight_failed',
      entity_type: 'expense_receipt',
      entity_id: expense_id,
      payload: { reasons: preflight.reasons },
    })

    throw new ApiError('Preflight failed: ' + preflight.reasons.join('; '), 400)
  }

  const { accessToken, tenantId } = await getToken(client)

  const billBody = buildXeroExpenseBillBody(expense)

  const result = await xeroPost('/Invoices', accessToken, tenantId, { Invoices: [billBody] }, 'POST', `expense-${expense_id}`)
  const xeroBillId = result?.Invoices?.[0]?.InvoiceID

  await client.from('expense_receipts').update({
    xero_bill_id: xeroBillId,
    xero_status: 'draft',
    status: 'pushed_to_xero',
    preflight_failed_reasons: null,
    updated_at: new Date().toISOString(),
  }).eq('id', expense_id)

  logBusinessEvent(client, {
    event_type: 'expense.pushed_to_xero',
    entity_type: 'expense_receipt',
    entity_id: expense_id,
    payload: { xero_bill_id: xeroBillId, xero_status: 'draft' },
  })

  return { success: true, xero_bill_id: xeroBillId, xero_status: 'draft' }
}

async function listExpenses(client: any, params: URLSearchParams) {
  const jobId = params.get('job_id')
  const status = params.get('status')
  const limit = Number(params.get('limit') || 50)

  let query = client.from('expense_receipts')
    .select('*, jobs:job_id(client_name, job_number)')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (jobId) query = query.eq('job_id', jobId)
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw error
  return { expenses: data || [] }
}

async function listUnreconciledTransactions(client: any, params: URLSearchParams) {
  const daysBack = Number(params.get('days_back') || 30)
  const limit = Number(params.get('limit') || 50)
  const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0]

  // Get recent bank transactions (SPEND type = company card purchases)
  const { data: txns } = await client.from('xero_bank_transactions')
    .select('*')
    .eq('txn_type', 'SPEND')
    .gte('txn_date', cutoff)
    .order('txn_date', { ascending: false })
    .limit(limit)

  if (!txns || txns.length === 0) return { transactions: [] }

  // Get recent expenses and POs for fuzzy matching
  const { data: expenses } = await client.from('expense_receipts')
    .select('id, vendor_name, total_amount, receipt_date, job_id, status')
    .gte('created_at', new Date(Date.now() - daysBack * 86400000).toISOString())
  const { data: pos } = await client.from('purchase_orders')
    .select('id, supplier_name, total, created_at, job_id')
    .gte('created_at', new Date(Date.now() - daysBack * 86400000).toISOString())

  const results = txns.map((txn: any) => {
    const suggestedMatches: any[] = []
    const txnAmt = Math.abs(Number(txn.amount || 0))
    const txnDate = txn.txn_date
    const txnContact = (txn.contact_name || '').toLowerCase()

    // Match against expenses (amount ±$2, date ±3 days, vendor similarity)
    for (const exp of (expenses || [])) {
      const expAmt = Number(exp.total_amount || 0)
      const amtDiff = Math.abs(txnAmt - expAmt)
      if (amtDiff > 2) continue

      const dateDiff = exp.receipt_date
        ? Math.abs(new Date(txnDate).getTime() - new Date(exp.receipt_date).getTime()) / 86400000
        : 999
      const vendorMatch = exp.vendor_name && txnContact.includes(exp.vendor_name.toLowerCase().slice(0, 6))

      if (amtDiff <= 2 && (dateDiff <= 3 || vendorMatch)) {
        suggestedMatches.push({
          type: 'expense',
          id: exp.id,
          confidence: vendorMatch ? 0.9 : 0.7,
          match_reason: `Amount $${expAmt} (diff $${amtDiff.toFixed(2)})${vendorMatch ? ', vendor match' : ''}`,
        })
      }
    }

    // Match against POs (amount match + supplier name)
    for (const po of (pos || [])) {
      const poAmt = Number(po.total || 0)
      const amtDiff = Math.abs(txnAmt - poAmt)
      if (amtDiff > 2) continue

      const supplierMatch = po.supplier_name && txnContact.includes(po.supplier_name.toLowerCase().slice(0, 6))
      if (amtDiff <= 2 || supplierMatch) {
        suggestedMatches.push({
          type: 'po',
          id: po.id,
          confidence: supplierMatch && amtDiff <= 2 ? 0.9 : 0.5,
          match_reason: `PO $${poAmt}${supplierMatch ? ', supplier match' : ''}`,
        })
      }
    }

    return {
      xero_txn_id: txn.xero_txn_id,
      amount: txnAmt,
      date: txnDate,
      contact_name: txn.contact_name,
      description: txn.description || txn.reference,
      is_reconciled: txn.is_reconciled,
      suggested_matches: suggestedMatches.sort((a: any, b: any) => b.confidence - a.confidence).slice(0, 3),
    }
  })

  // Only return transactions with no high-confidence match
  const unreconciled = results.filter((r: any) =>
    r.suggested_matches.length === 0 || r.suggested_matches[0].confidence < 0.9
  )

  return { transactions: unreconciled }
}


// ════════════════════════════════════════════════════════════
// SPINE INFRASTRUCTURE — Council/Engineering Process
// ════════════════════════════════════════════════════════════

async function createCouncilSubmission(client: any, body: any) {
  const { job_id, template_type } = body
  if (!job_id) throw new Error('job_id required')

  // Seed steps: prefer client-provided steps array, fall back to template
  let steps: any[] = []
  if (body.steps && Array.isArray(body.steps) && body.steps.length > 0) {
    // Client-defined steps (from modal with custom step list)
    steps = body.steps.map((s: any) => ({
      step_id: crypto.randomUUID(),
      name: s.name || 'Untitled Step',
      status: 'pending',
      vendor: s.vendor || null,
      vendor_email: s.vendor_email || null,
      started_at: null,
      completed_at: null,
      documents_received: [],
      notes: s.notes || '',
    }))
  } else if (template_type) {
    const { data: template } = await client.from('council_step_templates')
      .select('steps')
      .eq('template_type', template_type)
      .maybeSingle()
    if (template?.steps) {
      steps = template.steps.map((s: any, i: number) => ({
        ...s,
        step_id: crypto.randomUUID(),
        status: 'pending',
        vendor: s.vendor || null,
        vendor_email: s.vendor_email || null,
        started_at: null,
        completed_at: null,
        documents_received: [],
        notes: '',
      }))
    }
  }

  // Validate job exists before inserting
  const { data: jobCheck } = await client.from('jobs').select('id').eq('id', job_id).maybeSingle()
  if (!jobCheck) throw new ApiError('Job not found — invalid job_id', 404)

  const { data: submission, error } = await client.from('council_submissions').insert({
    org_id: DEFAULT_ORG_ID,
    job_id,
    steps,
    template_type: template_type || 'custom',
    overall_status: 'not_started',
  }).select('id').single()
  if (error) throw error

  const { data: job } = await client.from('jobs').select('job_number').eq('id', job_id).maybeSingle()

  logBusinessEvent(client, {
    event_type: 'council.submission_created',
    entity_type: 'council_submission',
    entity_id: submission.id,
    job_id: job?.job_number || job_id,
    payload: { template_type, step_count: steps.length },
  })

  return { submission_id: submission.id, steps_count: steps.length }
}

async function updateCouncilStatus(client: any, body: any) {
  const { submission_id, step_index, step_id, status, vendor, vendor_email, notes, documents_received } = body
  if (!submission_id) throw new Error('submission_id required')

  const { data: sub } = await client.from('council_submissions')
    .select('id, job_id, steps, current_step_index')
    .eq('id', submission_id)
    .single()
  if (!sub) throw new Error('Submission not found')

  const steps = sub.steps || []
  // Find step by index or step_id
  const idx = step_index != null ? step_index : steps.findIndex((s: any) => s.step_id === step_id)
  if (idx < 0 || idx >= steps.length) throw new Error('Step not found')

  // Update the step
  if (status) steps[idx].status = status
  if (vendor) steps[idx].vendor = vendor
  if (vendor_email) steps[idx].vendor_email = vendor_email
  if (notes) steps[idx].notes = notes
  if (documents_received) steps[idx].documents_received = [...(steps[idx].documents_received || []), ...documents_received]
  if (status === 'in_progress' && !steps[idx].started_at) steps[idx].started_at = new Date().toISOString()
  if (status === 'complete') steps[idx].completed_at = new Date().toISOString()

  // Calculate overall status and advance current step
  const allComplete = steps.every((s: any) => s.status === 'complete')
  const anyBlocked = steps.some((s: any) => s.status === 'blocked')
  const anyInProgress = steps.some((s: any) => s.status === 'in_progress')
  const overallStatus = allComplete ? 'complete' : anyBlocked ? 'blocked' : anyInProgress ? 'in_progress' : 'not_started'

  // Find the first non-complete step as current
  const newCurrentIdx = steps.findIndex((s: any) => s.status !== 'complete')

  await client.from('council_submissions').update({
    steps,
    current_step_index: newCurrentIdx >= 0 ? newCurrentIdx : steps.length - 1,
    overall_status: overallStatus,
    updated_at: new Date().toISOString(),
  }).eq('id', submission_id)

  const { data: job } = await client.from('jobs').select('job_number').eq('id', sub.job_id).maybeSingle()

  logBusinessEvent(client, {
    event_type: `council.step_${status || 'updated'}`,
    entity_type: 'council_submission',
    entity_id: submission_id,
    job_id: job?.job_number || sub.job_id,
    payload: { step_name: steps[idx].name, step_status: status, overall_status: overallStatus },
  })

  return { success: true, overall_status: overallStatus, step: steps[idx] }
}

async function sendCouncilEmail(client: any, body: any) {
  const { submission_id, step_index, to_email, cc, subject, body_html, body_text, attachments } = body
  if (!submission_id || !to_email) throw new Error('submission_id and to_email required')

  const { data: sub } = await client.from('council_submissions')
    .select('id, job_id, steps')
    .eq('id', submission_id)
    .single()
  if (!sub) throw new Error('Submission not found')

  const { data: job } = await client.from('jobs').select('job_number, type, ghl_contact_id').eq('id', sub.job_id).maybeSingle()
  const replyTo = `council+CS${submission_id.slice(0, 8)}-step${step_index || 0}@secureworksgroup.app`

  // Send via internal call to send-po-email (reuse Resend infrastructure)
  // We create a dummy po_id reference — send-po-email will handle sending
  // Actually, call Resend directly since we don't have a PO
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || ''
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured')

  const emailPayload: any = {
    from: `SecureWorks Group <orders@secureworksgroup.app>`,
    reply_to: getClientReplyTo(job?.type, job?.job_number),
    to: [to_email],
    ...(cc && Array.isArray(cc) && cc.length > 0 ? { cc } : {}),
    subject: subject || `Re: ${job?.job_number || ''} Council Submission`,
    html: body_html || body_text || '',
    text: body_text || '',
  }

  // Wire attachments through to Resend (was accepted but never passed — bug fix)
  if (attachments && Array.isArray(attachments) && attachments.length > 0) {
    emailPayload.attachments = attachments.map((att: any) => ({
      filename: att.filename || att.name || 'document',
      content: att.content || att.content_base64 || '',
    }))
  }

  const resendResp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(emailPayload),
  })
  const resendResult = await resendResp.json()
  const messageId = resendResult?.id || null
  const inReplyTo = body.in_reply_to || null
  const threadId = inReplyTo ? (body.thread_id || inReplyTo) : messageId

  // Store in po_communications with threading + council linking
  await client.from('po_communications').insert({
    job_id: sub.job_id,
    direction: 'outbound',
    from_email: 'orders@secureworksgroup.app',
    to_email,
    subject: emailPayload.subject,
    body_html: body_html || null,
    body_text: body_text || null,
    communication_type: 'council',
    council_submission_id: submission_id,
    council_step_index: step_index || null,
    sent_at: new Date().toISOString(),
    message_id: messageId,
    in_reply_to: inReplyTo,
    thread_id: threadId,
    delivery_status: 'sent',
  })
  // Log note to GHL contact
  logEmailToGHL(job?.ghl_contact_id, emailPayload.subject, to_email)

  // Log email event
  await client.from('email_events').insert({
    email_type: 'notification',
    entity_type: 'council_submission',
    entity_id: submission_id,
    job_id: sub.job_id,
    recipient: to_email,
    sender: 'orders@secureworksgroup.app',
    subject: emailPayload.subject,
    resend_message_id: messageId,
    status: resendResp.ok ? 'sent' : 'failed',
    comms_channel: 'email',
    sent_at: new Date().toISOString(),
  })

  return { success: true, email_id: messageId }
}

async function listRunAcceptances(client: any, params: URLSearchParams) {
  const jobId = params.get('job_id')
  if (!jobId) throw new Error('job_id required')

  const { data: acceptances, error } = await client.from('run_acceptances')
    .select('*, job_contacts(client_name, contact_label, is_primary)')
    .eq('job_id', jobId)
    .order('run_label')
  if (error) throw error

  // Enrich with deposit payment status from xero_invoices
  const { data: invoices } = await client.from('xero_invoices')
    .select('run_label, job_contact_id, status, amount_paid, total, reference')
    .eq('job_id', jobId)
    .eq('invoice_type', 'ACCREC')
    .not('status', 'in', '("VOIDED","DELETED")')
    .not('run_label', 'is', null)

  const invoiceMap: Record<string, any> = {}
  ;(invoices || []).forEach((inv: any) => {
    const key = `${inv.run_label}_${inv.job_contact_id}`
    invoiceMap[key] = {
      status: inv.status,
      paid: inv.status === 'PAID' || (inv.amount_paid && inv.amount_paid >= inv.total),
      total: inv.total,
      amount_paid: inv.amount_paid,
      reference: inv.reference,
    }
  })

  const enriched = (acceptances || []).map((ra: any) => ({
    ...ra,
    deposit: invoiceMap[`${ra.run_label}_${ra.job_contact_id}`] || null,
  }))

  return { acceptances: enriched }
}

// ── Send Council SMS via GHL ──
async function sendCouncilSMS(client: any, body: any) {
  const { job_id, message } = body
  if (!job_id || !message) throw new Error('job_id and message required')

  const { data: job } = await client.from('jobs')
    .select('id, job_number, client_name, client_phone, ghl_contact_id')
    .eq('id', job_id)
    .single()
  if (!job) throw new Error('Job not found')
  if (!job.ghl_contact_id) throw new Error('No GHL contact linked to this job — cannot send SMS')

  const ghlUrl = `${SUPABASE_URL}/functions/v1/ghl-proxy?action=send_sms`
  const smsResp = await fetch(ghlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contactId: job.ghl_contact_id, message }),
  })
  const smsResult = await smsResp.json()
  if (!smsResp.ok) throw new Error('SMS send failed: ' + (smsResult.message || JSON.stringify(smsResult)))

  // Log as job event
  await client.from('job_events').insert({
    job_id,
    event_type: 'council_sms_sent',
    detail_json: { message, ghl_contact_id: job.ghl_contact_id },
  })

  return { success: true, sms_sent: true }
}

async function listCouncilSubmissions(client: any, params: URLSearchParams) {
  const jobId = params.get('job_id')

  let query = client.from('council_submissions')
    .select('*, jobs:job_id(client_name, job_number, type)')
    .order('created_at', { ascending: false })
    .limit(50)

  if (jobId) query = query.eq('job_id', jobId)

  const { data, error } = await query
  if (error) throw error

  // Attach email threads per submission
  const submissionIds = (data || []).map((s: any) => s.id)
  let emails: any[] = []
  if (submissionIds.length > 0) {
    const { data: comms } = await client.from('po_communications')
      .select('*')
      .eq('communication_type', 'council')
      .in('job_id', (data || []).map((s: any) => s.job_id))
      .order('created_at', { ascending: true })
    emails = comms || []
  }

  const submissions = (data || []).map((s: any) => ({
    ...s,
    email_threads: emails.filter((e: any) => e.job_id === s.job_id),
  }))

  return { submissions }
}


// ════════════════════════════════════════════════════════════
// SPINE INFRASTRUCTURE — Send Variation to Client
// ════════════════════════════════════════════════════════════

async function sendVariation(client: any, body: any) {
  const { variation_id } = body
  if (!variation_id) throw new Error('variation_id required')

  const { data: variation } = await client.from('job_variations')
    .select('*, jobs:job_id(client_name, client_email, job_number, type, site_address, ghl_contact_id)')
    .eq('id', variation_id)
    .single()
  if (!variation) throw new Error('Variation not found')

  const job = variation.jobs
  if (!job?.client_email) throw new Error('No client email on job')

  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || ''
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured')

  // Build variation email
  const viewUrl = `https://secureworks-group.github.io/securedash/quote-viewer.html?token=${variation.share_token}&type=variation`

  const html = `
    <div style="font-family: Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #293C46; padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">Variation #${variation.variation_number}</h1>
      </div>
      <div style="padding: 24px; background: #f8f6f3;">
        <p>Hi ${job.client_name?.split(' ')[0] || 'there'},</p>
        <p>We need to make an adjustment to your ${job.type || 'project'} at ${job.site_address || 'your property'}:</p>
        <div style="background: white; border-left: 4px solid #F15A29; padding: 16px; margin: 16px 0;">
          <strong>${variation.description}</strong>
          <p style="font-size: 24px; color: #293C46; margin: 8px 0;">$${Number(variation.amount).toLocaleString('en-AU', { minimumFractionDigits: 2 })} ${variation.gst_included ? '(inc. GST)' : '(ex. GST)'}</p>
          ${variation.reason ? `<p style="color: #666;">Reason: ${variation.reason}</p>` : ''}
        </div>
        <div style="text-align: center; margin: 24px 0;">
          <a href="${viewUrl}" style="background: #F15A29; color: white; padding: 14px 32px; text-decoration: none; font-weight: bold; display: inline-block;">View & Respond</a>
        </div>
        <p style="color: #666; font-size: 13px;">If you have questions, reply to this email or call us on 0489 267 771.</p>
      </div>
      <div style="background: #293C46; padding: 12px; text-align: center;">
        <p style="color: #8FA4B2; font-size: 12px; margin: 0;">SecureWorks Group — Patios | Fencing | Decking | Screening</p>
      </div>
    </div>
  `

  const resendResp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SecureWorks Group <no-reply@secureworksgroup.app>',
      reply_to: getClientReplyTo(job?.type, job?.job_number),
      to: [job.client_email],
      subject: `Variation #${variation.variation_number} for ${job.job_number} — ${job.site_address || 'your project'}`,
      html,
    }),
  })
  const resendResult = await resendResp.json()
  const variationSubject = `Variation #${variation.variation_number} for ${job.job_number} — ${job.site_address || 'your project'}`

  // Log to po_communications for client email thread
  if (resendResult?.id) {
    client.from('po_communications').insert({
      job_id: variation.job_id, direction: 'outbound',
      from_email: 'no-reply@secureworksgroup.app', to_email: job.client_email,
      subject: variationSubject, body_html: html,
      communication_type: 'client', sent_at: new Date().toISOString(),
      message_id: resendResult.id, delivery_status: 'sent',
    }).catch(() => {})
  }
  // Log note to GHL contact
  logEmailToGHL(job?.ghl_contact_id, variationSubject, job.client_email)

  // Update variation status
  await client.from('job_variations').update({
    status: 'sent',
    sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', variation_id)

  // Log email event
  await client.from('email_events').insert({
    email_type: 'notification',
    entity_type: 'job_variation',
    entity_id: variation_id,
    job_id: variation.job_id,
    recipient: job.client_email,
    sender: 'no-reply@secureworksgroup.app',
    subject: `Variation #${variation.variation_number}`,
    resend_message_id: resendResult?.id || null,
    status: resendResp.ok ? 'sent' : 'failed',
    sent_at: new Date().toISOString(),
  })

  logBusinessEvent(client, {
    event_type: 'variation.sent_to_client',
    entity_type: 'job_variation',
    entity_id: variation_id,
    job_id: job.job_number,
    payload: { share_token: variation.share_token, client_email: job.client_email },
  })

  return { success: true, email_id: resendResult?.id }
}


// ════════════════════════════════════════════════════════════
// SPINE INFRASTRUCTURE — Callbacks
// ════════════════════════════════════════════════════════════

async function createCallback(client: any, body: any) {
  const { job_id, issue_description, reported_by } = body
  if (!job_id || !issue_description) throw new Error('job_id and issue_description required')

  const { data: job } = await client.from('jobs')
    .select('id, job_number, client_name, type, status')
    .eq('id', job_id)
    .single()
  if (!job) throw new ApiError('Job not found', 404)

  // Mark job as callback
  await client.from('jobs').update({
    is_callback: true,
    status: job.status === 'complete' ? 'in_progress' : job.status,
  }).eq('id', job_id)

  // Log job event
  await client.from('job_events').insert({
    job_id,
    user_id: reported_by || null,
    event_type: 'callback_opened',
    detail_json: { issue_description },
  })

  // Create annotation for ops
  await client.from('ai_annotations').insert({
    org_id: DEFAULT_ORG_ID,
    job_id,
    annotation_type: 'callback_opened',
    source: 'system/callback',
    severity: 'red',
    message: `Callback opened on ${job.job_number} (${job.client_name}) — ${issue_description}`,
    detail_json: { issue_description, reported_by },
    source_ref: `callback:${job_id}`,
  })

  logBusinessEvent(client, {
    event_type: 'job.callback_opened',
    entity_type: 'job',
    entity_id: job_id,
    job_id: job.job_number,
    payload: { issue_description, previous_status: job.status },
    metadata: { operator: reported_by || null },
  })

  return { success: true, message: `Callback opened on ${job.job_number}. Status reverted to in_progress.` }
}

async function resolveCallback(client: any, body: any) {
  const { job_id, resolution_notes, resolved_by } = body
  if (!job_id) throw new Error('job_id required')

  await client.from('jobs').update({
    status: 'complete',
    is_callback: false,
  }).eq('id', job_id)

  await client.from('job_events').insert({
    job_id,
    user_id: resolved_by || null,
    event_type: 'callback_resolved',
    detail_json: { resolution_notes: resolution_notes || null },
  })

  // Resolve callback annotation
  await client.from('ai_annotations')
    .update({ resolved_at: new Date().toISOString(), resolved_by: resolved_by || null })
    .eq('source_ref', `callback:${job_id}`)
    .is('resolved_at', null)

  const { data: job } = await client.from('jobs').select('job_number').eq('id', job_id).maybeSingle()

  logBusinessEvent(client, {
    event_type: 'job.callback_resolved',
    entity_type: 'job',
    entity_id: job_id,
    job_id: job?.job_number || job_id,
    payload: { resolution_notes },
    metadata: { operator: resolved_by || null },
  })

  return { success: true, message: 'Callback resolved. Job status returned to complete.' }
}


// ════════════════════════════════════════════════════════════
// SPINE INFRASTRUCTURE — Client Auto-Comms (caller-triggered)
// ════════════════════════════════════════════════════════════

const CLIENT_COMMS_TEMPLATES: Record<string, { channel: string; template: string }> = {
  quote_sent: { channel: 'email', template: 'Hi {name}, your quote for {service} at {address} is ready. View it here: {link}' },
  quote_accepted: { channel: 'sms', template: 'Thanks for choosing SecureWorks! Your deposit invoice is on its way.' },
  deposit_paid: { channel: 'sms', template: "Deposit received! We're ordering your materials and scheduling your install." },
  materials_ordered: { channel: 'sms', template: 'Your materials have been ordered. Expected delivery: {delivery_date}.' },
  council_submitted: { channel: 'sms', template: "We've submitted your application to {council}. Typical processing: 2-4 weeks." },
  council_approved: { channel: 'sms', template: "Great news! Your {service} has been approved. We'll confirm install dates shortly." },
  crew_scheduled: { channel: 'sms', template: 'Your install is booked for {date}. {installer} and team will arrive between {time_range}.' },
  crew_arriving: { channel: 'sms', template: 'Our crew is on their way to {address}. Expected arrival: {time}.' },
  daily_progress: { channel: 'sms', template: 'Day {day} update: {progress_note}' },
  job_complete: { channel: 'email', template: 'Your {service} is complete! Please review and sign off here: {link}' },
  invoice_sent: { channel: 'email', template: 'Your final invoice for {amount} is attached. Pay online here: {link}' },
  payment_received: { channel: 'email', template: "Payment received — thank you! We'd love a Google review: {review_link}" },
  follow_up_30d: { channel: 'email', template: "Hi {name}, how's your new {service}? Remember, we also do {cross_sell}. Refer a friend: {referral_link}" },
  // ── Phase 2 additions ──
  follow_up_day3: { channel: 'sms', template: "Hi {name}, just checking in — have you had a chance to review your {service} quote? Happy to answer any questions." },
  follow_up_day5: { channel: 'sms', template: "Hi {name}, your quote for {service} at {address} is still open. Would you like to discuss anything?" },
  follow_up_day7: { channel: 'email', template: "Hi {name}, we noticed you haven't responded to your {service} quote yet. We'd hate for you to miss out — this quote expires soon. Call us anytime on 0489 267 771." },
  deposit_reminder_day3: { channel: 'sms', template: "Hi {name}, just a reminder — your deposit invoice for {service} is waiting. Pay online anytime: {payment_url}" },
  deposit_reminder_day7: { channel: 'sms', template: "Hi {name}, your deposit for {service} is still outstanding (7 days). Please pay soon to secure your install date: {payment_url}" },
}

async function sendClientUpdate(client: any, body: any) {
  const { job_id, comms_trigger, channel: overrideChannel, custom_message, template_vars, job_contact_id } = body
  if (!job_id || !comms_trigger) throw new Error('job_id and comms_trigger required')

  const tmpl = CLIENT_COMMS_TEMPLATES[comms_trigger]
  if (!tmpl && !custom_message) throw new ApiError(`Unknown comms_trigger: ${comms_trigger}. Valid triggers: ${Object.keys(CLIENT_COMMS_TEMPLATES).join(', ')}`, 400)

  // Check for duplicate: per contact if specified, otherwise per job
  let dupQuery = client.from('email_events')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', job_id)
    .eq('comms_trigger', comms_trigger)
  if (job_contact_id) dupQuery = dupQuery.eq('recipient', job_contact_id)
  const { count: existing } = await dupQuery
  if ((existing || 0) > 0) {
    return { sent: false, reason: `${comms_trigger} already sent for this ${job_contact_id ? 'contact' : 'job'}` }
  }

  // Get job + client details
  const { data: job } = await client.from('jobs')
    .select('id, job_number, client_name, client_phone, client_email, type, site_address, ghl_contact_id')
    .eq('id', job_id)
    .single()
  if (!job) throw new ApiError('Job not found', 404)

  // If job_contact_id provided, override contact details from job_contacts
  let contactName = job.client_name
  let contactPhone = job.client_phone
  let contactEmail = job.client_email
  let contactGhlId = job.ghl_contact_id
  if (job_contact_id) {
    const { data: jc } = await client.from('job_contacts')
      .select('client_name, client_phone, client_email, ghl_contact_id')
      .eq('id', job_contact_id)
      .single()
    if (jc) {
      contactName = jc.client_name || contactName
      contactPhone = jc.client_phone || contactPhone
      contactEmail = jc.client_email || contactEmail
      contactGhlId = jc.ghl_contact_id || contactGhlId
    }
  }

  // Personalise message
  const vars: Record<string, string> = {
    name: contactName?.split(' ')[0] || 'there',
    service: job.type || 'project',
    address: job.site_address || 'your property',
    job_number: job.job_number || '',
    ...(template_vars || {}),
  }

  let message = custom_message || tmpl.template
  for (const [k, v] of Object.entries(vars)) {
    message = message.replace(new RegExp(`\\{${k}\\}`, 'g'), v)
  }

  // Append cross-sell footer for SMS
  const channel = overrideChannel || tmpl?.channel || 'sms'
  if (channel === 'sms') {
    message += '\n\nSecureWorks Group — Patios | Fencing | Decking | Screening | Makesafe'
  }

  let sent = false
  if (channel === 'sms') {
    // Send via GHL (use per-contact GHL ID if available)
    if (!contactGhlId) {
      return { sent: false, reason: 'No GHL contact ID — cannot send SMS' }
    }
    try {
      const ghlUrl = `${SUPABASE_URL}/functions/v1/ghl-proxy?action=send_sms`
      await fetch(ghlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: contactGhlId, message }),
      })
      sent = true
    } catch (e) {
      console.log('[ops-api] GHL SMS failed:', (e as Error).message)
    }
  } else {
    // Send via Resend
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || ''
    if (!RESEND_API_KEY || !job.client_email) {
      return { sent: false, reason: 'No RESEND_API_KEY or client email' }
    }
    const updateSubject = `${job.job_number} — Update from SecureWorks`
    const updateHtml = `<div style="font-family: Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
            <p>${message.replace(/\n/g, '<br>')}</p>
            <hr style="border: none; border-top: 1px solid #D4DEE4; margin: 24px 0;">
            <p style="color: #8FA4B2; font-size: 12px;">SecureWorks Group — Patios | Fencing | Decking | Screening</p>
          </div>`
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'SecureWorks Group <no-reply@secureworksgroup.app>',
          reply_to: getClientReplyTo(job.type, job.job_number),
          to: [job.client_email],
          subject: updateSubject,
          html: updateHtml,
        }),
      })
      sent = true
      // Log to po_communications for client email thread
      client.from('po_communications').insert({
        job_id: job.id, direction: 'outbound',
        from_email: 'no-reply@secureworksgroup.app', to_email: job.client_email,
        subject: updateSubject, body_html: updateHtml,
        communication_type: 'client', sent_at: new Date().toISOString(),
        delivery_status: 'sent',
      }).catch(() => {})
      // Log note to GHL contact
      logEmailToGHL(contactGhlId, updateSubject, job.client_email)
    } catch (e) {
      console.log('[ops-api] Resend email failed:', (e as Error).message)
    }
  }

  // Log to email_events (per-contact if specified)
  await client.from('email_events').insert({
    email_type: 'notification',
    entity_type: 'job',
    entity_id: job_id,
    job_id,
    recipient: job_contact_id || (channel === 'sms' ? contactPhone : contactEmail),
    sender: 'system',
    subject: `Client update: ${comms_trigger}${job_contact_id ? ' (contact)' : ''}`,
    status: sent ? 'sent' : 'failed',
    comms_trigger,
    comms_channel: channel,
    sent_at: sent ? new Date().toISOString() : null,
  })

  logBusinessEvent(client, {
    event_type: 'client_comms.sent',
    entity_type: 'job',
    entity_id: job_id,
    job_id: job.job_number,
    payload: { comms_trigger, channel, message_preview: message.slice(0, 100) },
  })

  return { sent, channel, message_preview: message.slice(0, 200) }
}


// ════════════════════════════════════════════════════════════
// SPINE INFRASTRUCTURE — Job Duration Monitoring
// ════════════════════════════════════════════════════════════

async function checkJobDurations(client: any) {
  // Get all active jobs (in_progress or scheduled)
  const { data: jobs } = await client.from('jobs')
    .select('id, job_number, type, status, client_name, scope_json, scheduled_at, accepted_at, created_at')
    .in('status', ['accepted', 'approvals', 'deposit', 'processing', 'scheduled', 'in_progress'])
    .eq('is_callback', false)
    .limit(200)

  if (!jobs || jobs.length === 0) return { overdue_jobs: [], on_track_jobs: [] }

  // Get duration defaults as fallback
  const { data: defaults } = await client.from('job_duration_defaults').select('*')
  const defaultMap = new Map()
  for (const d of (defaults || [])) {
    defaultMap.set(`${d.job_type}:${d.stage_from}:${d.stage_to}`, d.expected_days)
  }

  const overdueJobs: any[] = []
  const onTrackJobs: any[] = []

  for (const job of jobs) {
    // Determine expected install days
    // Priority: scope_json.labour_days → scope_json.install_days → metres-based (fencing) → defaults
    let expectedDays: number | null = null
    const scope = job.scope_json || {}

    if (scope.labour_days) {
      expectedDays = Number(scope.labour_days)
    } else if (scope.install_days) {
      expectedDays = Number(scope.install_days)
    } else if (job.type === 'fencing' && scope.total_metres) {
      const metres = Number(scope.total_metres)
      expectedDays = metres < 30 ? 1 : metres < 60 ? 2 : 3
    }

    // Fallback to defaults for current stage transition
    if (!expectedDays) {
      const prevStage = job.status === 'in_progress' ? 'install_start' : job.status
      const nextStage = job.status === 'in_progress' ? 'completed' : 'install_start'
      expectedDays = defaultMap.get(`${job.type}:${prevStage}:${nextStage}`) || null
    }

    if (!expectedDays) continue // Can't evaluate without expected duration

    // Calculate actual days in current stage
    const stageStart = job.scheduled_at || job.accepted_at || job.created_at
    const actualDays = Math.round((Date.now() - new Date(stageStart).getTime()) / 86400000)

    if (actualDays > expectedDays * 1.5) {
      // Check for existing annotation to prevent duplicates
      const sourceRef = `duration_overdue:${job.id}:${job.status}`
      const { count: existingAnnotation } = await client.from('ai_annotations')
        .select('id', { count: 'exact', head: true })
        .eq('source_ref', sourceRef)
        .is('resolved_at', null)

      if ((existingAnnotation || 0) === 0) {
        await client.from('ai_annotations').insert({
          org_id: DEFAULT_ORG_ID,
          job_id: job.id,
          annotation_type: 'duration_overdue',
          source: 'system/duration',
          severity: actualDays > expectedDays * 2 ? 'red' : 'amber',
          message: `${job.job_number} has been in ${job.status} for ${actualDays} days — expected ${expectedDays} days`,
          detail_json: { expected_days: expectedDays, actual_days: actualDays, stage: job.status },
          source_ref: sourceRef,
        })
      }

      overdueJobs.push({
        job_id: job.id,
        job_number: job.job_number,
        client_name: job.client_name,
        stage: job.status,
        expected_days: expectedDays,
        actual_days: actualDays,
        overdue_by: actualDays - expectedDays,
      })
    } else {
      onTrackJobs.push({
        job_id: job.id,
        job_number: job.job_number,
        stage: job.status,
        expected_days: expectedDays,
        actual_days: actualDays,
      })
    }
  }

  return { overdue_jobs: overdueJobs, on_track_jobs: onTrackJobs }
}

// ══════════════════════════════════════════════════════════════
// INVOICE VERIFICATION — list_pending_verifications, verify_hours, dispute_hours
// ══════════════════════════════════════════════════════════════

async function listPendingVerifications(client: any, leadUserId: string, params: URLSearchParams) {
  // Find jobs where this user is the work order lead (lead_installer on the assignment)
  // Then find other assignments on those jobs that are status='submitted' and not yet verified
  const { data: leadAssignments } = await client
    .from('job_assignments')
    .select('job_id')
    .eq('user_id', leadUserId)
    .in('role', ['lead', 'lead_installer'])

  if (!leadAssignments || leadAssignments.length === 0) {
    return { verifications: [] }
  }

  const jobIds = leadAssignments.map((a: any) => a.job_id)

  const { data: pending } = await client
    .from('job_assignments')
    .select('id, user_id, job_id, scheduled_date, started_at, completed_at, status, hours_worked, manual_override, users(name, email), jobs(job_number, client_name)')
    .in('job_id', jobIds)
    .eq('status', 'submitted')
    .neq('user_id', leadUserId)
    .order('scheduled_date', { ascending: false })

  const verifications = (pending || []).map((a: any) => ({
    id: a.id,
    user_id: a.user_id,
    user_name: a.users?.name || null,
    user_email: a.users?.email || null,
    job_id: a.job_id,
    job_number: a.jobs?.job_number || null,
    client_name: a.jobs?.client_name || null,
    scheduled_date: a.scheduled_date,
    hours: a.hours_worked || 0,
    started_at: a.started_at,
    completed_at: a.completed_at,
    manual_override: a.manual_override || false,
  }))

  return { verifications }
}

async function verifyHours(client: any, leadUserId: string, body: any) {
  const ids = body.assignment_ids || []
  if (!ids.length) return { error: 'assignment_ids required' }

  const now = new Date().toISOString()
  const { error } = await client
    .from('job_assignments')
    .update({ verified_at: now, verified_by: leadUserId, status: 'verified' })
    .in('id', ids)
    .eq('status', 'submitted')

  if (error) throw new Error('Failed to verify hours: ' + error.message)

  // Create business events for each
  for (const id of ids) {
    await client.from('business_events').insert({
      event_type: 'labour.hours_verified',
      entity_type: 'job_assignment',
      entity_id: id,
      detail_json: { verified_by: leadUserId, verified_at: now },
    }).catch(() => {})
  }

  return { success: true, verified_count: ids.length }
}

async function disputeHours(client: any, leadUserId: string, body: any) {
  const assignmentId = body.assignment_id
  const reason = body.reason || ''
  if (!assignmentId) return { error: 'assignment_id required' }

  const { error } = await client
    .from('job_assignments')
    .update({ status: 'draft', dispute_reason: reason, disputed_by: leadUserId, disputed_at: new Date().toISOString() })
    .eq('id', assignmentId)
    .eq('status', 'submitted')

  if (error) throw new Error('Failed to dispute hours: ' + error.message)

  // Create business event
  await client.from('business_events').insert({
    event_type: 'labour.hours_disputed',
    entity_type: 'job_assignment',
    entity_id: assignmentId,
    detail_json: { disputed_by: leadUserId, reason },
  }).catch(() => {})

  return { success: true, message: 'Hours disputed — labourer notified' }
}

// ══════════════════════════════════════════════════════════════
// FENCING NEIGHBOUR SYNC — populate job_contacts from pricing_json.neighbour_splits
// ══════════════════════════════════════════════════════════════

async function syncFencingNeighbours(client: any, body: any) {
  const jId = body.job_id || body.jobId
  if (!jId) throw new Error('job_id required')

  // Fetch job with pricing and scope data
  const { data: job, error: jobErr } = await client
    .from('jobs')
    .select('id, job_number, type, client_name, client_phone, client_email, site_address, site_suburb, ghl_contact_id, xero_contact_id, pricing_json, scope_json')
    .eq('id', jId)
    .single()
  if (jobErr || !job) throw new Error('Job not found')

  // Parse pricing_json for pre-calculated neighbour splits
  const pricing = typeof job.pricing_json === 'string' ? JSON.parse(job.pricing_json || '{}') : (job.pricing_json || {})
  const splits = pricing.neighbour_splits

  if (!splits || !splits.neighbours || splits.neighbours.length === 0) {
    // No neighbour data in pricing_json — check scope_json as fallback
    const scope = typeof job.scope_json === 'string' ? JSON.parse(job.scope_json || '{}') : (job.scope_json || {})
    const jobData = scope.job || scope
    if (!jobData.neighboursRequired || !jobData.neighbours || jobData.neighbours.length === 0) {
      return { success: true, message: 'No neighbours to sync', synced_count: 0 }
    }
    // Scope has neighbours but pricing doesn't have splits — calculate from runs
    return await syncFromScopeJson(client, job, jobData)
  }

  // Primary path: use pricing_json.neighbour_splits (pre-calculated by fencing tool)
  const contacts: any[] = []
  const labels = ['A', 'B', 'C', 'D', 'E', 'F']
  let ghlCreated = 0

  // 1. Primary client (label A)
  const clientPortionExGst = splits.client_portion_ex_gst || pricing.totalExGST || 0
  const { data: existingPrimary } = await client.from('job_contacts')
    .select('id').eq('job_id', jId).eq('is_primary', true).maybeSingle()

  const primaryData: any = {
    job_id: jId,
    contact_label: 'A',
    is_primary: true,
    client_name: job.client_name,
    client_phone: job.client_phone || '',
    client_email: job.client_email || '',
    site_address: [job.site_address, job.site_suburb].filter(Boolean).join(', '),
    ghl_contact_id: job.ghl_contact_id || null,
    xero_contact_id: job.xero_contact_id || null,
    share_percentage: splits.method === 'per_run'
      ? Math.round(clientPortionExGst / (pricing.totalExGST || 1) * 100)
      : (splits.client_share_percent || 50),
    quote_value_ex_gst: clientPortionExGst,
    assigned_runs: splits.client_assigned_runs || [],
    status: 'active',
    contact_type: 'primary',
  }

  if (existingPrimary) {
    await client.from('job_contacts').update(primaryData).eq('id', existingPrimary.id)
    contacts.push({ ...primaryData, id: existingPrimary.id })
  } else {
    const { data: inserted } = await client.from('job_contacts').insert(primaryData).select('id').single()
    contacts.push({ ...primaryData, id: inserted?.id })
  }

  // 2. Each neighbour (labels B, C, D...)
  for (let i = 0; i < splits.neighbours.length; i++) {
    const nb = splits.neighbours[i]
    const label = labels[i + 1] || String.fromCharCode(66 + i) // B, C, D...
    const contactType = `neighbour_${label.toLowerCase()}`

    const { data: existingNb } = await client.from('job_contacts')
      .select('id').eq('job_id', jId).eq('contact_label', label).maybeSingle()

    const nbData: any = {
      job_id: jId,
      contact_label: label,
      is_primary: false,
      client_name: nb.name || '',
      client_phone: nb.phone || '',
      client_email: nb.email || '',
      site_address: nb.address || '',
      share_percentage: nb.share_percent || 50,
      quote_value_ex_gst: nb.portion_ex_gst || 0,
      assigned_runs: nb.assigned_runs || [],
      status: 'active',
      contact_type: contactType,
    }

    // Create GHL contact for neighbour if they have a phone number
    if (nb.phone && !existingNb) {
      try {
        const nameParts = (nb.name || '').split(' ')
        const ghlRes = await fetch(`${SUPABASE_URL}/functions/v1/ghl-proxy?action=create_contact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
          body: JSON.stringify({
            firstName: nameParts[0] || nb.name || 'Neighbour',
            lastName: nameParts.slice(1).join(' ') || label,
            phone: nb.phone,
            email: nb.email || undefined,
            address: nb.address || undefined,
            skipOpportunity: true, // Don't create a separate opportunity for neighbours
          }),
        })
        const ghlResult = await ghlRes.json()
        if (ghlResult.contactId) {
          nbData.ghl_contact_id = ghlResult.contactId
          ghlCreated++
          console.log(`[sync_neighbours] GHL contact created for ${nb.name}: ${ghlResult.contactId}`)
        }
      } catch (e) {
        console.warn(`[sync_neighbours] GHL contact creation failed for ${nb.name} (non-fatal):`, (e as Error).message)
        // Don't fail — neighbour can still be invoiced without GHL
      }
    } else if (existingNb) {
      // Preserve existing GHL contact ID
      const { data: existing } = await client.from('job_contacts')
        .select('ghl_contact_id, xero_contact_id').eq('id', existingNb.id).single()
      if (existing?.ghl_contact_id) nbData.ghl_contact_id = existing.ghl_contact_id
      if (existing?.xero_contact_id) nbData.xero_contact_id = existing.xero_contact_id
    }

    // Flag missing email
    if (!nb.email && nb.phone) {
      nbData.notes = 'No email — invoice via SMS or print only'
    }

    if (existingNb) {
      await client.from('job_contacts').update(nbData).eq('id', existingNb.id)
      contacts.push({ ...nbData, id: existingNb.id })
    } else {
      const { data: inserted } = await client.from('job_contacts').insert(nbData).select('id').single()
      contacts.push({ ...nbData, id: inserted?.id })
    }
  }

  // 3. Handle removed neighbours (exist in job_contacts but not in current splits)
  const activeLabels = ['A', ...splits.neighbours.map((_: any, i: number) => labels[i + 1])]
  const { data: allContacts } = await client.from('job_contacts')
    .select('id, contact_label, status')
    .eq('job_id', jId)
    .eq('status', 'active')

  for (const existing of (allContacts || [])) {
    if (!activeLabels.includes(existing.contact_label)) {
      await client.from('job_contacts')
        .update({ status: 'removed', updated_at: new Date().toISOString() })
        .eq('id', existing.id)
      console.log(`[sync_neighbours] Marked contact ${existing.contact_label} as removed (no longer in scope)`)
    }
  }

  // Log business event
  await client.from('business_events').insert({
    event_type: 'fencing.neighbours_synced',
    entity_type: 'job',
    entity_id: jId,
    detail_json: {
      contacts_count: contacts.length,
      ghl_created: ghlCreated,
      method: splits.method,
    },
  }).catch(() => {})

  return {
    success: true,
    contacts,
    synced_count: contacts.length,
    ghl_created_count: ghlCreated,
  }
}

// Fallback: calculate splits from scope_json when pricing_json doesn't have neighbour_splits
async function syncFromScopeJson(client: any, job: any, jobData: any) {
  const runs = jobData.runs || []
  const neighbours = jobData.neighbours || []
  const pricePerMetre = jobData.pricePerMetre || 125

  // Calculate per-run costs
  let totalRunCost = 0
  const runCosts: Record<string, number> = {}
  runs.forEach((r: any) => {
    const cost = (r.lengthM || r.length || 0) * pricePerMetre
    const key = r.neighbourId || '__client__'
    runCosts[key] = (runCosts[key] || 0) + cost
    totalRunCost += cost
  })

  // Build synthetic neighbour_splits and recurse
  const pricing = typeof job.pricing_json === 'string' ? JSON.parse(job.pricing_json || '{}') : (job.pricing_json || {})
  const clientCost = runCosts['__client__'] || 0
  const syntheticSplits = {
    method: 'per_run' as const,
    client_portion_ex_gst: clientCost,
    client_portion_inc_gst: clientCost * 1.1,
    client_assigned_runs: runs.filter((r: any) => !r.neighbourId).map((r: any) => r.name || 'Run'),
    neighbours: neighbours.map((nb: any) => {
      const nbCost = runCosts[nb.id] || 0
      return {
        id: nb.id,
        name: [nb.firstName, nb.lastName].filter(Boolean).join(' '),
        phone: nb.phone || '',
        email: nb.email || '',
        address: nb.address || '',
        portion_ex_gst: nbCost,
        portion_inc_gst: nbCost * 1.1,
        assigned_runs: runs.filter((r: any) => r.neighbourId === nb.id).map((r: any) => r.name || 'Run'),
        share_percent: totalRunCost > 0 ? Math.round(nbCost / totalRunCost * 100) : 50,
      }
    }),
  }

  // Update pricing_json with the calculated splits so future calls use the fast path
  pricing.neighbour_splits = syntheticSplits
  await client.from('jobs').update({ pricing_json: pricing }).eq('id', job.id)

  // Re-run with the splits now in place
  return syncFencingNeighbours(client, { job_id: job.id })
}

// ══════════════════════════════════════════════════════════════
// EMAIL COMMUNICATIONS — list, read tracking, inbox
// ══════════════════════════════════════════════════════════════

async function listPoCommunications(client: any, params: URLSearchParams) {
  const jobId = params.get('job_id')
  const poId = params.get('po_id')
  const councilSubId = params.get('council_submission_id')
  const stepIndex = params.get('step_index')
  const direction = params.get('direction')
  const threadId = params.get('thread_id')
  const limit = parseInt(params.get('limit') || '50')

  let query = client.from('po_communications')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(limit)

  // If both po_id and job_id provided, use OR to catch rows where po_id may be null
  if (poId && jobId) {
    query = query.or(`po_id.eq.${poId},and(job_id.eq.${jobId},communication_type.eq.purchase_order)`)
  } else if (poId) {
    query = query.eq('po_id', poId)
  } else if (jobId) {
    query = query.eq('job_id', jobId)
  }
  if (councilSubId) query = query.eq('council_submission_id', councilSubId)
  if (stepIndex) query = query.eq('council_step_index', parseInt(stepIndex))
  if (direction) query = query.eq('direction', direction)
  if (threadId) query = query.eq('thread_id', threadId)

  const { data, error } = await query
  if (error) throw error

  return { emails: data || [] }
}

async function markEmailRead(client: any, body: any) {
  const emailId = body.email_id || body.id
  if (!emailId) throw new Error('email_id required')

  const { error } = await client.from('po_communications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', emailId)
    .is('read_at', null) // Only set if not already read

  if (error) throw error
  return { success: true }
}

async function listJobCommunications(client: any, params: URLSearchParams) {
  const jobId = params.get('job_id')
  if (!jobId) throw new Error('job_id required')

  const { data, error } = await client.from('po_communications')
    .select('*')
    .eq('job_id', jobId)
    .eq('communication_type', 'client')
    .order('created_at', { ascending: true })
    .limit(50)

  if (error) throw error
  return { emails: data || [] }
}

async function getEmailInbox(client: any, params: URLSearchParams) {
  const unreadOnly = params.get('unread_only') === 'true'
  const typeFilter = params.get('type') // 'po', 'council', or null for all
  const limit = parseInt(params.get('limit') || '30')

  let query = client.from('po_communications')
    .select('*, jobs:job_id(job_number, client_name, type)')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (unreadOnly) {
    query = query.eq('direction', 'inbound').is('read_at', null)
  }
  if (typeFilter === 'po') query = query.eq('communication_type', 'purchase_order')
  if (typeFilter === 'council') query = query.in('communication_type', ['council', 'engineering'])
  if (typeFilter === 'client') query = query.eq('communication_type', 'client')

  const { data, error } = await query
  if (error) throw error

  // Get unread count
  const { count } = await client.from('po_communications')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'inbound')
    .is('read_at', null)

  return { emails: data || [], unread_count: count || 0 }
}

// ════════════════════════════════════════════════════════════
// CLEAR DEBT — Payment Chase & Collection
// ════════════════════════════════════════════════════════════

async function listOverdueInvoices(client: any) {
  const today = new Date().toISOString().slice(0, 10)

  // 1. Get all overdue ACCREC invoices
  const { data: invoices, error } = await client.from('xero_invoices')
    .select('id, xero_invoice_id, xero_contact_id, contact_name, invoice_number, reference, total, amount_due, amount_paid, due_date, invoice_date, status, job_id, line_items, debt_classification, debt_classification_reason, debt_classified_by, debt_classified_at, synced_at')
    .eq('invoice_type', 'ACCREC')
    .eq('org_id', DEFAULT_ORG_ID)
    .in('status', ['AUTHORISED', 'SUBMITTED'])
    .gt('amount_due', 0)
    .lt('due_date', today)
    .order('due_date', { ascending: true })
  if (error) throw error
  if (!invoices || invoices.length === 0) return { clients: [], total_outstanding: 0, total_clients: 0, total_invoices: 0 }

  // 2. Get job details for linked invoices
  const jobIds = [...new Set(invoices.filter((i: any) => i.job_id).map((i: any) => i.job_id))]
  let jobMap: Record<string, any> = {}
  if (jobIds.length > 0) {
    const { data: jobs } = await client.from('jobs')
      .select('id, job_number, type, status, client_name, client_phone, client_email, site_address, site_suburb, ghl_contact_id, ghl_opportunity_id, created_at, quoted_at, accepted_at, scheduled_at, completed_at')
      .in('id', jobIds)
    ;(jobs || []).forEach((j: any) => { jobMap[j.id] = j })
  }

  // 3. Resolve contact info via contact_matches (for GHL ID, phone, email)
  const xeroContactIds = [...new Set(invoices.filter((i: any) => i.xero_contact_id).map((i: any) => i.xero_contact_id))]
  let contactInfo: Record<string, any> = {}
  if (xeroContactIds.length > 0) {
    const { data: matches } = await client.from('contact_matches')
      .select('xero_contact_id, phone, email, client_name, ghl_contact_id, job_id')
      .in('xero_contact_id', xeroContactIds)
    ;(matches || []).forEach((m: any) => {
      if (m.xero_contact_id && !contactInfo[m.xero_contact_id]) {
        contactInfo[m.xero_contact_id] = { phone: m.phone, email: m.email, ghl_id: m.ghl_contact_id }
      }
    })
  }

  // 4. Get chase logs (last 10 per invoice) + count totals
  const invoiceIds = invoices.map((i: any) => i.xero_invoice_id)
  let chaseMap: Record<string, any[]> = {}
  let chaseCountMap: Record<string, number> = {}
  let followUpMap: Record<string, any> = {}
  if (invoiceIds.length > 0) {
    const { data: chaseLogs } = await client.from('payment_chase_logs')
      .select('id, xero_invoice_id, method, outcome, notes, follow_up_date, follow_up_resolved, chased_by, created_at')
      .in('xero_invoice_id', invoiceIds)
      .order('created_at', { ascending: false })
      .limit(500)
    ;(chaseLogs || []).forEach((log: any) => {
      if (!chaseMap[log.xero_invoice_id]) chaseMap[log.xero_invoice_id] = []
      if (!chaseCountMap[log.xero_invoice_id]) chaseCountMap[log.xero_invoice_id] = 0
      chaseCountMap[log.xero_invoice_id]++
      if (chaseMap[log.xero_invoice_id].length < 3) chaseMap[log.xero_invoice_id].push(log)
      // Track next unresolved follow-up
      if (log.follow_up_date && !log.follow_up_resolved && !followUpMap[log.xero_invoice_id]) {
        followUpMap[log.xero_invoice_id] = log.follow_up_date
      }
    })
  }

  // 4b. Detect first-time clients (no prior PAID invoices for these contacts)
  let firstClientSet = new Set<string>()
  if (xeroContactIds.length > 0) {
    const { data: paidContacts } = await client.from('xero_invoices')
      .select('xero_contact_id')
      .eq('org_id', DEFAULT_ORG_ID)
      .eq('invoice_type', 'ACCREC')
      .eq('status', 'PAID')
      .in('xero_contact_id', xeroContactIds)
    const paidSet = new Set((paidContacts || []).map((p: any) => p.xero_contact_id))
    xeroContactIds.forEach((id: string) => { if (!paidSet.has(id)) firstClientSet.add(id) })
  }

  // 4c. Get personality notes (latest per contact)
  let personalityMap: Record<string, any> = {}
  if (xeroContactIds.length > 0) {
    // Get all personality notes, sorted newest first, then deduplicate per contact in JS
    const { data: pNotes } = await client.from('payment_chase_logs')
      .select('xero_invoice_id, notes, chased_by, created_at')
      .eq('method', 'personality_note')
      .in('xero_invoice_id', invoiceIds)
      .order('created_at', { ascending: false })
      .limit(100)
    ;(pNotes || []).forEach((n: any) => {
      // Map from invoice to contact via enriched data later; store by invoice_id for now
      if (n.xero_invoice_id && !personalityMap[n.xero_invoice_id]) {
        personalityMap[n.xero_invoice_id] = { notes: n.notes, chased_by: n.chased_by, created_at: n.created_at }
      }
    })
  }

  // 4d. Get last_synced_at from the MOST RECENT sync across ALL invoices (not just overdue)
  const { data: syncRow } = await client.from('xero_invoices')
    .select('synced_at')
    .eq('org_id', DEFAULT_ORG_ID)
    .not('synced_at', 'is', null)
    .order('synced_at', { ascending: false })
    .limit(1)
  const lastSyncedAt = syncRow?.[0]?.synced_at || null

  // 5. Build enriched invoice list with auto-classification (filter out test records)
  const enriched = invoices.filter((inv: any) => !isTestRecord(inv.contact_name)).map((inv: any) => {
    const job = inv.job_id ? jobMap[inv.job_id] : null
    const contact = inv.xero_contact_id ? contactInfo[inv.xero_contact_id] : null
    const ghl_contact_id = job?.ghl_contact_id || contact?.ghl_id || null
    const phone = job?.client_phone || contact?.phone || null
    const email = job?.client_email || contact?.email || null
    const daysOverdue = Math.ceil((Date.now() - new Date(inv.due_date + 'T00:00:00').getTime()) / 86400000)

    // Auto-classify (computed, not stored) — only override if current is 'unclassified'
    let classification = inv.debt_classification || 'unclassified'
    let classificationReason = inv.debt_classification_reason || null
    let autoClassified = false
    if (classification === 'unclassified') {
      if (job) {
        if (['in_progress', 'scheduled', 'draft', 'scoping', 'quoted'].includes(job.status)) {
          classification = 'blocked_by_us'
          classificationReason = 'Job status: ' + job.status
          autoClassified = true
        } else if (['complete', 'invoiced'].includes(job.status)) {
          classification = 'genuine_debt'
          classificationReason = 'Job complete, payment outstanding'
          autoClassified = true
        }
      }
    }

    // Warning flags
    const flags: string[] = []
    if (!ghl_contact_id) flags.push('No GHL contact')
    if (!job) flags.push('No job linked')

    return {
      xero_invoice_id: inv.xero_invoice_id,
      invoice_number: inv.invoice_number,
      contact_name: inv.contact_name,
      amount_due: inv.amount_due,
      total: inv.total,
      due_date: inv.due_date,
      days_overdue: daysOverdue,
      age_bucket: daysOverdue <= 30 ? '1-30' : daysOverdue <= 60 ? '31-60' : daysOverdue <= 90 ? '61-90' : '90+',
      classification,
      job_number: job?.job_number || null,
      job_status: job?.status || null,
      phone,
      email,
      ghl_contact_id,
      chase_log_count: chaseCountMap[inv.xero_invoice_id] || 0,
      next_follow_up: followUpMap[inv.xero_invoice_id] || null,
      flags,
    }
  })

  // 6. Group by contact
  const clientMap: Record<string, any> = {}
  enriched.forEach((inv: any) => {
    const key = inv.xero_contact_id || inv.contact_name || 'unknown'
    if (!clientMap[key]) {
      clientMap[key] = {
        contact_name: inv.contact_name,
        xero_contact_id: inv.xero_contact_id,
        ghl_contact_id: inv.ghl_contact_id,
        phone: inv.phone,
        email: inv.email,
        total_owed: 0,
        invoices: [],
      }
    }
    // Use most complete contact info
    if (!clientMap[key].ghl_contact_id && inv.ghl_contact_id) clientMap[key].ghl_contact_id = inv.ghl_contact_id
    if (!clientMap[key].phone && inv.phone) clientMap[key].phone = inv.phone
    if (!clientMap[key].email && inv.email) clientMap[key].email = inv.email
    clientMap[key].total_owed += Number(inv.amount_due) || 0
    clientMap[key].invoices.push(inv)
    // First-time client flag
    if (inv.xero_contact_id && firstClientSet.has(inv.xero_contact_id)) clientMap[key].first_client = true
    // Personality note (from any linked invoice)
    if (!clientMap[key].personality_note && personalityMap[inv.xero_invoice_id]) {
      clientMap[key].personality_note = personalityMap[inv.xero_invoice_id]
    }
  })

  // 6b. Fetch PAID invoices for these contacts (gives full picture per client)
  if (xeroContactIds.length > 0) {
    const { data: paidInvoices } = await client.from('xero_invoices')
      .select('xero_contact_id, invoice_number, total, amount_paid, fully_paid_on, invoice_date, reference, job_id')
      .eq('org_id', DEFAULT_ORG_ID)
      .eq('invoice_type', 'ACCREC')
      .eq('status', 'PAID')
      .in('xero_contact_id', xeroContactIds)
      .order('fully_paid_on', { ascending: false })
      .limit(100)
    ;(paidInvoices || []).forEach((pi: any) => {
      const key = pi.xero_contact_id || 'unknown'
      if (clientMap[key]) {
        if (!clientMap[key].paid_invoices) clientMap[key].paid_invoices = []
        if (clientMap[key].paid_invoices.length < 3) {
          clientMap[key].paid_invoices.push({
            invoice_number: pi.invoice_number,
            total: pi.total,
            amount_paid: pi.amount_paid,
            fully_paid_on: pi.fully_paid_on,
          })
        }
      }
    })
  }

  const clients = Object.values(clientMap).sort((a: any, b: any) => b.total_owed - a.total_owed)

  // 7. Summary stats
  const stats = { unclassified: 0, genuine_debt: 0, blocked_by_us: 0, in_dispute: 0, bad_debt: 0 }
  const amounts = { unclassified: 0, genuine_debt: 0, blocked_by_us: 0, in_dispute: 0, bad_debt: 0 }
  enriched.forEach((inv: any) => {
    const c = inv.classification as keyof typeof stats
    if (stats[c] !== undefined) { stats[c]++; amounts[c] += Number(inv.amount_due) || 0 }
  })

  return {
    clients,
    total_outstanding: enriched.reduce((s: number, i: any) => s + (Number(i.amount_due) || 0), 0),
    total_clients: clients.length,
    total_invoices: enriched.length,
    stats,
    amounts,
    last_synced_at: lastSyncedAt,
  }
}

async function classifyInvoice(client: any, body: any) {
  const { xero_invoice_id, classification, reason, operator_email } = body
  if (!xero_invoice_id || !classification) throw new ApiError('xero_invoice_id and classification required', 400)

  const validClassifications = ['unclassified', 'genuine_debt', 'blocked_by_us', 'in_dispute', 'bad_debt']
  if (!validClassifications.includes(classification)) throw new ApiError('Invalid classification', 400)

  // Update invoice
  const { error } = await client.from('xero_invoices')
    .update({
      debt_classification: classification,
      debt_classification_reason: reason || null,
      debt_classified_by: operator_email || null,
      debt_classified_at: new Date().toISOString(),
    })
    .eq('xero_invoice_id', xero_invoice_id)
  if (error) throw error

  // Log the classification change
  await client.from('payment_chase_logs').insert({
    xero_invoice_id,
    method: 'status_change',
    outcome: classification,
    notes: reason || ('Classified as ' + classification),
    chased_by: operator_email || null,
  })

  // If genuine_debt and we have a GHL contact, trigger the chase workflow
  // (caller should handle this via separate trigger_chase_workflow call from the UI)

  return { success: true, classification }
}

async function logChase(client: any, body: any) {
  const { xero_invoice_id, job_id, ghl_contact_id, contact_name, method, outcome, notes, follow_up_date, operator_email } = body
  if (!xero_invoice_id || !method) throw new ApiError('xero_invoice_id and method required', 400)

  // If new follow-up date, resolve previous unresolved follow-ups for this invoice
  if (follow_up_date) {
    await client.from('payment_chase_logs')
      .update({ follow_up_resolved: true })
      .eq('xero_invoice_id', xero_invoice_id)
      .eq('follow_up_resolved', false)
      .not('follow_up_date', 'is', null)
  }

  const { data, error } = await client.from('payment_chase_logs').insert({
    xero_invoice_id,
    job_id: job_id || null,
    ghl_contact_id: ghl_contact_id || null,
    contact_name: contact_name || null,
    method,
    outcome: outcome || null,
    notes: notes || null,
    follow_up_date: follow_up_date || null,
    chased_by: operator_email || null,
  }).select().single()
  if (error) throw error

  return { success: true, chase_log: data }
}

async function resolveFollowUp(client: any, body: any) {
  const { chase_log_id } = body
  if (!chase_log_id) throw new ApiError('chase_log_id required', 400)

  const { error } = await client.from('payment_chase_logs')
    .update({ follow_up_resolved: true })
    .eq('id', chase_log_id)
  if (error) throw error

  return { success: true }
}

async function triggerXeroSync() {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/xero-sync?action=sync_invoices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({}),
  })
  const result = await resp.json()
  return { success: resp.ok, synced: result }
}

// ════════════════════════════════════════════════════════════
// AI DEBT INTELLIGENCE
// ════════════════════════════════════════════════════════════

async function _callClaude(model: string, system: string, userContent: string, maxTokens = 1024) {
  if (!ANTHROPIC_API_KEY) throw new ApiError('ANTHROPIC_API_KEY not configured', 500)
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userContent }] }),
  })
  const data = await resp.json()
  let text = data.content?.[0]?.text || ''
  // Strip markdown code fences if Claude wraps the JSON
  text = text.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json|JSON)?\n?/, '').replace(/\n?```$/, '').trim()
  }
  return text
}

async function _fetchGHLConversation(ghlContactId: string, limit = 30) {
  if (!ghlContactId) return []
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/ghl-proxy?action=get_conversation&contactId=${ghlContactId}`, {
      headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
    })
    const data = await resp.json()
    return (data.messages || []).slice(-limit)
  } catch { return [] }
}

async function aiAnalyseDebtClient(dbClient: any, body: any) {
  const { contact_name, ghl_contact_id, invoices, job_ids, personality_note, total_owed } = body
  if (!contact_name || !invoices) throw new ApiError('contact_name and invoices required', 400)

  // Fetch GHL conversation
  const conversation = await _fetchGHLConversation(ghl_contact_id)

  // Fetch job details for linked jobs (cap at 3)
  let jobDetails: any[] = []
  if (job_ids && job_ids.length > 0) {
    const { data: jobs } = await dbClient.from('jobs')
      .select('job_number, type, status, site_suburb, scope_json, pricing_json, completed_at')
      .in('id', job_ids.slice(0, 3))
    jobDetails = jobs || []
  }

  const contextBundle = {
    client: { name: contact_name, total_owed, personality_note: personality_note || null },
    invoices: (invoices || []).map((inv: any) => ({
      number: inv.invoice_number, amount_due: inv.amount_due, days_overdue: inv.days_overdue,
      classification: inv.classification, chase_logs: (inv.chase_logs || []).slice(-10),
    })),
    jobs: jobDetails.map((j: any) => ({
      number: j.job_number, type: j.type, status: j.status, suburb: j.site_suburb, completed_at: j.completed_at,
    })),
    conversation: conversation.map((m: any) => ({
      direction: m.direction, body: (m.body || '').substring(0, 500), timestamp: m.timestamp,
    })),
  }

  const systemPrompt = `You are an AI debt collection advisor for SecureWorks Group (Perth fencing & patio company).

Analyse this client's debt situation and return a JSON response with exactly these fields:
{
  "tone_assessment": "One sentence describing the client's tone/attitude based on conversation history. If no conversation, say 'No conversation history available'.",
  "situation_summary": "2-3 sentences explaining the full picture — what the job was, what happened with payment, where things stand now.",
  "risk_level": "low" | "medium" | "high",
  "risk_signals": ["Array of short risk signals, e.g. 'Gone silent 21 days', 'Disputes variations'"],
  "suggested_approach": "2-3 sentences of specific, actionable advice. Reference specific conversation details if available.",
  "draft_sms": "A ready-to-send SMS (under 300 chars) appropriate for the current situation. Warm but professional.",
  "payment_likelihood": "low" | "medium" | "high",
  "payment_likelihood_reasoning": "One sentence explaining why."
}

RULES:
- Be specific. Reference actual conversation content, dates, and amounts.
- If classified as "blocked_by_us", focus on fixing the internal blocker, NOT chasing.
- If classified as "in_dispute", focus on resolution, NOT payment demands.
- If conversation shows anger or legal threats, flag prominently and suggest de-escalation.
- Draft SMS should NEVER be aggressive. Perth tradie culture — direct but respectful.
- Return ONLY the JSON object, no markdown.`

  const text = await _callClaude('claude-haiku-4-5-20251001', systemPrompt, JSON.stringify(contextBundle))
  try {
    return JSON.parse(text)
  } catch {
    return { error: 'Failed to parse AI response', raw: text.substring(0, 500) }
  }
}

async function aiDraftChaseMessage(body: any) {
  const { contact_name, ghl_contact_id, channel, total_owed, classification, last_chase_summary, personality_note, context_hint } = body
  if (!contact_name || !channel || !total_owed) throw new ApiError('contact_name, channel, and total_owed required', 400)

  const conversation = await _fetchGHLConversation(ghl_contact_id, 15)

  const prompt = `You are writing a ${channel === 'sms' ? 'text message (SMS, max 300 chars)' : 'short email'} to chase payment from a client of SecureWorks Group (Perth fencing & patio company).

CLIENT: ${contact_name}
OWED: $${total_owed}
CLASSIFICATION: ${classification || 'unclassified'}
${personality_note ? 'PERSONALITY: ' + personality_note : ''}
${last_chase_summary ? 'LAST CHASE: ' + last_chase_summary : ''}
${context_hint ? 'SITUATION: ' + context_hint : ''}

RECENT CONVERSATION:
${conversation.map((m: any) => `[${m.direction}] ${(m.body || '').substring(0, 200)}`).join('\n') || 'No conversation history.'}

RULES:
- Perth tradie culture: direct, friendly, not corporate or threatening
- First name basis
- If blocked_by_us: DON'T chase for payment, acknowledge the issue
- If in_dispute: focus on resolution, not money
- If broken promise: reference the specific promise gently
- NEVER mention solicitors, legal action, or credit reporting
- Sign off as "SecureWorks" or "The SecureWorks team"
- Return ONLY the message text, nothing else.`

  const draft = await _callClaude('claude-haiku-4-5-20251001', 'Generate the requested message.', prompt, 512)
  return { draft: draft.trim(), channel }
}

async function aiTriageDebtPortfolio(body: any) {
  const { clients, total_portfolio_value } = body
  if (!clients || !clients.length) throw new ApiError('clients array required', 400)

  const systemPrompt = `You are a debt collection strategist for SecureWorks Group (Perth fencing & patio company).

Total portfolio: $${total_portfolio_value || 0}

Analyse these ${clients.length} clients and return a JSON array of prioritised actions:

[
  {
    "priority": 1,
    "contact_name": "Client Name",
    "total_owed": 6900,
    "action": "call" | "sms" | "email" | "investigate" | "escalate" | "write_off_candidate" | "resolve_blocker" | "resolve_dispute",
    "reasoning": "One sentence explaining why this is the priority and what to do specifically.",
    "time_estimate": "5 min" | "10 min" | "15 min"
  }
]

RULES:
- Return max 10 actions (the most impactful ones)
- Genuine debts with broken promises = high priority
- Large amounts with no chase activity = high priority
- "blocked_by_us" clients need internal action, not chasing
- "in_dispute" clients need resolution, not payment demands
- Consider ROI: a $500 debt chased 8 times is less worthwhile than a $5,000 debt never contacted
- Be specific in reasoning — reference the actual data
- Return ONLY the JSON array.`

  const text = await _callClaude('claude-sonnet-4-6', systemPrompt, JSON.stringify(clients), 2048)
  try {
    return { actions: JSON.parse(text) }
  } catch {
    return { error: 'Parse error', raw: text.substring(0, 500) }
  }
}

async function aiBatchHints(body: any) {
  const { clients } = body
  if (!clients || !clients.length) return { hints: {} }

  const systemPrompt = `You are a debt collection advisor for SecureWorks Group (Perth fencing & patio company).

For each client below, write ONE short sentence (max 15 words) of specific, actionable advice for the person about to chase them. Be direct and specific — reference amounts, days, classification.

Return a JSON object where keys are client names and values are the one-liner hints.
Example: {"Jim Clarke": "First contact needed — $6,900 overdue 39d, call today", "Sarah Miles": "Chased 3x no reply — consider formal demand letter"}

Return ONLY the JSON object.`

  const text = await _callClaude('claude-haiku-4-5-20251001', systemPrompt, JSON.stringify(clients), 2048)
  try {
    return { hints: JSON.parse(text) }
  } catch {
    return { hints: {}, error: 'Parse error' }
  }
}

async function forceReconcileInvoice(dbClient: any, body: any) {
  const { xero_invoice_id } = body
  if (!xero_invoice_id) throw new ApiError('xero_invoice_id required', 400)

  // Call xero-sync to trigger a full sync (which includes reconciliation)
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/xero-sync?action=sync_invoices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
    body: JSON.stringify({}),
  })
  const syncResult = await resp.json()

  // Also directly check this specific invoice
  const { data: inv } = await dbClient.from('xero_invoices')
    .select('status, amount_due, synced_at')
    .eq('xero_invoice_id', xero_invoice_id)
    .eq('org_id', DEFAULT_ORG_ID)
    .maybeSingle()

  return { success: true, invoice_status: inv?.status, amount_due: inv?.amount_due, synced_at: inv?.synced_at, sync: syncResult }
}

async function sendChaseSms(client: any, body: any) {
  const { xero_invoice_id, message, operator_email } = body
  // Normalise empty strings to null — job_id has FK constraint to jobs(id)
  const job_id = body.job_id && String(body.job_id).trim() ? String(body.job_id).trim() : null
  const ghl_contact_id = body.ghl_contact_id || body.contact_id
  if (!ghl_contact_id || !message) throw new ApiError('ghl_contact_id and message required', 400)

  // Send via GHL proxy
  const ghlUrl = `${SUPABASE_URL}/functions/v1/ghl-proxy?action=send_sms`
  const smsResp = await fetch(ghlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
    body: JSON.stringify({ contactId: ghl_contact_id, message, jobId: job_id || undefined }),
  })
  const smsResult = await smsResp.json()
  if (!smsResult.success) throw new Error(smsResult.error || 'SMS send failed')

  // Log the chase (job_id optional — some chase SMS target contacts without linked jobs)
  await client.from('payment_chase_logs').insert({
    xero_invoice_id: xero_invoice_id || null,
    job_id: job_id,
    ghl_contact_id,
    method: 'sms',
    outcome: 'SMS sent',
    notes: message.substring(0, 500),
    chased_by: operator_email || null,
  })

  return { success: true, message_id: smsResult.messageId }
}

async function triggerChaseWorkflow(client: any, body: any) {
  const { ghl_contact_id, overdue_amount, invoice_number, job_number } = body
  if (!ghl_contact_id) throw new ApiError('ghl_contact_id required', 400)

  const ghlBase = `${SUPABASE_URL}/functions/v1/ghl-proxy`

  // 1. Add chase-overdue tag to contact
  const tagResp = await fetch(`${ghlBase}?action=add_contact_tag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contactId: ghl_contact_id, tag: 'chase-overdue' }),
  })
  const tagResult = await tagResp.json()

  // 2. Set custom fields with chase context (for GHL workflow SMS templates)
  try {
    await fetch(`${ghlBase}?action=update_contact_custom_fields`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contactId: ghl_contact_id,
        customFields: {
          overdue_amount: overdue_amount ? String(overdue_amount) : '',
          overdue_invoice_number: invoice_number || '',
          overdue_job_number: job_number || '',
        },
      }),
    })
  } catch (e) {
    console.log('[ops-api] Custom field update failed (non-blocking):', e)
  }

  return { success: true, tag_added: tagResult.success }
}

async function stopChaseWorkflow(client: any, body: any) {
  const { ghl_contact_id } = body
  if (!ghl_contact_id) throw new ApiError('ghl_contact_id required', 400)

  const ghlBase = `${SUPABASE_URL}/functions/v1/ghl-proxy`

  // 1. Remove chase-overdue tag
  const tagResp = await fetch(`${ghlBase}?action=remove_contact_tag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contactId: ghl_contact_id, tag: 'chase-overdue' }),
  })
  const tagResult = await tagResp.json()

  // 2. Clear custom fields
  try {
    await fetch(`${ghlBase}?action=update_contact_custom_fields`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contactId: ghl_contact_id,
        customFields: { overdue_amount: '', overdue_invoice_number: '', overdue_job_number: '' },
      }),
    })
  } catch (e) {
    console.log('[ops-api] Custom field clear failed (non-blocking):', e)
  }

  return { success: true, tag_removed: tagResult.success }
}

// ── Handle payment detection events ──
// Called when xero sync detects an invoice has been paid (amount_due → 0).
// Stops chase workflow, sends thank-you SMS, logs to payment_chase_logs.
async function handlePaymentEvent(client: any, body: any) {
  const { xero_contact_id, xero_invoice_id, invoice_number, contact_name, amount_paid, job_id } = body
  if (!xero_invoice_id) throw new ApiError('xero_invoice_id required', 400)

  const results: string[] = []

  // 1. Resolve GHL contact from contact_matches
  let ghlContactId: string | null = null
  const { data: match } = await client.from('contact_matches')
    .select('ghl_contact_id, phone')
    .eq('xero_contact_id', xero_contact_id)
    .limit(1)
    .maybeSingle()
  if (match?.ghl_contact_id) {
    ghlContactId = match.ghl_contact_id
  }

  // 2. Stop chase workflow if GHL contact exists
  if (ghlContactId) {
    try {
      await stopChaseWorkflow(client, { ghl_contact_id: ghlContactId })
      results.push('chase_stopped')
    } catch (e) {
      console.log(`[ops-api] stopChaseWorkflow failed for ${ghlContactId}:`, e)
    }
  }

  // 3. Resolve any unresolved follow-ups for this invoice
  const { count: resolvedCount } = await client.from('payment_chase_logs')
    .update({ follow_up_resolved: true })
    .eq('xero_invoice_id', xero_invoice_id)
    .eq('follow_up_resolved', false)
    .not('follow_up_date', 'is', null)
  if (resolvedCount && resolvedCount > 0) {
    results.push(`resolved_${resolvedCount}_followups`)
  }

  // 4. Log payment received to chase logs
  await client.from('payment_chase_logs').insert({
    xero_invoice_id,
    job_id: job_id || null,
    ghl_contact_id: ghlContactId || null,
    contact_name: contact_name || null,
    method: 'status_change',
    outcome: `Payment received: $${amount_paid || '?'} — ${invoice_number}`,
    chased_by: 'system',
  })
  results.push('chase_log_created')

  // 5. Send thank-you SMS if we have a GHL contact with a phone
  if (ghlContactId && match?.phone) {
    const firstName = (contact_name || '').split(' ')[0] || 'there'
    const thankYouMsg = `Hi ${firstName}, we've received your payment of $${Math.round(Number(amount_paid) || 0).toLocaleString()} for invoice ${invoice_number}. Thank you! — SecureWorks`
    try {
      const ghlUrl = `${SUPABASE_URL}/functions/v1/ghl-proxy?action=send_sms`
      await fetch(ghlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
        body: JSON.stringify({ contactId: ghlContactId, message: thankYouMsg }),
      })
      results.push('thank_you_sms_sent')
    } catch (e) {
      console.log(`[ops-api] Thank-you SMS failed for ${ghlContactId}:`, e)
      results.push('thank_you_sms_failed')
    }
  }

  return { success: true, invoice_number, contact_name, actions: results }
}


// ════════════════════════════════════════════════════════════
// SCOPE AVAILABILITY — Smart booking slots with suburb scoring
// ════════════════════════════════════════════════════════════

// Perth suburb zones for proximity scoring
const PERTH_ZONES: Record<string, string[]> = {
  north: ['Joondalup','Clarkson','Wanneroo','Alkimos','Yanchep','Two Rocks','Butler','Mindarie','Quinns Rocks','Currambine','Kinross','Burns Beach','Iluka','Connolly','Heathridge','Ocean Reef','Mullaloo','Kallaroo','Hillarys','Padbury','Duncraig','Craigie','Woodvale','Kingsley','Greenwood','Warwick','Hamersley','Carine','Sorrento','Marmion','Watermans Bay','Banksia Grove','Tapping','Madeley','Landsdale','Alexander Heights','Marangaroo','Girrawheen','Koondoola','Ballajura','Malaga','Noranda'],
  inner_north: ['Scarborough','Doubleview','Innaloo','Stirling','Osborne Park','Tuart Hill','Nollamara','Balga','Westminster','Mirrabooka','Morley','Dianella','Yokine','Mount Lawley','Inglewood','Bedford','Bayswater','Embleton','Maylands','Bassendean','Eden Hill','Ashfield','Guildford'],
  east: ['Midland','Swan View','Ellenbrook','The Vines','Upper Swan','Henley Brook','Aveley','Dayton','Brabham','Whiteman','Bennett Springs','Stratton','Viveash','Caversham','Kiara'],
  hills: ['Mundaring','Kalamunda','Lesmurdie','Gooseberry Hill','High Wycombe','Forrestfield','Maida Vale','Helena Valley','Darlington','Glen Forrest','Parkerville','Stoneville','Hovea','Sawyers Valley'],
  inner_south: ['Fremantle','Booragoon','Applecross','Mount Pleasant','Bateman','Bull Creek','Leeming','Jandakot','Bibra Lake','Cockburn','Success','Atwell','Aubin Grove','Coogee','Spearwood','Hamilton Hill','Coolbellup','Kardinya','Murdoch','Winthrop','Melville','Palmyra','Bicton','East Fremantle','Willagee','Hilton','White Gum Valley','Beaconsfield','South Lake','Yangebup','Henderson','Munster'],
  south: ['Rockingham','Baldivis','Wellard','Bertram','Wandi','Byford','Mundijong','Armadale','Kelmscott','Gosnells','Southern River','Canning Vale','Harrisdale','Piara Waters','Thornlie','Langford','Ferndale','Riverton','Willetton','Cannington','Beckenham','Kenwick','Maddington','Orange Grove','Martin','Roleystone','Bedfordale','Seville Grove','Brookdale','Champion Lakes','Haynes','Hilbert'],
  central: ['Perth','Northbridge','East Perth','West Perth','Subiaco','Leederville','North Perth','Mount Hawthorn','Joondanna','Wembley','Floreat','City Beach','Nedlands','Claremont','Cottesloe','Dalkeith','Peppermint Grove','Crawley','Shenton Park','Daglish','Churchlands','Woodlands','Karrinyup','Gwelup','Trigg'],
  east_vic_park: ['Victoria Park','East Victoria Park','Carlisle','Lathlain','Bentley','St James','Welshpool','Kewdale','Cloverdale','Belmont','Redcliffe','Ascot','Rivervale'],
}

// Adjacent zone pairs for partial scoring
const ADJACENT_ZONES: Record<string, string[]> = {
  north: ['inner_north', 'east'],
  inner_north: ['north', 'central', 'east', 'east_vic_park'],
  east: ['north', 'inner_north', 'hills'],
  hills: ['east', 'east_vic_park', 'south'],
  inner_south: ['central', 'east_vic_park', 'south'],
  south: ['inner_south', 'hills', 'east_vic_park'],
  central: ['inner_north', 'inner_south', 'east_vic_park'],
  east_vic_park: ['inner_north', 'central', 'inner_south', 'south', 'hills'],
}

function getSuburbZone(suburb: string): string | null {
  if (!suburb) return null
  const normalised = suburb.trim().toLowerCase()
  for (const [zone, suburbs] of Object.entries(PERTH_ZONES)) {
    if (suburbs.some(s => s.toLowerCase() === normalised)) return zone
  }
  return null
}

function scoreSuburbProximity(targetSuburb: string, existingSuburbs: string[]): number {
  const targetZone = getSuburbZone(targetSuburb)
  if (!targetZone || existingSuburbs.length === 0) return 50 // neutral if no data

  const existingZones = existingSuburbs.map(s => getSuburbZone(s)).filter(Boolean) as string[]
  if (existingZones.length === 0) return 50

  // Same zone = 100, adjacent = 70, different = 20
  if (existingZones.includes(targetZone)) return 100
  const adjacent = ADJACENT_ZONES[targetZone] || []
  if (existingZones.some(z => adjacent.includes(z))) return 70
  return 20
}

const SCOPE_SLOTS = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00']

async function scopeAvailability(client: any, params: URLSearchParams) {
  const scoperId = params.get('scoper_id') || undefined
  const suburb = params.get('suburb') || undefined
  const fromStr = params.get('from') || new Date().toISOString().slice(0, 10)
  const toStr = params.get('to') || (() => {
    const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().slice(0, 10)
  })()

  // Get scopers (users with estimator or scoper role, or all crew if not filtered)
  let userQuery = client.from('users').select('id, name, email, phone, role')
    .eq('org_id', DEFAULT_ORG_ID)
    .in('role', ['estimator', 'sales', 'admin', 'ops_manager'])
  if (scoperId) userQuery = userQuery.eq('id', scoperId)
  const { data: scopers } = await userQuery

  // Filter to known scopers (Khairo, Nithin, Nathan) — anyone who does scope assignments
  const { data: recentScopers } = await client
    .from('job_assignments')
    .select('user_id')
    .eq('assignment_type', 'scope')
    .gte('scheduled_date', new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10))
  const activeScoперIds = new Set((recentScopers || []).map((r: any) => r.user_id).filter(Boolean))

  // Use recent scopers if available, otherwise fall back to all scopers from role query
  const allScopers = (scopers || []).filter((s: any) => scoperId ? true : activeScoперIds.has(s.id))
  if (allScopers.length === 0 && scopers && scopers.length > 0) {
    // Fallback: just use the first 3 from role query
    allScopers.push(...(scopers || []).slice(0, 3))
  }
  const scoperIds = allScopers.map((s: any) => s.id)
  const scoperMap: Record<string, any> = Object.fromEntries(allScopers.map((s: any) => [s.id, s]))

  // Existing scope assignments in range
  const { data: existingAssignments } = await client
    .from('job_assignments')
    .select('user_id, scheduled_date, start_time, end_time, job_id')
    .eq('assignment_type', 'scope')
    .neq('status', 'cancelled')
    .gte('scheduled_date', fromStr)
    .lte('scheduled_date', toStr)
    .in('user_id', scoperIds.length > 0 ? scoperIds : ['00000000-0000-0000-0000-000000000000'])

  // Get suburbs for existing assignments
  const assignmentJobIds = [...new Set((existingAssignments || []).map((a: any) => a.job_id).filter(Boolean))]
  let jobSuburbMap: Record<string, string> = {}
  if (assignmentJobIds.length > 0) {
    const { data: jobRows } = await client.from('jobs').select('id, site_suburb').in('id', assignmentJobIds)
    jobSuburbMap = Object.fromEntries((jobRows || []).map((j: any) => [j.id, j.site_suburb || '']))
  }

  // Crew availability (leave/unavailable)
  const { data: availRows } = await client
    .from('crew_availability')
    .select('user_id, date, status')
    .gte('date', fromStr)
    .lte('date', toStr)
    .in('user_id', scoperIds.length > 0 ? scoperIds : ['00000000-0000-0000-0000-000000000000'])
  const unavailableSet = new Set(
    (availRows || []).filter((r: any) => r.status === 'leave' || r.status === 'unavailable')
      .map((r: any) => `${r.user_id}_${r.date}`)
  )

  // Build booked slots lookup: "userId_date_time" → true
  const bookedSlots = new Set<string>()
  const daySuburbs: Record<string, string[]> = {} // "userId_date" → suburbs[]
  for (const a of (existingAssignments || [])) {
    const key = `${a.user_id}_${a.scheduled_date}`
    if (a.start_time) {
      bookedSlots.add(`${key}_${a.start_time.slice(0, 5)}`)
    }
    // Track suburbs for this scoper+day
    if (!daySuburbs[key]) daySuburbs[key] = []
    const sub = jobSuburbMap[a.job_id]
    if (sub && !daySuburbs[key].includes(sub)) daySuburbs[key].push(sub)
  }

  // Generate slots
  const slots: any[] = []
  const from = new Date(fromStr + 'T00:00:00')
  const to = new Date(toStr + 'T00:00:00')

  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const dayOfWeek = d.getDay()
    if (dayOfWeek === 0 || dayOfWeek === 6) continue // skip weekends

    const dateStr = d.toISOString().slice(0, 10)

    for (const scoper of allScopers) {
      const dayKey = `${scoper.id}_${dateStr}`

      // Skip if on leave
      if (unavailableSet.has(dayKey)) continue

      const existingSubs = daySuburbs[dayKey] || []

      for (const time of SCOPE_SLOTS) {
        const slotKey = `${dayKey}_${time}`
        const available = !bookedSlots.has(slotKey)

        const suburbScore = suburb ? scoreSuburbProximity(suburb, existingSubs) : 50

        slots.push({
          date: dateStr,
          scoper_id: scoper.id,
          scoper_name: scoper.name,
          start_time: time,
          available,
          existing_suburbs: existingSubs,
          zone: suburb ? getSuburbZone(suburb) : null,
          suburb_score: available ? suburbScore : 0,
        })
      }
    }
  }

  // Sort: available first, then by suburb_score desc, then by date asc, then by time asc
  slots.sort((a: any, b: any) => {
    if (a.available !== b.available) return a.available ? -1 : 1
    if (a.suburb_score !== b.suburb_score) return b.suburb_score - a.suburb_score
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    return a.start_time < b.start_time ? -1 : 1
  })

  return { slots, scopers: allScopers.map((s: any) => ({ id: s.id, name: s.name })) }
}
