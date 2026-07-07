// DA-M3-8 — installer allocation notify is SMS, not Telegram.
// Marnin: "dont do any telegram stuff should be text".
//
// createAssignment's notify block must:
//   1. send a plain-text SMS to the assigned installer's users.phone via the
//      existing ghl-proxy send_sms path (sendSmsViaGhl), and NEVER hit
//      api.telegram.org;
//   2. be fire-and-forget — an SMS failure must not fail or delay the
//      assignment write;
//   3. leave updateAssignment (the reassignment path) completely SILENT —
//      the M3 CP3 first-live-write test is a silent reassignment round-trip.
//
// createAssignment/updateAssignment are module-private, so both are exercised
// through the exported allocateJob (new allocation -> createAssignment,
// assignmentId reassignment -> updateAssignment). Notifies are asserted at the
// globalThis.fetch layer (sendSmsViaGhl is a bare in-module function).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { allocateJob } from "./index.ts";

// ── Minimal chainable Supabase mock (modeled on allocation_authz_test.ts, ──
// with promise-backed then/catch so `.insert().then().catch()` chains work).
type Store = {
  jobs?: Record<string, any>;
  users?: Record<string, any>;
  assignments?: Record<string, any>;
  dup?: any[]; // rows for the job+user+date idempotency query
  inserts?: Array<{ table: string; row: any }>;
  updates?: Array<{ table: string; row: any }>;
};

function makeClient(store: Store) {
  store.inserts = store.inserts || [];
  store.updates = store.updates || [];
  function builder(table: string) {
    const filters: Record<string, any> = {};
    let op: "select" | "insert" | "update" | "delete" = "select";
    let insertRow: any = null;
    let updateRow: any = null;
    const resolveSingle = () => {
      if (op === "insert") return { id: "new-assignment", ...insertRow };
      if (op === "update") return { ...(store.assignments?.[filters.id] ?? {}), ...updateRow, id: filters.id };
      if (table === "jobs") return store.jobs?.[filters.id] ?? null;
      if (table === "users") return store.users?.[filters.id] ?? null;
      if (table === "job_assignments") return store.assignments?.[filters.id] ?? null;
      return null; // makesafe_job_details etc. -> not found
    };
    const resolveArray = () => {
      if (op === "insert" || op === "update") return null;
      if (table === "job_assignments") return store.dup ?? [];
      return [];
    };
    const b: any = {
      select: () => b,
      insert: (row: any) => { op = "insert"; insertRow = row; store.inserts!.push({ table, row }); return b; },
      update: (row: any) => { op = "update"; updateRow = row; store.updates!.push({ table, row }); return b; },
      delete: () => { op = "delete"; return b; },
      eq: (k: string, v: any) => { filters[k] = v; return b; },
      neq: () => b,
      not: () => b,
      in: () => b,
      or: () => b,
      gte: () => b,
      lt: () => b,
      ilike: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve({ data: resolveSingle(), error: null }),
      single: () => Promise.resolve({ data: resolveSingle(), error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: resolveArray(), error: null }).then(res, rej),
      catch: () => Promise.resolve({ data: null, error: null }),
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

// ── fetch interception ──────────────────────────────────────────────────────
type FetchCall = { url: string; init?: any };

function stubFetch(failSendSms = false) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (failSendSms && url.includes("action=send_sms")) {
      return Promise.reject(new Error("simulated GHL outage"));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// Let un-awaited fire-and-forget sends run to completion before asserting.
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const smsCalls = (calls: FetchCall[]) => calls.filter((c) => c.url.includes("ghl-proxy?action=send_sms"));
const telegramCalls = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.includes("api.telegram.org") || c.url.includes("sendMessage"));

const JOB = {
  id: "job-1",
  type: "fencing",
  job_number: "SWF-100",
  status: "processing",
  client_name: "Jane Client",
  site_address: "12 Example St",
  site_suburb: "Padbury",
  ghl_opportunity_id: null,
};
const INSTALLER = { id: "inst-1", name: "Hugo", phone: "+61400111222" };

function baseStore(): Store {
  return { jobs: { "job-1": { ...JOB } }, users: { "inst-1": { ...INSTALLER } }, dup: [] };
}

// ── 1. New allocation sends SMS to the installer's phone, never Telegram ────
Deno.test("createAssignment (via allocateJob): new allocation sends plain-text SMS to installer phone, not Telegram", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store = baseStore();
    const res = await allocateJob(makeClient(store), {
      body: { jobId: "job-1", userId: "inst-1", scheduledDate: "2026-07-08" },
      callerRole: "admin",
    });
    await flush();

    assertEquals(res.ok, true);
    assertEquals(res.mode, "create");

    const sms = smsCalls(calls);
    assertEquals(sms.length, 1, `expected exactly one send_sms POST, saw: ${calls.map((c) => c.url).join(" | ")}`);
    assertEquals(sms[0].init?.method, "POST");
    const body = JSON.parse(String(sms[0].init?.body));
    assertEquals(body.phone, "+61400111222");
    assert(body.message.includes("SWF-100"), "SMS carries the job number");
    assert(body.message.includes("Jane Client"), "SMS carries the client name");
    assert(body.message.includes("12 Example St"), "SMS carries the site address");
    assert(body.message.includes("Padbury"), "SMS carries the suburb");
    assert(body.message.includes("2026-07-08"), "SMS carries the scheduled date");
    assert(
      body.message.includes("https://secureworks-group.github.io/secureworks-ux/trade.html#job/job-1"),
      "SMS keeps the Open-in-Trade destination as a plain URL",
    );
    assert(!body.message.includes("<b>") && !body.message.includes("</b>"), "SMS body is plain text, no HTML");

    assertEquals(telegramCalls(calls).length, 0, "no Telegram traffic on allocation");
  } finally {
    restore();
  }
});

// ── 1b. No phone on file -> no SMS, allocation still succeeds ───────────────
Deno.test("createAssignment (via allocateJob): installer without a phone gets no SMS, allocation still succeeds", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store = baseStore();
    store.users!["inst-1"].phone = null;
    const res = await allocateJob(makeClient(store), {
      body: { jobId: "job-1", userId: "inst-1", scheduledDate: "2026-07-08" },
      callerRole: "admin",
    });
    await flush();

    assertEquals(res.ok, true);
    assertEquals(res.mode, "create");
    assertEquals(smsCalls(calls).length, 0);
    assertEquals(telegramCalls(calls).length, 0);
    assertEquals(store.inserts!.filter((i) => i.table === "job_assignments").length, 1);
  } finally {
    restore();
  }
});

// ── 2. Notify failure is non-blocking: assignment write still succeeds ──────
Deno.test("createAssignment (via allocateJob): SMS send failure does not fail the assignment write", async () => {
  const { calls, restore } = stubFetch(true /* send_sms rejects */);
  try {
    const store = baseStore();
    const res = await allocateJob(makeClient(store), {
      body: { jobId: "job-1", userId: "inst-1", scheduledDate: "2026-07-08" },
      callerRole: "admin",
    });
    await flush();

    // The allocation succeeded despite the SMS path blowing up.
    assertEquals(res.ok, true);
    assertEquals(res.mode, "create");
    assertEquals(res.assignment?.id, "new-assignment");
    assertEquals(store.inserts!.filter((i) => i.table === "job_assignments").length, 1);
    // The send was attempted (and failed) — proving failure is swallowed, not skipped.
    assertEquals(smsCalls(calls).length, 1);
  } finally {
    restore();
  }
});

// ── 3. Reassignment (updateAssignment) fires NO notify at all ───────────────
// The M3 CP3 first-live-write test is a SILENT reassignment round-trip; texting
// a real installer during that watched write would be a live incident.
Deno.test("updateAssignment (via allocateJob reassignment): completely silent — no SMS, no Telegram, no fetch at all", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store = baseStore();
    store.users!["inst-2"] = { id: "inst-2", name: "Marco", phone: "+61400333444" };
    store.assignments = {
      "a1": {
        id: "a1",
        job_id: "job-1",
        user_id: "inst-1",
        scheduled_date: "2026-07-08",
        confirmation_status: "tentative",
        crew_name: "Hugo",
        status: "scheduled",
      },
    };
    const res = await allocateJob(makeClient(store), {
      body: { assignmentId: "a1", userId: "inst-2" },
      callerRole: "admin",
    });
    await flush();

    assertEquals(res.ok, true);
    assertEquals(res.mode, "reassign");
    // The reassignment DID write (user_id moved to inst-2)…
    const upd = store.updates!.filter((u) => u.table === "job_assignments");
    assertEquals(upd.length, 1);
    assertEquals(upd[0].row.user_id, "inst-2");
    // …and stayed silent.
    assertEquals(smsCalls(calls).length, 0, "reassignment must not SMS");
    assertEquals(telegramCalls(calls).length, 0, "reassignment must not Telegram");
    assertEquals(calls.length, 0, `reassignment makes no outbound calls at all today, saw: ${calls.map((c) => c.url).join(" | ")}`);
  } finally {
    restore();
  }
});
