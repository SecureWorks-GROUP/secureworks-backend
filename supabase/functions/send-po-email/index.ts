// ════════════════════════════════════════════════════════════
// SecureWorks — Send PO Email Edge Function
//
// Sends supplier emails via Resend API, linked to specific POs and jobs.
// Stores all sent emails in po_communications for thread tracking.
//
// Deploy:
//   supabase functions deploy send-po-email --no-verify-jwt
//
// Secrets required:
//   TODO: supabase secrets set RESEND_API_KEY="re_..."
//   From domain: orders@secureworkswa.com.au (must be verified in Resend)
//
// Params (POST body):
//   po_id         — UUID of purchase order
//   job_id        — UUID of job (optional, looked up from PO if omitted)
//   to_email      — Supplier email address
//   subject       — Email subject (auto-appends PO/job ref if missing)
//   body_html     — HTML email body
//   body_text     — Plain text fallback (optional)
//   attachments   — Array of { filename, storage_url, content_type } (optional)
//   attach_po_pdf — Boolean, attach PO PDF (implemented — requires pdf_url)
//   dry_run       — Boolean, skip actual send but store the record
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || ''
const FROM_EMAIL = Deno.env.get('FROM_EMAIL') || 'orders@secureworkswa.com.au'
const FROM_NAME = Deno.env.get('FROM_NAME') || 'SecureWorks Group'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  // ── API Key Authentication ──
  const apiKey = req.headers.get('x-api-key') || req.headers.get('authorization')?.replace('Bearer ', '')
  const validKey = Deno.env.get('SW_API_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!apiKey || (apiKey !== validKey && apiKey !== serviceKey)) {
    return json({ error: 'Unauthorized' }, 401)
  }

  if (req.method !== 'POST') return json({ error: 'POST required' }, 405)

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  try {
    const body = await req.json()
    const {
      po_id,
      to_email,
      subject: rawSubject,
      body_html,
      body_text,
      attachments,
      attach_po_pdf,
      pdf_url,
      dry_run,
    } = body
    let { job_id } = body
    const cc: string[] = body.cc || []

    if (!po_id || !to_email) {
      return json({ error: 'po_id and to_email required' }, 400)
    }
    if (!rawSubject || (!body_html && !body_text)) {
      return json({ error: 'subject and body_html (or body_text) required' }, 400)
    }

    // Look up PO for number and job reference
    const { data: po, error: poErr } = await sb
      .from('purchase_orders')
      .select('id, po_number, job_id, supplier_name, reference')
      .eq('id', po_id)
      .single()

    if (poErr || !po) {
      return json({ error: 'PO not found: ' + (poErr?.message || po_id) }, 404)
    }

    // Get job_id from PO if not provided
    if (!job_id) job_id = po.job_id

    // Look up job number for subject tagging
    let jobNumber = ''
    if (job_id) {
      const { data: job } = await sb
        .from('jobs')
        .select('job_number')
        .eq('id', job_id)
        .single()
      jobNumber = job?.job_number || ''
    }

    // Build subject — auto-append PO/job reference if not already present
    const poRef = po.po_number || ''
    let subject = rawSubject
    const refTag = `${poRef}${jobNumber ? ' | ' + jobNumber : ''}`
    if (poRef && subject.indexOf(poRef) === -1) {
      subject = `${subject} | ${refTag}`
    }

    // Build reply-to with encoded PO reference for inbound routing
    // Format: orders+PO001-SWP25019@secureworksgroup.app (Resend inbound domain)
    const fromDomain = FROM_EMAIL.split('@')[1] || 'secureworksgroup.app'
    const replyToTag = `${poRef}${jobNumber ? '-' + jobNumber : ''}`.replace(/\s+/g, '')
    const replyTo = `orders+${replyToTag}@${fromDomain}`

    // Build email HTML with signature
    const htmlBody = body_html || `<pre>${body_text}</pre>`
    const fullHtml = `${htmlBody}
<br><hr style="border:none;border-top:1px solid #ddd;margin:20px 0;">
<p style="font-size:12px;color:#666;">
  <strong>SecureWorks Group Pty Ltd</strong><br>
  ${FROM_EMAIL}<br>
  Ref: ${refTag}
</p>`

    // Attach PO PDF if URL provided (generated client-side and uploaded to Storage)
    const emailAttachments: Array<{filename: string, content: string}> = []
    if (attach_po_pdf && pdf_url) {
      try {
        const pdfRes = await fetch(pdf_url)
        if (pdfRes.ok) {
          const pdfBuf = await pdfRes.arrayBuffer()
          const pdfBytes = new Uint8Array(pdfBuf)
          // Chunked base64 encoding to avoid stack overflow on large files
          let binary = ''
          const chunkSize = 8192
          for (let i = 0; i < pdfBytes.length; i += chunkSize) {
            const chunk = pdfBytes.subarray(i, i + chunkSize)
            binary += String.fromCharCode(...chunk)
          }
          const pdfBase64 = btoa(binary)
          const pdfFilename = `${poRef || 'PO'}.pdf`
          emailAttachments.push({ filename: pdfFilename, content: pdfBase64 })
          console.log(`[send-po-email] PDF attached: ${pdfFilename} (${pdfBytes.length} bytes)`)
        } else {
          console.log(`[send-po-email] PDF fetch failed: HTTP ${pdfRes.status}`)
        }
      } catch (e) {
        console.log(`[send-po-email] PDF attachment error (non-blocking): ${(e as Error).message}`)
      }
    } else if (attach_po_pdf) {
      console.log(`[send-po-email] attach_po_pdf requested but no pdf_url provided`)
    }

    // Send via Resend API (unless dry_run)
    let resendId = null
    const sentAt = new Date().toISOString()

    if (!dry_run) {
      if (!RESEND_API_KEY) {
        return json({ error: 'RESEND_API_KEY not configured — use dry_run=true for testing' }, 500)
      }

      const resendPayload: any = {
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: [to_email],
        reply_to: replyTo,
        subject,
        html: fullHtml,
      }
      if (body_text) resendPayload.text = body_text
      if (cc.length > 0) resendPayload.cc = cc

      // Add PDF and any other attachments
      if (emailAttachments.length > 0) {
        resendPayload.attachments = emailAttachments
      }

      const resendResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(resendPayload),
      })

      const resendResult = await resendResp.json()
      if (!resendResp.ok) {
        console.error('[send-po-email] Resend error:', resendResult)
        return json({ error: 'Email send failed: ' + (resendResult.message || JSON.stringify(resendResult)) }, 502)
      }

      resendId = resendResult.id
      console.log(`[send-po-email] Sent email for PO ${poRef} to ${to_email}, resend_id=${resendId}`)
    } else {
      console.log(`[send-po-email] DRY RUN — would send to ${to_email} for PO ${poRef}`)
    }

    // Store in po_communications with threading metadata
    const messageId = resendId || null // Resend's message ID serves as our message_id
    const inReplyTo = body.in_reply_to || null
    // thread_id: inherit from parent if replying, otherwise start new thread with this message_id
    const threadId = inReplyTo ? (body.thread_id || inReplyTo) : messageId

    const { data: comm, error: commErr } = await sb
      .from('po_communications')
      .insert({
        po_id,
        job_id: job_id || null,
        direction: 'outbound',
        from_email: FROM_EMAIL,
        to_email,
        subject,
        body_text: body_text || null,
        body_html: fullHtml,
        attachments_json: pdf_url
          ? [{ filename: `${poRef || 'PO'}.pdf`, storage_url: pdf_url, content_type: 'application/pdf' }]
          : (attachments || []),
        sent_at: sentAt,
        message_id: messageId,
        in_reply_to: inReplyTo,
        thread_id: threadId,
        delivery_status: 'sent',
        cc_emails: cc.length > 0 ? cc : null,
      })
      .select('id')
      .single()

    if (commErr) {
      console.error('[send-po-email] Failed to store communication:', commErr)
    }

    // Store in email_events (unified email log — used by Resend webhooks for tracking)
    const { data: emailEvent, error: eeErr } = await sb
      .from('email_events')
      .insert({
        email_type: 'po',
        entity_type: 'purchase_order',
        entity_id: po_id,
        job_id: job_id || null,
        recipient: to_email,
        sender: FROM_EMAIL,
        subject,
        resend_message_id: resendId,
        status: dry_run ? 'queued' : 'sent',
        sent_at: dry_run ? null : sentAt,
        metadata: {
          po_number: poRef,
          supplier_name: po.supplier_name || null,
          communication_id: comm?.id || null,
          dry_run: !!dry_run,
        },
      })
      .select('id')
      .single()

    if (eeErr) {
      console.error('[send-po-email] Failed to store email_event:', eeErr)
    }

    // Log as job_event for timeline
    if (job_id) {
      await sb.from('job_events').insert({
        job_id,
        event_type: 'po_email_sent',
        detail_json: {
          po_id,
          po_number: poRef,
          to_email,
          subject,
          communication_id: comm?.id || null,
          email_event_id: emailEvent?.id || null,
          resend_id: resendId,
          dry_run: !!dry_run,
        },
      })
    }

    return json({
      success: true,
      communication_id: comm?.id || null,
      email_event_id: emailEvent?.id || null,
      resend_id: resendId,
      dry_run: !!dry_run,
    })

  } catch (err) {
    console.error('[send-po-email] ERROR:', err)
    return json({ error: (err as Error).message || 'Internal error' }, 500)
  }
})
