// ════════════════════════════════════════════════════════════
// SecureWorks — Google Ads Ingest Edge Function (v2)
//
// POST endpoint receiving daily metrics from a Google Ads Script.
// Handles three data types in a single request:
//   1. rows       → google_ads_daily   (ad group level)
//   2. keywords   → google_ads_keywords
//   3. landing_pages → google_ads_landing_pages
//
// Deploy: supabase functions deploy google-ads-ingest
// Secret: GOOGLE_ADS_INGEST_KEY (shared key for auth)
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const INGEST_KEY = Deno.env.get('GOOGLE_ADS_INGEST_KEY') || ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Verify API key
  const key = req.headers.get('X-API-Key') || req.headers.get('authorization')?.replace('Bearer ', '')
  if (!INGEST_KEY) {
    console.error('GOOGLE_ADS_INGEST_KEY not set — rejecting request')
    return json({ error: 'Server misconfigured — ingest key not set' }, 500)
  }
  if (key !== INGEST_KEY) {
    return json({ error: 'Unauthorized' }, 401)
  }

  try {
    const body = await req.json()
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    const results = { ad_groups: { upserted: 0, errors: 0 }, keywords: { upserted: 0, errors: 0 }, landing_pages: { upserted: 0, errors: 0 } }

    // ── 1. Ad Group rows (google_ads_daily) ─────────────────
    const rows = body.rows || body.data || (Array.isArray(body) ? body : [])
    for (const row of rows) {
      if (!row.date || !row.campaign_id) { results.ad_groups.errors++; continue }

      const costMicros = Math.round((row.cost || 0) * 1_000_000)
      const { error } = await sb.from('google_ads_daily').upsert({
        org_id: DEFAULT_ORG_ID,
        report_date: row.date,
        campaign_id: String(row.campaign_id),
        campaign_name: row.campaign_name || null,
        ad_group_id: row.ad_group_id ? String(row.ad_group_id) : '',
        ad_group_name: row.ad_group_name || null,
        impressions: row.impressions || 0,
        clicks: row.clicks || 0,
        cost_micros: costMicros,
        conversions: row.conversions || 0,
        conversion_value: row.conversion_value || 0,
        interactions: row.interactions || row.clicks || 0,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'org_id,report_date,campaign_id,ad_group_id' })

      if (error) {
        console.error(`Ad group upsert ${row.date}/${row.campaign_id}/${row.ad_group_id}:`, error.message)
        results.ad_groups.errors++
      } else {
        results.ad_groups.upserted++
      }
    }

    // ── 2. Keywords (google_ads_keywords) ───────────────────
    const keywords = body.keywords || []
    for (const kw of keywords) {
      if (!kw.date || !kw.keyword_text) { results.keywords.errors++; continue }

      const costMicros = Math.round((kw.cost || 0) * 1_000_000)
      const { error } = await sb.from('google_ads_keywords').upsert({
        org_id: DEFAULT_ORG_ID,
        report_date: kw.date,
        campaign_id: String(kw.campaign_id || ''),
        campaign_name: kw.campaign_name || null,
        ad_group_id: String(kw.ad_group_id || ''),
        ad_group_name: kw.ad_group_name || null,
        keyword_text: kw.keyword_text,
        match_type: kw.match_type || null,
        impressions: kw.impressions || 0,
        clicks: kw.clicks || 0,
        cost_micros: costMicros,
        conversions: kw.conversions || 0,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'org_id,report_date,campaign_id,ad_group_id,keyword_text,match_type' })

      if (error) {
        console.error(`Keyword upsert ${kw.date}/${kw.keyword_text}:`, error.message)
        results.keywords.errors++
      } else {
        results.keywords.upserted++
      }
    }

    // ── 3. Landing Pages (google_ads_landing_pages) ─────────
    const landingPages = body.landing_pages || []
    for (const lp of landingPages) {
      if (!lp.date || !lp.landing_page_url) { results.landing_pages.errors++; continue }

      const costMicros = Math.round((lp.cost || 0) * 1_000_000)
      const { error } = await sb.from('google_ads_landing_pages').upsert({
        org_id: DEFAULT_ORG_ID,
        report_date: lp.date,
        campaign_id: String(lp.campaign_id || ''),
        landing_page_url: lp.landing_page_url,
        impressions: lp.impressions || 0,
        clicks: lp.clicks || 0,
        cost_micros: costMicros,
        conversions: lp.conversions || 0,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'org_id,report_date,landing_page_url' })

      if (error) {
        console.error(`Landing page upsert ${lp.date}/${lp.landing_page_url}:`, error.message)
        results.landing_pages.errors++
      } else {
        results.landing_pages.upserted++
      }
    }

    // Log ingestion
    const totalRows = rows.length + keywords.length + landingPages.length
    const totalErrors = results.ad_groups.errors + results.keywords.errors + results.landing_pages.errors
    await sb.from('webhook_log').insert({
      org_id: DEFAULT_ORG_ID,
      source: 'google_ads',
      event_type: 'daily_ingest',
      payload: { rows_received: totalRows, results },
      status: totalErrors === totalRows ? 'failed' : 'processed',
    })

    return json({ success: true, results, total: totalRows })
  } catch (err) {
    console.error('Google Ads ingest error:', err)
    return json({ error: err.message }, 500)
  }
})
