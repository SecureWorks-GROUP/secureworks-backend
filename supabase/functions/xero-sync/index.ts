// ════════════════════════════════════════════════════════════
// SecureWorks — Xero Sync Edge Function
//
// Handles Xero Custom Connection OAuth (client_credentials),
// incremental invoice sync, P&L report sync, and contact matching.
//
// Deploy: supabase functions deploy xero-sync
// Secrets: XERO_CLIENT_ID, XERO_CLIENT_SECRET
//
// Actions (via ?action= query param):
//   token_refresh      — Refresh OAuth token (called by pg_cron every 20 min)
//   sync_invoices      — Incremental invoice sync (called every 15 min)
//   sync_reports       — Pull P&L + Aged Receivables (called daily 6am AWST)
//   sync_projects      — Pull all Xero Projects with per-job P&L (daily)
//   sync_tracking_pl   — Pull P&L by tracking category (monthly, for service type breakdown)
//   match_contacts     — Match GHL contacts to Xero contacts by email (daily 3am AWST)
//   backfill_invoices  — One-time full invoice fetch (?year=2025 for batching)
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const XERO_CLIENT_ID = Deno.env.get('XERO_CLIENT_ID') || ''
const XERO_CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET') || ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token'
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0'
const XERO_PROJECTS_BASE = 'https://api.xero.com/projects.xro/2.0'

// Tracking category ID for "Business Unit" (Fencing, Patios, Group, etc.)
const TRACKING_CATEGORY_ID = '68b39e33-e803-4163-af8d-2e8955a1ce2a'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Request to ${url.split('?')[0]} timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  const url = new URL(req.url)
  const action = url.searchParams.get('action') || ''
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  try {
    switch (action) {
      case 'token_refresh':
        return json(await refreshToken(sb))
      case 'sync_invoices':
        return json(await syncInvoices(sb))
      case 'sync_reports':
        return json(await syncReports(sb))
      case 'sync_projects':
        return json(await syncProjects(sb))
      case 'sync_tracking_pl':
        return json(await syncTrackingPL(sb))
      case 'match_contacts':
        return json(await matchContacts(sb))
      case 'backfill_contacts':
        return json(await backfillContacts(sb))
      case 'backfill_invoices':
        return json(await backfillInvoices(sb, url.searchParams))
      case 'sync_purchase_orders':
        return json(await syncPurchaseOrders(sb))
      case 'sync_suppliers':
        return json(await syncSuppliers(sb))
      case 'create_or_find_contact': {
        if (req.method !== 'POST') return json({ error: 'POST required' }, 405)
        const body = await req.json()
        return json(await createOrFindContact(sb, body))
      }
      case 'match_invoices_by_reference':
        return json(await matchInvoicesByReference(sb))
      case 'backfill_xero_contacts': {
        const batchLimit = parseInt(url.searchParams.get('limit') || '10', 10)
        return json(await backfillXeroContacts(sb, batchLimit))
      }
      case 'sync_bank_balances':
        return json(await syncBankBalances(sb))
      case 'sync_aged_payables':
        return json(await syncAgedPayables(sb))
      case 'sync_bank_transactions':
        return json(await syncBankTransactions(sb))
      default:
        return json({ error: 'Unknown action. Use: token_refresh, sync_invoices, sync_reports, sync_projects, sync_tracking_pl, match_contacts, backfill_contacts, backfill_invoices, sync_purchase_orders, sync_suppliers, create_or_find_contact, match_invoices_by_reference, backfill_xero_contacts, sync_bank_balances, sync_aged_payables, sync_bank_transactions' }, 400)
    }
  } catch (err: any) {
    console.error(`xero-sync [${action}] error:`, err)
    // Log webhook error
    try {
      await sb.from('webhook_log').insert({
        org_id: DEFAULT_ORG_ID,
        source: 'xero',
        event_type: `sync_error_${action}`,
        payload: { error: err.message },
        status: 'failed',
        error_message: err.message,
      })
    } catch (_) { /* ignore log failure */ }
    return json({ error: err.message }, 500)
  }
})


// ════════════════════════════════════════════════════════════
// TOKEN REFRESH — Xero Custom Connection (client_credentials)
// ════════════════════════════════════════════════════════════

async function refreshToken(sb: any) {
  // Custom Connections use client_credentials grant — no user interaction needed.
  // Token is valid for 30 minutes; we refresh every 20 minutes.
  const credentials = btoa(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`)

  const resp = await fetchWithTimeout(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  }, 15000)

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Token refresh failed (${resp.status}): ${errText}`)
  }

  const token = await resp.json()

  // Get Xero tenant ID from /connections endpoint
  let tenantId = ''
  try {
    const connResp = await fetchWithTimeout('https://api.xero.com/connections', {
      headers: { 'Authorization': `Bearer ${token.access_token}` },
    }, 15000)
    if (connResp.ok) {
      const connections = await connResp.json()
      if (connections.length > 0) tenantId = connections[0].tenantId
    }
  } catch (e: any) {
    console.warn('Could not fetch tenant ID:', e.message)
  }

  const expiresAt = new Date(Date.now() + (token.expires_in - 60) * 1000).toISOString()

  // Upsert token
  const { error } = await sb.from('xero_tokens').upsert({
    org_id: DEFAULT_ORG_ID,
    access_token: token.access_token,
    refresh_token: token.refresh_token || null,
    token_type: token.token_type || 'Bearer',
    expires_at: expiresAt,
    tenant_id: tenantId,
    scopes: token.scope || '',
  }, { onConflict: 'org_id' })

  if (error) throw error

  return { success: true, expires_at: expiresAt, tenant_id: tenantId }
}


// ════════════════════════════════════════════════════════════
// GET VALID TOKEN — fetches stored token, refreshes if expired
// ════════════════════════════════════════════════════════════

async function getToken(sb: any): Promise<{ accessToken: string; tenantId: string }> {
  const { data: token, error } = await sb
    .from('xero_tokens')
    .select('*')
    .eq('org_id', DEFAULT_ORG_ID)
    .single()

  if (error || !token) {
    // No token stored — try initial refresh
    await refreshToken(sb)
    const { data: newToken } = await sb
      .from('xero_tokens')
      .select('*')
      .eq('org_id', DEFAULT_ORG_ID)
      .single()
    if (!newToken) throw new Error('No Xero token available. Run token_refresh first.')
    return { accessToken: newToken.access_token, tenantId: newToken.tenant_id }
  }

  // Check if expired (with 2-min buffer)
  if (new Date(token.expires_at) < new Date(Date.now() + 120000)) {
    await refreshToken(sb)
    const { data: refreshed } = await sb
      .from('xero_tokens')
      .select('*')
      .eq('org_id', DEFAULT_ORG_ID)
      .single()
    if (!refreshed) throw new Error('Token refresh failed — no token stored.')
    return { accessToken: refreshed.access_token, tenantId: refreshed.tenant_id }
  }

  return { accessToken: token.access_token, tenantId: token.tenant_id }
}


// ════════════════════════════════════════════════════════════
// XERO API HELPER
// ════════════════════════════════════════════════════════════

async function xeroGet(
  path: string,
  accessToken: string,
  tenantId: string,
  params?: Record<string, string>,
  extraHeaders?: Record<string, string>,
  retryCount = 0
) {
  const url = new URL(`${XERO_API_BASE}${path}`)
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  }

  // Xero's Statuses param needs raw commas (not URL-encoded %2C).
  // URLSearchParams encodes commas, so we decode the final URL.
  const fetchUrl = url.toString().replace(/%2C/g, ',')

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'Xero-tenant-id': tenantId,
    'Accept': 'application/json',
    ...extraHeaders,
  }

  const resp = await fetchWithTimeout(fetchUrl, { headers }, 30000)

  if (resp.status === 429) {
    if (retryCount >= 3) {
      throw new Error(`Xero rate limited on ${path} after ${retryCount} retries`)
    }
    const retryAfter = parseInt(resp.headers.get('Retry-After') || '5')
    console.warn(`Xero rate limited on ${path}, retry ${retryCount + 1}/3 after ${retryAfter}s`)
    await new Promise(r => setTimeout(r, retryAfter * 1000))
    return xeroGet(path, accessToken, tenantId, params, extraHeaders, retryCount + 1)
  }

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Xero API ${path} failed (${resp.status}): ${errText}`)
  }

  return resp.json()
}


// Helper for Xero Projects API (different base URL from Accounting API)
async function xeroProjectsGet(
  path: string,
  accessToken: string,
  tenantId: string,
  params?: Record<string, string>,
  retryCount = 0
) {
  const url = new URL(`${XERO_PROJECTS_BASE}${path}`)
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'Xero-tenant-id': tenantId,
    'Accept': 'application/json',
  }

  const resp = await fetchWithTimeout(url.toString(), { headers }, 30000)

  if (resp.status === 429) {
    if (retryCount >= 3) throw new Error(`Xero rate limited on ${path} after ${retryCount} retries`)
    const retryAfter = parseInt(resp.headers.get('Retry-After') || '5')
    console.warn(`Xero Projects rate limited, retry ${retryCount + 1}/3 after ${retryAfter}s`)
    await new Promise(r => setTimeout(r, retryAfter * 1000))
    return xeroProjectsGet(path, accessToken, tenantId, params, retryCount + 1)
  }

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Xero Projects API ${path} failed (${resp.status}): ${errText}`)
  }

  return resp.json()
}


// ════════════════════════════════════════════════════════════
// XERO POST/PUT HELPER — for creating/updating Xero resources
// ════════════════════════════════════════════════════════════

async function xeroPost(
  path: string,
  accessToken: string,
  tenantId: string,
  body: unknown,
  method: 'POST' | 'PUT' = 'POST',
  retryCount = 0
) {
  const url = `${XERO_API_BASE}${path}`

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'Xero-tenant-id': tenantId,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }

  // Add idempotency key for POST/PUT requests to prevent duplicate creation
  // Callers can include _idempotencyKey in the body; otherwise auto-generate from path + timestamp
  const bodyObj = body as any
  if (bodyObj?._idempotencyKey) {
    headers['Idempotency-Key'] = bodyObj._idempotencyKey
    delete bodyObj._idempotencyKey
  }

  const resp = await fetchWithTimeout(url, {
    method,
    headers,
    body: JSON.stringify(body),
  }, 30000)

  if (resp.status === 429) {
    if (retryCount >= 3) {
      throw new Error(`Xero rate limited on ${method} ${path} after ${retryCount} retries`)
    }
    const retryAfter = parseInt(resp.headers.get('Retry-After') || '5')
    console.warn(`Xero rate limited on ${method} ${path}, retry ${retryCount + 1}/3 after ${retryAfter}s`)
    await new Promise(r => setTimeout(r, retryAfter * 1000))
    return xeroPost(path, accessToken, tenantId, body, method, retryCount + 1)
  }

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Xero API ${method} ${path} failed (${resp.status}): ${errText}`)
  }

  return resp.json()
}


// ════════════════════════════════════════════════════════════
// PARSE XERO DATE — converts /Date(1234567890000)/ → ISO string
// ════════════════════════════════════════════════════════════

function parseXeroDate(xeroDate: string | null | undefined): string | null {
  if (!xeroDate) return null
  const match = xeroDate.match(/\/Date\((\d+)([+-]\d+)?\)\//)
  if (!match) return null
  return new Date(parseInt(match[1], 10)).toISOString()
}


// ════════════════════════════════════════════════════════════
// SYNC INVOICES — incremental via If-Modified-Since
// ════════════════════════════════════════════════════════════

async function syncInvoices(sb: any) {
  const { accessToken, tenantId } = await getToken(sb)

  // Find last Xero-side update time (not our sync time) for incremental fetch.
  // Using updated_at (Xero's UpdatedDateUTC) ensures we catch all changes
  // since the last time Xero actually modified an invoice, rather than
  // using synced_at which resets every sync cycle and misses old invoices.
  const { data: lastInvoice } = await sb
    .from('xero_invoices')
    .select('updated_at')
    .eq('org_id', DEFAULT_ORG_ID)
    .not('updated_at', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(1)

  const modifiedSince = lastInvoice?.[0]?.updated_at
    ? new Date(lastInvoice[0].updated_at).toISOString()
    : undefined

  let totalSynced = 0
  const syncBoth = ['ACCREC', 'ACCPAY'] // Sales invoices + Bills

  for (const invoiceType of syncBoth) {
    let page = 1
    let hasMore = true

    while (hasMore) {
      // Statuses includes PAID + DELETED + VOIDED — so deletions in Xero
      // propagate to our local cache and stop showing in debt collection
      const params: Record<string, string> = {
        page: String(page),
        where: `Type=="${invoiceType}"`,
        Statuses: 'DRAFT,SUBMITTED,AUTHORISED,PAID,DELETED,VOIDED',
      }
      const extraHeaders: Record<string, string> = {}
      if (modifiedSince) {
        extraHeaders['If-Modified-Since'] = modifiedSince
      }

      const data = await xeroGet('/Invoices', accessToken, tenantId, params, extraHeaders)
      const invoices = data.Invoices || []

      if (invoices.length === 0) {
        hasMore = false
        break
      }

      // Upsert each invoice — preserve existing job_id linkage
      for (const inv of invoices) {
        // Check if this invoice already has a job link (set by createInvoice)
        let existingJobId: string | null = null
        let existingJobContactId: string | null = null
        const { data: existingRec } = await sb.from('xero_invoices')
          .select('job_id, job_contact_id')
          .eq('org_id', DEFAULT_ORG_ID)
          .eq('xero_invoice_id', inv.InvoiceID)
          .maybeSingle()
        if (existingRec) {
          existingJobId = existingRec.job_id
          existingJobContactId = existingRec.job_contact_id
        }

        const record: any = {
          org_id: DEFAULT_ORG_ID,
          xero_invoice_id: inv.InvoiceID,
          xero_contact_id: inv.Contact?.ContactID || null,
          contact_name: inv.Contact?.Name || null,
          invoice_number: inv.InvoiceNumber || null,
          invoice_type: inv.Type,
          status: inv.Status,
          reference: inv.Reference || null,
          currency_code: inv.CurrencyCode || 'AUD',
          sub_total: inv.SubTotal || 0,
          total_tax: inv.TotalTax || 0,
          total: inv.Total || 0,
          amount_due: inv.AmountDue || 0,
          amount_paid: inv.AmountPaid || 0,
          invoice_date: inv.DateString || null,
          due_date: inv.DueDateString || null,
          fully_paid_on: parseXeroDate(inv.FullyPaidOnDate) || null,
          line_items: inv.LineItems || [],
          raw_json: inv,
          updated_at: parseXeroDate(inv.UpdatedDateUTC) || new Date().toISOString(),
          synced_at: new Date().toISOString(),
        }

        // Preserve job linkage — don't let sync wipe links set by createInvoice
        if (existingJobId) record.job_id = existingJobId
        if (existingJobContactId) record.job_contact_id = existingJobContactId

        const { error } = await sb.from('xero_invoices').upsert(record, {
          onConflict: 'org_id,xero_invoice_id',
        })

        if (error) {
          console.error(`Failed to upsert invoice ${inv.InvoiceNumber}:`, error.message)
        } else {
          totalSynced++

          // Auto-link invoice to job via SW reference number in Reference field.
          // Matches patterns like SWP-25001, SWF-25002, SW1615, etc.
          const ref = inv.Reference || ''
          const swMatch = ref.match(/SW[A-Z]?-?(\d{3,5})/i)
          if (swMatch) {
            const swNumber = swMatch[0].toUpperCase()
            const { data: job } = await sb.from('jobs')
              .select('id')
              .eq('org_id', DEFAULT_ORG_ID)
              .eq('job_number', swNumber)
              .maybeSingle()

            // Also check xero_projects for legacy Tradify SW numbers (e.g. "SW1615 15 Main St")
            if (!job) {
              const { data: xp } = await sb.from('xero_projects')
                .select('job_id')
                .eq('org_id', DEFAULT_ORG_ID)
                .ilike('project_name', `${swNumber}%`)
                .not('job_id', 'is', null)
                .limit(1)
                .maybeSingle()
              if (xp?.job_id) {
                await sb.from('xero_invoices')
                  .update({ job_id: xp.job_id })
                  .eq('xero_invoice_id', inv.InvoiceID)
                  .eq('org_id', DEFAULT_ORG_ID)
                  .is('job_id', null)
              }
            } else {
              await sb.from('xero_invoices')
                .update({ job_id: job.id })
                .eq('xero_invoice_id', inv.InvoiceID)
                .eq('org_id', DEFAULT_ORG_ID)
                .is('job_id', null)
            }
          }

          // ── Auto-update job status when all invoices are PAID ──
          // Only for sales invoices (ACCREC) that are linked to a job
          if (inv.Type === 'ACCREC' && inv.Status === 'PAID') {
            // Find the job_id for this invoice
            const { data: invRecord } = await sb.from('xero_invoices')
              .select('job_id')
              .eq('xero_invoice_id', inv.InvoiceID)
              .eq('org_id', DEFAULT_ORG_ID)
              .not('job_id', 'is', null)
              .maybeSingle()

            if (invRecord?.job_id) {
              // Check if ALL invoices for this job are paid
              const { data: unpaid } = await sb.from('xero_invoices')
                .select('id')
                .eq('job_id', invRecord.job_id)
                .eq('invoice_type', 'ACCREC')
                .not('status', 'eq', 'PAID')
                .not('status', 'in', '("VOIDED","DELETED")')
                .limit(1)

              if (!unpaid || unpaid.length === 0) {
                // All invoices paid — check if job is in 'invoiced' status
                const { data: jobData } = await sb.from('jobs')
                  .select('id, status')
                  .eq('id', invRecord.job_id)
                  .eq('status', 'invoiced')
                  .maybeSingle()

                if (jobData) {
                  // Route through ops-api so GHL stage sync fires automatically
                  try {
                    const opsUrl = `${SUPABASE_URL}/functions/v1/ops-api?action=update_job_status`
                    const opsResp = await fetch(opsUrl, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                      },
                      body: JSON.stringify({
                        jobId: jobData.id,
                        status: 'complete',
                        source: 'xero_sync',
                      }),
                    })
                    const opsResult = await opsResp.json()
                    console.log(`[xero-sync] Job ${jobData.id} fully paid — status updated via ops-api:`, opsResult.job?.status || opsResult.error)
                  } catch (e: any) {
                    // Fallback: update directly if ops-api call fails
                    console.error(`[xero-sync] ops-api call failed, updating directly:`, (e as Error).message)
                    await sb.from('jobs')
                      .update({ status: 'complete', completed_at: new Date().toISOString() })
                      .eq('id', jobData.id)
                      .eq('status', 'invoiced')
                  }

                  await sb.from('job_events').insert({
                    job_id: jobData.id,
                    event_type: 'payment_received',
                    detail_json: {
                      source: 'xero_sync',
                      xero_invoice_id: inv.InvoiceID,
                      invoice_number: inv.InvoiceNumber,
                      amount_paid: inv.AmountPaid,
                      fully_paid_on: inv.FullyPaidOnDate,
                    },
                  })
                  console.log(`[xero-sync] Job ${jobData.id} fully paid — payment event logged`)
                }
              }
            }
          }

          // ── Trade invoice payment detection — ACCPAY bills ──
          // Match both reference formats: "TRADE-Name-WKn-year" (ops push) and "Name WE date" (direct push)
          const tradeRef = inv.Reference || ''
          const isTradeInvoice = tradeRef.startsWith('TRADE-') || / WE \d{4}-\d{2}-\d{2}/.test(tradeRef)
          if (inv.Type === 'ACCPAY' && inv.Status === 'PAID' && isTradeInvoice) {
            try {
              // Check both column names: xero_bill_id (ops push) and xero_invoice_id (direct push)
              const { data: tradeInv } = await sb.from('trade_invoices')
                .select('id, user_id, week_start, total_inc, status')
                .or(`xero_bill_id.eq.${inv.InvoiceID},xero_invoice_id.eq.${inv.InvoiceID}`)
                .maybeSingle()

              if (tradeInv && tradeInv.status !== 'paid') {
                await sb.from('trade_invoices').update({ status: 'paid' }).eq('id', tradeInv.id)

                // Notify trade via Telegram
                const { data: tradeUser } = await sb.from('users')
                  .select('telegram_id, name')
                  .eq('id', tradeInv.user_id)
                  .maybeSingle()

                const TBOT = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
                if (TBOT && tradeUser?.telegram_id) {
                  try {
                    await fetchWithTimeout('https://api.telegram.org/bot' + TBOT + '/sendMessage', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        chat_id: tradeUser.telegram_id,
                        text: 'Invoice for week of ' + tradeInv.week_start + ' paid — $' + Number(tradeInv.total_inc).toLocaleString() + ' ✓',
                      }),
                    }, 15000)
                  } catch (e: any) { console.log('[xero-sync] Trade payment telegram failed:', e) }
                }
                console.log('[xero-sync] Trade invoice ' + tradeInv.id + ' marked as paid')
              }
            } catch (e: any) { console.log('[xero-sync] Trade payment check failed:', e) }
          }
        }
      }

      // Xero returns max 100 per page
      hasMore = invoices.length === 100
      page++
    }
  }

  // ── Match unlinked invoices after sync ──
  const matchResult = await matchUnlinkedInvoices(sb)

  // ── Reconciliation: verify stale local invoices against Xero ──
  // Find local AUTHORISED/SUBMITTED invoices that haven't been synced in 24h+
  // and check if they still exist in Xero with that status
  let reconciled = 0
  try {
    const staleThreshold = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
    const { data: staleInvoices } = await sb.from('xero_invoices')
      .select('xero_invoice_id')
      .eq('org_id', DEFAULT_ORG_ID)
      .eq('invoice_type', 'ACCREC')
      .in('status', ['AUTHORISED', 'SUBMITTED'])
      .gt('amount_due', 0)
      .lt('synced_at', staleThreshold)
      .limit(50)

    if (staleInvoices && staleInvoices.length > 0) {
      const { accessToken: at2, tenantId: tid2 } = await getToken(sb)
      for (const stale of staleInvoices) {
        try {
          const invData = await xeroGet(`/Invoices/${stale.xero_invoice_id}`, at2, tid2, {})
          const inv = invData?.Invoices?.[0]
          if (inv && inv.Status !== 'AUTHORISED' && inv.Status !== 'SUBMITTED') {
            // Status changed in Xero — update locally
            await sb.from('xero_invoices')
              .update({
                status: inv.Status,
                amount_due: inv.AmountDue || 0,
                amount_paid: inv.AmountPaid || 0,
                synced_at: new Date().toISOString(),
                updated_at: parseXeroDate(inv.UpdatedDateUTC) || new Date().toISOString(),
              })
              .eq('xero_invoice_id', stale.xero_invoice_id)
              .eq('org_id', DEFAULT_ORG_ID)
            reconciled++
            console.log(`[xero-sync] Reconciled ${stale.xero_invoice_id}: now ${inv.Status}`)
          } else if (inv) {
            // Still AUTHORISED/SUBMITTED — just update synced_at
            await sb.from('xero_invoices')
              .update({ synced_at: new Date().toISOString() })
              .eq('xero_invoice_id', stale.xero_invoice_id)
              .eq('org_id', DEFAULT_ORG_ID)
          }
        } catch (e: any) {
          // If 404, invoice was deleted in Xero
          console.log(`[xero-sync] Invoice ${stale.xero_invoice_id} not found in Xero — marking DELETED`)
          await sb.from('xero_invoices')
            .update({ status: 'DELETED', amount_due: 0, synced_at: new Date().toISOString() })
            .eq('xero_invoice_id', stale.xero_invoice_id)
            .eq('org_id', DEFAULT_ORG_ID)
          reconciled++
        }
      }
    }
  } catch (e: any) {
    console.error('[xero-sync] Reconciliation error:', (e as Error).message)
  }

  // Log sync
  await sb.from('webhook_log').insert({
    org_id: DEFAULT_ORG_ID,
    source: 'xero',
    event_type: 'sync_invoices',
    payload: { synced: totalSynced, reconciled, modified_since: modifiedSince, ...matchResult },
    status: 'processed',
  })

  return { success: true, synced: totalSynced, reconciled, ...matchResult }
}


// ════════════════════════════════════════════════════════════
// UNLINKED INVOICE MATCHING
//
// Runs after each invoice sync. Picks up invoices created directly
// in Xero (job_id is null) and attempts to auto-link them to jobs.
//
// Strategy 1: Reference field contains a job number (SWP-25029, etc.)
// Strategy 2: Contact name matches a single job's client_name exactly
// Strategy 3: Multiple client_name matches → flag for manual review
// ════════════════════════════════════════════════════════════

async function matchUnlinkedInvoices(client: any) {
  try {
    // Get invoices with no job_id
    const { data: unlinked } = await client.from('xero_invoices')
      .select('id, xero_invoice_id, reference, contact_name, total, invoice_number, status')
      .is('job_id', null)
      .not('status', 'in', '("VOIDED","DELETED")')
      .limit(100)

    if (!unlinked || unlinked.length === 0) return { matched: 0, flagged: 0 }

    let matched = 0
    let flagged = 0

    for (const inv of unlinked) {
      const ref = inv.reference || ''
      const contactName = inv.contact_name || ''

      // Strategy 1: Reference contains a job number (SWP-25029, SWF-25010, etc.)
      const jobNumMatch = ref.match(/SW[PFDRIM]-\d{5}/i)
      if (jobNumMatch) {
        const { data: job } = await client.from('jobs')
          .select('id, job_number')
          .eq('job_number', jobNumMatch[0].toUpperCase())
          .maybeSingle()

        if (job) {
          await client.from('xero_invoices')
            .update({ job_id: job.id, updated_at: new Date().toISOString() })
            .eq('id', inv.id)

          await client.from('business_events').insert({
            event_type: 'invoice.auto_linked',
            source: 'xero-sync',
            entity_type: 'invoice',
            entity_id: inv.xero_invoice_id,
            job_id: job.job_number,
            payload: { invoice_number: inv.invoice_number, job_number: job.job_number, method: 'reference_match' },
          }).catch(() => {})

          matched++
          continue
        }
      }

      // Strategy 2: Contact name matches a job client_name exactly
      if (contactName) {
        const { data: jobs } = await client.from('jobs')
          .select('id, job_number, client_name, quoted_value, pricing_json')
          .eq('org_id', '00000000-0000-0000-0000-000000000001')
          .eq('legacy', false)
          .ilike('client_name', contactName)
          .not('status', 'in', '("cancelled","lost")')
          .order('created_at', { ascending: false })
          .limit(5)

        if (jobs && jobs.length === 1) {
          // Exact single match — high confidence, auto-link
          await client.from('xero_invoices')
            .update({ job_id: jobs[0].id, updated_at: new Date().toISOString() })
            .eq('id', inv.id)

          await client.from('business_events').insert({
            event_type: 'invoice.auto_linked',
            source: 'xero-sync',
            entity_type: 'invoice',
            entity_id: inv.xero_invoice_id,
            job_id: jobs[0].job_number,
            payload: { invoice_number: inv.invoice_number, job_number: jobs[0].job_number, method: 'client_name_exact' },
          }).catch(() => {})

          matched++
          continue
        }

        if (jobs && jobs.length > 1) {
          // Write annotation instead of alert — shows in Inbox with resolution buttons
          const _srcRef = `sync:unlinked:${inv.xero_invoice_id}`
          const { data: _existingAnn } = await client.from('ai_annotations')
            .select('id').eq('source_ref', _srcRef).eq('status', 'active').limit(1)
          if (!_existingAnn || _existingAnn.length === 0) {
            await client.from('ai_annotations').insert({
              org_id: '00000000-0000-0000-0000-000000000001',
              entity_type: 'invoice',
              entity_id: null,
              ui_location: 'today',
              annotation_type: 'unlinked_invoice',
              category: 'financial',
              title: `${inv.invoice_number} ($${Math.round(inv.total || 0).toLocaleString()}) matches ${jobs.length} jobs`,
              body: `"${contactName}" could be: ${jobs.map((j: any) => j.job_number).join(', ')}. Link manually.`,
              structured_data: {
                xero_invoice_id: inv.xero_invoice_id,
                invoice_number: inv.invoice_number,
                candidate_jobs: jobs.map((j: any) => ({ id: j.id, job_number: j.job_number, client_name: j.client_name })),
              },
              response_type: 'choice',
              response_options: jobs.slice(0, 4).map((j: any) => ({ value: 'link:' + j.id, label: 'Link to ' + j.job_number, style: 'primary' })).concat([
                { value: 'dismiss', label: 'Not Related', style: 'ghost' },
              ]),
              priority: 70,
              severity: 'amber',
              source: 'xero-sync',
              source_ref: _srcRef,
              confidence: 0.5,
            }).catch(() => {})
          }

          flagged++
          continue
        }
      }

      // Strategy 3: No match found — leave unlinked
      // These could be direct Xero invoices not related to SW jobs
    }

    console.log(`[xero-sync] Invoice matching: ${matched} auto-linked, ${flagged} flagged for review`)
    return { matched, flagged }
  } catch (e: any) {
    console.log('[xero-sync] Invoice matching failed:', (e as Error).message)
    return { matched: 0, flagged: 0 }
  }
}


// ════════════════════════════════════════════════════════════
// BACKFILL INVOICES — one-time full fetch (no If-Modified-Since)
//
// Pulls ALL ACCREC + ACCPAY invoices from Xero, paginating through
// every page. Use ?year=2025 to filter by calendar year if the full
// fetch times out. Upserts via the existing unique constraint on
// (org_id, xero_invoice_id) so it's safe to run multiple times.
// ════════════════════════════════════════════════════════════

async function backfillInvoices(sb: any, searchParams: URLSearchParams) {
  const { accessToken, tenantId } = await getToken(sb)
  const year = searchParams.get('year')

  let totalSynced = 0
  let totalPages = 0
  const syncBoth = ['ACCREC', 'ACCPAY']

  for (const invoiceType of syncBoth) {
    let page = 1
    let hasMore = true

    // Fetch each status separately — Xero excludes PAID by default and
    // the Statuses query param has URL-encoding issues with commas.
    // Using the where clause is more reliable.
    const statusesToSync = ['AUTHORISED', 'PAID', 'DRAFT', 'SUBMITTED']

    for (const invStatus of statusesToSync) {
    let page = 1
    let hasMore = true

    while (hasMore) {
      let where = `Type=="${invoiceType}" AND Status=="${invStatus}"`
      if (year) {
        const y = parseInt(year, 10)
        where += ` AND Date >= DateTime(${y},1,1) AND Date < DateTime(${y + 1},1,1)`
      }

      const params: Record<string, string> = {
        page: String(page),
        where,
      }

      // No If-Modified-Since header — we want everything
      const data = await xeroGet('/Invoices', accessToken, tenantId, params)
      const invoices = data.Invoices || []

      if (invoices.length === 0) {
        hasMore = false
        break
      }

      // Upsert each invoice — preserve existing job linkage
      for (const inv of invoices) {
        let existingJobId: string | null = null
        let existingJobContactId: string | null = null
        const { data: existingRec } = await sb.from('xero_invoices')
          .select('job_id, job_contact_id')
          .eq('org_id', DEFAULT_ORG_ID)
          .eq('xero_invoice_id', inv.InvoiceID)
          .maybeSingle()
        if (existingRec) {
          existingJobId = existingRec.job_id
          existingJobContactId = existingRec.job_contact_id
        }

        const record: any = {
          org_id: DEFAULT_ORG_ID,
          xero_invoice_id: inv.InvoiceID,
          xero_contact_id: inv.Contact?.ContactID || null,
          contact_name: inv.Contact?.Name || null,
          invoice_number: inv.InvoiceNumber || null,
          invoice_type: inv.Type,
          status: inv.Status,
          reference: inv.Reference || null,
          currency_code: inv.CurrencyCode || 'AUD',
          sub_total: inv.SubTotal || 0,
          total_tax: inv.TotalTax || 0,
          total: inv.Total || 0,
          amount_due: inv.AmountDue || 0,
          amount_paid: inv.AmountPaid || 0,
          invoice_date: inv.DateString || null,
          due_date: inv.DueDateString || null,
          fully_paid_on: parseXeroDate(inv.FullyPaidOnDate) || null,
          line_items: inv.LineItems || [],
          raw_json: inv,
          updated_at: parseXeroDate(inv.UpdatedDateUTC) || new Date().toISOString(),
          synced_at: new Date().toISOString(),
        }

        if (existingJobId) record.job_id = existingJobId
        if (existingJobContactId) record.job_contact_id = existingJobContactId

        const { error } = await sb.from('xero_invoices').upsert(record, {
          onConflict: 'org_id,xero_invoice_id',
        })

        if (error) {
          console.error(`Backfill: failed to upsert invoice ${inv.InvoiceNumber}:`, error.message)
        } else {
          totalSynced++
        }
      }

      totalPages++
      hasMore = invoices.length === 100
      page++
    }
    } // end statusesToSync loop
  }

  // Log the backfill
  await sb.from('webhook_log').insert({
    org_id: DEFAULT_ORG_ID,
    source: 'xero',
    event_type: 'backfill_invoices',
    payload: { synced: totalSynced, pages: totalPages, year: year || 'all' },
    status: 'processed',
  })

  return { success: true, synced: totalSynced, pages: totalPages, year: year || 'all' }
}


// ════════════════════════════════════════════════════════════
// SYNC REPORTS — P&L + Aged Receivables
// ════════════════════════════════════════════════════════════

async function syncReports(sb: any) {
  const { accessToken, tenantId } = await getToken(sb)
  const now = new Date()
  const results: Record<string, boolean> = {}

  // ── Profit & Loss (current month) ──
  try {
    const fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
    const toDate = now.toISOString().split('T')[0]

    const plData = await xeroGet('/Reports/ProfitAndLoss', accessToken, tenantId, {
      fromDate,
      toDate,
      standardLayout: 'true',
    })

    await sb.from('xero_reports').upsert({
      org_id: DEFAULT_ORG_ID,
      report_type: 'profit_and_loss',
      report_date: toDate,
      period_start: fromDate,
      period_end: toDate,
      report_json: plData,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'org_id,report_type,report_date' })

    results.profit_and_loss = true
  } catch (e: any) {
    console.error('P&L sync failed:', e.message)
    results.profit_and_loss = false
  }

  // ── P&L (previous month for comparison) ──
  try {
    const prevFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0]
    const prevTo = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0]

    const plPrev = await xeroGet('/Reports/ProfitAndLoss', accessToken, tenantId, {
      fromDate: prevFrom,
      toDate: prevTo,
      standardLayout: 'true',
    })

    await sb.from('xero_reports').upsert({
      org_id: DEFAULT_ORG_ID,
      report_type: 'profit_and_loss',
      report_date: prevTo,
      period_start: prevFrom,
      period_end: prevTo,
      report_json: plPrev,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'org_id,report_type,report_date' })

    results.profit_and_loss_prev = true
  } catch (e: any) {
    console.error('Previous P&L sync failed:', e.message)
    results.profit_and_loss_prev = false
  }

  // ── P&L (YTD) ──
  try {
    const ytdFrom = `${now.getFullYear()}-01-01`
    const ytdTo = now.toISOString().split('T')[0]

    const plYtd = await xeroGet('/Reports/ProfitAndLoss', accessToken, tenantId, {
      fromDate: ytdFrom,
      toDate: ytdTo,
      standardLayout: 'true',
    })

    await sb.from('xero_reports').upsert({
      org_id: DEFAULT_ORG_ID,
      report_type: 'profit_and_loss_ytd',
      report_date: ytdTo,
      period_start: ytdFrom,
      period_end: ytdTo,
      report_json: plYtd,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'org_id,report_type,report_date' })

    results.profit_and_loss_ytd = true
  } catch (e: any) {
    console.error('YTD P&L sync failed:', e.message)
    results.profit_and_loss_ytd = false
  }

  // ── Aged Receivables (calculated from synced invoices) ──
  try {
    // Pull all ACCREC invoices with outstanding amounts
    const { data: outstanding } = await sb
      .from('xero_invoices')
      .select('contact_name, xero_contact_id, invoice_number, total, amount_due, due_date, invoice_date, status')
      .eq('org_id', DEFAULT_ORG_ID)
      .eq('invoice_type', 'ACCREC')
      .gt('amount_due', 0)
      .in('status', ['AUTHORISED', 'SENT'])

    const today = now.getTime()
    const DAY_MS = 86400000

    // Build per-contact aged buckets
    const contactMap: Record<string, {
      contact_name: string, xero_contact_id: string,
      current: number, days_1_30: number, days_31_60: number, days_61_90: number, days_90_plus: number,
      total: number, invoices: any[]
    }> = {}

    for (const inv of (outstanding || [])) {
      const dueDate = inv.due_date ? new Date(inv.due_date).getTime() : today
      const daysOverdue = Math.max(0, Math.floor((today - dueDate) / DAY_MS))
      const key = inv.xero_contact_id || inv.contact_name || 'Unknown'

      if (!contactMap[key]) {
        contactMap[key] = {
          contact_name: inv.contact_name || 'Unknown',
          xero_contact_id: inv.xero_contact_id || '',
          current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 0,
          total: 0, invoices: [],
        }
      }
      const c = contactMap[key]
      const amt = Number(inv.amount_due) || 0

      if (daysOverdue <= 0) c.current += amt
      else if (daysOverdue <= 30) c.days_1_30 += amt
      else if (daysOverdue <= 60) c.days_31_60 += amt
      else if (daysOverdue <= 90) c.days_61_90 += amt
      else c.days_90_plus += amt

      c.total += amt
      c.invoices.push({
        invoice_number: inv.invoice_number,
        amount_due: amt,
        due_date: inv.due_date,
        days_overdue: daysOverdue,
      })
    }

    // Summary totals
    const contacts = Object.values(contactMap).sort((a, b) => b.total - a.total)
    const totals = contacts.reduce((t, c) => ({
      current: t.current + c.current,
      days_1_30: t.days_1_30 + c.days_1_30,
      days_31_60: t.days_31_60 + c.days_31_60,
      days_61_90: t.days_61_90 + c.days_61_90,
      days_90_plus: t.days_90_plus + c.days_90_plus,
      total: t.total + c.total,
    }), { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 0, total: 0 })

    const arReport = { contacts, totals, generated_at: now.toISOString() }

    await sb.from('xero_reports').upsert({
      org_id: DEFAULT_ORG_ID,
      report_type: 'aged_receivables',
      report_date: now.toISOString().split('T')[0],
      period_start: now.toISOString().split('T')[0],
      period_end: now.toISOString().split('T')[0],
      report_json: arReport,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'org_id,report_type,report_date' })

    results.aged_receivables = true
  } catch (e: any) {
    console.error('Aged Receivables sync failed:', e.message)
    results.aged_receivables = false
  }

  // Log
  await sb.from('webhook_log').insert({
    org_id: DEFAULT_ORG_ID,
    source: 'xero',
    event_type: 'sync_reports',
    payload: results,
    status: 'processed',
  })

  return { success: true, results }
}


// ════════════════════════════════════════════════════════════
// SYNC PROJECTS — Pull all Xero Projects with per-job P&L
//
// Xero Projects contain revenue + expenses per project.
// Project names follow "SW1234 Address" pattern.
// Matched to internal jobs via xero_contact_id → contact_matches.
// ════════════════════════════════════════════════════════════

async function syncProjects(sb: any) {
  const { accessToken, tenantId } = await getToken(sb)

  // Fetch all projects (paginate — max 50 per page)
  let allProjects: any[] = []
  let page = 1
  while (true) {
    const data = await xeroProjectsGet('/projects', accessToken, tenantId, {
      pageSize: '50',
      page: String(page),
    })
    const items = data.items || []
    allProjects = allProjects.concat(items)
    if (items.length < 50) break
    page++
    if (page > 50) break // Safety: 2500 projects max
  }

  console.log(`Fetched ${allProjects.length} Xero projects`)

  // Get existing contact_matches for job linking (xero_contact_id → job_id)
  const { data: contactMatches } = await sb
    .from('contact_matches')
    .select('xero_contact_id, job_id')
    .eq('org_id', DEFAULT_ORG_ID)
    .not('xero_contact_id', 'is', null)
    .not('job_id', 'is', null)

  // Build lookup: xero_contact_id → job_id
  const contactToJob = new Map<string, string>()
  for (const cm of (contactMatches || [])) {
    if (cm.xero_contact_id && cm.job_id) {
      contactToJob.set(cm.xero_contact_id, cm.job_id)
    }
  }

  // Extract SW job number from project name (e.g. "SW1334 15 Cloudberry Crescent")
  const extractJobNumber = (name: string): string | null => {
    const match = name.match(/^(SW\d{3,5})/i)
    return match ? match[1].toUpperCase() : null
  }

  let upserted = 0
  let matched = 0

  for (const proj of allProjects) {
    const val = (field: any) => field?.value ?? 0

    const jobNumber = extractJobNumber(proj.name || '')
    const jobId = proj.contactId ? contactToJob.get(proj.contactId) : null

    const record = {
      org_id: DEFAULT_ORG_ID,
      xero_project_id: proj.projectId,
      xero_contact_id: proj.contactId || null,
      project_name: proj.name || '',
      status: proj.status || 'INPROGRESS',
      total_invoiced: val(proj.totalInvoiced),
      total_expenses: val(proj.totalExpenseAmount),
      total_to_be_invoiced: val(proj.totalToBeInvoiced),
      deposit: val(proj.deposit),
      credit_note_amount: val(proj.creditNoteAmount),
      project_amount_invoiced: val(proj.projectAmountInvoiced),
      task_amount_invoiced: val(proj.taskAmountInvoiced),
      expense_amount_invoiced: val(proj.expenseAmountInvoiced),
      expense_amount_to_be_invoiced: val(proj.expenseAmountToBeInvoiced),
      job_id: jobId || null,
      job_number: jobNumber,
      synced_at: new Date().toISOString(),
    }

    const { error } = await sb.from('xero_projects').upsert(record, {
      onConflict: 'org_id,xero_project_id',
    })

    if (error) {
      console.error(`Failed to upsert project ${proj.name}:`, error.message)
    } else {
      upserted++
      if (jobId) matched++
    }
  }

  // Log
  await sb.from('webhook_log').insert({
    org_id: DEFAULT_ORG_ID,
    source: 'xero',
    event_type: 'sync_projects',
    payload: { total: allProjects.length, upserted, matched_to_jobs: matched },
    status: 'processed',
  })

  return {
    success: true,
    total_projects: allProjects.length,
    upserted,
    matched_to_jobs: matched,
    in_progress: allProjects.filter((p: any) => p.status === 'INPROGRESS').length,
    closed: allProjects.filter((p: any) => p.status === 'CLOSED').length,
  }
}


// ════════════════════════════════════════════════════════════
// SYNC TRACKING P&L — P&L broken down by Business Unit
//
// Uses the "Business Unit" tracking category to get revenue/costs
// per service type (Fencing, Patios, Reno, Insurance, Roofing).
// Fetches monthly P&L for last 12 months.
// ════════════════════════════════════════════════════════════

async function syncTrackingPL(sb: any) {
  const { accessToken, tenantId } = await getToken(sb)
  const now = new Date()
  const results: any[] = []

  // Fetch P&L by tracking category for last 12 months (one month at a time)
  for (let i = 0; i < 12; i++) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0)
    const fromDate = monthStart.toISOString().split('T')[0]
    const toDate = monthEnd.toISOString().split('T')[0]

    try {
      const plData = await xeroGet('/Reports/ProfitAndLoss', accessToken, tenantId, {
        fromDate,
        toDate,
        trackingCategoryID: TRACKING_CATEGORY_ID,
        standardLayout: 'true',
      })

      // Parse the report to extract per-unit figures
      const report = plData?.Reports?.[0]
      if (!report) continue

      // Get column headers (tracking category options)
      const headerRow = report.Rows?.find((r: any) => r.RowType === 'Header')
      const columns = (headerRow?.Cells || []).map((c: any) => c.Value).filter((v: string) => v)

      // Parse income and cost sections
      const parsed: Record<string, { revenue: number; costs: number; gross_profit: number }> = {}
      for (const col of columns) {
        parsed[col] = { revenue: 0, costs: 0, gross_profit: 0 }
      }

      for (const section of (report.Rows || [])) {
        if (section.Title === 'Income' || section.Title === 'Less Cost of Sales') {
          for (const row of (section.Rows || [])) {
            if (row.RowType === 'SummaryRow') {
              // Summary row has totals
              const cells = row.Cells || []
              const label = cells[0]?.Value || ''
              if (label.includes('Total Income') || label.includes('Total Cost')) {
                for (let c = 1; c < cells.length && c - 1 < columns.length; c++) {
                  const val = parseFloat(cells[c]?.Value || '0')
                  const unit = columns[c - 1]
                  if (!parsed[unit]) continue
                  if (label.includes('Income')) parsed[unit].revenue = val
                  else parsed[unit].costs = val
                }
              }
            }
          }
        }
        // Gross Profit row
        if (section.RowType === 'Section' && !section.Title) {
          for (const row of (section.Rows || [])) {
            const label = row.Cells?.[0]?.Value || ''
            if (label === 'Gross Profit') {
              for (let c = 1; c < (row.Cells?.length || 0) && c - 1 < columns.length; c++) {
                const val = parseFloat(row.Cells[c]?.Value || '0')
                const unit = columns[c - 1]
                if (parsed[unit]) parsed[unit].gross_profit = val
              }
            }
          }
        }
      }

      // Store as a report
      await sb.from('xero_reports').upsert({
        org_id: DEFAULT_ORG_ID,
        report_type: 'pl_by_tracking',
        report_date: toDate,
        period_start: fromDate,
        period_end: toDate,
        report_json: { columns, data: parsed, raw: plData },
        synced_at: new Date().toISOString(),
      }, { onConflict: 'org_id,report_type,report_date' })

      results.push({ month: fromDate, columns: Object.keys(parsed), status: 'ok' })
    } catch (e: any) {
      console.error(`Tracking P&L sync failed for ${fromDate}:`, e.message)
      results.push({ month: fromDate, status: 'error', error: e.message })
    }
  }

  // Log
  await sb.from('webhook_log').insert({
    org_id: DEFAULT_ORG_ID,
    source: 'xero',
    event_type: 'sync_tracking_pl',
    payload: { months_synced: results.filter(r => r.status === 'ok').length, results },
    status: 'processed',
  })

  return {
    success: true,
    months_synced: results.filter(r => r.status === 'ok').length,
    months_failed: results.filter(r => r.status === 'error').length,
    results,
  }
}


// ════════════════════════════════════════════════════════════
// MATCH CONTACTS — link GHL contacts to Xero contacts by email
// Enhanced: normalized names, surname+initial matching, unmatched logging
// ════════════════════════════════════════════════════════════

async function matchContacts(sb: any) {
  // Find unmatched contact_matches (no xero_contact_id yet)
  const { data: unmatched, error: fetchErr } = await sb
    .from('contact_matches')
    .select('id, email, client_name, phone, job_id')
    .eq('org_id', DEFAULT_ORG_ID)
    .is('xero_contact_id', null)

  if (fetchErr) throw fetchErr
  if (!unmatched || unmatched.length === 0) {
    return { success: true, matched: 0, message: 'No unmatched contacts' }
  }

  // Fetch ALL Xero contacts (more efficient than per-contact lookups)
  const { accessToken, tenantId } = await getToken(sb)
  const allXeroContacts: any[] = []
  let page = 1

  while (true) {
    const result = await xeroGet('/Contacts', accessToken, tenantId, { page: String(page) })
    const contacts = result.Contacts || []
    for (const c of contacts) allXeroContacts.push(c)
    if (contacts.length < 100) break
    page++
    if (page > 20) break  // Safety limit: 2000 contacts max
  }

  // Strip titles, lowercase, trim — "Mrs. Jane Smith" → "jane smith"
  const normName = (s: string) => {
    return s
      .replace(/^(mr\.?|mrs\.?|ms\.?|dr\.?|miss)\s+/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  // Build lookup maps (plain objects instead of Map for Deno compat)
  const xeroByEmail: Record<string, any> = {}
  const xeroByNormName: Record<string, any> = {}
  const xeroByLastFirst: Record<string, any> = {}  // "smith|jane" → contact
  const xeroByPhone: Record<string, any> = {}      // normalised phone → contact

  // Normalise AU phone numbers: strip spaces/dashes/parens, convert +614→04
  const normPhone = (p: string) => {
    let n = p.replace(/[\s\-()]+/g, '')
    if (n.startsWith('+61')) n = '0' + n.slice(3)
    if (n.startsWith('61') && n.length === 11) n = '0' + n.slice(2)
    return n
  }

  for (const xc of allXeroContacts) {
    if (xc.EmailAddress) {
      const key = xc.EmailAddress.toLowerCase()
      if (!xeroByEmail[key]) xeroByEmail[key] = xc
    }
    // Index by phone number (check all phone types)
    for (const ph of (xc.Phones || [])) {
      if (ph.PhoneNumber) {
        const norm = normPhone(ph.PhoneNumber)
        if (norm.length >= 8 && !xeroByPhone[norm]) xeroByPhone[norm] = xc
      }
    }
    if (xc.Name) {
      const norm = normName(xc.Name)
      if (!xeroByNormName[norm]) xeroByNormName[norm] = xc

      // Index by surname + first name for person names
      const parts = norm.split(' ').filter(Boolean)
      if (parts.length >= 2) {
        const last = parts[parts.length - 1]
        const first = parts[0]
        if (last.length >= 3) {
          const key = last + '|' + first
          if (!xeroByLastFirst[key]) xeroByLastFirst[key] = xc
        }
      }
    }
  }

  // Match unmatched contacts: email → phone → normalized name → surname+initial
  let matchCount = 0
  const unmatchedLog: string[] = []

  for (const contact of unmatched) {
    let xeroMatch = null
    let method = ''

    // Pass 1: Email match (most reliable)
    if (contact.email) {
      xeroMatch = xeroByEmail[contact.email.toLowerCase()] || null
      if (xeroMatch) method = 'email'
    }

    // Pass 1.5: Phone match (reliable — unique identifier)
    if (!xeroMatch && contact.phone) {
      const norm = normPhone(contact.phone)
      if (norm.length >= 8) {
        xeroMatch = xeroByPhone[norm] || null
        if (xeroMatch) method = 'phone'
      }
    }

    // Pass 2: Normalized name match
    if (!xeroMatch && contact.client_name) {
      const norm = normName(contact.client_name)
      xeroMatch = xeroByNormName[norm] || null
      if (xeroMatch) method = 'normalized_name'
    }

    // Pass 3: Surname + first name/initial match
    if (!xeroMatch && contact.client_name) {
      const norm = normName(contact.client_name)
      const parts = norm.split(' ').filter(Boolean)
      if (parts.length >= 2) {
        const last = parts[parts.length - 1]
        const first = parts[0]
        if (last.length >= 3) {
          // Try exact surname + first name
          xeroMatch = xeroByLastFirst[last + '|' + first] || null
          if (xeroMatch) method = 'surname_firstname'

          // Try first initial — only if single match for that surname
          if (!xeroMatch) {
            const prefix = last + '|'
            const surnameKeys = Object.keys(xeroByLastFirst).filter(k => k.startsWith(prefix))
            if (surnameKeys.length === 1) {
              const candidateFirst = surnameKeys[0].split('|')[1]
              if (candidateFirst && first && candidateFirst[0] === first[0]) {
                xeroMatch = xeroByLastFirst[surnameKeys[0]]
                method = 'surname_initial'
              }
            }
          }
        }
      }
    }

    if (xeroMatch) {
      await sb
        .from('contact_matches')
        .update({
          xero_contact_id: xeroMatch.ContactID,
          matched_at: new Date().toISOString(),
        })
        .eq('id', contact.id)

      // Link invoices from this Xero contact to the job
      if (contact.job_id) {
        await sb
          .from('xero_invoices')
          .update({ job_id: contact.job_id })
          .eq('xero_contact_id', xeroMatch.ContactID)
          .eq('org_id', DEFAULT_ORG_ID)
          .is('job_id', null)
      }

      matchCount++
    } else {
      unmatchedLog.push((contact.client_name || '?') + ' (' + (contact.email || 'no email') + ')')
    }
  }

  // Write unmatched contacts to webhook_log for visibility
  if (unmatchedLog.length > 0) {
    try {
      await sb.from('webhook_log').insert({
        org_id: DEFAULT_ORG_ID,
        source: 'xero',
        event_type: 'unmatched_contacts',
        payload: { count: unmatchedLog.length, contacts: unmatchedLog.slice(0, 100) },
        status: 'processed',
      })
    } catch (_) { /* non-critical */ }
  }

  await sb.from('webhook_log').insert({
    org_id: DEFAULT_ORG_ID,
    source: 'xero',
    event_type: 'match_contacts',
    payload: {
      total_unmatched: unmatched.length,
      matched: matchCount,
      still_unmatched: unmatchedLog.length,
      xero_contacts_fetched: allXeroContacts.length,
    },
    status: 'processed',
  })

  return {
    success: true,
    matched: matchCount,
    total_checked: unmatched.length,
    still_unmatched: unmatchedLog.length,
    xero_contacts: allXeroContacts.length,
  }
}


// ════════════════════════════════════════════════════════════
// BACKFILL CONTACTS — One-time: create contact_matches from existing jobs
// ════════════════════════════════════════════════════════════

async function backfillContacts(sb: any) {
  // Get all jobs that have email or phone (skip test/junk entries)
  const { data: jobs, error: jobErr } = await sb
    .from('jobs')
    .select('id, client_name, client_email, client_phone, ghl_opportunity_id, created_at')
    .eq('org_id', DEFAULT_ORG_ID)
    .not('status', 'eq', 'cancelled')  // Skip cancelled jobs

  if (jobErr) throw jobErr
  if (!jobs || jobs.length === 0) {
    return { success: true, created: 0, message: 'No jobs to backfill' }
  }

  // Get existing contact_matches job_ids to avoid duplicates
  const { data: existing } = await sb
    .from('contact_matches')
    .select('job_id')
    .eq('org_id', DEFAULT_ORG_ID)

  const existingJobIds = new Set((existing || []).map((e: any) => e.job_id))

  // Build contact_matches rows for jobs not already matched
  const rows = []
  for (const job of jobs) {
    if (existingJobIds.has(job.id)) continue
    if (!job.client_email && !job.client_phone && !job.client_name) continue

    // Skip junk entries (phone numbers as names, "test", etc.)
    const name = (job.client_name || '').trim()
    if (name.length < 3) continue
    if (/^[\d\s()+\-]+$/.test(name)) continue  // Phone number as name
    if (/^test/i.test(name)) continue

    rows.push({
      org_id: DEFAULT_ORG_ID,
      ghl_contact_id: job.ghl_opportunity_id || null,
      job_id: job.id,
      email: job.client_email || null,
      phone: job.client_phone || null,
      client_name: name,
      lead_source: 'unknown',  // Can't determine retroactively
    })
  }

  if (rows.length === 0) {
    return { success: true, created: 0, message: 'No eligible jobs to backfill' }
  }

  // Insert in batches of 100
  let created = 0
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100)
    const { error: insertErr } = await sb.from('contact_matches').insert(batch)
    if (insertErr) {
      console.error(`Batch insert error at offset ${i}:`, insertErr.message)
    } else {
      created += batch.length
    }
  }

  // Don't auto-run matchContacts here — it hits Xero API per contact
  // and can blow compute limits. Call match_contacts separately after.

  await sb.from('webhook_log').insert({
    org_id: DEFAULT_ORG_ID,
    source: 'xero',
    event_type: 'backfill_contacts',
    payload: {
      total_jobs: jobs.length,
      eligible: rows.length,
      created,
    },
    status: 'processed',
  })

  return {
    success: true,
    total_jobs: jobs.length,
    eligible: rows.length,
    created,
    message: 'Run match_contacts separately to link to Xero',
  }
}


// ════════════════════════════════════════════════════════════
// SYNC PURCHASE ORDERS — Pull POs from Xero, upsert to purchase_orders table
// ════════════════════════════════════════════════════════════

async function syncPurchaseOrders(sb: any) {
  const { accessToken, tenantId } = await getToken(sb)

  // Get last sync time for incremental fetch
  const { data: lastPO } = await sb
    .from('purchase_orders')
    .select('synced_at')
    .eq('org_id', DEFAULT_ORG_ID)
    .not('xero_po_id', 'is', null)
    .order('synced_at', { ascending: false })
    .limit(1)
    .single()

  const headers: Record<string, string> = {}
  if (lastPO?.synced_at) {
    headers['If-Modified-Since'] = new Date(lastPO.synced_at).toUTCString()
  }

  const result = await xeroGet('/PurchaseOrders', accessToken, tenantId, {
    Statuses: 'DRAFT,SUBMITTED,AUTHORISED,BILLED',
  }, headers)

  const purchaseOrders = result?.PurchaseOrders || []
  let upserted = 0

  for (const po of purchaseOrders) {
    // Map Xero status to our status
    const statusMap: Record<string, string> = {
      'DRAFT': 'draft',
      'SUBMITTED': 'submitted',
      'AUTHORISED': 'authorised',
      'BILLED': 'billed',
      'DELETED': 'deleted',
    }
    const status = statusMap[po.Status] || 'draft'

    // Build line items
    const lineItems = (po.LineItems || []).map((li: any) => ({
      description: li.Description || '',
      quantity: li.Quantity || 0,
      unit_price: li.UnitAmount || 0,
      account_code: li.AccountCode || '',
      tax_amount: li.TaxAmount || 0,
      line_amount: li.LineAmount || 0,
    }))

    // Try to match to a job via Reference field (SW number pattern)
    let jobId = null
    const ref = po.Reference || po.PurchaseOrderNumber || ''
    const swMatch = ref.match(/SW\d+/i)
    if (swMatch) {
      const { data: matchedJobs } = await sb
        .from('xero_projects')
        .select('job_id')
        .ilike('project_name', `%${swMatch[0]}%`)
        .limit(1)
        .single()
      if (matchedJobs) jobId = matchedJobs.job_id
    }

    const deliveryDate = po.DeliveryDate
      ? new Date(po.DeliveryDate.match(/\/Date\((\d+)/)?.[1] ? parseInt(po.DeliveryDate.match(/\/Date\((\d+)/)[1]) : po.DeliveryDate).toISOString().slice(0, 10)
      : null

    const { error } = await sb.from('purchase_orders').upsert({
      org_id: DEFAULT_ORG_ID,
      xero_po_id: po.PurchaseOrderID,
      po_number: po.PurchaseOrderNumber || `XPO-${po.PurchaseOrderID.slice(0, 8)}`,
      supplier_name: po.Contact?.Name || 'Unknown',
      xero_contact_id: po.Contact?.ContactID || null,
      status,
      line_items: lineItems,
      subtotal: po.SubTotal || 0,
      tax: po.TotalTax || 0,
      total: po.Total || 0,
      delivery_date: deliveryDate,
      reference: po.Reference || null,
      job_id: jobId,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'org_id,xero_po_id', ignoreDuplicates: false })

    if (!error) upserted++
  }

  await sb.from('webhook_log').insert({
    org_id: DEFAULT_ORG_ID,
    source: 'xero',
    event_type: 'sync_purchase_orders',
    payload: { total: purchaseOrders.length, upserted },
    status: 'processed',
  })

  return { success: true, total: purchaseOrders.length, upserted }
}


// ════════════════════════════════════════════════════════════
// SYNC SUPPLIERS — Pull supplier contacts from Xero
// ════════════════════════════════════════════════════════════

async function syncSuppliers(sb: any) {
  const { accessToken, tenantId } = await getToken(sb)

  const result = await xeroGet('/Contacts', accessToken, tenantId, {
    where: 'IsSupplier==true',
    includeArchived: 'false',
  })

  const contacts = result?.Contacts || []
  let upserted = 0

  for (const c of contacts) {
    const phone = c.Phones?.find((p: any) => p.PhoneType === 'DEFAULT')?.PhoneNumber
      || c.Phones?.find((p: any) => p.PhoneNumber)?.PhoneNumber
      || null

    const { error } = await sb.from('suppliers').upsert({
      org_id: DEFAULT_ORG_ID,
      xero_contact_id: c.ContactID,
      name: c.Name || '',
      email: c.EmailAddress || null,
      phone,
      is_active: c.ContactStatus === 'ACTIVE',
      synced_at: new Date().toISOString(),
    }, { onConflict: 'org_id,xero_contact_id' })

    if (!error) upserted++
  }

  await sb.from('webhook_log').insert({
    org_id: DEFAULT_ORG_ID,
    source: 'xero',
    event_type: 'sync_suppliers',
    payload: { total: contacts.length, upserted },
    status: 'processed',
  })

  return { success: true, total_contacts: contacts.length, upserted }
}


// ════════════════════════════════════════════════════════════
// CREATE OR FIND XERO CONTACT — for scope complete automation
//
// Searches Xero by email, then name. Creates a new contact if
// not found. Updates contact_matches and jobs.xero_contact_id.
// ════════════════════════════════════════════════════════════

async function createOrFindContact(sb: any, body: any) {
  const { name, email, phone, address, suburb, job_id, ghl_contact_id } = body

  if (!name) throw new Error('name is required')

  const { accessToken, tenantId } = await getToken(sb)
  let xeroContact: any = null
  let created = false

  // Search by email first (most reliable, targeted query — not fetching all contacts)
  if (email) {
    try {
      const emailResult = await xeroGet('/Contacts', accessToken, tenantId, {
        where: `EmailAddress=="${email}"`,
      })
      const matches = emailResult.Contacts || []
      if (matches.length > 0) {
        xeroContact = matches[0]
        console.log(`[xero-sync] Found Xero contact by email: ${xeroContact.Name} (${xeroContact.ContactID})`)
      }
    } catch (e: any) {
      console.warn('[xero-sync] Email search failed:', e.message)
    }
  }

  // Search by name if email didn't match
  if (!xeroContact && name) {
    try {
      const nameResult = await xeroGet('/Contacts', accessToken, tenantId, {
        where: `Name=="${name.replace(/"/g, '')}"`,
      })
      const matches = nameResult.Contacts || []
      if (matches.length > 0) {
        xeroContact = matches[0]
        console.log(`[xero-sync] Found Xero contact by name: ${xeroContact.Name} (${xeroContact.ContactID})`)
      }
    } catch (e: any) {
      console.warn('[xero-sync] Name search failed:', e.message)
    }
  }

  // Create new contact if not found
  if (!xeroContact) {
    const newContact: any = {
      Name: name,
    }
    if (email) newContact.EmailAddress = email
    if (phone) {
      newContact.Phones = [{ PhoneType: 'MOBILE', PhoneNumber: phone }]
    }
    if (address || suburb) {
      newContact.Addresses = [{
        AddressType: 'STREET',
        AddressLine1: address || '',
        City: suburb || '',
        Region: 'WA',
        Country: 'AU',
      }]
    }

    const result = await xeroPost('/Contacts', accessToken, tenantId, {
      Contacts: [newContact],
      _idempotencyKey: `create-contact-${name.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 50)}-${job_id || 'no-job'}`,
    })

    xeroContact = result.Contacts?.[0]
    if (!xeroContact) throw new Error('Xero contact creation returned no data')
    created = true
    console.log(`[xero-sync] Created Xero contact: ${xeroContact.Name} (${xeroContact.ContactID})`)
  }

  const xeroContactId = xeroContact.ContactID

  // Update the job's xero_contact_id
  if (job_id) {
    await sb.from('jobs')
      .update({ xero_contact_id: xeroContactId })
      .eq('id', job_id)
      .eq('org_id', DEFAULT_ORG_ID)
  }

  // Update existing contact_matches row or insert new one
  if (ghl_contact_id || job_id) {
    // Try to find existing row by job_id first, then by ghl_contact_id
    let existingMatch = null
    if (job_id) {
      const { data } = await sb.from('contact_matches')
        .select('id')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('job_id', job_id)
        .limit(1)
        .maybeSingle()
      existingMatch = data
    }
    if (!existingMatch && ghl_contact_id) {
      const { data } = await sb.from('contact_matches')
        .select('id')
        .eq('org_id', DEFAULT_ORG_ID)
        .eq('ghl_contact_id', ghl_contact_id)
        .limit(1)
        .maybeSingle()
      existingMatch = data
    }

    if (existingMatch) {
      // Update existing row with Xero contact link
      await sb.from('contact_matches')
        .update({
          xero_contact_id: xeroContactId,
          matched_at: new Date().toISOString(),
          email: email || undefined,
          phone: phone || undefined,
        })
        .eq('id', existingMatch.id)
    } else {
      // Insert new contact_matches row
      await sb.from('contact_matches').insert({
        org_id: DEFAULT_ORG_ID,
        ghl_contact_id: ghl_contact_id || null,
        job_id: job_id || null,
        email: email || null,
        phone: phone || null,
        client_name: name,
        xero_contact_id: xeroContactId,
        matched_at: new Date().toISOString(),
      })
    }
  }

  // Link any existing invoices from this Xero contact to the job
  if (job_id) {
    await sb.from('xero_invoices')
      .update({ job_id })
      .eq('xero_contact_id', xeroContactId)
      .eq('org_id', DEFAULT_ORG_ID)
      .is('job_id', null)
  }

  // Log it
  await sb.from('webhook_log').insert({
    org_id: DEFAULT_ORG_ID,
    source: 'xero',
    event_type: 'create_or_find_contact',
    payload: {
      name,
      email,
      xero_contact_id: xeroContactId,
      created,
      job_id,
    },
    status: 'processed',
  })

  return {
    success: true,
    xero_contact_id: xeroContactId,
    created,
    contact_name: xeroContact.Name,
  }
}


// ════════════════════════════════════════════════════════════
// MATCH INVOICES BY REFERENCE — backfill job_id on invoices
// that have SW-XXXX in the reference field but no job_id.
// ════════════════════════════════════════════════════════════

async function matchInvoicesByReference(sb: any) {
  // Find invoices with SW-like references that have no job_id
  const { data: invoices, error: invErr } = await sb
    .from('xero_invoices')
    .select('id, xero_invoice_id, reference, contact_name')
    .eq('org_id', DEFAULT_ORG_ID)
    .is('job_id', null)
    .not('reference', 'is', null)

  if (invErr) throw invErr
  if (!invoices || invoices.length === 0) {
    return { success: true, matched: 0, message: 'No unmatched invoices with references' }
  }

  // Filter to only those with SW-like references
  const swPattern = /SW[A-Z]?-?(\d{3,5})/i
  const candidates = invoices.filter((inv: any) => swPattern.test(inv.reference || ''))

  if (candidates.length === 0) {
    return { success: true, matched: 0, total_checked: invoices.length, message: 'No SW references found' }
  }

  let matched = 0
  const matchLog: string[] = []

  for (const inv of candidates) {
    const swMatch = (inv.reference || '').match(swPattern)
    if (!swMatch) continue

    const swNumber = swMatch[0].toUpperCase()

    // Try jobs.job_number first (new system)
    const { data: job } = await sb.from('jobs')
      .select('id')
      .eq('org_id', DEFAULT_ORG_ID)
      .eq('job_number', swNumber)
      .maybeSingle()

    if (job) {
      await sb.from('xero_invoices')
        .update({ job_id: job.id })
        .eq('id', inv.id)
      matched++
      matchLog.push(`${inv.reference} → job ${swNumber} (job_number)`)
      continue
    }

    // Fall back to xero_projects name match (legacy Tradify numbers)
    const { data: xp } = await sb.from('xero_projects')
      .select('job_id')
      .eq('org_id', DEFAULT_ORG_ID)
      .ilike('project_name', `${swNumber}%`)
      .not('job_id', 'is', null)
      .limit(1)
      .maybeSingle()

    if (xp?.job_id) {
      await sb.from('xero_invoices')
        .update({ job_id: xp.job_id })
        .eq('id', inv.id)
      matched++
      matchLog.push(`${inv.reference} → job via xero_projects (${swNumber})`)
    }
  }

  await sb.from('webhook_log').insert({
    org_id: DEFAULT_ORG_ID,
    source: 'xero',
    event_type: 'match_invoices_by_reference',
    payload: {
      total_invoices_checked: invoices.length,
      sw_references_found: candidates.length,
      matched,
      matches: matchLog.slice(0, 50),
    },
    status: 'processed',
  })

  return {
    success: true,
    matched,
    sw_references_found: candidates.length,
    total_checked: invoices.length,
    matches: matchLog.slice(0, 50),
  }
}


// ════════════════════════════════════════════════════════════
// BACKFILL XERO CONTACTS — for active/won jobs without xero_contact_id.
// Creates or finds Xero contacts for jobs that have client details.
// Batches with delays to respect Xero rate limits (60 req/min).
// ════════════════════════════════════════════════════════════

async function backfillXeroContacts(sb: any, batchLimit = 10) {
  // Get active jobs that have client details but no xero_contact_id.
  // Process in small batches to avoid Supabase Edge Function compute limits.
  // Call repeatedly with ?limit=10 (default) until no eligible jobs remain.
  const { data: jobs, error: jobErr } = await sb
    .from('jobs')
    .select('id, client_name, client_email, client_phone, site_address, site_suburb, ghl_contact_id')
    .eq('org_id', DEFAULT_ORG_ID)
    .is('xero_contact_id', null)
    .in('status', ['complete', 'in_progress', 'accepted', 'scheduled', 'invoiced', 'quoted'])
    .not('client_name', 'is', null)
    .limit(batchLimit * 2)  // Fetch extra to account for filtered-out junk

  if (jobErr) throw jobErr
  if (!jobs || jobs.length === 0) {
    return { success: true, created: 0, found: 0, failed: 0, remaining: 0, message: 'No eligible jobs' }
  }

  // Filter out junk entries
  const eligible = jobs.filter((j: any) => {
    const name = (j.client_name || '').trim()
    if (name.length < 3) return false
    if (/^[\d\s()+\-]+$/.test(name)) return false  // Phone number as name
    if (/^test/i.test(name)) return false
    return true
  }).slice(0, batchLimit)

  let created = 0
  let found = 0
  let failed = 0

  for (let i = 0; i < eligible.length; i++) {
    const job = eligible[i]

    // Rate limit: pause every 5 jobs to stay under 60 req/min
    if (i > 0 && i % 5 === 0) {
      await new Promise(r => setTimeout(r, 3000))
    }

    try {
      const result = await createOrFindContact(sb, {
        name: job.client_name.trim(),
        email: job.client_email || undefined,
        phone: job.client_phone || undefined,
        address: job.site_address || undefined,
        suburb: job.site_suburb || undefined,
        job_id: job.id,
        ghl_contact_id: job.ghl_contact_id || undefined,
      })

      if (result.created) created++
      else found++
    } catch (e: any) {
      console.error(`[xero-sync] backfill contact failed for job ${job.id} (${job.client_name}):`, e.message)
      failed++
    }
  }

  await sb.from('webhook_log').insert({
    org_id: DEFAULT_ORG_ID,
    source: 'xero',
    event_type: 'backfill_xero_contacts',
    payload: {
      total_eligible: eligible.length,
      created,
      found,
      failed,
    },
    status: 'processed',
  })

  // Count remaining eligible jobs (rough — doesn't filter junk names)
  const { count: remainingCount } = await sb
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', DEFAULT_ORG_ID)
    .is('xero_contact_id', null)
    .in('status', ['complete', 'in_progress', 'accepted', 'scheduled', 'invoiced', 'quoted'])
    .not('client_name', 'is', null)

  return {
    success: true,
    processed: eligible.length,
    created,
    found,
    failed,
    remaining: Math.max(0, (remainingCount || 0) - eligible.length + failed),
    message: (remainingCount || 0) > eligible.length
      ? `Processed ${eligible.length}. ~${remainingCount! - eligible.length} remaining — run again with ?action=backfill_xero_contacts&limit=${batchLimit}`
      : 'All eligible jobs processed',
  }
}


// ════════════════════════════════════════════════════════════
// BANK BALANCES — daily cash position snapshot
// ════════════════════════════════════════════════════════════

async function syncBankBalances(sb: any) {
  const { accessToken, tenantId } = await getToken(sb)
  const now = new Date().toISOString()
  const today = now.split('T')[0]

  // Use Bank Summary Report for actual balances (GET /Accounts doesn't include balances)
  try {
    const report = await xeroGet('/Reports/BankSummary', accessToken, tenantId, { date: today })
    const rows = report.Reports?.[0]?.Rows || []
    let synced = 0

    for (const section of rows) {
      if (section.RowType !== 'Section' || !section.Rows) continue
      for (const row of section.Rows) {
        if (row.RowType !== 'Row' || !row.Cells) continue
        const cells = row.Cells
        const accountName = cells[0]?.Value || ''
        const accountId = cells[0]?.Attributes?.[0]?.Value || accountName
        const balance = parseFloat(cells[1]?.Value || '0') || 0

        if (!accountName) continue

        await sb.from('xero_bank_balances').upsert({
          org_id: DEFAULT_ORG_ID,
          account_id: accountId,
          account_name: accountName,
          balance: balance,
          balance_date: today,
          synced_at: now,
        }, { onConflict: 'org_id,account_id,balance_date' })

        synced++
      }
    }

    console.log(`[xero-sync] Synced ${synced} bank balances from Bank Summary report`)
    return { success: true, accounts_synced: synced }
  } catch (e: any) {
    console.error('[xero-sync] Bank Summary report failed, falling back to Accounts API:', (e as Error).message)

    // Fallback: GET /Accounts (won't have balances but at least gets account names)
    const data = await xeroGet('/Accounts', accessToken, tenantId, {
      where: 'Type=="BANK"&&Status=="ACTIVE"',
    })
    const accounts = data.Accounts || []
    let synced = 0
    for (const acct of accounts) {
      await sb.from('xero_bank_balances').upsert({
        org_id: DEFAULT_ORG_ID,
        account_id: acct.AccountID,
        account_name: acct.Name || '',
        balance: 0,
        balance_date: today,
        synced_at: now,
      }, { onConflict: 'org_id,account_id,balance_date' })
      synced++
    }
    return { success: true, accounts_synced: synced, note: 'Used fallback — balances may be $0' }
  }
}


// ════════════════════════════════════════════════════════════
// AGED PAYABLES — what you owe suppliers
// ════════════════════════════════════════════════════════════

async function syncAgedPayables(sb: any) {
  const { accessToken, tenantId } = await getToken(sb)
  const now = new Date()
  const nowIso = now.toISOString()
  const today = nowIso.split('T')[0]

  // Get outstanding ACCPAY invoices (bills from suppliers) directly from Xero
  const data = await xeroGet('/Invoices', accessToken, tenantId, {
    where: 'Type=="ACCPAY"&&Status=="AUTHORISED"',
    order: 'DueDate',
  })

  const invoices = data.Invoices || []

  // Clear previous sync
  await sb.from('xero_aged_payables')
    .delete()
    .eq('org_id', DEFAULT_ORG_ID)
    .gte('synced_at', today + 'T00:00:00')

  // Calculate age buckets from invoice due dates
  let synced = 0
  for (const inv of invoices) {
    const amountDue = Number(inv.AmountDue || 0)
    if (amountDue <= 0) continue

    const dueDate = inv.DueDateString || inv.DueDate || ''
    const dueDateObj = dueDate ? new Date(dueDate) : now
    const daysOverdue = Math.floor((now.getTime() - dueDateObj.getTime()) / 86400000)

    let bucket = 'current'
    if (daysOverdue > 90) bucket = '90+'
    else if (daysOverdue > 60) bucket = '61-90'
    else if (daysOverdue > 30) bucket = '31-60'
    else if (daysOverdue > 0) bucket = '1-30'

    await sb.from('xero_aged_payables').insert({
      org_id: DEFAULT_ORG_ID,
      contact_name: inv.Contact?.Name || 'Unknown',
      contact_id: inv.Contact?.ContactID || null,
      amount_due: amountDue,
      age_bucket: bucket,
      invoice_number: inv.InvoiceNumber || null,
      due_date: dueDate ? dueDate.split('T')[0] : null,
      synced_at: nowIso,
    })
    synced++
  }

  console.log(`[xero-sync] Synced ${synced} aged payable entries from ACCPAY invoices`)
  return { success: true, entries_synced: synced }
}


// ════════════════════════════════════════════════════════════
// BANK TRANSACTIONS — reconciled transactions (90-day window)
// ════════════════════════════════════════════════════════════

async function syncBankTransactions(sb: any) {
  const { accessToken, tenantId } = await getToken(sb)
  const now = new Date()
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86400000).toISOString().split('T')[0]

  // Xero Accounting API: GET /BankTransactions
  // Filter to reconciled transactions in the last 90 days
  const data = await xeroGet('/BankTransactions', accessToken, tenantId, {
    where: `Date>DateTime(${ninetyDaysAgo.replace(/-/g, ',')})&&IsReconciled==true`,
    order: 'Date DESC',
  })

  const txns = data.BankTransactions || []
  let synced = 0
  let skipped = 0

  for (const txn of txns) {
    const txnId = txn.BankTransactionID
    if (!txnId) continue

    // Determine transaction type
    let txnType = 'SPEND'
    if (txn.Type === 'RECEIVE' || txn.Type === 'RECEIVE-OVERPAYMENT' || txn.Type === 'RECEIVE-PREPAYMENT') {
      txnType = 'RECEIVE'
    } else if (txn.Type === 'RECEIVE-TRANSFER' || txn.Type === 'SPEND-TRANSFER') {
      txnType = 'TRANSFER'
    }

    // Calculate total amount from line items
    const amount = txn.Total || txn.SubTotal || 0

    const row: any = {
      org_id: DEFAULT_ORG_ID,
      xero_txn_id: txnId,
      account_id: txn.BankAccount?.AccountID || '',
      account_name: txn.BankAccount?.Name || null,
      txn_date: txn.Date ? txn.Date.split('T')[0] : now.toISOString().split('T')[0],
      txn_type: txnType,
      contact_name: txn.Contact?.Name || null,
      reference: txn.Reference || null,
      description: (txn.LineItems || []).map((li: any) => li.Description).filter(Boolean).join('; ') || null,
      amount: txnType === 'SPEND' ? -Math.abs(amount) : Math.abs(amount),
      sub_total: txn.SubTotal || null,
      total_tax: txn.TotalTax || null,
      status: txn.Status || null,
      is_reconciled: txn.IsReconciled ?? true,
      synced_at: now.toISOString(),
    }
    const { error } = await sb.from('xero_bank_transactions').upsert(row, { onConflict: 'org_id,xero_txn_id' })

    if (error) {
      if (skipped === 0) console.log(`[xero-sync] Bank txn upsert error sample:`, error.message, error.details)
      skipped++
    } else {
      synced++
    }
  }

  console.log(`[xero-sync] Synced ${synced} bank transactions (${skipped} skipped)`)
  return { success: true, transactions_synced: synced, skipped, first_error: skipped > 0 ? 'check edge function logs' : null }
}
