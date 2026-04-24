// ════════════════════════════════════════════════════════════
// SecureWorks — Follow-up Signal Sync (SecureSale v2 R1)
//
// Ingests rep follow-up activity from `ghl_conversation_cache`
// into `job_events` so the Work Queue's urgency rules see the
// same truth the reps see in MaxLead/GHL.
//
// Fixes the DEV-FOLLOWUP-SIGNAL gap surfaced 2026-04-24 where
// follow-up compliance measured at 0% because outbound SMS sent
// from GHL never wrote to job_events.
//
// Event types emitted (detail_json.source = 'ghl_cache'):
//   sms_sent        — rep outbound TYPE_SMS
//   call_made       — rep outbound TYPE_CALL
//   client_replied  — client inbound TYPE_SMS / TYPE_CALL
//
// Idempotent via detail_json.ghl_message_id dedup per job.
// Deploy: supabase functions deploy followup-signal-sync --no-verify-jwt
// Invoke:  curl -H 'x-api-key: $SW_API_KEY' '.../followup-signal-sync?job_id=<uuid>'
//          omit job_id to sync every cached conversation.
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

function classifyMessage(m: any): { event_type: string; skip: boolean } {
  const type = (m?.type || '').toString()
  const direction = (m?.direction || '').toString()
  if (type === 'TYPE_SMS' && direction === 'outbound') return { event_type: 'sms_sent', skip: false }
  if (type === 'TYPE_SMS' && direction === 'inbound')  return { event_type: 'client_replied', skip: false }
  if (type === 'TYPE_CALL' && direction === 'outbound') return { event_type: 'call_made', skip: false }
  if (type === 'TYPE_CALL' && direction === 'inbound')  return { event_type: 'client_replied', skip: false }
  // ignore TYPE_ACTIVITY_*, TYPE_EMAIL for now (noise / separate domain)
  return { event_type: '', skip: true }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  // Auth — service key or SW_API_KEY
  const validKey = Deno.env.get('SW_API_KEY')
  const xApiKey = req.headers.get('x-api-key')
  const authHeader = req.headers.get('authorization')
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  const ok = (xApiKey && (xApiKey === validKey || xApiKey === SUPABASE_SERVICE_KEY))
          || (bearer && (bearer === validKey || bearer === SUPABASE_SERVICE_KEY))
  if (!ok) return json({ error: 'Unauthorized' }, 401)

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const url = new URL(req.url)
  const filterJobId = url.searchParams.get('job_id')
  const dryRun = url.searchParams.get('dry_run') === '1'

  try {
    // Pull cache rows (scoped to one job if specified)
    let cq = sb.from('ghl_conversation_cache').select('job_id, contact_id, messages, synced_at')
    if (filterJobId) cq = cq.eq('job_id', filterJobId)
    const { data: caches, error: cErr } = await cq
    if (cErr) return json({ error: cErr.message }, 500)

    const jobIds = [...new Set((caches || []).map((c: any) => c.job_id).filter(Boolean))]
    if (jobIds.length === 0) return json({ caches: 0, inserted: 0, skipped: 0, note: 'no cached conversations' })

    // Pre-load existing ghl-sourced job_events per job to dedup
    const { data: existing, error: eErr } = await sb.from('job_events')
      .select('job_id, event_type, detail_json, created_at')
      .in('job_id', jobIds)
    if (eErr) return json({ error: eErr.message }, 500)

    const seenKey = new Set<string>()
    for (const e of (existing || [])) {
      const mid = e.detail_json && typeof e.detail_json === 'object' ? e.detail_json.ghl_message_id : null
      if (mid) seenKey.add(`${e.job_id}|${mid}`)
    }

    const rows: any[] = []
    let skipped = 0
    for (const c of (caches || [])) {
      const msgs = Array.isArray(c.messages) ? c.messages : []
      for (const m of msgs) {
        const { event_type, skip } = classifyMessage(m)
        if (skip) { skipped++; continue }
        const mid = m.id
        if (!mid || seenKey.has(`${c.job_id}|${mid}`)) { skipped++; continue }
        rows.push({
          job_id: c.job_id,
          event_type,
          created_at: m.timestamp || c.synced_at,
          detail_json: {
            source: 'ghl_cache',
            ghl_message_id: mid,
            ghl_contact_id: c.contact_id,
            type: m.type,
            direction: m.direction,
            body_preview: typeof m.body === 'string' ? m.body.slice(0, 140) : null,
          },
        })
        seenKey.add(`${c.job_id}|${mid}`)
      }
    }

    if (dryRun) return json({ caches: caches?.length || 0, would_insert: rows.length, skipped, sample: rows.slice(0, 3) })

    // Insert in batches of 500
    let inserted = 0
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500)
      const { error } = await sb.from('job_events').insert(batch)
      if (error) return json({ error: error.message, inserted_before_error: inserted }, 500)
      inserted += batch.length
    }

    return json({
      caches: caches?.length || 0,
      inserted,
      skipped,
      job_ids_touched: jobIds.length,
      generated_at: new Date().toISOString(),
    })
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
})
