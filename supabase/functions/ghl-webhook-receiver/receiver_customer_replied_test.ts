// CustomerReplied behaviour tests: a GHL workflow (trigger Customer Replied,
// reply channel SMS, Custom Webhook action) posts type, contactId and
// locationId with the shared secret. The post carries no GHL message id and
// usually no conversation id. It is a doorbell exactly like the slice T1
// CallCompleted doorbell: nothing is written from its body; one targeted read of
// the contact's newest conversation (newest 20) saves each message through the
// shared builder and capture_business_event under ghl:<GHL message id>, behind
// flag ghl_message_capture_v2. The 15-minute reconciler uses the same key, so
// a text is saved once.
// Driven through the real handler and the real reconciler with the R9 and
// N1 to N3 items recorded read only from GHL (ghl_message_fixtures.ts). No
// network, no live GHL, no production credentials.
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
  R9_WEBHOOK,
} from "../_shared/evidence/ghl_message_fixtures.ts";
import {
  type ReconcileDeps,
  runGhlMessageReconcile,
  type RunRow,
} from "../ghl-message-reconcile/reconcile.ts";
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
 * R9's recorded inbound text ("are the guys coming today?", to 774) as the
 * conversation message list serves it. R9 is the SWP-26941 contact, whose only
 * GHL conversation holds N1 to N3, so the text sits in that conversation.
 */
const R9_TEXT = {
  id: R9_WEBHOOK.messageId,
  messageType: "TYPE_SMS",
  direction: "inbound",
  status: "delivered",
  to: R9_WEBHOOK.to,
  from: "+61400000000",
  body: R9_WEBHOOK.body,
  contactId: CONTACT,
  conversationId: CONVERSATION,
  dateAdded: R9_WEBHOOK.dateAdded,
};
assertEquals(R9_WEBHOOK.contactId, CONTACT, "R9 is the N1 to N3 contact");

/** The conversation's newest messages: R9's reply and the three calls. */
const CONVERSATION_ITEMS = [
  N1_CALL_ITEM,
  R9_TEXT,
  N2_CALL_ITEM,
  N3_CALL_ITEM,
] as unknown as Row[];

/**
 * The Customer Replied workflow's Custom Webhook post: exactly the custom data
 * the workflow is built with (type, contactId, locationId). No message id, no
 * conversation id, no text.
 */
const CUSTOMER_REPLIED = {
  type: "CustomerReplied",
  contactId: CONTACT,
  locationId: TEST_LOCATION_ID,
};

const onOurLocation = (item: Row) => ({
  ...item,
  locationId: TEST_LOCATION_ID,
});

/** GHL as the provider reads see it: the contact, its one conversation, and the newest messages. */
function provider(messages: Row[]) {
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
        conversations: [{
          id: CONVERSATION,
          contactId: CONTACT,
          locationId: TEST_LOCATION_ID,
        }],
        total: 1,
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
      if (u.searchParams.get("limit") !== "20") {
        return new Response("expected the newest 20", { status: 400 });
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

/**
 * business_events keyed on provider_message_id, answering as
 * capture_business_event does: a key already held is a duplicate. Shared by the
 * receiver runs and the reconciler so a second door sees the first door's row.
 */
class KeyedStore {
  rows = new Map<string, Row>();
  writes: string[] = [];
  capture = (row: Row): { data: unknown; error: unknown } => {
    const key = String(row.provider_message_id);
    this.writes.push(key);
    if (this.rows.has(key)) {
      return {
        data: {
          outcome: "duplicate",
          id: "66666666-6666-4666-8666-666666666666",
          upgraded: false,
        },
        error: null,
      };
    }
    this.rows.set(key, row);
    return {
      data: {
        outcome: "inserted",
        id: `77777777-7777-4777-8777-${
          String(this.rows.size).padStart(12, "0")
        }`,
      },
      error: null,
    };
  };
}

const captureRows = (r: Run) =>
  r.rpcCalls.filter((c) => c.name === "capture_business_event").map((c) =>
    c.args?.p_row as Row
  );

const R9_KEY = `ghl:${R9_TEXT.id}`;

// ── flag on: a doorbell only ────────────────────────────────

Deno.test("CustomerReplied with only a contact id: nothing from its body; the newest inbound text is saved under ghl:<id> through the one writer", async () => {
  const store = new KeyedStore();
  const gh = provider(CONVERSATION_ITEMS);
  const r = await run(
    await post(CUSTOMER_REPLIED, "secret"),
    "enforce",
    { ...ON, capture: store.capture },
    TOKEN,
    gh.answer,
  );
  assertEquals(r.res.status, 200);
  const rows = captureRows(r);
  // Every business_events write went through capture_business_event.
  assertEquals(evidenceRows(r).length, rows.length);
  assertEquals(rows.map((row) => row.provider_message_id), [
    "ghl:6kn6WmrtfTMvhEJtmfeJ",
    R9_KEY,
    "ghl:Py9PovOwc4I4vNkn9jXg",
    "ghl:0Gct0u0TQNZox8DRAVLo",
  ]);
  const text = store.rows.get(R9_KEY)!;
  assertEquals(text.event_type, "client.reply");
  assertEquals(text.channel, "sms");
  assertEquals(text.direction, "inbound");
  assertEquals(text.source, "ghl-webhook-receiver");
  assertEquals(text.contact_id, CONTACT);
  assertEquals(text.job_id, null, "the ladder places the text");
  assertEquals(text.thread_key, null);
  assertEquals(text.event_at, R9_TEXT.dateAdded);
  assertEquals((text.metadata as Row).capture_mode, "live");
  assertEquals((text.payload as Row).body, R9_TEXT.body);
  assertEquals((text.payload as Row).line, "patio");

  // The post names the contact only: its newest conversation is found, then
  // read once (newest 20).
  assertEquals(gh.seen, [
    `/contacts/${CONTACT}`,
    "/conversations/search",
    `/contacts/${CONTACT}`,
    `/conversations/${CONVERSATION}`,
    `/conversations/${CONVERSATION}/messages`,
  ]);
  const g = ghlReceipt(r);
  assertEquals(g.event_type, "CustomerReplied");
  assertEquals(g.outcome, "skipped");
  assertEquals(g.reason, "reply_doorbell");
  assertEquals(g.auth, "workflow_secret");
  assertEquals(g.contact_id, CONTACT);
  assertEquals(g.message_id, null);
  assertEquals(g.event_id, null);
  assertEquals(g.targeted_read, "ok");
  assertEquals(g.targeted_seen, 4);
  assertEquals(g.targeted_inserted, 4);
  assertEquals(g.targeted_errors, 0);
  const rec = receipt(r);
  assertEquals(rec.payload.type, "CustomerReplied");
  assertEquals(rec.payload.outcome, "skipped");
  assertEquals(rec.payload.auth, "workflow_secret");
  // Receipts and logs stay ids-only.
  for (
    const secret of ["ghl-token-for-tests", "+61400000000", R9_TEXT.body]
  ) {
    assertFalse(r.logs.includes(secret), `logs carry ${secret}`);
    assertFalse(JSON.stringify(rec).includes(secret), `receipt ${secret}`);
    assertFalse(JSON.stringify(g).includes(secret), `ghl receipt ${secret}`);
  }
});

Deno.test("CustomerReplied: a body conversation id is ignored; the contact's newest conversation is read", async () => {
  const store = new KeyedStore();
  const gh = provider(CONVERSATION_ITEMS);
  const r = await run(
    await post(
      { ...CUSTOMER_REPLIED, conversationId: "another-valid-conversation-id" },
      "secret",
    ),
    "enforce",
    { ...ON, capture: store.capture },
    TOKEN,
    gh.answer,
  );
  assertEquals(r.res.status, 200);
  assert(store.rows.has(R9_KEY));
  assertFalse(gh.seen.includes("/conversations/another-valid-conversation-id"));
  assertEquals(ghlReceipt(r).reason, "reply_doorbell");
});

Deno.test("CustomerReplied twice for the same text: the second post writes nothing new", async () => {
  const store = new KeyedStore();
  const first = await run(
    await post(CUSTOMER_REPLIED, "secret"),
    "enforce",
    { ...ON, capture: store.capture },
    TOKEN,
    provider(CONVERSATION_ITEMS).answer,
  );
  assertEquals(first.res.status, 200);
  assertEquals(store.rows.size, 4);
  const saved = new Map(store.rows);

  const second = await run(
    await post(CUSTOMER_REPLIED, "secret"),
    "enforce",
    { ...ON, capture: store.capture },
    TOKEN,
    provider(CONVERSATION_ITEMS).answer,
  );
  assertEquals(second.res.status, 200);
  assertEquals(store.rows.size, 4, "no new row");
  assertEquals(store.rows, saved, "existing rows untouched");
  const g = ghlReceipt(second);
  assertEquals(g.outcome, "skipped");
  assertEquals(g.targeted_inserted, 0);
  assertEquals(g.targeted_duplicates, 4);
});

// ── the reconciler shares the key ─────────────────────────

const RECONCILE_NOW = Date.parse("2026-09-23T08:00:00.000Z");

/**
 * The reconciler's dependencies over the same keyed store and the same GHL
 * conversation, with a previous complete scan whose floors reach back past R9.
 */
function reconcileDeps(store: KeyedStore): ReconcileDeps {
  const runs: RunRow[] = [{
    id: "prev-run",
    status: "succeeded",
    started_at: "2026-09-23T07:45:00.000Z",
    updated_at: "2026-09-23T07:45:00.000Z",
    watermark: "2026-09-23T07:45:00.000Z",
    cursor: {
      v: 1,
      scan_top: "2026-09-23T07:45:00.000Z",
      list_floor: "2026-09-22T22:00:00.000Z",
      message_floor: "2026-09-22T22:00:00.000Z",
      position: null,
      complete: true,
    },
  }];
  const items: Row[] = CONVERSATION_ITEMS.map(onOurLocation);
  const newestMs = Math.max(
    ...items.map((m) => Date.parse(String(m.dateAdded))),
  );
  return {
    now: () => RECONCILE_NOW,
    itemFlagOn: () => Promise.resolve(true),
    captureLaneOn: () => Promise.resolve(true),
    latestRuns: (n) => Promise.resolve(runs.slice(0, n)),
    recordRun: (row) => {
      const id = String(row.run_id ?? "reconcile-run");
      const existing = runs.find((r) => r.id === id);
      if (existing) {
        Object.assign(existing, row);
      } else {
        runs.unshift({
          id,
          status: (row.status as RunRow["status"]) ?? "running",
          started_at: new Date(RECONCILE_NOW).toISOString(),
          updated_at: new Date(RECONCILE_NOW).toISOString(),
          watermark: (row.watermark as string | null) ?? null,
          cursor: row.cursor ?? null,
        });
      }
      return Promise.resolve(id);
    },
    listRecentConversations: ({ startAfterDate }) =>
      Promise.resolve({
        conversations: startAfterDate && Number(startAfterDate) <= newestMs
          ? []
          : [{
            id: CONVERSATION,
            contactId: CONTACT,
            locationId: TEST_LOCATION_ID,
            lastMessageDate: newestMs,
          }],
        hasMore: false,
      }),
    listMessages: () =>
      Promise.resolve({
        messages: [...items].sort((a, b) =>
          Date.parse(String(b.dateAdded)) - Date.parse(String(a.dateAdded))
        ),
        hasMore: false,
        nextLastMessageId: null,
      }),
    existingKeys: (keys) =>
      Promise.resolve(new Set(keys.filter((k) => store.rows.has(k)))),
    capture: (row) => {
      const out = store.capture(row).data as { outcome: string; id?: string };
      return Promise.resolve(
        out.outcome === "inserted"
          ? { outcome: "inserted", id: out.id }
          : { outcome: "duplicate", id: out.id },
      );
    },
    pairLegacyCall: (row) => Promise.resolve({ row, outcome: "none" }),
  };
}

Deno.test("control: without the doorbell, the reconciler pass reads R9's text and saves it under the same ghl:<id> key", async () => {
  const store = new KeyedStore();
  const result = await runGhlMessageReconcile(reconcileDeps(store));
  assert(result.outcome === "ran");
  assertEquals(result.status, "succeeded");
  assert(store.rows.has(R9_KEY), "the reconciler reads and keys R9's text");
  assertEquals(store.rows.get(R9_KEY)!.source, "ghl-message-reconcile");
});

Deno.test("a reconciler pass after the CustomerReplied doorbell writes nothing new", async () => {
  const store = new KeyedStore();
  const doorbell = await run(
    await post(CUSTOMER_REPLIED, "secret"),
    "enforce",
    { ...ON, capture: store.capture },
    TOKEN,
    provider(CONVERSATION_ITEMS).answer,
  );
  assertEquals(doorbell.res.status, 200);
  const saved = new Map(store.rows);
  const writesBefore = store.writes.length;

  const result = await runGhlMessageReconcile(reconcileDeps(store));
  assert(result.outcome === "ran");
  assertEquals(result.status, "succeeded");
  assert(result.counts.items_seen >= 3, "the reconciler read the conversation");
  assertEquals(result.counts.inserted, 0);
  assertEquals(result.counts.write_errors, 0);
  assertEquals(store.rows, saved, "no new or changed row");
  assertFalse(
    store.writes.slice(writesBefore).includes(R9_KEY),
    "R9's text is never written a second time",
  );
  assertEquals(store.rows.get(R9_KEY)!.source, "ghl-webhook-receiver");
});

// ── auth and the flag ─────────────────────────────────────

Deno.test("CustomerReplied without the secret in observe mode is processed and recorded auth missing", async () => {
  const store = new KeyedStore();
  const r = await run(
    await post(CUSTOMER_REPLIED, "none"),
    "observe",
    { ...ON, capture: store.capture },
    TOKEN,
    provider(CONVERSATION_ITEMS).answer,
  );
  assertEquals(r.res.status, 200);
  const rec = receipt(r);
  assertEquals(rec.payload.auth, "missing");
  assertEquals(rec.payload.auth_detail, "no_proof");
  assertEquals(rec.payload.auth_mode, "observe");
  const g = ghlReceipt(r);
  assertEquals(g.auth, "missing");
  assertEquals(g.auth_detail, "no_proof");
  assertEquals(g.auth_mode, "observe");
  assertEquals(g.reason, "reply_doorbell");
});

Deno.test("CustomerReplied is a secret-checked workflow post: an app signature alone or no proof is refused when enforcing", async () => {
  for (const proof of ["none", "signature"] as const) {
    const gh = provider(CONVERSATION_ITEMS);
    const r = await run(
      await post(CUSTOMER_REPLIED, proof),
      "enforce",
      ON,
      TOKEN,
      gh.answer,
    );
    assertEquals(r.res.status, 401, proof);
    assertEquals(evidenceRows(r).length, 0, proof);
    assertEquals(gh.seen.length, 0, `${proof}: no provider read`);
    assertEquals(receipt(r).payload.outcome, "unauthorized", proof);
  }
});

Deno.test("CustomerReplied with the flag off, missing or unreadable writes nothing and makes no read", async () => {
  for (
    const [label, db] of [
      ["off", OFF],
      ["missing", { flags: { some_other_flag: true } }],
      [
        "unreadable",
        { flagReadError: { code: "57014", message: "statement timeout" } },
      ],
    ] as const
  ) {
    const gh = provider(CONVERSATION_ITEMS);
    const r = await run(
      await post(CUSTOMER_REPLIED, "secret"),
      "enforce",
      db,
      TOKEN,
      gh.answer,
    );
    assertEquals(r.res.status, 200, label);
    assertEquals(evidenceRows(r).length, 0, `${label}: nothing written`);
    assertEquals(captureRows(r).length, 0, label);
    assertEquals(gh.seen.length, 0, `${label}: no provider read`);
    const g = ghlReceipt(r);
    assertEquals(g.outcome, "capture_disabled", label);
    assertEquals(g.reason, "flag_off", label);
    assertEquals(receipt(r).payload.outcome, "capture_disabled", label);
  }
});

Deno.test("CustomerReplied with the capture lane off answers capture_disabled before any read", async () => {
  const gh = provider(CONVERSATION_ITEMS);
  const r = await run(
    await post(CUSTOMER_REPLIED, "secret"),
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
