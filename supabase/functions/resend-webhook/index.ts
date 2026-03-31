// ════════════════════════════════════════════════════════════
// SecureWorks — Resend Webhook Edge Function
//
// Receives ALL Resend webhook events and updates the email_events table.
// Creates AI annotations on bounced emails and sends Telegram alerts
// on spam complaints.
//
// Deploy:
//   /Users/marninstobbe/.local/bin/supabase functions deploy resend-webhook --no-verify-jwt --project-ref kevgrhcjxspbxgovpmfl
//
// Secrets needed:
//   supabase secrets set RESEND_WEBHOOK_SECRET=whsec_...
//   (Also requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
//
// Resend webhook setup:
//   1. Go to Resend dashboard → Webhooks
//   2. Add endpoint: https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/resend-webhook
//   3. Select all event types
//   4. Copy signing secret → set as RESEND_WEBHOOK_SECRET
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Webhook } from 'https://esm.sh/svix@1.15.0'

// ── Environment ──
const RESEND_WEBHOOK_SECRET = Deno.env.get('RESEND_WEBHOOK_SECRET') || ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') || ''
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

// ── CORS (webhook endpoint — allow all origins) ──
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, svix-id, svix-timestamp, svix-signature',
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

// ── Webhook signature verification (Resend uses Svix) ──
function verifyWebhook(body: string, headers: Headers): unknown {
  const wh = new Webhook(RESEND_WEBHOOK_SECRET)
  const svixHeaders = {
    'svix-id': headers.get('svix-id') || '',
    'svix-timestamp': headers.get('svix-timestamp') || '',
    'svix-signature': headers.get('svix-signature') || '',
  }
  // Throws on invalid signature
  return wh.verify(body, svixHeaders)
}

// ── Telegram alert helper ──
async function sendTelegramAlert(message: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('Telegram not configured — skipping alert')
    return
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
      }),
    })
  } catch (err) {
    console.error('Telegram alert failed:', err)
  }
}

// ── Main handler ──
serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  // Read raw body for signature verification
  const rawBody = await req.text()

  // ── Verify webhook signature ──
  let payload: any
  try {
    payload = verifyWebhook(rawBody, req.headers)
  } catch (err) {
    console.error('Webhook signature verification failed:', err)
    return jsonResponse({ error: 'Invalid signature' }, 401)
  }

  const eventType: string = payload.type
  const eventData = payload.data
  const resendMessageId: string = eventData?.email_id

  if (!resendMessageId) {
    console.warn('Webhook event missing email_id:', eventType)
    return jsonResponse({ error: 'Missing email_id in payload' }, 400)
  }

  console.log(`Resend webhook: ${eventType} for message ${resendMessageId}`)

  // ── Init Supabase client ──
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // ── Look up the email_events row by resend_message_id ──
  const { data: emailEvent, error: lookupErr } = await sb
    .from('email_events')
    .select('id, job_id, recipient, subject, status, opened_count')
    .eq('resend_message_id', resendMessageId)
    .limit(1)
    .maybeSingle()

  if (lookupErr) {
    console.error('email_events lookup error:', lookupErr)
    return jsonResponse({ error: 'Database lookup failed' }, 500)
  }

  if (!emailEvent) {
    // Not necessarily an error — could be a test email or one not tracked
    console.warn(`No email_events row for resend_message_id: ${resendMessageId}`)
    return jsonResponse({ ok: true, skipped: true, reason: 'no matching email_events row' })
  }

  const now = new Date().toISOString()
  let updateFields: Record<string, unknown> = {}

  // ── Handle each event type ──
  switch (eventType) {
    case 'email.sent': {
      updateFields = {
        status: 'sent',
        sent_at: now,
      }
      break
    }

    case 'email.delivered': {
      updateFields = {
        status: 'delivered',
        delivered_at: now,
      }
      break
    }

    case 'email.opened': {
      const newCount = (emailEvent.opened_count || 0) + 1
      updateFields = {
        status: 'opened',
        opened_count: newCount,
        last_opened_at: now,
        // Set opened_at only on first open
        ...(newCount === 1 ? { opened_at: now } : {}),
      }
      break
    }

    case 'email.clicked': {
      // Record the click but keep status as 'opened'
      updateFields = {
        clicked_at: now,
      }
      break
    }

    case 'email.bounced': {
      const bounceReason = eventData?.bounce?.message
        || eventData?.reason
        || 'Unknown bounce reason'

      updateFields = {
        status: 'bounced',
        bounced_at: now,
        failure_reason: bounceReason,
      }

      // ── Create AI annotation on the linked job ──
      if (emailEvent.job_id) {
        const sourceRef = `resend:bounce:${resendMessageId}`
        const recipient = emailEvent.recipient || eventData?.to?.[0] || 'unknown'
        const subject = emailEvent.subject || eventData?.subject || '(no subject)'

        try {
          // Dedup: check if annotation already exists for this bounce
          const { data: existing } = await sb
            .from('ai_annotations')
            .select('id')
            .eq('source_ref', sourceRef)
            .eq('status', 'active')
            .limit(1)

          if (!existing || existing.length === 0) {
            await sb.from('ai_annotations').insert({
              org_id: DEFAULT_ORG_ID,
              entity_type: 'job',
              entity_id: emailEvent.job_id,
              ui_location: 'job_overview',
              annotation_type: 'email_bounced',
              category: 'communication',
              title: `Email bounced — ${recipient}`,
              body: `"${subject}" bounced: ${bounceReason}. Verify the email address and resend.`,
              structured_data: {
                resend_message_id: resendMessageId,
                recipient,
                subject,
                bounce_reason: bounceReason,
                bounced_at: now,
              },
              response_type: 'choice',
              response_options: [
                { value: 'update_email', label: 'Update Email', style: 'primary' },
                { value: 'dismiss', label: 'Dismiss', style: 'ghost' },
              ],
              priority: 70,
              severity: 'warning',
              source: 'resend-webhook',
              source_ref: sourceRef,
              confidence: 1.0,
            })
          }
        } catch (annErr) {
          console.error('Failed to create bounce annotation:', annErr)
          // Non-fatal — continue with the status update
        }
      }
      break
    }

    case 'email.complained': {
      updateFields = {
        status: 'complained',
      }

      // ── Send Telegram alert ──
      const recipient = emailEvent.recipient || eventData?.to?.[0] || 'unknown'
      const subject = emailEvent.subject || eventData?.subject || '(no subject)'

      await sendTelegramAlert(
        `⚠️ <b>SPAM COMPLAINT</b>\n\n` +
        `<b>Recipient:</b> ${recipient}\n` +
        `<b>Subject:</b> ${subject}\n\n` +
        `This recipient marked the email as spam. Review email practices and consider removing them from future sends.`
      )
      break
    }

    case 'email.delivery_delayed': {
      // Log only — don't update status (delivery may still succeed)
      console.log(`Delivery delayed for ${resendMessageId}: ${JSON.stringify(eventData)}`)
      return jsonResponse({ ok: true, event: eventType, action: 'logged_only' })
    }

    default: {
      console.log(`Unhandled Resend event type: ${eventType}`)
      return jsonResponse({ ok: true, event: eventType, action: 'ignored' })
    }
  }

  // ── Apply the update ──
  if (Object.keys(updateFields).length > 0) {
    const { error: updateErr } = await sb
      .from('email_events')
      .update(updateFields)
      .eq('id', emailEvent.id)

    if (updateErr) {
      console.error(`Failed to update email_events for ${eventType}:`, updateErr)
      return jsonResponse({ error: 'Failed to update email event' }, 500)
    }

    console.log(`Updated email_events ${emailEvent.id}: ${eventType} →`, updateFields)
  }

  return jsonResponse({ ok: true, event: eventType, email_event_id: emailEvent.id })
})
