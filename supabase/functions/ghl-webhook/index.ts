// ════════════════════════════════════════════════════════════
// SecureWorks — GHL Webhook Edge Function
//
// Handles two types of GHL events:
//   1. Form submissions → creates draft jobs
//   2. Pipeline stage changes → syncs job status to Supabase
//      - Includes Sales→Execution pipeline re-link logic
//      - Logs backward-move conflicts for attention panel
//
// Deploy: supabase functions deploy ghl-webhook --no-verify-jwt
// GHL Setup:
//   Form webhook: POST to https://<project>.supabase.co/functions/v1/ghl-webhook
//   Pipeline stage change workflow: POST to same URL
//
// See docs/project-knowledge/GHL_WORKFLOW_SETUP.md for GHL config steps.
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GHL_WEBHOOK_SECRET = Deno.env.get('GHL_WEBHOOK_SECRET') || ''
const GHL_API_TOKEN = Deno.env.get('GHL_API_TOKEN') || ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Secret',
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

// ── GHL stage ID → Supabase status (execution pipelines only) ──
// Discovered from GHL API 2026-03-04. Update if Shaun renames stages.
const GHL_STAGE_TO_STATUS: Record<string, string> = {
  // Fencing Execution pipeline (fgV2mkFh6BD4gOZZx94y)
  'c1615373-9140-4e49-92aa-aa0cfa8e9793': 'accepted',     // Job Accepted Ready for Execution
  '680eeee9-742d-4025-9be3-a9bc8427dd9b': 'accepted',     // 25% Deposits To Be Received
  '1b2b08f5-bc15-430d-8cfa-e3e19ed1cf44': 'accepted',     // 50% Deposit To Be Received
  'c0e34aa5-c113-4485-a962-33eadd7be4de': 'scheduled',    // Materials To Be Ordered / Job Scheduled
  '56a580ff-2687-4240-8051-6f64c445c6e7': 'scheduled',    // Pending WhatsApp Confirmation
  '3a35ac3f-d0fb-4145-8fc3-7f8f310367ec': 'scheduled',    // Pending Confirmation Email
  '2a6163d5-17b0-4df3-8ca2-9618837e7a7b': 'scheduled',    // Confirmed Material Order
  '110e77c9-fc0d-4448-99e7-ce26ab134d88': 'scheduled',    // Order to be Picked up
  '3ebc787e-ff0a-4ec4-9e41-1fcc75d54b22': 'scheduled',    // Order To be Delivered
  '6d57806c-314c-47e5-a681-d163c10ed27e': 'in_progress',  // Scheduled / In Progress
  'f622844c-2fac-4627-81d4-978a6a864c72': 'complete',     // Get Final Payment Both Clients
  'd5c198bd-7fc4-4289-bf6c-510e81e2c438': 'complete',     // Get Google Review
  '14fe43aa-b0d2-4d46-8652-240a0d3325e4': 'complete',     // Completed and Archived
  'c065222d-7364-412d-9a7b-42e699764d1f': 'invoiced',     // Outstanding Payments Backlog

  // Patio Execution pipeline (SxayUz0KRDlCUk58apCC)
  '66742bf8-4917-406c-a1c1-33ac271cfe09': 'accepted',     // Ready to Execute
  '6aa51f88-ba79-4bc8-85cd-447c33164831': 'accepted',     // Drafting in progress
  '3d82ed96-9bdc-48e3-b939-e472b114d63f': 'accepted',     // DA in Progress
  'ee4945bd-1511-4fb5-beae-0422b904c57a': 'accepted',     // Engineering in progress
  '4b8fcebe-3deb-432d-90c7-e02caf77edc7': 'accepted',     // CDC in Progress
  '064001f6-48e6-48da-95a2-95e6c2925c0c': 'accepted',     // Council Approval in progress
  '872ff085-22f8-495f-90bc-4e9f09975893': 'accepted',     // Finalised Plans and Invoice
  '64bc0dde-1871-4078-a593-9a6d57182a98': 'scheduled',    // Deposit Received Materials to be ordered
  'a8497265-7a90-45dc-9fee-8decef18bc50': 'scheduled',    // Materials Ordered Job to be Scheduled
  '48f6871b-2d6c-4679-86a6-5b7bd602a6a8': 'scheduled',    // Scheduled Awaiting Start Date
  '4dfa654d-4d7c-491b-89dc-39717fc8e911': 'in_progress',  // In Progress
  'b91c3e8a-3747-49f2-8e4d-32265174d097': 'in_progress',  // Rectification / To be Finished off
  '54d52061-6fca-4dfe-a421-f35a3b88d434': 'complete',     // Job complete Needs to be invoiced
  '0276706b-faeb-44ff-b049-efce11a96a7f': 'invoiced',     // Invoice Sent waiting on Final Payment
  '9ea58244-5fb3-4242-8a8c-27e1f323b5ca': 'complete',     // Get Google Review
  'aee34104-e813-4df7-b198-b269b00f3999': 'complete',     // Job sign off with all documentation
}

// Execution pipeline IDs — only sync stages from these pipelines
const EXECUTION_PIPELINE_IDS = new Set([
  'fgV2mkFh6BD4gOZZx94y', // Fencing Execution
  'SxayUz0KRDlCUk58apCC', // Patio Execution
])

// Status rank for forward-only progression
const STATUS_RANK: Record<string, number> = {
  draft: 0, quoted: 1, accepted: 2, scheduled: 3,
  in_progress: 4, complete: 5, invoiced: 6, cancelled: -1,
}

// Pipeline ID → job type for fallback contact matching
const PIPELINE_TO_TYPE: Record<string, string> = {
  'fgV2mkFh6BD4gOZZx94y': 'fencing',
  'SxayUz0KRDlCUk58apCC': 'patio',
}


serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  // Verify webhook secret — fail-close if not configured
  if (!GHL_WEBHOOK_SECRET) {
    console.error('[ghl-webhook] GHL_WEBHOOK_SECRET not configured — rejecting request')
    return jsonResponse({ error: 'Webhook secret not configured' }, 500)
  }
  const secret = req.headers.get('X-Webhook-Secret') || req.headers.get('authorization')
  if (secret !== GHL_WEBHOOK_SECRET && secret !== `Bearer ${GHL_WEBHOOK_SECRET}`) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  try {
    const body = await req.json()
    console.log('[ghl-webhook] Received payload type:', body.type || 'unknown', 'keys:', Object.keys(body).join(','))

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Log raw webhook for debugging
    await sb.from('webhook_log').insert({
      org_id: DEFAULT_ORG_ID,
      source: 'ghl',
      event_type: body.type || 'unknown',
      payload: body,
      status: 'received',
    }).catch(() => {}) // Non-blocking

    // ── Route by event type ──
    if (isStageChangeEvent(body)) {
      return await handleStageChange(sb, body)
    }

    // Default: treat as form submission
    return await handleFormSubmission(sb, body)

  } catch (err) {
    console.error('[ghl-webhook] ERROR:', err)
    return jsonResponse({ error: (err as Error).message || 'Internal error' }, 500)
  }
})


// ════════════════════════════════════════════════════════════
// EVENT TYPE DETECTION
// ════════════════════════════════════════════════════════════

function isStageChangeEvent(body: any): boolean {
  if (body.type === 'OpportunityStageUpdate') return true
  if (body.type === 'opportunity.stage.changed') return true
  if (body.type === 'PipelineStageChanged') return true
  if (body.opportunityId && body.pipelineStageId) return true
  if (body.opportunity?.id && body.opportunity?.pipeline_stage_id) return true
  if (body.pipeline_stage_id && (body.opportunity_id || body.opportunityId)) return true
  return false
}


// ════════════════════════════════════════════════════════════
// STAGE CHANGE HANDLER (GHL → Supabase sync)
// Includes Sales→Execution re-link + backward-move conflict logging
// ════════════════════════════════════════════════════════════

async function handleStageChange(sb: any, body: any) {
  const opportunityId = body.opportunityId || body.opportunity_id || body.opportunity?.id || ''
  const pipelineId = body.pipelineId || body.pipeline_id || body.opportunity?.pipeline_id || ''
  const stageId = body.pipelineStageId || body.pipeline_stage_id || body.opportunity?.pipeline_stage_id || ''
  const contactId = body.contactId || body.contact_id || body.contact?.id || ''

  console.log(`[ghl-webhook] Stage change: opp=${opportunityId} pipeline=${pipelineId} stage=${stageId} contact=${contactId}`)

  if (!opportunityId || !stageId) {
    console.log('[ghl-webhook] Missing opportunityId or stageId — skipping')
    return jsonResponse({ success: false, reason: 'missing_fields' })
  }

  // Only process execution pipeline stage changes
  if (pipelineId && !EXECUTION_PIPELINE_IDS.has(pipelineId)) {
    console.log(`[ghl-webhook] Pipeline ${pipelineId} is not an execution pipeline — skipping`)
    return jsonResponse({ success: true, action: 'skipped', reason: 'not_execution_pipeline' })
  }

  // Look up the Supabase status for this GHL stage
  const newStatus = GHL_STAGE_TO_STATUS[stageId]
  if (!newStatus) {
    console.log(`[ghl-webhook] No status mapping for stage ${stageId} — skipping`)
    return jsonResponse({ success: true, action: 'skipped', reason: 'unmapped_stage' })
  }

  // ── Step 1: Try direct match by ghl_opportunity_id ──
  let job = await findJobByOpportunityId(sb, opportunityId)

  // ── Step 2: If no match, try re-linking (Sales→Execution transition) ──
  if (!job) {
    console.log(`[ghl-webhook] No direct match for opp ${opportunityId} — attempting re-link`)
    job = await attemptRelink(sb, opportunityId, pipelineId, contactId)
  }

  if (!job) {
    console.log(`[ghl-webhook] No job found for opportunity ${opportunityId} — skipping`)
    return jsonResponse({ success: true, action: 'skipped', reason: 'job_not_found' })
  }

  // ── Anti-loop: skip if status already matches ──
  if (job.status === newStatus) {
    console.log(`[ghl-webhook] Job ${job.id} already ${newStatus} — skipping (anti-loop)`)
    return jsonResponse({ success: true, action: 'skipped', reason: 'already_matches' })
  }

  // ── Backward-move: log conflict instead of silent discard ──
  const currentRank = STATUS_RANK[job.status] ?? 0
  const newRank = STATUS_RANK[newStatus] ?? 0

  if (newRank <= currentRank) {
    console.log(`[ghl-webhook] Conflict: ${job.status} (${currentRank}) → ${newStatus} (${newRank}) — backward move rejected`)

    // Log conflict event for Ops Dashboard attention panel
    await sb.from('job_events').insert({
      job_id: job.id,
      event_type: 'ghl_conflict',
      detail_json: {
        current_status: job.status,
        attempted_status: newStatus,
        ghl_opportunity_id: opportunityId,
        ghl_stage_id: stageId,
        pipeline_id: pipelineId,
        message: `GHL backward move rejected: tried ${newStatus} but job is ${job.status}. Check GHL pipeline matches Ops Dashboard.`,
      },
    }).catch((e: any) => console.error('[ghl-webhook] Failed to log conflict:', e))

    return jsonResponse({ success: true, action: 'conflict_logged', reason: 'backward_move', current: job.status, attempted: newStatus })
  }

  // ── Forward move: update job status via ops-api ──
  try {
    const updateUrl = `${SUPABASE_URL}/functions/v1/ops-api?action=update_job_status`
    const resp = await fetch(updateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
      body: JSON.stringify({
        jobId: job.id,
        status: newStatus,
        source: 'ghl_webhook', // Prevents ops-api from pushing back to GHL (anti-loop)
      }),
    })
    const result = await resp.json()
    console.log(`[ghl-webhook] Status updated: ${job.id} ${job.status} → ${newStatus}`, result)

    return jsonResponse({
      success: true,
      action: 'status_updated',
      job_id: job.id,
      old_status: job.status,
      new_status: newStatus,
      relinked: job._relinked || false,
    })
  } catch (e) {
    console.error('[ghl-webhook] Status update failed:', e)
    return jsonResponse({ success: false, error: (e as Error).message }, 500)
  }
}


// ════════════════════════════════════════════════════════════
// JOB LOOKUP HELPERS
// ════════════════════════════════════════════════════════════

async function findJobByOpportunityId(sb: any, opportunityId: string) {
  const { data } = await sb
    .from('jobs')
    .select('id, status, type, job_number, ghl_opportunity_id, ghl_contact_id, client_name')
    .eq('ghl_opportunity_id', opportunityId)
    .limit(1)

  return data && data.length > 0 ? data[0] : null
}

/**
 * Attempt to re-link a job when the opportunity ID doesn't match.
 * This handles the Sales→Execution pipeline transition where GHL creates
 * a new opportunity with a new ID but carries over custom fields.
 *
 * Matching priority:
 *   1. supabase_job_id custom field (exact UUID match — best)
 *   2. job_number custom field (exact match — reliable)
 *   3. ghl_contact_id + job type (fallback — may be ambiguous)
 */
async function attemptRelink(sb: any, newOpportunityId: string, pipelineId: string, contactId: string) {
  let job: any = null

  // Try fetching custom fields from the GHL opportunity
  const customFields = await fetchOpportunityCustomFields(newOpportunityId)

  if (customFields) {
    const supabaseJobId = customFields.supabase_job_id
    const jobNumber = customFields.job_number

    // Match 1: by Supabase UUID (most reliable)
    if (supabaseJobId) {
      const { data } = await sb
        .from('jobs')
        .select('id, status, type, job_number, ghl_opportunity_id, ghl_contact_id, client_name')
        .eq('id', supabaseJobId)
        .limit(1)
      if (data && data.length > 0) {
        job = data[0]
        console.log(`[ghl-webhook] Re-link matched by supabase_job_id: ${supabaseJobId}`)
      }
    }

    // Match 2: by job number
    if (!job && jobNumber) {
      const { data } = await sb
        .from('jobs')
        .select('id, status, type, job_number, ghl_opportunity_id, ghl_contact_id, client_name')
        .eq('job_number', jobNumber)
        .limit(1)
      if (data && data.length > 0) {
        job = data[0]
        console.log(`[ghl-webhook] Re-link matched by job_number: ${jobNumber}`)
      }
    }
  }

  // Match 3: fallback by contact + type (unreliable for repeat customers)
  if (!job && contactId) {
    const jobType = PIPELINE_TO_TYPE[pipelineId]
    if (jobType) {
      const { data } = await sb
        .from('jobs')
        .select('id, status, type, job_number, ghl_opportunity_id, ghl_contact_id, client_name')
        .eq('ghl_contact_id', contactId)
        .eq('type', jobType)
        .order('created_at', { ascending: false })
        .limit(1)
      if (data && data.length > 0) {
        job = data[0]
        console.log(`[ghl-webhook] Re-link matched by contact+type fallback: contact=${contactId} type=${jobType}`)
      }
    }
  }

  // If we found a match, update ghl_opportunity_id to the new one
  if (job) {
    const oldOppId = job.ghl_opportunity_id
    await sb
      .from('jobs')
      .update({ ghl_opportunity_id: newOpportunityId })
      .eq('id', job.id)

    await sb.from('job_events').insert({
      job_id: job.id,
      event_type: 'ghl_opportunity_relinked',
      detail_json: {
        old_opportunity_id: oldOppId,
        new_opportunity_id: newOpportunityId,
        pipeline_id: pipelineId,
        match_method: job._matchMethod || 'unknown',
        message: `Re-linked from Sales to Execution pipeline (old: ${oldOppId || 'none'})`,
      },
    }).catch((e: any) => console.error('[ghl-webhook] Failed to log re-link:', e))

    console.log(`[ghl-webhook] Re-linked job ${job.job_number || job.id}: ${oldOppId} → ${newOpportunityId}`)

    // Mark as relinked for the response
    job._relinked = true
    job.ghl_opportunity_id = newOpportunityId
  }

  return job
}

/**
 * Fetch custom fields from a GHL opportunity via the GHL API.
 * Returns { supabase_job_id, job_number, job_type, ... } or null if unavailable.
 */
async function fetchOpportunityCustomFields(opportunityId: string): Promise<Record<string, string> | null> {
  if (!GHL_API_TOKEN) {
    console.log('[ghl-webhook] No GHL_API_TOKEN — cannot fetch opportunity custom fields for re-link')
    return null
  }

  try {
    const resp = await fetch(`https://services.leadconnectorhq.com/opportunities/${opportunityId}`, {
      headers: {
        'Authorization': `Bearer ${GHL_API_TOKEN}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
      },
    })

    if (!resp.ok) {
      console.log(`[ghl-webhook] GHL API returned ${resp.status} for opportunity ${opportunityId}`)
      return null
    }

    const data = await resp.json()
    const opp = data.opportunity || data

    // GHL custom fields come as an array of { id, key, field_value } or as a flat object
    const result: Record<string, string> = {}

    if (Array.isArray(opp.customFields)) {
      for (const cf of opp.customFields) {
        const key = cf.key || cf.id || ''
        const val = cf.field_value || cf.value || ''
        if (key && val) result[key] = String(val)
      }
    } else if (opp.customFields && typeof opp.customFields === 'object') {
      for (const [key, val] of Object.entries(opp.customFields)) {
        if (val) result[key] = String(val)
      }
    }

    // Also check top-level customData (some GHL API versions)
    if (opp.customData && typeof opp.customData === 'object') {
      for (const [key, val] of Object.entries(opp.customData)) {
        if (val && !result[key]) result[key] = String(val)
      }
    }

    console.log(`[ghl-webhook] Opportunity ${opportunityId} custom fields:`, Object.keys(result).join(','))
    return Object.keys(result).length > 0 ? result : null

  } catch (e) {
    console.error('[ghl-webhook] Failed to fetch opportunity custom fields:', (e as Error).message)
    return null
  }
}


// ════════════════════════════════════════════════════════════
// FORM SUBMISSION HANDLER (original behaviour)
// ════════════════════════════════════════════════════════════

async function handleFormSubmission(sb: any, body: any) {
  const mapped = mapGHLPayload(body)

  // Check if job already exists for this GHL contact
  if (mapped.ghl_contact_id) {
    const { data: existing } = await sb
      .from('jobs')
      .select('id')
      .eq('org_id', DEFAULT_ORG_ID)
      .eq('ghl_contact_id', mapped.ghl_contact_id)
      .limit(1)

    if (existing && existing.length > 0) {
      const { data, error } = await sb
        .from('jobs')
        .update({
          client_name: mapped.client_name,
          client_phone: mapped.client_phone,
          client_email: mapped.client_email,
          site_address: mapped.site_address,
          site_suburb: mapped.site_suburb,
          notes: mapped.notes,
        })
        .eq('id', existing[0].id)
        .eq('org_id', DEFAULT_ORG_ID)
        .select()
        .single()

      if (error) throw error

      await sb.from('job_events').insert({
        job_id: data.id,
        event_type: 'ghl_updated',
        detail_json: { source: 'ghl_webhook', raw: body },
      })

      return jsonResponse({ success: true, action: 'updated', job_id: data.id })
    }
  }

  // Auto-assign salesperson by job type
  const SALESPERSON_BY_TYPE: Record<string, string> = {
    patio: '5862cf1d-0a3b-4836-8fd1-d69f95aa2f73',   // Nithin
    combo: '5862cf1d-0a3b-4836-8fd1-d69f95aa2f73',   // Nithin
    fencing: 'be6c2188-2b7b-49c7-b6e4-5b0d0deb6415', // Khairo
  }

  // Create new draft job
  const { data: job, error: jobError } = await sb
    .from('jobs')
    .insert({
      org_id: DEFAULT_ORG_ID,
      status: 'draft',
      type: mapped.type,
      client_name: mapped.client_name,
      client_phone: mapped.client_phone,
      client_email: mapped.client_email,
      site_address: mapped.site_address,
      site_suburb: mapped.site_suburb,
      notes: mapped.notes,
      ghl_contact_id: mapped.ghl_contact_id,
      created_by: SALESPERSON_BY_TYPE[mapped.type] || null,
    })
    .select()
    .single()

  if (jobError) throw jobError

  await sb.from('job_events').insert({
    job_id: job.id,
    event_type: 'job_created',
    detail_json: {
      source: 'ghl_webhook',
      raw: body,
      timeframe: mapped.timeframe,
    },
  })

  // ── Create contact_matches row for attribution tracking ──
  let leadSource = 'direct'
  if (mapped.gclid) leadSource = 'google_ads'
  else if (mapped.utm_source === 'google' && mapped.utm_medium === 'cpc') leadSource = 'google_ads'
  else if (mapped.utm_source) leadSource = mapped.utm_source
  else if (body.source || body.lead_source) leadSource = String(body.source || body.lead_source).toLowerCase()

  const { error: matchErr } = await sb.from('contact_matches').insert({
    org_id: DEFAULT_ORG_ID,
    ghl_contact_id: mapped.ghl_contact_id || null,
    job_id: job.id,
    email: mapped.client_email || null,
    phone: mapped.client_phone || null,
    client_name: mapped.client_name || null,
    gclid: mapped.gclid || null,
    utm_source: mapped.utm_source || null,
    utm_medium: mapped.utm_medium || null,
    utm_campaign: mapped.utm_campaign || null,
    utm_term: mapped.utm_term || null,
    utm_content: mapped.utm_content || null,
    lead_source: leadSource,
  })
  if (matchErr) console.error('contact_matches insert error:', matchErr.message)

  return jsonResponse({ success: true, action: 'created', job_id: job.id })
}


// ════════════════════════════════════════════════════════════
// GHL PAYLOAD MAPPING
// ════════════════════════════════════════════════════════════

interface MappedData {
  ghl_contact_id: string
  client_name: string
  client_phone: string
  client_email: string
  site_address: string
  site_suburb: string
  type: string
  timeframe: string
  notes: string
  gclid: string
  utm_source: string
  utm_medium: string
  utm_campaign: string
  utm_term: string
  utm_content: string
}

function mapGHLPayload(body: any): MappedData {
  const find = (...keys: string[]): string => {
    for (const key of keys) {
      if (body[key]) return String(body[key])
      if (body[`customField.${key}`]) return String(body[`customField.${key}`])
      if (body.customFields?.[key]) return String(body.customFields[key])
      if (body.contact?.[key]) return String(body.contact[key])
    }
    return ''
  }

  const projectTypeRaw = find('project_type', 'projectType', 'service', 'type').toLowerCase()
  let type = 'patio'
  if (projectTypeRaw.includes('fenc')) type = 'fencing'
  else if (projectTypeRaw.includes('combo') || projectTypeRaw.includes('both')) type = 'combo'
  else if (projectTypeRaw.includes('patio') || projectTypeRaw.includes('pergola') || projectTypeRaw.includes('carport')) type = 'patio'

  const timeframe = find('timeframe', 'timeline', 'when')
  const extraNotes = find('notes', 'message', 'description', 'additional_info')
  const notesParts: string[] = []
  if (timeframe) notesParts.push(`Timeframe: ${timeframe}`)
  if (projectTypeRaw && projectTypeRaw !== type) notesParts.push(`Project type: ${projectTypeRaw}`)
  if (extraNotes) notesParts.push(extraNotes)

  return {
    ghl_contact_id: find('contact_id', 'contactId', 'id'),
    client_name: find('full_name', 'fullName', 'name', 'firstName', 'first_name')
      + (find('lastName', 'last_name') ? ' ' + find('lastName', 'last_name') : ''),
    client_phone: find('phone', 'phoneNumber', 'mobile'),
    client_email: find('email', 'emailAddress'),
    site_address: find('address', 'address1', 'street', 'site_address', 'streetAddress'),
    site_suburb: find('suburb', 'city', 'location', 'area', 'site_suburb'),
    type,
    timeframe,
    notes: notesParts.join('\n'),
    gclid: find('gclid', 'GCLID', 'gc_id'),
    utm_source: find('utm_source', 'utmSource'),
    utm_medium: find('utm_medium', 'utmMedium'),
    utm_campaign: find('utm_campaign', 'utmCampaign'),
    utm_term: find('utm_term', 'utmTerm'),
    utm_content: find('utm_content', 'utmContent'),
  }
}
