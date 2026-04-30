// ════════════════════════════════════════════════════════════
// SecureWorks — Send Quote Edge Function
//
// Sends a quote PDF to the client via email and provides
// a client-facing acceptance page.
//
// Deploy: supabase functions deploy send-quote
//
// Endpoints:
//   POST /send - Send quote email to client
//   GET  /status?job_id=xxx - Quote status for toolbar badges
//   GET  /view?token=xxx - Client views their quote
//   POST /accept?token=xxx - Client accepts quote
//   POST /decline?token=xxx - Client declines quote
//   POST /send-invoice - Send branded deposit invoice email
//   GET  /payment-confirmed?token=xxx - "I've paid" prompt page
//   POST /payment-confirmed?token=xxx - Record payment claim + show success
//   POST /neighbour-nudge - Nudge paid neighbour to chase unpaid (GATED)
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { canonicalJsonAndHash } from '../_shared/release_packet/canonicalize.ts'
import { buildMinimalReleaseManifest } from '../_shared/release_packet/build_minimal_manifest.ts'
import type { CouncilStatus } from '../_shared/release_packet/manifest_types.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || ''
const GHL_API_TOKEN = Deno.env.get('GHL_API_TOKEN') || ''
const FROM_EMAIL = Deno.env.get('FROM_EMAIL') || 'quotes@secureworksgroup.app'
const FROM_NAME = Deno.env.get('FROM_NAME') || 'SecureWorks Group'
const BASE_URL = Deno.env.get('PUBLIC_URL') || SUPABASE_URL
const QUOTE_VIEWER_BASE = Deno.env.get('QUOTE_VIEWER_URL') || 'https://secureworks-website.pages.dev/quote.html'
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0'
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'
const SW_API_KEY = Deno.env.get('SW_API_KEY') || ''

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
  }).then(() => {}, () => {})
}

// ── Base64 helper for large binary files (chunked to avoid stack overflow) ──
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

// ── Shared email event logger — one function, one truth path ──
async function insertEmailEvent(sb: any, opts: {
  emailType: string          // 'quote' | 'invoice' | 'reminder'
  jobId: string
  recipient: string
  subject: string
  resendMessageId?: string | null
  status: 'sent' | 'failed'
  failureReason?: string
  metadata?: Record<string, any>
}) {
  try {
    const { error } = await sb.from('email_events').insert({
      email_type: opts.emailType,
      entity_type: 'job',
      entity_id: opts.jobId,
      job_id: opts.jobId,
      recipient: opts.recipient,
      sender: `${FROM_NAME} <${FROM_EMAIL}>`,
      subject: opts.subject,
      resend_message_id: opts.resendMessageId || null,
      status: opts.status,
      sent_at: opts.status === 'sent' ? new Date().toISOString() : null,
      failed_at: opts.status === 'failed' ? new Date().toISOString() : null,
      failure_reason: opts.failureReason || null,
      metadata: opts.metadata || {},
    })
    if (error) console.log(`[send-quote] email_events insert failed:`, error.message)
  } catch (e: any) {
    console.log(`[send-quote] email_events insert failed:`, e.message)
  }
}

// Cap 0 release-truth canonical-event durability (CAP0-QA-CANONICAL-EVENTS-HARDENING).
// Awaited business_events insert with structured failure logging for Tier-1 release-truth
// emits. The release moment (the awaited jobs.update + Resend send) is not rolled back on
// canonical-insert failure: the email already left, status is already 'quoted', and the legacy
// job_events row is already written. A failure here is RECOVERABLE (canonical row missing while
// the rest of the release moment is recorded), so we log a [canonical-event-fail] line and
// return without throwing so the caller's response shape stays unchanged. Per CIO ticket:
// no retry, no transactional change in this patch — Option B/C are deferred follow-ups.
async function safeBusinessEventInsert(
  sb: any,
  row: Record<string, any>,
  ctx: { handler: string; job_id: string | null }
): Promise<void> {
  try {
    const { error } = await sb.from('business_events').insert(row)
    if (error) {
      console.error('[canonical-event-fail]', JSON.stringify({
        event_type: row?.event_type ?? null,
        handler: ctx.handler,
        job_id: ctx.job_id,
        error: error.message ?? String(error),
      }))
    }
  } catch (e: any) {
    console.error('[canonical-event-fail]', JSON.stringify({
      event_type: row?.event_type ?? null,
      handler: ctx.handler,
      job_id: ctx.job_id,
      error: e?.message ?? String(e),
    }))
  }
}

// ── CAP0-QUOTE-REVISION-MINIMAL — Job Release Packet V1 helper ──────────────
//
// recordReleasedQuoteRevision: builds the minimal manifest, computes the hash,
// uploads canonical manifest JSON to Storage, then INSERTs the quote_revisions
// row WITH sent_at = now() in a single atomic step.
//
// Why no pre-Resend staging: an earlier design wrote a staged row
// (sent_at = NULL) BEFORE Resend so the hash anchor existed even on Resend
// failure. Codex stop-gate review (task-molbo0d5-4v6crc) flagged that this
// produces a stale-snapshot bug — a failed first attempt leaves the staged row
// keyed only on (job_id, version); a later retry with different content
// (recipient changed, pricing edited, PDF regenerated) hits ON CONFLICT, blindly
// reuses the stale row, and releases an immutable revision whose snapshot does
// NOT match the email that actually shipped. The trigger's immutability still
// held — but it was protecting the wrong content.
//
// Fix: the row is INSERTed only at the release moment, with sent_at = now()
// directly. A failed Resend produces no row at all. A retry with different
// content is free to record fresh truth. The released-row contract becomes:
// row exists ⇒ release happened. No intermediate states.
//
// Manifest upload still happens BEFORE the INSERT so manifest_url is reachable
// as soon as the row exists. If the upload fails we log and return null;
// the caller's canonical events still emit (release moment is irreversible:
// email sent, jobs.status flipped) — just without a quote_revision_id.
type RecordReleaseQuoteRevisionInput = {
  job_id: string
  job_document_id: string
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
    runs?: Array<{
      run_label: string
      run_name: string | null
      neighbour_id: string | null
      items_count: number
    }>
  }
  pricing_json: unknown
  pdf_url: string
  released_via: 'send-quote/send' | 'send-quote/send-runs'
  org_id: string
}

async function recordReleasedQuoteRevision(
  sb: any,
  input: RecordReleaseQuoteRevisionInput,
  ctx: { handler: string; job_id: string },
): Promise<string | null> {
  try {
    // 1. Build minimal manifest snapshot at release time.
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

    // 2. Canonicalize + hash (recursive deep-sort + SHA-256).
    const { canonical, hash } = await canonicalJsonAndHash(manifest)

    // 3. Manifest "URL" — Cap 0 ships without Storage upload.
    //
    // Initial design uploaded canonical manifest JSON to job-pdfs Storage.
    // Live deploys revealed that the bucket RLS policy requires
    //   (storage.foldername(name))[1] = auth_org_id()::text
    // which isn't satisfied by the service role (no auth_org_id() context).
    // Both direct .upload() and createSignedUploadUrl + fetch PUT failed in
    // production despite signing succeeding. PDFs work because they upload
    // via the GHL-proxy prepare_quote flow which mints a client-side signed
    // URL the BROWSER PUTs to — a flow we can't reuse for server-side
    // manifest writes from inside this Edge Function.
    //
    // For Cap 0 release-truth, the manifest content is fully captured in
    // scope_snapshot_json + pricing_snapshot_json + totals_snapshot_json
    // columns; the hash provides integrity. manifest_url is forensic-only.
    // We use an internal stub URL that satisfies the NOT NULL constraint
    // and lets future consumers reconstruct the manifest from columns +
    // verify against the hash.
    //
    // CAP0-QUOTE-REVISION-MANIFEST-STORAGE is the follow-up ticket to wire
    // a working manifest object store (likely via a service-role bypass
    // policy on job-pdfs, or a dedicated manifests bucket).
    const manifestUrl = `supabase-internal://manifest/${hash}`

    // 4. INSERT the released row directly with sent_at = now(). Atomic; no staging.
    const totals = manifest.totals_snapshot
    const sentAtIso = new Date().toISOString()
    const { data: inserted, error: insErr } = await sb.from('quote_revisions')
      .insert({
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
        // Codex stop-gate fix: capture canonical bytes inline so the hash is
        // verifiable without external Storage. sha256(manifest_canonical_text)
        // = manifest_hash by construction. Cap 0 schema-version 1.0; column
        // is nullable for backward compat with rows written before
        // 20260430170000 migration landed.
        manifest_canonical_text: canonical,
        pdf_url: input.pdf_url,
        council_status: input.council_status ?? 'unknown',
        build_kind: input.build_kind,
        neighbours_required: input.neighbours_required ?? null,
        released_via: input.released_via,
        sent_at: sentAtIso,
        schema_version: '1.0',
      })
      .select('id')
      .single()

    if (!insErr && inserted) {
      return inserted.id
    }

    // INSERT failed — almost certainly a (job_id, version) unique conflict.
    // In the new lifecycle, a row can only exist at sent_at IS NOT NULL (we
    // never stage). So a conflict means either (a) a previous release fired
    // this row — defensive log [quote-revision-duplicate-release], return the
    // existing released id so canonical events stay coherent — or (b) a stale
    // staged row from a pre-fix deploy (should not exist in this codebase's
    // history; defensive only) — log [quote-revision-stale-staged] and return
    // null so canonical events emit with quote_revision_id=null and the
    // operator notices.
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
      // sent_at IS NULL — should not happen post-this-fix. The
      // controlled-immutability trigger refuses any UPDATE; the no_delete
      // trigger refuses any DELETE; so the row is stuck. DB admin must drop
      // and recreate to clean up.
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

serve(async (req: Request) => {
  const url = new URL(req.url)
  const path = url.pathname.split('/').pop()

  // CORS
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  try {
    // ── API Key Auth (only for send/send-invoice — view/accept/decline are public client endpoints) ──
    if (path === 'send' || path === 'send-invoice' || path === 'send-runs') {
      const apiKey = req.headers.get('x-api-key') || req.headers.get('authorization')?.replace('Bearer ', '')
      const validKey = Deno.env.get('SW_API_KEY')
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
      if (!apiKey || (apiKey !== validKey && apiKey !== serviceKey)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }

    // ── SEND QUOTE EMAIL ──
    if (path === 'send' && req.method === 'POST') {
      const { document_id, client_email: providedEmail, client_name: providedName, message, cc_emails, subject: customSubject, attachment_paths, scoper_name } = await req.json()

      if (!document_id) {
        return jsonResponse({ error: 'document_id required' }, 400, corsHeaders)
      }

      // Get document record (include job_contact for per-neighbour routing).
      // Cap 0 Job Release Packet V1: pricing_json + site_address are needed at
      // staging time for the manifest snapshot.
      const { data: doc, error: docErr } = await sb
        .from('job_documents')
        .select('*, jobs(client_name, site_suburb, site_address, type, job_number, ghl_contact_id, pricing_json), job_contacts(client_name, client_email)')
        .eq('id', document_id)
        .single()

      if (docErr || !doc) {
        return jsonResponse({ error: 'Document not found' }, 404, corsHeaders)
      }

      // Resolve email: use provided, fall back to job_contact, then job-level
      const client_email = providedEmail || doc.job_contacts?.client_email
      if (!client_email) {
        return jsonResponse({ error: 'No email address found for this contact' }, 400, corsHeaders)
      }

      // Resolve name: use provided, fall back to job_contact, then job-level
      const client_name = providedName || doc.job_contacts?.client_name || doc.jobs?.client_name || 'there'

      // Build client view URL
      const viewUrl = `${BASE_URL}/functions/v1/send-quote/view?token=${doc.share_token}`

      // ── Cap 0 quote_revision precompute (Job Release Packet V1) ──
      // Per Codex stop-gate review (task-molbo0d5-4v6crc) we record the
      // quote_revisions row ONLY at the release moment (post-Resend success +
      // jobs.status flip), not pre-Resend. This precomputes the build_kind
      // that the post-flip recordReleasedQuoteRevision call will need.
      const buildKindForSend: 'patio' | 'fence' | 'misc' =
        doc.jobs?.type === 'fencing' ? 'fence' :
        doc.jobs?.type === 'patio' ? 'patio' : 'misc'

      // Send email via Resend
      const emailSubject = customSubject || `Your ${doc.jobs?.type || 'project'} quote from SecureWorks Group`
      if (!RESEND_API_KEY) {
        return jsonResponse({ error: 'Email service not configured — contact admin' }, 503, corsHeaders)
      }
      {
        const emailHtml = buildQuoteEmail({
          clientName: client_name,
          viewUrl,
          pdfUrl: doc.pdf_url,
          projectType: doc.jobs?.type || 'project',
          suburb: doc.jobs?.site_suburb || '',
          customMessage: message || '',
          scoperName: scoper_name || 'The SecureWorks Team',
        })

        // Build attachments array
        const attachments: Array<{filename: string, content: string}> = []

        // PDF not attached — client views via "View Your Quote" link for tracking

        // Attach library docs
        if (attachment_paths && attachment_paths.length > 0) {
          for (const docPath of attachment_paths) {
            try {
              const libUrl = `${SUPABASE_URL}/storage/v1/object/public/library-docs/${docPath}`
              const libRes = await fetch(libUrl)
              if (libRes.ok) {
                const libBuf = await libRes.arrayBuffer()
                const libBase64 = uint8ToBase64(new Uint8Array(libBuf))
                const libFilename = docPath.split('/').pop() || docPath
                attachments.push({ filename: libFilename, content: libBase64 })
              }
            } catch (e) {
              console.log(`[send-quote] Library doc fetch failed for ${docPath} (non-blocking):`, (e as Error).message)
            }
          }
        }

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: `${FROM_NAME} <${FROM_EMAIL}>`,
            reply_to: getClientReplyTo(doc.jobs?.type, doc.jobs?.job_number),
            to: client_email,
            subject: emailSubject,
            html: emailHtml,
            ...(cc_emails && cc_emails.length > 0 ? { cc: cc_emails } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          }),
        })

        if (emailRes.ok) {
          const resendData = await emailRes.json()
          await insertEmailEvent(sb, {
            emailType: 'quote', jobId: doc.job_id, recipient: client_email,
            subject: emailSubject, resendMessageId: resendData.id,
            status: 'sent',
            metadata: { document_id: doc.id, quote_number: doc.quote_number, client_name: client_name, job_type: doc.jobs?.type, cc_emails: cc_emails || [] },
          })
          // Log to po_communications for client email thread
          sb.from('po_communications').insert({
            job_id: doc.job_id, direction: 'outbound',
            from_email: FROM_EMAIL, to_email: client_email,
            subject: emailSubject, body_html: emailHtml,
            communication_type: 'client', sent_at: new Date().toISOString(),
            message_id: resendData.id, delivery_status: 'sent',
          }).then(() => {}, () => {})
          // Log note to GHL contact
          logEmailToGHL(doc.jobs?.ghl_contact_id, emailSubject, client_email)
        } else {
          const errData = await emailRes.json().catch(() => ({}))
          console.log('[send-quote] Resend failed:', JSON.stringify(errData))
          await insertEmailEvent(sb, {
            emailType: 'quote', jobId: doc.job_id, recipient: client_email,
            subject: emailSubject, status: 'failed',
            failureReason: errData.message || `HTTP ${emailRes.status}`,
            metadata: { document_id: doc.id, client_name: client_name },
          })
          return jsonResponse({ error: 'Email delivery failed: ' + (errData.message || `HTTP ${emailRes.status}`) }, 502, corsHeaders)
        }
      }

      // Mark as sent (only reached if email succeeded)
      await sb
        .from('job_documents')
        .update({ sent_to_client: true, sent_at: new Date().toISOString() })
        .eq('id', document_id)

      // Update job status to quoted (release moment per ADR 2026-04-27)
      if (doc.job_id) {
        // Read job metadata for the canonical event payloads. Status here is informational
        // only — the source of truth for "did this call cause the release transition?" is
        // the UPDATE's affected-row count below, which closes the SELECT-then-UPDATE race.
        const { data: jobBefore } = await sb
          .from('jobs')
          .select('job_number, type, pricing_json, client_name')
          .eq('id', doc.job_id)
          .single()

        // Conditional UPDATE returning affected rows — only this call's atomic
        // draft → quoted flip emits canonical release events. If a concurrent writer
        // already moved the job (or this is a resend), updatedRows is empty and we
        // skip the canonical emit.
        const { data: updatedRows } = await sb
          .from('jobs')
          .update({ status: 'quoted', quoted_at: new Date().toISOString() })
          .eq('id', doc.job_id)
          .eq('status', 'draft') // only if still draft
          .select('id')
        const transitioned = Array.isArray(updatedRows) && updatedRows.length > 0

        // Legacy event (preserved for back-compat with daily-digest / older readers)
        await sb.from('job_events').insert({
          job_id: doc.job_id,
          event_type: 'quote_sent',
          detail_json: { document_id, sent_to: client_email },
        })

        // Canonical release events — only when this UPDATE actually flipped the row.
        // Awaited via safeBusinessEventInsert so transient Supabase failures are logged as
        // [canonical-event-fail] rather than silently dropped.
        if (transitioned) {
          const nowIso = new Date().toISOString()
          const totalIncGST = jobBefore?.pricing_json?.totalIncGST ?? jobBefore?.pricing_json?.total ?? jobBefore?.pricing_json?.grandTotal ?? 0

          // Cap 0 quote_revisions: record the released row HERE, atomic with
          // the release moment. Builds manifest + uploads + INSERTs sent_at=now()
          // in one helper call. Returns the new revision id, or null if the
          // helper failed (release moment is irreversible — email sent and
          // jobs.status flipped, so canonical events still emit, just with
          // quote_revision_id=null).
          const releasedRevisionId = await recordReleasedQuoteRevision(sb, {
            job_id: doc.job_id,
            job_document_id: doc.id,
            version: doc.version || 1,
            recipient_email: client_email,
            recipient_label: doc.job_contacts?.client_name || null,
            build_kind: buildKindForSend,
            scope: {
              client_name: doc.jobs?.client_name || null,
              site_address: doc.jobs?.site_address || null,
              site_suburb: doc.jobs?.site_suburb || null,
              job_type: doc.jobs?.type || null,
              job_number: doc.jobs?.job_number || null,
            },
            pricing_json: doc.jobs?.pricing_json || null,
            pdf_url: doc.pdf_url || '',
            released_via: 'send-quote/send',
            org_id: DEFAULT_ORG_ID,
          }, { handler: 'send-quote/send', job_id: doc.job_id })

          await safeBusinessEventInsert(sb, {
            event_type: 'quote.sent',
            source: 'send-quote',
            occurred_at: nowIso,
            recorded_at: nowIso,
            entity_type: 'job',
            entity_id: doc.job_id,
            correlation_id: doc.job_id,
            job_id: doc.job_id,
            payload: {
              document_id,
              quote_revision_id: releasedRevisionId,
              job_number: jobBefore?.job_number || null,
              job_type: jobBefore?.type || null,
              sent_to: client_email,
              total_inc_gst: totalIncGST,
            },
            metadata: { handler: 'send-quote/send' },
            schema_version: '1.0',
          }, { handler: 'send-quote/send', job_id: doc.job_id })

          await safeBusinessEventInsert(sb, {
            event_type: 'job.status_changed',
            source: 'send-quote',
            occurred_at: nowIso,
            recorded_at: nowIso,
            entity_type: 'job',
            entity_id: doc.job_id,
            correlation_id: doc.job_id,
            job_id: doc.job_id,
            payload: {
              entity: { id: doc.job_id, name: jobBefore?.job_number || jobBefore?.client_name || '' },
              changes: { status: { from: 'draft', to: 'quoted' } },
              financial: { amount: totalIncGST },
              related_entities: [
                { type: 'job_document', id: document_id },
                ...(releasedRevisionId ? [{ type: 'quote_revision', id: releasedRevisionId }] : []),
              ],
            },
            metadata: { reason: 'quote_sent', handler: 'send-quote/send' },
            schema_version: '1.0',
          }, { handler: 'send-quote/send', job_id: doc.job_id })
        }

        // Get full job data for GHL + Xero sync
        const { data: job } = await sb
          .from('jobs')
          .select('id, ghl_opportunity_id, xero_contact_id, job_number, client_name, site_address, site_suburb, type, pricing_json')
          .eq('id', doc.job_id)
          .single()

        // Push monetary value to GHL opportunity (non-blocking)
        if (GHL_API_TOKEN && job?.ghl_opportunity_id) {
          try {
            const monetaryValue = job.pricing_json?.totalIncGST
            if (monetaryValue && monetaryValue > 0) {
              await fetch(`https://services.leadconnectorhq.com/opportunities/${job.ghl_opportunity_id}`, {
                method: 'PUT',
                headers: {
                  'Authorization': `Bearer ${GHL_API_TOKEN}`,
                  'Version': '2021-07-28',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ monetaryValue }),
              })
              console.log(`[send-quote] GHL monetary value set: $${monetaryValue}`)
            }
          } catch (e) {
            console.log('[send-quote] GHL monetary value push failed (non-blocking):', (e as Error).message)
          }
        }

        // ── Create Xero Quote (non-blocking) ──
        if (job?.xero_contact_id) {
          try {
            const xeroQuoteId = await createXeroQuote(sb, job, doc)
            if (xeroQuoteId) {
              await sb.from('jobs').update({ xero_quote_id: xeroQuoteId }).eq('id', job.id)
              await sb.from('job_events').insert({
                job_id: job.id,
                event_type: 'xero_quote_created',
                detail_json: { xero_quote_id: xeroQuoteId, amount: job.pricing_json?.totalIncGST },
              })
              console.log(`[send-quote] Xero Quote created: ${xeroQuoteId}`)
            }
          } catch (e) {
            console.log('[send-quote] Xero Quote creation failed (non-blocking):', (e as Error).message)
          }
        }
      }

      return jsonResponse({ success: true, view_url: viewUrl, share_token: doc.share_token, quote_number: doc.quote_number }, 200, corsHeaders)
    }

    // ── QUOTE STATUS (for toolbar badges) ──
    if (path === 'status' && req.method === 'GET') {
      const jobId = url.searchParams.get('job_id')
      if (!jobId) return jsonResponse({ error: 'job_id required' }, 400, corsHeaders)

      const { data: docs } = await sb
        .from('job_documents')
        .select('id, quote_number, sent_at, viewed_at, accepted_at, declined_at, share_token')
        .eq('job_id', jobId)
        .eq('doc_type', 'quote')
        .order('created_at', { ascending: false })
        .limit(5)

      if (!docs || docs.length === 0) {
        return jsonResponse({ status: null }, 200, corsHeaders)
      }

      const latest = docs[0]
      let status = 'draft'
      if (latest.accepted_at) status = 'accepted'
      else if (latest.declined_at) status = 'declined'
      else if (latest.viewed_at) status = 'viewed'
      else if (latest.sent_at) status = 'sent'

      return jsonResponse({
        status,
        quote_number: latest.quote_number,
        sent_at: latest.sent_at,
        viewed_at: latest.viewed_at,
        accepted_at: latest.accepted_at,
        declined_at: latest.declined_at,
        total_quotes: docs.length,
      }, 200, corsHeaders)
    }

    // ── CLIENT VIEWS QUOTE ──
    if (path === 'view' && req.method === 'GET') {
      const token = url.searchParams.get('token')
      if (!token) return await htmlResponse(errorPage('Invalid link'))

      // Try job_documents first
      let { data: doc, error } = await sb
        .from('job_documents')
        .select('*, jobs(client_name, site_suburb, type, status)')
        .eq('share_token', token)
        .eq('sent_to_client', true)
        .single()

      // Fallback: check job_variations table for variation acceptance links
      if (error || !doc) {
        const { data: variation } = await sb
          .from('job_variations')
          .select('*, jobs(client_name, site_suburb, type, status, job_number)')
          .eq('share_token', token)
          .single()

        if (variation) {
          // Render variation-specific client page
          return await htmlResponse(buildVariationPage(variation, token))
        }

        return await htmlResponse(errorPage('Quote not found or link has expired'))
      }

      // Track views (first view sets viewed_at)
      if (!doc.viewed_at) {
        await sb.from('job_documents')
          .update({ viewed_at: new Date().toISOString() })
          .eq('id', doc.id)
      }

      // Check for multi-option siblings (same job, different options)
      if (doc.job_id) {
        const { data: siblings } = await sb.from('job_documents')
          .select('id, quote_number, pdf_url, share_token, accepted_at, declined_at, data_snapshot_json, job_contact_id')
          .eq('job_id', doc.job_id)
          .eq('type', 'quote')
          .eq('sent_to_client', true)
          .neq('id', doc.id)
          .order('created_at')

        if (siblings && siblings.length > 0) {
          // Multi-option job — show option picker page
          const allDocs = [doc, ...siblings]
          return await htmlResponse(buildMultiOptionPage(allDocs, doc.jobs, token))
        }
      }

      // Log view event (fire-and-forget — for phantom buyer detection)
      if (doc.job_id) {
        sb.from('job_events').insert({
          job_id: doc.job_id,
          event_type: 'quote_viewed',
          detail_json: { document_id: doc.id },
        }).then(() => {}, () => {})

        // Also log to email_events for view counting (non-blocking)
        sb.from('email_events').insert({
          job_id: doc.job_id,
          email_type: 'quote',
          comms_trigger: 'quote_viewed',
          recipient: 'client',
          subject: 'Quote viewed',
        }).then(() => {}, () => {})
      }

      // Per-run fencing quote page (multi-neighbour)
      if (doc.run_label && doc.jobs?.type === 'fencing') {
        // Load full job data for pricing_json
        const { data: fullJob } = await sb.from('jobs')
          .select('*, job_contacts(*)')
          .eq('id', doc.job_id)
          .single()

        if (fullJob?.pricing_json?.runs) {
          const pj = typeof fullJob.pricing_json === 'string' ? JSON.parse(fullJob.pricing_json) : fullJob.pricing_json
          const run = (pj.runs || []).find((r: any) => r.run_label === doc.run_label)
          if (run) {
            // Determine viewer type: client or neighbour (based on job_contact_id)
            const isNeighbour = doc.job_contact_id && fullJob.job_contacts?.some(
              (c: any) => c.id === doc.job_contact_id && !c.is_primary
            )
            return await htmlResponse(buildRunQuotePage(doc, token, run, fullJob, isNeighbour ? 'neighbour' : 'client'))
          }
        }
      }

      return await htmlResponse(buildClientPage(doc, token))
    }

    // ── VARIATION ACCEPT/DECLINE ──
    if ((path === 'accept' || path === 'decline') && req.method === 'POST' && url.searchParams.get('type') === 'variation') {
      const token = url.searchParams.get('token')
      if (!token) return jsonResponse({ error: 'Token required' }, 400, corsHeaders)

      const { data: variation, error: vErr } = await sb
        .from('job_variations')
        .select('*')
        .eq('share_token', token)
        .single()

      if (vErr || !variation) return jsonResponse({ error: 'Variation not found' }, 404, corsHeaders)

      if (path === 'accept') {
        await sb.from('job_variations').update({ status: 'accepted', accepted_at: new Date().toISOString() }).eq('id', variation.id)
        if (variation.job_id) {
          await sb.from('business_events').insert({
            event_type: 'variation.accepted',
            entity_type: 'job',
            entity_id: variation.job_id,
            detail_json: { variation_id: variation.id, variation_number: variation.variation_number, amount: variation.amount },
          }).then(() => {}, () => {})
        }
        return jsonResponse({ success: true, message: 'Variation accepted' }, 200, corsHeaders)
      } else {
        const body = await req.json().catch(() => ({}))
        await sb.from('job_variations').update({ status: 'declined', declined_at: new Date().toISOString() }).eq('id', variation.id)
        if (variation.job_id) {
          await sb.from('business_events').insert({
            event_type: 'variation.declined',
            entity_type: 'job',
            entity_id: variation.job_id,
            detail_json: { variation_id: variation.id, reason: body.reason || '' },
          }).then(() => {}, () => {})
        }
        return jsonResponse({ success: true, message: 'Variation declined' }, 200, corsHeaders)
      }
    }

    // ── CLIENT ACCEPTS QUOTE ──
    if (path === 'accept' && req.method === 'POST') {
      const token = url.searchParams.get('token')
      if (!token) return jsonResponse({ error: 'Token required' }, 400, corsHeaders)

      const { data: doc, error } = await sb
        .from('job_documents')
        .select('*, job_contacts(id, contact_label, client_name, share_percentage, quote_value_ex_gst)')
        .eq('share_token', token)
        .eq('sent_to_client', true)
        .single()

      if (error || !doc) return jsonResponse({ error: 'Quote not found' }, 404, corsHeaders)

      if (doc.accepted_at) return jsonResponse({ error: 'Already accepted' }, 400, corsHeaders)
      if (doc.declined_at) return jsonResponse({ error: 'Already declined' }, 400, corsHeaders)

      await sb
        .from('job_documents')
        .update({ accepted_at: new Date().toISOString() })
        .eq('id', doc.id)

      // ── PER-RUN ACCEPTANCE (multi-neighbour fencing) ──
      if (doc.run_label && doc.job_id) {
        const runLabel = doc.run_label
        const contactId = doc.job_contact_id

        // Update run_acceptances
        await sb.from('run_acceptances').upsert({
          job_id: doc.job_id,
          job_contact_id: contactId,
          job_document_id: doc.id,
          run_label: runLabel,
          status: 'accepted',
          accepted_at: new Date().toISOString(),
        }, { onConflict: 'job_id,job_contact_id,run_label' })

        // Get job data
        const { data: job } = await sb.from('jobs')
          .select('id, job_number, client_name, type, pricing_json, site_address, site_suburb, ghl_contact_id')
          .eq('id', doc.job_id).single()

        const pj = typeof job?.pricing_json === 'string' ? JSON.parse(job.pricing_json) : (job?.pricing_json || {})
        const run = (pj.runs || []).find((r: any) => r.run_label === runLabel)
        const runName = run?.run_name || runLabel

        // Check if both parties accepted this run
        const { data: runAccepts } = await sb.from('run_acceptances')
          .select('*')
          .eq('job_id', doc.job_id)
          .eq('run_label', runLabel)

        // Check if this run has a neighbour
        const { data: runItems } = await sb.from('run_line_items')
          .select('job_contact_id')
          .eq('job_id', doc.job_id)
          .eq('run_label', runLabel)
          .limit(1)
        const runNeighbourId = runItems?.[0]?.job_contact_id || null
        const hasNeighbour = !!runNeighbourId

        const allAccepted = hasNeighbour
          ? (runAccepts || []).filter((ra: any) => ra.status === 'accepted').length >= 2
          : (runAccepts || []).some((ra: any) => ra.status === 'accepted')

        // Log acceptance event
        await sb.from('business_events').insert({
          event_type: 'quote.run_accepted',
          source: 'send-quote',
          occurred_at: new Date().toISOString(),
          recorded_at: new Date().toISOString(),
          entity_type: 'job',
          entity_id: doc.job_id,
          job_id: job?.job_number || doc.job_id,
          payload: {
            run_label: runLabel,
            run_name: runName,
            contact_id: contactId,
            contact_name: doc.job_contacts?.client_name || '',
            both_accepted: allAccepted,
          },
          metadata: {},
        }).then(() => {}, () => {})

        // Update overall job status
        const { data: allRunAccepts } = await sb.from('run_acceptances')
          .select('run_label, status')
          .eq('job_id', doc.job_id)

        const runLabels = [...new Set((allRunAccepts || []).map((ra: any) => ra.run_label))]
        const allRunsFullyAccepted = runLabels.every(rl => {
          const forRun = (allRunAccepts || []).filter((ra: any) => ra.run_label === rl)
          return forRun.every((ra: any) => ra.status === 'accepted')
        })
        const anyDeclined = (allRunAccepts || []).some((ra: any) => ra.status === 'declined')
        const anyAccepted = (allRunAccepts || []).some((ra: any) => ra.status === 'accepted')

        const jobStatus = allRunsFullyAccepted ? 'accepted'
          : (anyAccepted || anyDeclined) ? 'partially_accepted'
          : 'quoted'
        await sb.from('jobs').update({ status: jobStatus, ...(jobStatus === 'accepted' ? { accepted_at: new Date().toISOString() } : {}) }).eq('id', doc.job_id)

        if (allAccepted) {
          // ── RUN FULLY ACCEPTED — create deposit invoices for both parties ──

          // Telegram notification
          const clientName = job?.client_name || 'Client'
          const neighbourName = run?.neighbour_name || 'Neighbour'
          await sb.from('business_events').insert({
            event_type: 'quote.run_fully_accepted.notify',
            source: 'send-quote',
            occurred_at: new Date().toISOString(),
            recorded_at: new Date().toISOString(),
            entity_type: 'job',
            entity_id: doc.job_id,
            job_id: job?.job_number || '',
            payload: {
              message: `✅ ${job?.job_number || ''} ${runLabel} run fully accepted — both ${clientName} and ${hasNeighbour ? neighbourName : 'parties'} confirmed. Creating deposit invoices.`,
              run_label: runLabel,
              run_name: runName,
            },
            metadata: {},
          }).then(() => {}, () => {})

          // Create deposit invoices via ops-api for each party
          const SW_API_KEY = Deno.env.get('SW_API_KEY') || ''
          const depositPercent = pj.deposit?.percent || 50

          // Get all contacts for this run
          const { data: contacts } = await sb.from('job_contacts')
            .select('*')
            .eq('job_id', doc.job_id)
            .eq('status', 'active')

          for (const ra of (runAccepts || []).filter((r: any) => r.status === 'accepted')) {
            const contact = (contacts || []).find((c: any) => c.id === ra.job_contact_id)
            if (!contact) continue

            const isClient = contact.is_primary
            const shareInc = isClient
              ? (run?.totals?.client_share_inc || 0)
              : (run?.totals?.neighbour_share_inc || 0)
            const depositAmount = Math.round(shareInc * (depositPercent / 100) * 100) / 100

            if (depositAmount <= 0) continue

            try {
              await fetch(`${SUPABASE_URL}/functions/v1/ops-api?action=send_acceptance_invoice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': SW_API_KEY },
                body: JSON.stringify({
                  job_id: doc.job_id,
                  job_contact_id: contact.id,
                  deposit_amount: depositAmount,
                  deposit_percent: depositPercent,
                  run_label: runLabel,
                }),
              })
            } catch (e: any) {
              console.log(`[accept] Failed to create deposit for ${contact.client_name}:`, e.message)
            }
          }

          // Return "Next Steps" page for fully accepted run
          return await htmlResponse(buildRunAcceptedPage(job, run, doc.job_contacts?.client_name || ''))
        } else {
          // ── WAITING FOR OTHER PARTY ──
          return await htmlResponse(buildWaitingPage(job, run, doc.job_contacts?.client_name || '', runLabel))
        }
      }

      // Track invoice result for Next Steps page (existing non-run flow)
      let invoiceResult: any = null

      if (doc.job_id) {
        // Get full job data for notifications + invoicing
        const { data: job } = await sb
          .from('jobs')
          .select('id, ghl_opportunity_id, ghl_contact_id, job_number, client_name, type, pricing_json, site_address, site_suburb')
          .eq('id', doc.job_id)
          .single()

        // Determine job status: check if this is a multi-contact job
        const { data: allContacts } = await sb
          .from('job_contacts')
          .select('id')
          .eq('job_id', doc.job_id)

        const isMultiContact = allContacts && allContacts.length > 1
        let newStatus = 'accepted'

        if (isMultiContact) {
          // Check how many contacts have accepted (via their job_documents)
          const { data: allDocs } = await sb
            .from('job_documents')
            .select('id, job_contact_id, accepted_at')
            .eq('job_id', doc.job_id)
            .eq('type', 'quote')
            .not('job_contact_id', 'is', null)

          const totalContactDocs = allDocs?.length || 0
          const acceptedDocs = allDocs?.filter((d: any) => d.accepted_at)?.length || 0

          if (acceptedDocs >= totalContactDocs && totalContactDocs > 0) {
            newStatus = 'accepted' // all contacts accepted
          } else {
            newStatus = 'partially_accepted' // some still pending
          }
        }

        await sb
          .from('jobs')
          .update({
            status: newStatus,
            ...(newStatus === 'accepted' ? { accepted_at: new Date().toISOString() } : {}),
          })
          .eq('id', doc.job_id)

        // Log rich event for Ops Dashboard attention panel
        const pricing = typeof job?.pricing_json === 'string' ? JSON.parse(job.pricing_json || '{}') : (job?.pricing_json || {})
        const totalIncGST = pricing.totalIncGST || 0
        const depositConfig = pricing.deposit || {}

        // Determine who accepted (for multi-contact: use the contact name)
        const acceptorName = doc.job_contacts?.client_name || job?.client_name || 'Client'
        const contactLabel = doc.job_contacts?.contact_label || ''

        await sb.from('job_events').insert({
          job_id: doc.job_id,
          event_type: 'quote_accepted',
          detail_json: {
            document_id: doc.id,
            accepted_via: 'share_link',
            accepted_at: new Date().toISOString(),
            job_number: job?.job_number || null,
            client_name: acceptorName,
            contact_label: contactLabel,
            amount: totalIncGST || null,
            is_multi_contact: isMultiContact,
            new_status: newStatus,
            message: `${acceptorName}${contactLabel ? ' (' + contactLabel + ')' : ''} accepted quote${job?.job_number ? ' for ' + job.job_number : ''}${isMultiContact ? ' — status: ' + newStatus : ''}`,
          },
        })

        // Push GHL stage (only to 'accepted' when fully accepted)
        if (newStatus === 'accepted' && job?.ghl_opportunity_id) {
          try {
            await fetch(`${SUPABASE_URL}/functions/v1/ghl-proxy?action=move_stage`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              },
              body: JSON.stringify({
                opportunityId: job.ghl_opportunity_id,
                status: 'accepted',
                jobType: job.type,
              }),
            })
            console.log(`[send-quote] GHL stage pushed to accepted for ${job.ghl_opportunity_id}`)
          } catch (e) {
            console.log('[send-quote] GHL stage push failed (non-blocking):', (e as Error).message)
          }
        }

        // ── Send client comms trigger: quote_accepted (non-blocking) ──
        // Fire for each individual contact acceptance (not just when all accept)
        {
          try {
            const commsBody: any = { job_id: doc.job_id, comms_trigger: 'quote_accepted' }
            if (doc.job_contact_id) commsBody.job_contact_id = doc.job_contact_id
            await fetch(`${SUPABASE_URL}/functions/v1/ops-api?action=send_client_update`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              },
              body: JSON.stringify(commsBody),
            })
            console.log(`[send-quote] Client comms trigger 'quote_accepted' sent for job ${doc.job_id}`)
          } catch (e) {
            console.log('[send-quote] quote_accepted comms failed (non-blocking):', (e as Error).message)
          }
        }

        // Add acceptance note to GHL contact (non-blocking)
        if (job?.ghl_contact_id && GHL_API_TOKEN) {
          try {
            const noteDate = new Date().toLocaleDateString('en-AU')
            const statusNote = isMultiContact ? `Job status: ${newStatus}` : 'Deposit invoice auto-sent'
            const noteBody = `Quote accepted by ${acceptorName}${contactLabel ? ' (' + contactLabel + ')' : ''} via link on ${noteDate}.\nJob: ${job.job_number || 'N/A'}\nAmount: ${totalIncGST ? '$' + totalIncGST.toLocaleString() : 'N/A'}\n${statusNote}.`
            await fetch(`https://services.leadconnectorhq.com/contacts/${job.ghl_contact_id}/notes`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${GHL_API_TOKEN}`,
                'Version': '2021-07-28',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ body: noteBody }),
            })
          } catch (e) {
            console.log('[send-quote] GHL note failed (non-blocking):', (e as Error).message)
          }
        }

        // Create GHL contact for neighbour if not yet created
        if (doc.job_contact_id && doc.job_contacts && GHL_API_TOKEN) {
          try {
            // Fetch current job_contact to check ghl_contact_id
            const { data: jcFull } = await sb.from('job_contacts')
              .select('id, ghl_contact_id, client_name, client_phone, client_email')
              .eq('id', doc.job_contact_id)
              .single()

            if (jcFull && !jcFull.ghl_contact_id) {
              // Create GHL contact via ghl-proxy (reuses dedup-by-email/phone logic)
              const createRes = await fetch(`${SUPABASE_URL}/functions/v1/ghl-proxy?action=create_contact_and_opportunity`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                },
                body: JSON.stringify({
                  name: jcFull.client_name || acceptorName,
                  phone: jcFull.client_phone || '',
                  email: jcFull.client_email || '',
                  skipOpportunity: true, // only create contact, not a new opportunity
                }),
              })
              const createData = await createRes.json()

              if (createData.contactId) {
                // Update job_contacts with GHL contact ID
                await sb.from('job_contacts')
                  .update({ ghl_contact_id: createData.contactId })
                  .eq('id', doc.job_contact_id)

                // Add note to new GHL contact
                const noteBody = `Neighbour on ${job?.job_number || 'N/A'} — accepted quote ${doc.quote_number || ''} for $${totalIncGST ? (totalIncGST * ((doc.job_contacts.share_percentage || 50) / 100)).toLocaleString() : 'N/A'}`
                await fetch(`https://services.leadconnectorhq.com/contacts/${createData.contactId}/notes`, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${GHL_API_TOKEN}`,
                    'Version': '2021-07-28',
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({ body: noteBody }),
                })
                console.log(`[send-quote] GHL contact created for neighbour ${jcFull.client_name}: ${createData.contactId}`)
              }
            }
          } catch (e) {
            console.log('[send-quote] GHL neighbour contact creation failed (non-blocking):', (e as Error).message)
          }
        }

        // Auto-create + send deposit invoice via send_acceptance_invoice
        // For multi-contact: create per-contact deposit invoice using their share
        if (job?.id) {
          try {
            const invoiceBody: any = {
              job_id: job.id,
              notify_client: true,
            }

            // If this is a per-neighbour document, pass the contact info for portion-based invoicing
            if (doc.job_contact_id && doc.job_contacts) {
              invoiceBody.job_contact_id = doc.job_contact_id
              // Calculate this contact's deposit from their exact quote value (not back-calculated share %)
              let contactPortionIncGST
              if (doc.job_contacts.quote_value_ex_gst) {
                contactPortionIncGST = doc.job_contacts.quote_value_ex_gst * 1.10
              } else {
                const sharePct = doc.job_contacts.share_percentage || 50
                contactPortionIncGST = totalIncGST * (sharePct / 100)
              }
              const depositPct = depositConfig.percent || 50
              invoiceBody.deposit_amount = Math.round(contactPortionIncGST * (depositPct / 100) * 100) / 100
              invoiceBody.deposit_percent = depositPct
            }

            const depRes = await fetch(`${SUPABASE_URL}/functions/v1/ops-api?action=send_acceptance_invoice`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              },
              body: JSON.stringify(invoiceBody),
            })
            invoiceResult = await depRes.json()
            if (invoiceResult.success) {
              console.log(`[send-quote] Acceptance invoice sent: ${invoiceResult.invoice_number} — payment URL: ${invoiceResult.payment_url}`)
            } else {
              console.log(`[send-quote] Acceptance invoice failed: ${invoiceResult.error || 'unknown'}`)
              invoiceResult = null
            }
          } catch (e) {
            console.log('[send-quote] Acceptance invoice failed (non-blocking):', (e as Error).message)
            invoiceResult = null
          }
        }

        // ── Auto-start council process for patio jobs (fire-and-forget) ──
        let councilSubmissionId: string | null = null
        const isPatio = job?.type === 'patio' || job?.job_number?.startsWith('SWP')
        if (isPatio) {
          try {
            const councilRes = await fetch(`${SUPABASE_URL}/functions/v1/ops-api?action=create_council_submission`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
              body: JSON.stringify({ job_id: job.id, template_type: 'standard_council' }),
            })
            const councilResult = await councilRes.json()
            if (councilResult.submission_id) {
              councilSubmissionId = councilResult.submission_id
              console.log(`[send-quote] Council auto-created for ${job.job_number}: ${councilSubmissionId}`)
            }
          } catch (e) {
            console.log('[send-quote] Council auto-create failed (non-blocking):', (e as Error).message)
          }

          // Send "Next Steps & House Plans" email (fire-and-forget — don't block acceptance page)
          {
            const clientFirst = (acceptorName || '').split(' ')[0] || 'there'
            const uploadUrl = `${BASE_URL}/functions/v1/send-quote/upload-plans?token=${token}&job=${job.id}`
            const replyToCouncil = councilSubmissionId
              ? `council+${job.job_number}+CS${councilSubmissionId.slice(0, 8)}+S0@secureworksgroup.app`
              : `approvals@secureworksgroup.app`

            fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'SecureWorks Group <approvals@secureworksgroup.app>',
                reply_to: getClientReplyTo(job?.type, job?.job_number),
                to: [job.client_email || doc.job_contacts?.client_email || ''],
                subject: `Your Patio Project — Next Steps & What We Need From You`,
                html: buildCouncilKickoffEmail(clientFirst, job.site_address || '', job.site_suburb || '', uploadUrl),
              }),
            })
            .then(() => {
              console.log(`[send-quote] Council kickoff email sent for ${job.job_number}`)
              logEmailToGHL(job?.ghl_contact_id, 'Council Kickoff — Next Steps & House Plans', job.client_email || '')
              // Record in po_communications for council thread
              if (councilSubmissionId) {
                sb.from('po_communications').insert({
                  job_id: job.id,
                  direction: 'outbound',
                  from_email: 'approvals@secureworksgroup.app',
                  to_email: job.client_email || '',
                  subject: 'Your Patio Project — Next Steps & What We Need From You',
                  body_text: 'House plans request sent to client on acceptance',
                  communication_type: 'council',
                  council_submission_id: councilSubmissionId,
                  council_step_index: 0,
                  sent_at: new Date().toISOString(),
                  delivery_status: 'sent',
                }).then(() => {}, () => {})
              }
            })
            .catch((e: Error) => console.log('[send-quote] Council email failed (non-blocking):', e.message))
          }
        }

        // Return Next Steps HTML page directly (not via redirect — this is fetched by JS, not loaded as a page)
        const address = [job?.site_address, job?.site_suburb].filter(Boolean).join(', ')
        const nextStepsHtml = buildNextStepsPage({
          clientName: acceptorName,
          projectType: job?.type || 'project',
          address,
          depositAmount: invoiceResult?.deposit_amount || depositConfig.total_deposit_inc_gst || 0,
          depositDescription: depositConfig.description || '',
          paymentUrl: invoiceResult?.payment_url || '',
          invoiceNumber: invoiceResult?.invoice_number || job?.job_number || '',
          shareToken: token,
          isPatio,
          jobId: job?.id || '',
        })
        return new Response(nextStepsHtml, {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'text/html' },
        })
      }

      // Fallback if no job_id (shouldn't happen, but safe)
      const fallbackHtml = buildNextStepsPage({
        clientName: 'Customer',
        projectType: 'project',
        address: '',
        depositAmount: 0,
        depositDescription: '',
        paymentUrl: '',
        invoiceNumber: '',
        shareToken: '',
      })
      return new Response(fallbackHtml, {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'text/html' },
      })
    }

    // ── CLIENT DECLINES QUOTE ──
    if (path === 'decline' && req.method === 'POST') {
      const token = url.searchParams.get('token')
      const body = await req.json().catch(() => ({}))

      if (!token) return jsonResponse({ error: 'Token required' }, 400, corsHeaders)

      const { data: doc, error } = await sb
        .from('job_documents')
        .select('*, jobs(type, site_suburb, job_number, pricing_json)')
        .eq('share_token', token)
        .eq('sent_to_client', true)
        .single()

      if (error || !doc) return jsonResponse({ error: 'Quote not found' }, 404, corsHeaders)

      await sb
        .from('job_documents')
        .update({ declined_at: new Date().toISOString() })
        .eq('id', doc.id)

      // Per-run decline
      if (doc.run_label && doc.job_id) {
        await sb.from('run_acceptances').upsert({
          job_id: doc.job_id,
          job_contact_id: doc.job_contact_id,
          job_document_id: doc.id,
          run_label: doc.run_label,
          status: 'declined',
          declined_at: new Date().toISOString(),
          decline_reason: body.reason || body.comment || null,
        }, { onConflict: 'job_id,job_contact_id,run_label' })

        // Update job status
        await sb.from('jobs').update({ status: 'partially_accepted' }).eq('id', doc.job_id)
      }

      if (doc.job_id) {
        await sb.from('job_events').insert({
          job_id: doc.job_id,
          event_type: doc.run_label ? 'quote_run_declined' : 'quote_declined',
          detail_json: {
            document_id: doc.id,
            run_label: doc.run_label || null,
            reason: body.reason || '',
            reason_label: body.reason_label || body.reason || '',
            comment: body.comment || '',
            declined_at: new Date().toISOString(),
          },
        })
      }

      // Also log to business_events for analytics (price elasticity, win-rate per suburb)
      if (doc.job_id) {
        let quotedAmount = null
        try {
          const p = typeof doc.jobs?.pricing_json === 'string' ? JSON.parse(doc.jobs.pricing_json) : doc.jobs?.pricing_json
          quotedAmount = p?.totalIncGST || p?.total || null
        } catch {}
        await sb.from('business_events').insert({
          event_type: 'quote.declined',
          entity_type: 'job',
          entity_id: doc.job_id,
          detail_json: {
            document_id: doc.id,
            reason: body.reason || '',
            reason_label: body.reason_label || '',
            comment: body.comment || '',
            job_type: doc.jobs?.type || null,
            suburb: doc.jobs?.site_suburb || null,
            job_number: doc.jobs?.job_number || null,
            quoted_amount: quotedAmount,
          },
        }).then(() => {}, () => {}) // non-blocking
      }

      // ── Notify scoper via business_event (telegram-bot reacts to this) ──
      if (doc.job_id) {
        const reasonLabel = body.reason_label || body.reason || 'No reason given'
        const clientName = doc.jobs?.job_number ? `${doc.jobs.job_number}` : 'Unknown'
        await sb.from('business_events').insert({
          event_type: 'quote.declined.notify_scoper',
          entity_type: 'job',
          entity_id: doc.job_id,
          detail_json: {
            reason: reasonLabel,
            comment: body.comment || '',
            job_number: doc.jobs?.job_number || null,
            client_name: clientName,
            message: `Quote declined by client. Reason: ${reasonLabel}. ${body.comment ? 'Comment: ' + body.comment : ''}Call them now?`,
          },
        }).then(() => {}, () => {})
      }

      return jsonResponse({ success: true, message: 'Quote declined' }, 200, corsHeaders)
    }

    // ── SEND PER-RUN FENCING QUOTES (multi-neighbour) ──
    if (path === 'send-runs' && req.method === 'POST') {
      if (!RESEND_API_KEY) {
        return jsonResponse({ error: 'Email service not configured — contact admin' }, 503, corsHeaders)
      }
      const { job_id, message, run_pdfs } = await req.json()
      // run_pdfs: optional map { 'REAR': 'https://...pdf', 'LHS': 'https://...pdf' }
      if (!job_id) return jsonResponse({ error: 'job_id required' }, 400, corsHeaders)

      // Load job with contacts and pricing
      const { data: job, error: jobErr } = await sb.from('jobs')
        .select('*, job_contacts(*)')
        .eq('id', job_id)
        .single()
      if (jobErr || !job) return jsonResponse({ error: 'Job not found' }, 404, corsHeaders)

      const pj = typeof job.pricing_json === 'string' ? JSON.parse(job.pricing_json) : (job.pricing_json || {})
      const runs = pj.runs || []
      if (runs.length === 0) return jsonResponse({ error: 'No runs in pricing_json' }, 400, corsHeaders)

      const contacts = job.job_contacts || []
      const primaryContact = contacts.find((c: any) => c.is_primary) || { client_name: job.client_name, client_email: job.client_email }

      // Create one job_document per run per party (client doc + neighbour doc)
      const createdDocs: any[] = []
      const emailsByRecipient: Record<string, { name: string, email: string, docs: any[], runs: any[] }> = {}

      for (const run of runs) {
        const neighbour = run.neighbour_id ? contacts.find((c: any) => !c.is_primary && c.assigned_runs?.includes?.(run.run_label)) : null

        // Client document for this run
        const runPdfUrl = run_pdfs?.[run.run_label] || null
        const { data: clientDoc } = await sb.from('job_documents').insert({
          job_id: job.id,
          type: 'quote',
          run_label: run.run_label,
          job_contact_id: primaryContact.id || null,
          pdf_url: runPdfUrl,
          sent_to_client: true,
          sent_at: new Date().toISOString(),
          data_snapshot_json: { run },
        }).select('id, share_token').single()

        if (clientDoc) {
          createdDocs.push(clientDoc)
          const clientEmail = primaryContact.client_email || job.client_email
          if (clientEmail) {
            if (!emailsByRecipient[clientEmail]) {
              emailsByRecipient[clientEmail] = { name: primaryContact.client_name || job.client_name, email: clientEmail, docs: [], runs: [] }
            }
            emailsByRecipient[clientEmail].docs.push(clientDoc)
            emailsByRecipient[clientEmail].runs.push(run)
          }

          // Create run_acceptance for client
          await sb.from('run_acceptances').upsert({
            job_id: job.id,
            job_contact_id: primaryContact.id || contacts[0]?.id,
            job_document_id: clientDoc.id,
            run_label: run.run_label,
            status: 'pending',
          }, { onConflict: 'job_id,job_contact_id,run_label' }).then(() => {}, () => {})
        }

        // Neighbour document for this run (if neighbour exists)
        if (neighbour && neighbour.client_email) {
          const { data: nbDoc } = await sb.from('job_documents').insert({
            job_id: job.id,
            type: 'quote',
            run_label: run.run_label,
            job_contact_id: neighbour.id,
            pdf_url: runPdfUrl,
            sent_to_client: true,
            sent_at: new Date().toISOString(),
            data_snapshot_json: { run },
          }).select('id, share_token').single()

          if (nbDoc) {
            createdDocs.push(nbDoc)
            if (!emailsByRecipient[neighbour.client_email]) {
              emailsByRecipient[neighbour.client_email] = { name: neighbour.client_name, email: neighbour.client_email, docs: [], runs: [] }
            }
            emailsByRecipient[neighbour.client_email].docs.push(nbDoc)
            emailsByRecipient[neighbour.client_email].runs.push(run)

            // Create run_acceptance for neighbour
            await sb.from('run_acceptances').upsert({
              job_id: job.id,
              job_contact_id: neighbour.id,
              job_document_id: nbDoc.id,
              run_label: run.run_label,
              status: 'pending',
            }, { onConflict: 'job_id,job_contact_id,run_label' }).then(() => {}, () => {})
          }
        }

        // Write structured run_line_items for AI queryability
        const itemRows = (run.items || []).map((item: any, idx: number) => ({
          org_id: DEFAULT_ORG_ID,
          job_id: job.id,
          run_label: run.run_label,
          job_contact_id: neighbour?.id || null,
          description: item.description,
          quantity: item.quantity || 1,
          unit: item.unit || null,
          unit_price_ex: item.unit_price_ex || 0,
          line_total_ex: item.line_total_ex || 0,
          allocation: item.allocation || 'shared',
          split_pct: item.split_pct ?? 50,
          allocation_note: item.allocation_note || null,
          client_amount_ex: item.client_amount_ex || 0,
          neighbour_amount_ex: item.neighbour_amount_ex || 0,
          sort_order: idx,
        }))
        if (itemRows.length > 0) {
          // Clear existing items for this run, then insert fresh
          await sb.from('run_line_items').delete().eq('job_id', job.id).eq('run_label', run.run_label)
          await sb.from('run_line_items').insert(itemRows)
        }
      }

      // ── Cap 0 quote_revision precompute for /send-runs (Job Release Packet V1) ──
      // Per Codex stop-gate review (task-molbo0d5-4v6crc) we record the
      // quote_revisions row ONLY at the release moment (post-Resend success +
      // jobs.status flip), not pre-Resend. This precomputes the per-run scope
      // summary + neighbour flag + first-client-doc reference that the
      // post-flip recordReleasedQuoteRevision call needs.
      const firstClientDocForRev = createdDocs[0] || null
      const anyRunPdfUrl = (run_pdfs && Object.values(run_pdfs).find((u): u is string => typeof u === 'string' && u.length > 0)) || ''
      const runsScopeSummary = runs.map((r: any) => ({
        run_label: String(r.run_label),
        run_name: r.run_name ? String(r.run_name) : null,
        neighbour_id: r.neighbour_id ? String(r.neighbour_id) : null,
        items_count: Array.isArray(r.items) ? r.items.length : 0,
      }))
      const anyNeighbourBound = runs.some((r: any) => !!r.neighbour_id)

      // Send emails grouped by recipient
      const viewBaseUrl = `${SUPABASE_URL}/functions/v1/send-quote/view`
      let emailsSent = 0
      let primarySent = false
      const primaryEmail = (primaryContact.client_email || job.client_email || '').toLowerCase()

      for (const [email, recipient] of Object.entries(emailsByRecipient)) {
        const runLinks = recipient.docs.map((doc: any, i: number) => {
          const run = recipient.runs[i]
          return `<a href="${viewBaseUrl}?token=${doc.share_token}" style="display:block;padding:12px 16px;margin:8px 0;background:#f8f9fa;border-radius:8px;border-left:3px solid #F15A29;text-decoration:none;color:#293C46;font-weight:600;">${run.run_name || run.run_label} — View & Accept →</a>`
        }).join('')

        const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;">
<tr><td style="background:#F15A29;height:4px;"></td></tr>
<tr><td style="background:#293C46;padding:20px 32px;">
  <span style="color:#fff;font-size:18px;font-weight:700;">SecureWorks</span>
  <span style="color:rgba(255,255,255,0.6);font-size:16px;font-weight:400;margin-left:4px;">Group</span>
</td></tr>
<tr><td style="padding:32px;">
  <h1 style="margin:0 0 16px;color:#293C46;font-size:22px;">Your fencing quote is ready</h1>
  <p style="color:#4C6A7C;font-size:15px;line-height:1.6;margin:0 0 16px;">Hi ${recipient.name},</p>
  ${message ? `<p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 16px;">${message}</p>` : ''}
  <p style="color:#4C6A7C;font-size:15px;line-height:1.6;margin:0 0 16px;">
    Thank you for giving us the opportunity to quote on your fencing project${job.site_suburb ? ' in ' + job.site_suburb : ''}.
    This job has ${recipient.runs.length} fence run${recipient.runs.length > 1 ? 's' : ''} — each with its own quote below.
  </p>
  ${runLinks}
  <p style="color:#4C6A7C;font-size:13px;margin-top:24px;">Each quote is valid for 30 days. You can accept or decline each run independently.</p>
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #eee;text-align:center;">
  <p style="color:#999;font-size:12px;">SecureWorks Group Pty Ltd | ABN 64 689 223 416</p>
</td></tr>
</table></body></html>`

        try {
          // Build attachments from PDFs (if available)
          const attachments: any[] = []
          if (run_pdfs) {
            for (const run of recipient.runs) {
              const pdfUrl = run_pdfs[run.run_label]
              if (pdfUrl) {
                attachments.push({
                  path: pdfUrl,
                  filename: `Quote_${job.job_number || 'SWF'}_${run.run_label}.pdf`,
                })
              }
            }
          }

          const emailPayload: any = {
            from: `${FROM_NAME} <${FROM_EMAIL}>`,
            to: [email],
            subject: `Your Fencing Quote — ${job.job_number || ''} — SecureWorks Group`,
            html: emailHtml,
          }
          if (attachments.length > 0) emailPayload.attachments = attachments

          const resendRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
            body: JSON.stringify(emailPayload)
          })
          if (resendRes.ok) {
            emailsSent++
            if (primaryEmail && email.toLowerCase() === primaryEmail) primarySent = true
          }
        } catch (e: any) {
          console.log(`[send-runs] Failed to email ${email}:`, e.message)
        }
      }

      // Per ADR 2026-04-27: 'quoted' = quote sent to the primary client.
      // A neighbour-only success does NOT release the quote.
      // Only flip status from 'draft' to 'quoted' — never regress an already
      // accepted / scheduled / in_progress / complete / invoiced job back to quoted.
      // We gate canonical emits on the UPDATE's affected-row count (not a pre-select),
      // so a concurrent writer that moved the job out of 'draft' between read and write
      // cannot cause a false canonical release event.
      let transitioned = false
      if (primarySent) {
        const { data: updatedRows } = await sb.from('jobs')
          .update({ status: 'quoted', quoted_at: new Date().toISOString() })
          .eq('id', job.id)
          .eq('status', 'draft')
          .select('id')
        transitioned = Array.isArray(updatedRows) && updatedRows.length > 0
      } else {
        console.log(`[send-runs] Primary client send did not succeed (primaryEmail=${primaryEmail || '(none)'}, emailsSent=${emailsSent}). Leaving job unquoted.`)
      }

      // Analytics event (preserved): records the runs-bundle send attempt regardless of outcome.
      // job_id is now the row uuid (was previously job_number || id, which wrote a number string
      // into a uuid column). This adjustment ships with the send-runs release-truth refactor.
      sb.from('business_events').insert({
        event_type: 'quote.runs_sent',
        source: 'send-quote',
        occurred_at: new Date().toISOString(),
        recorded_at: new Date().toISOString(),
        entity_type: 'job',
        entity_id: job.id,
        job_id: job.id,
        payload: {
          run_count: runs.length,
          docs_created: createdDocs.length,
          emails_sent: emailsSent,
          primary_sent: primarySent,
          released: transitioned,
          job_number: job.job_number,
        },
        metadata: {},
      }).then(() => {}, () => {})

      // Canonical release events — only when this call's UPDATE actually flipped
      // the job from 'draft' to 'quoted'. Resends on an already-quoted/accepted/etc.
      // job no-op the UPDATE (zero affected rows) and emit nothing here.
      if (transitioned) {
        const nowIso = new Date().toISOString()
        const totalIncGST = pj?.totalIncGST ?? pj?.total ?? pj?.grandTotal ?? 0
        const firstClientDoc = createdDocs[0]

        // Cap 0 quote_revisions: record the released row HERE for /send-runs.
        // Atomic with the release moment. One revision per call regardless of
        // run count; manifest captures all runs in scope_snapshot.runs[].
        let releasedRevisionIdRuns: string | null = null
        if (firstClientDocForRev?.id) {
          releasedRevisionIdRuns = await recordReleasedQuoteRevision(sb, {
            job_id: job.id,
            job_document_id: firstClientDocForRev.id,
            version: 1,
            recipient_email: primaryContact.client_email || job.client_email || '',
            recipient_label: primaryContact.client_name || null,
            build_kind: 'fence',
            neighbours_required: anyNeighbourBound,
            scope: {
              client_name: job.client_name || null,
              site_address: job.site_address || null,
              site_suburb: job.site_suburb || null,
              job_type: job.type || 'fencing',
              job_number: job.job_number || null,
              runs: runsScopeSummary,
            },
            pricing_json: pj,
            pdf_url: anyRunPdfUrl,
            released_via: 'send-quote/send-runs',
            org_id: DEFAULT_ORG_ID,
          }, { handler: 'send-quote/send-runs', job_id: job.id })
        }

        await safeBusinessEventInsert(sb, {
          event_type: 'quote.sent',
          source: 'send-quote',
          occurred_at: nowIso,
          recorded_at: nowIso,
          entity_type: 'job',
          entity_id: job.id,
          correlation_id: job.id,
          job_id: job.id,
          payload: {
            document_id: firstClientDoc?.id || null,
            quote_revision_id: releasedRevisionIdRuns,
            job_number: job.job_number || null,
            job_type: job.type || 'fencing',
            sent_to: primaryContact.client_email || job.client_email,
            total_inc_gst: totalIncGST,
            run_count: runs.length,
            docs_created: createdDocs.length,
          },
          metadata: { handler: 'send-quote/send-runs' },
          schema_version: '1.0',
        }, { handler: 'send-quote/send-runs', job_id: job.id })

        await safeBusinessEventInsert(sb, {
          event_type: 'job.status_changed',
          source: 'send-quote',
          occurred_at: nowIso,
          recorded_at: nowIso,
          entity_type: 'job',
          entity_id: job.id,
          correlation_id: job.id,
          job_id: job.id,
          payload: {
            entity: { id: job.id, name: job.job_number || job.client_name || '' },
            changes: { status: { from: 'draft', to: 'quoted' } },
            financial: { amount: totalIncGST },
            related_entities: [
              ...createdDocs.slice(0, 5).map((d: any) => ({ type: 'job_document', id: d.id })),
              ...(releasedRevisionIdRuns ? [{ type: 'quote_revision', id: releasedRevisionIdRuns }] : []),
            ],
          },
          metadata: { reason: 'quote_sent_runs', handler: 'send-quote/send-runs' },
          schema_version: '1.0',
        }, { handler: 'send-quote/send-runs', job_id: job.id })
      }

      return jsonResponse({
        success: true,
        runs_sent: runs.length,
        documents_created: createdDocs.length,
        emails_sent: emailsSent,
        documents: createdDocs.map((d: any) => ({ id: d.id, token: d.share_token })),
      }, 200, corsHeaders)
    }

    // ── SEND BRANDED INVOICE EMAIL ──
    if (path === 'send-invoice' && req.method === 'POST') {
      const body = await req.json()
      const { xero_invoice_id, job_id, payment_url, invoice_number, deposit_amount,
              client_name, client_email, job_type, address, share_token, due_date } = body

      if (!xero_invoice_id || !job_id || !client_email) {
        return jsonResponse({ error: 'xero_invoice_id, job_id, and client_email required' }, 400, corsHeaders)
      }

      // Look up job for reply-to routing and GHL logging
      const { data: invoiceJob } = await sb.from('jobs')
        .select('job_number, type, ghl_contact_id')
        .eq('id', job_id).maybeSingle()

      const firstName = (client_name || 'there').split(' ')[0]
      const typeName = job_type === 'fencing' ? 'fencing' : job_type === 'decking' ? 'decking' : 'patio'
      const dueDate = due_date || new Date(Date.now() + 14 * 86400000).toLocaleDateString('en-AU')
      const depositFormatted = deposit_amount > 0
        ? '$' + Number(deposit_amount).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : ''

      // Build payment-confirmed URL (for "I've paid" button)
      const paymentConfirmedUrl = share_token
        ? `${BASE_URL}/functions/v1/send-quote/payment-confirmed?token=${share_token}`
        : ''

      const emailSubject = `Deposit Invoice ${invoice_number || ''} — SecureWorks Group`.trim()
      const emailHtml = buildInvoiceEmail({
        firstName,
        jobType: typeName,
        address: address || '',
        invoiceNumber: invoice_number || '',
        depositAmount: depositFormatted,
        dueDate,
        paymentUrl: payment_url || '',
        paymentConfirmedUrl,
      })

      let resendMessageId: string | null = null

      if (RESEND_API_KEY) {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: `${FROM_NAME} <invoices@secureworksgroup.app>`,
            reply_to: getClientReplyTo(invoiceJob?.type || job_type, invoiceJob?.job_number),
            to: client_email,
            subject: emailSubject,
            html: emailHtml,
          }),
        })

        if (emailRes.ok) {
          const resendData = await emailRes.json()
          resendMessageId = resendData.id
          await insertEmailEvent(sb, {
            emailType: 'invoice', jobId: job_id, recipient: client_email,
            subject: emailSubject, resendMessageId,
            status: 'sent',
            metadata: { xero_invoice_id, invoice_number, deposit_amount, client_name, job_type },
          })
          // Log to po_communications for client email thread
          sb.from('po_communications').insert({
            job_id, direction: 'outbound',
            from_email: 'invoices@secureworksgroup.app', to_email: client_email,
            subject: emailSubject, body_html: emailHtml,
            communication_type: 'client', sent_at: new Date().toISOString(),
            message_id: resendMessageId, delivery_status: 'sent',
          }).then(() => {}, () => {})
          // Log note to GHL contact
          logEmailToGHL(invoiceJob?.ghl_contact_id, emailSubject, client_email)
        } else {
          const errData = await emailRes.json().catch(() => ({}))
          console.log('[send-invoice] Resend failed:', JSON.stringify(errData))
          await insertEmailEvent(sb, {
            emailType: 'invoice', jobId: job_id, recipient: client_email,
            subject: emailSubject, status: 'failed',
            failureReason: errData.message || `HTTP ${emailRes.status}`,
            metadata: { xero_invoice_id, invoice_number, client_name },
          })
          return jsonResponse({ error: 'Email send failed', detail: errData.message }, 502, corsHeaders)
        }
      }

      return jsonResponse({ success: true, resend_message_id: resendMessageId }, 200, corsHeaders)
    }

    // ── PAYMENT CONFIRMED ("I've paid" signal) ──
    if (path === 'payment-confirmed' && req.method === 'POST') {
      const token = url.searchParams.get('token')
      if (!token) return jsonResponse({ error: 'Token required' }, 400, corsHeaders)

      // Look up the document by share_token to find job + contact
      const { data: doc, error: docErr } = await sb
        .from('job_documents')
        .select('*, jobs(client_name, job_number, type, site_address, site_suburb), job_contacts(client_name)')
        .eq('share_token', token)
        .single()

      if (docErr || !doc) return await htmlResponse(errorPage('Invalid or expired link'))

      const contactName = doc.job_contacts?.client_name || doc.jobs?.client_name || 'Client'
      const firstName = contactName.split(' ')[0]

      // Insert job_event — this is an ops signal, not payment confirmation
      await sb.from('job_events').insert({
        job_id: doc.job_id,
        event_type: 'client_payment_claimed',
        detail_json: {
          client_name: contactName,
          job_number: doc.jobs?.job_number || null,
          claimed_at: new Date().toISOString(),
          share_token: token,
          message: `${contactName} clicked "I've paid" for ${doc.jobs?.job_number || 'unknown job'}`,
        },
      })

      // Insert business_event for Terminal D / daily-digest pickup
      await sb.from('business_events').insert({
        event_type: 'payment.claimed',
        entity_type: 'job',
        entity_id: doc.job_id,
        detail_json: {
          client_name: contactName,
          job_number: doc.jobs?.job_number || null,
          job_type: doc.jobs?.type || null,
          address: [doc.jobs?.site_address, doc.jobs?.site_suburb].filter(Boolean).join(', '),
        },
      }).then(() => {}, () => {}) // non-blocking

      // Return branded success page
      return await htmlResponse(buildPaymentConfirmedPage(firstName))
    }

    // ── PAYMENT CONFIRMED (GET — for direct link clicks from email) ──
    if (path === 'payment-confirmed' && req.method === 'GET') {
      const token = url.searchParams.get('token')
      if (!token) return await htmlResponse(errorPage('Invalid link'))

      // Show a simple page with a confirm button that POSTs
      return await htmlResponse(buildPaymentConfirmPromptPage(token))
    }

    // ── UPLOAD PLANS — client uploads house plans for council process ──
    if (path === 'upload-plans' && req.method === 'GET') {
      const token = url.searchParams.get('token')
      const jobId = url.searchParams.get('job')
      if (!token) return new Response('Invalid link', { status: 400, headers: corsHeaders })

      // Validate token
      const { data: doc } = await sb.from('job_documents').select('job_id, accepted_at, jobs(site_address, site_suburb)').eq('share_token', token).maybeSingle()
      const addr = doc?.jobs ? [doc.jobs.site_address, doc.jobs.site_suburb].filter(Boolean).join(', ') : ''

      return new Response(buildUploadPlansPage(token, jobId || doc?.job_id || '', addr), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'text/html' },
      })
    }

    if (path === 'upload-plans' && req.method === 'POST') {
      const body = await req.json()
      const { token, job_id, filename, content_base64, content_type } = body
      if (!token || !content_base64) return jsonResponse({ error: 'token and content_base64 required' }, 400, corsHeaders)

      // Validate token
      const { data: doc } = await sb.from('job_documents').select('job_id').eq('share_token', token).maybeSingle()
      const jId = job_id || doc?.job_id
      if (!jId) return jsonResponse({ error: 'Invalid token or job not found' }, 404, corsHeaders)

      // Upload to Storage
      try { await sb.storage.createBucket('job-documents', { public: true }) } catch { /* exists */ }
      const filePath = `${jId}/council/house-plans/${Date.now()}-${filename || 'house-plans.pdf'}`
      const fileBuffer = Uint8Array.from(atob(content_base64), c => c.charCodeAt(0))
      await sb.storage.from('job-documents').upload(filePath, fileBuffer, {
        contentType: content_type || 'application/pdf', upsert: true,
      })
      const { data: urlData } = sb.storage.from('job-documents').getPublicUrl(filePath)

      // Business event
      await sb.from('business_events').insert({
        event_type: 'council.plans_received',
        entity_type: 'job',
        entity_id: jId,
        detail_json: { filename, source: 'upload_page', url: urlData?.publicUrl },
      }).then(() => {}, () => {})

      // Annotation
      await sb.from('ai_annotations').insert({
        org_id: DEFAULT_ORG_ID,
        entity_type: 'job',
        entity_id: jId,
        ui_location: 'job_overview',
        annotation_type: 'council_plans_received',
        category: 'council',
        title: 'House plans uploaded by client',
        body: `${filename || 'Plans'} uploaded via acceptance page`,
        priority: 60,
        severity: 'info',
        source: 'send-quote',
        source_ref: `plans:${jId}:${Date.now()}`,
        confidence: 1.0,
      }).then(() => {}, () => {})

      // Update council submission step 0 if exists
      const { data: submission } = await sb.from('council_submissions')
        .select('id, steps').eq('job_id', jId).maybeSingle()
      if (submission && submission.steps && submission.steps[0]?.status === 'pending') {
        const steps = [...submission.steps]
        steps[0] = { ...steps[0], status: 'complete', completed_at: new Date().toISOString(), documents_received: [{ filename, url: urlData?.publicUrl }] }
        await sb.from('council_submissions').update({ steps, current_step_index: 1 }).eq('id', submission.id)
      }

      return jsonResponse({ success: true, url: urlData?.publicUrl }, 200, corsHeaders)
    }

    // ── NEIGHBOUR NUDGE SMS (T7 — gated, call via cron or manual trigger) ──
    if (path === 'neighbour-nudge' && req.method === 'POST') {
      const ENABLE_NUDGE = Deno.env.get('ENABLE_NEIGHBOUR_NUDGE') === 'true'
      if (!ENABLE_NUDGE) {
        return jsonResponse({ skipped: true, reason: 'ENABLE_NEIGHBOUR_NUDGE is not true' }, 200, corsHeaders)
      }

      // Find multi-contact jobs where A has paid but B hasn't opened in 4+ days
      const fourDaysAgo = new Date(Date.now() - 4 * 86400000).toISOString()

      // Get jobs with multiple contacts that have deposit invoices
      const { data: multiContactJobs } = await sb
        .from('job_contacts')
        .select('job_id')
        .not('job_id', 'is', null)

      if (!multiContactJobs || multiContactJobs.length === 0) {
        return jsonResponse({ nudges_sent: 0, reason: 'No multi-contact jobs found' }, 200, corsHeaders)
      }

      // Group by job_id, only keep jobs with 2+ contacts
      const jobCounts: Record<string, number> = {}
      multiContactJobs.forEach((jc: any) => { jobCounts[jc.job_id] = (jobCounts[jc.job_id] || 0) + 1 })
      const multiJobs = Object.keys(jobCounts).filter(jid => jobCounts[jid] > 1)

      let nudgesSent = 0

      for (const jobId of multiJobs) {
        // Check if nudge already sent for this job
        const { data: existing } = await sb
          .from('job_events')
          .select('id')
          .eq('job_id', jobId)
          .eq('event_type', 'neighbour_nudge_sent')
          .limit(1)
        if (existing && existing.length > 0) continue

        // Get all contacts for this job
        const { data: contacts } = await sb
          .from('job_contacts')
          .select('id, client_name, client_phone, ghl_contact_id, contact_label')
          .eq('job_id', jobId)

        if (!contacts || contacts.length < 2) continue

        // Get job details
        const { data: job } = await sb
          .from('jobs')
          .select('id, job_number, type, site_address, site_suburb')
          .eq('id', jobId)
          .single()

        // Check which contacts have paid (via xero_invoices PAID status)
        const { data: paidInvoices } = await sb
          .from('xero_invoices')
          .select('job_contact_id, status')
          .eq('job_id', jobId)
          .eq('status', 'PAID')
          .not('job_contact_id', 'is', null)

        const paidContactIds = new Set((paidInvoices || []).map((inv: any) => inv.job_contact_id))

        // Check which contacts' quote emails haven't been opened
        const { data: emailEvents } = await sb
          .from('email_events')
          .select('job_id, recipient, status, metadata, sent_at')
          .eq('job_id', jobId)
          .eq('email_type', 'invoice')

        for (const contact of contacts) {
          if (paidContactIds.has(contact.id)) continue // this one paid, skip

          // Check if their invoice email was sent > 4 days ago and never opened
          const contactEmail = emailEvents?.find((ev: any) =>
            ev.metadata?.client_name === contact.client_name && ev.status === 'sent' && ev.sent_at < fourDaysAgo
          )
          const wasOpened = emailEvents?.some((ev: any) =>
            ev.metadata?.client_name === contact.client_name && (ev.status === 'opened' || ev.status === 'delivered')
          )

          if (!contactEmail || wasOpened) continue

          // Found: unpaid contact whose email hasn't been opened in 4+ days
          // Find a paid contact to nudge
          const paidContact = contacts.find((c: any) => paidContactIds.has(c.id) && c.ghl_contact_id)
          if (!paidContact) continue

          const paidFirstName = paidContact.client_name?.split(' ')[0] || 'there'
          const unpaidAddress = job?.site_address || 'next door'

          const smsMessage = `Hi ${paidFirstName}, we have your deposit and we're ready to order materials. We're just waiting on the neighbour at ${unpaidAddress} to confirm their share. Sometimes a friendly knock helps get things moving!`

          // Send via GHL
          try {
            await fetch(`${SUPABASE_URL}/functions/v1/ghl-proxy?action=send_sms`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contactId: paidContact.ghl_contact_id,
                message: smsMessage,
              }),
            })

            // Guard: log so we never send twice for this job
            await sb.from('job_events').insert({
              job_id: jobId,
              event_type: 'neighbour_nudge_sent',
              detail_json: {
                nudged_contact: paidContact.client_name,
                waiting_on: contact.client_name,
                message: smsMessage,
              },
            })
            nudgesSent++
          } catch (e) {
            console.log('[neighbour-nudge] SMS failed:', (e as Error).message)
          }

          break // one nudge per job max
        }
      }

      return jsonResponse({ success: true, nudges_sent: nudgesSent }, 200, corsHeaders)
    }

    return jsonResponse({ error: 'Not found' }, 404, corsHeaders)

  } catch (err) {
    console.error('Send-quote error:', err)
    return jsonResponse({ error: err.message || 'Internal error' }, 500, corsHeaders)
  }
})

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

function jsonResponse(data: any, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })
}

async function htmlResponse(html: string) {
  // Supabase edge runtime forces text/plain on GET text/html responses (CSP sandbox).
  // Workaround: store HTML in public bucket, redirect to a viewer page that fetches it.
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const pageId = crypto.randomUUID()
  const fileName = `pages/${pageId}.txt`
  try { await sb.storage.createBucket('quote-views', { public: true }) } catch { /* exists */ }
  await sb.storage.from('quote-views').upload(fileName, html, {
    contentType: 'text/plain',
    upsert: true,
  })
  const { data: urlData } = sb.storage.from('quote-views').getPublicUrl(fileName)
  const viewerUrl = `${QUOTE_VIEWER_BASE}?src=${encodeURIComponent(urlData.publicUrl)}`
  return Response.redirect(viewerUrl, 302)
}

// ════════════════════════════════════════════════════════════
// EMAIL TEMPLATE
// ════════════════════════════════════════════════════════════

function buildQuoteEmail(opts: {
  clientName: string
  viewUrl: string
  pdfUrl: string
  projectType: string
  suburb: string
  customMessage: string
  scoperName: string
}): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;">
    <!-- Header -->
    <tr><td style="background:#F15A29;height:4px;"></td></tr>
    <tr><td style="background:#293C46;padding:20px 32px;">
      <span style="color:#fff;font-size:18px;font-weight:700;letter-spacing:0.5px;">SecureWorks</span>
      <span style="color:rgba(255,255,255,0.6);font-size:16px;font-weight:400;margin-left:4px;">Group</span>
    </td></tr>

    <!-- Body -->
    <tr><td style="padding:32px;">
      <h1 style="margin:0 0 16px;color:#293C46;font-size:22px;">Your ${opts.projectType} quote is ready</h1>
      <p style="color:#4C6A7C;font-size:15px;line-height:1.6;margin:0 0 16px;">
        Hi ${opts.clientName},
      </p>
      ${opts.customMessage ? `<p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 16px;">${opts.customMessage}</p>` : ''}
      <p style="color:#4C6A7C;font-size:15px;line-height:1.6;margin:0 0 24px;">
        Thank you for giving us the opportunity to quote on your ${opts.projectType} project${opts.suburb ? ' in ' + opts.suburb : ''}.
        Please find your detailed quote attached below.
      </p>

      <!-- CTA Button -->
      <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
        <tr><td style="background:#F15A29;border-radius:8px;">
          <a href="${opts.viewUrl}" style="display:inline-block;padding:14px 32px;color:#fff;text-decoration:none;font-size:16px;font-weight:600;">
            View Your Quote
          </a>
        </td></tr>
      </table>

      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">

      <p style="color:#4C6A7C;font-size:14px;line-height:1.6;margin:0 0 8px;">
        If you have any questions, don't hesitate to reach out. We're happy to walk through the quote with you.
      </p>
      <p style="color:#293C46;font-size:14px;font-weight:600;margin:0;">
        ${opts.scoperName}<br>
        <span style="font-weight:400;color:#4C6A7C;">SecureWorks Group</span><br>
        <a href="tel:+61489267771" style="color:#F15A29;text-decoration:none;">Call us</a> &nbsp;|&nbsp;
        <a href="mailto:admin@secureworkswa.com.au" style="color:#F15A29;text-decoration:none;">Email</a>
      </p>
    </td></tr>

    <!-- Cross-sell footer -->
    <tr><td style="background:#293C46;padding:20px 32px;">
      <p style="color:#ffffff;font-size:13px;margin:0;text-align:center;line-height:1.6;">
        <strong>SecureWorks Group</strong> — Insulated Patios | Fencing &amp; Screening | Composite Decking<br>
        <span style="color:#F15A29;">Transform your entire outdoor space — ask us about a complete package</span>
      </p>
    </td></tr>

    <!-- Footer -->
    <tr><td style="background:#f5f5f7;padding:20px 32px;border-top:1px solid #eee;">
      <p style="color:#999;font-size:11px;margin:0;line-height:1.5;">
        SecureWorks Group Pty Ltd | ABN 64 689 223 416<br>
        This quote is valid for 30 days from the date of issue.
      </p>
    </td></tr>
  </table>
</body>
</html>`
}

// ════════════════════════════════════════════════════════════
// CLIENT-FACING QUOTE PAGE
// ════════════════════════════════════════════════════════════

function buildClientPage(doc: any, token: string): string {
  const clientName = doc.jobs?.client_name || 'Customer'
  const projectType = doc.jobs?.type || 'project'
  const suburb = doc.jobs?.site_suburb || ''
  const isAccepted = !!doc.accepted_at
  const isDeclined = !!doc.declined_at

  let statusHtml = ''
  if (isAccepted) {
    statusHtml = '<div style="background:#34C75920;color:#34C759;padding:16px;border-radius:8px;text-align:center;font-weight:600;margin-bottom:24px;">Quote Accepted &mdash; Thank you! We\'ll be in touch shortly.</div>'
  } else if (isDeclined) {
    statusHtml = '<div style="background:#FF3B3020;color:#FF3B30;padding:16px;border-radius:8px;text-align:center;font-weight:600;margin-bottom:24px;">Quote Declined</div>'
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Quote — SecureWorks Group</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif; background: #f5f5f7; color: #333; }
    .header { background: #293C46; padding: 16px 24px; }
    .header-brand { color: #fff; font-size: 18px; font-weight: 700; }
    .header-brand span { color: rgba(255,255,255,0.6); font-weight: 400; }
    .container { max-width: 720px; margin: 0 auto; padding: 24px 16px; }
    .card { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 16px; }
    h1 { color: #293C46; font-size: 22px; margin-bottom: 8px; }
    .subtitle { color: #4C6A7C; font-size: 14px; margin-bottom: 24px; }
    .pdf-frame { width: 100%; height: 80vh; min-height: 600px; border: none; border-radius: 8px; background: #f0f0f0; }
    .confirm-overlay { display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center; }
    .confirm-overlay.active { display:flex; }
    .confirm-box { background:#fff;border-radius:12px;padding:28px;max-width:400px;width:90%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.2); }
    .pdf-mobile { display: none; text-align: center; padding: 32px 16px; background: #F9FAFB; border-radius: 8px; border: 1px solid #E5E7EB; }
    .pdf-mobile-icon { font-size: 48px; margin-bottom: 12px; }
    .pdf-mobile p { color: #4C6A7C; font-size: 14px; margin-bottom: 16px; }
    .btn { display: inline-block; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: 600; text-decoration: none; cursor: pointer; border: none; text-align: center; width: 100%; margin-bottom: 8px; }
    .btn-accept { background: #34C759; color: #fff; }
    .btn-decline { background: #f5f5f7; color: #FF3B30; border: 1px solid #FF3B30; }
    .btn-download { background: #293C46; color: #fff; }
    .btn-view-pdf { background: #F15A29; color: #fff; display: inline-block; width: auto; padding: 14px 40px; }
    .btn:hover { opacity: 0.9; }
    .footer { text-align: center; color: #999; font-size: 12px; padding: 24px; }
    @media (max-width: 768px) {
      .pdf-frame { display: none !important; }
      .pdf-mobile { display: block !important; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-brand">SecureWorks <span>Group</span></div>
  </div>
  <div class="container">
    <div class="card">
      <h1>Your ${projectType} quote</h1>
      <p class="subtitle">For ${clientName}${suburb ? ' — ' + suburb : ''}</p>

      ${statusHtml}

      ${doc.pdf_url ? `
      <iframe src="${doc.pdf_url}" class="pdf-frame" title="Quote PDF"></iframe>
      <div class="pdf-mobile">
        <div class="pdf-mobile-icon">📄</div>
        <p>Your detailed quote is ready to view</p>
        <a href="${doc.pdf_url}" target="_blank" class="btn btn-view-pdf">View Quote PDF</a>
      </div>
      ` : '<p style="color:#4C6A7C;text-align:center;padding:20px;">PDF not available</p>'}

      ${!isAccepted && !isDeclined ? `
      <div style="margin-top:24px;padding-top:24px;border-top:1px solid #eee;">
        <p style="color:#4C6A7C;font-size:14px;margin-bottom:16px;">Happy with the quote? Accept below to confirm and we'll be in touch to schedule your project.</p>
        <button class="btn btn-accept" onclick="respondToQuote('accept')">Accept Quote</button>
        <button class="btn btn-decline" onclick="showDeclineForm()">Decline</button>
      </div>
      <div id="declineForm" style="display:none;margin-top:16px;padding:20px;background:#FFF5F5;border:1px solid #FF3B3040;border-radius:8px;">
        <p style="color:#293C46;font-size:15px;font-weight:600;margin-bottom:12px;">We'd appreciate your feedback</p>
        <p style="color:#4C6A7C;font-size:13px;margin-bottom:16px;">This helps us improve our service. Select the main reason:</p>
        <div id="declineReasons" style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#fff;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:14px;color:#333;">
            <input type="radio" name="declineReason" value="price" style="accent-color:#F15A29;"> Price too high
          </label>
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#fff;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:14px;color:#333;">
            <input type="radio" name="declineReason" value="timeline" style="accent-color:#F15A29;"> Timeline doesn't work
          </label>
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#fff;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:14px;color:#333;">
            <input type="radio" name="declineReason" value="competitor" style="accent-color:#F15A29;"> Going with another company
          </label>
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#fff;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:14px;color:#333;">
            <input type="radio" name="declineReason" value="scope_changed" style="accent-color:#F15A29;"> Project scope changed
          </label>
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#fff;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:14px;color:#333;">
            <input type="radio" name="declineReason" value="not_proceeding" style="accent-color:#F15A29;"> Not proceeding at all
          </label>
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#fff;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:14px;color:#333;">
            <input type="radio" name="declineReason" value="other" style="accent-color:#F15A29;"> Other
          </label>
        </div>
        <textarea id="declineComment" placeholder="Any additional feedback? (optional)" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:14px;font-family:inherit;resize:vertical;min-height:60px;margin-bottom:12px;"></textarea>
        <div style="display:flex;gap:8px;">
          <button class="btn" style="background:#FF3B30;color:#fff;flex:1;" onclick="submitDecline()">Confirm Decline</button>
          <button class="btn" style="background:#f5f5f7;color:#4C6A7C;flex:1;" onclick="hideDeclineForm()">Cancel</button>
        </div>
      </div>
      ` : ''}
    </div>

    ${buildSupportingDocsHtml(doc)}

    <div class="card" style="text-align:center;">
      <p style="color:#4C6A7C;font-size:14px;">Questions about your quote?</p>
      <p style="margin-top:8px;">
        <a href="tel:+61489267771" style="color:#F15A29;font-weight:600;text-decoration:none;">Call Us</a> &nbsp;|&nbsp;
        <a href="mailto:admin@secureworkswa.com.au" style="color:#F15A29;font-weight:600;text-decoration:none;">Email</a>
      </p>
    </div>

    <div class="footer">
      SecureWorks Group Pty Ltd | ABN 64 689 223 416<br>
      This quote is valid for 30 days from the date of issue.
    </div>
  </div>

  <script>
    function showDeclineForm() {
      document.getElementById('declineForm').style.display = 'block';
    }
    function hideDeclineForm() {
      document.getElementById('declineForm').style.display = 'none';
    }
    async function submitDecline() {
      var selected = document.querySelector('input[name="declineReason"]:checked');
      if (!selected) { alert('Please select a reason before declining.'); return; }
      var reason = selected.value;
      var comment = (document.getElementById('declineComment').value || '').trim();
      await respondToQuote('decline', { reason: reason, comment: comment });
    }
    function showAcceptConfirm() {
      var overlay = document.createElement('div');
      overlay.className = 'confirm-overlay active';
      overlay.innerHTML = '<div class="confirm-box">' +
        '<div style="font-size:36px;margin-bottom:12px">&#9989;</div>' +
        '<h3 style="color:#293C46;font-size:18px;margin-bottom:8px">Accept this quote?</h3>' +
        '<p style="color:#4C6A7C;font-size:14px;margin-bottom:20px">This confirms your agreement to the terms and conditions included.</p>' +
        '<div style="display:flex;gap:8px">' +
        '<button onclick="this.closest(\\'.confirm-overlay\\').remove()" style="flex:1;padding:12px;border:1px solid #ddd;border-radius:8px;background:#fff;font-size:15px;cursor:pointer;font-family:inherit">Cancel</button>' +
        '<button onclick="this.closest(\\'.confirm-overlay\\').remove();doAccept()" style="flex:1;padding:12px;border:none;border-radius:8px;background:#34C759;color:#fff;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit">Yes, Accept</button>' +
        '</div></div>';
      document.body.appendChild(overlay);
    }
    function doAccept() { respondToQuote('accept_confirmed'); }

    async function respondToQuote(action, declineData) {
      if (action === 'accept') {
        showAcceptConfirm(); return;
      }
      if (action === 'accept_confirmed') action = 'accept';

      // Show processing overlay for accept
      if (action === 'accept') {
        var overlay = document.createElement('div');
        overlay.id = 'processingOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,0.95);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;';
        overlay.innerHTML = '<div style="width:40px;height:40px;border:4px solid #D4DEE4;border-top-color:#F15A29;border-radius:50%;animation:spin 0.8s linear infinite;"></div><div style="color:#293C46;font-size:16px;font-weight:600;">Confirming your acceptance...</div><div style="color:#4C6A7C;font-size:13px;">This may take 10-15 seconds</div>';
        var style = document.createElement('style');
        style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
        document.head.appendChild(style);
        document.body.appendChild(overlay);
      }

      var payload = {};
      if (action === 'decline' && declineData) {
        payload = {
          reason: declineData.reason,
          reason_label: { price: 'Price too high', timeline: 'Timeline doesn\\'t work', competitor: 'Going with another company', scope_changed: 'Project scope changed', not_proceeding: 'Not proceeding at all', other: 'Other' }[declineData.reason] || declineData.reason,
          comment: declineData.comment || ''
        };
      }

      try {
        var res = await fetch('https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/send-quote/' + action + '?token=${token}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          if (action === 'accept') {
            var html = await res.text();
            document.open();
            document.write(html);
            document.close();
          } else {
            window.location.reload();
          }
        } else {
          var po = document.getElementById('processingOverlay'); if (po) po.remove();
          var ct = res.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            var data = await res.json();
            alert(data.error || 'Something went wrong');
          } else {
            alert('Something went wrong. Please try again.');
          }
        }
      } catch(e) {
        var po = document.getElementById('processingOverlay'); if (po) po.remove();
        alert('Failed to send response. Please try again.');
      }
    }
  </script>
</body>
</html>`
}

// ════════════════════════════════════════════════════════════
// PER-RUN FENCING QUOTE PAGE (multi-neighbour)
// ════════════════════════════════════════════════════════════

function buildRunQuotePage(doc: any, token: string, run: any, job: any, viewerType: string): string {
  const clientName = job?.client_name || 'Customer'
  const clientAddress = job?.site_address || ''
  const suburb = job?.site_suburb || ''
  const jobNumber = job?.job_number || ''
  const runLabel = run.run_label || ''
  const runName = run.run_name || runLabel
  const neighbourName = run.neighbour_name || null
  const neighbourAddress = run.neighbour_address || ''
  const hasNeighbour = !!neighbourName
  const isAccepted = !!doc.accepted_at
  const isDeclined = !!doc.declined_at
  const quoteRef = `${jobNumber}-${runLabel}`

  const items = run.items || []
  const totals = run.totals || {}

  // Format currency
  const f = (n: number) => n != null ? n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'

  let statusHtml = ''
  if (isAccepted) {
    statusHtml = '<div style="background:#34C75920;color:#34C759;padding:16px;border-radius:8px;text-align:center;font-weight:600;margin-bottom:24px;">Quote Accepted &mdash; Thank you!</div>'
  } else if (isDeclined) {
    statusHtml = '<div style="background:#FF3B3020;color:#FF3B30;padding:16px;border-radius:8px;text-align:center;font-weight:600;margin-bottom:24px;">Quote Declined</div>'
  }

  // Build line items table
  let itemRows = ''
  items.forEach((item: any) => {
    const allocNote = item.allocation === 'client_only' ? `<br><span style="color:#4C6A7C;font-size:11px;font-style:italic;">Client's cost in full</span>`
      : item.allocation === 'neighbour_only' ? `<br><span style="color:#4C6A7C;font-size:11px;font-style:italic;">${neighbourName ? neighbourName + "'s" : "Neighbour's"} cost in full</span>`
      : ''
    const noteText = item.allocation_note ? `<br><span style="color:#4C6A7C;font-size:11px;font-style:italic;">${item.allocation_note}</span>` : ''

    itemRows += `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;">${item.description || ''}${allocNote}${noteText}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;font-size:13px;white-space:nowrap;">${item.quantity || ''} ${item.unit || ''}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;font-size:13px;">$${f(item.line_total_ex)}</td>
    </tr>`
  })

  // Parties section
  const partiesHtml = hasNeighbour ? `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
      <div style="background:#f8f9fa;padding:12px;border-radius:6px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#4C6A7C;margin-bottom:4px;">Client</div>
        <div style="font-weight:600;color:#293C46;">${clientName}</div>
        <div style="font-size:12px;color:#4C6A7C;">${clientAddress}</div>
      </div>
      <div style="background:#f8f9fa;padding:12px;border-radius:6px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#4C6A7C;margin-bottom:4px;">Adjoining Owner</div>
        <div style="font-weight:600;color:#293C46;">${neighbourName}</div>
        <div style="font-size:12px;color:#4C6A7C;">${neighbourAddress}</div>
      </div>
    </div>
  ` : `
    <div style="background:#f8f9fa;padding:12px;border-radius:6px;margin-bottom:20px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#4C6A7C;margin-bottom:4px;">Client</div>
      <div style="font-weight:600;color:#293C46;">${clientName}</div>
      <div style="font-size:12px;color:#4C6A7C;">${clientAddress}</div>
    </div>
  `

  // Cost summary
  const summaryHtml = hasNeighbour ? `
    <div style="margin-top:24px;padding:20px;background:#293C46;border-radius:8px;color:#fff;">
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
        <span>Run Total (ex GST)</span><span style="font-weight:600;">$${f(totals.run_total_ex)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;padding:8px 0;border-top:1px solid rgba(255,255,255,0.15);">
        <span>${clientName}'s Share (ex GST)</span><span style="font-weight:600;">$${f(totals.client_share_ex)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
        <span>${neighbourName}'s Share (ex GST)</span><span style="font-weight:600;">$${f(totals.neighbour_share_ex)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding-top:12px;border-top:1px solid rgba(255,255,255,0.3);font-size:18px;">
        <span style="font-weight:700;">Total inc GST</span><span style="font-weight:700;color:#F15A29;">$${f(totals.run_total_inc)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:13px;opacity:0.8;">
        <span>${clientName}: $${f(totals.client_share_inc)}</span>
        <span>${neighbourName}: $${f(totals.neighbour_share_inc)}</span>
      </div>
    </div>
  ` : `
    <div style="margin-top:24px;padding:20px;background:#293C46;border-radius:8px;color:#fff;">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span>Subtotal (ex GST)</span><span style="font-weight:600;">$${f(totals.run_total_ex)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span>GST (10%)</span><span>$${f((totals.run_total_inc || 0) - (totals.run_total_ex || 0))}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding-top:12px;border-top:1px solid rgba(255,255,255,0.3);font-size:18px;">
        <span style="font-weight:700;">Total inc GST</span><span style="font-weight:700;color:#F15A29;">$${f(totals.run_total_inc)}</span>
      </div>
    </div>
  `

  // Disclaimers
  const disclaimers = `
    <div style="margin-top:24px;font-size:11px;color:#4C6A7C;line-height:1.6;">
      <div style="font-weight:600;margin-bottom:8px;">Terms & Conditions</div>
      <ol style="padding-left:16px;">
        <li style="margin-bottom:4px;"><strong>Boundary verification</strong> — The client is responsible for confirming the boundary location. SecureWorks is not liable for fencing installed in the wrong position.</li>
        <li style="margin-bottom:4px;"><strong>Permits & approvals</strong> — Any required permits or council approvals are excluded unless specifically itemised above.</li>
        <li style="margin-bottom:4px;"><strong>Site conditions</strong> — Pricing assumes standard sand/loam conditions. Rock excavation, if encountered, will be charged at $45 per hole.</li>
        <li style="margin-bottom:4px;"><strong>Variations</strong> — Any changes to the scope of work will be quoted separately and require written approval before proceeding.</li>
        <li style="margin-bottom:4px;"><strong>Underground services</strong> — The client is responsible for obtaining a Dial Before You Dig report and marking all underground services on-site prior to works commencing.</li>
        <li style="margin-bottom:4px;"><strong>Payment</strong> — 50% deposit required on acceptance. Balance due on completion.</li>
      </ol>
      <div style="margin-top:8px;">This quote is valid for 30 days from the date of issue.</div>
    </div>
  `

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${quoteRef} — ${runName} — SecureWorks Group</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif; background: #f5f5f7; color: #333; }
    .header { background: #293C46; padding: 16px 24px; display:flex; justify-content:space-between; align-items:center; }
    .header-brand { color: #fff; font-size: 18px; font-weight: 700; }
    .header-brand span { color: rgba(255,255,255,0.6); font-weight: 400; }
    .header-ref { color: rgba(255,255,255,0.6); font-size: 13px; }
    .container { max-width: 720px; margin: 0 auto; padding: 24px 16px; }
    .card { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 16px; }
    h1 { color: #293C46; font-size: 22px; margin-bottom: 4px; }
    .run-badge { display: inline-block; background: #F15A29; color: #fff; padding: 3px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; margin-bottom: 12px; }
    .subtitle { color: #4C6A7C; font-size: 14px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 10px 12px; background: #f8f9fa; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #4C6A7C; border-bottom: 2px solid #293C46; }
    th:last-child { text-align: right; }
    .btn { display: inline-block; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: 600; text-decoration: none; cursor: pointer; border: none; text-align: center; width: 100%; margin-bottom: 8px; }
    .btn-accept { background: #34C759; color: #fff; }
    .btn-decline { background: #f5f5f7; color: #FF3B30; border: 1px solid #FF3B30; }
    .btn:hover { opacity: 0.9; }
    .footer { text-align: center; color: #999; font-size: 12px; padding: 24px; }
    @media print {
      body { background: #fff; }
      .no-print { display: none !important; }
      .card { box-shadow: none; border: 1px solid #eee; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-brand">SecureWorks <span>Group</span></div>
    <div class="header-ref">${quoteRef}</div>
  </div>
  <div class="container">
    <div class="card">
      <div class="run-badge">${runLabel}</div>
      <h1>${runName}</h1>
      <p class="subtitle">${quoteRef} &mdash; ${suburb}</p>

      ${statusHtml}
      ${partiesHtml}

      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th style="text-align:right;">Qty</th>
            <th style="text-align:right;">Amount (ex GST)</th>
          </tr>
        </thead>
        <tbody>
          ${itemRows}
        </tbody>
      </table>

      ${summaryHtml}
      ${disclaimers}

      ${!isAccepted && !isDeclined ? `
      <div class="no-print" style="margin-top:24px;padding-top:24px;border-top:1px solid #eee;">
        <p style="color:#4C6A7C;font-size:14px;margin-bottom:16px;">Happy with this quote? Accept below to confirm.</p>
        <button class="btn btn-accept" onclick="respondToQuote('accept')">Accept Quote</button>
        <button class="btn btn-decline" onclick="respondToQuote('decline')">Decline</button>
      </div>
      ` : ''}
    </div>

    <div class="card no-print" style="text-align:center;">
      <p style="color:#4C6A7C;font-size:14px;">Questions about your quote?</p>
      <p style="margin-top:8px;">
        <a href="tel:+61489267771" style="color:#F15A29;font-weight:600;text-decoration:none;">Call Us</a> &nbsp;|&nbsp;
        <a href="mailto:admin@secureworkswa.com.au" style="color:#F15A29;font-weight:600;text-decoration:none;">Email</a>
      </p>
    </div>

    <div class="footer">
      SecureWorks Group Pty Ltd | ABN 64 689 223 416<br>
      This quote is valid for 30 days from the date of issue.
    </div>
  </div>

  <script>
    async function respondToQuote(action) {
      if (action === 'accept' && !confirm('Accept this quote? This confirms your agreement to the terms and conditions.')) return;
      if (action === 'decline') {
        var reason = prompt('Could you tell us why? (optional)');
        try {
          var res = await fetch('https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/send-quote/' + action + '?token=${token}', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason || '' })
          });
          if (res.ok) window.location.reload();
          else alert('Something went wrong. Please try again.');
        } catch(e) { alert('Failed. Please try again.'); }
        return;
      }
      try {
        var res = await fetch('https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/send-quote/' + action + '?token=${token}', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        if (res.ok) {
          var ct = res.headers.get('content-type') || '';
          if (ct.includes('text/html')) {
            document.open(); document.write(await res.text()); document.close();
          } else {
            window.location.reload();
          }
        } else { alert('Something went wrong. Please try again.'); }
      } catch(e) { alert('Failed. Please try again.'); }
    }
  </script>
</body>
</html>`
}

// ════════════════════════════════════════════════════════════
// PER-RUN ACCEPTANCE CONFIRMATION PAGES
// ════════════════════════════════════════════════════════════

function buildRunAcceptedPage(job: any, run: any, acceptorName: string): string {
  const jobNumber = job?.job_number || ''
  const runName = run?.run_name || run?.run_label || 'Fence'
  const suburb = job?.site_suburb || ''

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Quote Accepted — SecureWorks Group</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif;background:#f5f5f7;color:#333}.header{background:#293C46;padding:16px 24px}.header-brand{color:#fff;font-size:18px;font-weight:700}.container{max-width:600px;margin:0 auto;padding:24px 16px}.card{background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.08);text-align:center;margin-bottom:16px}.footer{text-align:center;color:#999;font-size:12px;padding:24px}</style>
</head><body>
<div class="header"><div class="header-brand">SecureWorks <span style="color:rgba(255,255,255,0.6);font-weight:400">Group</span></div></div>
<div class="container">
  <div class="card">
    <div style="font-size:48px;margin-bottom:16px">✅</div>
    <h1 style="color:#293C46;font-size:22px;margin-bottom:8px">${runName} — Accepted</h1>
    <p style="color:#4C6A7C;font-size:15px;margin-bottom:24px">${jobNumber}${suburb ? ' — ' + suburb : ''}</p>
    <div style="background:#34C75915;border:1px solid #34C75930;border-radius:8px;padding:16px;margin-bottom:24px;">
      <p style="color:#34C759;font-weight:600;font-size:15px;">Both parties have confirmed this run.</p>
      <p style="color:#4C6A7C;font-size:13px;margin-top:8px;">Deposit invoices are being created now. You'll receive yours by email shortly with a payment link.</p>
    </div>
    <div style="text-align:left;background:#f8f9fa;padding:16px;border-radius:8px;">
      <p style="font-weight:600;color:#293C46;margin-bottom:8px;">What happens next?</p>
      <ol style="color:#4C6A7C;font-size:14px;line-height:2;padding-left:20px;">
        <li>Pay your deposit via the invoice link (check your email)</li>
        <li>We'll order materials once deposits are received</li>
        <li>Our team will be in touch to schedule the installation</li>
      </ol>
    </div>
  </div>
  <div class="card" style="text-align:center;">
    <p style="color:#4C6A7C;font-size:14px;">Questions?</p>
    <p style="margin-top:8px;"><a href="tel:+61489267771" style="color:#F15A29;font-weight:600;text-decoration:none;">Call Us</a> &nbsp;|&nbsp; <a href="mailto:admin@secureworkswa.com.au" style="color:#F15A29;font-weight:600;text-decoration:none;">Email</a></p>
  </div>
  <div class="footer">SecureWorks Group Pty Ltd | ABN 64 689 223 416</div>
</div></body></html>`
}

function buildWaitingPage(job: any, run: any, acceptorName: string, runLabel: string): string {
  const jobNumber = job?.job_number || ''
  const runName = run?.run_name || runLabel || 'Fence'
  const suburb = job?.site_suburb || ''
  const clientAddress = job?.site_address || ''
  const neighbourAddress = run?.neighbour_address || ''
  const boundaryDesc = [clientAddress, neighbourAddress].filter(Boolean).join(' & ')

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Quote Accepted — SecureWorks Group</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif;background:#f5f5f7;color:#333}.header{background:#293C46;padding:16px 24px}.header-brand{color:#fff;font-size:18px;font-weight:700}.container{max-width:600px;margin:0 auto;padding:24px 16px}.card{background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.08);margin-bottom:16px}.footer{text-align:center;color:#999;font-size:12px;padding:24px}</style>
</head><body>
<div class="header"><div class="header-brand">SecureWorks <span style="color:rgba(255,255,255,0.6);font-weight:400">Group</span></div></div>
<div class="container">
  <div class="card" style="text-align:center;">
    <div style="font-size:48px;margin-bottom:16px">👍</div>
    <h1 style="color:#293C46;font-size:22px;margin-bottom:8px">Thank You, ${acceptorName}</h1>
    <p style="color:#4C6A7C;font-size:15px;margin-bottom:20px;">You've accepted the quote for the <strong>${runName}</strong>.</p>

    ${boundaryDesc ? `<div style="background:#f8f9fa;padding:10px 14px;border-radius:6px;margin-bottom:20px;font-size:13px;color:#4C6A7C;">
      <strong>Boundary:</strong> ${boundaryDesc}
    </div>` : ''}

    <div style="background:#3498DB10;border:1px solid #3498DB25;border-radius:8px;padding:20px;margin-bottom:24px;text-align:left;">
      <p style="color:#293C46;font-weight:600;font-size:15px;margin-bottom:10px;">Waiting on the other property owner</p>
      <p style="color:#4C6A7C;font-size:14px;line-height:1.6;margin-bottom:12px;">
        Because this is a shared boundary fence, both property owners need to confirm the quote before work can begin.
        The other party has received the same quote with the agreed cost split.
      </p>
      <p style="color:#4C6A7C;font-size:14px;line-height:1.6;">
        We'll follow up with them if we haven't heard back within a few days. You don't need to do anything &mdash; we'll email you as soon as both parties are confirmed.
      </p>
    </div>

    <div style="text-align:left;background:#f8f9fa;padding:16px;border-radius:8px;margin-bottom:20px;">
      <p style="font-weight:600;color:#293C46;margin-bottom:8px;">What happens once both parties accept?</p>
      <ol style="color:#4C6A7C;font-size:14px;line-height:2;padding-left:20px;">
        <li>Both parties receive a deposit invoice with a secure payment link</li>
        <li>Once deposits are received, we order materials</li>
        <li>Our team gets in touch to schedule the installation</li>
        <li>Typical turnaround: 2&ndash;4 weeks from deposit to completion</li>
      </ol>
    </div>

    <div style="background:#F15A2908;border:1px solid #F15A2920;border-radius:8px;padding:14px;text-align:left;">
      <p style="color:#293C46;font-size:13px;line-height:1.5;">
        <strong>Already spoken to your neighbour?</strong> If they're happy to proceed, let them know to check their email for the quote link.
        If they have any questions, they're welcome to call us directly.
      </p>
    </div>
  </div>

  <div class="card" style="text-align:center;">
    <p style="color:#4C6A7C;font-size:14px;">Questions about your fencing project?</p>
    <p style="margin-top:8px;">
      <a href="tel:+61489267771" style="color:#F15A29;font-weight:600;text-decoration:none;">Call +61 489 267 771</a> &nbsp;|&nbsp;
      <a href="mailto:admin@secureworkswa.com.au" style="color:#F15A29;font-weight:600;text-decoration:none;">Email Us</a>
    </p>
  </div>

  <div class="footer">SecureWorks Group Pty Ltd | ABN 64 689 223 416<br>${jobNumber}${suburb ? ' &mdash; ' + suburb : ''}</div>
</div></body></html>`
}

// ════════════════════════════════════════════════════════════
// VARIATION CLIENT PAGE
// ════════════════════════════════════════════════════════════

function buildMultiOptionPage(docs: any[], job: any, activeToken: string): string {
  const clientName = job?.client_name || 'Customer'
  const suburb = job?.site_suburb || ''
  const projectType = job?.type || 'patio'

  const optionCards = docs.map((d: any) => {
    const qn = d.quote_number || ''
    const isAccepted = !!d.accepted_at
    const isDeclined = !!d.declined_at
    const isActive = d.share_token === activeToken
    const snapshot = d.data_snapshot_json || {}
    const price = snapshot.totalIncGST || snapshot.total || ''
    const priceStr = price ? '$' + Number(price).toLocaleString('en-AU', { minimumFractionDigits: 0 }) : ''

    let statusBadge = ''
    if (isAccepted) statusBadge = '<span style="color:#34C759;font-weight:600;">Accepted ✓</span>'
    else if (isDeclined) statusBadge = '<span style="color:#FF3B30;">Declined</span>'

    return `<div style="border:${isActive ? '2px solid #F15A29' : '1px solid #ddd'};border-radius:10px;padding:16px;margin-bottom:12px;background:#fff;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:700;font-size:16px;color:#293C46;">${qn || 'Quote'}</div>
          ${priceStr ? `<div style="font-size:22px;font-weight:800;color:#F15A29;margin-top:4px;">${priceStr} <span style="font-size:12px;color:#4C6A7C;font-weight:400;">inc GST</span></div>` : ''}
        </div>
        ${statusBadge}
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <a href="${d.pdf_url || '#'}" target="_blank" style="flex:1;padding:10px;text-align:center;background:#293C46;color:#fff;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">View PDF</a>
        ${!isAccepted && !isDeclined ? `<button onclick="respondToQuote('accept','${d.share_token}')" style="flex:1;padding:10px;background:#34C759;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">Accept This Option</button>` : ''}
      </div>
    </div>`
  }).join('')

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Your Quotes — SecureWorks Group</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif;background:#f5f5f7;color:#333}
  .header{background:#293C46;padding:16px 24px}
  .header-brand{color:#fff;font-size:18px;font-weight:700}
  .header-brand span{color:rgba(255,255,255,0.6);font-weight:400}
  .container{max-width:720px;margin:0 auto;padding:24px 16px}
  .card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,0.08);margin-bottom:16px}
  .footer{text-align:center;color:#999;font-size:12px;padding:24px}
</style></head><body>
<div class="header"><div class="header-brand">SecureWorks <span>Group</span></div></div>
<div class="container">
  <div class="card">
    <h1 style="color:#293C46;font-size:22px;margin-bottom:4px;">Your ${projectType} quotes</h1>
    <p style="color:#4C6A7C;font-size:14px;">For ${clientName}${suburb ? ' — ' + suburb : ''}</p>
    <p style="color:#4C6A7C;font-size:13px;margin-top:8px;">We've prepared ${docs.length} options for you. Review each quote PDF and accept the one you'd like to go with.</p>
  </div>
  ${optionCards}
  <div class="card" style="text-align:center;">
    <p style="color:#4C6A7C;font-size:14px;">Questions? We're here to help.</p>
    <p style="margin-top:8px;"><a href="tel:+61489267771" style="color:#F15A29;font-weight:600;text-decoration:none;">Call Us</a> &nbsp;|&nbsp; <a href="mailto:admin@secureworkswa.com.au" style="color:#F15A29;font-weight:600;text-decoration:none;">Email</a></p>
  </div>
  <div class="footer">SecureWorks Group Pty Ltd | ABN 64 689 223 416</div>
</div>
<script>
async function respondToQuote(action, token) {
  if (!confirm('Accept this quote option? The other options will be superseded.')) return;
  try {
    var res = await fetch('https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/send-quote/accept?token=' + token, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}'
    });
    if (res.ok) { location.reload(); } else { alert('Failed. Please try again.'); }
  } catch(e) { alert('Network error. Please try again.'); }
}
</script></body></html>`
}

function buildVariationPage(variation: any, token: string): string {
  const job = variation.jobs || {}
  const jobNum = job.job_number || ''
  const clientName = job.client_name || 'Client'
  const amount = variation.amount ? `$${Number(variation.amount).toFixed(2)}` : 'See details'
  const gstNote = variation.gst_included ? '(inc GST)' : '(ex GST)'
  const isAccepted = !!variation.accepted_at
  const isDeclined = !!variation.declined_at

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Variation — ${jobNum}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;background:#F8F6F3;color:#1A2332}
  .header{background:#293C46;padding:24px;text-align:center}
  .header h1{color:#fff;font-size:20px;margin:0}
  .header p{color:rgba(255,255,255,0.7);font-size:14px;margin:4px 0 0}
  .card{max-width:500px;margin:24px auto;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);padding:24px}
  .amount{font-size:28px;font-weight:800;color:#F15A29;margin:16px 0 4px}
  .gst{font-size:13px;color:#7C8898}
  .reason{display:inline-block;padding:4px 10px;background:#EDF1F4;border-radius:6px;font-size:12px;font-weight:600;color:#4C6A7C;margin:8px 0}
  .desc{font-size:15px;line-height:1.6;color:#4C6A7C;margin:16px 0}
  .btn{display:block;width:100%;padding:14px;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;margin-bottom:8px;font-family:inherit}
  .btn-accept{background:#27AE60;color:#fff}
  .btn-decline{background:#fff;color:#E74C3C;border:2px solid #E74C3C}
  .status{text-align:center;padding:16px;font-size:15px;font-weight:600}
  .status.accepted{color:#27AE60} .status.declined{color:#E74C3C}
</style></head><body>
<div class="header"><h1>Variation Request</h1><p>${jobNum} — ${clientName}</p></div>
<div class="card">
  <div style="font-size:13px;color:#7C8898;margin-bottom:4px">Variation #${variation.variation_number || 1}</div>
  <div style="font-size:12px;color:#7C8898">${variation.reason ? `Reason: ${variation.reason.replace(/_/g, ' ')}` : ''}</div>
  <div class="amount">${amount}</div>
  <div class="gst">${gstNote}</div>
  <div class="desc">${variation.description || 'No description provided'}</div>
  ${variation.photo_url ? `<img src="${variation.photo_url}" style="width:100%;border-radius:8px;margin:12px 0" alt="Variation photo">` : ''}
  ${isAccepted ? '<div class="status accepted">✓ Accepted</div>' :
    isDeclined ? '<div class="status declined">✗ Declined</div>' :
    `<button class="btn btn-accept" onclick="respondVariation('accept')">Accept Variation</button>
     <button class="btn btn-decline" onclick="respondVariation('decline')">Decline</button>`}
</div>
<script>
async function respondVariation(action) {
  if (action === 'accept' && !confirm('Accept this variation?')) return;
  try {
    const res = await fetch('/functions/v1/send-quote/' + action + '?token=${token}&type=variation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    if (res.ok) { location.reload(); } else { alert('Failed. Please try again.'); }
  } catch { alert('Network error.'); }
}
</script></body></html>`
}

// ════════════════════════════════════════════════════════════
// SUPPORTING DOCUMENTS
// ════════════════════════════════════════════════════════════

const SUPPORTING_DOC_META: Record<string, { title: string; description: string }> = {
  solarspan_brochure: { title: 'SolarSpan Product Brochure', description: 'Technical specifications and benefits of SolarSpan insulated panels' },
  warranty_guide: { title: 'Warranty Guide', description: 'Coverage details and warranty terms' },
  colour_chart: { title: 'Colorbond Colour Chart', description: 'Available roof, ceiling, and post colours' },
}

function buildSupportingDocsHtml(doc: any): string {
  const snapshot = doc.data_snapshot_json
  const docs = snapshot?.supporting_docs
  if (!docs || !Array.isArray(docs) || docs.length === 0) return ''

  const items = docs.map((key: string) => {
    const meta = SUPPORTING_DOC_META[key] || { title: key, description: '' }
    // Static URLs — these PDFs are uploaded once to Supabase Storage
    // For now, show info-only until the PDFs are actually uploaded
    return `<div style="padding:12px 0;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;gap:12px;">
      <div style="width:36px;height:36px;background:#EDF1F4;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <span style="font-size:18px;">📄</span>
      </div>
      <div>
        <div style="font-weight:600;color:#293C46;font-size:14px;">${meta.title}</div>
        <div style="color:#4C6A7C;font-size:12px;">${meta.description}</div>
      </div>
    </div>`
  }).join('')

  return `<div class="card">
    <h3 style="color:#293C46;font-size:16px;margin-bottom:12px;">Supporting Documents</h3>
    ${items}
  </div>`
}

// ════════════════════════════════════════════════════════════
// XERO QUOTE CREATION
// ════════════════════════════════════════════════════════════

async function getXeroToken(sb: any): Promise<{ accessToken: string; tenantId: string } | null> {
  const { data: token } = await sb
    .from('xero_tokens')
    .select('access_token, tenant_id, expires_at')
    .eq('org_id', DEFAULT_ORG_ID)
    .single()

  if (!token || !token.access_token) return null

  // Check if expired (token refresh is handled by pg_cron every 20 min)
  if (new Date(token.expires_at) < new Date()) {
    console.log('[send-quote] Xero token expired — quote will be skipped')
    return null
  }

  return { accessToken: token.access_token, tenantId: token.tenant_id }
}

async function createXeroQuote(sb: any, job: any, doc?: any): Promise<string | null> {
  const xeroAuth = await getXeroToken(sb)
  if (!xeroAuth) return null

  const pricing = job.pricing_json || {}
  const totalIncGST = pricing.totalIncGST || 0
  if (totalIncGST <= 0) return null

  // Build description with full job metadata baked in
  const typeName = job.type === 'fencing' ? 'Fencing' : job.type === 'patio' ? 'Patio' : job.type === 'decking' ? 'Decking' : 'Project'
  const scopeDesc = pricing.job_description || `${typeName} Installation`
  const location = [job.site_address, job.site_suburb].filter(Boolean).join(', ')

  // Rich line description: SWP-25042 | Patio | 8m × 4m Insulated Patio | 123 Main St | John Smith
  const metaParts = [job.job_number, typeName, scopeDesc, location, job.client_name].filter(Boolean)
  const richDesc = metaParts.join(' | ')

  // Tracking category for Xero reporting (Division: Patios/Fencing/Decking)
  const divisionOption = job.job_number
    ? (() => {
        const pfx = (job.job_number || '').slice(0, 3).toUpperCase()
        if (pfx === 'SWP') return 'Patios'
        if (pfx === 'SWF') return 'Fencing'
        if (pfx === 'SWD') return 'Decking'
        return 'General'
      })()
    : 'General'
  const tracking = [{ Name: 'Division', Option: divisionOption }]

  // Account code by job type (all 200 by default — update if bookkeeper wants separation)
  const accountCode = '200'

  // Build line items from pricing_json.items if available, otherwise single line
  const lineItems: any[] = []
  if (Array.isArray(pricing.items) && pricing.items.length > 0) {
    for (const item of pricing.items) {
      lineItems.push({
        Description: item.description || scopeDesc,
        Quantity: item.quantity || 1,
        UnitAmount: item.unit_price || item.unitPrice || 0,
        AccountCode: accountCode,
        TaxType: 'OUTPUT',
        Tracking: tracking,
      })
    }
  } else {
    // Single line item: use ex-GST amount
    const exGST = pricing.totalExGST || pricing.total || Math.round(totalIncGST / 1.1 * 100) / 100
    lineItems.push({
      Description: richDesc,
      Quantity: 1,
      UnitAmount: exGST,
      AccountCode: accountCode,
      TaxType: 'OUTPUT',
      Tracking: tracking,
    })
  }

  const expiryDate = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]

  const quotePayload = {
    Quotes: [{
      Contact: { ContactID: job.xero_contact_id },
      QuoteNumber: (doc?.quote_number) || job.job_number || undefined,
      Reference: job.job_number || undefined,
      Status: 'SENT',
      ExpiryDate: expiryDate,
      Title: `${typeName} — ${job.job_number || 'Quote'}`,
      Summary: richDesc,
      LineItems: lineItems,
    }],
  }

  const resp = await fetch(`${XERO_API_BASE}/Quotes`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${xeroAuth.accessToken}`,
      'Xero-tenant-id': xeroAuth.tenantId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Idempotency-Key': `${job.id}-xero-quote-${doc?.quote_number || 'v1'}`,
    },
    body: JSON.stringify(quotePayload),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    console.error(`[send-quote] Xero Quote API error (${resp.status}):`, errText)
    return null
  }

  const result = await resp.json()
  const quote = result?.Quotes?.[0]
  return quote?.QuoteID || null
}


// ════════════════════════════════════════════════════════════
// NEXT STEPS PAGE (shown after quote acceptance)
// ════════════════════════════════════════════════════════════

function buildNextStepsPage(opts: {
  clientName: string
  projectType: string
  address: string
  depositAmount: number
  depositDescription: string
  paymentUrl: string
  invoiceNumber: string
  shareToken?: string
  bankBsb?: string
  bankAccount?: string
  bankName?: string
  isPatio?: boolean
  jobId?: string
}): string {
  const firstName = opts.clientName?.split(' ')[0] || 'there'
  const typeName = opts.projectType === 'fencing' ? 'fencing' : opts.projectType === 'decking' ? 'decking' : 'patio'
  const depositFormatted = opts.depositAmount > 0
    ? '$' + opts.depositAmount.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : ''

  const payButton = opts.paymentUrl
    ? `<a href="${opts.paymentUrl}" class="btn btn-pay" target="_blank">Pay Now — Card or Bank Transfer</a>`
    : '<p style="color:#4C6A7C;font-size:14px;">Your deposit invoice has been emailed to you. You can pay by card or bank transfer.</p>'

  // "I've paid" secondary button — links to payment-confirmed handler
  const paidButton = opts.shareToken
    ? `<a href="${BASE_URL}/functions/v1/send-quote/payment-confirmed?token=${opts.shareToken}" class="btn btn-paid">I've made my payment &mdash; let SecureWorks know</a>`
    : ''

  // Bank details section — only shown if configured
  const bankSection = (opts.bankBsb && opts.bankAccount) ? `
    <div class="bank-details">
      <h3>Or pay by direct bank transfer:</h3>
      <div class="bank-row"><span class="bank-label">Bank</span><span>${opts.bankName || 'SecureWorks Group'}</span></div>
      <div class="bank-row"><span class="bank-label">BSB</span><span>${opts.bankBsb}</span></div>
      <div class="bank-row"><span class="bank-label">Account</span><span>${opts.bankAccount}</span></div>
      <div class="bank-row"><span class="bank-label">Reference</span><span>${opts.invoiceNumber}</span></div>
    </div>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Quote Accepted — SecureWorks Group</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif; background: #f5f5f7; color: #333; }
    .header { background: #293C46; padding: 16px 24px; }
    .header-brand { color: #fff; font-size: 18px; font-weight: 700; }
    .header-brand span { color: rgba(255,255,255,0.6); font-weight: 400; }
    .container { max-width: 720px; margin: 0 auto; padding: 24px 16px; }
    .hero { text-align: center; margin-bottom: 24px; }
    .hero-icon { width: 64px; height: 64px; background: #34C759; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px; }
    .hero-icon svg { width: 32px; height: 32px; fill: #fff; }
    h1 { color: #293C46; font-size: 24px; margin-bottom: 8px; }
    .hero p { color: #4C6A7C; font-size: 15px; }
    .card { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 16px; }
    .deposit-card { border-left: 4px solid #F15A29; }
    .deposit-amount { font-size: 36px; font-weight: 800; color: #293C46; margin: 12px 0; }
    .deposit-desc { color: #4C6A7C; font-size: 14px; margin-bottom: 20px; }
    .btn { display: inline-block; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: 600; text-decoration: none; text-align: center; width: 100%; }
    .btn-pay { background: #F15A29; color: #fff; }
    .btn-pay:hover { background: #d94e22; }
    .btn-paid { background: #f5f5f7; color: #4C6A7C; border: 1px solid #D4DEE4; font-size: 14px; margin-top: 12px; }
    .btn-paid:hover { background: #EDF1F4; }
    .bank-details { margin-top: 20px; padding-top: 20px; border-top: 1px solid #eee; }
    .bank-details h3 { color: #293C46; font-size: 15px; margin-bottom: 12px; }
    .bank-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; }
    .bank-label { color: #4C6A7C; font-weight: 600; min-width: 80px; }
    .timeline { counter-reset: step; }
    .timeline li { position: relative; padding: 0 0 20px 36px; list-style: none; font-size: 14px; color: #4C6A7C; line-height: 1.5; }
    .timeline li:last-child { padding-bottom: 0; }
    .timeline li::before { counter-increment: step; content: counter(step); position: absolute; left: 0; top: 0; width: 24px; height: 24px; background: #293C46; color: #fff; border-radius: 50%; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
    .timeline li:first-child::before { background: #F15A29; }
    .timeline li::after { content: ''; position: absolute; left: 11px; top: 24px; width: 2px; height: calc(100% - 24px); background: #eee; }
    .timeline li:last-child::after { display: none; }
    .footer { text-align: center; color: #999; font-size: 12px; padding: 24px; }
    .contact-card { text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-brand">SecureWorks <span>Group</span></div>
  </div>
  <div class="container">
    <div class="hero">
      <div class="hero-icon">
        <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
      </div>
      <h1>Quote Accepted!</h1>
      <p>Your ${typeName} project${opts.address ? ' at ' + opts.address : ''} is confirmed.</p>
    </div>

    ${depositFormatted ? `
    <div class="card deposit-card">
      <p style="color:#4C6A7C;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Deposit Required</p>
      <div class="deposit-amount">${depositFormatted}</div>
      <p class="deposit-desc">${opts.depositDescription || 'Deposit to confirm your booking and secure scheduling.'}</p>
      ${payButton}
      ${bankSection}
      ${paidButton}
    </div>
    ` : `
    <div class="card">
      <p style="color:#4C6A7C;font-size:14px;">Your deposit invoice will be sent to you shortly. You can pay by card or bank transfer.</p>
    </div>
    `}

    <div class="card">
      <h3 style="color:#293C46;font-size:16px;margin-bottom:16px;">What happens next?</h3>
      <ol class="timeline">
        <li><strong>Deposit received</strong> — we confirm your booking</li>
        ${opts.isPatio ? `
        <li><strong>Send us your house plans</strong> — so we can start engineering</li>
        <li><strong>Engineering drawings</strong> — our engineer prepares structural plans</li>
        <li><strong>Council approval</strong> — we handle the entire process (typically 6–8 weeks)</li>
        ` : ''}
        <li><strong>Materials ordered</strong> — lead time is around 2 weeks</li>
        <li><strong>Build day!</strong> — our crew arrives and gets to work</li>
      </ol>
    </div>

    ${opts.isPatio && opts.shareToken ? `
    <div class="card" style="border-left:4px solid #293C46;">
      <div style="text-align:center;margin-bottom:12px;">
        <span style="font-size:28px;">📋</span>
        <h3 style="color:#293C46;font-size:16px;margin-top:8px;">Speed things up — send us your house plans now</h3>
        <p style="color:#4C6A7C;font-size:13px;margin-top:4px;">We need your original house plans (showing the house footprint) to start the engineering and council process.</p>
      </div>
      <div id="planUploadArea" style="border:2px dashed #D4DEE4;border-radius:8px;padding:24px;text-align:center;cursor:pointer;transition:border-color 0.2s" onclick="document.getElementById('planFileInput').click()" ondragover="event.preventDefault();this.style.borderColor='#F15A29'" ondragleave="this.style.borderColor='#D4DEE4'" ondrop="event.preventDefault();this.style.borderColor='#D4DEE4';handlePlanDrop(event)">
        <div style="font-size:18px;margin-bottom:4px;">📎</div>
        <div style="font-size:14px;font-weight:600;color:#293C46;">Drag files here or tap to upload</div>
        <div style="font-size:12px;color:#999;margin-top:4px;">Accepted: PDF, JPG, PNG (max 20MB)</div>
        <input type="file" id="planFileInput" accept=".pdf,.jpg,.jpeg,.png" multiple style="display:none" onchange="handlePlanUpload(this.files)">
      </div>
      <div id="planUploadStatus" style="display:none;text-align:center;padding:16px;">
        <div style="font-size:24px;margin-bottom:8px;">✅</div>
        <div style="font-size:15px;font-weight:600;color:#34C759;">Plans received!</div>
        <div style="font-size:13px;color:#4C6A7C;">We'll start the engineering process and keep you updated.</div>
      </div>
      <div style="text-align:center;margin-top:12px;">
        <p style="font-size:12px;color:#999;">Or email them to: <a href="mailto:approvals@secureworksgroup.app" style="color:#F15A29;">approvals@secureworksgroup.app</a></p>
        <p style="font-size:11px;color:#999;margin-top:4px;">Not sure where to find them? Check your original build pack, or request a copy from your local council.</p>
      </div>
    </div>
    <script>
      async function handlePlanUpload(files) {
        if (!files || files.length === 0) return;
        var area = document.getElementById('planUploadArea');
        var status = document.getElementById('planUploadStatus');
        area.innerHTML = '<div style="color:#4C6A7C;font-size:13px;">Uploading...</div>';
        try {
          for (var i = 0; i < files.length; i++) {
            var file = files[i];
            var reader = new FileReader();
            await new Promise(function(resolve, reject) {
              reader.onload = function() {
                var base64 = reader.result.split(',')[1];
                fetch('https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/send-quote/upload-plans', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    token: '${opts.shareToken}',
                    job_id: '${opts.jobId || ''}',
                    filename: file.name,
                    content_base64: base64,
                    content_type: file.type || 'application/pdf'
                  })
                }).then(function(r) { return r.json(); }).then(function(data) {
                  if (data.error) reject(new Error(data.error));
                  else resolve(data);
                }).catch(reject);
              };
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
          }
          area.style.display = 'none';
          status.style.display = '';
        } catch (e) {
          area.innerHTML = '<div style="color:#E74C3C;">Upload failed: ' + e.message + '. Try emailing to approvals@secureworksgroup.app instead.</div>';
        }
      }
      function handlePlanDrop(e) {
        handlePlanUpload(e.dataTransfer.files);
      }
    </script>
    ` : ''}

    <div class="card contact-card">
      <p style="color:#4C6A7C;font-size:14px;">Questions? We're here to help.</p>
      <p style="margin-top:8px;">
        <a href="tel:+61489267778" style="color:#F15A29;font-weight:600;text-decoration:none;">Call Us</a> &nbsp;|&nbsp;
        <a href="mailto:admin@secureworkswa.com.au" style="color:#F15A29;font-weight:600;text-decoration:none;">Email</a>
      </p>
    </div>

    <div class="footer">
      SecureWorks Group Pty Ltd | ABN 64 689 223 416
    </div>
  </div>
</body>
</html>`
}

// ════════════════════════════════════════════════════════════
// BRANDED INVOICE EMAIL TEMPLATE (T3 + T8 referral footer)
// ════════════════════════════════════════════════════════════

function buildInvoiceEmail(opts: {
  firstName: string
  jobType: string
  address: string
  invoiceNumber: string
  depositAmount: string
  dueDate: string
  paymentUrl: string
  paymentConfirmedUrl: string
}): string {
  const payButton = opts.paymentUrl
    ? `<table cellpadding="0" cellspacing="0" width="100%"><tr><td style="background:#F15A29;border-radius:6px;text-align:center;">
        <a href="${opts.paymentUrl}" style="display:inline-block;padding:14px 32px;color:#fff;text-decoration:none;font-size:16px;font-weight:600;width:100%;box-sizing:border-box;">Pay Now</a>
      </td></tr></table>`
    : ''

  const paidButton = opts.paymentConfirmedUrl
    ? `<p style="text-align:center;margin-top:12px;">
        <a href="${opts.paymentConfirmedUrl}" style="color:#4C6A7C;font-size:13px;text-decoration:underline;">Already paid? Let us know &rarr;</a>
      </p>`
    : ''

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <style>
    :root { color-scheme: light; }
    @media (prefers-color-scheme: dark) {
      .email-body, .email-card, .email-invoice-card { background-color: #ffffff !important; color: #293C46 !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;" class="email-body">
    <!-- Orange accent bar -->
    <tr><td style="background:#F15A29;height:4px;"></td></tr>
    <!-- Dark header -->
    <tr><td style="background:#293C46;padding:20px 32px;">
      <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">SecureWorks</span>
      <span style="color:rgba(255,255,255,0.6);font-size:16px;font-weight:400;margin-left:4px;">Group</span>
      <br><span style="color:rgba(255,255,255,0.45);font-size:11px;">ABN 64 689 223 416</span>
    </td></tr>

    <!-- Body -->
    <tr><td style="padding:32px;background:#ffffff;" class="email-card">
      <p style="color:#4C6A7C;font-size:15px;line-height:1.6;margin:0 0 16px;">
        Hi ${opts.firstName},
      </p>
      <p style="color:#4C6A7C;font-size:15px;line-height:1.6;margin:0 0 24px;">
        Your deposit invoice for your ${opts.jobType} project${opts.address ? ' at ' + opts.address : ''} is ready.
      </p>

      <!-- Invoice card with orange left border -->
      <table cellpadding="0" cellspacing="0" width="100%" style="border-left:4px solid #F15A29;background:#FCFBFA;margin-bottom:24px;" class="email-invoice-card">
        <tr><td style="padding:20px 24px;">
          <p style="color:#4C6A7C;font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin:0 0 12px;">Deposit Invoice</p>
          <table cellpadding="0" cellspacing="0" width="100%">
            <tr><td style="color:#4C6A7C;font-size:14px;padding:4px 0;">Invoice:</td><td style="color:#293C46;font-size:14px;font-weight:600;text-align:right;">#${opts.invoiceNumber}</td></tr>
            <tr><td style="color:#4C6A7C;font-size:14px;padding:4px 0;">Amount:</td><td style="color:#293C46;font-size:20px;font-weight:700;text-align:right;">${opts.depositAmount}</td></tr>
            <tr><td style="color:#4C6A7C;font-size:14px;padding:4px 0;">Due:</td><td style="color:#293C46;font-size:14px;font-weight:600;text-align:right;">${opts.dueDate}</td></tr>
          </table>
          <div style="margin-top:20px;">
            ${payButton}
            ${paidButton}
          </div>
        </td></tr>
      </table>

      <p style="color:#4C6A7C;font-size:13px;line-height:1.6;margin:0 0 24px;">
        Credit card payments include a 1.75% processing fee. Bank transfers have no additional fee.
      </p>

      <!-- T8: Referral footer -->
      <div style="background:#FDF2EE;padding:16px;border-radius:8px;margin-bottom:24px;">
        <p style="color:#293C46;font-size:14px;font-weight:600;margin:0 0 4px;">Know someone who needs a patio, deck, or fence?</p>
        <p style="color:#4C6A7C;font-size:13px;margin:0;">
          Send them our way and tell them you referred them. If they book, you both get a $100 Bunnings voucher.
        </p>
      </div>

      <hr style="border:none;border-top:1px solid #eee;margin:0 0 24px;">

      <p style="color:#4C6A7C;font-size:14px;line-height:1.6;margin:0 0 8px;">
        Questions? Call <a href="tel:+61489267778" style="color:#F15A29;text-decoration:none;font-weight:600;">0489 267 778</a> or reply to this email.
      </p>
    </td></tr>

    <!-- Cross-sell footer -->
    <tr><td style="background:#293C46;padding:20px 32px;">
      <p style="color:#ffffff;font-size:13px;margin:0;text-align:center;line-height:1.6;">
        <strong>SecureWorks Group</strong> — Insulated Patios | Fencing &amp; Screening | Composite Decking<br>
        <span style="color:#F15A29;">Transform your entire outdoor space — ask us about a complete package</span>
      </p>
    </td></tr>

    <!-- Footer -->
    <tr><td style="background:#f5f5f7;padding:20px 32px;border-top:1px solid #eee;">
      <p style="color:#999;font-size:11px;margin:0;line-height:1.5;">
        SecureWorks Group Pty Ltd | ABN 64 689 223 416
      </p>
    </td></tr>
  </table>
</body>
</html>`
}

// ════════════════════════════════════════════════════════════
// PAYMENT CONFIRMED PAGES (T4)
// ════════════════════════════════════════════════════════════

function buildPaymentConfirmedPage(firstName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Noted — SecureWorks Group</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif; background: #f5f5f7; color: #333; }
    .header { background: #293C46; padding: 16px 24px; }
    .header-brand { color: #fff; font-size: 18px; font-weight: 700; }
    .header-brand span { color: rgba(255,255,255,0.6); font-weight: 400; }
    .container { max-width: 720px; margin: 0 auto; padding: 24px 16px; text-align: center; }
    .card { background: #fff; border-radius: 12px; padding: 32px 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .icon { width: 64px; height: 64px; background: #34C759; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px; }
    .icon svg { width: 32px; height: 32px; fill: #fff; }
    h1 { color: #293C46; font-size: 22px; margin-bottom: 12px; }
    p { color: #4C6A7C; font-size: 15px; line-height: 1.6; }
    .footer { color: #999; font-size: 12px; padding: 24px; }
  </style>
</head>
<body>
  <div class="header"><div class="header-brand">SecureWorks <span>Group</span></div></div>
  <div class="container">
    <div class="card">
      <div class="icon"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg></div>
      <h1>Thanks ${firstName}!</h1>
      <p>We've notified the team. We'll confirm receipt and be in touch to schedule your project.</p>
    </div>
    <div class="footer">SecureWorks Group Pty Ltd | ABN 64 689 223 416</div>
  </div>
</body>
</html>`
}

function buildUploadPlansPage(token: string, jobId: string, address: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Upload House Plans — SecureWorks Group</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0;background:#F8F6F3;color:#293C46}
  .header{background:#293C46;padding:16px 24px;color:#fff;font-size:18px;font-weight:700}
  .header span{color:rgba(255,255,255,0.6);font-weight:400}
  .container{max-width:500px;margin:24px auto;padding:0 16px}
  .card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,0.08);text-align:center}
  .dropzone{border:2px dashed #D4DEE4;border-radius:8px;padding:32px;cursor:pointer;transition:border-color 0.2s}
  .dropzone:hover{border-color:#F15A29}
  .btn{display:inline-block;padding:12px 24px;background:#F15A29;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
  .success{display:none;text-align:center;padding:24px}
  .footer{text-align:center;color:#999;font-size:11px;margin-top:24px}
</style></head><body>
<div class="header">SecureWorks <span>Group</span></div>
<div class="container">
  <div class="card">
    <h2 style="margin:0 0 8px">Upload Your House Plans</h2>
    <p style="color:#4C6A7C;font-size:14px;margin-bottom:20px">${address ? address + ' — ' : ''}We need your original house plans to start engineering.</p>
    <div class="dropzone" id="dropzone" onclick="document.getElementById('fileInput').click()" ondragover="event.preventDefault();this.style.borderColor='#F15A29'" ondragleave="this.style.borderColor='#D4DEE4'" ondrop="event.preventDefault();this.style.borderColor='#D4DEE4';doUpload(event.dataTransfer.files)">
      <div style="font-size:24px;margin-bottom:8px">📎</div>
      <div style="font-weight:600">Drag files here or tap to upload</div>
      <div style="font-size:12px;color:#999;margin-top:4px">PDF, JPG, PNG — max 20MB</div>
      <input type="file" id="fileInput" accept=".pdf,.jpg,.jpeg,.png" multiple style="display:none" onchange="doUpload(this.files)">
    </div>
    <div class="success" id="success">
      <div style="font-size:36px;margin-bottom:12px">✅</div>
      <div style="font-size:18px;font-weight:700;color:#34C759">Plans received!</div>
      <div style="font-size:14px;color:#4C6A7C;margin-top:4px">We'll start the engineering process and keep you updated.</div>
    </div>
    <p style="font-size:12px;color:#999;margin-top:16px">Or email to: <a href="mailto:approvals@secureworksgroup.app" style="color:#F15A29">approvals@secureworksgroup.app</a></p>
  </div>
  <div class="footer">SecureWorks Group Pty Ltd | ABN 64 689 223 416</div>
</div>
<script>
async function doUpload(files) {
  if (!files || !files.length) return;
  var dz = document.getElementById('dropzone');
  dz.innerHTML = '<div style="color:#4C6A7C">Uploading...</div>';
  try {
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var b64 = await new Promise(function(res, rej) {
        var r = new FileReader(); r.onload = function() { res(r.result.split(',')[1]); }; r.onerror = rej; r.readAsDataURL(f);
      });
      var resp = await fetch('https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/send-quote/upload-plans', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({token:'${token}',job_id:'${jobId}',filename:f.name,content_base64:b64,content_type:f.type})
      });
      var data = await resp.json();
      if (data.error) throw new Error(data.error);
    }
    dz.style.display = 'none';
    document.getElementById('success').style.display = '';
  } catch(e) { dz.innerHTML = '<div style="color:#E74C3C">Upload failed: '+e.message+'</div>'; }
}
</script></body></html>`
}

function buildCouncilKickoffEmail(clientFirst: string, address: string, suburb: string, uploadUrl: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;">
  <tr><td style="background:#F15A29;height:4px;"></td></tr>
  <tr><td style="background:#293C46;padding:20px 32px;">
    <span style="color:#fff;font-size:18px;font-weight:700;">SecureWorks</span>
    <span style="color:rgba(255,255,255,0.6);font-size:16px;font-weight:400;margin-left:4px;">Group</span>
  </td></tr>
  <tr><td style="padding:32px;background:#fff;">
    <p style="color:#4C6A7C;font-size:15px;line-height:1.6;margin:0 0 16px;">Hi ${clientFirst},</p>
    <p style="color:#4C6A7C;font-size:15px;line-height:1.6;margin:0 0 16px;">Thanks for choosing SecureWorks for your patio project${address ? ' at ' + address : ''}!</p>
    <p style="color:#4C6A7C;font-size:15px;line-height:1.6;margin:0 0 16px;">Your deposit invoice has been sent separately. While we wait for that to come through, there's one thing we need from you to get started:</p>

    <div style="background:#293C46;border-radius:8px;padding:20px;margin:20px 0;text-align:center;">
      <div style="color:#fff;font-size:18px;font-weight:700;margin-bottom:8px;">📋 We Need Your House Plans</div>
      <p style="color:rgba(255,255,255,0.8);font-size:14px;margin:0 0 16px;">To begin engineering and council approval, we need a copy of your original house plans showing the building footprint.</p>
      <a href="${uploadUrl}" style="display:inline-block;padding:12px 28px;background:#F15A29;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-size:15px;">Upload Your Plans Here</a>
    </div>

    <p style="color:#4C6A7C;font-size:14px;line-height:1.6;margin:0 0 8px;">Or simply <strong>reply to this email</strong> with your plans attached.</p>
    <p style="color:#999;font-size:13px;line-height:1.6;margin:0 0 20px;">Not sure where to find them? Check your original build pack, request a copy from your local council${suburb ? ' (' + suburb + ')' : ''}, or ask your builder.</p>

    <div style="border-top:1px solid #eee;padding-top:20px;margin-top:20px;">
      <p style="color:#293C46;font-size:14px;font-weight:700;margin:0 0 12px;">What happens from here:</p>
      <ol style="color:#4C6A7C;font-size:14px;line-height:1.8;padding-left:20px;margin:0;">
        <li>Our engineer prepares structural drawings (1–2 weeks)</li>
        <li>We submit your CDC application to council</li>
        <li>Council reviews and issues a building permit (typically 6–8 weeks)</li>
        <li>We order materials and schedule your build</li>
      </ol>
      <p style="color:#4C6A7C;font-size:13px;margin-top:12px;">We handle the entire council process for you — no need for you to contact council directly.</p>
    </div>

    <p style="color:#4C6A7C;font-size:14px;margin-top:20px;">Questions? Call <a href="tel:+61489267771" style="color:#F15A29;text-decoration:none;font-weight:600;">0489 267 771</a> or reply to this email.</p>
  </td></tr>
  <tr><td style="background:#293C46;padding:20px 32px;">
    <p style="color:#ffffff;font-size:13px;margin:0;text-align:center;line-height:1.6;">
      <strong>SecureWorks Group</strong> — Insulated Patios | Fencing &amp; Screening | Composite Decking<br>
      <span style="color:#F15A29;">Transform your entire outdoor space — ask us about a complete package</span>
    </p>
  </td></tr>
  <tr><td style="background:#f5f5f7;padding:16px 32px;">
    <p style="color:#999;font-size:11px;margin:0;text-align:center;">SecureWorks Group Pty Ltd | ABN 64 689 223 416</p>
  </td></tr>
</table></body></html>`
}

function buildPaymentConfirmPromptPage(token: string): string {
  const postUrl = `payment-confirmed?token=${encodeURIComponent(token)}`
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm Payment — SecureWorks Group</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif; background: #f5f5f7; color: #333; }
    .header { background: #293C46; padding: 16px 24px; }
    .header-brand { color: #fff; font-size: 18px; font-weight: 700; }
    .header-brand span { color: rgba(255,255,255,0.6); font-weight: 400; }
    .container { max-width: 720px; margin: 0 auto; padding: 24px 16px; text-align: center; }
    .card { background: #fff; border-radius: 12px; padding: 32px 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    h1 { color: #293C46; font-size: 22px; margin-bottom: 12px; }
    p { color: #4C6A7C; font-size: 15px; line-height: 1.6; margin-bottom: 20px; }
    .btn { display: inline-block; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: 600; text-decoration: none; cursor: pointer; border: none; background: #F15A29; color: #fff; width: 100%; }
    .btn:hover { background: #d94e22; }
    .note { color: #999; font-size: 13px; margin-top: 16px; }
    .footer { color: #999; font-size: 12px; padding: 24px; }
  </style>
</head>
<body>
  <div class="header"><div class="header-brand">SecureWorks <span>Group</span></div></div>
  <div class="container">
    <div class="card">
      <h1>Made your payment?</h1>
      <p>Tap the button below to let our team know. This helps us process your project faster.</p>
      <button class="btn" onclick="confirmPayment()" id="confirmBtn">Yes, I've Made My Payment</button>
      <p class="note">This does not process a payment — it simply notifies our team.</p>
    </div>
    <div class="footer">SecureWorks Group Pty Ltd | ABN 64 689 223 416</div>
  </div>
  <script>
    async function confirmPayment() {
      var btn = document.getElementById('confirmBtn');
      btn.disabled = true;
      btn.textContent = 'Sending...';
      try {
        var res = await fetch('${postUrl}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (res.ok) {
          var html = await res.text();
          document.open(); document.write(html); document.close();
        } else {
          alert('Something went wrong. Please try again.');
          btn.disabled = false; btn.textContent = "Yes, I\\'ve Made My Payment";
        }
      } catch(e) {
        alert('Failed to send. Please try again.');
        btn.disabled = false; btn.textContent = "Yes, I\\'ve Made My Payment";
      }
    }
  </script>
</body>
</html>`
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SecureWorks Group</title></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
  <div style="background:#fff;border-radius:12px;padding:40px;max-width:400px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <h1 style="color:#293C46;font-size:20px;margin-bottom:12px;">${message}</h1>
    <p style="color:#4C6A7C;font-size:14px;">Please contact SecureWorks Group if you need assistance.</p>
    <a href="mailto:admin@secureworkswa.com.au" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#F15A29;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Contact Us</a>
  </div>
</body></html>`
}
