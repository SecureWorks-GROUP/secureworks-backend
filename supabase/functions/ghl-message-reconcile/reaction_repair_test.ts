// C7 (3 Nov 2026): the operator's reaction repair. It saves the GHL text
// reactions capture skipped before reactions were captured, through the one
// builder and writer, as backfill rows marked reaction_repair; a dry run (the
// default) reads only. The GHL side is a fake location that answers like the
// provider reads (strictly older than the list cursor, newest first); the
// database side is a key set with capture_business_event's outcomes.
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  R3_LIST_ITEM,
  RX1_REACTION_ITEM,
  RX1_TARGET_ITEM,
  RX2_REACTION_ITEM,
  RX2_TARGET_ITEM,
} from "../_shared/evidence/ghl_message_fixtures.ts";
import { EVENT_SOURCE } from "./reconcile.ts";
import {
  parseRepairRequest,
  REPAIR,
  REPAIR_CAPTURE_PATH,
  type RepairDeps,
  type RepairPolicy,
  type RepairRequest,
  runGhlReactionRepair,
} from "./reaction_repair.ts";

const NOW = Date.parse("2026-11-03T14:00:00.000Z");
const SINCE = Date.parse("2026-10-26T16:00:00.000Z");
const SEC = 1_000;

type Msg = Record<string, unknown> & { id: string; dateAdded: string };
interface Conv {
  id: string;
  contactId: string;
  messages: Msg[];
}

class Location {
  convs = new Map<string, Conv>();
  calls: string[] = [];
  rateLimited = new Set<string>();
  refused = new Set<string>();
  ignoreCursor = false;
  constructor(public clock: { t: number; tick: number }) {}
  add(c: Conv) {
    this.convs.set(c.id, c);
  }
  last(c: Conv) {
    return Math.max(...c.messages.map((m) => Date.parse(m.dateAdded)));
  }
  listRecent(
    { limit, startAfterDate }: { limit: number; startAfterDate?: string },
  ) {
    this.calls.push(`list:${startAfterDate ?? "top"}`);
    const rows = [...this.convs.values()]
      .map((c) => ({
        id: c.id,
        contactId: c.contactId,
        lastMessageDate: this.last(c),
      }))
      .filter((c) =>
        this.ignoreCursor || !startAfterDate ||
        c.lastMessageDate < Number(startAfterDate)
      )
      .sort((a, b) =>
        b.lastMessageDate - a.lastMessageDate || a.id.localeCompare(b.id)
      );
    const page = rows.slice(0, limit);
    return {
      conversations: page as Record<string, unknown>[],
      hasMore: page.length < limit ? false : null,
    };
  }
  listMessages({ conversationId, limit, lastMessageId }: {
    contactId: string;
    conversationId: string;
    limit: number;
    lastMessageId?: string;
  }) {
    this.calls.push(`messages:${conversationId}:${lastMessageId ?? "top"}`);
    this.clock.t += this.clock.tick;
    if (this.rateLimited.has(conversationId)) {
      throw { code: "ghl_rate_limited", status: 429 };
    }
    if (this.refused.has(conversationId)) {
      throw {
        code: "provider_record_refused",
        status: 404,
        providerStatus: 404,
      };
    }
    const sorted = [...this.convs.get(conversationId)!.messages].sort((a, b) =>
      Date.parse(b.dateAdded) - Date.parse(a.dateAdded)
    );
    const start = lastMessageId
      ? sorted.findIndex((m) => m.id === lastMessageId) + 1
      : 0;
    const page = sorted.slice(start, start + limit);
    const more = start + limit < sorted.length;
    return {
      messages: page,
      hasMore: more,
      nextLastMessageId: more ? page.at(-1)!.id : null,
    };
  }
}

class Store {
  keys = new Set<string>();
  rows: Record<string, unknown>[] = [];
  captureCalls = 0;
  keyReads = 0;
  flag = true;
  lane = true;
}

function deps(ghl: Location, db: Store): RepairDeps {
  return {
    now: () => ghl.clock.t,
    itemFlagOn: () => Promise.resolve(db.flag),
    captureLaneOn: () => Promise.resolve(db.lane),
    listRecentConversations: (a) => {
      try {
        return Promise.resolve(ghl.listRecent(a));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    listMessages: (a) => {
      try {
        return Promise.resolve(ghl.listMessages(a));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    existingKeys: (keys) => {
      db.keyReads++;
      return Promise.resolve(new Set(keys.filter((k) => db.keys.has(k))));
    },
    capture: (row) => {
      db.captureCalls++;
      const key = String(row.provider_message_id);
      if (db.keys.has(key)) {
        return Promise.resolve({ outcome: "duplicate" as const });
      }
      db.keys.add(key);
      db.rows.push(row);
      return Promise.resolve({ outcome: "inserted" as const, id: key });
    },
  };
}

/** Two conversations from the census misses: RX1 (iPhone) and RX2 (Android), each with its text. */
function location(tick = SEC) {
  const ghl = new Location({ t: NOW, tick });
  ghl.add({
    id: RX1_REACTION_ITEM.conversationId,
    contactId: RX1_REACTION_ITEM.contactId,
    // An ordinary text the reconciler never saved sits beside the reaction.
    messages: [
      RX1_REACTION_ITEM,
      RX1_TARGET_ITEM,
      {
        ...R3_LIST_ITEM,
        contactId: RX1_REACTION_ITEM.contactId,
        conversationId: RX1_REACTION_ITEM.conversationId,
        dateAdded: "2026-10-27T01:21:00.000Z",
      },
    ] as Msg[],
  });
  ghl.add({
    id: RX2_REACTION_ITEM.conversationId,
    contactId: RX2_REACTION_ITEM.contactId,
    messages: [RX2_REACTION_ITEM, RX2_TARGET_ITEM] as Msg[],
  });
  return ghl;
}

function request(over: Partial<RepairRequest> = {}): RepairRequest {
  return {
    dryRun: true,
    sinceMs: SINCE,
    conversations: null,
    next: null,
    ...over,
  };
}

const NAMED = [
  {
    contactId: RX1_REACTION_ITEM.contactId,
    conversationId: RX1_REACTION_ITEM.conversationId,
  },
  {
    contactId: RX2_REACTION_ITEM.contactId,
    conversationId: RX2_REACTION_ITEM.conversationId,
  },
];

Deno.test("C7 repair: a dry run of the named conversations reads only and lists what a real run would save", async () => {
  const ghl = location();
  const db = new Store();
  db.keys.add(`ghl:${RX2_REACTION_ITEM.id}`); // already saved
  const result = await runGhlReactionRepair(
    deps(ghl, db),
    request({ conversations: NAMED }),
  );
  assert(result.outcome === "ran");
  assertEquals(result.dry_run, true);
  assertEquals(result.complete, true);
  assertEquals(result.next, null);
  assertEquals(db.captureCalls, 0, "a dry run never calls the writer");
  assertEquals(db.rows.length, 0);
  assertEquals(result.counts.reactions_seen, 2);
  assertEquals(result.counts.reactions_to_write, 1);
  assertEquals(result.counts.reactions_existing, 1);
  assertEquals(result.counts.reacted_to_found, 2);
  assertEquals(result.reactions, [
    {
      key: `ghl:${RX1_REACTION_ITEM.id}`,
      conversation_id: RX1_REACTION_ITEM.conversationId,
      at: RX1_REACTION_ITEM.dateAdded,
      result: "would_write",
      reacted_to_match: "quoted_text",
      reacted_to_key: `ghl:${RX1_TARGET_ITEM.id}`,
    },
    {
      key: `ghl:${RX2_REACTION_ITEM.id}`,
      conversation_id: RX2_REACTION_ITEM.conversationId,
      at: RX2_REACTION_ITEM.dateAdded,
      result: "exists",
      reacted_to_match: "quoted_text",
      reacted_to_key: `ghl:${RX2_TARGET_ITEM.id}`,
    },
  ]);
  // Ids and times only: never the words.
  assert(!JSON.stringify(result).includes("automation apologies"));
  // Only GHL reads: no conversation list when conversations are named.
  assert(ghl.calls.every((c) => c.startsWith("messages:")));
});

Deno.test("C7 repair: a real run saves only the missing reactions, as backfill rows marked reaction_repair; a second run finds them saved", async () => {
  const ghl = location();
  const db = new Store();
  const result = await runGhlReactionRepair(
    deps(ghl, db),
    request({ dryRun: false, conversations: NAMED }),
  );
  assert(result.outcome === "ran");
  assertEquals(result.complete, true);
  assertEquals(result.counts.inserted, 2);
  assertEquals(db.rows.length, 2);
  for (const row of db.rows) {
    assertEquals(row.event_type, "client.sms_reaction");
    assertEquals(row.channel, "status");
    assertEquals(row.source, EVENT_SOURCE);
    assertEquals(row.metadata, {
      capture_mode: "backfill",
      capture_path: REPAIR_CAPTURE_PATH,
    });
    assertEquals(row.job_id, null);
  }
  // The ordinary text it passed is the reconciler's and the history load's, not the repair's.
  assert(!db.keys.has(`ghl:${R3_LIST_ITEM.id}`));
  assert(!db.keys.has(`ghl:${RX1_TARGET_ITEM.id}`));
  const again = await runGhlReactionRepair(
    deps(ghl, db),
    request({ dryRun: false, conversations: NAMED }),
  );
  assert(again.outcome === "ran");
  assertEquals(again.counts.inserted, 0);
  assertEquals(again.counts.reactions_existing, 2);
  assertEquals(db.rows.length, 2);
});

Deno.test("C7 repair: a reaction before since is left alone", async () => {
  const ghl = location();
  const db = new Store();
  const result = await runGhlReactionRepair(
    deps(ghl, db),
    request({
      conversations: NAMED,
      sinceMs: Date.parse("2026-10-28T00:00:00.000Z"),
    }),
  );
  assert(result.outcome === "ran");
  assertEquals(result.counts.reactions_seen, 1);
  assertEquals(result.reactions.map((r) => r.key), [
    `ghl:${RX2_REACTION_ITEM.id}`,
  ]);
});

Deno.test("C7 repair: the sweep walks conversations newest first down to since; a call cut by its budget resumes from next and finishes", async () => {
  const ghl = location(40 * SEC);
  // A third conversation older than since is never read.
  ghl.add({
    id: "oldConversation01",
    contactId: "oldContact000001",
    messages: [{
      ...RX1_REACTION_ITEM,
      id: "oldReaction00001",
      conversationId: "oldConversation01",
      contactId: "oldContact000001",
      dateAdded: "2026-10-01T00:00:00.000Z",
    }] as Msg[],
  });
  const db = new Store();
  const policy: RepairPolicy = { ...REPAIR, timeBudgetMs: 30 * SEC };
  const first = await runGhlReactionRepair(
    deps(ghl, db),
    request({ dryRun: false }),
    policy,
  );
  assert(first.outcome === "ran");
  // RX2 (29 Oct) is the newest conversation, so it is read first; the budget then stops the walk.
  assertEquals(first.complete, false);
  assertEquals(first.counts.conversations_read, 1);
  assertEquals(db.rows.map((r) => r.provider_message_id), [
    `ghl:${RX2_REACTION_ITEM.id}`,
  ]);
  assert(first.next !== null);
  const second = await runGhlReactionRepair(
    deps(ghl, db),
    request({ dryRun: false, next: Number(first.next) }),
    policy,
  );
  assert(second.outcome === "ran");
  assertEquals(second.complete, true);
  assertEquals(second.next, null);
  assertEquals(
    db.rows.map((r) => r.provider_message_id).sort(),
    [
      `ghl:${RX1_REACTION_ITEM.id}`,
      `ghl:${RX2_REACTION_ITEM.id}`,
    ].sort(),
  );
  assert(!ghl.calls.some((c) => c.startsWith("messages:oldConversation01")));
});

Deno.test("C7 repair: a GHL rate limit stops the call with a next to resume; a conversation GHL refuses is skipped and the call is not complete", async () => {
  const ghl = location();
  ghl.refused.add(RX2_REACTION_ITEM.conversationId);
  const db = new Store();
  const skipped = await runGhlReactionRepair(
    deps(ghl, db),
    request({ dryRun: false }),
  );
  assert(skipped.outcome === "ran");
  assertEquals(skipped.complete, false);
  assertEquals(skipped.error_code, null);
  assertEquals(skipped.counts.conversations_unreadable, 1);
  assertEquals(db.rows.map((r) => r.provider_message_id), [
    `ghl:${RX1_REACTION_ITEM.id}`,
  ]);

  const limited = location();
  limited.rateLimited.add(RX2_REACTION_ITEM.conversationId);
  const db2 = new Store();
  const stopped = await runGhlReactionRepair(
    deps(limited, db2),
    request({ dryRun: false }),
  );
  assert(stopped.outcome === "ran");
  assertEquals(stopped.error_code, "ghl_rate_limited");
  assertEquals(stopped.complete, false);
  // Resume at the conversation it could not read (re-list at or before its time).
  assertEquals(
    stopped.next,
    String(Date.parse(RX2_REACTION_ITEM.dateAdded) + 1),
  );
  assertEquals(db2.rows.length, 0);
});

Deno.test("C7 repair: a provider that ignores the list cursor stops the walk instead of looping", async () => {
  const ghl = location();
  ghl.ignoreCursor = true;
  const db = new Store();
  const policy: RepairPolicy = { ...REPAIR, listPageLimit: 2 };
  const result = await runGhlReactionRepair(deps(ghl, db), request(), policy);
  assert(result.outcome === "ran");
  assertEquals(result.error_code, "list_cursor_stuck");
  assertEquals(result.complete, false);
  assert(ghl.calls.filter((c) => c.startsWith("list:")).length <= 3);
});

Deno.test("C7 repair: switched off, it reads nothing", async () => {
  const ghl = location();
  const db = new Store();
  db.flag = false;
  assertEquals(await runGhlReactionRepair(deps(ghl, db), request()), {
    outcome: "idle",
    reason: "item_flag_off",
  });
  db.flag = true;
  db.lane = false;
  assertEquals(await runGhlReactionRepair(deps(ghl, db), request()), {
    outcome: "idle",
    reason: "capture_lane_off",
  });
  assertEquals(ghl.calls, []);
});

Deno.test("C7 repair: the request is refused when since is missing, in the future or older than 40 days, or the conversation list is malformed", () => {
  const ok = parseRepairRequest({ since: "2026-10-26T16:00:00Z" }, NOW);
  assert(ok.ok);
  assertEquals(ok.request.dryRun, true, "dry run unless exactly false");
  assertEquals(ok.request.conversations, null);
  const real = parseRepairRequest({
    since: "2026-10-26T16:00:00Z",
    dry_run: false,
  }, NOW);
  assert(real.ok && real.request.dryRun === false);
  const refusals: [Record<string, unknown>, string][] = [
    [{}, "since_required"],
    [{ since: "not a time" }, "since_required"],
    [{ since: "2026-11-04T00:00:00Z" }, "since_in_future"],
    [{ since: "2026-09-20T00:00:00Z" }, "since_too_old"],
    [
      { since: "2026-10-26T16:00:00Z", conversations: [] },
      "conversations_invalid",
    ],
    [
      { since: "2026-10-26T16:00:00Z", conversations: [{ contact_id: "x" }] },
      "conversations_invalid",
    ],
    [{
      since: "2026-10-26T16:00:00Z",
      conversations: Array(51).fill({
        contact_id: "abcdef",
        conversation_id: "ghijkl",
      }),
    }, "conversations_invalid"],
    [{ since: "2026-10-26T16:00:00Z", next: "12x" }, "next_invalid"],
    [{
      since: "2026-10-26T16:00:00Z",
      next: "123",
      conversations: [{ contact_id: "abcdef", conversation_id: "ghijkl" }],
    }, "next_with_conversations"],
  ];
  for (const [body, code] of refusals) {
    assertEquals(
      parseRepairRequest(body, NOW),
      { ok: false, code },
      JSON.stringify(body),
    );
  }
  const dupes = parseRepairRequest({
    since: "2026-10-26T16:00:00Z",
    conversations: [
      { contact_id: "abcdef", conversation_id: "ghijkl" },
      { contact_id: "abcdef", conversation_id: "ghijkl" },
    ],
  }, NOW);
  assert(dupes.ok);
  assertEquals(dupes.request.conversations?.length, 1);
});
