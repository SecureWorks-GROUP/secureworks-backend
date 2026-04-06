// ════════════════════════════════════════════════════════════
// SecureWorks — Ops API Edge Function
//
// Backend for the Ops Dashboard (scheduling, POs, WOs, pipeline)
// and Trade mobile view. All data access uses service_role.
//
// Deploy:
//   /Users/marninstobbe/.local/bin/supabase functions deploy ops-api --no-verify-jwt
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

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const XERO_CLIENT_ID = Deno.env.get('XERO_CLIENT_ID') || ''
const XERO_CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET') || ''
const GHL_API_TOKEN = Deno.env.get('GHL_API_TOKEN') || ''
const GHL_LOCATION_ID = Deno.env.get('GHL_LOCATION_ID') || ''
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || ''
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'
const SW_API_KEY = Deno.env.get('SW_API_KEY') || ''

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
}) {
  try {
    await client.from('business_events').insert({
      event_type: event.event_type,
      source: event.source || 'app/office',
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      correlation_id: event.correlation_id || null,
      causation_id: event.causation_id || null,
      job_id: event.job_id || null,
      payload: event.payload || {},
      metadata: {
        ...(event.metadata || {}),
        operator: event.metadata?.operator || null,
      },
      schema_version: '1.0',
    })
  } catch (e) {
    // Non-blocking — log but don't fail the main operation
    console.log('[ops-api] business_events write failed (table may not exist yet):', (e as Error).message)
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
// REQUEST HANDLER
// ════════════════════════════════════════════════════════════

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

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
      // ── Ops Dashboard Read ──
      case 'ops_summary': return json(await opsSummary(client))
      case 'calendar': return json(await calendarEvents(client, url.searchParams))
      case 'pipeline': return json(await pipeline(client, url.searchParams))
      case 'job_detail': return json(await jobDetail(client, url.searchParams.get('jobId') || url.searchParams.get('job_id') || ''))
      case 'list_invoices': return json(await listInvoices(client, url.searchParams))
      case 'list_quotes': return json(await listQuotes(client, url.searchParams))
      case 'list_pos': return json(await listPOs(client, url.searchParams))
      case 'list_work_orders': return json(await listWorkOrders(client, url.searchParams))
      case 'list_suppliers': return json(await listSuppliers(client))
      case 'list_users': return json(await listUsers(client))
      case 'ops_targets': return json(await opsTargets(client))
      case 'get_email_events': return json(await getEmailEvents(client, url.searchParams))

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
      case 'create_invoice': return json(await createInvoice(client, body))
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
        const { accessToken: aAt, tenantId: aTi } = await getToken(client)
        const aRes = await xeroPost(`/Invoices/${aid}`, aAt, aTi, { Invoices: [{ InvoiceID: aid, Status: 'AUTHORISED' }] }, 'POST')
        const approved = aRes?.Invoices?.[0]
        await client.from('xero_invoices').update({ status: 'AUTHORISED', updated_at: new Date().toISOString() }).eq('xero_invoice_id', aid)
        return json({ success: true, status: 'AUTHORISED', invoice_number: approved?.InvoiceNumber })
      }
      case 'send_invoice_email': {
        const sid = body.xero_invoice_id
        if (!sid) return json({ error: 'xero_invoice_id required' }, 400)
        const { accessToken: sAt, tenantId: sTi } = await getToken(client)
        await xeroPost(`/Invoices/${sid}/Email`, sAt, sTi, {}, 'POST')
        return json({ success: true, emailed: true })
      }

      case 'approve_and_send_invoice': {
        const asId = body.xero_invoice_id
        if (!asId) return json({ error: 'xero_invoice_id required' }, 400)

        // 1. Approve: DRAFT → AUTHORISED
        const { accessToken: asAt, tenantId: asTi } = await getToken(client)
        const asRes = await xeroPost(`/Invoices/${asId}`, asAt, asTi, { Invoices: [{ InvoiceID: asId, Status: 'AUTHORISED' }] }, 'POST')
        const asApproved = asRes?.Invoices?.[0]
        const asInvNumber = asApproved?.InvoiceNumber || ''
        const asTotal = asApproved?.Total || 0

        // Update local record
        await client.from('xero_invoices').update({ status: 'AUTHORISED', updated_at: new Date().toISOString() }).eq('xero_invoice_id', asId)

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
          .select('*, user:user_id(name, email, abn, default_hourly_rate, payment_terms_days)')
          .eq('id', invoice_id)
          .maybeSingle()
        if (!inv) throw new ApiError('Invoice not found', 404)
        if (inv.status !== 'acknowledged' && inv.status !== 'approved') throw new ApiError('Invoice must be acknowledged before pushing to Xero', 400)
        if (inv.xero_bill_id) throw new ApiError('Already pushed to Xero', 400)

        const { data: lines } = await client.from('trade_invoice_lines')
          .select('*')
          .eq('trade_invoice_id', invoice_id)

        const { accessToken, tenantId } = await getToken(client)

        // Resolve Xero contact for the trade
        const tradeName = inv.user?.name || 'Unknown Trade'
        const tradeEmail = inv.user?.email || ''
        let xeroContactId = null

        // Search for existing contact
        try {
          const contacts = await xeroGet('/Contacts?where=EmailAddress%3D%3D%22' + encodeURIComponent(tradeEmail) + '%22', accessToken, tenantId)
          if (contacts?.Contacts?.length > 0) xeroContactId = contacts.Contacts[0].ContactID
        } catch (e) { /* fallback to create */ }

        if (!xeroContactId) {
          // Create contact
          const createRes = await xeroPost('/Contacts', accessToken, tenantId, {
            Contacts: [{ Name: tradeName, EmailAddress: tradeEmail, IsSupplier: true }]
          }, 'PUT')
          xeroContactId = createRes?.Contacts?.[0]?.ContactID
        }

        if (!xeroContactId) throw new Error('Failed to resolve Xero contact for ' + tradeName)

        // Build line items
        const weekNum = Math.ceil((new Date(inv.week_start).getTime() - new Date(new Date(inv.week_start).getFullYear(), 0, 1).getTime()) / (7 * 86400000))
        const year = new Date(inv.week_start).getFullYear()
        const reference = 'TRADE-' + tradeName.split(' ')[0] + '-WK' + weekNum + '-' + year

        const paymentDays = inv.user?.payment_terms_days || 7
        const dueDate = new Date(new Date(inv.submitted_at || Date.now()).getTime() + paymentDays * 86400000).toISOString().slice(0, 10)

        // Look up tracking categories
        let tracking: any[] = []
        try {
          const trackingCats = await xeroGet('/TrackingCategories', accessToken, tenantId)
          const divisionCat = (trackingCats?.TrackingCategories || []).find((tc: any) => tc.Name === 'Business Unit' && tc.Status === 'ACTIVE')
          if (divisionCat) tracking = divisionCat
        } catch (e) { /* skip tracking */ }

        const xeroLineItems = (lines || []).map((line: any) => {
          const desc = (line.job_number || '') + ' ' + (line.client_name || '') + ' — ' + line.total_hours + 'h @ $' + line.hourly_rate + '/hr'
          const trackingOption = trackingCategoryForJob(line.job_number || '')
          const lineTracking = tracking && trackingOption ? [{ Name: 'Business Unit', Option: trackingOption }] : []
          return {
            Description: desc,
            Quantity: line.total_hours,
            UnitAmount: line.hourly_rate,
            AccountCode: '620', // Subcontractor expense
            TaxType: 'INPUT',
            Tracking: lineTracking,
          }
        })

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
      case 'submit_expense': return json(await submitExpense(client, body))
      case 'approve_expense': return json(await approveExpense(client, body))
      case 'push_expense_to_xero': return json(await pushExpenseToXero(client, body))
      case 'list_expenses': return json(await listExpenses(client, url.searchParams))
      case 'list_unreconciled_transactions': return json(await listUnreconciledTransactions(client, url.searchParams))

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

      // ── Proposed Actions (SMS drafts etc.) ──
      case 'list_proposed_actions': return json(await listProposedActions(client, url.searchParams))
      case 'send_proposed_sms': return json(await sendProposedSms(client, body))
      case 'dismiss_proposed_action': return json(await dismissProposedAction(client, body))

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
      case 'add_note':
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
          case 'add_note': return json(await addNote(client, { ...body, userId: tradeUser.id }, isAdmin))
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

            // Get user's default rate
            const { data: userProfile } = await client.from('users')
              .select('default_hourly_rate, name')
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
            try {
              const { accessToken, tenantId } = await getToken(client)
              const tradeEmail = tradeUser.email || ''

              // Resolve Xero supplier contact (search by email, create if not found)
              let xeroContactId = null
              try {
                const contacts = await xeroGet('/Contacts?where=EmailAddress%3D%3D%22' + encodeURIComponent(tradeEmail) + '%22', accessToken, tenantId)
                if (contacts?.Contacts?.length > 0) xeroContactId = contacts.Contacts[0].ContactID
              } catch (e) { /* fallback to create */ }
              if (!xeroContactId) {
                const createRes = await xeroPost('/Contacts', accessToken, tenantId, {
                  Contacts: [{ Name: userProfile?.name || 'Trade', EmailAddress: tradeEmail, IsSupplier: true }]
                }, 'PUT')
                xeroContactId = createRes?.Contacts?.[0]?.ContactID
              }

              // Save contact ID for next time
              if (xeroContactId && !tradeUser.xero_contact_id) {
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
              console.log('[ops-api] Xero auto-push failed (non-blocking):', (e as Error).message)
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
    client.from('jobs')
      .select('id, status, type, accepted_at, completed_at, pricing_json')
      .eq('org_id', DEFAULT_ORG_ID)
      .not('legacy', 'is', true)
      .in('status', ['quoted', 'accepted', 'approvals', 'deposit', 'processing', 'scheduled', 'in_progress', 'complete', 'invoiced'])
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
  const from = params.get('from') || new Date().toISOString().slice(0, 10)
  const to = params.get('to') || (() => {
    const d = new Date(); d.setDate(d.getDate() + 60); return d.toISOString().slice(0, 10)
  })()
  const jobType = params.get('type')
  const includeFinancials = params.get('include_financials') === 'true'

  const calSelect = includeFinancials
    ? '*'
    : 'assignment_id, job_id, job_number, client_name, client_phone, site_address, site_suburb, job_type, job_status, job_phase, crew_name, assigned_to, user_id, scheduled_date, scheduled_end, start_time, end_time, assignment_status, assignment_type, assignment_notes, confirmation_status, confirmed_at, completed_at, started_at, duration_days, scope_json, ghl_contact_id, legacy, org_id, last_phase_changed_at, assigned_phone, clocked_on_at, clocked_off_at, travel_started_at, arrived_at, break_minutes, hours_worked'

  let query = client
    .from('calendar_events')
    .select(calSelect)
    .gte('scheduled_date', from)
    .lte('scheduled_date', to)
    .eq('org_id', DEFAULT_ORG_ID)
    .neq('assignment_status', 'cancelled')
    .order('scheduled_date', { ascending: true })

  if (jobType) query = query.eq('job_type', jobType)

  const { data, error } = await query
  if (error) throw error

  // Also get PO deliveries in range — use confirmed_delivery_date if available
  const { data: deliveriesByReq } = await client
    .from('purchase_orders')
    .select('id, po_number, supplier_name, delivery_date, confirmed_delivery_date, job_id, status, total')
    .eq('org_id', DEFAULT_ORG_ID)
    .gte('delivery_date', from)
    .lte('delivery_date', to)
    .in('status', ['draft', 'submitted', 'authorised'])
  const { data: deliveriesByConfirmed } = await client
    .from('purchase_orders')
    .select('id, po_number, supplier_name, delivery_date, confirmed_delivery_date, job_id, status, total')
    .eq('org_id', DEFAULT_ORG_ID)
    .gte('confirmed_delivery_date', from)
    .lte('confirmed_delivery_date', to)
    .in('status', ['draft', 'submitted', 'authorised'])
  // Merge and deduplicate by id
  const deliveryMap = new Map<string, any>()
  for (const d of [...(deliveriesByReq || []), ...(deliveriesByConfirmed || [])]) {
    deliveryMap.set(d.id, d)
  }
  const deliveries = Array.from(deliveryMap.values())

  // ── Readiness: compute per unique job in range ──
  const readiness: Record<string, JobReadiness> = {}
  const events = data || []
  const uniqueJobIds = [...new Set(events.map((e: any) => e.job_id).filter(Boolean))]

  if (uniqueJobIds.length > 0) {
    // Fetch job_intelligence for these jobs
    const { data: intelRows } = await client
      .from('job_intelligence')
      .select('*')
      .in('job_id', uniqueJobIds)

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

  return { events, deliveries: deliveries || [], readiness }
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
    query = query.in('status', ['draft', 'quoted', 'accepted', 'approvals', 'deposit', 'processing', 'scheduled', 'in_progress', 'complete', 'invoiced'])
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

  if (jobIds.length > 0) {
    ;[assignRes, poRes, woRes, councilRes, emailRes, invoiceRes] = await Promise.all([
      client.from('job_assignments').select('job_id').in('job_id', jobIds).neq('status', 'cancelled'),
      client.from('purchase_orders').select('job_id').in('job_id', jobIds).neq('status', 'deleted'),
      client.from('work_orders').select('job_id').in('job_id', jobIds).neq('status', 'cancelled'),
      client.from('council_submissions').select('job_id, overall_status, current_step_index, steps').in('job_id', jobIds),
      client.from('po_communications').select('job_id, direction, created_at').in('job_id', jobIds).eq('communication_type', 'purchase_order').order('created_at', { ascending: false }).limit(500),
      client.from('xero_invoices').select('job_id, status, invoice_type, reference').in('job_id', jobIds).eq('invoice_type', 'ACCREC').not('status', 'in', '("VOIDED","DELETED")'),
    ])
  }

  const countMap = (rows: any[]) => {
    const m: Record<string, number> = {}
    for (const r of rows) m[r.job_id] = (m[r.job_id] || 0) + 1
    return m
  }
  const assignMap = countMap(assignRes.data || [])
  const poMap = countMap(poRes.data || [])
  const woMap = countMap(woRes.data || [])

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
      ...jLite, value, days_in_stage: daysInStage,
      assignment_count: assignMap[j.id] || 0,
      po_count: poMap[j.id] || 0,
      wo_count: woMap[j.id] || 0,
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

  const columns: Record<string, any[]> = {
    draft: [], quoted: [], accepted: [], approvals: [], processing: [], in_progress: [], complete: [], invoiced: [],
  }
  for (const j of enriched) {
    // Merge deposit → accepted column, scheduled → processing column
    const col = j.status === 'deposit' ? 'accepted'
      : j.status === 'scheduled' ? 'processing'
      : j.status
    if (columns[col]) columns[col].push(j)
  }

  return { columns, total: enriched.length }
}

async function jobDetail(client: any, jobId: string) {
  if (!jobId) throw new Error('jobId required')

  const [jobRes, assignRes, docsRes, eventsRes, mediaRes, poRes, woRes, xeroRes, contactsRes] = await Promise.all([
    client.from('jobs').select('*').eq('id', jobId).single(),
    client.from('job_assignments').select('*, users:user_id(name, phone, email)').eq('job_id', jobId).order('scheduled_date'),
    client.from('job_documents').select('*').eq('job_id', jobId).order('created_at', { ascending: false }),
    client.from('job_events').select('*, users:user_id(name)').eq('job_id', jobId).order('created_at', { ascending: false }).limit(20),
    client.from('job_media').select('*').eq('job_id', jobId).order('created_at'),
    client.from('purchase_orders').select('*').eq('job_id', jobId).neq('status', 'deleted').order('created_at', { ascending: false }),
    client.from('work_orders').select('*').eq('job_id', jobId).neq('status', 'cancelled').order('created_at', { ascending: false }),
    client.from('xero_projects').select('*').eq('job_id', jobId).maybeSingle(),
    client.from('job_contacts').select('*').eq('job_id', jobId).eq('status', 'active').order('contact_label'),
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

  // Strip heavy JSON blobs from response — keep only computed values
  const { scope_json: _s, pricing_json: _p, ...jobLite } = jobRes.data || {}

  // Strip line_items from invoices (huge nested JSON)
  const invoicesLite = invoices.map((inv: any) => {
    const { line_items: _li, ...rest } = inv
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
    documents: (docsRes.data || []).map((d: any) => ({ id: d.id, name: d.name, type: d.type, url: d.url, created_at: d.created_at })),
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
    chase_logs: chaseLogs,
    readiness: jobReadiness,
  }
}

async function listInvoices(client: any, params: URLSearchParams) {
  const type = params.get('type') || 'ACCREC'
  const status = params.get('status')
  const limit = parseInt(params.get('limit') || '50')
  const offset = parseInt(params.get('offset') || '0')
  const dateFrom = params.get('date_from')
  const dateTo = params.get('date_to')

  let query = client.from('xero_invoices')
    .select('*', { count: 'exact' })
    .eq('org_id', DEFAULT_ORG_ID)
    .eq('invoice_type', type)
    .order('invoice_date', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) query = query.eq('status', status)
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
  const jobId = params.get('job_id')

  let query = client.from('work_orders')
    .select('*')
    .eq('org_id', DEFAULT_ORG_ID)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })

  if (status) query = query.eq('status', status)
  if (jobId) query = query.eq('job_id', jobId)

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

// ════════════════════════════════════════════════════════════
// OPS DASHBOARD — WRITE ACTIONS
// ════════════════════════════════════════════════════════════

async function createAssignment(client: any, body: any) {
  const { jobId, job_id, userId, user_id, scheduledDate, scheduled_date,
          scheduledEnd, scheduled_end, startTime, start_time, endTime, end_time,
          assignmentType, assignment_type, crewName, crew_name, role, notes } = body

  const jId = jobId || job_id
  const sDate = scheduledDate || scheduled_date
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
                { text: '🔗 Open in Trade', url: `https://marninms98-dotcom.github.io/securedash/trade.html#job/${jId}` }
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

  return { assignment: data }
}

async function updateAssignment(client: any, body: any) {
  const id = body.assignmentId || body.id
  if (!id) throw new Error('assignmentId required')

  // Capture old state for dual-write
  const { data: oldAssignment } = await client
    .from('job_assignments')
    .select('confirmation_status, scheduled_date, crew_name, job_id')
    .eq('id', id)
    .single()

  const allowed: Record<string, string> = {
    scheduledDate: 'scheduled_date', scheduled_date: 'scheduled_date',
    scheduledEnd: 'scheduled_end', scheduled_end: 'scheduled_end',
    startTime: 'start_time', start_time: 'start_time',
    endTime: 'end_time', end_time: 'end_time',
    status: 'status', notes: 'notes',
    crewName: 'crew_name', crew_name: 'crew_name',
    assignmentType: 'assignment_type', assignment_type: 'assignment_type',
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
  const id = body.assignmentId || body.id
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

  const validStatuses = ['draft', 'quoted', 'accepted', 'approvals', 'deposit', 'processing', 'scheduled', 'in_progress', 'complete', 'invoiced', 'cancelled', 'lost']
  if (!validStatuses.includes(status)) throw new Error('Invalid status: ' + status)

  // Capture old status + job data for business_events dual-write
  const { data: jobBefore } = await client.from('jobs')
    .select('status, job_number, client_name, pricing_json')
    .eq('id', jId).single()
  const oldStatus = jobBefore?.status || 'unknown'

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

  return { job: data }
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

  // Dual-write to business_events
  logBusinessEvent(client, {
    event_type: 'po.created',
    entity_type: 'purchase_order',
    entity_id: data.id,
    job_id: data.reference || '',
    correlation_id: data.job_id || null,
    payload: {
      entity: { id: data.id, name: data.po_number || '' },
      financial: { amount: Number(data.total || 0), currency: 'AUD' },
      related_entities: [
        { type: 'supplier', id: null, name: data.supplier_name || '' },
        { type: 'job', id: data.job_id || null },
      ],
    },
    metadata: { operator: body.operator_email || body.user_email || null },
  })

  return { purchase_order: data }
}

async function updatePO(client: any, body: any) {
  const { id, ...updates } = body
  if (!id) throw new Error('id required')

  // TODO: Add invoice_received_at, paid_at, xero_bill_id columns to purchase_orders table
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
  const { id } = body
  if (!id) throw new Error('id required')

  const { data: po, error } = await client
    .from('purchase_orders')
    .select('xero_po_id')
    .eq('id', id)
    .single()

  if (error || !po || !po.xero_po_id) throw new Error('PO not found or not synced to Xero')

  const { accessToken, tenantId } = await getToken(client)
  await xeroPost(`/PurchaseOrders/${po.xero_po_id}/Email`, accessToken, tenantId, {}, 'POST')

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
  const { id } = body
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

async function createInvoice(client: any, body: any) {
  const { job_id, jobId, contact_name, contactName, xero_contact_id, job_contact_id,
          line_items, lineItems, due_date, dueDate, reference,
          xero_status, send_email } = body

  const items = line_items || lineItems
  if (!items || items.length === 0) throw new Error('line_items required')
  const contact = contact_name || contactName
  if (!contact && !xero_contact_id) throw new Error('contact_name or xero_contact_id required')

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

  const invoice = {
    Invoices: [{
      Type: 'ACCREC',
      Contact: resolvedContactId
        ? { ContactID: resolvedContactId }
        : { Name: contact },
      LineAmountTypes: 'Exclusive',
      LineItems: xeroLineItems,
      Reference: reference || '',
      DueDate: due_date || dueDate || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
      Status: invoiceStatus,
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
        due_date: due_date || dueDate || null,
        job_id: jId || null,
        job_contact_id: job_contact_id || null,
        run_label: body.run_label || null,
        reference_suffix: (reference || '').includes('-') ? (reference || '').split('-').slice(2).join('-') || null : null,
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

  const payload: any = {
    InvoiceID: xero_invoice_id,
    LineItems: line_items.map((li: any) => ({
      Description: li.description || '',
      Quantity: li.quantity || 1,
      UnitAmount: li.unit_price || 0,
      AccountCode: li.account_code || '200',
      TaxType: 'OUTPUT',
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
  // otherwise extract from pricing_json
  let lineItems: any[] = body.line_items_override || []
  if (lineItems.length === 0 && job.pricing_json) {
    const pricing = typeof job.pricing_json === 'string' ? JSON.parse(job.pricing_json) : job.pricing_json
    if (Array.isArray(pricing.items)) {
      lineItems = pricing.items.map((li: any) => ({
        description: li.description || li.name || 'Line item',
        quantity: li.quantity || li.qty || 1,
        unit_price: li.unit_price || li.unitPrice || li.price || li.amount || 0,
        account_code: li.account_code || '200',
      }))
    } else if (pricing.total || pricing.amount) {
      // Single total amount — create one line item with rich description
      lineItems = [{
        description: buildRichDescription(job, `${trackingCategoryForJob(job.job_number) || 'Construction'} works`),
        quantity: 1,
        unit_price: pricing.total || pricing.amount || 0,
        account_code: accountCodeForJob(job.type),
      }]
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

  const finalStatus = reqStatus === 'quoted' ? 'quoted' : 'draft'

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
    .select('id, job_number, client_name, client_email, client_phone, site_address, site_suburb, pricing_json')
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

  // Update job with quote_sent_at
  await client.from('jobs')
    .update({ quoted_at: new Date().toISOString() })
    .eq('id', job_id)

  // Log email event
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

  return { success: true, resend_id: resendResult.id, sent_to: job.client_email }
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
  const prefix = jobNumber.slice(0, 3).toUpperCase()
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

  // Extract total from pricing_json
  let quotedTotal = 0
  let jobDescription = ''
  if (job.pricing_json) {
    const pricing = typeof job.pricing_json === 'string' ? JSON.parse(job.pricing_json) : job.pricing_json
    quotedTotal = pricing.totalIncGST || pricing.total || pricing.amount || 0
    jobDescription = pricing.description || pricing.jobDescription || ''
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
      .gte('scheduled_date', startStr)
      .lte('scheduled_date', endStr)
      .neq('status', 'cancelled')

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
          site_address, site_suburb, notes, job_number, pricing_json
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
          site_address, site_suburb, notes, job_number, pricing_json
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
      .select('id, type, pdf_url, storage_url, file_name, visible_to_trades, version, created_at')
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
  const { jobId, job_id, userId, user_id, text } = body
  const jId = jobId || job_id
  const uId = userId || user_id
  if (!jId || !text) throw new Error('jobId and text required')

  // Verify user is assigned to this job (admins bypass)
  if (uId) await assertAssigned(client, jId, uId, isAdmin)

  const { data, error } = await client.from('job_events').insert({
    job_id: jId,
    user_id: userId || user_id || null,
    event_type: 'note',
    detail_json: { text },
  }).select().single()

  if (error) throw error

  // Dual-write to business_events
  logBusinessEvent(client, {
    event_type: 'note.added',
    source: 'app/field',
    entity_type: 'job',
    entity_id: jId,
    job_id: jId,
    correlation_id: jId,
    payload: {
      entity: { id: jId },
      related_entities: [{ type: 'user', id: uId || null }],
    },
  })

  return { note: data }
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

  const allowedTypes = ['work_order', 'quote', 'approval', 'site_photo', 'general', 'supplier_quote', 'council_plans', 'engineering', 'client_reference', 'asbestos', 'other']
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

  // Default visibility: on for site_photo, council_plans, engineering, work_order. Off for supplier_quote, quote
  const defaultVisible = ['site_photo', 'council_plans', 'engineering', 'work_order', 'approval'].includes(type)
  const isVisible = visible_to_trades != null ? visible_to_trades : defaultVisible

  const allowedTypes = ['work_order', 'quote', 'approval', 'site_photo', 'general', 'supplier_quote', 'council_plans', 'engineering', 'client_reference', 'asbestos', 'other']
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

// ── Signed upload URL (trade uploads photo directly to Storage) ──
async function getUploadUrl(client: any, body: any, userId: string, isAdmin = false) {
  const { jobId, job_id, fileName, contentType } = body
  const jId = jobId || job_id
  if (!jId || !fileName) throw new Error('jobId and fileName required')

  // Verify user is assigned to this job (admins bypass)
  await assertAssigned(client, jId, userId, isAdmin)

  const bucket = 'job-photos'
  const photoId = crypto.randomUUID()
  const ext = fileName.split('.').pop() || 'jpg'
  const path = `${DEFAULT_ORG_ID}/${jId}/photos/${photoId}.${ext}`

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
  }
}

// ── Confirm upload (create media record after direct upload) ──
async function confirmUpload(client: any, body: any, userId: string, isAdmin = false) {
  const { jobId, job_id, publicUrl, path, label, phase, po_id } = body
  const jId = jobId || job_id
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
  // Default to this week if no dates provided (prevents 500 errors from agent calls)
  const today = new Date().toISOString().split('T')[0]
  const weekOut = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]
  const startDate = params.get('start_date') || params.get('from') || params.get('date') || today
  const endDate = params.get('end_date') || params.get('to') || weekOut

  // Fetch availability rows
  const { data: rows, error } = await client
    .from('crew_availability')
    .select('id, user_id, date, status, note, created_at')
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true })

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

  let query = client.from('ai_proposed_actions')
    .select('*, jobs:job_id(job_number, client_name, type)')
    .eq('status', status)
    .lt('expires_at', new Date(Date.now() + 48 * 3600000).toISOString()) // not expired
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(50)

  if (actionType) query = query.eq('action_type', actionType)

  const { data, error } = await query
  if (error) {
    // Table may not exist yet — return empty instead of 500
    console.log('[ops-api] ai_proposed_actions query failed (table may not exist):', error.message)
    return { actions: [] }
  }

  return {
    actions: (data || []).map((a: any) => ({
      ...a,
      job_number: a.jobs?.job_number || null,
      job_type: a.jobs?.type || null,
      jobs: undefined,
    })),
  }
}

async function sendProposedSms(client: any, body: any) {
  const { action_id } = body
  if (!action_id) throw new Error('action_id required')

  // Get the proposed action
  const { data: action, error } = await client.from('ai_proposed_actions')
    .select('*')
    .eq('id', action_id)
    .eq('status', 'pending')
    .single()

  if (error || !action) throw new Error('Action not found or already processed')

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
    .eq('id', action_id)

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

async function dismissProposedAction(client: any, body: any) {
  const { action_id, user_id } = body
  if (!action_id) throw new Error('action_id required')

  const { error } = await client.from('ai_proposed_actions')
    .update({
      status: 'dismissed',
      dismissed_at: new Date().toISOString(),
      dismissed_by: user_id || null,
    })
    .eq('id', action_id)
    .eq('status', 'pending')

  if (error) throw error
  return { success: true, action_id }
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

async function submitExpense(client: any, body: any) {
  const { job_id, receipt_photo_url, submitted_by, po_id } = body
  if (!receipt_photo_url) throw new Error('receipt_photo_url required')

  // Insert receipt FIRST — saved regardless of AI extraction success
  const { data: expense, error: insertErr } = await client.from('expense_receipts').insert({
    org_id: DEFAULT_ORG_ID,
    job_id: job_id || null,
    po_id: po_id || null,
    submitted_by: submitted_by || null,
    receipt_photo_url,
    status: 'pending_extraction',
    match_type: job_id ? 'ad_hoc' : 'non_job',
    expense_tier: job_id ? 'tier_2' : 'tier_3',
    approval_routed_to: job_id ? 'shaun' : 'jan',
  }).select('id').single()
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

          // Update expense with extracted data
          const updateFields: any = {
            vendor_name: extraction.vendor_name || null,
            receipt_date: extraction.receipt_date || null,
            total_amount: extraction.total_amount ? Number(extraction.total_amount) : null,
            gst_amount: extraction.gst_amount ? Number(extraction.gst_amount) : null,
            line_items: extraction.line_items || [],
            extraction_raw: visionResult,
            extraction_confidence: 0.8,
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
    payload: { extraction, routed_to: routedTo },
    metadata: { operator: submitted_by || null },
  })

  return {
    expense_id: expense.id,
    extraction,
    status: extraction ? 'pending' : 'pending_extraction',
    routed_to: routedTo,
  }
}

async function approveExpense(client: any, body: any) {
  const { expense_id, approved_by, approved } = body
  if (!expense_id) throw new Error('expense_id required')

  const status = approved === false ? 'queried' : 'approved'
  await client.from('expense_receipts').update({
    status,
    approved_by: approved_by || null,
    approved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', expense_id)

  // Resolve the annotation
  await client.from('ai_annotations')
    .update({ resolved_at: new Date().toISOString(), resolved_by: approved_by || null })
    .eq('source_ref', `expense:${expense_id}`)
    .is('resolved_at', null)

  logBusinessEvent(client, {
    event_type: `expense.${status}`,
    entity_type: 'expense_receipt',
    entity_id: expense_id,
    metadata: { operator: approved_by || null },
  })

  return { success: true, status }
}

async function pushExpenseToXero(client: any, body: any) {
  const { expense_id } = body
  if (!expense_id) throw new Error('expense_id required')

  const { data: expense } = await client.from('expense_receipts')
    .select('*, jobs:job_id(job_number, xero_contact_id)')
    .eq('id', expense_id)
    .single()
  if (!expense) throw new Error('Expense not found')
  if (expense.status !== 'approved') throw new Error('Expense must be approved before pushing to Xero')

  const { accessToken, tenantId } = await getToken(client)

  const billBody = {
    Type: 'ACCPAY',
    Contact: { Name: expense.vendor_name || 'Unknown Vendor' },
    Date: expense.receipt_date || new Date().toISOString().split('T')[0],
    DueDate: expense.receipt_date || new Date().toISOString().split('T')[0],
    Reference: expense.jobs?.job_number ? `${expense.jobs.job_number} — Receipt` : 'Receipt',
    LineItems: (expense.line_items || []).length > 0
      ? expense.line_items.map((li: any) => ({
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

  const result = await xeroPost('/Invoices', accessToken, tenantId, { Invoices: [billBody] }, 'POST', `expense-${expense_id}`)
  const xeroBillId = result?.Invoices?.[0]?.InvoiceID

  await client.from('expense_receipts').update({
    xero_bill_id: xeroBillId,
    status: 'pushed_to_xero',
    updated_at: new Date().toISOString(),
  }).eq('id', expense_id)

  logBusinessEvent(client, {
    event_type: 'expense.pushed_to_xero',
    entity_type: 'expense_receipt',
    entity_id: expense_id,
    payload: { xero_bill_id: xeroBillId },
  })

  return { success: true, xero_bill_id: xeroBillId }
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
  const viewUrl = `https://marninms98-dotcom.github.io/securedash/quote-viewer.html?token=${variation.share_token}&type=variation`

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
      xero_contact_id: inv.xero_contact_id,
      invoice_number: inv.invoice_number,
      reference: inv.reference,
      contact_name: inv.contact_name,
      amount_due: inv.amount_due,
      total: inv.total,
      due_date: inv.due_date,
      invoice_date: inv.invoice_date,
      days_overdue: daysOverdue,
      age_bucket: daysOverdue <= 30 ? '1-30' : daysOverdue <= 60 ? '31-60' : daysOverdue <= 90 ? '61-90' : '90+',
      classification,
      classification_reason: classificationReason,
      auto_classified: autoClassified,
      classified_by: inv.debt_classified_by,
      classified_at: inv.debt_classified_at,
      job_id: inv.job_id,
      job_number: job?.job_number || null,
      job_type: job?.type || null,
      job_status: job?.status || null,
      ghl_contact_id,
      ghl_opportunity_id: job?.ghl_opportunity_id || null,
      phone,
      email,
      site_address: job?.site_address || null,
      site_suburb: job?.site_suburb || null,
      invoice_status: inv.status || null,
      amount_paid: inv.amount_paid || 0,
      job_created_at: job?.created_at || null,
      job_quoted_at: job?.quoted_at || null,
      job_accepted_at: job?.accepted_at || null,
      job_scheduled_at: job?.scheduled_at || null,
      job_completed_at: job?.completed_at || null,
      days_since_completion: job?.completed_at ? Math.ceil((Date.now() - new Date(job.completed_at).getTime()) / 86400000) : null,
      chase_logs: chaseMap[inv.xero_invoice_id] || [],
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
        clientMap[key].paid_invoices.push({
          invoice_number: pi.invoice_number,
          total: pi.total,
          amount_paid: pi.amount_paid,
          fully_paid_on: pi.fully_paid_on,
          invoice_date: pi.invoice_date,
          reference: pi.reference,
          job_id: pi.job_id,
        })
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
  const { ghl_contact_id, xero_invoice_id, job_id, message, operator_email } = body
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

  // Log the chase
  await client.from('payment_chase_logs').insert({
    xero_invoice_id: xero_invoice_id || null,
    job_id: job_id || null,
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
