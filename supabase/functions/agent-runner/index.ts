// ════════════════════════════════════════════════════════════
// SecureWorks — Agent Runner (Free-Rein Natural Language Agent)
//
// Multi-turn autonomous agent that understands natural language
// and executes multi-step workflows. Replaces single-turn ops-ai
// for dashboard chat. Keeps going until the job is done.
//
// Deploy:
//   /Users/marninstobbe/.local/bin/supabase functions deploy agent-runner --no-verify-jwt
//
// Required secrets:
//   ANTHROPIC_API_KEY, SW_API_KEY
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || ''
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

// AWST = UTC+8
const AWST_OFFSET_MS = 8 * 60 * 60 * 1000
function awstNow(): Date { return new Date(Date.now() + AWST_OFFSET_MS) }
function awstDate(): string { return awstNow().toISOString().slice(0, 10) }

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

function sbClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
}

// ════════════════════════════════════════════════════════════
// INTERNAL API CALLERS
// ════════════════════════════════════════════════════════════

async function callOpsApi(action: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${SUPABASE_URL}/functions/v1/ops-api`)
  url.searchParams.set('action', action)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const resp = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
  })
  return resp.json()
}

async function postOpsApi(action: string, body: any): Promise<any> {
  const url = new URL(`${SUPABASE_URL}/functions/v1/ops-api`)
  url.searchParams.set('action', action)
  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify(body),
  })
  return resp.json()
}

async function callReportingApi(action: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${SUPABASE_URL}/functions/v1/reporting-api`)
  url.searchParams.set('action', action)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const resp = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
  })
  return resp.json()
}

async function callGhlProxy(action: string, body?: any): Promise<any> {
  const url = new URL(`${SUPABASE_URL}/functions/v1/ghl-proxy`)
  url.searchParams.set('action', action)
  const opts: RequestInit = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  }
  if (body) {
    opts.method = 'POST'
    opts.body = JSON.stringify(body)
  }
  const resp = await fetch(url.toString(), opts)
  return resp.json()
}

// ════════════════════════════════════════════════════════════
// CALLER CONTEXT
// ════════════════════════════════════════════════════════════

interface CallerContext {
  user_id: string | null
  user_name: string
  user_email: string
  user_role: 'crew' | 'lead_installer' | 'division_ops' | 'sales' | 'admin'
  channel: 'dashboard' | 'telegram_group' | 'telegram_dm' | 'ceo_dashboard' | 'scheduled'
  org_id: string
}

function resolveRole(email: string): CallerContext['user_role'] {
  const e = (email || '').toLowerCase()
  if (e.includes('marnin') || e.includes('shaun') || e.includes('jan')) return 'admin'
  if (e.includes('henry')) return 'division_ops'
  if (e.includes('nathan') || e.includes('khairo')) return 'sales'
  if (e.includes('isaac')) return 'lead_installer'
  return 'crew'
}

// ════════════════════════════════════════════════════════════
// TOOL DEFINITIONS — Complete set for free-rein agent
// ════════════════════════════════════════════════════════════

const ALL_TOOLS = [
  // ── READ: Jobs & Pipeline ──
  {
    name: 'search_jobs',
    description: 'Search jobs by name, status, type, or suburb. Returns matching jobs with key details.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter: accepted, scheduled, in_progress, complete, invoiced, cancelled' },
        type: { type: 'string', description: 'Filter: fencing, patio, combo, decking, renovation, insurance, roofing' },
        search: { type: 'string', description: 'Search client name, suburb, or job number' },
      },
    },
  },
  {
    name: 'get_job_detail',
    description: 'Full detail for a job: assignments, POs, WOs, invoices, activity log, contact info.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'get_schedule',
    description: 'Calendar: who is working where and when for a date range.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date (YYYY-MM-DD). Default: today.' },
        to: { type: 'string', description: 'End date (YYYY-MM-DD). Default: +7 days.' },
      },
    },
  },
  {
    name: 'get_attention_items',
    description: 'Today\'s ops summary: attention items, schedule, stat cards.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_invoices',
    description: 'Search Xero invoices. ACCREC = sales, ACCPAY = bills.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'ACCREC or ACCPAY. Default: ACCREC' },
        status: { type: 'string', description: 'DRAFT, SUBMITTED, AUTHORISED, PAID, OVERDUE' },
        search: { type: 'string', description: 'Contact name or reference' },
      },
    },
  },

  // ── READ: CEO / Financial ──
  {
    name: 'get_dashboard_summary',
    description: 'Revenue MTD, margin, gross profit, AR aging, pipeline forecast, revenue by type.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_job_profitability',
    description: 'Per-job P&L from Xero Projects: revenue, costs, margin.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by job type' },
        min_revenue: { type: 'number', description: 'Minimum revenue threshold' },
      },
    },
  },
  {
    name: 'get_marketing_summary',
    description: 'Google Ads: CPL, CPA, PPAD, win rate, campaign performance.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_trends',
    description: '12-month trends: revenue, costs, margin, win rate, deal size.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_sales_breakdown',
    description: 'Revenue by job type, suburb, pipeline velocity, quote accuracy.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_debt_followup',
    description: 'Outstanding receivables by client with contact details and age buckets.',
    input_schema: { type: 'object', properties: {} },
  },

  // ── READ: Intelligence ──
  {
    name: 'revenue_forecast',
    description: 'Forecast next 30/60/90 days from pipeline + conversion rates.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Forecast period. Default: 90' } },
    },
  },
  {
    name: 'cash_flow_status',
    description: 'Cash position: outstanding invoices, expected payments, aged receivables.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'unbilled_revenue',
    description: 'Completed jobs with no invoice. Shows money sitting on the table.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_ai_alerts',
    description: 'Active AI alerts: overdue items, margin risks, scheduling conflicts.',
    input_schema: {
      type: 'object',
      properties: { severity: { type: 'string', description: 'red, amber, or all. Default: all' } },
    },
  },

  // ── READ: Contacts & Conversations ──
  {
    name: 'search_contacts',
    description: 'Search GHL contacts by name, phone, or email.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search term' } },
      required: ['query'],
    },
  },
  {
    name: 'get_contact_detail',
    description: 'Full GHL contact record with all fields.',
    input_schema: {
      type: 'object',
      properties: { contact_id: { type: 'string', description: 'GHL contact ID' } },
      required: ['contact_id'],
    },
  },
  {
    name: 'get_client_conversation',
    description: 'Read GHL conversation history (SMS, email, calls). Last 30 messages. Use before composing a reply.',
    input_schema: {
      type: 'object',
      properties: { contact_id: { type: 'string', description: 'GHL contact ID' } },
      required: ['contact_id'],
    },
  },
  {
    name: 'get_opportunities',
    description: 'List GHL pipeline opportunities.',
    input_schema: { type: 'object', properties: {} },
  },

  // ── WRITE: Actions (all require confirmation at L1) ──
  {
    name: 'send_sms',
    description: 'Send SMS to a client via GHL. At L1 autonomy this returns a confirmation card. Include the exact message text.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'GHL contact ID' },
        message: { type: 'string', description: 'Exact SMS text to send' },
        job_id: { type: 'string', description: 'Related job UUID for logging' },
      },
      required: ['contact_id', 'message'],
    },
  },
  {
    name: 'send_email',
    description: 'Send email to a client via GHL. At L1 this returns a confirmation card.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'GHL contact ID' },
        subject: { type: 'string', description: 'Email subject' },
        html_body: { type: 'string', description: 'Email body (HTML)' },
        job_id: { type: 'string', description: 'Related job UUID' },
      },
      required: ['contact_id', 'subject', 'html_body'],
    },
  },
  {
    name: 'create_assignment',
    description: 'Schedule a crew assignment. Returns confirmation card.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID' },
        scheduled_date: { type: 'string', description: 'Date (YYYY-MM-DD)' },
        scheduled_end: { type: 'string', description: 'End date if multi-day' },
        start_time: { type: 'string', description: 'HH:MM. Default: 07:00' },
        end_time: { type: 'string', description: 'HH:MM. Default: 15:00' },
        crew_name: { type: 'string', description: 'Crew or person name' },
        assignment_type: { type: 'string', description: 'install, scope, delivery, rectification, followup' },
        notes: { type: 'string', description: 'Optional notes' },
      },
      required: ['job_id', 'scheduled_date'],
    },
  },
  {
    name: 'update_job_status',
    description: 'Update job status. Valid: accepted->scheduled, scheduled->in_progress, in_progress->complete, complete->invoiced.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID' },
        status: { type: 'string', description: 'New status' },
      },
      required: ['job_id', 'status'],
    },
  },
  {
    name: 'complete_and_invoice',
    description: 'Mark job complete + create Xero invoice in one step. Returns confirmation card.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'create_invoice',
    description: 'Create a Xero invoice (deposit or full). Returns confirmation card.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID' },
        type: { type: 'string', description: 'deposit or full' },
        percentage: { type: 'number', description: 'Deposit %. Default: 50' },
      },
      required: ['job_id', 'type'],
    },
  },
  {
    name: 'create_po',
    description: 'Create a purchase order. Returns confirmation card.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID' },
        supplier: { type: 'string', description: 'Supplier name' },
        line_items: { type: 'array', description: 'PO line items', items: { type: 'object' } },
      },
      required: ['job_id', 'supplier', 'line_items'],
    },
  },
  {
    name: 'send_quote',
    description: 'Send quote PDF to client. Job must have scope/pricing data.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'push_po_to_xero',
    description: 'Push a local draft PO to Xero.',
    input_schema: {
      type: 'object',
      properties: {
        po_id: { type: 'string', description: 'PO UUID (must be draft)' },
        status: { type: 'string', description: 'DRAFT or AUTHORISED. Default: DRAFT' },
      },
      required: ['po_id'],
    },
  },
  {
    name: 'email_supplier_po',
    description: 'Email a PO to the supplier.',
    input_schema: {
      type: 'object',
      properties: {
        po_id: { type: 'string', description: 'PO UUID' },
        job_id: { type: 'string', description: 'Related job UUID' },
      },
      required: ['po_id'],
    },
  },
  {
    name: 'add_ghl_note',
    description: 'Add a note to a GHL contact record.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'GHL contact ID' },
        note_body: { type: 'string', description: 'Note content' },
        job_id: { type: 'string', description: 'Related job UUID' },
      },
      required: ['contact_id', 'note_body'],
    },
  },
  {
    name: 'send_telegram',
    description: 'Send Telegram message to a team member.',
    input_schema: {
      type: 'object',
      properties: {
        user_email: { type: 'string', description: 'Team member email' },
        user_name: { type: 'string', description: 'Team member name (alt lookup)' },
        message: { type: 'string', description: 'Message text' },
      },
      required: ['message'],
    },
  },

  // ── THINK: Internal reasoning step ──
  {
    name: 'think',
    description: 'Use this to reason through multi-step problems. Write your thinking here before taking action. This is NOT shown to the user — use it to plan your approach, check assumptions, and decide what to do next.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Your internal reasoning' },
      },
      required: ['reasoning'],
    },
  },
]

// Write actions that need confirmation (L1 autonomy)
const WRITE_ACTIONS = new Set([
  'send_sms', 'send_email', 'create_assignment', 'update_job_status',
  'complete_and_invoice', 'create_invoice', 'create_po', 'send_quote',
  'push_po_to_xero', 'email_supplier_po', 'add_ghl_note', 'send_telegram',
])

// ════════════════════════════════════════════════════════════
// TOOL EXECUTION
// ════════════════════════════════════════════════════════════

async function executeTool(name: string, input: any): Promise<{ result: any; needs_confirm?: boolean }> {
  // Internal reasoning — no side effects
  if (name === 'think') {
    return { result: { acknowledged: true } }
  }

  // ── READ operations ──
  switch (name) {
    case 'search_jobs': {
      const p: Record<string, string> = {}
      if (input.status) p.status = input.status
      if (input.type) p.type = input.type
      if (input.search) p.search = input.search
      return { result: await callOpsApi('pipeline', p) }
    }
    case 'get_job_detail':
      return { result: await callOpsApi('job_detail', { jobId: input.job_id }) }
    case 'get_schedule': {
      const from = input.from || awstDate()
      const to = input.to || new Date(new Date(from).getTime() + 7 * 86400000).toISOString().slice(0, 10)
      return { result: await callOpsApi('calendar', { from, to }) }
    }
    case 'get_attention_items':
      return { result: await callOpsApi('ops_summary') }
    case 'search_invoices': {
      const p: Record<string, string> = {}
      if (input.type) p.type = input.type
      if (input.status) p.status = input.status
      if (input.search) p.search = input.search
      return { result: await callOpsApi('list_invoices', p) }
    }
    case 'get_dashboard_summary':
      return { result: await callReportingApi('dashboard_summary') }
    case 'get_job_profitability': {
      const p: Record<string, string> = {}
      if (input.type) p.type = input.type
      if (input.min_revenue) p.min_revenue = String(input.min_revenue)
      return { result: await callReportingApi('job_profitability', p) }
    }
    case 'get_marketing_summary':
      return { result: await callReportingApi('marketing_summary') }
    case 'get_trends':
      return { result: await callReportingApi('trends') }
    case 'get_sales_breakdown':
      return { result: await callReportingApi('sales_breakdown') }
    case 'get_debt_followup':
      return { result: await callReportingApi('debt_followup') }
    case 'revenue_forecast':
      return { result: await callReportingApi('revenue_forecast', input.days ? { days: String(input.days) } : {}) }
    case 'cash_flow_status':
      return { result: await callReportingApi('cash_flow_status') }
    case 'unbilled_revenue':
      return { result: await callReportingApi('unbilled_revenue') }
    case 'get_ai_alerts': {
      const p: Record<string, string> = {}
      if (input.severity) p.severity = input.severity
      return { result: await callOpsApi('annotations', p) }
    }
    case 'search_contacts':
      return { result: await callGhlProxy('search_contacts', { query: input.query }) }
    case 'get_contact_detail':
      return { result: await callGhlProxy('get_contact', { contactId: input.contact_id }) }
    case 'get_client_conversation':
      return { result: await callGhlProxy('get_conversation', { contactId: input.contact_id }) }
    case 'get_opportunities':
      return { result: await callGhlProxy('list_opportunities') }
  }

  // ── WRITE operations — return confirmation card (L1 autonomy) ──
  if (WRITE_ACTIONS.has(name)) {
    return {
      needs_confirm: true,
      result: buildConfirmationCard(name, input),
    }
  }

  return { result: { error: `Unknown tool: ${name}` } }
}

function buildConfirmationCard(action: string, params: any): any {
  const labels: Record<string, string> = {
    send_sms: `Send SMS to contact: "${(params.message || '').slice(0, 80)}..."`,
    send_email: `Send email: "${params.subject}"`,
    create_assignment: `Schedule ${params.crew_name || 'crew'} on ${params.scheduled_date}`,
    update_job_status: `Update job status to "${params.status}"`,
    complete_and_invoice: `Mark job complete and create Xero invoice (DRAFT)`,
    create_invoice: `Create ${params.type} invoice`,
    create_po: `Create PO for ${params.supplier}`,
    send_quote: `Send quote PDF to client`,
    push_po_to_xero: `Push PO to Xero as ${params.status || 'DRAFT'}`,
    email_supplier_po: `Email PO to supplier`,
    add_ghl_note: `Add note to contact record`,
    send_telegram: `Send Telegram to ${params.user_name || params.user_email || 'team member'}`,
  }

  return {
    action,
    params,
    message: labels[action] || `Execute ${action}?`,
  }
}

// ════════════════════════════════════════════════════════════
// SAFETY RULES
// ════════════════════════════════════════════════════════════

async function checkSafety(toolName: string, input: any, caller: CallerContext): Promise<{ allowed: boolean; reason?: string }> {
  // No deletes
  if (toolName.includes('delete')) {
    return { allowed: false, reason: "Cannot delete records. Use cancel/archive instead." }
  }

  // $20K+ requires admin
  const amount = Number(input.amount || input.total || 0)
  if (amount > 20000 && caller.user_role !== 'admin') {
    return { allowed: false, reason: 'Amounts over $20,000 require admin approval.' }
  }

  // Invoice creation = admin only
  if (['create_invoice', 'complete_and_invoice'].includes(toolName) && caller.user_role !== 'admin') {
    return { allowed: false, reason: 'Invoice creation restricted to admin (Marnin, Shaun, Jan).' }
  }

  // Check action_permissions table for blocked actions
  if (WRITE_ACTIONS.has(toolName)) {
    try {
      const sb = sbClient()
      const { data: perm } = await sb.from('action_permissions')
        .select('autonomy_level')
        .eq('action_type', toolName)
        .maybeSingle()
      if (perm?.autonomy_level === 'block') {
        return { allowed: false, reason: `Action "${toolName}" is blocked by policy.` }
      }
    } catch { /* table may not exist */ }
  }

  return { allowed: true }
}

// ════════════════════════════════════════════════════════════
// SYSTEM PROMPT — Free-rein agent personality
// ════════════════════════════════════════════════════════════

function buildSystemPrompt(view: string, caller: CallerContext, context: any): string {
  const today = awstDate()
  const dayName = awstNow().toLocaleDateString('en-AU', { weekday: 'long' })

  return `You are the SecureWorks operations agent. You run the business.

Date: ${dayName}, ${today} (AWST, Perth)
Caller: ${caller.user_name} (${caller.user_role})
View: ${view}

IDENTITY: You are a competent, direct operations manager who knows the business intimately. You don't just answer questions — you investigate, cross-reference, and take action. When someone says "chase the Smiths" you find their job, check their invoice status, read their conversation history, draft an appropriate message, and present it for approval. All in one go.

TARGETS: $180K revenue/mo | 30% margin | 15 jobs/mo | $5K marketing
JOB NUMBERS: SWF=Fencing, SWP=Patio, SWD=Decking, SWR=Renovation, SWI=Insurance

HOW TO WORK:
1. Use the "think" tool to plan multi-step workflows before acting. Break complex requests into steps.
2. Gather ALL relevant data before responding. If chasing a debtor: get their job, invoices, AND conversation history.
3. For write actions: show the user what you'll do and let them confirm. Never execute silently.
4. Keep going until the task is DONE. Don't stop after one tool call if the job needs more.
5. If you hit a dead end, say so and suggest what the user can do instead.

RESPONSE RULES:
- Task first, context second. Under 6 sentences unless they ask for detail.
- No emojis. No dramatic formatting. No "As your AI assistant..." — just do the work.
- Reference specific job numbers, names, dollar amounts. If you lack data, say so.
- When proposing an action: what + why + confirm. Three lines max.
- Currency: $X,XXX (AUD).

MULTI-STEP PATTERNS:
- "Chase [client]" → search jobs → get invoices → get conversation → draft SMS → present for approval
- "What needs doing?" → get attention items → get schedule → get overdue invoices → prioritised list of 5 actions
- "Invoice completed jobs" → search jobs status=complete → for each, complete_and_invoice → batch confirmation
- "How's cash?" → cash_flow_status + unbilled_revenue + debt_followup → one coherent answer

FINANCIAL INTELLIGENCE: When asked about money/profit/cash:
- Run unbilled_revenue first (most common cash gap)
- Cross-reference Xero data with job data for accuracy
- Mention Xero sync age if available

${view === 'ops' ? `OPS FOCUS for ${caller.user_name}: scheduling, crew coordination, POs, material deliveries, job tracking, bottlenecks.` : ''}
${view === 'ceo' ? `CEO FOCUS for ${caller.user_name}: revenue vs $180K pace, margin vs 30%, pipeline health, marketing ROI, cash flow.` : ''}
${view === 'sales' ? `SALES FOCUS for ${caller.user_name}: pipeline, follow-ups, lead conversion, personal KPIs.` : ''}

CURRENT CONTEXT:
${context ? JSON.stringify(context, null, 2) : 'No pre-loaded context. Use tools to fetch what you need.'}
`
}

// ════════════════════════════════════════════════════════════
// AUTO-CONTEXT — light data pull based on view
// ════════════════════════════════════════════════════════════

async function getAutoContext(view: string): Promise<any> {
  try {
    if (view === 'ops') {
      const summary = await callOpsApi('ops_summary')
      return {
        today_schedule: (summary.schedule || []).slice(0, 8).map((s: any) => ({
          client: s.client_name, suburb: s.site_suburb, type: s.assignment_type,
          crew: s.crew_name, status: s.status,
        })),
        stats: summary.stats,
        attention_count: (summary.attention || []).length,
      }
    }
    const summary = await callReportingApi('dashboard_summary')
    return {
      revenue_mtd: summary.stats?.revenue_mtd,
      margin_pct: summary.stats?.margin_pct,
      pipeline_weighted: summary.pipeline_forecast?.weighted_pipeline,
      aged_receivables: summary.aged_receivables,
    }
  } catch (err) {
    console.error('[agent-runner] auto-context error:', err)
    return null
  }
}

// ════════════════════════════════════════════════════════════
// EXECUTION LOGGING
// ════════════════════════════════════════════════════════════

async function logExecution(data: {
  caller: CallerContext
  query: string
  tools_used: string[]
  action_cards: number
  total_input_tokens: number
  total_output_tokens: number
  rounds: number
  latency_ms: number
  cost_usd: number
}) {
  try {
    const sb = sbClient()
    await sb.from('ai_reasoning_traces').insert({
      org_id: DEFAULT_ORG_ID,
      trigger_type: data.caller.channel === 'scheduled' ? 'scheduled' : 'user_query',
      model_name: 'claude-sonnet-4-20250514',
      input_snapshot: {
        query: data.query,
        caller: { name: data.caller.user_name, role: data.caller.user_role },
        tools_called: data.tools_used,
      },
      output_type: data.action_cards > 0 ? 'action_proposal' : 'informational',
      input_tokens: data.total_input_tokens,
      output_tokens: data.total_output_tokens,
      cost_usd: data.cost_usd,
      iteration_count: data.rounds,
      latency_ms: data.latency_ms,
      status: 'completed',
    })
  } catch (e) {
    console.log('[agent-runner] log failed:', (e as Error).message)
  }
}

// ════════════════════════════════════════════════════════════
// CONFIRM ACTION HANDLER — execute approved actions
// ════════════════════════════════════════════════════════════

async function executeConfirmedAction(action: string, params: any): Promise<any> {
  switch (action) {
    case 'send_sms':
      return await callGhlProxy('send_sms', params)
    case 'send_email':
      return await callGhlProxy('send_email', params)
    case 'create_assignment':
      return await postOpsApi('create_assignment', params)
    case 'update_job_status':
      return await postOpsApi('update_job_status', { jobId: params.job_id, status: params.status })
    case 'complete_and_invoice':
      return await postOpsApi('complete_and_invoice', { job_id: params.job_id, xero_status: 'DRAFT', send_email: false })
    case 'create_invoice':
      return await postOpsApi(params.type === 'deposit' ? 'create_deposit_invoice' : 'create_unified_invoice', params)
    case 'create_po':
      return await postOpsApi('create_po', params)
    case 'send_quote': {
      const url = new URL(`${SUPABASE_URL}/functions/v1/send-quote`)
      const resp = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
        body: JSON.stringify({ jobId: params.job_id }),
      })
      return await resp.json()
    }
    case 'push_po_to_xero':
      return await postOpsApi('push_po_to_xero', { id: params.po_id, status: params.status })
    case 'email_supplier_po':
      return await postOpsApi('email_po', { id: params.po_id })
    case 'add_ghl_note':
      return await callGhlProxy('add_note', params)
    case 'send_telegram': {
      const sb = sbClient()
      let telegramId: number | null = null
      if (params.user_email) {
        const { data } = await sb.from('users').select('telegram_id').ilike('email', `%${params.user_email}%`).limit(1).maybeSingle()
        telegramId = data?.telegram_id
      } else if (params.user_name) {
        const { data } = await sb.from('users').select('telegram_id').ilike('full_name', `%${params.user_name}%`).limit(1).maybeSingle()
        telegramId = data?.telegram_id
      }
      if (!telegramId) return { error: 'Could not find Telegram ID for this user' }
      const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
      if (!botToken) return { error: 'Telegram bot token not configured' }
      const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramId, text: params.message, parse_mode: 'HTML' }),
      })
      return await resp.json()
    }
    default:
      return { error: `Unknown action: ${action}` }
  }
}

// ════════════════════════════════════════════════════════════
// MAIN HANDLER — The Agent Loop
// ════════════════════════════════════════════════════════════

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  // ── Auth (same as ops-ai) ──
  const validKey = Deno.env.get('SW_API_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const xApiKey = req.headers.get('x-api-key')
  const authHeader = req.headers.get('authorization')
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

  let isAuthed = false
  if (xApiKey && (xApiKey === validKey || xApiKey === serviceKey)) isAuthed = true
  else if (bearerToken && (bearerToken === validKey || bearerToken === serviceKey)) isAuthed = true
  else if (bearerToken) {
    try {
      const authClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const { data: { user }, error } = await authClient.auth.getUser(bearerToken)
      if (!error && user) isAuthed = true
    } catch { /* invalid token */ }
  }
  if (!isAuthed) return json({ error: 'Unauthorized' }, 401)
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500)

  try {
    const body = await req.json()
    const { messages, view = 'ops', confirm_action, caller_context, mode } = body

    // Build caller context
    const caller: CallerContext = caller_context || {
      user_id: null,
      user_name: view === 'ops' ? 'Shaun' : 'Marnin',
      user_email: view === 'ops' ? 'shaun@secureworkswa.com.au' : 'marnin@secureworkswa.com.au',
      user_role: 'admin' as const,
      channel: (view === 'ceo' ? 'ceo_dashboard' : 'dashboard') as CallerContext['channel'],
      org_id: DEFAULT_ORG_ID,
    }

    // ── Handle confirmed actions ──
    if (confirm_action) {
      const { action, params } = confirm_action
      const result = await executeConfirmedAction(action, params)

      // Log approval
      try {
        const sb = sbClient()
        await sb.from('ai_feedback_outcomes').insert({
          human_action: 'approved',
          human_action_at: new Date().toISOString(),
          actual_outcome: result,
          feedback_category: action,
        })
      } catch { /* non-blocking */ }

      return json({ role: 'assistant', content: `Done. ${JSON.stringify(result)}`, confirmed_result: result })
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return json({ error: 'messages array required' }, 400)
    }

    // ── Scheduled mode: concise digest ──
    const isScheduled = mode === 'digest' || caller.channel === 'scheduled'

    // Pull auto-context
    const context = await getAutoContext(view)
    const systemPrompt = buildSystemPrompt(view, caller, context)

    // Build conversation
    let anthropicMessages = messages.map((m: any) => ({
      role: m.role,
      content: m.content,
    }))

    // ── THE AGENT LOOP ──
    // Keep going until Claude gives a final text answer or we hit the limit.
    // 15 rounds = 15 tool calls max per request. Enough for complex multi-step.
    const MAX_ROUNDS = 15
    let finalResponse = ''
    const actionCards: any[] = []
    const toolsUsed: string[] = []
    let totalInputTokens = 0
    let totalOutputTokens = 0
    const startTime = Date.now()

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: anthropicMessages,
          tools: ALL_TOOLS,
        }),
      })

      if (!resp.ok) {
        const errText = await resp.text()
        console.error('[agent-runner] API error:', resp.status, errText)

        // Retry without prompt caching on 400
        if (resp.status === 400 && round === 0) {
          const retryResp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 4096,
              system: systemPrompt,
              messages: anthropicMessages,
              tools: ALL_TOOLS,
            }),
          })
          if (retryResp.ok) {
            const retryResult = await retryResp.json()
            totalInputTokens += retryResult.usage?.input_tokens || 0
            totalOutputTokens += retryResult.usage?.output_tokens || 0
            for (const block of retryResult.content) {
              if (block.type === 'text') finalResponse += block.text
            }
            if (finalResponse) break
          }
        }
        return json({ error: `AI service error (${resp.status})` }, 502)
      }

      const result = await resp.json()
      totalInputTokens += result.usage?.input_tokens || 0
      totalOutputTokens += result.usage?.output_tokens || 0

      // Check for text + tool use
      let hasToolUse = false
      let roundText = ''
      const toolResults: any[] = []

      for (const block of result.content) {
        if (block.type === 'text') roundText += block.text
        if (block.type === 'tool_use') hasToolUse = true
      }

      // No tool use = final answer
      if (!hasToolUse) {
        finalResponse = roundText
        break
      }

      // Execute tool calls
      for (const block of result.content) {
        if (block.type !== 'tool_use') continue

        toolsUsed.push(block.name)

        // Safety check
        const safety = await checkSafety(block.name, block.input, caller)
        if (!safety.allowed) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ blocked: true, reason: safety.reason }),
          })
          continue
        }

        const { result: toolResult, needs_confirm } = await executeTool(block.name, block.input)

        if (needs_confirm) {
          actionCards.push(toolResult)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({
              pending_confirmation: true,
              message: toolResult.message,
              note: 'This action requires user confirmation. Present it clearly and continue with remaining work.',
            }),
          })
        } else {
          let resultStr = JSON.stringify(toolResult)
          if (resultStr.length > 12000) resultStr = resultStr.slice(0, 12000) + '... (truncated)'
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: resultStr,
          })
        }
      }

      // Continue the conversation
      anthropicMessages.push({ role: 'assistant', content: result.content })
      anthropicMessages.push({ role: 'user', content: toolResults })
    }

    // ── Log execution ──
    const latencyMs = Date.now() - startTime
    const costUsd = (totalInputTokens * 0.003 / 1000) + (totalOutputTokens * 0.015 / 1000)
    const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user')

    logExecution({
      caller,
      query: typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg?.content),
      tools_used: toolsUsed,
      action_cards: actionCards.length,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      rounds: toolsUsed.length,
      latency_ms: latencyMs,
      cost_usd: costUsd,
    })

    console.log(`[agent-runner] ${caller.user_name} | ${toolsUsed.length} tools | ${Math.round(latencyMs / 1000)}s | $${costUsd.toFixed(4)}`)

    return json({
      role: 'assistant',
      content: finalResponse,
      action_cards: actionCards.length > 0 ? actionCards : undefined,
      meta: {
        tools_used: toolsUsed,
        rounds: toolsUsed.length,
        cost_usd: costUsd,
        latency_ms: latencyMs,
      },
    })

  } catch (err) {
    console.error('[agent-runner] ERROR:', err)
    return json({ error: (err as Error).message || 'Internal error' }, 500)
  }
})
