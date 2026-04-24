// ════════════════════════════════════════════════════════════
// SecureWorks — Attribution Backfill (SecureSale v2 R1)
//
// Walks webhook_log for historical GHL Contact events and retroactively
// populates contact_matches.gclid + utm_* when the raw payload contained
// them but the upsert was lost (pre-GCLID-patch behaviour).
//
// Also folds rows where lead_source is still 'unknown'/'unattributed'
// into 'google_ads' when we now have a gclid.
//
// Spec: secureworks-docs/playbooks/gclid-attribution-runbook.md
// Deploy: supabase functions deploy attribution-backfill --no-verify-jwt
// Invoke:  curl -H 'x-api-key: $SW_API_KEY' '.../attribution-backfill'
//          Add ?dry_run=1 to preview without writing.
//          Add ?days=180 to change the lookback (default 90).
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
}

const ATTRIBUTION_KEYS = ['gclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

function extractAttribution(payload: any): Record<string, string> {
  const out: Record<string, string> = {}
  if (!payload || typeof payload !== 'object') return out

  // Shape A: customFields object
  const cfObj = payload.customFields
  if (cfObj && typeof cfObj === 'object' && !Array.isArray(cfObj)) {
    for (const k of ATTRIBUTION_KEYS) if (cfObj[k]) out[k] = String(cfObj[k]).slice(0, 500)
  }
  // Shape B: customField array
  const cfArr = payload.customField || payload.customFieldArray
  if (Array.isArray(cfArr)) {
    for (const item of cfArr) {
      const key = (item?.name || item?.fieldKey || item?.key || '').toLowerCase()
      if (ATTRIBUTION_KEYS.includes(key) && item?.value) out[key] = String(item.value).slice(0, 500)
    }
  }
  // Shape C: top-level
  for (const k of ATTRIBUTION_KEYS) {
    if (!out[k] && payload[k]) out[k] = String(payload[k]).slice(0, 500)
  }
  return out
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const validKey = Deno.env.get('SW_API_KEY')
  const xApiKey = req.headers.get('x-api-key')
  const authHeader = req.headers.get('authorization')
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  const ok = (xApiKey && (xApiKey === validKey || xApiKey === SUPABASE_SERVICE_KEY))
          || (bearer && (bearer === validKey || bearer === SUPABASE_SERVICE_KEY))
  if (!ok) return json({ error: 'Unauthorized' }, 401)

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const url = new URL(req.url)
  const dryRun = url.searchParams.get('dry_run') === '1'
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '90'), 7), 730)
  const since = new Date(Date.now() - days * 86400000).toISOString()

  try {
    // 1. Candidate contact_matches rows — missing gclid
    const { data: candidates, error: cErr } = await sb.from('contact_matches')
      .select('id, ghl_contact_id, gclid, utm_source, utm_medium, utm_campaign, utm_term, utm_content, lead_source, created_at')
      .is('gclid', null)
      .gte('created_at', since)
      .limit(5000)
    if (cErr) return json({ error: cErr.message }, 500)

    if (!candidates || candidates.length === 0) {
      return json({ scanned: 0, updated: 0, note: 'no candidates in window', since, days })
    }

    // 2. Pull webhook_log entries that reference these contact ids (as either body.contactId or body.id)
    const ghlIds = candidates.map((c: any) => c.ghl_contact_id).filter(Boolean)
    const contactIdsIn = ghlIds.length > 0 ? `(${ghlIds.map((id: string) => `"${id.replace(/"/g, '\\"')}"`).join(',')})` : '()'

    // Use two OR filters to catch both payload shapes; fall back to a scan if too large
    const { data: logs, error: lErr } = await sb.from('webhook_log')
      .select('payload, created_at, event_type')
      .eq('source', 'ghl_webhook')
      .gte('created_at', since)
      .in('event_type', ['ContactCreate', 'ContactUpdate', 'InboundMessage', 'OutboundMessage', 'unknown'])
      .limit(20000)
    if (lErr) return json({ error: lErr.message }, 500)

    // 3. Index logs by ghl_contact_id — best-effort on common payload keys
    const byContact: Record<string, any[]> = {}
    for (const row of (logs || [])) {
      const p = row.payload
      if (!p || typeof p !== 'object') continue
      const cid = p.contactId || p.id || (p.contact && p.contact.id) || null
      if (!cid || !ghlIds.includes(cid)) continue
      if (!byContact[cid]) byContact[cid] = []
      byContact[cid].push(p)
    }

    // 4. For each candidate, scan its payloads for attribution
    const updates: any[] = []
    let matched = 0
    for (const c of candidates) {
      const payloads = byContact[c.ghl_contact_id] || []
      if (payloads.length === 0) continue
      const extracted: Record<string, string> = {}
      for (const p of payloads) {
        const e = extractAttribution(p)
        for (const [k, v] of Object.entries(e)) {
          if (!extracted[k] && v) extracted[k] = v
        }
      }
      if (Object.keys(extracted).length === 0) continue
      matched++
      const patch: Record<string, string> = {}
      for (const k of ATTRIBUTION_KEYS) {
        const cur = (c as any)[k]
        if (extracted[k] && !cur) patch[k] = extracted[k]
      }
      if (extracted.gclid && (!c.lead_source || c.lead_source === 'unknown' || c.lead_source === 'unattributed')) {
        patch.lead_source = 'google_ads'
      }
      if (Object.keys(patch).length === 0) continue
      updates.push({ id: c.id, ghl_contact_id: c.ghl_contact_id, patch })
    }

    if (dryRun) {
      return json({
        scanned: candidates.length,
        payloads_indexed: Object.keys(byContact).length,
        matched_with_payload: matched,
        would_update: updates.length,
        sample: updates.slice(0, 3),
        days, since,
      })
    }

    // 5. Apply in small batches
    let updated = 0
    for (const u of updates) {
      const { error } = await sb.from('contact_matches').update(u.patch).eq('id', u.id)
      if (!error) updated++
    }

    // 6. Coverage report for telemetry
    const { count: totalCount } = await sb.from('contact_matches')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since)
    const { count: withSourceCount } = await sb.from('contact_matches')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since)
      .not('lead_source', 'is', null)
      .not('lead_source', 'in', '(unknown,unattributed)')
    const coverage = totalCount && totalCount > 0 ? Math.round((withSourceCount || 0) * 1000 / totalCount) / 10 : 0

    return json({
      scanned: candidates.length,
      payloads_indexed: Object.keys(byContact).length,
      matched_with_payload: matched,
      updated,
      coverage_pct: coverage,
      coverage_note: coverage < 80 ? 'Below 80% — UI should keep `source` hidden per runbook Step 4' : 'Meets ≥80% UI gate',
      days, since,
      generated_at: new Date().toISOString(),
    })
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
})
