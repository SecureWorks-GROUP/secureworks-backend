// Recorded fixtures for slice T2 (transcripts.md §10 named rows and the
// replacement rows named in the T2 PR). Read only on 24 Sep 2026 05:01 to
// 05:07Z through the read-only SecureSuite tools sw_list_ghl_messages and
// sw_get_ghl_call_transcript (the ghl-proxy read, which calls the same two GHL
// endpoints the fetcher calls).
//
// Recorded exactly: message ids, contact and conversation ids, times, the
// provider's direction, status and duration (including their absence), the
// sentence count, the order of channels across sentences, the first start and
// last end time, and the sentence keys GHL sends (speaker, mediaChannel,
// sentenceIndex, transcript, startTime, endTime, words; no confidence on any
// sentence). Not recorded: the words. Every sentence's words are placeholders
// written for the fixture, and the times between the first and last are
// spread evenly. The customer's number is replaced by +61400000000.
//
// `item` is the single-item read (GET /conversations/messages/{id}), the one
// the fetcher re-reads: for an inbound call it names our side "SecureWorks WA",
// not the number. The conversation list read (what the webhook doorbell, the
// reconciler and the history load build call rows from) carries the number.

export const LOCATION_ID = "13yKADzN94BRxX4hByYX";

/** One GHL transcript sentence, in the live v3 shape. */
export interface V3Sentence {
  speaker: number;
  mediaChannel: number;
  sentenceIndex: number;
  transcript: string;
  startTime: number;
  endTime: number;
  words: unknown[];
}

/**
 * Sentences from a recorded channel order: runs of [channel, count], the
 * recorded first start and last end, and placeholder words.
 */
export function sentencesFromRuns(
  runs: [number, number][],
  firstStart: number,
  lastEnd: number,
  words: (index: number) => string = (i) =>
    `Placeholder words for sentence ${i}.`,
): V3Sentence[] {
  const channels = runs.flatMap(([ch, n]) => Array(n).fill(ch) as number[]);
  const step = (lastEnd - firstStart) / channels.length;
  return channels.map((ch, i) => ({
    speaker: ch - 1,
    mediaChannel: ch,
    sentenceIndex: i,
    transcript: words(i),
    startTime: Number((firstStart + i * step).toFixed(3)),
    endTime: i === channels.length - 1
      ? lastEnd
      : Number((firstStart + (i + 1) * step).toFixed(3)),
    words: [],
  }));
}

/** GHL's GET /conversations/messages/{id} answer shape: the item nests under message. */
export function messageAnswer(item: Record<string, unknown>) {
  return { message: item, traceId: "fixture-trace" };
}

// ── SWP-26941 (a live patio job): the R9 contact's only conversation ──
export const SWP_26941 = {
  contactId: "Oxqi7eCx2rGCsS0BXOH2",
  conversationId: "3GOBTMJT1qEXkGwcodQK",
};
const NITHIN_USER = "ERAycY7r6KZ8OA66WQCy";

/** N1: 23 Sep 07:40Z, inbound to 774, answered, 109 s. 50 sentences, two channels. */
export const N1 = {
  item: {
    id: "6kn6WmrtfTMvhEJtmfeJ",
    altId: "CAfcb0bf0b3d5308f16a6087ca116874a8",
    contactId: SWP_26941.contactId,
    conversationId: SWP_26941.conversationId,
    dateAdded: "2026-09-23T07:40:55.171Z",
    dateUpdated: "2026-09-23T07:43:05.924Z",
    direction: "inbound",
    from: "+61400000000",
    locationId: LOCATION_ID,
    messageType: "TYPE_CALL",
    meta: { call: { duration: 109, status: "completed" } },
    status: "completed",
    to: "SecureWorks WA",
    type: 1,
    userId: NITHIN_USER,
  },
  sentences: sentencesFromRuns(
    [
      [1, 3],
      [2, 2],
      [1, 1],
      [2, 2],
      [1, 5],
      [2, 2],
      [1, 3],
      [2, 2],
      [1, 2],
      [
        2,
        1,
      ],
      [1, 3],
      [2, 2],
      [1, 3],
      [2, 2],
      [1, 3],
      [2, 3],
      [1, 1],
      [2, 3],
      [1, 3],
      [
        2,
        4,
      ],
    ],
    1.92,
    102.495,
  ),
};

/** N2: 22 Sep 22:59Z, inbound voicemail to 774, no duration from GHL. 1 sentence of 4 words. */
export const N2 = {
  item: {
    id: "Py9PovOwc4I4vNkn9jXg",
    altId: "CA328d9bf74781d1cb8a8166ae38939924",
    contactId: SWP_26941.contactId,
    conversationId: SWP_26941.conversationId,
    dateAdded: "2026-09-22T22:59:20.907Z",
    dateUpdated: "2026-09-22T23:00:01.982Z",
    direction: "inbound",
    from: "+61400000000",
    locationId: LOCATION_ID,
    messageType: "TYPE_CALL",
    meta: { call: { status: "voicemail" } },
    status: "voicemail",
    to: "SecureWorks WA",
    type: 1,
    userId: NITHIN_USER,
  },
  sentences: sentencesFromRuns(
    [[1, 1]],
    1.4399999,
    2.3999999,
    () => "Four placeholder words here.",
  ),
};

/**
 * VMG (replacement for N5, a voicemail greeting): 16 Jul 05:51Z, inbound,
 * GHL says completed, 21 s, but the recording is a mobile voicemail greeting.
 * 10 sentences on both channels. The greeting words are a generic greeting
 * written for the fixture.
 */
export const VMG = {
  item: {
    id: "ps9i5b2x4f8WqRjEe1Bs",
    altId: "CAd62f52d7676b30b18dec7c8a87b118fb",
    contactId: SWP_26941.contactId,
    conversationId: SWP_26941.conversationId,
    dateAdded: "2026-07-16T05:51:23.072Z",
    dateUpdated: "2026-07-16T05:51:52.709Z",
    direction: "inbound",
    from: "+61400000000",
    locationId: LOCATION_ID,
    messageType: "TYPE_CALL",
    meta: { call: { duration: 21, status: "completed" } },
    status: "completed",
    to: "SecureWorks WA",
    type: 1,
    userId: NITHIN_USER,
  },
  sentences: sentencesFromRuns(
    [[1, 5], [2, 3], [1, 1], [2, 1]],
    3.12,
    20.594936,
    (i) =>
      [
        "Hi.",
        "This is a phone.",
        "I cannot take your call right now.",
        "Please leave your name and number and I will call you back.",
        "Thanks.",
        "The person you called is unavailable.",
        "Please leave a message after the tone.",
        "When you have finished recording you may hang up.",
        "one",
        "for more options.",
      ][i],
  ),
};

/**
 * ONECH (replacement for N6, both voices on one channel): 16 Jul 06:40Z,
 * outbound from 774, completed, 22 s. 7 sentences, every one on channel 1.
 */
export const ONECH = {
  item: {
    id: "ZKxEtfBzwb5qZx3o6p3v",
    altId: "CA7f54dca746cedd9e469acf1529c867a3",
    contactId: SWP_26941.contactId,
    conversationId: SWP_26941.conversationId,
    dateAdded: "2026-07-16T06:40:22.892Z",
    dateUpdated: "2026-07-16T06:40:59.252Z",
    direction: "outbound",
    from: "+61489267774",
    locationId: LOCATION_ID,
    messageType: "TYPE_CALL",
    meta: { call: { duration: 22, status: "completed" } },
    source: "app",
    status: "completed",
    to: "+61400000000",
    type: 1,
    userId: NITHIN_USER,
  },
  sentences: sentencesFromRuns([[1, 7]], 2.72, 14.719999),
};

/** NOANS: 7 Jul 01:34Z, inbound, GHL status no-answer, no duration. Its transcription answer is HTTP 400. */
export const NOANS = {
  item: {
    id: "meYkjPC1Se4b7vCLZGaZ",
    contactId: SWP_26941.contactId,
    conversationId: SWP_26941.conversationId,
    dateAdded: "2026-07-07T01:34:05.766Z",
    direction: "inbound",
    from: "+61400000000",
    locationId: LOCATION_ID,
    messageType: "TYPE_CALL",
    meta: { call: { duration: null, status: "no-answer" } },
    status: "no-answer",
    to: "+61489267774",
    type: 1,
  },
  transcriptionStatus: 400,
};

// ── The N4 contact (a fencing lead that became a quoted job) ──
export const N4_CONTACT = {
  contactId: "lYPee0K2DuQHXH2xHL1P",
  conversationId: "I98nlO8dKPOAaylh7k23",
};
const KHAIRO_USER = "RgDWTnYL6zL3eJA6nLht";

/** N4: 16 Sep 07:22Z, inbound to 772, 127 s, placed inside a lead window. 77 sentences, two channels. */
export const N4 = {
  item: {
    id: "Ag9DKkqpfsadWkJS8jst",
    altId: "CA67bdf6e5852b97942031424077cf8159",
    contactId: N4_CONTACT.contactId,
    conversationId: N4_CONTACT.conversationId,
    dateAdded: "2026-09-16T07:22:28.713Z",
    dateUpdated: "2026-09-16T07:24:48.526Z",
    direction: "inbound",
    from: "+61400000000",
    locationId: LOCATION_ID,
    messageType: "TYPE_CALL",
    meta: { call: { duration: 127, status: "completed" } },
    status: "completed",
    to: "SecureWorks WA",
    type: 1,
    userId: KHAIRO_USER,
  },
  sentences: sentencesFromRuns(
    [
      [1, 4],
      [2, 3],
      [1, 2],
      [2, 8],
      [1, 3],
      [2, 3],
      [1, 2],
      [2, 2],
      [1, 1],
      [
        2,
        9,
      ],
      [1, 2],
      [2, 4],
      [1, 2],
      [2, 5],
      [1, 3],
      [2, 3],
      [1, 3],
      [2, 5],
      [1, 2],
      [
        2,
        5,
      ],
      [1, 1],
      [2, 5],
    ],
    2,
    127.409996,
  ),
};

/**
 * NODUR: 21 Sep 07:09Z, outbound from 772, GHL says completed with NO
 * duration (meta.call carries status only, on the list read and the item
 * read), yet 90 sentences on both channels.
 */
export const NODUR = {
  item: {
    id: "MeVPH47LXDbgcvPUAkjY",
    altId: "CA6b5ffb5f1e5e6b65f5fe94fd38e26040",
    contactId: N4_CONTACT.contactId,
    conversationId: N4_CONTACT.conversationId,
    dateAdded: "2026-09-21T07:09:16.322Z",
    dateUpdated: "2026-09-21T07:13:00.997Z",
    direction: "outbound",
    from: "+61489267772",
    locationId: LOCATION_ID,
    messageType: "TYPE_CALL",
    meta: { call: { status: "completed" } },
    source: "app",
    status: "completed",
    to: "+61400000000",
    type: 1,
    userId: KHAIRO_USER,
  },
  sentences: sentencesFromRuns(
    [
      [1, 1],
      [2, 3],
      [1, 1],
      [2, 9],
      [1, 5],
      [2, 4],
      [1, 2],
      [2, 4],
      [1, 3],
      [
        2,
        2,
      ],
      [1, 3],
      [2, 3],
      [1, 3],
      [2, 1],
      [1, 5],
      [2, 4],
      [1, 1],
      [2, 1],
      [1, 1],
      [
        2,
        4,
      ],
      [1, 4],
      [2, 2],
      [1, 2],
      [2, 1],
      [1, 2],
      [2, 5],
      [1, 4],
      [2, 5],
      [1, 2],
      [
        2,
        3,
      ],
    ],
    0.08,
    204.04001,
  ),
};

/** The same conversation's list read, as the history load sees it: a text, an activity and the two calls. */
export const N4_CONVERSATION_PAGE = [
  {
    id: "unJUR0MY5jwawuYXWYgR",
    messageType: "TYPE_SMS",
    direction: "outbound",
    contactId: N4_CONTACT.contactId,
    conversationId: N4_CONTACT.conversationId,
    dateAdded: "2026-09-23T05:19:34.381Z",
    body: "Placeholder text.",
  },
  { ...NODUR.item, meta: { call: { duration: null, status: "completed" } } },
  {
    id: "3LqQANiVr0fuAI6LlVeu",
    messageType: "TYPE_ACTIVITY_OPPORTUNITY",
    direction: "outbound",
    contactId: N4_CONTACT.contactId,
    conversationId: N4_CONTACT.conversationId,
    dateAdded: "2026-09-21T03:57:48.133Z",
  },
  { ...N4.item, to: "+61489267772" },
];
