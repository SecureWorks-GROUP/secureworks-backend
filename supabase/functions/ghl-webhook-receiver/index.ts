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
// T7 Loop 4 — atomic cutover to recordEvidence when evidence_capture_v1
// is ON. Wraps the single business_events insert below. Inbound SMS,
// inbound email, calls, and GHL notes all get the full envelope
// (channel/direction/source_table/source_id/match_status) when ON.
import { recordEvidence } from "../_shared/evidence/record_evidence.ts";
import { isFlagOn } from "../_shared/evidence/feature_flag.ts";
import type { Channel, Direction } from "../_shared/evidence/types.ts";

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

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
      "ContactCreate",
      "ContactUpdate",
    ];

    if (!SUPPORTED_TYPES.includes(type)) {
      console.log(`[ghl-webhook-receiver] Skipping unsupported event: ${type}`);
      return jsonResponse({ received: true, skipped: type });
    }

    // ════════════════════════════════════════════════════════════
    // GCLID + UTM attribution capture (ContactCreate / ContactUpdate)
    // Spec: secureworks-docs/playbooks/gclid-attribution-runbook.md
    // Upserts contact_matches with gclid + utm_* from the GHL form payload.
    // Tolerant of both customFields shapes (object or id-value array).
    // ════════════════════════════════════════════════════════════
    if (type === "ContactCreate" || type === "ContactUpdate") {
      try {
        const ATTRIBUTION_KEYS = ["gclid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
        const extracted: Record<string, string | null> = {};

        // Shape A: body.customFields is an object { gclid: "...", utm_source: "..." }
        const cfObj = (body as any).customFields;
        if (cfObj && typeof cfObj === "object" && !Array.isArray(cfObj)) {
          for (const k of ATTRIBUTION_KEYS) {
            if (cfObj[k]) extracted[k] = String(cfObj[k]).slice(0, 500);
          }
        }
        // Shape B: body.customField is an array [{ id, value }] with the field name elsewhere
        const cfArr = (body as any).customField || (body as any).customFieldArray;
        if (Array.isArray(cfArr)) {
          for (const item of cfArr) {
            const key = (item?.name || item?.fieldKey || item?.key || "").toLowerCase();
            if (ATTRIBUTION_KEYS.includes(key) && item?.value) {
              extracted[key] = String(item.value).slice(0, 500);
            }
          }
        }
        // Shape C: top-level on body (some GHL configs strip the customFields wrapper)
        for (const k of ATTRIBUTION_KEYS) {
          if (!extracted[k] && (body as any)[k]) extracted[k] = String((body as any)[k]).slice(0, 500);
        }

        if (Object.keys(extracted).length > 0 && contactId) {
          // Upsert contact_matches keyed on ghl_contact_id. Don't overwrite existing non-null attribution
          // values unless the incoming value is richer (presence over absence).
          const { data: existing } = await supabase
            .from("contact_matches")
            .select("id, gclid, utm_source, utm_medium, utm_campaign, utm_term, utm_content, lead_source")
            .eq("ghl_contact_id", contactId)
            .maybeSingle();

          const patch: Record<string, string | null> = {};
          for (const k of ATTRIBUTION_KEYS) {
            const cur = existing ? (existing as any)[k] : null;
            if (extracted[k] && (!cur || cur === "")) patch[k] = extracted[k];
          }
          // Derive lead_source from gclid presence; preserve existing non-placeholder value.
          const existingLs = existing?.lead_source;
          if (extracted.gclid && (!existingLs || existingLs === "unknown" || existingLs === "unattributed")) {
            patch.lead_source = "google_ads";
          }

          if (Object.keys(patch).length > 0) {
            if (existing) {
              await supabase.from("contact_matches").update(patch).eq("id", existing.id);
            } else {
              await supabase.from("contact_matches").insert({
                org_id: "00000000-0000-0000-0000-000000000001",
                ghl_contact_id: contactId,
                email: email || null,
                phone: phone || null,
                client_name: body.firstName && body.lastName ? `${body.firstName} ${body.lastName}` : (body.name || null),
                ...patch,
                matched_at: new Date().toISOString(),
              });
            }
            console.log(`[ghl-webhook-receiver] attribution upsert contactId=${contactId} keys=${Object.keys(patch).join(",")}`);
          }
        }
      } catch (attrErr) {
        // Never let attribution capture break the main webhook path
        console.error("[ghl-webhook-receiver] attribution capture failed (non-fatal):", attrErr);
      }

      // ContactCreate/ContactUpdate don't produce a business_event in the old branching below
      // unless you want one. Return early — attribution capture is the whole payload for now.
      return jsonResponse({ received: true, type, attribution_captured: true });
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

    // ── Create business_event (T7 atomic cutover) ──
    // Map the GHL webhook type onto the T7 channel + direction envelope.
    // Inbound: client.reply (SMS/email/chat). Outbound: client.sms_out / client.email_out.
    // Call: client.call_complete. Note: ghl.note_added. Stage: ghl.stage_changed.
    // Appointment: client.appointment.
    const t7Enabled = await isFlagOn(supabase, "evidence_capture_v1", DEFAULT_ORG_ID);
    let eventError: { message: string } | null = null;

    // Legacy spine row shape — emitted either by the T7 fallback path
    // OR when the flag is OFF. Defined once so both paths stay in lockstep.
    const legacySpineRow = {
      event_type: eventType,
      source: "ghl_webhook_receiver",
      entity_type: job ? "contact" : "unmatched_contact",
      entity_id: contactId || null,
      job_id: job?.id || null,
      occurred_at: new Date().toISOString(),
      payload: eventPayload,
    };

    let t7Failed = false;
    if (t7Enabled) {
      let channel: Channel = "system";
      let direction: Direction = "system";
      let conversationKey: string | null = (conversationId as string) || null;
      switch (type) {
        case "InboundMessage": {
          const ch = (eventPayload.channel as string) || "sms";
          channel = ch === "email" ? "email" : ch === "chat" ? "chat" : "sms";
          direction = "inbound";
          break;
        }
        case "OutboundMessage": {
          const ch = (eventPayload.channel as string) || "sms";
          channel = ch === "email" ? "email" : "sms";
          direction = "outbound";
          break;
        }
        case "CallCompleted":
          channel = "call";
          direction = (eventPayload.direction as string) === "outbound" ? "outbound" : "inbound";
          break;
        case "AppointmentCreated":
          channel = "status";
          direction = "internal";
          break;
        case "NoteAdded":
          channel = "note";
          direction = "internal";
          break;
        case "ContactStageChanged":
          channel = "status";
          direction = "internal";
          break;
      }
      try {
        await recordEvidence(supabase, {
          event_type: eventType,
          source: "ghl-webhook-receiver",
          channel,
          direction,
          occurred_at: new Date().toISOString(),
          // Source: GHL conversation cache when conversation_id present;
          // else the webhook event id when GHL supplies one; else a synthetic.
          source_table: "ghl_webhook",
          source_id: String(
            (body as { eventId?: string; id?: string }).eventId ??
            (body as { id?: string }).id ??
            conversationKey ??
            crypto.randomUUID(),
          ),
          job_id: job?.id || null,
          contact_id: contactId || null,
          entity_type: job ? "contact" : "unmatched_contact",
          entity_id: contactId || null,
          match_method: job?.id ? "contact_id" : "none",
          match_confidence: job?.id ? 0.85 : undefined,
          body_preview: typeof eventPayload.message_text === "string"
            ? (eventPayload.message_text as string).slice(0, 500)
            : typeof eventPayload.note_text === "string"
            ? (eventPayload.note_text as string).slice(0, 500)
            : undefined,
          thread_key: conversationKey,
          // Inbound client comms: 7y; system events: 12m.
          retention_class: (direction === "inbound" || direction === "outbound") ? "7y_audit" : "12m_default",
          privacy_classification: "staff_only",
          payload: eventPayload,
        }, {
          org_id: DEFAULT_ORG_ID,
          storage_client: supabase.storage,
        });
      } catch (e) {
        // T7 path failed (helper threw, validator rejected, transient
        // Postgres error, etc.). Mark for fallback so the canonical event
        // still lands via the legacy raw insert below. Without this, an
        // inbound reply / outbound SMS / call event could be dropped from
        // the spine on a T7 failure — exactly the regression the
        // stop-time review caught.
        console.error(
          "[ghl-webhook-receiver] T7 recordEvidence failed; falling back to legacy:",
          (e as Error).message,
        );
        t7Failed = true;
      }
    }

    if (!t7Enabled || t7Failed) {
      const { error } = await supabase.from("business_events").insert(legacySpineRow);
      eventError = error;
    }

    if (eventError) {
      console.error(`[ghl-webhook-receiver] business_event insert failed:`, eventError.message);
      return jsonResponse({ received: true, event_created: false, error: eventError.message }, 500);
    }

    // ── T7 Loop 7 — auto-invoke transcribe-call for CallCompleted events ──
    // Fire-and-forget. The transcribe-call function:
    //   - Re-checks evidence_transcript_capture flag (so OFF means no-op)
    //   - Downloads audio from recording_url
    //   - Calls OpenAI Whisper API
    //   - Writes transcript via recordEvidence (channel='call')
    //   - Enqueues to extraction_jobs → context_fact → JARVIS citation
    // We don't block the webhook response on this — Twilio recording URLs
    // expire within minutes so the worker must be quick anyway, but the
    // webhook returns immediately to keep GHL happy.
    if (type === "CallCompleted") {
      const recording_url = (eventPayload.recording_url as string) || null;
      if (recording_url) {
        const transcribePayload = {
          recording_url,
          job_id: job?.id || null,
          contact_id: contactId || null,
          call_direction: (eventPayload.direction as string) || "internal",
          occurred_at: new Date().toISOString(),
          duration_seconds: eventPayload.duration as number || null,
          phone: (eventPayload.phone as string) || null,
          ghl_call_id: (body as { eventId?: string; id?: string }).eventId
                        || (body as { id?: string }).id
                        || null,
        };
        // Fire-and-forget invoke. We use the supabase Functions client
        // so auth + URL are resolved automatically.
        supabase.functions.invoke("transcribe-call", { body: transcribePayload })
          .then((r) => {
            if (r.error) console.error("[ghl-webhook-receiver] transcribe-call invoke error:", r.error);
            else console.log("[ghl-webhook-receiver] transcribe-call invoked", r.data?.spine_event_id || "(no id)");
          })
          .catch((e: unknown) => console.error("[ghl-webhook-receiver] transcribe-call invoke threw:", (e as Error).message));
      }
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
