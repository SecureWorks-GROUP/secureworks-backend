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

const EMAIL_SIGNATURE = `
<div style="margin-top:32px;padding-top:16px;border-top:2px solid #F15A29;font-family:Helvetica,Arial,sans-serif">
  <table cellpadding="0" cellspacing="0" border="0" style="font-family:Helvetica,Arial,sans-serif">
    <tr>
      <td style="padding-right:16px;vertical-align:top">
        <img src="data:image/png;base64,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" width="160" alt="SecureWorks WA" style="display:block" />
      </td>
      <td style="padding-left:16px;border-left:2px solid #293C46;vertical-align:top">
        <p style="margin:0 0 2px;font-size:15px;font-weight:bold;color:#293C46">Marnin Stobbe</p>
        <p style="margin:0 0 8px;font-size:13px;color:#4C6A7C">Operations Manager</p>
        <p style="margin:0 0 4px;font-size:11px;color:#293C46;letter-spacing:3px;font-weight:600">EXCELLENCE \&nbsp;|\&nbsp; INTEGRITY \&nbsp;|\&nbsp; SERVICE</p>
        <p style="margin:8px 0 0;font-size:13px;color:#4C6A7C">
          <b style="color:#293C46">P:</b> 0404 777 984 \&nbsp;\&nbsp;
          <b style="color:#293C46">E:</b> <a href="mailto:marnin@secureworkswa.com.au" style="color:#F15A29;text-decoration:none">marnin@secureworkswa.com.au</a>
        </p>
      </td>
    </tr>
  </table>
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
      body: { contentType: 'HTML', content: htmlBody + EMAIL_SIGNATURE },
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
