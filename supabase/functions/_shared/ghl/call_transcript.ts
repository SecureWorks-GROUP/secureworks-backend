// The one reader of GHL's call transcript (context slice T2; transcripts.md §2
// step 3, §8 F4, F5, F11, F13).
//
// GHL answers GET /conversations/locations/{loc}/messages/{id}/transcription
// (API version v3) with one sentence object or a list of them. This module is
// the only place that decides whether that answer is a transcript: ghl-proxy's
// get_ghl_call_transcript read and the ghl-call-transcript-fetch edge function
// both use it, so the two can never disagree about what GHL said.
//
// Tolerant where the design says so: mediaChannel and speaker are optional (an
// older shape carries every voice on one channel, or none; F4). Everything
// else stays strict: a sentence needs its words, a whole-number index and
// non-negative, ordered times, and a supplied value must be well formed. An
// answer that is not a sentence or a list of sentences is refused, never
// guessed at (F5).
//
// Flattening: the words are stored once (review S13). `text` is the sentences
// in index order; when two or more channels are present each turn (a run of
// sentences on one channel) starts "Speaker N: ", N numbered by first
// appearance. `turns` are compact [channel, start, end, char_offset] rows that
// point into that text, never a second copy of the words. Channels are never
// mapped to roles (decision D-T2): which speaker is the customer is not known.
//
// Pure: no I/O, no clock.

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

// Diagnostic-only allowlist: no provider scalar values or arbitrary keys escape.
export function transcriptShape(value: unknown): JsonObject {
  let budget = 24;
  const keys = [
    "data",
    "result",
    "results",
    "transcription",
    "transcriptions",
    "transcript",
    "sentences",
    "mediaChannel",
    "speaker",
    "sentenceIndex",
    "startTime",
    "endTime",
    "confidence",
  ];
  function shape(input: unknown, depth: number): JsonObject {
    if (--budget < 0) return { type: "omitted", bounded: true };
    const type = input === null
      ? "null"
      : Array.isArray(input)
      ? "array"
      : typeof input;
    if (type !== "object" && type !== "array") return { type };
    if (depth >= 4) return { type, bounded: true };
    if (Array.isArray(input)) {
      return {
        type,
        length: Math.min(input.length, 10000),
        ...(input.length > 10000 ? { length_capped: true } : {}),
        items: input.slice(0, 2).map((item) => shape(item, depth + 1)),
      };
    }
    const obj = object(input);
    const fields: JsonObject = {};
    for (const key of keys) {
      if (Object.hasOwn(obj, key)) fields[key] = shape(obj[key], depth + 1);
    }
    return { type, fields };
  }
  return shape(value, 0);
}

function numeric(value: unknown): boolean {
  return (typeof value === "number" ||
    (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))) &&
    Number.isFinite(Number(value)) && Number(value) >= 0;
}

/** Why one provider sentence is not a transcript sentence, or null when it is. */
export function transcriptSentenceValidationReason(
  value: unknown,
): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "sentence_not_object";
  }
  const sentence = object(value);
  if (!Object.hasOwn(sentence, "transcript")) return "missing_field:transcript";
  if (typeof sentence.transcript !== "string") return "invalid_type:transcript";
  if (!sentence.transcript.trim()) return "empty_transcript";
  for (
    const key of [
      "mediaChannel",
      "sentenceIndex",
      "startTime",
      "endTime",
      "confidence",
    ]
  ) {
    // mediaChannel (older shapes) and confidence (live v3) may be absent.
    // Absence is kept as absence; a supplied value must still be valid.
    if (
      (key === "confidence" || key === "mediaChannel") &&
      !Object.hasOwn(sentence, key)
    ) continue;
    if (!Object.hasOwn(sentence, key)) return `missing_field:${key}`;
    if (!numeric(sentence[key])) return `invalid_numeric:${key}`;
  }
  if (Number(sentence.endTime) < Number(sentence.startTime)) {
    return "reversed_timing";
  }
  if (
    Object.hasOwn(sentence, "mediaChannel") &&
    !Number.isInteger(Number(sentence.mediaChannel))
  ) {
    return "invalid_integer:mediaChannel";
  }
  if (!Number.isInteger(Number(sentence.sentenceIndex))) {
    return "invalid_integer:sentenceIndex";
  }
  if (
    Object.hasOwn(sentence, "confidence") && Number(sentence.confidence) > 1
  ) {
    return "invalid_range:confidence";
  }
  if (
    Object.hasOwn(sentence, "speaker") && sentence.speaker !== null &&
    typeof sentence.speaker !== "string" && typeof sentence.speaker !== "number"
  ) {
    return "invalid_type:speaker";
  }
  return null;
}

export type TranscriptRead =
  | { ok: true; sentences: JsonObject[] }
  | { ok: false; reason: string; diagnostic: JsonObject };

/**
 * GHL's transcription answer as its sentence list. null and [] are an empty
 * list (no transcript yet, or none). Any sentence that fails validation refuses
 * the whole answer, with a words-free diagnostic.
 */
export function readTranscriptSentences(raw: unknown): TranscriptRead {
  const sentences = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  for (const value of sentences) {
    const reason = transcriptSentenceValidationReason(value);
    if (reason) {
      return {
        ok: false,
        reason,
        diagnostic: {
          reason,
          shape: transcriptShape(raw),
          invalid_sentence: transcriptShape(value),
        },
      };
    }
  }
  return { ok: true, sentences: sentences as JsonObject[] };
}

/** One validated sentence, numbers read. */
export interface TranscriptSentence {
  text: string;
  channel: number | null;
  index: number;
  start: number;
  end: number;
}

/** A turn: [channel, start seconds, end seconds, char offset of the turn in text]. */
export type TranscriptTurn = [number | null, number, number, number];

export interface FlatTranscript {
  text: string;
  turns: TranscriptTurn[];
  /** true when two or more channels are present, so turns carry "Speaker N:". */
  speakerLabels: boolean;
  /** speakerChannels[n - 1] is the channel shown as "Speaker n". */
  speakerChannels: number[];
  sentenceCount: number;
  /** Sentences kept in text (fewer than sentenceCount only when cut). */
  sentencesKept: number;
  wordCount: number;
  cut: boolean;
  /** sha-256 hex of the sentence words in order: two reads agree when equal. */
  digest: string;
  lowSignal: boolean;
}

/** Stored text above this many UTF-8 bytes is cut at a sentence boundary (F11). */
export const TRANSCRIPT_MAX_BYTES = 64 * 1024;
/** Under this many words a transcript is low signal (F13). */
export const LOW_SIGNAL_MIN_WORDS = 8;
/** A voicemail greeting is only low signal when it is this short. */
const GREETING_MAX_WORDS = 60;
const GREETING =
  /\b(leave (me |us )?(a|your) (message|name)|after the (tone|beep)|not available|unavailable to take your call|can'?t (take|come to) (your|the) (call|phone)|voice ?mail|mailbox|record your message)\b/i;

/** Validated sentences, in index order (then start time), numbers read. */
export function normaliseSentences(
  sentences: readonly object[],
): TranscriptSentence[] {
  return (sentences as readonly JsonObject[])
    .map((s) => ({
      text: String(s.transcript).trim().replace(/\s+/g, " "),
      channel: Object.hasOwn(s, "mediaChannel") ? Number(s.mediaChannel) : null,
      index: Number(s.sentenceIndex),
      start: Number(s.startTime),
      end: Number(s.endTime),
    }))
    .sort((a, b) => a.index - b.index || a.start - b.start);
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(text)),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The stored form of one transcript: text once, turns pointing into it. */
export async function flattenTranscript(
  sentences: TranscriptSentence[],
  maxBytes = TRANSCRIPT_MAX_BYTES,
): Promise<FlatTranscript> {
  const channels: number[] = [];
  for (const s of sentences) {
    if (s.channel !== null && !channels.includes(s.channel)) {
      channels.push(s.channel);
    }
  }
  const speakerLabels = channels.length >= 2;
  const turns: TranscriptTurn[] = [];
  let text = "";
  let kept = 0;
  let cut = false;
  let current: TranscriptTurn | null = null;
  for (const s of sentences) {
    const newTurn = current === null || current[0] !== s.channel;
    const prefix = newTurn
      ? `${text ? "\n" : ""}${
        speakerLabels && s.channel !== null
          ? `Speaker ${channels.indexOf(s.channel) + 1}: `
          : ""
      }`
      : " ";
    const piece = prefix + s.text;
    if (encoder.encode(text + piece).length > maxBytes) {
      cut = true;
      break;
    }
    if (newTurn) {
      current = [s.channel, s.start, s.end, text.length + (text ? 1 : 0)];
      turns.push(current);
    } else if (current) {
      current[2] = Math.max(current[2], s.end);
    }
    text += piece;
    kept++;
  }
  if (cut) {
    text += `${text ? "\n" : ""}[Transcript cut here by capture: longer than ${
      Math.round(maxBytes / 1024)
    } KB. ${kept} of ${sentences.length} sentences kept.]`;
  }
  const allWords = sentences.map((s) => s.text).join(" ");
  const wordCount = words(allWords);
  const lowSignal = wordCount < LOW_SIGNAL_MIN_WORDS ||
    (wordCount <= GREETING_MAX_WORDS && GREETING.test(allWords));
  return {
    text,
    turns,
    speakerLabels,
    speakerChannels: speakerLabels ? channels : [],
    sentenceCount: sentences.length,
    sentencesKept: kept,
    wordCount,
    cut,
    digest: await sha256Hex(sentences.map((s) => s.text).join("\n")),
    lowSignal,
  };
}
