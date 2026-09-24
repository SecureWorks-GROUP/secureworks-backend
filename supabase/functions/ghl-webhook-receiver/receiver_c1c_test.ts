// Slice C1c behaviour tests: the real receiver handler saves GHL messages and
// the app's notes, tasks and appointments only through the shared builder and
// capture_business_event, behind flag ghl_message_capture_v2; picks no job;
// cancels nothing; reads the conversation when a message webhook has no id;
// and leaves one ids-only ghl_webhook_receipts row per delivery. Driven with
// the recorded named rows of sms.md §10 through an in-memory database. No
// network, no live GHL, no production credentials.
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CALL_ITEM,
  N1_CALL_ITEM,
  R11_BODY,
  R11_LIST_ITEM,
  R1_WEBHOOK,
  R1_WEBHOOK_NO_ID,
  R25_NOTE_CREATE,
  R26_NOTE_CREATE,
  R27_NOTE_UPDATE,
  R28_TASK_CREATE,
  R29_TASK_COMPLETE_FIRST,
  R29_TASK_COMPLETE_SECOND,
  R2_LIST_ITEM,
  R30_APPOINTMENT_UPDATE,
  R31_APPOINTMENT_CREATE,
  R31_APPOINTMENT_DELETE,
  R3_LIST_ITEM,
  R4_WEBHOOK,
  R5_WEBHOOK,
  R7_LIST_ITEMS,
  R9_WEBHOOK,
} from "../_shared/evidence/ghl_message_fixtures.ts";
import { c1cContractRowLines, c1cContractRows } from "./c1c_contract_rows.ts";
import { TEST_LOCATION_ID } from "./named_rows_fixture.ts";
import {
  evidenceRows,
  ghlReceipt,
  post,
  receipt,
  type Row,
  type Run,
  run,
} from "./receiver_test_support.ts";

const ON = { flags: { ghl_message_capture_v2: true } };
const OFF = { flags: {} };
const R1_TEXT = R1_WEBHOOK.body;

/** The GHL app signs its webhooks for our location; the fixtures use the test location. */
const signed = (body: Record<string, unknown>) =>
  post({ ...body, locationId: TEST_LOCATION_ID }, "signature");

const captureCalls = (r: Run) =>
  r.rpcCalls.filter((c) => c.name === "capture_business_event");

/** A ghl_webhook_receipts row carries these keys only: identifiers, codes, counts. */
const RECEIPT_KEYS = [
  "auth",
  "auth_detail",
  "auth_mode",
  "contact_id",
  "error_code",
  "event_id",
  "event_type",
  "message_id",
  "outcome",
  "reason",
  "targeted_duplicates",
  "targeted_errors",
  "targeted_inserted",
  "targeted_read",
  "targeted_seen",
  "targeted_skipped",
  "upgraded",
  "webhook_id",
];

function assertNoText(r: Run, forbidden: string[]) {
  const g = ghlReceipt(r);
  assertEquals(Object.keys(g).sort(), RECEIPT_KEYS);
  const both = JSON.stringify(g) + JSON.stringify(receipt(r));
  for (const s of forbidden) {
    assertFalse(both.includes(s), `receipt must not carry ${s}`);
    assertFalse(r.logs.includes(s), `logs must not carry ${s}`);
  }
}

// ── the database proof and the receiver cannot drift ─────

Deno.test("the C1c SQL contract's input rows are exactly what the receiver builds", async () => {
  const contract = await Deno.readTextFile(
    new URL(
      "../../tests/migration-contracts/20260924130000_ghl_webhook_receipts/contract.sql",
      import.meta.url,
    ),
  );
  const block = contract.slice(
    contract.indexOf("-- ROWS BEGIN"),
    contract.indexOf("-- ROWS END"),
  ).split("\n").slice(2).join("\n").trimEnd();
  assertEquals(block, c1cContractRowLines());
});

// ── the flag ──────────────────────────────────────────────

Deno.test("flag ghl_message_capture_v2 off (the shipped state): R1 writes nothing, receipt capture_disabled flag_off", async () => {
  const r = await run(await signed(R1_WEBHOOK), "enforce", OFF);
  assertEquals(r.res.status, 200);
  assertEquals(captureCalls(r).length, 0);
  assertEquals(evidenceRows(r).length, 0);
  const g = ghlReceipt(r);
  assertEquals(g.outcome, "capture_disabled");
  assertEquals(g.reason, "flag_off");
  assertEquals(g.message_id, "pffXnIL1v2FTaKnz4DHm");
  assertEquals(receipt(r).payload.outcome, "capture_disabled");
  assertNoText(r, [R1_TEXT]);
});

Deno.test("flag off also holds the rank-10 events and any old evidence flag: nothing reaches the legacy path", async () => {
  for (
    const body of [
      R25_NOTE_CREATE,
      R28_TASK_CREATE,
      R30_APPOINTMENT_UPDATE,
      R1_WEBHOOK,
    ]
  ) {
    const r = await run(await signed(body), "enforce", {
      flags: { evidence_capture_v1: true },
    });
    assertEquals(r.res.status, 200);
    assertEquals(evidenceRows(r).length, 0, `${body.type} wrote a row`);
    assertEquals(ghlReceipt(r).reason, "flag_off");
  }
});

Deno.test("the capture lane off wins before the flag: capture_disabled, no row", async () => {
  const r = await run(await signed(R1_WEBHOOK), "enforce", {
    ...ON,
    laneOn: false,
  });
  assertEquals(evidenceRows(r).length, 0);
  assertEquals(ghlReceipt(r).outcome, "capture_disabled");
});

// ── messages through the one builder and writer ──────────

Deno.test("R1: saved only through capture_business_event with the builder's row; no job chosen, no thread, nothing cancelled", async () => {
  const r = await run(await signed(R1_WEBHOOK), "enforce", ON);
  assertEquals(r.res.status, 200);
  const calls = captureCalls(r);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].args?.p_row, c1cContractRows().r1);
  const row = calls[0].args?.p_row as Row;
  assertEquals(row.source, "ghl-webhook-receiver");
  assertEquals(row.provider_message_id, "ghl:pffXnIL1v2FTaKnz4DHm");
  assertEquals(row.job_id, null);
  assertEquals(row.match_method, "none");
  assertEquals(row.thread_key, null);
  assertEquals(row.conversation_key, "I98nlO8dKPOAaylh7k23");
  assertEquals(row.event_at, "2026-09-23T04:35:00.000Z");
  assertEquals((row.metadata as Row).capture_mode, "live");
  // No direct insert, no jobs read (the ladder places it), no cancellation
  // (the event listener owns that, on every candidate: slice E2).
  assertEquals(
    r.ops.filter((o) => o.table === "business_events" && o.kind === "insert")
      .length,
    1,
  );
  assertEquals(r.ops.filter((o) => o.table === "jobs").length, 0);
  assertEquals(r.ops.filter((o) => o.kind === "update").length, 0);
  const g = ghlReceipt(r);
  assertEquals(g.outcome, "event_created");
  assertEquals(g.event_id, "77777777-7777-4777-8777-000000000001");
  assertEquals(g.auth, "app_signature");
  assertEquals(g.auth_mode, "enforce");
  assertNoText(r, [R1_TEXT, "I98nlO8dKPOAaylh7k23", "+61489267772"]);
});

Deno.test("a body job id is never trusted on the new path", async () => {
  const r = await run(
    await signed({
      ...R1_WEBHOOK,
      job_id: "11111111-1111-4111-8111-111111111111",
    }),
    "enforce",
    ON,
  );
  const row = captureCalls(r)[0].args?.p_row as Row;
  assertEquals(row.job_id, null);
  assertFalse(
    JSON.stringify(row).includes("11111111-1111-4111-8111-111111111111"),
  );
});

Deno.test("R2 staff reply from the app and R4 GHL workflow follow-up say who sent them", async () => {
  const r2 = await run(
    await signed({
      ...R2_LIST_ITEM,
      type: "OutboundMessage",
      messageType: "SMS",
      messageId: R2_LIST_ITEM.id,
    }),
    "enforce",
    ON,
  );
  const row2 = captureCalls(r2)[0].args?.p_row as Row;
  assertEquals(row2.event_type, "client.sms_out");
  assertEquals((row2.payload as Row).sent_by_kind, "staff_app");
  assertEquals((row2.payload as Row).sent_by_user, "RgDWTnYL6zL3eJA6nLht");
  assertEquals((row2.payload as Row).from_line, "772");

  const r4 = await run(await signed(R4_WEBHOOK), "enforce", ON);
  const row4 = captureCalls(r4)[0].args?.p_row as Row;
  assertEquals(row4, c1cContractRows().r4);
  assertEquals((row4.payload as Row).sent_by_kind, "workflow");
});

Deno.test("R5: the webhook of a text our tool already saved is a duplicate: one row, 200, receipt duplicate", async () => {
  const r = await run(await signed(R5_WEBHOOK), "enforce", {
    ...ON,
    insertError: { code: "23505", message: "duplicate key" },
  });
  assertEquals(r.res.status, 200);
  assertEquals(captureCalls(r).length, 1);
  assertEquals(
    (captureCalls(r)[0].args?.p_row as Row).provider_message_id,
    "ghl:mDS89hMzWE2R3VCMqxP2",
  );
  assertEquals(ghlReceipt(r).outcome, "duplicate");
  assertEquals(ghlReceipt(r).event_id, "66666666-6666-4666-8666-666666666666");
  assertEquals(
    ((captureCalls(r)[0].args?.p_row as Row).payload as Row).sent_by_kind,
    "our_tool",
    "the SecureWorks app id marks it as our tool's text",
  );
});

Deno.test("R9 and R10: the line comes from our number (774 patio, 772 fencing)", async () => {
  const r9 = await run(await signed(R9_WEBHOOK), "enforce", ON);
  assertEquals(captureCalls(r9)[0].args?.p_row, c1cContractRows().r9);
  assertEquals(
    ((captureCalls(r9)[0].args?.p_row as Row).payload as Row).line,
    "patio",
  );
  const r10 = await run(
    await signed({
      type: "InboundMessage",
      messageId: "e7W3aTJs6myLqx1P5tfC",
      messageType: "SMS",
      direction: "inbound",
      to: "+61489267772",
      body: "Inbound text for the R10 fixture.",
      contactId: "r10-contact-placeholder",
      conversationId: "r10-conversation-placeholder",
      dateAdded: "2026-09-21T02:00:00.000Z",
    }),
    "enforce",
    ON,
  );
  assertEquals(
    ((captureCalls(r10)[0].args?.p_row as Row).payload as Row).line,
    "fencing",
  );
});

Deno.test("R11: a 320-character question is kept whole", async () => {
  const r = await run(
    await signed({
      ...R11_LIST_ITEM,
      type: "InboundMessage",
      messageType: "SMS",
      messageId: R11_LIST_ITEM.id,
    }),
    "enforce",
    ON,
  );
  const row = captureCalls(r)[0].args?.p_row as Row;
  assertEquals((row.payload as Row).body, R11_BODY);
  assertEquals(R11_BODY.length, 320);
  assertNoText(r, [R11_BODY.slice(0, 40)]);
});

Deno.test("R7: an internal comment is note / internal, never a text we sent", async () => {
  const r = await run(
    await signed({
      ...R7_LIST_ITEMS[0],
      type: "OutboundMessage",
      messageId: R7_LIST_ITEMS[0].id,
      messageType: "InternalComment",
    }),
    "enforce",
    ON,
  );
  const row = captureCalls(r)[0].args?.p_row as Row;
  assertEquals(row.event_type, "ghl.internal_comment");
  assertEquals(row.channel, "note");
  assertEquals(row.direction, "internal");
});

Deno.test("T1: a call message webhook is one client.call_logged row through the writer, under ghl:<id>", async () => {
  const r = await run(
    await signed({
      ...N1_CALL_ITEM,
      id: undefined,
      type: "InboundMessage",
      messageId: N1_CALL_ITEM.id,
      messageType: "CALL",
    }),
    "enforce",
    ON,
  );
  assertEquals(r.res.status, 200);
  assertEquals(captureCalls(r).length, 1);
  const row = captureCalls(r)[0].args?.p_row as Row;
  assertEquals(row.event_type, "client.call_logged");
  assertEquals(row.channel, "call");
  assertEquals(row.provider_message_id, "ghl:6kn6WmrtfTMvhEJtmfeJ");
  assertEquals(row.job_id, null);
  assertEquals((row.payload as Row).duration_seconds, 109);
  assertEquals(ghlReceipt(r).outcome, "event_created");
});

Deno.test("a writer error answers 500 so GHL retries, with the code only", async () => {
  const r = await run(await signed(R1_WEBHOOK), "enforce", {
    ...ON,
    capture: () => ({
      data: null,
      error: { code: "57014", message: `canceling statement: ${R1_TEXT}` },
    }),
  });
  assertEquals(r.res.status, 500);
  const g = ghlReceipt(r);
  assertEquals(g.outcome, "error");
  assertEquals(g.error_code, "57014");
  assertEquals(receipt(r).status, "failed");
  assertNoText(r, [R1_TEXT]);
});

Deno.test("the writer finding the lane switched off mid-delivery is capture_disabled lane_off, 200", async () => {
  const r = await run(await signed(R1_WEBHOOK), "enforce", {
    ...ON,
    capture: () => ({ data: { outcome: "capture_disabled" }, error: null }),
  });
  assertEquals(r.res.status, 200);
  assertEquals(ghlReceipt(r).outcome, "capture_disabled");
  assertEquals(ghlReceipt(r).reason, "lane_off");
});

// ── a message webhook without an id ───────────────────────

function providerFor(messages: Row[], opts: { failMessages?: boolean } = {}) {
  return (url: string): Response => {
    const u = new URL(url);
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (u.pathname === "/contacts/lYPee0K2DuQHXH2xHL1P") {
      return json({
        contact: { id: "lYPee0K2DuQHXH2xHL1P", locationId: TEST_LOCATION_ID },
      });
    }
    if (u.pathname === "/conversations/I98nlO8dKPOAaylh7k23") {
      return json({
        conversation: {
          id: "I98nlO8dKPOAaylh7k23",
          locationId: TEST_LOCATION_ID,
          contactId: "lYPee0K2DuQHXH2xHL1P",
        },
      });
    }
    if (u.pathname === "/conversations/I98nlO8dKPOAaylh7k23/messages") {
      if (opts.failMessages) {
        return new Response("rate limited", { status: 500 });
      }
      return json({
        messages: { messages, nextPage: false, lastMessageId: null },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

const onConversation = (item: Row) => ({
  ...item,
  locationId: TEST_LOCATION_ID,
});

Deno.test("R1 without a message id: nothing from its body; one targeted read saves each listed message under ghl:<id>", async () => {
  const listed = [
    onConversation({
      ...R1_WEBHOOK,
      id: R1_WEBHOOK.messageId,
      messageId: undefined,
      type: undefined,
      messageType: "TYPE_SMS",
    }),
    onConversation(R3_LIST_ITEM),
    onConversation(CALL_ITEM),
  ];
  const r = await run(
    await signed(R1_WEBHOOK_NO_ID),
    "enforce",
    ON,
    { GHL_API_TOKEN: "ghl-token-for-tests" },
    providerFor(listed),
  );
  assertEquals(r.res.status, 200);
  const keys = captureCalls(r).map((c) =>
    (c.args?.p_row as Row).provider_message_id
  );
  // Since slice T1 the call on the page is saved too, as a call record.
  assertEquals(keys, [
    "ghl:pffXnIL1v2FTaKnz4DHm",
    "ghl:EHw3wdBraMS847Q3V380",
    "ghl:callItemFixture01",
  ]);
  for (const c of captureCalls(r)) {
    assertEquals((c.args?.p_row as Row).source, "ghl-webhook-receiver");
    assertEquals(((c.args?.p_row as Row).metadata as Row).capture_mode, "live");
  }
  const read = r.fetches.map((f) => new URL(f.url));
  assert(
    read.some((u) =>
      u.pathname === "/conversations/I98nlO8dKPOAaylh7k23/messages" &&
      u.searchParams.get("limit") === "20"
    ),
  );
  assertEquals(
    r.fetches.length,
    3,
    "contact, conversation, newest 20 messages: one read, no paging",
  );
  const g = ghlReceipt(r);
  assertEquals(g.outcome, "unresolved_id");
  assertEquals(g.message_id, null);
  assertEquals(g.targeted_read, "ok");
  assertEquals(g.targeted_seen, 3);
  assertEquals(g.targeted_inserted, 3);
  assertEquals(g.targeted_skipped, 0);
  assertEquals(g.targeted_errors, 0);
  assertEquals(receipt(r).payload.outcome, "unresolved_id");
  assertNoText(r, [R1_TEXT, "ghl-token-for-tests"]);
});

Deno.test("R1 without an id when the targeted read fails: nothing written, 200, the reconciler covers it", async () => {
  const r = await run(
    await signed(R1_WEBHOOK_NO_ID),
    "enforce",
    ON,
    { GHL_API_TOKEN: "ghl-token-for-tests" },
    providerFor([], { failMessages: true }),
  );
  assertEquals(r.res.status, 200);
  assertEquals(captureCalls(r).length, 0);
  const g = ghlReceipt(r);
  assertEquals(g.outcome, "unresolved_id");
  assertEquals(g.targeted_read, "failed");
  assertEquals(g.reason, "provider_request_failed");
});

Deno.test("R1 without an id and no GHL token configured: no read, receipt says why", async () => {
  const r = await run(await signed(R1_WEBHOOK_NO_ID), "enforce", ON);
  assertEquals(r.fetches.length, 0);
  assertEquals(captureCalls(r).length, 0);
  assertEquals(ghlReceipt(r).targeted_read, "skipped");
  assertEquals(ghlReceipt(r).reason, "provider_not_configured");
});

// ── rank 10: notes, tasks, appointments ───────────────────

Deno.test("R25 NoteCreate: ghl.note_added, note / internal, full body, the builder's row", async () => {
  const r = await run(await signed(R25_NOTE_CREATE), "enforce", ON);
  assertEquals(r.res.status, 200);
  const row = captureCalls(r)[0].args?.p_row as Row;
  assertEquals(row, c1cContractRows().r25);
  assertEquals(row.event_type, "ghl.note_added");
  assertEquals(row.channel, "note");
  assertEquals(row.direction, "internal");
  assertEquals((row.payload as Row).body, R25_NOTE_CREATE.body);
  const g = ghlReceipt(r);
  assertEquals(g.event_type, "NoteCreate");
  assertEquals(g.message_id, "r25NotePlaceholder01");
  assertEquals(g.contact_id, "1VHBzZX6DsjMZW2WbgQn");
  assertNoText(r, [R25_NOTE_CREATE.body]);
});

Deno.test("R27 NoteUpdate: a new row keyed on the edit time; R25's key is untouched", async () => {
  const r = await run(await signed(R27_NOTE_UPDATE), "enforce", ON);
  const row = captureCalls(r)[0].args?.p_row as Row;
  assertEquals(row, c1cContractRows().r27);
  assertEquals(
    row.provider_message_id,
    "ghlnote:r25NotePlaceholder01:2026-09-09T01:00:00.000Z",
  );
  assert(row.provider_message_id !== c1cContractRows().r25.provider_message_id);
  assertEquals(row.event_at, "2026-09-09T01:00:00.000Z");
});

Deno.test("an edit with no version at all writes nothing (no key, no row)", async () => {
  const { dateUpdated: _d, webhookId: _w, ...bare } = R27_NOTE_UPDATE;
  const r = await run(await signed(bare), "enforce", ON);
  assertEquals(captureCalls(r).length, 0);
  assertEquals(ghlReceipt(r).outcome, "skipped");
  assertEquals(ghlReceipt(r).reason, "no_id");
});

Deno.test("R26 note, R28 task, R29 two completions, R30 reschedule, R31 create and delete: one row each, distinct keys", async () => {
  const expected = c1cContractRows();
  const cases: Array<[Record<string, unknown>, string]> = [
    [R26_NOTE_CREATE, "r26"],
    [R28_TASK_CREATE, "r28"],
    [R29_TASK_COMPLETE_FIRST, "r29_first"],
    [R29_TASK_COMPLETE_SECOND, "r29_second"],
    [R30_APPOINTMENT_UPDATE, "r30"],
    [R31_APPOINTMENT_CREATE, "r31_create"],
    [R31_APPOINTMENT_DELETE, "r31_delete"],
  ];
  const keys = new Set<string>();
  for (const [body, label] of cases) {
    const r = await run(await signed(body), "enforce", ON);
    assertEquals(r.res.status, 200, label);
    assertEquals(captureCalls(r).length, 1, label);
    const row = captureCalls(r)[0].args?.p_row as Row;
    assertEquals(row, expected[label], label);
    keys.add(String(row.provider_message_id));
    assertEquals(ghlReceipt(r).outcome, "event_created", label);
  }
  assertEquals(keys.size, cases.length);
  assertEquals(expected.r28.event_type, "ghl.task_created");
  assertEquals(expected.r28.channel, "status");
  assertEquals(expected.r29_first.event_type, "ghl.task_completed");
  assertEquals(expected.r30.event_type, "ghl.appointment_updated");
  assertEquals((expected.r30.payload as Row).answer_path, false);
  assertEquals(expected.r31_delete.event_type, "ghl.appointment_deleted");
});

Deno.test("an appointment receipt names the appointment and its contact, nothing else", async () => {
  const r = await run(await signed(R31_APPOINTMENT_CREATE), "enforce", ON);
  const g = ghlReceipt(r);
  assertEquals(g.message_id, "r31ApptPlaceholder01");
  assertEquals(g.contact_id, "r31-contact-placeholder");
  assertNoText(r, ["Appointment title for the R31 fixture"]);
});

Deno.test("rank-10 events must come signed by the app: the workflow secret alone is refused when enforcing", async () => {
  const r = await run(await post(R25_NOTE_CREATE, "secret"), "enforce", ON);
  assertEquals(r.res.status, 401);
  assertEquals(captureCalls(r).length, 0);
  assertEquals(ghlReceipt(r).outcome, "unauthorized");
});
