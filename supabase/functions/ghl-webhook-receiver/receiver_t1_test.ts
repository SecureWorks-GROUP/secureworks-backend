// Slice T1 behaviour tests (transcripts.md §2 review B2, §10 N1 to N3): the
// receiver's CallCompleted post branches on flag ghl_message_capture_v2.
//   * Off (the shipped state), missing: today's legacy client.call_complete
//     row is written, so every call still reaches the job read.
//   * On: a doorbell only. The post writes nothing itself; one targeted read of
//     the contact's newest conversation saves each call item once, through the shared
//     builder and capture_business_event, as client.call_logged under
//     ghl:<GHL message id>.
// Driven through the real handler with the N1 to N3 call items recorded read
// only from GHL on 24 Sep 2026 (ghl_message_fixtures.ts). No network, no live
// GHL, no production credentials.
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  N1_CALL_ITEM,
  N2_CALL_ITEM,
  N3_CALL_ITEM,
} from "../_shared/evidence/ghl_message_fixtures.ts";
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
const TOKEN = { GHL_API_TOKEN: "ghl-token-for-tests" };

const CONTACT = N1_CALL_ITEM.contactId;
const CONVERSATION = N1_CALL_ITEM.conversationId;

/**
 * N1's CallCompleted workflow post, with exactly the key set GHL's workflow
 * posts (read from production webhook_log on 24 Sep 2026, key names only):
 * callStatus, contactEmail, contactId, contactName, direction, duration,
 * eventId, from, locationId, phone, recordingUrl, to, type, voicemail,
 * workflowId. It carries no conversation id and no GHL message id. Values are
 * N1's call facts; name, email, phone, event id and recording link are
 * placeholders.
 */
const N1_CALL_COMPLETED = {
  type: "CallCompleted",
  callStatus: "completed",
  contactEmail: "placeholder@example.test",
  contactId: CONTACT,
  contactName: "N1 caller placeholder",
  direction: "inbound",
  duration: 109,
  eventId: "n1-workflow-event-placeholder",
  from: "+61400000000",
  locationId: TEST_LOCATION_ID,
  phone: "+61400000000",
  recordingUrl: "https://recordings.example.test/n1-placeholder.mp3",
  to: "+61489267774",
  voicemail: false,
  workflowId: "wf-call-completed",
};

/** A post naming another conversation; the receiver must still resolve the newest one. */
const N1_CALL_COMPLETED_WITH_CONVERSATION = {
  ...N1_CALL_COMPLETED,
  conversationId: "another-valid-conversation-id",
};

const onOurLocation = (item: Row) => ({
  ...item,
  locationId: TEST_LOCATION_ID,
});

/** GHL as the provider reads see it: the contact, its one conversation, and the newest messages. */
function provider(
  messages: Row[],
  opts: { failMessages?: boolean; noConversations?: boolean } = {},
) {
  const seen: string[] = [];
  const answer = (url: string): Response => {
    const u = new URL(url);
    seen.push(u.pathname);
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (u.pathname === `/contacts/${CONTACT}`) {
      return json({ contact: { id: CONTACT, locationId: TEST_LOCATION_ID } });
    }
    if (u.pathname === "/conversations/search") {
      if (u.searchParams.get("contactId") !== CONTACT) {
        return new Response("wrong contact", { status: 400 });
      }
      return json({
        conversations: opts.noConversations ? [] : [{
          id: CONVERSATION,
          contactId: CONTACT,
          locationId: TEST_LOCATION_ID,
        }],
        total: opts.noConversations ? 0 : 1,
      });
    }
    if (u.pathname === `/conversations/${CONVERSATION}`) {
      return json({
        conversation: {
          id: CONVERSATION,
          locationId: TEST_LOCATION_ID,
          contactId: CONTACT,
        },
      });
    }
    if (u.pathname === `/conversations/${CONVERSATION}/messages`) {
      if (opts.failMessages) {
        return new Response("unavailable", { status: 503 });
      }
      return json({
        messages: {
          messages: messages.map(onOurLocation),
          nextPage: false,
          lastMessageId: null,
        },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { answer, seen };
}

const CALLS = [N1_CALL_ITEM, N2_CALL_ITEM, N3_CALL_ITEM] as unknown as Row[];

const captureRows = (r: Run) =>
  r.rpcCalls.filter((c) => c.name === "capture_business_event").map((c) =>
    c.args?.p_row as Row
  );

const transcribeFetches = (r: Run) =>
  r.fetches.filter((f) => f.url.includes("/functions/v1/transcribe-call"));

// ── flag off: the legacy call row, as today ─────────────────

Deno.test("T1 flag off (shipped state): N1's CallCompleted writes today's legacy client.call_complete row; the builder writes nothing", async () => {
  const r = await run(await post(N1_CALL_COMPLETED, "secret"), "enforce", OFF);
  assertEquals(r.res.status, 200);
  assertEquals(captureRows(r).length, 0, "no call through the new writer");
  const rows = evidenceRows(r);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].event_type, "client.call_complete");
  assertEquals(rows[0].channel, "call");
  assertEquals(rows[0].direction, "inbound");
  assertEquals(rows[0].contact_id, CONTACT);
  assertEquals(rows[0].job_id, null);
  assertEquals((rows[0].payload as Row).duration, 109);
  assertEquals((rows[0].payload as Row).line_label, "patios");
  assertEquals(receipt(r).payload.outcome, "event_created");
  assertEquals(ghlReceipt(r).outcome, "event_created");
  // No provider read: the legacy path makes no conversation read.
  assertFalse(r.fetches.some((f) => f.url.includes("leadconnectorhq")));
});

Deno.test("T1 flag missing reads as off: the legacy row is still written (fail closed to today's behaviour)", async () => {
  const r = await run(await post(N1_CALL_COMPLETED, "secret"), "enforce", {
    flags: { some_other_flag: true },
  });
  assertEquals(r.res.status, 200);
  assertEquals(evidenceRows(r).length, 1);
  assertEquals(evidenceRows(r)[0].event_type, "client.call_complete");
  assertEquals(captureRows(r).length, 0);
});

// ── flag on: a doorbell only ────────────────────────────────

Deno.test("T1 flag on: N1's CallCompleted writes nothing itself; one targeted read saves N1 to N3 once each as client.call_logged", async () => {
  const gh = provider(CALLS);
  const r = await run(
    await post(N1_CALL_COMPLETED, "secret"),
    "enforce",
    ON,
    TOKEN,
    gh.answer,
  );
  assertEquals(r.res.status, 200);
  const rows = captureRows(r);
  // Every business_events write went through capture_business_event: no legacy row.
  assertEquals(evidenceRows(r).length, rows.length);
  assertFalse(rows.some((row) => row.event_type === "client.call_complete"));
  assertEquals(rows.map((row) => row.provider_message_id), [
    "ghl:6kn6WmrtfTMvhEJtmfeJ",
    "ghl:Py9PovOwc4I4vNkn9jXg",
    "ghl:0Gct0u0TQNZox8DRAVLo",
  ]);
  for (const row of rows) {
    assertEquals(row.event_type, "client.call_logged");
    assertEquals(row.channel, "call");
    assertEquals(row.source, "ghl-webhook-receiver");
    assertEquals(row.contact_id, CONTACT);
    assertEquals(row.job_id, null, "the ladder places the call");
    assertEquals((row.metadata as Row).capture_mode, "live");
    assertEquals(row.thread_key, null);
  }
  const [n1, n2, n3] = rows;
  assertEquals(n1.direction, "inbound");
  assertEquals((n1.payload as Row).duration_seconds, 109);
  assertEquals(n1.event_at, "2026-09-23T07:40:55.171Z");
  assertEquals((n2.payload as Row).call_status, "voicemail");
  assertEquals(n3.direction, "outbound");
  assertEquals((n3.payload as Row).duration_seconds, 67);
  assertEquals((n3.payload as Row).source, "app");
  assertFalse("provider_source" in (n3.payload as Row));

  // No Whisper chain and no recording fetch on the doorbell.
  assertEquals(transcribeFetches(r).length, 0);
  assertFalse(r.fetches.some((f) => /recording/i.test(f.url)));
  // GHL's post names the contact only: its newest conversation is found,
  // then read once (newest 20). The recording link is never fetched.
  assertEquals(gh.seen, [
    `/contacts/${CONTACT}`,
    "/conversations/search",
    `/contacts/${CONTACT}`,
    `/conversations/${CONVERSATION}`,
    `/conversations/${CONVERSATION}/messages`,
  ]);
  const g = ghlReceipt(r);
  assertEquals(g.event_type, "CallCompleted");
  assertEquals(g.outcome, "skipped");
  assertEquals(g.reason, "call_doorbell");
  assertEquals(g.event_id, null);
  assertEquals(g.targeted_read, "ok");
  assertEquals(g.targeted_seen, 3);
  assertEquals(g.targeted_inserted, 3);
  assertEquals(g.targeted_errors, 0);
  assertEquals(receipt(r).payload.outcome, "skipped");
  for (
    const secret of [
      "ghl-token-for-tests",
      "+61400000000",
      "placeholder@example.test",
      "N1 caller placeholder",
      "n1-placeholder.mp3",
    ]
  ) {
    assertFalse(r.logs.includes(secret), `logs carry ${secret}`);
    assertFalse(
      JSON.stringify(receipt(r)).includes(secret),
      `receipt carries ${secret}`,
    );
    assertFalse(
      JSON.stringify(g).includes(secret),
      `ghl receipt carries ${secret}`,
    );
  }
});

Deno.test("T1 flag on: a body conversation id cannot bypass resolving the contact's newest conversation", async () => {
  const gh = provider(CALLS);
  const r = await run(
    await post(N1_CALL_COMPLETED_WITH_CONVERSATION, "secret"),
    "enforce",
    ON,
    TOKEN,
    gh.answer,
  );
  assertEquals(r.res.status, 200);
  assertEquals(captureRows(r).length, 3);
  assert(gh.seen.includes("/conversations/search"));
  assertFalse(gh.seen.includes("/conversations/another-valid-conversation-id"));
  assertEquals(gh.seen, [
    `/contacts/${CONTACT}`,
    "/conversations/search",
    `/contacts/${CONTACT}`,
    `/conversations/${CONVERSATION}`,
    `/conversations/${CONVERSATION}/messages`,
  ]);
  assertEquals(ghlReceipt(r).reason, "call_doorbell");
});

Deno.test("T1 flag on: a replayed doorbell lands on the same keys (duplicates), never a second row", async () => {
  const gh = provider(CALLS);
  const r = await run(
    await post(N1_CALL_COMPLETED, "secret"),
    "enforce",
    { ...ON, insertError: { code: "23505", message: "duplicate key" } },
    TOKEN,
    gh.answer,
  );
  assertEquals(r.res.status, 200);
  const g = ghlReceipt(r);
  assertEquals(g.outcome, "skipped");
  assertEquals(g.targeted_inserted, 0);
  assertEquals(g.targeted_duplicates, 3);
});

Deno.test("T1 flag on: when the read cannot run, nothing is written, 200, the reason is recorded and the reconciler covers the call", async () => {
  for (
    const [label, gh, extra, reason] of [
      ["provider down", provider(CALLS, { failMessages: true }), TOKEN, null],
      [
        "no conversation",
        provider(CALLS, { noConversations: true }),
        TOKEN,
        "no_conversation",
      ],
      [
        "provider not configured",
        provider(CALLS),
        {},
        "provider_not_configured",
      ],
    ] as const
  ) {
    const r = await run(
      await post(N1_CALL_COMPLETED, "secret"),
      "enforce",
      ON,
      extra,
      gh.answer,
    );
    assertEquals(r.res.status, 200, label);
    assertEquals(evidenceRows(r).length, 0, `${label}: nothing written`);
    assertEquals(transcribeFetches(r).length, 0, label);
    const g = ghlReceipt(r);
    assertEquals(g.outcome, "skipped", label);
    assert(g.reason && g.reason !== "call_doorbell", label);
    if (reason) assertEquals(g.reason, reason, label);
    assertEquals(g.targeted_inserted, 0, label);
  }
});

Deno.test("T1 flag on: a writer error on a call the read found answers 500 with the code only", async () => {
  const gh = provider([N1_CALL_ITEM] as unknown as Row[]);
  const r = await run(
    await post(N1_CALL_COMPLETED, "secret"),
    "enforce",
    { ...ON, insertError: { code: "57014", message: "canceling statement" } },
    TOKEN,
    gh.answer,
  );
  assertEquals(r.res.status, 500);
  const g = ghlReceipt(r);
  assertEquals(g.outcome, "error");
  assertEquals(g.error_code, "57014");
  assertEquals(g.targeted_errors, 1);
  assertEquals(receipt(r).status, "failed");
});

Deno.test("T1 flag on: the capture lane off still answers capture_disabled before any read", async () => {
  const gh = provider(CALLS);
  const r = await run(
    await post(N1_CALL_COMPLETED, "secret"),
    "enforce",
    { ...ON, laneOn: false },
    TOKEN,
    gh.answer,
  );
  assertEquals(r.res.status, 200);
  assertEquals(evidenceRows(r).length, 0);
  assertEquals(gh.seen.length, 0);
  assertEquals(ghlReceipt(r).outcome, "capture_disabled");
});

// ── one real call is one call (finding T1-002, ruling A2) ─────

Deno.test("T1-002 flag on: the doorbell's N1 row records the one legacy CallCompleted row; N2 (no legacy row) is written as normal; nothing existing is edited", async () => {
  const legacyN1 = {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    event_type: "client.call_complete",
    contact_id: CONTACT,
    event_at: null,
    occurred_at: "2026-09-23T07:43:06.000Z",
    provider_message_id: null,
    payload: { duration: 109 },
  };
  const gh = provider(CALLS);
  const r = await run(
    await post(N1_CALL_COMPLETED, "secret"),
    "enforce",
    { ...ON, events: [legacyN1] },
    TOKEN,
    gh.answer,
  );
  assertEquals(r.res.status, 200);
  const [n1, n2, n3] = captureRows(r);
  assertEquals(
    (n1.payload as Row).legacy_event_id,
    "aaaaaaaa-0000-4000-8000-000000000001",
  );
  assertFalse("legacy_event_id" in (n2.payload as Row));
  assertFalse("legacy_event_id" in (n3.payload as Row));
  assertEquals(
    ghlReceipt(r).targeted_inserted,
    3,
    "each call still written once",
  );
  assertEquals(
    r.ops.filter((o) => o.table === "business_events" && o.kind === "update")
      .length,
    0,
    "no existing row is edited",
  );
});
