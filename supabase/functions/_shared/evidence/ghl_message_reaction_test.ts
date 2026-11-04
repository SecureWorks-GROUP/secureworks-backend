// C7 (3 Nov 2026): GHL text reactions through the one row builder. A reaction
// (TYPE_SMS_REACTION, type 45) is saved as its own client.sms_reaction row on
// channel status, keyed by its own GHL id, on its contact and conversation,
// naming the text it is on when the caller holds it, and never read as the
// customer writing. Recorded shapes from the 3 Nov read (fixtures). Pure: no
// network, no database.
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildGhlMessageRow,
  findReactionTarget,
  type GhlMessageItem,
  isReactionItem,
  parseGhlReaction,
  REACTION_EVENT_TYPE,
} from "./ghl_message.ts";
import {
  R3_LIST_ITEM,
  RX1_REACTION_ITEM,
  RX1_REACTION_SINGLE_READ,
  RX1_TARGET_ITEM,
  RX2_REACTION_ITEM,
  RX2_TARGET_ITEM,
} from "./ghl_message_fixtures.ts";

const LIVE = { source: "ghl-message-reconcile", captureMode: "live" as const };

function row(
  item: Record<string, unknown>,
  inHand?: Record<string, unknown>[],
): Record<string, unknown> {
  const built = buildGhlMessageRow(item as GhlMessageItem, {
    ...LIVE,
    inHand: inHand as GhlMessageItem[] | undefined,
  });
  assert(built.kind === "row", `expected a row, got ${JSON.stringify(built)}`);
  return built.row;
}

function payload(r: Record<string, unknown>): Record<string, unknown> {
  return r.payload as Record<string, unknown>;
}

Deno.test("C7 RX1: an iPhone tapback is one client.sms_reaction row on channel status, keyed by its own GHL id, on its contact and conversation", () => {
  const r = row(RX1_REACTION_ITEM, [RX1_REACTION_ITEM, RX1_TARGET_ITEM]);
  assertEquals(r.event_type, REACTION_EVENT_TYPE);
  assertEquals(r.event_type, "client.sms_reaction");
  assertEquals(r.channel, "status");
  assertEquals(r.direction, "inbound");
  assertEquals(r.provider_message_id, "ghl:aHJDV3bgOb5fof6NtlUa");
  assertEquals(r.contact_id, RX1_REACTION_ITEM.contactId);
  assertEquals(r.entity_id, RX1_REACTION_ITEM.contactId);
  assertEquals(r.conversation_key, RX1_REACTION_ITEM.conversationId);
  assertEquals(r.thread_key, null);
  assertEquals(r.event_at, RX1_REACTION_ITEM.dateAdded);
  // Capture never names a job: the ladder places it like any worded row.
  assertEquals(r.job_id, null);
  assertEquals(r.match_method, "none");
  assertEquals(r.metadata, { capture_mode: "live" });
  assertEquals(r.retention_class, "7y_audit");
  // The provider's words are kept whole; the short account names the mark and the text.
  assertEquals(payload(r).body, RX1_REACTION_ITEM.body);
  assertEquals(
    r.body_preview,
    "[Reaction \u{1F44D} (Liked) on our text ghl:o6r7C1Sk23UdMcagy04d: “Sorry yes that was an automation apologies”]",
  );
  assertEquals(r.safe_summary, r.body_preview);
  assertEquals(payload(r).channel, "status");
  assertEquals(payload(r).sent_by_kind, "customer");
  assertEquals(payload(r).line, "fencing");
  assertEquals(payload(r).from_line, "772");
  assertEquals(payload(r).ghl_message_type, "TYPE_SMS_REACTION");
  assertEquals(payload(r).ghl_type, 45);
  assertEquals(payload(r).reaction, {
    emoji: "\u{1F44D}",
    verb: "Liked",
    removed: false,
    quoted_text: "Sorry yes that was an automation apologies",
    reacted_to_match: "quoted_text",
    reacted_to_key: "ghl:o6r7C1Sk23UdMcagy04d",
    reacted_to_ghl_message_id: "o6r7C1Sk23UdMcagy04d",
    reacted_to_direction: "outbound",
  });
});

Deno.test("C7: a single-message read (messageType empty, type 45) is the same reaction; a type-2 text that reads like one is still a text", () => {
  const listed = row(RX1_REACTION_ITEM);
  const single = row(RX1_REACTION_SINGLE_READ);
  assertEquals(single.event_type, "client.sms_reaction");
  assertEquals(single.provider_message_id, listed.provider_message_id);
  assertEquals(single.body_preview, listed.body_preview);
  assertEquals(payload(single).ghl_message_type, "");
  // GHL called it a text (as it did for an Android reaction in July 2026): the
  // builder never re-reads a text as a reaction from its words.
  const text = row({ ...RX1_REACTION_ITEM, type: 2, messageType: "TYPE_SMS" });
  assertEquals(text.event_type, "client.reply");
  assertEquals(text.channel, "sms");
  assertEquals(isReactionItem({ messageType: "", type: 2 }), false);
  assertEquals(isReactionItem({ messageType: "", type: "45" }), true);
  assertEquals(isReactionItem({ messageType: "SMS_REACTION" }), true);
});

Deno.test("C7 RX2: an Android emoji reaction is read through its invisible marks and the spaces inside its quote", () => {
  const r = row(RX2_REACTION_ITEM, [RX2_REACTION_ITEM, RX2_TARGET_ITEM]);
  assertEquals(r.event_type, "client.sms_reaction");
  assertEquals(payload(r).line, null, "771 decides no line");
  assertEquals(
    r.body_preview,
    "[Reaction \u{1F44D} on our text ghl:30TfoJaOxSXh2mSStvJN: “Hi there, Placeholder booking text for the RX2 fixture. Cheers, Office.”]",
  );
  const reaction = payload(r).reaction as Record<string, unknown>;
  assertEquals(reaction.emoji, "\u{1F44D}");
  assertEquals(reaction.verb, "\u{1F44D} to");
  assertEquals(reaction.reacted_to_key, "ghl:30TfoJaOxSXh2mSStvJN");
  assertEquals(reaction.reacted_to_direction, "outbound");
});

Deno.test("C7: the reacted-to text is named only when exactly one earlier text of the conversation has the quoted words", () => {
  const quoted = "Sorry yes that was an automation apologies";
  const target = RX1_TARGET_ITEM as GhlMessageItem;
  const reaction = RX1_REACTION_ITEM as GhlMessageItem;
  // Nothing in hand (a lone webhook body): recorded, never guessed.
  assertEquals(findReactionTarget(reaction, quoted, undefined), {
    match: "not_in_hand",
  });
  assertEquals(findReactionTarget(reaction, null, [target]), {
    match: "no_quote",
  });
  // Curly quotes, spacing and line breaks do not stop a match.
  assertEquals(
    findReactionTarget(
      reaction,
      "Sorry  yes that\nwas an automation apologies",
      [
        { ...target, body: "Sorry yes that was an automation apologies " },
      ],
    ).match,
    "quoted_text",
  );
  // Two equal earlier texts: several, no id.
  assertEquals(
    findReactionTarget(reaction, quoted, [
      target,
      { ...target, id: "o6r7C1Sk23UdMcagy0XX" },
    ]),
    { match: "several", candidates: 2 },
  );
  // A later text, another conversation, the reaction itself, another reaction,
  // a call or a note never count.
  assertEquals(
    findReactionTarget(reaction, quoted, [
      { ...target, dateAdded: "2026-10-27T02:00:00.000Z" },
      { ...target, id: "otherConv0001", conversationId: "otherConversation1" },
      reaction,
      { ...reaction, id: "anotherReaction1", body: quoted },
      { ...target, id: "callItem00001", messageType: "TYPE_CALL" },
      { ...target, id: "noteItem00001", messageType: "TYPE_INTERNAL_COMMENT" },
    ]),
    { match: "not_found" },
  );
  // The customer's own earlier text is named as theirs.
  const own = { ...target, direction: "inbound" };
  const r = row(RX1_REACTION_ITEM, [own]);
  assertEquals(
    r.body_preview,
    "[Reaction \u{1F44D} (Liked) on the customer's text ghl:o6r7C1Sk23UdMcagy04d: “Sorry yes that was an automation apologies”]",
  );
  // No text in hand: the short account says only "a text".
  const lone = row(RX1_REACTION_ITEM);
  assertEquals(
    lone.body_preview,
    "[Reaction \u{1F44D} (Liked) on a text: “Sorry yes that was an automation apologies”]",
  );
  const loneReaction = payload(lone).reaction as Record<string, unknown>;
  assertEquals(loneReaction.reacted_to_match, "not_in_hand");
  assertEquals(loneReaction.reacted_to_key, null);
});

Deno.test("C7: the tapback words give the mark; a taken-back mark and an unknown one are said as such", () => {
  const cases: [string, Partial<ReturnType<typeof parseGhlReaction>>][] = [
    ["Liked “A”", {
      emoji: "\u{1F44D}",
      verb: "Liked",
      removed: false,
      quoted: "A",
    }],
    ["Loved “A”", { emoji: "❤️", verb: "Loved" }],
    ["Laughed at “A”", { emoji: "\u{1F602}", verb: "Laughed at" }],
    ["Emphasized “A”", { emoji: "‼️" }],
    ["Questioned “A”", { emoji: "❓" }],
    ["Disliked “A”", { emoji: "\u{1F44E}" }],
    ["Removed a like from “A”", {
      emoji: "\u{1F44D}",
      removed: true,
      quoted: "A",
    }],
    ["Removed a question mark from “A”", { emoji: "❓", removed: true }],
    ["Reacted \u{1F389} to “A”", {
      emoji: "\u{1F389}",
      verb: "Reacted \u{1F389} to",
    }],
    ["​\u{1F44D}​ to “ A ”", {
      emoji: "\u{1F44D}",
      verb: "\u{1F44D} to",
      quoted: "A",
    }],
    ['Liked "A"', { emoji: "\u{1F44D}", quoted: "A" }],
    ["Thumbs up", { emoji: null, verb: "Thumbs up", quoted: null }],
    ["", { emoji: null, verb: null, quoted: null }],
  ];
  for (const [body, want] of cases) {
    const got = parseGhlReaction(body);
    for (const [k, v] of Object.entries(want)) {
      assertEquals(
        got[k as keyof typeof got],
        v,
        `${JSON.stringify(body)} ${k}`,
      );
    }
  }
  const back = row({
    ...RX1_REACTION_ITEM,
    body: "Removed a like from “Sorry yes that was an automation apologies”",
  }, [RX1_TARGET_ITEM]);
  assertEquals(
    back.body_preview,
    "[Reaction \u{1F44D} taken back from our text ghl:o6r7C1Sk23UdMcagy04d: “Sorry yes that was an automation apologies”]",
  );
  assertEquals(
    (payload(back).reaction as Record<string, unknown>).removed,
    true,
  );
  const unknown = row({ ...RX1_REACTION_ITEM, body: "Thumbs up" });
  assertEquals(unknown.body_preview, "[Reaction Thumbs up on a text]");
  const empty = buildGhlMessageRow({ ...RX1_REACTION_ITEM, body: "" }, LIVE);
  assert(empty.kind === "row");
  assertEquals(empty.row.body_preview, "[Reaction a mark on a text]");
  assertEquals(
    (empty.row.payload as Record<string, unknown>).described_by_capture,
    true,
  );
});

Deno.test("C7: a long quote is cut in the short account and at 500 in the payload; no id, contact or direction is skipped as for a text", () => {
  const long = "x".repeat(700);
  const r = row({ ...RX1_REACTION_ITEM, body: `Liked “${long}”` });
  assertEquals(
    r.body_preview,
    `[Reaction \u{1F44D} (Liked) on a text: “${"x".repeat(120)}...”]`,
  );
  assertEquals(
    ((payload(r).reaction as Record<string, unknown>).quoted_text as string)
      .length,
    500,
  );
  assertEquals((r.safe_summary as string).length <= 280, true);
  assertEquals(
    buildGhlMessageRow({ ...RX1_REACTION_ITEM, direction: null }, LIVE),
    { kind: "skip", reason: "no_direction" },
  );
  assertEquals(
    buildGhlMessageRow({ ...RX1_REACTION_ITEM, contactId: null }, LIVE),
    { kind: "skip", reason: "no_contact" },
  );
  assertEquals(
    buildGhlMessageRow({ ...RX1_REACTION_ITEM, id: null }, LIVE),
    { kind: "skip", reason: "no_id" },
  );
  // A job id a caller names is never put on a reaction: the ladder places it.
  const named = buildGhlMessageRow(RX1_REACTION_ITEM, {
    ...LIVE,
    verifiedJobId: "33333333-3333-4333-8333-333333333335",
    unverifiedJobId: "33333333-3333-4333-8333-333333333336",
  });
  assert(named.kind === "row");
  assertEquals(named.row.job_id, null);
  assertEquals(named.row.match_method, "none");
  // An ordinary text beside it is unchanged.
  assertEquals(row(R3_LIST_ITEM).event_type, "client.reply");
});

// The readers that take an inbound text as the customer writing, as live on
// 3 Nov 2026 (read with pg_get_functiondef, production, read only). The
// reaction row must match none of them, so it never becomes notes evidence,
// never opens, reopens or closes a notes item, never makes a job due a read
// and never makes a reply owed on the card. This pins the capture side of
// that contract: moving reactions to channel sms, or onto one of these event
// types, fails here.
const MESSAGE_READERS = {
  // public.context_ledger_message_kind (20261006013000_context_ledger_store.sql:362)
  context_ledger_message_kind: {
    channels: ["sms", "email", "call", "note", "document"],
    eventTypes: [
      "client.reply",
      "client.sms_in",
      "client.sms_out",
      "client.email_in",
      "client.email_out",
      "client.call_logged",
      "client.message_in",
      "call.transcript_completed",
      "note.added",
      "ghl.internal_comment",
      "document.text_extracted",
      "supplier.email_in",
      "staff.email_internal",
    ],
  },
  // public.context_job_record_messages (is_msg) and context_job_record_loops (channel sms or email)
  context_job_record_messages: {
    channels: ["sms", "email", "call", "note"],
    eventTypes: [
      "call.transcript_completed",
      "client.reply",
      "client.email_in",
      "client.sms_in",
    ],
  },
  // public.context_lead_monitored_jobs (the customer's messages)
  context_lead_monitored_jobs: {
    channels: ["sms", "email", "call"],
    eventTypes: [
      "client.reply",
      "client.sms_in",
      "client.email_in",
      "client.call_logged",
      "client.call_complete",
      "call.transcript_completed",
    ],
  },
};

Deno.test("C7: a reaction row is not a message kind for the notes reader, the card's open items or the lead monitor", () => {
  for (
    const item of [
      RX1_REACTION_ITEM,
      RX1_REACTION_SINGLE_READ,
      RX2_REACTION_ITEM,
    ]
  ) {
    const r = row(item, [RX1_TARGET_ITEM, RX2_TARGET_ITEM]);
    for (const [reader, kinds] of Object.entries(MESSAGE_READERS)) {
      assert(
        !kinds.channels.includes(String(r.channel)),
        `${reader} would read channel ${r.channel}`,
      );
      assert(
        !kinds.eventTypes.includes(String(r.event_type)),
        `${reader} would read ${r.event_type}`,
      );
    }
  }
});
