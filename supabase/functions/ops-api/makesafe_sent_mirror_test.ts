// W3-A (M-E hybrid loop) — admin@ Sent-Items MIRROR tests.
//
// Covers the incremental/backfill window, the Graph-message -> emails-row mapper
// (folder tag + populated to_recipients), and the DB action (idempotent upsert,
// one audit event per NEW message, watermark advance) against a data-driven mock.
import {
  assert,
  assertEquals,
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
  const { sinceIso, initialBackfill } = computeSentWindow(cursor, now, { overlapSeconds: 900 });
  assertEquals(initialBackfill, false);
  assertEquals(sinceIso, "2026-07-07T11:45:00.000Z"); // cursor - 15min overlap
});

Deno.test("window: a corrupt way-back cursor is floored at the 90-day retention edge", () => {
  const now = "2026-07-08T00:00:00Z";
  const cursor = "2020-01-01T00:00:00Z"; // absurdly old
  const { sinceIso } = computeSentWindow(cursor, now);
  const gapDays = (Date.parse(now) - Date.parse(sinceIso)) / 86_400_000;
  assert(gapDays <= SENT_BACKFILL_DAYS + 0.01, "never scans earlier than the backfill floor");
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
  from: { emailAddress: { address: "admin@secureworkswa.com.au", name: "SecureWorks" } },
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
  assertEquals(row.to_recipients, "workorders@ajs.build, accounts@ajs.build, marnin@secureworkswa.com.au");
  assertEquals(row.received_at, "2026-07-07T05:00:00Z"); // prefers sentDateTime
  assertEquals(row.has_attachments, true);
});

Deno.test("recipientsString: null when there are no recipients", () => {
  assertEquals(recipientsString({ ...MSG, toRecipients: [], ccRecipients: [] }), null);
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

type Tables = { emails?: any[]; email_events_raw?: any[]; mail_sync_cursors?: any[] };
function makeClient(tables: Tables) {
  tables.emails = tables.emails || [];
  tables.email_events_raw = tables.email_events_raw || [];
  tables.mail_sync_cursors = tables.mail_sync_cursors || [];
  const upserts: Array<{ table: string; rows: any[] }> = [];
  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const ins: Record<string, any[]> = {};
    let op: "select" | "insert" | "upsert" = "select";
    let payload: any = null;
    let conflict: string | null = null;
    const rowsOf = () => (tables[table as keyof Tables] || []) as any[];
    const match = () => {
      let rows = rowsOf().slice();
      for (const [k, v] of Object.entries(eqs)) rows = rows.filter((r) => r[k] === v);
      for (const [k, arr] of Object.entries(ins)) rows = rows.filter((r) => arr.includes(r[k]));
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
      if (op === "upsert") return doUpsert();
      if (op === "insert") return doInsert();
      return { data: match(), error: null };
    };
    const b: any = {
      select: () => b,
      eq: (k: string, v: any) => { eqs[k] = v; return b; },
      in: (k: string, arr: any[]) => { ins[k] = arr; return b; },
      upsert: (rows: any, opts?: any) => { op = "upsert"; payload = rows; conflict = opts?.onConflict ?? null; return b; },
      insert: (rows: any) => { op = "insert"; payload = rows; return b; },
      maybeSingle: () => Promise.resolve({ data: match()[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej),
    };
    return b;
  }
  return { from: (t: string) => builder(t), __upserts: upserts };
}

const A: GraphSentMessage = { ...MSG, id: "m-a", sentDateTime: "2026-07-07T01:00:00Z" };
const B: GraphSentMessage = { ...MSG, id: "m-b", sentDateTime: "2026-07-07T02:00:00Z" };

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
  assertEquals(tables.emails!.every((e) => e.folder === SENT_FOLDER && e.mailbox === ADMIN_SENT_MAILBOX), true);
  assertEquals(tables.email_events_raw!.length, 2);
  assertEquals(tables.mail_sync_cursors![0].last_completed_max, "2026-07-07T02:00:00Z");
  assertEquals(tables.mail_sync_cursors![0].mailbox, ADMIN_SENT_MAILBOX);
});

Deno.test("mirror: idempotent re-run of the same window adds NO duplicate audit events", async () => {
  const tables: Tables = {};
  const client = makeClient(tables);
  await makesafeSentMirror(client, { nowIso: "2026-07-08T00:00:00Z", fetchSentMessages: () => Promise.resolve([A, B]) });
  const res2 = await makesafeSentMirror(client, { nowIso: "2026-07-08T00:30:00Z", fetchSentMessages: () => Promise.resolve([A, B]) });
  assertEquals(res2.upserted, 2); // re-upsert is fine (conflict on post_id)
  assertEquals(res2.new_events, 0, "both already in the store -> no new events");
  assertEquals(tables.emails!.length, 2, "no duplicate email rows");
  assertEquals(tables.email_events_raw!.length, 2, "audit log not double-appended");
});

Deno.test("mirror: never touches invoices / substatus / sends (only emails, events, cursor)", async () => {
  const tables: Tables = {};
  const client = makeClient(tables);
  await makesafeSentMirror(client, { nowIso: "2026-07-08T00:00:00Z", fetchSentMessages: () => Promise.resolve([A]) });
  const touched = new Set(client.__upserts.map((u) => u.table));
  assert([...touched].every((t) => ["emails", "mail_sync_cursors"].includes(t)));
});
