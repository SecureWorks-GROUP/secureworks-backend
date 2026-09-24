// Slice T2: the one reader of GHL's call transcript, on recorded shapes
// (supabase/functions/ghl-call-transcript-fetch/transcript_fixtures.ts).
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  flattenTranscript,
  normaliseSentences,
  readTranscriptSentences,
  transcriptSentenceValidationReason,
} from "./call_transcript.ts";
import {
  N1,
  N2,
  N4,
  NODUR,
  ONECH,
  sentencesFromRuns,
  VMG,
} from "../../ghl-call-transcript-fetch/transcript_fixtures.ts";

function flat(sentences: unknown) {
  const read = readTranscriptSentences(sentences);
  if (!read.ok) throw new Error(read.reason);
  return flattenTranscript(normaliseSentences(read.sentences));
}

Deno.test("the live v3 shape reads as given: numeric fields, speaker, words [] and no confidence", () => {
  for (const s of [...N1.sentences, ...N2.sentences, ...VMG.sentences]) {
    assertEquals(transcriptSentenceValidationReason(s), null);
    assertFalse(Object.hasOwn(s, "confidence"));
  }
  const read = readTranscriptSentences(N1.sentences);
  assert(read.ok);
  assertEquals(read.sentences.length, 50);
});

Deno.test("mediaChannel and speaker are optional; a supplied value must still be valid (review F4)", () => {
  const { mediaChannel: _c, speaker: _s, ...bare } = N2.sentences[0];
  assertEquals(transcriptSentenceValidationReason(bare), null);
  assertEquals(
    transcriptSentenceValidationReason({ ...bare, mediaChannel: 1.5 }),
    "invalid_integer:mediaChannel",
  );
  assertEquals(
    transcriptSentenceValidationReason({ ...bare, speaker: [1] }),
    "invalid_type:speaker",
  );
  assertEquals(
    transcriptSentenceValidationReason({ ...bare, sentenceIndex: undefined }),
    "invalid_numeric:sentenceIndex",
  );
  const refused = readTranscriptSentences([bare, { transcript: "" }]);
  assertFalse(refused.ok);
  if (!refused.ok) {
    assertEquals(refused.reason, "empty_transcript");
    assertFalse(JSON.stringify(refused.diagnostic).includes("Four"));
  }
});

Deno.test("null and [] are an empty list, never a refusal", () => {
  for (const body of [null, []]) {
    const read = readTranscriptSentences(body);
    assert(read.ok);
    if (read.ok) assertEquals(read.sentences.length, 0);
  }
});

Deno.test("N1: two channels give Speaker 1 / Speaker 2 turns, text stored once, turns point into it", async () => {
  const t = await flat(N1.sentences);
  assertEquals(t.sentenceCount, 50);
  assertEquals(t.speakerLabels, true);
  assertEquals(t.speakerChannels, [1, 2]);
  // 20 recorded runs of one channel = 20 turns.
  assertEquals(t.turns.length, 20);
  assert(t.text.startsWith("Speaker 1: Placeholder words for sentence 0."));
  for (const [channel, start, end, offset] of t.turns) {
    const label = `Speaker ${channel === 1 ? 1 : 2}: `;
    assertEquals(t.text.slice(offset, offset + label.length), label);
    assert(end >= start);
  }
  // Every sentence's words appear exactly once.
  assertEquals(t.text.split("Placeholder words for sentence").length - 1, 50);
  assertEquals(t.cut, false);
  assertEquals(t.lowSignal, false);
  assertEquals(t.wordCount, 250);
  assertEquals(t.turns[t.turns.length - 1][2], 102.495);
  // The digest is of the words in order: a second read of the same answer agrees.
  assertEquals((await flat(N1.sentences)).digest, t.digest);
  assertEquals(t.digest.length, 64);
});

Deno.test("N4 and NODUR: recorded channel orders give one turn per run", async () => {
  assertEquals((await flat(N4.sentences)).turns.length, 22);
  const nodur = await flat(NODUR.sentences);
  assertEquals(nodur.sentenceCount, 90);
  assertEquals(nodur.turns.length, 30);
});

Deno.test("ONECH: both voices on one channel, so no speaker labels and no prefix (review F4, N6)", async () => {
  const t = await flat(ONECH.sentences);
  assertEquals(t.speakerLabels, false);
  assertEquals(t.speakerChannels, []);
  assertEquals(t.turns.length, 1);
  assertFalse(t.text.includes("Speaker"));
  assertEquals(t.lowSignal, false);
});

Deno.test("sentences without any channel: one turn with a null channel, no labels", async () => {
  const noChannel = ONECH.sentences.map(({ mediaChannel: _c, ...s }) => s);
  const t = await flat(noChannel);
  assertEquals(t.speakerLabels, false);
  assertEquals(t.turns, [[null, 2.72, 14.719999, 0]]);
});

Deno.test("N2 (four words) and VMG (a voicemail greeting) are low signal (F13)", async () => {
  const n2 = await flat(N2.sentences);
  assertEquals(n2.wordCount, 4);
  assertEquals(n2.lowSignal, true);
  const vmg = await flat(VMG.sentences);
  assert(vmg.wordCount >= 8);
  assertEquals(vmg.lowSignal, true);
});

Deno.test("sentences are read in sentenceIndex order whatever order GHL lists them", async () => {
  const shuffled = [...N1.sentences].reverse();
  assertEquals((await flat(shuffled)).text, (await flat(N1.sentences)).text);
});

Deno.test("a transcript over 64 KB is cut at a sentence boundary with a stated marker (F11)", async () => {
  const long = sentencesFromRuns(
    [[1, 400], [2, 400]],
    0,
    9000,
    (i) => `Sentence ${i} ${"x".repeat(150)}.`,
  );
  const t = await flat(long);
  assertEquals(t.cut, true);
  assert(new TextEncoder().encode(t.text).length < 64 * 1024 + 200);
  assert(t.sentencesKept < 800);
  assert(
    t.text.endsWith(
      `[Transcript cut here by capture: longer than 64 KB. ${t.sentencesKept} of 800 sentences kept.]`,
    ),
  );
  // The words kept end on a whole sentence.
  const lastKept = t.text.split("\n").at(-2)!;
  assert(lastKept.endsWith("."));
  assertEquals(t.wordCount, 800 * 3);
});

Deno.test("one sentence alone over the limit stores only the truncation marker", async () => {
  const huge = sentencesFromRuns([[1, 1]], 0, 1, () => "y ".repeat(40000));
  const t = await flat(huge);
  assertEquals(t.cut, true);
  assertEquals(t.sentencesKept, 0);
  assertEquals(t.turns, []);
  assertEquals(
    t.text,
    "[Transcript cut here by capture: longer than 64 KB. 0 of 1 sentences kept.]",
  );
  assert(new TextEncoder().encode(t.text).length < 64 * 1024 + 200);
});
