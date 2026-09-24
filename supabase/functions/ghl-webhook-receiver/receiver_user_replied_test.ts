// UserReplied behaviour tests: a GHL workflow (trigger User Replied, a staff
// reply) posts type, contactId, locationId and conversationId with the shared
// secret. Like CustomerReplied it is a doorbell: nothing is written from its
// body; one targeted read (newest 20) saves each message through the shared
// builder and capture_business_event under ghl:<GHL message id>, behind flag
// ghl_message_capture_v2. Exactly like CustomerReplied, the contact's newest
// conversation is read; a conversationId in the post is ignored.
// Driven through the real handler with the R10 items recorded read only from
// GHL (ghl_message_fixtures.ts). No network, no live GHL, no production
// credentials.
// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  R10_INBOUND,
  R10_OUTBOUND,
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

const CONTACT = R10_OUTBOUND.contactId;
const CONVERSATION = R10_OUTBOUND.conversationId;
/** A second, older conversation of the same contact (not the newest). */
const OLDER_CONVERSATION = "r10-older-conversation";

/** R10's conversation: the customer's text and the staff reply to it. */
const CONVERSATION_ITEMS = [R10_INBOUND, R10_OUTBOUND] as unknown as Row[];

const STAFF_KEY = `ghl:${R10_OUTBOUND.id}`;
const INBOUND_KEY = `ghl:${R10_INBOUND.id}`;

/** The User Replied workflow's Custom Webhook post. No message id, no text. */
const USER_REPLIED = {
  type: "UserReplied",
  contactId: CONTACT,
  locationId: TEST_LOCATION_ID,
  conversationId: CONVERSATION,
};
const { conversationId: _omit, ...USER_REPLIED_NO_CONVERSATION } = USER_REPLIED;

/** The newest-conversation read path every reply doorbell makes. */
const NEWEST_READ = [
  `/contacts/${CONTACT}`,
  "/conversations/search",
  `/contacts/${CONTACT}`,
  `/conversations/${CONVERSATION}`,
  `/conversations/${CONVERSATION}/messages`,
];

/**
 * GHL as the provider reads see it: the contact, whose newest conversation is
 * `newest`, and that conversation's messages.
 */
function provider(newest: string) {
  const seen: string[] = [];
  const json = (b: unknown) =>
    new Response(JSON.stringify(b), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const owner: Record<string, string> = {
    [CONVERSATION]: CONTACT,
    [OLDER_CONVERSATION]: CONTACT,
  };
  const answer = (url: string): Response => {
    const u = new URL(url);
    seen.push(u.pathname);
    if (u.pathname === `/contacts/${CONTACT}`) {
      return json({ contact: { id: CONTACT, locationId: TEST_LOCATION_ID } });
    }
    if (u.pathname === "/conversations/search") {
      if (u.searchParams.get("contactId") !== CONTACT) {
        return new Response("wrong contact", { status: 400 });
      }
      return json({
        conversations: [{
          id: newest,
          contactId: CONTACT,
          locationId: TEST_LOCATION_ID,
        }],
        total: 1,
      });
    }
    const conv = u.pathname.match(/^\/conversations\/([^/]+)(\/messages)?$/);
    if (conv && owner[conv[1]]) {
      if (!conv[2]) {
        return json({
          conversation: {
            id: conv[1],
            locationId: TEST_LOCATION_ID,
            contactId: owner[conv[1]],
          },
        });
      }
      if (u.searchParams.get("limit") !== "20") {
        return new Response("expected the newest 20", { status: 400 });
      }
      const items = conv[1] === CONVERSATION ? CONVERSATION_ITEMS : [];
      return json({
        messages: {
          messages: items.map((m) => ({
            ...m,
            locationId: TEST_LOCATION_ID,
          })),
          nextPage: false,
          lastMessageId: null,
        },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { answer, seen };
}

/** business_events keyed on provider_message_id, as capture_business_event answers. */
class KeyedStore {
  rows = new Map<string, Row>();
  capture = (row: Row): { data: unknown; error: unknown } => {
    const key = String(row.provider_message_id);
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

Deno.test("UserReplied ignores the post's conversation id, reads the contact's newest conversation and saves the staff reply under ghl:<id>", async () => {
  const store = new KeyedStore();
  const gh = provider(CONVERSATION);
  const r = await run(
    await post(
      { ...USER_REPLIED, conversationId: OLDER_CONVERSATION },
      "secret",
    ),
    "enforce",
    { ...ON, capture: store.capture },
    TOKEN,
    gh.answer,
  );
  assertEquals(r.res.status, 200);
  const rows = captureRows(r);
  assertEquals(evidenceRows(r).length, rows.length);
  assertEquals(rows.map((row) => row.provider_message_id), [
    INBOUND_KEY,
    STAFF_KEY,
  ]);
  const staff = store.rows.get(STAFF_KEY)!;
  assertEquals(staff.channel, "sms");
  assertEquals(staff.direction, "outbound");
  assertEquals(staff.source, "ghl-webhook-receiver");
  assertEquals(staff.contact_id, CONTACT);
  assertEquals(staff.job_id, null, "the ladder places the reply");
  assertEquals((staff.metadata as Row).capture_mode, "live");

  assertFalse(
    gh.seen.some((p) => p.includes(OLDER_CONVERSATION)),
    "the posted conversation id is never read",
  );
  assertEquals(gh.seen, NEWEST_READ);
  const g = ghlReceipt(r);
  assertEquals(g.event_type, "UserReplied");
  assertEquals(g.outcome, "skipped");
  assertEquals(g.reason, "user_reply_doorbell");
  assertEquals(g.auth, "workflow_secret");
  assertEquals(g.contact_id, CONTACT);
  assertEquals(g.message_id, null);
  assertEquals(g.targeted_read, "ok");
  assertEquals(g.targeted_inserted, 2);
  const rec = receipt(r);
  for (
    const secret of ["ghl-token-for-tests", R10_OUTBOUND.body, R10_INBOUND.body]
  ) {
    assertFalse(r.logs.includes(secret), `logs carry ${secret}`);
    assertFalse(JSON.stringify(rec).includes(secret), `receipt ${secret}`);
    assertFalse(JSON.stringify(g).includes(secret), `ghl receipt ${secret}`);
  }
});

Deno.test("UserReplied without a conversation id reads the contact's newest conversation", async () => {
  const store = new KeyedStore();
  const gh = provider(CONVERSATION);
  const r = await run(
    await post(USER_REPLIED_NO_CONVERSATION, "secret"),
    "enforce",
    { ...ON, capture: store.capture },
    TOKEN,
    gh.answer,
  );
  assertEquals(r.res.status, 200);
  assertEquals([...store.rows.keys()], [INBOUND_KEY, STAFF_KEY]);
  assertEquals(gh.seen, NEWEST_READ);
  assertEquals(ghlReceipt(r).reason, "user_reply_doorbell");
});

Deno.test("UserReplied twice for the same reply: the second post writes nothing new", async () => {
  const store = new KeyedStore();
  for (const expected of [2, 0]) {
    const r = await run(
      await post(USER_REPLIED, "secret"),
      "enforce",
      { ...ON, capture: store.capture },
      TOKEN,
      provider(CONVERSATION).answer,
    );
    assertEquals(r.res.status, 200);
    assertEquals(ghlReceipt(r).targeted_inserted, expected);
  }
  assertEquals(store.rows.size, 2);
});

Deno.test("UserReplied is a secret-checked workflow post: no proof or an app signature alone is refused when enforcing", async () => {
  for (const proof of ["none", "signature"] as const) {
    const gh = provider(CONVERSATION);
    const r = await run(
      await post(USER_REPLIED, proof),
      "enforce",
      ON,
      TOKEN,
      gh.answer,
    );
    assertEquals(r.res.status, 401, proof);
    assertEquals(evidenceRows(r).length, 0, proof);
    assertEquals(gh.seen.length, 0, `${proof}: no provider read`);
  }
});

Deno.test("UserReplied without the secret in observe mode is processed and recorded auth missing", async () => {
  const store = new KeyedStore();
  const r = await run(
    await post(USER_REPLIED, "none"),
    "observe",
    { ...ON, capture: store.capture },
    TOKEN,
    provider(CONVERSATION).answer,
  );
  assertEquals(r.res.status, 200);
  assertEquals(receipt(r).payload.auth, "missing");
  assertEquals(ghlReceipt(r).auth, "missing");
  assertEquals(ghlReceipt(r).reason, "user_reply_doorbell");
});

Deno.test("UserReplied with the flag off writes nothing and makes no read", async () => {
  const gh = provider(CONVERSATION);
  const r = await run(
    await post(USER_REPLIED, "secret"),
    "enforce",
    OFF,
    TOKEN,
    gh.answer,
  );
  assertEquals(r.res.status, 200);
  assertEquals(evidenceRows(r).length, 0);
  assertEquals(captureRows(r).length, 0);
  assertEquals(gh.seen.length, 0);
  const g = ghlReceipt(r);
  assertEquals(g.outcome, "capture_disabled");
  assertEquals(g.reason, "flag_off");
});
