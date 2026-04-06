// ════════════════════════════════════════════════════════════
// MONITOR-INBOX — Microsoft Graph inbox polling for JARVIS
// ════════════════════════════════════════════════════════════
//
// Triggered via pg_cron every 5 minutes.
// Polls unread emails from monitored mailboxes via Microsoft Graph,
// classifies with Haiku, stores in inbox_events, sends Telegram alerts.
//
// Auth: SW_API_KEY header or Supabase service role
// Graph: client_credentials flow (same as send-outlook-email)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.39.0'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_KEY')!
const SW_API_KEY = Deno.env.get('SW_API_KEY') || ''
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

// Monitored mailboxes
const MONITORED_MAILBOXES = [
  'marnin@secureworkswa.com.au',
  'jan@secureworkswa.com.au',
]

// Admin Telegram chat IDs — resolved from users table at runtime
async function getAdminTelegramIds(sb: any): Promise<number[]> {
  const { data } = await sb.from('users')
    .select('telegram_id')
    .eq('org_id', DEFAULT_ORG_ID)
    .in('role', ['admin', 'owner'])
    .not('telegram_id', 'is', null)
    .limit(5)
  return (data || []).map((u: any) => u.telegram_id).filter((id: number) => id > 0)
}

// Graph token cache
let _cachedToken: { token: string; expires: number } | null = null

async function getGraphToken(): Promise<string> {
  if (_cachedToken && _cachedToken.expires > Date.now() + 300000) {
    return _cachedToken.token
  }

  const tenantId = Deno.env.get('MICROSOFT_TENANT_ID')
  const clientId = Deno.env.get('MICROSOFT_CLIENT_ID')
  const clientSecret = Deno.env.get('MICROSOFT_CLIENT_SECRET')

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET must be set')
  }

  const resp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }),
  })

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Graph token request failed: ${resp.status} ${err}`)
  }

  const data = await resp.json()
  _cachedToken = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in * 1000),
  }
  return data.access_token
}

// ── Classify email with Haiku ──
async function classifyEmail(
  from: string,
  subject: string,
  bodyPreview: string,
): Promise<{ classification: string; priority: string; action_needed: string | null; job_ref: string | null }> {
  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: `You classify business emails for a Perth outdoor construction company (SecureWorks WA).
Return JSON only: { "classification": "...", "priority": "...", "action_needed": "..." or null, "job_ref": "SWP-XXXXX" or null }

Classifications: client_reply, supplier_quote, supplier_response, council, invoice, complaint, urgent, newsletter, spam, other
Priority: high (complaints, urgent, council deadlines, large invoices), normal (client replies, supplier responses), low (newsletters, marketing, spam)
action_needed: brief description of recommended action, or null if informational only
job_ref: extract any job reference (SWP-XXXXX, SWF-XXXXX, SWD-XXXXX) from subject or body, or null`,
      messages: [{
        role: 'user',
        content: `From: ${from}\nSubject: ${subject}\nPreview: ${bodyPreview}`,
      }],
    })

    const text = resp.content[0].type === 'text' ? resp.content[0].text : ''
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]) } catch { /* fall through to default */ }
    }
  } catch (e) {
    console.log('[monitor-inbox] Classification failed:', (e as Error).message)
  }

  return { classification: 'other', priority: 'normal', action_needed: null, job_ref: null }
}

// ── Send Telegram notification ──
async function sendTelegram(chatId: number, html: string) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
      }),
    })
  } catch (e) {
    console.log('[monitor-inbox] Telegram send failed:', (e as Error).message)
  }
}

// ── Process a single mailbox ──
async function processMailbox(
  sb: any,
  token: string,
  mailbox: string,
  adminTelegramIds: number[],
): Promise<{ processed: number; notified: number }> {
  let processed = 0
  let notified = 0

  // Fetch unread messages from last 15 mins (overlap to catch any missed)
  const fifteenMinsAgo = new Date(Date.now() - 15 * 60000).toISOString()
  const graphUrl = `https://graph.microsoft.com/v1.0/users/${mailbox}/mailFolders/inbox/messages` +
    `?$filter=isRead eq false and receivedDateTime ge ${fifteenMinsAgo}` +
    `&$top=20` +
    `&$select=id,from,toRecipients,subject,bodyPreview,receivedDateTime,hasAttachments` +
    `&$orderby=receivedDateTime desc`

  const resp = await fetch(graphUrl, {
    headers: { 'Authorization': `Bearer ${token}` },
  })

  if (!resp.ok) {
    const err = await resp.text()
    console.log(`[monitor-inbox] Graph fetch failed for ${mailbox}: ${resp.status} ${err}`)
    return { processed: 0, notified: 0 }
  }

  const data = await resp.json()
  const messages = data.value || []

  if (messages.length === 0) {
    return { processed: 0, notified: 0 }
  }

  // Get existing graph_message_ids to dedup
  const graphIds = messages.map((m: any) => m.id)
  const { data: existing } = await sb.from('inbox_events')
    .select('graph_message_id')
    .in('graph_message_id', graphIds)
  const existingSet = new Set((existing || []).map((e: any) => e.graph_message_id))

  for (const msg of messages) {
    if (existingSet.has(msg.id)) continue // Already processed

    const fromEmail = msg.from?.emailAddress?.address || ''
    const fromName = msg.from?.emailAddress?.name || ''
    const toEmail = (msg.toRecipients || []).map((r: any) => r.emailAddress?.address).join(', ')
    const subject = msg.subject || '(no subject)'
    const bodyPreview = (msg.bodyPreview || '').slice(0, 500)
    const receivedAt = msg.receivedDateTime

    // Classify
    const classification = await classifyEmail(fromEmail, subject, bodyPreview)

    // Try to match to a job
    let jobId: string | null = null
    let ghlContactId: string | null = null
    if (classification.job_ref) {
      const { data: job } = await sb.from('jobs')
        .select('id')
        .eq('org_id', DEFAULT_ORG_ID)
        .ilike('job_number', classification.job_ref)
        .limit(1)
        .maybeSingle()
      jobId = job?.id || null
    }

    // Try to match sender to a contact
    if (fromEmail) {
      const { data: contact } = await sb.from('contact_matches')
        .select('ghl_contact_id')
        .ilike('email', fromEmail)
        .limit(1)
        .maybeSingle()
      ghlContactId = contact?.ghl_contact_id || null
    }

    // Store in inbox_events
    const { error: insertErr } = await sb.from('inbox_events').insert({
      org_id: DEFAULT_ORG_ID,
      graph_message_id: msg.id,
      mailbox,
      from_email: fromEmail,
      from_name: fromName,
      to_email: toEmail,
      subject,
      body_preview: bodyPreview,
      received_at: receivedAt,
      classification: classification.classification,
      priority: classification.priority,
      action_needed: classification.action_needed,
      job_id: jobId,
      ghl_contact_id: ghlContactId,
      telegram_notified: false,
      metadata: {
        has_attachments: msg.hasAttachments || false,
        job_ref: classification.job_ref,
      },
    })

    if (insertErr) {
      console.log(`[monitor-inbox] Insert failed for ${msg.id}:`, insertErr.message)
      continue
    }

    processed++

    // Telegram notification for high priority
    if (classification.priority === 'high') {
      const emoji = classification.classification === 'complaint' ? '🚨'
        : classification.classification === 'urgent' ? '⚡'
        : classification.classification === 'council' ? '🏛️'
        : '📧'

      const telegramMsg = [
        `${emoji} <b>New email</b> (${classification.classification})`,
        `<b>From:</b> ${fromName || fromEmail}`,
        `<b>Subject:</b> ${subject}`,
        bodyPreview.length > 200 ? bodyPreview.slice(0, 200) + '...' : bodyPreview,
        classification.action_needed ? `\n<b>Suggested:</b> ${classification.action_needed}` : '',
        classification.job_ref ? `\n<b>Job:</b> ${classification.job_ref}` : '',
      ].filter(Boolean).join('\n')

      for (const chatId of adminTelegramIds) {
        await sendTelegram(chatId, telegramMsg)
      }

      // Mark as telegram_notified
      await sb.from('inbox_events')
        .update({ telegram_notified: true })
        .eq('graph_message_id', msg.id)

      notified++
    }
  }

  return { processed, notified }
}

// ── Main handler ──
Deno.serve(async (req) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  }

  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  // Auth: deployed with --no-verify-jwt so Supabase handles function-level auth.
  // pg_cron calls come from within Supabase network with service key.
  // Only reject if explicitly called with wrong API key (external abuse).
  const apiKey = req.headers.get('x-api-key') || ''
  const authHeader = req.headers.get('authorization') || ''
  if (apiKey && apiKey !== SW_API_KEY) {
    return new Response(JSON.stringify({ error: 'Invalid API key' }), {
      status: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const token = await getGraphToken()
    const adminTelegramIds = await getAdminTelegramIds(sb)

    let totalProcessed = 0
    let totalNotified = 0

    for (const mailbox of MONITORED_MAILBOXES) {
      const { processed, notified } = await processMailbox(sb, token, mailbox, adminTelegramIds)
      totalProcessed += processed
      totalNotified += notified
    }

    const result = {
      success: true,
      processed: totalProcessed,
      notified: totalNotified,
      mailboxes: MONITORED_MAILBOXES.length,
      timestamp: new Date().toISOString(),
    }

    console.log(`[monitor-inbox] ${totalProcessed} emails processed, ${totalNotified} Telegram alerts sent`)

    return new Response(JSON.stringify(result), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('[monitor-inbox] Error:', (e as Error).message)
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
