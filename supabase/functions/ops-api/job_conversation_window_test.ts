// deno-lint-ignore-file no-explicit-any no-import-prefix
//
// Ask the story (6 Oct 2026): one period's messages. A question such as "what
// happened on this job in August" reads get_job_conversation with since and
// until. Without until the read is the newest `limit` messages after since,
// so on a job whose later months hold more than the limit, August never
// arrives. Pins:
//   Window   since and until are ISO date-times or absent; anything else, or
//            an until before since, is refused (400 invalid_window), never
//            read as no window.
//   Reader   readBusinessEventsBySourceTime caps both reads (rows with
//            event_at, and rows timed by occurred_at) at until, inclusive.
//   Merge    every source of get_job_conversation (CRM cache, old inbox,
//            staff notes, business_events, system emails) stops at until, and
//            the newest N inside the window are returned, not the newest N.
//   Unchanged with no until: the same read as before.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _getJobConversationForTest } from "./index.ts";
import {
  conversationWindow,
  happenedBy,
  readBusinessEventsBySourceTime,
  TIMELINE_MESSAGE_COLUMNS,
} from "./job_conversation_timeline.ts";

type Tables = Record<string, any[]>;
const WRITE_METHODS = ["insert", "update", "upsert", "delete"];

/** Read-only fake honouring eq, is, not is, gt, gte, lt, lte, in, ilike, the message or() filter, order and limit. */
function fakeClient(tables: Tables) {
  return {
    rpc() {
      return Promise.resolve({ data: null, error: { code: "57014", message: "not in fake" } });
    },
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      const orders: Array<{ col: string; asc: boolean }> = [];
      let limit: number | null = null;
      let single = false;
      const q: any = {};
      for (const m of WRITE_METHODS) q[m] = () => { throw new Error(`write attempted: ${m} ${table}`); };
      const has = (r: any, c: string) => r[c] !== null && r[c] !== undefined;
      q.select = () => q;
      q.eq = (c: string, v: any) => (filters.push((r) => r[c] === v), q);
      q.neq = (c: string, v: any) => (filters.push((r) => r[c] !== v), q);
      q.ilike = (c: string, v: any) => (filters.push((r) => String(r[c] ?? "").toLowerCase() === String(v).toLowerCase()), q);
      q.is = (c: string, v: any) => (filters.push((r) => (r[c] ?? null) === v), q);
      q.not = (c: string, op: string, v: any) => (op === "is" && filters.push((r) => (r[c] ?? null) !== v), q);
      q.gt = (c: string, v: any) => (filters.push((r) => has(r, c) && Date.parse(r[c]) > Date.parse(v)), q);
      q.gte = (c: string, v: any) => (filters.push((r) => has(r, c) && Date.parse(r[c]) >= Date.parse(v)), q);
      q.lt = (c: string, v: any) => (filters.push((r) => has(r, c) && Date.parse(r[c]) < Date.parse(v)), q);
      q.lte = (c: string, v: any) => (filters.push((r) => has(r, c) && Date.parse(r[c]) <= Date.parse(v)), q);
      q.in = (c: string, vs: any[]) => (filters.push((r) => vs.includes(r[c])), q);
      q.or = (expr: string) => {
        const m = /^channel\.in\.\(([^)]*)\),event_type\.in\.\(([^)]*)\)$/.exec(expr);
        if (m) {
          const channels = m[1].split(",");
          const types = m[2].split(",").map((t) => t.replace(/"/g, ""));
          filters.push((r) => channels.includes(r.channel) || types.includes(r.event_type));
        }
        return q;
      };
      q.contains = () => q;
      q.range = () => q;
      q.order = (col: string, o?: { ascending?: boolean }) => (orders.push({ col, asc: o?.ascending !== false }), q);
      q.limit = (n: number) => ((limit = n), q);
      q.maybeSingle = () => ((single = true), q);
      q.single = q.maybeSingle;
      q.then = (resolve: any, reject: any) => {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        rows = [...rows].sort((a, b) => {
          for (const o of orders) {
            const av = a[o.col] ?? "";
            const bv = b[o.col] ?? "";
            if (av < bv) return o.asc ? -1 : 1;
            if (av > bv) return o.asc ? 1 : -1;
          }
          return 0;
        });
        if (limit !== null) rows = rows.slice(0, limit);
        return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve, reject);
      };
      return q;
    },
  };
}

const JOB = "6a000000-0000-4000-8000-000000000001";
const AUG_START = "2026-07-31T16:00:00.000Z"; // 1 Aug 00:00 Perth
const AUG_END = "2026-08-31T15:59:59.999Z"; // 31 Aug 23:59:59.999 Perth

/** A text on the job, n hours after `start`. */
function text(id: string, at: string, over: Record<string, unknown> = {}) {
  return {
    id,
    job_id: JOB,
    event_type: "client.sms_in",
    source: "fixture",
    channel: "sms",
    direction: "inbound",
    event_at: at,
    occurred_at: "2026-10-05T01:00:00.000Z", // loaded later; the source time is event_at
    payload: { body: `words ${id}` },
    ...over,
  };
}
const hours = (start: string, n: number) => new Date(Date.parse(start) + n * 3_600_000).toISOString();

function tables(): Tables {
  // 3 texts in August, then 60 in September and October: more than a limit of 50 after August.
  const events = [
    text("aug-1", hours(AUG_START, 2)),
    text("aug-2", hours(AUG_START, 300)),
    text("aug-last", AUG_END),
    // A row with no event_at is timed by occurred_at.
    text("aug-unstamped", hours(AUG_START, 400), { event_at: null, occurred_at: hours(AUG_START, 400) }),
    ...Array.from({ length: 60 }, (_, i) => text(`later-${i}`, hours("2026-09-01T00:00:00.000Z", i * 12))),
  ];
  return {
    jobs: [{ id: JOB, job_number: "SWP-99931", ghl_contact_id: "contact-1", client_email: "client@example.test" }],
    job_contacts: [],
    ghl_conversation_cache: [{
      contact_id: "contact-1",
      job_id: JOB,
      synced_at: "2026-10-05T00:00:00.000Z",
      messages: [
        { id: "cache-aug", timestamp: hours(AUG_START, 50), direction: "inbound", type: "TYPE_SMS", body: "cache august" },
        { id: "cache-sep", timestamp: "2026-09-20T02:00:00.000Z", direction: "outbound", type: "TYPE_SMS", body: "cache september" },
      ],
    }],
    inbox_events: [
      { id: "inbox-aug", job_id: JOB, from_email: "client@example.test", subject: "Aug", body_preview: "inbox august", received_at: hours(AUG_START, 100) },
      { id: "inbox-oct", job_id: JOB, from_email: "client@example.test", subject: "Oct", body_preview: "inbox october", received_at: "2026-10-02T02:00:00.000Z" },
    ],
    job_events: [
      { id: "note-aug", job_id: JOB, event_type: "note", detail_json: { text: "note august" }, created_at: hours(AUG_START, 120) },
      { id: "note-sep", job_id: JOB, event_type: "note", detail_json: { text: "note september" }, created_at: "2026-09-03T02:00:00.000Z" },
    ],
    email_events: [
      { id: "mail-aug", job_id: JOB, email_type: "quote_sent", recipient: "client@example.test", subject: "Quote", status: "delivered", sent_at: hours(AUG_START, 140), created_at: hours(AUG_START, 140) },
      { id: "mail-sep", job_id: JOB, email_type: "invoice", recipient: "client@example.test", subject: "Invoice", status: "delivered", sent_at: "2026-09-25T02:00:00.000Z", created_at: "2026-09-25T02:00:00.000Z" },
    ],
    business_events: events,
    feature_flags: [],
  };
}

Deno.test("window: since and until are ISO date-times or absent; anything else is refused, never read as no window", () => {
  assertEquals(conversationWindow({}), { since: null, until: null, error: null });
  assertEquals(conversationWindow({ since: AUG_START, until: AUG_END }), { since: AUG_START, until: AUG_END, error: null });
  assertEquals(conversationWindow({ until: "" }), { since: null, until: null, error: null });
  assertEquals(conversationWindow({ until: "August" }).error, "until must be an ISO date-time");
  assertEquals(conversationWindow({ since: 5 }).error, "since must be an ISO date-time");
  assertEquals(conversationWindow({ since: AUG_END, until: AUG_START }).error, "until is before since");
  assert(happenedBy(AUG_END, AUG_END));
  assert(!happenedBy("2026-08-31T16:00:00.000Z", AUG_END));
  assert(happenedBy("not a time", AUG_END), "a message with no readable time is kept, never dropped silently");
  assert(happenedBy("2030-01-01T00:00:00.000Z", null));
});

Deno.test("reader: both reads stop at until, inclusive, and give the newest N inside the window", async () => {
  const client = fakeClient(tables());
  const { rows, error } = await readBusinessEventsBySourceTime(client, {
    jobId: JOB, select: TIMELINE_MESSAGE_COLUMNS, limit: 50, since: AUG_START, until: AUG_END, messagesOnly: true,
  });
  assertEquals(error, null);
  assertEquals(rows.map((r: any) => r.id), ["aug-unstamped", "aug-last", "aug-2", "aug-1"].sort((a, b) => {
    const at = (id: string) => Date.parse(tables().business_events.find((r) => r.id === id)!.event_at ?? tables().business_events.find((r) => r.id === id)!.occurred_at);
    return at(b) - at(a);
  }));
});

Deno.test("get_job_conversation: a period read gives that period's messages from every source, even when later months hold more than the limit", async () => {
  const client = fakeClient(tables());
  const answer: any = await _getJobConversationForTest(client, { job_id: JOB, limit: 50, since: AUG_START, until: AUG_END });
  const ids = answer.messages.map((m: any) => m.id).sort();
  assertEquals(ids, [
    "bev:aug-1", "bev:aug-2", "bev:aug-last", "bev:aug-unstamped",
    "email_event:mail-aug", "ghl:cache-aug", "inbox:inbox-aug", "note:note-aug",
  ].sort());
  assert(answer.messages.every((m: any) => Date.parse(m.occurred_at) <= Date.parse(AUG_END)));
  assertEquals(answer.summary.window, { since: AUG_START, until: AUG_END });
  // Without until, the same request is the newest 50 after since, as before: August's texts are pushed out.
  const before: any = await _getJobConversationForTest(fakeClient(tables()), { job_id: JOB, limit: 50, since: AUG_START });
  assertEquals(before.messages.length, 50);
  assert(!before.messages.some((m: any) => m.id === "bev:aug-1"));
  assertEquals(before.summary.window, { since: AUG_START, until: null });
});

Deno.test("dispatch: get_job_conversation refuses an unreadable window with 400 invalid_window before any read", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const at = index.indexOf("case 'get_job_conversation': {");
  assert(at > 0, "the case has its own block");
  const block = index.slice(at, at + 400);
  assert(block.includes("const asked = conversationWindow(body)"));
  assert(block.includes("if (asked.error) return json({ error: asked.error, code: 'invalid_window' }, 400)"));
  assert(block.indexOf("conversationWindow(body)") < block.indexOf("getJobConversation(client, body)"), "the window is checked first");
});
