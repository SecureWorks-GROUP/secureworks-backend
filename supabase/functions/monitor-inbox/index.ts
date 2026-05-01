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
// Step 17: Expanded from 2 to 7 mailboxes (GRAF Level 6)
// khairo@ excluded — MS365 mailbox not provisioned (needs admin action)
const MONITORED_MAILBOXES = [
  'marnin@secureworkswa.com.au',
  'jan@secureworkswa.com.au',
  'nithin@secureworkswa.com.au',    // Sales (patios) — confirmed working
  'shaun@secureworkswa.com.au',     // Ops manager — returns Apr 13, mailbox active
  'admin@secureworkswa.com.au',     // Shared admin inbox
  'patios@secureworkswa.com.au',    // Group mailbox — patio enquiries
  'fencing@secureworkswa.com.au',   // Group mailbox — fencing enquiries
  // 'khairo@secureworkswa.com.au', // NOT provisioned in MS365 — needs admin to create/verify
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
job_ref: extract FIRST match from subject or body, in this priority order, or null:
  1. Legacy/bare job number: SW\\d{4,} (e.g., SW1895)
  2. Prefixed: SWP-\\d+, SWF-\\d+, SWD-\\d+ (e.g., SWP-26046)
  3. PO number: PO-\\d+ (e.g., PO-061378) — return as "PO-XXXXXX"
  4. Supplier invoice number: INV-\\d+ — return as "INV-XXXXX"
  5. Supplier quote ref: Quote #\\d+ — return as "Quote#XXX"
Return the raw matched string preserving case/format. Leave null only if none present.`,
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

// ── Comprehensive job resolution — tries every ref pattern + supplier/client fallbacks.
//
// Returns a confidence tier so that downstream logic (e.g. auto-attaching a supplier
// PDF) can decide whether the match is strong enough to act on:
//
//   'high'  — unambiguous reference-based match (explicit job_number / PO number).
//             Safe to auto-attach PDFs to this job.
//   'low'   — heuristic match (supplier sender domain or client-name fuzzy match).
//             Good enough to tag inbox_events for human review, but NOT safe for
//             auto-attaching files — supplier can have multiple open POs, common
//             first words can collide, etc. Do not move files on 'low'.
//
// When no match is found at all, jobId/matchedVia are null and confidence is 'none'.
async function resolveJobId(
  sb: any,
  fromEmail: string,
  subject: string,
  bodyPreview: string,
  classifierJobRef: string | null,
): Promise<{ jobId: string | null; matchedVia: string | null; confidence: 'high' | 'low' | 'none' }> {
  const haystack = `${subject}\n${bodyPreview}`

  // 1. AI classifier job_ref — could be SW####, SW[PFD]-####, PO-######, INV-#####, Quote####
  if (classifierJobRef) {
    const ref = classifierJobRef.trim()
    if (/^PO-?\d+$/i.test(ref)) {
      const { data } = await sb.from('purchase_orders')
        .select('job_id').eq('org_id', DEFAULT_ORG_ID)
        .ilike('po_number', ref.replace(/\s/g, '')).limit(1).maybeSingle()
      if (data?.job_id) return { jobId: data.job_id, matchedVia: `ai_po:${ref}`, confidence: 'high' }
    } else if (/^Quote\s*#?\d+$/i.test(ref)) {
      const num = ref.match(/\d+/)?.[0]
      if (num) {
        // Only accept Quote# match if it resolves to exactly ONE PO. If multiple POs
        // reference the same quote number (e.g. notes text collision across suppliers),
        // the match is ambiguous — downgrade to 'none' rather than guess.
        const { data } = await sb.from('purchase_orders')
          .select('job_id').eq('org_id', DEFAULT_ORG_ID)
          .or(`notes.ilike.%Quote #${num}%,notes.ilike.%Quote#${num}%`).limit(2)
        if (data && data.length === 1 && data[0].job_id) {
          return { jobId: data[0].job_id, matchedVia: `ai_quote:${ref}`, confidence: 'high' }
        }
      }
    } else if (/^INV-?\d+$/i.test(ref)) {
      // Xero invoice lookup — best effort
      const { data } = await sb.from('xero_invoices')
        .select('contact_id, reference').ilike('invoice_number', ref).limit(1).maybeSingle()
      if (data?.reference) {
        // Xero reference field often contains SW#### or PO-#### — re-parse
        const reRef = data.reference.match(/\bSW\d{4,}\b|\bSW[PFD]-\d+\b|\bPO-?\d{6}\b/i)
        if (reRef) {
          if (/^PO/i.test(reRef[0])) {
            const { data: po } = await sb.from('purchase_orders')
              .select('job_id').ilike('po_number', reRef[0]).limit(1).maybeSingle()
            if (po?.job_id) return { jobId: po.job_id, matchedVia: `ai_inv_via_po:${ref}`, confidence: 'high' }
          } else {
            const { data: job } = await sb.from('jobs')
              .select('id').eq('org_id', DEFAULT_ORG_ID)
              .ilike('job_number', reRef[0]).limit(1).maybeSingle()
            if (job?.id) return { jobId: job.id, matchedVia: `ai_inv_via_job:${ref}`, confidence: 'high' }
          }
        }
      }
    } else {
      // Treat as raw job_number (SW####, SW[PFD]-####)
      const { data } = await sb.from('jobs')
        .select('id').eq('org_id', DEFAULT_ORG_ID)
        .ilike('job_number', ref).limit(1).maybeSingle()
      if (data?.id) return { jobId: data.id, matchedVia: `ai_job_ref:${ref}`, confidence: 'high' }
    }
  }

  // 2. Direct scan — legacy SW#### (e.g. SW1895) from subject/body
  const swLegacy = haystack.match(/\bSW\d{4,}\b/i)
  if (swLegacy) {
    const { data } = await sb.from('jobs')
      .select('id').eq('org_id', DEFAULT_ORG_ID)
      .ilike('job_number', swLegacy[0]).limit(1).maybeSingle()
    if (data?.id) return { jobId: data.id, matchedVia: `legacy_sw:${swLegacy[0]}`, confidence: 'high' }
  }

  // 3. Prefixed SW[PFD]-####
  const swPrefixed = haystack.match(/\bSW[PFD]-\d+\b/i)
  if (swPrefixed) {
    const { data } = await sb.from('jobs')
      .select('id').eq('org_id', DEFAULT_ORG_ID)
      .ilike('job_number', swPrefixed[0]).limit(1).maybeSingle()
    if (data?.id) return { jobId: data.id, matchedVia: `job_ref:${swPrefixed[0]}`, confidence: 'high' }
  }

  // 4. PO number in subject/body
  const poMatch = haystack.match(/\bPO-?\d{6}\b/i)
  if (poMatch) {
    const { data } = await sb.from('purchase_orders')
      .select('job_id').eq('org_id', DEFAULT_ORG_ID)
      .ilike('po_number', poMatch[0]).limit(1).maybeSingle()
    if (data?.job_id) return { jobId: data.job_id, matchedVia: `po:${poMatch[0]}`, confidence: 'high' }
  }

  // 5. LOW-CONFIDENCE: supplier sender domain → PO from that supplier.
  //    Only return if there's exactly ONE open/draft/sent PO from this supplier in
  //    the last 60 days — otherwise we'd misfile onto whichever PO happens to be
  //    most recent. With 2+ candidates, treat as no match and let humans link it.
  if (fromEmail && fromEmail.includes('@')) {
    const domain = fromEmail.split('@')[1]
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    const { data: candidates } = await sb.from('purchase_orders')
      .select('job_id').eq('org_id', DEFAULT_ORG_ID)
      .ilike('supplier_email', `%@${domain}%`)
      .gte('created_at', sixtyDaysAgo)
      .limit(2)
    if (candidates && candidates.length === 1 && candidates[0].job_id) {
      return { jobId: candidates[0].job_id, matchedVia: `supplier_domain_single:${domain}`, confidence: 'low' }
    }
  }

  // 6. LOW-CONFIDENCE: client name from cleaned subject.
  //    Only return if the first word (i) is reasonably specific (>3 chars, not a
  //    generic greeting) AND (ii) matches exactly ONE non-archived job. Multiple
  //    matches = ambiguous; return none.
  const cleanSubject = subject.replace(/^(RE|FW|Fwd):\s*/gi, '').trim()
  const firstWord = cleanSubject.split(/\s+/)[0]
  const GENERIC_WORDS = /^(PO|INV|CN|Quote|Re|Fw|Dear|Hello|Hi|Thanks|Thank|Update|Delivery|Order|Notice|Work|Credit|Invoice|Upcoming|New|Your|Our|We|This|From|Subject|Regards)$/i
  if (firstWord && firstWord.length > 3 && !GENERIC_WORDS.test(firstWord)) {
    const { data: candidates } = await sb.from('jobs')
      .select('id').ilike('client_name', `%${firstWord}%`)
      .eq('org_id', DEFAULT_ORG_ID).not('archived', 'is', true).limit(2)
    if (candidates && candidates.length === 1) {
      return { jobId: candidates[0].id, matchedVia: `client_name_single:${firstWord}`, confidence: 'low' }
    }
  }

  return { jobId: null, matchedVia: null, confidence: 'none' }
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

    // Try to match to a job — comprehensive ref-based resolution
    let jobId: string | null = null
    let matchedVia: string | null = null
    let matchConfidence: 'high' | 'low' | 'none' = 'none'
    let ghlContactId: string | null = null
    const resolved = await resolveJobId(sb, fromEmail, subject, bodyPreview, classification.job_ref)
    jobId = resolved.jobId
    matchedVia = resolved.matchedVia
    matchConfidence = resolved.confidence

    // Try to match sender to a contact
    if (fromEmail) {
      const { data: contact } = await sb.from('contact_matches')
        .select('ghl_contact_id')
        .ilike('email', fromEmail)
        .limit(1)
        .maybeSingle()
      ghlContactId = contact?.ghl_contact_id || null
    }

    // Store in inbox_events; capture id for the business_events payload backref.
    const { data: inboxRow, error: insertErr } = await sb.from('inbox_events').insert({
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
        matched_via: matchedVia,
        match_confidence: matchConfidence,
      },
    }).select('id').single()

    if (insertErr) {
      console.log(`[monitor-inbox] Insert failed for ${msg.id}:`, insertErr.message)
      continue
    }

    const inboxEventId = inboxRow?.id || null

    processed++

    // Download attachments ONLY when we have a HIGH-confidence job match.
    // Low-confidence matches (supplier_domain_single, client_name_single) still tag
    // inbox_events.job_id for human review but must NOT auto-move files, because
    // the ref-free heuristics can confidently point to the wrong PO/job.
    if (msg.hasAttachments && jobId && matchConfidence === 'high') {
      try {
        const attachResp = await fetch(
          `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${msg.id}/attachments`,
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
              // Decide doc type + visibility from classification + subject keywords.
              // Fallback to 'supplier_quote' because that value is guaranteed to exist
              // in the job_documents.type CHECK constraint across schema revisions.
              const subjLower = (subject + ' ' + (att.name || '')).toLowerCase()
              let docType = 'supplier_quote'
              let visibleToTrades = true
              if (classification.classification === 'invoice') {
                docType = 'supplier_invoice'
                visibleToTrades = false // invoices contain prices — don't show to trades
              } else if (/work.?order|delivery|install|schedule|dispatch/i.test(subjLower)) {
                docType = 'supplier_work_order'
                visibleToTrades = true
              } else if (classification.classification === 'supplier_response') {
                docType = 'supplier_work_order' // default inbound supplier response with doc is treated as work-order-adjacent
                visibleToTrades = true
              }

              // Insert with visible error handling. If the new type is rejected by the
              // CHECK constraint (pre-migration DB), fall back to 'supplier_quote' so
              // the PDF is never silently lost.
              const baseRow = {
                job_id: jobId,
                file_name: att.name || 'Supplier Document',
                storage_url: publicUrl,
                pdf_url: publicUrl,
                visible_to_trades: visibleToTrades,
                version: 1,
              }
              const { error: insertDocErr } = await sb.from('job_documents')
                .insert({ ...baseRow, type: docType })
              if (insertDocErr) {
                console.error(`[monitor-inbox] job_documents insert failed for ${att.name} (type=${docType}, job=${jobId}): ${insertDocErr.message}`)
                // Fallback: retry with legacy-safe type so the PDF is still recorded.
                if (docType !== 'supplier_quote') {
                  const { error: retryErr } = await sb.from('job_documents')
                    .insert({ ...baseRow, type: 'supplier_quote' })
                  if (retryErr) {
                    console.error(`[monitor-inbox] job_documents fallback insert ALSO failed for ${att.name}: ${retryErr.message}`)
                  } else {
                    console.warn(`[monitor-inbox] Stored supplier PDF: ${att.name} with FALLBACK type=supplier_quote (intended ${docType}) for job ${jobId} via ${matchedVia}`)
                  }
                }
              } else {
                console.log(`[monitor-inbox] Stored supplier PDF: ${att.name} as ${docType} (trades=${visibleToTrades}) for job ${jobId} via ${matchedVia}`)
              }
            } else {
              // Store as job_media — surface errors, don't swallow
              const { error: mediaErr } = await sb.from('job_media').insert({
                job_id: jobId,
                phase: 'receipt',
                type: 'photo',
                storage_url: publicUrl,
                label: att.name || 'Supplier attachment',
              })
              if (mediaErr) {
                console.error(`[monitor-inbox] job_media insert failed for ${att.name} (job=${jobId}): ${mediaErr.message}`)
              }
            }
          }
        }
      } catch (e) {
        console.log(`[monitor-inbox] Attachment processing failed:`, (e as Error).message)
      }
    }

    // (The legacy supplier-domain "most recent PO" fallback was removed here — it
    // misfiled attachments onto the wrong PO when a supplier had multiple open jobs.
    // The new resolveJobId() covers the same case correctly, returning a match only
    // when there's exactly ONE PO candidate in the last 60 days.)

    // ── Job Memory Loop: create business_event for supplier/client emails ──
    const isSupplier = ['supplier_quote', 'supplier_response'].includes(classification.classification)
    const isClient = ['client_reply', 'complaint', 'urgent'].includes(classification.classification)
    if (isSupplier || isClient) {
      // For supplier emails without a job match, try PO number from subject
      let finalJobId = jobId
      if (!finalJobId && isSupplier) {
        const poMatch = subject.match(/PO-?\d{6}/i)
        if (poMatch) {
          const { data: po } = await sb.from('purchase_orders')
            .select('job_id')
            .ilike('po_number', poMatch[0])
            .limit(1)
            .maybeSingle()
          finalJobId = po?.job_id || null
        }
      }
      // If still no match, try client name from subject for non-archived jobs
      if (!finalJobId && isSupplier) {
        const cleanSubject = subject.replace(/^(RE|FW|Fwd):\s*/gi, '').trim()
        const firstWord = cleanSubject.split(' ')[0]
        if (firstWord && firstWord.length > 2) {
          const { data: matchedJobs } = await sb.from('jobs')
            .select('id')
            .ilike('client_name', `%${firstWord}%`)
            .eq('org_id', DEFAULT_ORG_ID)
            .not('archived', 'is', true)
            .limit(1)
          finalJobId = matchedJobs?.[0]?.id || null
        }
      }

      await sb.from('business_events').insert({
        event_type: isSupplier ? 'supplier.email_in' : 'client.email_in',
        source: 'monitor_inbox',
        entity_type: finalJobId ? 'job' : (isSupplier ? 'unmatched_supplier' : 'unmatched_contact'),
        entity_id: finalJobId || 'unmatched',
        job_id: finalJobId || null,
        payload: {
          from: fromEmail,
          subject: subject.slice(0, 200),
          body_preview: bodyPreview,
          inbox_events_id: inboxEventId,
          classification: classification.classification,
          priority: classification.priority,
          has_attachments: msg.hasAttachments || false,
          matched: !!finalJobId,
          mailbox,
          job_ref: classification.job_ref || null,
        },
        occurred_at: receivedAt || new Date().toISOString(),
      }).then(() => {}).catch((e: any) => {
        console.log(`[monitor-inbox] business_event insert failed:`, e?.message)
      })
    }

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
