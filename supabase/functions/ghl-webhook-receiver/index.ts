// ════════════════════════════════════════════════════════════
// SecureWorks — GHL Webhook Receiver (All Event Types)
//
// Receives webhook payloads from GHL for client interactions:
// InboundMessage, OutboundMessage, CallCompleted,
// AppointmentCreated, NoteAdded, ContactStageChanged.
// Creates business_events for the event-listener to react to
// (Telegram notifications, nudge cancellation, job timeline).
//
// Deploy: supabase functions deploy ghl-webhook-receiver --no-verify-jwt
// GHL Setup: Settings > Integrations > Webhooks > all 6 event types
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
        source: "ghl_webhook",
        event_type: type || "unknown",
        payload: body,
        status: "received",
      })
      .then(() => {})
      .catch(() => {});

    // Supported event types
    const SUPPORTED_TYPES = [
      "InboundMessage",
      "OutboundMessage",
      "CallCompleted",
      "AppointmentCreated",
      "NoteAdded",
      "ContactStageChanged",
    ];

    if (!SUPPORTED_TYPES.includes(type)) {
      console.log(`[ghl-webhook-receiver] Skipping unsupported event: ${type}`);
      return jsonResponse({ received: true, skipped: type });
    }

    // ── Match to an active job via ghl_contact_id ──
    const { data: jobs } = await supabase
      .from("jobs")
      .select("id, job_number, client_name, type, status")
      .eq("ghl_contact_id", contactId)
      .not("status", "in", '("cancelled","complete")')
      .order("created_at", { ascending: false })
      .limit(1);

    const job = jobs?.[0];

    // ── Build event_type and payload per webhook type ──
    let eventType = "";
    let eventPayload: Record<string, unknown> = {};

    switch (type) {
      case "InboundMessage": {
        const channel = phone ? "sms" : email ? "email" : "chat";
        eventType = "client.reply";
        eventPayload = {
          message_text: (message || "").slice(0, 500),
          phone: phone || null,
          email: email || null,
          conversation_id: conversationId || null,
          channel,
          source: "ghl_webhook",
        };
        break;
      }

      case "OutboundMessage": {
        const channel = body.messageType === "Email" || body.channel === "email" ? "email" : "sms";
        eventType = channel === "email" ? "client.email_out" : "client.sms_out";
        eventPayload = {
          message_text: (body.body || body.message || "").slice(0, 500),
          phone: body.phone || null,
          email: body.email || null,
          conversation_id: conversationId || null,
          channel,
          sent_by: body.userId || "ghl",
          source: "ghl_webhook",
        };
        break;
      }

      case "CallCompleted": {
        eventType = "client.call_complete";
        eventPayload = {
          duration: body.duration || body.callDuration || null,
          direction: body.direction || body.callDirection || null,
          recording_url: body.recordingUrl || body.recording_url || null,
          phone: body.phone || body.callerNumber || null,
          source: "ghl_webhook",
        };
        break;
      }

      case "AppointmentCreated": {
        eventType = "client.appointment";
        eventPayload = {
          date: body.startTime || body.date || null,
          time: body.startTime || body.time || null,
          type: body.appointmentType || body.calendarName || null,
          title: body.title || body.name || null,
          source: "ghl_webhook",
        };
        break;
      }

      case "NoteAdded": {
        eventType = "ghl.note_added";
        eventPayload = {
          note_text: (body.body || body.note || "").slice(0, 500),
          added_by: body.userId || body.addedBy || "unknown",
          source: "ghl_webhook",
        };
        break;
      }

      case "ContactStageChanged": {
        eventType = "ghl.stage_changed";
        eventPayload = {
          old_stage: body.previousStage || body.oldStage || null,
          new_stage: body.currentStage || body.newStage || body.stage || null,
          pipeline: body.pipelineName || body.pipeline || null,
          source: "ghl_webhook",
        };
        break;
      }
    }

    // Attach job context to payload
    eventPayload.job_id = job?.id || null;
    eventPayload.job_number = job?.job_number || null;
    eventPayload.client_name = job?.client_name || null;
    eventPayload.job_type = job?.type || null;

    // ── Create business_event ──
    const { error: eventError } = await supabase.from("business_events").insert({
      event_type: eventType,
      source: "ghl_webhook_receiver",
      entity_type: job ? "contact" : "unmatched_contact",
      entity_id: contactId || null,
      job_id: job?.id || null,
      occurred_at: new Date().toISOString(),
      payload: eventPayload,
    });

    if (eventError) {
      console.error(`[ghl-webhook-receiver] business_event insert failed:`, eventError.message);
      return jsonResponse({ received: true, event_created: false, error: eventError.message }, 500);
    }

    // ── Auto-cancel pending nudges/chases on inbound reply ──
    let nudgesCancelled = false;
    if (type === "InboundMessage" && job?.id) {
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
      `[ghl-webhook-receiver] Processed: type=${type} event=${eventType} job_matched=${!!job} job=${job?.job_number || "none"}`
    );

    return jsonResponse({
      received: true,
      event_type: eventType,
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
