// Slice T1, finding T1-002 (firstmate ruling A2): before a client.call_logged
// row is written, the one legacy client.call_complete row of the same contact
// around the call is recorded in payload.legacy_event_id; none or several means
// the row is written as normal; existing rows are never edited. Driven with the
// recorded N1 and N3 call items (transcripts.md §10). The legacy rows stand for
// the receiver's CallCompleted rows: GHL's workflow post carries no provider
// time, so a legacy row is stamped only with its arrival (occurred_at), which
// is when the call ended. Legacy row ids are placeholders.
// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  LEGACY_CALL_PAIR_WINDOW_SECONDS,
  legacyCallWindow,
  pairLegacyCall,
} from "./ghl_call_pair.ts";
import { buildGhlMessageRow } from "./ghl_message.ts";
import { N1_CALL_ITEM, N3_CALL_ITEM } from "./ghl_message_fixtures.ts";
import {
  legacyCallClient,
  type StoredEvent,
} from "./ghl_call_pair_test_support.ts";

const CONTACT = N1_CALL_ITEM.contactId;
const LEGACY_N1 = "aaaaaaaa-0000-4000-8000-000000000001";
const LEGACY_N1_RETRY = "aaaaaaaa-0000-4000-8000-000000000002";
const LEGACY_N3 = "aaaaaaaa-0000-4000-8000-000000000003";

function callRow(item: Record<string, unknown>): Record<string, unknown> {
  const built = buildGhlMessageRow(item, {
    source: "ghl-webhook-receiver",
    captureMode: "live",
  });
  if (built.kind !== "row") throw new Error(`skip ${built.reason}`);
  return built.row;
}

/** N1: started 07:40:55Z, 109 s; its CallCompleted post landed 07:43:06Z. */
const n1Legacy: StoredEvent = {
  id: LEGACY_N1,
  event_type: "client.call_complete",
  contact_id: CONTACT,
  event_at: null,
  occurred_at: "2026-09-23T07:43:06.000Z",
  provider_message_id: null,
  payload: { duration: 109, direction: "inbound" },
};
/** N3 (21 Sep): its own legacy row, two days earlier. */
const n3Legacy: StoredEvent = {
  id: LEGACY_N3,
  event_type: "client.call_complete",
  contact_id: CONTACT,
  event_at: null,
  occurred_at: "2026-09-21T23:17:53.000Z",
  provider_message_id: null,
  payload: { duration: 67, direction: "outbound" },
};

Deno.test("T1-002 exactly one: N1 records its one legacy CallCompleted row; the input row and the legacy row are unchanged", async () => {
  const events = [structuredClone(n1Legacy), structuredClone(n3Legacy)];
  const before = structuredClone(events);
  const { client } = legacyCallClient(events);
  const row = callRow(N1_CALL_ITEM);
  const frozen = structuredClone(row);
  const out = await pairLegacyCall(client, row);
  assertEquals(out.outcome, "paired");
  assertEquals(
    (out.row.payload as Record<string, unknown>).legacy_event_id,
    LEGACY_N1,
  );
  // Only the new row carries the pairing; nothing else about it changes.
  assertEquals(
    {
      ...out.row,
      payload: { ...(out.row.payload as object), legacy_event_id: undefined },
    },
    {
      ...frozen,
      payload: { ...(frozen.payload as object), legacy_event_id: undefined },
    },
  );
  assertEquals(row, frozen, "the built row is not mutated");
  assertEquals(events, before, "existing rows are never edited");
});

Deno.test("T1-002 exactly one: N3 (outbound, 67 s) pairs with its own legacy row, not N1's", async () => {
  const { client } = legacyCallClient([n1Legacy, n3Legacy]);
  const out = await pairLegacyCall(client, callRow(N3_CALL_ITEM));
  assertEquals(out.outcome, "paired");
  assertEquals(
    (out.row.payload as Record<string, unknown>).legacy_event_id,
    LEGACY_N3,
  );
});

Deno.test("T1-002 none: no legacy row for the contact around the call writes the row as normal", async () => {
  for (
    const events of [
      [],
      [n3Legacy], // same contact, two days away
      [{ ...n1Legacy, contact_id: "someOtherContact01" }], // right time, other contact
      [{ ...n1Legacy, event_type: "client.call_logged" }], // not a legacy row
    ]
  ) {
    const row = callRow(N1_CALL_ITEM);
    const out = await pairLegacyCall(legacyCallClient(events).client, row);
    assertEquals(out.outcome, "none");
    assertEquals(out.row, row);
    assertFalse("legacy_event_id" in (out.row.payload as object));
  }
});

Deno.test("T1-002 several: two legacy rows around one call (a retried workflow post) writes the row as normal", async () => {
  const retry = {
    ...n1Legacy,
    id: LEGACY_N1_RETRY,
    occurred_at: "2026-09-23T07:43:40.000Z",
  };
  const row = callRow(N1_CALL_ITEM);
  const out = await pairLegacyCall(
    legacyCallClient([n1Legacy, retry]).client,
    row,
  );
  assertEquals(out.outcome, "several");
  assertEquals(out.row, row);
});

Deno.test("T1-002 a legacy row another call already records is not reused; a replay of the same call pairs again", async () => {
  const otherCall: StoredEvent = {
    id: "bbbbbbbb-0000-4000-8000-000000000001",
    event_type: "client.call_logged",
    contact_id: CONTACT,
    provider_message_id: "ghl:someEarlierCall01",
    payload: { legacy_event_id: LEGACY_N1 },
  };
  const row = callRow(N1_CALL_ITEM);
  const claimed = await pairLegacyCall(
    legacyCallClient([n1Legacy, otherCall]).client,
    row,
  );
  assertEquals(claimed.outcome, "already_paired");
  assertEquals(claimed.row, row);

  const sameCall = {
    ...otherCall,
    provider_message_id: row.provider_message_id as string,
  };
  const replay = await pairLegacyCall(
    legacyCallClient([n1Legacy, sameCall]).client,
    row,
  );
  assertEquals(replay.outcome, "paired");
  assertEquals(
    (replay.row.payload as Record<string, unknown>).legacy_event_id,
    LEGACY_N1,
  );
});

Deno.test("T1-002 an unreadable lookup (error or throw) writes the row as normal", async () => {
  const row = callRow(N1_CALL_ITEM);
  for (
    const opts of [
      { error: { code: "57014", message: "canceling statement" } },
      { throws: true },
    ]
  ) {
    const out = await pairLegacyCall(
      legacyCallClient([n1Legacy], opts).client,
      row,
    );
    assertEquals(out.outcome, "unreadable");
    assertEquals(out.row, row);
  }
});

Deno.test("T1-002 the window: 120 s before the call started to 120 s after it ended; a provider time wins over arrival time", async () => {
  const row = callRow(N1_CALL_ITEM); // 07:40:55.171Z + 109 s
  assertEquals(LEGACY_CALL_PAIR_WINDOW_SECONDS, 120);
  assertEquals(legacyCallWindow(row), {
    from: "2026-09-23T07:38:55.171Z",
    to: "2026-09-23T07:44:44.171Z",
  });
  const at = async (legacy: Partial<StoredEvent>) =>
    (await pairLegacyCall(
      legacyCallClient([{ ...n1Legacy, ...legacy }]).client,
      row,
    )).outcome;
  assertEquals(await at({ occurred_at: "2026-09-23T07:44:44.171Z" }), "paired");
  assertEquals(await at({ occurred_at: "2026-09-23T07:44:44.172Z" }), "none");
  assertEquals(await at({ occurred_at: "2026-09-23T07:38:55.171Z" }), "paired");
  assertEquals(await at({ occurred_at: "2026-09-23T07:38:55.170Z" }), "none");
  // A legacy row with its own provider time is judged by that time.
  assertEquals(
    await at({
      event_at: "2026-09-23T07:41:00.000Z",
      occurred_at: "2026-09-23T09:00:00.000Z",
    }),
    "paired",
  );
  assertEquals(
    await at({
      event_at: "2026-09-23T09:00:00.000Z",
      occurred_at: "2026-09-23T07:43:06.000Z",
    }),
    "none",
  );
  // A voicemail with no duration: the window is 120 s either side of its start.
  const vm = callRow({
    ...N1_CALL_ITEM,
    status: "voicemail",
    meta: { call: { duration: null, status: "voicemail" } },
  });
  assertEquals(legacyCallWindow(vm), {
    from: "2026-09-23T07:38:55.171Z",
    to: "2026-09-23T07:42:55.171Z",
  });
});

Deno.test("T1-002 not a call, or a call with no contact or time: no lookup, written as normal", async () => {
  const { client, queries } = legacyCallClient([n1Legacy]);
  const text = {
    event_type: "client.reply",
    contact_id: CONTACT,
    event_at: "2026-09-23T07:41:00.000Z",
    payload: {},
  };
  assertEquals((await pairLegacyCall(client, text)).outcome, "not_a_call");
  const untimed = { ...callRow(N1_CALL_ITEM), event_at: null };
  assertEquals((await pairLegacyCall(client, untimed)).outcome, "none");
  assertEquals(queries.length, 0, "no read for rows that cannot pair");
});
