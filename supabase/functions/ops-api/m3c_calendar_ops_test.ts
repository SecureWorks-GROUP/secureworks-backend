// M3c — ops calendar 80/20 (trade-app-redesign · U-O2 SMS guard + U-O3 feed).
// ---------------------------------------------------------------------------
//   U-O2  createAssignment must NEVER text an installer for a calendar
//         meeting/reminder (a planning entry, not an allocation), whatever the
//         status — same skip block as isSelfAssign. A real install allocation
//         with no explicit status keeps texting (DA-M3-8 must not regress).
//   U-O3  calendarEvents (a) filters by window OVERLAP (carries scheduled_end),
//         not start-date containment, and (e) flags `truncated` when the 500-row
//         cap is hit so the FE can warn the view is partial.
// Notify is asserted at the globalThis.fetch layer (sendSmsViaGhl is a bare
// in-module fn); the feed is asserted against the REAL exported calendarEvents.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { allocateJob, calendarEvents } from "./index.ts";

// ── Minimal chainable Supabase mock for allocateJob (from createassignment_notify_sms_test.ts) ──
type Store = {
  jobs?: Record<string, any>;
  users?: Record<string, any>;
  assignments?: Record<string, any>;
  dup?: any[];
  inserts?: Array<{ table: string; row: any }>;
};
function makeClient(store: Store) {
  store.inserts = store.inserts || [];
  function builder(table: string) {
    const filters: Record<string, any> = {};
    let op: "select" | "insert" | "update" | "delete" = "select";
    let insertRow: any = null;
    const resolveSingle = () => {
      if (op === "insert") return { id: "new-assignment", ...insertRow };
      if (table === "jobs") return store.jobs?.[filters.id] ?? null;
      if (table === "users") return store.users?.[filters.id] ?? null;
      if (table === "job_assignments") return store.assignments?.[filters.id] ?? null;
      return null;
    };
    const resolveArray = () => (table === "job_assignments" ? store.dup ?? [] : []);
    const b: any = {
      select: () => b,
      insert: (row: any) => { op = "insert"; insertRow = row; store.inserts!.push({ table, row }); return b; },
      update: () => { op = "update"; return b; },
      delete: () => { op = "delete"; return b; },
      eq: (k: string, v: any) => { filters[k] = v; return b; },
      neq: () => b, not: () => b, in: () => b, or: () => b, gte: () => b, lt: () => b, ilike: () => b, order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve({ data: resolveSingle(), error: null }),
      single: () => Promise.resolve({ data: resolveSingle(), error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: resolveArray(), error: null }).then(res, rej),
      catch: () => Promise.resolve({ data: null, error: null }),
    };
    return b;
  }
  return { from: (t: string) => builder(t) };
}
type FetchCall = { url: string; init?: any };
function stubFetch() {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) => {
    calls.push({ url: String(input instanceof Request ? input.url : input), init });
    return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}
async function flush() { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }
const smsCalls = (calls: FetchCall[]) => calls.filter((c) => c.url.includes("ghl-proxy?action=send_sms"));

function baseStore(): Store {
  return {
    jobs: { "job-1": { id: "job-1", type: "fencing", job_number: "SWF-100", status: "processing", client_name: "Jane", site_address: "12 Example St", site_suburb: "Padbury", ghl_opportunity_id: null } },
    users: { "inst-1": { id: "inst-1", name: "Hugo", phone: "+61400111222" } },
    dup: [],
  };
}

// ── U-O2: meeting/reminder never texts; install (control) still texts ──
Deno.test("U-O2: createAssignment with assignment_type meeting -> ZERO SMS (planning entry), assignment still written", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store = baseStore();
    const res = await allocateJob(makeClient(store), {
      body: { jobId: "job-1", userId: "inst-1", scheduledDate: "2026-07-08", assignmentType: "meeting" },
      callerRole: "admin",
    });
    await flush();
    assertEquals(res.ok, true);
    assertEquals(smsCalls(calls).length, 0, "a calendar meeting must never text an installer");
    assertEquals(store.inserts!.filter((i) => i.table === "job_assignments").length, 1, "assignment still written");
  } finally { restore(); }
});

Deno.test("U-O2: createAssignment with assignment_type reminder -> ZERO SMS", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store = baseStore();
    const res = await allocateJob(makeClient(store), {
      body: { jobId: "job-1", userId: "inst-1", scheduledDate: "2026-07-08", assignment_type: "reminder" },
      callerRole: "admin",
    });
    await flush();
    assertEquals(res.ok, true);
    assertEquals(smsCalls(calls).length, 0, "a calendar reminder must never text an installer");
  } finally { restore(); }
});

Deno.test("U-O2 control: a real install allocation (no explicit status) STILL texts — DA-M3-8 not regressed", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store = baseStore();
    const res = await allocateJob(makeClient(store), {
      body: { jobId: "job-1", userId: "inst-1", scheduledDate: "2026-07-08", assignmentType: "install" },
      callerRole: "admin",
    });
    await flush();
    assertEquals(res.ok, true);
    assertEquals(smsCalls(calls).length, 1, "install allocation must keep texting the assigned installer");
  } finally { restore(); }
});

// ── U-O3: calendarEvents feed — overlap filter + truncated flag ──
function calFeedClient(calRows: any[]) {
  const captured: { or?: string; lteCol?: string; lteVal?: string; limit?: number } = {};
  function builder(table: string) {
    const b: any = {
      select: () => b,
      or: (s: string) => { captured.or = s; return b; },
      lte: (col: string, val: string) => { if (table === "calendar_events" && captured.lteCol === undefined) { captured.lteCol = col; captured.lteVal = val; } return b; },
      gte: () => b, eq: () => b, neq: () => b, in: () => b,
      order: () => b,
      limit: (n: number) => { captured.limit = n; return b; },
      then: (res: any, rej: any) => Promise.resolve({ data: table === "calendar_events" ? calRows : [], error: null }).then(res, rej),
    };
    return b;
  }
  return { client: { from: (t: string) => builder(t) }, captured };
}
function params(from: string, to: string) { return new URLSearchParams({ from, to }); }

Deno.test("U-O3(a): calendarEvents filters by window OVERLAP — the .or carries scheduled_end, .lte bounds scheduled_date by `to`", async () => {
  const { client, captured } = calFeedClient([]);
  await calendarEvents(client, params("2026-07-08", "2026-07-14"));
  assert(captured.or, "an .or overlap clause is used");
  assert(captured.or!.includes("scheduled_end.gte.2026-07-08"), `overlap includes scheduled_end >= from; saw: ${captured.or}`);
  assert(captured.or!.includes("and(scheduled_end.is.null,scheduled_date.gte.2026-07-08)"), "null-end rows fall back to start-date containment");
  assertEquals(captured.lteCol, "scheduled_date");
  assertEquals(captured.lteVal, "2026-07-14", "start still bounded by the window end");
});

Deno.test("U-O3(e): truncated flag is true exactly when the 500 cap is hit, false below it", async () => {
  const full = Array.from({ length: 500 }, (_, i) => ({ assignment_id: "a" + i, scheduled_date: "2026-07-08" }));
  const r1 = await calendarEvents(calFeedClient(full).client, params("2026-07-08", "2026-07-14"));
  assertEquals((r1 as any).truncated, true, "500 rows -> truncated");
  const r2 = await calendarEvents(calFeedClient(full.slice(0, 3)).client, params("2026-07-08", "2026-07-14"));
  assertEquals((r2 as any).truncated, false, "3 rows -> not truncated");
  assertEquals((r2 as any).events.length, 3, "events pass through");
});
