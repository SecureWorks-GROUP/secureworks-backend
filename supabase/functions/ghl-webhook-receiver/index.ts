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
import { resolveMatch } from "../_shared/evidence/match.ts";
import type { Channel, Direction, MatchMethod } from "../_shared/evidence/types.ts";

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Webhook-Secret",
};

// SecureWorks Group telephony lines canon — see
// secureworks-docs/cio/operations/board/Evidence-Spine-JARVIS-Memory/
//   call-transcript-ingestion-activation/telephony-lines-canon.md
// Match body.to (inbound) or body.from (outbound) against E.164 OR local form.
const TELEPHONY_LINES: Array<{ e164: string; local: string; line_label: string; department: string }> = [
  { e164: "+61489267776", local: "0489267776", line_label: "admin",          department: "ops"           },
  { e164: "+61489267772", local: "0489267772", line_label: "fencing",        department: "sales-fencing" },
  { e164: "+61489267774", local: "0489267774", line_label: "patios",         department: "sales-patios"  },
  { e164: "+61489267778", local: "0489267778", line_label: "fencing-mgmt",   department: "mgmt-fencing"  },
  { e164: "+61489267771", local: "0489267771", line_label: "shaun-ops-mgr",  department: "ops-mgr"       },
];

function normalisePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  return digits.replace(/^0/, "61");
}

function attributeLine(toRaw: string | null | undefined, fromRaw: string | null | undefined, direction: string | null | undefined): { line_label: string; department: string; matched_field: "to" | "from" | null } {
  const toN = normalisePhone(toRaw);
  const fromN = normalisePhone(fromRaw);
  // Inbound: client → us, so match `to` against our lines.
  // Outbound: us → client, so match `from` against our lines.
  // Default to checking both for robustness.
  const candidates: Array<["to" | "from", string]> = direction === "outbound"
    ? [["from", fromN], ["to", toN]]
    : [["to", toN], ["from", fromN]];
  for (const [field, n] of candidates) {
    if (!n) continue;
    for (const line of TELEPHONY_LINES) {
      if (n === normalisePhone(line.e164) || n === normalisePhone(line.local)) {
        return { line_label: line.line_label, department: line.department, matched_field: field };
      }
    }
  }
  return { line_label: "unknown", department: "unknown", matched_field: null };
}

// GHL templating renders missing variables as the literal 4-char string "null".
// Treat string "null" / "" / "undefined" as null so downstream truthy checks behave.
function nullableString(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "" || s === "null" || s === "undefined") return null;
  return s;
}

function nullableBool(raw: unknown): boolean | null {
  if (raw == null) return null;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return null;
}

function nullableNumber(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function previewFromPayload(payload: Record<string, unknown>): string | null {
  const raw =
    payload.message_text ??
    payload.note_text ??
    payload.body_preview ??
    payload.message_preview ??
    payload.body ??
    payload.text ??
    payload.message ??
    null;
  if (raw == null) return null;
  const text = String(raw).trim();
  return text ? text.slice(0, 500) : null;
}

interface WebhookJobCandidate {
  id: string;
  job_number: string | null;
  client_name: string | null;
  type: string | null;
  status: string | null;
  site_suburb: string | null;
  created_at: string | null;
}

interface WebhookJobMatch {
  job: WebhookJobCandidate | null;
  match_method: MatchMethod;
  match_confidence: number | undefined;
  match_reason: string;
  candidate_count: number;
  candidates: Array<{
    id: string;
    job_number: string | null;
    type: string | null;
    status: string | null;
    site_suburb: string | null;
  }>;
}

function normaliseLoose(raw: string | null | undefined): string {
  return (raw || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function resolveWebhookJobMatch(
  jobs: WebhookJobCandidate[] | null | undefined,
  body: Record<string, unknown>,
): WebhookJobMatch {
  const candidates = (jobs || []).map((j) => ({
    id: j.id,
    job_number: j.job_number || null,
    type: j.type || null,
    status: j.status || null,
    site_suburb: j.site_suburb || null,
  }));
  const candidate_count = candidates.length;
  const directJobId = nullableString(body.supabase_job_id ?? body.job_id ?? body.jobId);
  const directJobNumber = nullableString(body.job_number ?? body.jobNumber ?? body.jobNo);

  if (directJobId) {
    const direct = (jobs || []).find((j) => j.id === directJobId);
    if (direct) {
      return {
        job: direct,
        match_method: "direct_job_id",
        match_confidence: 0.99,
        match_reason: "webhook carried direct Supabase job_id",
        candidate_count,
        candidates,
      };
    }
  }

  if (directJobNumber) {
    const direct = (jobs || []).filter((j) => normaliseLoose(j.job_number) === normaliseLoose(directJobNumber));
    if (direct.length === 1) {
      return {
        job: direct[0],
        match_method: "direct_reference",
        match_confidence: 0.95,
        match_reason: "webhook carried direct job_number",
        candidate_count,
        candidates,
      };
    }
  }

  if (!jobs || jobs.length === 0) {
    return {
      job: null,
      match_method: "none",
      match_confidence: undefined,
      match_reason: "no active Supabase job for GHL contact",
      candidate_count,
      candidates,
    };
  }

  if (jobs.length === 1) {
    return {
      job: jobs[0],
      match_method: "contact_id",
      match_confidence: 0.85,
      match_reason: "single active Supabase job for GHL contact",
      candidate_count,
      candidates,
    };
  }

  const contactName = nullableString(
    body.contactName ?? body.contact_name ?? body.name ??
      [body.firstName, body.lastName].filter(Boolean).join(" "),
  );
  if (contactName) {
    const nameMatches = jobs.filter((j) => {
      const lhs = normaliseLoose(j.client_name);
      const rhs = normaliseLoose(contactName);
      return lhs.length > 0 && rhs.length > 0 && (lhs === rhs || lhs.includes(rhs) || rhs.includes(lhs));
    });
    if (nameMatches.length === 1) {
      return {
        job: nameMatches[0],
        match_method: "contact_id",
        match_confidence: 0.78,
        match_reason: "multiple active jobs for contact; client name narrowed to one job",
        candidate_count,
        candidates,
      };
    }
  }

  return {
    job: null,
    match_method: "contact_id",
    match_confidence: 0.5,
    match_reason: "multiple active jobs for GHL contact; transcript/message must identify job before durable extraction",
    candidate_count,
    candidates,
  };
}

// Best-effort GHL recording lookup. Used when the workflow body did not carry a
// resolvable recordingUrl (typical: GHL's `{{phoneCall.recordingUrl}}` renders
// to literal "null" because Twilio hasn't finalised the recording at trigger
// time, or the operator bound a non-existent variable).
//
// Strategy: list the contact's conversations, pull the most recent call-type
// message, return its recording-bearing attachment URL. Returns null on any
// failure — never throws (this is fire-and-forget instrumentation, not a
// blocking dependency).
async function lookupGhlCallRecording(
  contactId: string | null,
  locationId: string | null,
  ghlToken: string,
  webhookOccurredAt: Date,
): Promise<{ recording_url: string | null; message_id: string | null; conversation_id: string | null; lookup_status: string }> {
  if (!contactId || !ghlToken) {
    return { recording_url: null, message_id: null, conversation_id: null, lookup_status: "skipped:missing_contact_or_token" };
  }
  const headers = {
    Authorization: `Bearer ${ghlToken}`,
    Version: "2021-04-15",
    Accept: "application/json",
  };
  try {
    // 1. Find the contact's most recent conversation. If locationId is
    // available we use the v2 search endpoint; otherwise fall back to the
    // contacts/{id}/conversations alias.
    let conversationId: string | null = null;
    if (locationId) {
      const searchUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}&limit=1&sort=desc&sortBy=last_message_date`;
      const resp = await fetch(searchUrl, { headers });
      if (resp.ok) {
        const j = await resp.json() as { conversations?: Array<{ id: string }> };
        conversationId = j.conversations?.[0]?.id || null;
      }
    }
    if (!conversationId) {
      return { recording_url: null, message_id: null, conversation_id: null, lookup_status: "no_conversation_found" };
    }
    // 2. List recent messages, find the most recent CALL-type message within
    // ±15 minutes of the webhook timestamp.
    const msgsUrl = `https://services.leadconnectorhq.com/conversations/${conversationId}/messages?limit=20&type=TYPE_CALL`;
    const msgsResp = await fetch(msgsUrl, { headers });
    if (!msgsResp.ok) {
      return { recording_url: null, message_id: null, conversation_id: conversationId, lookup_status: `messages_fetch_failed:${msgsResp.status}` };
    }
    const msgsJson = await msgsResp.json() as { messages?: { messages?: Array<{ id: string; type: string; messageType?: string; dateAdded?: string; meta?: Record<string, unknown>; attachments?: string[] | Array<{ url?: string }> }> } };
    const messages = msgsJson.messages?.messages || [];
    const window = 15 * 60 * 1000; // 15 minutes
    const candidates = messages.filter((m) => {
      const isCall = m.type === "TYPE_CALL" || m.messageType === "TYPE_CALL" || (typeof m.type === "string" && m.type.toUpperCase().includes("CALL"));
      if (!isCall) return false;
      if (!m.dateAdded) return true;
      const t = Date.parse(m.dateAdded);
      return !Number.isNaN(t) && Math.abs(t - webhookOccurredAt.getTime()) <= window;
    });
    if (candidates.length === 0) {
      return { recording_url: null, message_id: null, conversation_id: conversationId, lookup_status: "no_call_message_in_window" };
    }
    // Pick the most recent.
    candidates.sort((a, b) => (Date.parse(b.dateAdded || "") || 0) - (Date.parse(a.dateAdded || "") || 0));
    const msg = candidates[0];
    // 3. Recording URL extraction. GHL surfaces it via attachments[] (string URLs)
    // OR via meta.call.recording_url / meta.recordingUrl on newer payloads.
    let recording_url: string | null = null;
    if (Array.isArray(msg.attachments)) {
      for (const att of msg.attachments) {
        const url = typeof att === "string" ? att : (att?.url || null);
        if (url && /\.(mp3|wav|m4a|ogg|flac|webm)/i.test(url)) {
          recording_url = url;
          break;
        }
        if (url && !recording_url) recording_url = url; // best fallback
      }
    }
    const meta = msg.meta as Record<string, any> | undefined;
    if (!recording_url && meta) {
      recording_url = (meta.call?.recordingUrl as string) || (meta.call?.recording_url as string) || (meta.recordingUrl as string) || null;
    }
    if (!recording_url) {
      // 4. Last resort: derive the canonical recording fetch endpoint by
      // message id. This URL streams the audio binary when fetched with the
      // GHL bearer token. (Verified working via the ghl-call-data edge fn.)
      recording_url = `https://services.leadconnectorhq.com/conversations/messages/${msg.id}/locations/${locationId}/recording`;
    }
    return { recording_url, message_id: msg.id, conversation_id: conversationId, lookup_status: "ok" };
  } catch (e) {
    return { recording_url: null, message_id: null, conversation_id: null, lookup_status: `threw:${(e as Error).message.slice(0, 200)}` };
  }
}

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
    void (async () => {
      try {
        await supabase.from("webhook_log").insert({
          org_id: "00000000-0000-0000-0000-000000000001",
          source: "ghl_webhook",
          event_type: type || "unknown",
          payload: body,
          status: "received",
        });
      } catch {
        // Debug logging must not block webhook ingestion.
      }
    })();

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
    // Conservative by design: a phone/contact can own multiple active jobs.
    // In that case we keep the evidence on the contact and mark the job as
    // ambiguous unless the webhook carries a direct job reference or the
    // client name narrows it to exactly one job. This prevents call
    // transcripts from polluting the wrong permanent job memory.
    const { data: jobs } = await supabase
      .from("jobs")
      .select("id, job_number, client_name, type, status, site_suburb, created_at")
      .eq("ghl_contact_id", contactId)
      .not("status", "in", '("cancelled","complete")')
      .order("created_at", { ascending: false })
      .limit(10);

    const jobMatch = resolveWebhookJobMatch((jobs || []) as WebhookJobCandidate[], body as Record<string, unknown>);
    const job = jobMatch.job;

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
        // Normalise all GHL-templated fields. GHL renders missing variables as
        // the literal string "null"; treat that as null. F2 fix.
        const callTo        = nullableString(body.to);
        const callFrom      = nullableString(body.from);
        const callDirection = nullableString(body.direction || body.callDirection);
        const callStatusRaw = nullableString(body.callStatus || body.status);
        const callDuration  = nullableNumber(body.duration ?? body.callDuration);
        const callPhone     = nullableString(body.phone || body.callerNumber);
        const callRecordingUrl = nullableString(body.recordingUrl || body.recording_url);
        const callEventId   = nullableString(body.eventId || body.callId || body.messageId || body.id);
        const callVoicemail = nullableBool(body.voicemail);
        // Line attribution from canon (F3 enrichment).
        const attribution = attributeLine(callTo, callFrom, callDirection);
        eventPayload = {
          // Backwards-compatible primary fields:
          duration: callDuration,
          direction: callDirection,
          recording_url: callRecordingUrl,
          phone: callPhone,
          // F3 enrichment — full call envelope so JARVIS dossier sees everything:
          to: callTo,
          from: callFrom,
          call_status: callStatusRaw,
          voicemail: callVoicemail,
          line_label: attribution.line_label,
          department: attribution.department,
          line_matched_field: attribution.matched_field,
          event_id: callEventId,
          location_id: nullableString(body.locationId),
          workflow_id: nullableString(body.workflowId),
          contact_name: nullableString(body.contactName),
          contact_email: nullableString(body.contactEmail),
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
    eventPayload.match_reason = jobMatch.match_reason;
    eventPayload.match_candidate_count = jobMatch.candidate_count;
    eventPayload.match_candidates = jobMatch.candidates;

    // ── Create business_event (T7 atomic cutover) ──
    // Map the GHL webhook type onto the T7 channel + direction envelope.
    // Inbound: client.reply (SMS/email/chat). Outbound: client.sms_out / client.email_out.
    // Call: client.call_complete. Note: ghl.note_added. Stage: ghl.stage_changed.
    // Appointment: client.appointment.
    const t7Enabled = await isFlagOn(supabase, "evidence_capture_v1", DEFAULT_ORG_ID);
    let eventError: { message: string } | null = null;
    const occurredAt = new Date().toISOString();
    const sourceId = String(
      (body as { eventId?: string; id?: string }).eventId ??
      (body as { id?: string }).id ??
      conversationId ??
      crypto.randomUUID(),
    );
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
    const match = resolveMatch({
      job_id: job?.id || null,
      match_method: jobMatch.match_method,
      match_confidence: jobMatch.match_confidence,
    });
    const bodyPreview = previewFromPayload(eventPayload);

    // Legacy spine row shape — emitted either by the T7 fallback path
    // OR when the flag is OFF. It still carries the extractor-readable
    // envelope so fallback rows do not become unreadable evidence shells.
    const legacySpineRow = {
      event_type: eventType,
      source: "ghl_webhook_receiver",
      entity_type: job ? "contact" : "unmatched_contact",
      entity_id: contactId || null,
      job_id: match.job_id,
      occurred_at: occurredAt,
      source_table: "ghl_webhook",
      source_id: sourceId,
      channel,
      direction,
      contact_id: contactId || null,
      thread_key: conversationKey,
      conversation_key: conversationKey,
      body_preview: bodyPreview,
      safe_summary: bodyPreview ? bodyPreview.slice(0, 280) : null,
      match_status: match.match_status,
      match_method: match.match_method,
      match_confidence: match.match_confidence,
      privacy_classification: "staff_only",
      retention_class: (direction === "inbound" || direction === "outbound") ? "7y_audit" : "12m_default",
      payload: eventPayload,
      metadata: {
        t7_fallback_envelope: true,
        match_notes: match.notes,
      },
      schema_version: "1.0",
    };

    let t7Failed = false;
    if (t7Enabled) {
      try {
        await recordEvidence(supabase, {
          event_type: eventType,
          source: "ghl-webhook-receiver",
          channel,
          direction,
          occurred_at: occurredAt,
          // Source: GHL conversation cache when conversation_id present;
          // else the webhook event id when GHL supplies one; else a synthetic.
          source_table: "ghl_webhook",
          source_id: sourceId,
          job_id: job?.id || null,
          contact_id: contactId || null,
          entity_type: job ? "contact" : "unmatched_contact",
          entity_id: contactId || null,
          match_method: jobMatch.match_method,
          match_confidence: jobMatch.match_confidence,
          body_preview: bodyPreview || undefined,
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
    // We don't block the webhook response on this. Twilio/GHL recording URLs
    // can take 10-30s to finalise; we fork off, optionally do a short delayed
    // GHL lookup if the workflow body lacked a real recordingUrl, then invoke.
    if (type === "CallCompleted") {
      // Capture closure-stable copies before the async block.
      const initialRecordingUrl = nullableString(eventPayload.recording_url);
      const ghlEventId = nullableString(eventPayload.event_id);
      const _job_id = job?.id || null;
      const _contact_id = contactId || null;
      const _direction = nullableString(eventPayload.direction) || "internal";
      const _duration = (eventPayload.duration as number | null);
      const _phone = nullableString(eventPayload.phone);
      const _location_id = nullableString(eventPayload.location_id);
      const _ghlToken = Deno.env.get("GHL_API_TOKEN") || "";
      const _serviceJwt = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
      const _supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
      const webhookOccurredAt = new Date();
      // Source-id anchor — used by transcribe-call for spine dedupe.
      const callSourceId = ghlEventId || (_contact_id ? `${_contact_id}:${webhookOccurredAt.toISOString()}` : null);

      // Fire-and-forget chain. If recording_url was supplied + non-null, invoke
      // immediately. Otherwise wait 25s then look up via GHL conversations API.
      // Use EdgeRuntime.waitUntil so Supabase keeps the worker alive past the
      // HTTP response. Without this, the async IIFE is killed when the
      // response is sent (~1-2s) and the 25s sleep + lookup never run.
      const transcribeChain = (async () => {
        try {
          let recording_url = initialRecordingUrl;
          let lookup_status = recording_url ? "from_webhook_body" : "missing";
          let message_id: string | null = null;
          let conversation_id: string | null = null;
          if (!recording_url && _ghlToken && _contact_id) {
            // Wait briefly for Twilio to finalise the recording.
            await new Promise((r) => setTimeout(r, 25_000));
            const lookup = await lookupGhlCallRecording(_contact_id, _location_id, _ghlToken, webhookOccurredAt);
            recording_url = lookup.recording_url;
            message_id = lookup.message_id;
            conversation_id = lookup.conversation_id;
            lookup_status = lookup.lookup_status;
            console.log(`[ghl-webhook-receiver] ghl recording lookup contactId=${_contact_id} status=${lookup_status} found=${recording_url ? "yes" : "no"} message_id=${message_id || "n/a"}`);
          }
          if (!recording_url) {
            console.warn(`[ghl-webhook-receiver] CallCompleted with no recoverable recording_url; skipping transcribe-call. lookup_status=${lookup_status}`);
            return;
          }
          // Build transcribe-call payload.
          const transcribePayload: Record<string, unknown> = {
            recording_url,
            job_id: _job_id,
            contact_id: _contact_id,
            call_direction: _direction,
            occurred_at: webhookOccurredAt.toISOString(),
            duration_seconds: _duration,
            phone: _phone,
            ghl_call_id: callSourceId,
          };
          // GHL audio URLs require the bearer token; pass it through so
          // transcribe-call can fetch with it.
          if (recording_url.startsWith("https://services.leadconnectorhq.com/")) {
            transcribePayload.fetch_auth_bearer = _ghlToken;
          }
          // Direct fetch instead of supabase.functions.invoke() — explicitly
          // attach the service-role JWT so transcribe-call's verify_jwt:true
          // ingress accepts the call (F1 fix). The supabase-js Deno client did
          // not propagate auth on inter-function invokes (cf. 401 logs).
          const tcResp = await fetch(`${_supabaseUrl}/functions/v1/transcribe-call`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${_serviceJwt}`,
              "apikey": _serviceJwt,
            },
            body: JSON.stringify(transcribePayload),
          });
          const tcText = await tcResp.text();
          if (!tcResp.ok) {
            console.error(`[ghl-webhook-receiver] transcribe-call HTTP ${tcResp.status}: ${tcText.slice(0, 500)}`);
          } else {
            console.log(`[ghl-webhook-receiver] transcribe-call invoked ok: ${tcText.slice(0, 200)}`);
          }
        } catch (e) {
          console.error("[ghl-webhook-receiver] transcribe-call chain threw:", (e as Error).message);
        }
      })();
      // EdgeRuntime is a Supabase-injected global. waitUntil(promise) keeps the
      // worker alive until the promise settles, so the 25s sleep + GHL lookup
      // + transcribe-call invoke actually complete after we return 200 to GHL.
      try {
        // deno-lint-ignore no-explicit-any
        (globalThis as any).EdgeRuntime?.waitUntil?.(transcribeChain);
      } catch (_e) {
        // No-op if EdgeRuntime is not available (e.g. local Deno).
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
      `[ghl-webhook-receiver] Processed: type=${type} event=${eventType} job_matched=${!!job} job=${job?.job_number || "none"} match_reason=${jobMatch.match_reason}`
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
