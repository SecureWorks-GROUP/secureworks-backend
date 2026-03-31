import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SW_API_KEY = Deno.env.get('SW_API_KEY')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
const ADMIN_CHAT_ID = Deno.env.get('ADMIN_TELEGRAM_CHAT_ID') || ''

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization',
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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  // Auth check (same pattern as ops-api)
  const apiKey = req.headers.get('x-api-key') || req.headers.get('authorization')?.replace('Bearer ', '')
  if (!apiKey || (apiKey !== SW_API_KEY && apiKey !== SUPABASE_SERVICE_KEY)) {
    return json({ error: 'Unauthorized' }, 401)
  }

  try {
    const client = sb()
    const checks: Record<string, any> = {}
    const alerts: string[] = []

    // Check 1: Xero data freshness
    const { data: latestInvoice } = await client
      .from('xero_invoices')
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const xeroAge = latestInvoice
      ? Math.round((Date.now() - new Date(latestInvoice.updated_at).getTime()) / 60000)
      : 9999
    checks.xero_sync = {
      status: xeroAge < 60 ? 'ok' : xeroAge < 180 ? 'warning' : 'critical',
      last_sync: latestInvoice?.updated_at || null,
      age_minutes: xeroAge,
    }
    if (xeroAge >= 180) alerts.push(`Xero sync stale: ${xeroAge} minutes since last update`)

    // Check 2: Daily digest last run
    const { data: latestDigest } = await client
      .from('weekly_reports')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const digestAge = latestDigest
      ? Math.round((Date.now() - new Date(latestDigest.created_at).getTime()) / 3600000)
      : 9999
    checks.daily_digest = {
      status: digestAge < 26 ? 'ok' : 'warning',
      last_run: latestDigest?.created_at || null,
      age_hours: digestAge,
    }
    if (digestAge >= 26) alerts.push(`Daily digest not run in ${digestAge} hours`)

    // Check 3: Unresolved old alerts (older than 48h)
    const { count: staleAlerts } = await client
      .from('ai_alerts')
      .select('id', { count: 'exact', head: true })
      .is('dismissed_at', null)
      .lt('created_at', new Date(Date.now() - 48 * 3600000).toISOString())

    checks.stale_alerts = {
      status: (staleAlerts || 0) < 10 ? 'ok' : (staleAlerts || 0) < 30 ? 'warning' : 'critical',
      count: staleAlerts || 0,
    }
    if ((staleAlerts || 0) >= 30) alerts.push(`${staleAlerts} unresolved alerts older than 48 hours`)

    // Check 4: Active annotations count
    const { count: activeAnnotations } = await client
      .from('ai_annotations')
      .select('id', { count: 'exact', head: true })
      .is('resolved_at', null)

    checks.annotations = {
      status: 'ok',
      active_count: activeAnnotations || 0,
    }

    // Check 5: Recent business events (system is generating events)
    const { count: recentEvents } = await client
      .from('business_events')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', new Date(Date.now() - 24 * 3600000).toISOString())

    checks.business_events = {
      status: (recentEvents || 0) > 0 ? 'ok' : 'warning',
      last_24h_count: recentEvents || 0,
    }
    if ((recentEvents || 0) === 0) alerts.push('No business events in the last 24 hours')

    // Determine overall status
    const hasWarning = Object.values(checks).some((c: any) => c.status === 'warning')
    const hasCritical = Object.values(checks).some((c: any) => c.status === 'critical')
    const overallStatus = hasCritical ? 'critical' : hasWarning ? 'degraded' : 'healthy'

    // If degraded or critical, send Telegram alert
    if ((overallStatus === 'degraded' || overallStatus === 'critical') && TELEGRAM_BOT_TOKEN && ADMIN_CHAT_ID) {
      try {
        const alertText = `⚠️ <b>System Health: ${overallStatus.toUpperCase()}</b>\n\n${alerts.join('\n')}`
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: ADMIN_CHAT_ID,
            text: alertText,
            parse_mode: 'HTML',
          }),
        })
      } catch (e) {
        console.log('[system-health] Telegram alert failed:', (e as Error).message)
      }
    }

    return json({
      status: overallStatus,
      checked_at: new Date().toISOString(),
      checks,
      alerts,
    })
  } catch (err) {
    console.error('[system-health] ERROR:', err)
    return json({ error: (err as Error).message || 'Internal error' }, 500)
  }
})
