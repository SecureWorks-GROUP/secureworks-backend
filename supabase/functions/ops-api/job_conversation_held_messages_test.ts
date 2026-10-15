// deno-lint-ignore-file no-import-prefix no-explicit-any
// getJobConversation (index.ts) held_contact_ids, the Debt Workshop's read of the payer's
// messages held on NO job (job_conversation_timeline.ts heldConversationMessages).
//
// Live case (14 Oct 2026): a payment-chase text to the customer on 9 Oct (SWF-261098)
// sat in business_events with job_id null, attribution_status unplaced and that job as
// its ONLY candidate, so the Debt tab's conversation stopped at 1 Oct. A held message is
// read on a candidate job only for a contact the caller names (the payer's), marked
// unplaced: true, and a copy already on the job shows once. Synthetic data only.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _getJobConversationForTest } from "./index.ts";
import {
  compareConversationNewestFirst,
  heldConversationMessages,
} from "./job_conversation_timeline.ts";
import { DEBT_WS_ACTIONS, runDebtWsAction } from "./debt_ws_actions.ts";
import {
  fakeDeps,
  FakeStore,
  IDS,
  JOBS,
  SERVER,
} from "./debt_ws_test_fakes.ts";

const JOB = "a0000000-0000-4000-8000-0000000000a1";
const OTHER_JOB = "a0000000-0000-4000-8000-0000000000a2";
const PAYER = "ghlpayer000000000001";
const NEIGHBOUR = "ghlneighbour00000001";
const STRANGER = "ghlstranger000000001";

/**
 * Read-only fake that honours eq / in / is / not-is / contains (others pass through).
 * fail: a query whose table and filters it names returns this error and no rows.
 */
function filteringClient(
  tables: Record<string, any[]>,
  fail?: (table: string, filters: string[]) => string | null,
) {
  const reads: Array<{ table: string; filters: string[] }> = [];
  return {
    reads,
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      const seen: string[] = [];
      let single = false;
      const q: any = {};
      for (
        const m of [
          "select",
          "neq",
          "gt",
          "gte",
          "lt",
          "lte",
          "ilike",
          "or",
          "order",
          "range",
          "limit",
        ]
      ) q[m] = () => q;
      q.eq = (col: string, v: unknown) => {
        seen.push(`eq:${col}`);
        filters.push((r) => r[col] === v);
        return q;
      };
      q.in = (col: string, vs: unknown[]) => {
        seen.push(`in:${col}`);
        filters.push((r) => vs.includes(r[col]));
        return q;
      };
      q.is = (col: string, v: unknown) => {
        seen.push(`is:${col}`);
        filters.push((r) => v === null ? r[col] == null : r[col] === v);
        return q;
      };
      q.not = (col: string, op: string, v: unknown) => {
        seen.push(`not:${col}`);
        if (op === "is" && v === null) filters.push((r) => r[col] != null);
        return q;
      };
      q.contains = (col: string, vs: unknown[]) => {
        seen.push(`contains:${col}`);
        filters.push((r) =>
          Array.isArray(r[col]) && vs.every((v) => r[col].includes(v))
        );
        return q;
      };
      q.maybeSingle = () => {
        single = true;
        return q;
      };
      q.single = q.maybeSingle;
      q.then = (resolve: any, reject: any) => {
        reads.push({ table, filters: seen });
        const failed = fail?.(table, seen) ?? null;
        if (failed) {
          return Promise.resolve({ data: null, error: { message: failed } })
            .then(resolve, reject);
        }
        const rows = (tables[table] ?? []).filter((r) =>
          filters.every((f) => f(r))
        );
        return Promise.resolve({
          data: single ? rows[0] ?? null : rows,
          error: null,
        }).then(resolve, reject);
      };
      return q;
    },
  };
}

/** A business_events text row; held by default (on no job, this job its one candidate). */
function sms(id: string, at: string, over: Record<string, unknown> = {}) {
  return {
    id,
    event_type: "client.sms_out",
    source: "ghl-message-reconcile",
    channel: "sms",
    direction: "outbound",
    event_at: at,
    occurred_at: at,
    body_preview: `text ${id}`,
    provider_message_id: `ghl:msg-${id}`,
    payload: { body: `text ${id}` },
    contact_id: PAYER,
    entity_type: "contact",
    entity_id: PAYER,
    job_id: null,
    attribution_status: "unplaced",
    candidate_job_ids: [JOB],
    ...over,
  };
}

function tables(events: any[]) {
  return {
    jobs: [{
      id: JOB,
      job_number: "SWF-90011",
      ghl_contact_id: PAYER,
      client_email: null,
    }],
    job_contacts: [],
    ghl_conversation_cache: [],
    inbox_events: [],
    job_events: [],
    email_events: [],
    business_events: events,
  };
}

async function read(events: any[], body: Record<string, unknown>) {
  const client = filteringClient(tables(events));
  const res: any = await _getJobConversationForTest(client, {
    job_id: JOB,
    limit: 50,
    ...body,
  });
  return { res, client };
}

const ids = (res: any) => res.messages.map((m: any) => m.id);

Deno.test("held: the payer's unplaced message with this job as candidate is read, marked unplaced", async () => {
  const placed = sms("p1", "2026-10-01T02:00:00.000Z", {
    job_id: JOB,
    attribution_status: "attributed",
    candidate_job_ids: null,
  });
  const held = sms("h1", "2026-10-09T03:02:52.647Z");
  const { res } = await read([placed, held], { held_contact_ids: [PAYER] });
  assertEquals(ids(res), ["bev:h1", "bev:p1"]);
  const h = res.messages[0];
  assertEquals(h.unplaced, true);
  assertEquals(h.candidate_job_count, 1);
  assertEquals(h.contact_id, PAYER);
  assertEquals(h.body, "text h1");
  assertEquals(h.job_id, JOB);
  // The placed message is not marked.
  assertEquals(res.messages[1].unplaced, undefined);
  // pending_luna is held too.
  const pending = sms("h2", "2026-10-10T01:00:00.000Z", {
    attribution_status: "pending_luna",
  });
  const two = await read([held, pending], { held_contact_ids: [PAYER] });
  assertEquals(ids(two.res), ["bev:h2", "bev:h1"]);
});

Deno.test("held: nothing is read unless a contact is asked for (every other caller unchanged)", async () => {
  const { res, client } = await read(
    [sms("h1", "2026-10-09T03:00:00.000Z")],
    {},
  );
  assertEquals(res.messages, []);
  assertEquals(
    client.reads.filter((r) =>
      r.table === "business_events" &&
      r.filters.includes("contains:candidate_job_ids")
    ).length,
    0,
  );
  // A malformed contact id reads nothing either.
  const bad = await read([sms("h1", "2026-10-09T03:00:00.000Z")], {
    held_contact_ids: ["bad id!"],
  });
  assertEquals(bad.res.messages, []);
});

Deno.test("held: a message from another contact is not read onto the job", async () => {
  const { res } = await read([
    sms("h1", "2026-10-09T03:00:00.000Z", {
      contact_id: STRANGER,
      entity_id: STRANGER,
    }),
  ], { held_contact_ids: [PAYER] });
  assertEquals(res.messages, []);
});

Deno.test("held: a message whose candidates do not include this job is not read", async () => {
  const { res } = await read([
    sms("h1", "2026-10-09T03:00:00.000Z", { candidate_job_ids: [OTHER_JOB] }),
    // Placed on another job: never read here, whatever its candidates.
    sms("h2", "2026-10-09T04:00:00.000Z", {
      job_id: OTHER_JOB,
      attribution_status: "attributed",
      candidate_job_ids: [JOB, OTHER_JOB],
    }),
  ], { held_contact_ids: [PAYER] });
  assertEquals(res.messages, []);
});

Deno.test("held: a duplicate of a message already on the job shows once, as the placed copy", async () => {
  const placed = sms("p1", "2026-10-09T03:00:00.000Z", {
    job_id: JOB,
    attribution_status: "attributed",
    candidate_job_ids: null,
    provider_message_id: "ghl:same-message",
  });
  const copy = sms("h1", "2026-10-09T03:00:00.000Z", {
    provider_message_id: "ghl:same-message",
  });
  const { res } = await read([placed, copy], { held_contact_ids: [PAYER] });
  assertEquals(ids(res), ["bev:p1"]);
  assertEquals(res.messages[0].unplaced, undefined);
});

Deno.test("held: on a shared fence only the payer's contact counts", async () => {
  // The neighbour owes; the main client's held message stays off the payer's read.
  const fromMain = sms("h1", "2026-10-09T03:00:00.000Z");
  const fromNeighbour = sms("h2", "2026-10-08T03:00:00.000Z", {
    contact_id: NEIGHBOUR,
    entity_id: NEIGHBOUR,
  });
  const { res } = await read([fromMain, fromNeighbour], {
    held_contact_ids: [NEIGHBOUR],
  });
  assertEquals(ids(res), ["bev:h2"]);
  assertEquals(res.messages[0].contact_id, NEIGHBOUR);
  assertEquals(res.messages[0].unplaced, true);
});

Deno.test("held: the limit keeps the newest messages, held ones included", async () => {
  const placed = Array.from(
    { length: 6 },
    (_, k) =>
      sms(`p${k}`, `2026-09-0${k + 1}T01:00:00.000Z`, {
        job_id: JOB,
        attribution_status: "attributed",
        candidate_job_ids: null,
      }),
  );
  const held = sms("h1", "2026-10-09T03:00:00.000Z");
  const { res } = await read([...placed, held], {
    held_contact_ids: [PAYER],
    limit: 3,
  });
  assertEquals(ids(res), ["bev:h1", "bev:p5", "bev:p4"]);
});

Deno.test("heldConversationMessages: rows are checked again, whatever the read returned", () => {
  const customer = new Set<string>();
  const rows = [
    sms("ok", "2026-10-09T03:00:00.000Z"),
    sms("placed", "2026-10-09T03:00:00.000Z", { job_id: OTHER_JOB }),
    sms("not-held", "2026-10-09T03:00:00.000Z", {
      attribution_status: "attributed",
    }),
    sms("stranger", "2026-10-09T03:00:00.000Z", { contact_id: STRANGER }),
    sms("other-job", "2026-10-09T03:00:00.000Z", {
      candidate_job_ids: [OTHER_JOB],
    }),
    sms("retracted", "2026-10-09T03:00:00.000Z", { retracted: "true" }),
    sms("copy", "2026-10-09T03:00:00.000Z", { duplicate_of: "x" }),
    sms("in-cache", "2026-10-09T03:00:00.000Z", {
      provider_message_id: "ghl:cache-1",
    }),
    sms("placed-copy", "2026-10-09T03:00:00.000Z", {
      provider_message_id: "ghl:placed-1",
    }),
  ];
  const existing = [
    { source_system: "ghl_cache", source_ref: "cache-1" },
    {
      source_system: "business_events",
      source_ref: "p1",
      provider_message_id: "ghl:placed-1",
    },
  ];
  const out = heldConversationMessages(rows, JOB, [PAYER], customer, existing);
  // A copy shown only from the GoHighLevel cache does not hide the held row (the
  // reader drops the cache copy); a placed business_events copy does.
  assertEquals(out.map((m) => m.id), ["bev:ok", "bev:in-cache"]);
  assert(out.every((m) => m.unplaced === true));
  assertEquals(heldConversationMessages(rows, JOB, [], customer, []), []);
});

// ── Debt review, 15 Oct 2026 (follow-up to PR 1056) ──
//
// (1) A held message that is also in the payer's GoHighLevel cache reached the agent as
//     the unmarked cache copy. (2) The agent bundle sorted "...Z" after "...+00:00" for
//     one instant, so the unmarked copy was taken as newest (SWF-261423: a call held on 2
//     jobs, its call log in the cache). (3) A failed held read was logged and swallowed,
//     so a move was checked against a read missing the held messages. These tests drive
//     the real reader (getJobConversation) with a fake database.

const CALL_AT_Z = "2026-10-05T09:49:46.859Z";
const CALL_AT_OFFSET = "2026-10-05T09:49:46.859+00:00";

/** A GoHighLevel cache thread row for `contact`, with these messages. */
function cacheRow(contact: string, jobId: string, msgs: any[]) {
  return {
    contact_id: contact,
    job_id: jobId,
    messages: msgs,
    message_count: msgs.length,
  };
}

Deno.test("held: a held message also in the GoHighLevel cache shows once, as the held row, marked", async () => {
  const held = sms("h1", "2026-10-09T03:00:00.000+00:00", {
    provider_message_id: "ghl:cached-1",
    candidate_job_ids: [JOB, OTHER_JOB],
    direction: "inbound",
    event_type: "client.reply",
  });
  const cache = cacheRow(PAYER, JOB, [{
    id: "cached-1",
    type: "TYPE_SMS",
    direction: "inbound",
    timestamp: "2026-10-09T03:00:00.000Z",
    body: "text h1",
  }, {
    id: "cached-2",
    type: "TYPE_SMS",
    direction: "outbound",
    timestamp: "2026-10-01T03:00:00.000Z",
    body: "plain cache text",
  }]);
  const t = { ...tables([held]), ghl_conversation_cache: [cache] };
  const res: any = await _getJobConversationForTest(filteringClient(t), {
    job_id: JOB,
    limit: 50,
    held_contact_ids: [PAYER],
  });
  assertEquals(ids(res), ["bev:h1", "ghl:cached-2"]);
  assertEquals(res.messages[0].unplaced, true);
  assertEquals(res.messages[0].candidate_job_count, 2);
  assertEquals(res.messages[1].unplaced, undefined);
  assertEquals(res.held_read_failed, false);

  // A caller that does not ask for held messages gets exactly what it got before:
  // both cache messages, unmarked, and no held_read_failed key.
  const plain: any = await _getJobConversationForTest(filteringClient(t), {
    job_id: JOB,
    limit: 50,
  });
  assertEquals(ids(plain), ["ghl:cached-1", "ghl:cached-2"]);
  assert(plain.messages.every((m: any) => m.unplaced === undefined));
  assertEquals("held_read_failed" in plain, false);
});

Deno.test("held: a failed held read is reported as held_read_failed", async () => {
  const t = tables([sms("h1", "2026-10-09T03:00:00.000Z")]);
  const failHeld = (table: string, f: string[]) =>
    table === "business_events" && f.includes("contains:candidate_job_ids")
      ? "canceling statement due to statement timeout"
      : null;
  const res: any = await _getJobConversationForTest(
    filteringClient(t, failHeld),
    { job_id: JOB, limit: 50, held_contact_ids: [PAYER] },
  );
  assertEquals(res.held_read_failed, true);
  assertEquals(res.messages, []);
  // Without held_contact_ids the held read never runs and nothing is reported.
  const plain: any = await _getJobConversationForTest(
    filteringClient(t, failHeld),
    { job_id: JOB, limit: 50 },
  );
  assertEquals("held_read_failed" in plain, false);
});

Deno.test("compareConversationNewestFirst: one instant in Z and +00:00 is equal, the held copy first", () => {
  const unmarked = { id: "a", occurred_at: CALL_AT_Z };
  const held = { id: "b", occurred_at: CALL_AT_OFFSET, unplaced: true };
  const older = { id: "c", occurred_at: "2026-10-04T00:00:00Z" };
  const none = { id: "d", occurred_at: null };
  const sorted = [none, older, unmarked, held].sort(
    compareConversationNewestFirst,
  );
  assertEquals(sorted.map((m) => m.id), ["b", "a", "c", "d"]);
  // Without held messages the order is the plain newest-first order, ties kept.
  const tie = [{ id: "x", occurred_at: CALL_AT_OFFSET }, {
    id: "y",
    occurred_at: CALL_AT_Z,
  }]
    .sort(compareConversationNewestFirst);
  assertEquals(tie.map((m) => m.id), ["x", "y"]);
});

// The Debt Workshop's submit check driven by the real reader. The fake job SWF-90001
// (JOBS.fence) owes IDS.final; its payer's GoHighLevel contact is FENCE_PAYER.
const FENCE_PAYER = "ghlcontact0000000001";

const SAYS_PAID_MOVE = {
  xero_invoice_id: IDS.final,
  step: "reply_says_paid",
  kind: "move",
  channel: "sms",
  text: "Thanks Alex! It hasn't shown up our end yet.\n\nCheers,\nShaun",
  why: "Client said on the call they paid.",
  proposed_category: "says_paid",
  agent_version: "debt-ws-playbook/v1",
};

function fenceTables(events: any[], cache: any[]) {
  return {
    jobs: [{
      id: JOBS.fence,
      job_number: "SWF-90001",
      ghl_contact_id: FENCE_PAYER,
      client_email: null,
    }],
    job_contacts: [],
    ghl_conversation_cache: cache.length
      ? [cacheRow(FENCE_PAYER, JOBS.fence, cache)]
      : [],
    inbox_events: [],
    job_events: [],
    email_events: [],
    business_events: events,
  };
}

/** A business_events call row held on no job, with these candidates. */
function heldCall(
  id: string,
  over: Record<string, unknown>,
  candidates = [JOBS.fence, OTHER_JOB],
) {
  return sms(id, CALL_AT_OFFSET, {
    channel: "call",
    direction: "inbound",
    contact_id: FENCE_PAYER,
    entity_id: FENCE_PAYER,
    candidate_job_ids: candidates,
    ...over,
  });
}

/** The 5 Oct call log as the GoHighLevel cache holds it (Z stamp, empty body). */
const CACHED_CALL_LOG = {
  id: "call-1",
  type: "TYPE_CALL",
  direction: "inbound",
  timestamp: CALL_AT_Z,
  body: "",
};

/** fakeDeps whose conversation is the real reader over this fake database. */
function realReaderDeps(
  t: Record<string, any[]>,
  fail?: (table: string, filters: string[]) => string | null,
) {
  const store = new FakeStore();
  store.settingsRow.agent_enabled = true;
  const { deps, rec } = fakeDeps(store);
  const client = filteringClient(t, fail);
  deps.conversation = (jobId, limit, contactIds, heldContactIds) =>
    _getJobConversationForTest(client, {
      job_id: jobId,
      limit,
      ...(contactIds?.length ? { extra_contact_ids: contactIds } : {}),
      ...(heldContactIds?.length ? { held_contact_ids: heldContactIds } : {}),
    }) as any;
  return { store, deps, rec };
}

async function submit(deps: any, input: Record<string, unknown>) {
  const res = await runDebtWsAction(
    "debt_ws_agent_submit",
    DEBT_WS_ACTIONS.debt_ws_agent_submit.method,
    new URLSearchParams(),
    input,
    SERVER,
    deps,
  );
  return res as { status: number; body: any };
}

Deno.test("debt agent, real reader: SWF-261423 shape, the call held on 2 jobs turns a says-paid move into a flag", async () => {
  // The call log is in the cache AND held (same GoHighLevel id); its transcript is held.
  const callLog = heldCall("call-log", {
    event_type: "client.call_logged",
    provider_message_id: "ghl:call-1",
    body_preview: "",
    payload: {},
  });
  const transcript = heldCall("call-tx", {
    event_type: "call.transcript_completed",
    provider_message_id: "ghltx:call-1",
    body_preview: "I paid it yesterday",
    payload: { transcript: "I paid it yesterday" },
  });
  const { store, deps, rec } = realReaderDeps(
    fenceTables([callLog, transcript], [CACHED_CALL_LOG]),
  );
  const res = await submit(deps, SAYS_PAID_MOVE);
  assertEquals(res.status, 200);
  assertEquals(res.body.kind, "flag");
  assertEquals(res.body.move_refused.reason, "held_message_several_jobs");
  assertEquals(res.body.move_refused.candidate_job_count, 2);
  // The held copy of the call log replaced the unmarked cache copy.
  assert(String(res.body.move_refused.message_id).startsWith("bev:"));
  assertEquals(rec.conversationReads.length, 0); // the fake reader was not used
  assertEquals(store.suggestionRows[0].kind, "flag");
  assertEquals(store.suggestionRows[0].proposed_category, null);
  assertEquals(rec.statusMoves.length, 0);
  assertEquals(rec.sms.length, 0);
});

Deno.test("debt agent, real reader: an unmarked cache copy and a held message at one instant, the held one is newest", async () => {
  // Only the transcript is held; the call log is in the cache alone (Z stamp). Compared
  // as strings the Z copy sorted last and the move stood.
  const transcript = heldCall("call-tx", {
    event_type: "call.transcript_completed",
    provider_message_id: "ghltx:call-1",
    body_preview: "I paid it yesterday",
    payload: { transcript: "I paid it yesterday" },
  });
  const { store, deps } = realReaderDeps(
    fenceTables([transcript], [CACHED_CALL_LOG]),
  );
  const res = await submit(deps, SAYS_PAID_MOVE);
  assertEquals(res.status, 200);
  assertEquals(res.body.kind, "flag");
  assertEquals(res.body.move_refused.message_id, "bev:call-tx");
  assertEquals(store.suggestionRows[0].kind, "flag");
});

Deno.test("debt agent, real reader: a held message on this job alone still lets a move stand", async () => {
  const transcript = heldCall("call-tx", {
    event_type: "call.transcript_completed",
    provider_message_id: "ghltx:call-1",
    body_preview: "I paid it yesterday",
    payload: { transcript: "I paid it yesterday" },
  }, [JOBS.fence]);
  const callLog = heldCall("call-log", {
    event_type: "client.call_logged",
    provider_message_id: "ghl:call-1",
    body_preview: "",
    payload: {},
  }, [JOBS.fence]);
  const { store, deps } = realReaderDeps(
    fenceTables([callLog, transcript], [CACHED_CALL_LOG]),
  );
  const res = await submit(deps, SAYS_PAID_MOVE);
  assertEquals(res.status, 200);
  assertEquals(res.body.kind, "move");
  assertEquals(res.body.move_refused, undefined);
  assertEquals(store.suggestionRows[0].proposed_category, "says_paid");
});

Deno.test("debt agent, real reader: a failed held read refuses a move (503), a flag still goes in", async () => {
  const failHeld = (table: string, f: string[]) =>
    table === "business_events" && f.includes("contains:candidate_job_ids")
      ? "canceling statement due to statement timeout"
      : null;
  const { store, deps } = realReaderDeps(
    fenceTables([], [CACHED_CALL_LOG]),
    failHeld,
  );
  const move = await submit(deps, SAYS_PAID_MOVE);
  assertEquals(move.status, 503);
  assertEquals(move.body.code, "conversation_unreadable");
  const rect = await submit(deps, {
    ...SAYS_PAID_MOVE,
    step: "reply_problem",
    proposed_category: "rectification",
    why: "Client says the gate is broken.",
  });
  assertEquals(rect.status, 503);
  assertEquals(rect.body.code, "conversation_unreadable");
  // Nothing stored and nothing stamped for the refused moves.
  assertEquals(store.suggestionRows.length, 0);
  assertEquals(
    store.stateRows.find((s) => s.share_key === IDS.final)?.agent_reviewed_at ??
      null,
    null,
  );
  // A flag is not checked against the read and goes in as before.
  const flag = await submit(deps, {
    ...SAYS_PAID_MOVE,
    kind: "flag",
    channel: null,
    step: null,
    proposed_category: null,
    text: "Client mentioned a payment on a call",
  });
  assertEquals(flag.status, 200);
  assertEquals(flag.body.kind, "flag");
  assertEquals(store.suggestionRows.length, 1);
});
