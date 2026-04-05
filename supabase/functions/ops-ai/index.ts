// ════════════════════════════════════════════════════════════
// SecureWorks — Ops AI Edge Function
//
// Claude AI assistant for Ops + CEO dashboards.
// Receives chat messages, auto-pulls relevant context,
// and uses tool_use to query ops-api / reporting-api.
//
// Deploy:
//   /Users/marninstobbe/.local/bin/supabase functions deploy ops-ai --no-verify-jwt
//
// Required secret:
//   ANTHROPIC_API_KEY — set via: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || ''
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

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

// Fetch with timeout — prevents hanging on unresponsive external APIs
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Request to ${url.split('?')[0]} timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// AWST = UTC+8
const AWST_OFFSET_MS = 8 * 60 * 60 * 1000
function awstNow(): Date { return new Date(Date.now() + AWST_OFFSET_MS) }
function awstDate(): string { return awstNow().toISOString().slice(0, 10) }

// ════════════════════════════════════════════════════════════
// CALLER CONTEXT — role-based access control
// ════════════════════════════════════════════════════════════

interface CallerContext {
  user_id: string | null
  user_name: string
  user_email: string
  user_role: 'crew' | 'lead_installer' | 'division_ops' | 'sales' | 'admin'
  channel: 'dashboard' | 'telegram_group' | 'telegram_dm' | 'ceo_dashboard' | 'canary_test'
  org_id: string
  recent_messages?: string[]
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
// INTERNAL API CALLERS — call ops-api / reporting-api directly
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

function sbClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
}

async function callGhlProxy(action: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${SUPABASE_URL}/functions/v1/ghl-proxy`)
  url.searchParams.set('action', action)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const resp = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
  })
  return resp.json()
}

// ════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ════════════════════════════════════════════════════════════

// Ops-view tools — scheduling, POs, WOs, trade coordination
const OPS_TOOLS = [
  {
    name: 'search_jobs',
    description: 'Search jobs by name, status, type, or suburb. Returns a list of matching jobs with key details.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: accepted, scheduled, in_progress, complete, invoiced, cancelled' },
        type: { type: 'string', description: 'Filter by type: fencing, patio, combo, decking, renovation, insurance, roofing' },
        search: { type: 'string', description: 'Search term to match against client name, suburb, or job number' },
      },
    },
  },
  {
    name: 'get_schedule',
    description: 'Get calendar events/assignments for a date range. Shows who is working where and when.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date (YYYY-MM-DD). Defaults to today.' },
        to: { type: 'string', description: 'End date (YYYY-MM-DD). Defaults to 7 days from start.' },
      },
    },
  },
  {
    name: 'get_job_detail',
    description: 'Get full detail for a specific job including assignments, POs, WOs, invoices, and activity log.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job UUID' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'search_invoices',
    description: 'Search Xero invoices by type (ACCREC for sales, ACCPAY for bills), status, or contact name.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'ACCREC (sales) or ACCPAY (bills). Default: ACCREC' },
        status: { type: 'string', description: 'Filter: DRAFT, SUBMITTED, AUTHORISED, PAID, OVERDUE' },
        search: { type: 'string', description: 'Search term for contact name or reference' },
      },
    },
  },
  {
    name: 'get_attention_items',
    description: 'Get today\'s ops summary including attention items, schedule, and stat cards.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_assignment',
    description: 'Schedule a job assignment on the calendar. REQUIRES USER CONFIRMATION before executing.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID to schedule' },
        scheduled_date: { type: 'string', description: 'Date (YYYY-MM-DD)' },
        scheduled_end: { type: 'string', description: 'End date if multi-day (YYYY-MM-DD)' },
        start_time: { type: 'string', description: 'Start time (HH:MM). Default: 07:00' },
        end_time: { type: 'string', description: 'End time (HH:MM). Default: 15:00' },
        crew_name: { type: 'string', description: 'Crew or person name' },
        assignment_type: { type: 'string', description: 'Type: install, scope, delivery, rectification, followup' },
        notes: { type: 'string', description: 'Optional notes' },
      },
      required: ['job_id', 'scheduled_date'],
    },
  },
  {
    name: 'update_job_status',
    description: 'Update a job\'s status. REQUIRES USER CONFIRMATION before executing. Valid transitions: accepted→scheduled, scheduled→in_progress, in_progress→complete, complete→invoiced.',
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
    name: 'draft_communication',
    description: 'Draft an email or SMS for a client or trade. Returns the text — does NOT send it. Use job data for context.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'email or sms' },
        recipient: { type: 'string', description: 'Who is this for (client name, trade name)' },
        purpose: { type: 'string', description: 'Purpose: quote_followup, schedule_confirm, completion_notice, payment_reminder, trade_instruction' },
        context: { type: 'string', description: 'Any additional context from the job' },
      },
      required: ['type', 'recipient', 'purpose'],
    },
  },
  {
    name: 'complete_and_invoice',
    description: 'Mark a job complete and create a Xero invoice in one step. REQUIRES USER CONFIRMATION. Uses pricing_json for line items.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID to complete and invoice' },
      },
      required: ['job_id'],
    },
  },
]

// CEO-view tools — financial analysis, strategy
const CEO_TOOLS = [
  {
    name: 'get_dashboard_summary',
    description: 'Get revenue MTD, margin, gross profit, AR aging, pipeline forecast, and revenue by type.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_job_profitability',
    description: 'Get per-job P&L from Xero Projects. Shows revenue, costs, margin for each job.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by job type: fencing, patio, etc.' },
        min_revenue: { type: 'number', description: 'Minimum revenue threshold' },
      },
    },
  },
  {
    name: 'get_marketing_summary',
    description: 'Get Google Ads metrics: CPL, CPA, PPAD, win rate, campaign performance, keywords, landing pages.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_trends',
    description: 'Get 12-month trends: revenue, costs, margin, win rate, deal size, Google Ads spend/CPL.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_sales_breakdown',
    description: 'Revenue by job type, suburb, pipeline velocity, quote accuracy.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_invoices',
    description: 'Search Xero invoices by type (ACCREC/ACCPAY), status, or contact name.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'ACCREC (sales) or ACCPAY (bills)' },
        status: { type: 'string', description: 'DRAFT, SUBMITTED, AUTHORISED, PAID, OVERDUE' },
        search: { type: 'string', description: 'Contact name or reference search' },
      },
    },
  },
  {
    name: 'get_debt_followup',
    description: 'Get outstanding receivables grouped by client with contact details and age buckets. Use search to find a specific client.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by client name (e.g. "Anthony Yeo"). Returns only matching clients.' },
      },
    },
  },
  {
    name: 'search_contacts',
    description: 'Search for a client/contact by name across all data sources (jobs, Xero invoices, contact matches). Returns contact details, phone, email, GHL ID, job count, and outstanding balance.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Client name to search for (partial match, case-insensitive)' },
      },
      required: ['name'],
    },
  },
]

// Intelligence tools — available to ALL views (ops, ceo, sales)
const INTELLIGENCE_TOOLS = [
  {
    name: 'analyse_profitability',
    description: 'Compare quoted margins vs actual margins across completed jobs. Group by job type, suburb, salesperson, or time period. Shows which areas are most/least profitable.',
    input_schema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', description: 'Group results by: type, suburb, salesperson, month. Default: type' },
        period_months: { type: 'number', description: 'Look back period in months. Default: 6' },
      },
    },
  },
  {
    name: 'revenue_forecast',
    description: 'Forecast revenue for next 30/60/90 days based on current pipeline, conversion rates, and scheduled jobs.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Forecast period in days. Default: 90' },
      },
    },
  },
  {
    name: 'supplier_analysis',
    description: 'Analyse PO data by supplier — delivery reliability, cost trends, average lead times. Generates supplier scorecards.',
    input_schema: {
      type: 'object',
      properties: {
        supplier_name: { type: 'string', description: 'Specific supplier to analyse, or omit for all' },
      },
    },
  },
  {
    name: 'sales_performance',
    description: 'Analyse salesperson metrics — close rate, average deal size, speed to quote, pipeline value. Compare people or periods.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Specific salesperson UUID, or omit for all' },
        period: { type: 'string', description: 'this_month, last_month, this_quarter, last_90_days. Default: last_90_days' },
      },
    },
  },
  {
    name: 'job_duration_analysis',
    description: 'Analyse how long jobs take from acceptance to completion. Identifies bottlenecks and outliers.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by job type: patio, fencing, combo, etc.' },
      },
    },
  },
  {
    name: 'cash_flow_status',
    description: 'Current cash position: outstanding invoices, expected payments, upcoming PO costs, aged receivables breakdown.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'estimate_accuracy_report',
    description: 'Compare quoted pricing vs actual costs for completed jobs. Identifies systematic quoting biases by material category, job type, and size.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by job type' },
        min_jobs: { type: 'number', description: 'Minimum completed jobs for statistical significance. Default: 5' },
      },
    },
  },
  {
    name: 'generate_pricing_recommendation',
    description: 'Based on estimate accuracy data, generate specific pricing adjustment recommendations for the scope tool.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'generate_sop',
    description: 'Generate a standard operating procedure based on how the best-performing jobs actually flowed through the system.',
    input_schema: {
      type: 'object',
      properties: {
        process: { type: 'string', description: 'Process name: material_ordering, job_scheduling, client_followup, quoting, invoicing, completion' },
      },
      required: ['process'],
    },
  },
  {
    name: 'get_ai_alerts',
    description: 'Get current active AI alerts (fire prevention warnings) — overdue items, margin risks, scheduling conflicts.',
    input_schema: {
      type: 'object',
      properties: {
        severity: { type: 'string', description: 'Filter by severity: red, amber, or all. Default: all' },
      },
    },
  },
  {
    name: 'explain_pnl',
    description: 'Explain why the Xero P&L shows a different number than expected. Cross-references Xero accrual data against job completions, PO timing, and unbilled revenue. Identifies timing discrepancies. USE THIS when the user asks about profit/loss, margin, or why the numbers look wrong.',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'Month to analyse: YYYY-MM. Default: current month' },
      },
    },
  },
  {
    name: 'cash_flow_forecast',
    description: 'Project cash position for 30/60/90 days. Combines bank balances, outstanding invoices, confirmed POs, scheduled jobs, and historical payment patterns.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Forecast period. Default: 90' },
      },
    },
  },
  {
    name: 'unbilled_revenue',
    description: 'Find completed jobs that have no invoice sent yet. Shows the total dollar amount sitting on the table. USE THIS proactively when discussing completed jobs.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'division_comparison',
    description: 'Compare patio vs fencing vs decking divisions on revenue, margin, average job value, duration, and revenue per crew-day. Shows which division is most profitable and capital-efficient.',
    input_schema: {
      type: 'object',
      properties: {
        period_months: { type: 'number', description: 'Look back period. Default: 6' },
      },
    },
  },
  {
    name: 'cost_trend_analysis',
    description: 'Track material cost trends from the price ledger and PO data. Flags cost creep where supplier prices are rising but quote pricing hasn\'t adjusted.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Material category to focus on: steel, roofing, concrete, all. Default: all' },
      },
    },
  },
  {
    name: 'check_supplier_pricing',
    description: 'Compare current supplier prices (from PO ledger) against scope tool defaults. Flags drift where real costs have moved but quoting rates haven\'t been updated. Shows % gap and financial impact per item.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Material category to check: roofing, steel, concrete, all. Default: all' },
      },
    },
  },
]

// Execute tools — write actions requiring confirmation (admin + tier-appropriate only)
const EXECUTE_TOOLS = [
  {
    name: 'execute_create_invoice',
    description: 'Create a Xero invoice for a job. REQUIRES USER CONFIRMATION. Returns action card for approval.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID' },
        type: { type: 'string', description: 'Invoice type: deposit or full' },
        line_items: { type: 'array', description: 'Optional line items override', items: { type: 'object' } },
        percentage: { type: 'number', description: 'Deposit percentage (for deposit type). Default: 50' },
      },
      required: ['job_id', 'type'],
    },
  },
  {
    name: 'execute_send_sms',
    description: 'Send an SMS to a client via GHL. REQUIRES USER CONFIRMATION. Shows exact message text and recipient for approval.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID for context' },
        contact_id: { type: 'string', description: 'GHL contact ID' },
        message_text: { type: 'string', description: 'Exact SMS text to send' },
      },
      required: ['contact_id', 'message_text'],
    },
  },
  {
    name: 'execute_update_status',
    description: 'Update a job status. REQUIRES USER CONFIRMATION.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID' },
        new_status: { type: 'string', description: 'New status value' },
      },
      required: ['job_id', 'new_status'],
    },
  },
  {
    name: 'execute_create_po',
    description: 'Create a purchase order for a job. REQUIRES USER CONFIRMATION.',
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
    name: 'execute_assign_crew',
    description: 'Assign crew to a job on a specific date. REQUIRES USER CONFIRMATION.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID' },
        user_id: { type: 'string', description: 'Crew member UUID' },
        scheduled_date: { type: 'string', description: 'Date (YYYY-MM-DD)' },
        assignment_type: { type: 'string', description: 'Type: install, scope, delivery, rectification' },
      },
      required: ['job_id', 'user_id', 'scheduled_date'],
    },
  },
  {
    name: 'get_client_conversation',
    description: 'Read the GHL conversation history for a client contact. Returns last 30 messages (SMS, email, calls). Use this to understand context before composing a reply.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'GHL contact ID' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'execute_send_email',
    description: 'Send an email to a client via GHL. REQUIRES USER CONFIRMATION. Use get_client_conversation first for context.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'GHL contact ID' },
        subject: { type: 'string', description: 'Email subject line' },
        html_body: { type: 'string', description: 'Email body (HTML supported)' },
        job_id: { type: 'string', description: 'Related job UUID for logging' },
      },
      required: ['contact_id', 'subject', 'html_body'],
    },
  },
  {
    name: 'execute_send_quote',
    description: 'Send the quote PDF to a client via email. REQUIRES USER CONFIRMATION. Job must have scope_json/pricing_json.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID — must have scope and pricing data' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'execute_push_po_to_xero',
    description: 'Push a local draft PO to Xero as a purchase order. REQUIRES USER CONFIRMATION.',
    input_schema: {
      type: 'object',
      properties: {
        po_id: { type: 'string', description: 'Purchase order UUID (must be in draft status)' },
        status: { type: 'string', description: 'Xero PO status: DRAFT or AUTHORISED. Default: DRAFT' },
      },
      required: ['po_id'],
    },
  },
  {
    name: 'execute_add_ghl_note',
    description: 'Add a note to a GHL contact record. REQUIRES USER CONFIRMATION.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'GHL contact ID' },
        note_body: { type: 'string', description: 'Note content (plain text or markdown)' },
        job_id: { type: 'string', description: 'Related job UUID for context' },
      },
      required: ['contact_id', 'note_body'],
    },
  },
  {
    name: 'execute_email_supplier_po',
    description: 'Email a PO to the supplier. REQUIRES USER CONFIRMATION. PO must be pushed to Xero first, OR uses Resend via send-po-email.',
    input_schema: {
      type: 'object',
      properties: {
        po_id: { type: 'string', description: 'Purchase order UUID' },
        job_id: { type: 'string', description: 'Related job UUID' },
      },
      required: ['po_id'],
    },
  },
  {
    name: 'execute_send_telegram',
    description: 'Send a Telegram message to a team member. REQUIRES USER CONFIRMATION.',
    input_schema: {
      type: 'object',
      properties: {
        user_email: { type: 'string', description: 'Team member email (to look up their Telegram ID)' },
        user_name: { type: 'string', description: 'Team member name (alternative to email for lookup)' },
        message: { type: 'string', description: 'Message text to send' },
      },
      required: ['message'],
    },
  },
  {
    name: 'rough_estimate',
    description: 'Generate a rough price estimate for a job described verbally (e.g. "30m Colorbond fence in Joondalup"). Uses historical job data to estimate. NOT a formal quote.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Verbal job description — type, size, location, materials' },
        job_type: { type: 'string', description: 'fencing, patio, decking, roofing' },
      },
      required: ['description'],
    },
  },
  {
    name: 'get_quote_terms',
    description: 'Read the current Terms & Conditions from the patio or fencing quote templates. Returns the full T&C text.',
    input_schema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Which template: patio or fencing' },
      },
      required: ['template'],
    },
  },
  {
    name: 'execute_reconcile_payment',
    description: 'Record a payment against a Xero invoice. REQUIRES USER CONFIRMATION. Use search_invoices first to find the invoice.',
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', description: 'Xero Invoice ID (UUID)' },
        amount: { type: 'number', description: 'Payment amount in AUD' },
        payment_date: { type: 'string', description: 'Payment date (YYYY-MM-DD). Defaults to today.' },
        reference: { type: 'string', description: 'Payment reference (e.g. bank transfer ref, card last 4 digits)' },
        account_code: { type: 'string', description: 'Xero bank account code. Default: use main business account.' },
      },
      required: ['invoice_id', 'amount'],
    },
  },
  // ── Additional ops tools (Batch 2 additions) ──
  {
    name: 'list_variations',
    description: 'List variations (scope changes) across jobs. Filter by job_id or status.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Filter by job UUID' },
        status: { type: 'string', description: 'Filter by status: pending, approved, rejected' },
      },
    },
  },
  {
    name: 'list_council_submissions',
    description: 'List council/permit submissions. Shows status, current step, and job linkage.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Filter by job UUID' },
        status: { type: 'string', description: 'Filter by overall_status: not_started, in_progress, approved, rejected' },
      },
    },
  },
  {
    name: 'list_expenses',
    description: 'List business expenses. Filter by date range, category, or status.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        to: { type: 'string', description: 'End date (YYYY-MM-DD)' },
        status: { type: 'string', description: 'Filter by status: pending, approved, paid' },
      },
    },
  },
  {
    name: 'list_purchase_orders',
    description: 'List purchase orders. Filter by job, supplier name, or status.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Filter by job UUID' },
        supplier: { type: 'string', description: 'Search by supplier name (partial match)' },
        status: { type: 'string', description: 'Filter by status: draft, sent, confirmed, received, cancelled' },
      },
    },
  },
  {
    name: 'list_work_orders',
    description: 'List work orders. Filter by job or status.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Filter by job UUID' },
        status: { type: 'string', description: 'Filter by status: draft, sent, accepted, in_progress, complete, cancelled' },
      },
    },
  },
  {
    name: 'execute_create_work_order',
    description: 'Create a work order for a job. REQUIRES USER CONFIRMATION.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID' },
        description: { type: 'string', description: 'Work order description/scope' },
        assigned_to: { type: 'string', description: 'User ID to assign to' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'get_crew_availability',
    description: 'Check crew availability for a date range. Shows who is free and who is booked.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date (YYYY-MM-DD). Defaults to today.' },
        to: { type: 'string', description: 'End date (YYYY-MM-DD). Defaults to 7 days from start.' },
      },
    },
  },
  {
    name: 'list_suppliers',
    description: 'List all suppliers with their contact details and categories.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_email_events',
    description: 'Get email delivery events (sent, opened, bounced, etc.). Filter by job or recipient.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Filter by job UUID' },
        email: { type: 'string', description: 'Filter by recipient email' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'execute_send_review_request',
    description: 'Send a Google review request to a client after job completion. REQUIRES USER CONFIRMATION.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job UUID (must be complete/invoiced)' },
        method: { type: 'string', description: 'Send via: sms or email. Default: sms' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'search_ghl_contacts',
    description: 'Search GoHighLevel CRM contacts by name, email, or phone. Use this when a contact is not found in Supabase jobs — they may be a lead in GHL.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search term (name, email, or phone)' },
      },
      required: ['search'],
    },
  },
  {
    name: 'get_team_activity',
    description: 'Get recent team activity — job events, status changes, assignments, POs created. Shows what happened in the last 24-48 hours.',
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Look back this many hours (default: 24)' },
        user_id: { type: 'string', description: 'Filter by specific team member UUID' },
      },
    },
  },
  {
    name: 'get_sales_leads',
    description: 'Get new sales leads/opportunities from GHL. Shows recent inquiries, their status, and assignment.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date (YYYY-MM-DD). Defaults to 7 days ago.' },
        status: { type: 'string', description: 'Filter by status: new, contacted, qualified, quoted' },
      },
    },
  },
  {
    name: 'get_inbox_summary',
    description: 'Get recent email inbox activity — new emails received, classified by type and priority. Shows what came in overnight or recently.',
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Look back this many hours (default: 24)' },
        mailbox: { type: 'string', description: 'Filter by mailbox (e.g. "marnin@secureworkswa.com.au")' },
        priority: { type: 'string', description: 'Filter by priority: high, normal, low' },
      },
    },
  },
]

// ════════════════════════════════════════════════════════════
// TOOL FILTERING BY ROLE
// ════════════════════════════════════════════════════════════

const FINANCIAL_TOOLS = new Set([
  'get_dashboard_summary', 'get_trends', 'explain_pnl', 'cash_flow_forecast',
  'cash_flow_status', 'division_comparison', 'get_debt_followup', 'get_job_profitability',
  'get_sales_breakdown',
])

const COST_TOOLS = new Set([
  'analyse_profitability', 'cost_trend_analysis', 'estimate_accuracy_report',
  'generate_pricing_recommendation',
])

function getToolsForCaller(view: string, caller?: CallerContext): any[] {
  // No caller = dashboard = admin (backward compat)
  if (!caller || caller.user_role === 'admin') {
    return [...(view === 'ops' ? OPS_TOOLS : view === 'sales' ? OPS_TOOLS : CEO_TOOLS), ...INTELLIGENCE_TOOLS, ...EXECUTE_TOOLS]
  }

  const role = caller.user_role
  let tools: any[] = []

  if (role === 'crew') {
    // Crew: own jobs search, own schedule only
    tools = [
      OPS_TOOLS.find(t => t.name === 'search_jobs'),
      OPS_TOOLS.find(t => t.name === 'get_job_detail'),
      OPS_TOOLS.find(t => t.name === 'get_schedule'),
    ].filter(Boolean)
  } else if (role === 'lead_installer') {
    // Lead installer: ops tools minus financials
    tools = OPS_TOOLS.filter(t => !FINANCIAL_TOOLS.has(t.name))
    tools.push(...INTELLIGENCE_TOOLS.filter(t =>
      !FINANCIAL_TOOLS.has(t.name) && !COST_TOOLS.has(t.name) &&
      t.name !== 'sales_performance'
    ))
  } else if (role === 'division_ops') {
    // Division ops: all ops tools, per-job costs, but not business-wide P&L
    tools = [...OPS_TOOLS]
    tools.push(...INTELLIGENCE_TOOLS.filter(t =>
      !FINANCIAL_TOOLS.has(t.name)
    ))
  } else if (role === 'sales') {
    // Sales: pipeline, leads, quotes, own performance
    tools = [
      OPS_TOOLS.find(t => t.name === 'search_jobs'),
      OPS_TOOLS.find(t => t.name === 'get_job_detail'),
      OPS_TOOLS.find(t => t.name === 'get_schedule'),
      OPS_TOOLS.find(t => t.name === 'draft_communication'),
      INTELLIGENCE_TOOLS.find(t => t.name === 'sales_performance'),
      INTELLIGENCE_TOOLS.find(t => t.name === 'revenue_forecast'),
      INTELLIGENCE_TOOLS.find(t => t.name === 'get_ai_alerts'),
      // Allow send_sms for sales
      EXECUTE_TOOLS.find(t => t.name === 'execute_send_sms'),
    ].filter(Boolean)
  }

  return tools
}

// ════════════════════════════════════════════════════════════
// SAFETY RULES
// ════════════════════════════════════════════════════════════

async function checkSafetyRules(
  toolName: string,
  input: any,
  caller: CallerContext
): Promise<{ allowed: boolean; reason?: string }> {
  // Rule 1: No deletes ever
  if (toolName.includes('delete')) {
    return { allowed: false, reason: "I can't delete records. I can mark things as cancelled or archived." }
  }

  // Rule 2: $20K+ requires admin
  const amount = input.amount || input.total || 0
  if (Number(amount) > 20000 && caller.user_role !== 'admin') {
    return { allowed: false, reason: 'Amounts over $20,000 require admin approval. Please ask Marnin or Shaun to confirm.' }
  }

  // Rule 4: Invoice creation restricted to admin
  const invoiceActions = new Set(['execute_create_invoice', 'execute_reconcile_payment', 'complete_and_invoice'])
  if (invoiceActions.has(toolName) && caller.user_role !== 'admin') {
    return { allowed: false, reason: 'Invoice creation is restricted to admin users (Marnin, Shaun, Jan).' }
  }

  // Rule 3: Check action_permissions table
  const executeActions: Record<string, string> = {
    execute_create_invoice: 'create_invoice',
    execute_send_sms: 'send_client_sms',
    execute_update_status: 'update_job_status',
    execute_create_po: 'create_po',
    execute_assign_crew: 'create_assignment',
    execute_send_email: 'send_client_email',
    execute_send_quote: 'send_quote',
    execute_push_po_to_xero: 'push_po_to_xero',
    execute_add_ghl_note: 'add_ghl_note',
    execute_email_supplier_po: 'email_supplier_po',
    execute_send_telegram: 'send_telegram',
    execute_reconcile_payment: 'reconcile_payment',
  }
  const permAction = executeActions[toolName]
  if (permAction) {
    try {
      const sb = sbClient()
      const { data: perm } = await sb.from('action_permissions')
        .select('autonomy_level')
        .eq('action_type', permAction)
        .maybeSingle()
      if (perm?.autonomy_level === 'block') {
        return { allowed: false, reason: `This action type (${permAction}) is currently blocked by policy.` }
      }
    } catch { /* table may not exist — allow */ }
  }

  return { allowed: true }
}

// ════════════════════════════════════════════════════════════
// TOOL EXECUTION
// ════════════════════════════════════════════════════════════

// Write actions that need user confirmation in the frontend
const CONFIRM_ACTIONS = new Set([
  'create_assignment', 'update_job_status', 'complete_and_invoice',
  'execute_create_invoice', 'execute_send_sms', 'execute_update_status',
  'execute_create_po', 'execute_assign_crew',
  'execute_send_email', 'execute_send_quote', 'execute_push_po_to_xero',
  'execute_add_ghl_note', 'execute_email_supplier_po', 'execute_send_telegram',
  'execute_reconcile_payment',
])

// Level 2 auto-execute: actions here CAN skip confirmation when all gates pass.
// Empty by default — nothing auto-executes until you add action names here.
const AUTO_ELIGIBLE_ACTIONS = new Set<string>([
  // e.g. 'execute_update_status' — add when shadow data proves accuracy
])

async function executeTool(name: string, input: any, view: string): Promise<{ result: any; needs_confirm?: boolean }> {
  switch (name) {
    // ── Shared ──
    case 'search_invoices': {
      const params: Record<string, string> = {}
      if (input.type) params.type = input.type
      if (input.status) params.status = input.status
      if (input.search) params.search = input.search
      return { result: await callOpsApi('list_invoices', params) }
    }

    // ── Ops tools ──
    case 'search_jobs': {
      const params: Record<string, string> = {}
      if (input.status) params.status = input.status
      if (input.type) params.type = input.type
      if (input.search) params.search = input.search
      const pipelineResult = await callOpsApi('pipeline', params)

      // If search returned no results and we have a search term, try GHL as fallback
      if (input.search && pipelineResult?.total === 0) {
        try {
          const ghlResult = await callGhlProxy('search', { q: input.search })
          if (ghlResult?.opportunities?.length > 0) {
            return {
              result: {
                ...pipelineResult,
                ghl_leads: ghlResult.opportunities.slice(0, 10).map((o: any) => ({
                  name: o.contact_name || o.name,
                  status: o.status || o.stage_name,
                  pipeline: o.pipeline_name,
                  phone: o.phone,
                  email: o.email,
                  source: 'GHL (not yet a job in system)',
                })),
                _note: `No jobs found for "${input.search}" but found ${ghlResult.opportunities.length} lead(s) in GHL CRM.`,
              }
            }
          }
        } catch (e) { /* GHL fallback is best-effort */ }
      }

      return { result: pipelineResult }
    }
    case 'get_schedule': {
      const from = input.from || awstDate()
      const to = input.to || (() => {
        const d = new Date(from)
        d.setDate(d.getDate() + 7)
        return d.toISOString().slice(0, 10)
      })()
      return { result: await callOpsApi('calendar', { from, to }) }
    }
    case 'get_job_detail':
      return { result: await callOpsApi('job_detail', { jobId: input.job_id }) }
    case 'get_attention_items':
      return { result: await callOpsApi('ops_summary') }

    // Write actions — return confirmation payload instead of executing
    case 'create_assignment':
      return {
        result: {
          action: 'create_assignment',
          params: input,
          message: `Schedule ${input.crew_name || 'crew'} on ${input.scheduled_date} for this job?`,
        },
        needs_confirm: true,
      }
    case 'update_job_status':
      return {
        result: {
          action: 'update_job_status',
          params: { jobId: input.job_id, status: input.status },
          message: `Update job status to "${input.status}"?`,
        },
        needs_confirm: true,
      }
    case 'complete_and_invoice':
      return {
        result: {
          action: 'complete_and_invoice',
          params: { job_id: input.job_id, xero_status: 'DRAFT', send_email: false },
          message: `Mark job complete and create Xero invoice (DRAFT)?`,
        },
        needs_confirm: true,
      }

    case 'draft_communication':
      // For drafts, we just return a marker — the LLM itself generates the text
      return { result: { drafted: true, type: input.type, recipient: input.recipient, purpose: input.purpose } }

    // ── CEO tools ──
    case 'get_dashboard_summary':
      return { result: await callReportingApi('dashboard_summary') }
    case 'get_job_profitability': {
      const params: Record<string, string> = {}
      if (input.type) params.type = input.type
      if (input.min_revenue) params.min_revenue = String(input.min_revenue)
      return { result: await callReportingApi('job_profitability', params) }
    }
    case 'get_marketing_summary':
      return { result: await callReportingApi('marketing_summary') }
    case 'get_trends':
      return { result: await callReportingApi('trends') }
    case 'get_sales_breakdown':
      return { result: await callReportingApi('sales_breakdown') }
    case 'get_debt_followup': {
      const params: Record<string, string> = {}
      if (input.search) params.search = input.search
      return { result: await callReportingApi('debt_followup', params) }
    }
    case 'search_contacts': {
      const sb = sbClient()
      const searchName = (input.name || '').trim()
      if (!searchName) return { result: { error: 'Name is required' } }
      const searchPattern = `%${searchName}%`

      // Search across multiple data sources in parallel
      const [jobsRes, xeroRes, contactsRes] = await Promise.all([
        sb.from('jobs')
          .select('id, client_name, client_phone, client_email, ghl_contact_id, xero_contact_id, job_number, status, type')
          .eq('org_id', DEFAULT_ORG_ID)
          .or('legacy.is.null,legacy.eq.false')
          .ilike('client_name', searchPattern)
          .limit(10),
        sb.from('xero_invoices')
          .select('xero_contact_id, contact_name, amount_due, status, invoice_type')
          .eq('org_id', DEFAULT_ORG_ID)
          .eq('invoice_type', 'ACCREC')
          .ilike('contact_name', searchPattern)
          .limit(20),
        sb.from('contact_matches')
          .select('id, client_name, phone, email, ghl_contact_id, xero_contact_id, job_id')
          .ilike('client_name', searchPattern)
          .limit(10),
      ])

      // Merge into unified contact results
      const contactMap: Record<string, any> = {}
      for (const j of (jobsRes.data || [])) {
        const key = (j.client_name || '').toLowerCase()
        if (!contactMap[key]) contactMap[key] = { name: j.client_name, phone: null, email: null, ghl_contact_id: null, xero_contact_id: null, jobs: [], outstanding: 0 }
        contactMap[key].phone = contactMap[key].phone || j.client_phone
        contactMap[key].email = contactMap[key].email || j.client_email
        contactMap[key].ghl_contact_id = contactMap[key].ghl_contact_id || j.ghl_contact_id
        contactMap[key].xero_contact_id = contactMap[key].xero_contact_id || j.xero_contact_id
        contactMap[key].jobs.push({ job_number: j.job_number, status: j.status, type: j.type })
      }
      for (const c of (contactsRes.data || [])) {
        const key = (c.client_name || '').toLowerCase()
        if (!contactMap[key]) contactMap[key] = { name: c.client_name, phone: null, email: null, ghl_contact_id: null, xero_contact_id: null, jobs: [], outstanding: 0 }
        contactMap[key].phone = contactMap[key].phone || c.phone
        contactMap[key].email = contactMap[key].email || c.email
        contactMap[key].ghl_contact_id = contactMap[key].ghl_contact_id || c.ghl_contact_id
        contactMap[key].xero_contact_id = contactMap[key].xero_contact_id || c.xero_contact_id
      }
      // Sum outstanding from Xero invoices
      for (const inv of (xeroRes.data || [])) {
        const key = (inv.contact_name || '').toLowerCase()
        if (!contactMap[key]) contactMap[key] = { name: inv.contact_name, phone: null, email: null, ghl_contact_id: null, xero_contact_id: inv.xero_contact_id, jobs: [], outstanding: 0 }
        if (['AUTHORISED', 'SUBMITTED'].includes(inv.status) && inv.amount_due > 0) {
          contactMap[key].outstanding += Number(inv.amount_due) || 0
        }
        contactMap[key].xero_contact_id = contactMap[key].xero_contact_id || inv.xero_contact_id
      }

      return { result: { contacts: Object.values(contactMap), count: Object.keys(contactMap).length } }
    }

    // ── Intelligence tools ──
    case 'analyse_profitability': {
      const sb = sbClient()
      const monthsBack = input.period_months || 6
      const since = new Date(Date.now() - monthsBack * 30 * 86400000).toISOString().slice(0, 10)
      const groupBy = input.group_by || 'type'

      // Get completed jobs with pricing and PO costs
      const { data: jobs } = await sb.from('jobs')
        .select('id, type, site_suburb, created_by, pricing_json, completed_at, status')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('legacy', false)
        .in('status', ['complete', 'invoiced'])
        .gte('completed_at', since)

      const { data: pos } = await sb.from('purchase_orders')
        .select('job_id, total')
        .eq('org_id', DEFAULT_ORG_ID)
        .not('job_id', 'is', null)

      const { data: users } = await sb.from('users').select('id, name')
      const userMap = Object.fromEntries((users || []).map((u: any) => [u.id, u.name]))

      // Sum PO costs per job
      const poCosts: Record<string, number> = {}
      for (const po of (pos || [])) {
        poCosts[po.job_id] = (poCosts[po.job_id] || 0) + Number(po.total || 0)
      }

      // Group and calculate
      const groups: Record<string, { count: number; quoted_total: number; actual_cost: number; jobs: any[] }> = {}
      for (const j of (jobs || [])) {
        const quoted = j.pricing_json?.total || j.pricing_json?.grandTotal || j.pricing_json?.totalExGST || 0
        const actual = poCosts[j.id] || 0
        let key = ''
        if (groupBy === 'type') key = j.type || 'unknown'
        else if (groupBy === 'suburb') key = j.site_suburb || 'unknown'
        else if (groupBy === 'salesperson') key = userMap[j.created_by] || 'unknown'
        else if (groupBy === 'month') key = (j.completed_at || '').slice(0, 7)
        else key = j.type || 'unknown'

        if (!groups[key]) groups[key] = { count: 0, quoted_total: 0, actual_cost: 0, jobs: [] }
        groups[key].count++
        groups[key].quoted_total += Number(quoted)
        groups[key].actual_cost += actual
      }

      const analysis = Object.entries(groups).map(([key, g]) => ({
        group: key,
        count: g.count,
        quoted_total: Math.round(g.quoted_total),
        actual_material_cost: Math.round(g.actual_cost),
        implied_margin: g.quoted_total > 0 ? Math.round(((g.quoted_total - g.actual_cost) / g.quoted_total) * 100) : null,
        avg_job_value: Math.round(g.quoted_total / g.count),
      })).sort((a, b) => (b.implied_margin || 0) - (a.implied_margin || 0))

      return { result: { group_by: groupBy, period_months: monthsBack, analysis } }
    }

    case 'revenue_forecast': {
      const sb = sbClient()
      const days = input.days || 90

      const { data: jobs } = await sb.from('jobs')
        .select('id, status, type, pricing_json, accepted_at, scheduled_at, quoted_at')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('legacy', false)
        .in('status', ['quoted', 'accepted', 'scheduled', 'in_progress'])

      // Historical conversion rate
      const { data: allJobs } = await sb.from('jobs')
        .select('status')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('legacy', false)
      const totalQuoted = (allJobs || []).filter((j: any) => ['quoted', 'accepted', 'scheduled', 'in_progress', 'complete', 'invoiced'].includes(j.status)).length
      const totalWon = (allJobs || []).filter((j: any) => ['accepted', 'scheduled', 'in_progress', 'complete', 'invoiced'].includes(j.status)).length
      const convRate = totalQuoted > 0 ? totalWon / totalQuoted : 0.35

      const stageProb: Record<string, number> = { quoted: convRate, accepted: 0.85, scheduled: 0.95, in_progress: 0.98 }

      let forecast30 = 0, forecast60 = 0, forecast90 = 0
      const pipeline = (jobs || []).map((j: any) => {
        const val = j.pricing_json?.total || j.pricing_json?.grandTotal || 0
        const weighted = Number(val) * (stageProb[j.status] || 0.5)
        // Estimate timing based on status
        if (j.status === 'in_progress' || j.status === 'scheduled') forecast30 += weighted
        else if (j.status === 'accepted') { forecast30 += weighted * 0.3; forecast60 += weighted * 0.7 }
        else { forecast60 += weighted * 0.4; forecast90 += weighted * 0.6 }
        return { status: j.status, value: Number(val), weighted }
      })

      return {
        result: {
          forecast_days: days,
          conversion_rate: Math.round(convRate * 100),
          next_30_days: Math.round(forecast30),
          next_60_days: Math.round(forecast30 + forecast60),
          next_90_days: Math.round(forecast30 + forecast60 + forecast90),
          pipeline_count: pipeline.length,
          pipeline_total: Math.round(pipeline.reduce((s, p) => s + p.value, 0)),
          pipeline_weighted: Math.round(pipeline.reduce((s, p) => s + p.weighted, 0)),
        },
      }
    }

    case 'supplier_analysis': {
      const sb = sbClient()
      const { data: pos } = await sb.from('purchase_orders')
        .select('id, supplier_name, total, status, delivery_date, created_at, updated_at')
        .eq('org_id', DEFAULT_ORG_ID)
        .neq('status', 'deleted')

      const suppliers: Record<string, { count: number; total_spend: number; statuses: string[]; delivery_dates: string[]; created_dates: string[] }> = {}
      for (const po of (pos || [])) {
        const name = po.supplier_name || 'Unknown'
        if (input.supplier_name && name.toLowerCase() !== input.supplier_name.toLowerCase()) continue
        if (!suppliers[name]) suppliers[name] = { count: 0, total_spend: 0, statuses: [], delivery_dates: [], created_dates: [] }
        suppliers[name].count++
        suppliers[name].total_spend += Number(po.total || 0)
        suppliers[name].statuses.push(po.status)
        if (po.delivery_date) suppliers[name].delivery_dates.push(po.delivery_date)
        suppliers[name].created_dates.push(po.created_at)
      }

      const scorecards = Object.entries(suppliers).map(([name, s]) => ({
        supplier: name,
        po_count: s.count,
        total_spend: Math.round(s.total_spend),
        avg_po_value: Math.round(s.total_spend / s.count),
        confirmed_rate: Math.round((s.statuses.filter(st => ['confirmed', 'delivered', 'billed', 'authorised'].includes(st)).length / s.count) * 100),
      })).sort((a, b) => b.total_spend - a.total_spend)

      return { result: { suppliers: scorecards } }
    }

    case 'sales_performance': {
      const sb = sbClient()
      const periodMap: Record<string, number> = { this_month: 30, last_month: 60, this_quarter: 90, last_90_days: 90 }
      const days = periodMap[input.period || 'last_90_days'] || 90
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)

      const { data: jobs } = await sb.from('jobs')
        .select('id, status, type, created_by, pricing_json, created_at, quoted_at, accepted_at')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('legacy', false)
        .gte('created_at', since)

      const { data: users } = await sb.from('users').select('id, name, role')
      const userMap = Object.fromEntries((users || []).map((u: any) => [u.id, { name: u.name, role: u.role }]))

      const byUser: Record<string, { leads: number; quoted: number; won: number; total_value: number; days_to_quote: number[]; }> = {}
      for (const j of (jobs || [])) {
        if (input.user_id && j.created_by !== input.user_id) continue
        const uid = j.created_by || 'unassigned'
        if (!byUser[uid]) byUser[uid] = { leads: 0, quoted: 0, won: 0, total_value: 0, days_to_quote: [] }
        byUser[uid].leads++
        if (['quoted', 'accepted', 'scheduled', 'in_progress', 'complete', 'invoiced'].includes(j.status)) {
          byUser[uid].quoted++
          if (j.created_at && j.quoted_at) {
            byUser[uid].days_to_quote.push((new Date(j.quoted_at).getTime() - new Date(j.created_at).getTime()) / 86400000)
          }
        }
        if (['accepted', 'scheduled', 'in_progress', 'complete', 'invoiced'].includes(j.status)) {
          byUser[uid].won++
          byUser[uid].total_value += Number(j.pricing_json?.total || j.pricing_json?.grandTotal || 0)
        }
      }

      const performance = Object.entries(byUser).map(([uid, s]) => ({
        user_id: uid,
        name: userMap[uid]?.name || 'Unknown',
        leads: s.leads,
        quoted: s.quoted,
        won: s.won,
        close_rate: s.quoted > 0 ? Math.round((s.won / s.quoted) * 100) : 0,
        total_booked_value: Math.round(s.total_value),
        avg_deal_size: s.won > 0 ? Math.round(s.total_value / s.won) : 0,
        avg_days_to_quote: s.days_to_quote.length > 0 ? Math.round(s.days_to_quote.reduce((a, b) => a + b, 0) / s.days_to_quote.length) : null,
      })).sort((a, b) => b.total_booked_value - a.total_booked_value)

      return { result: { period: input.period || 'last_90_days', salespeople: performance } }
    }

    case 'job_duration_analysis': {
      const sb = sbClient()
      const { data: jobs } = await sb.from('jobs')
        .select('id, type, client_name, job_number, accepted_at, scheduled_at, completed_at, status')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('legacy', false)
        .in('status', ['complete', 'invoiced'])
        .not('accepted_at', 'is', null)
        .not('completed_at', 'is', null)

      const filtered = input.type ? (jobs || []).filter((j: any) => j.type === input.type) : (jobs || [])

      const durations = filtered.map((j: any) => {
        const acceptToComplete = (new Date(j.completed_at).getTime() - new Date(j.accepted_at).getTime()) / 86400000
        const acceptToSchedule = j.scheduled_at ? (new Date(j.scheduled_at).getTime() - new Date(j.accepted_at).getTime()) / 86400000 : null
        return {
          job_number: j.job_number,
          client_name: j.client_name,
          type: j.type,
          days_accept_to_complete: Math.round(acceptToComplete),
          days_accept_to_schedule: acceptToSchedule ? Math.round(acceptToSchedule) : null,
        }
      }).sort((a: any, b: any) => b.days_accept_to_complete - a.days_accept_to_complete)

      const avgDuration = durations.length > 0 ? Math.round(durations.reduce((s: number, d: any) => s + d.days_accept_to_complete, 0) / durations.length) : 0
      const medianDuration = durations.length > 0 ? durations[Math.floor(durations.length / 2)].days_accept_to_complete : 0

      return {
        result: {
          type_filter: input.type || 'all',
          total_jobs: durations.length,
          avg_days: avgDuration,
          median_days: medianDuration,
          fastest: durations.length > 0 ? durations[durations.length - 1] : null,
          slowest: durations.length > 0 ? durations[0] : null,
          outliers_30plus: durations.filter((d: any) => d.days_accept_to_complete > 30),
        },
      }
    }

    case 'cash_flow_status': {
      const sb = sbClient()
      const [invoicesRes, posRes, receivablesRes] = await Promise.all([
        sb.from('xero_invoices').select('id, contact_name, total, amount_paid, amount_due, status, date, due_date, type, job_id')
          .eq('org_id', DEFAULT_ORG_ID)
          .in('status', ['AUTHORISED', 'SUBMITTED'])
          .eq('type', 'ACCREC'),
        sb.from('purchase_orders').select('id, supplier_name, total, status, job_id')
          .eq('org_id', DEFAULT_ORG_ID)
          .in('status', ['draft', 'submitted', 'authorised', 'sent', 'confirmed']),
        sb.from('aged_receivables').select('*').eq('org_id', DEFAULT_ORG_ID),
      ])

      const invoices = invoicesRes.data || []
      const uncommittedPOs = posRes.data || []
      const receivables = receivablesRes.data || []

      const totalOwed = invoices.reduce((s: number, i: any) => s + (Number(i.amount_due) || 0), 0)
      const totalPOCommitted = uncommittedPOs.reduce((s: number, p: any) => s + (Number(p.total) || 0), 0)

      // Age buckets
      const now = new Date()
      const ageBuckets: Record<string, { count: number; amount: number }> = { current: { count: 0, amount: 0 }, '1-30': { count: 0, amount: 0 }, '31-60': { count: 0, amount: 0 }, '60+': { count: 0, amount: 0 } }
      for (const inv of invoices) {
        const daysOld = inv.due_date ? Math.floor((now.getTime() - new Date(inv.due_date).getTime()) / 86400000) : 0
        const due = Number(inv.amount_due) || 0
        if (daysOld <= 0) { ageBuckets.current.count++; ageBuckets.current.amount += due }
        else if (daysOld <= 30) { ageBuckets['1-30'].count++; ageBuckets['1-30'].amount += due }
        else if (daysOld <= 60) { ageBuckets['31-60'].count++; ageBuckets['31-60'].amount += due }
        else { ageBuckets['60+'].count++; ageBuckets['60+'].amount += due }
      }

      // Round amounts
      for (const b of Object.values(ageBuckets)) b.amount = Math.round(b.amount)

      return {
        result: {
          total_receivable: Math.round(totalOwed),
          total_po_committed: Math.round(totalPOCommitted),
          net_position: Math.round(totalOwed - totalPOCommitted),
          aged_receivables: ageBuckets,
          top_debtors: invoices.sort((a: any, b: any) => (Number(b.amount_due) || 0) - (Number(a.amount_due) || 0)).slice(0, 10).map((i: any) => ({
            client: i.contact_name,
            amount_due: Math.round(Number(i.amount_due) || 0),
            due_date: i.due_date,
          })),
        },
      }
    }

    case 'estimate_accuracy_report': {
      const sb = sbClient()
      const { data: jobs } = await sb.from('jobs')
        .select('id, type, job_number, client_name, pricing_json, completed_at')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('legacy', false)
        .in('status', ['complete', 'invoiced'])

      const { data: pos } = await sb.from('purchase_orders')
        .select('job_id, total, line_items')
        .eq('org_id', DEFAULT_ORG_ID)
        .not('job_id', 'is', null)

      const poCostsByJob: Record<string, number> = {}
      for (const po of (pos || [])) {
        poCostsByJob[po.job_id] = (poCostsByJob[po.job_id] || 0) + Number(po.total || 0)
      }

      const filtered = input.type ? (jobs || []).filter((j: any) => j.type === input.type) : (jobs || [])

      const comparisons = filtered
        .filter((j: any) => {
          const quoted = j.pricing_json?.total || j.pricing_json?.grandTotal || 0
          return Number(quoted) > 0 && poCostsByJob[j.id]
        })
        .map((j: any) => {
          const quoted = Number(j.pricing_json?.total || j.pricing_json?.grandTotal || 0)
          const actual = poCostsByJob[j.id] || 0
          const accuracy = quoted > 0 ? Math.round((actual / quoted) * 100) : 0
          return {
            job_number: j.job_number,
            type: j.type,
            quoted_total: Math.round(quoted),
            actual_material_cost: Math.round(actual),
            material_cost_ratio: accuracy,
            over_under: Math.round(actual - quoted),
          }
        })

      const avgAccuracy = comparisons.length > 0 ? Math.round(comparisons.reduce((s, c) => s + c.material_cost_ratio, 0) / comparisons.length) : 0
      const overquoted = comparisons.filter(c => c.material_cost_ratio < 90).length
      const underquoted = comparisons.filter(c => c.material_cost_ratio > 110).length

      return {
        result: {
          total_jobs_analysed: comparisons.length,
          avg_material_cost_ratio: avgAccuracy,
          jobs_overquoted: overquoted,
          jobs_underquoted: underquoted,
          jobs_accurate: comparisons.length - overquoted - underquoted,
          worst_underquotes: comparisons.filter(c => c.material_cost_ratio > 100).sort((a, b) => b.material_cost_ratio - a.material_cost_ratio).slice(0, 5),
          note: 'material_cost_ratio = actual PO costs as % of quoted total. Over 100% means actual costs exceeded quote.',
        },
      }
    }

    case 'generate_pricing_recommendation': {
      // This tool gathers data and lets Claude generate the recommendations in its response
      const sb = sbClient()
      const { data: jobs } = await sb.from('jobs')
        .select('id, type, site_suburb, pricing_json')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('legacy', false)
        .in('status', ['complete', 'invoiced'])

      const { data: pos } = await sb.from('purchase_orders')
        .select('job_id, total')
        .eq('org_id', DEFAULT_ORG_ID)
        .not('job_id', 'is', null)

      const poCosts: Record<string, number> = {}
      for (const po of (pos || [])) {
        poCosts[po.job_id] = (poCosts[po.job_id] || 0) + Number(po.total || 0)
      }

      // Group by type
      const byType: Record<string, { count: number; total_quoted: number; total_actual: number }> = {}
      for (const j of (jobs || [])) {
        const quoted = Number(j.pricing_json?.total || j.pricing_json?.grandTotal || 0)
        const actual = poCosts[j.id] || 0
        if (quoted <= 0 || actual <= 0) continue
        const t = j.type || 'other'
        if (!byType[t]) byType[t] = { count: 0, total_quoted: 0, total_actual: 0 }
        byType[t].count++
        byType[t].total_quoted += quoted
        byType[t].total_actual += actual
      }

      const typeAnalysis = Object.entries(byType).map(([type, d]) => ({
        type,
        jobs: d.count,
        avg_quoted: Math.round(d.total_quoted / d.count),
        avg_actual_cost: Math.round(d.total_actual / d.count),
        cost_ratio_pct: Math.round((d.total_actual / d.total_quoted) * 100),
        adjustment_needed: Math.round(((d.total_actual / d.total_quoted) - 1) * 100),
      }))

      return {
        result: {
          by_type: typeAnalysis,
          instruction: 'Based on this data, generate specific pricing recommendations. A positive adjustment_needed means costs exceeded quotes — prices should increase. Focus on actionable changes to the scope tool pricing tables.',
        },
      }
    }

    case 'generate_sop': {
      // Gather real job flow data so Claude can generate the SOP
      const sb = sbClient()
      const { data: recentCompleted } = await sb.from('jobs')
        .select('id, job_number, type, created_at, quoted_at, accepted_at, scheduled_at, completed_at')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('legacy', false)
        .in('status', ['complete', 'invoiced'])
        .order('completed_at', { ascending: false })
        .limit(20)

      // Get events for these jobs to understand the actual workflow
      const jobIds = (recentCompleted || []).map((j: any) => j.id)
      let events: any[] = []
      if (jobIds.length > 0) {
        const { data: evts } = await sb.from('job_events')
          .select('job_id, event_type, created_at')
          .in('job_id', jobIds)
          .order('created_at', { ascending: true })
        events = evts || []
      }

      // Summarise typical event sequences
      const eventsByJob: Record<string, string[]> = {}
      for (const e of events) {
        if (!eventsByJob[e.job_id]) eventsByJob[e.job_id] = []
        eventsByJob[e.job_id].push(e.event_type)
      }

      // Calculate avg times between stages
      const timings = (recentCompleted || []).map((j: any) => ({
        job_number: j.job_number,
        type: j.type,
        lead_to_quote_days: j.quoted_at && j.created_at ? Math.round((new Date(j.quoted_at).getTime() - new Date(j.created_at).getTime()) / 86400000) : null,
        quote_to_accept_days: j.accepted_at && j.quoted_at ? Math.round((new Date(j.accepted_at).getTime() - new Date(j.quoted_at).getTime()) / 86400000) : null,
        accept_to_schedule_days: j.scheduled_at && j.accepted_at ? Math.round((new Date(j.scheduled_at).getTime() - new Date(j.accepted_at).getTime()) / 86400000) : null,
        accept_to_complete_days: j.completed_at && j.accepted_at ? Math.round((new Date(j.completed_at).getTime() - new Date(j.accepted_at).getTime()) / 86400000) : null,
        event_sequence: eventsByJob[j.id] || [],
      }))

      // Fetch confirmed learned rules relevant to this process
      const ruleTypeMap: Record<string, string[]> = {
        material_ordering: ['po', 'status'],
        job_scheduling: ['assign', 'status'],
        quoting: ['status', 'po'],
        invoicing: ['status'],
        completion: ['status', 'assign'],
        client_followup: ['status'],
      }
      const relevantRuleTypes = ruleTypeMap[input.process] || ['status']
      const { data: rules } = await sb.from('learned_rules')
        .select('rule_type, description, correction_text, confidence')
        .in('status', ['confirmed', 'corrected'])
        .in('rule_type', relevantRuleTypes)
        .gt('confidence', 0.7)
        .order('confidence', { ascending: false })
        .limit(15)

      const rulesContext = (rules || []).map((r: any) => r.correction_text || r.description)

      // Fetch PO/assignment data for specific process types
      let processData: any = {}
      if (input.process === 'material_ordering' && jobIds.length > 0) {
        const { data: pos } = await sb.from('purchase_orders')
          .select('job_id, supplier_name, total, status, created_at')
          .in('job_id', jobIds)
          .neq('status', 'deleted')
          .order('created_at', { ascending: false })
          .limit(50)
        // Summarise: suppliers, avg PO per job, timing
        const suppliers = [...new Set((pos || []).map((p: any) => p.supplier_name).filter(Boolean))]
        const avgPO = (pos || []).length > 0 ? Math.round((pos || []).reduce((s: number, p: any) => s + Number(p.total || 0), 0) / (pos || []).length) : 0
        processData = { top_suppliers: suppliers.slice(0, 5), avg_po_value: avgPO, total_pos_sampled: (pos || []).length }
      } else if (input.process === 'job_scheduling' && jobIds.length > 0) {
        const { data: assigns } = await sb.from('job_assignments')
          .select('job_id, crew_name, scheduled_date, assignment_type')
          .in('job_id', jobIds)
          .order('scheduled_date', { ascending: false })
          .limit(50)
        const crews = [...new Set((assigns || []).map((a: any) => a.crew_name).filter(Boolean))]
        processData = { active_crews: crews, total_assignments_sampled: (assigns || []).length }
      }

      return {
        result: {
          process: input.process,
          recent_jobs: timings,
          common_event_types: [...new Set(events.map((e: any) => e.event_type))],
          confirmed_business_rules: rulesContext,
          process_specific_data: processData,
          instruction: `Generate a detailed SOP for the "${input.process}" process based on this real job data AND the confirmed business rules below. Include: numbered steps, responsible person (Shaun=ops, Nathan/Khairo=sales, Marnin=CEO), timing benchmarks from the data, business rules as mandatory checkpoints, and exception handling. Format as markdown.`,
        },
      }
    }

    case 'get_ai_alerts': {
      const sb = sbClient()
      let query = sb.from('ai_alerts')
        .select('*')
        .eq('org_id', DEFAULT_ORG_ID)
        .is('dismissed_at', null)
        .is('resolved_at', null)
        .order('created_at', { ascending: false })
        .limit(50)

      if (input.severity && input.severity !== 'all') {
        query = query.eq('severity', input.severity)
      }

      const { data, error } = await query
      if (error) {
        // Table might not exist yet
        return { result: { alerts: [], note: 'ai_alerts table may not exist yet — run the migration' } }
      }
      return { result: { alerts: data || [] } }
    }

    case 'explain_pnl': {
      const sb = sbClient()
      const now = new Date()
      const period = input.period || now.toISOString().slice(0, 7)
      const monthStart = period + '-01'
      const monthEnd = new Date(parseInt(period.slice(0, 4)), parseInt(period.slice(5, 7)), 0).toISOString().slice(0, 10)

      // Get Xero P&L from reports
      const { data: plReport } = await sb.from('xero_reports')
        .select('report_json')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('report_type', 'profit_and_loss')
        .gte('period_start', monthStart)
        .order('report_date', { ascending: false })
        .limit(1)
        .maybeSingle()

      // Get jobs completed this month but not invoiced
      const { data: completedNotInvoiced } = await sb.from('jobs')
        .select('id, job_number, client_name, pricing_json, completed_at, status')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('legacy', false)
        .eq('status', 'complete')
        .gte('completed_at', monthStart)

      // Get POs created this month (costs hitting P&L)
      const { data: monthPOs } = await sb.from('purchase_orders')
        .select('id, po_number, supplier_name, total, job_id, status, created_at')
        .eq('org_id', DEFAULT_ORG_ID)
        .neq('status', 'deleted')
        .gte('created_at', monthStart)
        .lte('created_at', monthEnd + 'T23:59:59')

      // Get invoices sent this month
      const { data: monthInvoices } = await sb.from('xero_invoices')
        .select('id, contact_name, total, amount_paid, status, date, job_id')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('type', 'ACCREC')
        .gte('date', monthStart)
        .lte('date', monthEnd)

      // Get bank balance if available
      const { data: bankBal } = await sb.from('xero_bank_balances')
        .select('account_name, balance, synced_at')
        .eq('org_id', DEFAULT_ORG_ID)
        .order('synced_at', { ascending: false })
        .limit(5)

      const qv = (j) => Number(j.pricing_json?.total || j.pricing_json?.grandTotal || j.pricing_json?.totalIncGST || 0)
      const unbilledTotal = (completedNotInvoiced || []).reduce((s, j) => s + qv(j), 0)
      const poTotal = (monthPOs || []).reduce((s, p) => s + Number(p.total || 0), 0)
      const invoicedTotal = (monthInvoices || []).reduce((s, i) => s + Number(i.total || 0), 0)
      const collectedTotal = (monthInvoices || []).reduce((s, i) => s + Number(i.amount_paid || 0), 0)

      // POs for jobs not yet completed (prepaid costs)
      const completedJobIds = new Set((completedNotInvoiced || []).map(j => j.id))
      const prepaidPOs = (monthPOs || []).filter(p => p.job_id && !completedJobIds.has(p.job_id))
      const prepaidTotal = prepaidPOs.reduce((s, p) => s + Number(p.total || 0), 0)

      return {
        result: {
          period,
          xero_pl_available: !!plReport,
          invoiced_this_month: Math.round(invoicedTotal),
          collected_this_month: Math.round(collectedTotal),
          unbilled_completed_jobs: {
            count: (completedNotInvoiced || []).length,
            total: Math.round(unbilledTotal),
            jobs: (completedNotInvoiced || []).map(j => ({
              job_number: j.job_number, client_name: j.client_name,
              value: qv(j), days_since_completed: Math.round((now.getTime() - new Date(j.completed_at).getTime()) / 86400000),
            })),
          },
          po_costs_this_month: Math.round(poTotal),
          prepaid_costs_for_future_jobs: Math.round(prepaidTotal),
          bank_balances: (bankBal || []).map(b => ({ account: b.account_name, balance: Number(b.balance) })),
          explanation_context: 'If Xero P&L shows a loss but jobs are profitable, it is likely because: (1) unbilled completed jobs = revenue earned but not yet in Xero, (2) prepaid PO costs = supplier bills for upcoming jobs hitting this month. The AI should explain this in plain English using the specific numbers above.',
        },
      }
    }

    case 'cash_flow_forecast': {
      const sb = sbClient()
      const now = new Date()
      const days = input.days || 90

      // Outstanding receivables (money coming in)
      const { data: receivables } = await sb.from('xero_invoices')
        .select('contact_name, total, amount_due, amount_paid, due_date, status, job_id')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('type', 'ACCREC')
        .in('status', ['AUTHORISED', 'SUBMITTED'])

      // Outstanding payables (money going out)
      const { data: payables } = await sb.from('xero_aged_payables')
        .select('contact_name, amount_due, age_bucket')
        .eq('org_id', DEFAULT_ORG_ID)
        .order('synced_at', { ascending: false })
        .limit(100)

      // Confirmed POs not yet billed (upcoming costs)
      const { data: uncommittedPOs } = await sb.from('purchase_orders')
        .select('supplier_name, total, status, delivery_date')
        .eq('org_id', DEFAULT_ORG_ID)
        .in('status', ['draft', 'submitted', 'authorised', 'sent', 'confirmed'])

      // Bank balance
      const { data: bankBal } = await sb.from('xero_bank_balances')
        .select('account_name, balance')
        .eq('org_id', DEFAULT_ORG_ID)
        .order('synced_at', { ascending: false })
        .limit(5)

      // Scheduled jobs (future revenue)
      const { data: scheduledJobs } = await sb.from('jobs')
        .select('id, job_number, client_name, pricing_json, status')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('legacy', false)
        .in('status', ['accepted', 'scheduled', 'in_progress'])

      const totalReceivable = (receivables || []).reduce((s, i) => s + Number(i.amount_due || 0), 0)
      const totalPayable = (payables || []).reduce((s, p) => s + Number(p.amount_due || 0), 0)
      const totalPOCommitted = (uncommittedPOs || []).reduce((s, p) => s + Number(p.total || 0), 0)
      const totalBankBalance = (bankBal || []).reduce((s, b) => s + Number(b.balance || 0), 0)
      const qv = (j) => Number(j.pricing_json?.total || j.pricing_json?.grandTotal || 0)
      const scheduledValue = (scheduledJobs || []).reduce((s, j) => s + qv(j), 0)

      // Project by period
      const due30 = (receivables || []).filter(i => {
        if (!i.due_date) return true
        const daysUntilDue = (new Date(i.due_date).getTime() - now.getTime()) / 86400000
        return daysUntilDue <= 30
      }).reduce((s, i) => s + Number(i.amount_due || 0), 0)

      const due60 = (receivables || []).filter(i => {
        if (!i.due_date) return false
        const daysUntilDue = (new Date(i.due_date).getTime() - now.getTime()) / 86400000
        return daysUntilDue > 30 && daysUntilDue <= 60
      }).reduce((s, i) => s + Number(i.amount_due || 0), 0)

      return {
        result: {
          current_bank_balance: Math.round(totalBankBalance),
          bank_accounts: (bankBal || []).map(b => ({ name: b.account_name, balance: Number(b.balance) })),
          money_coming_in: {
            outstanding_invoices: Math.round(totalReceivable),
            expected_next_30_days: Math.round(due30),
            expected_30_to_60_days: Math.round(due60),
            scheduled_job_pipeline: Math.round(scheduledValue),
          },
          money_going_out: {
            outstanding_payables: Math.round(totalPayable),
            committed_pos: Math.round(totalPOCommitted),
          },
          net_position: Math.round(totalBankBalance + totalReceivable - totalPayable - totalPOCommitted),
          forecast_30_day: Math.round(totalBankBalance + due30 - totalPayable),
          top_debtors: (receivables || []).sort((a, b) => Number(b.amount_due || 0) - Number(a.amount_due || 0)).slice(0, 5).map(i => ({
            client: i.contact_name, amount: Math.round(Number(i.amount_due || 0)), due: i.due_date,
          })),
        },
      }
    }

    case 'unbilled_revenue': {
      const sb = sbClient()
      const now = new Date()

      const { data: completed } = await sb.from('jobs')
        .select('id, job_number, client_name, type, pricing_json, completed_at')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('legacy', false)
        .eq('status', 'complete')

      // Check which have invoices
      const jobIds = (completed || []).map(j => j.id)
      let invoicedJobIds = new Set()
      if (jobIds.length > 0) {
        const { data: invoices } = await sb.from('xero_invoices')
          .select('job_id')
          .in('job_id', jobIds)
          .eq('type', 'ACCREC')
        invoicedJobIds = new Set((invoices || []).map(i => i.job_id))
      }

      const unbilled = (completed || []).filter(j => !invoicedJobIds.has(j.id))
      const qv = (j) => Number(j.pricing_json?.total || j.pricing_json?.grandTotal || j.pricing_json?.totalIncGST || 0)

      return {
        result: {
          unbilled_count: unbilled.length,
          unbilled_total: Math.round(unbilled.reduce((s, j) => s + qv(j), 0)),
          jobs: unbilled.map(j => ({
            job_number: j.job_number,
            client_name: j.client_name,
            type: j.type,
            value: Math.round(qv(j)),
            days_since_completed: Math.round((now.getTime() - new Date(j.completed_at).getTime()) / 86400000),
          })).sort((a, b) => b.value - a.value),
          urgency: unbilled.length > 0 ? 'Send these invoices today. Every day without an invoice delays payment by at least that long.' : 'All completed jobs are invoiced.',
        },
      }
    }

    case 'division_comparison': {
      const sb = sbClient()
      const months = input.period_months || 6
      const since = new Date(Date.now() - months * 30 * 86400000).toISOString().slice(0, 10)

      const { data: jobs } = await sb.from('jobs')
        .select('id, type, pricing_json, completed_at, accepted_at, status')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('legacy', false)
        .in('status', ['complete', 'invoiced'])
        .gte('completed_at', since)

      const { data: pos } = await sb.from('purchase_orders')
        .select('job_id, total')
        .eq('org_id', DEFAULT_ORG_ID)
        .neq('status', 'deleted')
        .not('job_id', 'is', null)

      const { data: assignments } = await sb.from('job_assignments')
        .select('job_id, scheduled_date, scheduled_end')
        .eq('assignment_type', 'install')

      const poCosts = {}
      for (const po of (pos || [])) { poCosts[po.job_id] = (poCosts[po.job_id] || 0) + Number(po.total || 0) }

      // Days on site per job (from assignments)
      const jobDays = {}
      for (const a of (assignments || [])) {
        const start = new Date(a.scheduled_date)
        const end = a.scheduled_end ? new Date(a.scheduled_end) : start
        const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1)
        jobDays[a.job_id] = (jobDays[a.job_id] || 0) + days
      }

      const divisions = {}
      const qv = (j) => Number(j.pricing_json?.total || j.pricing_json?.grandTotal || 0)

      for (const j of (jobs || [])) {
        const type = j.type || 'other'
        if (!divisions[type]) divisions[type] = { count: 0, revenue: 0, cost: 0, total_days: 0, durations: [] }
        const d = divisions[type]
        d.count++
        d.revenue += qv(j)
        d.cost += poCosts[j.id] || 0
        const crewDays = jobDays[j.id] || 0
        d.total_days += crewDays
        if (j.accepted_at && j.completed_at) {
          d.durations.push(Math.round((new Date(j.completed_at).getTime() - new Date(j.accepted_at).getTime()) / 86400000))
        }
      }

      const comparison = Object.entries(divisions).map(([type, d]) => ({
        division: type,
        jobs: d.count,
        total_revenue: Math.round(d.revenue),
        total_material_cost: Math.round(d.cost),
        avg_job_value: Math.round(d.revenue / d.count),
        avg_material_cost: Math.round(d.cost / d.count),
        implied_margin_pct: d.revenue > 0 ? Math.round(((d.revenue - d.cost) / d.revenue) * 100) : null,
        avg_duration_days: d.durations.length > 0 ? Math.round(d.durations.reduce((a, b) => a + b, 0) / d.durations.length) : null,
        revenue_per_crew_day: d.total_days > 0 ? Math.round(d.revenue / d.total_days) : null,
      })).sort((a, b) => b.total_revenue - a.total_revenue)

      return { result: { period_months: months, divisions: comparison } }
    }

    case 'cost_trend_analysis': {
      const sb = sbClient()
      const category = input.category || 'all'

      // Get from material_price_ledger if it has data
      const { data: ledger } = await sb.from('material_price_ledger')
        .select('supplier_name, material_category, material_code, unit_price, captured_at, status')
        .eq('org_id', DEFAULT_ORG_ID)
        .order('captured_at', { ascending: true })

      // Also analyse PO costs over time
      const { data: pos } = await sb.from('purchase_orders')
        .select('id, supplier_name, total, line_items, created_at, job_id')
        .eq('org_id', DEFAULT_ORG_ID)
        .neq('status', 'deleted')
        .order('created_at', { ascending: true })

      // Group PO costs by supplier over time (monthly)
      const supplierMonthly = {}
      for (const po of (pos || [])) {
        const month = (po.created_at || '').slice(0, 7)
        const supplier = po.supplier_name || 'Unknown'
        if (!supplierMonthly[supplier]) supplierMonthly[supplier] = {}
        if (!supplierMonthly[supplier][month]) supplierMonthly[supplier][month] = { count: 0, total: 0 }
        supplierMonthly[supplier][month].count++
        supplierMonthly[supplier][month].total += Number(po.total || 0)
      }

      // Calculate trends
      const trends = Object.entries(supplierMonthly).map(([supplier, months]) => {
        const sortedMonths = Object.entries(months).sort((a, b) => a[0].localeCompare(b[0]))
        const avgPerPO = sortedMonths.map(([m, d]) => ({ month: m, avg: Math.round(d.total / d.count) }))
        const firstAvg = avgPerPO.length > 0 ? avgPerPO[0].avg : 0
        const lastAvg = avgPerPO.length > 0 ? avgPerPO[avgPerPO.length - 1].avg : 0
        const changePct = firstAvg > 0 ? Math.round(((lastAvg - firstAvg) / firstAvg) * 100) : 0
        return { supplier, months: avgPerPO, change_pct: changePct, total_pos: sortedMonths.reduce((s, [, d]) => s + d.count, 0) }
      }).sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))

      // Price ledger analysis
      const ledgerEntries = (ledger || []).filter(l => category === 'all' || l.material_category === category)

      return {
        result: {
          supplier_cost_trends: trends,
          price_ledger_entries: ledgerEntries.length,
          price_ledger_sample: ledgerEntries.slice(0, 20).map(l => ({
            supplier: l.supplier_name, item: l.material_code || l.material_category,
            price: Number(l.unit_price), date: l.captured_at, status: l.status,
          })),
          note: trends.length > 0 ? 'Positive change_pct means costs are rising. Flag any supplier with >5% increase over the period.' : 'Not enough PO data yet for trend analysis.',
        },
      }
    }

    case 'check_supplier_pricing': {
      const sb = sbClient()
      const category = input.category || 'all'

      // Fencing detection keywords — if a PO or ledger item contains these, it's fencing
      const FENCING_KEYWORDS = ['fence', 'fencing', 'panel', 'post', 'rail', 'plinth', 'colorbond', 'gate', 'hardie', 'super6']

      // Detect division from category or fetch both
      const isFencingCategory = category.startsWith('fencing_')
      const isPatio = category === 'roofing' || category === 'steel' || category === 'concrete'

      // Get scope tool defaults — query correct scope_tool based on category, or both if 'all'
      let defaultsQuery = sb.from('scope_tool_defaults')
        .select('scope_tool, category, item_key, item_description, material_code, unit, default_price, default_cost_rate, last_updated_at')
        .eq('org_id', DEFAULT_ORG_ID)
      if (isFencingCategory) {
        defaultsQuery = defaultsQuery.eq('scope_tool', 'fence-designer').eq('category', category)
      } else if (isPatio) {
        defaultsQuery = defaultsQuery.eq('scope_tool', 'patio-tool').eq('category', category)
      } else if (category !== 'all') {
        defaultsQuery = defaultsQuery.eq('category', category)
      }
      // Skip surcharge/panel-width rows — not comparable to supplier prices
      defaultsQuery = defaultsQuery.not('category', 'in', '("fencing_surcharge","fencing_panels")')
      const { data: defaults } = await defaultsQuery

      // Get recent confirmed ledger prices (last 90 days)
      const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString()
      let ledgerQuery = sb.from('material_price_ledger')
        .select('supplier_name, material_category, material_code, item_description, unit_price, captured_at, status, job_id')
        .eq('org_id', DEFAULT_ORG_ID)
        .in('status', ['confirmed', 'pending'])
        .gte('captured_at', ninetyDaysAgo)
        .order('captured_at', { ascending: false })
      if (category !== 'all' && !isFencingCategory) ledgerQuery = ledgerQuery.eq('material_category', category)
      const { data: ledger } = await ledgerQuery

      // For fencing ledger entries, also match by keywords in item_description
      const classifyLedgerEntry = (l: any): 'fencing' | 'patio' | 'unknown' => {
        const desc = ((l.item_description || '') + ' ' + (l.material_code || '') + ' ' + (l.material_category || '')).toLowerCase()
        if (FENCING_KEYWORDS.some(kw => desc.includes(kw))) return 'fencing'
        if (['roofing', 'solarspan', 'trimdek', 'spandek', 'corrugated', 'spanplus'].some(kw => desc.includes(kw))) return 'patio'
        return 'unknown'
      }

      // Compare: for each default, find matching ledger entries and compute drift
      const driftItems: any[] = []
      for (const def of (defaults || [])) {
        const defScopeTool = def.scope_tool || 'patio-tool'
        const isFencingDefault = defScopeTool === 'fence-designer'

        // Match ledger entries by material_code, item_key, or description similarity
        const matches = (ledger || []).filter((l: any) => {
          // Division filter: fencing defaults should only match fencing ledger items
          if (isFencingDefault && classifyLedgerEntry(l) === 'patio') return false
          if (!isFencingDefault && classifyLedgerEntry(l) === 'fencing') return false

          const code = (l.material_code || '').toLowerCase()
          const desc = (l.item_description || '').toLowerCase()
          const key = def.item_key.toLowerCase()
          const matCode = (def.material_code || '').toLowerCase()
          return code.includes(key) || desc.includes(key) || key.includes(code)
            || (matCode && (code.includes(matCode) || desc.includes(matCode)))
        })

        if (matches.length === 0) continue

        // Use most recent price
        const latestPrice = Number(matches[0].unit_price)
        const defaultPrice = Number(def.default_price || def.default_cost_rate)
        if (!defaultPrice || !latestPrice) continue

        const driftPct = Math.round(((latestPrice - defaultPrice) / defaultPrice) * 100)
        if (Math.abs(driftPct) < 3) continue // Ignore tiny drift

        driftItems.push({
          item: def.item_description,
          item_key: def.item_key,
          scope_tool: defScopeTool,
          category: def.category,
          scope_tool_rate: defaultPrice,
          latest_supplier_rate: latestPrice,
          drift_pct: driftPct,
          direction: driftPct > 0 ? 'supplier_higher' : 'supplier_lower',
          supplier: matches[0].supplier_name,
          last_po_date: matches[0].captured_at,
          sample_count: matches.length,
        })
      }

      driftItems.sort((a, b) => Math.abs(b.drift_pct) - Math.abs(a.drift_pct))

      // Group summary by division
      const patioItems = driftItems.filter(d => d.scope_tool === 'patio-tool')
      const fencingItems = driftItems.filter(d => d.scope_tool === 'fence-designer')

      return {
        result: {
          drift_items: driftItems,
          by_division: {
            patio: { count: patioItems.length, items: patioItems },
            fencing: { count: fencingItems.length, items: fencingItems },
          },
          defaults_count: (defaults || []).length,
          ledger_entries_checked: (ledger || []).length,
          summary: driftItems.length > 0
            ? `Found ${driftItems.length} items with price drift >3% (${patioItems.length} patio, ${fencingItems.length} fencing). Largest: ${driftItems[0].item} at ${driftItems[0].drift_pct}% ${driftItems[0].direction === 'supplier_higher' ? 'above' : 'below'} scope tool rate.`
            : 'No significant price drift detected between scope tool defaults and recent supplier prices.',
          instruction: driftItems.length > 0
            ? 'Present the drift items grouped by division (patio vs fencing). For items where suppliers are charging MORE than scope tool rates, recommend updating the scope tool. For items where suppliers are cheaper, note the margin improvement. Flag any COST-row drift separately from SELL-row drift.'
            : 'Report that pricing is aligned. Mention when defaults were last updated and how many defaults exist per division.',
        },
      }
    }

    // ── Execute tools (all require confirmation) ──
    case 'execute_create_invoice':
      return {
        result: {
          action: input.type === 'deposit' ? 'create_deposit_invoice' : 'create_unified_invoice',
          params: { job_id: input.job_id, type: input.type, line_items: input.line_items, percentage: input.percentage, xero_status: 'DRAFT', send_email: false },
          message: `Create ${input.type} invoice (DRAFT) for this job?\n• Type: ${input.type}\n• Amount: ${input.percentage ? input.percentage + '% deposit' : 'as specified'}\n• Status: DRAFT (review in Xero before sending)`,
        },
        needs_confirm: true,
      }
    case 'execute_send_sms':
      return {
        result: {
          action: 'send_sms',
          params: { contactId: input.contact_id, message: input.message_text, jobId: input.job_id },
          message: `Send SMS: "${input.message_text}"`,
        },
        needs_confirm: true,
      }
    case 'execute_update_status':
      return {
        result: {
          action: 'update_job_status',
          params: { jobId: input.job_id, status: input.new_status },
          message: `Update job status to "${input.new_status}"?`,
        },
        needs_confirm: true,
      }
    case 'execute_create_po':
      return {
        result: {
          action: 'create_po',
          params: { job_id: input.job_id, supplier_name: input.supplier, line_items: input.line_items },
          message: `Create PO for ${input.supplier}?`,
        },
        needs_confirm: true,
      }
    case 'execute_assign_crew':
      return {
        result: {
          action: 'create_assignment',
          params: { job_id: input.job_id, user_id: input.user_id, scheduled_date: input.scheduled_date, assignment_type: input.assignment_type || 'install' },
          message: `Assign crew on ${input.scheduled_date}?`,
        },
        needs_confirm: true,
      }

    // ── New capability tools ──
    case 'get_client_conversation': {
      const url = new URL(`${SUPABASE_URL}/functions/v1/ghl-proxy`)
      url.searchParams.set('action', 'get_conversation')
      url.searchParams.set('contactId', input.contact_id)
      const resp = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
      })
      return { result: await resp.json() }
    }

    case 'execute_send_email':
      return {
        result: {
          action: 'send_email',
          params: { contactId: input.contact_id, subject: input.subject, htmlBody: input.html_body, jobId: input.job_id },
          message: `Send email "${input.subject}" to this contact?`,
        },
        needs_confirm: true,
      }

    case 'execute_send_quote':
      return {
        result: {
          action: 'send_quote',
          params: { job_id: input.job_id },
          message: `Send the quote PDF to the client for this job?`,
        },
        needs_confirm: true,
      }

    case 'execute_push_po_to_xero':
      return {
        result: {
          action: 'push_po_to_xero',
          params: { po_id: input.po_id, status: input.status || 'DRAFT' },
          message: `Push PO to Xero as ${input.status || 'DRAFT'}?`,
        },
        needs_confirm: true,
      }

    case 'execute_add_ghl_note':
      return {
        result: {
          action: 'add_ghl_note',
          params: { contactId: input.contact_id, body: input.note_body, jobId: input.job_id },
          message: `Add note to contact: "${input.note_body.slice(0, 80)}${input.note_body.length > 80 ? '...' : ''}"?`,
        },
        needs_confirm: true,
      }

    case 'execute_email_supplier_po':
      return {
        result: {
          action: 'email_supplier_po',
          params: { po_id: input.po_id, job_id: input.job_id },
          message: `Email this PO to the supplier?`,
        },
        needs_confirm: true,
      }

    case 'execute_send_telegram':
      return {
        result: {
          action: 'send_telegram',
          params: { user_email: input.user_email, user_name: input.user_name, message: input.message },
          message: `Send Telegram message to ${input.user_name || input.user_email || 'team member'}: "${input.message.slice(0, 80)}${input.message.length > 80 ? '...' : ''}"?`,
        },
        needs_confirm: true,
      }

    case 'rough_estimate': {
      // Query historical jobs of same type for pricing data
      const sb = sbClient()
      const jobType = (input.job_type || '').toLowerCase()
      const typeFilter = jobType === 'fencing' ? 'fencing' : jobType === 'patio' ? 'patio' : jobType === 'decking' ? 'decking' : null

      let query = sb.from('jobs')
        .select('id, job_number, type, pricing_json, quoted_value, site_suburb, status')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('legacy', false)
        .not('quoted_value', 'is', null)
        .gt('quoted_value', 0)
        .in('status', ['quoted', 'accepted', 'scheduled', 'in_progress', 'complete', 'invoiced'])
        .order('created_at', { ascending: false })
        .limit(50)

      if (typeFilter) query = query.eq('type', typeFilter)

      const { data: historicalJobs } = await query

      // Extract pricing patterns
      const priceData = (historicalJobs || []).map(j => ({
        type: j.type,
        suburb: j.site_suburb,
        quoted: Number(j.quoted_value),
        has_pricing: !!j.pricing_json,
      }))

      const avgQuote = priceData.length > 0
        ? Math.round(priceData.reduce((sum, j) => sum + j.quoted, 0) / priceData.length)
        : null

      return {
        result: {
          description: input.description,
          job_type: jobType || 'unknown',
          historical_sample_size: priceData.length,
          average_quoted_value: avgQuote,
          price_range: priceData.length >= 3 ? {
            low: Math.round(priceData.sort((a, b) => a.quoted - b.quoted)[Math.floor(priceData.length * 0.25)]?.quoted || 0),
            median: Math.round(priceData[Math.floor(priceData.length * 0.5)]?.quoted || 0),
            high: Math.round(priceData[Math.floor(priceData.length * 0.75)]?.quoted || 0),
          } : null,
          sample_jobs: priceData.slice(0, 10),
          note: 'This is a ROUGH estimate based on historical data only. Use the scope tool for accurate quoting. Tell the user the range and that it depends on site conditions, materials chosen, etc.',
        },
      }
    }

    case 'get_quote_terms': {
      const template = (input.template || '').toLowerCase()
      if (template.includes('patio')) {
        return { result: {
          template: 'patio',
          terms: {
            quotation: 'This quote is valid for 30 days from the date of issue. Pricing is subject to change after this period due to material cost fluctuations. This quote is based on the scope of works described above. Any additional works, site conditions not visible at time of quoting, or client-requested changes will be quoted separately as a variation. All prices include GST unless otherwise stated.',
            payment: '20% deposit is required to confirm your booking date and secure scheduling. A planning/permit fee may also apply if council approval is required (quoted separately if applicable). An additional 50% of the total is due 25 days prior to the confirmed job start date. This allows sufficient time for material ordering, fabrication, and delivery coordination. The remaining 30% balance is due upon satisfactory completion of all works. We will conduct a final walkthrough with you to ensure you are completely happy before requesting final payment. Failure to make progress payments within the agreed timeframes may result in delays to your project start date.',
            scope_of_works: 'All structural steel is powder-coated Colorbond steel, engineered to Australian Standards (AS/NZS 1170 & AS 4100) and the National Construction Code (NCC). Footings are designed to meet or exceed local engineering requirements for wind region N2 (standard suburban). Coastal or exposed sites (N3+) may require upgraded footings at additional cost. Electrical work (downlights, fans, GPOs), plumbing, and any trade work outside of patio construction is excluded unless specifically listed in the scope above. Where existing structures (gutters, fascia, roofing) are modified as part of the connection, we take all reasonable care. Minor cosmetic touch-ups to existing surfaces are included; however, pre-existing defects or deterioration are not our responsibility. Clean-up of the work area and removal of construction waste is included as standard.',
            construction_access: 'The client is responsible for ensuring clear and safe access to the work area for personnel, vehicles, and material deliveries. Any access restrictions must be communicated prior to the job start. We require a minimum clear working zone of 1.5 metres around the build area. Temporary relocation of garden furniture, pot plants, or other items is the client\'s responsibility unless otherwise arranged. Construction timelines provided are estimates and may be affected by weather, material availability, or unforeseen site conditions. We will keep you informed of any changes. Standard construction hours are Monday–Friday 7:00am–3:30pm, in accordance with local council noise regulations.',
            warranty: 'All workmanship is backed by our 10-year structural warranty covering the steel frame, connections, and footings. Roofing materials carry the manufacturer\'s warranty (BlueScope Colorbond: up to 36 years; Bondor SolarSpan: 15 years) subject to their terms and conditions. Powder coating is warranted against peeling, cracking, or flaking for 10 years under normal conditions. Minor surface scratches from construction are touched up on completion. Our warranty does not cover damage caused by third parties, unauthorised modifications, extreme weather events beyond design parameters, or lack of reasonable maintenance.',
            general: 'All works are designed and constructed in compliance with the National Construction Code (NCC), Australian Standards (AS/NZS 1170, AS 4100), and relevant WA building regulations. SecureWorks Group Pty Ltd (ABN 64 689 223 416) is fully licensed and insured for structural patio and outdoor construction in Western Australia. We maintain public liability insurance and workers\' compensation coverage for all personnel on site. Payment of the deposit or written confirmation (email, SMS, or signed copy) constitutes acceptance of this quote and these Terms & Conditions in full. Any dispute will be resolved in good faith through direct communication. If unresolved, mediation under WA consumer protection laws will apply. The client confirms they are the property owner or have authority to authorise works, and that any required body corporate, strata, or HOA approvals have been obtained prior to commencement.',
          },
        }}
      } else if (template.includes('fenc')) {
        return { result: {
          template: 'fencing',
          disclaimers: [
            'This quote is based on information provided and a standard site assessment. Actual costs may vary if unforeseen site conditions are encountered during installation, including but not limited to rock, tree roots, clay, underground services, water table, or non-standard soil conditions. Any additional costs arising from such conditions will be communicated before proceeding.',
            'Customer is responsible for confirming property boundaries before installation. SecureWorks Group strongly recommends engaging a licensed surveyor to mark boundaries prior to works commencing. SecureWorks Group accepts no liability for fencing installed on incorrect boundaries or for any disputes arising from boundary placement.',
            'Retaining walls over 500mm in height may require a Building Permit and/or engineer certification under the Building Act 2011 (WA) and associated regulations. Customer is responsible for obtaining all required approvals, permits, and certifications prior to commencement. SecureWorks Group can assist with applications upon request at additional cost.',
            'This quote does not include any electrical or plumbing relocation, stormwater management, tree removal requiring council approval, asbestos testing or removal, or any works not specifically listed in the scope above. Any additional works requested after acceptance will be quoted separately.',
            'Payment terms: 50% deposit required to confirm booking and secure materials. Balance due on day of completion prior to handover. Overdue accounts incur interest at the rate of 2% per month (24% per annum) compounding. The customer is liable for all collection costs, including legal fees, in the event of non-payment.',
            'All COLORBOND steel products carry the manufacturer\'s standard warranty (BlueScope 10-year fencing warranty). SecureWorks Group provides a 12-month workmanship warranty from the date of completion covering defects in installation. This warranty does not cover damage caused by third parties, acts of nature, ground movement, or unauthorised modifications.',
            'This quote is valid for 30 days from the date of issue. After this period, pricing may be subject to change due to material cost fluctuations. A new quote will be provided upon request.',
            'SecureWorks Group holds appropriate public liability insurance and workers\' compensation coverage for all works performed. Copies of insurance certificates are available upon request.',
            'The customer must provide clear and safe access to the worksite for the duration of works. Any delays caused by restricted access, adverse weather, or other factors outside SecureWorks Group\'s control may result in schedule adjustments. SecureWorks Group is not liable for consequential losses arising from such delays.',
            'Site cleanup is included as part of the scope of works. SecureWorks Group will remove all installation debris and excess materials. Any existing waste, dumped materials, or items not related to this project remain the customer\'s responsibility.',
            'By accepting this quote, the customer agrees to these terms and conditions in full. Acceptance may be communicated in writing, via email, or by payment of the deposit. Verbal acceptance followed by deposit payment constitutes a binding agreement.',
            'Either party may cancel this agreement in writing. If the customer cancels after deposit has been paid and materials have been ordered, the deposit is non-refundable to the extent of costs already incurred. SecureWorks Group will provide an itemised breakdown of costs incurred upon request.',
          ],
        }}
      } else {
        return { result: { error: 'Unknown template. Use "patio" or "fencing".' } }
      }
    }

    case 'execute_reconcile_payment':
      return {
        result: {
          action: 'reconcile_payment',
          params: {
            invoice_id: input.invoice_id,
            amount: input.amount,
            payment_date: input.payment_date || awstDate(),
            reference: input.reference || '',
            account_code: input.account_code || '',
          },
          message: `Record $${Number(input.amount).toLocaleString()} payment against invoice${input.reference ? ` (ref: ${input.reference})` : ''}?`,
        },
        needs_confirm: true,
      }

    // ── Batch 2: New tool handlers ──
    case 'list_variations': {
      const params: Record<string, string> = {}
      if (input.job_id) params.job_id = input.job_id
      if (input.status) params.status = input.status
      return { result: await callOpsApi('list_variations', params) }
    }
    case 'list_council_submissions': {
      const params: Record<string, string> = {}
      if (input.job_id) params.job_id = input.job_id
      if (input.status) params.status = input.status
      return { result: await callOpsApi('list_council_submissions', params) }
    }
    case 'list_expenses': {
      const params: Record<string, string> = {}
      if (input.from) params.from = input.from
      if (input.to) params.to = input.to
      if (input.status) params.status = input.status
      return { result: await callOpsApi('list_expenses', params) }
    }
    case 'list_purchase_orders': {
      const params: Record<string, string> = {}
      if (input.job_id) params.job_id = input.job_id
      if (input.supplier) params.supplier = input.supplier
      if (input.status) params.status = input.status
      return { result: await callOpsApi('list_pos', params) }
    }
    case 'list_work_orders': {
      const params: Record<string, string> = {}
      if (input.job_id) params.job_id = input.job_id
      if (input.status) params.status = input.status
      return { result: await callOpsApi('list_work_orders', params) }
    }
    case 'execute_create_work_order':
      return {
        result: {
          action: 'create_work_order',
          params: { job_id: input.job_id, description: input.description || '', assigned_to: input.assigned_to || '' },
          message: `Create work order for job${input.description ? ': ' + input.description : ''}?`,
        },
        needs_confirm: true,
      }
    case 'get_crew_availability': {
      const params: Record<string, string> = {}
      if (input.from) params.from = input.from
      if (input.to) params.to = input.to
      return { result: await callOpsApi('get_crew_availability', params) }
    }
    case 'list_suppliers':
      return { result: await callOpsApi('list_suppliers') }
    case 'get_email_events': {
      const params: Record<string, string> = {}
      if (input.job_id) params.job_id = input.job_id
      if (input.email) params.email = input.email
      if (input.limit) params.limit = String(input.limit)
      return { result: await callOpsApi('get_email_events', params) }
    }
    case 'execute_send_review_request':
      return {
        result: {
          action: 'send_review_request',
          params: { job_id: input.job_id, method: input.method || 'sms' },
          message: `Send Google review request via ${input.method || 'sms'}?`,
        },
        needs_confirm: true,
      }
    case 'search_ghl_contacts': {
      const params: Record<string, string> = { q: input.search }
      return { result: await callGhlProxy('search', params) }
    }
    case 'get_team_activity': {
      const sb = sbClient()
      const hours = input.hours || 24
      const since = new Date(Date.now() - hours * 3600000).toISOString()
      let query = sb.from('job_events')
        .select('id, job_id, event_type, detail_json, created_at, users:user_id(name)')
        .eq('org_id', DEFAULT_ORG_ID)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(50)
      if (input.user_id) query = query.eq('user_id', input.user_id)
      const { data: events } = await query

      // Get job names for context
      const jobIds = [...new Set((events || []).map((e: any) => e.job_id).filter(Boolean))]
      let jobNames: Record<string, string> = {}
      if (jobIds.length > 0) {
        const { data: jobs } = await sb.from('jobs').select('id, client_name, job_number').in('id', jobIds.slice(0, 100))
        for (const j of (jobs || [])) jobNames[j.id] = `${j.job_number} (${j.client_name})`
      }

      return {
        result: {
          events: (events || []).map((e: any) => ({
            type: e.event_type,
            job: jobNames[e.job_id] || e.job_id,
            who: e.users?.name || 'System',
            when: e.created_at,
            detail: typeof e.detail_json === 'string' ? e.detail_json.slice(0, 200) : JSON.stringify(e.detail_json || {}).slice(0, 200),
          })),
          total: (events || []).length,
          period: `Last ${hours} hours`,
        }
      }
    }
    case 'get_sales_leads': {
      const params: Record<string, string> = {}
      if (input.from) params.from = input.from
      if (input.status) params.status = input.status
      return { result: await callReportingApi('sales_leads', params) }
    }
    case 'get_inbox_summary': {
      const sb = sbClient()
      const hours = input.hours || 24
      const since = new Date(Date.now() - hours * 3600000).toISOString()
      let query = sb.from('inbox_events')
        .select('id, mailbox, from_email, from_name, subject, classification, priority, action_needed, job_id, received_at, telegram_notified')
        .eq('org_id', DEFAULT_ORG_ID)
        .gte('received_at', since)
        .order('received_at', { ascending: false })
        .limit(30)
      if (input.mailbox) query = query.eq('mailbox', input.mailbox)
      if (input.priority) query = query.eq('priority', input.priority)
      const { data: events } = await query

      // Summary stats
      const byClass: Record<string, number> = {}
      const byPriority: Record<string, number> = {}
      for (const e of (events || [])) {
        byClass[e.classification] = (byClass[e.classification] || 0) + 1
        byPriority[e.priority] = (byPriority[e.priority] || 0) + 1
      }

      return {
        result: {
          emails: (events || []).map((e: any) => ({
            from: e.from_name || e.from_email,
            subject: e.subject,
            classification: e.classification,
            priority: e.priority,
            action_needed: e.action_needed,
            received: e.received_at,
            mailbox: e.mailbox,
          })),
          total: (events || []).length,
          by_classification: byClass,
          by_priority: byPriority,
          period: `Last ${hours} hours`,
        },
      }
    }

    default:
      return { result: { error: `Unknown tool: ${name}` } }
  }
}

// ════════════════════════════════════════════════════════════
// CHAT LOGGING — fire-and-forget insert into chat_logs
// ════════════════════════════════════════════════════════════

function logChat(opts: {
  role: string
  query: string
  response: string
  toolsUsed: string[]
  jobIdsReferenced: string[]
  insightsGenerated: string[]
  caller?: CallerContext
}) {
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    sb.from('chat_logs')
      .insert({
        role: opts.role,
        query: opts.query,
        response: opts.response,
        tools_used: opts.toolsUsed,
        job_ids_referenced: opts.jobIdsReferenced,
        insights_generated: opts.insightsGenerated,
        channel: opts.caller?.channel || 'dashboard',
        caller_tier: opts.caller ? (['crew', 'lead_installer', 'division_ops', 'sales', 'admin'].indexOf(opts.caller.user_role) + 1) : 5,
      })
      .then(({ error }) => {
        if (error) console.error('[ops-ai] chat log insert error:', error.message)
      })
      .catch(() => {})
  } catch (e) {
    console.error('[ops-ai] chat log error:', e)
  }
}

// Log reasoning trace to ai_reasoning_traces table
async function logReasoningTrace(opts: {
  triggerType: string;
  correlationId?: string;
  modelName: string;
  promptVersion?: string;
  inputSnapshot: any;
  outputResult: any;
  outputType: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  iterationCount?: number;
  status?: string;
  reasoningSummary?: string;
}) {
  try {
    const sb = sbClient()
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(opts.inputSnapshot)))
    const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')

    const { data } = await sb.from('ai_reasoning_traces').insert({
      trigger_type: opts.triggerType,
      correlation_id: opts.correlationId || null,
      model_name: opts.modelName,
      prompt_template_version: opts.promptVersion || 'v1',
      input_context_snapshot: opts.inputSnapshot,
      input_context_hash: hashHex,
      reasoning_summary: opts.reasoningSummary || null,
      output_result: opts.outputResult,
      output_type: opts.outputType,
      input_tokens: opts.inputTokens || null,
      output_tokens: opts.outputTokens || null,
      cost_usd: opts.costUsd || null,
      latency_ms: opts.latencyMs || null,
      iteration_count: opts.iterationCount || 1,
      status: opts.status || 'completed',
      storage_tier: 'full',
    }).select('id').single()

    return data?.id || null
  } catch (e) {
    console.log('[ops-ai] reasoning trace write failed (table may not exist yet):', (e as Error).message)
    return null
  }
}

// ════════════════════════════════════════════════════════════
// EVALUATOR — Haiku validates proposed actions before confirmation
// ════════════════════════════════════════════════════════════

async function evaluateAction(
  action: string, params: any, context: { view: string; recentTools: string[]; jobContext?: any }
): Promise<{ approved: boolean; confidence: number; concerns: string[] }> {
  try {
    const resp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: `You are a business rules validator for SecureWorks Group construction company. Evaluate whether this proposed action is safe and logical. Check:
1. Does the action make sense given the context? (e.g., don't invoice before job complete)
2. Are there missing prerequisites? (e.g., materials not confirmed before scheduling)
3. Are the amounts reasonable? (e.g., invoice matches quote value)
4. Is the timing right? (e.g., not scheduling on weekends, not double-booking crew)
5. Is this a routine, legitimate business action? If so, approve it with high confidence.
Return ONLY valid JSON: { "approved": true/false, "confidence": 0.0-1.0, "concerns": ["list of issues if any"] }
IMPORTANT: Routine actions like creating invoices for completed jobs, scheduling crew on weekdays, or creating POs for accepted jobs should be approved with confidence >= 0.85. Only flag genuine logical issues.`,
        messages: [{ role: 'user', content: `Evaluate: ${action}\nParams: ${JSON.stringify(params)}\nContext: ${JSON.stringify(context)}` }],
      }),
    }, 60000)
    if (!resp.ok) return { approved: true, confidence: 0.5, concerns: [] }
    const result = await resp.json()
    const text = result.content?.[0]?.text || '{}'
    try {
      const parsed = JSON.parse(text)
      return {
        approved: parsed.approved !== false,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
      }
    } catch {
      const match = text.match(/\{[\s\S]*\}/)
      if (match) {
        try {
          const parsed = JSON.parse(match[0])
          return {
            approved: parsed.approved !== false,
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
            concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
          }
        } catch { /* fall through */ }
      }
      return { approved: true, confidence: 0.5, concerns: [] }
    }
  } catch (e) {
    console.log('[ops-ai] evaluator failed (allowing action):', (e as Error).message)
    return { approved: true, confidence: 0.5, concerns: [] }
  }
}

function computeConfidence(
  evaluatorConfidence: number,
  action: string,
  params: any,
  learnedBehaviors: Record<string, { approved: number; total: number }>
): number {
  let score = evaluatorConfidence

  // Precedent match: boost if this action type has high historical approval
  const history = learnedBehaviors[action]
  if (history && history.total >= 5) {
    const approvalRate = history.approved / history.total
    score = score * 0.7 + approvalRate * 0.3
  }

  // Business rule adjustments
  const amount = params.total || params.amount || 0
  if (amount > 10000) score *= 0.85
  if (amount > 20000) score *= 0.7

  return Math.round(score * 100) / 100
}

async function logShadowDecision(sb: any, decision: {
  action: string; params: any; confidence: number; concerns: string[];
  evaluator_approved: boolean; job_id: string | null; caller: any;
}) {
  try {
    await sb.from('business_events').insert({
      event_type: 'ai.shadow_decision',
      source: 'ops-ai/evaluator',
      entity_type: 'ai_decision',
      entity_id: crypto.randomUUID(),
      job_id: decision.job_id || null,
      payload: {
        action: decision.action,
        params: decision.params,
        confidence: decision.confidence,
        concerns: decision.concerns,
        evaluator_approved: decision.evaluator_approved,
      },
      metadata: {
        caller_name: decision.caller?.user_name || null,
        caller_role: decision.caller?.user_role || null,
        channel: decision.caller?.channel || null,
      },
      schema_version: '1.0',
    })
  } catch (e) {
    console.log('[ops-ai] shadow decision log failed:', (e as Error).message)
  }
}

async function getFeedbackHistory(): Promise<Record<string, { approved: number; total: number }>> {
  try {
    const sb = sbClient()
    const { data } = await sb.from('ai_feedback_outcomes')
      .select('feedback_category, human_action')
      .order('created_at', { ascending: false })
      .limit(200)

    const history: Record<string, { approved: number; total: number }> = {}
    for (const f of (data || [])) {
      const cat = f.feedback_category || 'unknown'
      if (!history[cat]) history[cat] = { approved: 0, total: 0 }
      history[cat].total++
      if (f.human_action === 'approved') history[cat].approved++
    }
    return history
  } catch {
    return {}
  }
}

// Level 2: Check whether an action can auto-execute (skip confirmation).
// All five gates must pass: eligible action, high confidence, approval history, not paused, API success.
async function canAutoExecute(
  action: string,
  confidence: number,
  feedbackHistory: Record<string, { approved: number; total: number }>,
  params: any,
): Promise<boolean> {
  // Gate 1: action must have graduated to 'auto' in action_permissions (or be in legacy allow-list)
  if (!AUTO_ELIGIBLE_ACTIONS.has(action)) {
    try {
      const sb = sbClient()
      const { data: perm } = await sb.from('action_permissions')
        .select('autonomy_level')
        .eq('action_type', action)
        .eq('autonomy_level', 'auto')
        .maybeSingle()
      if (!perm) return false
    } catch {
      return false // fail closed
    }
  }

  // Gate 2: confidence must exceed 0.95
  if (confidence <= 0.95) return false

  // Gate 3: 5+ historical approvals with >95% approval rate
  const hist = feedbackHistory[action]
  if (!hist || hist.total < 5) return false
  if ((hist.approved / hist.total) < 0.95) return false

  // Gate 4: org not paused
  try {
    const sb = sbClient()
    const { data: orgRow } = await sb.from('organisations')
      .select('settings_json')
      .eq('id', DEFAULT_ORG_ID)
      .maybeSingle()
    if (orgRow?.settings_json?.ai_paused) return false
  } catch {
    return false // fail closed
  }

  // Gate 5: postOpsApi must succeed (attempted in caller — this just confirms eligibility)
  return true
}

// ════════════════════════════════════════════════════════════
// SYSTEM PROMPTS
// ════════════════════════════════════════════════════════════

function buildCoachingPersona(caller: CallerContext): string {
  const e = (caller.user_email || '').toLowerCase()
  const name = caller.user_name || 'there'

  const channelFormat: Record<string, string> = {
    telegram_group: 'TELEGRAM MODE: Maximum 4 sentences. Plain text only. No markdown tables, no bullet points, no headers. Numbers inline. If a table is needed, say "Check the ops dashboard for the full breakdown" and give a 2-sentence summary. Always end with a clear next action if one exists: "Want me to chase Metroll?" or "Should I create the invoice?"',
    telegram_dm: 'TELEGRAM MODE: Maximum 8 sentences. Plain text preferred. One short list OK (3 items max). No tables. Numbers inline. Always end with a clear next action if one exists: "Want me to chase Metroll?" or "Should I create the invoice?"',
    dashboard: 'Full detail with markdown formatting, tables, and bullet points.',
    ceo_dashboard: 'Full detail with markdown formatting, tables, and bullet points.',
  }
  const format = channelFormat[caller.channel] || channelFormat.dashboard

  const safety = `\nSAFETY: Never reveal financial data to non-admin users in group chat. Never auto-execute write actions — always show confirmation first. Never share one person's performance metrics with another non-admin person.\n`

  const patternRecognition = `\nIf you notice a pattern in the data (recurring supplier delays, shifting close rates, etc.), mention it briefly after answering the question. One sentence.\n`

  // Marnin — CEO Strategist
  if (e.includes('marnin')) {
    return `You are SecureBot, the strategic advisor for SecureWorks Group. You're talking to Marnin, the founder and CEO.
- Lead with the business impact, not the operational detail
- Be direct and concise — he's making decisions, not doing admin
- Flag risks proactively: cash flow, margin erosion, team performance issues
- When he asks about numbers, give the number first, then context
- Challenge him if he's building when he should be selling
- Priorities: (1) revenue leverage, (2) systems that remove Marnin from day-to-day, (3) cash velocity
- Every recommendation should move toward operator-led, not founder-led

Caller: ${name} (CEO, admin) | Channel: ${caller.channel}
${format}
${patternRecognition}${safety}`
  }

  // Shaun — Operations Management Expert
  if (e.includes('shaun')) {
    return `You are SecureBot, the operations assistant for SecureWorks Group. You're talking to Shaun, the ops manager.
- Lead with actionable tasks — what needs doing NOW
- Be specific: job numbers, client names, dollar amounts, dates
- When he asks "what needs attention," give a numbered priority list, max 5 items
- After the priority list, add a brief coaching note (2 sentences max) about something he might be overlooking
- Never dump walls of text — Shaun needs to act, not read
- Think in: throughput, crew utilization, materials flow
- Quantify gaps ("utilization 62% — here are 3 moves to reach 80%")
- When jobs are delayed, trace root cause (materials? crew? client?) and fix the system

Caller: ${name} (Operations Manager, admin) | Channel: ${caller.channel}
${format}
${patternRecognition}${safety}`
  }

  // Nathan — Sales Performance Coach (Patios)
  if (e.includes('nathan')) {
    return `Sales coach for Nathan (patios). Give specific call lists with priority and talking points. "Call {client} first — $12K quote, 5 days old. Say: just checking in, any questions?" Make it impossible to not know what to do next.

Caller: ${name} (Sales — Patios) | Channel: ${caller.channel}
${format}
${patternRecognition}${safety}`
  }

  // Khairo — Sales Performance Coach (Fencing)
  if (e.includes('khairo')) {
    return `Sales coach for Khairo (fencing). Give specific call lists with priority and talking points. "Call {client} first — $8K quote, 5 days old. Say: just checking in, any questions?" Make it impossible to not know what to do next.

Caller: ${name} (Sales — Fencing) | Channel: ${caller.channel}
${format}
${patternRecognition}${safety}`
  }

  // Jan — Director, 74, non-technical
  if (e.includes('jan')) {
    return `You are SecureBot. You're talking to Jan, the company director.
- Speak simply and warmly — he's 74 and not technical
- When he asks about the business, give him the big picture: how many jobs this week, is the team busy, any problems
- Don't mention dashboards, systems, or technical terms
- If he asks to do something operational, gently redirect: "That's one for Shaun — want me to let him know?"
- Keep responses under 4 sentences
- No jargon, no metrics names, no system references

Current caller: ${name} (Director, admin)
Channel: ${caller.channel}
${format}
${safety}`
  }

  // Trades — Isaac, Henry, Ryan (field crew)
  if (e.includes('isaac') || e.includes('henry') || e.includes('ryan') || e.includes('emeka')) {
    return `You are SecureBot. You're talking to a tradie on site.
- Keep it under 3 sentences
- Use plain language — no business jargon
- If they ask about a job, give: address, what's happening today, any issues flagged
- If they ask something you can't answer, say "Ask Shaun" — don't try to be helpful about ops questions

Current caller: ${name} (${caller.user_role})
Channel: ${caller.channel}
${format}
${safety}`
  }

  // Default — other crew or unknown roles
  return `You are SecureBot, the operations assistant for SecureWorks Group.
Current caller: ${name} (${caller.user_role})
Channel: ${caller.channel}
${format}

After answering, suggest 1-2 relevant follow-up actions the caller could take.
${safety}`
}

async function getLearnedBehaviors(orgId: string): Promise<string> {
  try {
    const sb = sbClient()
    const { data: feedback } = await sb.from('ai_feedback_outcomes')
      .select('feedback_category, human_action, human_modification, human_notes')
      .order('created_at', { ascending: false })
      .limit(100)

    if (!feedback || feedback.length === 0) return ''

    // Summarize approval/rejection patterns per action type
    const patterns: Record<string, { approved: number; rejected: number; modifications: string[] }> = {}
    for (const f of feedback) {
      const cat = f.feedback_category || 'unknown'
      if (!patterns[cat]) patterns[cat] = { approved: 0, rejected: 0, modifications: [] }
      if (f.human_action === 'approved') {
        patterns[cat].approved++
      } else if (f.human_action === 'rejected') {
        patterns[cat].rejected++
      }
      if (f.human_modification) patterns[cat].modifications.push(f.human_modification)
      if (f.human_notes) patterns[cat].modifications.push(f.human_notes)
    }

    const lines: string[] = ['LEARNED BEHAVIORS (from your past interactions):']
    for (const [action, stats] of Object.entries(patterns)) {
      const total = stats.approved + stats.rejected
      if (total < 2) continue // Not enough data to learn from
      const label = action.replace(/_/g, ' ')
      if (stats.rejected === 0) {
        lines.push(`- ${label}: approved ${stats.approved}/${total} times. Be proactive about suggesting this.`)
      } else {
        const mods = stats.modifications.slice(0, 2).join('; ')
        lines.push(`- ${label}: approved ${stats.approved}/${total} times.${mods ? ` Common feedback: "${mods}"` : ''} — adapt accordingly.`)
      }
    }

    if (lines.length <= 1) return '' // No meaningful patterns yet
    lines.push('\nApply these learnings. Your suggestions should get better over time.\n')
    return lines.join('\n')
  } catch (e) {
    console.log('[ops-ai] learned behaviors query failed:', e)
    return ''
  }
}

async function getRelevantExamples(sb: any, actionType?: string, limit = 3): Promise<string> {
  try {
    let query = sb.from('ai_feedback_outcomes')
      .select('feedback_category, action_params, actual_outcome, learned_example')
      .eq('human_action', 'approved')
      .not('learned_example', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (actionType) {
      query = query.eq('feedback_category', actionType)
    }

    const { data } = await query
    if (!data || data.length === 0) return ''

    const lines: string[] = ['SUCCESSFUL PAST EXAMPLES:']
    for (const ex of data) {
      const le = ex.learned_example
      if (!le) continue
      lines.push(`- Situation: ${le.situation || 'N/A'}`)
      lines.push(`  Action: ${le.action || 'N/A'}`)
      lines.push(`  Outcome: ${le.outcome || 'N/A'}`)
    }
    if (lines.length <= 1) return ''
    lines.push('')
    return lines.join('\n')
  } catch (e) {
    console.log('[ops-ai] few-shot examples query failed:', e)
    return ''
  }
}

async function getConfirmedRules(sb: any): Promise<string> {
  try {
    const { data } = await sb.from('learned_rules')
      .select('rule_type, description, conditions, correction_text')
      .in('status', ['confirmed', 'corrected'])
      .gt('confidence', 0.7)
      .order('confidence', { ascending: false })
      .limit(20)

    if (!data || data.length === 0) return ''

    const lines: string[] = ['CONFIRMED BUSINESS RULES:']
    for (const rule of data) {
      const desc = rule.correction_text || rule.description
      lines.push(`- [${rule.rule_type}] ${desc}`)
    }
    lines.push('')
    return lines.join('\n')
  } catch (e) {
    console.log('[ops-ai] confirmed rules query failed:', e)
    return ''
  }
}

async function getConfidenceNote(sb: any, action: string, params: any): Promise<string | null> {
  try {
    // Check if there's a confirmed rule for this action type
    const { data: rules } = await sb.from('learned_rules')
      .select('id')
      .eq('rule_type', action)
      .in('status', ['confirmed', 'corrected'])
      .gt('confidence', 0.7)
      .limit(1)

    if (rules && rules.length > 0) return null // Has confirmed rule — no note needed

    // Count past approvals for this action type
    const { count } = await sb.from('ai_feedback_outcomes')
      .select('id', { count: 'exact', head: true })
      .eq('feedback_category', action)
      .eq('human_action', 'approved')

    if ((count || 0) >= 5) return 'Based on your usual approach'
    return '⚠️ First time suggesting this — please review carefully'
  } catch {
    return null
  }
}

function buildSystemPrompt(view: string, context: any, caller?: CallerContext, groupContext?: string): string {
  const today = awstDate()
  const dayName = awstNow().toLocaleDateString('en-AU', { weekday: 'long' })

  // Group context financial restriction
  const groupRestriction = groupContext === 'crew'
    ? `\nCREW GROUP CHAT — FINANCIAL DATA RESTRICTED: You are in a crew group chat. NEVER mention: dollar amounts, margins, costs, pricing, revenue, profit, commissions, rates, invoice amounts, bank balances, or any financial information. If asked about financials, say "DM me for that info." Only share: job addresses, schedules, crew assignments, material deliveries, status updates.\n`
    : ''

  const base = `You are the SecureWorks AI assistant. Perth outdoor living construction (fencing, patios, decking, roofing).

Date: ${dayName}, ${today} (AWST)

Targets: $180K revenue/mo, 30% margin, 15 jobs/mo, $5K marketing
Job numbers: SWF=Fencing, SWP=Patio, SWD=Decking, SWR=Renovation, SWI=Insurance
${groupRestriction}
RESPONSE RULES (MANDATORY):
1. Do the task first. Add context second.
2. Keep responses under 6 sentences unless asked for detail.
3. No emojis. Ever.
4. No dramatic formatting — no ### headers, no **bold walls**, no bullet-point lists longer than 5 items.
5. Never talk about yourself, your role, or your capabilities unprompted.
6. Never say "As your..." or "I'm here to..." — just answer.
7. When proposing an action: state what, state why, ask to confirm. Three lines max.
8. Currency: $X,XXX (AUD). Reference specific job numbers, names, dollar amounts.
9. If you lack data, say so. Do not guess.
10. Confidence notes should be brief: "(First time — verify)" or "(Matches usual approach)"
11. When your response includes financial data from Xero, append a freshness note at the end: "(Xero data synced X minutes ago)" — get the sync age from context.xero_sync_age_minutes if available.

FINANCIAL INTELLIGENCE: When asked about money/profit/cash:
- Run unbilled_revenue first (most common cash gap)
- P&L confusion: use explain_pnl
- Cash position: use cash_flow_forecast
- Strategy/pricing: mention division_comparison

PROACTIVE INTELLIGENCE: After answering, suggest ONE relevant deeper analysis if applicable. Do not list all tools.

ACTION EXECUTION (CRITICAL):
When the user asks you to DO something (chase, send, schedule, invoice, create, update, assign, complete, approve, cancel), you MUST call the appropriate tool. Never describe what you WOULD do — actually do it. The confirmation system handles safety.
- "Chase [name]" → search_contacts or get_debt_followup with search, find their details, then execute_send_sms or execute_send_email
- "Schedule [crew] for [job]" → create_assignment
- "Send [name] an update" → execute_send_sms or execute_send_email
- "Invoice [job]" → complete_and_invoice
- "Create work order" → execute_create_work_order
- "Send review request" → execute_send_review_request
If you need more info to execute, call the lookup tool FIRST (search_contacts, get_job_detail), then call the action tool. Do not stop at the lookup.

YOUR TOOLS INVENTORY (you have ALL of these — use them):
LOOKUP: search_jobs, get_job_detail, get_schedule, search_contacts, search_ghl_contacts, search_invoices, get_attention_items, get_dashboard_summary, get_debt_followup, get_job_profitability, get_trends, get_sales_breakdown, get_marketing_summary, get_client_conversation, get_quote_terms, get_crew_availability, list_suppliers, get_email_events, get_team_activity, get_sales_leads, get_ai_alerts, get_inbox_summary
DATA: list_variations, list_council_submissions, list_expenses, list_purchase_orders, list_work_orders
FINANCIAL: explain_pnl, cash_flow_forecast, cash_flow_status, unbilled_revenue, division_comparison, cost_trend_analysis, check_supplier_pricing
ANALYSIS: analyse_profitability, revenue_forecast, supplier_analysis, sales_performance, job_duration_analysis, estimate_accuracy_report, generate_pricing_recommendation
ACTIONS (need confirmation): execute_send_sms, execute_send_email, execute_send_quote, create_assignment, update_job_status, execute_create_po, execute_create_work_order, execute_push_po_to_xero, execute_add_ghl_note, execute_email_supplier_po, execute_send_telegram, execute_create_invoice, complete_and_invoice, execute_reconcile_payment, execute_send_review_request
NEVER say "I don't have that capability" or "I don't have access" — check your tools first.
`

  // Coaching persona — role-specific voice
  const coachingPersona = caller ? buildCoachingPersona(caller) : ''

  // Conversational memory — inject recent messages for context continuity
  let memoryContext = ''
  if (caller?.recent_messages && caller.recent_messages.length > 0) {
    memoryContext = `\nRECENT CONVERSATION CONTEXT (last few exchanges with this person):\n${caller.recent_messages.join('\n')}\n\nUse this to maintain continuity. If they said "that job" — you know which job. If they asked about revenue yesterday, build on that context today.\n`
  }

  if (view === 'ops') {
    return coachingPersona + memoryContext + base + `
Caller: Shaun (Operations Manager). Focus: scheduling, crew coordination, job tracking, POs, material deliveries, bottlenecks.

Morning brief format (when asked "what should I focus on?"):
1. Jobs today — who, where, what
2. Urgent items — overdue, missing POs, stale quotes
3. This week's schedule gaps
4. Completed jobs needing invoices

PROACTIVE FLAGS — add at end of response only if relevant. No flags section if nothing applies.
- Accepted >7 days, not scheduled: "[job_number] accepted [X]d ago — schedule"
- Scheduled <5 days, no confirmed PO: "[job_number] starts in [X]d, materials not confirmed"
- Margin <30%: "[job_number] margin [X]%"
- Overdue 14d+: "Follow up: [client] $[amount] [X]d overdue"
- Overdue 60d+: "ESCALATE: [client] $[amount] [X]d overdue — credit hold"
- Quote >14d cold: "[job_number] quote going cold ([X]d)"

Context:
${context ? JSON.stringify(context, null, 2) : 'Loading...'}
`
  }

  // CEO view
  if (view === 'ceo') {
    return coachingPersona + memoryContext + base + `
Caller: Marnin (CEO). Focus: revenue pacing vs $180K, margin vs 30%, pipeline health, marketing ROI, cash flow, strategy.

"Are we on track?" format:
1. Revenue MTD vs $180K pace
2. Margin vs 30%
3. Pipeline coverage
4. Overdue receivables
5. Key risk or win

PROACTIVE FLAGS — add at end only if relevant:
- Margin <30%: flag with specifics
- Pacing behind: shortfall + days remaining
- Pipeline <1.5x remaining target: thin coverage
- CPL >$150 or CPA >$500: above threshold
- Receivables 60d+: escalation needed

Context:
${context ? JSON.stringify(context, null, 2) : 'Loading...'}
`
  }

  if (view === 'sales') {
    return coachingPersona + memoryContext + base + `
Caller: salesperson. Focus: pipeline, follow-ups, lead conversion, client comms, personal KPIs.

PROACTIVE FLAGS — add at end only if relevant:
- Draft >3d, no scope: "Call NOW — response time is your #1 lever"
- Quote >7d, no follow-up: give specific call script with client name
- No activity 48hrs on a lead: flag with phone number
- Close rate <30%: diagnose — pricing? speed? follow-up gap?
- Hot lead (recently scoped, high value): push same-day quote

Context: ${context ? JSON.stringify(context, null, 2) : 'Loading...'}
`
  }

  // Fallback (CEO view reaches here)
  return coachingPersona + memoryContext + base
}

// ════════════════════════════════════════════════════════════
// AUTO-CONTEXT — pull relevant data based on view
// ════════════════════════════════════════════════════════════

async function getAutoContext(view: string): Promise<any> {
  try {
    // Get Xero sync freshness
    let xeroSyncAgeMinutes: number | null = null
    try {
      const sb = sbClient()
      const { data: xeroRow } = await sb.from('xero_invoices')
        .select('updated_at')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (xeroRow?.updated_at) {
        xeroSyncAgeMinutes = Math.round((Date.now() - new Date(xeroRow.updated_at).getTime()) / 60000)
      }
    } catch (_e) { /* non-critical */ }

    if (view === 'ops') {
      const summary = await callOpsApi('ops_summary')
      return {
        today_schedule: (summary.schedule || []).slice(0, 10).map((s: any) => ({
          client: s.client_name, suburb: s.site_suburb, type: s.assignment_type,
          time: s.start_time, crew: s.crew_name, status: s.status,
        })),
        stats: summary.stats,
        attention: summary.attention,
        pipeline_overview: summary.pipeline_overview,
        xero_sync_age_minutes: xeroSyncAgeMinutes,
      }
    }

    // CEO: light summary
    const summary = await callReportingApi('dashboard_summary')
    return {
      revenue_mtd: summary.stats?.revenue_mtd,
      margin_pct: summary.stats?.margin_pct,
      gross_profit: summary.stats?.gross_profit_mtd,
      pipeline_weighted: summary.pipeline_forecast?.weighted_pipeline,
      pipeline_coverage: summary.pipeline_forecast?.coverage,
      aged_receivables: summary.aged_receivables,
      is_fallback: summary.stats?.is_fallback,
      display_month: summary.stats?.display_month,
      xero_sync_age_minutes: xeroSyncAgeMinutes,
    }
  } catch (err) {
    console.error('[ops-ai] auto-context error:', err)
    return null
  }
}

// ════════════════════════════════════════════════════════════
// MAIN HANDLER
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

  if (!ANTHROPIC_API_KEY) {
    return json({ error: 'ANTHROPIC_API_KEY not configured. Set it via: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...' }, 500)
  }

  try {
    const { messages, view = 'ops', confirm_action, caller_context, group_context } = await req.json()

    // Backward compat: dashboard sends no caller_context → synthesize admin
    const callerContext: CallerContext = caller_context || {
      user_id: null,
      user_name: view === 'ops' ? 'Shaun' : 'Marnin',
      user_email: view === 'ops' ? 'shaun@secureworkswa.com.au' : 'marnin@secureworkswa.com.au',
      user_role: 'admin' as const,
      channel: (view === 'ceo' ? 'ceo_dashboard' : 'dashboard') as CallerContext['channel'],
      org_id: DEFAULT_ORG_ID,
    }

    // Handle confirmed write actions (user clicked Confirm in the UI)
    if (confirm_action) {
      const { action, params } = confirm_action
      let result
      switch (action) {
        case 'create_assignment':
          result = await postOpsApi('create_assignment', params)
          break
        case 'update_job_status':
          result = await postOpsApi('update_job_status', params)
          break
        case 'complete_and_invoice':
          result = await postOpsApi('complete_and_invoice', params)
          break
        case 'create_deposit_invoice':
        case 'create_unified_invoice':
          result = await postOpsApi(action, params)
          break
        case 'send_sms': {
          const url = new URL(`${SUPABASE_URL}/functions/v1/ghl-proxy`)
          url.searchParams.set('action', 'send_sms')
          const smsResp = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
            body: JSON.stringify(params),
          })
          result = await smsResp.json()
          break
        }
        case 'create_po':
          result = await postOpsApi('create_po', params)
          break
        case 'send_email': {
          const url = new URL(`${SUPABASE_URL}/functions/v1/ghl-proxy`)
          url.searchParams.set('action', 'send_email')
          const emailResp = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
            body: JSON.stringify(params),
          })
          result = await emailResp.json()
          break
        }
        case 'send_quote': {
          const url = new URL(`${SUPABASE_URL}/functions/v1/send-quote`)
          const quoteResp = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
            body: JSON.stringify({ jobId: params.job_id }),
          })
          result = await quoteResp.json()
          break
        }
        case 'push_po_to_xero':
          result = await postOpsApi('push_po_to_xero', { id: params.po_id, status: params.status })
          break
        case 'add_ghl_note': {
          const url = new URL(`${SUPABASE_URL}/functions/v1/ghl-proxy`)
          url.searchParams.set('action', 'add_note')
          const noteResp = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
            body: JSON.stringify(params),
          })
          result = await noteResp.json()
          break
        }
        case 'email_supplier_po':
          result = await postOpsApi('email_po', { id: params.po_id })
          break
        case 'send_telegram': {
          // Look up user's Telegram ID
          const sb = sbClient()
          let telegramId: number | null = null
          if (params.user_email) {
            const { data: usr } = await sb.from('users')
              .select('telegram_id')
              .ilike('email', `%${params.user_email}%`)
              .limit(1)
              .maybeSingle()
            telegramId = usr?.telegram_id
          } else if (params.user_name) {
            const { data: usr } = await sb.from('users')
              .select('telegram_id')
              .ilike('full_name', `%${params.user_name}%`)
              .limit(1)
              .maybeSingle()
            telegramId = usr?.telegram_id
          }
          if (!telegramId) {
            result = { error: 'Could not find Telegram ID for this user' }
            break
          }
          const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
          if (!botToken) {
            result = { error: 'Telegram bot token not configured' }
            break
          }
          const tgResp = await fetchWithTimeout(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: telegramId,
              text: params.message,
              parse_mode: 'HTML',
            }),
          }, 15000)
          result = await tgResp.json()
          break
        }
        case 'reconcile_payment':
          result = await postOpsApi('reconcile_payment', params)
          break
        case 'create_work_order':
          result = await postOpsApi('create_work_order', params)
          break
        case 'send_review_request': {
          // Route via GHL proxy or ops-api depending on method
          const url = new URL(`${SUPABASE_URL}/functions/v1/ghl-proxy`)
          url.searchParams.set('action', params.method === 'email' ? 'send_review_email' : 'send_review_sms')
          const reviewResp = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
            body: JSON.stringify(params),
          })
          result = await reviewResp.json()
          break
        }
        default:
          return json({ error: 'Unknown confirm action' }, 400)
      }

      // Feedback loop — log approval
      try {
        const sb = sbClient()
        await sb.from('ai_feedback_outcomes').insert({
          trace_id: null, // Could be linked if we stored trace_id in action cards
          human_action: 'approved',
          human_action_at: new Date().toISOString(),
          actual_outcome: result,
          feedback_category: action,
        })
      } catch { /* non-blocking */ }

      // Fire-and-forget: generate learned example from approval
      ;(async () => {
        try {
          const exampleResp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 200,
              system: 'Summarise the approved action into a JSON object with keys: situation (what triggered it), action (what was done), outcome (the result). Be concise — one sentence each.',
              messages: [{ role: 'user', content: JSON.stringify({ action, params, result }) }],
            }),
          }, 30000)
          if (exampleResp.ok) {
            const exResult = await exampleResp.json()
            const text = exResult.content?.[0]?.text || ''
            const jsonMatch = text.match(/\{[\s\S]*\}/)
            if (jsonMatch) {
              const learnedExample = JSON.parse(jsonMatch[0])
              const sb = sbClient()
              await sb.from('ai_feedback_outcomes')
                .update({ learned_example: learnedExample, confidence_at_decision: null, action_params: params })
                .eq('human_action', 'approved')
                .eq('feedback_category', action)
                .order('created_at', { ascending: false })
                .limit(1)
            }
          }
        } catch (e) {
          console.log('[ops-ai] learned example generation failed:', e)
        }
      })()

      return json({ role: 'assistant', content: `Done! ${JSON.stringify(result)}`, confirmed_result: result })
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return json({ error: 'messages array required' }, 400)
    }

    // Pull auto-context for system prompt
    const context = await getAutoContext(view)
    // Learned behaviors from feedback patterns
    const learnedBehaviors = await getLearnedBehaviors(callerContext.org_id)
    const sb = sbClient()
    const confirmedRules = await getConfirmedRules(sb)
    const fewShotExamples = callerContext.channel !== 'canary_test' ? await getRelevantExamples(sb) : ''
    const systemPrompt = buildSystemPrompt(view, context, callerContext, group_context) + learnedBehaviors + confirmedRules + fewShotExamples
    const tools = getToolsForCaller(view, callerContext)

    // Claude Messages API call with tool_use
    let anthropicMessages = messages.map((m: any) => ({
      role: m.role,
      content: m.content,
    }))

    // Tool use loop — keep calling until Claude produces a final text response
    const MAX_TOOL_ROUNDS = 5
    let finalResponse = ''
    let actionCards: any[] = []
    const toolsUsed: string[] = []
    const jobIdsReferenced = new Set<string>()
    let totalInputTokens = 0
    let totalOutputTokens = 0

    const _traceStart = Date.now()

    // ── Haiku Classifier: route simple queries to Haiku, complex to Sonnet ──
    let queryClass = 'B'
    try {
      const msgs = anthropicMessages || []
      const lastMsg = msgs.filter((m: any) => m.role === 'user').pop()
      let lastText = ''
      if (lastMsg) {
        if (typeof lastMsg.content === 'string') lastText = lastMsg.content
        else if (Array.isArray(lastMsg.content)) {
          lastText = lastMsg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
        }
      }
      const classResp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Classify this query. Reply with ONLY one letter:\nA = simple data lookup (job status, address, schedule, counts)\nB = complex analysis requiring reasoning (profitability, trends, recommendations, comparisons)\nC = request to take an action (create, send, update, assign, approve)\n\nQuery: ' + JSON.stringify(lastText.slice(0, 500)) + '\n\nReply with just the letter.' }]
        })
      }, 15000)
      if (classResp.ok) {
        const cr = await classResp.json()
        const letter = (cr.content?.[0]?.text || '').trim().toUpperCase()
        if (letter === 'A' || letter === 'B' || letter === 'C') queryClass = letter
      }
    } catch (e) { console.log('[ops-ai] classifier error:', (e as Error).message) }

    const SIMPLE_TOOLS = (tools || []).filter((t: any) => ['search_jobs', 'get_job_detail', 'get_schedule', 'get_attention_items', 'get_dashboard_summary', 'search_contacts'].includes(t.name))

    // ── Role-based model override ──
    // After classifier determines A/B/C, override model based on WHO is asking
    const callerEmail = (callerContext.user_email || '').toLowerCase()
    let routedModel: string
    let routedMaxTokens: number
    let routedTools: any[]

    if (callerEmail.includes('marnin')) {
      // Marnin (CEO): always Sonnet — quality even on simple lookups
      routedModel = 'claude-sonnet-4-20250514'
      routedMaxTokens = queryClass === 'A' ? 1024 : 2048
      routedTools = queryClass === 'A' ? SIMPLE_TOOLS : tools
    } else if (callerEmail.includes('shaun')) {
      // Shaun (ops_manager): Haiku for lookups, Sonnet for analysis/actions
      routedModel = queryClass === 'A' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-20250514'
      routedMaxTokens = queryClass === 'A' ? 512 : 2048
      routedTools = queryClass === 'A' ? SIMPLE_TOOLS : tools
    } else if (callerEmail.includes('nathan') || callerEmail.includes('khairo')) {
      // Sales: Haiku for A/B, Sonnet only for actions
      routedModel = queryClass === 'C' ? 'claude-sonnet-4-20250514' : 'claude-haiku-4-5-20251001'
      routedMaxTokens = queryClass === 'C' ? 2048 : 512
      routedTools = queryClass === 'A' ? SIMPLE_TOOLS : tools
    } else if (callerEmail.includes('jan')) {
      // Jan: always Haiku with special persona (handled in buildCoachingPersona)
      routedModel = 'claude-haiku-4-5-20251001'
      routedMaxTokens = 512
      routedTools = SIMPLE_TOOLS
    } else if (callerEmail.includes('isaac') || callerEmail.includes('henry') || callerEmail.includes('ryan') || callerEmail.includes('emeka')) {
      // Trades: always Haiku — fast, simple, minimal
      routedModel = 'claude-haiku-4-5-20251001'
      routedMaxTokens = 512
      routedTools = SIMPLE_TOOLS
    } else {
      // Default: original routing logic
      routedModel = queryClass === 'A' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-20250514'
      routedMaxTokens = queryClass === 'A' ? 512 : 2048
      routedTools = queryClass === 'A' ? SIMPLE_TOOLS : tools
    }

    console.log('[ops-ai] class=' + queryClass + ' model=' + (routedModel.includes('haiku') ? 'Haiku' : 'Sonnet') + ' caller=' + (callerContext.user_name || 'unknown'))

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const apiBody = {
        model: routedModel,
        max_tokens: routedMaxTokens,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: anthropicMessages,
        tools: routedTools,
      }

      const resp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
        },
        body: JSON.stringify(apiBody),
      }, 90000)

      if (!resp.ok) {
        const errText = await resp.text()
        console.error('[ops-ai] Anthropic API error:', resp.status, errText)

        // Retry once without beta header (prompt caching can cause 400 on some accounts)
        if (resp.status === 400 && round === 0) {
          console.log('[ops-ai] Retrying without prompt-caching beta header...')
          const retryResp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({ ...apiBody, system: systemPrompt }),
          }, 90000)
          if (retryResp.ok) {
            const retryResult = await retryResp.json()
            // Use retry result — continue the loop with this data
            totalInputTokens += retryResult.usage?.input_tokens || 0
            totalOutputTokens += retryResult.usage?.output_tokens || 0
            let retryText = ''
            for (const block of retryResult.content) {
              if (block.type === 'text') retryText += block.text
            }
            if (retryText) {
              finalResponse = retryText
              break // Exit tool loop with the response
            }
          }
          const retryErr = await retryResp.text().catch(() => '')
          console.error('[ops-ai] Retry also failed:', retryResp.status, retryErr)
        }

        return json({ error: `AI service error (${resp.status}): ${errText.slice(0, 200)}` }, 502)
      }

      const result = await resp.json()

      // Accumulate token usage across tool-use rounds
      totalInputTokens += result.usage?.input_tokens || 0
      totalOutputTokens += result.usage?.output_tokens || 0

      // Check for text content and tool use
      // Only keep text from the LAST round — intermediate rounds are chain-of-thought
      let hasText = false
      let hasToolUse = false
      const toolResults: any[] = []
      let roundText = ''

      for (const block of result.content) {
        if (block.type === 'text') {
          roundText += block.text
          hasText = true
        }
        if (block.type === 'tool_use') {
          hasToolUse = true
        }
      }

      // If no tool use, this is the final answer — keep only this round's text
      if (!hasToolUse) {
        finalResponse = roundText
        break
      }

      // Execute tool calls
      for (const block of result.content) {
        if (block.type !== 'tool_use') continue

        // Safety check
        const safetyCheck = await checkSafetyRules(block.name, block.input, callerContext)
        if (!safetyCheck.allowed) {
          toolsUsed.push(block.name)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ blocked: true, reason: safetyCheck.reason }),
          })
          continue
        }

        const { result: toolResult, needs_confirm } = await executeTool(block.name, block.input, view)

        // Track tools and job IDs for logging
        toolsUsed.push(block.name)
        if (block.input?.job_id) jobIdsReferenced.add(block.input.job_id)
        // Extract job IDs from tool results (best-effort)
        const toolResultJson = JSON.stringify(toolResult)
        const uuidMatches = toolResultJson.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)
        if (uuidMatches) uuidMatches.forEach(id => jobIdsReferenced.add(id))

        if (needs_confirm) {
          // Canary test: return proposal without side effects
          if (callerContext.channel === 'canary_test') {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify({
                canary_response: true,
                proposed_action: toolResult.action,
                proposed_params: toolResult.params,
                message: toolResult.message,
              }),
            })
            continue
          }

          // Evaluator-Optimizer: validate the proposed action
          const evaluation = await evaluateAction(block.name, block.input, {
            view, recentTools: toolsUsed, jobContext: null,
          })

          // Compute confidence with learned behaviors
          const feedbackHistory = await getFeedbackHistory()
          const confidence = computeConfidence(evaluation.confidence, toolResult.action, toolResult.params, feedbackHistory)
          toolResult.confidence = confidence
          toolResult.concerns = evaluation.concerns

          // Shadow logging — record what the AI proposed
          const sb = sbClient()
          logShadowDecision(sb, {
            action: toolResult.action,
            params: toolResult.params,
            confidence,
            concerns: evaluation.concerns,
            evaluator_approved: evaluation.approved,
            job_id: block.input?.job_id || toolResult.params?.job_id || null,
            caller: callerContext,
          })

          if (!evaluation.approved) {
            // Don't present the action — tell Claude it failed validation
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify({
                validation_failed: true,
                concerns: evaluation.concerns,
                note: 'The evaluator flagged issues with this action. Explain the concerns to the user and suggest corrections.',
              }),
            })
            continue
          }

          // Level 2: attempt auto-execute if all gates pass
          const autoEligible = await canAutoExecute(toolResult.action, confidence, feedbackHistory, toolResult.params)
          if (autoEligible) {
            try {
              const autoResult = await postOpsApi(toolResult.action, toolResult.params)
              // Log auto-execution for audit trail
              const sb2 = sbClient()
              sb2.from('ai_feedback_outcomes').insert({
                org_id: DEFAULT_ORG_ID,
                feedback_category: toolResult.action,
                human_action: 'auto_approved',
                confidence_at_decision: confidence,
                action_params: toolResult.params,
              }).then(() => {}).catch(() => {})
              sb2.from('business_events').insert({
                event_type: 'ai.auto_executed',
                source: 'ops-ai/level2',
                entity_type: 'action',
                entity_id: crypto.randomUUID(),
                job_id: toolResult.params?.job_id || null,
                payload: { action: toolResult.action, params: toolResult.params, confidence, result: autoResult },
              }).then(() => {}).catch(() => {})

              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify({
                  auto_executed: true,
                  result: autoResult,
                  confidence,
                  note: 'This action was auto-executed (Level 2). Tell the user what was done.',
                }),
              })
              continue
            } catch {
              // Gate 5 failed — fall through to manual confirmation
            }
          }

          // Add confidence note for first-time suggestions
          const confidenceNote = await getConfidenceNote(sbClient(), toolResult.action, toolResult.params)
          if (confidenceNote) {
            toolResult.confidence_note = confidenceNote
          }

          actionCards.push(toolResult)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({
              pending_confirmation: true,
              message: toolResult.message,
              confidence,
              concerns: evaluation.concerns.length > 0 ? evaluation.concerns : undefined,
              note: 'This action requires user confirmation. Tell the user what will happen and that they need to confirm.' +
                (evaluation.concerns.length > 0 ? ' Also mention the evaluator concerns.' : ''),
            }),
          })
        } else {
          // Smart truncation: summarize lists instead of dumb slice
          let resultStr: string
          const MAX_RESULT_CHARS = 6000
          const rawStr = JSON.stringify(toolResult)
          if (rawStr.length > MAX_RESULT_CHARS) {
            // If result has a list/array, summarize it
            const result = toolResult?.result || toolResult
            if (result?.clients && Array.isArray(result.clients)) {
              // Debt/overdue: keep summary stats + top 10 clients (without nested invoices)
              const lite = {
                ...result,
                clients: result.clients.slice(0, 10).map((c: any) => ({
                  contact_name: c.contact_name, total_owed: c.total_owed, phone: c.phone, email: c.email,
                  ghl_contact_id: c.ghl_contact_id, invoice_count: c.invoices?.length || 0,
                  first_client: c.first_client || false,
                })),
                _truncated: true,
                _total_clients: result.clients.length,
              }
              resultStr = JSON.stringify({ result: lite })
            } else if (result?.columns) {
              // Pipeline: count per column + top 5 per column
              const liteCols: Record<string, any> = {}
              for (const [col, jobs] of Object.entries(result.columns)) {
                const arr = jobs as any[]
                liteCols[col] = {
                  count: arr.length,
                  total_value: arr.reduce((s: number, j: any) => s + (j.value || 0), 0),
                  jobs: arr.slice(0, 5).map((j: any) => ({ job_number: j.job_number, client_name: j.client_name, value: j.value, status: j.status, days_in_stage: j.days_in_stage })),
                }
              }
              resultStr = JSON.stringify({ result: { columns: liteCols, total: result.total, _truncated: true } })
            } else {
              resultStr = rawStr.slice(0, MAX_RESULT_CHARS) + '... (truncated)'
            }
          } else {
            resultStr = rawStr
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: resultStr,
          })
        }
      }

      // Add assistant message + tool results to conversation
      anthropicMessages.push({ role: 'assistant', content: result.content })
      anthropicMessages.push({ role: 'user', content: toolResults })
    }

    // Log reasoning trace (non-blocking)
    const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user')

    logReasoningTrace({
      triggerType: 'user_query',
      modelName: routedModel,
      inputSnapshot: {
        user_message: typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg?.content),
        view,
        caller: { name: callerContext.user_name, role: callerContext.user_role, channel: callerContext.channel },
        tools_called: toolsUsed,
        context_summary: context ? { keys: Object.keys(context) } : null,
      },
      outputResult: {
        response_length: finalResponse.length,
        action_cards: actionCards.length,
        tools_used: toolsUsed,
      },
      outputType: actionCards.length > 0 ? 'action_proposal' : 'informational',
      inputTokens: totalInputTokens || null,
      outputTokens: totalOutputTokens || null,
      costUsd: totalInputTokens > 0 ? (totalInputTokens * 0.003 / 1000) + (totalOutputTokens * 0.015 / 1000) : null,
      iterationCount: toolsUsed.length + 1,
      latencyMs: Date.now() - _traceStart,
      reasoningSummary: finalResponse.slice(0, 200),
      status: 'completed',
    })

    // Fire-and-forget chat logging
    const flagLines = finalResponse.match(/^[⚠️💬📞🔴].+$/gm) || []
    logChat({
      role: view,
      query: typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg?.content),
      response: finalResponse,
      toolsUsed,
      jobIdsReferenced: [...jobIdsReferenced],
      insightsGenerated: flagLines,
      caller: callerContext,
    })

    return json({
      role: 'assistant',
      content: finalResponse,
      action_cards: actionCards.length > 0 ? actionCards : undefined,
    })

  } catch (err) {
    console.error('[ops-ai] ERROR:', err)
    return json({ error: (err as Error).message || 'Internal error' }, 500)
  }
})
