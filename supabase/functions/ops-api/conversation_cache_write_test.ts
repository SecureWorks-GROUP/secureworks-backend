// deno-lint-ignore-file no-explicit-any require-await
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { syncConversationCache } from "./conversation_cache_write.ts";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "ZZTEST-contact";

function cacheClient(options: { writeError?: boolean; readError?: boolean; jobError?: boolean } = {}) {
  const rows: any[] = [];
  const events: any[] = [];
  const jobs = [{ id: JOB_ID, job_number: "SWP-260001" }];
  let writes = 0;
  return {
    rows, events, get writes() { return writes; },
    from(table: string) {
      let operation = "select";
      let value: any;
      const filters: [string, unknown][] = [];
      const query: any = {
        select() { return query; },
        eq(key: string, expected: unknown) { filters.push([key, expected]); return query; },
        limit() { return query; },
        maybeSingle() { return query; },
        insert(row: any) { operation = "insert"; value = row; return query; },
        update(row: any) { operation = "update"; value = row; return query; },
        then(resolve: any, reject: any) {
          return Promise.resolve().then(() => {
            if (table === "jobs") {
              return { data: jobs.find(row => filters.every(([key, expected]) => row[key as keyof typeof row] === expected)) ?? null,
                error: options.jobError ? { message: "read failed" } : null };
            }
            if (table !== "ghl_conversation_cache") throw new Error("Unexpected table");
            if (operation === "select") return {
              data: rows.find(row => filters.every(([key, expected]) => row[key] === expected)) ?? null,
              error: options.readError ? { message: "read failed" } : null,
            };
            writes++;
            if (options.writeError) return { data: null, error: { message: "write failed" } };
            if (operation === "insert") rows.push({ id: "cache-row", ...structuredClone(value) });
            else Object.assign(rows.find(row => filters.every(([key, expected]) => row[key] === expected)), structuredClone(value));
            return { data: null, error: null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name: string, args: any) {
      assertEquals(name, "capture_business_event");
      events.push(args.p_row);
      return { data: { outcome: "inserted" }, error: null };
    },
  };
}

function sync(client: any, body: any, method = "POST", serverCaller = true) {
  return syncConversationCache(client, body, { method, serverCaller });
}

Deno.test("conversation cache: a known uuid writes the resolved job and sync evidence", async () => {
  const db = cacheClient();
  const messages = [{ id: "ZZTEST-message" }];
  const result = await sync(db, { contact_id: CONTACT_ID, job_id: JOB_ID, messages });
  assertEquals(result, { status: 200, body: { ok: true, contact_id: CONTACT_ID, job_id: JOB_ID, message_count: 1 } });
  assertEquals(db.rows[0].job_id, JOB_ID);
  assertEquals(db.rows[0].messages, messages);
  assertEquals(db.rows[0].message_count, 1);
  assertEquals(Number.isNaN(Date.parse(db.rows[0].synced_at)), false);
  assertEquals(db.events.length, 1);
  assertEquals(db.events[0].event_type, "conversation.synced");
  assertEquals(db.events[0].job_id, JOB_ID);
  assertEquals(db.events[0].entity_id, CONTACT_ID);
  assertEquals(db.events[0].payload.message_count, 1);
});

Deno.test("conversation cache: job numbers resolve exactly including lower case and legacy job_id", async () => {
  for (const job of [{ job_number: "SWP-260001" }, { job_number: "swp-260001" }, { job_id: "swp-260001" }]) {
    const db = cacheClient();
    assertEquals((await sync(db, { contact_id: CONTACT_ID, ...job, messages: [] })).status, 200);
    assertEquals(db.rows[0].job_id, JOB_ID);
  }
});

Deno.test("conversation cache: unknown job ids and numbers refuse without a write", async () => {
  for (const job of [{ job_number: "SWP-unknown" }, { job_number: "SWP-%" }, { job_id: "22222222-2222-4222-8222-222222222222" }]) {
    const db = cacheClient();
    assertEquals(await sync(db, { contact_id: CONTACT_ID, ...job, messages: [] }), {
      status: 422, body: { ok: false, code: "JOB_NOT_FOUND" },
    });
    assertEquals(db.writes, 0);
    assertEquals(db.events.length, 0);
  }
});

Deno.test("conversation cache: failed writes return failure and record no sync event", async () => {
  const db = cacheClient({ writeError: true });
  assertEquals(await sync(db, { contact_id: CONTACT_ID, messages: [] }), {
    status: 500, body: { ok: false, code: "CACHE_WRITE_FAILED" },
  });
  assertEquals(db.rows.length, 0);
  assertEquals(db.events.length, 0);
});

Deno.test("conversation cache: a repeat updates the same contact row and can clear the job", async () => {
  const db = cacheClient();
  await sync(db, { contact_id: CONTACT_ID, job_id: JOB_ID, messages: [] });
  const rowId = db.rows[0].id;
  const messages = [{ id: "ZZTEST-next" }];
  const result = await sync(db, { contact_id: CONTACT_ID, messages });
  assertEquals(result.body.job_id, null);
  assertEquals(db.rows.length, 1);
  assertEquals(db.rows[0].id, rowId);
  assertEquals(db.rows[0].job_id, null);
  assertEquals(db.rows[0].messages, messages);
  assertEquals(db.rows[0].message_count, 1);
});

Deno.test("conversation cache: rejects invalid input and permits the 2000 message boundary", async () => {
  for (const body of [null, {}, { contact_id: " " , messages: [] }, { contact_id: 1, messages: [] },
    { contact_id: CONTACT_ID, messages: {} }, { contact_id: CONTACT_ID, messages: Array(2001).fill({}) }]) {
    const db = cacheClient();
    assertEquals((await sync(db, body)).status, 400);
    assertEquals(db.writes, 0);
    assertEquals(db.events.length, 0);
  }
  const db = cacheClient();
  assertEquals((await sync(db, { contact_id: CONTACT_ID, messages: Array(2000).fill({}) })).status, 200);
  assertEquals(db.rows[0].message_count, 2000);
});

Deno.test("conversation cache: only a server caller using POST reaches storage", async () => {
  for (const [method, serverCaller, status] of [["GET", true, 405], ["POST", false, 403]] as const) {
    const db = cacheClient();
    assertEquals((await sync(db, { contact_id: CONTACT_ID, messages: [] }, method, serverCaller)).status, status);
    assertEquals(db.writes, 0);
    assertEquals(db.events.length, 0);
  }
});

Deno.test("conversation cache: unreadable job or cache cannot become an insert", async () => {
  for (const options of [{ jobError: true }, { readError: true }]) {
    const db = cacheClient(options);
    assertEquals((await sync(db, { contact_id: CONTACT_ID, job_id: JOB_ID, messages: [] })).status, 500);
    assertEquals(db.writes, 0);
    assertEquals(db.events.length, 0);
  }
});
