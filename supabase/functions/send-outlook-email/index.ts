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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-api-key, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

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
      body: { contentType: 'HTML', content: htmlBody },
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
