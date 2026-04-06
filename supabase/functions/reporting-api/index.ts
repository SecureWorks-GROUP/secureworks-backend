// ════════════════════════════════════════════════════════════
// SecureWorks — Reporting API Edge Function
//
// Aggregated reporting endpoints for the dashboard.
// Called by the dashboard frontend (auth required).
//
// Deploy: supabase functions deploy reporting-api
//
// Actions (via ?action= query param):
//   dashboard_summary   — Revenue, profit, margins, receivables for Reports tab
//   job_profitability   — Per-job P&L for Job P&L tab
//   marketing_summary   — Google Ads + attribution for Marketing tab
//   trends              — 12-month revenue/margin/win-rate trends
//   sales_breakdown     — Revenue by job type, suburb, pipeline velocity
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

// Test data filter — exclude test records from production outputs
const isTestRecord = (name: string | null | undefined): boolean =>
  !name ? false : /\btest\b/i.test(name) || /^marnin test/i.test(name)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
}

// Helper to fetch all rows from a table (Supabase limits to 1000 per request)
async function fetchAll(sb: any, table: string, select: string, filters: Record<string, any> = {}) {
  const PAGE_SIZE = 1000
  let all: any[] = []
  let offset = 0
  while (true) {
    let query = sb.from(table).select(select).range(offset, offset + PAGE_SIZE - 1)
    for (const [key, val] of Object.entries(filters)) {
      if (key === '_in') {
        for (const [col, vals] of Object.entries(val as Record<string, string[]>)) {
          query = query.in(col, vals)
        }
      } else if (key === '_gte') {
        for (const [col, v] of Object.entries(val as Record<string, string>)) {
          query = query.gte(col, v)
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

// Helper: get P&L totals from pl_by_tracking reports for a date range.
// Returns a map of "YYYY-MM-DD" (first-of-month) → { revenue, costs, gross_profit }
// sourced from the "Total" key in each monthly tracking P&L report.
async function getPLTotals(sb: any, fromDate: string, toDate?: string) {
  let query = sb
    .from('xero_reports')
    .select('period_start, report_date, report_json')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('report_type', 'pl_by_tracking')
    .gte('period_start', fromDate)
    .order('period_start', { ascending: true })

  if (toDate) query = query.lte('period_start', toDate)

  const { data, error } = await query
  if (error) throw error

  const result: Record<string, { revenue: number; costs: number; gross_profit: number }> = {}
  for (const row of (data || [])) {
    const total = row.report_json?.data?.Total
    if (!total) continue
    // Normalise period_start to first-of-month key
    const monthKey = row.period_start?.slice(0, 10) || row.report_date?.slice(0, 10)
    if (monthKey) {
      result[monthKey] = {
        revenue: total.revenue || 0,
        costs: total.costs || 0,
        gross_profit: total.gross_profit || 0,
      }
    }
  }
  return result
}

// Get P&L for a specific division from tracking category reports
async function getPLByDivision(
  sb: any, fromDate: string, division: string,
  divTrackingKeys: Record<string, string>
) {
  const trackingKey = divTrackingKeys[division]
  // For 'other': sum everything except patios/fencing/decking
  const knownKeys = ['SW - PATIOS', 'SW - FENCING', 'SW - DECKING']

  const { data, error } = await sb
    .from('xero_reports')
    .select('period_start, report_date, report_json')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('report_type', 'pl_by_tracking')
    .gte('period_start', fromDate)
    .order('period_start', { ascending: true })

  if (error) throw error

  const result: Record<string, { revenue: number; costs: number; gross_profit: number }> = {}
  for (const row of (data || [])) {
    const allData = row.report_json?.data
    if (!allData) continue
    const monthKey = row.period_start?.slice(0, 10) || row.report_date?.slice(0, 10)
    if (!monthKey) continue

    if (trackingKey && allData[trackingKey]) {
      // Specific division: extract its tracking category
      const vals = allData[trackingKey]
      result[monthKey] = {
        revenue: vals.revenue || 0,
        costs: vals.costs || 0,
        gross_profit: vals.gross_profit || 0,
      }
    } else if (division === 'other') {
      // Other: sum everything not in known divisions
      let rev = 0, cost = 0, gp = 0
      for (const [unit, vals] of Object.entries(allData as Record<string, any>)) {
        if (unit === 'Total' || knownKeys.includes(unit)) continue
        rev += vals.revenue || 0
        cost += vals.costs || 0
        gp += vals.gross_profit || 0
      }
      result[monthKey] = { revenue: rev, costs: cost, gross_profit: gp }
    }
  }
  return result
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

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
    isAuthed = true
  } else if (bearerToken && (bearerToken === validKey || bearerToken === serviceKey)) {
    isAuthed = true
  } else if (bearerToken) {
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

  const url = new URL(req.url)
  const action = url.searchParams.get('action') || ''

  // Use service role client for data queries (RLS views need it)
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)


  try {
    switch (action) {
      case 'dashboard_summary':
        return json(await dashboardSummary(sb))
      case 'job_profitability':
        return json(await jobProfitability(sb, url.searchParams))
      case 'marketing_summary':
        return json(await marketingSummary(sb))
      case 'trends':
        return json(await trends(sb, url.searchParams.get('division') || undefined))
      case 'sales_breakdown':
        return json(await salesBreakdown(sb))
      case 'insights':
        return json(await generateInsights(sb))
      case 'match_invoices':
        return json(await matchInvoicesToJobs(sb))
      case 'debt_followup':
        return json(await debtFollowup(sb, url.searchParams.get('search') || undefined))
      case 'ceo_report':
        return json(await ceoReport(sb))
      case 'sales_summary':
        return json(await salesSummaryAction(sb, url.searchParams))
      case 'sales_pipeline':
        return json(await salesPipelineAction(sb, url.searchParams))
      case 'sales_performance':
        return json(await salesPerformanceAction(sb, url.searchParams))
      case 'sales_leads':
        return json(await salesLeadsAction(sb, url.searchParams))
      case 'team_activity': {
        const since = url.searchParams.get('since') || new Date(Date.now() - 24 * 3600000).toISOString()
        const { data: events } = await sb.from('job_events')
          .select('id, job_id, event_type, detail_json, created_at, users:user_id(name)')
          .eq('org_id', DEFAULT_ORG_ID)
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(50)
        const jobIds = [...new Set((events || []).map((e: any) => e.job_id).filter(Boolean))]
        let jobNames: Record<string, string> = {}
        if (jobIds.length > 0) {
          const { data: jobs } = await sb.from('jobs').select('id, client_name, job_number').in('id', jobIds.slice(0, 100))
          for (const j of (jobs || [])) jobNames[j.id] = `${j.job_number} (${j.client_name})`
        }
        return json({
          events: (events || []).map((e: any) => ({
            type: e.event_type, job: jobNames[e.job_id] || e.job_id,
            who: e.users?.name || 'System', when: e.created_at,
            detail: typeof e.detail_json === 'string' ? e.detail_json.slice(0, 200) : JSON.stringify(e.detail_json || {}).slice(0, 200),
          })),
          total: (events || []).length,
          period: `Since ${since}`,
        })
      }
      case 'sales_alerts':
        return json(await salesAlertsAction(sb, url.searchParams))
      case 'sales_snooze': {
        if (req.method !== 'POST') return json({ error: 'POST required' }, 405)
        const body = await req.json()
        return json(await salesSnoozeAction(sb, body))
      }
      case 'sales_quick_action': {
        if (req.method !== 'POST') return json({ error: 'POST required' }, 405)
        const body = await req.json()
        return json(await salesQuickAction(sb, body))
      }
      case 'reconcile_transaction': {
        if (req.method !== 'POST') return json({ error: 'POST required' }, 405)
        const body = await req.json()
        const { transaction_id, job_id, cost_centre, status } = body
        if (!transaction_id) return json({ error: 'transaction_id required' }, 400)

        // Record the reconciliation as a business event
        const { error: evtErr } = await sb.from('business_events').insert({
          event_type: 'transaction.reconciled',
          source: 'reporting-api/reconcile_transaction',
          entity_type: 'transaction',
          entity_id: transaction_id,
          payload: {
            transaction_id,
            job_id: job_id || null,
            cost_centre: cost_centre || null,
            status: status || 'reconciled',
            reconciled_at: new Date().toISOString(),
          },
        })
        if (evtErr) return json({ error: 'Failed to record reconciliation: ' + evtErr.message }, 500)

        return json({ success: true, transaction_id, status: status || 'reconciled' })
      }
      case 'cash_waterfall':
        return json(await cashWaterfall(sb))
      default:
        return json({ error: 'Unknown action. Use: dashboard_summary, job_profitability, marketing_summary, trends, sales_breakdown, insights, debt_followup, ceo_report, sales_summary, sales_pipeline, sales_performance, sales_leads, sales_alerts, sales_snooze, sales_quick_action, reconcile_transaction, cash_waterfall' }, 400)
    }
  } catch (err) {
    console.error(`reporting-api [${action}] error:`, err)
    return json({ error: (err as Error).message || String(err) }, 500)
  }
})


// ════════════════════════════════════════════════════════════
// DASHBOARD SUMMARY — Reports Tab
// ════════════════════════════════════════════════════════════

async function dashboardSummary(sb: any) {
  const now = new Date()
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0]

  // ── Revenue MTD from P&L tracking reports (accurate, unlike broken invoice sync) ──
  const plTotals = await getPLTotals(sb, prevMonthStart, currentMonthStart)

  let revenueMtd = plTotals[currentMonthStart]?.revenue || 0
  let costsMtd = plTotals[currentMonthStart]?.costs || 0
  let grossProfit = plTotals[currentMonthStart]?.gross_profit || 0
  let displayMonth = currentMonthStart
  let isFallback = false

  // If current month has no revenue (start of month), fall back to previous month
  if (revenueMtd === 0 && plTotals[prevMonthStart]?.revenue > 0) {
    revenueMtd = plTotals[prevMonthStart].revenue
    costsMtd = plTotals[prevMonthStart].costs
    grossProfit = plTotals[prevMonthStart].gross_profit
    displayMonth = prevMonthStart
    isFallback = true
  }

  const marginPct = revenueMtd > 0 ? Math.round((grossProfit / revenueMtd) * 100) : 0

  // ── Same month last year (YoY comparison) from P&L reports ──
  const displayDate = new Date(displayMonth + 'T00:00:00')
  const sameMonthLastYear = new Date(displayDate.getFullYear() - 1, displayDate.getMonth(), 1).toISOString().split('T')[0]
  const yoyPL = await getPLTotals(sb, sameMonthLastYear, sameMonthLastYear)
  const yoyRevenue = yoyPL[sameMonthLastYear]?.revenue || 0
  const yoyChangePct = yoyRevenue > 0 ? Math.round(((revenueMtd - yoyRevenue) / yoyRevenue) * 100) : null

  // ── Outstanding Receivables ──
  const { data: receivables } = await sb
    .from('aged_receivables')
    .select('*')
    .eq('org_id', DEFAULT_ORG_ID)

  const totalOutstanding = (receivables || []).reduce(
    (sum: number, r: any) => sum + (parseFloat(r.amount_due) || 0), 0
  )

  // ── Revenue vs Costs (last 12 months) from P&L reports ──
  const twelveMonthsAgoChart = new Date(now.getFullYear(), now.getMonth() - 11, 1).toISOString().split('T')[0]
  const chartPL = await getPLTotals(sb, twelveMonthsAgoChart, currentMonthStart)

  const months: string[] = []
  const revenueData: number[] = []
  const costsData: number[] = []

  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const monthKey = d.toISOString().split('T')[0]
    const label = d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' })
    months.push(label)
    revenueData.push(chartPL[monthKey]?.revenue || 0)
    costsData.push(chartPL[monthKey]?.costs || 0)
  }

  // ── P&L Summary (from Xero reports) ──
  const { data: plReports } = await sb
    .from('xero_reports')
    .select('report_type, report_date, period_start, period_end, report_json')
    .eq('org_id', DEFAULT_ORG_ID)
    .in('report_type', ['profit_and_loss', 'profit_and_loss_ytd'])
    .order('report_date', { ascending: false })
    .limit(5)

  // ── Aged Receivables grouped by bucket ──
  const buckets: Record<string, { count: number; total: number; items: any[] }> = {
    current: { count: 0, total: 0, items: [] },
    '1-30': { count: 0, total: 0, items: [] },
    '31-60': { count: 0, total: 0, items: [] },
    '61-90': { count: 0, total: 0, items: [] },
    '90+': { count: 0, total: 0, items: [] },
  }

  for (const r of (receivables || [])) {
    const bucket = r.age_bucket || 'current'
    if (buckets[bucket]) {
      buckets[bucket].count++
      buckets[bucket].total += parseFloat(r.amount_due) || 0
      buckets[bucket].items.push({
        contact: r.contact_name,
        invoice: r.invoice_number,
        amount: r.amount_due,
        due_date: r.due_date,
        reference: r.reference || null,
        job_type: r.job_type || null,
      })
    }
  }

  // ── Weighted Pipeline Forecast ──
  const pipelineJobs = await fetchAll(sb, 'jobs',
    'id, status, type, pricing_json, created_at, quoted_at, accepted_at',
    { org_id: DEFAULT_ORG_ID, legacy: false, _in: { status: ['quoted', 'accepted', 'scheduled', 'in_progress'] } }
  )

  // Stage probabilities based on typical trades conversion
  const stageProb: Record<string, number> = {
    quoted: 0.30,
    accepted: 0.70,
    scheduled: 0.90,
    in_progress: 0.95,
  }

  // Expected days to revenue from each stage
  const stageDays: Record<string, number> = {
    quoted: 45,      // ~14d to accept + ~14d to schedule + ~14d to complete + invoice
    accepted: 30,    // ~14d to schedule + ~14d to complete + invoice
    scheduled: 14,   // ~14d to complete + invoice
    in_progress: 7,  // ~7d to complete + invoice
  }

  let rawPipeline = 0
  let weightedPipeline = 0
  const forecast30 = { raw: 0, weighted: 0, jobs: 0 }
  const forecast60 = { raw: 0, weighted: 0, jobs: 0 }
  const forecast90 = { raw: 0, weighted: 0, jobs: 0 }

  for (const job of pipelineJobs) {
    const val = parseFloat(job.pricing_json?.totalExGST || job.pricing_json?.totalIncGST || 0)
    if (val <= 0) continue

    const prob = stageProb[job.status] || 0.5
    const expectedDays = stageDays[job.status] || 30
    const weighted = val * prob

    rawPipeline += val
    weightedPipeline += weighted

    if (expectedDays <= 30) { forecast30.raw += val; forecast30.weighted += weighted; forecast30.jobs++ }
    if (expectedDays <= 60) { forecast60.raw += val; forecast60.weighted += weighted; forecast60.jobs++ }
    if (expectedDays <= 90) { forecast90.raw += val; forecast90.weighted += weighted; forecast90.jobs++ }
  }

  // Count jobs per pipeline stage
  const stageCounts: Record<string, number> = {}
  for (const job of pipelineJobs) {
    stageCounts[job.status] = (stageCounts[job.status] || 0) + 1
  }

  // Pipeline by division — group pipeline jobs by type for division filtering
  const pipelineByDivision: Record<string, { raw: number; weighted: number; jobs: number }> = {}
  for (const job of pipelineJobs) {
    const val = parseFloat(job.pricing_json?.totalExGST || job.pricing_json?.totalIncGST || 0)
    if (val <= 0) continue
    const t = (job.type || 'other').toLowerCase()
    // Map to division: combo → patios
    const div = t === 'patio' || t === 'combo' ? 'patios'
      : t === 'fencing' ? 'fencing'
      : t === 'decking' ? 'decking'
      : 'other'
    if (!pipelineByDivision[div]) pipelineByDivision[div] = { raw: 0, weighted: 0, jobs: 0 }
    const prob = stageProb[job.status] || 0.5
    pipelineByDivision[div].raw += val
    pipelineByDivision[div].weighted += val * prob
    pipelineByDivision[div].jobs++
  }

  // Avg cycle time from recently completed jobs (last 6 months)
  const sixMonthsAgoDS = new Date(now.getTime() - 180 * 86400000).toISOString().split('T')[0]
  const { data: completedJobs } = await sb
    .from('jobs')
    .select('created_at, completed_at')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('legacy', false)
    .in('status', ['complete', 'invoiced'])
    .gte('completed_at', sixMonthsAgoDS)
    .not('created_at', 'is', null)
    .not('completed_at', 'is', null)
    .limit(200)

  let avgCycleDays: number | null = null
  if (completedJobs && completedJobs.length >= 3) {
    const cycles = completedJobs
      .map((j: any) => (new Date(j.completed_at).getTime() - new Date(j.created_at).getTime()) / 86400000)
      .filter((d: number) => d > 0 && d < 365)
    if (cycles.length >= 3) {
      avgCycleDays = Math.round(cycles.reduce((s: number, d: number) => s + d, 0) / cycles.length)
    }
  }

  // Pipeline coverage ratio
  const prevMonthRev = revenueData.length >= 2 ? revenueData[revenueData.length - 2] : revenueMtd
  const monthlyTarget = prevMonthRev > 0 ? prevMonthRev : revenueMtd
  const pipelineCoverage = monthlyTarget > 0 ? parseFloat((rawPipeline / monthlyTarget).toFixed(1)) : 0

  // ── Break-even ──
  const { data: fixedCostsConfig } = await sb
    .from('org_config')
    .select('config_value')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('config_key', 'monthly_fixed_costs')
    .maybeSingle()

  const fixedCosts = fixedCostsConfig?.config_value?.amount || 0
  let breakEvenJobs = null
  if (fixedCosts > 0 && revenueMtd > 0) {
    const avgMargin = marginPct / 100
    const { count: completedCount } = await sb
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', DEFAULT_ORG_ID)
      .eq('legacy', false)
      .in('status', ['complete', 'invoiced'])
      .gte('completed_at', currentMonthStart)

    const avgJobRevenue = completedCount && completedCount > 0 ? revenueMtd / completedCount : 0
    const avgJobProfit = avgJobRevenue * avgMargin
    if (avgJobProfit > 0) {
      breakEvenJobs = Math.ceil(fixedCosts / avgJobProfit)
    }
  }

  // ── Revenue by service type from tracking categories ──
  // Get the tracking P&L for the display month
  const trackingDate = new Date(displayMonth + 'T00:00:00')
  const displayMonthEnd = new Date(trackingDate.getFullYear(), trackingDate.getMonth() + 1, 0)
    .toISOString().split('T')[0]

  const { data: trackingPL } = await sb
    .from('xero_reports')
    .select('report_json')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('report_type', 'pl_by_tracking')
    .eq('report_date', displayMonthEnd)
    .maybeSingle()

  // Parse tracking data into revenue_by_type
  const revenueByType: Record<string, { revenue: number; costs: number; gross_profit: number }> = {}
  if (trackingPL?.report_json?.data) {
    for (const [unit, vals] of Object.entries(trackingPL.report_json.data as Record<string, any>)) {
      if (unit === 'Total' || unit === 'Unassigned' || unit.includes('GROUP')) continue
      // Clean up tracking category names: "SW - FENCING" → "Fencing"
      const cleanName = unit.replace(/^SW\s*-\s*/i, '').toLowerCase()
        .replace(/\b\w/g, (l: string) => l.toUpperCase())
      revenueByType[cleanName] = {
        revenue: vals.revenue || 0,
        costs: vals.costs || 0,
        gross_profit: vals.gross_profit || 0,
      }
    }
  }

  // Also build 12-month revenue by type for stacked chart
  const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1)
  const { data: allTrackingPL } = await sb
    .from('xero_reports')
    .select('report_date, period_start, report_json')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('report_type', 'pl_by_tracking')
    .gte('period_start', twelveMonthsAgo.toISOString().split('T')[0])
    .order('period_start', { ascending: true })

  // Build stacked chart data: { months: [...], fencing: [...], patios: [...], ... }
  const stackedChart: Record<string, number[]> = { fencing: [], patios: [], renovations: [], insurance_work: [], other: [] }
  const stackedMonths: string[] = []

  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0).toISOString().split('T')[0]
    const label = d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' })
    stackedMonths.push(label)

    const monthReport = (allTrackingPL || []).find((r: any) => r.report_date === monthEnd)
    const data = monthReport?.report_json?.data || {}

    stackedChart.fencing.push(data['SW - FENCING']?.revenue || 0)
    stackedChart.patios.push(data['SW - PATIOS']?.revenue || 0)
    stackedChart.renovations.push(data['SW - RENOVATIONS']?.revenue || 0)
    stackedChart.insurance_work.push(data['SW - INSURANCE WORK']?.revenue || 0)
    stackedChart.other.push(data['Unassigned']?.revenue || 0)
  }

  return {
    stats: {
      revenue_mtd: revenueMtd,
      gross_profit_mtd: grossProfit,
      margin_pct: marginPct,
      outstanding_receivables: totalOutstanding,
      yoy_revenue: yoyRevenue,
      yoy_change_pct: yoyChangePct,
      display_month: displayMonth,
      is_fallback: isFallback,
      // DSO: Days Sales Outstanding (how fast we collect)
      dso: (() => {
        const last3rev = revenueData.slice(-3).reduce((s, v) => s + v, 0)
        const dailyRev = last3rev / 90
        return dailyRev > 0 ? Math.round(totalOutstanding / dailyRev) : null
      })(),
    },
    chart: {
      months,
      revenue: revenueData,
      costs: costsData,
    },
    revenue_by_type: revenueByType,
    stacked_revenue: {
      months: stackedMonths,
      ...stackedChart,
    },
    pl_reports: plReports || [],
    aged_receivables: buckets,
    overdue_total: (buckets['1-30'].total + buckets['31-60'].total + buckets['61-90'].total + buckets['90+'].total),
    overdue_count: (buckets['1-30'].count + buckets['31-60'].count + buckets['61-90'].count + buckets['90+'].count),
    pipeline_forecast: {
      raw_pipeline: rawPipeline,
      weighted_pipeline: weightedPipeline,
      coverage: pipelineCoverage,
      forecast_30: forecast30,
      forecast_60: forecast60,
      forecast_90: forecast90,
      monthly_target: monthlyTarget,
      stage_probabilities: stageProb,
      stage_counts: stageCounts,
      avg_cycle_days: avgCycleDays,
      pipeline_by_division: pipelineByDivision,
    },
    break_even: fixedCosts > 0 ? {
      monthly_fixed_costs: fixedCosts,
      jobs_needed: breakEvenJobs,
    } : null,
    targets: await getTargets(sb),
  }
}

// Fetch all CEO targets from org_config
async function getTargets(sb: any) {
  const keys = [
    'monthly_revenue_target', 'margin_target_pct', 'monthly_jobs_target',
    'monthly_marketing_budget', 'pipeline_coverage_target',
    'dso_target', 'cycle_time_target', 'cost_to_revenue_target',
    'concentration_risk_threshold', 'win_rate_target',
  ]
  const { data } = await sb
    .from('org_config')
    .select('config_key, config_value')
    .eq('org_id', DEFAULT_ORG_ID)
    .in('config_key', keys)

  const targets: Record<string, number> = {}
  for (const row of (data || [])) {
    const key = row.config_key.replace('monthly_', '').replace('_target', '').replace('_pct', '').replace('_threshold', '')
    targets[key] = row.config_value?.amount || 0
  }
  return targets
}


// ════════════════════════════════════════════════════════════
// JOB PROFITABILITY — Job P&L Tab
// ════════════════════════════════════════════════════════════

async function jobProfitability(sb: any, params: URLSearchParams) {
  const dateFrom = params.get('from') || null
  const dateTo = params.get('to') || null
  const jobType = params.get('type') || null
  const status = params.get('status') || null
  const limit = Math.min(parseInt(params.get('limit') || '50', 10) || 50, 5000)

  // Get jobs with pricing
  let query = sb
    .from('jobs')
    .select('id, type, status, client_name, site_suburb, pricing_json, created_at, job_number')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('legacy', false)
    .order('created_at', { ascending: false })

  if (jobType) query = query.eq('type', jobType)
  if (status) query = query.eq('status', status)
  if (dateFrom) query = query.gte('created_at', dateFrom)
  if (dateTo) query = query.lte('created_at', dateTo)
  query = query.limit(limit)

  const { data: jobs, error: jobErr } = await query
  if (jobErr) throw jobErr

  // Get all invoices linked to these jobs
  const jobIds = (jobs || []).map((j: any) => j.id)
  let invoicesByJob: Record<string, any[]> = {}

  if (jobIds.length > 0) {
    const { data: invoices } = await sb
      .from('xero_invoices')
      .select('job_id, invoice_type, sub_total, total, amount_paid')
      .eq('org_id', DEFAULT_ORG_ID)
      .in('job_id', jobIds)

    for (const inv of (invoices || [])) {
      if (!invoicesByJob[inv.job_id]) invoicesByJob[inv.job_id] = []
      invoicesByJob[inv.job_id].push(inv)
    }
  }

  // ── Xero Projects data — per-job revenue + expenses (most accurate source) ──
  const { data: xeroProjects } = await sb
    .from('xero_projects')
    .select('job_id, project_name, job_number, total_invoiced, total_expenses, total_to_be_invoiced, status')
    .eq('org_id', DEFAULT_ORG_ID)
    .not('job_id', 'is', null)

  // Build lookup: job_id → xero project financials
  const projectByJob: Record<string, any> = {}
  for (const proj of (xeroProjects || [])) {
    if (proj.job_id) {
      // If multiple projects map to same job, sum them
      if (projectByJob[proj.job_id]) {
        projectByJob[proj.job_id].total_invoiced += parseFloat(proj.total_invoiced) || 0
        projectByJob[proj.job_id].total_expenses += parseFloat(proj.total_expenses) || 0
      } else {
        projectByJob[proj.job_id] = {
          project_name: proj.project_name,
          job_number: proj.job_number,
          total_invoiced: parseFloat(proj.total_invoiced) || 0,
          total_expenses: parseFloat(proj.total_expenses) || 0,
          to_be_invoiced: parseFloat(proj.total_to_be_invoiced) || 0,
          project_status: proj.status,
        }
      }
    }
  }

  // Build profitability rows — prefer Xero Projects data, fall back to invoice matching
  const rows = (jobs || []).map((job: any) => {
    const quoteValue = job.pricing_json?.totalExGST || job.pricing_json?.totalIncGST || 0
    const jobInvoices = invoicesByJob[job.id] || []
    const xeroProject = projectByJob[job.id] || null

    // Revenue: prefer Xero Projects invoiced amount, fall back to ACCREC invoices
    const invoiced = xeroProject
      ? xeroProject.total_invoiced
      : jobInvoices.filter((i: any) => i.invoice_type === 'ACCREC')
          .reduce((s: number, i: any) => s + (parseFloat(i.sub_total) || 0), 0)

    // Costs: prefer Xero Projects expenses (includes ALL costs logged to project),
    // fall back to ACCPAY invoices matched by contact
    const bills = xeroProject
      ? xeroProject.total_expenses
      : jobInvoices.filter((i: any) => i.invoice_type === 'ACCPAY')
          .reduce((s: number, i: any) => s + (parseFloat(i.sub_total) || 0), 0)

    const margin = invoiced - bills
    const marginPct = invoiced > 0 ? Math.round((margin / invoiced) * 100) : 0

    return {
      id: job.id,
      job_number: job.job_number || xeroProject?.job_number || null,
      client_name: job.client_name,
      type: job.type,
      status: job.status,
      quote_value: quoteValue,
      invoiced,
      bills,
      margin,
      margin_pct: marginPct,
      data_source: xeroProject ? 'xero_projects' : (jobInvoices.length > 0 ? 'invoice_match' : 'none'),
    }
  })

  // Summary stats
  const totalInvoiced = rows.reduce((s: number, r: any) => s + r.invoiced, 0)
  const totalBills = rows.reduce((s: number, r: any) => s + r.bills, 0)
  const avgMargin = totalInvoiced > 0 ? Math.round(((totalInvoiced - totalBills) / totalInvoiced) * 100) : 0

  // Data source breakdown
  const dataSourceCounts = rows.reduce((acc: Record<string, number>, r: any) => {
    acc[r.data_source] = (acc[r.data_source] || 0) + 1
    return acc
  }, {})

  return {
    jobs: rows,
    summary: {
      total_jobs: rows.length,
      total_invoiced: totalInvoiced,
      total_bills: totalBills,
      total_margin: totalInvoiced - totalBills,
      avg_margin_pct: avgMargin,
      data_sources: dataSourceCounts,
      xero_projects_matched: (xeroProjects || []).length,
    },
  }
}


// ════════════════════════════════════════════════════════════
// MARKETING SUMMARY — Marketing Tab
// ════════════════════════════════════════════════════════════

async function marketingSummary(sb: any) {
  const now = new Date()
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86400000).toISOString().split('T')[0]

  // Get all daily data for the last 12 months (dashboard will filter by selected period)
  const oneYearAgo = new Date(now.getTime() - 365 * 86400000).toISOString().split('T')[0]
  const { data: allDaily } = await sb
    .from('google_ads_daily')
    .select('report_date, campaign_id, campaign_name, impressions, clicks, cost_micros, conversions, conversion_value')
    .eq('org_id', DEFAULT_ORG_ID)
    .gte('report_date', oneYearAgo)
    .order('report_date', { ascending: true })

  // Filter for 90-day stats
  const adsRolling = (allDaily || []).filter((r: any) => r.report_date >= ninetyDaysAgo)

  // Current month campaigns for the table view
  const { data: adsMonthly } = await sb
    .from('google_ads_monthly')
    .select('*')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('month', currentMonthStart)

  // Stats use rolling 90-day for better signal (trades have long sales cycles)
  const totalSpend90 = (adsRolling || []).reduce((s: number, r: any) => s + (Number(r.cost_micros) || 0), 0) / 1_000_000
  const totalClicks90 = (adsRolling || []).reduce((s: number, r: any) => s + (r.clicks || 0), 0)
  const totalConversions90 = (adsRolling || []).reduce((s: number, r: any) => s + (parseFloat(r.conversions) || 0), 0)
  const totalImpressions90 = (adsRolling || []).reduce((s: number, r: any) => s + (r.impressions || 0), 0)

  // Monthly totals for the campaign table
  const totalSpend = (adsMonthly || []).reduce((s: number, r: any) => s + (parseFloat(r.spend) || 0), 0)
  const totalClicks = (adsMonthly || []).reduce((s: number, r: any) => s + (r.clicks || 0), 0)
  const totalConversions = (adsMonthly || []).reduce((s: number, r: any) => s + (parseFloat(r.conversions) || 0), 0)
  const totalImpressions = (adsMonthly || []).reduce((s: number, r: any) => s + (r.impressions || 0), 0)

  const cpl = totalConversions90 > 0 ? Math.round(totalSpend90 / totalConversions90) : 0

  // CPA — cost per acquisition
  // Two approaches: (1) Attributed via GCLID, (2) Blended using all won jobs
  const { data: allContactMatches } = await sb
    .from('contact_matches')
    .select('job_id, gclid, lead_source')
    .eq('org_id', DEFAULT_ORG_ID)
    .not('job_id', 'is', null)

  // Get ALL jobs that reached accepted+ (won) in the rolling 90-day period
  const { data: wonJobs90d } = await sb
    .from('jobs')
    .select('id, status, accepted_at, type')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('legacy', false)
    .in('status', ['accepted', 'scheduled', 'in_progress', 'complete', 'invoiced'])
    .gte('accepted_at', ninetyDaysAgo)

  // Also count jobs with Xero invoices as "won" (backup signal)
  const { data: invoicedJobs90d } = await sb
    .from('xero_invoices')
    .select('job_id')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('invoice_type', 'ACCREC')
    .not('status', 'in', '(VOIDED,DELETED,DRAFT)')
    .not('job_id', 'is', null)
    .gte('invoice_date', ninetyDaysAgo)

  // Merge both signals: GHL accepted+ OR Xero invoiced
  const wonJobIds = new Set<string>()
  for (const j of (wonJobs90d || [])) wonJobIds.add(j.id)
  for (const inv of (invoicedJobs90d || [])) if (inv.job_id) wonJobIds.add(inv.job_id)

  const totalAcquisitions = wonJobIds.size

  // Attributed acquisitions (have GCLID = confirmed Google Ads source)
  const gclMatches = (allContactMatches || []).filter((m: any) => m.gclid)
  const attributedJobIds = new Set(gclMatches.map((m: any) => m.job_id))
  const attributedAcquisitions = [...attributedJobIds].filter(id => wonJobIds.has(id)).length

  // CPA: use total acquisitions (blended) since most historical jobs lack GCLID attribution
  const cpa = totalAcquisitions > 0 ? Math.round(totalSpend90 / totalAcquisitions) : 0

  // PPAD (Profit Per Ad Dollar) + ROAS
  // Use ALL job invoices to calculate (not just attributed ones) — blended approach
  // until GCLID attribution has enough data
  let adsRevenue = 0
  let adsCosts = 0
  const allJobIds = [...wonJobIds]
  if (allJobIds.length > 0) {
    const { data: adsInvoices } = await sb
      .from('xero_invoices')
      .select('sub_total, invoice_type')
      .eq('org_id', DEFAULT_ORG_ID)
      .in('job_id', allJobIds)
      .not('status', 'in', '(VOIDED,DELETED,DRAFT)')

    adsRevenue = (adsInvoices || []).filter((i: any) => i.invoice_type === 'ACCREC')
      .reduce((s: number, i: any) => s + (parseFloat(i.sub_total) || 0), 0)
    adsCosts = (adsInvoices || []).filter((i: any) => i.invoice_type === 'ACCPAY')
      .reduce((s: number, i: any) => s + (parseFloat(i.sub_total) || 0), 0)
  }

  const adsGrossProfit = adsRevenue - adsCosts
  const roas = totalSpend90 > 0 ? (adsRevenue / totalSpend90).toFixed(1) : '0.0'
  const ppad = totalSpend90 > 0 ? (adsGrossProfit / totalSpend90).toFixed(2) : '0.00'

  // ── ROI by Division ──
  // Map campaign names to divisions for per-division ad spend
  function campToDivision(name: string): string {
    if (!name) return 'other'
    const lower = name.toLowerCase()
    if (lower.includes('patio') || lower.includes('pergola') || lower.includes('carport')) return 'patios'
    if (lower.includes('fenc') || lower.includes('colorbond')) return 'fencing'
    if (lower.includes('deck')) return 'decking'
    return 'other'
  }

  // Per-division ad spend from daily data (90-day rolling)
  const divSpend: Record<string, number> = {}
  for (const row of (adsRolling || [])) {
    const div = campToDivision(row.campaign_name)
    divSpend[div] = (divSpend[div] || 0) + (parseFloat(row.spend) || (row.cost_micros || 0) / 1_000_000)
  }

  // Per-division won job counts (from wonJobs90d which now has type)
  const divWon: Record<string, string[]> = {}  // division → job ids
  for (const j of (wonJobs90d || [])) {
    const t = (j.type || 'other').toLowerCase()
    const div = t === 'patio' || t === 'combo' ? 'patios'
      : t === 'fencing' ? 'fencing'
      : t === 'decking' ? 'decking'
      : 'other'
    if (!divWon[div]) divWon[div] = []
    divWon[div].push(j.id)
  }
  // Also add invoiced-only jobs by division (fetch type for those)
  const invoiceOnlyIds = [...wonJobIds].filter(id => !(wonJobs90d || []).some((j: any) => j.id === id))
  if (invoiceOnlyIds.length > 0) {
    const { data: ioJobs } = await sb
      .from('jobs')
      .select('id, type')
      .in('id', invoiceOnlyIds.slice(0, 200))
    for (const j of (ioJobs || [])) {
      const t = (j.type || 'other').toLowerCase()
      const div = t === 'patio' || t === 'combo' ? 'patios'
        : t === 'fencing' ? 'fencing'
        : t === 'decking' ? 'decking'
        : 'other'
      if (!divWon[div]) divWon[div] = []
      if (!divWon[div].includes(j.id)) divWon[div].push(j.id)
    }
  }

  // Per-division revenue from Xero invoices (already fetched for ROAS)
  // We need to re-query per-division — batch fetch all won job invoices with job_id + type
  const allWonIds = [...wonJobIds]
  let divRevenue: Record<string, number> = {}
  let divCosts: Record<string, number> = {}
  if (allWonIds.length > 0) {
    const { data: divInvoices } = await sb
      .from('xero_invoices')
      .select('sub_total, invoice_type, job_id')
      .eq('org_id', DEFAULT_ORG_ID)
      .in('job_id', allWonIds.slice(0, 200))
      .not('status', 'in', '(VOIDED,DELETED,DRAFT)')

    // Build job_id → division lookup
    const jobDiv: Record<string, string> = {}
    for (const div of Object.keys(divWon)) {
      for (const id of divWon[div]) jobDiv[id] = div
    }

    for (const inv of (divInvoices || [])) {
      const div = jobDiv[inv.job_id] || 'other'
      const amt = parseFloat(inv.sub_total) || 0
      if (inv.invoice_type === 'ACCREC') {
        divRevenue[div] = (divRevenue[div] || 0) + amt
      } else if (inv.invoice_type === 'ACCPAY') {
        divCosts[div] = (divCosts[div] || 0) + amt
      }
    }
  }

  // Build roi_by_division output
  const roiByDivision: Record<string, any> = {}
  for (const div of ['patios', 'fencing', 'decking', 'other']) {
    const spend = divSpend[div] || 0
    const won = divWon[div] ? divWon[div].length : 0
    const rev = divRevenue[div] || 0
    const cost = divCosts[div] || 0
    const gp = rev - cost
    if (spend > 0 || won > 0) {
      roiByDivision[div] = {
        ad_spend: Math.round(spend),
        acquisitions: won,
        cpa: won > 0 ? Math.round(spend / won) : 0,
        revenue: Math.round(rev),
        costs: Math.round(cost),
        gross_profit: Math.round(gp),
        roas: spend > 0 ? parseFloat((rev / spend).toFixed(1)) : 0,
        ppad: spend > 0 ? parseFloat((gp / spend).toFixed(2)) : 0,
      }
    }
  }

  // ── Growth Calculator inputs: avg job value + win rate ──
  const avgJobValue = totalAcquisitions > 0 ? Math.round(adsRevenue / totalAcquisitions) : 0

  // Win rate: quoted jobs vs won jobs (last 6 months for stable signal)
  const sixMonthsAgo = new Date(now.getTime() - 180 * 86400000).toISOString().split('T')[0]
  const { data: quotedJobs6m } = await sb
    .from('jobs')
    .select('id, status')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('legacy', false)
    .in('status', ['quoted', 'accepted', 'scheduled', 'in_progress', 'complete', 'invoiced'])
    .gte('created_at', sixMonthsAgo)
  const totalQuoted6m = (quotedJobs6m || []).length
  const totalWon6m = (quotedJobs6m || []).filter((j: any) =>
    ['accepted', 'scheduled', 'in_progress', 'complete', 'invoiced'].includes(j.status)
  ).length
  const winRate = totalQuoted6m > 0 ? Math.round((totalWon6m / totalQuoted6m) * 100) : 0

  // ── Campaign performance table ──
  const campaigns = (adsMonthly || []).map((c: any) => ({
    campaign_id: c.campaign_id,
    campaign_name: c.campaign_name,
    impressions: c.impressions,
    clicks: c.clicks,
    ctr: c.ctr,
    spend: c.spend,
    conversions: c.conversions,
    cpl: c.cpl,
  }))

  // ── Lead source breakdown ──
  const { data: pipelineMetrics } = await sb
    .from('pipeline_metrics')
    .select('*')
    .eq('org_id', DEFAULT_ORG_ID)

  const leadSources: Record<string, number> = {
    google_ads: 0,
    organic: 0,
    referral: 0,
    direct: 0,
    unattributed: 0,
  }
  for (const row of (pipelineMetrics || [])) {
    leadSources.google_ads += row.google_ads_leads || 0
    leadSources.organic += row.organic_leads || 0
    leadSources.referral += row.referral_leads || 0
    leadSources.direct += row.direct_leads || 0
    leadSources.unattributed += row.unattributed_leads || 0
  }

  // Transform daily data for the frontend (convert cost_micros to dollars)
  const dailyData = (allDaily || []).map((d: any) => ({
    date: d.report_date,
    campaign_id: d.campaign_id,
    campaign_name: d.campaign_name,
    impressions: d.impressions || 0,
    clicks: d.clicks || 0,
    cost: (d.cost_micros || 0) / 1_000_000,
    conversions: d.conversions || 0,
    conversion_value: d.conversion_value || 0,
  }))

  // ── Attribution detail: contact_matches joined with jobs + invoices ──
  const matchedJobIds = (allContactMatches || [])
    .filter((m: any) => m.job_id)
    .map((m: any) => m.job_id)
  const uniqueMatchedIds = [...new Set(matchedJobIds)] as string[]

  let attributionJobs: any[] = []
  if (uniqueMatchedIds.length > 0) {
    const { data: aJobs } = await sb
      .from('jobs')
      .select('id, client_name, status, created_at, pricing_json')
      .eq('org_id', DEFAULT_ORG_ID)
      .in('id', uniqueMatchedIds.slice(0, 200))
    attributionJobs = aJobs || []
  }

  // Build job lookup
  const jobLookup: Record<string, any> = {}
  for (const j of attributionJobs) jobLookup[j.id] = j

  // Build invoice totals per job
  const invoiceTotals: Record<string, number> = {}
  if (uniqueMatchedIds.length > 0) {
    const { data: aInvoices } = await sb
      .from('xero_invoices')
      .select('job_id, sub_total')
      .eq('org_id', DEFAULT_ORG_ID)
      .eq('invoice_type', 'ACCREC')
      .not('status', 'in', '(VOIDED,DELETED,DRAFT)')
      .in('job_id', uniqueMatchedIds.slice(0, 200))
    for (const inv of (aInvoices || [])) {
      if (inv.job_id) {
        invoiceTotals[inv.job_id] = (invoiceTotals[inv.job_id] || 0) + (parseFloat(inv.sub_total) || 0)
      }
    }
  }

  // Build attribution array (most recent first)
  const attribution = (allContactMatches || [])
    .filter((m: any) => m.job_id)
    .map((m: any) => {
      const job = jobLookup[m.job_id] || {}
      const quoteVal = job.pricing_json?.totalExGST || job.pricing_json?.totalIncGST || null
      return {
        client_name: job.client_name || null,
        lead_source: m.lead_source || null,
        gclid: m.gclid || null,
        lead_date: job.created_at || null,
        status: job.status || null,
        quote_value: quoteVal ? parseFloat(quoteVal) : null,
        invoiced: invoiceTotals[m.job_id] || null,
      }
    })
    .sort((a: any, b: any) => {
      if (!a.lead_date) return 1
      if (!b.lead_date) return -1
      return b.lead_date.localeCompare(a.lead_date)
    })
    .slice(0, 100)

  // ── Keywords: top 50 by spend in last 90 days ──
  const { data: kwData } = await sb
    .from('google_ads_keywords')
    .select('keyword_text, match_type, campaign_name, ad_group_name, impressions, clicks, cost_micros, conversions')
    .eq('org_id', DEFAULT_ORG_ID)
    .gte('report_date', ninetyDaysAgo)

  // Aggregate keywords across dates (same keyword may appear on multiple days)
  const kwAgg: Record<string, any> = {}
  for (const kw of (kwData || [])) {
    const key = `${kw.keyword_text}|${kw.match_type}`
    if (!kwAgg[key]) {
      kwAgg[key] = { keyword_text: kw.keyword_text, match_type: kw.match_type, campaign_name: kw.campaign_name, ad_group_name: kw.ad_group_name, impressions: 0, clicks: 0, cost: 0, conversions: 0 }
    }
    kwAgg[key].impressions += kw.impressions || 0
    kwAgg[key].clicks += kw.clicks || 0
    kwAgg[key].cost += (kw.cost_micros || 0) / 1_000_000
    kwAgg[key].conversions += parseFloat(kw.conversions) || 0
  }
  const keywords = Object.values(kwAgg)
    .sort((a: any, b: any) => b.cost - a.cost)
    .slice(0, 50)
    .map((k: any) => ({
      ...k,
      cost: Math.round(k.cost * 100) / 100,
      ctr: k.impressions > 0 ? Math.round(k.clicks / k.impressions * 10000) / 100 : 0,
      cpl: k.conversions > 0 ? Math.round(k.cost / k.conversions) : null,
    }))

  // ── Landing pages: top 30 by clicks in last 90 days ──
  const { data: lpData } = await sb
    .from('google_ads_landing_pages')
    .select('landing_page_url, campaign_id, impressions, clicks, cost_micros, conversions')
    .eq('org_id', DEFAULT_ORG_ID)
    .gte('report_date', ninetyDaysAgo)

  // Aggregate landing pages across dates
  const lpAgg: Record<string, any> = {}
  for (const lp of (lpData || [])) {
    const key = lp.landing_page_url
    if (!lpAgg[key]) {
      lpAgg[key] = { url: lp.landing_page_url, impressions: 0, clicks: 0, cost: 0, conversions: 0 }
    }
    lpAgg[key].impressions += lp.impressions || 0
    lpAgg[key].clicks += lp.clicks || 0
    lpAgg[key].cost += (lp.cost_micros || 0) / 1_000_000
    lpAgg[key].conversions += parseFloat(lp.conversions) || 0
  }
  const landingPages = Object.values(lpAgg)
    .sort((a: any, b: any) => b.clicks - a.clicks)
    .slice(0, 30)
    .map((p: any) => ({
      ...p,
      cost: Math.round(p.cost * 100) / 100,
      ctr: p.impressions > 0 ? Math.round(p.clicks / p.impressions * 10000) / 100 : 0,
      conv_rate: p.clicks > 0 ? Math.round(p.conversions / p.clicks * 10000) / 100 : 0,
    }))

  // ── Ad group breakdown (current month) ──
  const adGroups = (adsMonthly || [])
    .filter((c: any) => c.ad_group_id && c.ad_group_id !== '')
    .map((c: any) => ({
      campaign_name: c.campaign_name,
      ad_group_id: c.ad_group_id,
      ad_group_name: c.ad_group_name,
      impressions: c.impressions,
      clicks: c.clicks,
      ctr: c.ctr,
      spend: c.spend,
      conversions: c.conversions,
      cpl: c.cpl,
    }))

  return {
    stats: {
      monthly_spend: totalSpend,
      rolling_spend_90d: totalSpend90,
      cpl,
      cpa,
      roas: parseFloat(roas),
      ppad: parseFloat(ppad),
      ads_revenue: adsRevenue,
      ads_costs: adsCosts,
      ads_gross_profit: adsGrossProfit,
      period: 'rolling_90d',
      total_acquisitions: totalAcquisitions,
      attributed_acquisitions: attributedAcquisitions,
      cpa_type: attributedAcquisitions >= 5 ? 'attributed' : 'blended',
      avg_job_value: avgJobValue,
      win_rate: winRate,
    },
    campaigns,
    ad_groups: adGroups,
    keywords,
    landing_pages: landingPages,
    lead_sources: leadSources,
    daily_data: dailyData,
    attribution,
    roi_by_division: roiByDivision,
    totals: {
      impressions: totalImpressions,
      clicks: totalClicks,
      conversions: totalConversions,
      spend: totalSpend,
    },
    targets: await getTargets(sb),
  }
}


// ════════════════════════════════════════════════════════════
// DEBT FOLLOW-UP — client-grouped receivables with phone numbers
// ════════════════════════════════════════════════════════════

async function debtFollowup(sb: any, search?: string) {
  // Get all outstanding receivables
  let query = sb
    .from('aged_receivables')
    .select('*')
    .eq('org_id', DEFAULT_ORG_ID)
    .neq('age_bucket', 'current') // Exclude not-yet-due invoices — overdue only

  // Filter by client name if search provided
  if (search) {
    query = query.ilike('contact_name', `%${search}%`)
  }

  const { data: receivables } = await query

  if (!receivables || receivables.length === 0) {
    return { clients: [], total_outstanding: 0, total_clients: 0, total_invoices: 0 }
  }

  // Get unique Xero contact IDs
  const xeroContactIds = [...new Set(
    receivables.filter((r: any) => r.xero_contact_id).map((r: any) => r.xero_contact_id)
  )] as string[]

  // Look up phone/email from contact_matches (linked via xero_contact_id)
  const { data: matches } = await sb
    .from('contact_matches')
    .select('xero_contact_id, phone, email, client_name, ghl_contact_id, job_id')
    .eq('org_id', DEFAULT_ORG_ID)
    .in('xero_contact_id', xeroContactIds.slice(0, 200))

  // Build contact info lookup from contact_matches
  const contactInfo: Record<string, { phone: string | null, email: string | null, ghl_id: string | null }> = {}
  for (const m of (matches || [])) {
    if (m.xero_contact_id && !contactInfo[m.xero_contact_id]) {
      contactInfo[m.xero_contact_id] = { phone: m.phone, email: m.email, ghl_id: m.ghl_contact_id }
    }
    // Update if current entry has no phone but this one does
    if (m.xero_contact_id && m.phone && !contactInfo[m.xero_contact_id]?.phone) {
      contactInfo[m.xero_contact_id].phone = m.phone
    }
  }

  // Also try to find phone/email from jobs table (fallback)
  const matchedJobIds = (matches || []).filter((m: any) => m.job_id).map((m: any) => m.job_id)
  if (matchedJobIds.length > 0) {
    const { data: jobs } = await sb
      .from('jobs')
      .select('id, client_phone, client_email, client_name')
      .in('id', matchedJobIds.slice(0, 200))

    // Map job_id back to xero_contact_id via matches
    const jobToXero: Record<string, string> = {}
    for (const m of (matches || [])) {
      if (m.job_id && m.xero_contact_id) jobToXero[m.job_id] = m.xero_contact_id
    }
    for (const j of (jobs || [])) {
      const xeroId = jobToXero[j.id]
      if (xeroId && contactInfo[xeroId]) {
        if (!contactInfo[xeroId].phone && j.client_phone) contactInfo[xeroId].phone = j.client_phone
        if (!contactInfo[xeroId].email && j.client_email) contactInfo[xeroId].email = j.client_email
      }
    }
  }

  // Filter out test records before grouping
  const filteredReceivables = receivables.filter((r: any) => !isTestRecord(r.contact_name))

  // Group receivables by contact
  const byContact: Record<string, {
    contact_name: string,
    xero_contact_id: string | null,
    phone: string | null,
    email: string | null,
    ghl_id: string | null,
    total_owed: number,
    oldest_bucket: string,
    invoices: any[],
  }> = {}

  const bucketSeverity: Record<string, number> = { 'current': 0, '1-30': 1, '31-60': 2, '61-90': 3, '90+': 4 }

  for (const r of filteredReceivables) {
    const key = r.xero_contact_id || r.contact_name || 'Unknown'
    if (!byContact[key]) {
      const info = contactInfo[r.xero_contact_id] || {}
      byContact[key] = {
        contact_name: r.contact_name || 'Unknown',
        xero_contact_id: r.xero_contact_id || null,
        phone: info.phone || null,
        email: info.email || null,
        ghl_id: info.ghl_id || null,
        total_owed: 0,
        oldest_bucket: 'current',
        invoices: [],
      }
    }
    const amount = parseFloat(r.amount_due) || 0
    byContact[key].total_owed += amount
    byContact[key].invoices.push({
      invoice_number: r.invoice_number,
      invoice_date: r.invoice_date,
      due_date: r.due_date,
      amount_due: amount,
      age_bucket: r.age_bucket,
      reference: r.reference || null,
      job_type: r.job_type || null,
    })
    // Track worst bucket
    if ((bucketSeverity[r.age_bucket] || 0) > (bucketSeverity[byContact[key].oldest_bucket] || 0)) {
      byContact[key].oldest_bucket = r.age_bucket
    }
  }

  // Convert to array, sorted by total owed descending
  const clients = Object.values(byContact)
    .sort((a, b) => b.total_owed - a.total_owed)
    .map(c => ({
      ...c,
      // Sort invoices by due date (oldest first)
      invoices: c.invoices.sort((a: any, b: any) => (a.due_date || '').localeCompare(b.due_date || '')),
    }))

  const totalOutstanding = clients.reduce((s, c) => s + c.total_owed, 0)

  return {
    clients,
    total_outstanding: totalOutstanding,
    total_clients: clients.length,
    total_invoices: filteredReceivables.length,
  }
}


// ════════════════════════════════════════════════════════════
// TRENDS — 12-month revenue, margin, win rate, cash flow
// ════════════════════════════════════════════════════════════

async function trends(sb: any, division?: string) {
  const now = new Date()
  const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1).toISOString().split('T')[0]

  // Map division param to Xero tracking category key
  const divTrackingKeys: Record<string, string> = {
    patios: 'SW - PATIOS',
    fencing: 'SW - FENCING',
    decking: 'SW - DECKING',
    other: null as any,  // not a single tracking key
  }

  // When division is set, read per-category data from pl_by_tracking reports
  let trendPL: Record<string, { revenue: number; costs: number; gross_profit: number }>
  if (division && divTrackingKeys[division] !== undefined) {
    trendPL = await getPLByDivision(sb, twelveMonthsAgo, division, divTrackingKeys)
  } else {
    trendPL = await getPLTotals(sb, twelveMonthsAgo)
  }

  // Build 12-month arrays
  const months: string[] = []
  const monthKeys: string[] = []
  const revenue: number[] = []
  const costs: number[] = []
  const grossProfit: number[] = []
  const marginPct: number[] = []
  const cashIn: number[] = []
  const cashOut: number[] = []
  const netCash: number[] = []

  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const monthKey = d.toISOString().split('T')[0]
    const shortMonth = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const label = shortMonth[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2)
    months.push(label)
    monthKeys.push(monthKey)

    const pl = trendPL[monthKey]
    const r = pl?.revenue || 0
    const c = pl?.costs || 0
    const gp = pl?.gross_profit || (r - c)
    revenue.push(r)
    costs.push(c)
    grossProfit.push(gp)
    marginPct.push(r > 0 ? Math.round((gp / r) * 100) : 0)
    // Cash flow: use P&L revenue/costs as proxy (invoice cash data was broken)
    cashIn.push(r)
    cashOut.push(c)
    netCash.push(r - c)
  }

  // Win rate trend by month — jobs that moved to accepted+ vs total quoted
  const allJobs = await fetchAll(sb, 'jobs',
    'status, quoted_at, accepted_at, scheduled_at, completed_at, created_at, type, pricing_json, site_suburb',
    { org_id: DEFAULT_ORG_ID, legacy: false, _gte: { created_at: twelveMonthsAgo } }
  )

  // Filter jobs by division if set
  const divJobTypes: Record<string, string[]> = {
    patios: ['patio', 'combo'],
    fencing: ['fencing'],
    decking: ['decking'],
  }
  const filteredJobs = division && divJobTypes[division]
    ? (allJobs || []).filter((j: any) => divJobTypes[division].includes((j.type || '').toLowerCase()))
    : division === 'other'
      ? (allJobs || []).filter((j: any) => !['patio', 'combo', 'fencing', 'decking'].includes((j.type || '').toLowerCase()))
      : (allJobs || [])

  const winRateByMonth: number[] = []
  const quotesByMonth: number[] = []
  const wonByMonth: number[] = []
  const avgDealByMonth: number[] = []

  for (const monthKey of monthKeys) {
    const monthEnd = new Date(monthKey)
    monthEnd.setMonth(monthEnd.getMonth() + 1)
    const endStr = monthEnd.toISOString()

    const monthJobs = filteredJobs.filter((j: any) => {
      const d = j.quoted_at || j.created_at
      return d >= monthKey && d < endStr
    })

    const quoted = monthJobs.filter((j: any) =>
      ['quoted','accepted','scheduled','in_progress','complete','invoiced'].includes(j.status)
    ).length
    const won = monthJobs.filter((j: any) =>
      ['accepted','scheduled','in_progress','complete','invoiced'].includes(j.status)
    ).length

    quotesByMonth.push(quoted)
    wonByMonth.push(won)
    winRateByMonth.push(quoted > 0 ? Math.round((won / quoted) * 100) : 0)

    // Average deal size (from pricing_json)
    const wonJobs = monthJobs.filter((j: any) =>
      ['accepted','scheduled','in_progress','complete','invoiced'].includes(j.status) && j.pricing_json
    )
    const totalValue = wonJobs.reduce((s: number, j: any) =>
      s + (parseFloat(j.pricing_json?.totalExGST || j.pricing_json?.totalIncGST || 0)), 0
    )
    avgDealByMonth.push(wonJobs.length > 0 ? Math.round(totalValue / wonJobs.length) : 0)
  }

  // Google Ads spend trend (monthly)
  const { data: adsTrend } = await sb
    .from('google_ads_monthly')
    .select('month, spend, clicks, conversions, impressions')
    .eq('org_id', DEFAULT_ORG_ID)
    .gte('month', twelveMonthsAgo)
    .order('month', { ascending: true })

  // Aggregate ads by month (may have multiple campaigns per month)
  const adsSpend: number[] = []
  const adsCPL: number[] = []
  const adsConversions: number[] = []

  for (const monthKey of monthKeys) {
    const monthAds = (adsTrend || []).filter((a: any) => a.month === monthKey)
    const spend = monthAds.reduce((s: number, a: any) => s + (parseFloat(a.spend) || 0), 0)
    const conv = monthAds.reduce((s: number, a: any) => s + (parseFloat(a.conversions) || 0), 0)
    adsSpend.push(spend)
    adsConversions.push(conv)
    adsCPL.push(conv > 0 ? Math.round(spend / conv) : 0)
  }

  return {
    months,
    revenue: { data: revenue, total: revenue.reduce((a, b) => a + b, 0) },
    costs: { data: costs, total: costs.reduce((a, b) => a + b, 0) },
    gross_profit: { data: grossProfit },
    margin_pct: { data: marginPct },
    cash_flow: {
      cash_in: cashIn,
      cash_out: cashOut,
      net: netCash,
    },
    win_rate: {
      rate: winRateByMonth,
      quotes: quotesByMonth,
      won: wonByMonth,
    },
    avg_deal_size: { data: avgDealByMonth },
    google_ads: {
      spend: adsSpend,
      cpl: adsCPL,
      conversions: adsConversions,
    },
  }
}


// ════════════════════════════════════════════════════════════
// SALES BREAKDOWN — by type, suburb, pipeline velocity
// ════════════════════════════════════════════════════════════

async function salesBreakdown(sb: any) {
  // All jobs
  const allJobs = await fetchAll(sb, 'jobs',
    'id, type, status, client_name, site_suburb, pricing_json, created_at, quoted_at, accepted_at, scheduled_at, completed_at',
    { org_id: DEFAULT_ORG_ID, legacy: false }
  )

  const jobs = allJobs || []

  // ── Revenue by job type (from Xero P&L accounts — most accurate source) ──
  // Xero P&L already breaks down revenue by account: "Sales - SW Fencing", "Sales - SW Patios", etc.
  const { data: plReports } = await sb
    .from('xero_reports')
    .select('report_json, report_type, period_start, period_end')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('report_type', 'profit_and_loss_ytd')
    .order('report_date', { ascending: false })
    .limit(1)

  // Extract revenue by category from Xero P&L
  const xeroByType: Record<string, { revenue: number; label: string }> = {}
  if (plReports && plReports.length > 0) {
    const report = plReports[0].report_json
    const rows = report?.Reports?.[0]?.Rows || []
    const incomeSection = rows.find((r: any) => r.Title === 'Income')
    if (incomeSection?.Rows) {
      for (const row of incomeSection.Rows) {
        if (row.RowType === 'SummaryRow') continue
        const label = row.Cells?.[0]?.Value || ''
        const value = parseFloat(row.Cells?.[1]?.Value || '0')
        if (value <= 0) continue
        // Map Xero account names to types
        let typeKey = 'other'
        if (label.includes('Fencing')) typeKey = 'fencing'
        else if (label.includes('Patio')) typeKey = 'patio'
        else if (label.includes('Reno') || label.includes('Extension')) typeKey = 'reno'
        else if (label.includes('Roofing')) typeKey = 'roofing'
        else if (label.includes('Insurance')) typeKey = 'insurance'
        else if (label.includes('Interest')) continue // Skip interest income
        xeroByType[typeKey] = { revenue: value, label }
      }
    }
  }

  // Also calculate pipeline value by type from GHL (quote values, not revenue)
  const pipelineByType: Record<string, { count: number; pipeline_value: number; avg_deal: number }> = {}
  for (const job of jobs) {
    if (job.status === 'cancelled') continue
    const value = parseFloat(job.pricing_json?.totalExGST || job.pricing_json?.totalIncGST || 0)
    const t = job.type || 'other'
    if (!pipelineByType[t]) pipelineByType[t] = { count: 0, pipeline_value: 0, avg_deal: 0 }
    pipelineByType[t].count++
    pipelineByType[t].pipeline_value += value
  }
  for (const t of Object.keys(pipelineByType)) {
    pipelineByType[t].avg_deal = pipelineByType[t].count > 0
      ? Math.round(pipelineByType[t].pipeline_value / pipelineByType[t].count)
      : 0
  }

  // Merge Xero revenue + pipeline data by type
  const allTypes = new Set([...Object.keys(xeroByType), ...Object.keys(pipelineByType)])
  const typeRevenue: Record<string, any> = {}
  for (const t of allTypes) {
    typeRevenue[t] = {
      xero_revenue: xeroByType[t]?.revenue || 0,
      xero_label: xeroByType[t]?.label || t,
      pipeline_count: pipelineByType[t]?.count || 0,
      pipeline_value: pipelineByType[t]?.pipeline_value || 0,
      avg_deal: pipelineByType[t]?.avg_deal || 0,
    }
  }

  // ── Revenue by suburb (top 15) — with margin data from Xero ──
  // Fetch invoices upfront so we can calculate per-suburb margins
  const { data: allInvoices } = await sb
    .from('xero_invoices')
    .select('job_id, invoice_type, sub_total')
    .eq('org_id', DEFAULT_ORG_ID)
    .not('status', 'in', '(VOIDED,DELETED,DRAFT)')
    .not('job_id', 'is', null)

  const suburbData: Record<string, { count: number; revenue: number; xero_revenue: number; xero_costs: number }> = {}
  for (const job of jobs) {
    if (!['accepted','scheduled','in_progress','complete','invoiced'].includes(job.status)) continue
    const suburb = job.site_suburb || 'Unknown'
    const value = parseFloat(job.pricing_json?.totalExGST || job.pricing_json?.totalIncGST || 0)
    if (!suburbData[suburb]) suburbData[suburb] = { count: 0, revenue: 0, xero_revenue: 0, xero_costs: 0 }
    suburbData[suburb].count++
    suburbData[suburb].revenue += value

    // Xero actual revenue + costs for this job
    const jobInvoices = (allInvoices || []).filter((i: any) => i.job_id === job.id)
    suburbData[suburb].xero_revenue += jobInvoices
      .filter((i: any) => i.invoice_type === 'ACCREC')
      .reduce((s: number, i: any) => s + (parseFloat(i.sub_total) || 0), 0)
    suburbData[suburb].xero_costs += jobInvoices
      .filter((i: any) => i.invoice_type === 'ACCPAY')
      .reduce((s: number, i: any) => s + (parseFloat(i.sub_total) || 0), 0)
  }

  const topSuburbs = Object.entries(suburbData)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 15)
    .map(([suburb, data]) => {
      const margin = data.xero_revenue > 0
        ? Math.round(((data.xero_revenue - data.xero_costs) / data.xero_revenue) * 100)
        : null
      return {
        suburb,
        count: data.count,
        revenue: data.revenue,
        avg_job: data.count > 0 ? Math.round(data.revenue / data.count) : 0,
        margin_pct: margin,
        xero_revenue: data.xero_revenue,
        xero_costs: data.xero_costs,
      }
    })

  // ── Pipeline velocity (avg days between stages) ──
  const velocities = {
    draft_to_quoted: [] as number[],
    quoted_to_accepted: [] as number[],
    accepted_to_scheduled: [] as number[],
    scheduled_to_complete: [] as number[],
    total_cycle: [] as number[],
  }

  for (const job of jobs) {
    const created = job.created_at ? new Date(job.created_at).getTime() : 0
    const quoted = job.quoted_at ? new Date(job.quoted_at).getTime() : 0
    const accepted = job.accepted_at ? new Date(job.accepted_at).getTime() : 0
    const scheduled = job.scheduled_at ? new Date(job.scheduled_at).getTime() : 0
    const completed = job.completed_at ? new Date(job.completed_at).getTime() : 0

    if (created && quoted) velocities.draft_to_quoted.push((quoted - created) / 86400000)
    if (quoted && accepted) velocities.quoted_to_accepted.push((accepted - quoted) / 86400000)
    if (accepted && scheduled) velocities.accepted_to_scheduled.push((scheduled - accepted) / 86400000)
    if (scheduled && completed) velocities.scheduled_to_complete.push((completed - scheduled) / 86400000)
    if (created && completed) velocities.total_cycle.push((completed - created) / 86400000)
  }

  const avgDays = (arr: number[]) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null

  const pipelineVelocity = {
    draft_to_quoted: avgDays(velocities.draft_to_quoted),
    quoted_to_accepted: avgDays(velocities.quoted_to_accepted),
    accepted_to_scheduled: avgDays(velocities.accepted_to_scheduled),
    scheduled_to_complete: avgDays(velocities.scheduled_to_complete),
    total_cycle: avgDays(velocities.total_cycle),
    sample_sizes: {
      draft_to_quoted: velocities.draft_to_quoted.length,
      quoted_to_accepted: velocities.quoted_to_accepted.length,
      accepted_to_scheduled: velocities.accepted_to_scheduled.length,
      scheduled_to_complete: velocities.scheduled_to_complete.length,
      total_cycle: velocities.total_cycle.length,
    },
  }

  // ── Job status distribution ──
  const statusDist: Record<string, number> = {}
  for (const job of jobs) {
    statusDist[job.status] = (statusDist[job.status] || 0) + 1
  }

  // ── Invoiced vs Quote comparison (uses allInvoices fetched above) ──
  let totalQuoteValue = 0
  let totalInvoicedValue = 0
  let jobsWithBoth = 0
  // Per-type quote accuracy for insights
  const quoteAccuracyByType: Record<string, { quoted: number; invoiced: number; costs: number; count: number }> = {}

  for (const job of jobs) {
    if (!job.pricing_json) continue
    const quoteVal = parseFloat(job.pricing_json?.totalExGST || job.pricing_json?.totalIncGST || 0)
    if (quoteVal <= 0) continue

    const jobInvoices = (allInvoices || []).filter((i: any) => i.job_id === job.id)
    const invoicedVal = jobInvoices.filter((i: any) => i.invoice_type === 'ACCREC')
      .reduce((s: number, i: any) => s + (parseFloat(i.sub_total) || 0), 0)
    const jobCosts = jobInvoices.filter((i: any) => i.invoice_type === 'ACCPAY')
      .reduce((s: number, i: any) => s + (parseFloat(i.sub_total) || 0), 0)

    if (invoicedVal > 0) {
      totalQuoteValue += quoteVal
      totalInvoicedValue += invoicedVal
      jobsWithBoth++

      // Track per-type accuracy
      const jtype = job.type || 'other'
      if (!quoteAccuracyByType[jtype]) quoteAccuracyByType[jtype] = { quoted: 0, invoiced: 0, costs: 0, count: 0 }
      quoteAccuracyByType[jtype].quoted += quoteVal
      quoteAccuracyByType[jtype].invoiced += invoicedVal
      quoteAccuracyByType[jtype].costs += jobCosts
      quoteAccuracyByType[jtype].count++
    }
  }

  // Build quote accuracy insights per type
  const quoteAccuracy = Object.entries(quoteAccuracyByType).map(([type, data]) => {
    const revenueVariance = data.quoted > 0 ? Math.round(((data.invoiced - data.quoted) / data.quoted) * 100) : 0
    const actualMargin = data.invoiced > 0 ? Math.round(((data.invoiced - data.costs) / data.invoiced) * 100) : null
    const expectedMargin = data.quoted > 0 && data.costs > 0 ? Math.round(((data.quoted - data.costs) / data.quoted) * 100) : null
    return {
      type,
      jobs_compared: data.count,
      avg_quoted: Math.round(data.quoted / data.count),
      avg_invoiced: Math.round(data.invoiced / data.count),
      avg_cost: Math.round(data.costs / data.count),
      revenue_variance_pct: revenueVariance,
      actual_margin_pct: actualMargin,
    }
  })

  // ── Conversion Funnel by Division ──
  // Group jobs by division + status to build per-division funnels
  const funnelByDivision: Record<string, Record<string, number>> = {}
  const funnelStages = ['draft', 'quoted', 'accepted', 'scheduled', 'in_progress', 'complete', 'invoiced', 'cancelled']
  for (const job of jobs) {
    const t = (job.type || 'other').toLowerCase()
    const div = t === 'patio' || t === 'combo' ? 'patios'
      : t === 'fencing' ? 'fencing'
      : t === 'decking' ? 'decking'
      : 'other'
    if (!funnelByDivision[div]) {
      funnelByDivision[div] = {}
      funnelStages.forEach(s => { funnelByDivision[div][s] = 0 })
    }
    const st = job.status || 'draft'
    funnelByDivision[div][st] = (funnelByDivision[div][st] || 0) + 1
  }

  return {
    by_type: typeRevenue,
    by_suburb: topSuburbs,
    pipeline_velocity: pipelineVelocity,
    status_distribution: statusDist,
    funnel_by_division: funnelByDivision,
    quote_vs_invoice: {
      total_quoted: totalQuoteValue,
      total_invoiced: totalInvoicedValue,
      variance_pct: totalQuoteValue > 0 ? Math.round(((totalInvoicedValue - totalQuoteValue) / totalQuoteValue) * 100) : 0,
      jobs_compared: jobsWithBoth,
    },
    quote_accuracy_by_type: quoteAccuracy,
  }
}


// ════════════════════════════════════════════════════════════
// INSIGHTS ENGINE — Actionable recommendations & benchmarks
// ════════════════════════════════════════════════════════════

// Industry benchmarks for trades/construction in Perth
const BENCHMARKS = {
  gross_margin_target: 30,       // 30%+ is healthy for patio/fencing
  gross_margin_warning: 20,      // Below 20% is concerning
  gross_margin_critical: 15,     // Below 15% is unsustainable
  cpl_target: 80,               // $80 or less is good for home services
  cpl_warning: 120,             // Above $120 needs attention
  cpa_target: 250,              // $250 or less for a won job
  roas_target: 5,               // 5x is strong
  roas_minimum: 3,              // Below 3x needs review
  win_rate_target: 40,          // 40%+ quote-to-win
  win_rate_warning: 25,         // Below 25% is low
  receivables_warning_pct: 20,  // 20% of revenue outstanding is concerning
  quote_to_accept_days: 14,     // 14 days quote → acceptance
  total_cycle_days: 60,         // 60 days draft → complete
  avg_job_size_patio: 15000,    // Expected avg for patio jobs
  avg_job_size_fencing: 5000,   // Expected avg for fencing jobs
}

type Severity = 'success' | 'warning' | 'critical' | 'info'

interface Insight {
  category: string
  title: string
  message: string
  severity: Severity
  metric?: string
  value?: number | string
  benchmark?: number | string
  action?: string
}

async function generateInsights(sb: any) {
  const now = new Date()
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0]
  const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString().split('T')[0]

  const insights: Insight[] = []

  // ── Fetch all the data we need ──
  // Jobs query uses fetchAll to paginate past the 1000-row PostgREST limit
  const [
    { data: revCurrent },
    { data: revPrev },
    { data: costCurrent },
    { data: costPrev },
    { data: receivables },
    allJobs,
    { data: adsCurrent },
    { data: adsPrev },
    { count: invoiceCount },
  ] = await Promise.all([
    sb.from('monthly_revenue').select('*').eq('org_id', DEFAULT_ORG_ID).eq('month', currentMonthStart).maybeSingle(),
    sb.from('monthly_revenue').select('*').eq('org_id', DEFAULT_ORG_ID).eq('month', prevMonthStart).maybeSingle(),
    sb.from('monthly_costs').select('*').eq('org_id', DEFAULT_ORG_ID).eq('month', currentMonthStart).maybeSingle(),
    sb.from('monthly_costs').select('*').eq('org_id', DEFAULT_ORG_ID).eq('month', prevMonthStart).maybeSingle(),
    sb.from('aged_receivables').select('*').eq('org_id', DEFAULT_ORG_ID),
    fetchAll(sb, 'jobs', 'id, type, status, pricing_json, created_at, quoted_at, accepted_at, completed_at, client_name, site_suburb', { org_id: DEFAULT_ORG_ID, legacy: false }),
    sb.from('google_ads_monthly').select('*').eq('org_id', DEFAULT_ORG_ID).eq('month', currentMonthStart),
    sb.from('google_ads_monthly').select('*').eq('org_id', DEFAULT_ORG_ID).eq('month', prevMonthStart),
    sb.from('xero_invoices').select('id', { count: 'exact', head: true }).eq('org_id', DEFAULT_ORG_ID).not('status', 'in', '(VOIDED,DELETED)'),
  ])

  const rev = revCurrent?.revenue || 0
  const prevRev = revPrev?.revenue || 0
  const costs = costCurrent?.costs || 0
  const prevCosts = costPrev?.costs || 0
  const margin = rev > 0 ? ((rev - costs) / rev) * 100 : 0
  const prevMargin = prevRev > 0 ? ((prevRev - prevCosts) / prevRev) * 100 : 0
  const jobs = allJobs || []

  // ════════════════════════════════════════
  // FINANCIAL INSIGHTS
  // ════════════════════════════════════════

  // Revenue trend
  if (rev > 0 && prevRev > 0) {
    const revChange = ((rev - prevRev) / prevRev) * 100
    if (revChange > 10) {
      insights.push({
        category: 'Financial', title: 'Revenue growing',
        message: `Revenue is up ${Math.round(revChange)}% vs last month ($${Math.round(rev).toLocaleString()} vs $${Math.round(prevRev).toLocaleString()}).`,
        severity: 'success', metric: 'Revenue MoM', value: `+${Math.round(revChange)}%`,
      })
    } else if (revChange < -10) {
      insights.push({
        category: 'Financial', title: 'Revenue declining',
        message: `Revenue is down ${Math.round(Math.abs(revChange))}% vs last month. Review pipeline and marketing spend.`,
        severity: 'warning', metric: 'Revenue MoM', value: `${Math.round(revChange)}%`,
        action: 'Check pipeline volume and ad performance. Consider increasing ad spend if leads are also down.',
      })
    }
  }

  // Gross margin
  if (rev > 0) {
    const marginRounded = Math.round(margin)
    if (margin >= BENCHMARKS.gross_margin_target) {
      insights.push({
        category: 'Financial', title: 'Margins are healthy',
        message: `Gross margin at ${marginRounded}%, above the ${BENCHMARKS.gross_margin_target}% target.`,
        severity: 'success', metric: 'Gross Margin', value: `${marginRounded}%`, benchmark: `${BENCHMARKS.gross_margin_target}%`,
      })
    } else if (margin >= BENCHMARKS.gross_margin_warning) {
      insights.push({
        category: 'Financial', title: 'Margins tightening',
        message: `Gross margin at ${marginRounded}% — below the ${BENCHMARKS.gross_margin_target}% target. Review material costs and pricing.`,
        severity: 'warning', metric: 'Gross Margin', value: `${marginRounded}%`, benchmark: `${BENCHMARKS.gross_margin_target}%`,
        action: 'Review supplier pricing and consider quoting higher on next jobs. Check if any jobs have cost overruns.',
      })
    } else {
      insights.push({
        category: 'Financial', title: 'Margins critically low',
        message: `Gross margin at ${marginRounded}% — well below sustainable levels. Immediate action needed.`,
        severity: 'critical', metric: 'Gross Margin', value: `${marginRounded}%`, benchmark: `${BENCHMARKS.gross_margin_target}%`,
        action: 'Audit current job costs. Identify which jobs are dragging margins down. Increase quotes by 10-15% or renegotiate supplier rates.',
      })
    }

    // Margin trend
    if (prevRev > 0 && margin < prevMargin - 5) {
      insights.push({
        category: 'Financial', title: 'Margin dropping',
        message: `Margin fell from ${Math.round(prevMargin)}% to ${Math.round(margin)}% month-on-month. Costs may be rising faster than revenue.`,
        severity: 'warning', action: 'Compare this month\'s bills to last month. Check for material price increases or scope creep on jobs.',
      })
    }
  }

  // Receivables
  const totalReceivables = (receivables || []).reduce((s: number, r: any) => s + (parseFloat(r.amount_due) || 0), 0)
  const overdueReceivables = (receivables || []).filter((r: any) => ['31-60','61-90','90+'].includes(r.age_bucket))
  const overdueTotal = overdueReceivables.reduce((s: number, r: any) => s + (parseFloat(r.amount_due) || 0), 0)
  const severelyOverdue = (receivables || []).filter((r: any) => r.age_bucket === '90+')

  if (severelyOverdue.length > 0) {
    const severeTotal = severelyOverdue.reduce((s: number, r: any) => s + (parseFloat(r.amount_due) || 0), 0)
    insights.push({
      category: 'Financial', title: `${severelyOverdue.length} invoice${severelyOverdue.length > 1 ? 's' : ''} overdue 90+ days`,
      message: `$${Math.round(severeTotal).toLocaleString()} outstanding for 90+ days: ${severelyOverdue.map((r: any) => r.contact_name).join(', ')}.`,
      severity: 'critical', metric: '90+ Day Receivables', value: `$${Math.round(severeTotal).toLocaleString()}`,
      action: 'Call these clients this week. Consider putting on stop credit or engaging a collections process.',
    })
  } else if (overdueTotal > 0) {
    insights.push({
      category: 'Financial', title: 'Overdue receivables need attention',
      message: `$${Math.round(overdueTotal).toLocaleString()} outstanding beyond 30 days across ${overdueReceivables.length} invoices.`,
      severity: 'warning', metric: 'Overdue >30 Days', value: `$${Math.round(overdueTotal).toLocaleString()}`,
      action: 'Send payment reminders for all invoices over 30 days. Follow up with a phone call for 60+ day invoices.',
    })
  }

  if (rev > 0 && totalReceivables > rev * (BENCHMARKS.receivables_warning_pct / 100)) {
    insights.push({
      category: 'Financial', title: 'High receivables ratio',
      message: `Outstanding receivables ($${Math.round(totalReceivables).toLocaleString()}) are ${Math.round((totalReceivables / rev) * 100)}% of monthly revenue. Target is under ${BENCHMARKS.receivables_warning_pct}%.`,
      severity: 'warning', action: 'Tighten payment terms. Consider requiring deposits upfront. Chase outstanding invoices.',
    })
  }

  // NOTE: Per-job-type margin analysis removed — relied on invoice→job matching
  // which only has 11% match rate. Will re-enable when contact matching improves.
  // Xero P&L tracking categories (pl_by_tracking) gives accurate type-level margins instead.

  // ════════════════════════════════════════
  // SALES / PIPELINE INSIGHTS
  // ════════════════════════════════════════

  // Win rate
  const quotedJobs = jobs.filter((j: any) => ['quoted','accepted','scheduled','in_progress','complete','invoiced'].includes(j.status))
  const wonJobs = jobs.filter((j: any) => ['accepted','scheduled','in_progress','complete','invoiced'].includes(j.status))
  const winRate = quotedJobs.length > 0 ? (wonJobs.length / quotedJobs.length) * 100 : 0

  if (quotedJobs.length >= 5) {
    if (winRate >= BENCHMARKS.win_rate_target) {
      insights.push({
        category: 'Sales', title: 'Strong win rate',
        message: `Converting ${Math.round(winRate)}% of quotes to jobs (${wonJobs.length}/${quotedJobs.length}). Above the ${BENCHMARKS.win_rate_target}% target.`,
        severity: 'success', metric: 'Win Rate', value: `${Math.round(winRate)}%`, benchmark: `${BENCHMARKS.win_rate_target}%`,
      })
    } else if (winRate < BENCHMARKS.win_rate_warning) {
      insights.push({
        category: 'Sales', title: 'Low win rate — review quoting',
        message: `Only converting ${Math.round(winRate)}% of quotes. Industry target is ${BENCHMARKS.win_rate_target}%+.`,
        severity: 'critical', metric: 'Win Rate', value: `${Math.round(winRate)}%`, benchmark: `${BENCHMARKS.win_rate_target}%`,
        action: 'Review recent lost quotes. Are you pricing too high? Is follow-up happening within 24 hours? Consider adding a \"why did we lose\" field.',
      })
    } else {
      insights.push({
        category: 'Sales', title: 'Win rate needs improvement',
        message: `Win rate at ${Math.round(winRate)}%. Target is ${BENCHMARKS.win_rate_target}%+.`,
        severity: 'warning', metric: 'Win Rate', value: `${Math.round(winRate)}%`, benchmark: `${BENCHMARKS.win_rate_target}%`,
        action: 'Speed up quote follow-up. Call within 24h of sending. Ask for feedback on lost quotes.',
      })
    }
  }

  // Pipeline velocity
  const velocityJobs = jobs.filter((j: any) => j.quoted_at && j.accepted_at)
  if (velocityJobs.length >= 3) {
    const avgQuoteToAccept = velocityJobs.reduce((s: number, j: any) => {
      return s + (new Date(j.accepted_at).getTime() - new Date(j.quoted_at).getTime()) / 86400000
    }, 0) / velocityJobs.length

    if (avgQuoteToAccept > BENCHMARKS.quote_to_accept_days * 2) {
      insights.push({
        category: 'Sales', title: 'Slow quote acceptance',
        message: `Average ${Math.round(avgQuoteToAccept)} days from quote to acceptance. Benchmark is ${BENCHMARKS.quote_to_accept_days} days.`,
        severity: 'warning', metric: 'Quote → Accept', value: `${Math.round(avgQuoteToAccept)} days`, benchmark: `${BENCHMARKS.quote_to_accept_days} days`,
        action: 'Follow up on quotes within 48 hours. Add urgency with limited-time pricing. Make it easy to accept (digital signatures).',
      })
    }
  }

  // Pipeline value
  const pipelineJobs = jobs.filter((j: any) => ['quoted','accepted','scheduled'].includes(j.status))
  const pipelineValue = pipelineJobs.reduce((s: number, j: any) => s + (parseFloat(j.pricing_json?.totalIncGST || 0)), 0)
  if (rev > 0 && pipelineValue < rev * 2) {
    insights.push({
      category: 'Sales', title: 'Pipeline needs filling',
      message: `Pipeline value ($${Math.round(pipelineValue).toLocaleString()}) is less than 2x monthly revenue. You need more leads/quotes to sustain growth.`,
      severity: 'warning', metric: 'Pipeline Cover', value: `${(pipelineValue / rev).toFixed(1)}x`, benchmark: '2x+',
      action: 'Increase marketing spend, activate referral requests, or explore new channels (Facebook, NextDoor, local partnerships).',
    })
  }

  // ════════════════════════════════════════
  // MARKETING INSIGHTS
  // ════════════════════════════════════════

  const adsCurrentData = adsCurrent || []
  const adsPrevData = adsPrev || []
  const currentSpend = adsCurrentData.reduce((s: number, r: any) => s + (parseFloat(r.spend) || 0), 0)
  const prevSpend = adsPrevData.reduce((s: number, r: any) => s + (parseFloat(r.spend) || 0), 0)
  const currentConv = adsCurrentData.reduce((s: number, r: any) => s + (parseFloat(r.conversions) || 0), 0)
  const prevConv = adsPrevData.reduce((s: number, r: any) => s + (parseFloat(r.conversions) || 0), 0)
  const currentCPL = currentConv > 0 ? currentSpend / currentConv : 0

  if (currentSpend > 0) {
    // CPL analysis
    if (currentCPL > 0 && currentCPL <= BENCHMARKS.cpl_target) {
      insights.push({
        category: 'Marketing', title: 'CPL is efficient',
        message: `Cost per lead at $${Math.round(currentCPL)} — below the $${BENCHMARKS.cpl_target} target. Consider scaling spend.`,
        severity: 'success', metric: 'CPL', value: `$${Math.round(currentCPL)}`, benchmark: `$${BENCHMARKS.cpl_target}`,
        action: 'Increase daily budget by 20% and monitor for 2 weeks. Your ads are efficient — capture more market share.',
      })
    } else if (currentCPL > BENCHMARKS.cpl_warning) {
      insights.push({
        category: 'Marketing', title: 'CPL too high — optimise ads',
        message: `Cost per lead at $${Math.round(currentCPL)}, well above the $${BENCHMARKS.cpl_target} target.`,
        severity: 'critical', metric: 'CPL', value: `$${Math.round(currentCPL)}`, benchmark: `$${BENCHMARKS.cpl_target}`,
        action: 'Review search terms report for wasted spend. Tighten negative keywords. Test new ad copy. Consider pausing worst-performing campaigns.',
      })
    } else if (currentCPL > BENCHMARKS.cpl_target) {
      insights.push({
        category: 'Marketing', title: 'CPL above target',
        message: `Cost per lead at $${Math.round(currentCPL)} vs $${BENCHMARKS.cpl_target} target.`,
        severity: 'warning', metric: 'CPL', value: `$${Math.round(currentCPL)}`, benchmark: `$${BENCHMARKS.cpl_target}`,
        action: 'Check search terms for irrelevant clicks. Review ad copy and landing page conversion rate.',
      })
    }

    // CPL trend
    const prevCPL = prevConv > 0 ? prevSpend / prevConv : 0
    if (prevCPL > 0 && currentCPL > 0) {
      const cplChange = ((currentCPL - prevCPL) / prevCPL) * 100
      if (cplChange > 25) {
        insights.push({
          category: 'Marketing', title: 'CPL spiking',
          message: `CPL up ${Math.round(cplChange)}% vs last month ($${Math.round(currentCPL)} vs $${Math.round(prevCPL)}). Investigate immediately.`,
          severity: 'warning', action: 'Check if a competitor entered the market, if quality score dropped, or if landing page has issues.',
        })
      } else if (cplChange < -15) {
        insights.push({
          category: 'Marketing', title: 'CPL improving',
          message: `CPL down ${Math.round(Math.abs(cplChange))}% vs last month. Whatever you changed is working.`,
          severity: 'success',
        })
      }
    }

    // Campaign comparison — find best and worst
    if (adsCurrentData.length >= 2) {
      const sorted = [...adsCurrentData].sort((a: any, b: any) => (parseFloat(a.cpl) || 999) - (parseFloat(b.cpl) || 999))
      const best = sorted[0]
      const worst = sorted[sorted.length - 1]
      if (best && worst && parseFloat(worst.cpl) > parseFloat(best.cpl) * 2) {
        insights.push({
          category: 'Marketing', title: 'Campaign efficiency gap',
          message: `"${worst.campaign_name}" CPL ($${Math.round(parseFloat(worst.cpl))}) is ${Math.round(parseFloat(worst.cpl) / parseFloat(best.cpl))}x worse than "${best.campaign_name}" ($${Math.round(parseFloat(best.cpl))}).`,
          severity: 'warning',
          action: `Consider pausing or restructuring "${worst.campaign_name}". Shift budget to "${best.campaign_name}".`,
        })
      }
    }
  }

  // ════════════════════════════════════════
  // KPI SCORECARD
  // ════════════════════════════════════════

  const scorecard = [
    {
      name: 'Gross Margin', value: rev > 0 ? Math.round(margin) : null, unit: '%',
      target: BENCHMARKS.gross_margin_target, warning: BENCHMARKS.gross_margin_warning,
      status: rev === 0 ? 'no-data' : margin >= BENCHMARKS.gross_margin_target ? 'green' : margin >= BENCHMARKS.gross_margin_warning ? 'amber' : 'red',
    },
    {
      name: 'Win Rate', value: quotedJobs.length >= 3 ? Math.round(winRate) : null, unit: '%',
      target: BENCHMARKS.win_rate_target, warning: BENCHMARKS.win_rate_warning,
      status: quotedJobs.length < 3 ? 'no-data' : winRate >= BENCHMARKS.win_rate_target ? 'green' : winRate >= BENCHMARKS.win_rate_warning ? 'amber' : 'red',
    },
    {
      name: 'Cost Per Lead', value: currentCPL > 0 ? Math.round(currentCPL) : null, unit: '$', inverted: true,
      target: BENCHMARKS.cpl_target, warning: BENCHMARKS.cpl_warning,
      status: currentCPL === 0 ? 'no-data' : currentCPL <= BENCHMARKS.cpl_target ? 'green' : currentCPL <= BENCHMARKS.cpl_warning ? 'amber' : 'red',
    },
    {
      name: 'Pipeline Cover', value: rev > 0 ? parseFloat((pipelineValue / rev).toFixed(1)) : null, unit: 'x',
      target: 2, warning: 1.5,
      status: rev === 0 ? 'no-data' : (pipelineValue / rev) >= 2 ? 'green' : (pipelineValue / rev) >= 1.5 ? 'amber' : 'red',
    },
    {
      name: 'Revenue MoM', value: prevRev > 0 ? Math.round(((rev - prevRev) / prevRev) * 100) : null, unit: '%',
      target: 10, warning: 0,
      status: prevRev === 0 ? 'no-data' : rev >= prevRev * 1.1 ? 'green' : rev >= prevRev ? 'amber' : 'red',
    },
    {
      name: 'Receivables Health',
      value: rev > 0 ? Math.round((totalReceivables / rev) * 100) : null, unit: '% of rev',
      target: BENCHMARKS.receivables_warning_pct, warning: BENCHMARKS.receivables_warning_pct, inverted: true,
      status: rev === 0 ? 'no-data' : totalReceivables <= rev * 0.1 ? 'green' : totalReceivables <= rev * (BENCHMARKS.receivables_warning_pct / 100) ? 'amber' : 'red',
    },
  ]

  // Sort insights: critical first, then warning, then info, then success
  const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2, success: 3 }
  insights.sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2))

  return {
    insights,
    scorecard,
    benchmarks: BENCHMARKS,
    data_quality: {
      has_xero_data: rev > 0,
      has_ads_data: currentSpend > 0,
      has_jobs: jobs.length > 0,
      total_jobs: jobs.length,
      quoted_jobs: quotedJobs.length,
      invoices_synced: invoiceCount || 0,
      won_jobs: wonJobs.length,
      win_rate_raw: winRate,
      contact_match_rate_low: false, // Updated: 65%+ match rate after sync layer backfill
      // Status distribution for debugging
      status_counts: jobs.reduce((acc: Record<string, number>, j: any) => {
        acc[j.status] = (acc[j.status] || 0) + 1
        return acc
      }, {}),
    },
  }
}


// ════════════════════════════════════════════════════════════
// MATCH INVOICES TO JOBS — by contact name
// ════════════════════════════════════════════════════════════

async function matchInvoicesToJobs(sb: any) {
  // Get all unmatched invoices (sales + bills without a job_id)
  const { data: invoices, error: invErr } = await sb
    .from('xero_invoices')
    .select('id, contact_name, xero_contact_id, invoice_type, reference')
    .eq('org_id', DEFAULT_ORG_ID)
    .is('job_id', null)
    .in('invoice_type', ['ACCREC', 'ACCPAY'])
    .not('status', 'in', '(VOIDED,DELETED,DRAFT)')

  if (invErr) return { success: false, error: invErr.message }
  if (!invoices || invoices.length === 0) {
    return { success: true, matched: 0, message: 'No unmatched invoices' }
  }

  // Get all jobs with contact details + job_number for reference matching
  const { data: jobs, error: jobErr } = await sb
    .from('jobs')
    .select('id, client_name, client_email, client_phone, ghl_contact_id, job_number')
    .eq('org_id', DEFAULT_ORG_ID)
    .limit(5000)

  if (jobErr) return { success: false, error: jobErr.message }
  if (!jobs || jobs.length === 0) {
    return { success: true, matched: 0, message: 'No jobs to match against' }
  }

  // Build job_number lookup for reference matching
  const jobByNumber: Record<string, any> = {}
  for (const job of jobs) {
    if (job.job_number) {
      jobByNumber[job.job_number.toUpperCase()] = job
    }
  }

  // Helper: normalise name — strip punctuation, lowercase, collapse spaces
  const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ')

  // Helper: check if name looks like a business (not a person)
  const BUSINESS_WORDS = ['pty', 'ltd', 'limited', 'group', 'warehouse', 'services',
    'industries', 'holdings', 'corp', 'inc', 'fencing', 'electrical', 'plumbing',
    'construction', 'property', 'building', 'supplies', 'company']
  const isBusiness = (s: string) => {
    const lower = s.toLowerCase()
    return BUSINESS_WORDS.some(w => lower.includes(w)) || !/\s/.test(s.trim())
  }

  // Helper: split into first/last name parts (only for person names with 2+ words)
  const nameParts = (s: string) => {
    const parts = norm(s).split(' ').filter(p => p.length > 0)
    if (parts.length < 2) return null // Can't split single-word names
    return { first: parts[0], last: parts[parts.length - 1], full: parts.join(' ') }
  }

  // Build lookup: exact normalised name → job (first match wins)
  const nameMap: Record<string, any> = {}
  // Build lookup: "last, first" → job (for person names only)
  const personMap: Record<string, any> = {}

  for (const job of jobs) {
    if (!job.client_name) continue
    const n = norm(job.client_name)
    if (!nameMap[n]) nameMap[n] = job

    // Index by surname for person names
    const parts = nameParts(job.client_name)
    if (parts && !isBusiness(job.client_name) && parts.last.length >= 3) {
      const key = parts.last + '|' + parts.first
      if (!personMap[key]) personMap[key] = job
    }
  }

  let matched = 0
  let updateErrors = 0
  const matchLog: string[] = []
  const failLog: string[] = []

  for (const inv of invoices) {
    let matchedJob: any = null
    let matchType = ''

    // Pass 0: Reference match (most reliable — SW number in invoice reference field)
    // Matches SWP-25001, SWF-25002, SW1615, etc.
    if (inv.reference) {
      const swMatch = (inv.reference as string).match(/SW[A-Z]?-?(\d{3,5})/i)
      if (swMatch) {
        const swNumber = swMatch[0].toUpperCase()
        if (jobByNumber[swNumber]) {
          matchedJob = jobByNumber[swNumber]
          matchType = 'reference'
        }
      }
    }

    if (!matchedJob && !inv.contact_name) continue

    const normContact = inv.contact_name ? norm(inv.contact_name) : ''

    // Pass 1: Exact normalised name match (highest confidence)
    if (!matchedJob && normContact && nameMap[normContact]) {
      matchedJob = nameMap[normContact]
      matchType = 'exact'
    }

    // Pass 2: Person name matching — same surname + matching first name/initial
    // Only for non-business names with first+last format
    if (!matchedJob && !isBusiness(inv.contact_name)) {
      const invParts = nameParts(inv.contact_name)
      if (invParts && invParts.last.length >= 3) {
        // Look for exact surname + first name match
        const exactKey = invParts.last + '|' + invParts.first
        if (personMap[exactKey]) {
          matchedJob = personMap[exactKey]
          matchType = 'person_name'
        }

        // Try first initial match if no exact first name match
        if (!matchedJob) {
          const candidates = Object.entries(personMap)
            .filter(([key]) => key.startsWith(invParts.last + '|'))
            .map(([key, job]) => ({ key, job, jobFirst: key.split('|')[1] }))

          if (candidates.length === 1) {
            // Only one person with this surname — match if first initial matches
            const c = candidates[0]
            if (c.jobFirst[0] === invParts.first[0]) {
              matchedJob = c.job
              matchType = 'surname_initial'
            }
          }
        }
      }
    }

    if (matchedJob) {
      const { error } = await sb
        .from('xero_invoices')
        .update({ job_id: matchedJob.id })
        .eq('id', inv.id)

      if (!error) {
        matched++
        const invLabel = inv.contact_name || inv.reference || '?'
        matchLog.push(`${invLabel} → ${matchedJob.client_name} [${matchType}]`)
      } else {
        updateErrors++
        failLog.push(`${inv.contact_name || inv.reference}: ${error.message}`)
      }
    }
  }

  return {
    success: true,
    matched,
    update_errors: updateErrors,
    total_checked: invoices.length,
    unmatched: invoices.length - matched - updateErrors,
    matches: matchLog.slice(0, 50),
    errors: failLog.slice(0, 10),
  }
}


// ════════════════════════════════════════════════════════════
// CUSTOMER LIFETIME VALUE — CLV analysis by customer, type, channel
// ════════════════════════════════════════════════════════════

async function customerLTV(sb: any) {
  // Get all valid ACCREC invoices grouped by contact
  const allInvoices = await fetchAll(sb, 'xero_invoices',
    'xero_contact_id, contact_name, sub_total, invoice_date, job_id, status',
    { org_id: DEFAULT_ORG_ID, invoice_type: 'ACCREC' }
  )

  // Filter out voided/deleted/draft
  const validInvoices = (allInvoices || []).filter((i: any) =>
    !['VOIDED', 'DELETED', 'DRAFT'].includes(i.status)
  )

  // Group by xero_contact_id (or contact_name fallback)
  const byCustomer: Record<string, {
    xero_contact_id: string | null
    contact_name: string
    total_revenue: number
    invoice_count: number
    first_invoice: string | null
    latest_invoice: string | null
    job_ids: Set<string>
  }> = {}

  for (const inv of validInvoices) {
    const key = inv.xero_contact_id || inv.contact_name || 'Unknown'
    if (!byCustomer[key]) {
      byCustomer[key] = {
        xero_contact_id: inv.xero_contact_id,
        contact_name: inv.contact_name || 'Unknown',
        total_revenue: 0,
        invoice_count: 0,
        first_invoice: null,
        latest_invoice: null,
        job_ids: new Set(),
      }
    }
    byCustomer[key].total_revenue += parseFloat(inv.sub_total) || 0
    byCustomer[key].invoice_count++
    if (inv.job_id) byCustomer[key].job_ids.add(inv.job_id)

    const d = inv.invoice_date
    if (d) {
      if (!byCustomer[key].first_invoice || d < byCustomer[key].first_invoice) byCustomer[key].first_invoice = d
      if (!byCustomer[key].latest_invoice || d > byCustomer[key].latest_invoice) byCustomer[key].latest_invoice = d
    }
  }

  const customers = Object.values(byCustomer)
  const totalRevenue = customers.reduce((s, c) => s + c.total_revenue, 0)
  const avgCLV = customers.length > 0 ? Math.round(totalRevenue / customers.length) : 0
  const repeatCustomers = customers.filter(c => c.invoice_count >= 2)
  const repeatRate = customers.length > 0 ? Math.round((repeatCustomers.length / customers.length) * 100) : 0

  // Top 10 customers
  const topCustomers = customers
    .sort((a, b) => b.total_revenue - a.total_revenue)
    .slice(0, 10)
    .map(c => ({
      contact_name: c.contact_name,
      total_revenue: Math.round(c.total_revenue),
      invoice_count: c.invoice_count,
      first_invoice: c.first_invoice,
      latest_invoice: c.latest_invoice,
      job_count: c.job_ids.size,
    }))

  // Top 5 concentration (risk metric)
  const top5Revenue = customers
    .sort((a, b) => b.total_revenue - a.total_revenue)
    .slice(0, 5)
    .reduce((s, c) => s + c.total_revenue, 0)
  const concentrationPct = totalRevenue > 0 ? Math.round((top5Revenue / totalRevenue) * 100) : 0

  // CLV by business unit — get job types from jobs table
  const allJobIds = [...new Set(customers.flatMap(c => [...c.job_ids]))]
  let jobTypeMap: Record<string, string> = {}
  if (allJobIds.length > 0) {
    // Fetch in batches of 500
    for (let i = 0; i < allJobIds.length; i += 500) {
      const batch = allJobIds.slice(i, i + 500)
      const { data: jobs } = await sb
        .from('jobs')
        .select('id, type')
        .in('id', batch)
      for (const j of (jobs || [])) {
        jobTypeMap[j.id] = j.type || 'other'
      }
    }
  }

  // Revenue by type from invoice → job → type
  const revenueByType: Record<string, number> = {}
  for (const inv of validInvoices) {
    if (!inv.job_id) continue
    const jtype = jobTypeMap[inv.job_id] || 'other'
    revenueByType[jtype] = (revenueByType[jtype] || 0) + (parseFloat(inv.sub_total) || 0)
  }

  const byType = Object.entries(revenueByType)
    .map(([type, rev]) => ({ type, revenue: Math.round(rev) }))
    .sort((a, b) => b.revenue - a.revenue)

  // CLV by acquisition channel — join with contact_matches
  const { data: contactMatches } = await sb
    .from('contact_matches')
    .select('xero_contact_id, lead_source, gclid')
    .eq('org_id', DEFAULT_ORG_ID)
    .not('xero_contact_id', 'is', null)

  // Build channel lookup: xero_contact_id → lead_source
  const channelMap: Record<string, string> = {}
  for (const m of (contactMatches || [])) {
    if (m.xero_contact_id) {
      // Classify channel: if has gclid → google_ads, else use lead_source
      channelMap[m.xero_contact_id] = m.gclid ? 'Google Ads' :
        (m.lead_source || 'Direct').replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())
    }
  }

  const revenueByChannel: Record<string, number> = {}
  for (const c of customers) {
    const channel = (c.xero_contact_id && channelMap[c.xero_contact_id]) || 'Unattributed'
    revenueByChannel[channel] = (revenueByChannel[channel] || 0) + c.total_revenue
  }

  const byChannel = Object.entries(revenueByChannel)
    .map(([channel, rev]) => ({ channel, revenue: Math.round(rev) }))
    .sort((a, b) => b.revenue - a.revenue)

  return {
    overall: {
      avg_clv: avgCLV,
      total_customers: customers.length,
      total_revenue: Math.round(totalRevenue),
      repeat_rate: repeatRate,
      repeat_customers: repeatCustomers.length,
    },
    concentration: {
      top_5_pct: concentrationPct,
      top_5_revenue: Math.round(top5Revenue),
    },
    top_customers: topCustomers,
    by_type: byType,
    by_channel: byChannel,
  }
}


// ════════════════════════════════════════════════════════════
// COST ANALYSIS — top suppliers, cost categories, ratios
// ════════════════════════════════════════════════════════════

async function costAnalysis(sb: any) {
  const now = new Date()
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1).toISOString().split('T')[0]

  // Get all ACCPAY invoices (bills) — YTD for supplier ranking
  const allBills = await fetchAll(sb, 'xero_invoices',
    'contact_name, sub_total, invoice_date, line_items, status',
    { org_id: DEFAULT_ORG_ID, invoice_type: 'ACCPAY' }
  )

  const validBills = (allBills || []).filter((b: any) =>
    !['VOIDED', 'DELETED', 'DRAFT'].includes(b.status)
  )

  // Top 20 suppliers by spend
  const supplierSpend: Record<string, { total: number; count: number }> = {}
  for (const bill of validBills) {
    const name = bill.contact_name || 'Unknown'
    if (!supplierSpend[name]) supplierSpend[name] = { total: 0, count: 0 }
    supplierSpend[name].total += parseFloat(bill.sub_total) || 0
    supplierSpend[name].count++
  }

  const topSuppliers = Object.entries(supplierSpend)
    .map(([name, data]) => ({ name, total: Math.round(data.total), count: data.count }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20)

  // Cost category breakdown by keyword matching on line item descriptions
  const CATEGORY_KEYWORDS: Record<string, string[]> = {
    'Materials': ['colorbond', 'panel', 'steel', 'concrete', 'solarspan', 'post', 'timber',
      'gate', 'mesh', 'bolt', 'bracket', 'beam', 'sheet', 'rail', 'fixing', 'screw',
      'aluminium', 'roofing', 'flashing', 'gutter', 'hardware', 'material'],
    'Labour': ['labour', 'labor', 'install', 'subcontract', 'wages', 'sub-contract', 'contractor'],
    'Equipment': ['hire', 'crane', 'scaffold', 'bobcat', 'excavator', 'tool', 'equipment'],
    'Transport': ['delivery', 'transport', 'freight', 'shipping', 'cartage', 'fuel'],
    'Admin': ['insurance', 'accounting', 'admin', 'office', 'phone', 'software', 'subscription',
      'license', 'registration', 'training', 'uniform'],
  }

  const categories: Record<string, number> = {
    'Materials': 0, 'Labour': 0, 'Equipment': 0, 'Transport': 0, 'Admin': 0, 'Other': 0,
  }

  for (const bill of validBills) {
    const lineItems = bill.line_items || []
    if (lineItems.length === 0) {
      // No line items — classify by supplier name
      const amount = parseFloat(bill.sub_total) || 0
      let matched = false
      const supplierLower = (bill.contact_name || '').toLowerCase()
      for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
        if (keywords.some(kw => supplierLower.includes(kw))) {
          categories[cat] += amount
          matched = true
          break
        }
      }
      if (!matched) categories['Other'] += amount
      continue
    }

    for (const item of lineItems) {
      const desc = ((item.Description || item.description || '') + ' ' + (bill.contact_name || '')).toLowerCase()
      const amount = parseFloat(item.LineAmount || item.line_amount || 0)
      let matched = false

      for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
        if (keywords.some(kw => desc.includes(kw))) {
          categories[cat] += amount
          matched = true
          break
        }
      }
      if (!matched) categories['Other'] += amount
    }
  }

  // Round category values
  const categoryBreakdown = Object.entries(categories)
    .map(([category, amount]) => ({ category, amount: Math.round(amount) }))
    .filter(c => c.amount > 0)
    .sort((a, b) => b.amount - a.amount)

  // Monthly cost trend (last 12 months) — from P&L tracking data
  const plTotals = await getPLTotals(sb, twelveMonthsAgo, currentMonthStart)
  const costTrend: { month: string; revenue: number; costs: number; gross_profit: number }[] = []

  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const monthKey = d.toISOString().split('T')[0]
    const shortMonth = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const label = shortMonth[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2)
    const pl = plTotals[monthKey]
    costTrend.push({
      month: label,
      revenue: pl?.revenue || 0,
      costs: pl?.costs || 0,
      gross_profit: pl?.gross_profit || 0,
    })
  }

  // Cost-to-revenue ratio: current month vs trailing 12-month average
  const currentPL = plTotals[currentMonthStart]
  const currentRatio = currentPL && currentPL.revenue > 0
    ? Math.round((currentPL.costs / currentPL.revenue) * 100) : null

  const allMonthPL = Object.values(plTotals).filter(p => p.revenue > 0)
  const trailing12Rev = allMonthPL.reduce((s, p) => s + p.revenue, 0)
  const trailing12Costs = allMonthPL.reduce((s, p) => s + p.costs, 0)
  const trailingRatio = trailing12Rev > 0 ? Math.round((trailing12Costs / trailing12Rev) * 100) : null

  return {
    top_suppliers: topSuppliers,
    categories: categoryBreakdown,
    cost_trend: costTrend,
    cost_to_revenue: {
      current_month_pct: currentRatio,
      trailing_12m_pct: trailingRatio,
    },
  }
}


// ════════════════════════════════════════════════════════════
// CASH FORECAST — When will cash arrive?
// ════════════════════════════════════════════════════════════

async function cashForecast(sb: any) {
  // Unpaid receivables (ACCREC invoices with amount_due > 0)
  const { data: unpaid } = await sb
    .from('xero_invoices')
    .select('amount_due, due_date, status')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('invoice_type', 'ACCREC')
    .gt('amount_due', 0)
    .not('status', 'in', '(VOIDED,DELETED,DRAFT)')

  const now = new Date()
  let unpaidCurrent = 0
  let unpaid30 = 0
  let unpaid60 = 0
  let unpaid90 = 0

  for (const inv of (unpaid || [])) {
    const amt = parseFloat(inv.amount_due) || 0
    if (!inv.due_date) { unpaid30 += amt; continue }
    const dueDate = new Date(inv.due_date)
    const daysUntilDue = (dueDate.getTime() - now.getTime()) / 86400000
    if (daysUntilDue < 0) unpaidCurrent += amt       // Already overdue
    else if (daysUntilDue <= 30) unpaid30 += amt
    else if (daysUntilDue <= 60) unpaid60 += amt
    else unpaid90 += amt
  }

  const totalUnpaid = unpaidCurrent + unpaid30 + unpaid60 + unpaid90

  // Weighted pipeline (from jobs table)
  const stageProb: Record<string, number> = { quoted: 0.30, accepted: 0.70, scheduled: 0.90, in_progress: 0.95 }
  const stageDays: Record<string, number> = { quoted: 45, accepted: 30, scheduled: 14, in_progress: 7 }

  const pipelineJobs = await fetchAll(sb, 'jobs',
    'id, status, pricing_json',
    { org_id: DEFAULT_ORG_ID, legacy: false, _in: { status: ['quoted', 'accepted', 'scheduled', 'in_progress'] } }
  )

  let pipeline30 = 0, pipeline60 = 0, pipeline90 = 0
  for (const job of pipelineJobs) {
    const val = parseFloat(job.pricing_json?.totalExGST || job.pricing_json?.totalIncGST || 0)
    if (val <= 0) continue
    const prob = stageProb[job.status] || 0.5
    const days = stageDays[job.status] || 30
    const weighted = val * prob
    if (days <= 30) pipeline30 += weighted
    if (days <= 60) pipeline60 += weighted
    if (days <= 90) pipeline90 += weighted
  }

  // Monthly fixed costs from org_config
  const { data: fixedConfig } = await sb
    .from('org_config')
    .select('config_value')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('config_key', 'monthly_fixed_costs')
    .maybeSingle()

  const monthlyFixedCosts = fixedConfig?.config_value?.amount || 45000

  // Months of runway = (unpaid receivables + 30d pipeline) / monthly costs
  const cashIn30 = unpaidCurrent + unpaid30 + pipeline30
  const monthsRunway = monthlyFixedCosts > 0 ? parseFloat((cashIn30 / monthlyFixedCosts).toFixed(1)) : 0

  return {
    unpaid_receivables: totalUnpaid,
    overdue: unpaidCurrent,
    due_30d: unpaid30,
    due_60d: unpaid60,
    due_90d: unpaid90,
    pipeline_30d: Math.round(pipeline30),
    pipeline_60d: Math.round(pipeline60),
    pipeline_90d: Math.round(pipeline90),
    monthly_fixed_costs: monthlyFixedCosts,
    months_runway: monthsRunway,
    projected_cash_30d: Math.round(unpaidCurrent + unpaid30 + pipeline30),
    projected_cash_60d: Math.round(unpaidCurrent + unpaid30 + unpaid60 + pipeline60),
    projected_cash_90d: Math.round(unpaidCurrent + unpaid30 + unpaid60 + unpaid90 + pipeline90),
  }
}


// ════════════════════════════════════════════════════════════
// BUDGET BURN — Marketing ad spend pacing
// ════════════════════════════════════════════════════════════

async function budgetBurn(sb: any) {
  const now = new Date()
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  const dayOfMonth = now.getDate()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const daysLeft = daysInMonth - dayOfMonth

  // MTD ad spend from google_ads_daily
  const { data: adsRows } = await sb
    .from('google_ads_daily')
    .select('cost_micros')
    .eq('org_id', DEFAULT_ORG_ID)
    .gte('report_date', currentMonthStart)

  const mtdSpend = (adsRows || []).reduce((s: number, r: any) => s + (Number(r.cost_micros) || 0), 0) / 1_000_000

  // Budget from org_config
  const { data: budgetConfig } = await sb
    .from('org_config')
    .select('config_value')
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('config_key', 'monthly_marketing_budget')
    .maybeSingle()

  const budget = budgetConfig?.config_value?.amount || 5000
  const remaining = budget - mtdSpend
  const dailyRate = dayOfMonth > 0 ? mtdSpend / dayOfMonth : 0
  const projectedMonthEnd = mtdSpend + (dailyRate * daysLeft)
  const pctUsed = budget > 0 ? Math.round((mtdSpend / budget) * 100) : 0

  return {
    mtd_spend: Math.round(mtdSpend),
    budget,
    remaining: Math.round(remaining),
    daily_rate: Math.round(dailyRate),
    projected_month_end: Math.round(projectedMonthEnd),
    days_elapsed: dayOfMonth,
    days_left: daysLeft,
    days_in_month: daysInMonth,
    pct_used: pctUsed,
  }
}


// ════════════════════════════════════════════════════════════
// PROBLEM JOBS — Worst-margin active jobs
// ════════════════════════════════════════════════════════════

async function problemJobs(sb: any) {
  // Get active xero_projects with revenue > 0, sorted by margin ascending
  const { data: projects } = await sb
    .from('xero_projects')
    .select('job_id, project_name, job_number, total_invoiced, total_expenses, status')
    .eq('org_id', DEFAULT_ORG_ID)
    .not('job_id', 'is', null)
    .gt('total_invoiced', 0)
    .order('total_invoiced', { ascending: false })
    .limit(200)

  // Calculate margin and sort by worst margin
  const withMargin = (projects || []).map((p: any) => {
    const revenue = parseFloat(p.total_invoiced) || 0
    const costs = parseFloat(p.total_expenses) || 0
    const profit = revenue - costs
    const marginPct = revenue > 0 ? Math.round((profit / revenue) * 100) : 0
    return { ...p, revenue, costs, profit, margin_pct: marginPct }
  }).sort((a: any, b: any) => a.margin_pct - b.margin_pct)

  // Get job details for the worst 5
  const worst5 = withMargin.slice(0, 5)
  const jobIds = worst5.map((p: any) => p.job_id).filter(Boolean)

  let jobLookup: Record<string, any> = {}
  if (jobIds.length > 0) {
    const { data: jobs } = await sb
      .from('jobs')
      .select('id, client_name, type, pricing_json')
      .in('id', jobIds)

    for (const j of (jobs || [])) {
      jobLookup[j.id] = j
    }
  }

  return worst5.map((p: any) => {
    const job = jobLookup[p.job_id] || {}
    const quotedMarginPct = job.pricing_json?.margin_pct ?? job.pricing_json?.marginPercent ?? job.pricing_json?.margin_percent ?? null
    const actualMarginPct = p.margin_pct
    const slippage = quotedMarginPct != null ? Math.round(actualMarginPct - parseFloat(quotedMarginPct)) : null
    return {
      client_name: job.client_name || p.project_name,
      type: job.type || 'unknown',
      job_number: p.job_number,
      revenue: p.revenue,
      costs: p.costs,
      margin_pct: actualMarginPct,
      quoted_margin_pct: quotedMarginPct != null ? Math.round(parseFloat(quotedMarginPct)) : null,
      slippage,
      status: p.status,
    }
  })
}


// ════════════════════════════════════════════════════════════
// SYNC HEALTH — Data freshness indicators
// ════════════════════════════════════════════════════════════

async function syncHealth(sb: any) {
  const now = new Date()
  const yesterday = new Date(now.getTime() - 86400000).toISOString().split('T')[0]
  const alerts: string[] = []

  // Latest Xero sync timestamp
  const { data: latestXero } = await sb
    .from('xero_invoices')
    .select('synced_at')
    .eq('org_id', DEFAULT_ORG_ID)
    .order('synced_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const xeroLastSync = latestXero?.synced_at || null
  if (xeroLastSync) {
    const hoursAgo = Math.round((now.getTime() - new Date(xeroLastSync).getTime()) / 3600000)
    if (hoursAgo > 48) alerts.push(`Xero data is ${hoursAgo}h old`)
  } else {
    alerts.push('No Xero data found')
  }

  // Latest Google Ads date
  const { data: latestAds } = await sb
    .from('google_ads_daily')
    .select('report_date')
    .eq('org_id', DEFAULT_ORG_ID)
    .order('report_date', { ascending: false })
    .limit(1)
    .maybeSingle()

  const adsLastDate = latestAds?.report_date || null
  if (adsLastDate && adsLastDate < yesterday) {
    alerts.push('Google Ads data missing for yesterday')
  } else if (!adsLastDate) {
    alerts.push('No Google Ads data found')
  }

  // Contact match rate
  const { count: totalJobs } = await sb
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('legacy', false)

  const { count: matchedJobs } = await sb
    .from('contact_matches')
    .select('job_id', { count: 'exact', head: true })
    .eq('org_id', DEFAULT_ORG_ID)
    .not('xero_contact_id', 'is', null)

  const matchRate = (totalJobs || 0) > 0
    ? Math.round(((matchedJobs || 0) / (totalJobs || 1)) * 100) : 0

  return {
    xero_last_sync: xeroLastSync,
    ads_last_date: adsLastDate,
    match_rate: matchRate,
    matched_jobs: matchedJobs || 0,
    total_jobs: totalJobs || 0,
    alerts,
  }
}


// ════════════════════════════════════════════════════════════
// DIVISION P&L — breakdown by tracking category (patios/fencing/decking/other)
// ════════════════════════════════════════════════════════════

async function divisionPL(sb: any) {
  const now = new Date()
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString().split('T')[0]

  const divTrackingKeys: Record<string, string> = {
    patios: 'SW - PATIOS',
    fencing: 'SW - FENCING',
    decking: 'SW - DECKING',
    other: null as any,
  }

  const divisions = ['patios', 'fencing', 'decking', 'other']

  // Fetch all division P&L data + totals in parallel
  const [totals, ...divData] = await Promise.all([
    getPLTotals(sb, sixMonthsAgo),
    ...divisions.map(d => getPLByDivision(sb, sixMonthsAgo, d, divTrackingKeys)),
  ])

  // Build 6-month arrays per division
  const months: string[] = []
  const monthKeys: string[] = []
  const shortMonth = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const monthKey = d.toISOString().split('T')[0]
    months.push(shortMonth[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2))
    monthKeys.push(monthKey)
  }

  // Current month = last in array, previous month = second to last
  const curKey = monthKeys[monthKeys.length - 1]
  const prevKey = monthKeys[monthKeys.length - 2]

  // Build per-division summary (current + previous month) and trend
  const divSummaries = divisions.map((name, idx) => {
    const pl = divData[idx]
    const cur = pl[curKey] || { revenue: 0, costs: 0, gross_profit: 0 }
    const prev = pl[prevKey] || { revenue: 0, costs: 0, gross_profit: 0 }
    const marginCur = cur.revenue > 0 ? Math.round((cur.gross_profit / cur.revenue) * 100) : 0
    const marginPrev = prev.revenue > 0 ? Math.round((prev.gross_profit / prev.revenue) * 100) : 0

    // Monthly trend arrays
    const trendRevenue = monthKeys.map(k => pl[k]?.revenue || 0)
    const trendCosts = monthKeys.map(k => pl[k]?.costs || 0)
    const trendMargin = monthKeys.map(k => {
      const r = pl[k]?.revenue || 0
      const gp = pl[k]?.gross_profit || 0
      return r > 0 ? Math.round((gp / r) * 100) : 0
    })

    return {
      division: name,
      current: { revenue: cur.revenue, costs: cur.costs, gross_profit: cur.gross_profit, margin_pct: marginCur },
      previous: { revenue: prev.revenue, costs: prev.costs, gross_profit: prev.gross_profit, margin_pct: marginPrev },
      trend: { revenue: trendRevenue, costs: trendCosts, margin_pct: trendMargin },
    }
  })

  // Totals for current + previous
  const totalCur = totals[curKey] || { revenue: 0, costs: 0, gross_profit: 0 }
  const totalPrev = totals[prevKey] || { revenue: 0, costs: 0, gross_profit: 0 }

  // Check for unallocated costs (total costs > sum of division costs)
  const divCostsCur = divSummaries.reduce((s, d) => s + d.current.costs, 0)
  const unallocatedCur = Math.max(0, totalCur.costs - divCostsCur)

  return {
    months,
    divisions: divSummaries,
    totals: {
      current: { ...totalCur, margin_pct: totalCur.revenue > 0 ? Math.round((totalCur.gross_profit / totalCur.revenue) * 100) : 0 },
      previous: { ...totalPrev, margin_pct: totalPrev.revenue > 0 ? Math.round((totalPrev.gross_profit / totalPrev.revenue) * 100) : 0 },
    },
    unallocated_costs: unallocatedCur,
  }
}


// CEO REPORT — Orchestrator: one call, all data
// ════════════════════════════════════════════════════════════

async function ceoReport(sb: any) {
  // Run all data queries in parallel to minimise latency
  const [summary, trendData, sales, marketing, insightsData, debt, clv, costs, cash, budget, problems, health, divPL] = await Promise.all([
    dashboardSummary(sb),
    trends(sb),
    salesBreakdown(sb),
    marketingSummary(sb),
    generateInsights(sb),
    debtFollowup(sb),
    customerLTV(sb),
    costAnalysis(sb),
    cashForecast(sb),
    budgetBurn(sb),
    problemJobs(sb),
    syncHealth(sb),
    divisionPL(sb),
  ])

  return {
    summary,
    trends: trendData,
    sales,
    marketing,
    insights: insightsData,
    debt,
    clv: { ...clv, data_quality: 'moderate' }, // 65%+ contact match rate after sync layer backfill
    costs,
    cash_forecast: cash,
    budget_burn: budget,
    problem_jobs: problems,
    sync_health: health,
    division_pl: divPL,
  }
}


// ════════════════════════════════════════════════════════════
// SALES SUMMARY — Salesperson daily dashboard
// ════════════════════════════════════════════════════════════
async function salesSummaryAction(sb: any, params: URLSearchParams) {
  const salesperson_id = params.get('salesperson_id') || undefined
  const from = params.get('from')
  const to = params.get('to')

  const now = new Date()
  // Monday of current week
  const dayOfWeek = now.getUTCDay()
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const weekStart = from || new Date(now.getTime() - mondayOffset * 86400000).toISOString().slice(0, 10)
  const weekEnd = to || now.toISOString().slice(0, 10) + 'T23:59:59'

  // Month boundaries
  const monthStart = `${now.toISOString().slice(0, 7)}-01`

  // Fetch all org jobs (filter by salesperson in JS for flexibility)
  const filters: Record<string, any> = { org_id: DEFAULT_ORG_ID, legacy: false }
  if (salesperson_id) filters.created_by = salesperson_id
  const allJobs = await fetchAll(sb, 'jobs',
    'id, job_number, status, type, client_name, client_phone, client_email, site_address, site_suburb, pricing_json, quoted_at, accepted_at, created_at, created_by, ghl_contact_id',
    filters
  )

  // Filter out ghost drafts (scope-tool auto-saves with no job_number)
  const jobs = allJobs.filter((j: any) => j.status !== 'draft' || j.job_number)

  const qv = (j: any) => { const p = j.pricing_json; if (!p) return 0; return parseFloat(p.totalIncGST || p.totalExGST || p.total || p.grandTotal || p.subtotal || 0) || 0 }

  // Quotes this week: quoted/accepted/lost/cancelled with quoted_at in week
  const quotedThisWeek = jobs.filter((j: any) => j.quoted_at && j.quoted_at >= weekStart && ['quoted', 'accepted', 'cancelled'].includes(j.status))
  const bookedThisWeek = jobs.filter((j: any) => j.status === 'accepted' && j.accepted_at && j.accepted_at >= weekStart)
  const drafts = jobs.filter((j: any) => j.status === 'draft')

  // Close rate for current month
  const monthJobs = jobs.filter((j: any) => j.quoted_at && j.quoted_at >= monthStart)
  const accepted = monthJobs.filter((j: any) => j.status === 'accepted').length
  const closePool = monthJobs.filter((j: any) => ['quoted', 'accepted', 'cancelled'].includes(j.status)).length
  const closeRate = closePool > 0 ? Math.round((accepted / closePool) * 100) : 0

  // ── Snooze filtering: exclude jobs snoozed until future ──
  const allActionJobIds = [...drafts.map((j: any) => j.id), ...jobs.filter((j: any) => j.status === 'quoted').map((j: any) => j.id)]
  const { data: activeSnoozes } = allActionJobIds.length > 0
    ? await sb.from('sales_snooze').select('job_id, snoozed_until').in('job_id', allActionJobIds.slice(0, 200)).gte('snoozed_until', now.toISOString())
    : { data: [] }
  const snoozedJobIds = new Set((activeSnoozes || []).map((s: any) => s.job_id))

  // ── Last event per job (for "last contact X days ago") ──
  let lastEvents: any = null
  if (allActionJobIds.length > 0) {
    try {
      const rpcResult = await sb.rpc('get_last_event_per_job', { job_ids: allActionJobIds.slice(0, 200) })
      lastEvents = rpcResult.data
    } catch { /* RPC may not exist — fallback below */ }
  }
  // Fallback: query job_events directly if RPC doesn't exist
  let lastEventMap: Record<string, string> = {}
  if (lastEvents && Array.isArray(lastEvents)) {
    lastEventMap = Object.fromEntries(lastEvents.map((e: any) => [e.job_id, e.last_event_at]))
  } else if (allActionJobIds.length > 0) {
    const { data: evRows } = await sb.from('job_events').select('job_id, created_at').in('job_id', allActionJobIds.slice(0, 200)).order('created_at', { ascending: false })
    const seen = new Set<string>()
    for (const e of (evRows || [])) {
      if (!seen.has(e.job_id)) { lastEventMap[e.job_id] = e.created_at; seen.add(e.job_id) }
    }
  }

  // Follow-ups due: quoted > 7 days ago (exclude snoozed)
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString()
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000).toISOString()
  const followUps = jobs.filter((j: any) => j.status === 'quoted' && j.quoted_at && j.quoted_at < sevenDaysAgo && !snoozedJobIds.has(j.id))
    .map((j: any) => {
      const daysSinceQuoted = Math.floor((now.getTime() - new Date(j.quoted_at).getTime()) / 86400000)
      const category = daysSinceQuoted <= 14 ? 'warm' : daysSinceQuoted <= 60 ? 'warm' : 'clean'
      return { job_id: j.id, client_name: j.client_name, quote_value: qv(j), days_since_quoted: daysSinceQuoted, client_phone: j.client_phone, ghl_contact_id: j.ghl_contact_id || null, last_event_at: lastEventMap[j.id] || null, category }
    })

  // Quotes expiring: quoted > 21 days ago, value > $5K (exclude snoozed)
  const twentyOneDaysAgo = new Date(now.getTime() - 21 * 86400000).toISOString()
  const expiring = jobs.filter((j: any) => j.status === 'quoted' && j.quoted_at && j.quoted_at < twentyOneDaysAgo && !snoozedJobIds.has(j.id))
    .map((j: any) => {
      const daysSinceQuoted = Math.floor((now.getTime() - new Date(j.quoted_at).getTime()) / 86400000)
      return { job_id: j.id, client_name: j.client_name, quote_value: qv(j), days_since_quoted: daysSinceQuoted, client_phone: j.client_phone, ghl_contact_id: j.ghl_contact_id || null, last_event_at: lastEventMap[j.id] || null, category: 'hot' as const }
    })

  // Needs first contact: drafts with no scope assignment (exclude snoozed)
  const draftIds = drafts.map((j: any) => j.id)
  const { data: scopeAssignments } = draftIds.length > 0
    ? await sb.from('job_assignments').select('job_id').in('job_id', draftIds).eq('assignment_type', 'scope')
    : { data: [] }
  const scopedJobIds = new Set((scopeAssignments || []).map((a: any) => a.job_id))
  const needsContact = drafts.filter((j: any) => !scopedJobIds.has(j.id) && !snoozedJobIds.has(j.id))
    .map((j: any) => ({ job_id: j.id, client_name: j.client_name, days_old: Math.floor((now.getTime() - new Date(j.created_at).getTime()) / 86400000), type: j.type, client_phone: j.client_phone, ghl_contact_id: j.ghl_contact_id || null, last_event_at: lastEventMap[j.id] || null, category: 'hot' as const }))

  // Scope visits today
  const today = now.toISOString().slice(0, 10)
  let scopeQuery = sb.from('job_assignments').select('job_id, scheduled_date, notes').eq('assignment_type', 'scope').eq('scheduled_date', today)
  if (salesperson_id) scopeQuery = scopeQuery.eq('user_id', salesperson_id)
  const { data: todayScopes } = await scopeQuery
  const scopeJobIds = (todayScopes || []).map((s: any) => s.job_id)
  const scopeJobMap = Object.fromEntries(jobs.map((j: any) => [j.id, j]))
  const scopeVisits = (todayScopes || []).map((s: any) => {
    const j = scopeJobMap[s.job_id] || {}
    return { job_id: s.job_id, client_name: j.client_name || '', site_address: j.site_address || '', time: s.notes || '', type: j.type || '', category: 'hot' as const }
  })

  // Stale quotes (>60 days) — separate "clean" category for archival
  const staleQuotes = jobs.filter((j: any) => j.status === 'quoted' && j.quoted_at && j.quoted_at < sixtyDaysAgo && !snoozedJobIds.has(j.id))
    .map((j: any) => ({
      job_id: j.id, client_name: j.client_name, quote_value: qv(j),
      days_since_quoted: Math.floor((now.getTime() - new Date(j.quoted_at).getTime()) / 86400000),
      client_phone: j.client_phone, ghl_contact_id: j.ghl_contact_id || null, last_event_at: lastEventMap[j.id] || null, category: 'clean' as const
    }))

  // Recent activity: last 10 job_events for this user's jobs
  const jobIds = jobs.map((j: any) => j.id)
  const { data: events } = jobIds.length > 0
    ? await sb.from('job_events').select('event_type, job_id, detail_json, created_at').in('job_id', jobIds.slice(0, 200)).order('created_at', { ascending: false }).limit(10)
    : { data: [] }
  const jobMap = Object.fromEntries(jobs.map((j: any) => [j.id, j]))
  const recentActivity = (events || []).map((e: any) => ({
    event_type: e.event_type, client_name: jobMap[e.job_id]?.client_name || '', value: jobMap[e.job_id] ? qv(jobMap[e.job_id]) : 0, timestamp: e.created_at
  }))

  const oldestDraft = drafts.length > 0 ? Math.max(...drafts.map((j: any) => Math.floor((now.getTime() - new Date(j.created_at).getTime()) / 86400000))) : 0

  return {
    quotes_this_week: { count: quotedThisWeek.length, value: quotedThisWeek.reduce((s: number, j: any) => s + qv(j), 0) },
    booked_this_week: { count: bookedThisWeek.length, value: bookedThisWeek.reduce((s: number, j: any) => s + qv(j), 0) },
    my_leads: { count: drafts.length, oldest_days: oldestDraft },
    close_rate_month: closeRate,
    actions: { needs_first_contact: needsContact, follow_ups_due: followUps, scope_visits_today: scopeVisits, quotes_expiring: expiring, stale_quotes: staleQuotes },
    recent_activity: recentActivity,
  }
}


// ════════════════════════════════════════════════════════════
// SALES PIPELINE — Kanban board data
// ════════════════════════════════════════════════════════════
async function salesPipelineAction(sb: any, params: URLSearchParams) {
  const salesperson_id = params.get('salesperson_id') || undefined
  const type_filter = params.get('type_filter') || 'all'

  const now = new Date()
  // Only fetch pipeline-relevant statuses directly from DB
  const pipelineStatuses = ['draft', 'quoted', 'accepted', 'cancelled']
  // Cancelled/lost older than 90 days are irrelevant to pipeline view
  const cutoff90 = new Date(now.getTime() - 90 * 86400000).toISOString()

  const filters: Record<string, any> = {
    org_id: DEFAULT_ORG_ID,
    legacy: false,
    _in: { status: pipelineStatuses },
  }
  if (salesperson_id) filters.created_by = salesperson_id

  // Only select columns needed for cards — skip pricing_json (huge), extract value via DB-side or small parse
  const jobs = await fetchAll(sb, 'jobs',
    'id, job_number, client_name, client_phone, client_email, type, status, pricing_json, created_at, quoted_at, accepted_at',
    filters
  )

  const qv = (j: any) => { const p = j.pricing_json; if (!p) return 0; return parseFloat(p.totalIncGST || p.totalExGST || p.total || p.grandTotal || p.subtotal || 0) || 0 }

  // Filter out ghost drafts (scope-tool auto-saves with no job_number)
  const realJobs = jobs.filter((j: any) => j.status !== 'draft' || j.job_number)

  // Filter by type
  const filtered = type_filter === 'all' ? realJobs : realJobs.filter((j: any) => j.type === type_filter)

  // Drop cancelled/lost older than 90 days
  const pipelineJobs = filtered.filter((j: any) => {
    if (j.status === 'cancelled') {
      const refDate = j.quoted_at || j.created_at
      return refDate >= cutoff90
    }
    return true
  })

  const toCard = (j: any) => {
    let daysInStage = 0
    if (j.status === 'draft') daysInStage = Math.floor((now.getTime() - new Date(j.created_at).getTime()) / 86400000)
    else if (j.status === 'quoted' && j.quoted_at) daysInStage = Math.floor((now.getTime() - new Date(j.quoted_at).getTime()) / 86400000)
    else if (j.status === 'accepted' && j.accepted_at) daysInStage = Math.floor((now.getTime() - new Date(j.accepted_at).getTime()) / 86400000)
    else if (j.status === 'cancelled' && j.quoted_at) daysInStage = Math.floor((now.getTime() - new Date(j.quoted_at).getTime()) / 86400000)
    return { id: j.id, job_number: j.job_number || null, client_name: j.client_name, type: j.type, status: j.status, quote_value: qv(j), days_in_stage: daysInStage, phone: j.client_phone, email: j.client_email }
  }

  // Cap each column at 25 cards — include summary counts + total value for overflow
  const MAX_CARDS = 25
  const buildColumn = (jobs: any[]) => {
    const cards = jobs.map(toCard).sort((a: any, b: any) => b.quote_value - a.quote_value)
    const totalValue = cards.reduce((s: number, c: any) => s + (c.quote_value || 0), 0)
    const totalCount = cards.length
    return {
      total_count: totalCount,
      total_value: totalValue,
      cards: cards.slice(0, MAX_CARDS),
      ...(totalCount > MAX_CARDS ? { truncated: totalCount - MAX_CARDS } : {}),
    }
  }

  const columns = {
    draft: buildColumn(pipelineJobs.filter((j: any) => j.status === 'draft')),
    quoted: buildColumn(pipelineJobs.filter((j: any) => j.status === 'quoted')),
    accepted: buildColumn(pipelineJobs.filter((j: any) => j.status === 'accepted')),
    lost: buildColumn(pipelineJobs.filter((j: any) => j.status === 'cancelled')),
  }

  const pipelineValue = columns.quoted.total_value

  return { pipeline_value: pipelineValue, columns }
}


// ════════════════════════════════════════════════════════════
// SALES PERFORMANCE — KPIs, trends, leaderboard
// ════════════════════════════════════════════════════════════
async function salesPerformanceAction(sb: any, params: URLSearchParams) {
  const salesperson_id = params.get('salesperson_id') || undefined
  const now = new Date()
  const defaultFrom = new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10)
  const from = params.get('from') || defaultFrom
  const to = params.get('to') || now.toISOString().slice(0, 10) + 'T23:59:59'

  const filters: Record<string, any> = { org_id: DEFAULT_ORG_ID, legacy: false }
  if (salesperson_id) filters.created_by = salesperson_id

  const jobs = await fetchAll(sb, 'jobs',
    'id, status, type, site_suburb, pricing_json, created_at, quoted_at, accepted_at, created_by',
    filters
  )

  const qv = (j: any) => { const p = j.pricing_json; if (!p) return 0; return parseFloat(p.totalIncGST || p.totalExGST || p.total || p.grandTotal || p.subtotal || 0) || 0 }
  const inPeriod = (d: string | null) => d && d >= from && d <= to

  // KPIs
  const quotedInPeriod = jobs.filter((j: any) => inPeriod(j.quoted_at) && ['quoted', 'accepted', 'cancelled'].includes(j.status))
  const acceptedInPeriod = jobs.filter((j: any) => inPeriod(j.accepted_at) && j.status === 'accepted')
  const cancelledInPeriod = quotedInPeriod.filter((j: any) => j.status === 'cancelled')

  const totalQuotedValue = quotedInPeriod.reduce((s: number, j: any) => s + qv(j), 0)
  const totalBookedValue = acceptedInPeriod.reduce((s: number, j: any) => s + qv(j), 0)
  const closePool = quotedInPeriod.length
  const closeRate = closePool > 0 ? Math.round((acceptedInPeriod.length / closePool) * 100) : 0
  const avgJobValue = acceptedInPeriod.length > 0 ? Math.round(totalBookedValue / acceptedInPeriod.length) : 0

  // Average days lead-to-quote
  const withQuoted = jobs.filter((j: any) => j.quoted_at && inPeriod(j.quoted_at))
  const avgLeadToQuote = withQuoted.length > 0
    ? Math.round(withQuoted.reduce((s: number, j: any) => s + (new Date(j.quoted_at).getTime() - new Date(j.created_at).getTime()) / 86400000, 0) / withQuoted.length)
    : 0

  // Average days quote-to-accepted
  const withAccepted = acceptedInPeriod.filter((j: any) => j.quoted_at)
  const avgQuoteToAccepted = withAccepted.length > 0
    ? Math.round(withAccepted.reduce((s: number, j: any) => s + (new Date(j.accepted_at).getTime() - new Date(j.quoted_at).getTime()) / 86400000, 0) / withAccepted.length)
    : 0

  // Weekly trend: last 8 weeks
  const weeklyTrend: any[] = []
  for (let w = 7; w >= 0; w--) {
    const ws = new Date(now.getTime() - (w * 7 + (now.getUTCDay() || 7) - 1) * 86400000)
    const we = new Date(ws.getTime() + 6 * 86400000)
    const wsStr = ws.toISOString().slice(0, 10)
    const weStr = we.toISOString().slice(0, 10) + 'T23:59:59'
    const wQuoted = jobs.filter((j: any) => j.quoted_at && j.quoted_at >= wsStr && j.quoted_at <= weStr)
    const wBooked = jobs.filter((j: any) => j.status === 'accepted' && j.accepted_at && j.accepted_at >= wsStr && j.accepted_at <= weStr)
    weeklyTrend.push({ week: wsStr, quoted_value: wQuoted.reduce((s: number, j: any) => s + qv(j), 0), booked_value: wBooked.reduce((s: number, j: any) => s + qv(j), 0) })
  }

  // By type
  const byType = { patio: 0, fencing: 0, combo: 0 }
  acceptedInPeriod.forEach((j: any) => { if (j.type in byType) (byType as any)[j.type] += qv(j) })

  // Funnel
  const createdInPeriod = jobs.filter((j: any) => inPeriod(j.created_at))
  const { data: scopeAssigns } = createdInPeriod.length > 0
    ? await sb.from('job_assignments').select('job_id').in('job_id', createdInPeriod.map((j: any) => j.id).slice(0, 500)).eq('assignment_type', 'scope')
    : { data: [] }
  const scopedIds = new Set((scopeAssigns || []).map((a: any) => a.job_id))
  const funnel = {
    leads: createdInPeriod.length,
    scoped: createdInPeriod.filter((j: any) => scopedIds.has(j.id)).length,
    quoted: quotedInPeriod.length,
    accepted: acceptedInPeriod.length,
  }

  // By suburb: top 10
  const suburbMap: Record<string, { leads: number; accepted: number; value: number }> = {}
  jobs.filter((j: any) => inPeriod(j.created_at) && j.site_suburb).forEach((j: any) => {
    const s = j.site_suburb
    if (!suburbMap[s]) suburbMap[s] = { leads: 0, accepted: 0, value: 0 }
    suburbMap[s].leads++
    if (j.status === 'accepted') { suburbMap[s].accepted++; suburbMap[s].value += qv(j) }
  })
  const bySuburb = Object.entries(suburbMap)
    .map(([suburb, d]) => ({ suburb, leads: d.leads, conversion_rate: d.leads > 0 ? Math.round((d.accepted / d.leads) * 100) : 0, avg_value: d.accepted > 0 ? Math.round(d.value / d.accepted) : 0 }))
    .sort((a, b) => b.leads - a.leads).slice(0, 10)

  // Leaderboard (only if no salesperson_id filter)
  let leaderboard: any[] = []
  if (!salesperson_id) {
    const allJobs = await fetchAll(sb, 'jobs', 'id, status, pricing_json, created_by, accepted_at', { org_id: DEFAULT_ORG_ID, legacy: false })
    const byUser: Record<string, { booked_count: number; booked_value: number }> = {}
    allJobs.filter((j: any) => j.status === 'accepted' && inPeriod(j.accepted_at)).forEach((j: any) => {
      const uid = j.created_by
      if (!uid) return
      if (!byUser[uid]) byUser[uid] = { booked_count: 0, booked_value: 0 }
      byUser[uid].booked_count++
      byUser[uid].booked_value += qv(j)
    })
    const userIds = Object.keys(byUser)
    if (userIds.length > 0) {
      const { data: users } = await sb.from('users').select('id, name').in('id', userIds)
      const userMap = Object.fromEntries((users || []).map((u: any) => [u.id, u.name]))
      leaderboard = Object.entries(byUser)
        .map(([uid, d]) => ({ user_id: uid, name: userMap[uid] || 'Unknown', ...d }))
        .sort((a, b) => b.booked_value - a.booked_value)
    }
  }

  return {
    kpis: {
      total_quoted: { count: quotedInPeriod.length, value: totalQuotedValue },
      total_booked: { count: acceptedInPeriod.length, value: totalBookedValue },
      close_rate: closeRate,
      avg_job_value: avgJobValue,
      avg_days_lead_to_quote: avgLeadToQuote,
      avg_days_quote_to_accepted: avgQuoteToAccepted,
    },
    weekly_trend: weeklyTrend,
    by_type: byType,
    funnel,
    by_suburb: bySuburb,
    leaderboard,
  }
}


// ════════════════════════════════════════════════════════════
// SALES LEADS — Paginated lead list with source + hot detection
// ════════════════════════════════════════════════════════════
async function salesLeadsAction(sb: any, params: URLSearchParams) {
  const salesperson_id = params.get('salesperson_id') || undefined
  const status_filter = params.get('status_filter') || undefined
  const source_filter = params.get('source_filter') || undefined
  const search = params.get('search') || undefined
  const sort_by = params.get('sort_by') || 'created_at'
  const sort_dir = params.get('sort_dir') || 'desc'
  const page = parseInt(params.get('page') || '1', 10)
  const per_page = parseInt(params.get('per_page') || '25', 10)

  // Build job query
  let query = sb.from('jobs').select('id, client_name, client_phone, client_email, site_suburb, status, type, pricing_json, created_at, created_by', { count: 'exact' })
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('legacy', false)
  if (salesperson_id) query = query.eq('created_by', salesperson_id)
  if (status_filter) query = query.eq('status', status_filter)
  if (search) query = query.or(`client_name.ilike.%${search}%,site_suburb.ilike.%${search}%`)
  query = query.order(sort_by, { ascending: sort_dir === 'asc' })
    .range((page - 1) * per_page, page * per_page - 1)

  const { data: jobRows, count, error } = await query
  if (error) throw error
  const jobs = jobRows || []

  // Fetch contact_matches for these job IDs
  const jobIds = jobs.map((j: any) => j.id)
  let contactMap: Record<string, any> = {}
  if (jobIds.length > 0) {
    const { data: contacts } = await sb.from('contact_matches').select('job_id, lead_source, utm_campaign, utm_source, utm_medium, utm_term, utm_content').in('job_id', jobIds)
    ;(contacts || []).forEach((c: any) => { contactMap[c.job_id] = c })
  }

  // Filter by source if requested (post-fetch filter since join isn't direct)
  let filteredJobs = jobs
  if (source_filter) {
    filteredJobs = jobs.filter((j: any) => contactMap[j.id]?.lead_source === source_filter)
  }

  // Hot lead detection: suburbs with >= 5 total jobs and > 40% conversion
  const allSuburbJobs = await fetchAll(sb, 'jobs', 'site_suburb, status', { org_id: DEFAULT_ORG_ID, legacy: false })
  const suburbStats: Record<string, { total: number; accepted: number }> = {}
  allSuburbJobs.forEach((j: any) => {
    if (!j.site_suburb) return
    if (!suburbStats[j.site_suburb]) suburbStats[j.site_suburb] = { total: 0, accepted: 0 }
    suburbStats[j.site_suburb].total++
    if (j.status === 'accepted') suburbStats[j.site_suburb].accepted++
  })
  const hotSuburbs = new Set(Object.entries(suburbStats)
    .filter(([_, d]) => d.total >= 5 && (d.accepted / d.total) > 0.4)
    .map(([s]) => s))

  const now = new Date()
  const qv = (j: any) => { const p = j.pricing_json; if (!p) return null; return parseFloat(p.totalIncGST || p.totalExGST || p.total || p.grandTotal || p.subtotal || 0) || null }

  const leads = filteredJobs.map((j: any) => {
    const cm = contactMap[j.id] || {}
    return {
      id: j.id,
      client_name: j.client_name,
      client_phone: j.client_phone,
      client_email: j.client_email,
      site_suburb: j.site_suburb,
      lead_source: cm.lead_source || null,
      utm_campaign: cm.utm_campaign || null,
      created_at: j.created_at,
      status: j.status,
      days_old: Math.floor((now.getTime() - new Date(j.created_at).getTime()) / 86400000),
      quote_value: qv(j),
      type: j.type,
      hot: hotSuburbs.has(j.site_suburb),
    }
  })

  return { leads, total: count || 0, page }
}


// ════════════════════════════════════════════════════════════
// SALES ALERTS — AI-powered smart alerts for salespeople
// ════════════════════════════════════════════════════════════
async function salesAlertsAction(sb: any, params: URLSearchParams) {
  const salesperson_id = params.get('salesperson_id') || undefined
  const now = new Date()
  const qv = (j: any) => { const p = j.pricing_json; if (!p) return 0; return parseFloat(p.totalIncGST || p.totalExGST || p.total || p.grandTotal || p.subtotal || 0) || 0 }

  const filters: Record<string, any> = { org_id: DEFAULT_ORG_ID, legacy: false }
  if (salesperson_id) filters.created_by = salesperson_id

  const jobs = await fetchAll(sb, 'jobs',
    'id, status, type, client_name, client_phone, site_suburb, pricing_json, created_at, quoted_at, accepted_at, created_by',
    filters
  )

  // Get job_events for speed-to-lead check (last 30 days of drafts)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString()
  const draftJobs = jobs.filter((j: any) => j.status === 'draft' && j.created_at >= thirtyDaysAgo)
  const draftIds = draftJobs.map((j: any) => j.id)

  let jobEventsMap: Record<string, boolean> = {}
  if (draftIds.length > 0) {
    const { data: events } = await sb.from('job_events')
      .select('job_id')
      .in('job_id', draftIds.slice(0, 100))
    if (events) {
      events.forEach((e: any) => { jobEventsMap[e.job_id] = true })
    }
  }

  const alerts: any[] = []

  // 1. Speed-to-lead: Draft jobs > 24h with no job_events (beyond creation)
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 3600000).toISOString()
  const untouchedDrafts = draftJobs.filter((j: any) => j.created_at < twentyFourHoursAgo && !jobEventsMap[j.id])
  if (untouchedDrafts.length > 0) {
    const hoursWaiting = untouchedDrafts.map((j: any) => Math.floor((now.getTime() - new Date(j.created_at).getTime()) / 3600000))
    const maxHours = Math.max(...hoursWaiting)
    alerts.push({
      severity: 'critical',
      type: 'speed_to_lead',
      title: `${untouchedDrafts.length} lead${untouchedDrafts.length > 1 ? 's' : ''} waiting ${maxHours}+ hours`,
      detail: untouchedDrafts.slice(0, 3).map((j: any) => `${j.client_name} (${j.site_suburb || 'no suburb'})`).join(', '),
      action_text: 'Call now',
      job_ids: untouchedDrafts.map((j: any) => j.id),
    })
  }

  // 2. Stale quotes: Quoted jobs > 21 days, value > $5K
  const twentyOneDaysAgo = new Date(now.getTime() - 21 * 86400000).toISOString()
  const staleQuotes = jobs.filter((j: any) => j.status === 'quoted' && j.quoted_at && j.quoted_at < twentyOneDaysAgo && qv(j) > 5000)
  if (staleQuotes.length > 0) {
    const totalValue = staleQuotes.reduce((s: number, j: any) => s + qv(j), 0)
    alerts.push({
      severity: 'critical',
      type: 'stale_quote',
      title: `${staleQuotes.length} quote${staleQuotes.length > 1 ? 's' : ''} expiring ($${Math.round(totalValue / 1000)}K at risk)`,
      detail: staleQuotes.slice(0, 3).map((j: any) => {
        const days = Math.floor((now.getTime() - new Date(j.quoted_at).getTime()) / 86400000)
        return `${j.client_name} — ${days} days, $${qv(j).toLocaleString()}`
      }).join(', '),
      action_text: 'Follow up',
      job_ids: staleQuotes.map((j: any) => j.id),
    })
  }

  // 3. Follow-up due: Quoted jobs 7-21 days old
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString()
  const followUps = jobs.filter((j: any) => j.status === 'quoted' && j.quoted_at && j.quoted_at < sevenDaysAgo && j.quoted_at >= twentyOneDaysAgo)
  if (followUps.length > 0) {
    alerts.push({
      severity: 'warning',
      type: 'follow_up',
      title: `${followUps.length} quote${followUps.length > 1 ? 's' : ''} need follow-up`,
      detail: followUps.slice(0, 3).map((j: any) => {
        const days = Math.floor((now.getTime() - new Date(j.quoted_at).getTime()) / 86400000)
        return `${j.client_name} — ${days} days`
      }).join(', '),
      action_text: 'Call now',
      job_ids: followUps.map((j: any) => j.id),
    })
  }

  // 4. Hot suburb surge: Suburb with 3+ leads in past 7 days
  const recentJobs = jobs.filter((j: any) => j.created_at >= sevenDaysAgo && j.site_suburb)
  const suburbCounts: Record<string, number> = {}
  recentJobs.forEach((j: any) => { suburbCounts[j.site_suburb] = (suburbCounts[j.site_suburb] || 0) + 1 })
  const hotSuburbs = Object.entries(suburbCounts).filter(([_, c]) => c >= 3)
  if (hotSuburbs.length > 0) {
    alerts.push({
      severity: 'info',
      type: 'hot_suburb',
      title: `Hot suburb${hotSuburbs.length > 1 ? 's' : ''}: ${hotSuburbs.map(([s, c]) => `${s} (${c} leads)`).join(', ')}`,
      detail: 'High lead volume this week — consider door-knocking or letterbox drop',
      action_text: 'View leads',
      job_ids: recentJobs.filter((j: any) => hotSuburbs.some(([s]) => s === j.site_suburb)).map((j: any) => j.id),
    })
  }

  // 5. Pipeline gap: Total quoted value < 2x average monthly bookings
  const threeMonthsAgo = new Date(now.getTime() - 90 * 86400000).toISOString()
  const acceptedLast90 = jobs.filter((j: any) => j.status === 'accepted' && j.accepted_at && j.accepted_at >= threeMonthsAgo)
  const avgMonthlyBookings = acceptedLast90.reduce((s: number, j: any) => s + qv(j), 0) / 3
  const currentPipelineValue = jobs.filter((j: any) => j.status === 'quoted').reduce((s: number, j: any) => s + qv(j), 0)
  if (avgMonthlyBookings > 0 && currentPipelineValue < avgMonthlyBookings * 2) {
    alerts.push({
      severity: 'warning',
      type: 'pipeline_gap',
      title: `Pipeline thin: $${Math.round(currentPipelineValue / 1000)}K quoted vs $${Math.round(avgMonthlyBookings / 1000)}K/mo average`,
      detail: 'Need more quotes in the pipeline to maintain booking rate',
      action_text: 'View pipeline',
      job_ids: [],
    })
  }

  // 6. Win rate drop: Current month close rate < 70% of 3-month average
  const monthStart = `${now.toISOString().slice(0, 7)}-01`
  const monthQuoted = jobs.filter((j: any) => j.quoted_at && j.quoted_at >= monthStart && ['quoted', 'accepted', 'cancelled'].includes(j.status))
  const monthAccepted = monthQuoted.filter((j: any) => j.status === 'accepted').length
  const monthCloseRate = monthQuoted.length > 0 ? monthAccepted / monthQuoted.length : 0

  const qtr = jobs.filter((j: any) => j.quoted_at && j.quoted_at >= threeMonthsAgo && ['quoted', 'accepted', 'cancelled'].includes(j.status))
  const qtrAccepted = qtr.filter((j: any) => j.status === 'accepted').length
  const qtrCloseRate = qtr.length > 0 ? qtrAccepted / qtr.length : 0

  if (qtrCloseRate > 0 && monthQuoted.length >= 3 && monthCloseRate < qtrCloseRate * 0.7) {
    alerts.push({
      severity: 'warning',
      type: 'win_rate',
      title: `Win rate dropping: ${Math.round(monthCloseRate * 100)}% this month vs ${Math.round(qtrCloseRate * 100)}% avg`,
      detail: 'Close rate is significantly below your 3-month average',
      action_text: 'View stats',
      job_ids: [],
    })
  }

  return { alerts }
}


// ════════════════════════════════════════════════════════════
// SALES SNOOZE — Snooze a job in the action queue
// ════════════════════════════════════════════════════════════
async function salesSnoozeAction(sb: any, body: any) {
  const { job_id, days, reason } = body
  if (!job_id) return { error: 'job_id required' }
  const snoozeDays = Math.min(Math.max(parseInt(days) || 7, 1), 90)
  const snoozedUntil = new Date(Date.now() + snoozeDays * 86400000).toISOString()

  const { error } = await sb.from('sales_snooze').insert({
    job_id,
    snoozed_until: snoozedUntil,
    reason: reason || `Snoozed ${snoozeDays} days`,
  })
  if (error) return { error: 'Failed to snooze: ' + error.message }

  return { success: true, job_id, snoozed_until: snoozedUntil, days: snoozeDays }
}


// ════════════════════════════════════════════════════════════
// SALES QUICK ACTION — One-tap actions from action queue
// ════════════════════════════════════════════════════════════
async function salesQuickAction(sb: any, body: any) {
  const { action_type, job_id } = body
  if (!job_id || !action_type) return { error: 'job_id and action_type required' }

  if (action_type === 'archive') {
    // Mark job as cancelled with archived reason
    const { error } = await sb.from('jobs').update({ status: 'cancelled' }).eq('id', job_id)
    if (error) return { error: 'Failed to archive: ' + error.message }

    // Log the event
    await sb.from('job_events').insert({
      job_id,
      event_type: 'status_change',
      detail_json: { from: 'quoted', to: 'cancelled', reason: 'archived_dead_quote', source: 'sale_dashboard' },
    })

    return { success: true, job_id, action: 'archived' }
  }

  return { error: 'Unknown action_type: ' + action_type }
}

// ══════════════════════════════════════════════════════════
// CASH WATERFALL — where every dollar is across the business
// ══════════════════════════════════════════════════════════
async function cashWaterfall(sb: any) {
  const [bankRes, receivablesRes, payablesRes, jobsRes, posRes, depositsRes, invoicesRes] = await Promise.all([
    // 1. Bank balances (from last sync)
    sb.from('xero_bank_balances').select('account_name, balance, updated_at').eq('org_id', DEFAULT_ORG_ID),

    // 2. Receivables (what clients owe us) — only overdue
    sb.from('aged_receivables').select('contact_name, amount_due, age_bucket, due_date').eq('org_id', DEFAULT_ORG_ID).neq('age_bucket', 'current'),

    // 3. Payables (what we owe suppliers) — from xero aged payables
    sb.from('xero_aged_payables').select('contact_name, amount_due, age_bucket').eq('org_id', DEFAULT_ORG_ID),

    // 4. Completed but not invoiced (money floating in limbo)
    sb.from('jobs')
      .select('id, job_number, client_name, pricing_json, completed_at')
      .eq('org_id', DEFAULT_ORG_ID).eq('status', 'complete').not('legacy', 'is', true)
      .order('completed_at', { ascending: true }),

    // 5. PO committed (money spent but not left bank yet)
    sb.from('purchase_orders')
      .select('id, supplier_name, total, status, job_id')
      .eq('org_id', DEFAULT_ORG_ID).in('status', ['sent', 'confirmed', 'draft'])
      .not('status', 'eq', 'deleted'),

    // 6. Deposits collected but work not done (in bank but pre-committed)
    sb.from('jobs')
      .select('id, job_number, client_name, deposit_amount, status')
      .eq('org_id', DEFAULT_ORG_ID).not('legacy', 'is', true)
      .in('status', ['accepted', 'approvals', 'deposit', 'processing', 'scheduled'])
      .gt('deposit_amount', 0),

    // 7. Current month invoices sent but unpaid
    sb.from('xero_invoices')
      .select('contact_name, amount_due, due_date, invoice_number')
      .eq('org_id', DEFAULT_ORG_ID).eq('invoice_type', 'ACCREC')
      .in('status', ['AUTHORISED', 'SUBMITTED']).gt('amount_due', 0)
      .gte('due_date', new Date().toISOString().slice(0, 10))
      .order('due_date', { ascending: true }),
  ])

  // Calculate totals
  const bankTotal = (bankRes.data || []).reduce((s: number, b: any) => s + (Number(b.balance) || 0), 0)
  const bankAccounts = (bankRes.data || []).map((b: any) => ({ name: b.account_name, balance: Math.round(Number(b.balance) || 0), synced: b.updated_at }))

  const overdueTotal = (receivablesRes.data || []).reduce((s: number, r: any) => s + (Number(r.amount_due) || 0), 0)
  const overdueCount = (receivablesRes.data || []).length

  const payablesTotal = (payablesRes.data || []).reduce((s: number, p: any) => s + (Number(p.amount_due) || 0), 0)

  // Unbilled completed jobs
  const unbilledJobs = (jobsRes.data || []).map((j: any) => {
    const p = j.pricing_json || {}
    const value = parseFloat(p.totalIncGST || p.totalExGST || p.total || 0) || 0
    const daysSinceComplete = j.completed_at ? Math.floor((Date.now() - new Date(j.completed_at).getTime()) / 86400000) : 0
    return { job_number: j.job_number, client: j.client_name, value: Math.round(value), days_since_complete: daysSinceComplete }
  })
  const unbilledTotal = unbilledJobs.reduce((s: number, j: any) => s + j.value, 0)

  // PO committed
  const poCommitted = (posRes.data || []).reduce((s: number, p: any) => s + (Number(p.total) || 0), 0)
  const poCount = (posRes.data || []).length

  // Deposits held (pre-committed)
  const depositsHeld = (depositsRes.data || []).reduce((s: number, j: any) => s + (Number(j.deposit_amount) || 0), 0)
  const depositJobs = (depositsRes.data || []).length

  // Coming in (not yet due invoices)
  const comingIn = (invoicesRes.data || []).reduce((s: number, i: any) => s + (Number(i.amount_due) || 0), 0)
  const comingInCount = (invoicesRes.data || []).length

  // Real available cash = bank - PO committed - deposits held
  const realAvailable = Math.round(bankTotal - poCommitted - depositsHeld)

  // Potential inflow = overdue + unbilled + coming in
  const potentialInflow = Math.round(overdueTotal + unbilledTotal + comingIn)

  return {
    summary: {
      bank_balance: Math.round(bankTotal),
      real_available_cash: realAvailable,
      potential_inflow: potentialInflow,
      net_position: Math.round(realAvailable + potentialInflow - payablesTotal),
    },
    states: {
      '1_in_bank': { total: Math.round(bankTotal), accounts: bankAccounts },
      '2_owed_to_us_overdue': { total: Math.round(overdueTotal), count: overdueCount },
      '3_completed_not_invoiced': { total: unbilledTotal, jobs: unbilledJobs },
      '4_coming_in_not_yet_due': { total: Math.round(comingIn), count: comingInCount },
      '5_committed_to_suppliers': { total: Math.round(poCommitted), count: poCount },
      '6_owed_to_suppliers': { total: Math.round(payablesTotal) },
      '7_deposits_held_precommitted': { total: Math.round(depositsHeld), jobs: depositJobs },
    },
    actions: {
      invoice_now: unbilledJobs.length > 0 ? `${unbilledJobs.length} jobs worth $${unbilledTotal.toLocaleString()} need invoicing` : null,
      chase_now: overdueTotal > 0 ? `$${Math.round(overdueTotal).toLocaleString()} overdue across ${overdueCount} invoices` : null,
      cash_warning: realAvailable < 10000 ? `Real available cash is only $${realAvailable.toLocaleString()} after commitments` : null,
    },
  }
}
