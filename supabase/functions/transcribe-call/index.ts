// ════════════════════════════════════════════════════════════
// SecureWorks — transcribe-call (T7 Loop 7 / WhisperFlow path)
//
// Receives a call recording URL, downloads the audio, stores it in the
// evidence-audio bucket, calls OpenAI Whisper API for transcription,
// and writes the transcript to the spine via recordEvidence with
// channel='call'. Transcript then flows to extraction_jobs and JARVIS.
//
// Trigger paths:
//   1. ghl-webhook-receiver CallCompleted handler invokes us with the
//      recording_url it pulled from the GHL/Twilio payload.
//   2. Direct admin invoke (curl) for backfilling specific calls.
//
// Authorization:
//   - service_role only (verify_jwt: true)
//   - In addition: gated on `evidence_transcript_capture` feature flag.
//     When flag is OFF, returns { ok: false, reason: 'flag_off' } and
//     does nothing. Marnin flips the flag after the controlled proof
//     succeeds, then this becomes company-wide automatic capture.
//
// Provider: OpenAI Whisper API (whisper-1 model).
//   - Endpoint: POST https://api.openai.com/v1/audio/transcriptions
//   - ~$0.006/min audio
//   - Max 25MB per file (longer calls get a 'too_large' error; chunking
//     deferred to v2)
//   - Latency ~5s for 5min audio
//
// Input shape:
//   {
//     recording_url: string,         required (Twilio/GHL temp URL OR signed URL)
//     job_id?: string,               required for matching (else quarantined)
//     contact_id?: string,
//     call_direction?: 'inbound'|'outbound'|'internal',
//     occurred_at?: string,          ISO; defaults now
//     duration_seconds?: number,
//     phone?: string,
//     ghl_call_id?: string,          for source_id stability (else hash of url)
//   }
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { recordEvidence } from '../_shared/evidence/record_evidence.ts'
import { isFlagOn } from '../_shared/evidence/feature_flag.ts'
import type { Channel, Direction, MatchMethod } from '../_shared/evidence/types.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'
const WHISPER_MODEL = 'whisper-1'
const WHISPER_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions'
const MAX_AUDIO_BYTES = 25 * 1024 * 1024 // 25MB OpenAI limit

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

interface TranscribeCallInput {
  recording_url: string
  job_id?: string
  contact_id?: string
  call_direction?: 'inbound' | 'outbound' | 'internal'
  occurred_at?: string
  duration_seconds?: number
  phone?: string
  ghl_call_id?: string
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')

  if (!OPENAI_API_KEY) {
    console.error('[transcribe-call] OPENAI_API_KEY not set')
    return jsonResponse({ ok: false, reason: 'OPENAI_API_KEY missing' }, 500)
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // Feature-flag gate. This is the ONLY thing standing between "specific
  // call we just tested" and "every call the company makes". Flip
  // evidence_transcript_capture to true to enable company-wide capture.
  const flagOn = await isFlagOn(sb, 'evidence_transcript_capture', DEFAULT_ORG_ID)
  if (!flagOn) {
    return jsonResponse({ ok: false, reason: 'flag_off:evidence_transcript_capture', hint: 'set the flag to true in feature_flags table to enable' })
  }

  let input: TranscribeCallInput
  try {
    input = await req.json() as TranscribeCallInput
  } catch (e) {
    return jsonResponse({ ok: false, reason: `bad json: ${(e as Error).message}` }, 400)
  }

  if (!input.recording_url) {
    return jsonResponse({ ok: false, reason: 'recording_url required' }, 400)
  }

  const occurred_at = input.occurred_at || new Date().toISOString()
  const direction: Direction = (input.call_direction === 'inbound' || input.call_direction === 'outbound')
    ? input.call_direction
    : 'internal'

  // Stable source id: prefer ghl_call_id, else hash of recording_url
  const source_id = input.ghl_call_id || `whisper-${(await sha256Hex(input.recording_url)).slice(0, 24)}`

  // 1. Download audio from recording_url. Twilio URLs are temp-signed; this
  //    must run before the URL expires (typically minutes after CallCompleted).
  let audioBytes: Uint8Array
  let contentType = 'audio/mpeg'
  try {
    const resp = await fetch(input.recording_url)
    if (!resp.ok) {
      return jsonResponse({ ok: false, reason: `audio download failed: HTTP ${resp.status}` }, 502)
    }
    contentType = resp.headers.get('content-type') || contentType
    const buf = await resp.arrayBuffer()
    if (buf.byteLength > MAX_AUDIO_BYTES) {
      return jsonResponse({ ok: false, reason: `audio too large: ${buf.byteLength} bytes (max ${MAX_AUDIO_BYTES})` }, 413)
    }
    audioBytes = new Uint8Array(buf)
  } catch (e) {
    return jsonResponse({ ok: false, reason: `audio fetch threw: ${(e as Error).message}` }, 502)
  }

  // 2. Persist audio to evidence-audio bucket. Path:
  //    evidence-audio/<org>/call/<source_id>.<ext>
  // Whisper detects format from filename extension. Must be one of:
  //   flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm
  // Default to mp3 for unknown content-types — most call recording
  // services emit mp3, and Whisper is forgiving about misnamed mp3-ish bytes.
  const ext = contentType.includes('flac') ? 'flac'
            : contentType.includes('mp3') || contentType.includes('mpeg') ? 'mp3'
            : contentType.includes('wav') ? 'wav'
            : contentType.includes('mp4') || contentType.includes('m4a') ? 'm4a'
            : contentType.includes('ogg') || contentType.includes('oga') ? 'ogg'
            : contentType.includes('webm') ? 'webm'
            : 'mp3'
  const audioPath = `${DEFAULT_ORG_ID}/call/${source_id}.${ext}`
  try {
    const { error: upErr } = await sb.storage
      .from('evidence-audio')
      .upload(audioPath, audioBytes, { contentType, upsert: true })
    if (upErr) {
      console.warn('[transcribe-call] audio bucket upload failed (non-fatal):', upErr.message)
    }
  } catch (e) {
    console.warn('[transcribe-call] audio bucket upload threw (non-fatal):', (e as Error).message)
  }

  // 3. Call OpenAI Whisper API
  let transcript_text: string
  try {
    const form = new FormData()
    // Copy into a fresh ArrayBuffer so the Blob constructor's strict
    // typing accepts it (Uint8Array<ArrayBufferLike> can otherwise be
    // SharedArrayBuffer-backed which BlobPart rejects).
    const audioBlob = new Blob([new Uint8Array(audioBytes).buffer as ArrayBuffer], { type: contentType })
    form.append('file', audioBlob, `${source_id}.${ext}`)
    form.append('model', WHISPER_MODEL)
    form.append('response_format', 'json')
    const whisperResp = await fetch(WHISPER_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    })
    if (!whisperResp.ok) {
      const errBody = await whisperResp.text()
      return jsonResponse({ ok: false, reason: `whisper api error HTTP ${whisperResp.status}: ${errBody.slice(0, 500)}` }, 502)
    }
    const result = await whisperResp.json() as { text?: string }
    transcript_text = (result.text || '').trim()
    if (!transcript_text) {
      return jsonResponse({ ok: false, reason: 'whisper returned empty transcript' }, 502)
    }
  } catch (e) {
    return jsonResponse({ ok: false, reason: `whisper call threw: ${(e as Error).message}` }, 502)
  }

  // 4. Write transcript via recordEvidence. channel='call'. The local
  //    extractor_eligible_channels override lets it flow to extraction_jobs.
  const match_method: MatchMethod = input.job_id ? 'direct_job_id'
                                  : input.contact_id ? 'contact_id'
                                  : 'none'
  const channel: Channel = 'call'
  const safe_summary = transcript_text.slice(0, 280).replace(/\s+/g, ' ').trim()

  try {
    const result = await recordEvidence(sb, {
      event_type: 'call.transcript_completed',
      source: 'transcribe-call',
      channel,
      direction,
      occurred_at,
      // T5 extractor's loadSourceRow allowlist: business_events,
      // inbox_events, job_events, ghl_conversation_cache. The synthetic
      // 'transcribed_call' table doesn't exist; using business_events as
      // source means the extractor re-reads our own spine row's payload.
      // We can't know spine_event_id before recordEvidence runs, so we
      // suppress its built-in enqueue (enqueueExtraction:false) and do
      // the enqueue manually below, pointing source_id at the just-
      // returned spine_event_id.
      source_table: 'business_events',
      source_id,                                                    // placeholder; replaced post-insert
      enqueueExtraction: false,
      job_id: input.job_id || null,
      contact_id: input.contact_id || null,
      entity_type: input.job_id ? 'job' : 'contact',
      entity_id: input.job_id || input.contact_id || source_id,
      match_method,
      match_confidence: input.job_id ? 1.0 : (input.contact_id ? 0.85 : undefined),
      body_preview: transcript_text.slice(0, 500),
      body_full: transcript_text,
      body_filename: `${source_id}.txt`,
      body_mime: 'text/plain; charset=utf-8',
      safe_summary,
      privacy_classification: 'staff_only',
      retention_class: '7y_audit',
      payload: {
        // transcript_text lives in payload so the T5 extractor (which
        // reads business_events.payload via loadSourceRow) can pull it.
        transcript_text,
        recording_url_hash: (await sha256Hex(input.recording_url)).slice(0, 16),
        audio_pointer: `evidence-audio://${audioPath}`,
        audio_content_type: contentType,
        audio_bytes: audioBytes.byteLength,
        duration_seconds: input.duration_seconds || null,
        phone: input.phone || null,
        whisper_model: WHISPER_MODEL,
        char_count: transcript_text.length,
        ghl_call_id: input.ghl_call_id || null,
        whisperflow_synthetic_source_id: source_id,
      },
      metadata: {
        provider: 'openai-whisper',
        whisperflow_synthetic_source_id: source_id,
      },
    }, {
      org_id: DEFAULT_ORG_ID,
      bypass_feature_flag: true,                                    // we already gated on evidence_transcript_capture above
      storage_client: sb.storage,
    })
    // Manual extraction_jobs enqueue with source pointing at the spine
    // row that recordEvidence just inserted. Idempotent via the
    // (source_table, source_id, extractor_version) unique key.
    let extraction_job_id: string | null = null
    if (input.job_id) {
      const { data: enqueueData, error: enqueueErr } = await sb
        .from('extraction_jobs')
        .insert({
          job_id: input.job_id,
          source_table: 'business_events',
          source_id: result.spine_event_id,
          source_event_type: 'call.transcript_completed',
          extractor_version: 'context-fact-extractor:v1',
          priority: 5,
          status: 'pending',
          metadata: {
            spine_event_id: result.spine_event_id,
            channel: 'call',
            direction,
            transcript_chars: transcript_text.length,
            provider: 'openai-whisper',
          },
        })
        .select('id')
      if (enqueueErr) {
        console.warn('[transcribe-call] manual extraction enqueue failed (non-fatal):', enqueueErr.message)
      } else if (enqueueData && enqueueData.length > 0) {
        extraction_job_id = enqueueData[0].id
      }
    }
    return jsonResponse({
      ok: true,
      spine_event_id: result.spine_event_id,
      extraction_job_id,
      match_status: result.spine_row.match_status,
      audio_pointer: `evidence-audio://${audioPath}`,
      transcript_chars: transcript_text.length,
      transcript_preview: transcript_text.slice(0, 200),
      warnings: result.warnings,
    })
  } catch (e) {
    return jsonResponse({ ok: false, reason: `recordEvidence threw: ${(e as Error).message}` }, 500)
  }
})
