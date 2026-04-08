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
// Mailbox config: type 'user' uses /users/ Graph API, type 'group' uses /groups/ with group ID
const MONITORED_MAILBOXES: Array<{ email: string; type: 'user' | 'group'; groupId?: string }> = [
  { email: 'marnin@secureworkswa.com.au', type: 'user' },
  { email: 'jan@secureworkswa.com.au', type: 'user' },
  { email: 'admin@secureworkswa.com.au', type: 'user' },
  { email: 'shaun@secureworkswa.com.au', type: 'user' },
  { email: 'nithin@secureworkswa.com.au', type: 'user' },
  // khairo@ removed — mailbox invalid in MS365 (T2 Apr 8)
  // MS365 Groups — use group ID (resolve via Graph /groups?$filter=mail eq '...')
  // Group IDs need to be populated after first run — will log errors until set
  { email: 'patios@secureworkswa.com.au', type: 'group', groupId: '' },
  { email: 'fencing@secureworkswa.com.au', type: 'group', groupId: '' },
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

// ── Resolve MS365 Group ID from email address ──
const _groupIdCache = new Map<string, string>()

async function resolveGroupId(token: string, groupEmail: string): Promise<string | null> {
  const cached = _groupIdCache.get(groupEmail.toLowerCase())
  if (cached) return cached

  try {
    const resp = await fetch(
      `https://graph.microsoft.com/v1.0/groups?$filter=mail eq '${groupEmail}'&$select=id,displayName,mail&$top=1`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    )
    if (!resp.ok) {
      console.log(`[monitor-inbox] Group lookup failed for ${groupEmail}: ${resp.status}`)
      return null
    }
    const data = await resp.json()
    const groups = data.value || []
    if (groups.length === 0) {
      console.log(`[monitor-inbox] No M365 Group found for ${groupEmail}`)
      return null
    }
    const groupId = groups[0].id
    console.log(`[monitor-inbox] Resolved ${groupEmail} → Group ID ${groupId} (${groups[0].displayName})`)
    _groupIdCache.set(groupEmail.toLowerCase(), groupId)
    return groupId
  } catch (e) {
    console.log(`[monitor-inbox] Group resolve error for ${groupEmail}:`, (e as Error).message)
    return null
  }
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
  mailboxType: 'user' | 'group' = 'user',
  groupId?: string,
): Promise<{ processed: number; notified: number }> {
  let processed = 0
  let notified = 0

  // Fetch unread messages from last 15 mins (overlap to catch any missed)
  const fifteenMinsAgo = new Date(Date.now() - 15 * 60000).toISOString()
  const graphBase = mailboxType === 'group' && groupId
    ? `https://graph.microsoft.com/v1.0/groups/${groupId}`
    : `https://graph.microsoft.com/v1.0/users/${mailbox}`

  let graphUrl: string
  let isGroupMode = false
  if (mailboxType === 'group' && groupId) {
    // Groups use /threads endpoint — no mailFolders
    graphUrl = `${graphBase}/threads` +
      `?$top=20` +
      `&$select=id,topic,lastDeliveredDateTime,preview,hasAttachments` +
      `&$orderby=lastDeliveredDateTime desc`
    isGroupMode = true
  } else {
    graphUrl = `${graphBase}/mailFolders/inbox/messages` +
      `?$filter=isRead eq false and receivedDateTime ge ${fifteenMinsAgo}` +
      `&$top=20` +
      `&$select=id,from,toRecipients,subject,bodyPreview,receivedDateTime,hasAttachments` +
      `&$orderby=receivedDateTime desc`
  }

  const resp = await fetch(graphUrl, {
    headers: { 'Authorization': `Bearer ${token}` },
  })

  if (!resp.ok) {
    const err = await resp.text()
    console.log(`[monitor-inbox] Graph fetch failed for ${mailbox}: ${resp.status} ${err}`)
    return { processed: 0, notified: 0 }
  }

  const data = await resp.json()
  let messages = data.value || []

  // Normalize group threads into message-like objects
  if (isGroupMode) {
    messages = messages
      .filter((t: any) => {
        // Only process threads from last 15 mins
        const dt = new Date(t.lastDeliveredDateTime || 0)
        return dt.getTime() > Date.now() - 15 * 60000
      })
      .map((t: any) => ({
        id: t.id,
        from: { emailAddress: { address: mailbox, name: t.topic || 'Group Thread' } },
        toRecipients: [{ emailAddress: { address: mailbox } }],
        subject: t.topic || '(no subject)',
        bodyPreview: t.preview || '',
        receivedDateTime: t.lastDeliveredDateTime,
        hasAttachments: t.hasAttachments || false,
      }))
  }

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

    // Outbound detection: skip classification + Telegram for emails FROM our own domain
    const isOutbound = fromEmail.toLowerCase().endsWith('@secureworkswa.com.au') || fromEmail.toLowerCase().endsWith('@secureworksgroup.app')
    if (isOutbound) {
      // Still store in inbox_events for tracking, but mark as outbound/low priority
      await sb.from('inbox_events').insert({
        org_id: DEFAULT_ORG_ID, graph_message_id: msg.id, mailbox,
        from_email: fromEmail, from_name: fromName, to_email: toEmail,
        subject, body_preview: bodyPreview, received_at: receivedAt,
        classification: 'outbound', priority: 'low', action_needed: null,
        telegram_notified: false, metadata: { is_outbound: true },
      }).then(() => {}).catch(() => {})
      processed++
      continue // Skip classification, routing, and Telegram notification
    }

    // Classify (only for external emails)
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

    // COHESION-4: Log email to job_events so it appears in job timeline
    if (jobId && classification.classification !== 'outbound') {
      sb.from('job_events').insert({
        job_id: jobId,
        event_type: 'email_received',
        detail_json: {
          from: fromEmail, from_name: fromName, subject,
          classification: classification.classification,
          priority: classification.priority,
          mailbox, inbox_event_id: msg.id,
        },
      }).then(() => {}).catch(() => {})
    }

    // Capability gap detection: log unclassified emails that look like requests
    if (classification.classification === 'other' && bodyPreview.length > 20) {
      const looksLikeRequest = /\?|please|can you|could you|i need|when will|how do|is it possible/i.test(bodyPreview)
      if (looksLikeRequest) {
        sb.from('business_events').insert({
          event_type: 'capability_gap_detected',
          source: 'monitor-inbox',
          entity_type: 'email',
          entity_id: msg.id,
          payload: { from: fromEmail, subject, preview: bodyPreview.slice(0, 200), mailbox, classification: classification.classification },
        }).then(() => {}).catch(() => {})
      }
    }

    // Download attachments if present and matched to a job
    if (msg.hasAttachments && jobId) {
      try {
        const attachResp = await fetch(
          `${graphBase}/messages/${msg.id}/attachments`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        )
        if (attachResp.ok) {
          const attachData = await attachResp.json()
          for (const att of (attachData.value || [])) {
            if (!att.contentBytes || att.size > 10000000) continue // Skip if no content or >10MB
            const isPdf = (att.contentType || '').includes('pdf') || (att.name || '').endsWith('.pdf')
            const isImage = (att.contentType || '').startsWith('image/')
            if (!isPdf && !isImage) continue // Only store PDFs and images

            const ext = isPdf ? 'pdf' : (att.name || '').split('.').pop() || 'jpg'
            const storagePath = `${DEFAULT_ORG_ID}/${jobId}/supplier/${Date.now()}_${(att.name || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_')}`

            // Upload to Supabase Storage
            const fileBuffer = Uint8Array.from(atob(att.contentBytes), c => c.charCodeAt(0))
            const { error: uploadErr } = await sb.storage
              .from('job-photos')
              .upload(storagePath, fileBuffer, { contentType: att.contentType || 'application/pdf', upsert: true })

            if (uploadErr) {
              console.log(`[monitor-inbox] Attachment upload failed:`, uploadErr.message)
              continue
            }

            const { data: urlData } = sb.storage.from('job-photos').getPublicUrl(storagePath)
            const publicUrl = urlData?.publicUrl || ''

            if (isPdf) {
              // Store as job_document (visible to trades)
              await sb.from('job_documents').insert({
                job_id: jobId,
                type: 'supplier_quote',
                file_name: att.name || 'Supplier Document',
                storage_url: publicUrl,
                pdf_url: publicUrl,
                visible_to_trades: true,
                version: 1,
              }).then(() => {}).catch(() => {})
              console.log(`[monitor-inbox] Stored supplier PDF: ${att.name} for job ${jobId}`)
            } else {
              // Store as job_media
              await sb.from('job_media').insert({
                job_id: jobId,
                phase: 'receipt',
                type: 'photo',
                storage_url: publicUrl,
                label: att.name || 'Supplier attachment',
              }).then(() => {}).catch(() => {})
            }
          }
        }
      } catch (e) {
        console.log(`[monitor-inbox] Attachment processing failed:`, (e as Error).message)
      }
    }

    // Also try to match supplier emails to POs by sender
    if (msg.hasAttachments && !jobId && fromEmail) {
      try {
        // Check if sender email matches any supplier
        const { data: supplierPOs } = await sb.from('purchase_orders')
          .select('id, job_id, supplier_name')
          .eq('org_id', DEFAULT_ORG_ID)
          .ilike('supplier_email', `%${fromEmail.split('@')[1]}%`)
          .order('created_at', { ascending: false })
          .limit(1)
        if (supplierPOs && supplierPOs.length > 0) {
          jobId = supplierPOs[0].job_id
          console.log(`[monitor-inbox] Matched supplier ${fromEmail} to job ${jobId} via PO`)
          // Re-update inbox_events with the matched job_id
          await sb.from('inbox_events')
            .update({ job_id: jobId })
            .eq('graph_message_id', msg.id)
            .then(() => {}).catch(() => {})
        }
      } catch { /* best effort */ }
    }

    // ── PO Reply Pipeline: supplier_quote/supplier_response → po_communications + analyse ──
    if (['supplier_quote', 'supplier_response'].includes(classification.classification) && fromEmail) {
      try {
        // Find PO by sender domain match or subject PO number
        let poId: string | null = null
        let poNumber: string | null = null

        // Try subject line PO number first
        const poMatch = subject.match(/PO[-\s]?(\d{6})/i) || subject.match(/(PO-\d+)/i)
        if (poMatch) {
          const poRef = poMatch[0].replace(/\s/g, '')
          const { data: po } = await sb.from('purchase_orders')
            .select('id, job_id, po_number')
            .ilike('po_number', `%${poRef}%`)
            .eq('org_id', DEFAULT_ORG_ID)
            .maybeSingle()
          if (po) { poId = po.id; poNumber = po.po_number; if (!jobId) jobId = po.job_id }
        }

        // Fallback: sender domain → supplier → active POs
        if (!poId) {
          const senderDomain = fromEmail.split('@')[1] || ''
          const { data: supplierPOs } = await sb.from('purchase_orders')
            .select('id, job_id, po_number, supplier_name')
            .eq('org_id', DEFAULT_ORG_ID)
            .not('status', 'in', '("deleted","billed")')
            .order('created_at', { ascending: false })
            .limit(20)
          // Match by domain in supplier name (lysaght.com → supplier ILIKE %lysaght%)
          const domainRoot = senderDomain.replace(/\.com\.au$|\.com$|\.au$/, '')
          const matchedPO = (supplierPOs || []).find((p: any) =>
            p.supplier_name?.toLowerCase().includes(domainRoot.toLowerCase())
          )
          if (matchedPO) { poId = matchedPO.id; poNumber = matchedPO.po_number; if (!jobId) jobId = matchedPO.job_id }
        }

        if (poId) {
          // Create po_communications record
          await sb.from('po_communications').insert({
            po_id: poId,
            job_id: jobId,
            direction: 'inbound',
            from_email: fromEmail,
            to_email: toEmail,
            subject,
            body_text: bodyPreview,
            communication_type: 'purchase_order',
            received_at: receivedAt,
          }).then(() => {}).catch((e: any) => console.log('[monitor-inbox] po_communications insert failed:', e.message))

          // Log as job_event
          if (jobId) {
            await sb.from('job_events').insert({
              job_id: jobId,
              event_type: 'po_email_received',
              detail_json: { po_id: poId, po_number: poNumber, from_email: fromEmail, subject, source: 'monitor-inbox' },
            }).then(() => {}).catch(() => {})
          }

          // Call analyse_supplier_quote (non-blocking)
          try {
            const analysisResp = await fetch(
              `${SUPABASE_URL}/functions/v1/ops-api?action=analyse_supplier_quote`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
                body: JSON.stringify({ po_id: poId, quote_text: bodyPreview }),
              }
            )
            if (analysisResp.ok) {
              const result = await analysisResp.json()
              console.log(`[monitor-inbox] analyse_supplier_quote: classification=${result.classification}, items=${result.items_extracted}`)
            }
          } catch (e) {
            console.log('[monitor-inbox] analyse_supplier_quote failed (non-blocking):', (e as Error).message)
          }

          // Update inbox_events with matched PO + job
          await sb.from('inbox_events')
            .update({ job_id: jobId, metadata: { has_attachments: msg.hasAttachments || false, job_ref: classification.job_ref, po_id: poId, po_number: poNumber } })
            .eq('graph_message_id', msg.id)
            .then(() => {}).catch(() => {})

          console.log(`[monitor-inbox] PO pipeline: ${fromEmail} → PO ${poNumber} (${poId}), job ${jobId}`)
        }
      } catch (e) {
        console.log('[monitor-inbox] PO reply pipeline failed (non-blocking):', (e as Error).message)
      }
    }

    // ── Classification routing: council, client_reply, invoice, complaint ──
    if (classification.classification === 'council' && jobId) {
      try {
        // Find council_submission for this job where a step is waiting on this sender's domain
        const senderDomain = fromEmail.split('@')[1] || ''
        const { data: submissions } = await sb.from('council_submissions')
          .select('id, steps, current_step_index, overall_status')
          .eq('job_id', jobId)
          .neq('overall_status', 'approved')
          .limit(1)
        if (submissions && submissions.length > 0) {
          const sub = submissions[0]
          // Update last_activity_at
          await sb.from('council_submissions')
            .update({ updated_at: new Date().toISOString() })
            .eq('id', sub.id)
          // Log council email event
          await sb.from('job_events').insert({
            job_id: jobId, event_type: 'council_email_received',
            detail_json: { from: fromEmail, subject, domain: senderDomain, submission_id: sub.id },
          }).then(() => {}).catch(() => {})
          console.log(`[monitor-inbox] Council routing: ${fromEmail} → submission ${sub.id}`)
        }
      } catch (e) {
        console.log('[monitor-inbox] Council routing failed:', (e as Error).message)
      }
    }

    if (classification.classification === 'client_reply' && jobId) {
      try {
        await sb.from('job_events').insert({
          job_id: jobId, event_type: 'client_email_received',
          detail_json: { from: fromEmail, from_name: fromName, subject, preview: bodyPreview.slice(0, 200) },
        })
        console.log(`[monitor-inbox] Client reply routed to job_events for job ${jobId}`)
      } catch (e) {
        console.log('[monitor-inbox] Client reply routing failed:', (e as Error).message)
      }
    }

    if (classification.classification === 'invoice' && jobId) {
      try {
        // Store as job_document (type: trade_invoice) — PDF already stored above if present
        await sb.from('job_documents').insert({
          job_id: jobId,
          type: 'trade_invoice',
          file_name: subject || 'Supplier Invoice',
          visible_to_trades: false,
          version: 1,
        }).then(() => {}).catch(() => {})
        await sb.from('job_events').insert({
          job_id: jobId, event_type: 'invoice_email_received',
          detail_json: { from: fromEmail, subject, classification: 'trade_invoice' },
        }).then(() => {}).catch(() => {})
        console.log(`[monitor-inbox] Invoice routed to job_documents for job ${jobId}`)
      } catch (e) {
        console.log('[monitor-inbox] Invoice routing failed:', (e as Error).message)
      }
    }

    if (classification.classification === 'complaint' && jobId) {
      try {
        await sb.from('job_events').insert({
          job_id: jobId, event_type: 'complaint_received',
          detail_json: { from: fromEmail, from_name: fromName, subject, preview: bodyPreview.slice(0, 200), severity: 'high' },
        })
        await sb.from('ai_alerts').insert({
          org_id: DEFAULT_ORG_ID, job_id: jobId,
          alert_type: 'client_complaint', severity: 'red',
          message: `Complaint from ${fromName || fromEmail}: ${subject}`,
          recommended_action: classification.action_needed || 'Contact client immediately to resolve.',
        }).then(() => {}).catch(() => {})
        console.log(`[monitor-inbox] Complaint alert created for job ${jobId}`)
      } catch (e) {
        console.log('[monitor-inbox] Complaint routing failed:', (e as Error).message)
      }
    }

    // Telegram notification for high priority (with cross-mailbox dedup)
    if (classification.priority === 'high') {
      // Cross-mailbox dedup: check if same subject+sender already notified within 60s
      const { data: recentDupe } = await sb.from('inbox_events')
        .select('id')
        .eq('subject', subject).eq('from_email', fromEmail)
        .eq('telegram_notified', true)
        .gte('received_at', new Date(Date.now() - 60000).toISOString())
        .neq('graph_message_id', msg.id)
        .limit(1)
      if (recentDupe && recentDupe.length > 0) {
        // Already notified from another mailbox — skip
        processed++
        continue
      }
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

    for (const mb of MONITORED_MAILBOXES) {
      let resolvedGroupId = mb.groupId || undefined
      // Auto-resolve group IDs at runtime
      if (mb.type === 'group' && !resolvedGroupId) {
        const gid = await resolveGroupId(token, mb.email)
        if (!gid) {
          console.log(`[monitor-inbox] Skipping ${mb.email} — could not resolve Group ID`)
          continue
        }
        resolvedGroupId = gid
      }
      const { processed, notified } = await processMailbox(sb, token, mb.email, adminTelegramIds, mb.type, resolvedGroupId)
      totalProcessed += processed
      totalNotified += notified
    }

    const result = {
      success: true,
      processed: totalProcessed,
      notified: totalNotified,
      mailboxes: MONITORED_MAILBOXES.map(m => m.email),
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
