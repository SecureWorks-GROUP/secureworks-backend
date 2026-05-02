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
//   po_id         — UUID of purchase order (REQUIRED — primary anchor)
//   job_id        — UUID of job (optional, looked up from PO if omitted;
//                   if provided, MUST match purchase_orders.job_id)
//   supplier      — Supplier name (optional, drift-check; if provided
//                   MUST match purchase_orders.supplier_name)
//   to_email      — Supplier email address (optional; if provided MUST
//                   match suppliers.email for the resolved supplier;
//                   recommended pattern is to omit and let server resolve)
//   subject       — Email subject (auto-appends PO/job ref if missing)
//   body_html     — HTML email body
//   body_text     — Plain text fallback (optional)
//   attachments   — Array of { filename, storage_url, content_type } (optional)
//   attach_po_pdf — Boolean, attach PO PDF (implemented — requires pdf_url)
//   dry_run       — Boolean, skip actual send but store the record
//
// ── Recipient verification (FV Loop 3, 2026-05-02) ──
// Mirrors T2's _verifyAndSendInvoiceEmail pattern. Server-side verification
// happens BEFORE any external send. Rejection codes:
//
//   po_not_found                 po_id not in purchase_orders
//   supplier_email_unverifiable  PO has no supplier_name OR suppliers row
//                                has no email on file
//   supplier_name_mismatch       caller's `supplier` ≠ PO's supplier_name
//   job_po_mismatch              caller's job_id ≠ PO's job_id
//   recipient_lookup_failed      DB error during suppliers query
//   recipient_mismatch           caller's to_email ≠ resolved supplier email
//
// Caller-supplied to_email is REJECTED if it doesn't match the resolved
// supplier email. To bypass legitimately, omit to_email and let the server
// resolve it from the suppliers table.
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

// ════════════════════════════════════════════════════════════
// EXPORTED FOR TESTING — recipient verification + supplier resolution.
// Mirrors T2's _verifyAndSendInvoiceEmail pattern.
//
// Returns either:
//   { ok: true, verifiedJobId, supplierName, finalToEmail, poRow }
// or
//   { ok: false, response }   — Response object the caller should return.
//
// Caller still owns the side-effects (Resend send, po_communications insert,
// email_events insert, job_events insert). This helper ONLY enforces the
// verification gate before any of those run.
// ════════════════════════════════════════════════════════════

export type VerifyDeps = {
  client: any   // Supabase service-role client (with .from().select() etc.)
}

export type VerifyArgs = {
  po_id: string
  job_id?: string
  supplier?: string
  to_email?: string
}

export type VerifyResult =
  | { ok: true; verifiedJobId: string | null; supplierName: string; finalToEmail: string; poRow: any }
  | { ok: false; response: Response }

export async function _verifyPoEmailRecipient(
  deps: VerifyDeps,
  args: VerifyArgs,
): Promise<VerifyResult> {
  const { client } = deps
  const { po_id, job_id, supplier, to_email } = args

  // 1. PO must exist in purchase_orders
  const { data: po, error: poErr } = await client
    .from('purchase_orders')
    .select('id, po_number, job_id, supplier_name, reference')
    .eq('id', po_id)
    .maybeSingle()

  if (poErr || !po) {
    return { ok: false, response: json({
      error: 'PO not found',
      code: 'po_not_found',
      po_id,
      detail: poErr?.message || null,
    }, poErr ? 400 : 404) }
  }

  // 2. PO must have a supplier_name on file
  const supplierName = (po.supplier_name || '').toString().trim()
  if (!supplierName) {
    return { ok: false, response: json({
      error: 'PO has no supplier_name on file — cannot resolve recipient',
      code: 'supplier_email_unverifiable',
      po_id,
    }, 400) }
  }

  // 3. Caller-supplied supplier name must match (drift check)
  const callerSupplier = (supplier || '').toString().trim()
  if (callerSupplier && callerSupplier.toLowerCase() !== supplierName.toLowerCase()) {
    return { ok: false, response: json({
      error: 'Caller-supplied supplier name does not match PO',
      code: 'supplier_name_mismatch',
      po_id,
      received: callerSupplier,
      expected: supplierName,
    }, 400) }
  }

  // 4. Caller-supplied job_id must match PO's job_id (mirror T2 job_invoice_mismatch)
  if (job_id && po.job_id && job_id !== po.job_id) {
    return { ok: false, response: json({
      error: 'job_id does not belong to this PO',
      code: 'job_po_mismatch',
      po_id,
      received_job_id: job_id,
      expected_job_id: po.job_id,
    }, 400) }
  }
  const verifiedJobId: string | null = po.job_id || null

  // 5. Resolve supplier email server-side (caller cannot override; case-insensitive
  //    name match mirrors the existing updateSupplierEmail pattern in ops-api)
  const { data: supplierRow, error: suppErr } = await client
    .from('suppliers')
    .select('id, name, email')
    .ilike('name', supplierName)
    .maybeSingle()

  if (suppErr) {
    return { ok: false, response: json({
      error: 'Supplier lookup failed',
      code: 'recipient_lookup_failed',
      po_id,
      detail: suppErr.message,
    }, 400) }
  }

  if (!supplierRow || typeof supplierRow.email !== 'string' || !supplierRow.email.trim()) {
    return { ok: false, response: json({
      error: 'Supplier has no email on file',
      code: 'supplier_email_unverifiable',
      po_id,
      supplier_name: supplierName,
    }, 400) }
  }

  const resolvedEmail = supplierRow.email.trim()
  const resolvedNorm = resolvedEmail.toLowerCase()

  // 6. Caller-supplied to_email must match resolved supplier email (drift check).
  //    Recommended pattern is to omit to_email entirely; server uses the resolved
  //    canonical email in either case.
  const callerToEmail = (to_email || '').toString().trim()
  if (callerToEmail && callerToEmail.toLowerCase() !== resolvedNorm) {
    return { ok: false, response: json({
      error: 'Caller-supplied to_email does not match supplier on file',
      code: 'recipient_mismatch',
      po_id,
      received: callerToEmail,
      expected: resolvedEmail,
    }, 400) }
  }

  return { ok: true, verifiedJobId, supplierName, finalToEmail: resolvedEmail, poRow: po }
}

// Only start the HTTP server when this module is the entry point — lets the
// test file import `_verifyPoEmailRecipient` without spinning up the server
// (mirrors the ops-api `if (import.meta.main) serve(...)` pattern).
if (import.meta.main) serve(async (req: Request) => {
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

    if (!po_id) {
      return json({ error: 'po_id required', code: 'po_id_missing' }, 400)
    }
    if (!rawSubject || (!body_html && !body_text)) {
      return json({ error: 'subject and body_html (or body_text) required' }, 400)
    }

    // ── Server-side recipient verification (FV Loop 3) ──
    // Look up PO + supplier; verify caller-supplied supplier/job_id/to_email
    // match canonical sources before any external send.
    const verify = await _verifyPoEmailRecipient({ client: sb }, {
      po_id,
      job_id: job_id || undefined,
      supplier: body.supplier || undefined,
      to_email: to_email || undefined,
    })
    if (!verify.ok) return verify.response

    const po = verify.poRow
    // Inherit PO's job_id if caller omitted it
    if (!job_id) job_id = verify.verifiedJobId
    // Use the canonical supplier email; reject silently overrides any caller value
    // because verify() already enforced equality (or accepted absence).
    const verifiedToEmail = verify.finalToEmail

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
        to: [verifiedToEmail],
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
      console.log(`[send-po-email] Sent email for PO ${poRef} to ${verifiedToEmail}, resend_id=${resendId}`)
    } else {
      console.log(`[send-po-email] DRY RUN — would send to ${verifiedToEmail} for PO ${poRef}`)
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
        to_email: verifiedToEmail,
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
        recipient: verifiedToEmail,
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
          to_email: verifiedToEmail,
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
