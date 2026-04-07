// ════════════════════════════════════════════════════════════
// SecureWorks — Send Outlook Email via Microsoft Graph API
//
// Sends email from any configured M365 mailbox with:
//   - HTML body
//   - CC recipients
//   - File attachments (from URL — downloaded and base64'd)
//
// Auth: Same dual-auth as other functions (x-api-key or Bearer)
// Graph: OAuth2 client_credentials flow (app-only, no user login)
//
// Required secrets:
//   MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
//
// Deploy:
//   supabase functions deploy send-outlook-email --no-verify-jwt
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-api-key, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const EMAIL_SIGNATURE = `
<div style="margin-top:28px;padding-top:20px;border-top:2px solid #F15A29;font-family:Helvetica,Arial,sans-serif;max-width:400px">
  <img src="data:image/png;base64,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" width="180" alt="SecureWorks Group" style="display:block;margin-bottom:14px" />
  <p style="margin:0 0 2px;font-size:14px;font-weight:bold;color:#293C46">Marnin Stobbe</p>
  <p style="margin:0 0 10px;font-size:12px;color:#4C6A7C">Operations Manager</p>
  <p style="margin:0 0 10px;font-size:10px;color:#293C46;letter-spacing:1.5px;font-weight:600">EXCELLENCE &nbsp;|&nbsp; INTEGRITY &nbsp;|&nbsp; SERVICE</p>
  <p style="margin:0;font-size:12px;color:#4C6A7C;line-height:20px">
    <b style="color:#293C46">P:</b> <a href="tel:0404777984" style="color:#4C6A7C;text-decoration:none">0404 777 984</a><br/>
    <b style="color:#293C46">E:</b> <a href="mailto:marnin@secureworkswa.com.au" style="color:#F15A29;text-decoration:none">marnin@secureworkswa.com.au</a>
  </p>
</div>`

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// ── Graph OAuth2 Token ──

let _cachedToken: { token: string; expires: number } | null = null

async function getGraphToken(): Promise<string> {
  // Return cached token if still valid (5 min buffer)
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

// ── Download + Base64 encode attachment from URL ──

async function fetchAttachment(url: string, name: string): Promise<{
  '@odata.type': string
  name: string
  contentType: string
  contentBytes: string
}> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Failed to download attachment: ${url} (${resp.status})`)

  const buffer = await resp.arrayBuffer()
  const bytes = new Uint8Array(buffer)

  // Base64 encode
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  const base64 = btoa(binary)

  // Guess content type from extension
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const contentTypes: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
  }

  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name,
    contentType: contentTypes[ext] || 'application/octet-stream',
    contentBytes: base64,
  }
}

// ── Dynamic Signature Selection ──
function getSignature(from: string): string {
  const email = (from || '').toLowerCase()
  if (email.includes('shaun')) {
    return EMAIL_SIGNATURE
      .replace('Marnin Stobbe', 'Shaun')
      .replace('Operations Manager', 'Operations Manager')
      .replace('0404 777 984', '')
      .replace('marnin@secureworkswa.com.au', 'shaun@secureworkswa.com.au')
      .replace('mailto:marnin@', 'mailto:shaun@')
      .replace('tel:0404777984', '')
  }
  if (email.includes('jan')) {
    return EMAIL_SIGNATURE
      .replace('Marnin Stobbe', 'Jan Stobbe')
      .replace('Operations Manager', 'Director')
      .replace('0404 777 984', '')
      .replace('marnin@secureworkswa.com.au', 'jan@secureworkswa.com.au')
      .replace('mailto:marnin@', 'mailto:jan@')
      .replace('tel:0404777984', '')
  }
  if (email.includes('fencing')) {
    return EMAIL_SIGNATURE
      .replace('Marnin Stobbe', 'SecureWorks Fencing')
      .replace('Operations Manager', 'Fencing Division')
      .replace('0404 777 984', '08 6102 2796')
      .replace('marnin@secureworkswa.com.au', 'fencing@secureworkswa.com.au')
      .replace('mailto:marnin@', 'mailto:fencing@')
      .replace('tel:0404777984', 'tel:0861022796')
  }
  if (email.includes('patio')) {
    return EMAIL_SIGNATURE
      .replace('Marnin Stobbe', 'SecureWorks Patios')
      .replace('Operations Manager', 'Patios Division')
      .replace('0404 777 984', '08 6102 2796')
      .replace('marnin@secureworkswa.com.au', 'patios@secureworkswa.com.au')
      .replace('mailto:marnin@', 'mailto:patios@')
      .replace('tel:0404777984', 'tel:0861022796')
  }
  // Default: Marnin
  return EMAIL_SIGNATURE
}

// ── Main Handler ──

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  // Auth — same pattern as ghl-proxy
  const validKey = Deno.env.get('SW_API_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const xApiKey = req.headers.get('x-api-key')
  const authHeader = req.headers.get('authorization')
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

  let isAuthed = false
  if (xApiKey && (xApiKey === validKey || xApiKey === serviceKey)) isAuthed = true
  else if (bearerToken && (bearerToken === validKey || bearerToken === serviceKey)) isAuthed = true
  if (!isAuthed) return json({ error: 'Unauthorized' }, 401)

  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    const body = await req.json()
    const {
      from = 'marnin@secureworkswa.com.au',
      to,
      cc,
      subject,
      htmlBody,
      attachments,
      job_id,
      ghl_contact_id,
      sent_by,
    } = body

    if (!to || !subject || !htmlBody) {
      return json({ error: 'Missing required fields: to, subject, htmlBody' }, 400)
    }

    // Build recipients
    const toRecipients = (Array.isArray(to) ? to : [to]).map((email: string) => ({
      emailAddress: { address: email.trim() },
    }))

    const ccRecipients = cc
      ? (Array.isArray(cc) ? cc : [cc]).map((email: string) => ({
          emailAddress: { address: email.trim() },
        }))
      : undefined

    // Build message
    const message: Record<string, unknown> = {
      subject,
      body: { contentType: 'HTML', content: htmlBody + getSignature(from) },
      toRecipients,
    }
    if (ccRecipients) message.ccRecipients = ccRecipients

    // Handle attachments
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      const graphAttachments = []
      for (const att of attachments) {
        if (att.url && att.name) {
          graphAttachments.push(await fetchAttachment(att.url, att.name))
        } else if (att.contentBytes && att.name) {
          // Already base64 encoded
          graphAttachments.push({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: att.name,
            contentType: att.contentType || 'application/octet-stream',
            contentBytes: att.contentBytes,
          })
        }
      }
      if (graphAttachments.length > 0) {
        message.attachments = graphAttachments
      }
    }

    // Get token and send
    const token = await getGraphToken()
    const graphResp = await fetch(
      `https://graph.microsoft.com/v1.0/users/${from}/sendMail`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
          saveToSentItems: true,
        }),
      },
    )

    if (!graphResp.ok) {
      const errBody = await graphResp.text()
      console.error('[send-outlook-email] Graph API error:', graphResp.status, errBody)
      return json({
        error: 'Graph API error',
        status: graphResp.status,
        detail: errBody,
      }, 502)
    }

    // Graph sendMail returns 202 Accepted with no body

    // ── Post-send logging (all fire-and-forget) ──
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const toStr = Array.isArray(to) ? to.join(', ') : to

    // 1. Log to po_communications (unified comms timeline)
    if (job_id) {
      sb.from('po_communications').insert({
        job_id,
        direction: 'outbound',
        from_email: from,
        to_email: toStr,
        cc_emails: cc ? (Array.isArray(cc) ? cc : [cc]) : null,
        subject,
        body_html: htmlBody,
        communication_type: 'client',
        sent_at: new Date().toISOString(),
        created_by: sent_by || null,
      }).then(() => {}).catch((e: any) => console.log('[send-outlook-email] po_comms log failed:', e?.message))
    }

    // 2. Log to email_events (delivery tracking)
    sb.from('email_events').insert({
      email_type: 'client_email',
      entity_type: job_id ? 'job' : 'contact',
      entity_id: job_id || ghl_contact_id || toStr,
      job_id: job_id || null,
      recipient: Array.isArray(to) ? to[0] : to,
      sender: from,
      subject,
      status: 'sent',
      sent_at: new Date().toISOString(),
    }).then(() => {}).catch(() => {})

    // 3. Log to GHL contact (so it shows in GHL timeline)
    if (ghl_contact_id) {
      fetch(`${SUPABASE_URL}/functions/v1/ghl-proxy?action=add_note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
        body: JSON.stringify({
          contactId: ghl_contact_id,
          body: `Email sent: "${subject}" to ${toStr}`,
        }),
      }).catch(() => {})
    }

    return json({
      success: true,
      from,
      to: Array.isArray(to) ? to : [to],
      cc: cc ? (Array.isArray(cc) ? cc : [cc]) : [],
      subject,
      attachments: (attachments || []).length,
    })
  } catch (err) {
    console.error('[send-outlook-email] Error:', (err as Error).message)
    return json({ error: (err as Error).message }, 500)
  }
})
