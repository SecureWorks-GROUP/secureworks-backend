// ════════════════════════════════════════════════════════════
// SecureWorks — Receive PO Email (Inbound Webhook)
//
// Webhook endpoint for inbound emails routed to orders@secureworksgroup.app.
// Parses the to-address to extract PO/job references and links the email
// to the correct PO thread in po_communications.
//
// Called by: Cloudflare Email Worker or Resend inbound webhook
//
// Deploy:
//   supabase functions deploy receive-po-email --no-verify-jwt
//
// Webhook payload (POST):
//   from_email    — Sender address
//   to_email      — Our address (orders+PO001-SWP25019@secureworksgroup.app)
//   subject       — Email subject
//   body_text     — Plain text body
//   body_html     — HTML body
//   attachments   — Array of { filename, content_base64, content_type }
//
// Routing:
//   Parses to_email for +tag: orders+PO001-SWP25019@secureworksgroup.app
//   → po_number = PO001, job_number = SWP25019
//   Falls back to subject line parsing if no +tag
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Webhook } from 'https://esm.sh/svix@1.15.0'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const RESEND_WEBHOOK_SECRET = Deno.env.get('RESEND_WEBHOOK_SECRET') || ''
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, svix-id, svix-timestamp, svix-signature',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

// Parse the +tag from the to-address
// orders+PO-467989-SWP-25008@secureworksgroup.app → { poNumber: 'PO-467989', jobNumber: 'SWP-25008' }
// orders+PO-467989@secureworksgroup.app → { poNumber: 'PO-467989', jobNumber: null }
// orders+PO001-SWP25019@secureworksgroup.app → { poNumber: 'PO001', jobNumber: 'SWP25019' }
function parseEmailTag(toEmail: string): { poNumber: string | null; jobNumber: string | null } {
  const match = toEmail.match(/orders\+([^@]+)@/i)
  if (!match) return { poNumber: null, jobNumber: null }

  const tag = match[1]

  // Try structured match first: PO-NNNNNN-SWP-NNNNN or PO-NNNNNN
  const structuredMatch = tag.match(/^(PO-?\d+)(?:-(SW[PF]-?\d+))?$/i)
  if (structuredMatch) {
    return { poNumber: structuredMatch[1], jobNumber: structuredMatch[2] || null }
  }

  // Fallback: split on dash between alpha and alpha (e.g. PO001-SWP25019)
  const fallbackMatch = tag.match(/^([A-Z]+\d+)-([A-Z]+\d+)$/i)
  if (fallbackMatch) {
    return { poNumber: fallbackMatch[1], jobNumber: fallbackMatch[2] }
  }

  // Last resort: treat entire tag as PO number
  return { poNumber: tag, jobNumber: null }
}

// Fallback: try to extract PO number from subject line
function parseSubjectForPO(subject: string): string | null {
  const match = subject.match(/\bPO\d{3,}\b/i)
  return match ? match[0].toUpperCase() : null
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405)

  // ── Webhook signature verification ──
  // Resend outbound webhooks use Svix signing, but inbound email webhooks do NOT
  // send Svix headers. Only verify if Svix headers are actually present.
  const rawBody = await req.text()
  const hasSvixHeaders = req.headers.get('svix-id') && req.headers.get('svix-signature')

  if (RESEND_WEBHOOK_SECRET && hasSvixHeaders) {
    try {
      const wh = new Webhook(RESEND_WEBHOOK_SECRET)
      const svixHeaders = {
        'svix-id': req.headers.get('svix-id') || '',
        'svix-timestamp': req.headers.get('svix-timestamp') || '',
        'svix-signature': req.headers.get('svix-signature') || '',
      }
      wh.verify(rawBody, svixHeaders)
    } catch (err) {
      console.error('[receive-po-email] Webhook signature verification failed:', err)
      return json({ error: 'Invalid webhook signature' }, 401)
    }
  } else if (!hasSvixHeaders) {
    console.log('[receive-po-email] No Svix headers — treating as Resend inbound email webhook')
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  try {
    const body = JSON.parse(rawBody)
    const {
      from_email,
      to_email,
      subject,
      body_text,
      body_html,
      attachments,
    } = body

    const receivedAt = new Date().toISOString()

    console.log(`[receive-po-email] Inbound from ${from_email} to ${to_email}: ${subject}`)

    // ── Council prefix routing ──
    // council+CS{submission_id}-step{index}@secureworksgroup.app
    // Also matches: council+{job_number}+CS{id}+S{index}@
    const councilMatch = (to_email || '').match(/council\+(?:CS)?([a-f0-9-]+)[+-](?:step|S)(\d+)@/i)
      || (to_email || '').match(/council\+([A-Z0-9-]+)\+CS([a-f0-9-]+)\+S(\d+)@/i)
    if (councilMatch) {
      let submissionIdPrefix: string
      let stepIndex: number
      if (councilMatch.length === 4) {
        // Format: council+SWP25029+CS550e8400+S0@
        submissionIdPrefix = councilMatch[2]
        stepIndex = Number(councilMatch[3])
      } else {
        submissionIdPrefix = councilMatch[1]
        stepIndex = Number(councilMatch[2])
      }

      const { data: submission } = await sb.from('council_submissions')
        .select('id, job_id, steps')
        .like('id', `${submissionIdPrefix}%`)
        .maybeSingle()

      const jobId = submission?.job_id || null
      const { data: job } = jobId ? await sb.from('jobs').select('job_number').eq('id', jobId).single() : { data: null }

      // Ensure po-attachments bucket exists
      try { await sb.storage.createBucket('job-documents', { public: true }) } catch { /* exists */ }

      // Extract + store attachments (was missing for council routing)
      const storedAttachments: any[] = []
      if (attachments && Array.isArray(attachments) && jobId) {
        for (const att of attachments) {
          if (!att.content_base64 || !att.filename) continue
          try {
            const filePath = `${jobId}/council/house-plans/${Date.now()}-${att.filename}`
            const fileBuffer = Uint8Array.from(atob(att.content_base64), c => c.charCodeAt(0))
            await sb.storage.from('job-documents').upload(filePath, fileBuffer, {
              contentType: att.content_type || 'application/octet-stream',
            })
            const { data: urlData } = sb.storage.from('job-documents').getPublicUrl(filePath)
            storedAttachments.push({ filename: att.filename, storage_url: urlData?.publicUrl || filePath, content_type: att.content_type })
          } catch (e) {
            console.log(`[receive-po-email] Council attachment upload failed: ${(e as Error).message}`)
          }
        }
      }

      // Store council communication with threading
      const inReplyTo = body.in_reply_to || body.headers?.['in-reply-to'] || null
      let threadId = null
      if (inReplyTo) {
        const { data: origMsg } = await sb.from('po_communications').select('thread_id').eq('message_id', inReplyTo).maybeSingle()
        threadId = origMsg?.thread_id || inReplyTo
      }

      await sb.from('po_communications').insert({
        job_id: jobId,
        direction: 'inbound',
        from_email: from_email || null,
        to_email: to_email || null,
        subject: subject || null,
        body_text: body_text || null,
        body_html: body_html || null,
        communication_type: 'council',
        council_submission_id: submission?.id || null,
        council_step_index: stepIndex,
        attachments_json: storedAttachments,
        received_at: new Date().toISOString(),
        in_reply_to: inReplyTo,
        thread_id: threadId,
      })

      // If step 0 (house plans) and has attachments → mark plans received
      if (stepIndex === 0 && storedAttachments.length > 0 && jobId) {
        await sb.from('business_events').insert({
          event_type: 'council.plans_received',
          entity_type: 'job',
          entity_id: jobId,
          detail_json: { filename: storedAttachments[0]?.filename, source: 'email_reply', attachments: storedAttachments.length },
        }).catch(() => {})

        await sb.from('ai_annotations').insert({
          org_id: '00000000-0000-0000-0000-000000000001',
          entity_type: 'job',
          entity_id: jobId,
          ui_location: 'job_overview',
          annotation_type: 'council_plans_received',
          category: 'council',
          title: 'House plans received via email',
          body: `${from_email} replied with ${storedAttachments.length} attachment(s)`,
          priority: 60, severity: 'info',
          source: 'receive-po-email',
          source_ref: `council-plans:${jobId}:${Date.now()}`,
          confidence: 1.0,
        }).catch(() => {})

        // Update council step 0 to complete
        if (submission?.steps && submission.steps[0]?.status === 'pending') {
          const steps = [...submission.steps]
          steps[0] = { ...steps[0], status: 'complete', completed_at: new Date().toISOString(), documents_received: storedAttachments }
          await sb.from('council_submissions').update({ steps, current_step_index: 1 }).eq('id', submission.id)
        }

        console.log(`[receive-po-email] House plans received via email for ${job?.job_number || jobId}`)
      }

      console.log(`[receive-po-email] Council routed: submission=${submissionIdPrefix}, step=${stepIndex}, attachments=${storedAttachments.length}`)
      return json({ success: true, type: 'council', submission_id: submission?.id, step_index: stepIndex, attachments: storedAttachments.length })
    }

    // Parse the to-address for PO/job reference
    let { poNumber, jobNumber } = parseEmailTag(to_email || '')

    // Fallback to subject parsing
    if (!poNumber && subject) {
      poNumber = parseSubjectForPO(subject)
    }

    // Look up PO by po_number
    let poId: string | null = null
    let jobId: string | null = null

    if (poNumber) {
      const { data: po } = await sb
        .from('purchase_orders')
        .select('id, job_id, po_number')
        .eq('po_number', poNumber)
        .eq('org_id', DEFAULT_ORG_ID)
        .maybeSingle()

      if (po) {
        poId = po.id
        jobId = po.job_id
        console.log(`[receive-po-email] Matched PO ${po.po_number} (${poId}), job ${jobId}`)
      } else {
        console.log(`[receive-po-email] PO number ${poNumber} not found in database`)
      }
    }

    // Sender-to-supplier fallback: if no PO matched by tag/subject, try matching sender email to a supplier
    if (!poId && from_email) {
      const { data: supplier } = await sb.from('suppliers')
        .select('id, name')
        .eq('email', from_email)
        .eq('is_active', true)
        .maybeSingle()
      if (supplier) {
        const { data: activePOs } = await sb.from('purchase_orders')
          .select('id, job_id, po_number')
          .eq('supplier_name', supplier.name)
          .eq('org_id', DEFAULT_ORG_ID)
          .not('status', 'in', '("deleted","billed")')
          .order('created_at', { ascending: false })
          .limit(1)
        if (activePOs && activePOs.length > 0) {
          poId = activePOs[0].id
          jobId = activePOs[0].job_id
          poNumber = activePOs[0].po_number
          console.log(`[receive-po-email] Sender-match: ${from_email} → ${supplier.name} → PO ${poNumber}`)
        }
      }
    }

    // If we also got a job number from the tag, verify/use it
    if (jobNumber && !jobId) {
      const { data: job } = await sb
        .from('jobs')
        .select('id')
        .eq('job_number', jobNumber)
        .maybeSingle()
      if (job) jobId = job.id
    }

    // Ensure po-attachments bucket exists (was never created — bug fix)
    try { await sb.storage.createBucket('po-attachments', { public: true }) } catch { /* exists */ }

    // Store attachments in Supabase Storage if we have a PO
    const storedAttachments: any[] = []
    if (attachments && Array.isArray(attachments) && poId) {
      for (const att of attachments) {
        if (!att.content_base64 || !att.filename) continue
        try {
          const filePath = `po-attachments/${poId}/${Date.now()}-${att.filename}`
          const fileBuffer = Uint8Array.from(atob(att.content_base64), c => c.charCodeAt(0))

          const { data: uploaded, error: uploadErr } = await sb.storage
            .from('po-attachments')
            .upload(filePath, fileBuffer, {
              contentType: att.content_type || 'application/octet-stream',
            })

          if (uploadErr) {
            console.log(`[receive-po-email] Attachment upload failed: ${uploadErr.message}`)
          } else {
            const { data: urlData } = sb.storage.from('po-attachments').getPublicUrl(filePath)
            storedAttachments.push({
              filename: att.filename,
              storage_url: urlData?.publicUrl || filePath,
              content_type: att.content_type || 'application/octet-stream',
            })
          }
        } catch (e) {
          console.log(`[receive-po-email] Attachment storage error: ${(e as Error).message}`)
        }
      }
    }

    // Extract threading headers from inbound email
    const inReplyTo = body.in_reply_to || body.headers?.['in-reply-to'] || null
    let threadId = null
    if (inReplyTo) {
      // Look up the original message to get its thread_id
      const { data: origMsg } = await sb.from('po_communications')
        .select('thread_id, message_id')
        .eq('message_id', inReplyTo)
        .maybeSingle()
      threadId = origMsg?.thread_id || inReplyTo // Use original's thread_id, or the in_reply_to as thread start
    }

    // Extract the inbound message's own Message-ID for threading
    const inboundMessageId = body.message_id || body.headers?.['message-id'] || null

    // If PO found, store in po_communications
    if (poId) {
      const { data: comm, error: commErr } = await sb
        .from('po_communications')
        .insert({
          po_id: poId,
          job_id: jobId,
          direction: 'inbound',
          from_email,
          to_email,
          subject,
          body_text: body_text || null,
          body_html: body_html || null,
          attachments_json: storedAttachments.length > 0 ? storedAttachments : [],
          received_at: receivedAt,
          message_id: inboundMessageId,
          in_reply_to: inReplyTo,
          thread_id: threadId,
        })
        .select('id')
        .single()

      if (commErr) {
        console.error('[receive-po-email] Failed to store communication:', commErr)
      }

      // Log as job_event for timeline
      if (jobId) {
        await sb.from('job_events').insert({
          job_id: jobId,
          event_type: 'po_email_received',
          detail_json: {
            po_id: poId,
            po_number: poNumber,
            from_email,
            subject,
            communication_id: comm?.id || null,
            attachment_count: storedAttachments.length,
          },
        })
      }

      // ── Trigger AI analysis: pricing extraction + reply classification + delivery date ──
      // One Sonnet call handles everything — no separate Haiku classification needed.
      // Always analyse supplier replies (not just pricing-looking ones) so we catch
      // confirmations, questions, and issues too.
      let analysisResult: any = null
      try {
        const opsApiUrl = SUPABASE_URL + '/functions/v1/ops-api?action=analyse_supplier_quote'

        // Grab first image attachment base64 if available
        let firstImageB64: string | null = null
        if (attachments && Array.isArray(attachments)) {
          const img = attachments.find((a: any) =>
            a.content_base64 && a.content_type?.startsWith('image/')
          )
          if (img) firstImageB64 = img.content_base64
        }

        const analysisResp = await fetch(opsApiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          },
          body: JSON.stringify({
            po_id: poId,
            quote_text: body_text || '',
            ...(firstImageB64 ? { image_base64: firstImageB64 } : {}),
          }),
        })

        if (analysisResp.ok) {
          analysisResult = await analysisResp.json()
          console.log(`[receive-po-email] analyseSupplierQuote for PO ${poNumber}: classification=${analysisResult.classification}, confidence=${analysisResult.confidence}, confirmation=${analysisResult.is_confirmation}, items=${analysisResult.items_extracted}`)

          // Store AI classification on the communication row
          if (comm?.id && analysisResult.classification) {
            const classUpdate: any = {
              ai_classification: analysisResult.classification,
              ai_confidence: analysisResult.confidence || null,
            }
            // Quote versioning: count prior quotes for this PO and assign version
            if (analysisResult.classification === 'quote' && poId) {
              const { count } = await sb.from('po_communications')
                .select('*', { count: 'exact', head: true })
                .eq('po_id', poId)
                .eq('ai_classification', 'quote')
              classUpdate.quote_version = (count || 0) + 1
            }
            await sb.from('po_communications').update(classUpdate).eq('id', comm.id)
          }
        } else {
          console.log(`[receive-po-email] analyseSupplierQuote returned ${analysisResp.status}`)
        }
      } catch (e) {
        // Never fail email archival due to AI analysis
        console.log(`[receive-po-email] analyseSupplierQuote error: ${(e as Error).message}`)
      }

      // ── Telegram notification for high-priority classifications ──
      if (analysisResult && analysisResult.classification) {
        const cls = analysisResult.classification
        const conf = analysisResult.confidence || 0
        const isHighPriority = cls === 'invoice' || cls === 'issue' || (cls === 'confirmation' && conf < 0.8)
        if (isHighPriority) {
          const TBOT = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
          if (TBOT) {
            // Query admin users with telegram_id (same pattern as daily-digest)
            const { data: admins } = await sb.from('users')
              .select('telegram_id')
              .or('email.ilike.%marnin%,email.ilike.%shaun%')
              .not('telegram_id', 'is', null)
            if (admins && admins.length > 0) {
              const emoji = cls === 'invoice' ? '🧾' : cls === 'issue' ? '⚠️' : '❓'
              const preview = (body_text || '').split('\n')[0]?.substring(0, 60) || ''
              const tgMsg = `${emoji} <b>Supplier Email — ${cls}</b>\n${poNumber || 'Unknown PO'} from ${from_email}\n<i>${preview}</i>`
              for (const admin of admins) {
                try {
                  await fetch(`https://api.telegram.org/bot${TBOT}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: admin.telegram_id, text: tgMsg, parse_mode: 'HTML' }),
                  })
                } catch (e) { /* non-blocking */ }
              }
            }
          }
        }
      }

      // ── Urgency detection — scan for keywords that need immediate attention ──
      const bodyLower = (body_text || '').toLowerCase() + ' ' + (subject || '').toLowerCase()
      const urgencyKeywords = [
        { pattern: /out of stock|unavailable|not available/i, label: 'Out of stock', severity: 'warning' },
        { pattern: /delay|delayed|postpone|push back/i, label: 'Delivery delayed', severity: 'warning' },
        { pattern: /price increase|price change|surcharge/i, label: 'Price change', severity: 'warning' },
        { pattern: /discontinued|no longer|end of line/i, label: 'Product discontinued', severity: 'critical' },
        { pattern: /back.?order|lead time.*week/i, label: 'Backorder', severity: 'warning' },
      ]
      for (const kw of urgencyKeywords) {
        if (kw.pattern.test(bodyLower) && jobId) {
          const sourceRef = `urgency:${comm?.id || 'unknown'}:${kw.label}`
          await sb.from('ai_annotations').insert({
            org_id: DEFAULT_ORG_ID,
            entity_type: 'job',
            entity_id: jobId,
            ui_location: 'job_overview',
            annotation_type: 'supplier_urgency',
            category: 'materials',
            title: `Supplier: ${kw.label}`,
            body: `Email from ${from_email}: "${subject}". Review and take action.`,
            priority: kw.severity === 'critical' ? 90 : 70,
            severity: kw.severity,
            source: 'receive-po-email',
            source_ref: sourceRef,
            confidence: 0.85,
          }).catch(() => {})
          console.log(`[receive-po-email] Urgency detected: ${kw.label} for job ${jobId}`)
          break // One annotation per email
        }
      }

      return json({
        success: true,
        matched: true,
        po_id: poId,
        job_id: jobId,
        communication_id: comm?.id || null,
        classification: analysisResult?.classification || null,
        is_confirmation: analysisResult?.is_confirmation || false,
        confirmed_delivery_date: analysisResult?.confirmed_delivery_date || null,
      })

    } else {
      // PO not found — store in unmatched_emails for manual review
      console.log(`[receive-po-email] Unmatched email from ${from_email}: ${subject}`)

      await sb.from('unmatched_emails').insert({
        from_email,
        to_email,
        subject,
        body_text: body_text || null,
        body_html: body_html || null,
        attachments_json: attachments ? attachments.map((a: any) => ({
          filename: a.filename,
          content_type: a.content_type,
        })) : [],
        received_at: receivedAt,
      })

      return json({
        success: true,
        matched: false,
        reason: poNumber ? `PO ${poNumber} not found` : 'No PO reference in address or subject',
      })
    }

  } catch (err) {
    console.error('[receive-po-email] ERROR:', err)
    return json({ error: (err as Error).message || 'Internal error' }, 500)
  }
})
