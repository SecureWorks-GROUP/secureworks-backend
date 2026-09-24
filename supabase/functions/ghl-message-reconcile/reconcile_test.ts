// Behaviour tests for the 15-minute GHL message reconciler (context slice C1d),
// on the design's named rows (sms.md §10) as recorded fixtures, plus the
// failure modes of sms.md §8 (F5 targeted recovery, F6 rate limit, F8 switch
// off) and review M12 (a burst larger than one run drains without stalling).
// The GHL side is a fake location that answers like the provider reads; the
// database side is an in-memory run store with record_capture_run's rules and
// a business_events key set with capture_business_event's outcomes.
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ACTIVITY_ITEM,
  CALL_ITEM,
  N1_CALL_ITEM,
  N2_CALL_ITEM,
  N3_CALL_ITEM,
  R13_LIST_ITEM,
  R2_LIST_ITEM,
  R3_LIST_ITEM,
  R4_LIST_ITEM,
  R5,
  R7_LIST_ITEMS,
} from "../_shared/evidence/ghl_message_fixtures.ts";
import { pairLegacyCall } from "../_shared/evidence/ghl_call_pair.ts";
import {
  legacyCallClient,
  type StoredEvent,
} from "../_shared/evidence/ghl_call_pair_test_support.ts";
import {
  CAPTURE_RUN_CURSOR_MAX_BYTES,
  captureRunCursorBytes,
  EVENT_SOURCE,
  POLICY,
  type ReconcileDeps,
  RUN_SOURCE,
  runGhlMessageReconcile,
  type RunRow,
} from "./reconcile.ts";

const T0 = Date.parse("2026-09-23T06:30:00.000Z");
const MIN = 60_000;

// sms.md R1: Gauci's inbound on the SWF-261448 / SWF-261431 conversation.
const R1_LIST_ITEM = {
  id: "pffXnIL1v2FTaKnz4DHm",
  messageType: "TYPE_SMS",
  direction: "inbound",
  to: "+61489267772",
  body: "I haven't received all three quotes as yet?",
  contactId: R2_LIST_ITEM.contactId,
  conversationId: R2_LIST_ITEM.conversationId,
  dateAdded: "2026-09-23T04:35:00.000Z",
};
const R1_CONVERSATION = R2_LIST_ITEM.conversationId;
const R1_CONTACT = R2_LIST_ITEM.contactId;
// sms.md R12: a conversation with no text since 10 Jun.
const R12_CONVERSATION = "mxoELFbGvp1SLEycQU23";

type Msg = Record<string, unknown> & { id: string; dateAdded?: string };
interface Conv {
  id: string;
  contactId: string;
  messages: Msg[]; // any order; served newest first
  lastMessageDate?: number | null;
}

class FakeGhl {
  conversations = new Map<string, Conv>();
  calls: string[] = [];
  failMessagesFor = new Map<
    string,
    { code: string; status: number; providerStatus?: number }
  >();
  failList: { code: string; status: number; providerStatus?: number } | null =
    null;

  add(conv: Conv) {
    this.conversations.set(conv.id, conv);
  }
  last(c: Conv): number | null {
    if (c.lastMessageDate !== undefined) return c.lastMessageDate;
    const times = c.messages.map((m) => Date.parse(String(m.dateAdded)))
      .filter(Number.isFinite);
    return times.length ? Math.max(...times) : null;
  }
  // GHL search_after semantics: strictly older than startAfterDate.
  // Missing and zero lastMessageDate rows pass through and sort to the tail.
  listRecent(
    { limit, startAfterDate }: { limit: number; startAfterDate?: string },
  ) {
    this.calls.push(`list:${startAfterDate ?? "top"}`);
    if (this.failList) throw this.failList;
    const rows = [...this.conversations.values()]
      .map((c) => ({
        id: c.id,
        contactId: c.contactId,
        locationId: "loc",
        lastMessageDate: this.last(c),
      }))
      .filter((c) =>
        !startAfterDate || (c.lastMessageDate ?? 0) < Number(startAfterDate)
      )
      .sort((a, b) =>
        (b.lastMessageDate ?? 0) - (a.lastMessageDate ?? 0) ||
        a.id.localeCompare(b.id)
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
    const fail = this.failMessagesFor.get(conversationId);
    if (fail) throw fail;
    const conv = this.conversations.get(conversationId)!;
    const sorted = [...conv.messages].sort((a, b) =>
      Date.parse(String(b.dateAdded)) - Date.parse(String(a.dateAdded))
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

/** octet_length of JSON with ': ' and ', ' separators (PostgreSQL jsonb::text). */
function jsonbStyleCursorBytes(cursor: unknown): number {
  const compact = JSON.stringify(cursor);
  if (compact === undefined) return 4;
  let out = "";
  let inString = false;
  let escape = false;
  for (const ch of compact) {
    out += ch;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === ":" || ch === ",") out += " ";
  }
  return new TextEncoder().encode(out).length;
}

class FakeDb {
  runs: (RunRow & {
    counts: Record<string, number>;
    error_code: string | null;
    window_from: string | null;
    window_to: string | null;
  })[] = [];
  keys = new Set<string>();
  rows: Record<string, unknown>[] = [];
  /** Existing business_events rows the legacy call pairing reads (slice T1). */
  events: StoredEvent[] = [];
  eventsUnreadable = false;
  captureCalls = 0;
  refusedCursors = 0;
  flag = true;
  lane = true;
  captureDisabledAfter = Infinity;
  clock = T0;
  recordRun(run: Record<string, unknown>): string {
    const allowed = [
      "run_id",
      "source",
      "status",
      "window_from",
      "window_to",
      "watermark",
      "cursor",
      "counts",
      "error_code",
    ];
    for (const k of Object.keys(run)) {
      assert(allowed.includes(k), `record_capture_run key ${k}`);
    }
    assertEquals(run.source, RUN_SOURCE);
    if (run.cursor != null) {
      const bytes = jsonbStyleCursorBytes(run.cursor);
      if (bytes > CAPTURE_RUN_CURSOR_MAX_BYTES) {
        this.refusedCursors++;
        throw Object.assign(new Error("capture_run_invalid"), {
          code: "capture_run_invalid",
        });
      }
    }
    const now = new Date(this.clock).toISOString();
    const existing = this.runs.find((r) => r.id === run.run_id);
    const json = (v: unknown) =>
      v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    if (existing) {
      assertEquals(existing.status, "running", "a finished run is immutable");
      for (
        const k of [
          "status",
          "window_from",
          "window_to",
          "watermark",
          "cursor",
          "counts",
          "error_code",
        ] as const
      ) {
        // deno-lint-ignore no-explicit-any
        if (k in run) (existing as any)[k] = json(run[k]);
      }
      existing.updated_at = now;
      if (existing.status === "failed") {
        assert(existing.error_code, "failed needs a code");
      }
      return existing.id;
    }
    const id = crypto.randomUUID();
    this.runs.unshift({
      id,
      status: (run.status as RunRow["status"]) ?? "running",
      started_at: now,
      updated_at: now,
      watermark: (run.watermark as string | null) ?? null,
      cursor: json(run.cursor) ?? null,
      counts: json(run.counts) ?? {},
      error_code: (run.error_code as string | null) ?? null,
      window_from: (run.window_from as string) ?? null,
      window_to: (run.window_to as string) ?? null,
    });
    return id;
  }
  capture(row: Record<string, unknown>) {
    this.captureCalls++;
    if (this.captureCalls > this.captureDisabledAfter) {
      return { outcome: "capture_disabled" as const };
    }
    const key = String(row.provider_message_id);
    if (this.keys.has(key)) return { outcome: "duplicate" as const };
    this.keys.add(key);
    this.rows.push(row);
    return { outcome: "inserted" as const, id: key };
  }
}

function deps(ghl: FakeGhl, db: FakeDb): ReconcileDeps {
  return {
    now: () => db.clock,
    itemFlagOn: () => Promise.resolve(db.flag),
    captureLaneOn: () => Promise.resolve(db.lane),
    latestRuns: (n) => Promise.resolve(db.runs.slice(0, n) as RunRow[]),
    recordRun: (r) => Promise.resolve(db.recordRun(r)),
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
    existingKeys: (keys) =>
      Promise.resolve(new Set(keys.filter((k) => db.keys.has(k)))),
    capture: (row) => Promise.resolve(db.capture(row)),
    // The real pairing, over a stand-in for its two business_events reads.
    pairLegacyCall: (row) =>
      pairLegacyCall(
        legacyCallClient(
          db.events,
          db.eventsUnreadable
            ? { error: { code: "57014", message: "canceling statement" } }
            : {},
        ).client,
        row,
      ),
  };
}

function at(iso: string) {
  return Date.parse(iso);
}
function msg(
  id: string,
  conv: string,
  contact: string,
  iso: string,
  extra: Record<string, unknown> = {},
): Msg {
  return {
    id,
    messageType: "TYPE_SMS",
    direction: "inbound",
    to: "+61489267772",
    body: `Text ${id}`,
    contactId: contact,
    conversationId: conv,
    dateAdded: iso,
    ...extra,
  };
}
function rowFor(db: FakeDb, ghlId: string) {
  return db.rows.find((r) => r.provider_message_id === `ghl:${ghlId}`);
}

// A previous complete scan so the window is the normal 15-minute one.
function seedCompleteScan(db: FakeDb, topIso: string, listFloorIso?: string) {
  const top = at(topIso);
  db.runs.unshift({
    id: crypto.randomUUID(),
    status: "succeeded",
    started_at: topIso,
    updated_at: topIso,
    watermark: topIso,
    cursor: {
      v: 1,
      scan_top: topIso,
      list_floor: listFloorIso ?? new Date(top - 45 * MIN).toISOString(),
      message_floor: listFloorIso ?? new Date(top - 45 * MIN).toISOString(),
      position: null,
      complete: true,
    },
    counts: {},
    error_code: null,
    window_from: null,
    window_to: topIso,
  });
}

Deno.test("R1 to R4, R13: texts the webhook missed are saved once, mapped by the one builder, live", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  ghl.add({
    id: R1_CONVERSATION,
    contactId: R1_CONTACT,
    messages: [
      R1_LIST_ITEM,
      R2_LIST_ITEM,
      R3_LIST_ITEM,
      R4_LIST_ITEM,
      R13_LIST_ITEM,
      CALL_ITEM,
      ACTIVITY_ITEM,
    ] as Msg[],
  });
  // Last complete scan at 21 Sep 03:00Z: R13 (21 Sep 03:51Z) is inside the window.
  seedCompleteScan(db, "2026-09-21T03:00:00.000Z");
  const result = await runGhlMessageReconcile(deps(ghl, db));
  assert(result.outcome === "ran");
  assertEquals(result.status, "succeeded");
  // Six rows: the five texts and, since slice T1, the call.
  assertEquals(result.counts.inserted, 6);
  assertEquals(result.counts.webhook_misses, 6);
  assertEquals(result.counts.skipped_call, 0);
  assertEquals(result.counts.skipped_activity, 1);

  const r1 = rowFor(db, R1_LIST_ITEM.id)!;
  assertEquals(r1.event_type, "client.reply");
  assertEquals(r1.source, EVENT_SOURCE);
  assertEquals(r1.thread_key, null);
  assertEquals(r1.event_at, R1_LIST_ITEM.dateAdded);
  assertEquals(r1.metadata, { capture_mode: "live" });
  assertEquals(r1.match_method, "none");
  assertEquals(r1.job_id, null, "the reconciler never places: the ladder does");
  assertEquals((r1.payload as Record<string, unknown>).body, R1_LIST_ITEM.body);
  const r2 = rowFor(db, R2_LIST_ITEM.id)!;
  assertEquals(r2.event_type, "client.sms_out");
  assertEquals(
    (r2.payload as Record<string, unknown>).sent_by_kind,
    "staff_app",
  );
  assertEquals(
    (r2.payload as Record<string, unknown>).sent_by_user,
    R2_LIST_ITEM.userId,
  );
  assertEquals((r2.payload as Record<string, unknown>).line, "fencing");
  const r3 = rowFor(db, R3_LIST_ITEM.id)!;
  assertEquals(r3.event_type, "client.reply");
  assertEquals((r3.payload as Record<string, unknown>).body, "Thanks.");
  const r4 = rowFor(db, R4_LIST_ITEM.id)!;
  assertEquals(
    (r4.payload as Record<string, unknown>).sent_by_kind,
    "workflow",
  );
  const r13 = rowFor(db, R13_LIST_ITEM.id)!;
  assertEquals(
    (r13.payload as Record<string, unknown>).body,
    "I only see one price of $5,478",
  );
  const call = rowFor(db, CALL_ITEM.id)!;
  assertEquals(call.event_type, "client.call_logged");
  assertEquals(call.channel, "call");
  assertEquals(call.provider_message_id, `ghl:${CALL_ITEM.id}`);

  // The run row: counts and codes only, window and watermark.
  const run = db.runs[0];
  assertEquals(run.status, "succeeded");
  assertEquals(run.watermark, new Date(T0).toISOString());
  assertEquals(run.window_to, new Date(T0).toISOString());
  assert(
    !JSON.stringify(run).includes("quotes as yet"),
    "no message text on the run row",
  );

  // A second run over the same state writes nothing and reads only new time.
  db.clock = T0 + 15 * MIN;
  const again = await runGhlMessageReconcile(deps(ghl, db));
  assert(again.outcome === "ran");
  assertEquals(again.counts.inserted, 0);
  assertEquals(db.rows.length, 6);
});

Deno.test("T1 N1 to N3: calls the webhook missed are saved as one call record each; a call lead-thread-capture already keyed is a duplicate", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  // lead-thread-capture writes call items under the same ghl:<id> key today.
  db.keys.add(`ghl:${N3_CALL_ITEM.id}`);
  ghl.add({
    id: N1_CALL_ITEM.conversationId,
    contactId: N1_CALL_ITEM.contactId,
    messages: [N1_CALL_ITEM, N2_CALL_ITEM, N3_CALL_ITEM] as Msg[],
  });
  seedCompleteScan(db, "2026-09-21T23:00:00.000Z");
  db.clock = at("2026-09-23T07:50:00.000Z");
  const result = await runGhlMessageReconcile(deps(ghl, db));
  assert(result.outcome === "ran");
  assertEquals(result.counts.inserted, 2);
  assertEquals(result.counts.duplicates, 1);
  assertEquals(result.counts.skipped_call, 0);
  for (const item of [N1_CALL_ITEM, N2_CALL_ITEM]) {
    const r = rowFor(db, item.id)!;
    assertEquals(r.event_type, "client.call_logged");
    assertEquals(r.channel, "call");
    assertEquals(r.direction, "inbound");
    assertEquals(r.event_at, item.dateAdded);
    assertEquals(r.metadata, { capture_mode: "live" });
    assertEquals(r.job_id, null, "the ladder places the call");
  }
  assertEquals(
    (rowFor(db, N2_CALL_ITEM.id)!.payload as Record<string, unknown>)
      .call_status,
    "voicemail",
  );
  assertEquals(rowFor(db, N3_CALL_ITEM.id), undefined, "no second row");
});

Deno.test("T1-002: a call the webhook missed records its one legacy CallCompleted row; the run counts the pairing; an unreadable lookup writes as normal", async () => {
  const legacyN2 = {
    id: "aaaaaaaa-0000-4000-8000-000000000002",
    event_type: "client.call_complete",
    contact_id: N2_CALL_ITEM.contactId,
    event_at: null,
    occurred_at: "2026-09-22T23:00:02.000Z", // the voicemail's post, as it ended
    provider_message_id: null,
    payload: { voicemail: true },
  };
  for (const unreadable of [false, true]) {
    const ghl = new FakeGhl();
    const db = new FakeDb();
    db.events = [legacyN2];
    db.eventsUnreadable = unreadable;
    ghl.add({
      id: N1_CALL_ITEM.conversationId,
      contactId: N1_CALL_ITEM.contactId,
      messages: [N1_CALL_ITEM, N2_CALL_ITEM, N3_CALL_ITEM] as Msg[],
    });
    seedCompleteScan(db, "2026-09-21T23:00:00.000Z");
    db.clock = at("2026-09-23T07:50:00.000Z");
    const result = await runGhlMessageReconcile(deps(ghl, db));
    assert(result.outcome === "ran");
    assertEquals(result.counts.inserted, 3, "every call still written once");
    const n2 = rowFor(db, N2_CALL_ITEM.id)!.payload as Record<string, unknown>;
    const n1 = rowFor(db, N1_CALL_ITEM.id)!.payload as Record<string, unknown>;
    assertEquals("legacy_event_id" in n1, false);
    if (unreadable) {
      assertEquals("legacy_event_id" in n2, false);
      assertEquals(result.counts.calls_paired_legacy, 0);
      assertEquals(result.counts.call_pair_unreadable, 3);
      assertEquals(
        result.status,
        "succeeded",
        "a lookup fault never fails the run",
      );
    } else {
      assertEquals(n2.legacy_event_id, "aaaaaaaa-0000-4000-8000-000000000002");
      assertEquals(result.counts.calls_paired_legacy, 1);
      assertEquals(result.counts.call_pair_unreadable, 0);
    }
    assertEquals(db.events, [legacyN2], "the legacy row is never edited");
  }
});

Deno.test("R5: a text our tool already saved is a duplicate; no second row and no writer call", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  db.keys.add(`ghl:${R5.messageId}`); // the existing row 689a6745-... from ghl-proxy send_sms
  ghl.add({
    id: "r5-conversation-placeholder",
    contactId: R5.contactId,
    messages: [{
      id: R5.messageId,
      messageType: "TYPE_SMS",
      direction: "outbound",
      source: "app",
      from: R5.fromNumber,
      body: R5.body,
      contactId: R5.contactId,
      conversationId: "r5-conversation-placeholder",
      dateAdded: "2026-09-23T06:10:00.000Z",
      meta: { marketplace: { appId: "69a41803c86f294a620b6499" } },
    }],
  });
  seedCompleteScan(db, "2026-09-23T06:15:00.000Z");
  const result = await runGhlMessageReconcile(deps(ghl, db));
  assert(result.outcome === "ran");
  assertEquals(result.counts.duplicates, 1);
  assertEquals(result.counts.inserted, 0);
  assertEquals(db.captureCalls, 0);
  assertEquals(db.rows.length, 0);
});

Deno.test("R7: internal comments are saved as internal notes, never as texts", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  ghl.add({
    id: "r5-conversation-placeholder",
    contactId: R5.contactId,
    messages: R7_LIST_ITEMS as Msg[],
  });
  seedCompleteScan(db, "2026-09-08T01:30:00.000Z");
  db.clock = at("2026-09-08T02:15:00.000Z");
  const result = await runGhlMessageReconcile(deps(ghl, db));
  assert(result.outcome === "ran");
  assertEquals(result.counts.inserted, 2);
  for (const item of R7_LIST_ITEMS) {
    const row = rowFor(db, item.id)!;
    assertEquals(row.event_type, "ghl.internal_comment");
    assertEquals(row.channel, "note");
    assertEquals(row.direction, "internal");
  }
});

Deno.test("R12: a conversation quiet since 10 Jun is below the window; nothing is read or written", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  ghl.add({
    id: R12_CONVERSATION,
    contactId: "r12-contact-placeholder",
    messages: [
      msg(
        "r12LastText0001",
        R12_CONVERSATION,
        "r12-contact-placeholder",
        "2026-06-10T02:00:00.000Z",
      ),
    ],
  });
  seedCompleteScan(db, "2026-09-23T06:15:00.000Z");
  const result = await runGhlMessageReconcile(deps(ghl, db));
  assert(result.outcome === "ran");
  assertEquals(result.status, "succeeded");
  assertEquals(result.counts.scan_completed, 1);
  assertEquals(result.counts.conversations_read, 0);
  assertEquals(db.rows.length, 0);
  assert(!ghl.calls.some((c) => c.startsWith(`messages:${R12_CONVERSATION}`)));
});

Deno.test("M12: a burst larger than one run drains over later runs without re-reading or stalling", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  for (let i = 0; i < 7; i++) {
    const conv = `burstConversation${i}`;
    ghl.add({
      id: conv,
      contactId: `burst-contact-${i}`,
      messages: [
        msg(
          `burstText00${i}`,
          conv,
          `burst-contact-${i}`,
          new Date(T0 - (i + 1) * MIN).toISOString(),
        ),
      ],
    });
  }
  seedCompleteScan(db, new Date(T0 - 15 * MIN).toISOString());
  const small = { ...POLICY, maxConversationsPerRun: 3, listPageLimit: 2 };
  const first = await runGhlMessageReconcile(deps(ghl, db), small);
  assert(first.outcome === "ran");
  assertEquals(first.status, "partial");
  assertEquals(first.counts.conversations_read, 3);
  assert(first.counts.backlog_conversations + first.counts.backlog_more > 0);
  assertEquals(
    first.watermark,
    new Date(T0 - 15 * MIN).toISOString(),
    "watermark held until the scan completes",
  );

  db.clock = T0 + 15 * MIN;
  const second = await runGhlMessageReconcile(deps(ghl, db), small);
  assert(second.outcome === "ran");
  assertEquals(second.counts.scan_continued, 1);
  assertEquals(second.counts.conversations_read, 3);
  db.clock = T0 + 30 * MIN;
  const third = await runGhlMessageReconcile(deps(ghl, db), small);
  assert(third.outcome === "ran");
  assertEquals(third.status, "succeeded");
  assertEquals(
    third.watermark,
    new Date(T0).toISOString(),
    "the watermark moves to the top of the completed scan",
  );
  assertEquals(db.rows.length, 7);
  const reads = ghl.calls.filter((c) => c.startsWith("messages:"));
  assertEquals(
    reads.length,
    new Set(reads).size,
    "no conversation is read twice",
  );
});

Deno.test("F6: a GHL rate limit fails the run and holds position and watermark; the next run finishes", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  for (let i = 0; i < 3; i++) {
    const conv = `rateConversation${i}`;
    ghl.add({
      id: conv,
      contactId: `rate-contact-${i}`,
      messages: [
        msg(
          `rateText000${i}`,
          conv,
          `rate-contact-${i}`,
          new Date(T0 - (i + 1) * MIN).toISOString(),
        ),
      ],
    });
  }
  seedCompleteScan(db, new Date(T0 - 15 * MIN).toISOString());
  ghl.failMessagesFor.set("rateConversation1", {
    code: "provider_request_failed",
    status: 429,
    providerStatus: 429,
  });
  const failed = await runGhlMessageReconcile(deps(ghl, db));
  assert(failed.outcome === "ran");
  assertEquals(failed.status, "failed");
  assertEquals(failed.error_code, "ghl_rate_limited");
  assertEquals(failed.watermark, new Date(T0 - 15 * MIN).toISOString());
  const cursor = db.runs[0].cursor as {
    position: { ids: string[] };
    complete: boolean;
  };
  assertEquals(cursor.position.ids, ["rateConversation0"]);
  assertEquals(cursor.complete, false);

  ghl.failMessagesFor.clear();
  db.clock = T0 + 15 * MIN;
  const next = await runGhlMessageReconcile(deps(ghl, db));
  assert(next.outcome === "ran");
  assertEquals(next.status, "succeeded");
  assertEquals(next.counts.scan_continued, 1);
  assertEquals(db.rows.length, 3);
  assertEquals(
    ghl.calls.filter((c) => c === "messages:rateConversation0:top").length,
    1,
  );
});

Deno.test("F6: a failed conversation list read fails the run with its code", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  ghl.failList = { code: "provider_transport_failed", status: 502 };
  const result = await runGhlMessageReconcile(deps(ghl, db));
  assert(result.outcome === "ran");
  assertEquals(result.status, "failed");
  assertEquals(result.error_code, "provider_transport_failed");
  assertEquals(result.watermark, null);
});

Deno.test("F8: item flag off or capture lane off is idle: no GHL read, no run row", async () => {
  for (const off of ["flag", "lane"] as const) {
    const ghl = new FakeGhl();
    const db = new FakeDb();
    db[off] = false;
    ghl.add({
      id: "anyConversation1",
      contactId: "c",
      messages: [
        msg(
          "anyText0000001",
          "anyConversation1",
          "c",
          new Date(T0 - MIN).toISOString(),
        ),
      ],
    });
    const result = await runGhlMessageReconcile(deps(ghl, db));
    assertEquals(result, {
      outcome: "idle",
      reason: off === "flag" ? "item_flag_off" : "capture_lane_off",
    });
    assertEquals(ghl.calls, []);
    assertEquals(db.runs, []);
  }
});

Deno.test("the writer switching off mid-run fails the run without moving past the unsaved text", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  for (let i = 0; i < 2; i++) {
    const conv = `laneConversation${i}`;
    ghl.add({
      id: conv,
      contactId: `lane-contact-${i}`,
      messages: [
        msg(
          `laneText000${i}`,
          conv,
          `lane-contact-${i}`,
          new Date(T0 - (i + 1) * MIN).toISOString(),
        ),
      ],
    });
  }
  seedCompleteScan(db, new Date(T0 - 15 * MIN).toISOString());
  db.captureDisabledAfter = 1;
  const result = await runGhlMessageReconcile(deps(ghl, db));
  assert(result.outcome === "ran");
  assertEquals(result.status, "failed");
  assertEquals(result.error_code, "capture_disabled");
  const cursor = db.runs[0].cursor as { position: { ids: string[] } };
  assertEquals(cursor.position.ids, ["laneConversation0"]);
});

Deno.test("an unreadable conversation is skipped and counted; the scan goes on", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  for (let i = 0; i < 2; i++) {
    const conv = `goneConversation${i}`;
    ghl.add({
      id: conv,
      contactId: `gone-contact-${i}`,
      messages: [
        msg(
          `goneText000${i}`,
          conv,
          `gone-contact-${i}`,
          new Date(T0 - (i + 1) * MIN).toISOString(),
        ),
      ],
    });
  }
  seedCompleteScan(db, new Date(T0 - 15 * MIN).toISOString());
  ghl.failMessagesFor.set("goneConversation0", {
    code: "provider_request_failed",
    status: 502,
    providerStatus: 404,
  });
  const result = await runGhlMessageReconcile(deps(ghl, db));
  assert(result.outcome === "ran");
  assertEquals(result.status, "partial");
  assertEquals(
    result.error_code,
    "conversation_unreadable:provider_request_failed",
  );
  assertEquals(result.counts.conversations_unreadable, 1);
  assertEquals(result.counts.scan_completed, 1);
  assert(rowFor(db, "goneText0001"));
});

Deno.test("two conversations at the same millisecond across a page boundary are both read", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  const same = new Date(T0 - 2 * MIN).toISOString();
  for (
    const id of ["tieConversationA", "tieConversationB", "tieConversationC"]
  ) {
    ghl.add({
      id,
      contactId: `${id}-contact`,
      messages: [msg(`${id}Text`, id, `${id}-contact`, same)],
    });
  }
  seedCompleteScan(db, new Date(T0 - 15 * MIN).toISOString());
  const result = await runGhlMessageReconcile(deps(ghl, db), {
    ...POLICY,
    listPageLimit: 1,
  });
  assert(result.outcome === "ran");
  assertEquals(result.status, "succeeded");
  assertEquals(db.rows.length, 3);
});

Deno.test("a conversation that jumps above a running scan is read back to the previous floor next scan", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  // Webhook missed jumpText0001 at T0-10min; the scan runs over two runs.
  ghl.add({
    id: "fillerConversation1",
    contactId: "f1",
    messages: [
      msg(
        "fillerText00001",
        "fillerConversation1",
        "f1",
        new Date(T0 - 2 * MIN).toISOString(),
      ),
    ],
  });
  ghl.add({
    id: "jumpConversation1",
    contactId: "j1",
    messages: [
      msg(
        "jumpText0001",
        "jumpConversation1",
        "j1",
        new Date(T0 - 10 * MIN).toISOString(),
      ),
    ],
  });
  seedCompleteScan(db, new Date(T0 - 15 * MIN).toISOString());
  const small = { ...POLICY, maxConversationsPerRun: 1, listPageLimit: 1 };
  const first = await runGhlMessageReconcile(deps(ghl, db), small);
  assert(first.outcome === "ran" && first.status === "partial");
  // Before the scan reaches it, the customer texts again: the conversation
  // jumps above the scan's top and leaves the rest of this scan.
  ghl.conversations.get("jumpConversation1")!.messages.push(
    msg(
      "jumpText0002",
      "jumpConversation1",
      "j1",
      new Date(T0 + 5 * MIN).toISOString(),
    ),
  );
  db.clock = T0 + 15 * MIN;
  const second = await runGhlMessageReconcile(deps(ghl, db), small);
  assert(second.outcome === "ran" && second.status === "succeeded");
  assertEquals(
    rowFor(db, "jumpText0001"),
    undefined,
    "not reached by the scan it left",
  );
  db.clock = T0 + 30 * MIN;
  const third = await runGhlMessageReconcile(deps(ghl, db), small);
  assert(third.outcome === "ran");
  assert(rowFor(db, "jumpText0002"));
  assert(
    rowFor(db, "jumpText0001"),
    "recovered by reading back to the previous scan's floor",
  );
});

Deno.test("a fresh running run is left alone; an abandoned one is closed and its scan continued", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  ghl.add({
    id: "someConversation1",
    contactId: "s1",
    messages: [
      msg(
        "someText000001",
        "someConversation1",
        "s1",
        new Date(T0 - MIN).toISOString(),
      ),
    ],
  });
  const running = db.recordRun({
    source: RUN_SOURCE,
    status: "running",
    cursor: {
      v: 1,
      scan_top: new Date(T0 - 20 * MIN).toISOString(),
      list_floor: new Date(T0 - 60 * MIN).toISOString(),
      message_floor: new Date(T0 - 60 * MIN).toISOString(),
      position: null,
      complete: false,
    },
  });
  db.clock = T0 + 5 * MIN;
  assertEquals(await runGhlMessageReconcile(deps(ghl, db)), {
    outcome: "run_in_progress",
    run_id: running,
  });
  db.clock = T0 + 11 * MIN;
  const result = await runGhlMessageReconcile(deps(ghl, db));
  assert(result.outcome === "ran");
  assertEquals(db.runs.find((r) => r.id === running)!.status, "failed");
  assertEquals(
    db.runs.find((r) => r.id === running)!.error_code,
    "run_abandoned",
  );
  assertEquals(result.counts.scan_continued, 1);
  assertEquals(result.window.to, new Date(T0 - 20 * MIN).toISOString());
});

Deno.test("the first run reads two hours back; a long gap is capped at 72 hours and says so", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  const first = await runGhlMessageReconcile(deps(ghl, db));
  assert(first.outcome === "ran");
  assertEquals(first.window.from, new Date(T0 - 150 * MIN).toISOString());
  assertEquals(first.counts.window_capped, 0);

  const db2 = new FakeDb();
  seedCompleteScan(db2, "2026-09-01T00:00:00.000Z");
  const late = await runGhlMessageReconcile(deps(new FakeGhl(), db2));
  assert(late.outcome === "ran");
  assertEquals(late.counts.window_capped, 1);
  assertEquals(late.window.from, new Date(T0 - 72 * 60 * MIN).toISOString());
});

Deno.test("dateless conversations at the tail of a full page complete the scan", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  ghl.add({
    id: "datedConversation1",
    contactId: "d1",
    messages: [
      msg(
        "datedText0001",
        "datedConversation1",
        "d1",
        new Date(T0 - MIN).toISOString(),
      ),
    ],
  });
  for (let i = 0; i < 8; i++) {
    ghl.add({
      id: `datelessConversation${i}`,
      contactId: `n${i}`,
      messages: [],
      lastMessageDate: i % 2 === 0 ? 0 : null,
    });
  }
  seedCompleteScan(db, new Date(T0 - 15 * MIN).toISOString());
  const result = await runGhlMessageReconcile(deps(ghl, db), {
    ...POLICY,
    listPageLimit: 4,
  });
  assert(result.outcome === "ran");
  assertEquals(result.status, "succeeded");
  assertEquals(result.counts.scan_completed, 1);
  assertEquals(result.counts.conversations_read, 1);
  assert(result.counts.conversations_no_date >= 3);
  assertEquals(result.watermark, new Date(T0).toISOString());
  assertEquals(db.rows.length, 1);
  assertEquals(result.counts.list_pages, 2);
  assert(!ghl.calls.some((c) => c.startsWith("messages:dateless")));
});

Deno.test("more than 50 conversations at one millisecond are all read and the walk leaves that millisecond", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  const same = new Date(T0 - 2 * MIN).toISOString();
  const n = 60;
  for (let i = 0; i < n; i++) {
    const id = `tieConversation${String(i).padStart(2, "0")}`;
    ghl.add({
      id,
      contactId: `${id}-c`,
      messages: [msg(`${id}Text`, id, `${id}-c`, same)],
    });
  }
  ghl.add({
    id: "olderConversation1",
    contactId: "older-c",
    messages: [
      msg(
        "olderText1",
        "olderConversation1",
        "older-c",
        new Date(T0 - 5 * MIN).toISOString(),
      ),
    ],
  });
  seedCompleteScan(db, new Date(T0 - 15 * MIN).toISOString());
  const result = await runGhlMessageReconcile(deps(ghl, db), {
    ...POLICY,
    listPageLimit: 20,
  });
  assert(result.outcome === "ran");
  assertEquals(result.status, "succeeded");
  assertEquals(result.counts.conversations_read, n + 1);
  assertEquals(result.counts.boundary_tie_fallbacks, 0);
  assertEquals(db.rows.length, n + 1);
  assert(rowFor(db, "olderText1"));
  assert(
    captureRunCursorBytes(db.runs[0].cursor) <= CAPTURE_RUN_CURSOR_MAX_BYTES,
  );
});

Deno.test("a same-millisecond burst that would overflow the run cursor steps past that millisecond", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  const same = new Date(T0 - 2 * MIN).toISOString();
  const n = 80;
  for (let i = 0; i < n; i++) {
    const id = `sameMs${String(i).padStart(2, "0")}${"x".repeat(40)}`;
    ghl.add({
      id,
      contactId: `${id}-c`,
      messages: [msg(`${id}Text`, id, `${id}-c`, same)],
    });
  }
  ghl.add({
    id: "olderAfterBurst1",
    contactId: "older-burst-c",
    messages: [
      msg(
        "olderAfterBurstText",
        "olderAfterBurst1",
        "older-burst-c",
        new Date(T0 - 5 * MIN).toISOString(),
      ),
    ],
  });
  seedCompleteScan(db, new Date(T0 - 15 * MIN).toISOString());
  const result = await runGhlMessageReconcile(deps(ghl, db), {
    ...POLICY,
    listPageLimit: 50,
    maxConversationsPerRun: 200,
  });
  assert(result.outcome === "ran");
  assertEquals(result.status, "succeeded");
  assert(result.counts.boundary_tie_fallbacks >= 1);
  assert(result.counts.conversations_read < n + 1);
  assert(result.counts.conversations_read >= 1);
  assert(rowFor(db, "olderAfterBurstText"));
  assertEquals(result.counts.scan_completed, 1);
  assert(
    captureRunCursorBytes(db.runs[0].cursor) <= CAPTURE_RUN_CURSOR_MAX_BYTES,
  );
  assertEquals(db.refusedCursors, 0);
});

Deno.test("a same-millisecond blast of typical GHL ids drains without a refused jsonb cursor write", async () => {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  const same = new Date(T0 - 2 * MIN).toISOString();
  const n = 200;
  for (let i = 0; i < n; i++) {
    const id = `ghlConv${String(i).padStart(13, "0")}`;
    ghl.add({
      id,
      contactId: `${id}-c`,
      messages: [msg(`${id}Text`, id, `${id}-c`, same)],
    });
  }
  ghl.add({
    id: "olderAfterTypicalBurst",
    contactId: "older-typical-c",
    messages: [
      msg(
        "olderAfterTypicalBurstText",
        "olderAfterTypicalBurst",
        "older-typical-c",
        new Date(T0 - 5 * MIN).toISOString(),
      ),
    ],
  });
  seedCompleteScan(db, new Date(T0 - 15 * MIN).toISOString());
  const policy = {
    ...POLICY,
    listPageLimit: 50,
    maxConversationsPerRun: 150,
  };
  let result = await runGhlMessageReconcile(deps(ghl, db), policy);
  assert(result.outcome === "ran");
  assertEquals(db.refusedCursors, 0);
  if (result.status === "partial") {
    db.clock = T0 + 15 * MIN;
    result = await runGhlMessageReconcile(deps(ghl, db), policy);
    assert(result.outcome === "ran");
  }
  assertEquals(db.refusedCursors, 0);
  assertEquals(result.status, "succeeded");
  assertEquals(result.counts.scan_completed, 1);
  assert(rowFor(db, "olderAfterTypicalBurstText"));
  assert(
    db.runs.some((run) => (run.counts.boundary_tie_fallbacks ?? 0) >= 1),
  );
  for (const run of db.runs) {
    if (run.cursor != null) {
      assert(jsonbStyleCursorBytes(run.cursor) <= CAPTURE_RUN_CURSOR_MAX_BYTES);
    }
  }
});
