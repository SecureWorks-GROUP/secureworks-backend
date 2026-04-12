// ════════════════════════════════════════════════════════════
// SecureWorks — GHL Webhook Receiver (Inbound Messages)
//
// Receives webhook payloads from GHL when clients send SMS,
// email, or chat messages. Creates business_events for the
// event-listener to react to (Telegram notifications, nudge
// cancellation, etc.).
//
// Deploy: supabase functions deploy ghl-webhook-receiver --no-verify-jwt
// GHL Setup: Settings > Integrations > Webhooks > InboundMessage
// ════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Webhook-Secret",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json();
    const { type, contactId, message, phone, email, conversationId } = body;

    console.log(
      `[ghl-webhook-receiver] Received: type=${type || "unknown"} contactId=${contactId || "none"} keys=${Object.keys(body).join(",")}`
    );

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Log raw webhook for debugging (non-blocking)
    supabase
      .from("webhook_log")
      .insert({
        org_id: "00000000-0000-0000-0000-000000000001",
        source: "ghl_inbound",
        event_type: type || "unknown",
        payload: body,
        status: "received",
      })
      .then(() => {})
      .catch(() => {});

    // Only process inbound messages
    if (type !== "InboundMessage") {
      console.log(`[ghl-webhook-receiver] Skipping non-inbound event: ${type}`);
      return jsonResponse({ received: true, skipped: type });
    }

    // Match to an active job via ghl_contact_id
    const { data: jobs } = await supabase
      .from("jobs")
      .select("id, job_number, client_name, type, status")
      .eq("ghl_contact_id", contactId)
      .not("status", "in", '("cancelled","complete")')
      .order("created_at", { ascending: false })
      .limit(1);

    const job = jobs?.[0];

    // Determine channel
    const channel = phone ? "sms" : email ? "email" : "chat";

    // Create business_event for the event-listener to pick up
    const { error: eventError } = await supabase.from("business_events").insert({
      event_type: "client.reply",
      source: "ghl_webhook_receiver",
      entity_type: "contact",
      entity_id: contactId || null,
      job_id: job?.id || null,
      occurred_at: new Date().toISOString(),
      payload: {
        message_text: (message || "").slice(0, 500),
        phone: phone || null,
        email: email || null,
        conversation_id: conversationId || null,
        job_id: job?.id || null,
        job_number: job?.job_number || null,
        client_name: job?.client_name || null,
        job_type: job?.type || null,
        channel,
        source: "ghl_webhook",
      },
    });

    if (eventError) {
      console.error(`[ghl-webhook-receiver] business_event insert failed:`, eventError.message);
      return jsonResponse({ received: true, event_created: false, error: eventError.message }, 500);
    }

    // Auto-cancel pending nudges/chases for this job
    let nudgesCancelled = false;
    if (job?.id) {
      // Cancel pending smart_nudges
      await supabase
        .from("smart_nudges")
        .update({
          status: "cancelled_by_event",
          dismissed_at: new Date().toISOString(),
        })
        .eq("job_id", job.id)
        .eq("status", "pending");

      // Cancel pending ai_proposed_actions
      await supabase
        .from("ai_proposed_actions")
        .update({ status: "cancelled" })
        .eq("job_id", job.id)
        .eq("status", "pending");

      nudgesCancelled = true;
      console.log(`[ghl-webhook-receiver] Cancelled pending nudges/proposals for job ${job.job_number || job.id}`);
    }

    console.log(
      `[ghl-webhook-receiver] Processed: job_matched=${!!job} job=${job?.job_number || "none"} channel=${channel}`
    );

    return jsonResponse({
      received: true,
      event_created: true,
      job_matched: !!job,
      job_number: job?.job_number || null,
      nudges_cancelled: nudgesCancelled,
    });
  } catch (err) {
    console.error("[ghl-webhook-receiver] ERROR:", err);
    return jsonResponse({ error: (err as Error).message || "Internal error" }, 500);
  }
});
