// W3-A (M-E hybrid loop) — admin@ Sent-Items MIRROR tests.
//
// Covers the incremental/backfill window, the Graph-message -> emails-row mapper
// (folder tag + populated to_recipients), and the DB action (idempotent upsert,
// one audit event per NEW message, watermark advance) against a data-driven mock.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ADMIN_SENT_MAILBOX,
  computeSentWindow,
  type GraphSentMessage,
  makesafeSentMirror,
  mapSentMessageToEmailRow,
  maxReceivedAt,
  recipientsString,
  SENT_BACKFILL_DAYS,
  SENT_FOLDER,
} from "./makesafe_sent_mirror.ts";

// postgrest-js urlLengthLimit, and the gateway/runtime limit that surfaces an
// over-long `.in()` as `TypeError: Invalid URL` (see makesafe_compact_reads.ts).
const POSTGREST_URL_LIMIT = 8000;

// A live admin@ Graph id from this repo: 152 chars, trailing "=".
const LIVE_GRAPH_POST_ID =
  "AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAHgFepAAA=";

function realisticGraphPostId(index: number): string {
  const tail = index.toString(36).padStart(6, "0");
  return LIVE_GRAPH_POST_ID.slice(0, LIVE_GRAPH_POST_ID.length - 7) + tail +
    "=";
}

// The URL postgrest-js 2.99.3 builds for `.select().eq()*.in()`.
function postgrestInUrl(
  table: string,
  ids: string[],
  extra: Array<[string, string]> = [],
): string {
  const url = new URL(
    `https://kevgrhcjxspbxgovpmfl.supabase.co/rest/v1/${table}`,
  );
  url.searchParams.set("select", "post_id");
  for (const [column, value] of extra) url.searchParams.append(column, value);
  const cleaned = [...new Set(ids)].map((
    s,
  ) => (/[,()]/.test(s) ? `"${s}"` : `${s}`)).join(",");
  url.searchParams.append("post_id", `in.(${cleaned})`);
  return url.toString();
}

function assertUrlSendable(url: string): void {
  new URL(url);
  if (url.length > POSTGREST_URL_LIMIT) {
    throw new TypeError(
      `Invalid URL: ${url.slice(0, 96)}… (${url.length} chars)`,
    );
  }
}

// ════════════════════ window logic ════════════════════

Deno.test("window: first run (no cursor) reaches back the 90-day bounded backfill", () => {
  const now = "2026-07-08T00:00:00Z";
  const { sinceIso, initialBackfill } = computeSentWindow(null, now);
  assert(initialBackfill);
  const gapDays = (Date.parse(now) - Date.parse(sinceIso)) / 86_400_000;
  assertEquals(Math.round(gapDays), SENT_BACKFILL_DAYS);
});

Deno.test("window: incremental run uses cursor minus overlap", () => {
  const now = "2026-07-08T00:00:00Z";
  const cursor = "2026-07-07T12:00:00Z";
  const { sinceIso, initialBackfill } = computeSentWindow(cursor, now, {
    overlapSeconds: 900,
  });
  assertEquals(initialBackfill, false);
  assertEquals(sinceIso, "2026-07-07T11:45:00.000Z"); // cursor - 15min overlap
});

Deno.test("window: a corrupt way-back cursor is floored at the 90-day retention edge", () => {
  const now = "2026-07-08T00:00:00Z";
  const cursor = "2020-01-01T00:00:00Z"; // absurdly old
  const { sinceIso } = computeSentWindow(cursor, now);
  const gapDays = (Date.parse(now) - Date.parse(sinceIso)) / 86_400_000;
  assert(
    gapDays <= SENT_BACKFILL_DAYS + 0.01,
    "never scans earlier than the backfill floor",
  );
});

// ════════════════════ mapper ════════════════════

const MSG: GraphSentMessage = {
  id: "AAMk-sent-1",
  internetMessageId: "<abc@ourdomain>",
  conversationId: "conv-1",
  sentDateTime: "2026-07-07T05:00:00Z",
  receivedDateTime: "2026-07-07T05:00:01Z",
  subject: "Make Safe Report and Invoice - Job No 66949",
  bodyPreview: "Please find attached...",
  hasAttachments: true,
  from: {
    emailAddress: {
      address: "admin@secureworkswa.com.au",
      name: "SecureWorks",
    },
  },
  toRecipients: [
    { emailAddress: { address: "workorders@ajs.build" } },
    { emailAddress: { address: "accounts@ajs.build" } },
  ],
  ccRecipients: [{ emailAddress: { address: "marnin@secureworkswa.com.au" } }],
  body: { contentType: "html", content: "<p>report</p>" },
};

Deno.test("mapper: folder-tagged sentitems row with populated to_recipients", () => {
  const row = mapSentMessageToEmailRow(MSG, "2026-07-08T00:00:00Z");
  assertEquals(row.post_id, "AAMk-sent-1");
  assertEquals(row.mailbox, ADMIN_SENT_MAILBOX);
  assertEquals(row.folder, SENT_FOLDER);
  assertEquals(row.from_email, "admin@secureworkswa.com.au");
  // to + cc joined, deduped, in order.
  assertEquals(
    row.to_recipients,
    "workorders@ajs.build, accounts@ajs.build, marnin@secureworkswa.com.au",
  );
  assertEquals(row.received_at, "2026-07-07T05:00:00Z"); // prefers sentDateTime
  assertEquals(row.has_attachments, true);
});

Deno.test("recipientsString: null when there are no recipients", () => {
  assertEquals(
    recipientsString({ ...MSG, toRecipients: [], ccRecipients: [] }),
    null,
  );
});

Deno.test("maxReceivedAt: freshest across a batch (drives the cursor)", () => {
  assertEquals(
    maxReceivedAt([
      { id: "a", sentDateTime: "2026-07-01T00:00:00Z" },
      { id: "b", sentDateTime: "2026-07-05T00:00:00Z" },
      { id: "c", receivedDateTime: "2026-07-03T00:00:00Z" },
    ]),
    "2026-07-05T00:00:00Z",
  );
});

// ════════════════════ DB action (mock client) ════════════════════

type Tables = {
  emails?: any[];
  email_events_raw?: any[];
  mail_sync_cursors?: any[];
};
type InCall = {
  table: string;
  column: string;
  ids: string[];
  eqs: Record<string, unknown>;
};
type Fail = {
  table: string;
  op: "select" | "insert" | "upsert";
  onCall: number;
  message: string;
  seen?: number;
};

function makeClient(tables: Tables, fail?: Fail) {
  tables.emails = tables.emails || [];
  tables.email_events_raw = tables.email_events_raw || [];
  tables.mail_sync_cursors = tables.mail_sync_cursors || [];
  const upserts: Array<{ table: string; rows: any[] }> = [];
  const inCalls: InCall[] = [];
  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const ins: Record<string, any[]> = {};
    let op: "select" | "insert" | "upsert" = "select";
    let payload: any = null;
    let conflict: string | null = null;
    const rowsOf = () => (tables[table as keyof Tables] || []) as any[];
    const match = () => {
      let rows = rowsOf().slice();
      for (const [k, v] of Object.entries(eqs)) {
        rows = rows.filter((r) => r[k] === v);
      }
      for (const [k, arr] of Object.entries(ins)) {
        rows = rows.filter((r) => arr.includes(r[k]));
      }
      return rows;
    };
    const doUpsert = () => {
      const arr = Array.isArray(payload) ? payload : [payload];
      const store = rowsOf();
      for (const row of arr) {
        const key = conflict || "post_id";
        const idx = store.findIndex((r) => r[key] === row[key]);
        if (idx >= 0) store[idx] = { ...store[idx], ...row };
        else store.push({ ...row });
      }
      upserts.push({ table, rows: arr });
      return { data: null, error: null };
    };
    const doInsert = () => {
      const arr = Array.isArray(payload) ? payload : [payload];
      for (const row of arr) rowsOf().push({ ...row });
      return { data: null, error: null };
    };
    const resolve = () => {
      if (fail && fail.table === table && fail.op === op) {
        fail.seen = (fail.seen ?? 0) + 1;
        if (fail.seen === fail.onCall) {
          return { data: null, error: { message: fail.message } };
        }
      }
      if (op === "upsert") return doUpsert();
      if (op === "insert") return doInsert();
      return { data: match(), error: null };
    };
    const b: any = {
      select: () => b,
      eq: (k: string, v: any) => {
        eqs[k] = v;
        return b;
      },
      in: (k: string, arr: any[]) => {
        ins[k] = arr;
        inCalls.push({ table, column: k, ids: [...arr], eqs: { ...eqs } });
        return b;
      },
      upsert: (rows: any, opts?: any) => {
        op = "upsert";
        payload = rows;
        conflict = opts?.onConflict ?? null;
        return b;
      },
      insert: (rows: any) => {
        op = "insert";
        payload = rows;
        return b;
      },
      maybeSingle: () =>
        Promise.resolve({ data: match()[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej),
    };
    return b;
  }
  return {
    from: (t: string) => builder(t),
    __upserts: upserts,
    __inCalls: inCalls,
  };
}

const A: GraphSentMessage = {
  ...MSG,
  id: "m-a",
  sentDateTime: "2026-07-07T01:00:00Z",
};
const B: GraphSentMessage = {
  ...MSG,
  id: "m-b",
  sentDateTime: "2026-07-07T02:00:00Z",
};

Deno.test("mirror: upserts emails, writes one audit event per NEW message, advances cursor", async () => {
  const tables: Tables = {};
  const client = makeClient(tables);
  const res = await makesafeSentMirror(client, {
    nowIso: "2026-07-08T00:00:00Z",
    fetchSentMessages: () => Promise.resolve([A, B]),
  });
  assertEquals(res.fetched, 2);
  assertEquals(res.upserted, 2);
  assertEquals(res.new_events, 2);
  assertEquals(res.cursor_advanced_to, "2026-07-07T02:00:00Z");
  assertEquals(tables.emails!.length, 2);
  assertEquals(
    tables.emails!.every((e) =>
      e.folder === SENT_FOLDER && e.mailbox === ADMIN_SENT_MAILBOX
    ),
    true,
  );
  assertEquals(tables.email_events_raw!.length, 2);
  assertEquals(
    tables.mail_sync_cursors![0].last_completed_max,
    "2026-07-07T02:00:00Z",
  );
  assertEquals(tables.mail_sync_cursors![0].mailbox, ADMIN_SENT_MAILBOX);
});

Deno.test("mirror: idempotent re-run of the same window adds NO duplicate audit events", async () => {
  const tables: Tables = {};
  const client = makeClient(tables);
  await makesafeSentMirror(client, {
    nowIso: "2026-07-08T00:00:00Z",
    fetchSentMessages: () => Promise.resolve([A, B]),
  });
  const res2 = await makesafeSentMirror(client, {
    nowIso: "2026-07-08T00:30:00Z",
    fetchSentMessages: () => Promise.resolve([A, B]),
  });
  assertEquals(res2.upserted, 2); // re-upsert is fine (conflict on post_id)
  assertEquals(
    res2.new_events,
    0,
    "both already in the store -> no new events",
  );
  assertEquals(tables.emails!.length, 2, "no duplicate email rows");
  assertEquals(
    tables.email_events_raw!.length,
    2,
    "audit log not double-appended",
  );
});

Deno.test("mirror: never touches invoices / substatus / sends (only emails, events, cursor)", async () => {
  const tables: Tables = {};
  const client = makeClient(tables);
  await makesafeSentMirror(client, {
    nowIso: "2026-07-08T00:00:00Z",
    fetchSentMessages: () => Promise.resolve([A]),
  });
  const touched = new Set(client.__upserts.map((u) => u.table));
  assert(
    [...touched].every((t) => ["emails", "mail_sync_cursors"].includes(t)),
  );
});

function dedupeUrl(ids: string[]): string {
  return postgrestInUrl("email_events_raw", ids, [
    ["mailbox", `eq.${ADMIN_SENT_MAILBOX}`],
    ["change_type", "eq.created"],
  ]);
}

Deno.test("root cause: one .in() of a Sent page of live Graph ids is an Invalid URL", () => {
  const ids = Array.from({ length: 60 }, (_, i) => realisticGraphPostId(i));
  assertEquals(ids[0].length, LIVE_GRAPH_POST_ID.length);
  assertEquals(new Set(ids).size, 60);
  // The old dedupe read: emails?select=post_id&post_id=in.(every id).
  // 50 live ids sit just under 8000; the 52nd crosses it. The mirror fetches
  // every page since the cursor, and the cursor has never moved.
  assert(
    postgrestInUrl("emails", ids.slice(0, 50)).length <= POSTGREST_URL_LIMIT,
  );
  assert(
    postgrestInUrl("emails", ids.slice(0, 52)).length > POSTGREST_URL_LIMIT,
  );
  assertThrows(
    () => assertUrlSendable(postgrestInUrl("emails", ids)),
    TypeError,
    "Invalid URL",
  );
  assertThrows(
    () => assertUrlSendable(dedupeUrl(ids)),
    TypeError,
    "Invalid URL",
  );
});

Deno.test("mirror: 60 real-length Graph ids dedupe under the URL limit and a re-run does not duplicate", async () => {
  const ids = Array.from({ length: 60 }, (_, i) => realisticGraphPostId(i));
  const messages: GraphSentMessage[] = ids.map((id, i) => ({
    ...MSG,
    id,
    sentDateTime: new Date(Date.parse("2026-07-01T00:00:00Z") + i * 60_000)
      .toISOString(),
  }));
  const tables: Tables = {};
  const client = makeClient(tables);
  const res = await makesafeSentMirror(client, {
    nowIso: "2026-07-08T00:00:00Z",
    fetchSentMessages: () => Promise.resolve(messages),
  });

  assert(
    client.__inCalls.length > 1,
    "a page of 60 live ids must be more than one .in()",
  );
  const seen: string[] = [];
  for (const call of client.__inCalls) {
    assertEquals(call.table, "email_events_raw");
    assertEquals(call.column, "post_id");
    assertEquals(call.eqs.mailbox, ADMIN_SENT_MAILBOX);
    assertEquals(call.eqs.change_type, "created");
    assertUrlSendable(dedupeUrl(call.ids));
    seen.push(...call.ids);
  }
  assertEquals(seen.length, 60);
  assertEquals(new Set(seen).size, 60);
  assertEquals(res.fetched, 60);
  assertEquals(res.upserted, 60);
  assertEquals(res.new_events, 60);
  assertEquals(res.cursor_advanced_to, messages[59].sentDateTime);
  assertEquals(tables.emails!.length, 60);
  assertEquals(tables.email_events_raw!.length, 60);
  assert(
    tables.emails!.every((e) =>
      e.folder === SENT_FOLDER && e.mailbox === ADMIN_SENT_MAILBOX
    ),
  );

  const res2 = await makesafeSentMirror(client, {
    nowIso: "2026-07-08T00:30:00Z",
    fetchSentMessages: () => Promise.resolve(messages),
  });
  assertEquals(res2.upserted, 60);
  assertEquals(res2.new_events, 0);
  assertEquals(tables.emails!.length, 60);
  assertEquals(tables.email_events_raw!.length, 60);
});

Deno.test("mirror: a repeated Graph id in one page is stored once", async () => {
  const tables: Tables = {};
  const client = makeClient(tables);
  const dup: GraphSentMessage = {
    ...A,
    id: realisticGraphPostId(1),
    subject: "first copy",
  };
  const res = await makesafeSentMirror(client, {
    nowIso: "2026-07-08T00:00:00Z",
    fetchSentMessages: () =>
      Promise.resolve([dup, { ...dup, subject: "second copy" }]),
  });
  assertEquals(res.fetched, 2);
  assertEquals(res.upserted, 1);
  assertEquals(res.new_events, 1);
  assertEquals(tables.emails!.length, 1);
  assertEquals(tables.emails![0].subject, "first copy");
  assertEquals(tables.email_events_raw!.length, 1);
});

Deno.test("mirror: a dedupe read error is thrown and the cursor is not moved", async () => {
  const tables: Tables = {};
  const client = makeClient(tables, {
    table: "email_events_raw",
    op: "select",
    onCall: 1,
    message:
      "TypeError: Invalid URL: https://example.supabase.co/rest/v1/email_events_raw?post_id=in.(…)",
  });
  await assertRejects(
    () =>
      makesafeSentMirror(client, {
        nowIso: "2026-07-08T00:00:00Z",
        fetchSentMessages: () => Promise.resolve([A, B]),
      }),
    Error,
    "sent mirror dedupe read failed: TypeError: Invalid URL",
  );
  assertEquals(tables.emails!.length, 0);
  assertEquals(tables.email_events_raw!.length, 0);
  assertEquals(tables.mail_sync_cursors!.length, 0);
});

Deno.test("mirror: an upsert error is thrown and nothing is stored", async () => {
  const tables: Tables = {};
  const client = makeClient(tables, {
    table: "emails",
    op: "upsert",
    onCall: 1,
    message: "duplicate key value violates unique constraint",
  });
  await assertRejects(
    () =>
      makesafeSentMirror(client, {
        nowIso: "2026-07-08T00:00:00Z",
        fetchSentMessages: () => Promise.resolve([A]),
      }),
    Error,
    "emails upsert (sent mirror) failed: duplicate key value violates unique constraint",
  );
  assertEquals(tables.emails!.length, 0);
  assertEquals(tables.email_events_raw!.length, 0);
  assertEquals(tables.mail_sync_cursors!.length, 0);
});

Deno.test("mirror: a failed audit insert is surfaced, and the next run writes that event once", async () => {
  const tables: Tables = {};
  const fail: Fail = {
    table: "email_events_raw",
    op: "insert",
    onCall: 1,
    message: "insert failed",
  };
  const client = makeClient(tables, fail);
  await assertRejects(
    () =>
      makesafeSentMirror(client, {
        nowIso: "2026-07-08T00:00:00Z",
        fetchSentMessages: () => Promise.resolve([A, B]),
      }),
    Error,
    "email_events_raw insert (sent mirror) failed: insert failed",
  );
  assertEquals(
    tables.emails!.length,
    2,
    "the email upsert committed before the audit insert failed",
  );
  assertEquals(tables.email_events_raw!.length, 0);
  assertEquals(
    tables.mail_sync_cursors!.length,
    0,
    "cursor stays put so the run is retried",
  );

  const res2 = await makesafeSentMirror(client, {
    nowIso: "2026-07-08T00:30:00Z",
    fetchSentMessages: () => Promise.resolve([A, B]),
  });
  assertEquals(res2.new_events, 2, "the failed insert is retried, not dropped");
  assertEquals(tables.emails!.length, 2);
  assertEquals(tables.email_events_raw!.length, 2);
  assertEquals(tables.mail_sync_cursors!.length, 1);

  const res3 = await makesafeSentMirror(client, {
    nowIso: "2026-07-08T01:00:00Z",
    fetchSentMessages: () => Promise.resolve([A, B]),
  });
  assertEquals(res3.new_events, 0);
  assertEquals(tables.email_events_raw!.length, 2);
});

Deno.test("mirror: a page with no Graph ids throws and does not move the cursor", async () => {
  const tables: Tables = {};
  const client = makeClient(tables);
  await assertRejects(
    () =>
      makesafeSentMirror(client, {
        nowIso: "2026-07-08T00:00:00Z",
        fetchSentMessages: () => Promise.resolve([{ ...A, id: "" }]),
      }),
    Error,
    "sent mirror: Graph messages had no ids",
  );
  assertEquals(tables.mail_sync_cursors!.length, 0);
  assertEquals(tables.emails!.length, 0);
});
