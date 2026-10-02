// Slice T2: the transcript row (transcripts.md §2 "Transcript row", §3) on the
// recorded N1 call and transcript. Pure: no network, no database.
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildGhlCallTranscriptRow,
  buildGhlMessageRow,
  type CallRowFacts,
} from "./ghl_message.ts";
import {
  flattenTranscript,
  normaliseSentences,
} from "../ghl/call_transcript.ts";
import {
  N1,
  N2,
  ONECH,
} from "../../ghl-call-transcript-fetch/transcript_fixtures.ts";
import { N1_CALL_ITEM } from "./ghl_message_fixtures.ts";

/** The facts of the stored N1 call row, as the builder wrote it from the list read (slice T1). */
function n1Facts(): CallRowFacts {
  const built = buildGhlMessageRow(N1_CALL_ITEM, {
    source: "ghl-message-reconcile",
    captureMode: "live",
  });
  if (built.kind !== "row") throw new Error("N1 call row not built");
  const p = built.row.payload as Record<string, unknown>;
  return {
    ghlMessageId: N1.item.id,
    contactId: String(built.row.contact_id),
    eventAt: String(built.row.event_at),
    direction: String(built.row.direction),
    conversationKey: String(built.row.conversation_key),
    callSid: p.call_sid as string,
    durationSeconds: p.duration_seconds as number,
    line: p.line as string,
    fromLine: p.from_line as string,
    byUser: p.by_user as string,
  };
}

Deno.test("N1: transcript row keyed ghltx:<call id>, paired to its call by payload.ghl_call_id (review M8)", async () => {
  const t = await flattenTranscript(normaliseSentences(N1.sentences));
  const built = buildGhlCallTranscriptRow(n1Facts(), t, {
    captureMode: "live",
    agreement: "reached",
  });
  assert(built.kind === "row");
  const row = built.row;
  const p = row.payload as Record<string, unknown>;
  assertEquals(row.provider_message_id, "ghltx:6kn6WmrtfTMvhEJtmfeJ");
  assertEquals(row.event_type, "call.transcript_completed");
  assertEquals(row.source, "ghl-call-transcript");
  assertEquals(row.channel, "call");
  assertEquals(row.direction, "inbound");
  // The call's own time and contact, never ingestion time.
  assertEquals(row.event_at, "2026-09-23T07:40:55.171Z");
  assertEquals(row.contact_id, "Oxqi7eCx2rGCsS0BXOH2");
  assertEquals(row.thread_key, null);
  assertEquals(row.job_id, null);
  assertEquals(row.match_method, "none");
  assertEquals(p.ghl_call_id, "6kn6WmrtfTMvhEJtmfeJ");
  assertEquals(p.call_event_provider_id, "ghl:6kn6WmrtfTMvhEJtmfeJ");
  assertEquals(p.call_sid, "CAfcb0bf0b3d5308f16a6087ca116874a8");
  assertEquals(p.duration_seconds, 109);
  assertEquals(p.from_line, "774");
  assertEquals(p.line, "patio");
  assertEquals(p.by_user, "ERAycY7r6KZ8OA66WQCy");
  // Not the call's own key field: a reader pairing call to transcript by
  // ghl_message_id must never mistake the transcript for the call.
  assertFalse(Object.hasOwn(p, "ghl_message_id"));
  // Words stored once: payload.transcript, body_preview its first 500 characters.
  assertEquals(p.transcript, t.text);
  assertEquals(row.body_preview, t.text.slice(0, 500));
  for (const k of ["body", "text", "message", "message_text"]) {
    assertFalse(Object.hasOwn(p, k), k);
  }
  assertEquals(p.turns, t.turns);
  assertEquals(p.speaker_labels, true);
  assertEquals(p.speaker_channels, [1, 2]);
  assertEquals(p.speaker_roles, "not_given");
  assertEquals(p.sentence_count, 50);
  assertEquals(p.word_count, 250);
  assertEquals(p.low_signal, false);
  assertEquals(p.provider, "ghl");
  assertEquals(p.transcript_version, "ghl-v3");
  assertEquals(p.agreement, "reached");
  assertEquals(p.words, true);
  // safe_summary is capture's own account: no words.
  assertFalse(String(row.safe_summary).includes("Placeholder"));
  assertEquals(
    row.safe_summary,
    "[Call transcript, inbound. 50 sentences, 250 words. 2 speakers, roles not given.]",
  );
  assertEquals(row.privacy_classification, "staff_only");
  assertEquals(row.retention_class, "7y_audit");
  assertEquals(row.metadata, { capture_mode: "live" });
});

Deno.test("capture mode is the caller's (copied from the call row, or backfill for the history load)", async () => {
  const t = await flattenTranscript(normaliseSentences(N2.sentences));
  for (const mode of ["live", "backfill", "relink"] as const) {
    const built = buildGhlCallTranscriptRow(n1Facts(), t, {
      captureMode: mode,
    });
    assert(built.kind === "row");
    assertEquals(built.row.metadata, { capture_mode: mode });
  }
});

Deno.test("a one-channel transcript says the provider did not separate speakers", async () => {
  const t = await flattenTranscript(normaliseSentences(ONECH.sentences));
  const built = buildGhlCallTranscriptRow(
    { ...n1Facts(), direction: "outbound" },
    t,
    { captureMode: "live" },
  );
  assert(built.kind === "row");
  const p = built.row.payload as Record<string, unknown>;
  assertEquals(p.speaker_labels, false);
  assertEquals(p.speaker_roles, "not_given");
  assert(
    String(built.row.safe_summary).includes(
      "Speakers not separated by the provider.",
    ),
  );
});

Deno.test("no usable call id or contact: no row", async () => {
  const t = await flattenTranscript(normaliseSentences(N2.sentences));
  assertEquals(
    buildGhlCallTranscriptRow({ ...n1Facts(), ghlMessageId: "bad id" }, t, {
      captureMode: "live",
    }),
    { kind: "skip", reason: "no_id" },
  );
  assertEquals(
    buildGhlCallTranscriptRow({ ...n1Facts(), contactId: "" }, t, {
      captureMode: "live",
    }),
    { kind: "skip", reason: "no_contact" },
  );
});
