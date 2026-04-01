// ════════════════════════════════════════════════════════════
// SecureWorks — GHL Proxy Edge Function
//
// Secure proxy between the scoping tools and GoHighLevel API.
// The GHL API token stays server-side — never in client code.
//
// Endpoints (via query param ?action=):
//   GET  ?action=opportunities&pipeline=fencing|patio
//   GET  ?action=search&q=smith&pipeline=patio  — search GHL leads (pipeline+Supabase cross-ref)
//   GET  ?action=contact&contactId=xxx  — full contact details
//   POST ?action=link  { opportunityId, jobId, toolType, contact }
//   GET  ?action=find_job&opportunityId=xxx  — find Supabase job by GHL opp ID
//   POST ?action=create_job  { opportunityId, toolType, clientName, ... }
//   POST ?action=create_contact_and_opportunity  { firstName, lastName, email, phone, address, suburb, toolType }
//   POST ?action=save_scope  { jobId, scopeJson, meta }
//   POST ?action=update_contact  { contactId, name, email, phone, address, suburb }
//   GET  ?action=get_conversation&contactId=xxx  — GHL conversation thread (last 30 msgs)
//   GET  ?action=get_my_messages&contactId=xxx    — outbound-only messages (for Trade app)
//   POST ?action=send_sms   { contactId, message, jobId?, userId? } — also logs to job_events
//   POST ?action=send_email { contactId, subject, htmlBody }
//   POST ?action=add_note  { contactId, body, jobId? } — add note to GHL contact
//   GET  ?action=search_jobs&q=smith&type=patio&limit=30  — search Supabase jobs
//
// Deploy:
//   supabase functions deploy ghl-proxy --no-verify-jwt
//   supabase secrets set GHL_API_TOKEN="pit-..." GHL_LOCATION_ID="..."
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GHL_API_TOKEN = Deno.env.get('GHL_API_TOKEN') || ''
const GHL_LOCATION_ID = Deno.env.get('GHL_LOCATION_ID') || ''
const GHL_BASE = 'https://services.leadconnectorhq.com'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

// Sales pipelines (leads → quotes)
const PIPELINES: Record<string, string> = {
  fencing: 'I9t8njpuR0Dm7B2NDcvI',
  patio: 'OGZLpPPVWVarN94HL6af',
}

// Execution pipelines (accepted jobs)
const EXECUTION_PIPELINES: Record<string, string> = {
  fencing_exec: 'fgV2mkFh6BD4gOZZx94y',
  patio_exec: 'SxayUz0KRDlCUk58apCC',
}

// Materials pipeline (tracked but not primary)
const MATERIALS_PIPELINE = 'SkgfC3nzTsOHqTSv9LNl'

// "Scope Complete" stage IDs per pipeline
const SCOPE_COMPLETE_STAGES: Record<string, string> = {
  fencing: '418534d4-6356-4c20-a274-51fbb892c2fa',  // Scope Complete
  patio: '9b9e5313-8e0e-4ed6-8654-d50413b99885',    // Scope Complete / Quote to be Sent
}

// "Job Complete" stage IDs per execution pipeline (discovered from GHL API 2026-03-04)
const JOB_COMPLETE_STAGES: Record<string, string> = {
  fencing: 'f622844c-2fac-4627-81d4-978a6a864c72',  // "Get Final Payment Both Clients"
  patio: '54d52061-6fca-4dfe-a421-f35a3b88d434',    // "Job complete Needs to be invoiced"
}

// Reverse lookup: Supabase status → GHL execution pipeline stage UUID
// Used by ops-api to push status changes to GHL
const OPS_TO_GHL_STAGES: Record<string, Record<string, string>> = {
  fencing: {
    accepted:    'c1615373-9140-4e49-92aa-aa0cfa8e9793', // Job Accepted Ready for Execution
    // approvals: fencing skips approvals — stays at accepted stage in GHL
    deposit:     'c1615373-9140-4e49-92aa-aa0cfa8e9793', // 50% Deposit To Be Received (use accepted stage — GHL deposit stages are manual)
    processing:   'c0e34aa5-c113-4485-a962-33eadd7be4de', // Materials To Be Ordered / Job Scheduled
    scheduled:   'c0e34aa5-c113-4485-a962-33eadd7be4de', // Materials To Be Ordered / Job Scheduled (legacy)
    in_progress: '6d57806c-314c-47e5-a681-d163c10ed27e', // Scheduled / In Progress
    complete:    'f622844c-2fac-4627-81d4-978a6a864c72', // Get Final Payment Both Clients
    invoiced:    'c065222d-7364-412d-9a7b-42e699764d1f', // Outstanding Payments Backlog
  },
  patio: {
    accepted:    '66742bf8-4917-406c-a1c1-33ac271cfe09', // Ready to Execute
    approvals:   '66742bf8-4917-406c-a1c1-33ac271cfe09', // Council Approval in progress (use Ready to Execute — GHL has granular stages)
    deposit:     '66742bf8-4917-406c-a1c1-33ac271cfe09', // Finalised Plans and Invoice for Deposit Sent
    processing:   '48f6871b-2d6c-4679-86a6-5b7bd602a6a8', // Deposit Received Materials to be ordered
    scheduled:   '48f6871b-2d6c-4679-86a6-5b7bd602a6a8', // Scheduled Awaiting Start Date (legacy)
    in_progress: '4dfa654d-4d7c-491b-89dc-39717fc8e911', // In Progress
    complete:    '54d52061-6fca-4dfe-a421-f35a3b88d434', // Job complete Needs to be invoiced
    invoiced:    '0276706b-faeb-44ff-b049-efce11a96a7f', // Invoice Sent waiting on Final Payment
  },
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

async function ghl(path: string, init: RequestInit = {}) {
  const url = `${GHL_BASE}${path}`
  console.log(`[ghl-proxy] Calling: ${init.method || 'GET'} ${url}`)
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${GHL_API_TOKEN}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  console.log(`[ghl-proxy] Response: ${res.status} (${text.length} bytes)`)
  if (!res.ok) throw new Error(`GHL ${res.status}: ${text}`)
  return JSON.parse(text)
}

// Normalize Australian phone number for dedup
function normalizeAUPhone(phone: string): string {
  if (!phone) return ''
  // Strip spaces, dashes, parens, dots
  let clean = phone.replace(/[\s\-\(\)\.]/g, '')
  // Convert +61 to 0 prefix for consistency
  if (clean.startsWith('+61')) clean = '0' + clean.slice(3)
  // Convert 61 prefix (without +) to 0
  if (clean.startsWith('61') && clean.length === 11) clean = '0' + clean.slice(2)
  return clean
}

// ── Stage name cache (all pipelines loaded at once) ──
let stageCache: Record<string, Record<string, string>> = {}
let stageCacheLoaded = false

async function resolveStages(pipelineId: string) {
  if (!stageCacheLoaded) {
    try {
      const data = await ghl(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`)
      for (const p of (data.pipelines || [])) {
        const map: Record<string, string> = {}
        for (const s of (p.stages || [])) {
          map[s.id] = s.name
        }
        stageCache[p.id] = map
      }
      stageCacheLoaded = true
    } catch (e) {
      console.log('[ghl-proxy] Stage fetch failed:', e)
    }
  }
  return stageCache[pipelineId] || {}
}

function mapOpp(opp: any, stages: Record<string, string>) {
  return {
    id: opp.id,
    name: opp.name || opp.contact?.name || 'Unknown',
    contactName: opp.contact?.name || opp.name || '',
    contactEmail: opp.contact?.email || '',
    contactPhone: opp.contact?.phone || '',
    stageName: stages[opp.pipelineStageId] || opp.status || '',
    status: opp.status,
    monetaryValue: opp.monetaryValue || 0,
    createdAt: opp.createdAt,
    contactId: opp.contact?.id || '',
  }
}

// ════════════════════════════════════════════════════════════
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  // ── Dual Authentication: API Key (server-to-server) + JWT (browser) ──
  const validKey = Deno.env.get('SW_API_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const xApiKey = req.headers.get('x-api-key')
  const authHeader = req.headers.get('authorization')
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

  let isAuthed = false
  if (xApiKey && (xApiKey === validKey || xApiKey === serviceKey)) {
    isAuthed = true // Server-to-server via x-api-key
  } else if (bearerToken && (bearerToken === validKey || bearerToken === serviceKey)) {
    isAuthed = true // Server-to-server via Bearer
  } else if (bearerToken) {
    // Validate as user JWT (browser request)
    try {
      const authClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const { data: { user }, error } = await authClient.auth.getUser(bearerToken)
      if (!error && user) isAuthed = true
    } catch (_) { /* invalid token */ }
  }
  if (!isAuthed) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }

  try {
    const url = new URL(req.url)
    const action = url.searchParams.get('action')
    console.log(`[ghl-proxy] action=${action} method=${req.method}`)

    // ── List all pipelines (for discovering pipeline IDs) ──
    if (action === 'pipelines') {
      const data = await ghl(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`)
      return json(data)
    }

    // ── Get stage mappings (for webhook handler reverse lookups) ──
    if (action === 'stage_map') {
      return json({
        ops_to_ghl: OPS_TO_GHL_STAGES,
        execution_pipelines: EXECUTION_PIPELINES,
        stage_map: await (async () => {
          // Build GHL stage ID → Supabase status reverse lookup from STAGE_MAP
          // (used by ghl-webhook to map incoming stage changes)
          const stageIdToStatus: Record<string, string> = {}
          // Load all pipeline stages
          const data = await ghl(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`)
          for (const p of (data.pipelines || [])) {
            for (const s of (p.stages || [])) {
              // Use the STAGE_MAP defined in sync_ghl to resolve stage name → status
              const STAGE_MAP: Record<string, string> = {
                // Fencing Execution
                'Job Accepted Ready for Execution': 'accepted',
                '25% Deposits To Be Received (Shared Fence)': 'deposit',
                '50% Deposit To Be Received': 'deposit',
                'Materials To Be Ordered / Job Scheduled': 'processing',
                'Pending WhatsApp Confirmation From Fencing Team': 'processing',
                'Pending Confirmation Email From Supplier': 'processing',
                'Confirmed Material Order': 'processing',
                'Order to be Picked up': 'processing',
                'Order To be Delivered (Materials TBC on Site)': 'processing',
                'Scheduled / In Progress': 'in_progress',
                'Get Final Payment Both Clients': 'complete',
                'Get Google Review': 'complete',
                'Completed and Archived in Tradify (Get Sign off)': 'complete',
                'Outstanding Payments Backlog': 'invoiced',
                // Patio Execution
                'Ready to Execute': 'accepted',
                'Drafting in progress': 'approvals',
                'DA in Progress': 'approvals',
                'Engineering in progress': 'approvals',
                'CDC in Progress': 'approvals',
                'Council Approval in progress': 'approvals',
                'Finalised Plans and Invoice for Deposit Sent': 'deposit',
                'Deposit Received Materials to be ordered': 'processing',
                'Materials Ordered Job to be Scheduled': 'processing',
                'Scheduled Awaiting Start Date': 'processing',
                'In Progress': 'in_progress',
                'Rectifcation / To be Finished off': 'in_progress',
                'Job complete Needs to be invoiced': 'complete',
                'Invoice Sent waiting on Final Payment': 'invoiced',
                'Job sign off with all documentation': 'complete',
              }
              if (STAGE_MAP[s.name]) {
                stageIdToStatus[s.id] = STAGE_MAP[s.name]
              }
            }
          }
          return stageIdToStatus
        })(),
      })
    }

    // ── List opportunities ──
    if (action === 'opportunities') {
      const pipeline = url.searchParams.get('pipeline') || 'patio'
      const pipelineId = PIPELINES[pipeline] || EXECUTION_PIPELINES[pipeline]
      if (!pipelineId) return json({ error: 'Invalid pipeline. Use: fencing, patio, fencing_exec, patio_exec' }, 400)

      const [stages, data] = await Promise.all([
        resolveStages(pipelineId),
        ghl(`/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_id=${pipelineId}&limit=50`),
      ])
      const opps = (data.opportunities || []).map((o: any) => mapOpp(o, stages))
      return json({ opportunities: opps })
    }

    // ── Search (enhanced: pipeline filter, stage names, Supabase cross-ref) ──
    if (action === 'search') {
      const q = (url.searchParams.get('q') || '').trim()
      const pipeline = url.searchParams.get('pipeline') || ''
      const pipelineId = pipeline ? (PIPELINES[pipeline] || EXECUTION_PIPELINES[pipeline]) : ''

      // Build GHL search URL
      let searchUrl = `/opportunities/search?location_id=${GHL_LOCATION_ID}&limit=50`
      if (pipelineId) searchUrl += `&pipeline_id=${pipelineId}`
      if (q) searchUrl += `&q=${encodeURIComponent(q)}`

      // If no query AND no pipeline, return empty (original behaviour)
      if (!q && !pipelineId) return json({ opportunities: [] })

      const [stages, data] = await Promise.all([
        pipelineId ? resolveStages(pipelineId) : Promise.resolve({} as Record<string, string>),
        ghl(searchUrl),
      ])
      const opps = (data.opportunities || []).map((o: any) => mapOpp(o, stages))

      // Cross-reference with Supabase jobs to annotate linked leads
      const oppIds = opps.map((o: any) => o.id).filter(Boolean)
      if (oppIds.length > 0) {
        try {
          const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
          const { data: jobs } = await sb.from('jobs')
            .select('id, ghl_opportunity_id, scope_json')
            .in('ghl_opportunity_id', oppIds)
          const jobMap: Record<string, { id: string, hasScope: boolean }> = {}
          ;(jobs || []).forEach((j: any) => {
            jobMap[j.ghl_opportunity_id] = { id: j.id, hasScope: !!(j.scope_json && Object.keys(j.scope_json).length > 0) }
          })
          opps.forEach((o: any) => {
            const match = jobMap[o.id]
            o.supabaseJobId = match?.id || null
            o.hasScope = match?.hasScope || false
          })
        } catch (e) {
          console.log('[ghl-proxy] Supabase cross-ref failed (non-blocking):', e)
        }
      }

      return json({ opportunities: opps })
    }

    // ── Get full contact details ──
    if (action === 'contact') {
      const contactId = url.searchParams.get('contactId') || ''
      if (!contactId) return json({ error: 'contactId required' }, 400)
      const data = await ghl(`/contacts/${contactId}`)
      const c = data.contact || data
      return json({
        contact: {
          id: c.id,
          name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || '',
          firstName: c.firstName || '',
          lastName: c.lastName || '',
          email: c.email || '',
          phone: c.phone || '',
          address: c.address1 || '',
          suburb: c.city || '',
          state: c.state || '',
          postcode: c.postalCode || '',
        }
      })
    }

    // ── Link scope to opportunity ──
    if (action === 'link' && req.method === 'POST') {
      const body = await req.json()
      const { opportunityId, jobId, toolType, contactId } = body
      if (!opportunityId || !jobId) return json({ error: 'opportunityId and jobId required' }, 400)

      const tool = toolType === 'fencing' ? 'fencing' : 'patio'
      // GitHub Pages hosts the tools
      const toolUrls: Record<string, string> = {
        patio: 'https://marninms98-dotcom.github.io/patio/',
        fencing: 'https://marninms98-dotcom.github.io/fence-designer/',
      }
      const scopeUrl = `${toolUrls[tool] || toolUrls.patio}?jobId=${jobId}`

      // Move opportunity to "Scope Complete" stage in the pipeline
      let stageMoved = false
      const scopeStageId = SCOPE_COMPLETE_STAGES[tool]
      if (scopeStageId) {
        try {
          await ghl(`/opportunities/${opportunityId}`, {
            method: 'PUT',
            body: JSON.stringify({ pipelineStageId: scopeStageId })
          })
          stageMoved = true
          console.log(`[ghl-proxy] Opportunity moved to Scope Complete stage: ${scopeStageId}`)
        } catch (e) {
          console.log('[ghl-proxy] Stage move failed:', e)
        }
      }

      // Build a rich note from job data and add to contact
      let noteAdded = false
      if (contactId) {
        try {
          const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

          // Get job scope data
          const { data: jobData } = await sb.from('jobs')
            .select('scope_json, client_name, site_address, site_suburb, pricing_json')
            .eq('id', jobId)
            .single()

          // Get photos for this job
          const { data: photos } = await sb.from('job_media')
            .select('storage_url, thumbnail_url, label')
            .eq('job_id', jobId)
            .eq('type', 'photo')

          // Build the note
          const lines: string[] = []
          lines.push(`📋 SCOPE COMPLETE — ${tool.toUpperCase()}`)
          lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━`)

          if (jobData?.scope_json) {
            const scope = jobData.scope_json
            const config = scope.config || {}
            const client = scope.client || {}
            const pricing = scope.pricing || {}

            if (client.name) lines.push(`👤 ${client.name}`)
            if (client.address || jobData.site_suburb) lines.push(`📍 ${client.address || jobData.site_address || ''} ${jobData.site_suburb || ''}`.trim())
            lines.push('')

            // Dimensions & config
            if (config.length || config.projection) {
              lines.push(`📐 Size: ${config.length || '?'}m × ${config.projection || '?'}m`)
            }
            if (config.roofStyle) lines.push(`🏠 Style: ${config.roofStyle}`)
            if (config.roofing) lines.push(`🔩 Roofing: ${config.roofing}`)
            if (config.connection) lines.push(`🔗 Connection: ${config.connection}`)
            if (config.steelColor) lines.push(`🎨 Steel: ${config.steelColor} | Sheet: ${config.sheetColor || ''}`)
            lines.push('')

            // Pricing (from scope_json pricing or pricing_json)
            const pricingData = scope.pricing || {}
            // Try to extract total from scope data
            if (client.jobRef) lines.push(`📝 Job Ref: ${client.jobRef}`)
          }

          lines.push('')
          lines.push(`🔗 Open Scope: ${scopeUrl}`)

          // Just show photo count — all photos viewable via scope link
          if (photos && photos.length > 0) {
            lines.push(`📸 ${photos.length} site photo${photos.length > 1 ? 's' : ''} attached`)
          }

          await ghl(`/contacts/${contactId}/notes`, {
            method: 'POST',
            body: JSON.stringify({ body: lines.join('\n') })
          })
          noteAdded = true
          console.log('[ghl-proxy] Rich scope note added to contact')
        } catch (e) {
          console.log('[ghl-proxy] Contact note failed:', e)
          // Fallback: simple note
          try {
            await ghl(`/contacts/${contactId}/notes`, {
              method: 'POST',
              body: JSON.stringify({ body: `📋 Scope Link: ${scopeUrl}` })
            })
            noteAdded = true
          } catch (e2) {
            console.log('[ghl-proxy] Simple note also failed:', e2)
          }
        }
      }

      // Update Supabase job with GHL opportunity ID + contact ID
      const sbLink = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      await sbLink.from('jobs').update({
        ghl_opportunity_id: opportunityId,
        ghl_contact_id: contactId || null,
      }).eq('id', jobId)
      await sbLink.from('job_events').insert({ job_id: jobId, event_type: 'ghl_linked', detail_json: { opportunity_id: opportunityId, contact_id: contactId, scope_url: scopeUrl, stage_moved: stageMoved, note_added: noteAdded } })

      // ── Close the attribution chain: link contact_matches to this job ──
      // This connects Google Ads click → GHL contact → Supabase job
      let leadSource: string | null = null
      if (contactId) {
        try {
          // Find existing contact_matches entry for this GHL contact
          const { data: match } = await sbLink.from('contact_matches')
            .select('id, lead_source, utm_source, utm_campaign, gclid')
            .eq('ghl_contact_id', contactId)
            .is('job_id', null)
            .maybeSingle()

          if (match) {
            // Link the contact_match to this job
            await sbLink.from('contact_matches')
              .update({ job_id: jobId })
              .eq('id', match.id)
            leadSource = match.lead_source
            console.log(`[ghl-proxy] Attribution chain closed: ${match.lead_source || 'unknown'} → job ${jobId}`)
          } else {
            // No existing match — create one so the job has a contact_matches entry
            await sbLink.from('contact_matches').insert({
              org_id: DEFAULT_ORG_ID,
              ghl_contact_id: contactId,
              job_id: jobId,
              client_name: null, // will be filled from job data below
              lead_source: null, // unknown — GHL contact didn't come through tracked form
            })
            console.log(`[ghl-proxy] Created contact_matches entry for job ${jobId} (no attribution data)`)
          }
        } catch (e) {
          console.log('[ghl-proxy] Attribution chain link failed (non-blocking):', (e as Error).message)
        }
      }

      // ── Generate type-prefixed job number (SWP-25001, SWF-25002, etc.) ──
      let jobNumber: string | null = null
      try {
        // Check if job already has a number (re-save scenario)
        const { data: existingJob } = await sbLink.from('jobs')
          .select('job_number')
          .eq('id', jobId)
          .single()

        if (existingJob?.job_number) {
          // Job already posted — reuse existing number, just update scope data
          jobNumber = existingJob.job_number
          console.log(`[ghl-proxy] Job already has number: ${jobNumber}, reusing`)
        } else {
          // First time — assign new job number
          const jobType = tool || 'patio'
          const { data: jnData } = await sbLink.rpc('next_job_number', { job_type: jobType })
          jobNumber = jnData
          if (jobNumber) {
            await sbLink.from('jobs').update({ job_number: jobNumber, status: 'quoted' }).eq('id', jobId)
            await sbLink.from('job_events').insert({ job_id: jobId, event_type: 'status_change', detail_json: { from: 'draft', to: 'quoted', job_number: jobNumber } })
            console.log(`[ghl-proxy] Job number assigned: ${jobNumber}, status → quoted`)
          }
        }
      } catch (e) {
        console.log('[ghl-proxy] Job number generation failed (non-blocking):', (e as Error).message)
      }

      // ── Get latest job data for Xero contact creation + GHL monetary value ──
      const { data: jobData } = await sbLink.from('jobs')
        .select('client_name, client_email, client_phone, site_address, site_suburb, pricing_json, scope_json')
        .eq('id', jobId)
        .single()

      // ── Create/find Xero contact (non-blocking) ──
      let xeroResult: any = null
      if (jobData?.client_name) {
        try {
          const scope = jobData.scope_json || {}
          const client = scope.client || {}
          const xeroResp = await fetch(
            `${SUPABASE_URL}/functions/v1/xero-sync?action=create_or_find_contact`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': `${jobId}-create-contact`,
              },
              body: JSON.stringify({
                name: jobData.client_name,
                email: client.email || jobData.client_email || undefined,
                phone: client.phone || jobData.client_phone || undefined,
                address: client.address || jobData.site_address || undefined,
                suburb: client.suburb || jobData.site_suburb || undefined,
                job_id: jobId,
                ghl_contact_id: contactId || undefined,
                idempotency_key: `${jobId}-create-contact`,
              }),
            }
          )
          xeroResult = await xeroResp.json()
          console.log(`[ghl-proxy] Xero contact: ${xeroResult.created ? 'created' : 'found'} — ${xeroResult.contact_name}`)
        } catch (e) {
          console.log('[ghl-proxy] Xero contact sync failed (non-blocking):', (e as Error).message)
        }
      }

      // ── Push monetary value to GHL opportunity (non-blocking) ──
      let monetaryValue: number | null = null
      const pricing = jobData?.pricing_json || {}
      if (pricing.totalIncGST && pricing.totalIncGST > 0) {
        monetaryValue = pricing.totalIncGST
        try {
          await ghl(`/opportunities/${opportunityId}`, {
            method: 'PUT',
            body: JSON.stringify({ monetaryValue }),
          })
          console.log(`[ghl-proxy] GHL monetary value set: $${monetaryValue}`)
        } catch (e) {
          console.log('[ghl-proxy] GHL monetary value failed (non-blocking):', (e as Error).message)
        }
      }

      // ── Write custom fields to GHL opportunity (for pipeline visibility + webhook re-link) ──
      let customFieldsWritten = false
      if (jobNumber || jobId) {
        try {
          const customFields: { key: string; value: string | number }[] = []
          if (jobNumber) customFields.push({ key: 'job_number', value: jobNumber })
          customFields.push({ key: 'supabase_job_id', value: jobId })
          customFields.push({ key: 'job_type', value: tool })
          if (monetaryValue) customFields.push({ key: 'quote_value', value: monetaryValue })
          await ghl(`/opportunities/${opportunityId}`, {
            method: 'PUT',
            body: JSON.stringify({ customFields }),
          })
          customFieldsWritten = true
          console.log(`[ghl-proxy] Custom fields written: ${customFields.map(f => f.key).join(', ')}`)
        } catch (e) {
          console.log('[ghl-proxy] Custom field write failed (non-blocking):', (e as Error).message)
        }
      }

      // ── Rename GHL opportunity for pipeline readability ──
      // Format: "SWP-25005 — Wendy Walley — Patio"
      let opportunityRenamed = false
      if (jobNumber && jobData?.client_name) {
        try {
          const typeName = tool.charAt(0).toUpperCase() + tool.slice(1)
          const newName = `${jobNumber} — ${jobData.client_name} — ${typeName}`
          await ghl(`/opportunities/${opportunityId}`, {
            method: 'PUT',
            body: JSON.stringify({ name: newName }),
          })
          opportunityRenamed = true
          console.log(`[ghl-proxy] Opportunity renamed: ${newName}`)
        } catch (e) {
          console.log('[ghl-proxy] Opportunity rename failed (non-blocking):', (e as Error).message)
        }
      }

      // ── Update contact_matches with client name + Xero ID now that we have them ──
      if (contactId) {
        try {
          const cmUpdate: any = {}
          if (jobData?.client_name) cmUpdate.client_name = jobData.client_name
          if (jobData?.client_email) cmUpdate.email = jobData.client_email
          if (jobData?.client_phone) cmUpdate.phone = jobData.client_phone
          if (xeroResult?.xero_contact_id) cmUpdate.xero_contact_id = xeroResult.xero_contact_id
          if (Object.keys(cmUpdate).length > 0) {
            await sbLink.from('contact_matches')
              .update(cmUpdate)
              .eq('ghl_contact_id', contactId)
              .eq('job_id', jobId)
          }
        } catch (e) {
          console.log('[ghl-proxy] contact_matches enrichment failed (non-blocking):', (e as Error).message)
        }
      }

      return json({
        success: true,
        scopeUrl,
        stageMoved,
        noteAdded,
        jobNumber,
        leadSource,
        xeroContact: xeroResult ? { id: xeroResult.xero_contact_id, created: xeroResult.created } : null,
        monetaryValue,
        customFieldsWritten,
        opportunityRenamed,
      })
    }

    // ── Move opportunity to a specific GHL stage (used by ops-api sync) ──
    if (action === 'move_stage' && req.method === 'POST') {
      const body = await req.json()
      const { opportunityId, status, jobType } = body
      if (!opportunityId || !status) return json({ error: 'opportunityId and status required' }, 400)

      const type = jobType || 'patio'
      const stages = OPS_TO_GHL_STAGES[type]
      if (!stages) return json({ error: `No stage mapping for type "${type}"` }, 400)

      const targetStageId = stages[status]
      if (!targetStageId) return json({ error: `No GHL stage for status "${status}" in ${type}` }, 400)

      try {
        await ghl(`/opportunities/${opportunityId}`, {
          method: 'PUT',
          body: JSON.stringify({ pipelineStageId: targetStageId }),
        })
        console.log(`[ghl-proxy] move_stage: ${opportunityId} → ${status} (${targetStageId})`)
        return json({ success: true, stageId: targetStageId })
      } catch (e) {
        console.log('[ghl-proxy] move_stage failed:', e)
        return json({ success: false, error: (e as Error).message })
      }
    }

    // ── Move opportunity to "Job Complete" stage ──
    if (action === 'move_to_complete' && req.method === 'POST') {
      const body = await req.json()
      const { opportunityId, jobType, jobId } = body
      if (!opportunityId) return json({ error: 'opportunityId required' }, 400)

      const type = jobType || 'patio'
      const completeStageId = JOB_COMPLETE_STAGES[type]

      if (!completeStageId || completeStageId.startsWith('PLACEHOLDER')) {
        console.log(`[ghl-proxy] move_to_complete: no stage ID configured for type "${type}" — skipping GHL move`)
        // Still update job status in Supabase even without GHL stage move
        if (jobId) {
          const sbComplete = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
          await sbComplete.from('jobs').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', jobId)
          await sbComplete.from('job_events').insert({
            job_id: jobId, event_type: 'status_change',
            detail_json: { status: 'complete', source: 'trade_report', ghl_skipped: true },
          })
        }
        return json({ success: true, stageMoved: false, reason: 'stage_id_not_configured' })
      }

      // Move GHL opportunity stage
      let stageMoved = false
      try {
        await ghl(`/opportunities/${opportunityId}`, {
          method: 'PUT',
          body: JSON.stringify({ pipelineStageId: completeStageId }),
        })
        stageMoved = true
        console.log(`[ghl-proxy] Opportunity ${opportunityId} moved to Job Complete stage: ${completeStageId}`)
      } catch (e) {
        console.log('[ghl-proxy] Job Complete stage move failed:', e)
      }

      // Update job status in Supabase
      if (jobId) {
        const sbComplete = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        await sbComplete.from('jobs').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', jobId)
        await sbComplete.from('job_events').insert({
          job_id: jobId, event_type: 'status_change',
          detail_json: { status: 'complete', source: 'trade_report', ghl_stage_moved: stageMoved },
        })
      }

      return json({ success: true, stageMoved })
    }

    // ── Update GHL opportunity custom fields (scheduling info) ──
    if (action === 'update_custom_fields' && req.method === 'POST') {
      const body = await req.json()
      const { opportunityId, fields } = body
      if (!opportunityId || !fields) return json({ error: 'opportunityId and fields required' }, 400)

      try {
        // GHL custom fields are set via opportunity update
        const customFields: any[] = []
        for (const [key, value] of Object.entries(fields)) {
          customFields.push({ key, value })
        }
        await ghl(`/opportunities/${opportunityId}`, {
          method: 'PUT',
          body: JSON.stringify({ customFields }),
        })
        console.log(`[ghl-proxy] Custom fields updated for ${opportunityId}:`, Object.keys(fields))
        return json({ success: true })
      } catch (e) {
        console.log('[ghl-proxy] Custom field update failed:', e)
        return json({ success: false, error: (e as Error).message })
      }
    }

    // ── Add tag to GHL contact ──
    if (action === 'add_contact_tag' && req.method === 'POST') {
      const body = await req.json()
      const { contactId, tag } = body
      if (!contactId || !tag) return json({ error: 'contactId and tag required' }, 400)

      try {
        const contact = await ghl(`/contacts/${contactId}`)
        const existing: string[] = contact.contact?.tags || contact.tags || []
        if (!existing.includes(tag)) {
          existing.push(tag)
          await ghl(`/contacts/${contactId}`, {
            method: 'PUT',
            body: JSON.stringify({ tags: existing }),
          })
          console.log(`[ghl-proxy] Tag added to ${contactId}: ${tag}`)
        } else {
          console.log(`[ghl-proxy] Tag already exists on ${contactId}: ${tag}`)
        }
        return json({ success: true, tags: existing })
      } catch (e) {
        console.log('[ghl-proxy] add_contact_tag failed:', e)
        return json({ error: (e as Error).message }, 500)
      }
    }

    // ── Remove tag from GHL contact ──
    if (action === 'remove_contact_tag' && req.method === 'POST') {
      const body = await req.json()
      const { contactId, tag } = body
      if (!contactId || !tag) return json({ error: 'contactId and tag required' }, 400)

      try {
        const contact = await ghl(`/contacts/${contactId}`)
        const existing: string[] = contact.contact?.tags || contact.tags || []
        const filtered = existing.filter((t: string) => t !== tag)
        await ghl(`/contacts/${contactId}`, {
          method: 'PUT',
          body: JSON.stringify({ tags: filtered }),
        })
        console.log(`[ghl-proxy] Tag removed from ${contactId}: ${tag}`)
        return json({ success: true, tags: filtered })
      } catch (e) {
        console.log('[ghl-proxy] remove_contact_tag failed:', e)
        return json({ error: (e as Error).message }, 500)
      }
    }

    // ── Update custom fields on GHL contact (not opportunity) ──
    if (action === 'update_contact_custom_fields' && req.method === 'POST') {
      const body = await req.json()
      const { contactId, customFields } = body
      if (!contactId || !customFields) return json({ error: 'contactId and customFields required' }, 400)

      try {
        const fields: { key: string; field_value: string }[] = []
        for (const [key, value] of Object.entries(customFields)) {
          fields.push({ key, field_value: String(value) })
        }
        await ghl(`/contacts/${contactId}`, {
          method: 'PUT',
          body: JSON.stringify({ customFields: fields }),
        })
        console.log(`[ghl-proxy] Contact custom fields updated for ${contactId}:`, Object.keys(customFields))
        return json({ success: true })
      } catch (e) {
        console.log('[ghl-proxy] update_contact_custom_fields failed:', e)
        return json({ error: (e as Error).message }, 500)
      }
    }

    // ── Find existing Supabase job for a GHL opportunity ──
    // Pass ?type=fencing|patio to filter by job type (prevents cross-division overwrite)
    if (action === 'find_job') {
      const opportunityId = url.searchParams.get('opportunityId') || ''
      if (!opportunityId) return json({ error: 'opportunityId required' }, 400)

      const jobType = url.searchParams.get('type') || ''
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      let query = sb.from('jobs')
        .select('id, type, status, client_name, scope_json, pricing_json, ghl_opportunity_id, job_number, updated_at, site_address, site_suburb')
        .eq('ghl_opportunity_id', opportunityId)

      // Filter by type if provided — allows multiple jobs per opportunity (one per division)
      if (jobType) {
        query = query.eq('type', jobType)
      }
      query = query.limit(1)

      const { data, error } = await query

      if (error) {
        console.log('[ghl-proxy] find_job error:', error)
        return json({ error: error.message }, 500)
      }

      return json({ job: data && data.length > 0 ? data[0] : null })
    }

    // ── Search Supabase jobs across multiple fields ──
    if (action === 'search_jobs') {
      const q = (url.searchParams.get('q') || '').trim()
      const jobType = url.searchParams.get('type') || ''
      const limit = parseInt(url.searchParams.get('limit') || '30')
      const hasScope = url.searchParams.get('has_scope') === 'true'
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

      let query = sb.from('jobs')
        .select('id, type, status, client_name, client_phone, client_email, site_address, site_suburb, job_number, ghl_opportunity_id, ghl_contact_id, scope_json, pricing_json, updated_at, created_at')
        .not('legacy', 'is', true)
        .order('updated_at', { ascending: false })
        .limit(limit)

      if (jobType) query = query.eq('type', jobType)
      if (hasScope) query = query.not('scope_json', 'is', null)

      if (q) {
        // Search across multiple fields
        query = query.or(
          'job_number.ilike.%' + q + '%,' +
          'client_name.ilike.%' + q + '%,' +
          'site_address.ilike.%' + q + '%,' +
          'site_suburb.ilike.%' + q + '%,' +
          'client_phone.ilike.%' + q + '%,' +
          'client_email.ilike.%' + q + '%'
        )
      }

      const { data, error } = await query
      if (error) {
        console.log('[ghl-proxy] search_jobs error:', error)
        return json({ error: error.message }, 500)
      }

      return json({ jobs: data || [] })
    }

    // ── Create a Supabase job linked to a GHL opportunity ──
    if (action === 'create_job' && req.method === 'POST') {
      const body = await req.json()
      const { opportunityId, toolType, clientName, clientPhone, clientEmail, siteAddress, siteSuburb } = body

      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

      // Default org
      const orgId = '00000000-0000-0000-0000-000000000001'

      const insertData: Record<string, unknown> = {
        org_id: orgId,
        type: toolType || 'patio',
        status: 'draft',
        legacy: false,
        client_name: clientName || '',
        client_phone: clientPhone || '',
        client_email: clientEmail || '',
        site_address: siteAddress || '',
        site_suburb: siteSuburb || '',
      }
      // GHL link is optional — walk-up scopes may not have an opportunity
      if (opportunityId) insertData.ghl_opportunity_id = opportunityId
      if (body.contactId) insertData.ghl_contact_id = body.contactId

      const { data, error } = await sb.from('jobs').insert(insertData).select().single()

      if (error) {
        console.log('[ghl-proxy] create_job error:', error)
        return json({ error: error.message }, 500)
      }

      // Log event
      await sb.from('job_events').insert({
        job_id: data.id,
        event_type: 'job_created',
        detail_json: { source: opportunityId ? 'ghl_picker' : 'scoping_tool', opportunity_id: opportunityId || null }
      })

      return json({ job: data })
    }

    // ── Auto-create GHL contact + opportunity for walk-up clients ──
    if (action === 'create_contact_and_opportunity' && req.method === 'POST') {
      const body = await req.json()
      const { firstName, lastName, email, phone, address, suburb, toolType, skipOpportunity, name } = body

      // Resolve first/last name — send-quote sends `name` as full string
      let resolvedFirst = firstName || ''
      let resolvedLast = lastName || ''
      if (!resolvedFirst && !resolvedLast && name) {
        const parts = String(name).split(' ')
        resolvedFirst = parts[0] || ''
        resolvedLast = parts.slice(1).join(' ') || ''
      }

      // Normalize phone for dedup (handles +61 / 61 / 0 prefixes)
      const normalizedPhone = normalizeAUPhone(phone)

      let contactId: string | null = null
      let contactExisted = false

      // Dedup by email
      if (email) {
        try {
          const searchRes = await ghl(`/contacts/search/duplicate`, {
            method: 'POST',
            body: JSON.stringify({
              locationId: GHL_LOCATION_ID,
              email: email,
            }),
          })
          // v2 search returns { contact: {...} } if found
          if (searchRes.contact && searchRes.contact.id) {
            contactId = searchRes.contact.id
            contactExisted = true
            console.log('[ghl-proxy] Dedup: found existing contact by email:', contactId)
          }
        } catch (e) {
          console.log('[ghl-proxy] Email dedup search failed, trying phone:', e)
        }
      }

      // Dedup by phone if email didn't match
      if (!contactId && normalizedPhone) {
        try {
          const searchRes = await ghl(`/contacts/search/duplicate`, {
            method: 'POST',
            body: JSON.stringify({
              locationId: GHL_LOCATION_ID,
              phone: normalizedPhone,
            }),
          })
          if (searchRes.contact && searchRes.contact.id) {
            contactId = searchRes.contact.id
            contactExisted = true
            console.log('[ghl-proxy] Dedup: found existing contact by phone:', contactId)
          }
        } catch (e) {
          console.log('[ghl-proxy] Phone dedup search failed:', e)
        }
      }

      // Create contact if no match found
      if (!contactId) {
        try {
          const createRes = await ghl('/contacts/', {
            method: 'POST',
            body: JSON.stringify({
              firstName: resolvedFirst,
              lastName: resolvedLast,
              email: email || undefined,
              phone: phone || undefined,
              address1: address || '',
              city: suburb || '',
              locationId: GHL_LOCATION_ID,
            }),
          })
          contactId = createRes.contact?.id || null
          console.log('[ghl-proxy] Created new GHL contact:', contactId)
        } catch (e) {
          const errMsg = (e as Error).message || ''
          console.log('[ghl-proxy] Failed to create GHL contact:', errMsg)

          // GHL returns the existing contactId in duplicate errors — use it instead of failing
          const dupMatch = errMsg.match(/"contactId"\s*:\s*"([^"]+)"/)
          if (dupMatch && dupMatch[1]) {
            contactId = dupMatch[1]
            contactExisted = true
            console.log('[ghl-proxy] Recovered existing contact from duplicate error:', contactId)
          } else {
            return json({ error: 'Failed to create GHL contact: ' + errMsg }, 500)
          }
        }
      }

      // Create opportunity in the correct pipeline (skip for neighbours)
      let opportunityId: string | null = null
      if (!skipOpportunity) {
        const pipelineId = PIPELINES[toolType] || PIPELINES.patio
        try {
          const oppName = [resolvedFirst, resolvedLast].filter(Boolean).join(' ') + ' — ' + (toolType === 'fencing' ? 'Fencing' : 'Patio')
          const oppRes = await ghl('/opportunities/', {
            method: 'POST',
            body: JSON.stringify({
              pipelineId: pipelineId,
              locationId: GHL_LOCATION_ID,
              contactId: contactId,
              name: oppName,
              status: 'open',
              pipelineStageId: undefined, // defaults to first stage
            }),
          })
          opportunityId = oppRes.opportunity?.id || null
          console.log('[ghl-proxy] Created GHL opportunity:', opportunityId)
        } catch (e) {
          console.log('[ghl-proxy] Failed to create GHL opportunity:', e)
          return json({ contactId, opportunityId: null, contactExisted, error: 'Opportunity creation failed: ' + (e as Error).message }, 500)
        }
      } else {
        console.log('[ghl-proxy] skipOpportunity=true — no opportunity created for contact:', contactId)
      }

      return json({ contactId, opportunityId, contactExisted })
    }

    // ── Save scope data to a job (bypasses RLS) ──
    if (action === 'save_scope' && req.method === 'POST') {
      const body = await req.json()
      const { jobId, scopeJson, meta } = body
      if (!jobId) return json({ error: 'jobId required' }, 400)

      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

      // Snapshot previous scope_json hash for audit trail (non-blocking)
      let prevHash = null
      try {
        const { data: prev } = await sb.from('jobs').select('scope_json').eq('id', jobId).single()
        if (prev && prev.scope_json && Object.keys(prev.scope_json).length > 0) {
          prevHash = JSON.stringify(prev.scope_json).length // lightweight size fingerprint
        }
      } catch (_) { /* non-blocking */ }

      const update: Record<string, any> = { scope_json: scopeJson || {}, legacy: false }
      if (meta) {
        if (meta.client_name) update.client_name = meta.client_name
        if (meta.client_phone) update.client_phone = meta.client_phone
        if (meta.client_email) update.client_email = meta.client_email
        if (meta.site_address) update.site_address = meta.site_address
        if (meta.site_suburb) update.site_suburb = meta.site_suburb
        if (meta.pricing_json) update.pricing_json = meta.pricing_json
        if (meta.notes) update.notes = meta.notes
      }

      const { data, error } = await sb.from('jobs')
        .update(update)
        .eq('id', jobId)
        .select()
        .single()

      if (error) {
        console.log('[ghl-proxy] save_scope error:', error)
        return json({ error: error.message }, 500)
      }

      // Log event with previous scope size for change detection
      await sb.from('job_events').insert({
        job_id: jobId,
        event_type: 'scope_saved',
        detail_json: { source: 'tool', prev_scope_size: prevHash, new_scope_size: JSON.stringify(scopeJson || {}).length }
      })

      return json({ job: data })
    }

    // ── Load a job by ID (bypasses RLS) ──
    if (action === 'load_job') {
      const jobId = url.searchParams.get('jobId') || ''
      if (!jobId) return json({ error: 'jobId required' }, 400)

      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

      // Select specific columns instead of * to avoid pulling unnecessary data
      // and reduce transfer size for large scope_json payloads
      const columns = 'id, org_id, created_by, status, type, client_name, client_phone, client_email, site_address, site_suburb, site_lat, site_lng, job_number, ghl_opportunity_id, ghl_contact_id, notes, scope_json, pricing_json, quoted_at, accepted_at, scheduled_at, completed_at, created_at, updated_at'

      const { data, error } = await sb.from('jobs')
        .select(columns)
        .eq('id', jobId)
        .single()

      if (error) return json({ error: error.message }, 500)
      return json({ job: data })
    }

    // ── List media (photos/videos) for a job ──
    if (action === 'list_media') {
      const jobId = url.searchParams.get('jobId') || ''
      if (!jobId) return json({ error: 'jobId required' }, 400)

      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const { data, error } = await sb.from('job_media')
        .select('id, type, storage_url, thumbnail_url, label, notes, created_at')
        .eq('job_id', jobId)
        .order('created_at', { ascending: true })

      if (error) {
        console.log('[ghl-proxy] list_media error:', error)
        return json({ media: [] })
      }
      return json({ media: data || [] })
    }

    // ── Setup storage buckets ──
    if (action === 'setup_storage') {
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const results: Record<string, string> = {}

      for (const bucket of ['job-photos', 'job-videos', 'job-pdfs']) {
        // Update to public
        const { data, error } = await sb.storage.updateBucket(bucket, { public: true })
        results[bucket] = error ? `error: ${error.message}` : 'set public'
      }

      // Verify
      const { data: buckets } = await sb.storage.listBuckets()
      results['all_buckets'] = (buckets || []).map(b => `${b.name} (public:${b.public})`).join(', ')

      return json(results)
    }

    // ── Get a signed upload URL for large files (videos) ──
    if (action === 'get_upload_url' && req.method === 'POST') {
      const body = await req.json()
      const { jobId, fileName, contentType } = body
      if (!jobId || !fileName) return json({ error: 'jobId and fileName required' }, 400)

      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const orgId = '00000000-0000-0000-0000-000000000001'
      const bucket = contentType?.startsWith('video/') ? 'job-videos' : 'job-photos'
      const path = `${orgId}/${jobId}/media/${crypto.randomUUID()}_${fileName}`

      // Ensure bucket exists
      try {
        await sb.storage.createBucket(bucket, { public: true })
      } catch (e) {
        // Bucket already exists — fine
      }

      const { data, error } = await sb.storage
        .from(bucket)
        .createSignedUploadUrl(path)

      if (error) {
        console.log('[ghl-proxy] Signed URL error:', error)
        return json({ error: error.message }, 500)
      }

      // Also return the public URL for after upload
      const { data: urlData } = sb.storage.from(bucket).getPublicUrl(path)

      return json({
        signedUrl: data.signedUrl,
        token: data.token,
        path: path,
        publicUrl: urlData.publicUrl,
        bucket: bucket
      })
    }

    // ── Register an uploaded media item in the database ──
    if (action === 'register_media' && req.method === 'POST') {
      const body = await req.json()
      const { jobId, storageUrl, type, label } = body
      if (!jobId || !storageUrl) return json({ error: 'jobId and storageUrl required' }, 400)

      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const { data, error } = await sb.from('job_media').insert({
        job_id: jobId,
        type: type || 'photo',
        storage_url: storageUrl,
        label: label || '',
        phase: 'scope',
      }).select().single()

      if (error) {
        console.log('[ghl-proxy] register_media error:', error)
        return json({ error: error.message }, 500)
      }

      return json({ id: data.id, url: storageUrl })
    }

    // ── Upload a photo to Supabase Storage ──
    if (action === 'upload_photo' && req.method === 'POST') {
      const body = await req.json()
      const { jobId, dataUrl, label, caption } = body
      if (!jobId || !dataUrl) return json({ error: 'jobId and dataUrl required' }, 400)

      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const orgId = '00000000-0000-0000-0000-000000000001'

      // Decode base64 dataUrl to binary
      const base64 = dataUrl.split(',')[1]
      const mimeMatch = dataUrl.match(/data:([^;]+);/)
      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg'
      const ext = mime.includes('png') ? 'png' : 'jpg'
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))

      // Upload to storage
      const photoId = crypto.randomUUID()
      const path = `${orgId}/${jobId}/photos/${photoId}.${ext}`
      const { error: uploadError } = await sb.storage
        .from('job-photos')
        .upload(path, bytes, { contentType: mime, upsert: false })

      if (uploadError) {
        console.log('[ghl-proxy] Photo upload error:', uploadError)
        // If bucket doesn't exist, create it
        if (uploadError.message?.includes('not found') || uploadError.statusCode === '404') {
          await sb.storage.createBucket('job-photos', { public: true })
          const { error: retryError } = await sb.storage
            .from('job-photos')
            .upload(path, bytes, { contentType: mime, upsert: false })
          if (retryError) return json({ error: retryError.message }, 500)
        } else {
          return json({ error: uploadError.message }, 500)
        }
      }

      // Get public URL
      const { data: urlData } = sb.storage.from('job-photos').getPublicUrl(path)
      const storageUrl = urlData.publicUrl

      // Insert media record
      const { data: mediaRecord, error: mediaError } = await sb.from('job_media').insert({
        job_id: jobId,
        type: 'photo',
        storage_url: storageUrl,
        label: label || '',
        notes: caption || '',
        phase: 'scope',
      }).select().single()

      if (mediaError) {
        console.log('[ghl-proxy] Media record error:', mediaError)
        // Table might not exist, just return the URL
        return json({ url: storageUrl, label })
      }

      return json({ url: storageUrl, id: mediaRecord.id, label })
    }

    // ── Update GHL contact with details from tool ──
    if (action === 'update_contact' && req.method === 'POST') {
      const body = await req.json()
      const { contactId, name, firstName, lastName, email, phone, address, suburb } = body
      if (!contactId) return json({ error: 'contactId required' }, 400)

      const update: Record<string, string> = {}
      // Prefer structured firstName/lastName over combined name to avoid round-trip mangling
      if (firstName !== undefined) {
        update.firstName = firstName
        update.lastName = lastName || ''
      } else if (name) {
        const parts = name.trim().split(/\s+/)
        update.firstName = parts[0]
        if (parts.length > 1) update.lastName = parts.slice(1).join(' ')
      }
      if (email) update.email = email
      if (phone) update.phone = phone
      if (address) update.address1 = address
      if (suburb) update.city = suburb

      await ghl(`/contacts/${contactId}`, { method: 'PUT', body: JSON.stringify(update) })
      return json({ success: true })
    }

    // ── Get or create user profile (bypasses RLS) ──
    if (action === 'get_profile' && req.method === 'POST') {
      const body = await req.json()
      const { userId, email } = body
      if (!userId) return json({ error: 'userId required' }, 400)

      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const { data, error } = await sb.from('users')
        .select('*')
        .eq('id', userId)
        .single()

      if (error && error.code === 'PGRST116') {
        // User exists in auth but not in users table — auto-create
        const { data: newUser, error: insertErr } = await sb.from('users').insert({
          id: userId,
          org_id: '00000000-0000-0000-0000-000000000001',
          name: (email || '').split('@')[0],
          email: email || '',
          role: 'estimator'
        }).select().single()

        if (insertErr) return json({ error: insertErr.message }, 500)
        return json({ profile: newUser })
      }

      if (error) return json({ error: error.message }, 500)
      return json({ profile: data })
    }

    // ── Delete media records ──
    if (action === 'delete_media' && req.method === 'POST') {
      const body = await req.json()
      const { ids } = body
      if (!ids || !Array.isArray(ids)) return json({ error: 'ids array required' }, 400)

      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

      // Get storage URLs before deleting records
      const { data: records } = await sb.from('job_media').select('id, storage_url').in('id', ids)

      // Delete storage files
      if (records) {
        for (const r of records) {
          try {
            const urlPath = new URL(r.storage_url).pathname
            const match = urlPath.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)/)
            if (match) {
              await sb.storage.from(match[1]).remove([match[2]])
            }
          } catch (e) { /* ignore storage delete errors */ }
        }
      }

      // Delete database records
      const { error } = await sb.from('job_media').delete().in('id', ids)
      if (error) return json({ error: error.message }, 500)
      return json({ deleted: ids.length })
    }

    // ── Prepare a quote for sending — upload URL + job_documents record ──
    // Client generates PDF, calls this to get a signed upload URL,
    // then uploads the PDF, then calls send-quote/send.
    if (action === 'prepare_quote' && req.method === 'POST') {
      const body = await req.json()
      const { jobId, fileName, supportingDocs } = body
      if (!jobId) return json({ error: 'jobId required' }, 400)

      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const orgId = '00000000-0000-0000-0000-000000000001'

      // Get latest version for this doc type
      let version = 1
      const { data: existing } = await sb.from('job_documents')
        .select('version')
        .eq('job_id', jobId)
        .eq('type', 'quote')
        .order('version', { ascending: false })
        .limit(1)
      if (existing && existing.length > 0) {
        version = existing[0].version + 1
      }

      // Create signed upload URL for job-pdfs bucket
      const safeName = (fileName || 'quote').replace(/[^a-zA-Z0-9._-]/g, '_')
      const path = `${orgId}/${jobId}/quote_v${version}_${safeName}`

      try {
        await sb.storage.createBucket('job-pdfs', { public: true })
      } catch (e) { /* bucket exists */ }

      const { data: uploadData, error: uploadErr } = await sb.storage
        .from('job-pdfs')
        .createSignedUploadUrl(path)

      if (uploadErr) {
        console.log('[ghl-proxy] PDF signed URL error:', uploadErr)
        return json({ error: uploadErr.message }, 500)
      }

      // Get the public URL
      const { data: urlData } = sb.storage.from('job-pdfs').getPublicUrl(path)

      // Generate share token
      const shareToken = crypto.randomUUID()

      // Get next quote number
      const { data: qnData } = await sb.rpc('next_quote_number')
      const quoteNumber = qnData || null

      // Create job_documents record
      const docInsert: Record<string, unknown> = {
        job_id: jobId,
        type: 'quote',
        version,
        pdf_url: urlData.publicUrl,
        share_token: shareToken,
        quote_number: quoteNumber,
      }

      const { data: docRecord, error: docErr } = await sb.from('job_documents')
        .insert(docInsert)
        .select()
        .maybeSingle()

      // Store supporting docs selection in data_snapshot_json (column always exists)
      if (docRecord && supportingDocs && supportingDocs.length > 0) {
        await sb.from('job_documents')
          .update({ data_snapshot_json: { supporting_docs: supportingDocs } })
          .eq('id', docRecord.id)
      }

      if (docErr) {
        console.log('[ghl-proxy] job_documents insert error:', docErr)
        return json({ error: docErr.message }, 500)
      }

      console.log(`[ghl-proxy] Quote prepared: job=${jobId} v${version} doc=${docRecord.id} quote#=${quoteNumber}`)

      return json({
        documentId: docRecord.id,
        shareToken,
        quoteNumber,
        version,
        uploadUrl: uploadData.signedUrl,
        publicUrl: urlData.publicUrl,
        path,
      })
    }

    // ── Prepare Neighbour Quotes — multi-contact fencing jobs ──
    if (action === 'prepare_neighbour_quotes' && req.method === 'POST') {
      const body = await req.json()
      const { jobId, contacts, fileName, supportingDocs } = body
      // contacts: [{ name, email, phone, share_percentage?, portion_ex_gst?, assigned_runs?, contact_type }]
      if (!jobId) return json({ error: 'jobId required' }, 400)
      if (!contacts || !Array.isArray(contacts) || contacts.length < 2) {
        return json({ error: 'At least 2 contacts required for neighbour splits' }, 400)
      }

      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

      // Get the job to validate it exists
      const { data: job, error: jobErr } = await sb
        .from('jobs')
        .select('id, job_number, pricing_json')
        .eq('id', jobId)
        .single()
      if (jobErr || !job) return json({ error: 'Job not found' }, 404)

      const pricing = typeof job.pricing_json === 'string' ? JSON.parse(job.pricing_json || '{}') : (job.pricing_json || {})
      const totalExGST = pricing.totalExGST || 0

      // Detect per-run method: if any contact has portion_ex_gst, use it directly
      const usePerRunMethod = contacts.some((c: any) => c.portion_ex_gst != null)

      // Clear existing job_contacts for this job (fresh set each time)
      await sb.from('job_contacts').delete().eq('job_id', jobId)

      const results: any[] = []
      const labels = ['A', 'B', 'C', 'D']

      for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i]
        const label = labels[i] || String.fromCharCode(65 + i)
        const contactType = i === 0 ? 'primary' : `neighbour_${label.toLowerCase()}`

        // Per-run method: use portion_ex_gst directly; flat method: calculate from share_percentage
        let portionExGST: number
        let sharePct: number
        if (usePerRunMethod && c.portion_ex_gst != null) {
          portionExGST = Math.round((c.portion_ex_gst as number) * 100) / 100
          sharePct = totalExGST > 0 ? Math.round((portionExGST / totalExGST) * 10000) / 100 : 0
        } else {
          sharePct = c.share_percentage ?? (100 / contacts.length)
          portionExGST = Math.round(totalExGST * (sharePct / 100) * 100) / 100
        }

        // Create job_contact row
        const jcInsert: Record<string, unknown> = {
          job_id: jobId,
          contact_type: contactType,
          contact_label: label,
          client_name: c.name || `Contact ${label}`,
          client_phone: c.phone || null,
          client_email: c.email || null,
          share_percentage: sharePct,
          quote_value_ex_gst: portionExGST,
          is_primary: i === 0,
        }
        // Store assigned runs if provided (per-run method)
        if (c.assigned_runs && Array.isArray(c.assigned_runs) && c.assigned_runs.length > 0) {
          jcInsert.assigned_runs = c.assigned_runs
        }

        // Upsert: try insert, fall back to update if contact already exists
        let jc: any = null
        const { data: existingJc } = await sb.from('job_contacts')
          .select('id').eq('job_id', jobId).eq('contact_label', label).maybeSingle()

        if (existingJc) {
          const { data: updated } = await sb.from('job_contacts')
            .update(jcInsert).eq('id', existingJc.id).select().maybeSingle()
          jc = updated
        } else {
          const { data: inserted, error: jcErr } = await sb.from('job_contacts')
            .insert(jcInsert).select().maybeSingle()
          if (jcErr) {
            console.log(`[ghl-proxy] job_contact insert error for ${label}:`, jcErr)
            continue
          }
          jc = inserted
        }
        if (!jc) continue

        // Get latest version for this doc type
        let version = 1
        const { data: existing } = await sb.from('job_documents')
          .select('version')
          .eq('job_id', jobId)
          .eq('type', 'quote')
          .order('version', { ascending: false })
          .limit(1)
        if (existing && existing.length > 0) {
          version = existing[0].version + 1
        }

        // Create per-contact job_documents row with unique share_token
        const shareToken = crypto.randomUUID()
        const { data: qnData } = await sb.rpc('next_quote_number')
        const quoteNumber = qnData || null

        const safeName = (fileName || 'quote').replace(/[^a-zA-Z0-9._-]/g, '_')
        const path = `00000000-0000-0000-0000-000000000001/${jobId}/quote_v${version}_${label}_${safeName}`

        try { await sb.storage.createBucket('job-pdfs', { public: true }) } catch (_e) { /* exists */ }
        const { data: uploadData } = await sb.storage.from('job-pdfs').createSignedUploadUrl(path)
        const { data: urlData } = sb.storage.from('job-pdfs').getPublicUrl(path)

        const docInsert: Record<string, unknown> = {
          job_id: jobId,
          type: 'quote',
          version,
          pdf_url: urlData?.publicUrl || '',
          share_token: shareToken,
          quote_number: quoteNumber,
          job_contact_id: jc.id,
        }
        if (supportingDocs?.length > 0) {
          docInsert.data_snapshot_json = { supporting_docs: supportingDocs }
        }

        const { data: docRecord, error: docErr } = await sb.from('job_documents')
          .insert(docInsert)
          .select()
          .maybeSingle()

        if (docErr) {
          console.log(`[ghl-proxy] job_documents insert error for ${label}:`, docErr)
        }

        results.push({
          contact_label: label,
          contact_type: contactType,
          contact_id: jc.id,
          client_name: c.name,
          share_percentage: sharePct,
          portion_ex_gst: portionExGST,
          share_token: shareToken,
          document_id: docRecord?.id || null,
          quote_number: quoteNumber,
          upload_url: uploadData?.signedUrl || null,
          public_url: urlData?.publicUrl || '',
        })
      }

      console.log(`[ghl-proxy] Neighbour quotes prepared: job=${jobId}, contacts=${results.length}`)

      return json({
        success: true,
        job_id: jobId,
        contacts: results,
      })
    }

    // ── Job Detail — documents, invoices, events for panel ──
    if (action === 'job_detail') {
      const jobId = params.get('jobId') || params.get('job_id')
      if (!jobId) return json({ error: 'jobId required' }, 400)
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

      const [docsRes, invoicesRes, eventsRes] = await Promise.all([
        sb.from('job_documents')
          .select('id, type, version, status, file_url, share_token, sent_at, viewed_at, accepted_at, declined_at, created_at')
          .eq('job_id', jobId)
          .order('created_at', { ascending: false }),
        sb.from('xero_invoices')
          .select('id, xero_invoice_id, invoice_number, invoice_type, status, reference, sub_total, total, amount_due, amount_paid, invoice_date, due_date, fully_paid_on')
          .eq('job_id', jobId)
          .order('invoice_date', { ascending: false }),
        sb.from('job_events')
          .select('id, event_type, detail_json, created_at')
          .eq('job_id', jobId)
          .order('created_at', { ascending: false })
          .limit(20),
      ])

      return json({
        documents: docsRes.data || [],
        invoices: invoicesRes.data || [],
        events: eventsRes.data || [],
      })
    }

    // ── Sync all GHL opportunities into Supabase jobs table ──
    if (action === 'sync_ghl') {
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

      // GHL stage name → Supabase job status mapping
      const STAGE_MAP: Record<string, string> = {
        // Patio Sales pipeline stages
        'Client Needs To Be Contacted': 'draft',
        'Contacted Waiting on Response': 'draft',
        'Needs Scope / Quote': 'draft',
        'Scope Booked': 'draft',
        'Scope Complete / Quote to be Sent': 'quoted',
        'Quote Sent / Follow up': 'quoted',
        'Job Won / Move to Execution': 'accepted',
        'Nurture / On Hold (Nithin)': 'draft',
        'Outside Service Area (Too Small)': 'cancelled',
        'Job Lost/Archive': 'cancelled',
        'Not Relevant /Archive': 'cancelled',
        // Fencing Sales pipeline stages
        'New Lead (Call + Qualify)': 'draft',
        'New Lead (Replied/ Contacted)': 'draft',
        'Called, No Answer': 'draft',
        'Call Answered (presentation not made)': 'draft',
        'Presentation Made (scope not booked)': 'draft',
        'Needs On Site Scope Urgently': 'draft',
        'Lead Closed (scope booked)': 'draft',
        'Scope Scheduled': 'draft',
        'Scope Complete': 'quoted',
        'Following up Quote Sent (Site visit)': 'quoted',
        'Job Accepted -> Move to Execution': 'accepted',
        'On Hold': 'draft',
        'Stale Lead': 'cancelled',
        'Job Lost': 'cancelled',
        // Fencing Execution pipeline stages
        'Job Accepted Ready for Execution': 'accepted',
        '25% Deposits To Be Received (Shared Fence)': 'deposit',
        '50% Deposit To Be Received': 'deposit',
        'Materials To Be Ordered / Job Scheduled': 'processing',
        'Pending WhatsApp Confirmation From Fencing Team': 'processing',
        'Pending Confirmation Email From Supplier': 'processing',
        'Confirmed Material Order': 'processing',
        'Order to be Picked up': 'processing',
        'Order To be Delivered (Materials TBC on Site)': 'processing',
        'Scheduled / In Progress': 'in_progress',
        'Get Final Payment Both Clients': 'complete',
        'Get Google Review': 'complete',
        'Completed and Archived in Tradify (Get Sign off)': 'complete',
        'Outstanding Payments Backlog': 'invoiced',
        // Patios Execution pipeline stages
        'Ready to Execute': 'accepted',
        'Drafting in progress': 'approvals',
        'DA in Progress': 'approvals',
        'Engineering in progress': 'approvals',
        'CDC in Progress': 'approvals',
        'Council Approval in progress': 'approvals',
        'Finalised Plans and Invoice for Deposit Sent': 'deposit',
        'Deposit Received Materials to be ordered': 'processing',
        'Materials Ordered Job to be Scheduled': 'processing',
        'Scheduled Awaiting Start Date': 'processing',
        'In Progress': 'in_progress',
        'Rectifcation / To be Finished off': 'in_progress',
        'Job complete Needs to be invoiced': 'complete',
        'Invoice Sent waiting on Final Payment': 'invoiced',
        'Job sign off with all documentation': 'complete',
      }

      let totalSynced = 0
      let totalSkipped = 0
      let totalUpdated = 0
      const errors: string[] = []

      // Sync from BOTH sales and execution pipelines
      const allPipelines = {
        ...PIPELINES,
        ...EXECUTION_PIPELINES,
      }

      for (const [pipelineName, pipelineId] of Object.entries(allPipelines)) {
        const jobType = pipelineName.includes('fencing') ? 'fencing' : 'patio'

        // Load stage names for this pipeline
        const stages = await resolveStages(pipelineId)

        // Paginate through all opportunities (GHL returns max 50 per page)
        let hasMore = true
        let pageCount = 0
        const seenIds = new Set<string>()

        while (hasMore && pageCount < 20) { // Safety limit: 20 pages = 1000 opps
          pageCount++
          const searchUrl = `/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_id=${pipelineId}&limit=100&page=${pageCount}`

          const data = await ghl(searchUrl)
          const opps = data.opportunities || []

          if (opps.length === 0) {
            hasMore = false
            break
          }

          // Detect duplicate pages (GHL sometimes loops)
          const newOpps = opps.filter((o: any) => !seenIds.has(o.id))
          if (newOpps.length === 0) {
            hasMore = false
            break
          }
          opps.forEach((o: any) => seenIds.add(o.id))

          for (const opp of opps) {
            const stageName = stages[opp.pipelineStageId] || opp.status || ''
            const mappedStatus = STAGE_MAP[stageName] || 'draft'

            // Extract contact details (including address fields from GHL contact)
            const clientName = opp.contact?.name || opp.name || ''
            const clientEmail = opp.contact?.email || ''
            const clientPhone = opp.contact?.phone || ''
            const contactId = opp.contact?.id || ''
            const siteAddress = opp.contact?.address1 || ''
            const siteSuburb = opp.contact?.city || ''

            // Build pricing data from GHL monetary value (GHL values are GST-inclusive in AU)
            const monetaryValue = opp.monetaryValue || 0
            const pricingJson = monetaryValue > 0
              ? { totalIncGST: monetaryValue, totalExGST: Math.round(monetaryValue / 1.1 * 100) / 100, source: 'ghl' }
              : {}

            // Set timestamps based on mapped status
            const createdAt = opp.createdAt || new Date().toISOString()
            const timestamps: Record<string, string> = {}
            if (mappedStatus === 'quoted' || mappedStatus === 'accepted' || mappedStatus === 'scheduled' ||
                mappedStatus === 'in_progress' || mappedStatus === 'complete' || mappedStatus === 'invoiced') {
              timestamps.quoted_at = createdAt
            }
            if (mappedStatus === 'accepted' || mappedStatus === 'scheduled' ||
                mappedStatus === 'in_progress' || mappedStatus === 'complete' || mappedStatus === 'invoiced') {
              timestamps.accepted_at = createdAt
            }
            if (mappedStatus === 'complete' || mappedStatus === 'invoiced') {
              timestamps.completed_at = createdAt
            }

            // Check if job already exists for this opportunity
            const { data: existing } = await sb
              .from('jobs')
              .select('id, status, client_name, pricing_json, quoted_at')
              .eq('ghl_opportunity_id', opp.id)
              .limit(1)

            if (existing && existing.length > 0) {
              const JOB_STATUS_RANK: Record<string, number> = {
                draft: 0, quoted: 1, accepted: 2, scheduled: 3,
                in_progress: 4, complete: 5, invoiced: 6, cancelled: -1,
              }
              const currentRank = JOB_STATUS_RANK[existing[0].status] ?? 0
              const newRank = JOB_STATUS_RANK[mappedStatus] ?? 0

              const update: Record<string, any> = {}

              // Update status if GHL stage is further along
              if (newRank > currentRank || (mappedStatus === 'cancelled' && existing[0].status === 'draft')) {
                update.status = mappedStatus
              }

              // Update contact name if better
              if (clientName && clientName !== existing[0].client_name && !/^\d/.test(clientName)) {
                update.client_name = clientName
              }

              // Backfill address if we have it from GHL but job doesn't have it
              if (siteAddress) update.site_address = siteAddress
              if (siteSuburb) update.site_suburb = siteSuburb

              // Set pricing if not already set and GHL has a value
              if (monetaryValue > 0 && (!existing[0].pricing_json || !existing[0].pricing_json.totalIncGST)) {
                update.pricing_json = pricingJson
              }

              // Set timestamps if not already set
              if (!existing[0].quoted_at && timestamps.quoted_at) {
                Object.assign(update, timestamps)
              }

              if (Object.keys(update).length > 0) {
                update.updated_at = new Date().toISOString()
                await sb.from('jobs').update(update).eq('id', existing[0].id)
                totalUpdated++
              } else {
                totalSkipped++
              }
            } else {
              // Create new job from GHL opportunity
              const { error: insertErr } = await sb.from('jobs').insert({
                org_id: DEFAULT_ORG_ID,
                status: mappedStatus,
                type: jobType,
                client_name: clientName,
                client_phone: clientPhone,
                client_email: clientEmail,
                site_address: siteAddress || null,
                site_suburb: siteSuburb || null,
                ghl_contact_id: contactId,
                ghl_opportunity_id: opp.id,
                pricing_json: pricingJson,
                notes: `Synced from GHL ${pipelineName} pipeline. Stage: ${stageName}`,
                created_at: createdAt,
                ...timestamps,
              })

              if (insertErr) {
                errors.push(`${clientName}: ${insertErr.message}`)
              } else {
                totalSynced++
              }
            }
          }

          // If we got fewer than 100, we've reached the end
          hasMore = opps.length >= 100
        }
      }

      // Log the sync
      await sb.from('webhook_log').insert({
        org_id: DEFAULT_ORG_ID,
        source: 'ghl',
        event_type: 'sync_opportunities',
        payload: { synced: totalSynced, updated: totalUpdated, skipped: totalSkipped, errors },
        status: 'processed',
      })

      return json({
        success: true,
        created: totalSynced,
        updated: totalUpdated,
        skipped: totalSkipped,
        errors: errors.length > 0 ? errors : undefined,
      })
    }

    // ── Send SMS via GHL conversations API ──
    if (action === 'send_sms' && req.method === 'POST') {
      const body = await req.json()
      const { contactId, message, jobId, userId } = body
      if (!contactId || !message) return json({ error: 'contactId and message required' }, 400)

      try {
        const result = await ghl('/conversations/messages', {
          method: 'POST',
          body: JSON.stringify({
            type: 'SMS',
            contactId,
            message,
          }),
        })
        console.log(`[ghl-proxy] SMS sent to contact ${contactId}`)

        // Log to job_events so Ops timeline + Trade can show sent messages without calling GHL
        if (jobId) {
          try {
            const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
            await sb.from('job_events').insert({
              job_id: jobId,
              user_id: userId || null,
              event_type: 'sms_sent',
              detail_json: {
                contact_id: contactId,
                message: message,
                message_id: result.messageId || result.id || null,
              },
            })
            console.log(`[ghl-proxy] SMS logged to job_events for job ${jobId}`)
          } catch (logErr) {
            console.log('[ghl-proxy] Failed to log SMS to job_events:', logErr)
          }
        }

        return json({ success: true, messageId: result.messageId || result.id })
      } catch (e) {
        console.log('[ghl-proxy] send_sms failed:', e)
        return json({ success: false, error: (e as Error).message })
      }
    }

    // ── Send email via GHL conversations API ──
    if (action === 'send_email' && req.method === 'POST') {
      const body = await req.json()
      const { contactId, subject, htmlBody } = body
      if (!contactId || !subject || !htmlBody) return json({ error: 'contactId, subject, and htmlBody required' }, 400)

      try {
        const result = await ghl('/conversations/messages', {
          method: 'POST',
          body: JSON.stringify({
            type: 'Email',
            contactId,
            subject,
            html: htmlBody,
          }),
        })
        console.log(`[ghl-proxy] Email sent to contact ${contactId}: ${subject}`)
        return json({ success: true, messageId: result.messageId || result.id })
      } catch (e) {
        console.log('[ghl-proxy] send_email failed:', e)
        return json({ success: false, error: (e as Error).message })
      }
    }

    // ── Add note to GHL contact ──
    if (action === 'add_note' && req.method === 'POST') {
      const body = await req.json()
      const { contactId, body: noteBody, jobId } = body
      if (!contactId || !noteBody) return json({ error: 'contactId and body required' }, 400)

      try {
        const result = await ghl(`/contacts/${contactId}/notes`, {
          method: 'POST',
          body: JSON.stringify({ body: noteBody }),
        })
        console.log(`[ghl-proxy] Note added to contact ${contactId}`)

        // Log to job_events if jobId provided
        if (jobId) {
          const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
          await sb.from('job_events').insert({
            job_id: jobId,
            event_type: 'ghl_note_added',
            detail_json: { contact_id: contactId, note_preview: noteBody.slice(0, 200) },
          }).catch(() => {})
        }

        return json({ success: true, noteId: result.id || null })
      } catch (e) {
        console.log('[ghl-proxy] add_note failed:', e)
        return json({ success: false, error: (e as Error).message })
      }
    }

    // ── Initiate outbound call via GHL ──
    // GHL call bridge: rings the user's phone first, then connects to the client
    if (action === 'initiate_call' && req.method === 'POST') {
      const body = await req.json()
      const { contactId, toNumber, userPhone } = body
      if (!contactId || !toNumber) return json({ error: 'contactId and toNumber required' }, 400)

      try {
        // GHL's call endpoint — may be /conversations/calls or /phone/calls
        // Using the conversations/messages endpoint with type CALL as documented
        const result = await ghl('/conversations/messages', {
          method: 'POST',
          body: JSON.stringify({
            type: 'Call',
            contactId,
            phone: toNumber,
          }),
        })
        console.log(`[ghl-proxy] Call initiated to ${toNumber} for contact ${contactId}`)
        return json({ success: true, callId: result.messageId || result.id || null })
      } catch (e) {
        console.log('[ghl-proxy] initiate_call failed:', e)
        // TODO: Try alternative endpoint POST /phone/calls if conversations/messages doesn't support Call type
        // TODO: For true bridge calling, may need GHL's Twilio integration endpoint
        return json({ success: false, error: (e as Error).message })
      }
    }

    // ── List phone numbers for this location ──
    if (action === 'list_phone_numbers') {
      try {
        // Try GHL v2 phone number endpoints
        const data = await ghl(`/locations/${GHL_LOCATION_ID}/customValues`)
        // Also try to get location settings which include phone
        const locData = await ghl(`/locations/${GHL_LOCATION_ID}`)
        return json({ customValues: data, location: locData })
      } catch (e) {
        return json({ error: (e as Error).message })
      }
    }

    // ── Get conversation thread for a contact ──
    if (action === 'get_conversation') {
      const contactId = url.searchParams.get('contactId')
      if (!contactId) return json({ error: 'contactId required' }, 400)

      try {
        // Step 1: Find conversation ID for this contact
        const searchResult = await ghl(`/conversations/search?contactId=${contactId}&locationId=${GHL_LOCATION_ID}`)
        const conversations = searchResult.conversations || []
        if (conversations.length === 0) {
          return json({ messages: [], contactId, conversationId: null })
        }

        const conversationId = conversations[0].id

        // Step 2: Get messages from the conversation (last 30)
        // GHL API v2: GET /conversations/{conversationId}/messages
        const msgResult = await ghl(`/conversations/${conversationId}/messages?limit=30&type=TYPE_SMS,TYPE_EMAIL,TYPE_CALL&sort=desc&sortBy=dateAdded`)
        console.log(`[ghl-proxy] Raw messages response keys: ${Object.keys(msgResult || {}).join(', ')}`)
        // GHL returns { messages: { messages: [...] } } or { messages: [...] } depending on version
        let rawMessages: any[] = []
        if (Array.isArray(msgResult.messages)) {
          rawMessages = msgResult.messages
        } else if (msgResult.messages && Array.isArray(msgResult.messages.messages)) {
          rawMessages = msgResult.messages.messages
        } else if (Array.isArray(msgResult.data)) {
          rawMessages = msgResult.data
        }
        // Also try the lastMessageBody from conversation as fallback info
        const lastMsg = conversations[0].lastMessageBody || conversations[0].lastMessage?.body || ''
        if (rawMessages.length === 0 && lastMsg) {
          console.log(`[ghl-proxy] No messages returned but conversation has lastMessageBody: ${lastMsg.slice(0, 50)}`)
        }

        // Normalise message format
        const messages = rawMessages.map((m: any) => ({
          id: m.id,
          type: (m.messageType || m.type || 'SMS').toUpperCase(),
          direction: m.direction || (m.userId ? 'outbound' : 'inbound'),
          body: m.body || m.message || m.text || '',
          timestamp: m.dateAdded || m.createdAt || m.timestamp || '',
          sender_name: m.userName || m.user?.name || '',
          duration: m.duration || null,
        }))

        // Reverse so messages display oldest-first (chat order) — API returns newest first
        messages.reverse()
        console.log(`[ghl-proxy] Loaded ${messages.length} messages for contact ${contactId}`)
        return json({ messages, contactId, conversationId })
      } catch (e) {
        console.log('[ghl-proxy] get_conversation failed:', e)
        return json({ error: (e as Error).message, messages: [] }, 500)
      }
    }

    // ── Get outbound-only messages for Trade app ──
    if (action === 'get_my_messages') {
      const contactId = url.searchParams.get('contactId')
      if (!contactId) return json({ error: 'contactId required' }, 400)

      try {
        // Same flow as get_conversation
        const searchResult = await ghl(`/conversations/search?contactId=${contactId}&locationId=${GHL_LOCATION_ID}`)
        const conversations = searchResult.conversations || []
        if (conversations.length === 0) {
          return json({ messages: [], contactId, conversationId: null })
        }

        const conversationId = conversations[0].id
        const msgResult = await ghl(`/conversations/${conversationId}/messages?limit=30`)
        const rawMessages = Array.isArray(msgResult.messages) ? msgResult.messages : Array.isArray(msgResult.data) ? msgResult.data : []

        // Filter to outbound only (GHL doesn't support server-side filtering by direction)
        const messages = rawMessages
          .filter((m: any) => m.direction === 'outbound' || m.userId)
          .map((m: any) => ({
            id: m.id,
            type: (m.messageType || m.type || 'SMS').toUpperCase(),
            direction: 'outbound',
            body: m.body || m.message || m.text || '',
            timestamp: m.dateAdded || m.createdAt || m.timestamp || '',
            sender_name: m.userName || m.user?.name || '',
          }))

        console.log(`[ghl-proxy] Loaded ${messages.length} outbound messages for contact ${contactId}`)
        return json({ messages, contactId, conversationId })
      } catch (e) {
        console.log('[ghl-proxy] get_my_messages failed:', e)
        return json({ error: (e as Error).message, messages: [] }, 500)
      }
    }

    // TODO: ghl-proxy?action=initiate_call — future, GHL calling API bridge for routing calls through virtual number

    // ── Increment scope version (called after edits to a completed job) ──
    if (action === 'increment_scope_version' && req.method === 'POST') {
      const body = await req.json()
      const { job_id } = body
      if (!job_id) return json({ error: 'job_id required' }, 400)

      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

      // Get current version
      const { data: job, error: fetchErr } = await sb.from('jobs')
        .select('scope_version')
        .eq('id', job_id)
        .single()

      const currentVersion = (job?.scope_version || 1)
      const newVersion = currentVersion + 1

      // Update version + timestamp
      const { error: updateErr } = await sb.from('jobs')
        .update({ scope_version: newVersion, scope_updated_at: new Date().toISOString() })
        .eq('id', job_id)

      if (updateErr) return json({ error: updateErr.message }, 500)

      // Log job_event
      await sb.from('job_events').insert({
        job_id,
        event_type: 'scope_version_updated',
        detail_json: { from_version: currentVersion, to_version: newVersion },
        created_at: new Date().toISOString()
      })

      return json({ success: true, scope_version: newVersion })
    }

    // ── Assign job number without GHL linkage (walk-up jobs) ──
    if (action === 'assign_job_number' && req.method === 'POST') {
      const body = await req.json()
      const { jobId, toolType } = body
      if (!jobId) return json({ error: 'jobId required' }, 400)

      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

      // Check if job already has a number
      const { data: existing } = await sb.from('jobs').select('job_number').eq('id', jobId).single()
      if (existing?.job_number) {
        return json({ jobNumber: existing.job_number, reused: true })
      }

      // Assign new number
      const jType = toolType === 'fencing' ? 'fencing' : 'patio'
      const { data: jnData } = await sb.rpc('next_job_number', { job_type: jType })
      if (jnData) {
        await sb.from('jobs').update({ job_number: jnData, status: 'quoted' }).eq('id', jobId)
        await sb.from('job_events').insert({ job_id: jobId, event_type: 'status_change', detail_json: { from: 'draft', to: 'quoted', job_number: jnData } })
      }

      return json({ jobNumber: jnData || null })
    }

    return json({ error: 'Unknown action' }, 400)

  } catch (err) {
    console.error('[ghl-proxy] ERROR:', err)
    return json({ error: (err as Error).message || 'Internal error' }, 500)
  }
})
