// Slice C1a: the GHL row builder on the recorded named rows (sms.md §10).
// Pure: no network, no database.
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildGhlMessageRow,
  buildGhlRecordRow,
  CALL_LOG_TRANSCRIPT_PENDING,
  type GhlCaptureContext,
  type GhlMessageItem,
  type GhlRecordBody,
  type GhlRecordEventType,
  ourLineForNumber,
} from "./ghl_message.ts";
import {
  ACTIVITY_ITEM,
  CALL_ITEM,
  N1_CALL_ITEM,
  N2_CALL_ITEM,
  N3_CALL_ITEM,
  R10_INBOUND,
  R10_OUTBOUND,
  R11_BODY,
  R11_LIST_ITEM,
  R13_LIST_ITEM,
  R2_LIST_ITEM,
  R32_EMAIL,
  R32_MMS,
  R3_LIST_ITEM,
  R4_LIST_ITEM,
  R5,
  R5_WEBHOOK,
  R7_LIST_ITEMS,
  R9_WEBHOOK,
  SHORT_CALL_ITEM,
} from "./ghl_message_fixtures.ts";

const LIVE: GhlCaptureContext = {
  source: "ghl-message-test",
  captureMode: "live",
};

function row(
  item: GhlMessageItem,
  ctx: GhlCaptureContext = LIVE,
  // deno-lint-ignore no-explicit-any
): Record<string, any> {
  const built = buildGhlMessageRow(item, ctx);
  if (built.kind !== "row") {
    throw new Error(`expected a row, got skip ${built.reason}`);
  }
  return built.row;
}

Deno.test("every row is keyed ghl:<id>, has no thread key, and carries its capture mode", () => {
  for (
    const item of [
      R2_LIST_ITEM,
      R3_LIST_ITEM,
      R4_LIST_ITEM,
      R9_WEBHOOK,
      R11_LIST_ITEM,
      ...R7_LIST_ITEMS,
    ]
  ) {
    const r = row(item);
    assertEquals(
      r.provider_message_id,
      `ghl:${
        (item as { id?: string; messageId?: string }).id ??
          (item as { messageId?: string }).messageId
      }`,
    );
    assertEquals(r.thread_key, null);
    assertEquals(r.metadata, { capture_mode: "live" });
    assertEquals(r.entity_type, "contact");
    assertEquals(r.contact_id, item.contactId);
    // The conversation id is kept as evidence, never as a job thread.
    assertEquals(r.payload.conversation_key, item.conversationId);
    // Writer-owned fields are never supplied by the builder.
    for (
      const owned of [
        "id",
        "occurred_at",
        "attribution_status",
        "candidate_job_ids",
        "match_status",
        "match_confidence",
        "context_captured_at",
      ]
    ) {
      assert(!(owned in r), `builder must not set ${owned}`);
    }
  }
  assertEquals(
    row(R3_LIST_ITEM, { source: "x", captureMode: "backfill" }).metadata,
    { capture_mode: "backfill" },
  );
});

Deno.test("event_at is GHL's own time, never the capture clock", () => {
  assertEquals(row(R3_LIST_ITEM).event_at, "2026-09-23T06:00:00.000Z");
  assertEquals(row(R3_LIST_ITEM).payload.event_at_source, "provider");
  const noTime = row({ ...R3_LIST_ITEM, dateAdded: null });
  assertEquals(noTime.event_at, null);
  assertEquals(noTime.payload.event_at_source, "missing");
});

Deno.test("R2: a staff reply from the GHL app is client.sms_out by staff_app, author from the user id, line fencing (772)", () => {
  const r = row(R2_LIST_ITEM);
  assertEquals([r.event_type, r.channel, r.direction], [
    "client.sms_out",
    "sms",
    "outbound",
  ]);
  assertEquals(r.payload.sent_by_kind, "staff_app");
  assertEquals(r.payload.sent_by_user, "RgDWTnYL6zL3eJA6nLht");
  assertEquals([r.payload.from_line, r.payload.line], ["772", "fencing"]);
  assertEquals(r.job_id, null);
  assertEquals(r.match_method, "none");
});

Deno.test('R3: inbound "Thanks." is a customer reply, kept word for word', () => {
  const r = row(R3_LIST_ITEM);
  assertEquals([r.event_type, r.channel, r.direction], [
    "client.reply",
    "sms",
    "inbound",
  ]);
  assertEquals(r.payload.sent_by_kind, "customer");
  assertEquals(r.payload.sent_by_user, null);
  assertEquals(r.payload.body, "Thanks.");
});

Deno.test("R4: a GHL workflow text is client.sms_out by workflow, never our human reply", () => {
  const r = row(R4_LIST_ITEM);
  assertEquals(r.event_type, "client.sms_out");
  assertEquals(r.payload.sent_by_kind, "workflow");
  assertEquals(r.payload.provider_source, "workflow");
  // Not marked automated: the design keeps workflow texts linked (review D5).
  assertEquals(r.payload.automated, undefined);
});

Deno.test("outbound bulk_actions follows the named rules, not the workflow alias", () => {
  const withUser = row({
    ...R2_LIST_ITEM,
    id: "bulkActionsWithUser1",
    source: "bulk_actions",
  });
  assertEquals(withUser.event_type, "client.sms_out");
  assertEquals(withUser.payload.sent_by_kind, "staff_app");
  assertEquals(withUser.payload.sent_by_user, "RgDWTnYL6zL3eJA6nLht");
  assertEquals(withUser.payload.provider_source, "bulk_actions");

  const withoutUser = row({
    ...R4_LIST_ITEM,
    id: "bulkActionsNoUser1",
    source: "bulk_actions",
  });
  assertEquals(withoutUser.event_type, "client.sms_out");
  assertEquals(withoutUser.payload.sent_by_kind, "unknown");
  assertEquals(withoutUser.payload.sent_by_user, null);
  assertEquals(withoutUser.payload.provider_source, "bulk_actions");
});

Deno.test("R5: our tool's send and GHL's webhook build the same key; the tool row carries the verified job and line 771", () => {
  const tool = row({
    messageId: R5.messageId,
    messageType: "SMS",
    direction: "outbound",
    body: R5.body,
    contactId: R5.contactId,
    conversationId: R5.sendResult.conversationId,
  }, {
    source: "ghl-proxy",
    captureMode: "live",
    verifiedJobId: R5.jobId,
    ourNumber: R5.fromNumber,
    sentByKind: "our_tool",
  });
  const hook = row(R5_WEBHOOK);
  assertEquals(tool.provider_message_id, hook.provider_message_id);
  assertEquals(tool.provider_message_id, "ghl:mDS89hMzWE2R3VCMqxP2");
  assertEquals([tool.job_id, tool.match_method], [R5.jobId, "direct_job_id"]);
  assertEquals([hook.job_id, hook.match_method], [null, "none"]);
  assertEquals([
    tool.payload.from_line,
    tool.payload.line,
    tool.payload.our_number,
  ], ["771", null, "+61489267771"]);
  assertEquals(tool.payload.sent_by_kind, "our_tool");
  // GHL's webhook for an app-sent text is recognised as ours by the app id.
  assertEquals(hook.payload.sent_by_kind, "our_tool");
  assertEquals(hook.payload.from_line, "771");
});

Deno.test("an unverified job id is a hint only, never a direct link", () => {
  const r = row(R2_LIST_ITEM, { ...LIVE, unverifiedJobId: R5.jobId });
  assertEquals([r.job_id, r.match_method], [R5.jobId, "none"]);
});

Deno.test("R7: internal comments are ghl.internal_comment, internal, never outbound or a text", () => {
  for (const item of R7_LIST_ITEMS) {
    const r = row(item);
    assertEquals([r.event_type, r.channel, r.direction], [
      "ghl.internal_comment",
      "note",
      "internal",
    ]);
    assertEquals(r.payload.sent_by_kind, "staff_app");
    assertEquals(r.payload.body, item.body);
  }
});

Deno.test("R9: inbound to 774 is line patio", () => {
  const r = row(R9_WEBHOOK);
  assertEquals([r.event_type, r.payload.from_line, r.payload.line], [
    "client.reply",
    "774",
    "patio",
  ]);
  assertEquals(r.provider_message_id, "ghl:1TPog9f79izPytVu8yoo");
});

Deno.test("R10: one conversation across two lines: 772 row is fencing, 771 row decides nothing; author from the user id", () => {
  const inbound = row(R10_INBOUND);
  const outbound = row(R10_OUTBOUND);
  assertEquals([inbound.payload.from_line, inbound.payload.line], [
    "772",
    "fencing",
  ]);
  assertEquals([outbound.payload.from_line, outbound.payload.line], [
    "771",
    null,
  ]);
  assertEquals(outbound.payload.sent_by_user, "47AptTIxjOPutvcl6RpO");
  assertEquals(outbound.payload.sent_by_kind, "staff_app");
});

Deno.test("R11: a 320-character question is kept whole", () => {
  const r = row(R11_LIST_ITEM);
  assertEquals(R11_BODY.length, 320);
  assertEquals(r.payload.body, R11_BODY);
  assertEquals(r.body_preview, R11_BODY);
});

Deno.test("a body longer than the preview is kept whole in payload.body", () => {
  const long = "x".repeat(1200);
  const r = row({ ...R11_LIST_ITEM, body: long });
  assertEquals(r.payload.body.length, 1200);
  assertEquals(r.body_preview.length, 500);
});

Deno.test("R13: the price text is written as a plain customer reply with its words (placement is the ladder's)", () => {
  const r = row(R13_LIST_ITEM);
  assertEquals(r.payload.body, "I only see one price of $5,478");
  assertEquals([r.job_id, r.match_method], [null, "none"]);
});

Deno.test("R32 MMS with no words: bracketed description, attachment count and types only, no links", () => {
  const r = row(R32_MMS);
  assertEquals(r.event_type, "client.reply");
  assertEquals(r.payload.described_by_capture, true);
  assertEquals(r.payload.body, undefined);
  assertEquals(r.body_preview, "[No text. 2 attachments: jpg, heic.]");
  assertEquals(r.payload.attachments, { count: 2, types: ["jpg", "heic"] });
  assert(
    !JSON.stringify(r).includes("storage.example.test"),
    "attachment links must not be copied",
  );
  assert(
    !JSON.stringify(r).includes("IMG_0001"),
    "attachment file names must not be copied",
  );
});

Deno.test("R32 GHL Email: client.email_in, channel email, provider email id kept", () => {
  const r = row(R32_EMAIL);
  assertEquals([r.event_type, r.channel, r.direction], [
    "client.email_in",
    "email",
    "inbound",
  ]);
  assertEquals(r.payload.email_message_id, "r32-email-message-id");
  assertEquals(r.provider_message_id, "ghl:r32EmailPlaceholder1");
});

Deno.test("activity items, id-less and contact-less items are not written, with a reason", () => {
  assertEquals(buildGhlMessageRow(ACTIVITY_ITEM, LIVE), {
    kind: "skip",
    reason: "skipped_activity",
  });
  assertEquals(buildGhlMessageRow({ ...R3_LIST_ITEM, id: undefined }, LIVE), {
    kind: "skip",
    reason: "no_id",
  });
  assertEquals(buildGhlMessageRow({ ...R3_LIST_ITEM, id: "bad id!" }, LIVE), {
    kind: "skip",
    reason: "no_id",
  });
  assertEquals(buildGhlMessageRow({ ...R3_LIST_ITEM, contactId: null }, LIVE), {
    kind: "skip",
    reason: "no_contact",
  });
  assertEquals(buildGhlMessageRow({ ...R3_LIST_ITEM, direction: null }, LIVE), {
    kind: "skip",
    reason: "no_direction",
  });
  assertEquals(
    buildGhlMessageRow({ ...R3_LIST_ITEM, messageType: "TYPE_WHATSAPP" }, LIVE),
    { kind: "skip", reason: "unsupported_type" },
  );
});

Deno.test("our lines: 772 and 778 fencing, 774 patio, 771 and 776 none, other numbers unknown", () => {
  assertEquals(ourLineForNumber("0489267772").line, "fencing");
  assertEquals(ourLineForNumber("+61 489 267 778").line, "fencing");
  assertEquals(ourLineForNumber("+61489267774").line, "patio");
  assertEquals(ourLineForNumber("+61489267771"), {
    from_line: "771",
    line: null,
    our_number: "+61489267771",
  });
  assertEquals(ourLineForNumber("+61489267776").from_line, "776");
  assertEquals(ourLineForNumber("+61400000000"), {
    from_line: null,
    line: null,
    our_number: null,
  });
  assertEquals(ourLineForNumber(null).from_line, null);
});

// ── rank 10 (slice C1c): notes, tasks, appointments ─────────────────────────

Deno.test("rank 10: the key version is dateUpdated, else a create's dateAdded, else the event timestamp, else the webhook id", () => {
  const ctx = { source: "ghl-webhook-receiver", captureMode: "live" as const };
  const key = (type: GhlRecordEventType, body: GhlRecordBody) => {
    const b = buildGhlRecordRow(type, body, ctx);
    return b.kind === "row" ? b.row.provider_message_id : `skip:${b.reason}`;
  };
  const base = { id: "noteFixture01", contactId: "contact-fixture" };
  assertEquals(
    key("NoteCreate", {
      ...base,
      dateAdded: "2026-09-08T02:10:00.000Z",
      webhookId: "wh-1",
    }),
    "ghlnote:noteFixture01:2026-09-08T02:10:00.000Z",
  );
  assertEquals(
    key("NoteUpdate", {
      ...base,
      dateAdded: "2026-09-08T02:10:00.000Z",
      dateUpdated: "2026-09-09T01:00:00.000Z",
    }),
    "ghlnote:noteFixture01:2026-09-09T01:00:00.000Z",
  );
  // An edit never falls back to the creation time: that would fold it into the original row.
  assertEquals(
    key("NoteUpdate", {
      ...base,
      dateAdded: "2026-09-08T02:10:00.000Z",
      webhookId: "wh-2",
    }),
    "ghlnote:noteFixture01:wh-2",
  );
  assertEquals(
    key("NoteUpdate", { ...base, dateAdded: "2026-09-08T02:10:00.000Z" }),
    "skip:no_id",
  );
  assertEquals(
    key("TaskComplete", {
      ...base,
      dateAdded: "2026-09-01T00:00:00.000Z",
      timestamp: "2026-09-23T02:00:00.000Z",
    }),
    "ghltask:noteFixture01:complete:2026-09-23T02:00:00.000Z",
  );
  // A version that is not id- or time-shaped is not used.
  assertEquals(
    key("TaskDelete", { ...base, timestamp: "next tuesday please" }),
    "skip:no_id",
  );
});

Deno.test("rank 10: no contact means no row; an appointment's contact is read from the nested appointment", () => {
  const ctx = { source: "ghl-webhook-receiver", captureMode: "live" as const };
  const noContact = buildGhlRecordRow("NoteCreate", {
    id: "noteFixture01",
    dateAdded: "2026-09-08T02:10:00.000Z",
  }, ctx);
  assertEquals(
    noContact.kind === "skip" ? noContact.reason : "row",
    "no_contact",
  );
  const appt = buildGhlRecordRow("AppointmentDelete", {
    appointment: {
      id: "apptFixture01",
      contactId: "contact-nested",
      dateUpdated: "2026-09-20T03:00:00.000Z",
    },
  }, ctx);
  if (appt.kind !== "row") throw new Error("appointment skipped");
  assertEquals(appt.row.contact_id, "contact-nested");
  assertEquals(appt.row.event_type, "ghl.appointment_deleted");
  assertEquals(appt.row.channel, "status");
  assertEquals(appt.row.thread_key, null);
  assertEquals(
    (appt.row.metadata as Record<string, unknown>).capture_mode,
    "live",
  );
});

// ── Slice T1: one call record per GHL call item (transcripts.md §2, §10) ──

Deno.test("T1 N1: an answered inbound call is one client.call_logged row, keyed ghl:<id>, facts as given", () => {
  const r = row(N1_CALL_ITEM);
  assertEquals(r.event_type, "client.call_logged");
  assertEquals(r.provider_message_id, "ghl:6kn6WmrtfTMvhEJtmfeJ");
  assertEquals(r.channel, "call");
  assertEquals(r.direction, "inbound");
  assertEquals(r.contact_id, "Oxqi7eCx2rGCsS0BXOH2");
  assertEquals(r.entity_type, "contact");
  assertEquals(r.thread_key, null);
  assertEquals(r.conversation_key, "3GOBTMJT1qEXkGwcodQK");
  // Provider time, never ingestion time; the writer stamps occurred_at.
  assertEquals(r.event_at, "2026-09-23T07:40:55.171Z");
  assert(!("occurred_at" in r));
  assertEquals(r.job_id, null, "the ladder places a call, never the builder");
  assertEquals(r.match_method, "none");
  assertEquals(r.metadata, { capture_mode: "live" });
  assertEquals(r.privacy_classification, "staff_only");
  assertEquals(r.retention_class, "7y_audit");
  assertEquals(
    r.body_preview,
    `[Call, inbound. Provider status: completed. Duration: 109 seconds. ${CALL_LOG_TRANSCRIPT_PENDING}]`,
  );
  assertEquals(r.safe_summary, r.body_preview.slice(0, 280));
  assertEquals(r.payload, {
    described_by_capture: true,
    words: false,
    channel: "call",
    direction: "inbound",
    ghl_message_id: "6kn6WmrtfTMvhEJtmfeJ",
    ghl_contact_id: "Oxqi7eCx2rGCsS0BXOH2",
    ghl_message_type: "TYPE_CALL",
    conversation_key: "3GOBTMJT1qEXkGwcodQK",
    conversation_id: "3GOBTMJT1qEXkGwcodQK",
    call_sid: "CAfcb0bf0b3d5308f16a6087ca116874a8",
    call_status: "completed",
    duration_seconds: 109,
    by_user: "ERAycY7r6KZ8OA66WQCy",
    line: "patio",
    from_line: "774",
    our_number: "+61489267774",
    source: null,
    provider_status: "completed",
    transcript_expected: true,
    event_at_source: "provider",
  });
});

Deno.test("T1 N1: a call row has no words: nothing a reader takes for what someone said", () => {
  const r = row(N1_CALL_ITEM);
  for (const key of ["body", "text", "message", "message_text", "transcript"]) {
    assert(!(key in r.payload), `payload.${key} must be absent on a call row`);
  }
  assertEquals(r.payload.words, false);
});

Deno.test("T1 N2: a voicemail keeps the provider's status, no duration is invented, and a transcript is expected", () => {
  const r = row(N2_CALL_ITEM);
  assertEquals(r.event_type, "client.call_logged");
  assertEquals(r.provider_message_id, "ghl:Py9PovOwc4I4vNkn9jXg");
  assertEquals(r.direction, "inbound");
  assertEquals(r.event_at, "2026-09-22T22:59:20.907Z");
  assertEquals(r.payload.call_status, "voicemail");
  assertEquals(r.payload.duration_seconds, null);
  assertEquals(r.payload.transcript_expected, true);
  assertEquals(r.payload.line, "patio");
  assertEquals(
    r.body_preview,
    `[Call, inbound. Provider status: voicemail. Duration: none recorded. ${CALL_LOG_TRANSCRIPT_PENDING}]`,
  );
});

Deno.test("T1 N3: an outbound call placed in the GHL app keeps its direction, our line and the staff user", () => {
  const r = row(N3_CALL_ITEM);
  assertEquals(r.provider_message_id, "ghl:0Gct0u0TQNZox8DRAVLo");
  assertEquals(r.direction, "outbound");
  assertEquals(r.event_at, "2026-09-21T23:16:29.130Z");
  assertEquals(r.payload.duration_seconds, 67);
  assertEquals(r.payload.call_status, "completed");
  assertEquals(r.payload.by_user, "ERAycY7r6KZ8OA66WQCy");
  assertEquals(r.payload.source, "app");
  assertFalse("provider_source" in r.payload);
  // Outbound: our number is the one rung from.
  assertEquals(r.payload.our_number, "+61489267774");
  assertEquals(r.payload.from_line, "774");
  assertEquals(r.payload.transcript_expected, true);
  assert(
    r.body_preview.startsWith(
      "[Call, outbound. Provider status: completed. Duration: 67 seconds.",
    ),
  );
});

Deno.test("T1: a completed call under 5 s expects no transcript; a no-answer is never written as completed", () => {
  assertEquals(row(SHORT_CALL_ITEM).payload.transcript_expected, false);
  const noAnswer = row({
    ...N3_CALL_ITEM,
    status: "no-answer",
    meta: { call: { duration: 0, status: "no-answer" } },
  });
  assertEquals(noAnswer.payload.call_status, "no-answer");
  assertEquals(noAnswer.payload.transcript_expected, false);
  assert(noAnswer.body_preview.includes("Provider status: no-answer."));
});

Deno.test("T1: the app webhook shape (messageType CALL, callStatus, callDuration) builds the same row as the list item", () => {
  const listed = row(N1_CALL_ITEM);
  const hooked = row({
    messageId: N1_CALL_ITEM.id,
    messageType: "CALL",
    direction: "inbound",
    contactId: N1_CALL_ITEM.contactId,
    conversationId: N1_CALL_ITEM.conversationId,
    dateAdded: N1_CALL_ITEM.dateAdded,
    userId: N1_CALL_ITEM.userId,
    status: "completed",
    callStatus: "completed",
    callDuration: "109",
    altId: N1_CALL_ITEM.altId,
    from: N1_CALL_ITEM.from,
    to: N1_CALL_ITEM.to,
  });
  assertEquals(hooked.provider_message_id, listed.provider_message_id);
  assertEquals(hooked.body_preview, listed.body_preview);
  assertEquals(
    { ...hooked.payload, ghl_message_type: null },
    { ...listed.payload, ghl_message_type: null },
  );
});

Deno.test("T1: GHL's voicemail and IVR call types are call records too; a call with no direction is unknown, not guessed", () => {
  for (const messageType of ["TYPE_VOICEMAIL", "TYPE_IVR_CALL"]) {
    const r = row({ ...CALL_ITEM, messageType });
    assertEquals(r.event_type, "client.call_logged");
    assertEquals(r.channel, "call");
  }
  assertEquals(
    row({ ...CALL_ITEM, messageType: "TYPE_VOICEMAIL" }).payload
      .transcript_expected,
    true,
  );
  const undirected = row({ ...N1_CALL_ITEM, direction: null });
  assertEquals(undirected.direction, "unknown");
  assertEquals(
    undirected.payload.line,
    "patio",
    "our line found on either end",
  );
  assert(undirected.body_preview.startsWith("[Call, direction not given."));
  // The placeholder call item: nothing but id, type, direction and time.
  const bare = row(CALL_ITEM);
  assertEquals(bare.payload.call_status, null);
  assertEquals(bare.payload.duration_seconds, null);
  assertEquals(bare.payload.call_sid, null);
  assertEquals(bare.payload.transcript_expected, false);
  assert(
    bare.body_preview.includes(
      "Provider status: not given. Duration: none recorded.",
    ),
  );
});

Deno.test("T1: a call with no usable id or no contact writes nothing", () => {
  assertEquals(buildGhlMessageRow({ ...N1_CALL_ITEM, id: undefined }, LIVE), {
    kind: "skip",
    reason: "no_id",
  });
  assertEquals(
    buildGhlMessageRow({ ...N1_CALL_ITEM, contactId: null }, LIVE),
    { kind: "skip", reason: "no_contact" },
  );
});

Deno.test("T1: capture mode, a verified tool job id and the tool's actor are carried; an unverified id is a hint only", () => {
  const backfill = row(N1_CALL_ITEM, { ...LIVE, captureMode: "backfill" });
  assertEquals(backfill.metadata, { capture_mode: "backfill" });
  const job = "33333333-3333-4333-8333-333333333341";
  const tool = row(N3_CALL_ITEM, {
    ...LIVE,
    verifiedJobId: job,
    initiatedBy: "workflow:sw_initiate_call",
  });
  assertEquals(tool.job_id, job);
  assertEquals(tool.match_method, "direct_job_id");
  assertEquals(tool.payload.initiated_by, "workflow:sw_initiate_call");
  const hint = row(N3_CALL_ITEM, { ...LIVE, unverifiedJobId: job });
  assertEquals(hint.job_id, job);
  assertEquals(hint.match_method, "none");
  assert(!("initiated_by" in hint.payload));
});
